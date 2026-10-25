import { handleAmbassadorStoreRequest, purgeAmbassadorModeration } from './ambassadors.js';
import {reindexDiscovery,discoveryStatus} from './catalogue-discovery-index.js';
import {reindexPlaces,placeIndexStatus,PlaceIndexError} from './catalogue-place-index.js';
import { backfillWomensFoodTags,womensFoodTagStatus } from './womens-food-tag-index.js';
import { catalogueSchema } from './catalogue-schema.js';
import { CatalogueIndexError, searchCatalogue, batchCatalogue, importCatalogue, retainCatalogueProduct, exportCatalogue, queueCatalogueImport, refreshCatalogue, recalculateCatalogue, patchCatalogueImages, catalogueImageSource, catalogueImageManifest } from './catalogue-index.js';
import { handleContributionStoreRequest, nextContributionAlarm } from './product-contributions.js';
import { rememberCatalogueScoreEvidence } from './catalogue-score-evidence.js';
import { handleCatalogueEnrichment, enqueueCatalogueEnrichment, CatalogueEnrichmentError } from './catalogue-enrichment-store.js';
import { handleCatalogueScoringRun, CatalogueScoringRunError } from './catalogue-scoring-run.js';
import { archiveOFFImport } from './off-source-archive.js';

// This narrow adapter keeps prepared, parameterised query plans usable with
// both Workers D1 and a SQLite-backed Durable Object. Batches are atomic.
export function catalogueSQLAdapter(storage) {
  const statement=(sql,values=[])=>({
    bind:(...bound)=>statement(sql,bound),
    all:async()=>({results:storage.sql.exec(sql,...values).toArray()}),
    first:async()=>storage.sql.exec(sql,...values).toArray()[0]||null,
    run:async()=>({results:storage.sql.exec(sql,...values).toArray()}),
    execute:()=>({results:storage.sql.exec(sql,...values).toArray()})
  });
  return {prepare:statement,batch:async statements=>storage.transactionSync(()=>statements.map(item=>item.execute()))};
}
export class FoodCatalogueIndex {
  constructor(ctx,env) {
    this.ctx=ctx;this.env=env;this.db=catalogueSQLAdapter(ctx.storage);
    this.contributionSchedule=Promise.resolve();
    ctx.storage.sql.exec(catalogueSchema);
  }
  async scheduleContributions({notBefore=0}={}){
    if(!this.ctx?.storage?.setAlarm)return;
    this.contributionSchedule=(this.contributionSchedule||Promise.resolve()).catch(()=>{}).then(async()=>{
      const next=await nextContributionAlarm(this.db);
      if(next===null)await this.ctx.storage.deleteAlarm();else {
        // Frequent owner-status reads must not keep moving a queued alarm into
        // the future. A prior earlier alarm may perform one harmless no-op.
        const existing=await this.ctx.storage.getAlarm();
        const scheduled=typeof existing==='number'&&existing>Date.now()?Math.min(existing,next):next;
        await this.ctx.storage.setAlarm(Math.max(notBefore,scheduled));
      }
    });
    await this.contributionSchedule;
  }
  async alarm(){
    // Expire moderation data even if the independent AI queue runner is down.
    await purgeAmbassadorModeration(this.db);
    // A durable alarm keeps the analysis job alive beyond the HTTP waitUntil
    // window. The runner uses the existing quota and extraction implementation.
    let notBefore=0;
    try{
      if(!this.env.LABEL_QUOTA)throw new Error('Contribution runner unavailable');
      const runner=this.env.LABEL_QUOTA.get(this.env.LABEL_QUOTA.idFromName('contribution-runner'));
      const result=await runner.fetch('https://quota/process-product-contributions',{method:'POST',body:'{}'});
      if(!result.ok)throw new Error('Contribution runner unavailable');
    }catch(error){notBefore=Date.now()+30000;throw error;}finally{await this.scheduleContributions({notBefore});}
  }
  searchCoverage(now=Date.now()) {
    if(!this.coverageCache||this.coverageCache.expiresAt<=now){
      const entry={expiresAt:now+60_000};
      entry.value=Promise.all([discoveryStatus(this.db),womensFoodTagStatus(this.db),placeIndexStatus(this.db)]).then(([discovery,support,places])=>({discovery:{...discovery,generatedAt:now},support:{...support,generatedAt:now},places:{...places,generatedAt:now}})).catch(error=>{if(this.coverageCache===entry)this.coverageCache=null;throw error;});
      this.coverageCache=entry;
    }
    return this.coverageCache.value;
  }
  async fetch(request) {
    const url=new URL(request.url),action=url.pathname;
    const changesCoverage=['/import','/retain','/images','/discovery-index','/place-index','/support-tags','/refresh'].includes(action);
    try {
      if(action.startsWith('/ambassadors/')){
        const response=await handleAmbassadorStoreRequest(this.db,request);await this.scheduleContributions();return response;
      }
      if(action.startsWith('/contributions/')){
        const response=await handleContributionStoreRequest(this.db,request);
        await this.scheduleContributions();return response;
      }
      if(action==='/export')return Response.json(await exportCatalogue(this.db,url));
      if(action==='/image-source')return Response.json(await catalogueImageSource(this.db,url));
      if(action==='/image-manifest')return Response.json(await catalogueImageManifest(this.db,url));
      let body;
      try { body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await request.arrayBuffer())); }
      catch { throw new CatalogueIndexError('Invalid catalogue JSON.',400,'catalogue_request_invalid'); }
      if(action==='/search'||action==='/batch'){
        const result=action==='/search'?await searchCatalogue(this.db,body,{coverage:()=>this.searchCoverage()}):await batchCatalogue(this.db,body,{includeReviewed:request.headers.get('x-nudge-catalogue-source')!=='off-only'});
        const barcodes=result.ratings.filter(row=>row.score?.available!==true&&row.sourceKind!=='nudge_community').map(row=>row.barcode);
        if(barcodes.length&&this.ctx?.waitUntil)this.ctx.waitUntil(enqueueCatalogueEnrichment(this.db,{barcodes,reason:action==='/search'?'search':'scan'}).catch(()=>{
          console.error(JSON.stringify({event:'catalogue_enrichment_enqueue_failure',action}));
        }));
        return Response.json(result);
      }
      if(action.startsWith('/enrichment/'))return Response.json(await handleCatalogueEnrichment(this.db,action.slice('/enrichment/'.length),body));
      if(action.startsWith('/scoring/'))return Response.json(await handleCatalogueScoringRun(this.db,action.slice('/scoring/'.length),body));
      if(action==='/discovery-index')return Response.json(await reindexDiscovery(this.db,body));
      if(action==='/place-index')return Response.json(await reindexPlaces(this.db,body));
      if(action==='/import'){
        const result=await importCatalogue(this.db,body);
        // R2 contains the complete received source; query/index fields remain bounded.
        // Archive failure is explicit and the idempotent importer may retry this batch.
        const archive=await archiveOFFImport(this.env.PRODUCT_IMAGES,body);
        return Response.json({...result,...(archive?{sourceArchive:archive}:{})});
      }
      if(action==='/retain')return Response.json(await retainCatalogueProduct(this.db,body));
      if(action==='/images')return Response.json(await patchCatalogueImages(this.db,body));
      if(action==='/support-tags'){
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['after','limit','statusOnly'].includes(key))
          ||body.after!=null&&(typeof body.after!=='string'||body.after!==''&&!/^[0-9]{4,18}$/.test(body.after))
          ||body.limit!=null&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>250)
          ||body.statusOnly!=null&&typeof body.statusOnly!=='boolean')throw new CatalogueIndexError();
        return Response.json(await backfillWomensFoodTags(this.db,body));
      }
      if(action==='/recalculate')return Response.json(await recalculateCatalogue(this.db,body));
      if(action==='/score-evidence')return Response.json(await rememberCatalogueScoreEvidence(this.db,body));
      if(action==='/queue'){
        if(!this.env.FOOD_CATALOGUE_EXPORTS)throw new CatalogueIndexError('Export import storage is not configured.',503,'catalogue_import_storage_unavailable');
        return Response.json(await queueCatalogueImport(this.db,body));
      }
      if(action==='/refresh'){
        await refreshCatalogue({...this.env,FOOD_CATALOGUE_DB:this.db});
        return Response.json({refreshed:true});
      }
      return Response.json({code:'route_not_found'}, {status:404});
    } catch(error) {
      const known=error instanceof CatalogueIndexError||error instanceof CatalogueEnrichmentError||error instanceof PlaceIndexError||error instanceof CatalogueScoringRunError;
      const message=String(error?.message||'').slice(0,300);
      const resourceLimit=/SQLITE_FULL|(?:exceed|reach|exhaust|too many).*(?:limit|quota)|(?:daily|storage|row).*(?:limit|quota)/i.test(message);
      if(!known)console.error(JSON.stringify({event:'catalogue_storage_failure',action:action.startsWith('/ambassadors/')?'ambassador':action.startsWith('/contributions/')?'contribution':['/import','/retain','/images','/search','/batch','/export','/refresh','/recalculate','/queue'].includes(action)?action:'unknown',category:resourceLimit?'resource_limit':'storage_error',...((action.startsWith('/contributions/')||action.startsWith('/ambassadors/'))?{}:{name:String(error?.name||'Error').slice(0,60),message})}));
      return Response.json({code:known?error.code:resourceLimit?'catalogue_storage_limit':'catalogue_unavailable',message:known?error.message:resourceLimit?'Catalogue storage capacity is temporarily unavailable.':'Catalogue is temporarily unavailable.'},{status:known?error.status:503});
    } finally {
      if(changesCoverage)this.coverageCache=null;
    }
  }
}
export function catalogueIndexStub(env) {
  if(!env.FOOD_CATALOGUE_INDEX)return null;
  return env.FOOD_CATALOGUE_INDEX.get(env.FOOD_CATALOGUE_INDEX.idFromName('uk-public-products-v1'),{locationHint:'weur'});
}
