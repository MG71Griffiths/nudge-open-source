import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {resolve,dirname,basename} from 'node:path';
import {ScoreCore} from '../src/nutrition-core.js';
const source=readFileSync(new URL('../scripts/refresh-catalogue-scores.mjs',import.meta.url),'utf8').replace(/^#!.*\n/,'').replace(/^import .*;\n/gm,'');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
for(const signal of ['SIGINT','SIGTERM'])it(`finishes the in-flight receipt and releases its own refresh lock after ${signal}`,async()=>{
 const process=new EventEmitter();process.argv=['node','refresh-catalogue-scores.mjs','--token-file','/tmp/test-catalogue-token'];
 const writes=new Map(),events=[];let requests=0,closed=false,unlinked=null,release,inflight;
 const began=new Promise(resolve=>inflight=resolve),pending=new Promise(resolve=>release=resolve);
 const receipt=fields=>({method:ScoreCore.SCORE_METHOD,version:ScoreCore.SCORE_VERSION,classifierVersion:ScoreCore.CLASSIFIER_VERSION,total:600,remaining:600,updated:0,complete:false,...fields});
 const mocks={
  readFile:async()=> 'a'.repeat(64),writeFile:async(path,value)=>writes.set(path,value),mkdir:async()=>{},
  open:async()=>({close:async()=>{closed=true;}}),rename:async(from,to)=>{writes.set(to,writes.get(from));writes.delete(from);},unlink:async path=>{unlinked=path;},
  resolve,dirname,basename,ScoreCore,process,requireAdminOrigin:()=> 'https://admin.example',
  console:{log:line=>events.push(JSON.parse(line))},
  fetch:async()=>{requests++;if(requests===1)return Response.json(receipt({}));if(requests===2){inflight();await pending;return Response.json(receipt({updated:500,remaining:100}));}throw new Error('A stopped job must not start another request');}
 };
 const run=new AsyncFunction(...Object.keys(mocks),source)(...Object.values(mocks));
 await began;process.emit(signal);release();await run;
 assert.equal(requests,2);assert.equal(closed,true);assert.ok(unlinked.endsWith('/score-refresh/checkpoint.json.lock'));
 assert.equal(process.exitCode,signal==='SIGINT'?130:143);
 const saved=JSON.parse(writes.get(resolve('.local/score-refresh/checkpoint.json')));assert.equal(saved.updated,500);assert.equal(saved.remaining,100);
 assert.deepEqual(events.at(-1),{event:'score_refresh_stopped',signal,batches:1,updated:500,remaining:100,complete:false});
 assert.equal(process.listenerCount('SIGINT'),0);assert.equal(process.listenerCount('SIGTERM'),0);
});
