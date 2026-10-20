import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CatalogueEnrichmentRunner,extractCatalogueEvidence} from '../src/catalogue-enrichment-runner.js';
import {stableStringify} from '../src/product-score.js';
import worker from '../src/worker.js';
import {catalogueRecordFromPayload} from '../src/food-catalogue.js';
import {evaluateCatalogueEnrichment} from '../src/catalogue-enrichment-evidence.js';
import {buildCatalogueRow} from '../src/catalogue-index.js';
const DAY=86400000,now=20*DAY;
function fixture({rated=false,old=false}={}){
  const values=new Map(),calls=[],requests=[],completions=[];let alarm=null,extracts=0,lookups=0;
  const raw={code:'5000000000018',product_name:'Mystery food',last_modified_t:1};
  const job={id:'job',barcode:raw.code,sourceFingerprint:createHash('sha256').update(stableStringify(raw)).digest('hex'),leaseToken:'lease',sourceRow:{provider_json:JSON.stringify(raw),fetched_at:old?now-DAY-1:now-1}};
  const storage={get:async k=>values.get(k),put:async(k,v)=>values.set(k,v),getAlarm:async()=>alarm,setAlarm:async v=>{alarm=v;},deleteAlarm:async()=>{alarm=null;},transaction:async fn=>fn(storage)};
    const index={fetch:async(url,init)=>{calls.push(url);const action=url.split('/').at(-1),body=JSON.parse(init.body);requests.push({action,body});if(action==='claim'){assert.equal(body.limit,2);return Response.json({jobs:[job]});}if(action==='complete')completions.push(body);return Response.json({ok:true});}};
  const env={ENRICHMENT_ENABLED:'true',OPENAI_API_KEY:'test-only',OPENAI_MODEL:'gpt-4.1-mini',FOOD_CATALOGUE_INDEX:{idFromName:x=>x,get:()=>index}};
  const result={product:{name:'Mystery food'},classification:{category:'unknown'},recoveryContext:{candidates:[]},score:{available:rated},outcome:rated?'enriched':'unresolved'};
  const runner=new CatalogueEnrichmentRunner({storage},env,{now:()=>now,evaluate:async()=>result,extract:async()=>{extracts++;return {evidence:{},usage:{inputTokens:100,outputTokens:20}};},lookup:async()=>{lookups++;return {providerPayload:{product:raw}};}});
  return {runner,storage,values,calls,requests,completions,env,job,raw,get extracts(){return extracts;},get lookups(){return lookups;}};
}
describe('background catalogue runner',()=>{
  it('reuses deterministic evidence with no provider calls and no user quota or image-runner operations',async()=>{
    const f=fixture({rated:true});await f.runner.alarm();assert.equal(f.extracts,0);assert.equal(f.lookups,0);assert.equal(f.completions[0].outcome,'evidence');
    assert.ok(f.calls.every(url=>url.includes('/enrichment/')));assert.ok(await f.storage.getAlarm()>now);
  });
  it('durably counts AI requests and tokens and defers on daily cap without marking a product unresolved',async()=>{
    const f=fixture();f.env.ENRICHMENT_AI_DAILY_LIMIT='1';await f.runner.alarm();await f.runner.alarm();
    assert.equal(f.extracts,1);assert.equal(f.completions[1].outcome,'deferred');assert.ok(f.completions[1].retryAt>now);
    const status=await f.runner.status();assert.equal(status.budget.ai,1);assert.equal(status.budget.inputTokens,100);
  });
  it('paces exact source lookups independently of local work',async()=>{
    const f=fixture({old:true});await f.runner.alarm();await f.runner.alarm();assert.equal(f.lookups,1);assert.equal(f.completions[1].outcome,'deferred');
  });
  it('looks for label images missing from a fresh export and preserves scan priority and pilot membership',async()=>{
    const f=fixture();Object.assign(f.job,{reason:'scan',isPilot:true});f.job.sourceRow.import_source_url='https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz';
    let lookups=0;f.runner.lookup=async()=>{lookups++;return {providerPayload:{product:{...f.raw,last_modified_t:2}},product:{sourceURL:'https://world.openfoodfacts.org/product/'+f.raw.code},fetchedAt:now};};
    await f.runner.alarm();assert.equal(lookups,1);assert.equal(f.extracts,0);
    const refreshed=f.requests.find(r=>r.action==='refresh');assert.deepEqual(refreshed.body,{id:f.job.id,leaseToken:f.job.leaseToken,sourceFingerprint:createHash('sha256').update(stableStringify({...f.raw,last_modified_t:2})).digest('hex')});
    assert.equal(f.requests.filter(r=>r.action==='enqueue').length,0,'Source refresh must not impersonate another user scan');
  });
  it('preserves ordinary recovery and its exact new source binding across refresh without taking pilot credit',async()=>{
    const f=fixture({old:true});Object.assign(f.job,{reason:'recovery',isPilot:false});const updated={...f.raw,last_modified_t:2,unique_scans_n:42};
    f.runner.lookup=async()=>({providerPayload:{product:updated},product:{sourceURL:'https://world.openfoodfacts.org/product/'+f.raw.code},fetchedAt:now});
    await f.runner.alarm();const requests=f.requests.filter(r=>r.action==='refresh');assert.equal(requests.length,1);
    assert.deepEqual(requests[0].body,{id:f.job.id,leaseToken:f.job.leaseToken,sourceFingerprint:createHash('sha256').update(stableStringify(updated)).digest('hex')});
    assert.equal(f.extracts,0);assert.equal((await f.runner.status()).budget.source,1);assert.ok([...f.values.keys()].every(key=>!key.startsWith('enrichment-review-pilot')));
  });
  it('uses the unchanged ordinary AI cap for recovery even when separate preview credit exists',async()=>{
    const f=fixture();f.job.reason='recovery';f.env.ENRICHMENT_AI_DAILY_LIMIT='1';f.env.ENRICHMENT_PILOT_AI_LIMIT='100';
    await f.runner.alarm();await f.runner.alarm();assert.equal(f.extracts,1);assert.equal(f.completions[1].errorCode,'enrichment_budget');
    assert.equal((await f.runner.status()).budget.ai,1);assert.ok([...f.values.keys()].every(key=>!key.startsWith('enrichment-review-pilot')));
  });
  it('shares a persistent model cooldown after throttling instead of spending the request budget on every queued product',async()=>{
    const f=fixture();let attempts=0;f.runner.extract=async()=>{attempts++;throw Object.assign(new Error('enrichment_ai_unavailable'),{retryAfter:600000});};
    await f.runner.alarm();await f.runner.alarm();assert.equal(attempts,1);
    assert.ok(f.completions.every(r=>r.outcome==='deferred'&&r.errorCode==='provider_cooldown'));
    assert.equal((await f.runner.status()).budget.ai,1);
  });
  it('respects a public-source throttle across other queued products',async()=>{
    const f=fixture({old:true});let attempts=0;f.runner.lookup=async()=>{attempts++;throw Object.assign(new Error('Catalogue source unavailable (429)'),{catalogueStatus:429,retryAfter:600000});};
    await f.runner.alarm();await f.runner.alarm();assert.equal(attempts,1);assert.equal(f.extracts,0);
    assert.ok(f.completions.every(r=>r.outcome==='deferred'&&r.errorCode==='provider_cooldown'));
  });
  it('respects durable pause across cron ensures and resumes only on explicit start',async()=>{
    const f=fixture();await f.runner.fetch(new Request('https://runner/pause',{method:'POST',body:'{}'}));
    await f.runner.fetch(new Request('https://runner/ensure',{method:'POST',body:'{}'}));await f.runner.alarm();assert.equal(f.calls.length,0);assert.equal(await f.storage.getAlarm(),null);
    await f.runner.fetch(new Request('https://runner/start',{method:'POST',body:'{}'}));assert.ok(await f.storage.getAlarm()>now);
  });
  it('never forwards source-supplied URLs as a request destination or sends private user data to AI',async()=>{
    let body;
    const response={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({recovery:{category:'unknown',evidence:[],sweeteners:'unknown',sweetenerEvidence:[],recordId:null,reason:'no_compatible_source'},label:null})}]}],usage:{input_tokens:42,output_tokens:9}};
    await extractCatalogueEvidence({code:'5000000000018',image_nutrition_url:'https://evil.test/image'}, {product:{name:'Food',basisUnit:'g',nutritionPreparation:'as_sold'}},{OPENAI_API_KEY:'test',OPENAI_MODEL:'gpt-4.1-mini'},
      {fetchImpl:async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init.redirect,'manual');body=JSON.parse(init.body);return Response.json(response);}});
    assert.equal(body.store,false);assert.equal(body.input[0].content.length,1);assert.ok(!JSON.stringify(body).includes('evil.test'));
    assert.deepEqual(body.text.format.schema.properties.recovery.properties.recordId.enum,[null]);
  });
  it('does not convert an ambiguous composition choice into an approved source',async()=>{
    const reply={recovery:{category:'unknown',evidence:[],sweeteners:'unknown',sweetenerEvidence:[],recordId:'usda-example',reason:'ambiguous_preparation'},label:null};
    const response={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(reply)}]}]};
    await assert.rejects(extractCatalogueEvidence({code:'5000000000018'},{product:{},recoveryContext:{candidates:[]}},{OPENAI_MODEL:'gpt-4.1-mini'},
      {fetchImpl:async()=>Response.json(response)}),/enrichment_ai_invalid/);
  });
});
describe('enrichment administration',()=>{
  it('requires distinct admin authentication and does not expose claim/complete publicly',async()=>{
    const token='ab'.repeat(32),app='cd'.repeat(32),hash=s=>createHash('sha256').update(s).digest('hex');let calls=0;
    const env={CATALOGUE_ADMIN_TOKEN_SHA256:hash(token),PRIVATE_ACCESS_TOKEN_SHA256:hash(app),
      FOOD_CATALOGUE_INDEX:{idFromName:x=>x,get:()=>({fetch:async()=>{calls++;return Response.json({queued:1});}})},
      CATALOGUE_ENRICHMENT_RUNNER:{idFromName:x=>x,get:()=>({fetch:async()=>{calls++;return Response.json({status:'running'});}})}};
    const send=(route,key,method='POST',body='{}',ctx)=>worker.fetch(new Request('https://api.test/v1/catalogue/enrichment/'+route,{method,headers:key?{authorization:'Bearer '+key}:{},...(method==='GET'?{}:{body})}),env,ctx);
    assert.equal((await send('seed',app)).status,401);assert.equal(calls,0);
    assert.equal((await send('review',app)).status,401);assert.equal(calls,0);
    assert.equal((await send('candidates',app)).status,401);assert.equal(calls,0);
    assert.equal((await send('complete',token)).status,404);assert.equal(calls,0);
    assert.equal((await send('refresh',token)).status,404);assert.equal(calls,0);
    assert.equal((await send('start',token,'POST','{"reset":true}')).status,400);
    assert.equal((await send('seed',token)).status,200);assert.equal((await send('status',token,'GET')).status,200);assert.equal((await send('review',token,'POST','{"limit":5}')).status,200);
    const before=calls;
    assert.equal((await send('candidates',token,'POST','{"limit":50}',{waitUntil:()=>assert.fail('Candidate reads must not schedule work')})).status,200);
    assert.equal(calls,before+1,'Candidate reads must not schedule the runner');
  });
});
describe('shared enrichment on the individual scoring endpoint',()=>{
  it('returns the same saved score without AI and refuses to bind it to edited nutrition',async()=>{
    const time=Date.now(),raw={code:'5000000000001',product_name:'Dhal makhani',ingredients_text:'Lentils (60%), tomatoes (10%), water, cream, salt',
      nutriments:{'energy-kcal_100g':110,'energy-kj_100g':460,proteins_100g:6,carbohydrates_100g:14,sugars_100g:2,fat_100g:3,'saturated-fat_100g':1,fiber_100g:4,salt_100g:.5}};
    const record=catalogueRecordFromPayload({product:raw},raw.code,time),classification={category:'general',evidence:[{field:'name',quote:'Dhal makhani'}],sweeteners:'unknown',sweetenerEvidence:[]};
    const row=await buildCatalogueRow(raw,{fetchedAt:time,source:record.product.sourceURL,now:time,allowBarcodeOnly:true});
    assert.deepEqual(JSON.parse(row.provider_json),record.providerPayload.product,'The batch metadata describes the unchanged source facts');
    const score={...evaluateCatalogueEnrichment(raw,{classification}).score,catalogueEnrichment:{version:'catalogue-enrichment-v1',sourceFingerprint:row.source_fingerprint,expiresAt:time+100000}};
    assert.equal(score.available,true);
    const metadata={barcode:row.barcode,method:row.score_method,version:row.score_version,classifierVersion:row.classifier_version,sourceRevision:row.source_revision,sourceFingerprint:row.source_fingerprint,fetchedAt:row.fetched_at,expiresAt:row.expires_at,calculatedAt:time-50,score};
    const token='34'.repeat(32),env={PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),FOOD_CATALOGUE_INDEX:{idFromName:x=>x,get:()=>({fetch:async()=>Response.json({products:[record.providerPayload.product],ratings:[metadata]})})}};
    const run=product=>worker.fetch(new Request('https://api.test/v1/products/score',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({product})}),env);
    const response=await run(record.product),result=await response.json();assert.equal(response.status,200);assert.deepEqual(result.score.catalogueEnrichment,score.catalogueEnrichment);assert.equal(result.score.value,score.value);assert.equal(result.calculatedAt,time-50);
    const edited=structuredClone(record.product);edited.nutrients.salt.value=5;
    const changed=await(await run(edited)).json();assert.equal(changed.score.catalogueEnrichment,undefined);assert.equal(edited.nutrients.salt.value,5);
  });
});
