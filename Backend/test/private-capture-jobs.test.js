import {it} from 'node:test';
import assert from 'node:assert/strict';
import {DurableCaptureQueue,privateCaptureStub} from '../src/private-capture-jobs.js';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',id2='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RETENTION_MS=30*86400_000;
const fastBody=()=>({images:[{imageBase64:'synthetic-private-fast-photo'}],analysisPolicy:{version:1,mode:'fast'}});
function fixture(){
  const values=new Map();let alarm=null,time=1_800_000_000_000,chain=Promise.resolve(),calls=0,listHook,failAlarm=false;
  const tx={get:async k=>structuredClone(values.get(k)),put:async(k,v)=>{
    for(const [key,value] of typeof k==='string'?[[k,v]]:Object.entries(k)){assert.ok(JSON.stringify(value).length<128_000);values.set(key,structuredClone(value));}
  },delete:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])values.delete(k);},
  list:async({prefix=''})=>{
    const snapshot=new Map([...values].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k,structuredClone(v)]));
    const hook=listHook;listHook=undefined;if(hook)await hook();return snapshot;
  },setAlarm:async at=>{if(failAlarm){failAlarm=false;throw new Error('Alarm storage unavailable');}alarm=at;},deleteAlarm:async()=>alarm=null};
  const storage={...tx,transaction:callback=>{
    const pending=chain.then(async()=>{const before=structuredClone(values),beforeAlarm=alarm;try{return await callback(tx);}catch(e){values.clear();for(const p of before)values.set(...p);alarm=beforeAlarm;throw e;}});chain=pending.catch(()=>{});return pending;
  }};
  let process=async()=>({extraction:{name:'Synthetic food'},source:{retainedByNudge:true}});
  const make=()=>{const q=new DurableCaptureQueue({storage},{});q.now=()=>time;q.process=async(...args)=>{calls++;return process(...args);};return q;};
  const request=(q,method='POST',body={images:[{imageBase64:'synthetic-private-input'}]},key=id)=>q.fetch(new Request('https://private/'+key,{method,...(method==='POST'?{body:JSON.stringify({owner:'private-owner',body})}:{})}));
  return {values,make,request,setProcess:f=>process=f,setListHook:f=>listHook=f,failNextAlarm:()=>failAlarm=true,
    advance:n=>time+=n,get time(){return time;},get alarm(){return alarm;},get calls(){return calls;}};
}
it('persists original before acknowledgement, survives restart, retries accepted POST without duplicate analysis',async()=>{
  const f=fixture(),body={images:[{imageBase64:'x'.repeat(180_000)}],note:'a'};
  assert.equal((await f.request(f.make(),'POST',body)).status,202);assert.ok(f.alarm);
  const q=f.make();assert.equal((await f.request(q,'POST',{note:'a',images:body.images})).status,202);
  await q.alarm();assert.equal(f.calls,1);
  const result=await f.request(f.make(),'POST',body);assert.equal(result.status,200);
  assert.equal((await result.json()).extraction.name,'Synthetic food');assert.equal(f.calls,1);
  assert.ok(![...f.values.keys()].some(k=>k.startsWith('input:')));
});
it('fast dispatch is durably marked before work; failed paid work requires explicit retry and preserves lifetime counts',async()=>{
  const f=fixture(),q=f.make();await f.request(q,'POST',fastBody());
  f.setProcess(async(_body,_signal,{beforeProviderCall})=>{
    await beforeProviderCall('observation');assert.equal(f.values.get('job:'+id).providerDispatchCount,1);
    throw Object.assign(new Error(),{status:502,code:'upstream_network',trace:{usage:{status:'unavailable'}}});
  });
  await q.alarm();assert.equal(f.values.get('job:'+id).status,'retryable_failure');
  f.advance(60000);await f.make().alarm();assert.equal(f.calls,1);
  const failure=await (await f.request(q,'GET')).json();assert.equal(failure.manualRetryRequired,true);assert.equal(failure.trace.usage.status,'unavailable');
  assert.equal((await f.request(q,'POST',{},id+'/retry')).status,202);
  f.setProcess(async(_body,_signal,{beforeProviderCall})=>{await beforeProviderCall('observation');return {extraction:{name:'Explicit retry'}};});
  await q.alarm();const saved=f.values.get('job:'+id);assert.equal(saved.status,'complete');assert.equal(saved.paidCallCountTotal,2);assert.equal(saved.totalAttempts,2);
});
it('a lost acknowledgement across deployment returns the existing exact legacy job without changing policy or starting duplicate work',async()=>{
  const f=fixture(),q=f.make(),body=fastBody();delete body.analysisPolicy;
  await f.request(q,'POST',body);const original=structuredClone(f.values.get('job:'+id));
  assert.equal((await f.request(q,'POST',fastBody())).status,202);
  assert.deepEqual(f.values.get('job:'+id),original);assert.equal(f.values.get('job:'+id).fastPolicy,undefined);
  const changed=fastBody();changed.images[0].imageBase64='different-pixels';assert.equal((await f.request(q,'POST',changed)).status,409);
  await q.alarm();assert.equal((await f.request(q,'POST',fastBody())).status,200);assert.equal(f.calls,1);
});
it('new fast jobs advertise one-second polling without making another paid attempt',async()=>{
  const f=fixture(),q=f.make(),response=await f.request(q,'POST',fastBody());
  assert.equal(response.headers.get('retry-after'),'1');
  assert.equal((await f.request(q,'GET')).headers.get('retry-after'),'1');assert.equal(f.calls,0);
});
it('fast expired processing lease after dispatch never restarts paid work and fences the late result',async()=>{
  const f=fixture(),q=f.make();await f.request(q,'POST',fastBody());let finish,entered;
  const started=new Promise(resolve=>entered=resolve);
  f.setProcess(async(_body,_signal,{beforeProviderCall})=>{await beforeProviderCall('observation');entered();return new Promise(resolve=>finish=resolve);});
  const running=q.alarm();await started;f.advance(120001);await f.make().alarm();
  assert.equal(f.values.get('job:'+id).status,'retryable_failure');assert.equal(f.values.get('job:'+id).errorCode,'capture_retry_required');
  finish({extraction:{name:'Late answer'}});await running;assert.equal(f.calls,1);assert.equal((await f.request(q,'GET')).status,503);
});
it('fast jobs may retry admission before dispatch but prohibit duplicate observation or extra rechecks',async()=>{
  const f=fixture(),q=f.make();await f.request(q,'POST',fastBody());
  f.setProcess(async()=>{throw Object.assign(new Error(),{status:429,code:'quota_busy',retryAfter:5});});
  await q.alarm();assert.equal(f.values.get('job:'+id).status,'queued');f.advance(60000);
  f.setProcess(async(_body,_signal,{beforeProviderCall})=>{
    await beforeProviderCall('transcription');await beforeProviderCall('observation');
    await assert.rejects(beforeProviderCall('observation'),{code:'capture_retry_required'});
    await assert.rejects(beforeProviderCall('recheck'),{code:'capture_retry_required'});
    return {extraction:{name:'Once per explicit stage'}};
  });
  await q.alarm();assert.equal(f.values.get('job:'+id).status,'complete');assert.equal(f.values.get('job:'+id).paidCallCountTotal,2);
});
it('fast deleted or failed-storage dispatch checkpoint cannot authorize provider work',async()=>{
  for(const deleted of [false,true]){
    const f=fixture(),q=f.make();await f.request(q,'POST',fastBody());let providerCalls=0;
    f.setProcess(async(_body,_signal,{beforeProviderCall})=>{
      if(deleted)await f.request(q,'DELETE');else f.failNextAlarm();
      await beforeProviderCall('observation');providerCalls++;return {};
    });
    await q.alarm();assert.equal(providerCalls,0);
    assert.equal(f.values.get('job:'+id).providerDispatchCount||0,0);
  }
});
it('rejects edited payload under same id and accepts distinct intentional capture',async()=>{
  const f=fixture(),q=f.make();await f.request(q);
  assert.equal((await f.request(q,'POST',{changed:true})).status,409);
  assert.equal((await f.request(q,'POST',{changed:true},id2)).status,202);
  await q.alarm();await q.alarm();assert.equal(f.calls,2);
});
it('honours Retry-After, retains inputs and recovers a stale processing lease',async()=>{
  const f=fixture(),q=f.make();await f.request(q);
  f.setProcess(async()=>{throw Object.assign(new Error(),{status:429,code:'quota_busy',retryAfter:300});});
  await q.alarm();assert.ok(f.alarm>=f.time+300_000);assert.equal(f.values.get('job:'+id).status,'queued');
  await q.alarm();assert.equal(f.calls,1);
  const m=f.values.get('job:'+id);f.values.set('job:'+id,{...m,status:'processing',leaseUntil:f.time+1000});
  f.advance(1001);f.setProcess(async()=>({extraction:{name:'Recovered'}}));await f.make().alarm();
  assert.equal((await (await f.request(q,'GET')).json()).extraction.name,'Recovered');
});
it('deletion fences a running result and does not resurrect deleted history',async()=>{
  const f=fixture(),q=f.make();let finish,entered;
  const started=new Promise(r=>entered=r);f.setProcess(()=>{entered();return new Promise(r=>finish=r);});
  await f.request(q);const running=q.alarm();await started;
  assert.equal((await f.request(q,'DELETE')).status,200);finish({extraction:{name:'late'}});await running;
  assert.equal((await f.request(q,'GET')).status,410);assert.ok(![...f.values.keys()].some(k=>k.startsWith('result:')));
});
it('account purge erases private inputs and fences a late result',async()=>{
  const f=fixture(),q=f.make();await f.request(q);let finish,entered;const started=new Promise(r=>entered=r);
  f.setProcess(()=>{entered();return new Promise(r=>finish=r);});const running=q.alarm();await started;
  const purged=await q.fetch(new Request('https://private/purge',{method:'POST'}));assert.equal(purged.status,200);
  const {purgeToken}=await purged.json();assert.match(purgeToken,/^[a-f0-9-]{36}$/);
  finish({extraction:{name:'late'}});await running;assert.deepEqual([...f.values],[['purged',true],['purgeToken',purgeToken]]);
  assert.equal((await f.request(q)).status,410);
});
it('explicit verified-account reactivation cannot restore an old lease or overwrite a newly queued capture',async()=>{
  const f=fixture(),q=f.make();await f.request(q);let finish,entered;const started=new Promise(r=>entered=r);
  f.setProcess(()=>{entered();return new Promise(r=>finish=r);});const running=q.alarm();await started;
  const {purgeToken}=await (await q.fetch(new Request('https://private/purge',{method:'POST'}))).json();
  const reactivate=headers=>q.fetch(new Request('https://private/reactivate',{method:'POST',headers,body:JSON.stringify({purgeToken})}));
  assert.equal((await reactivate({})).status,404);assert.equal((await f.request(q)).status,410);
  assert.equal((await reactivate({'x-nudge-internal':'true'})).status,200);
  assert.equal((await f.request(q,'GET')).status,404,'Purged private data is never restored');
  assert.equal((await f.request(q,'POST',{images:[{imageBase64:'new-private-capture'}]})).status,202);
  finish({extraction:{name:'stale result'}});await running;
  assert.equal(f.values.get('job:'+id).status,'queued');assert.ok(![...f.values.keys()].some(k=>k.startsWith('result:')));
  assert.match(await q.readChunks(id,'input',1),/new-private-capture/);
  f.setProcess(async()=>({extraction:{name:'Fresh result'}}));await q.alarm();
  assert.equal((await (await f.request(q,'GET')).json()).extraction.name,'Fresh result');
});
it('a previous failed deletion cannot clear a newer account purge',async()=>{
  const f=fixture(),q=f.make(),purge=()=>q.fetch(new Request('https://private/purge',{method:'POST'}));
  const first=await (await purge()).json(),second=await (await purge()).json();
  assert.notEqual(first.purgeToken,second.purgeToken);
  const response=await q.fetch(new Request('https://private/reactivate',{method:'POST',headers:{'x-nudge-internal':'true'},body:JSON.stringify({purgeToken:first.purgeToken})}));
  assert.equal(response.status,409);assert.equal(f.values.get('purged'),true);assert.equal(f.values.get('purgeToken'),second.purgeToken);
  assert.equal((await f.request(q)).status,410);
});
it('terminal malformed-input failure remains editable with original retained until its scheduled expiry',async()=>{
  const f=fixture(),q=f.make();await f.request(q);f.setProcess(async()=>{throw Object.assign(new Error(),{status:422,code:'label_unreadable'});});
  await q.alarm();assert.equal((await f.request(q,'GET')).status,422);
  assert.ok([...f.values.keys()].some(k=>k.startsWith('input:')));assert.equal(f.alarm,f.time+RETENTION_MS);
});
it('uses separate stable account namespaces and rejects caller-shaped owners',()=>{
  const names=[],env={PRIVATE_CAPTURE_JOBS:{idFromName:n=>(names.push(n),n),get:id=>id}};
  assert.notEqual(privateCaptureStub(env,null),privateCaptureStub(env,'a'.repeat(64)));
  assert.equal(privateCaptureStub(env,'a'.repeat(64)),privateCaptureStub(env,'a'.repeat(64)));
  assert.throws(()=>privateCaptureStub(env,'other/user'));assert.equal(names.length,4);
});
it('exhausted attempts retain input; only explicit retry rearms after provider Retry-After',async()=>{
  const f=fixture(),q=f.make();await f.request(q);
  f.setProcess(async()=>{throw Object.assign(new Error(),{status:429,code:'quota_busy',retryAfter:300});});
  for(let i=0;i<6;i++){await q.alarm();if(i<5)f.advance(1000_000);}
  assert.equal(f.calls,6);assert.equal(f.values.get('job:'+id).status,'retryable_failure');
  assert.equal(f.alarm,f.values.get('job:'+id).createdAt+RETENTION_MS);
  assert.equal((await f.request(q)).status,503);assert.equal((await f.request(q,'GET')).status,503);
  assert.equal((await f.request(q,'POST',{},id+'/retry')).status,503);
  assert.equal(f.values.get('job:'+id).attempts,6);assert.ok([...f.values.keys()].some(k=>k.startsWith('input:')));
  f.advance(300_001);assert.equal((await f.request(q,'POST',{},id+'/retry')).status,202);
  f.setProcess(async()=>({extraction:{name:'Recovered'}}));await q.alarm();assert.equal(f.calls,7);
  assert.equal((await f.request(q,'GET')).status,200);
});
it('failed durable write cannot acknowledge a saved job',async()=>{
  const f=fixture(),q=f.make();q.putChunks=async()=>{throw new Error('Storage unavailable');};
  await assert.rejects(f.request(q),/Storage unavailable/);assert.equal(f.values.size,0);assert.equal(f.calls,0);
});
it('expired results are distinguished from deliberate deletion for local recovery',async()=>{
  const f=fixture(),q=f.make();await f.request(q);await q.alarm();f.advance(31*86400_000);await q.alarm();
  const expired=await f.request(q,'GET');assert.equal(expired.status,410);assert.equal((await expired.json()).code,'capture_expired');
  await f.request(q,'DELETE');assert.equal((await (await f.request(q,'GET')).json()).code,'capture_gone');
});

for(const status of ['queued','processing','needs_input','retryable_failure']){
  it(`legacy ${status} input expires at its original 30-day deadline before processing`,async()=>{
    const f=fixture(),q=f.make();await f.request(q);const createdAt=f.time;
    const m=f.values.get('job:'+id);
    f.values.set('job:'+id,{...m,status,nextRetryAt:createdAt+2*RETENTION_MS,leaseUntil:createdAt+2*RETENTION_MS});
    await q.schedule();assert.equal(f.alarm,createdAt+RETENTION_MS);
    f.advance(RETENTION_MS-1);await q.alarm();assert.ok(f.values.has('input:'+id+':0'));assert.equal(f.calls,0);
    f.advance(1);await q.alarm();assert.equal(f.calls,0);
    const response=await f.request(q,'GET');assert.equal(response.status,410);assert.equal((await response.json()).code,'capture_expired');
    assert.deepEqual(f.values.get('job:'+id),{id,status:'expired',expiresAt:f.time+RETENTION_MS});
    assert.ok(![...f.values.keys()].some(k=>/^(input|result):/.test(k)));
  });
  for(const method of ['GET','POST','retry']){
    it(`${method} expires legacy ${status} input without waiting for an alarm`,async()=>{
      const f=fixture(),q=f.make();await f.request(q);
      f.values.set('job:'+id,{...f.values.get('job:'+id),status,retryNotBefore:0});f.advance(RETENTION_MS);
      const response=await f.request(q,method==='retry'?'POST':method,{changed:true},method==='retry'?id+'/retry':id);
      assert.equal(response.status,410);assert.equal((await response.json()).code,'capture_expired');
      assert.equal(f.values.get('job:'+id).status,'expired');assert.equal(f.calls,0);
      assert.ok(![...f.values.keys()].some(k=>/^(input|result):/.test(k)));
    });
  }
}

it('manual retry and another failure do not extend the original input lifetime',async()=>{
  const f=fixture(),q=f.make();await f.request(q);const createdAt=f.time;
  f.values.set('job:'+id,{...f.values.get('job:'+id),attempts:5});
  f.setProcess(async()=>{throw Object.assign(new Error(),{status:503});});await q.alarm();
  assert.equal(f.values.get('job:'+id).status,'retryable_failure');
  f.advance(RETENTION_MS-1000);assert.equal((await f.request(q,'POST',{},id+'/retry')).status,202);
  await q.alarm();assert.equal(f.calls,2);assert.equal(f.values.get('job:'+id).createdAt,createdAt);
  assert.equal(f.alarm,createdAt+RETENTION_MS,'Retention wins when retry is due after the deadline');
  f.advance(1000);await q.alarm();assert.equal(f.calls,2);assert.equal((await f.request(q,'GET')).status,410);
});

it('completed result lifetime starts at completion and GET enforces its exact deadline',async()=>{
  const f=fixture(),q=f.make();await f.request(q);f.advance(2*86400_000);await q.alarm();const completedAt=f.time;
  f.advance(RETENTION_MS-1);assert.equal((await f.request(q,'GET')).status,200);
  assert.equal(f.alarm,Math.max(f.time+250,completedAt+RETENTION_MS));
  f.advance(1);const response=await f.request(q,'GET');assert.equal(response.status,410);
  assert.equal((await response.json()).code,'capture_expired');assert.equal(f.calls,1);
  assert.ok(![...f.values.keys()].some(k=>/^(input|result):/.test(k)));
});

for(const outcome of ['success','failure'])for(const useAlarm of [false,true]){
  it(`expiry fences an in-flight ${outcome} ${useAlarm?'with':'without'} a cleanup alarm`,async()=>{
    const f=fixture(),q=f.make();await f.request(q);f.advance(RETENTION_MS-1000);
    let finish,fail,entered;const started=new Promise(r=>entered=r);
    f.setProcess(()=>{entered();return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});});
    const running=q.alarm();await started;assert.equal(f.alarm,f.time+1000,'Expiry beats a longer processing lease');
    f.advance(1000);if(useAlarm)await q.alarm();
    if(outcome==='success')finish({extraction:{name:'Late result'}});else fail(Object.assign(new Error(),{status:503}));
    await running;assert.equal(f.values.get('job:'+id).status,'expired');assert.equal(f.calls,1);
    assert.ok(![...f.values.keys()].some(k=>/^(input|result):/.test(k)));
    assert.equal((await f.request(q,'POST',{},id+'/retry')).status,410);
  });
}

it('expired jobs release count capacity before a new upload is rejected',async()=>{
  const f=fixture(),q=f.make(),keys=Array.from({length:51},(_,i)=>`${String(i).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
  for(const key of keys.slice(0,50))assert.equal((await f.request(q,'POST',{},key)).status,202);
  assert.equal((await f.request(q,'POST',{},keys[50])).status,507);
  f.advance(RETENTION_MS);assert.equal((await f.request(q,'POST',{},keys[50])).status,202);
  assert.equal([...f.values.keys()].filter(k=>k.startsWith('input:')).length,1);
  assert.equal(f.values.get('job:'+keys[0]).status,'expired');assert.equal(f.calls,0);
});

it('expired jobs release byte capacity before a new upload is rejected',async()=>{
  const f=fixture(),q=f.make();await f.request(q);
  f.values.set('job:'+id,{...f.values.get('job:'+id),inputBytes:80_000_000,status:'needs_input'});
  assert.equal((await f.request(q,'POST',{},id2)).status,507);
  f.advance(RETENTION_MS);assert.equal((await f.request(q,'POST',{},id2)).status,202);
  assert.equal(f.values.get('job:'+id).status,'expired');assert.ok(!f.values.has('input:'+id+':0'));
});

it('expired tombstones are removed on schedule and old payloads do not remain',async()=>{
  const f=fixture(),q=f.make();await f.request(q);f.advance(RETENTION_MS);await q.alarm();
  assert.equal(f.alarm,f.time+RETENTION_MS);f.advance(RETENTION_MS);await q.alarm();
  assert.equal((await f.request(q,'GET')).status,404);assert.equal(f.values.size,0);assert.equal(f.alarm,null);
});

it('deleted tombstones reject edited uploads without retaining an input hash',async()=>{
  const f=fixture(),q=f.make();await f.request(q);await f.request(q,'DELETE');
  assert.deepEqual(f.values.get('job:'+id),{id,status:'deleted',expiresAt:f.time+RETENTION_MS});
  const response=await f.request(q,'POST',{changed:true});assert.equal(response.status,410);
  assert.equal((await response.json()).code,'capture_gone');assert.equal(f.calls,0);
});

it('cannot acknowledge a job if its retention/recovery alarm failed to persist',async()=>{
  const f=fixture(),q=f.make();f.failNextAlarm();await assert.rejects(f.request(q),/Alarm storage unavailable/);
  assert.equal(f.values.size,0);assert.equal(f.alarm,null);
  assert.equal((await f.request(q)).status,202);assert.ok(f.alarm);
});

it('scheduling cannot race account purge and restore an obsolete alarm',async()=>{
  const f=fixture(),q=f.make();await f.request(q);let entered,release;
  const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.setListHook(async()=>{entered();await gate;});const scheduling=q.schedule();await started;
  const purging=q.fetch(new Request('https://private/purge',{method:'POST'}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.values.has('purged'),false,'Purge cannot commit between a scheduling snapshot and its alarm write');release();
  await scheduling;assert.equal((await purging).status,200);assert.equal(f.alarm,null);
  assert.deepEqual([...f.values.keys()].sort(),['purgeToken','purged']);
});

it('an empty scheduling pass cannot cancel a concurrently accepted upload',async()=>{
  const f=fixture(),q=f.make();let entered,release;
  const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.setListHook(async()=>{entered();await gate;});const scheduling=q.schedule();await started;
  const uploading=f.request(q);release();await scheduling;assert.equal((await uploading).status,202);
  assert.ok(f.alarm);await q.alarm();assert.equal(f.calls,1);
});

it('account purge after input expiry prevents a late failure from restoring even an expired tombstone',async()=>{
  const f=fixture(),q=f.make();await f.request(q);f.advance(RETENTION_MS-1000);
  let fail,entered;const started=new Promise(r=>entered=r);
  f.setProcess(()=>{entered();return new Promise((_,reject)=>fail=reject);});
  const running=q.alarm();await started;f.advance(1000);await q.alarm();
  assert.equal(f.values.get('job:'+id).status,'expired');
  await q.fetch(new Request('https://private/purge',{method:'POST'}));
  fail(Object.assign(new Error(),{status:503}));await running;
  assert.deepEqual([...f.values.keys()].sort(),['purgeToken','purged']);assert.equal(f.alarm,null);
});

it('expiry removes all chunks of a large retained upload',async()=>{
  const f=fixture(),q=f.make();await f.request(q,'POST',{images:[{imageBase64:'x'.repeat(2_500_000)}]});
  assert.ok([...f.values.keys()].filter(k=>k.startsWith('input:')).length>100);
  f.advance(RETENTION_MS);await q.alarm();
  assert.deepEqual([...f.values.keys()],['job:'+id]);assert.equal(f.values.get('job:'+id).status,'expired');
});

it('input expiring while chunks load is removed before starting provider analysis',async()=>{
  const f=fixture(),q=f.make();await f.request(q);f.advance(RETENTION_MS-1);
  const read=q.readChunks.bind(q);q.readChunks=async(...args)=>{const text=await read(...args);f.advance(1);return text;};
  await q.alarm();assert.equal(f.calls,0);assert.equal(f.values.get('job:'+id).status,'expired');
  assert.ok(!f.values.has('input:'+id+':0'));
});

const expireRequest=(changes={})=>new Request('https://private/expire'+(changes.query||''),{
  method:changes.method||'POST',headers:changes.headers??{'x-nudge-internal':'true'},
  ...(changes.method==='GET'?{}:{body:changes.body??'{}'})});

it('internal maintenance expires overdue jobs without reading payloads or starting fresh work',async()=>{
  const f=fixture(),q=f.make();await f.request(q);
  f.values.set('job:'+id,{...f.values.get('job:'+id),status:'needs_input'});f.advance(RETENTION_MS);
  // Seed a second, fresh job without going through POST's eager sweep.
  f.values.set('job:'+id2,{id:id2,owner:'private-owner',status:'queued',inputChunks:1,inputBytes:2,createdAt:f.time,nextRetryAt:f.time,attempts:0});
  f.values.set('input:'+id2+':0','{}');
  const oldTombstone='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  f.values.set('job:'+oldTombstone,{id:oldTombstone,status:'deleted',expiresAt:f.time});
  q.readChunks=async()=>{throw new Error('Maintenance must not read payloads');};
  const response=await q.fetch(expireRequest());assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{expiredJobs:1,removedTombstones:1,remainingJobs:2,purged:false});
  assert.equal(f.calls,0);assert.equal(f.values.get('job:'+id).status,'expired');assert.equal(f.values.get('job:'+id2).status,'queued');
  assert.ok(!f.values.has('input:'+id+':0'));assert.ok(f.values.has('input:'+id2+':0'));assert.equal(f.alarm,f.time+250);
  assert.deepEqual(await (await q.fetch(expireRequest())).json(),{expiredJobs:0,removedTombstones:0,remainingJobs:2,purged:false});
});

it('internal maintenance is narrowly gated and requires an empty JSON object',async()=>{
  const f=fixture(),q=f.make();await f.request(q);const before=structuredClone(f.values);
  for(const [changes,status] of [[{headers:{}},404],[{method:'GET'},404],[{body:'{"path":"/purge"}'},400],
    [{body:'null'},400],[{body:'[]'},400],[{body:'true'},400],[{body:'invalid'},400],[{query:'?all=true'},400]]){
    assert.equal((await q.fetch(expireRequest(changes))).status,status);assert.deepEqual(f.values,before);
  }
});

it('internal maintenance preserves an account purge fence and keeps its alarm deleted',async()=>{
  const f=fixture(),q=f.make();await f.request(q);
  await q.fetch(new Request('https://private/purge',{method:'POST'}));const before=structuredClone(f.values);
  assert.deepEqual(await (await q.fetch(expireRequest())).json(),{expiredJobs:0,removedTombstones:0,remainingJobs:0,purged:true});
  assert.deepEqual(f.values,before);assert.equal(f.alarm,null);assert.equal((await f.request(q)).status,410);
});

it('meal hints survive queue restart and are included in the durable submission fingerprint',async()=>{
  const f=fixture(),hints={ingredients:['kefir','blueberries'],portion:{amount:500,unit:'ml'}},body={images:[{imageBase64:'synthetic-hinted-meal'}],mealHints:hints};
  assert.equal((await f.request(f.make(),'POST',body)).status,202);
  assert.equal((await f.request(f.make(),'POST',{mealHints:{portion:{unit:'ml',amount:500},ingredients:hints.ingredients},images:body.images})).status,202);
  assert.equal((await f.request(f.make(),'POST',{...body,mealHints:{...hints,portion:{amount:600,unit:'ml'}}})).status,409);
  assert.equal((await f.request(f.make(),'POST',{...body,mealHints:{ingredients:['kefir']}})).status,409);
  let received;f.setProcess(async input=>{received=input;return {extraction:{type:'meal',meal:{userIngredientSelection:{version:'meal-ingredients-v1',names:input.mealHints.ingredients,source:'user'}}}};});
  await f.make().alarm();assert.deepEqual(received.mealHints,hints);assert.equal(f.calls,1);
  assert.deepEqual((await (await f.request(f.make(),'GET')).json()).extraction.meal.userIngredientSelection.names,hints.ingredients);
});
