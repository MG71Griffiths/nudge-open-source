import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter,FoodCatalogueIndex} from '../src/catalogue-index-object.js';
import {submitContribution,claimContribution,completeContribution,reviewContribution,handleContributionStoreRequest} from '../src/product-contributions.js';
import {updateAmbassador} from '../src/ambassadors.js';
import {batchCatalogue,importCatalogue,exportCatalogue} from '../src/catalogue-index.js';
import {getCatalogueOutcome} from '../src/catalogue-service.js';
import {compatibleReviewedReplacement,reviewedCatalogueRecord} from '../src/reviewed-catalogue.js';
import worker from '../src/worker.js';

const now=Date.now(),owner='ab'.repeat(32),other='cd'.repeat(32),barcode='1234567890123';
const photo=readFileSync(new URL('./fixtures/blank.jpg',import.meta.url)).toString('base64');
const correction={fields:['nutrition'],note:'The pack says 8.2 g protein per 100 g.'};
const body=(extra={})=>({id:crypto.randomUUID(),barcode,marketCountry:'GB',store:null,consent:{version:'product-contribution-v1',shareProductFacts:true,retainPhotosForReview:true},photos:['front','ingredients','nutrition'].map(role=>({role,mimeType:'image/jpeg',imageBase64:photo})),correction,...extra});
const candidate=(protein=8.2)=>({readyForReview:true,missingPhotoRoles:[],product:{code:barcode,product_name:'Synthetic rice',brands:'Fixture',ingredients_text:'Rice, water',categories_tags:['en:rices'],nutrition:{aggregated_set:{per:'100g',preparation:'as_sold',nutrients:{'energy-kcal':{value:120,unit:'kcal'},proteins:{value:protein,unit:'g'},carbohydrates:{value:20,unit:'g'},sugars:{value:2,unit:'g'},fat:{value:3,unit:'g'},'saturated-fat':{value:.5,unit:'g'},fiber:{value:3,unit:'g'},salt:{value:.2,unit:'g'}}}}},prediction:{evidence:[],fieldEvidence:{}}});
function fixture(){const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');sql.exec(catalogueSchema);const storage={sql:{exec:(q,...v)=>({toArray:()=>sql.prepare(q).all(...v)})},transactionSync:fn=>{sql.exec('BEGIN');try{const value=fn();sql.exec('COMMIT');return value;}catch(error){sql.exec('ROLLBACK');throw error;}}};return {sql,db:catalogueSQLAdapter(storage)};}
async function pending(db,request,{who=owner,time=now,protein=8.2}={}){await submitContribution(db,who,request,{now:time});const job=await claimContribution(db,{now:time+1});assert.equal(job.id,request.id);await completeContribution(db,{id:job.id,lease:job.lease,sourceLookup:'found',candidate:candidate(protein)},{now:time+2});return job;}
const publish=(db,id,time=now,extra={})=>reviewContribution(db,id,{decision:'publish',expectedUpdatedAt:time+2,confirmBarcode:true,confirmLabelFacts:true,confirmCategory:true,confirmCorrection:true,...extra},{now:time+3});
const join=(db,who=owner,time=now-10)=>updateAmbassador(db,who,{adjective:'Bright',noun:'Fox',leaderboardVisible:false,termsVersion:'ambassador-v1',acceptedTerms:true,adultConfirmed:true},{now:time});
const request=(db,path,{who=owner,internal=false,time=now}={})=>handleContributionStoreRequest(db,new Request('https://index/contributions/'+path,{method:'POST',headers:{'x-nudge-owner':who,...(internal?{'x-nudge-internal':'true'}:{})},body:'{}'}),{now:time});

describe('explicit product corrections and reliable credit',()=>{
 it('upgrades an existing SQLite catalogue additively without changing old contributions or profiles',async()=>{
  const {db,sql}=fixture();await join(db);sql.exec('DROP TABLE product_contribution_details');
  const id=crypto.randomUUID();sql.prepare("INSERT INTO product_contributions(id,owner,barcode,consent_version,request_hash,status,created_at,updated_at,expires_at) VALUES(?,?,?,'product-contribution-v1','legacy','published',?,?,?)").run(id,owner,barcode,now,now,now+30*86400000);
  const before=sql.prepare('SELECT * FROM product_contributions').get(),profile=sql.prepare('SELECT * FROM ambassador_profiles').get();
  // FoodCatalogueIndex runs this same idempotent schema on every initialization.
  sql.exec(catalogueSchema);sql.exec(catalogueSchema);
  assert.deepEqual(sql.prepare('SELECT * FROM product_contributions').get(),before);assert.deepEqual(sql.prepare('SELECT * FROM ambassador_profiles').get(),profile);
  const old=(await (await request(db,'status?id='+id)).json()).contribution;assert.equal(old.pointsAwarded,undefined);assert.equal(old.correction,undefined);
  assert.equal((await submitContribution(db,owner,body(),{now})).contribution.correction.source,'user_proposed');
 });
 it('accepts only bounded product-fact proposals and does not change the legacy request shape',async()=>{
  const {db,sql}=fixture();
  for(const value of [null,{fields:[],note:''},{fields:['privateDiary'],note:''},{fields:['nutrition','nutrition'],note:''},{fields:['nutrition'],note:'a'.repeat(601)},{fields:['nutrition'],note:'界'.repeat(401)},{fields:['nutrition'],note:'<script>'},{fields:['nutrition'],note:'ok',points:99},{fields:['nutrition'],note:'ok',source:'reviewed'}])await assert.rejects(()=>submitContribution(db,owner,body({correction:value}),{now}));
  assert.equal(sql.prepare('SELECT count(*) n FROM product_contributions').get().n,0);
  const legacy=body();delete legacy.correction;const saved=await submitContribution(db,owner,legacy,{now});assert.equal(saved.contribution.correction,undefined);
 });
 it('keeps the proposal owner-private and immutable across retries without feeding it to photo analysis',async()=>{
  const {db}=fixture(),input=body();const first=await submitContribution(db,owner,input,{now});assert.deepEqual(first.contribution.correction,{...correction,source:'user_proposed'});
  assert.equal((await submitContribution(db,owner,input,{now:now+1})).replayed,true);
  await assert.rejects(()=>submitContribution(db,owner,{...input,correction:{...correction,note:'Changed'}},{now:now+1}),{code:'contribution_idempotency_conflict'});
  assert.equal((await request(db,'status?id='+input.id,{who:other})).status,404);
  const job=await claimContribution(db,{now:now+1});assert.equal(job.correction,undefined);assert.equal(job.note,undefined);
  assert.equal((await batchCatalogue(db,{codes:[barcode]},{now})).products.length,0);
 });
 it('requires the reviewer to explicitly confirm the proposed correction against packaging facts',async()=>{
  const {db,sql}=fixture(),input=body();await pending(db,input);
  await assert.rejects(()=>publish(db,input.id,now,{confirmCorrection:false}),/proposed correction/);
  assert.equal(sql.prepare('SELECT count(*) n FROM reviewed_products').get().n,0);
  const accepted=await publish(db,input.id);assert.equal(accepted.contribution.status,'published');assert.equal(accepted.contribution.pointsAwarded,0);
  const shared=await batchCatalogue(db,{codes:[barcode]},{now:now+4});assert.equal(shared.ratings[0].provenance.correctionReview,'administrator_confirmed');assert.ok(!JSON.stringify(shared).includes(correction.note));assert.ok(!JSON.stringify(shared).includes(owner));
 });
 it('selects a reviewed correction for future lookup while retaining the original OFF source and export',async()=>{
  const {db,sql}=fixture(),input=body();const old={...candidate(4).product,countries_tags:['en:united-kingdom'],last_modified_t:Math.floor((now-10000)/1000)};
  await importCatalogue(db,{products:[old],sourceURL:'https://static.openfoodfacts.org/data/off.jsonl',fetchedAt:now-1000},{now});const before=sql.prepare('SELECT * FROM catalogue_products').get();
  await pending(db,input);assert.notEqual((await batchCatalogue(db,{codes:[barcode]},{now:now+2})).ratings[0].sourceKind,'nudge_community');await publish(db,input.id);
  const shared=await batchCatalogue(db,{codes:[barcode]},{now:now+4});assert.equal(shared.ratings[0].sourceKind,'nudge_community');assert.equal(shared.products[0].nutrition.aggregated_set.nutrients.proteins.value,8.2);assert.deepEqual(sql.prepare('SELECT * FROM catalogue_products').get(),before);
  const exported=await exportCatalogue(db,new URL('https://index/export'),{now});assert.equal(exported.products[0].nutrition.aggregated_set.nutrients.proteins.value,4);
  const env={FOOD_CATALOGUE_INDEX:{idFromName:v=>v,get:()=>({fetch:async()=>Response.json(shared)})}};
  const outcome=await getCatalogueOutcome(env,barcode);assert.equal(outcome.status,'found');assert.equal(outcome.record.source,'Nudge community');assert.equal(outcome.record.product.nutrients.protein.value,8.2);assert.equal(outcome.record.product.providerNutriScore,undefined);assert.equal(outcome.record.licenceURL,null);
  const refreshed={...before,fetched_at:now+1000};assert.equal(compatibleReviewedReplacement(refreshed,shared.products[0],shared.ratings[0],{now:now+4}),true,'Fetching unchanged OFF facts later does not undo a reviewed correction');
  assert.equal(compatibleReviewedReplacement({...before,source_revision:Math.ceil((now+1000)/1000)},shared.products[0],shared.ratings[0],{now:now+4}),false,'A newer actual source revision needs another review');
 });
 it('rejects stale, unreviewed, changed or wrongly attributed reviewed source envelopes',async()=>{
  const {db}=fixture(),input=body();await pending(db,input);await publish(db,input.id);const shared=await batchCatalogue(db,{codes:[barcode]},{now:now+4}),p=shared.products[0],m=shared.ratings[0];
  for(const change of [{sourceName:'Open Food Facts'},{sourceURL:'https://evil.example'},{expiresAt:now-1},{sourceFingerprint:'00'.repeat(32)},{reviewedAt:now+5},{provenance:{...m.provenance,verification:'unreviewed_photo_prediction'}}])await assert.rejects(()=>reviewedCatalogueRecord(p,{...m,...change},barcode,{now:now+4}));
  await assert.rejects(()=>reviewedCatalogueRecord({...p,product_name:'Different'},m,barcode,{now:now+4}));
 });
 it('keeps legacy HTTP lookup OFF-only and requires a reviewed-source-aware client for corrections',async()=>{
  const {db,sql}=fixture(),input=body();const old={...candidate(4).product,countries_tags:['en:united-kingdom'],last_modified_t:Math.floor((now-10000)/1000)};
  await importCatalogue(db,{products:[old],sourceURL:'https://static.openfoodfacts.org/data/off.jsonl',fetchedAt:now-1000},{now});
  await pending(db,input,{time:now-500});await publish(db,input.id,now-500);
  const before=sql.prepare('SELECT * FROM catalogue_products').get(),token='48'.repeat(32),index={db,ctx:{}};
  const env={PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),FOOD_CATALOGUE_INDEX:{idFromName:v=>v,get:()=>({fetch:async(url,options)=>FoodCatalogueIndex.prototype.fetch.call(index,new Request(url,options))})},LABEL_QUOTA:{idFromName:()=>assert.fail('No source fetch or quota')}};
  const lookup=(capability,payload={barcode})=>worker.fetch(new Request('https://nudge.example/v1/products/lookup',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...(capability?{'x-nudge-catalogue-source':capability}:{})},body:JSON.stringify(payload)}),env);
  for(const capability of [undefined,'reviewed-v0','reviewed-v1, reviewed-v0']){
   const response=await lookup(capability),result=await response.json();assert.equal(response.status,200);assert.equal(result.source,'Open Food Facts');assert.equal(result.reviewedMetadata,undefined);assert.equal(result.providerPayload.product.nutrition.aggregated_set.nutrients.proteins.value,4);
  }
  const response=await lookup('reviewed-v1'),result=await response.json();assert.equal(response.status,200);assert.equal(result.source,'Nudge community');assert.equal(result.reviewedMetadata.provenance.correctionReview,'administrator_confirmed');assert.equal(result.providerPayload.product.nutrition.aggregated_set.nutrients.proteins.value,8.2);
  assert.equal((await lookup('reviewed-v1',{barcode,includeReviewed:true})).status,400,'Capability never expands the strict JSON contract');
  assert.deepEqual(sql.prepare('SELECT * FROM catalogue_products').get(),before,'Legacy fallback retains the original source');
 });
 it('returns a proven legacy miss for community-only products and rejects a service that ignores source exclusion',async()=>{
  const {db}=fixture(),input=body();await pending(db,input,{time:now-500});await publish(db,input.id,now-500);
  const index={db,ctx:{}},env={FOOD_CATALOGUE_INDEX:{idFromName:v=>v,get:()=>({fetch:async(url,options)=>FoodCatalogueIndex.prototype.fetch.call(index,new Request(url,options))})}};
  assert.equal((await getCatalogueOutcome(env,barcode,undefined,{includeReviewed:false})).status,'not_found');
  assert.equal((await getCatalogueOutcome(env,barcode)).record.source,'Nudge community');
  const shared=await batchCatalogue(db,{codes:[barcode]});let excluded=false;
  const wrong={FOOD_CATALOGUE_INDEX:{idFromName:v=>v,get:()=>({fetch:async(_url,options)=>{excluded=options.headers['x-nudge-catalogue-source']==='off-only';return Response.json(shared);}})}};
  assert.equal((await getCatalogueOutcome(wrong,barcode,undefined,{includeReviewed:false})).status,'unavailable');assert.equal(excluded,true);
 });
 it('reports the actual per-submission credit and cannot reward duplicate facts or repeat own products',async()=>{
  const {db,sql}=fixture();await join(db);await join(db,other);const first=body();await pending(db,first);assert.equal((await publish(db,first.id)).contribution.pointsAwarded,1);
  const second=body();await pending(db,second,{time:now+10,who:other});assert.equal((await publish(db,second.id,now+10)).contribution.pointsAwarded,0);
  const third=body();await pending(db,third,{time:now+20,protein:9});assert.equal((await publish(db,third.id,now+20)).contribution.pointsAwarded,0);
  assert.equal(sql.prepare('SELECT count(*) n FROM ambassador_awards').get().n,1);assert.equal((await (await request(db,'status?id='+first.id,{time:now+30})).json()).contribution.pointsAwarded,1);
  await assert.rejects(()=>publish(db,first.id));assert.equal(sql.prepare('SELECT points_awarded FROM product_contribution_details WHERE contribution_id=?').get(first.id).points_awarded,1);
 });
 it('rolls back the correction outcome and award receipt with failed publication',async()=>{
  const {db,sql}=fixture();await join(db);const input=body();await pending(db,input);sql.exec("CREATE TRIGGER fail_correction BEFORE UPDATE ON product_contributions WHEN NEW.status='published' BEGIN SELECT RAISE(ABORT,'test publication rollback'); END");
  await assert.rejects(()=>publish(db,input.id),/rollback/);assert.equal(sql.prepare('SELECT count(*) n FROM ambassador_awards').get().n,0);assert.equal(sql.prepare('SELECT points_awarded FROM product_contribution_details').get().points_awarded,null);assert.equal(sql.prepare('SELECT count(*) n FROM reviewed_products').get().n,0);
 });
 it('erases private notes on withdrawal, retention expiry and account erasure',async()=>{
  for(const mode of ['delete','expiry','purge-owner']){
   const {db,sql}=fixture(),input=body();await submitContribution(db,owner,input,{now});
   const response=await request(db,mode==='delete'?'delete?id='+input.id:mode==='expiry'?'list':'purge-owner',{internal:mode==='purge-owner',time:mode==='expiry'?now+31*86400000:now+1});assert.equal(response.status,200);
   assert.equal(sql.prepare('SELECT count(*) n FROM product_contribution_details').get().n,0,mode);assert.equal(sql.prepare('SELECT count(*) n FROM product_contribution_photos').get().n,0,mode);
  }
 });
});
