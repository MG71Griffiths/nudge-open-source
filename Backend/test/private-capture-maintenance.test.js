import {it,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from '../src/worker.js';

// Synthetic tokens and opaque IDs only; no Auth, Cloudflare or provider calls.
const admin='12'.repeat(32),app='34'.repeat(32),objectID='a'.repeat(64),objectID2='b'.repeat(64);
const hash=value=>createHash('sha256').update(value).digest('hex');
const route='https://nudge.example/v1/admin/private-captures/expire';
function fixture(){
  const ids=[],calls=[];let rejectID,failAt=0;
  let receipt={expiredJobs:2,removedTombstones:1,remainingJobs:4,purged:false};
  const env={CATALOGUE_ADMIN_TOKEN_SHA256:hash(admin),PRIVATE_ACCESS_TOKEN_SHA256:hash(app),PRIVATE_CAPTURE_JOBS:{
    idFromString:value=>{ids.push(value);if(value===rejectID)throw new TypeError('ID belongs to another namespace');return {opaque:value};},
    get:id=>({fetch:async(url,init)=>{
      calls.push({id,url,init});if(failAt===calls.length)throw new Error('Synthetic unavailable namespace');
      return Response.json(receipt);
    }})
  }};
  const send=(body={objectIds:[objectID]},options={})=>worker.fetch(new Request(options.url||route,{method:options.method||'POST',
    headers:{...(options.token===null?{}:{authorization:'Bearer '+(options.token??admin)}),'content-type':options.contentType||'application/json'},
    ...(['GET','HEAD'].includes(options.method)?{}:{body:options.raw??JSON.stringify(body)})}),env);
  return {env,ids,calls,send,rejectID:value=>rejectID=value,setReceipt:value=>receipt=value,failAt:value=>failAt=value};
}
afterEach(()=>mock.restoreAll());

it('only catalogue administrators can request private retention cleanup',async()=>{
  const network=mock.method(globalThis,'fetch',()=>{throw new Error('No network permitted');});
  for(const token of [null,app,'not-a-token','eyJhbGciOiJIUzI1NiJ9.synthetic.signature']){
    const f=fixture(),response=await f.send(undefined,{token});assert.equal(response.status,401);
    assert.equal(f.ids.length,0);assert.equal(f.calls.length,0);
  }
  const f=fixture();delete f.env.CATALOGUE_ADMIN_TOKEN_SHA256;
  assert.equal((await f.send()).status,503);assert.equal(f.calls.length,0);assert.equal(network.mock.callCount(),0);
});

it('forwards only the fixed internal expiration action and returns aggregate counts',async()=>{
  const f=fixture(),response=await f.send({objectIds:[objectID,objectID2]});assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,objects:2,expiredJobs:4,removedTombstones:2,remainingJobs:8,purgedObjects:0});
  assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(f.ids,[objectID,objectID2]);
  for(const call of f.calls){
    assert.equal(call.url,'https://private-captures/expire');assert.equal(call.init.method,'POST');
    assert.equal(call.init.headers['x-nudge-internal'],'true');assert.equal(call.init.body,'{}');
  }
});

it('accepts the maximum 50-object batch without reading private data',async()=>{
  const f=fixture(),objectIds=Array.from({length:50},(_,i)=>i.toString(16).padStart(64,'0'));
  const response=await f.send({objectIds});assert.equal(response.status,200);assert.equal((await response.json()).objects,50);
  assert.equal(f.calls.length,50);
});

it('rejects malformed, duplicate, excessive or caller-directed batches before touching a namespace',async()=>{
  for(const body of [null,[],{}, {objectIds:[]},{objectIds:[objectID],path:'/purge'}, {objectIds:[objectID],namespace:'other'},
    {objectIds:objectID},{objectIds:[1]},{objectIds:[null]},{objectIds:[objectID.toUpperCase()]},{objectIds:['private-owner']},
    {objectIds:[objectID,objectID]},{objectIds:[objectID,'../../purge']},
    {objectIds:Array.from({length:51},(_,i)=>i.toString(16).padStart(64,'0'))}]){
    const f=fixture(),response=await f.send(body);assert.equal(response.status,400,JSON.stringify(body));
    assert.equal(f.ids.length,0);assert.equal(f.calls.length,0);
  }
  const f=fixture();assert.equal((await f.send(undefined,{raw:'{"objectIds":'})).status,400);
  assert.equal((await f.send(undefined,{raw:' '.repeat(5000)})).status,413);assert.equal(f.calls.length,0);
});

it('requires POST over HTTPS with JSON and no query parameters',async()=>{
  for(const [options,status] of [[{method:'GET'},404],[{method:'DELETE'},404],[{url:route+'?path=/purge'},400],
    [{url:route.replace('https:','http:')},400],[{contentType:'text/plain'},415]]){
    const f=fixture();assert.equal((await f.send(undefined,options)).status,status);assert.equal(f.calls.length,0);
  }
});

it('rejects an ID from another namespace before expiring even the valid first object',async()=>{
  const f=fixture();f.rejectID(objectID2);
  const response=await f.send({objectIds:[objectID,objectID2]});assert.equal(response.status,400);
  assert.equal((await response.json()).code,'request_invalid');assert.deepEqual(f.ids,[objectID,objectID2]);assert.equal(f.calls.length,0);
});

it('missing bindings and failed objects never receive a successful cleanup receipt',async()=>{
  const missing=fixture();delete missing.env.PRIVATE_CAPTURE_JOBS;assert.equal((await missing.send()).status,503);
  const f=fixture();f.failAt(2);const response=await f.send({objectIds:[objectID,objectID2]});assert.equal(response.status,503);
  assert.equal((await response.json()).code,'capture_cleanup_unavailable');assert.equal(f.calls.length,2);
  f.failAt(0);assert.equal((await f.send({objectIds:[objectID,objectID2]})).status,200,'Whole-batch retry remains supported after a partial failure');
});

it('rejects unexpected private payloads instead of forwarding them to maintenance callers',async()=>{
  for(const receipt of [{photos:['private content']},{expiredJobs:-1,removedTombstones:0,remainingJobs:0,purged:false},
    {expiredJobs:0,removedTombstones:0,remainingJobs:0,purged:'false'},
    {expiredJobs:0,removedTombstones:0,remainingJobs:0,purged:false,owner:'synthetic-user'}]){
    const f=fixture();f.setReceipt(receipt);const response=await f.send();assert.equal(response.status,503);
    assert.doesNotMatch(await response.text(),/photos|private content|synthetic-user/);
  }
});

it('counts already purged objects without reopening them',async()=>{
  const f=fixture();f.setReceipt({expiredJobs:0,removedTombstones:0,remainingJobs:0,purged:true});
  const response=await f.send();assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,objects:1,expiredJobs:0,removedTombstones:0,remainingJobs:0,purgedObjects:1});
});
