import {it,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter} from '../src/catalogue-index-object.js';
import {importCatalogue,batchCatalogue,searchCatalogue,recalculateCatalogue,patchCatalogueImages} from '../src/catalogue-index.js';
import {catalogueRecordFromPayload} from '../src/food-catalogue.js';
import {getCatalogueFromIndex} from '../src/catalogue-service.js';
import {withheldCatalogueScore,qualityHoldCandidateSHA256,applyActiveQualityHoldStatement,publicCatalogueQualityHoldMatches} from '../src/catalogue-quality-hold.js';
import {applyCatalogueScoreEvidenceStatements} from '../src/catalogue-score-evidence.js';
import {ScoreCore} from '../src/nutrition-core.js';
import worker from '../src/worker.js';

const code='5000000000001',now=Date.now(),sourceURL='https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz';
const raw=()=>({code,product_name:'Test beans',countries_tags:['en:united-kingdom'],last_modified_t:1700000000,
 categories_tags:['en:baked-beans'],ingredients_text:'Beans (60%), water, tomatoes, salt',
 nutriments:{'energy-kcal_100g':90,proteins_100g:5,carbohydrates_100g:14,fat_100g:.5,'saturated-fat_100g':.1,sugars_100g:4,fiber_100g:4,salt_100g:.5}});
async function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec(catalogueSchema);
 const storage={sql:{exec:(q,...v)=>({toArray:()=>sql.prepare(q).all(...v)})},transactionSync:fn=>{sql.exec('BEGIN');try{const r=fn();sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const db=catalogueSQLAdapter(storage);await importCatalogue(db,{products:[raw()],sourceURL,fetchedAt:now},{now});
 const row=sql.prepare('SELECT * FROM catalogue_products').get(),candidate=JSON.parse(row.score_json);
 assert.equal(candidate.available,true);
 const hold={version:'catalogue-quality-hold-v1',runID:'quality-test-run',barcode:code,sourceFingerprint:row.source_fingerprint,sourceFetchedAt:now,
  reasonCode:'source_identity_conflict',reviewID:'quality-test-review',reviewNote:'Reviewed source mismatch',evidenceNote:'Synthetic fixture identity conflict',reviewedAt:now+1,
  candidateSHA256:await qualityHoldCandidateSHA256(candidate),revision:{method:candidate.methodId,version:candidate.version,classifierVersion:candidate.classifierVersion}};
 const score=withheldCatalogueScore(candidate,hold);
 sql.prepare('INSERT INTO catalogue_quality_holds VALUES(?,?,?,?,?,?)').run(code,row.source_fingerprint,hold.runID,JSON.stringify(hold),JSON.stringify(score),now+1);
 await db.batch([applyActiveQualityHoldStatement(db,{barcode:code})]);
 const read=()=>sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(code);
 const env={FOOD_CATALOGUE_INDEX:{idFromName:x=>x,get:()=>({fetch:async()=>Response.json(await batchCatalogue(db,{codes:[code]},{now:now+2}))})}};
 return {sql,db,hold,score,candidate,row,read,env};
}
afterEach(()=>mock.restoreAll());

it('keeps a reviewed hold across same-source import and rating backfill without changing raw facts',async()=>{
 const {db,sql,row,read}=await fixture();
 await importCatalogue(db,{products:[raw()],sourceURL,fetchedAt:now+10},{now:now+10});
 assert.equal(read().rating_value,null);assert.equal(read().provider_json,row.provider_json);
 sql.prepare("UPDATE catalogue_products SET classifier_version='old'").run();
 await recalculateCatalogue(db,{}, {now:now+20});
 assert.equal(read().rating_value,null);assert.equal(read().classifier_version,ScoreCore.CLASSIFIER_VERSION);
 assert.equal(JSON.parse(read().score_json).catalogueQualityHold.sourceFingerprint,row.source_fingerprint);
 assert.equal((await searchCatalogue(db,{query:'beans',minimumRating:1},{now:now+20})).total,0);
 assert.equal((await searchCatalogue(db,{query:'bea',prefixMatch:true,minimumRating:1},{now:now+20})).total,0);
 assert.equal((await searchCatalogue(db,{query:'bea',prefixMatch:true,minimumRating:1,includeCoverage:false},{now:now+20})).total,0);
 const live=await searchCatalogue(db,{query:'bea',prefixMatch:true},{now:now+20});
 assert.equal(live.total,1);assert.equal(live.ratings[0].score.available,false);
 assert.equal(live.ratings[0].score.catalogueQualityHold.sourceFingerprint,row.source_fingerprint);
});

it('masks later classification-evidence writes atomically for the reviewed source',async()=>{
 const {db,row,candidate,read}=await fixture();
 const record={barcode:code,sourceFingerprint:row.source_fingerprint,fetchedAt:now,factsFingerprint:'b'.repeat(64),method:candidate.methodId,
  version:candidate.version,classifierVersion:candidate.classifierVersion,evidenceVersion:'public-classification-evidence-v1',classification:{},score:candidate,calculatedAt:now+10};
 await db.batch(applyCatalogueScoreEvidenceStatements(record).map(({sql,values})=>db.prepare(sql).bind(...values)));
 assert.equal(read().rating_value,null);assert.equal(JSON.parse(read().score_json).available,false);
});

it('does not carry a hold to a different raw source fingerprint',async()=>{
 const {db,read,row}=await fixture();
 await importCatalogue(db,{products:[{...raw(),ingredients_text:'Beans (70%), water, tomatoes, salt'}],sourceURL,fetchedAt:now+20},{now:now+20});
 assert.notEqual(read().source_fingerprint,row.source_fingerprint);assert.equal(JSON.parse(read().score_json).available,true);
 assert.equal(JSON.parse(read().score_json).catalogueQualityHold,undefined);
});

it('does not treat an image-only patch as repaired nutrition evidence',async()=>{
 const {db,read,row}=await fixture();
 await patchCatalogueImages(db,{sourceURL,retrievedAt:now+10,records:[{barcode:code,sourceRevision:raw().last_modified_t,imageURL:'https://images.openfoodfacts.org/images/products/500/000/000/0001/front_en.1.400.jpg'}]},{now:now+10});
 assert.equal(read().source_fingerprint,row.source_fingerprint);assert.equal(read().rating_value,null);
});

it('atomically fences an image write when a quality hold activates after its read',async()=>{
 const {db,sql,hold,score,candidate,row,read}=await fixture();
 sql.exec('DELETE FROM catalogue_quality_holds');
 sql.prepare('UPDATE catalogue_products SET score_json=?,rating_value=?').run(JSON.stringify(candidate),candidate.value);
 const racingDB={...db,batch:async statements=>{
   sql.prepare('INSERT INTO catalogue_quality_holds VALUES(?,?,?,?,?,?)').run(code,row.source_fingerprint,hold.runID,JSON.stringify(hold),JSON.stringify(score),now+1);
   await db.batch([applyActiveQualityHoldStatement(db,{barcode:code})]);
   return db.batch(statements);
 }};
 const result=await patchCatalogueImages(racingDB,{sourceURL,retrievedAt:now+10,records:[{barcode:code,sourceRevision:raw().last_modified_t,imageURL:'https://images.openfoodfacts.org/images/products/500/000/000/0001/front_en.1.400.jpg'}]},{now:now+10});
 assert.equal(result.conflicts,1);assert.equal(read().source_fingerprint,row.source_fingerprint);assert.equal(read().rating_value,null);
});

it('returns the source-bound hold even after cache expiry, with no OFF or AI fallback',async()=>{
 const {env,sql,hold}=await fixture();assert.ok(now+1<Date.now());sql.prepare('UPDATE catalogue_products SET expires_at=?').run(now+1);
 const external=mock.method(globalThis,'fetch',async()=>{throw new Error('External requests forbidden');});
 const record=await getCatalogueFromIndex(env,code);
 assert.equal(record.catalogueRating.available,false);assert.equal(record.catalogueSourceFingerprint,hold.sourceFingerprint);
 const token='d'.repeat(64),httpEnv={...env,PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex')};
 const lookup=await worker.fetch(new Request('https://nudge.example/v1/products/lookup',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({barcode:code})}),httpEnv);
 assert.equal(lookup.status,200);const lookupBody=await lookup.json();assert.equal(lookupBody.catalogueRating.available,false);assert.equal(lookupBody.catalogueSourceFingerprint,hold.sourceFingerprint);
 const product=catalogueRecordFromPayload({product:raw()},code,now).product;
 const response=await worker.fetch(new Request('https://nudge.example/v1/products/score',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({product})}),httpEnv);
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.score.value,null);assert.equal(body.score.scoreBasis,'catalogue_quality_hold');
 assert.equal(publicCatalogueQualityHoldMatches(body.score,{barcode:code,sourceFingerprint:hold.sourceFingerprint}),true);
 assert.equal(external.mock.callCount(),0);
});

it('does not turn a configured index outage or malformed response into an unreviewed local score',async()=>{
 const token='d'.repeat(64),product=catalogueRecordFromPayload({product:raw()},code,now).product;
 const external=mock.method(globalThis,'fetch',async()=>{throw new Error('External requests forbidden');});
 let quotaCalls=0;
 for(const reply of [()=>new Response('',{status:503}),()=>{throw new Error('network');},()=>Response.json({}),()=>Response.json({products:[raw()],ratings:[]})]){
  const env={PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),
   FOOD_CATALOGUE_INDEX:{idFromName:v=>v,get:()=>({fetch:async()=>reply()})},
   LABEL_QUOTA:{idFromName:v=>v,get:()=>({fetch:async()=>{quotaCalls++;throw new Error('Fallback forbidden');}})}};
  for(const [route,body] of [['score',{product}],['lookup',{barcode:code}]]){
   const response=await worker.fetch(new Request('https://nudge.example/v1/products/'+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)}),env);
   assert.equal(response.status,503);assert.equal((await response.json()).score,undefined);
  }
 }
 assert.equal(external.mock.callCount(),0);assert.equal(quotaCalls,0);
});

it('requires complete matching metadata and a valid hold before treating a nonempty response as checked',async()=>{
 const {db}=await fixture(),payload=await batchCatalogue(db,{codes:[code]},{now:now+2});
 const token='d'.repeat(64),product=catalogueRecordFromPayload({product:raw()},code,now).product;
 const external=mock.method(globalThis,'fetch',async()=>{throw new Error('External requests forbidden');});let quotaCalls=0;
 const changes=[b=>delete b.ratings[0].score,b=>b.ratings[0].score=null,b=>b.ratings[0].score={},
  b=>delete b.ratings[0].score.catalogueQualityHold,b=>b.ratings[0].score.catalogueQualityHold=null,
  b=>delete b.ratings[0].expiresAt,b=>delete b.ratings[0].calculatedAt,b=>delete b.ratings[0].sourceFingerprint,
  b=>{delete b.products[0].product_name;delete b.products[0].product_name_en;},
  b=>b.products[0].code='9999999999999',b=>b.ratings[0].barcode='9999999999999',
  b=>{b.products[0].code='9999999999999';b.ratings[0].barcode='9999999999999';},
  b=>b.products.push(b.products[0]),b=>b.ratings.push(b.ratings[0]),b=>b.products=[],
  b=>b.ratings[0].classifierVersion='unexpected',
  ...[null,false,0,[],{}].map(value=>b=>{b.products[0]=value;b.ratings[0]=value;})];
 for(const change of changes){
  const body=structuredClone(payload);change(body);
  const env={PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),
   FOOD_CATALOGUE_INDEX:{idFromName:v=>v,get:()=>({fetch:async()=>Response.json(body)})},
   LABEL_QUOTA:{idFromName:v=>v,get:()=>({fetch:async()=>{quotaCalls++;throw new Error('Fallback forbidden');}})}};
  for(const [route,requestBody] of [['score',{product}],['lookup',{barcode:code}]]){
   const response=await worker.fetch(new Request('https://nudge.example/v1/products/'+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(requestBody)}),env);
   assert.equal(response.status,503);assert.equal((await response.json()).score,undefined);
  }
 }
 assert.equal(external.mock.callCount(),0);assert.equal(quotaCalls,0);
});

it('rejects a caller-authored quality-hold marker instead of treating it as catalogue provenance',async()=>{
 const {score}=await fixture(),token='d'.repeat(64);
 const product={...catalogueRecordFromPayload({product:raw()},code,now).product,catalogueQualityHold:score.catalogueQualityHold};
 const env={PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex')};
 const response=await worker.fetch(new Request('https://nudge.example/v1/products/score',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({product})}),env);
 assert.equal(response.status,400);
});
