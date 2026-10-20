import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ProductImageWarmRunner,nextImageWarmAlarm} from '../src/product-image-warm-runner.js';
import worker from '../src/worker.js';

function fixture(run=async()=>({status:'paused'})) {
  let clock=1000,alarm=null;const values=new Map(),alarms=[];
  const storage={get:async key=>values.get(key),put:async(key,value)=>values.set(key,structuredClone(value)),getAlarm:async()=>alarm,setAlarm:async value=>{alarm=value;alarms.push(value);}};
  const env={PRODUCT_IMAGES:{},FOOD_CATALOGUE_INDEX:{idFromName:name=>name,get:()=>({fetch:()=>assert.fail('Injected warm operation should own catalogue calls')})}};
  return {runner:new ProductImageWarmRunner({storage},env,{now:()=>clock,run}),storage,alarms,values,setNow:value=>clock=value};
}
describe('durable thumbnail job controller',()=>{
  it('starts immediately without resetting R2 state and persists a backup before running',async()=>{
    let ran=false;const f=fixture(async()=>{ran=true;assert.equal(await f.storage.getAlarm(),91000);return {status:'paused'};});
    const response=await f.runner.fetch(new Request('https://runner/start',{method:'POST',body:'{}'}));assert.equal(response.status,202);assert.equal((await response.json()).scheduledFor,1001);assert.equal(ran,false);
    await f.runner.alarm();assert.equal(ran,true);assert.equal(await f.storage.getAlarm(),3000);
    const status=await f.runner.status();assert.equal(status.status,'paused');assert.equal(status.lastRunAt,1000);assert.equal(status.runningUntil,null);
  });
  it('reports initial storage errors independently of a missing R2 progress object and backs off',async()=>{
    const f=fixture(async()=>({status:'failed',lastError:'image_warm_storage_unavailable'}));await f.runner.alarm();
    assert.deepEqual(await f.runner.status(),{status:'failed',lastRunAt:1000,finishedAt:1000,nextRunAt:61000,runningUntil:null,lastError:'image_warm_storage_unavailable'});
    for(const status of ['busy','failed','unavailable'])assert.equal(nextImageWarmAlarm({status},2000),62000);
  });
  it('sanitizes thrown failures, persists diagnostics and rearms',async()=>{
    const f=fixture(async()=>{throw new Error('PRIVATE SECRET');});await f.runner.alarm();
    const status=await f.runner.status();assert.equal(status.status,'failed');assert.equal(status.lastError,'image_runner_execution_failed');assert.doesNotMatch(JSON.stringify(status),/PRIVATE/);assert.equal(status.nextRunAt,61000);
  });
  it('keeps a completed weekly alarm on cron ensure, while an explicit admin start can wake it',async()=>{
    const due=1000+7*86400000,f=fixture(async()=>({status:'complete',nextSweepAt:due}));await f.runner.alarm();
    await f.runner.fetch(new Request('https://runner/ensure',{method:'POST',body:'{}'}));assert.equal(await f.storage.getAlarm(),due);
    await f.runner.fetch(new Request('https://runner/start',{method:'POST'}));assert.equal(await f.storage.getAlarm(),1001);
  });
  it('backs off failed batches with no new available images and resets the baseline each sweep',async()=>{
    const outcomes=[
      {status:'paused',startedAt:'sweep-1',available:5,failed:0},
      {status:'paused',startedAt:'sweep-1',available:5,failed:4},
      {status:'paused',startedAt:'sweep-1',available:6,failed:5},
      {status:'paused',startedAt:'sweep-2',available:0,failed:1},
    ];
    const f=fixture(async()=>outcomes.shift());
    for(const due of [3000,61000,3000,61000]){await f.runner.alarm();assert.equal(await f.storage.getAlarm(),due);}
  });
  it('repairs a stale alarm without preempting an active batch',async()=>{
    const f=fixture();await f.storage.setAlarm(1);f.setNow(100000);
    await f.runner.fetch(new Request('https://runner/ensure',{method:'POST'}));assert.equal(await f.storage.getAlarm(),100001);
    f.values.set('runner-state-v1',{status:'running',lastRunAt:100000,runningUntil:190000});await f.storage.setAlarm(190000);
    await f.runner.fetch(new Request('https://runner/start',{method:'POST'}));assert.equal(await f.storage.getAlarm(),190000);
  });
  it('refuses source/reset parameters and unknown internal actions',async()=>{
    const f=fixture();for(const [url,body] of [['/start?reset=true','{}'],['/start','{"reset":true}'],['/start','{"sourceURL":"https://evil.test"}']])assert.equal((await f.runner.fetch(new Request('https://runner'+url,{method:'POST',body}))).status,400);
    assert.equal(await f.storage.getAlarm(),null);
  });
});

describe('administrative warm-start boundary',()=>{
  const admin='89'.repeat(32),app='67'.repeat(32),hash=value=>createHash('sha256').update(value).digest('hex');
  it('requires separate admin auth, accepts only empty requests and forwards to one fixed runner',async()=>{
    let calls=0;
    const env={CATALOGUE_ADMIN_TOKEN_SHA256:hash(admin),PRIVATE_ACCESS_TOKEN_SHA256:hash(app),PRODUCT_IMAGE_WARM_RUNNER:{idFromName:name=>{assert.equal(name,'catalogue-thumbnails-v1');return name;},get:()=>({fetch:async(url,init)=>{calls++;assert.equal(url,'https://image-runner/start');assert.equal(init.body,'{}');return Response.json({status:'scheduled',scheduledFor:1234},{status:202});}})}};
    const send=(token,body,url='https://nudge.example/v1/catalogue/image-warm')=>worker.fetch(new Request(url,{method:'POST',headers:token?{authorization:'Bearer '+token}:{},...(body===undefined?{}:{body})}),env);
    assert.equal((await send()).status,401);assert.equal((await send(app)).status,401);assert.equal(calls,0);
    for(const body of ['{"reset":true}','{"source":"anything"}','x'.repeat(33)])assert.ok((await send(admin,body)).status>=400);
    assert.equal((await send(admin,'{}','https://nudge.example/v1/catalogue/image-warm?reset=1')).status,400);assert.equal(calls,0);
    assert.equal((await send(admin)).status,202);assert.equal((await send(admin,'{}')).status,202);assert.equal(calls,2);
  });
});
