// Isolated actual Workers/SQLite recovery queue test. No provider/AI calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
const {build}=require('esbuild'),{Miniflare,convertV4MiniflareOptions}=require('miniflare');
const directory=mkdtempSync(join(tmpdir(),'nudge-recovery-queue-')),scriptPath=join(directory,'worker.mjs');
let mf,outbound=0;
const options=()=>convertV4MiniflareOptions({resourcePersistencePath:join(directory,'storage'),workers:[{
 name:'recovery-queue',modules:true,scriptPath,compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],
 durableObjects:{FOOD_CATALOGUE_INDEX:{className:'FoodCatalogueIndex',useSQLite:true}},
 outboundService:async()=>{outbound++;throw new Error('No external network permitted');}
}]});
const send=async(path,body={})=>{
 const ns=await mf.getDurableObjectNamespace('FOOD_CATALOGUE_INDEX','recovery-queue');
 const response=await ns.get(ns.idFromName('uk-public-products-v1')).fetch('https://index'+path,{method:'POST',body:JSON.stringify(body)});
 assert.equal(response.status,200,path);return response.json();
};
const product=(code,popularity)=>({code,unique_scans_n:popularity,product_name:'Dhal makhani',brands:'Synthetic runtime fixture',
 countries_tags:['en:united-kingdom'],categories_tags:['en:dhal-makhani'],last_modified_t:1700000000,
 ingredients_text:'Lentils (60%), tomatoes (10%), water, cream, salt',
 nutriments:{'energy-kcal_100g':110,'energy-kj_100g':460,proteins_100g:6,carbohydrates_100g:14,sugars_100g:2,fat_100g:3,'saturated-fat_100g':1,fiber_100g:4}});
try{
 await build({stdin:{contents:"export {FoodCatalogueIndex} from './catalogue-index-object.js'; export default {fetch(){return new Response('not found',{status:404});}};",resolveDir:fileURLToPath(new URL('../src/',import.meta.url)),sourcefile:'recovery-runtime-entry.js'},bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,external:['cloudflare:workers','node:*'],outfile:scriptPath,logLevel:'silent'});
 mf=new Miniflare(options());
 const now=Date.now(),products=[product('5000000000011',1),product('5000000000022',900),product('5000000000033',20)];
 await send('/import',{products,sourceURL:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',fetchedAt:now});
 const first=await send('/enrichment/candidates',{limit:2});assert.equal(first.hasMore,true);assert.equal(first.nextAfter,products[1].code);
 const second=await send('/enrichment/candidates',{limit:2,after:first.nextAfter});assert.equal(second.hasMore,false);
 const manifest=[...first.products,...second.products].map(({barcode,sourceFingerprint})=>({barcode,sourceFingerprint}));assert.equal(manifest.length,3);
 assert.equal((await send('/enrichment/enqueue',{reason:'recovery',products:manifest})).queued,3);
 await send('/enrichment/enqueue',{reason:'scan',barcodes:[products[0].code]});
 assert.equal((await send('/enrichment/enqueue',{reason:'recovery',products:manifest})).alreadyKnown,3);
 let status=await send('/enrichment/status');assert.deepEqual(status.queuedByPriority,{recovery:2,scan:1});assert.equal(status.pilot.selected,0);
 await mf.dispose();mf=new Miniflare(options());
 const jobs=(await send('/enrichment/claim',{limit:3})).jobs;
 assert.deepEqual(jobs.map(j=>j.barcode),[products[0].code,products[1].code,products[2].code]);
 assert.deepEqual(jobs.map(j=>j.reason),['scan','recovery','recovery']);assert.deepEqual(jobs.map(j=>j.demandCount),[1,0,0]);
 assert.deepEqual(jobs.map(j=>j.offUniqueScans),[1,900,20]);
 for(const job of jobs)await send('/enrichment/complete',{id:job.id,leaseToken:job.leaseToken,sourceFingerprint:job.sourceFingerprint,outcome:'deferred',errorCode:'enrichment_budget',retryAt:Date.now()+120000});
 status=await send('/enrichment/status');assert.equal(status.counts.deferred,3);assert.equal(status.attempts,0);assert.equal(outbound,0);
 console.log(JSON.stringify({event:'ordinary_recovery_queue_runtime_pass',persistentJobs:3,userDemandPreserved:true,offPopularityPreserved:true,sourceBoundManifest:true,pilotMembers:0,externalRequests:outbound}));
}finally{if(mf)await mf.dispose();rmSync(directory,{recursive:true,force:true});}
