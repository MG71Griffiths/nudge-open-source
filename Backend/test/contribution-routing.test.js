import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from '../src/worker.js';
const privateToken='21'.repeat(32),adminToken='42'.repeat(32),hash=v=>createHash('sha256').update(v).digest('hex');
function fixture(){const requests=[];return {requests,env:{PRIVATE_ACCESS_TOKEN_SHA256:hash(privateToken),CATALOGUE_ADMIN_TOKEN_SHA256:hash(adminToken),FOOD_CATALOGUE_INDEX:{idFromName:v=>v,get:()=>({fetch:async(url,init)=>{requests.push({url,init});return Response.json({contributions:[]});}})}}};}
const req=(path,token=privateToken,method='GET',body)=>new Request('https://nudge.example'+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
describe('product contribution public routing',()=>{
 it('requires user authentication and supplies owner identity internally without AI configuration',async()=>{
  const {env,requests}=fixture();assert.equal((await worker.fetch(req('/v1/product-contributions',null),env)).status,401);assert.equal(requests.length,0);
  const response=await worker.fetch(req('/v1/product-contributions'),env);assert.equal(response.status,200);assert.equal(requests[0].init.headers['x-nudge-owner'],'private-owner');assert.equal(response.headers.get('cache-control'),'no-store');
 });
 it('requires the separate admin credential for reviews, recalculation and private photos',async()=>{
  for(const path of ['/v1/admin/product-contributions','/v1/admin/product-contributions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/photos/front']){
   const {env,requests}=fixture();assert.equal((await worker.fetch(req(path),env)).status,401);assert.equal(requests.length,0);assert.equal((await worker.fetch(req(path,adminToken),env)).status,200);assert.equal(requests[0].init.headers['x-nudge-admin'],'true');
  }
  const {env,requests}=fixture();assert.equal((await worker.fetch(req('/v1/catalogue/recalculate',privateToken,'POST',{}),env)).status,401);assert.equal(requests.length,0);assert.equal((await worker.fetch(req('/v1/catalogue/recalculate',adminToken,'POST',{}),env)).status,200);
 });
 it('exposes only reviewed source/export routes publicly, never internal jobs or unreviewed submissions',async()=>{
  const {env,requests}=fixture();for(const path of ['/v1/products/reviewed/12345678','/v1/catalogue/reviewed-export?limit=10'])assert.equal((await worker.fetch(req(path,null),env)).status,200);
  assert.ok(requests.every(r=>r.init.headers['x-nudge-internal']==='true'));
  for(const path of ['/contributions/claim','/process-product-contributions','/v1/product-contributions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])assert.notEqual((await worker.fetch(req(path,null),env)).status,200);
 });
 it('does not trust an owner or administration header supplied by the caller',async()=>{
  const {env,requests}=fixture(),request=req('/v1/product-contributions');request.headers.set('x-nudge-owner','ff'.repeat(32));request.headers.set('x-nudge-admin','true');request.headers.set('x-nudge-request-deadline',String(Date.now()+86400000));const started=Date.now();
  assert.equal((await worker.fetch(request,env)).status,200);const headers=requests[0].init.headers;assert.deepEqual(Object.keys(headers).sort(),['x-nudge-owner','x-nudge-request-deadline']);assert.equal(headers['x-nudge-owner'],'private-owner');assert.ok(Number(headers['x-nudge-request-deadline'])>=started+60000&&Number(headers['x-nudge-request-deadline'])<=Date.now()+60000);
 });
});
