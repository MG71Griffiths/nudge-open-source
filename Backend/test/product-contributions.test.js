import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter,FoodCatalogueIndex} from '../src/catalogue-index-object.js';
import {submitContribution,claimContribution,completeContribution,reviewContribution,handleContributionStoreRequest,handleContributionRequest,CONTRIBUTION_MAX_BYTES,nextContributionAlarm,contributionSourceLookup} from '../src/product-contributions.js';
import {batchCatalogue,searchCatalogue,exportCatalogue,importCatalogue,refreshCatalogue,recalculateCatalogue} from '../src/catalogue-index.js';
const now=Date.now(),owner='ab'.repeat(32),other='cd'.repeat(32),id='a0000000-0000-4000-8000-000000000001',barcode='1234567890123';
const image=readFileSync(new URL('./fixtures/blank.jpg',import.meta.url)).toString('base64');
function fixture(){const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');sql.exec(catalogueSchema);const storage={sql:{exec:(query,...values)=>({toArray:()=>sql.prepare(query).all(...values)})},transactionSync:fn=>{sql.exec('BEGIN');try{const r=fn();sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};return {sql,db:catalogueSQLAdapter(storage)};}
const body=(extra={})=>({id,barcode,marketCountry:'GB',store:'sainsburys',consent:{version:'product-contribution-v1',shareProductFacts:true,retainPhotosForReview:true},photos:['front','ingredients','nutrition'].map(role=>({role,mimeType:'image/jpeg',imageBase64:image})),...extra});
const candidate=()=>({readyForReview:true,missingPhotoRoles:[],verification:'unreviewed_photo_prediction',product:{code:barcode,product_name:'Synthetic rice',categories_tags:['en:rices'],ingredients_text:'Rice, water',nutrition:{aggregated_set:{per:'100g',preparation:'as_sold',nutrients:{'energy-kcal':{value:120,unit:'kcal'},proteins:{value:4,unit:'g'},carbohydrates:{value:20,unit:'g'},fat:{value:3,unit:'g'},'saturated-fat':{value:.5,unit:'g'},sugars:{value:2,unit:'g'},fiber:{value:3,unit:'g'},salt:{value:.2,unit:'g'}}}}},prediction:{evidence:[{quote:'Private packaging text',photoSHA256:'11'.repeat(32)}]}});
const internal=(db,action,{who=owner,admin=false,job=false,data={},query='',time=now}={})=>handleContributionStoreRequest(db,new Request('https://catalogue-index/contributions/'+action+query,{method:'POST',headers:admin?{'x-nudge-admin':'true'}:job?{'x-nudge-internal':'true'}:{'x-nudge-owner':who},body:JSON.stringify(data)}),{now:time});
async function pending(db,prediction=candidate()){await submitContribution(db,owner,body(),{now});const job=await claimContribution(db,{now:now+1});await completeContribution(db,{id,lease:job.lease,sourceLookup:'not_found',candidate:prediction},{now:now+2});return job;}
describe('private packaging contributions and reviewed publication',()=>{
 it('requires explicit consent and bounded genuine JPEG roles, rejecting client facts',async()=>{
  const {db}=fixture();for(const b of [body({consent:{version:'product-contribution-v1',shareProductFacts:false,retainPhotosForReview:true}}),body({facts:{protein:50}}),body({photos:[{role:'meal',mimeType:'image/jpeg',imageBase64:image}]}),body({photos:[{role:'front',mimeType:'image/jpeg',imageBase64:'AAAA'}]}),body({photos:[body().photos[0],body().photos[0]]}),body({photos:[{...body().photos[0],imageBase64:'A'.repeat(1000004)}]})])await assert.rejects(()=>submitContribution(db,owner,b,{now}));
  assert.equal((await submitContribution(db,owner,body({photos:[body().photos[0]]}),{now})).contribution.status,'queued');
 });
 it('is idempotent per owner and exact body without exposing stored photos or private predictions',async()=>{
  const {db,sql}=fixture();const first=await submitContribution(db,owner,body(),{now}),replay=await submitContribution(db,owner,body({photos:body().photos.toReversed()}),{now:now+1});assert.equal(replay.replayed,true);assert.equal(first.contribution.createdAt,now);assert.equal(sql.prepare('SELECT count(*) AS n FROM product_contribution_photos').get().n,3);
  await assert.rejects(()=>submitContribution(db,other,body(),{now}),{code:'contribution_idempotency_conflict'});await assert.rejects(()=>submitContribution(db,owner,body({barcode:'1234567890124'}),{now}),{code:'contribution_idempotency_conflict'});
  assert.doesNotMatch(JSON.stringify(first),/imageBase64|candidate|Private packaging/);assert.equal((await internal(db,'status',{who:other,query:'?id='+id})).status,404);
 });
 it('claims once, recovers an expired lease, ignores old completions, and caps attempts',async()=>{
  const {db}=fixture();await submitContribution(db,owner,body(),{now});const first=await claimContribution(db,{now});assert.equal(first.attempt,1);assert.equal(await claimContribution(db,{now:now+1}),null);
  const second=await claimContribution(db,{now:now+120001});assert.equal(second.attempt,2);assert.equal((await completeContribution(db,{id,lease:first.lease,sourceLookup:'not_found',candidate:candidate()},{now:now+120002})).completed,false);
  assert.equal((await completeContribution(db,{id,lease:second.lease,sourceLookup:'unavailable',candidate:null},{now:now+120003})).completed,true);assert.equal(await claimContribution(db,{now:now+120004}),null);
  const third=await claimContribution(db,{now:now+720004});assert.equal(third.attempt,3);assert.equal(await claimContribution(db,{now:now+840005}),null);
  const result=await(await internal(db,'status',{query:'?id='+id,time:now+840006})).json();assert.equal(result.contribution.status,'retryable_error');assert.equal(result.contribution.canRetry,false);
 });
 it('keeps pending facts and photos outside search, batch and public OFF export',async()=>{
  const {db}=fixture();await pending(db);assert.equal((await batchCatalogue(db,{codes:[barcode]},{now})).products.length,0);assert.equal((await searchCatalogue(db,{query:''},{now})).total,0);assert.equal((await exportCatalogue(db,new URL('https://nudge.example/export'),{now})).products.length,0);
  const status=await(await internal(db,'status',{query:'?id='+id,time:now+3})).json();assert.equal(status.contribution.status,'pending_review');assert.equal(status.candidate,undefined);
  const admin=await(await internal(db,'status',{admin:true,query:'?id='+id,time:now+3})).json();assert.ok(admin.candidate);assert.equal(admin.photos.length,3);assert.equal(admin.observedMarket.verification,'user_observation');
  assert.equal((await internal(db,'photo',{query:'?id='+id+'&role=front'})).status,404);
  const photo=await internal(db,'photo',{admin:true,query:'?id='+id+'&role=front'});assert.equal(photo.status,200);assert.equal(photo.headers.get('content-type'),'image/jpeg');assert.equal(Buffer.from(await photo.arrayBuffer()).toString('base64'),image);
 });
 it('publishes only independently confirmed reviewed facts with own provenance and deterministic ratings',async()=>{
  const {db,sql}=fixture();await pending(db);const review={decision:'publish',expectedUpdatedAt:now+2,confirmBarcode:true,confirmLabelFacts:true,confirmCategory:true};
  await assert.rejects(()=>reviewContribution(db,id,{...review,confirmBarcode:false},{now:now+3}));await assert.rejects(()=>reviewContribution(db,id,{...review,expectedUpdatedAt:now},{now:now+3}),{code:'contribution_review_conflict'});
  const result=await reviewContribution(db,id,review,{now:now+3});assert.equal(result.contribution.status,'published');assert.equal(result.contribution.canDelete,false);assert.equal(sql.prepare('SELECT count(*) AS n FROM product_contribution_photos').get().n,0);
  const batch=await batchCatalogue(db,{codes:[barcode]},{now:now+4});assert.equal(batch.products.length,1);assert.equal(batch.ratings[0].sourceKind,'nudge_community');assert.match(batch.ratings[0].sourceURL,/products\/reviewed\/1234567890123$/);assert.equal(batch.products[0].countries_tags,undefined);assert.equal(batch.products[0].stores,undefined);assert.equal(batch.ratings[0].score.value,100);assert.equal(batch.catalogue.licenceURL,null);assert.doesNotMatch(batch.catalogue.attribution,/Open Food Facts/);assert.doesNotMatch(JSON.stringify(batch),/Private packaging|imageBase64|owner/);
  assert.equal((await searchCatalogue(db,{query:''},{now})).total,0);assert.equal((await internal(db,'delete',{query:'?id='+id,time:now+4})).status,409);
  const pub=await(await internal(db,'reviewed-export',{job:true,time:now+4})).json();assert.equal(pub.products[0].code,barcode);assert.equal(pub.catalogue.photosPublic,false);
 });
 it('never overwrites authoritative OFF facts with a reviewed submission',async()=>{
  const {db}=fixture();await pending(db);await reviewContribution(db,id,{decision:'publish',expectedUpdatedAt:now+2,confirmBarcode:true,confirmLabelFacts:true,confirmCategory:true},{now:now+3});
  await importCatalogue(db,{products:[{...candidate().product,product_name:'Public OFF rice',countries_tags:['en:united-kingdom']}],sourceURL:'https://static.openfoodfacts.org/data/off.jsonl',fetchedAt:now+4},{now:now+4});const result=await batchCatalogue(db,{codes:[barcode]},{now:now+5});assert.equal(result.products.length,1);assert.equal(result.products[0].product_name,'Public OFF rice');assert.notEqual(result.ratings[0].sourceKind,'nudge_community');
 });
 it('uses compatible reviewed facts for an incomplete exact source while preserving the original OFF record',async()=>{
  const {db,sql}=fixture(),prediction=candidate();prediction.product.brands='Test';
  await importCatalogue(db,{products:[{code:barcode,product_name:'Synthetic rice',brands:'Test',ingredients_text:'Rice, water',categories_tags:['en:rices'],countries_tags:['en:united-kingdom'],stores:'Tesco',nutriments:{'energy-kcal_100g':120,proteins_100g:4,carbohydrates_100g:20}}],sourceURL:'https://static.openfoodfacts.org/data/off.jsonl',fetchedAt:now-1000},{now});
  const before=sql.prepare('SELECT * FROM catalogue_products').get();await pending(db,prediction);await reviewContribution(db,id,{decision:'publish',expectedUpdatedAt:now+2,confirmBarcode:true,confirmLabelFacts:true,confirmCategory:true},{now:now+3});
  const result=await batchCatalogue(db,{codes:[barcode]},{now:now+4});assert.equal(result.products.length,1);assert.equal(result.ratings[0].sourceKind,'nudge_community');assert.equal(result.ratings[0].score.value,100);assert.equal(result.products[0].stores,undefined);assert.equal(result.products[0].countries_tags,undefined);
  assert.deepEqual(sql.prepare('SELECT * FROM catalogue_products').get(),before);assert.equal((await searchCatalogue(db,{query:'rice',store:'tesco'},{now:now+4})).total,1);assert.deepEqual((await exportCatalogue(db,new URL('https://nudge.example/export'),{now})).products[0].countries_tags,['en:united-kingdom']);
 });
 it('never replaces conflicting identity, basis, known quantities, ingredients or allergy evidence',async()=>{
  for(const mutation of [{brands:'Other'},{product_name:'Other rice'},{quantity:'500 ml',product_quantity_unit:'ml'},{nutriments:{proteins_100g:8}},{ingredients_text:'Rice, milk'},{allergens:'Contains milk'},{allergens_tags:['en:milk']},{traces_tags:['en:peanuts']},{nutrition_data_prepared:'on',nutrition_data:''}]){
   const {db}=fixture(),prediction=candidate();prediction.product.brands='Test';
   await importCatalogue(db,{products:[{code:barcode,product_name:'Synthetic rice',brands:'Test',countries_tags:['en:united-kingdom'],nutriments:{proteins_100g:4},...mutation}],sourceURL:'https://static.openfoodfacts.org/data/off.jsonl',fetchedAt:now-1000},{now});await pending(db,prediction);await reviewContribution(db,id,{decision:'publish',expectedUpdatedAt:now+2,confirmBarcode:true,confirmLabelFacts:true,confirmCategory:true},{now:now+3});
   const result=await batchCatalogue(db,{codes:[barcode]},{now:now+4});assert.notEqual(result.ratings[0].sourceKind,'nudge_community',JSON.stringify(mutation));
  }
 });
 it('withdrawal deletes photos/predictions and prevents in-flight analysis or same-ID replay resurrecting them',async()=>{
  const {db,sql}=fixture();await submitContribution(db,owner,body(),{now});const job=await claimContribution(db,{now:now+1});assert.equal((await internal(db,'delete',{query:'?id='+id,time:now+2})).status,200);
  assert.equal((await completeContribution(db,{id,lease:job.lease,sourceLookup:'not_found',candidate:candidate()},{now:now+3})).completed,false);assert.equal(sql.prepare('SELECT count(*) AS n FROM product_contribution_photos').get().n,0);assert.equal((await internal(db,'status',{query:'?id='+id,time:now+4})).status,404);
  await assert.rejects(()=>submitContribution(db,owner,body(),{now:now+4}),{code:'contribution_deleted'});assert.equal((await(await internal(db,'list')).json()).contributions.length,0);
 });
 it('rejects stale review after withdrawal and cleans expired photos within the retention bound',async()=>{
  const {db,sql}=fixture();await pending(db);await internal(db,'delete',{query:'?id='+id,time:now+3});await assert.rejects(()=>reviewContribution(db,id,{decision:'publish',expectedUpdatedAt:now+2,confirmBarcode:true,confirmLabelFacts:true,confirmCategory:true},{now:now+4}),{code:'contribution_not_found'});
  const b=body({id:'a0000000-0000-4000-8000-000000000002'});await submitContribution(db,owner,b,{now});assert.equal((await internal(db,'status',{query:'?id='+b.id,time:now+30*86400000})).status,404);assert.equal(sql.prepare('SELECT count(*) AS n FROM product_contribution_photos').get().n,0);
 });
 it('enforces active-owner limits, separates owners and permits rejection to free capacity',async()=>{
  const {db}=fixture();for(let i=1;i<=20;i++)await submitContribution(db,owner,body({id:'a0000000-0000-4000-8000-'+String(i).padStart(12,'0')}),{now});await assert.rejects(()=>submitContribution(db,owner,body({id:'a0000000-0000-4000-8000-000000000021'}),{now}),{code:'contribution_queue_full'});
  const list=await(await internal(db,'list',{who:other})).json();assert.equal(list.contributions.length,0);
 });
 it('removes an erased owner’s private queue and photos but preserves independently reviewed public facts',async()=>{
  const {db,sql}=fixture();await pending(db);await reviewContribution(db,id,{decision:'publish',expectedUpdatedAt:now+2,confirmBarcode:true,confirmLabelFacts:true,confirmCategory:true},{now:now+3});
  await submitContribution(db,owner,body({id:'a0000000-0000-4000-8000-000000000002'}),{now});await submitContribution(db,other,body({id:'a0000000-0000-4000-8000-000000000003'}),{now});
  assert.equal((await internal(db,'purge-owner')).status,400,'Owner HTTP dispatch cannot invoke internal account erasure');
  const request=new Request('https://index/contributions/purge-owner',{method:'POST',headers:{'x-nudge-internal':'true','x-nudge-owner':owner},body:'{}'});
  const result=await(await handleContributionStoreRequest(db,request,{now:now+4})).json();assert.equal(result.deleted,true);assert.equal(result.removed,2);assert.match(result.purgeToken,/^[a-f0-9-]{36}$/);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM product_contributions WHERE owner=?').get(owner).n,0);assert.equal(sql.prepare('SELECT count(*) AS n FROM product_contribution_photos').get().n,3);
  assert.equal((await batchCatalogue(db,{codes:[barcode]},{now:now+5})).products.length,1);
 });
 it('reports country-tag mismatch without inventing availability or changing public metadata',()=>{
  const outcome={status:'found',record:{product:{countriesTags:['en:france']}}},original=structuredClone(outcome);
  assert.equal(contributionSourceLookup(outcome,'GB'),'found_other_market');assert.equal(contributionSourceLookup(outcome,'FR'),'found');assert.equal(contributionSourceLookup(outcome,'ZZ'),'found');
  assert.equal(contributionSourceLookup({status:'found',record:{product:{countriesTags:[]}}},'GB'),'found');assert.equal(contributionSourceLookup({status:'not_found'},'GB'),'not_found');assert.equal(contributionSourceLookup({status:'unavailable'},'GB'),'unavailable');assert.deepEqual(outcome,original);
 });
 it('serializes global processing and schedules durable retry/retention alarms from actual queue state',async()=>{
  const {db}=fixture();await submitContribution(db,owner,body(),{now});await submitContribution(db,other,body({id:'a0000000-0000-4000-8000-000000000002'}),{now:now+1});
  assert.equal(await nextContributionAlarm(db,{now:now+2}),now+102);const job=await claimContribution(db,{now:now+3});assert.equal(job.marketCountry,'GB');assert.equal(await claimContribution(db,{now:now+4}),null);assert.equal(await nextContributionAlarm(db,{now:now+4}),now+120003);
  await completeContribution(db,{id,lease:job.lease,sourceLookup:'found_other_market',candidate:candidate()},{now:now+5});const next=await claimContribution(db,{now:now+6});assert.equal(next.owner,other);assert.equal((await(await internal(db,'status',{query:'?id='+id,time:now+7})).json()).contribution.sourceLookup,'found_other_market');
 });
 it('does not postpone an existing queued alarm when owner status is polled repeatedly',async()=>{
  const {db}=fixture();await submitContribution(db,owner,body(),{now});const scheduled=Date.now()+50;let alarm=scheduled;
  const instance=Object.create(FoodCatalogueIndex.prototype);instance.db=db;instance.ctx={storage:{getAlarm:async()=>alarm,setAlarm:async value=>{alarm=value;},deleteAlarm:async()=>{alarm=null;}}};
  await Promise.all([instance.scheduleContributions(),instance.scheduleContributions()]);assert.equal(alarm,scheduled);
 });
 it('recalculates reviewed scores after a classifier update without changing source evidence or freshness',async()=>{
  const {db,sql}=fixture();await pending(db);await reviewContribution(db,id,{decision:'publish',expectedUpdatedAt:now+2,confirmBarcode:true,confirmLabelFacts:true,confirmCategory:true},{now:now+3});
  const before=sql.prepare('SELECT * FROM reviewed_products').get();sql.exec("UPDATE reviewed_products SET classifier_version='previous'");
  const refreshed=await recalculateCatalogue(db,{}, {now:now+31*86400000});assert.equal(refreshed.updated,1);assert.equal(refreshed.remaining,0);
  const after=sql.prepare('SELECT * FROM reviewed_products').get();for(const key of ['provider_json','source_revision','source_fingerprint','observed_at','reviewed_at','expires_at','provenance_json'])assert.equal(after[key],before[key],key);assert.equal(after.calculated_at,now+31*86400000);assert.equal((await batchCatalogue(db,{codes:[barcode]},{now:now+31*86400000})).ratings[0].freshness,'stale');
 });
 it('redacts unexpected private contribution parser/storage failures from diagnostic logs',async()=>{
  const instance=Object.create(FoodCatalogueIndex.prototype);instance.db={batch:async()=>{throw new Error('PRIVATE_IMAGE_OR_CANDIDATE');}};const old=console.error,messages=[];console.error=value=>messages.push(value);
  try{const response=await instance.fetch(new Request('https://index/contributions/list',{method:'POST',headers:{'x-nudge-owner':owner},body:'{}'}));assert.equal(response.status,503);assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_IMAGE_OR_CANDIDATE/);assert.equal(JSON.parse(messages[0]).action,'contribution');}finally{console.error=old;}
 });
 it('forwards bounded raw upload bytes only with trusted owner metadata',async()=>{
  const {db}=fixture();const instance=Object.create(FoodCatalogueIndex.prototype);instance.db=db;let forwarded;
  const env={FOOD_CATALOGUE_INDEX:{idFromName:v=>v,get:()=>({fetch:(url,init)=>{forwarded=init;return instance.fetch(new Request(url,init));}})}};
  const raw=' '+JSON.stringify(body())+'\n',request=new Request('https://nudge.example/v1/product-contributions',{method:'POST',headers:{'content-type':'application/json'},body:raw});
  const response=await handleContributionRequest(request,env,{owner});assert.equal(response.status,200);assert.ok(forwarded.body instanceof Uint8Array);assert.equal(new TextDecoder().decode(forwarded.body),raw);assert.equal(forwarded.headers['x-nudge-owner'],owner);
  const oversized=new Request('https://nudge.example/v1/product-contributions',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(CONTRIBUTION_MAX_BYTES+1)});assert.equal((await handleContributionRequest(oversized,env,{owner})).status,413);
 });
});
