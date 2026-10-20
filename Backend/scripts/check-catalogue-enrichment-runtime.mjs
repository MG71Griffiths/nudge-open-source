// Real Workers SQLite queue/score smoke test. No external provider or AI calls.
// Build the Worker with wrangler deploy --dry-run first.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const directory=mkdtempSync(join(tmpdir(),'nudge-enrichment-runtime-'));
const options=()=>convertV4MiniflareOptions({resourcePersistencePath:join(directory,'storage'),workers:[{
 name:'enrichment-runtime',modules:true,scriptPath:fileURLToPath(new URL('../.wrangler/dry-run/index.js',import.meta.url)),compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],
 durableObjects:{FOOD_CATALOGUE_INDEX:{className:'FoodCatalogueIndex',useSQLite:true},LABEL_QUOTA:{className:'LabelQuota',useSQLite:true},CATALOGUE_ENRICHMENT_RUNNER:{className:'CatalogueEnrichmentRunner',useSQLite:true},PRODUCT_IMAGE_WARM_RUNNER:{className:'ProductImageWarmRunner',useSQLite:true}},
 outboundService:async()=>{throw new Error('No external provider or AI network allowed');}
}]});
let mf=new Miniflare(options());
const send=async(path,body={})=>{const namespace=await mf.getDurableObjectNamespace('FOOD_CATALOGUE_INDEX','enrichment-runtime');const response=await namespace.get(namespace.idFromName('uk-public-products-v1')).fetch('https://index'+path,{method:'POST',body:JSON.stringify(body)});assert.equal(response.status,200,path+' '+response.status);return response.json();};
const product=(code='5000000000001',extra={})=>({code,product_name:'Dhal makhani',brands:'Example Foods',countries_tags:['en:united-kingdom'],categories_tags:['en:dhal-makhani'],last_modified_t:1700000000,
 ingredients_text:'Lentils (60%), tomatoes (10%), water, cream, salt',nutriments:{'energy-kcal_100g':110,'energy-kj_100g':460,proteins_100g:6,carbohydrates_100g:14,sugars_100g:2,fat_100g:3,'saturated-fat_100g':1,fiber_100g:4,salt_100g:.5},...extra});
const sourceURL='https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',classification={category:'general',evidence:[{field:'name',quote:'Dhal makhani'}],sweeteners:'unknown',sweetenerEvidence:[]};
const receipt=(job,extra)=>({id:job.id,leaseToken:job.leaseToken,sourceFingerprint:job.sourceFingerprint,...extra});
try{
 const now=Date.now(),products=[product(),product('5000000000002',{nutriments:{proteins_100g:6}}),product('5000000000003')];
 assert.equal((await send('/import',{products,sourceURL,fetchedAt:now})).accepted,3);
 const queued=await send('/enrichment/enqueue',{barcodes:products.map(p=>p.code),reason:'pilot'});assert.equal(queued.queued,3);
 const {jobs}=await send('/enrichment/claim',{limit:3});assert.equal(jobs.length,3);assert.ok(jobs.every(j=>j.sourceRow.provider_json&&j.leaseToken));
 const exact=jobs.find(j=>j.barcode===products[0].code),partial=jobs.find(j=>j.barcode===products[1].code),deferred=jobs.find(j=>j.barcode===products[2].code);
 const saved=await send('/enrichment/complete',receipt(exact,{outcome:'evidence',evidence:{classification}}));assert.equal(saved.stored,true);assert.equal(saved.estimated,false);
 assert.equal((await send('/enrichment/complete',receipt(partial,{outcome:'evidence',evidence:{classification}}))).status,'unresolved');
 assert.equal((await send('/enrichment/complete',receipt(deferred,{outcome:'deferred',errorCode:'enrichment_budget',retryAt:Date.now()+100000}))).status,'deferred');
 const results=await send('/search',{query:'dhal',minimumRating:saved.value,sort:'ratingHighest'});assert.equal(results.total,1);assert.equal(results.ratings[0].score.value,saved.value);
 const batch=await send('/batch',{codes:[exact.barcode]});assert.deepEqual(batch.products[0].nutriments,products[0].nutriments);assert.equal(batch.ratings[0].fetchedAt,now);assert.equal(batch.ratings[0].score.catalogueEnrichment.sourceFingerprint,exact.sourceFingerprint);
 let status=await send('/enrichment/status');assert.deepEqual(status.scored,{total:1,exact:1,estimated:0});assert.equal(status.counts.deferred,1);assert.equal(status.counts.unresolved,1);assert.equal(status.attempts,2);assert.equal(status.pilot.outcomes.enriched,1);assert.equal(status.pilot.outcomes.unresolved,1);assert.ok(status.missingInputs.salt>=1);
 await mf.dispose();mf=new Miniflare(options());
 status=await send('/enrichment/status');assert.equal(status.scored.total,1);assert.equal(status.counts.deferred,1);
 assert.equal((await send('/enrichment/complete',receipt(exact,{outcome:'evidence',evidence:{classification}}))).stored,false,'Completed lease cannot replay after restart');
 assert.equal((await send('/batch',{codes:[exact.barcode]})).ratings[0].score.value,saved.value);
 console.log(JSON.stringify({event:'catalogue_enrichment_runtime_pass',persistentJobs:3,exactScores:1,unresolved:1,deferred:1,sourceFactsUnchanged:true,externalRequests:0}));
}finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
