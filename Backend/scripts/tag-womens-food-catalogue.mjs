#!/usr/bin/env node
import {requireAdminOrigin} from './require-admin-origin.mjs';
// Resumable public catalogue projection. Makes no Open Food Facts/AI requests.
// The image downloader has its own checkpoint and is never touched here.
import {readFile,writeFile,mkdir,rename,open,unlink} from 'node:fs/promises';
import {dirname,basename,resolve} from 'node:path';
import {WOMENS_FOOD_TAG_VERSION} from '../src/womens-food-tags.js';

const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){
  if(!['--base-url','--token-file','--state','--limit','--delay-ms'].includes(args[i])||!args[i+1])throw new Error('Use --base-url --token-file --state [--limit 50] [--delay-ms 250].');
  options[args[i]]=args[i+1];
}
const selectedOrigin=requireAdminOrigin();
const url=new URL(options['--base-url']||selectedOrigin);
if(url.origin!==selectedOrigin||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('The explicitly configured administrative origin is required.');
const token=(await readFile(options['--token-file'],'utf8')).trim();
if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid catalogue credential file.');
const path=resolve(options['--state']||'.local/womens-food-tags/checkpoint.json'),limit=Number(options['--limit']||50),delay=Number(options['--delay-ms']||250);
if(basename(dirname(path))!=='womens-food-tags'||path===resolve(options['--token-file']))throw new Error('Keep the checkpoint in its own womens-food-tags directory.');
if(!Number.isInteger(limit)||limit<1||limit>250||!Number.isInteger(delay)||delay<100||delay>10000)throw new Error('Use 1–250 records per batch and at least 100 ms between requests.');
await mkdir(dirname(path),{recursive:true});
const lock=await open(path+'.lock','wx');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(body){
  for(let attempt=0;attempt<5;attempt++){
    try{
      const response=await fetch(new URL('/v1/catalogue/support-tags',url),{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(60000)});
      if(!response.ok){if(![429,500,502,503,504].includes(response.status))throw Object.assign(new Error('Catalogue administration rejected the request: HTTP '+response.status),{stop:true});throw new Error('Catalogue temporarily busy');}
      const value=await response.json();
      if(value.version!==WOMENS_FOOD_TAG_VERSION)throw Object.assign(new Error('Deployed tag version differs from this tool; checkpoint preserved.'),{stop:true});
      return value;
    }catch(error){if(error.stop||attempt===4)throw error;await sleep(1000*2**attempt);}
  }
}
try{
  let saved;try{saved=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let after=saved?.version===WOMENS_FOOD_TAG_VERSION&&saved?.origin===url.origin?saved.after||'':'';
  let updated=0;
  const initial=await request({statusOnly:true});console.log(JSON.stringify({event:'support_tags_started',...initial}));
  // A second pass catches a concurrent product change behind the cursor.
  for(let pass=0;pass<3;pass++){
    for(;;){
      const began=Date.now(),result=await request({after,limit});
      if(!Number.isInteger(result.updated)||typeof result.nextAfter!=='string'||typeof result.hasMore!=='boolean')throw new Error('Invalid tag batch response.');
      if(result.hasMore&&(!/^[0-9]{4,18}$/.test(result.nextAfter)||result.nextAfter<=after))throw new Error('Tag cursor did not advance; checkpoint preserved.');
      after=result.nextAfter;updated+=result.updated;
      await writeFile(path+'.tmp',JSON.stringify({version:WOMENS_FOOD_TAG_VERSION,origin:url.origin,after,updatedAt:new Date().toISOString()}));await rename(path+'.tmp',path);
      if(updated%1000<limit||!result.hasMore)console.log(JSON.stringify({event:'support_tags_progress',updated,after,elapsedMs:Date.now()-began}));
      // Slow down further if catalogue latency increases, leaving room for
      // product search, barcode scans and the independently running images.
      await sleep(Math.max(delay,Math.min(3000,Date.now()-began)));
      if(!result.hasMore)break;
    }
    const status=await request({statusOnly:true});console.log(JSON.stringify({event:'support_tags_status',...status}));
    if(status.complete){await writeFile(path,JSON.stringify({version:WOMENS_FOOD_TAG_VERSION,origin:url.origin,after:'',completedAt:new Date().toISOString(),status}));break;}
    after='';
    if(pass===2)throw new Error('Concurrent changes remain; resume this tool to finish.');
  }
}finally{await lock.close();await unlink(path+'.lock');}
