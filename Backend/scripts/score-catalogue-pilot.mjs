#!/usr/bin/env node
import {requireAdminOrigin} from './require-admin-origin.mjs';
// Persistent server checkpoints are authoritative. Local receipts and exports
// contain public product data only; credentials are read from a separate file.
import {readFile,writeFile,appendFile,mkdir,rename,open,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DIRECTIONAL_SCORE_REVISION} from '../src/product-score.js';
import {exportPilot} from './pilot-export.mjs';

const actions=['create','run','status','coverage','extend','pause','resume','export','quality-hold','activate','rollback'];
export function parseOptions(args){
 const options={};for(let i=0;i<args.length;i+=2){if(!['--action','--run-id','--token-file','--output','--delay-ms','--review-note','--batch-size','--expected-selected','--include-source','--scope','--review-file'].includes(args[i])||!args[i+1]||Object.hasOwn(options,args[i]))throw new Error('Use --action create|run|status|coverage|extend|pause|resume|export|quality-hold|activate|rollback --run-id ID --token-file PATH [--scope uk|non-uk (create only)] [--review-note TEXT] [--expected-selected COUNT] [--include-source yes|no] [--output .local/scoring-pilot/ID].');options[args[i]]=args[i+1];}
 if(!actions.includes(options['--action'])||!/^[A-Za-z0-9_-]{8,80}$/.test(options['--run-id']||'')||!options['--token-file'])throw new Error('An action, stable run ID and separate admin token file are required.');
 const output=resolve(options['--output']||'.local/scoring-pilot/'+options['--run-id']),token=resolve(options['--token-file']);
 if(!output.includes('/scoring-pilot/')||token===output||token.startsWith(output+'/'))throw new Error('Use a separate scoring-pilot output directory, outside the credential file.');
 const delay=Number(options['--delay-ms']||300),limit=Number(options['--batch-size']||50);
 if(!Number.isSafeInteger(delay)||delay<250||delay>30000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Batch size must be 1–100; delay must be 250–30000 ms.');
 const reviewNote=options['--review-note'];if(['extend','activate'].includes(options['--action'])&&(!reviewNote?.trim()||reviewNote.length>2000))throw new Error('Record the completed quality review using --review-note before extending or activating.');
 const expectedSelected=options['--expected-selected']===undefined?undefined:Number(options['--expected-selected']);
 if(expectedSelected!==undefined&&(options['--action']!=='activate'||!Number.isSafeInteger(expectedSelected)||expectedSelected<1||expectedSelected>10000))throw new Error('--expected-selected is an activation review count between 1 and 10000.');
 if(options['--include-source']!==undefined&&(options['--action']!=='export'||!['yes','no'].includes(options['--include-source'])))throw new Error('--include-source yes|no is an export option.');
 if(options['--scope']!==undefined&&(options['--action']!=='create'||!['uk','non-uk'].includes(options['--scope'])))throw new Error('--scope uk|non-uk is a create-only option.');
 if(options['--action']==='quality-hold'&&!options['--review-file'])throw new Error('Quality holds require a reviewed --review-file JSON payload.');
 if(options['--review-file']&&options['--action']!=='quality-hold')throw new Error('--review-file is a quality-hold-only option.');
 return {reviewFile:options['--review-file']?resolve(options['--review-file']):undefined,action:options['--action'],runID:options['--run-id'],tokenPath:token,output,delay,limit,reviewNote,expectedSelected,includeSource:options['--include-source']==='yes',scope:options['--scope']};
}
export function retryDelay(response,attempt,now=Date.now(),random=Math.random){
 const header=response?.headers?.get('retry-after');let server=0;
 if(header){const seconds=Number(header);server=Number.isFinite(seconds)&&seconds>=0?seconds*1000:Math.max(0,Date.parse(header)-now)||0;}
 return Math.max(server,Math.min(15000,1000*2**attempt)*(0.75+random()*0.5));
}
export function clientTimingSummary(measurements){
 const processedRecords=measurements.reduce((sum,m)=>sum+m.processedRecords,0),elapsedMs=measurements.reduce((sum,m)=>sum+m.elapsedMs,0);
 const productsPerSecond=elapsedMs>0&&processedRecords>0?processedRecords/(elapsedMs/1000):null;
 return {invocations:measurements.length,processedRecords,elapsedMs,productsPerSecond,projected10000Ms:productsPerSecond?Math.round(10000/productsPerSecond*1000):null};
}
async function save(path,value){await writeFile(path+'.part',JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(path+'.part',path);}
export async function main(args=process.argv.slice(2)){
  const origin = requireAdminOrigin();
 const options=parseOptions(args),token=(await readFile(options.tokenPath,'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid catalogue admin credential.');
 await mkdir(options.output,{recursive:true});
 const lockPath=options.output+'/runner.lock',lock=await open(lockPath,'wx');let stopping=false,wake=null;
 const invocationID=crypto.randomUUID(),invocationStarted=performance.now();let invocationOutcome='complete';
 // Only fixed metadata belongs in diagnostics: never credentials, request or
 // response bodies, URLs, review notes, or arbitrary exception messages.
 async function diagnostic(event,details={}){
  await appendFile(options.output+'/request-diagnostics.jsonl',JSON.stringify({at:new Date().toISOString(),runID:options.runID,invocationID,command:options.action,event,...details})+'\n',{mode:0o600});
 }
 const stop=()=>{stopping=true;wake?.();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const sleep=ms=>new Promise(resolve=>{const finish=()=>{clearTimeout(timer);wake=null;resolve();};const timer=setTimeout(finish,ms);wake=finish;if(stopping)finish();});
 async function request(action,extra={}){
  for(let attempt=0;attempt<6;attempt++){
   if(stopping)return null;
   const started=performance.now();let response,value,failure;
   await diagnostic('request_started',{action,attempt:attempt+1,timeoutMs:45000});
   try {
    response=await fetch(origin+'/v1/catalogue/scoring/'+action,{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({runID:options.runID,...extra})});
    if(!response.ok){const error=new Error('Scoring administration returned HTTP '+response.status);error.diagnosticCode='http_'+response.status;error.retryable=[429,500,502,503,504].includes(response.status);if(response.status===409){const v=await response.json().catch(()=>null);error.retryable=v?.code==='catalogue_scoring_run_busy';if(error.retryable)error.diagnosticCode='run_busy';}throw error;}
    value=await response.json();
    if(value.runID!==options.runID||value.method!==DIRECTIONAL_SCORE_REVISION.method||value.version!==DIRECTIONAL_SCORE_REVISION.version||value.classifierVersion!==DIRECTIONAL_SCORE_REVISION.classifierVersion)throw Object.assign(new Error('Deployed scoring revision differs from this runner.'),{retryable:false,diagnosticCode:'revision_mismatch'});
    if(action==='create'&&options.scope!==undefined&&value.scope!==options.scope)throw Object.assign(new Error('Deployed scoring scope differs from the requested cohort.'),{retryable:false,diagnosticCode:'scope_mismatch'});
   }catch(error){failure=error;}
   const retryable=!!failure&&!stopping&&attempt<5&&failure.retryable!==false,delay=retryable?retryDelay(response,attempt):null;
   await diagnostic('request_finished',{action,attempt:attempt+1,status:response?.status??null,durationMs:Math.max(0,Math.round(performance.now()-started)),outcome:failure?(stopping?'stopped':retryable&&delay<=60000?'retry':'failed'):'success',errorCode:failure?(failure.diagnosticCode||(failure.name==='TimeoutError'?'request_timeout':failure.name==='AbortError'?'request_aborted':failure instanceof SyntaxError?'invalid_response':'network_or_request_error')):null,retryDelayMs:retryable&&delay<=60000?Math.round(delay):null});
   if(!failure)return value;
   if(stopping)return null;
   if(!retryable)throw failure;
   if(delay>60000)throw new Error('Server requested a retry after '+Math.ceil(delay/1000)+' seconds. The durable run is saved; resume later.');
   await sleep(delay);
  }
 }
 async function receipt(value){if(value){await save(options.output+'/checkpoint.json',value);console.log(JSON.stringify({runID:value.runID,state:value.state,target:value.target,counts:value.counts,metrics:value.metrics,eligibleShortfall:value.eligibleShortfall}));}return value;}
 try {
  await diagnostic('command_started');
  if(options.action==='quality-hold'){
   const bytes=await readFile(options.reviewFile);if(bytes.length>200000)throw new Error('Quality review file exceeds its bounded size.');
   const review=JSON.parse(bytes);
   if(!review||review.runID!==options.runID||Object.keys(review).some(k=>!['runID','reviewID','reviewNote','items'].includes(k))||!Array.isArray(review.items)||review.items.length<1||review.items.length>50)throw new Error('Invalid source-bound quality review file.');
   const value=await receipt(await request('quality-hold',review));
   if(value)await save(options.output+'/quality-hold-receipt.json',value);
   return;
  }
  if(options.action==='coverage'){
   const value=await request('coverage');
   if(value){await save(options.output+'/coverage.json',value);console.log(JSON.stringify(value));}
   return;
  }
  if(options.action==='export'){
   const result=await exportPilot({options,request,sleep,stopped:()=>stopping,diagnostic});
   console.log(JSON.stringify({runID:options.runID,...result}));return;
  }
  if(options.action==='run'){
   let value=await receipt(await request('status'));
   if(!value||value.state!=='running'||!value.counts.pending)return;
   const timingPath=options.output+'/client-timing.json';
   let previous;try{previous=JSON.parse(await readFile(timingPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
   if(previous&&previous.runID!==options.runID)throw new Error('Client timing belongs to a different run.');
   const measurements=previous?.measurements||[],initialProcessed=value.metrics.processed,started=performance.now();
   const measurement={id:crypto.randomUUID(),startedAt:new Date().toISOString(),finishedAt:null,processedBefore:initialProcessed,processedRecords:0,elapsedMs:0,status:'running'};
   measurements.push(measurement);
   async function timing(status='running'){
    Object.assign(measurement,{status,elapsedMs:Math.max(0,Math.round(performance.now()-started)),processedRecords:Math.max(0,(value?.metrics.processed??initialProcessed)-initialProcessed)});
    if(status!=='running')measurement.finishedAt=new Date().toISOString();
    const summary=clientTimingSummary(measurements);
    await save(timingPath,{runID:options.runID,basis:'Client observed scoring requests, retries and throttle delays. Excludes status lookup, export, pauses between invocations and unacknowledged requests. Each resume is a separate measurement.',measurements,summary});
    console.log(JSON.stringify({runID:options.runID,event:'client_timing',invocation:measurement,summary}));
   }
   try{
    while(value&&!stopping&&value.state==='running'&&value.counts.pending>0){
     const next=await request('step',{limit:options.limit});if(next)value=await receipt(next);
     await timing();if(value?.counts.pending&&!stopping)await sleep(options.delay);
    }
    await timing(stopping?'stopped':value?.counts.pending?'paused':'complete');
   }catch(error){await timing('interrupted');throw error;}
   return;
  }
  if(['activate','rollback'].includes(options.action)){
   let value;
   do{value=await receipt(await request(options.action,{limit:options.limit,...(options.action==='activate'?{reviewPassed:true,reviewNote:options.reviewNote,...(options.expectedSelected===undefined?{}:{expectedSelected:options.expectedSelected})}:{})}));if(value&&['activating','rolling_back'].includes(value.state))await sleep(options.delay);}while(value&&!stopping&&['activating','rolling_back'].includes(value.state));return;
  }
  await receipt(await request(options.action,options.action==='extend'?{reviewPassed:true,reviewNote:options.reviewNote}:options.action==='create'&&options.scope!==undefined?{scope:options.scope}:{}));
 }catch(error){invocationOutcome='failed';throw error;}
 finally{
  try{await diagnostic('command_finished',{outcome:stopping?'stopped':invocationOutcome,durationMs:Math.max(0,Math.round(performance.now()-invocationStarted))});}
  finally{await lock.close();await unlink(lockPath);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);if(stopping){console.log(JSON.stringify({runID:options.runID,event:'stopped_after_current_request',resume:'Use the same run ID; completed server results are retained.'}));process.exitCode=130;}}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
