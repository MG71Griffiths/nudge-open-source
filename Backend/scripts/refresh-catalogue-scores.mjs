#!/usr/bin/env node
import {requireAdminOrigin} from './require-admin-origin.mjs';
const adminOrigin = requireAdminOrigin();
// Refresh retained public facts only. This job never reads/writes OFF images,
// image-warm checkpoints, personal observations or private diary records.
import { readFile, writeFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { ScoreCore } from '../src/nutrition-core.js';
const options={};
for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i].startsWith('--')||!process.argv[i+1])throw new Error('Use --token-file PATH [--state .local/score-refresh/checkpoint.json] [--delay-ms 300] [--status-only yes]');options[process.argv[i].slice(2)]=process.argv[i+1];}
if(Object.keys(options).some(key=>!['token-file','state','delay-ms','status-only'].includes(key))||!options['token-file'])throw new Error('A separate catalogue admin token file is required.');
const statePath=resolve(options.state||'.local/score-refresh/checkpoint.json'), tokenPath=resolve(options['token-file']);
if(basename(dirname(statePath))!=='score-refresh'||statePath===tokenPath)throw new Error('Use a dedicated score-refresh checkpoint directory, separate from image jobs and credentials.');
const delay=Number(options['delay-ms']||300);
if(!Number.isSafeInteger(delay)||delay<250||delay>30000||options['status-only']&&!['yes','no'].includes(options['status-only']))throw new Error('Invalid refresh options.');
const token=(await readFile(tokenPath,'utf8')).trim();
if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid catalogue admin token.');
await mkdir(dirname(statePath),{recursive:true});
const lockPath=statePath+'.lock',lock=await open(lockPath,'wx');
const endpoint = adminOrigin + '/v1/catalogue/recalculate';
let stopSignal=null,wakePause=null;
const stop=signal=>{stopSignal=signal;wakePause?.();};
const onInterrupt=()=>stop('SIGINT'),onTerminate=()=>stop('SIGTERM');
process.once('SIGINT',onInterrupt);process.once('SIGTERM',onTerminate);
const sleep=ms=>new Promise(resolve=>{const finish=()=>{clearTimeout(timer);wakePause=null;resolve();};const timer=setTimeout(finish,ms);wakePause=finish;if(stopSignal)finish();});
const state={method:ScoreCore.SCORE_METHOD,version:ScoreCore.SCORE_VERSION,classifierVersion:ScoreCore.CLASSIFIER_VERSION,startedAt:new Date().toISOString(),batches:0,updated:0,complete:false};
async function request(statusOnly=false){
 for(let attempt=0;attempt<6;attempt++){
  if(stopSignal){const error=new Error('Score refresh stopped.');error.stopRequested=true;throw error;}
  try{
   const response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(statusOnly?{statusOnly:true}:{})});
   if(!response.ok){const error=new Error('Catalogue score refresh failed with HTTP '+response.status);error.retryable=[429,500,502,503,504].includes(response.status);throw error;}
   const value=await response.json();
   if(value.method!==state.method||value.version!==state.version||value.classifierVersion!==state.classifierVersion)throw new Error('The deployed catalogue score revision does not match this script.');
   if(!Number.isSafeInteger(value.total)||value.total<0||!Number.isSafeInteger(value.remaining)||value.remaining<0||value.remaining>value.total
     ||!Number.isSafeInteger(value.updated)||value.updated<0||value.updated>600||value.complete!==(value.remaining===0))throw new Error('Invalid score refresh receipt.');
   return value;
  }catch(error){if(stopSignal){error.stopRequested=true;throw error;}if(attempt===5||error.retryable===false||/revision|receipt/.test(error.message))throw error;await sleep(Math.min(15000,1000*2**attempt));}
 }
}
async function save(receipt){
 Object.assign(state,{total:receipt.total,remaining:receipt.remaining,complete:receipt.complete,checkedAt:new Date().toISOString()});
 await writeFile(statePath+'.part',JSON.stringify(state,null,2)+'\n');await rename(statePath+'.part',statePath);
}
try{
 const status=await request(true);await save(status);console.log(JSON.stringify({event:'score_refresh_status',...status}));
 if(options['status-only']!=='yes')while(!state.complete&&!stopSignal){
  const receipt=await request();state.batches++;state.updated+=receipt.updated;await save(receipt);
  if(state.batches%10===0||state.complete)console.log(JSON.stringify({event:'score_refresh_progress',batches:state.batches,updated:state.updated,remaining:state.remaining,total:state.total,complete:state.complete}));
  if(!receipt.updated&&!receipt.complete)throw new Error('Score refresh made no progress; retain the checkpoint and inspect the catalogue.');
  // Keep one request in flight and honour the configured inter-batch pause.
  // Network/processing time is already elapsed; adding it again doubles a
  // large catalogue migration without reducing per-request work.
  if(!state.complete&&!stopSignal)await sleep(delay);
 }
}catch(error){if(!error.stopRequested)throw error;}
finally{
 await lock.close();await unlink(lockPath);
 process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onTerminate);
 if(stopSignal){console.log(JSON.stringify({event:'score_refresh_stopped',signal:stopSignal,batches:state.batches,updated:state.updated,remaining:state.remaining??null,complete:state.complete}));process.exitCode=stopSignal==='SIGINT'?130:143;}
}
