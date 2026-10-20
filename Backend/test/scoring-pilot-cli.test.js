import {it,mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {main,parseOptions} from '../scripts/score-catalogue-pilot.mjs';
import {DIRECTIONAL_SCORE_REVISION} from '../src/product-score.js';
import {SCORING_SELECTION_VERSION,NON_UK_SCORING_SELECTION_VERSION} from '../src/catalogue-scoring-run.js';

it('stages only an explicit matching bounded quality review file and keeps notes out of diagnostics',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nudge-quality-cli-')),runID='quality-cli-test',output=join(root,'scoring-pilot',runID),tokenPath=join(root,'credential'),reviewPath=join(root,'review.json');
 const review={runID,reviewID:'independent-review',reviewNote:'PRIVATE_REVIEW_TEXT',items:[{barcode:'12345678',sourceFingerprint:'a'.repeat(64),sourceFetchedAt:123,reasonCode:'source_identity_conflict',evidenceNote:'PRIVATE_EVIDENCE_TEXT'}]};
 await writeFile(tokenPath,'b'.repeat(64));await writeFile(reviewPath,JSON.stringify(review));
 const captured=[],fetchMock=mock.method(globalThis,'fetch',async(url,options)=>{captured.push({url,body:JSON.parse(options.body)});return Response.json({runID,...DIRECTIONAL_SCORE_REVISION,state:'review',target:500,counts:{quality_held:1}});});
 const log=mock.method(console,'log',()=>{});
 try{
  const args=['--action','quality-hold','--run-id',runID,'--token-file',tokenPath,'--output',output,'--review-file',reviewPath];
  await main(args);assert.equal(captured.length,1);assert.ok(captured[0].url.endsWith('/quality-hold'));assert.deepEqual(captured[0].body,review);
  const diagnostics=await readFile(join(output,'request-diagnostics.jsonl'),'utf8');assert.ok(!diagnostics.includes('PRIVATE_'));
  assert.equal(JSON.parse(await readFile(join(output,'quality-hold-receipt.json'),'utf8')).counts.quality_held,1);
  await writeFile(reviewPath,JSON.stringify({...review,runID:'wrong-review-run'}));await assert.rejects(()=>main(args),/Invalid source-bound/);assert.equal(captured.length,1);
 }finally{fetchMock.mock.restore();log.mock.restore();await rm(root,{recursive:true,force:true});}
});

it('persists safe attempt, retry and whole-command timings for create, extend, run and export',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nudge-pilot-cli-')),runID='diagnostic-pilot-test',token='a'.repeat(64),note='Private review note must never appear in diagnostics';
 const tokenPath=join(root,'credential');await writeFile(tokenPath,token);
 const base={runID,...DIRECTIONAL_SCORE_REVISION,state:'review',target:500,updatedAt:123,counts:{pending:0,selected:1},metrics:{processed:1}};
 const logged=[],consoleMock=mock.method(console,'log',value=>logged.push(value));
 try{
  for(const action of ['create','extend','run','export']){
   const output=join(root,'scoring-pilot',action);let calls=0;
   const fetchMock=mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(options.headers.authorization,'Bearer '+token);calls++;
    if(action==='create'&&calls===1)return new Response('PRIVATE_RESPONSE_BODY',{status:503});
    if(action==='run'&&url.endsWith('/status'))return Response.json({...base,state:'running',counts:{pending:1},metrics:{processed:499}});
    if(action==='export'&&url.endsWith('/records'))return Response.json({...base,records:[{barcode:'12345678',name:'PUBLIC_PRODUCT_BODY'}],hasMore:false});
    return Response.json(base);
   });
   try{await main(['--action',action,'--run-id',runID,'--token-file',tokenPath,'--output',output,...(action==='extend'?['--review-note',note]:[])]);}finally{fetchMock.mock.restore();}
   const path=join(output,'request-diagnostics.jsonl'),text=await readFile(path,'utf8'),events=text.trim().split('\n').map(line=>JSON.parse(line));
   assert.equal(events[0].event,'command_started');assert.equal(events.at(-1).event,'command_finished');assert.equal(events.at(-1).outcome,'complete');
   assert.ok(events.every(event=>event.command===action&&event.runID===runID&&event.invocationID===events[0].invocationID));
   assert.equal(events.filter(event=>event.event==='request_started').length,calls);
   const finished=events.filter(event=>event.event==='request_finished');assert.equal(finished.length,calls);
   assert.ok(finished.every(event=>Number.isSafeInteger(event.durationMs)&&event.durationMs>=0));
   if(action==='create'){assert.equal(finished[0].status,503);assert.equal(finished[0].outcome,'retry');assert.equal(finished[0].errorCode,'http_503');assert.ok(finished[0].retryDelayMs>=750);assert.equal(finished[1].attempt,2);}
   if(action==='run')assert.deepEqual(finished.map(event=>event.action),['status','step']);
   if(action==='export')assert.deepEqual(finished.map(event=>event.action),['status','records','status']);
   for(const secret of [token,note,'PRIVATE_RESPONSE_BODY','PUBLIC_PRODUCT_BODY',tokenPath,'authorization','https://'])assert.ok(!text.includes(secret),'Diagnostics must not include '+secret);
   assert.equal((await stat(path)).mode&0o777,0o600);
   await assert.rejects(()=>stat(join(output,'runner.lock')),error=>error.code==='ENOENT');
  }
 }finally{consoleMock.mock.restore();await rm(root,{recursive:true,force:true});}
});

it('resumes a legacy UK export with selection-version-only status and scope-less records from its last saved page',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nudge-pilot-cli-')),output=join(root,'scoring-pilot','resume'),tokenPath=join(root,'credential'),runID='resumable-pilot-test';
 await writeFile(tokenPath,'c'.repeat(64));
 const base={runID,...DIRECTIONAL_SCORE_REVISION,state:'review',target:500,updatedAt:123,counts:{pending:0,selected:200},metrics:{processed:200}};
 const rows=Array.from({length:200},(_,i)=>({barcode:String(5000000000000+i),name:'Product '+i,after:{value:i%5*25}})),requests=[];
 let interrupted=true;
 const fetchMock=mock.method(globalThis,'fetch',async(url,options)=>{
  if(url.endsWith('/status'))return Response.json({...base,selectionVersion:SCORING_SELECTION_VERSION});
  const {after}=JSON.parse(options.body);requests.push(after);
  if(after&&interrupted)return new Response('Do not retain failed response body',{status:403});
  return Response.json({...base,records:after?rows.slice(100):rows.slice(0,100),hasMore:!after,nextAfter:after?null:rows[99].barcode});
 });
 const consoleMock=mock.method(console,'log',()=>{}),args=['--action','export','--run-id',runID,'--token-file',tokenPath,'--output',output,'--delay-ms','250'];
 try{
  await assert.rejects(()=>main(args),/HTTP 403/);
  const partial=JSON.parse(await readFile(join(output,'export-manifest.json'),'utf8'));
  assert.equal(partial.complete,false);assert.equal(partial.recordCount,100);assert.equal(partial.pages.length,1);assert.equal(partial.nextAfter,rows[99].barcode);
  assert.equal(JSON.parse(await readFile(join(output,'records.json'),'utf8')).complete,false,'Partial export must never look complete');
  const pagePath=join(output,'export-pages-'+partial.generation,partial.pages[0].file),pageBefore=await stat(pagePath);
  interrupted=false;await main(args);
  const complete=JSON.parse(await readFile(join(output,'records.json'),'utf8'));
  assert.deepEqual(complete,{runID,...DIRECTIONAL_SCORE_REVISION,complete:true,records:rows});
  assert.deepEqual(requests,['',rows[99].barcode,rows[99].barcode],'Resume must not fetch the first page again');
  assert.equal((await stat(pagePath)).mtimeMs,pageBefore.mtimeMs,'A completed page is never rewritten');
  const manifest=JSON.parse(await readFile(join(output,'export-manifest.json'),'utf8'));assert.equal(manifest.complete,true);assert.equal(manifest.recordCount,200);assert.equal(manifest.pages.length,2);
  const finalBefore=await stat(join(output,'records.json'));await main(args);
  assert.equal(requests.length,3,'An unchanged completed export only checks current server status');
  assert.equal((await stat(join(output,'records.json'))).mtimeMs,finalBefore.mtimeMs);
 }finally{fetchMock.mock.restore();consoleMock.mock.restore();await rm(root,{recursive:true,force:true});}
});

it('does not publish a completed file if the server snapshot changed during export',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nudge-pilot-cli-')),output=join(root,'scoring-pilot','changed'),tokenPath=join(root,'credential'),runID='changing-pilot-test';await writeFile(tokenPath,'d'.repeat(64));
 const base={runID,...DIRECTIONAL_SCORE_REVISION,state:'review',target:500,updatedAt:123,counts:{pending:0,selected:1},metrics:{processed:1}};let statusCalls=0;
 const fetchMock=mock.method(globalThis,'fetch',async url=>url.endsWith('/status')?Response.json({...base,updatedAt:123+statusCalls++}):Response.json({...base,records:[{barcode:'12345678'}],hasMore:false}));
 try{
  await assert.rejects(()=>main(['--action','export','--run-id',runID,'--token-file',tokenPath,'--output',output]),/changed during export/);
  assert.equal(JSON.parse(await readFile(join(output,'records.json'),'utf8')).complete,false);
  const manifest=JSON.parse(await readFile(join(output,'export-manifest.json'),'utf8'));assert.equal(manifest.complete,false);assert.equal(manifest.fetchComplete,true);
 }finally{fetchMock.mock.restore();await rm(root,{recursive:true,force:true});}
});

it('logs sanitized terminal failures and releases the lock without retrying rejected actions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nudge-pilot-cli-')),output=join(root,'scoring-pilot','failure'),tokenPath=join(root,'credential');await writeFile(tokenPath,'b'.repeat(64));
 const fetchMock=mock.method(globalThis,'fetch',async()=>new Response('Do not log this response',{status:403}));
 try{
  await assert.rejects(()=>main(['--action','create','--run-id','failed-pilot-test','--token-file',tokenPath,'--output',output]),/HTTP 403/);
  const events=(await readFile(join(output,'request-diagnostics.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event=>event.event==='request_started').length,1);
  assert.equal(events.find(event=>event.event==='request_finished').errorCode,'http_403');
  assert.equal(events.at(-1).outcome,'failed');await assert.rejects(()=>stat(join(output,'runner.lock')),error=>error.code==='ENOENT');
 }finally{fetchMock.mock.restore();await rm(root,{recursive:true,force:true});}
});

it('sends the reviewed partial count on every publication batch and saves coverage without overwriting run checkpoints',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nudge-pilot-cli-')),output=join(root,'scoring-pilot','partial'),tokenPath=join(root,'credential'),runID='partial-review-test';await writeFile(tokenPath,'e'.repeat(64));
 const args=['--run-id',runID,'--token-file',tokenPath,'--output',output,'--delay-ms','250'],requests=[];
 const base={runID,...DIRECTIONAL_SCORE_REVISION,target:500,counts:{selected:12,pending:0},metrics:{processed:12}},coverage={runID,...DIRECTIONAL_SCORE_REVISION,coverage:{catalogue:{uk:{total:12}}}};
 const fetchMock=mock.method(globalThis,'fetch',async(url,options)=>{
  const body=JSON.parse(options.body);requests.push({url,body});
  if(url.endsWith('/coverage'))return Response.json(coverage);
  return Response.json({...base,state:requests.length===1?'activating':'activated'});
 });
 const consoleMock=mock.method(console,'log',()=>{});
 try{
  await main(['--action','activate',...args,'--expected-selected','12','--review-note','Reviewed all12']);
  assert.equal(requests.length,2);assert.ok(requests.every(request=>request.body.expectedSelected===12&&request.body.reviewPassed===true));
  const checkpoint=await readFile(join(output,'checkpoint.json'),'utf8');
  await main(['--action','coverage',...args]);assert.deepEqual(requests.at(-1).body,{runID});
  assert.deepEqual(JSON.parse(await readFile(join(output,'coverage.json'),'utf8')),coverage);assert.equal(await readFile(join(output,'checkpoint.json'),'utf8'),checkpoint);
  for(const count of ['0','10001','1.2','NaN'])assert.throws(()=>parseOptions(['--action','activate',...args,'--expected-selected',count,'--review-note','Review']),/activation review count/);
  assert.throws(()=>parseOptions(['--action','coverage',...args,'--expected-selected','12']),/activation review count/);
 }finally{fetchMock.mock.restore();consoleMock.mock.restore();await rm(root,{recursive:true,force:true});}
});
it('starts a new export generation when raw sources are requested instead of reusing source-less pages',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nudge-pilot-cli-')),output=join(root,'scoring-pilot','sources'),tokenPath=join(root,'credential'),runID='source-export-test';await writeFile(tokenPath,'f'.repeat(64));
 const args=['--action','export','--run-id',runID,'--token-file',tokenPath,'--output',output],requests=[];
 const base={runID,...DIRECTIONAL_SCORE_REVISION,state:'review',target:500,updatedAt:123,counts:{pending:0,selected:1},metrics:{processed:1}},row={barcode:'12345678'},source={raw:{code:'12345678',product_name:'Retained public product'},sourceFingerprint:'exact',sourceFetchedAt:123};
 const fetchMock=mock.method(globalThis,'fetch',async(url,options)=>{
  if(url.endsWith('/status'))return Response.json(base);
  const body=JSON.parse(options.body);requests.push(body);
  return Response.json({...base,records:[{...row,...(body.includeSource?{source}:{})}],hasMore:false});
 }),consoleMock=mock.method(console,'log',()=>{});
 try{
  await main(args);const initial=JSON.parse(await readFile(join(output,'export-manifest.json'),'utf8'));assert.equal(initial.includeSource,false);
  await main([...args,'--include-source','yes']);const complete=JSON.parse(await readFile(join(output,'records.json'),'utf8')),manifest=JSON.parse(await readFile(join(output,'export-manifest.json'),'utf8'));
  assert.notEqual(manifest.generation,initial.generation);assert.equal(manifest.includeSource,true);assert.deepEqual(complete.records,[{...row,source}]);assert.deepEqual(requests.map(request=>request.includeSource),[undefined,true]);
  await main([...args,'--include-source','yes']);assert.equal(requests.length,2,'Matching source-inclusive export remains resumable');
  assert.throws(()=>parseOptions([...args,'--include-source','maybe']),/export option/);
  assert.throws(()=>parseOptions(['--action','run',...args.slice(2),'--include-source','yes']),/export option/);
 }finally{fetchMock.mock.restore();consoleMock.mock.restore();await rm(root,{recursive:true,force:true});}
});

it('creates an explicit non-UK cohort and binds resumable export metadata to its returned scope',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nudge-pilot-cli-')),output=join(root,'scoring-pilot','non-uk'),tokenPath=join(root,'credential'),runID='non-uk-cohort-test';await writeFile(tokenPath,'a'.repeat(64));
 const args=['--run-id',runID,'--token-file',tokenPath,'--output',output],requests=[];
 const base={runID,...DIRECTIONAL_SCORE_REVISION,scope:'non-uk',selectionVersion:NON_UK_SCORING_SELECTION_VERSION,state:'review',target:500,updatedAt:123,counts:{pending:0,selected:1},metrics:{processed:1}};
 let pageScope='non-uk';
 const fetchMock=mock.method(globalThis,'fetch',async(url,options)=>{
  const body=JSON.parse(options.body);requests.push({url,body});
  return Response.json(url.endsWith('/records')?{...base,scope:pageScope,selectionVersion:pageScope==='uk'?SCORING_SELECTION_VERSION:NON_UK_SCORING_SELECTION_VERSION,records:[{barcode:'12345678'}],hasMore:false}:base);
 }),consoleMock=mock.method(console,'log',()=>{});
 try{
  await main(['--action','create',...args,'--scope','non-uk']);assert.equal(requests[0].body.scope,'non-uk');
  const checkpoint=JSON.parse(await readFile(join(output,'checkpoint.json'),'utf8'));assert.equal(checkpoint.scope,'non-uk');
  pageScope='uk';await assert.rejects(()=>main(['--action','export',...args]),/different selection scope/);
  assert.equal(JSON.parse(await readFile(join(output,'records.json'),'utf8')).complete,false);
  pageScope='non-uk';await main(['--action','export',...args]);
  const exported=JSON.parse(await readFile(join(output,'records.json'),'utf8')),manifest=JSON.parse(await readFile(join(output,'export-manifest.json'),'utf8'));
  assert.equal(exported.scope,'non-uk');assert.equal(exported.selectionVersion,NON_UK_SCORING_SELECTION_VERSION);assert.equal(manifest.scope,'non-uk');assert.equal(manifest.selectionVersion,NON_UK_SCORING_SELECTION_VERSION);
  assert.ok(requests.slice(1).every(r=>r.body.scope===undefined),'Scope is sent only when creating, never changed on resume');
  const count=requests.length;await main(['--action','export',...args]);assert.equal(requests.length,count+1,'Completed matching-scope export only checks status');
  const retained=await readFile(join(output,'records.json'),'utf8');delete base.scope;delete base.selectionVersion;
  await assert.rejects(()=>main(['--action','export',...args]),/different selection scope/);
  assert.equal(await readFile(join(output,'records.json'),'utf8'),retained,'An old UK-only server response must not replace a non-UK export');
  for(const action of ['run','status','coverage','export'])assert.throws(()=>parseOptions(['--action',action,...args,'--scope','non-uk']),/create-only/);
  for(const scope of ['all','nonUK','0'])assert.throws(()=>parseOptions(['--action','create',...args,'--scope',scope]),/create-only/);
 }finally{fetchMock.mock.restore();consoleMock.mock.restore();await rm(root,{recursive:true,force:true});}
});
it('fails closed when a server does not honour explicit non-UK creation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nudge-pilot-cli-')),output=join(root,'scoring-pilot','wrong-scope'),tokenPath=join(root,'credential'),runID='wrong-scope-test';await writeFile(tokenPath,'b'.repeat(64));let calls=0;
 const fetchMock=mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({runID,...DIRECTIONAL_SCORE_REVISION,scope:'uk',selectionVersion:SCORING_SELECTION_VERSION});});
 try{
  await assert.rejects(()=>main(['--action','create','--run-id',runID,'--token-file',tokenPath,'--output',output,'--scope','non-uk']),/scope differs/);assert.equal(calls,1);
  await assert.rejects(()=>stat(join(output,'checkpoint.json')),error=>error.code==='ENOENT');
 }finally{fetchMock.mock.restore();await rm(root,{recursive:true,force:true});}
});
