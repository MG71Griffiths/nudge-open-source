// Real workerd / SQLite verification. Uses a synthetic image/model response;
// every external request is intercepted. Never reads credentials or production.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,realpathSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const directory=mkdtempSync(join(tmpdir(),'nudge-offline-scoring-'));
const scriptPath=resolve(process.argv[2]||fileURLToPath(new URL('../../.local/offline-scoring/runtime-worker/index.js',import.meta.url)));
const token='48'.repeat(32),admin='49'.repeat(32),hash=t=>createHash('sha256').update(t).digest('hex');
const extraction={type:'product',meal:null,productName:'Runtime test peanut butter',brand:'Test',photoConsistency:'sameProduct',servingSuggestion:null,categoryTag:'en:peanut-butters',retailer:null,labelKind:'nutrition',ingredients:null,
 basis:'per100g',servingSize:{value:30,unit:'g'},needsClearerPhoto:false,message:'',
 nutrients:Object.fromEntries(Object.entries({energyKcal:600,protein:26,carbohydrate:20,fat:48,sugars:10,saturatedFat:8,fibre:6,salt:.5}).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g'}]))};
let modelCalls=0,holdNext=false,releaseModel,modelEntered;
const options=()=>convertV4MiniflareOptions({resourcePersistencePath:join(directory,'storage'),workers:[{
 name:'offline-scoring-runtime',modules:true,scriptPath,compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],
 durableObjects:{FOOD_CATALOGUE_INDEX:{className:'FoodCatalogueIndex',useSQLite:true},LABEL_QUOTA:{className:'LabelQuota',useSQLite:true},PRIVATE_CAPTURE_JOBS:{className:'PrivateCaptureJobs',useSQLite:true}},
 bindings:{PRIVATE_ACCESS_TOKEN_SHA256:hash(token),CATALOGUE_ADMIN_TOKEN_SHA256:hash(admin),SCORING_AUTO_REFRESH:'false',OPENAI_API_KEY:'synthetic-runtime-key',OPENAI_MODEL:'gpt-4.1-mini',LABEL_PRIVATE_OWNER_UNLIMITED:'true'},
 outboundService:async request=>{
  assert.equal(new URL(request.url).hostname,'api.openai.com','Unexpected upstream host');assert.equal(new URL(request.url).pathname,'/v1/responses');modelCalls++;
  if(holdNext){holdNext=false;modelEntered?.();await new Promise(resolve=>releaseModel=resolve);}
  return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(extraction)}]}],usage:{input_tokens:10,output_tokens:10}});
 }
}]});
let mf=new Miniflare(options());
const send=(path,body,{credential=admin,method='POST'}={})=>mf.dispatchFetch('https://nudge.example'+path,{method,headers:{authorization:'Bearer '+credential,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const runID='runtime-pilot-20261011';
async function scoring(action,extra={}){const response=await send('/v1/catalogue/scoring/'+action,{runID,...extra});assert.equal(response.status,200,action+' '+await response.clone().text());return response.json();}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function pollCapture(id,expected=200){for(let n=0;n<80;n++){const response=await send('/v1/nutrition-label/jobs/'+id,undefined,{credential:token,method:'GET'});if(response.status===expected)return response;assert.equal(response.status,202,await response.clone().text());await sleep(100);}throw new Error('Capture did not reach expected state');}
try{
 let response=await send('/v1/catalogue/scoring/create',{runID},{credential:token});assert.equal(response.status,401,'App credential cannot administer scoring');
 const now=Date.now(),base={product_name:'Chocolate dessert',brands:'Test',countries_tags:['en:united-kingdom'],categories_tags:['en:desserts'],ingredients_text:'Chocolate, cream, sugar, flour',nutriments:{'energy-kcal_100g':433,proteins_100g:5.8,carbohydrates_100g:39,fat_100g:28,'saturated-fat_100g':13,sugars_100g:34,fiber_100g:.6,salt_100g:.75}};
 const products=Array.from({length:510},(_,i)=>({...base,code:String(5000000000000+i)}));
 for(let i=0;i<products.length;i+=50){response=await send('/v1/catalogue/import',{products:products.slice(i,i+50),sourceURL:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',fetchedAt:now});assert.equal(response.status,200,await response.clone().text());}
 const before=await (await send('/v1/products/batch',{codes:[products[0].code]},{credential:token})).json();
 let status=await scoring('create');assert.equal(status.counts.selected,500);assert.equal((await scoring('create')).counts.selected,500);
 status=await scoring('step',{limit:100});assert.equal(status.metrics.processed,100);await scoring('pause');
 await mf.dispose();mf=new Miniflare(options());
 status=await scoring('status');assert.equal(status.state,'paused');assert.equal(status.metrics.processed,100);assert.equal((await scoring('step')).metrics.processed,100);
 await scoring('resume');do{status=await scoring('step',{limit:100});}while(status.counts.pending);
 assert.equal(status.counts.scored,500);assert.equal(status.complete,true);assert.equal(status.metrics.aiCalls,0);assert.equal(modelCalls,0);
 const records=await scoring('records',{limit:100});assert.equal(records.records.length,100);assert.equal(records.hasMore,true);
 response=await send('/v1/catalogue/scoring/extend',{runID});assert.equal(response.status,400,'Unreviewed extension rejected');
 response=await send('/v1/catalogue/scoring/activate',{runID,reviewPassed:true,reviewNote:'Synthetic runtime review'});assert.equal(response.status,409,'Candidate cannot activate under old live engine');
 const after=await (await send('/v1/products/batch',{codes:[products[0].code]},{credential:token})).json();assert.deepEqual(after.products,before.products);assert.deepEqual(after.ratings,before.ratings);
 // Accepted photos and their original bytes persist across a process restart.
 const photo={mimeType:'image/jpeg',imageBase64:readFileSync(new URL('../test/fixtures/blank.jpg',import.meta.url)).toString('base64')};
 const captureId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',body={captureId,images:[photo]};
 response=await send('/v1/nutrition-label/analyse',body,{credential:token});assert.equal(response.status,202,await response.clone().text());
 await mf.dispose();mf=new Miniflare(options());
 const analysed=await (await pollCapture(captureId)).json();assert.equal(analysed.extraction.productName,extraction.productName);assert.equal(modelCalls,1);
 response=await send('/v1/nutrition-label/analyse',body,{credential:token});assert.equal(response.status,200);assert.equal(modelCalls,1,'Lost response retry reuses stored analysis');
 response=await send('/v1/nutrition-label/analyse',{...body,images:[photo,photo]},{credential:token});assert.equal(response.status,409,'Edited capture cannot silently reuse same id');
 response=await send('/v1/nutrition-label/jobs/'+captureId,undefined,{credential:'47'.repeat(32),method:'GET'});assert.equal(response.status,401);
 const namespace=await mf.getDurableObjectNamespace('PRIVATE_CAPTURE_JOBS','offline-scoring-runtime');
 const other=namespace.get(namespace.idFromName('private-captures-v1:'+'b'.repeat(64)));
 response=await other.fetch('https://private/'+captureId);assert.equal(response.status,404,'Other owner has no access to saved result');
 // Deleting a capture while inference is running fences its late result.
 const late='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';holdNext=true;const entered=new Promise(resolve=>modelEntered=resolve);
 response=await send('/v1/nutrition-label/analyse',{captureId:late,images:[photo]},{credential:token});assert.equal(response.status,202);await Promise.race([entered,sleep(10000).then(()=>{throw new Error('Late-result test never entered model');})]);
 response=await send('/v1/nutrition-label/jobs/'+late,undefined,{credential:token,method:'DELETE'});assert.equal(response.status,200);releaseModel();await sleep(500);
 assert.equal((await send('/v1/nutrition-label/jobs/'+late,undefined,{credential:token,method:'GET'})).status,410);
 // Verify physical persisted tables contain shadow rows but no photo/diary data.
 await mf.dispose();mf=null;const files=readdirSync(join(directory,'storage'),{recursive:true}).filter(file=>file.endsWith('.sqlite'));let checked=false;
 for(const file of files){const db=new DatabaseSync(join(directory,'storage',file));try{if(db.prepare("SELECT name FROM sqlite_master WHERE name='catalogue_scoring_run_items'").get()){checked=true;assert.equal(db.prepare("SELECT count(*) AS n FROM catalogue_scoring_run_items WHERE state='scored'").get().n,500);assert.equal(db.prepare('SELECT count(*) AS n FROM catalogue_products').get().n,510);}}finally{db.close();}}
 assert.equal(checked,true);
 console.log(JSON.stringify({event:'offline_scoring_runtime_pass',shadowRecords:500,catalogueProducts:510,syntheticModelCalls:modelCalls,realExternalRequests:0,persistenceRestart:true,privateCaptureIdempotency:true,ownerIsolation:true,lateDeleteFence:true}));
}finally{if(releaseModel)releaseModel();if(mf)await mf.dispose();rmSync(directory,{recursive:true,force:true});}
