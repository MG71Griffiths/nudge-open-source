#!/usr/bin/env node
import {requireAdminOrigin} from './require-admin-origin.mjs';
// Administrative pilot tooling. Checkpoints/public identities live separately
// from the image downloader. Credentials are read once and never logged.
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {scorePackagedProduct} from '../src/product-score.js';
import {catalogueRecordFromPayload} from '../src/food-catalogue.js';
import {ENRICHMENT_VERSION,evaluateCatalogueEnrichment} from '../src/catalogue-enrichment-evidence.js';
import {ScoreCore} from '../src/nutrition-core.js';


export function popularity(raw){const n=Number(raw.unique_scans_n);return Number.isSafeInteger(n)&&n>0?n:0;}
export function rankCandidates(records){return records.filter(raw=>popularity(raw)>0&&raw.countries_tags?.includes('en:united-kingdom')&&typeof raw.code==='string')
  .sort((a,b)=>popularity(b)-popularity(a)||a.code.localeCompare(b.code));}
async function save(path,value){await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(value,null,2));await rename(path+'.tmp',path);}
export async function main(args=process.argv.slice(2)){
  const origin = requireAdminOrigin();
  const options={};for(let i=0;i<args.length;i+=2){if(!['--action','--input','--manifest','--token-file'].includes(args[i])||!args[i+1])throw new Error('Use --action prepare|enqueue|status|start|pause --input <OFF jsonl.gz> --manifest <path> --token-file <path>.');options[args[i]]=args[i+1];}
  const action=options['--action'],path=resolve(options['--manifest']||'.local/catalogue-enrichment/pilot.json');
  if(!path.includes('/catalogue-enrichment/')||path===resolve(options['--token-file']||'/unused'))throw new Error('Use a separate catalogue-enrichment output directory.');
  if(action==='prepare'){
    if(!options['--input'])throw new Error('An existing public OFF extract is required.');
    const stream=createReadStream(options['--input']),input=options['--input'].endsWith('.gz')?stream.pipe(createGunzip()):stream;
    const candidates=[];let records=0;
    for await(const line of createInterface({input,crlfDelay:Infinity})){records++;let raw;try{raw=JSON.parse(line);}catch{continue;}
      if(popularity(raw)>0&&raw.countries_tags?.includes('en:united-kingdom'))candidates.push(raw);}
    const picked=[],seen=new Set();let invalid=0,localRecoverable=0;
    for(const raw of rankCandidates(candidates)){
      if(seen.has(raw.code))continue;seen.add(raw.code);
      try{const p=catalogueRecordFromPayload({product:raw},raw.code,Date.now()).product,score=scorePackagedProduct(p);if(score.available)continue;
        const evaluation=evaluateCatalogueEnrichment(raw),recoverable=evaluation.score.available===true;if(recoverable)localRecoverable++;
        picked.push({barcode:raw.code,name:p.name,uniqueScans:popularity(raw),missing:score.missingInputs,localRecoverable:recoverable,
          ...(recoverable?{localValue:evaluation.score.value,estimated:evaluation.score.estimated===true}:{})});
      }catch{invalid++;}if(picked.length===1000)break;
    }
    const manifest={version:ENRICHMENT_VERSION,classifierVersion:ScoreCore.CLASSIFIER_VERSION,preparedAt:new Date().toISOString(),selection:'Positive OFF unique_scans_n, descending; UK unrated products. Not Nudge user telemetry.',records,invalid,selected:picked.length,localRecoverable,products:picked};
    await save(path,manifest);console.log(JSON.stringify({...manifest,products:undefined,manifest:path}));return;
  }
  if(!['enqueue','status','start','pause'].includes(action))throw new Error('Unknown action.');
  const token=(await readFile(options['--token-file'],'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid catalogue credential file.');
  async function request(endpoint,body){
    const response=await fetch(origin+'/v1/catalogue/enrichment/'+endpoint,{method:endpoint==='status'?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(60000),
      headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(endpoint==='status'?{}:{body:JSON.stringify(body||{})})});
    if(!response.ok)throw new Error('Enrichment administration returned HTTP '+response.status);return response.json();
  }
  if(action==='enqueue'){
    const manifest=JSON.parse(await readFile(path,'utf8'));if(manifest.version!==ENRICHMENT_VERSION||!Array.isArray(manifest.products)||manifest.products.length>1000)throw new Error('Invalid or outdated pilot manifest.');
    let queued=0;for(let offset=0;offset<manifest.products.length;offset+=50){
      const receipt=await request('enqueue',{barcodes:manifest.products.slice(offset,offset+50).map(p=>p.barcode),reason:'pilot'});
      if(receipt.version!==ENRICHMENT_VERSION)throw new Error('Deployed enrichment version differs; rerun after deployment propagates.');
      queued+=receipt.queued||0;await save(path.replace(/\.json$/, '')+'-enqueue.json',{version:ENRICHMENT_VERSION,through:offset+50,queued,receipt,at:new Date().toISOString()});
      console.log(JSON.stringify({through:Math.min(offset+50,manifest.products.length),queued}));await new Promise(r=>setTimeout(r,400));
    }
  }
  const result=await request(action==='enqueue'?'status':action);await save(path.replace(/\.json$/,'')+'-'+(action==='enqueue'?'status':action)+'.json',result);console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
