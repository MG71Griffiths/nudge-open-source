import {it} from 'node:test';
import assert from 'node:assert/strict';
import {validCapturePolicy,responseUsage,usageCostMicrousd,captureUsage,captureReservationMicrousd} from '../src/capture-policy.js';
import {captureSpendAction} from '../src/capture-spend.js';
const reported=(changes={})=>({input_tokens:1000,input_tokens_details:{cached_tokens:200,cache_write_tokens:0},
  output_tokens:100,output_tokens_details:{reasoning_tokens:40},total_tokens:1100,...changes});
it('accepts only the explicit bounded fast policy, leaving absent historical policy distinct',()=>{
  assert.equal(validCapturePolicy({version:1,mode:'fast'}),true);
  for(const value of [undefined,null,[],{},'fast',{version:2,mode:'fast'},{version:1,mode:'fast',maxCalls:3},{version:1,mode:'verify'}])
    assert.equal(validCapturePolicy(value),false);
});
it('counts cached/reasoning tokens once and prices only the known usage/rate combination',()=>{
  const usage=responseUsage(reported());
  assert.deepEqual(usage,{inputTokens:1000,cachedInputTokens:200,cacheWriteTokens:0,outputTokens:100,reasoningTokens:40,totalTokens:1100});
  assert.equal(usageCostMicrousd('gpt-4.1-mini',usage),500);
  assert.equal(usageCostMicrousd('gpt-4.1-mini-2025-04-14',usage),500);
  assert.equal(usageCostMicrousd('new-unpriced-model',usage),null);
  assert.equal(usageCostMicrousd('gpt-4.1-mini',{...usage,cacheWriteTokens:1}),null);
  assert.equal(usageCostMicrousd('gpt-4o-mini-transcribe',responseUsage(reported({input_tokens_details:{cached_tokens:0,cache_write_tokens:0}}))),1750);
});
it('invalid, absent or inconsistent usage never becomes zero billed tokens',()=>{
  for(const value of [null,{},reported({input_tokens:-1}),reported({input_tokens:1.2}),reported({input_tokens:'1000'}),
    reported({total_tokens:999}),reported({input_tokens_details:{cached_tokens:900,cache_write_tokens:101}}),
    reported({output_tokens_details:{reasoning_tokens:101}}),reported({input_tokens:Infinity})])assert.equal(responseUsage(value),null);
  const usage=responseUsage(reported()),calls=[{kind:'observation',usageStatus:'reported',...usage,estimatedCostMicrousd:500},
    {kind:'recheck',usageStatus:'unavailable',estimatedCostMicrousd:null}];
  const summary=captureUsage(calls);assert.equal(summary.status,'partial');assert.equal(summary.reportedCallCount,1);
  assert.equal(summary.totals.totalTokens,1100);assert.equal(summary.totals.estimatedCostMicrousd,null);
  assert.equal(captureUsage([calls[1]]).totals.inputTokens,null);
  const missing=responseUsage({input_tokens:10,output_tokens:20,total_tokens:30});
  assert.equal(missing.cachedInputTokens,null);assert.equal(missing.cacheWriteTokens,null);assert.equal(missing.reasoningTokens,null);
  assert.equal(usageCostMicrousd('gpt-4.1-mini',missing),null);
});
function fixture(limit='1000000'){
  const values=new Map([['quota',{lease:'one',leaseUntil:1_800_000_060_000}]]);
  let now=1_800_000_000_000;
  const tx={get:async key=>structuredClone(values.get(key)),put:async(key,value)=>values.set(key,structuredClone(value))};
  const env=limit===undefined?{}:{CAPTURE_DAILY_SPEND_STOP_MICROUSD:limit};
  const args={lease:'one',callID:'call-1',kind:'observation',model:'gpt-4.1-mini',maxOutputTokens:8192};
  return {values,args,env,run:(action,body=args)=>captureSpendAction(tx,env,action,body,now),
    advance:value=>now+=value,clock:()=>now};
}
it('reserves conservative model bounds, settles reported cost once, and does not double-refund',async()=>{
  const f=fixture(),reserve=captureReservationMicrousd('gpt-4.1-mini','observation',8192);
  assert.ok(reserve>400000);assert.equal((await f.run('reserve')).allowed,true);
  assert.equal((await f.run('reserve')).allowed,true);assert.equal(f.values.get('capture-spend').accountedMicrousd,reserve);
  const settle={lease:'one',callID:'call-1',costMicrousd:500};
  assert.equal((await f.run('settle',settle)).settled,true);assert.equal((await f.run('settle',settle)).settled,false);
  assert.equal(f.values.get('capture-spend').accountedMicrousd,500);
  assert.equal((await f.run('reserve')).allowed,false,'A settled call cannot be dispatched again with its old ID');
});
it('unknown outcomes retain reservation and owner request exemption cannot bypass spend stop',async()=>{
  const f=fixture('500000');f.env.LABEL_PRIVATE_OWNER_UNLIMITED='true';
  await f.run('reserve');const reserved=f.values.get('capture-spend').accountedMicrousd;
  await f.run('settle',{lease:'one',callID:'call-1',costMicrousd:null});
  assert.equal(f.values.get('capture-spend').accountedMicrousd,reserved);
  assert.equal((await f.run('reserve',{...f.args,callID:'call-2'})).code,'capture_spend_limit');
  assert.equal(f.values.get('capture-spend').accountedMicrousd,reserved);
});
it('abandoned-call and UTC-day fences prevent a late settlement refunding a newer reservation',async()=>{
  const f=fixture();await f.run('reserve');const first=f.values.get('capture-spend').accountedMicrousd;
  f.advance(60001);f.values.set('quota',{lease:'two',leaseUntil:f.clock()+60000});
  await f.run('reserve',{...f.args,lease:'two',callID:'call-2'});
  assert.equal((await f.run('settle',{lease:'one',callID:'call-1',costMicrousd:0})).settled,false);
  assert.equal(f.values.get('capture-spend').accountedMicrousd,first*2);
  f.advance(86400000);f.values.set('quota',{lease:'three',leaseUntil:f.clock()+60000});
  await f.run('reserve',{...f.args,lease:'three',callID:'call-3'});
  assert.equal(f.values.get('capture-spend').accountedMicrousd,first);
  assert.equal((await f.run('settle',{lease:'two',callID:'call-2',costMicrousd:0})).settled,false);
  assert.equal(f.values.get('capture-spend').accountedMicrousd,first);
});
it('invalid configured caps and unpriced models fail closed, while no configured cap adds none',async()=>{
  for(const value of ['-1','NaN','1.5',-1,Infinity])assert.equal((await fixture(value).run('reserve')).code,'capture_spend_configuration');
  assert.equal((await fixture('0').run('reserve')).code,'capture_spend_limit');
  const f=fixture();assert.equal((await f.run('reserve',{...f.args,model:'unpriced'})).code,'capture_spend_unpriced');
  assert.equal((await f.run('reserve',{...f.args,maxOutputTokens:32769})).code,'capture_spend_unpriced');
  assert.equal((await f.run('reserve',{...f.args,lease:'other'})).code,'capture_spend_unavailable');
  delete f.env.CAPTURE_DAILY_SPEND_STOP_MICROUSD;assert.deepEqual(await f.run('reserve'),{allowed:true,enabled:false});
  assert.equal(f.values.has('capture-spend'),false);
});
