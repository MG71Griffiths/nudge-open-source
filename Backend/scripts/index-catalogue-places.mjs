#!/usr/bin/env node
import {requireAdminOrigin} from './require-admin-origin.mjs';
const adminOrigin = requireAdminOrigin();
// Rebuild only public place associations; source facts, images and scores stay intact.
import {readFile,writeFile,mkdir,open,rename,unlink} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {PLACE_VERSION} from '../src/catalogue-places.js';

const options={};
for(let i=2;i<process.argv.length;i+=2){
 const key=process.argv[i];
 if(!['--token-file','--state','--limit','--delay-ms','--status-only'].includes(key)||!process.argv[i+1])throw new Error('Use --token-file PATH [--state PATH] [--limit 500] [--delay-ms 300] [--status-only yes].');
 options[key]=process.argv[i+1];
}
if(!options['--token-file'])throw new Error('A catalogue administrator token file is required.');
const limit=Number(options['--limit']||500),delay=Number(options['--delay-ms']||300);
if(!Number.isSafeInteger(limit)||limit<1||limit>500||!Number.isSafeInteger(delay)||delay<250||delay>30000||options['--status-only']&&!['yes','no'].includes(options['--status-only']))throw new Error('Invalid bounded place-index options.');
const tokenPath=resolve(options['--token-file']),statePath=resolve(options['--state']||'.local/place-index/checkpoint.json');
if(basename(dirname(statePath))!=='place-index'||statePath===tokenPath)throw new Error('Use a separate place-index checkpoint directory.');
const token=(await readFile(tokenPath,'utf8')).trim();
if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid catalogue administrator token file.');
await mkdir(dirname(statePath),{recursive:true});
const lock=await open(statePath+'.lock','wx');
const endpoint = adminOrigin + '/v1/catalogue/place-index';
let stopped=false;
const stop=()=>{stopped=true;};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const state={version:PLACE_VERSION,startedAt:new Date().toISOString(),batches:0,updated:0,complete:false};

async function request(statusOnly=false){
 for(let attempt=0;attempt<5;attempt++){
  try{
   const response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(statusOnly?{statusOnly:true,summary:true}:{limit})});
   if(!response.ok)throw Object.assign(new Error('Place index returned HTTP '+response.status),{terminal:![429,500,502,503,504].includes(response.status)});
   const receipt=await response.json();
   if(receipt.version!==PLACE_VERSION||!Number.isSafeInteger(receipt.processed)||receipt.processed<0||(statusOnly?!Number.isSafeInteger(receipt.total)||receipt.total<receipt.processed||receipt.complete!==(receipt.total===receipt.processed):receipt.processed>limit||typeof receipt.hasMore!=='boolean'))throw Object.assign(new Error('Invalid or mismatched place-index receipt.'),{terminal:true});
   return receipt;
  }catch(error){
   if(error.terminal||attempt===4||stopped)throw error;
   await pause(1000*2**attempt);
  }
 }
}
async function save(receipt){
 state.checkedAt=new Date().toISOString();state.receipt=receipt;
 if('complete' in receipt)state.complete=receipt.complete;
 await writeFile(statePath+'.part',JSON.stringify(state,null,2)+'\n');
 await rename(statePath+'.part',statePath);
 if(Array.isArray(receipt.places)){
  const summaryPath=resolve(dirname(statePath),'summary.json');
  await writeFile(summaryPath+'.part',JSON.stringify({checkedAt:state.checkedAt,...receipt},null,2)+'\n');
  await rename(summaryPath+'.part',summaryPath);
 }
}
function printStatus(receipt){
 const {places,...status}=receipt;
 console.log(JSON.stringify({event:'place_index_status',...status,places:places?.length??0}));
}
try{
 let status=await request(true);await save(status);printStatus(status);
 if(options['--status-only']!=='yes'){
  while(!state.complete&&!stopped){
   const receipt=await request();state.batches++;state.updated+=receipt.processed;
   await save(receipt);
   if(state.batches%10===0||!receipt.hasMore)console.log(JSON.stringify({event:'place_index_progress',batches:state.batches,updated:state.updated,...receipt}));
   if(!receipt.hasMore){
    status=await request(true);await save(status);printStatus(status);
    if(!receipt.processed&&!status.complete)throw new Error('No index progress; inspect the catalogue before resuming.');
   }
   if(!state.complete&&!stopped)await pause(delay);
  }
 }
}finally{
 await lock.close();await unlink(statePath+'.lock');
 process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
 if(stopped){console.log(JSON.stringify({event:'place_index_stopped',version:state.version,batches:state.batches,updated:state.updated}));process.exitCode=130;}
}
