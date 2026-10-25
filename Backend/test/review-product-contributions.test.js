import {it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {runReviewCLI} from '../scripts/review-product-contributions.mjs';

const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',TOKEN='ab'.repeat(32),BARCODE='1234567890123',NOW=1_790_000_000_000;
const JPEG=Buffer.from([255,216,255,217]),SHA=createHash('sha256').update(JPEG).digest('hex');
const ORIGIN='https://review.example',COMMON=['--base-url',ORIGIN];
const fixture=()=>({contribution:{id:ID,barcode:BARCODE,status:'pending_review',updatedAt:NOW,expiresAt:NOW+86400000,missingPhotoRoles:[]},
 candidate:{readyForReview:true,product:{code:BARCODE},prediction:{category:{value:'en:baked-beans'}}},photos:[{role:'front',mime_type:'image/jpeg',sha256:SHA}]});
async function setup(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nudge-review-test-'));await fs.chmod(directory,0o700);t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
function runner(handler){const requests=[],output=[];return {requests,output,run:(args,extra={})=>runReviewCLI([...args,...COMMON],{env:{NUDGE_CATALOGUE_ADMIN_TOKEN:TOKEN},now:()=>NOW,write:text=>output.push(text),fetchImpl:async(url,init)=>{assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer '+TOKEN);requests.push({url,init});return handler(url,init);},...extra})};}

it('lists and saves inspected candidates without printing photo bodies or credentials',async t=>{
 const directory=await setup(t),detail=fixture();detail.candidate.privateEvidence='not-for-stdout';
 const r=runner(url=>Response.json(url.endsWith(ID)?detail:{contributions:[detail.contribution]}));
 await r.run(['list']);await r.run(['show',ID,'--out',directory]);
 assert.equal(r.requests.length,2);assert.ok(r.output.every(text=>!text.includes(TOKEN)&&!text.includes('not-for-stdout')));
 const file=path.join(directory,'review.json');assert.equal((await fs.stat(file)).mode&0o777,0o600);
 const snapshot=JSON.parse(await fs.readFile(file));assert.equal(snapshot.origin,ORIGIN);assert.equal(snapshot.detail.contribution.updatedAt,NOW);
 await assert.rejects(()=>r.run(['show',ID,'--out',directory]),/never overwritten/);
});
it('downloads only authenticated role endpoints with hash verification and private file modes',async t=>{
 const directory=await setup(t),r=runner(url=>url.includes('/photos/')?new Response(JPEG,{headers:{'content-type':'image/jpeg'}}):Response.json(fixture()));
 await r.run(['show',ID,'--out',directory]);await r.run(['photos','--snapshot',path.join(directory,'review.json'),'--out',path.join(directory,'photos')]);
 const file=path.join(directory,'photos','front.jpg');assert.deepEqual(await fs.readFile(file),JPEG);assert.equal((await fs.stat(file)).mode&0o777,0o600);
 assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700);
 assert.equal(r.requests.at(-1).url,ORIGIN+'/v1/admin/product-contributions/'+ID+'/photos/front');
});
it('publishes only with exact explicit confirmations and the inspected update version',async t=>{
 const directory=await setup(t),r=runner((_url,init)=>Response.json(init.method==='POST'?{contribution:{...fixture().contribution,status:'published'}}:fixture()));
 await r.run(['show',ID,'--out',directory]);const snapshot=path.join(directory,'review.json');
 for(const args of [[],['--confirm-barcode','9999','--confirm-category','en:baked-beans','--confirm-label-facts'],['--confirm-barcode',BARCODE,'--confirm-category','en:soups','--confirm-label-facts']])await assert.rejects(()=>r.run(['publish','--snapshot',snapshot,...args]));
 assert.equal(r.requests.filter(r=>r.init.method==='POST').length,0);
 await r.run(['publish','--snapshot',snapshot,'--confirm-barcode',BARCODE,'--confirm-category','en:baked-beans','--confirm-label-facts']);
 assert.deepEqual(JSON.parse(r.requests.at(-1).init.body),{decision:'publish',expectedUpdatedAt:NOW,confirmBarcode:true,confirmCategory:true,confirmLabelFacts:true});
});
it('rejects stale, cross-server and altered snapshots before a review write',async t=>{
 const directory=await setup(t),detail=fixture(),r=runner(()=>Response.json(detail));await r.run(['show',ID,'--out',directory]);
 const file=path.join(directory,'review.json');detail.contribution.updatedAt++;
 await assert.rejects(()=>r.run(['reject','--snapshot',file]),/changed/);
 const snapshot=JSON.parse(await fs.readFile(file));snapshot.origin='https://different.example';await fs.writeFile(file,JSON.stringify(snapshot));
 await assert.rejects(()=>r.run(['reject','--snapshot',file]),/origin/);
 assert.equal(r.requests.filter(r=>r.init.method==='POST').length,0);
});
it('keeps product correction notes private and requires explicit review confirmation',async t=>{
 const directory=await setup(t),detail=fixture();detail.contribution.correction={fields:['nutrition'],note:'Private proposed label fact',source:'user_proposed'};
 const r=runner((_url,init)=>Response.json(init.method==='POST'?{contribution:{...detail.contribution,status:'published',pointsAwarded:1}}:detail));
 await r.run(['show',ID,'--out',directory]);assert.ok(r.output.every(text=>!text.includes(detail.contribution.correction.note)));
 const args=['publish','--snapshot',path.join(directory,'review.json'),'--confirm-barcode',BARCODE,'--confirm-category','en:baked-beans','--confirm-label-facts'];
 await assert.rejects(()=>r.run(args),/confirm-correction/);assert.equal(r.requests.filter(r=>r.init.method==='POST').length,0);
 await r.run([...args,'--confirm-correction']);assert.equal(JSON.parse(r.requests.at(-1).init.body).confirmCorrection,true);
});
it('rejects a submission through an explicit command without publication confirmations',async t=>{
 const directory=await setup(t),r=runner((_url,init)=>Response.json(init.method==='POST'?{contribution:{...fixture().contribution,status:'rejected'}}:fixture()));
 await r.run(['show',ID,'--out',directory]);await r.run(['reject','--snapshot',path.join(directory,'review.json')]);
 assert.deepEqual(JSON.parse(r.requests.at(-1).init.body),{decision:'reject',expectedUpdatedAt:NOW});
});
it('loads owner-only token files, rejects unsafe files/options and never repeats ambiguous writes',async t=>{
 const directory=await setup(t),tokenFile=path.join(directory,'token');await fs.writeFile(tokenFile,TOKEN,{mode:0o600});
 const r=runner(()=>Response.json({contributions:[]}));await r.run(['list','--token-file',tokenFile],{env:{}});
 await fs.chmod(tokenFile,0o644);await assert.rejects(()=>r.run(['list','--token-file',tokenFile],{env:{}}),/owner-only/);
 await assert.rejects(()=>r.run(['list','--token',TOKEN]),error=>!error.message.includes(TOKEN));
 await assert.rejects(()=>r.run(['list','--base-url','https://example.com/secret']),/duplicate/);
 const publish=runner((_url,init)=>{if(init.method==='POST')throw new Error('upstream '+TOKEN);return Response.json(fixture());});
 await publish.run(['show',ID,'--out',directory]);
 await assert.rejects(()=>publish.run(['publish','--snapshot',path.join(directory,'review.json'),'--confirm-barcode',BARCODE,'--confirm-category','en:baked-beans','--confirm-label-facts']),error=>/outcome is unknown/.test(error.message)&&!error.message.includes(TOKEN));
 assert.equal(publish.requests.filter(r=>r.init.method==='POST').length,1);
});
it('rejects mismatched photos and sanitizes server failures without saving evidence',async t=>{
 const directory=await setup(t),r=runner(url=>url.includes('/photos/')?new Response(Buffer.from([255,216,1,255,217]),{headers:{'content-type':'image/jpeg'}}):Response.json(fixture()));
 await r.run(['show',ID,'--out',directory]);await assert.rejects(()=>r.run(['photos','--snapshot',path.join(directory,'review.json'),'--out',path.join(directory,'photos')]),/evidence changed/);
 assert.deepEqual(await fs.readdir(path.join(directory,'photos')),[]);
 const fail=runner(()=>Response.json({code:TOKEN,message:TOKEN},{status:503}));await assert.rejects(()=>fail.run(['list']),error=>/HTTP 503/.test(error.message)&&!error.message.includes(TOKEN));
});
