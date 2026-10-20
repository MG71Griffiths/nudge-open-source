import {it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ScoreCore} from '../src/nutrition-core.js';
import {catalogueRecordFromPayload} from '../src/food-catalogue.js';
import {scorePackagedProduct} from '../src/product-score.js';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter,FoodCatalogueIndex} from '../src/catalogue-index-object.js';
import {importCatalogue,batchCatalogue,searchCatalogue,patchCatalogueImages,recalculateCatalogue} from '../src/catalogue-index.js';
import {enqueueCatalogueEnrichment,claimCatalogueEnrichment,completeCatalogueEnrichment,catalogueEnrichmentStatus,seedCatalogueEnrichment,reviewCatalogueEnrichment,catalogueRecoveryCandidates,refreshCatalogueEnrichment,ENRICHMENT_MAX_ATTEMPTS,ENRICHMENT_LEASE_MS,ENRICHMENT_VERSION} from '../src/catalogue-enrichment-store.js';
const now=Date.now(),source='https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz';
const raw=(code='5000000000001',extra={})=>({code,product_name:'Dhal makhani',brands:'Example Foods',countries_tags:['en:united-kingdom'],categories_tags:['en:dhal-makhani'],image_nutrition_url:`https://images.openfoodfacts.org/images/products/${code}/nutrition_en.1.400.jpg`,last_modified_t:1700000000,ingredients_text:'Lentils (60%), tomatoes (10%), water, cream, salt',nutriments:{'energy-kcal_100g':110,'energy-kj_100g':460,proteins_100g:6,carbohydrates_100g:14,sugars_100g:2,fat_100g:3,'saturated-fat_100g':1,fiber_100g:4},...extra});
function database(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');sql.exec(catalogueSchema);
 const storage={sql:{exec:(query,...values)=>({toArray:()=>sql.prepare(query).all(...values)})},transactionSync:callback=>{sql.exec('BEGIN');try{const result=callback();sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
 return {sql,storage,db:catalogueSQLAdapter(storage)};
}
const load=(db,products,time=now)=>importCatalogue(db,{products,sourceURL:source,fetchedAt:time},{now:time});
const enqueue=(db,barcodes,reason='scan',time=now)=>enqueueCatalogueEnrichment(db,{barcodes,reason},{now:time});
const claim=(db,limit=1,time=now)=>claimCatalogueEnrichment(db,{limit},{now:time});
const body=(job,extra={})=>({id:job.id,leaseToken:job.leaseToken,sourceFingerprint:job.sourceFingerprint,...extra,
 ...(extra.evidence===evidence?{evidence:{...evidence,nutritionEvidence:labelEvidence(job.barcode)}}:{})});
// Missing salt keeps these fixtures genuinely unresolved under the directional
// model. Successful jobs must supply a source-bound label reading, not a score.
function labelEvidence(barcode){return {
 version:'public-label-extraction-v1',barcode,sourceRevision:1700000000,
 sourceURL:`https://world.openfoodfacts.org/product/${barcode}`,
 images:[{role:'nutrition',url:`https://images.openfoodfacts.org/images/products/${barcode}/nutrition_en.1.400.jpg`}],
 extraction:{conflictingProduct:false,basis:'100g',basisQuote:'Nutrition per 100 g',preparation:'as_sold',preparationQuote:null,
 nutrients:{energyKcal:null,energyKj:null,protein:null,carbohydrate:null,sugars:null,fat:null,saturatedFat:null,fibre:null,salt:{value:.5,quote:'Salt 0.5 g',imageIndex:0}},ingredients:null,ingredientsImageIndex:null}
};}
const evidence={classification:{category:'general',evidence:[{field:'name',quote:'Dhal makhani'}],sweeteners:'unknown',sweetenerEvidence:[]}};

it('queues public unrated snapshots idempotently and prioritises scans over searches and pilot',async()=>{
 const {db,sql}=database();const p=[raw(),raw('5000000000002'),raw('5000000000003')];await load(db,p);
 await enqueue(db,[p[0].code],'pilot');await enqueue(db,[p[1].code],'search');await enqueue(db,[p[2].code],'scan');
 await enqueue(db,[p[0].code],'pilot');assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_jobs').get().n,3);
 const jobs=(await claim(db,3)).jobs;assert.deepEqual(jobs.map(j=>j.barcode),[p[2].code,p[1].code,p[0].code]);assert.deepEqual(jobs.map(j=>j.reason),['scan','search','pilot']);assert.deepEqual(jobs.map(j=>j.priority),[3,2,1]);assert.deepEqual(jobs.map(j=>j.isPilot),[false,false,true]);assert.ok(jobs.every(j=>j.sourceRow.import_source_url===source));
 for(const job of jobs){assert.equal(job.attempt,1);assert.match(job.sourceFingerprint,/^[a-f0-9]{64}$/);assert.equal(JSON.parse(job.sourceRow.provider_json).code,job.barcode);assert.equal(job.evidenceVersion,ENRICHMENT_VERSION);}
 await assert.rejects(()=>enqueueCatalogueEnrichment(db,{barcodes:[p[0].code],reason:'scan',owner:'private'},{now}));
 assert.doesNotMatch(JSON.stringify(await catalogueEnrichmentStatus(db,{}, {now})),/Dhal|500000000|provider_json|leaseToken/);
});
it('does not queue rated, expired, unknown or malformed products and bounds concurrency',async()=>{
 const {db,sql}=database();await load(db,Array.from({length:7},(_,i)=>raw(String(5000000000001+i))));
 await enqueue(db,Array.from({length:7},(_,i)=>String(5000000000001+i)));
 const a=await claim(db,5),b=await claim(db,5);assert.equal(a.jobs.length,5);assert.equal(b.jobs.length,0);
 assert.equal(sql.prepare("SELECT count(*) n FROM catalogue_enrichment_jobs WHERE status='running'").get().n,5);
 await assert.rejects(()=>claim(db,6));
 await load(db,[raw('5000000000020',{categories_tags:['en:ready-meals'],nutriments:{...raw().nutriments,salt_100g:.5}})]);assert.equal((await enqueue(db,['5000000000020'])).queued,0);
 assert.equal((await enqueue(db,['9999999999999'])).missing,1);
 assert.equal((await enqueue(db,['5000000000020'],'scan',now+31*86400000)).queued,0);
});
it('enforces retries, expired leases and backoff without resetting attempts on repeated scans',async()=>{
 const {db,sql}=database();await load(db,[raw()]);await enqueue(db,['5000000000001']);
 let time=now,job=(await claim(db,1,time)).jobs[0];
 time+=ENRICHMENT_LEASE_MS+1;assert.equal((await claim(db,1,time)).jobs.length,0);
 await enqueue(db,['5000000000001'],'scan',time);
 time+=60000;job=(await claim(db,1,time)).jobs[0];assert.equal(job.attempt,2);
 let r=await completeCatalogueEnrichment(db,body(job,{outcome:'retryable_error',errorCode:'analysis_unavailable'}),{now:time});assert.equal(r.status,'retryable');
 assert.equal((await claim(db,1,time+119999)).jobs.length,0);
 time+=120000;job=(await claim(db,1,time)).jobs[0];assert.equal(job.attempt,ENRICHMENT_MAX_ATTEMPTS);
 r=await completeCatalogueEnrichment(db,body(job,{outcome:'retryable_error',errorCode:'source_unavailable'}),{now:time});assert.equal(r.status,'exhausted');
 assert.equal((await claim(db,1,time+86400000)).jobs.length,0);assert.equal(sql.prepare('SELECT attempts FROM catalogue_enrichment_jobs').get().attempts,3);
});
it('defers for bounded cost/provider cooldown without spending retry attempts',async()=>{
 const {db,sql}=database();await load(db,[raw()]);await enqueue(db,['5000000000001']);const job=(await claim(db)).jobs[0];
 await assert.rejects(()=>completeCatalogueEnrichment(db,body(job,{outcome:'deferred',errorCode:'enrichment_budget',retryAt:now+100}),{now}));
 const r=await completeCatalogueEnrichment(db,body(job,{outcome:'deferred',errorCode:'enrichment_budget',retryAt:now+86400000}),{now});assert.equal(r.status,'deferred');
 assert.equal(sql.prepare('SELECT attempts FROM catalogue_enrichment_jobs').get().attempts,0);assert.equal((await claim(db,1,now+1000)).jobs.length,0);
 assert.equal((await claim(db,1,now+86400000)).jobs[0].attempt,1);
});
it('recomputes grounded evidence and reuses the score in search/batch without altering facts or images',async()=>{
 const {db,sql}=database(),p=raw(undefined,{image_front_url:'https://images.openfoodfacts.org/images/products/500/000/000/0001/front_en.1.400.jpg'});await load(db,[p]);
 const original=sql.prepare('SELECT * FROM catalogue_products').get();await enqueue(db,[p.code]);const job=(await claim(db)).jobs[0];
 await assert.rejects(()=>completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence:{...evidence,score:100}}),{now}));
 assert.equal((await completeCatalogueEnrichment(db,{...body(job,{outcome:'evidence',evidence}),leaseToken:'00000000-0000-0000-0000-000000000000'},{now})).stored,false);
 const saved=await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence}),{now:now+1});assert.equal(saved.stored,true);
 const after=sql.prepare('SELECT * FROM catalogue_products').get();for(const k of ['provider_json','source_fingerprint','fetched_at','expires_at','source_revision'])assert.equal(after[k],original[k],k);
 const result=await batchCatalogue(db,{codes:[p.code]},{now:now+2});assert.equal(result.ratings[0].score.available,true);assert.equal(result.ratings[0].score.catalogueEnrichment.sourceFingerprint,original.source_fingerprint);
 const search=await searchCatalogue(db,{query:'dhal',sort:'ratingHighest',minimumRating:saved.value},{now:now+2});assert.equal(search.total,1);assert.equal(search.ratings[0].score.value,saved.value);
 assert.equal((await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence}),{now:now+2})).stored,false,'A completed lease cannot replay');
 await load(db,[p],now+1000);assert.equal((await batchCatalogue(db,{codes:[p.code]},{now:now+1001})).ratings[0].score.value,saved.value);
});
it('rejects stale source completion and drops an overlay after identity/nutrition changes',async()=>{
 const {db,sql}=database();await load(db,[raw()]);await enqueue(db,['5000000000001']);const job=(await claim(db)).jobs[0];
 await load(db,[raw(undefined,{ingredients_text:'Lentils (5%), cream, salt'})],now+1);
 assert.equal((await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence}),{now:now+2})).stale,true);
 await enqueue(db,['5000000000001'],'scan',now+3);const fresh=(await claim(db,1,now+3)).jobs[0];assert.notEqual(fresh.sourceFingerprint,job.sourceFingerprint);
 assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_jobs').get().n,2);
});
it('does not let a source changed during evidence evaluation receive a score',async()=>{
 const {db,sql}=database();await load(db,[raw()]);await enqueue(db,['5000000000001']);const job=(await claim(db)).jobs[0];
 const batch=db.batch;db.batch=async statements=>{sql.prepare('UPDATE catalogue_products SET source_fingerprint=?').run('a'.repeat(64));return batch(statements);};
 const r=await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence}),{now});assert.equal(r.stored,false);assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_scores').get().n,0);
});
it('expired enriched scores are absent from rating filters and do not become numeric zero',async()=>{
 const {db,sql}=database();await load(db,[raw()]);await enqueue(db,['5000000000001']);const job=(await claim(db)).jobs[0];await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence}),{now});
 assert.equal((await searchCatalogue(db,{query:'dhal',minimumRating:0},{now:now+31*86400000})).total,0);
 assert.equal((await batchCatalogue(db,{codes:['5000000000001']},{now:now+31*86400000})).ratings[0].score.available,false);
});
it('renews an expired source-bound overlay for genuine demand while administrative recovery remains current-unrated only',async()=>{
 const {db,sql}=database(),product=raw(),day=86400000;await load(db,[product]);await enqueue(db,[product.code]);
 const job=(await claim(db)).jobs[0];assert.equal((await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence}),{now})).stored,true);
 // Refreshing unchanged facts extends their lifetime, while the earlier label
 // evidence keeps its own expiry. Reads intentionally do not rewrite that row.
 await load(db,[product],now+20*day);const later=now+31*day;
 assert.equal((await batchCatalogue(db,{codes:[product.code]},{now:later})).ratings[0].score.available,false);
 const stored=sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(product.code);
 assert.ok(stored.expires_at>later);assert.equal(JSON.parse(stored.score_json).available,true);
 assert.equal((await catalogueRecoveryCandidates(db,{}, {now:later})).products.length,0);
 const administrative=await enqueueCatalogueEnrichment(db,{reason:'recovery',products:[{barcode:product.code,sourceFingerprint:stored.source_fingerprint}]},{now:later});
 assert.equal(administrative.queued,0);assert.equal(administrative.excluded.not_unrated,1);
 assert.equal(sql.prepare('SELECT status FROM catalogue_enrichment_jobs').get().status,'succeeded');
 assert.equal((await enqueue(db,[product.code],'scan',later)).alreadyKnown,1);
 assert.deepEqual({...sql.prepare('SELECT status,attempts,demand_count FROM catalogue_enrichment_jobs').get()},{status:'pending',attempts:0,demand_count:2});
 const renewed=(await claim(db,1,later)).jobs[0];assert.equal(renewed.id,job.id);assert.equal(renewed.attempt,1);assert.equal(renewed.reason,'scan');
 assert.equal((await completeCatalogueEnrichment(db,body(renewed,{outcome:'evidence',evidence}),{now:later})).stored,true);
 assert.equal((await batchCatalogue(db,{codes:[product.code]},{now:later+1})).ratings[0].score.available,true);
});
it('does not renew expired overlays with superseded scoring or mismatched evidence identity',async()=>{
 for(const mutation of ['source','revision']){
  const {db,sql}=database(),product=raw(),day=86400000;await load(db,[product]);await enqueue(db,[product.code]);
  const job=(await claim(db)).jobs[0];await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence}),{now});
  await load(db,[product],now+20*day);
  const score=JSON.parse(sql.prepare('SELECT score_json FROM catalogue_products').get().score_json);
  if(mutation==='source')score.catalogueEnrichment.sourceFingerprint='f'.repeat(64);else score.classifierVersion='superseded';
  sql.prepare('UPDATE catalogue_products SET score_json=?').run(JSON.stringify(score));
  const result=await enqueue(db,[product.code],'scan',now+31*day);assert.equal(result.queued,0);assert.equal(result.alreadyKnown,0);
  assert.equal(sql.prepare('SELECT status FROM catalogue_enrichment_jobs').get().status,'succeeded');
 }
});
it('public image patches invalidate only source-bound enrichment and preserve image/fact dates',async()=>{
 const {db,sql}=database();await load(db,[raw()]);await enqueue(db,['5000000000001']);const job=(await claim(db)).jobs[0];await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence}),{now});
 const url='https://images.openfoodfacts.org/images/products/500/000/000/0001/front_en.2.400.jpg';
 await patchCatalogueImages(db,{records:[{barcode:'5000000000001',sourceRevision:1700000000,imageFrontURL:url}],sourceURL:source,retrievedAt:now+1},{now:now+1});
 const result=await batchCatalogue(db,{codes:['5000000000001']},{now:now+1});assert.equal(result.products[0].image_front_url,url);assert.equal(result.ratings[0].fetchedAt,now);assert.equal(result.ratings[0].score.available,false);
 assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_scores').get().n,0);
});
it('seeds a single lifetime pilot of at most 1000 products and never stores search identity',async()=>{
 const {db,sql}=database();const products=Array.from({length:1020},(_,i)=>raw(String(5000000000000+i)));
 for(let i=0;i<products.length;i+=200)await load(db,products.slice(i,i+200));
 const first=await seedCatalogueEnrichment(db,{limit:1000},{now});assert.equal(first.pilot.selected,1000);
 const next=await seedCatalogueEnrichment(db,{limit:1000},{now:now+1000});assert.equal(next.pilot.selected,1000);assert.equal(next.queued,0);
 assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_jobs').get().n,1000);
 await load(db,[raw(products[0].code,{ingredients_text:'Lentils (20%), tomatoes (10%), water, cream, salt'})],now+2000);
 assert.equal((await enqueue(db,[products[0].code],'pilot',now+2000)).queued,1,'Refreshing a pilot barcode does not spend a second pilot slot');
 assert.equal((await catalogueEnrichmentStatus(db,{}, {now:now+2000})).pilot.selected,1000);
 assert.equal((await enqueue(db,[products[1000].code],'pilot',now+2000)).queued,0,'A different barcode remains blocked at the pilot cap');
 await assert.rejects(()=>seedCatalogueEnrichment(db,{limit:1001},{now}));
});
it('queues selected unrated public products after DO search/batch using waitUntil',async()=>{
 const {db,storage,sql}=database();await load(db,[raw()]);const tasks=[];const index=new FoodCatalogueIndex({storage,waitUntil:p=>tasks.push(p)},{});
 const response=await index.fetch(new Request('https://index/search',{method:'POST',body:JSON.stringify({query:'dhal'})}));assert.equal(response.status,200);await Promise.all(tasks);
 assert.equal(sql.prepare('SELECT priority FROM catalogue_enrichment_jobs').get().priority,2);
 const selected=await index.fetch(new Request('https://index/batch',{method:'POST',body:JSON.stringify({codes:['5000000000001']})}));assert.equal(selected.status,200);await Promise.all(tasks);
 assert.equal(sql.prepare('SELECT priority FROM catalogue_enrichment_jobs').get().priority,3);
 const status=await index.fetch(new Request('https://index/enrichment/status',{method:'POST',body:'{}'}));assert.equal(status.status,200);
 const review=await index.fetch(new Request('https://index/enrichment/review',{method:'POST',body:'{"limit":1}'}));assert.equal(review.status,200);assert.equal((await review.json()).jobs[0].barcode,'5000000000001');
});

it('retains canonical partial evidence and missing reasons when a grounded category cannot complete nutrition',async()=>{
 const {db,sql}=database();const p=raw(undefined,{nutriments:{...raw().nutriments,salt_100g:undefined}});await load(db,[p]);await enqueue(db,[p.code],'pilot');
 const job=(await claim(db)).jobs[0];const result=await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence:{...evidence}}),{now});assert.equal(result.status,'unresolved');
 const row=sql.prepare('SELECT * FROM catalogue_enrichment_observations').get(),canonical=JSON.parse(row.evidence_json);assert.equal(row.outcome,'unresolved');assert.equal(canonical.classification.category,'general');assert.ok(canonical.evidence.some(e=>e.quote==='Dhal makhani'));
 assert.ok(JSON.parse(row.missing_inputs_json).includes('salt'));assert.equal(sql.prepare('SELECT rating_value FROM catalogue_products').get().rating_value,null);
 const status=await catalogueEnrichmentStatus(db,{}, {now});assert.equal(status.missingInputs.salt,1);assert.equal(status.errorCodes.insufficient_evidence,1);assert.equal(status.pilot.outcomes.unresolved,1);assert.equal(status.scored.total,0);
});
it('counts current-engine exact and estimated pilot gains while excluding superseded work from scheduling',async()=>{
 const {db,sql}=database();const p=ScoreCore.ACTIVE_DIRECTIONAL?raw(undefined,{product_name:'Beurre clarifié',ingredients_text:'Milk fat',categories_tags:[],nutriments:{fat_100g:99,'saturated-fat_100g':60,proteins_100g:0,sugars_100g:0,fiber_100g:0,salt_100g:0}}):raw(undefined,{nutriments:{...raw().nutriments,salt_100g:.5}}),salmon=raw('5000000000002',{product_name:'Raw salmon',ingredients_text:'Raw salmon',categories_tags:[],nutriments:{proteins_100g:20,salt_100g:2.1}});await load(db,[p,salmon,raw('5000000000003')]);await enqueue(db,[p.code,salmon.code,'5000000000003'],'pilot');
 sql.prepare("UPDATE catalogue_enrichment_jobs SET classifier_version='previous' WHERE barcode='5000000000003'").run();
 for(const job of (await claim(db,5)).jobs)await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence:job.barcode===p.code?{classification:{category:ScoreCore.ACTIVE_DIRECTIONAL?'fats_nuts_seeds':'general',evidence:[{field:'name',quote:p.product_name}],sweeteners:'unknown',sweetenerEvidence:[]}}:{}}),{now});
 const status=await catalogueEnrichmentStatus(db,{}, {now});assert.equal(status.classifierVersion,ScoreCore.CLASSIFIER_VERSION);assert.deepEqual(status.scored,{total:2,exact:1,estimated:1});assert.equal(status.pilot.outcomes.enriched,1);assert.equal(status.pilot.outcomes.estimated,1);assert.equal(status.pilot.currentRated,2);assert.equal(status.pilot.currentEstimated,1);assert.equal(status.pilot.currentExact,1);assert.equal(status.supersededJobs,1);assert.equal(status.nextAttemptAt,null);assert.equal(status.counts.pending,undefined);
});
it('cannot replace a same-source score published while the enrichment job was running',async()=>{
 const {db,sql}=database();await load(db,[raw()]);await enqueue(db,['5000000000001']);const job=(await claim(db)).jobs[0];
 const score=scorePackagedProduct(catalogueRecordFromPayload({product:raw(undefined,{categories_tags:['en:ready-meals'],nutriments:{...raw().nutriments,salt_100g:.5}})},'5000000000001',now).product);
 sql.prepare('UPDATE catalogue_products SET score_json=?,rating_value=?').run(JSON.stringify(score),score.value);
 assert.equal((await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence}),{now})).alreadyRated,true);
 assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_scores').get().n,0);
});
it('guards a same-source score race inside the atomic commit',async()=>{
 const {db,sql}=database();await load(db,[raw()]);await enqueue(db,['5000000000001']);const job=(await claim(db)).jobs[0];
 const score=scorePackagedProduct(catalogueRecordFromPayload({product:raw(undefined,{categories_tags:['en:ready-meals'],nutriments:{...raw().nutriments,salt_100g:.5}})},'5000000000001',now).product),batch=db.batch;
 db.batch=async statements=>{sql.prepare('UPDATE catalogue_products SET score_json=?,rating_value=?').run(JSON.stringify(score),score.value);return batch(statements);};
 assert.equal((await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence}),{now})).stored,false);assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_scores').get().n,0);assert.equal(sql.prepare('SELECT rating_value FROM catalogue_products').get().rating_value,score.value);
});
it('clears obsolete enrichment filters when refreshing a scoring version without changing source facts',async()=>{
 const {db,sql}=database();await load(db,[raw()]);await enqueue(db,['5000000000001']);const job=(await claim(db)).jobs[0];await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence}),{now});
 const before=sql.prepare('SELECT provider_json FROM catalogue_products').get().provider_json;
 sql.prepare("UPDATE catalogue_products SET classifier_version='old'").run();sql.prepare("UPDATE catalogue_enrichment_scores SET classifier_version='old'").run();
 const refresh=await recalculateCatalogue(db,{}, {now:now+1});assert.equal(refresh.updated,1);assert.equal(refresh.remaining,0);assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_scores').get().n,0);assert.equal(sql.prepare('SELECT provider_json FROM catalogue_products').get().provider_json,before);
});

it('renews a succeeded same-source job only after its enrichment expires and the source is freshly retrieved',async()=>{
 const {db,sql}=database();await load(db,[raw()]);await enqueue(db,['5000000000001']);const job=(await claim(db)).jobs[0];await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence}),{now});
 await enqueue(db,['5000000000001'],'scan',now+100000);assert.equal((await claim(db,1,now+100000)).jobs.length,0);
 const later=now+31*86400000;await load(db,[raw()],later);await enqueue(db,['5000000000001'],'scan',later);const renewed=(await claim(db,1,later)).jobs[0];assert.equal(renewed.id,job.id);assert.equal(renewed.attempt,1);assert.notEqual(renewed.leaseToken,job.leaseToken);assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_jobs').get().n,1);
 assert.equal((await completeCatalogueEnrichment(db,body(renewed,{outcome:'evidence',evidence}),{now:later})).stored,true);
});

it('reports pilot coverage gained from a newer original OFF source without claiming it was enriched',async()=>{
 const {db}=database();await load(db,[raw()]);await enqueue(db,['5000000000001'],'pilot');const job=(await claim(db)).jobs[0];
 await load(db,[raw(undefined,{categories_tags:['en:ready-meals'],nutriments:{...raw().nutriments,salt_100g:.5}})],now+1);
 assert.equal((await completeCatalogueEnrichment(db,body(job,{outcome:'unresolved'}),{now:now+2})).stale,true);
 const status=await catalogueEnrichmentStatus(db,{}, {now:now+2});assert.equal(status.scored.total,0);assert.equal(status.pilot.currentRated,1);assert.equal(status.pilot.currentExact,1);assert.equal(status.pilot.currentEstimated,0);
});

it('keeps human-readable missing reasons and repairs only pending diagnostics on idempotent enqueue',async()=>{
 const {db,sql}=database();const p=raw(undefined,{ingredients_text:'Lentils, tomatoes, water, cream, salt'});await load(db,[p]);await enqueue(db,[p.code],'pilot');
 let status=await catalogueEnrichmentStatus(db,{}, {now});assert.equal(status.missingInputs.salt,1);
 sql.prepare("UPDATE catalogue_enrichment_observations SET missing_inputs_json='[]'").run();
 await enqueue(db,[p.code],'pilot',now+1);status=await catalogueEnrichmentStatus(db,{}, {now:now+1});assert.equal(status.missingInputs.salt,1);
 assert.equal(sql.prepare('SELECT demand_count FROM catalogue_enrichment_jobs').get().demand_count,0,'Administrative pilot requests never invent user demand');
 const job=(await claim(db,1,now+2)).jobs[0];await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence:{...evidence}}),{now:now+3});
 const canonical=sql.prepare('SELECT * FROM catalogue_enrichment_observations').get();assert.equal(canonical.outcome,'unresolved');assert.deepEqual(JSON.parse(canonical.missing_inputs_json),ScoreCore.ACTIVE_DIRECTIONAL?['salt']:['salt','fruit_vegetable_and_legume_percentage']);
 await enqueue(db,[p.code],'pilot',now+60001);assert.deepEqual(sql.prepare('SELECT * FROM catalogue_enrichment_observations').get(),canonical,'A later demand event cannot overwrite validated partial evidence');
});
it('reviews current public canonical observations with a strict field, count and byte bound',async()=>{
 const {db,sql}=database();await load(db,[raw(undefined,{ingredients_text:'Lentils, tomatoes, cream, salt'}),raw('5000000000002')]);await enqueue(db,['5000000000001','5000000000002'],'pilot');
 for(const job of (await claim(db,2)).jobs)await completeCatalogueEnrichment(db,body(job,{outcome:'evidence',evidence:{...evidence}}),{now});
 const reviewed=await reviewCatalogueEnrichment(db,{limit:20},{now});assert.equal(reviewed.jobs.length,2);assert.equal(reviewed.truncated,false);assert.equal(reviewed.jobs.find(j=>j.barcode==='5000000000001').observation.classification.category,'general');assert.ok(reviewed.jobs.find(j=>j.barcode==='5000000000001').observation.missingInputs.includes('salt'));
 assert.doesNotMatch(JSON.stringify(reviewed),/provider_json|leaseToken|lease_token|sourceRow|nutriments|OPENAI_API_KEY|rawResponse/);
 assert.equal((await reviewCatalogueEnrichment(db,{limit:1},{now})).jobs.length,1);await assert.rejects(()=>reviewCatalogueEnrichment(db,{limit:21},{now}));await assert.rejects(()=>reviewCatalogueEnrichment(db,{limit:0},{now}));await assert.rejects(()=>reviewCatalogueEnrichment(db,{barcode:'5000000000001'},{now}));
 sql.prepare("UPDATE catalogue_enrichment_jobs SET classifier_version='old' WHERE barcode='5000000000002'").run();assert.equal((await reviewCatalogueEnrichment(db,{}, {now})).jobs.length,1);
 // Stored canonical evidence is already bounded on ingestion. Exercise the
 // response budget with several separate maximum-sized valid public records.
 const codes=Array.from({length:4},(_,i)=>String(5000000000010+i));await load(db,codes.map(c=>raw(c)));await enqueue(db,codes);
 const big=JSON.stringify({classification:{category:'general'},evidence:[{kind:'public_label',extraction:{ingredients:'Public ingredient '.repeat(2600)}}],provenance:{version:ENRICHMENT_VERSION}});
 sql.prepare("UPDATE catalogue_enrichment_observations SET evidence_json=? WHERE job_id IN(SELECT id FROM catalogue_enrichment_jobs WHERE barcode>='5000000000010')").run(big);
 const bounded=await reviewCatalogueEnrichment(db,{}, {now});assert.equal(bounded.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=100000);
});

it('retains only bounded specific analysis error codes for public job diagnostics',async()=>{
 const {db}=database(),codes=Array.from({length:4},(_,i)=>String(5000000000100+i));await load(db,codes.map(c=>raw(c)));await enqueue(db,codes);
 const errors=['analysis_timeout','analysis_response_invalid','incompatible_source','unneeded_composition'],jobs=(await claim(db,4)).jobs;
 await assert.rejects(()=>completeCatalogueEnrichment(db,body(jobs[0],{outcome:'retryable_error',errorCode:'provider response with arbitrary content'}),{now}));
 for(let i=0;i<jobs.length;i++)assert.equal((await completeCatalogueEnrichment(db,body(jobs[i],{outcome:'retryable_error',errorCode:errors[i]}),{now})).status,'retryable');
 const status=await catalogueEnrichmentStatus(db,{}, {now});for(const error of errors)assert.equal(status.errorCodes[error],1);
 assert.deepEqual((await reviewCatalogueEnrichment(db,{}, {now})).jobs.map(j=>j.errorCode).sort(),errors.sort());
});


const recoveryProducts=(sql,codes)=>codes.map(barcode=>({barcode,sourceFingerprint:sql.prepare('SELECT source_fingerprint FROM catalogue_products WHERE barcode=?').get(barcode).source_fingerprint}));
const recover=(db,sql,codes,time=now)=>enqueueCatalogueEnrichment(db,{reason:'recovery',products:recoveryProducts(sql,codes)},{now:time});
it('admits source-bound ordinary recovery without pilot membership and orders real demand ahead of OFF popularity',async()=>{
 const {db,sql}=database();const products=[raw('5000000000101',{unique_scans_n:100}),raw('5000000000102',{unique_scans_n:900}),raw('5000000000103',{unique_scans_n:1}),raw('5000000000104',{unique_scans_n:2})];
 await load(db,products);const all=products.map(p=>p.code);
 assert.equal((await recover(db,sql,all)).queued,4);
 assert.equal((await catalogueEnrichmentStatus(db,{}, {now})).pilot.selected,0);
 await enqueue(db,[all[2]],'search',now+1);await enqueue(db,[all[3]],'scan',now+1);
 const first=sql.prepare('SELECT * FROM catalogue_enrichment_jobs WHERE barcode=?').get(all[3]);
 await recover(db,sql,all,now+70000);
 assert.deepEqual(sql.prepare('SELECT * FROM catalogue_enrichment_jobs WHERE barcode=?').get(all[3]),first,'Admin replay does not inflate, downgrade or postpone actual user demand');
 assert.equal(sql.prepare('SELECT sum(demand_count) n FROM catalogue_enrichment_jobs').get().n,2);
 const jobs=(await claim(db,4,now+70000)).jobs;
 assert.deepEqual(jobs.map(j=>j.barcode),[all[3],all[2],all[1],all[0]]);
 assert.deepEqual(jobs.map(j=>j.reason),['scan','search','recovery','recovery']);
 assert.deepEqual(jobs.map(j=>j.offUniqueScans),[2,1,900,100]);
 assert.ok(jobs.every(j=>j.isPilot===false));
});
it('counts repeated real demand with coalescing while ordinary recovery never resets retries',async()=>{
 const {db,sql}=database();const a=raw(),b=raw('5000000000002',{unique_scans_n:999});await load(db,[a,b]);await recover(db,sql,[a.code,b.code]);
 await enqueue(db,[a.code,b.code],'scan',now+1);await enqueue(db,[a.code],'scan',now+2);await enqueue(db,[a.code],'scan',now+60002);
 assert.equal(sql.prepare('SELECT demand_count FROM catalogue_enrichment_jobs WHERE barcode=?').get(a.code).demand_count,2);
 const job=(await claim(db,1,now+60002)).jobs[0];assert.equal(job.barcode,a.code);
 await completeCatalogueEnrichment(db,body(job,{outcome:'retryable_error',errorCode:'analysis_timeout'}),{now:now+60002});
 const before=sql.prepare('SELECT * FROM catalogue_enrichment_jobs WHERE id=?').get(job.id);
 await recover(db,sql,[a.code],now+120003);
 assert.deepEqual(sql.prepare('SELECT * FROM catalogue_enrichment_jobs WHERE id=?').get(job.id),before);
});
it('does not spend or reset the full pilot membership cap when admitting ordinary recovery',async()=>{
 const {db,sql}=database();const products=Array.from({length:1001},(_,i)=>raw(String(5000000000000+i)));
 for(let i=0;i<products.length;i+=200)await load(db,products.slice(i,i+200));
 await seedCatalogueEnrichment(db,{limit:1000},{now});const last=products.at(-1).code;
 assert.equal((await recover(db,sql,[last])).queued,1);
 assert.equal((await catalogueEnrichmentStatus(db,{}, {now})).pilot.selected,1000);
 const declined=await enqueue(db,[last],'pilot');assert.equal(declined.queued,0);assert.equal(declined.excluded.pilot_limit,1);
 assert.equal(sql.prepare('SELECT pilot_selected FROM catalogue_enrichment_jobs WHERE barcode=?').get(last).pilot_selected,0);
 assert.equal((await catalogueEnrichmentStatus(db,{}, {now})).queuedByPriority.recovery,1);
});
it('rejects unsupported, corrupt, mismatched, expired, rated and superseded sources before any queue write',async()=>{
 const {db,sql}=database();const products=Array.from({length:8},(_,i)=>raw(String(5000000000001+i)));
 products[1]=raw(products[1].code,{product_name:'Vodka',categories_tags:['en:alcoholic-beverages'],ingredients_text:'Vodka'});
 products[6].nutriments.salt_100g=.5;
 await load(db,products);
 sql.prepare("UPDATE catalogue_products SET provider_json='[]' WHERE barcode=?").run(products[2].code);
 sql.prepare("UPDATE catalogue_products SET source_fingerprint=? WHERE barcode=?").run('a'.repeat(64),products[3].code);
 sql.prepare('UPDATE catalogue_products SET expires_at=? WHERE barcode=?').run(now-1,products[4].code);
 sql.prepare("UPDATE catalogue_products SET classifier_version='previous' WHERE barcode=?").run(products[5].code);
 const bound=recoveryProducts(sql,products.map(p=>p.code));bound[7].sourceFingerprint='b'.repeat(64);
 const result=await enqueueCatalogueEnrichment(db,{reason:'recovery',products:bound},{now});
 assert.equal(result.queued,1);assert.equal(result.skipped,7);
 assert.deepEqual(result.excluded,{unsupported:1,source_invalid:2,source_expired_or_invalid:1,score_revision_changed:1,not_unrated:1,source_changed:1});
 assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_jobs').get().n,1);
 assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_priority_metadata').get().n,1);
 assert.equal((await enqueue(db,[products[1].code,products[2].code],'scan')).queued,0,'Automatic scan/search admission uses the same source guards');
});
it('exports bounded source-bound candidates with global-ranking inputs and a cursor across empty pages',async()=>{
 const {db,sql}=database();const products=[raw('5000000000001'),raw('5000000000002'),raw('5000000000003',{unique_scans_n:900}),raw('5000000000004',{unique_scans_n:10})];await load(db,products);
 sql.prepare("UPDATE catalogue_products SET provider_json='[]' WHERE barcode IN (?,?)").run(products[0].code,products[1].code);
 await enqueue(db,[products[3].code],'scan');
 const first=await catalogueRecoveryCandidates(db,{limit:2},{now});assert.equal(first.scanned,2);assert.equal(first.products.length,0);assert.equal(first.hasMore,true);assert.equal(first.nextAfter,products[1].code);assert.deepEqual(first.excluded,{source_invalid:2});
 const second=await catalogueRecoveryCandidates(db,{limit:2,after:first.nextAfter},{now});assert.equal(second.scanned,2);assert.equal(second.hasMore,false);assert.equal(second.nextAfter,null);
 assert.deepEqual(second.products.map(p=>p.barcode),[products[3].code,products[2].code]);assert.deepEqual(second.products.map(p=>p.offUniqueScans),[10,900]);
 assert.ok(second.products.every(p=>p.sourceFingerprint.length===64&&!Object.hasOwn(p,'provider_json')));
 assert.equal(second.classifierVersion,ScoreCore.CLASSIFIER_VERSION);
 const before=sql.prepare('SELECT * FROM catalogue_enrichment_jobs').all();await catalogueRecoveryCandidates(db,{}, {now});assert.deepEqual(sql.prepare('SELECT * FROM catalogue_enrichment_jobs').all(),before,'Candidate export has no queue mutation');
 for(const body of [{limit:51},{after:'bad'},{limit:0},{runID:'reset'}])await assert.rejects(()=>catalogueRecoveryCandidates(db,body,{now}));
 const excessive=Array.from({length:51},(_,i)=>({barcode:String(5000000000000+i),sourceFingerprint:'a'.repeat(64)}));
 for(const body of [{reason:'recovery',barcodes:[products[3].code]},{reason:'recovery',products:excessive},{reason:'recovery',products:[second.products[0]]}])await assert.rejects(()=>enqueueCatalogueEnrichment(db,body,{now}));
});
it('does not reoffer unchanged terminal jobs and refuses an admission race without metadata side effects',async()=>{
 const {db,sql}=database();await load(db,[raw()]);await recover(db,sql,['5000000000001']);
 sql.prepare("UPDATE catalogue_enrichment_jobs SET status='exhausted',attempts=3").run();
 const report=await catalogueRecoveryCandidates(db,{}, {now});assert.equal(report.products.length,0);assert.equal(report.excluded.already_processed_or_running,1);
 const other=raw('5000000000002');await load(db,[other]);const sources=recoveryProducts(sql,[other.code]);
 const originalBatch=db.batch;db.batch=async statements=>{sql.prepare("UPDATE catalogue_products SET source_fingerprint=? WHERE barcode=?").run('c'.repeat(64),other.code);return originalBatch(statements);};
 const raced=await enqueueCatalogueEnrichment(db,{reason:'recovery',products:sources},{now});assert.equal(raced.queued,0);assert.equal(raced.excluded.source_changed,1);
 assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_jobs WHERE barcode=?').get(other.code).n,0);
 assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_priority_metadata').get().n,1);
});
it('adds recovery metadata safely to an existing catalogue without changing legacy jobs',async()=>{
 const {db,sql,storage}=database();await load(db,[raw()]);await enqueue(db,['5000000000001'],'pilot');
 sql.exec('DROP TABLE catalogue_enrichment_priority_metadata');const before=sql.prepare('SELECT * FROM catalogue_enrichment_jobs').all();
 sql.exec(catalogueSchema);assert.deepEqual(sql.prepare('SELECT * FROM catalogue_enrichment_jobs').all(),before);
 assert.equal((await claim(db)).jobs[0].reason,'pilot');
});

it('carries real demand and pilot/recovery membership through a lease-bound source refresh without a fake request',async()=>{
 const {db,sql}=database();const product=raw(undefined,{unique_scans_n:9});await load(db,[product]);
 await recover(db,sql,[product.code]);await enqueue(db,[product.code],'pilot');await enqueue(db,[product.code],'scan');await enqueue(db,[product.code],'scan',now+60001);
 const job=(await claim(db,1,now+60001)).jobs[0];assert.equal(job.demandCount,2);assert.equal(job.isPilot,true);
 const updated=raw(product.code,{unique_scans_n:20,last_modified_t:1700000001});await load(db,[updated],now+60002);
 const sourceFingerprint=recoveryProducts(sql,[product.code])[0].sourceFingerprint;
 const request={id:job.id,leaseToken:job.leaseToken,sourceFingerprint};
 assert.equal((await refreshCatalogueEnrichment(db,request,{now:now+60002})).queued,1);
 assert.equal((await refreshCatalogueEnrichment(db,request,{now:now+60003})).alreadyKnown,1);
 const changed=sql.prepare('SELECT j.*,m.recovery_selected FROM catalogue_enrichment_jobs j JOIN catalogue_enrichment_priority_metadata m ON m.job_id=j.id WHERE j.source_fingerprint=?').get(sourceFingerprint);
 assert.equal(changed.priority,3);assert.equal(changed.demand_count,2);assert.equal(changed.last_requested_at,now+60001);assert.equal(changed.pilot_selected,1);assert.equal(changed.recovery_selected,1);
 assert.equal((await catalogueEnrichmentStatus(db,{}, {now:now+60003})).pilot.selected,1);
 assert.equal((await refreshCatalogueEnrichment(db,{...request,leaseToken:'a'.repeat(36)},{now:now+60003})).stale,true);
 assert.equal((await refreshCatalogueEnrichment(db,{...request,sourceFingerprint:'b'.repeat(64)},{now:now+60003})).stale,true);
 const next=(await claim(db,1,now+60003)).jobs[0];assert.equal(next.reason,'scan');assert.equal(next.demandCount,2);assert.equal(next.offUniqueScans,20);
});
it('preserves ordinary recovery reason through refresh and does not retain malformed popularity as demand',async()=>{
 const {db,sql}=database();const product=raw(undefined,{unique_scans_n:{secret:'not a public count'}});await load(db,[product]);
 assert.equal(JSON.parse(sql.prepare('SELECT provider_json FROM catalogue_products').get().provider_json).unique_scans_n,undefined);
 await recover(db,sql,[product.code]);const job=(await claim(db)).jobs[0];
 await load(db,[raw(product.code,{last_modified_t:1700000001,unique_scans_n:40})],now+1);
 const sourceFingerprint=recoveryProducts(sql,[product.code])[0].sourceFingerprint;
 await refreshCatalogueEnrichment(db,{id:job.id,leaseToken:job.leaseToken,sourceFingerprint},{now:now+1});
 const next=(await claim(db,1,now+1)).jobs[0];assert.equal(next.reason,'recovery');assert.equal(next.isPilot,false);assert.equal(next.demandCount,0);assert.equal(next.offUniqueScans,40);
});

it('refuses a source-refresh race after the original lease is revoked',async()=>{
 const {db,sql}=database();await load(db,[raw()]);await recover(db,sql,['5000000000001']);const job=(await claim(db)).jobs[0];
 await load(db,[raw(undefined,{last_modified_t:1700000001})],now+1);
 const sourceFingerprint=recoveryProducts(sql,[job.barcode])[0].sourceFingerprint;
 const batch=db.batch;db.batch=async statements=>{sql.prepare("UPDATE catalogue_enrichment_jobs SET status='stale',lease_token=NULL WHERE id=?").run(job.id);return batch(statements);};
 const result=await refreshCatalogueEnrichment(db,{id:job.id,leaseToken:job.leaseToken,sourceFingerprint},{now:now+1});
 assert.equal(result.queued,0);assert.equal(result.excluded.source_changed,1);
 assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_jobs').get().n,1);
 assert.equal(sql.prepare('SELECT count(*) n FROM catalogue_enrichment_priority_metadata').get().n,1);
});
