// Real Workers/SQLite/durable-alarm integration with synthetic provider fixtures.
// Run wrangler deploy --dry-run --outdir .wrangler/dry-run first. No external calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {emptyMetadata} from '../src/photo-evidence.js';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const directory=mkdtempSync(join(tmpdir(),'nudge-contribution-'));
const token='37'.repeat(32),admin='38'.repeat(32),hash=s=>createHash('sha256').update(s).digest('hex');
const barcode='1234567890123',foreign='5060003830306',id='b0000000-0000-4000-8000-000000000001';
const photo=readFileSync(new URL('../test/fixtures/blank.jpg',import.meta.url)).toString('base64');
let calls=0,sourceCalls=0,analysisBarcode=barcode,outboundError;
const n=(value,unit='g')=>({value,unit});
function extraction(){return {type:'product',meal:null,productName:'Synthetic rice',brand:'Test brand',photoConsistency:'sameProduct',servingSuggestion:null,categoryTag:'en:rices',retailer:null,labelKind:'both',ingredients:{text:'Rice, water',plants:[],needsReview:false},basis:'per100g',energyKj:n(502,'kJ'),nutritionPreparation:'as_sold',servingSize:null,needsClearerPhoto:false,message:'',nutrients:{energyKcal:n(120,'kcal'),protein:n(4),carbohydrate:n(20),sugars:n(2),fat:n(3),saturatedFat:n(.5),fibre:n(3),salt:n(.2)},metadata:{...emptyMetadata(),evidence:[{id:'front',field:'identity',photoIndex:1,region:'front',text:'Test brand Synthetic rice Barcode: '+analysisBarcode},{id:'ingredients',field:'ingredients',photoIndex:2,region:'ingredients',text:'Ingredients: Rice, water'},{id:'nutrition',field:'nutrition',photoIndex:3,region:'panel',text:'Per 100 g: Energy 120 kcal / 502 kJ; fat 3 g; saturates 0.5 g; carbohydrate 20 g; sugars 2 g; fibre 3 g; protein 4 g; salt 0.2 g.'}]}};}
const options=()=>convertV4MiniflareOptions({resourcePersistencePath:directory,workers:[{
 name:'contribution-runtime',modules:true,scriptPath:fileURLToPath(new URL('../.wrangler/dry-run/index.js',import.meta.url)),compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],
 durableObjects:{FOOD_CATALOGUE_INDEX:{className:'FoodCatalogueIndex',useSQLite:true},LABEL_QUOTA:{className:'LabelQuota',useSQLite:true}},
 bindings:{PRIVATE_ACCESS_TOKEN_SHA256:hash(token),CATALOGUE_ADMIN_TOKEN_SHA256:hash(admin),OPENAI_API_KEY:'synthetic-only',OPENAI_MODEL:'gpt-4.1-mini'},
 outboundService:async request=>{try{
  const url=new URL(request.url);
  if(url.hostname==='world.openfoodfacts.org'){
   sourceCalls++;assert.equal(url.pathname.startsWith('/api/v3.6/product/'),true);
   if(url.pathname.includes(foreign))return Response.json({status:'success',product:{code:foreign,product_name:'Synthetic rice',countries_tags:['en:france'],last_modified_t:1700000000}});
   return Response.json({status:'failure',code:barcode,errors:[{message:{id:'product_not_found'}}]},{status:404});
  }
  assert.equal(url.href,'https://api.openai.com/v1/responses');const body=await request.json();assert.equal(body.store,false);assert.match(body.instructions,/product.only|packaged product/i);calls++;
  return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(extraction())}]}]});
 }catch(error){outboundError=error;throw error;}}
}]});
let mf=new Miniflare(options());
const request=(route,{method='GET',body,as=token}={})=>mf.dispatchFetch('https://nudge.example'+route,{method,headers:{...(as?{authorization:'Bearer '+as}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
const submission=(identity=id,code=barcode)=>({id:identity,barcode:code,marketCountry:'GB',store:'sainsburys',consent:{version:'product-contribution-v1',shareProductFacts:true,retainPhotosForReview:true},photos:['front','ingredients','nutrition'].map(role=>({role,mimeType:'image/jpeg',imageBase64:photo}))});
async function waitStatus(identity){const started=Date.now();for(;;){const r=await request('/v1/product-contributions/'+identity);assert.equal(r.status,200);const b=await r.json();if(!['queued','processing'].includes(b.contribution.status))return b.contribution;if(Date.now()-started>15000)throw Error('Durable alarm did not finish the contribution');if(outboundError)throw outboundError;await new Promise(resolve=>setTimeout(resolve,100));}}
try{
 let r=await request('/v1/product-contributions',{method:'POST',body:submission(),as:null});assert.equal(r.status,401);
 r=await request('/v1/product-contributions',{method:'POST',body:submission()});assert.equal(r.status,200);assert.equal((await r.json()).contribution.status,'queued');
 const pending=await waitStatus(id);assert.equal(pending.status,'pending_review');assert.equal(pending.sourceLookup,'not_found');assert.equal(calls,1,'Durable alarm reaches the existing analysis implementation once');
 r=await request('/v1/product-contributions',{method:'POST',body:submission()});assert.equal((await r.json()).replayed,true);assert.equal(calls,1);
 r=await request('/v1/products/batch',{method:'POST',body:{codes:[barcode]}});assert.equal((await r.json()).products.length,0);
 r=await request('/v1/admin/product-contributions/'+id,{as:token});assert.equal(r.status,401,'Account token cannot review its own contribution');
 r=await request('/v1/admin/product-contributions/'+id,{as:admin});const review=await r.json();assert.equal(review.candidate.readyForReview,true);assert.equal(review.photos.length,3);
 r=await request('/v1/admin/product-contributions/'+id+'/photos/front',{as:admin});assert.equal(r.headers.get('content-type'),'image/jpeg');assert.equal(Buffer.from(await r.arrayBuffer()).toString('base64'),photo);
 r=await request('/v1/admin/product-contributions/'+id+'/review',{method:'POST',as:admin,body:{decision:'publish',expectedUpdatedAt:pending.updatedAt,confirmBarcode:true,confirmLabelFacts:true,confirmCategory:true}});assert.equal(r.status,200);assert.equal((await r.json()).contribution.status,'published');
 r=await request('/v1/products/batch',{method:'POST',body:{codes:[barcode]}});let batch=await r.json();assert.equal(batch.products.length,1);assert.equal(batch.ratings[0].sourceKind,'nudge_community');assert.equal(batch.ratings[0].score.value,100);assert.equal(batch.products[0].countries_tags,undefined);assert.doesNotMatch(JSON.stringify(batch),/imageBase64|private-owner/);
 r=await request('/v1/admin/product-contributions/'+id+'/photos/front',{as:admin});assert.equal(r.status,404);
 r=await request('/v1/products/reviewed/'+barcode,{as:null});assert.equal(r.status,200);
 r=await request('/v1/catalogue/reviewed-export',{as:null});assert.equal((await r.json()).products.length,1);
 r=await request('/v1/product-contributions/'+id,{method:'DELETE'});assert.equal(r.status,409);
 const next='b0000000-0000-4000-8000-000000000002';analysisBarcode=foreign;
 r=await request('/v1/product-contributions',{method:'POST',body:submission(next,foreign)});assert.equal(r.status,200);const foreignPending=await waitStatus(next);assert.equal(foreignPending.status,'pending_review');assert.equal(foreignPending.sourceLookup,'found_other_market');
 r=await request('/v1/products/batch',{method:'POST',body:{codes:[foreign]}});batch=await r.json();assert.deepEqual(batch.products[0].countries_tags,['en:france']);
 r=await request('/v1/product-contributions/'+next,{method:'DELETE'});assert.equal(r.status,200);r=await request('/v1/product-contributions',{method:'POST',body:submission(next,foreign)});assert.equal(r.status,410);
 await mf.dispose();mf=new Miniflare(options());r=await request('/v1/products/batch',{method:'POST',body:{codes:[barcode]}});assert.equal((await r.json()).products[0].code,barcode);
 r=await request('/v1/product-contributions/'+next);assert.equal(r.status,404);assert.equal(calls,2);assert.equal(sourceCalls,2);
 console.log('PASS: authenticated photo consent, durable alarm analysis, missing/foreign global barcode distinction, private evidence review, deterministic publication, deleted photo lifecycle, replay prevention and persistent SQLite restart. Two synthetic provider calls; no external network.');
}finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
