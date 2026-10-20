#!/usr/bin/env node
// Stream a full OFF JSONL export/extract into bounded, validated public batches.
// SQL output is portable SQLite/D1; deployment currently uploads JSON to the DO.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { once } from 'node:events';
import { uploadCatalogueBatch } from './catalogue-upload.mjs';
import { CatalogueImportPipeline } from './catalogue-import-pipeline.mjs';
import { buildCatalogueRow, catalogueWriteStatements, INDEX_MAX_IMPORT_PRODUCTS, INDEX_MAX_IMPORT_BYTES } from '../src/catalogue-index.js';

const opts={};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!key?.startsWith('--')||!process.argv[i+1])throw new Error('Use --input PATH --output DIR --source-url URL --fetched-at ISO [--upload-url URL] [--limit N] [--skip N] [--sql yes] [--concurrency 1|2|3]');opts[key.slice(2)]=process.argv[i+1];}
if(!opts.input||!opts.output||!opts['source-url']||!opts['fetched-at'])throw new Error('Input, output, source URL and retrieval date are required.');
const fetchedAt=Date.parse(opts['fetched-at']), sourceURL=opts['source-url'];
if(!Number.isSafeInteger(fetchedAt)||fetchedAt>Date.now()+60_000||fetchedAt<Date.now()-30*86400000)throw new Error('Provide the recent actual export retrieval time, not a future date.');
const upload=opts['upload-url']?new URL('/v1/catalogue/import',opts['upload-url']):null;
if(upload&&upload.protocol!=='https:')throw new Error('Upload requires HTTPS.');
const token=upload?process.env[opts['token-env']||'NUDGE_CATALOGUE_ADMIN_TOKEN']:null;
if(upload&&!/^[a-f0-9]{64}$/.test(token||''))throw new Error('Provide the separate admin token through the requested environment variable.');
const limit=opts.limit?Number(opts.limit):Infinity,skip=Number(opts.skip||0);
if(!(limit>0)||!Number.isSafeInteger(skip)||skip<0)throw new Error('Invalid row limit/skip.');
const concurrency=Number(opts.concurrency||1);
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw new Error('Import concurrency must be 1, 2 or 3.');
await mkdir(opts.output,{recursive:true});
const progress={sourceURL,fetchedAt,startedAt:new Date().toISOString(),concurrency,read:0,accepted:0,skipped:0,batches:0,uploaded:0,preparedThroughLine:skip,uploadedThroughLine:skip,resumeSkip:skip,reasons:{},complete:false};
const rejects=createWriteStream(join(opts.output,'rejected.jsonl'),{flags:'a'});
const input=createReadStream(opts.input,{highWaterMark:128*1024});
const lines=createInterface({input:opts.input.endsWith('.gz')?input.pipe(createGunzip()):input,crlfDelay:Infinity});
let products=[],sql=[],batchBytes=0,batchLastLine=skip;
const literal=value=>value===null?'NULL':typeof value==='number'?String(value):"'"+String(value).replaceAll("'","''")+"'";
function sqlFor(statement){let i=0;return statement.sql.replace(/\?/g,()=>literal(statement.values[i++]));}
async function checkpoint(){
  const pending=join(opts.output,'manifest.json.part');
  await writeFile(pending,JSON.stringify(progress,null,2)+'\n');await rename(pending,join(opts.output,'manifest.json'));
}
const pipeline=upload?new CatalogueImportPipeline({concurrency,
  upload:async batch=>{
    const result=await uploadCatalogueBatch(upload,token,batch.json);
    if(result.accepted!==batch.count)throw Object.assign(new Error('Import count mismatch for batch '+batch.name),{code:'catalogue_import_count_mismatch'});
    return result;
  },
  onAcknowledged:(_batch,result)=>{progress.uploaded+=result.accepted;},
  onCommit:async batch=>{progress.uploadedThroughLine=batch.lastLine;progress.resumeSkip=batch.lastLine;await checkpoint();},
  onFailure:async(batch,error)=>{
    await writeFile(join(opts.output,'failed-batch.json'),batch.json+'\n');
    progress.failureCode=/^[a-z_]{1,64}$/.test(error.code||'')?error.code:'catalogue_upload_failed';
    progress.failureStatus=Number.isInteger(error.status)?error.status:null;
    progress.failedBatch=batch.name;progress.complete=false;await checkpoint();
  }
}):null;
async function flush(){
  if(!products.length)return;
  const batch=String(++progress.batches).padStart(6,'0'),body={products,sourceURL,fetchedAt,importID:'off-'+fetchedAt+'-'+(skip||0)+'-'+batch};
  const json=JSON.stringify(body),path=join(opts.output,batch+'.json');
  await writeFile(path,json+'\n');
  if(opts.sql==='yes')await writeFile(join(opts.output,batch+'.sql'),'BEGIN;\n'+sql.join(';\n')+';\nCOMMIT;\n');
  progress.preparedThroughLine=batchLastLine;
  if(pipeline)await pipeline.submit({name:batch,json,count:products.length,lastLine:batchLastLine,codes:products.map(product=>product.code)});
  products=[];sql=[];batchBytes=0;await checkpoint();
  process.stdout.write(JSON.stringify({read:progress.read,accepted:progress.accepted,skipped:progress.skipped,batches:progress.batches,uploaded:progress.uploaded})+'\n');
}
try {
  for await(const line of lines){
    pipeline?.throwIfFailed();
    if(!line.trim())continue;
    progress.read++;
    if(progress.read<=skip)continue;
    let code=null,validated=null;
    try {
      if(Buffer.byteLength(line)>512_000)throw new Error('Oversize source record');
      const raw=JSON.parse(line);code=raw.product?.code||raw.code||null;
      const row=await buildCatalogueRow(raw,{fetchedAt,source:sourceURL});
      // Preserve every field of the validated source product in upload chunks.
      // The server archives these chunks, then projects compact index/app facts.
      const product=raw.product||raw;
      validated={row,product,size:Buffer.byteLength(JSON.stringify(product))+1};
    } catch(error){
      // Quarantine identifiers/reasons only; malformed raw content is not copied.
      progress.skipped++;const reason=error.code||error.message||'invalid_record';progress.reasons[reason]=(progress.reasons[reason]||0)+1;
      if(!rejects.write(JSON.stringify({line:progress.read,barcode:typeof code==='string'&&/^\d{4,18}$/.test(code)?code:null,reason})+'\n'))await once(rejects,'drain');
    }
    if(validated){
      const {row,product,size}=validated;
      if(products.length&&(products.length>=INDEX_MAX_IMPORT_PRODUCTS||batchBytes+size>INDEX_MAX_IMPORT_BYTES-2048))await flush();
      products.push(product);batchLastLine=progress.read;batchBytes+=size;if(opts.sql==='yes')sql.push(...catalogueWriteStatements(row).map(sqlFor));
      progress.accepted++;
    }
    if(progress.accepted>=limit)break;
  }
  await flush();await pipeline?.finish();progress.complete=true;progress.completedAt=new Date().toISOString();await checkpoint();
} catch(error){await pipeline?.finish();throw error;}
finally {lines.close();input.destroy();rejects.end();}
