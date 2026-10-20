import {describe,it,mock,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lookupCatalogue,getCatalogue,lookupCatalogueOutcome,getCatalogueOutcome} from '../src/catalogue-service.js';
import {CATALOGUE_TTL_MS} from '../src/food-catalogue.js';
import worker from '../src/worker.js';
import {processContributionQueue} from '../src/product-contributions.js';
afterEach(()=>mock.restoreAll());
const barcode='1234567890123',now=Date.UTC(2026,9,4);
const storage=()=>{const data=new Map();return {data,get:async key=>structuredClone(data.get(key)),put:async(key,value)=>data.set(key,structuredClone(value))};};
const payload=()=>({status:'success',product:{code:barcode,product_name:'Synthetic bread',brands:'Fixture',ingredients_text:'Wheat, water',nutriments:{'energy-kcal_100g':220,proteins_100g:8,fiber_100g:3,salt_100g:1}}});
describe('catalogue service persistence and retry boundaries',()=>{
  it('reuses source-owned stored facts until expiry, then refreshes only once',async()=>{
    const s=storage();let count=0;const fetchImpl=async()=>{count++;return Response.json(payload());};
    const first=await lookupCatalogue(s,barcode,{now,fetchImpl}),second=await lookupCatalogue(s,barcode,{now:now+1,fetchImpl});
    assert.deepEqual(first,second);assert.equal(count,1);
    const refreshed=await lookupCatalogue(s,barcode,{now:now+CATALOGUE_TTL_MS,fetchImpl});assert.equal(count,2);assert.equal(refreshed.fetchedAt,now+CATALOGUE_TTL_MS);
  });
  it('persists a five-minute failure cooldown without fabricating a product',async()=>{
    const s=storage();let count=0;const fetchImpl=async()=>{count++;return Response.json({status:0},{status:404});};
    assert.equal(await lookupCatalogue(s,barcode,{now,fetchImpl}),null);assert.equal(await lookupCatalogue(s,barcode,{now:now+299999,fetchImpl}),null);assert.equal(count,1);assert.equal(s.data.has('public-food-record'),false);
    assert.equal(await lookupCatalogue(s,barcode,{now:now+300000,fetchImpl}),null);assert.equal(count,2);assert.deepEqual(Object.keys(s.data.get('public-source-failure')).sort(),['barcode','status','until']);
  });
  it('distinguishes a proven missing product from an outage and retains that distinction during cooldown',async()=>{
    for(const [reply,status] of [[()=>Response.json({status:0,code:barcode},{status:404}),'not_found'],[()=>Response.json({status:'failure',code:barcode,errors:[{message:{id:'product_not_found'}}]},{status:404}),'not_found'],[()=>new Response('gateway unavailable',{status:503}),'unavailable'],[()=>new Response('gateway missing',{status:404}),'unavailable'],[()=>Response.json({status:0,code:'9999999999999'},{status:404}),'unavailable']]){
      const s=storage();let calls=0;const fetchImpl=async()=>{calls++;return reply();};
      assert.equal((await lookupCatalogueOutcome(s,barcode,{now,fetchImpl})).status,status);assert.equal((await lookupCatalogueOutcome(s,barcode,{now:now+1,fetchImpl})).status,status);assert.equal(calls,1);
    }
  });
  it('does not create a failure cooldown for a caller cancellation',async()=>{
    const s=storage(),controller=new AbortController();controller.abort();
    const result=await lookupCatalogue(s,barcode,{now,signal:controller.signal,fetchImpl:async(_url,options)=>{options.signal.throwIfAborted();}});
    assert.equal(result,null);assert.equal(s.data.has('public-source-failure'),false);
  });
  it('uses a barcode-specific internal object and sends no request-supplied source or record',async()=>{
    let name,request;const env={LABEL_QUOTA:{idFromName:value=>{name=value;return value;},get:()=>({fetch:async(url,init)=>{request={url,init};return Response.json({record:{barcode}});}})}};
    assert.deepEqual(await getCatalogue(env,barcode,undefined,{allowSourceFetch:true}),{barcode});assert.equal(name,'food-catalogue:'+barcode);assert.equal(request.url,'https://catalogue/catalogue-lookup');assert.deepEqual(JSON.parse(request.init.body),{barcode});
    assert.equal(await getCatalogue(env,'https://evil.example'),null);
  });
  it('explicitly keeps source refresh in the background contribution processor',async()=>{
    let sourceCalls=0,completed;
    const job={id:'synthetic-contribution',lease:'synthetic-lease',barcode,owner:'synthetic-owner',marketCountry:'GB',photos:[]};
    const env={FOOD_CATALOGUE_INDEX:{idFromName:value=>value,get:()=>({fetch:async(url,init)=>{
      if(url.endsWith('/contributions/claim'))return Response.json({job});
      if(url.endsWith('/batch'))return Response.json({products:[],ratings:[]});
      assert.ok(url.endsWith('/contributions/complete'));completed=JSON.parse(init.body);return Response.json({completed:true});
    }})},LABEL_QUOTA:{idFromName:value=>value,get:()=>({fetch:async()=>{sourceCalls++;return Response.json({status:'not_found'});}})}};
    await processContributionQueue(env,{analyse:()=>{throw new Error('No photo analysis in this fixture');},validateUpload:()=>{}});
    assert.equal(sourceCalls,1);assert.equal(completed.sourceLookup,'not_found');assert.equal(completed.candidate,null);
  });
});

describe('foreground Nudge catalogue policy',()=>{
  const token='63'.repeat(32),auth={PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex')};
  const request=(path,body)=>new Request('https://nudge.example/v1/products/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  const makeEnv=reply=>({...auth,FOOD_CATALOGUE_INDEX:{idFromName:value=>value,get:()=>({fetch:reply})},LABEL_QUOTA:{idFromName:value=>value,get:()=>({fetch:()=>assert.fail('Foreground must not enter the source-fetch/quota object')})}});
  it('distinguishes an exact catalogue miss from outage or malformed evidence without any upstream fallback',async()=>{
    const external=mock.method(globalThis,'fetch',()=>assert.fail('Foreground must not contact OFF'));
    for(const [reply,expected] of [
      [()=>Response.json({products:[],ratings:[]}),'not_found'],
      [()=>Response.json({products:[]}),'unavailable'],
      [()=>Response.json({products:[],ratings:[{}]}),'unavailable'],
      [()=>new Response('',{status:503}),'unavailable'],
      [()=>{throw new Error('offline');},'unavailable']
    ]){
      const env=makeEnv(reply),outcome=await getCatalogueOutcome(env,barcode);
      assert.equal(outcome.status,expected);
      const response=await worker.fetch(request('lookup',{barcode}),env),body=await response.json();
      assert.equal(response.status,expected==='not_found'?404:503);
      assert.equal(body.code,expected==='not_found'?'product_not_found':'catalogue_unavailable');
      assert.ok(!body.message.includes('Open Food Facts'));
      if(expected==='not_found')assert.match(body.message,/Nudge catalogue/);
    }
    assert.equal((await getCatalogueOutcome({...auth,LABEL_QUOTA:makeEnv().LABEL_QUOTA},barcode)).status,'unavailable','Missing index is not a proven product miss');
    assert.equal((await getCatalogueOutcome(makeEnv(()=>Response.json({products:[],ratings:[]})),barcode,undefined,{skipIndex:true})).status,'not_found','Legacy skipIndex cannot enable an implicit source fetch');
    assert.equal(external.mock.callCount(),0);
  });
  it('keeps submitted manual facts and honest missing nutrients when scoring a barcode absent from the catalogue',async()=>{
    const external=mock.method(globalThis,'fetch',()=>assert.fail('No foreground provider fetch'));
    const product={barcode,name:'Synthetic bread',sourceName:'Manual label',basisUnit:'g',nutritionPreparation:'as_sold',categoriesTags:['en:breads'],ingredients:'Wheat, water',nutrients:{salt:{value:1,unit:'g',status:'supplied'},protein:{value:8,unit:'g',status:'supplied'}}};
    const before=structuredClone(product),env=makeEnv(()=>Response.json({products:[],ratings:[]}));
    const response=await worker.fetch(request('score',{product}),env);
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.score.available,false);assert.equal(body.score.value,null);
    assert.equal(body.score.inputs.salt,1);assert.equal(body.score.inputs.protein,8);
    assert.ok(body.score.missingInputs.includes('sugars'));assert.equal(body.recovery,undefined);
    assert.deepEqual(product,before);assert.equal(external.mock.callCount(),0);
  });
});
