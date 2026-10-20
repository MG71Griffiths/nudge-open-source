import {it} from 'node:test';
import assert from 'node:assert/strict';
import {uploadCatalogueBatch} from '../scripts/catalogue-upload.mjs';
it('retries transient catalogue failure boundedly and preserves only a safe status/code',async()=>{
 let calls=0;const delays=[];await assert.rejects(()=>uploadCatalogueBatch('https://test.example','not-logged','{}',{fetchImpl:async()=>{calls++;return Response.json({code:'catalogue_unavailable',message:'sensitive-raw-message'},{status:503});},sleep:async ms=>delays.push(ms)}),error=>error.status===503&&error.code==='catalogue_unavailable'&&!error.message.includes('sensitive'));
 assert.equal(calls,4);assert.deepEqual(delays,[1000,2000,4000]);
});
it('does not retry or quarantine a confirmed platform storage capacity limit',async()=>{
 let calls=0;await assert.rejects(()=>uploadCatalogueBatch('https://test.example','not-logged','{}',{fetchImpl:async()=>{calls++;return Response.json({code:'catalogue_storage_limit'},{status:503});},sleep:async()=>assert.fail('must not retry quota')}),error=>error.code==='catalogue_storage_limit');assert.equal(calls,1);
});
it('does not log unknown server errors or accept malformed success results',async()=>{
 await assert.rejects(()=>uploadCatalogueBatch('https://test.example','not-logged','{}',{fetchImpl:async()=>Response.json({code:'raw_secret_from_server'},{status:400})}),error=>error.code==='catalogue_upload_unavailable'&&!error.message.includes('raw_secret'));
 await assert.rejects(()=>uploadCatalogueBatch('https://test.example','not-logged','{}',{fetchImpl:async()=>Response.json({accepted:'20'})}),error=>error.code==='catalogue_upload_response_invalid');
});
it('returns the server accepted count without additional provider or AI calls',async()=>{
 const result=await uploadCatalogueBatch('https://test.example','not-logged','{}',{fetchImpl:async(url,init)=>{assert.equal(init.redirect,'error');assert.equal(init.headers['user-agent'],'Nudge/0.1 (official food catalogue import)');return Response.json({accepted:25});}});assert.equal(result.accepted,25);
});
