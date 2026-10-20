import test from 'node:test';
import assert from 'node:assert/strict';
import {CatalogueImportPipeline} from '../scripts/catalogue-import-pipeline.mjs';
import {uploadCatalogueBatch} from '../scripts/catalogue-upload.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const batch=(name,codes=[name])=>({name,codes,json:JSON.stringify({products:codes}),count:codes.length,lastLine:Number(name)*200});
function fixture(concurrency=2){
  const gates=new Map(),started=[],committed=[],acknowledged=[],failures=[];
  const pipeline=new CatalogueImportPipeline({concurrency,
    upload:async item=>{started.push(item.name);const gate=deferred();gates.set(item.name,gate);return gate.promise;},
    onAcknowledged:item=>acknowledged.push(item.name),
    onCommit:async item=>{await tick();committed.push(item.lastLine);},
    onFailure:async(item,error)=>failures.push({name:item.name,json:item.json,code:error.code})});
  return {pipeline,gates,started,committed,acknowledged,failures};
}

test('out-of-order success keeps a bounded uncommitted window and contiguous checkpoints',async()=>{
  const f=fixture();await f.pipeline.submit(batch('1'));await f.pipeline.submit(batch('2'));
  f.gates.get('2').resolve({accepted:1});await tick();
  let submitted=false;const third=f.pipeline.submit(batch('3')).then(()=>{submitted=true;});
  await tick();assert.equal(submitted,false);assert.deepEqual(f.started,['1','2']);assert.deepEqual(f.committed,[]);
  f.gates.get('1').resolve({accepted:1});await third;
  assert.deepEqual(f.committed,[200,400]);assert.deepEqual(f.started,['1','2','3']);
  f.gates.get('3').resolve({accepted:1});await f.pipeline.finish();assert.deepEqual(f.committed,[200,400,600]);
});

test('overlapping barcodes are serialized while disjoint batches can overlap',async()=>{
  const f=fixture(3);await f.pipeline.submit(batch('1',['00000042']));
  await f.pipeline.submit(batch('2',['00000042']));await f.pipeline.submit(batch('3',['00000099']));
  assert.deepEqual(f.started,['1','3']);
  f.gates.get('1').resolve({accepted:1});await tick();assert.deepEqual(f.started,['1','3','2']);
  f.gates.get('3').resolve({accepted:1});f.gates.get('2').resolve({accepted:1});
  await f.pipeline.finish();assert.deepEqual(f.committed,[200,400,600]);
});

test('failure stops production, settles earlier work, and saves the failed immutable body',async()=>{
  const f=fixture(),second=batch('2');await f.pipeline.submit(batch('1'));await f.pipeline.submit(second);
  second.json='changed';second.codes.push('changed');
  const error=Object.assign(new Error('failure'),{code:'catalogue_unavailable'});
  f.gates.get('2').reject(error);await tick();
  await assert.rejects(f.pipeline.submit(batch('3')),error);assert.deepEqual(f.started,['1','2']);
  const finish=assert.rejects(f.pipeline.finish(),error);f.gates.get('1').resolve({accepted:1});await finish;
  assert.deepEqual(f.committed,[200]);assert.equal(f.failures.length,1);
  assert.equal(f.failures[0].name,'2');assert.notEqual(f.failures[0].json,'changed');
  await assert.rejects(f.pipeline.finish(),error);assert.equal(f.failures.length,1);
});

test('earliest failed sequence wins even when its network failure arrives last',async()=>{
  const f=fixture();await f.pipeline.submit(batch('1'));await f.pipeline.submit(batch('2'));
  const first=Object.assign(new Error('first'),{code:'first_failure'}),second=Object.assign(new Error('second'),{code:'second_failure'});
  f.gates.get('2').reject(second);await tick();const finished=assert.rejects(f.pipeline.finish(),first);
  f.gates.get('1').reject(first);await finished;
  assert.deepEqual(f.committed,[]);assert.equal(f.failures[0].name,'1');assert.equal(f.failures[0].code,'first_failure');
});

test('success beyond a failed gap is acknowledged but never advances resume watermark',async()=>{
  const f=fixture();await f.pipeline.submit(batch('1'));await f.pipeline.submit(batch('2'));
  const error=new Error('first failed');f.gates.get('1').reject(error);await tick();
  const finished=assert.rejects(f.pipeline.finish(),error);f.gates.get('2').resolve({accepted:1});await finished;
  assert.deepEqual(f.acknowledged,['2']);assert.deepEqual(f.committed,[]);
});

test('a failed batch prevents a waiting duplicate from starting',async()=>{
  const f=fixture();await f.pipeline.submit(batch('1',['same']));await f.pipeline.submit(batch('2',['same']));
  f.gates.get('1').reject(new Error('capacity'));await tick();await assert.rejects(f.pipeline.finish());
  assert.deepEqual(f.started,['1']);assert.deepEqual(f.committed,[]);
});

test('retrying the same immutable body commits exactly once after acknowledgement',async()=>{
  const sent=[],committed=[];let calls=0;
  const pipeline=new CatalogueImportPipeline({concurrency:2,
    upload:item=>uploadCatalogueBatch(new URL('https://example.invalid/import'),'a'.repeat(64),item.json,{
      fetchImpl:async(_url,options)=>{sent.push(options.body);return ++calls===1
        ?Response.json({code:'catalogue_unavailable'},{status:503})
        :Response.json({accepted:1});},sleep:async()=>{}}),
    onCommit:async item=>committed.push(item.name)});
  await pipeline.submit(batch('1'));await pipeline.finish();
  assert.equal(sent.length,2);assert.equal(sent[0],sent[1]);assert.deepEqual(committed,['1']);
});

test('invalid concurrency is rejected and serial mode preserves the same checkpoint contract',async()=>{
  for(const concurrency of [0,4,2.5,NaN])assert.throws(()=>fixture(concurrency));
  const f=fixture(1);await f.pipeline.submit(batch('1'));const next=f.pipeline.submit(batch('2'));
  await tick();assert.deepEqual(f.started,['1']);f.gates.get('1').resolve({accepted:1});await next;
  f.gates.get('2').resolve({accepted:1});await f.pipeline.finish();assert.deepEqual(f.committed,[200,400]);
});

async function runCLI(fail=false){
  const directory=await mkdtemp(join(tmpdir(),'nudge-import-pipeline-'));
  try{
    const input=join(directory,'public.jsonl'),hook=join(directory,'fetch.mjs'),output=join(directory,'out');
    const records=Array.from({length:650},(_,i)=>({code:String(10000000+i),product_name:'Synthetic plain banana',
      countries_tags:['en:united-kingdom'],categories_tags:['en:bananas']}));
    await writeFile(input,records.map(record=>JSON.stringify(record)).join('\n'));
    await writeFile(hook,`let secondStarted;const second=new Promise(resolve=>{secondStarted=resolve;});globalThis.fetch=async(_url,options)=>{
      const body=JSON.parse(options.body),first=body.products[0].code==='10000000';
      if(first)await Promise.race([second,new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('Second concurrent upload did not start')),5000).unref())]);else secondStarted();
      await new Promise(resolve=>setTimeout(resolve,first?15:1));
      return ${fail?'first':'false'}?Response.json({code:'catalogue_storage_limit'},{status:503}):Response.json({accepted:body.products.length});
    };`);
    const child=spawn(process.execPath,['--import',hook,fileURLToPath(new URL('../scripts/import-off-catalogue.mjs',import.meta.url)),
      '--input',input,'--output',output,'--source-url','https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',
      '--fetched-at',new Date().toISOString(),'--upload-url','https://catalogue.invalid','--concurrency','2'],{
        env:{...process.env,NUDGE_CATALOGUE_ADMIN_TOKEN:'12'.repeat(32)},stdio:['ignore','pipe','pipe']});
    let errors='';child.stderr.on('data',data=>{errors+=data;});child.stdout.resume();
    const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
    const manifest=JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));
    const failed=fail?JSON.parse(await readFile(join(output,'failed-batch.json'),'utf8')):null;
    return {exit,errors,manifest,failed};
  }finally{await rm(directory,{recursive:true,force:true});}
}

test('CLI two-upload integration writes a complete contiguous manifest',async()=>{
  const result=await runCLI();assert.equal(result.exit,0,result.errors);
  assert.equal(result.manifest.concurrency,2);assert.equal(result.manifest.complete,true);
  assert.equal(result.manifest.uploaded,650);assert.equal(result.manifest.uploadedThroughLine,650);assert.equal(result.manifest.resumeSkip,650);
});

test('CLI failure checkpoint retains earliest failed public body and no unsafe resume gap',async()=>{
  const result=await runCLI(true);assert.notEqual(result.exit,0);
  assert.equal(result.manifest.complete,false);assert.equal(result.manifest.failedBatch,'000001');
  assert.equal(result.manifest.failureCode,'catalogue_storage_limit');assert.equal(result.manifest.failureStatus,503);
  assert.equal(result.manifest.uploaded,200);assert.equal(result.manifest.uploadedThroughLine,0);assert.equal(result.manifest.resumeSkip,0);
  assert.equal(result.failed.products.length,200);assert.equal(result.failed.products[0].code,'10000000');
  assert.ok(!JSON.stringify(result.failed).includes('12'.repeat(32)));
});
