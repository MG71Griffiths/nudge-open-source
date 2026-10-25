import {describe,it,mock,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from '../src/worker.js';
const token='63'.repeat(32),auth={PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex')};
const input=description=>({description,requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
const request=(body=input('banana'),extra={})=>new Request('https://nudge.example/v1/food-description/analyse'+(extra.query||''),{method:extra.method||'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...extra.headers},...(extra.method==='GET'?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
const selected={isFood:true,name:'Cheese sandwich with chutney',components:[
 {name:'white bread',sourceId:'11-980:d3b50c7664c5',amountGrams:80,evidence:'cheese sandwich',assumption:'Estimated two 40 g slices of white bread.'},
 {name:'cheddar cheese',sourceId:'12-346:9077a1c24b1d',amountGrams:30,evidence:'cheese',assumption:'Estimated 30 g generic Cheddar cheese.'},
 {name:'tomato chutney',sourceId:'17-345:3281604a170a',amountGrams:20,evidence:'chutney',assumption:'Estimated 20 g tomato chutney proxy.'}]};
const remote=input('I ate a cheese sandwich with chutney after work');
function environment({allowed=true,spend=true}={}){
 const calls=[],env={...auth,OPENAI_API_KEY:'synthetic-test-only',OPENAI_MODEL:'gpt-4.1-mini',CAPTURE_DAILY_SPEND_STOP_MICROUSD:'10000000',LABEL_QUOTA:{idFromName:v=>v,get:()=>({fetch:async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body)});
  return Response.json(url.endsWith('/acquire')?{allowed,busy:!allowed,retryAfter:12}:url.endsWith('/capture-spend-reserve')?{allowed:spend,enabled:true,code:spend?undefined:'capture_spend_limit'}:{allowed:true});
 }})}};return {env,calls};
}
afterEach(()=>mock.restoreAll());
describe('typed food HTTP authorization and quota boundary',()=>{
 it('requires authentication and accepts only the bounded exact JSON route',async()=>{
  mock.method(globalThis,'fetch',()=>assert.fail('No provider call'));
  assert.equal((await worker.fetch(request(undefined,{headers:{authorization:''}}),auth)).status,401);
  assert.equal((await worker.fetch(request(undefined,{method:'GET'}),auth)).status,404);
  assert.equal((await worker.fetch(request(undefined,{query:'?debug=1'}),auth)).status,400);
  assert.equal((await worker.fetch(request(undefined,{headers:{'content-type':'text/plain'}}),auth)).status,415);
  for(const body of ['{',input('a'),{...input('banana'),day:'private'},' '.repeat(12289)])assert.ok([400,413].includes((await worker.fetch(request(body),auth)).status));
 });
 it('returns local estimates without AI configuration, quota, source lookup or private catalogue writes',async()=>{
  mock.method(globalThis,'fetch',()=>assert.fail('No external call'));
  const response=await worker.fetch(request(input('sourdough cheese sandwich with chutney')),auth),body=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(body.entry.sourceMeta.typedFood.method,'local');assert.equal(body.entry.energyPerPortion,368);
 });
 it('honours denied admission before a paid call and never releases another lease',async()=>{
  mock.method(globalThis,'fetch',()=>assert.fail('Must not dispatch'));const {env,calls}=environment({allowed:false});
  const response=await worker.fetch(request(remote),env);assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'12');assert.deepEqual(calls.map(c=>c.url),['https://quota/acquire']);
 });
 it('reserves spending before one provider call and releases after success without persisting the description',async()=>{
  const {env,calls}=environment();let count=0;
  mock.method(globalThis,'fetch',async(url,options)=>{count++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(calls.at(-1).url,'https://quota/capture-spend-reserve');assert.equal(JSON.parse(options.body).model,env.OPENAI_MODEL);return Response.json({status:'completed',model:env.OPENAI_MODEL,usage:{input_tokens:10,output_tokens:20,total_tokens:30,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens_details:{reasoning_tokens:0}},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(selected)}]}]});});
  const response=await worker.fetch(request(remote),env);assert.equal(response.status,200);assert.equal(count,1);assert.equal(calls.at(-1).url,'https://quota/release');
  const reservation=calls.find(c=>c.url.endsWith('/capture-spend-reserve')),settled=calls.find(c=>c.url.endsWith('/capture-spend-settle'));
  assert.equal(reservation.body.kind,'observation');assert.equal(reservation.body.maxOutputTokens,2048);assert.equal(settled.body.callID,reservation.body.callID);assert.ok(Number.isInteger(settled.body.costMicrousd));assert.ok(!JSON.stringify(calls).includes(remote.description));
 });
 it('fails closed on spend limits and always releases its own admitted lease',async()=>{
  mock.method(globalThis,'fetch',()=>assert.fail('No spend beyond limit'));const {env,calls}=environment({spend:false});
  const response=await worker.fetch(request(remote),env);assert.equal(response.status,429);assert.equal((await response.json()).code,'capture_spend_limit');assert.equal(calls.at(-1).url,'https://quota/release');
 });
 it('releases after provider failure, retains unknown spend and hides private upstream details',async()=>{
  const {env,calls}=environment();let count=0;mock.method(globalThis,'fetch',async()=>{count++;throw Error('PRIVATE DESCRIPTION AND TOKEN');});
  const response=await worker.fetch(request(remote),env);assert.equal(response.status,502);assert.equal(count,1);assert.ok(!(await response.text()).includes('PRIVATE'));
  assert.equal(calls.find(c=>c.url.endsWith('/capture-spend-settle')).body.costMicrousd,null);assert.equal(calls.at(-1).url,'https://quota/release');
 });
});
