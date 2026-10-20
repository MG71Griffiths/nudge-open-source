// Real Workers/SQLite ambassador and contribution integration. Synthetic only.
// All provider calls are intercepted locally; no live users, data or network.
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
const directory=mkdtempSync(join(tmpdir(),'nudge-ambassador-'));
const privateToken='37'.repeat(32),admin='38'.repeat(32),hash=s=>createHash('sha256').update(s).digest('hex');
const project='https://abcdefghijklmnopqrst.supabase.co',userID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const token=`${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({iss:project+'/auth/v1',sub:userID,session_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600,is_anonymous:false})).toString('base64url')}.offline_signature`;
let deleted=false;
const barcode='1234567890123',foreign='5060003830306',id='b0000000-0000-4000-8000-000000000001';
const photo=readFileSync(new URL('../test/fixtures/blank.jpg',import.meta.url)).toString('base64');
let calls=0,sourceCalls=0,analysisBarcode=barcode,outboundError;
const n=(value,unit='g')=>({value,unit});
function extraction(){return {type:'product',meal:null,productName:'Synthetic rice',brand:'Test brand',photoConsistency:'sameProduct',servingSuggestion:null,categoryTag:'en:rices',retailer:null,labelKind:'both',ingredients:{text:'Rice, water',plants:[],needsReview:false},basis:'per100g',energyKj:n(502,'kJ'),nutritionPreparation:'as_sold',servingSize:null,needsClearerPhoto:false,message:'',nutrients:{energyKcal:n(120,'kcal'),protein:n(4),carbohydrate:n(20),sugars:n(2),fat:n(3),saturatedFat:n(.5),fibre:n(3),salt:n(.2)},metadata:{...emptyMetadata(),evidence:[{id:'front',field:'identity',photoIndex:1,region:'front',text:'Test brand Synthetic rice Barcode: '+analysisBarcode},{id:'ingredients',field:'ingredients',photoIndex:2,region:'ingredients',text:'Ingredients: Rice, water'},{id:'nutrition',field:'nutrition',photoIndex:3,region:'panel',text:'Per 100 g: Energy 120 kcal / 502 kJ; fat 3 g; saturates 0.5 g; carbohydrate 20 g; sugars 2 g; fibre 3 g; protein 4 g; salt 0.2 g.'}]}};}
const options=()=>convertV4MiniflareOptions({resourcePersistencePath:directory,workers:[{
 name:'ambassador-runtime',modules:true,scriptPath:fileURLToPath(new URL('../.wrangler/dry-run/index.js',import.meta.url)),compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],
 durableObjects:{FOOD_CATALOGUE_INDEX:{className:'FoodCatalogueIndex',useSQLite:true},LABEL_QUOTA:{className:'LabelQuota',useSQLite:true}},
 bindings:{PRIVATE_ACCESS_TOKEN_SHA256:hash(privateToken),SUPABASE_URL:project,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+'p'.repeat(32),SUPABASE_SECRET_KEY:'sb_secret_'+'s'.repeat(32),CATALOGUE_ADMIN_TOKEN_SHA256:hash(admin),OPENAI_API_KEY:'synthetic-only',OPENAI_MODEL:'gpt-4.1-mini'},
 outboundService:async request=>{try{
  const url=new URL(request.url);
  if(url.origin===project){
   if(url.pathname==='/auth/v1/user')return deleted?new Response(null,{status:401}):Response.json({id:userID,aud:'authenticated',role:'authenticated',is_anonymous:false,email_confirmed_at:'2026-01-01T00:00:00Z'});
   assert.equal(url.pathname,'/auth/v1/admin/users/'+userID);assert.equal(request.method,'DELETE');deleted=true;return Response.json({});
  }
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
const joinBody={adjective:'Bright',noun:'Otter',leaderboardVisible:false,termsVersion:'ambassador-v1',acceptedTerms:true,adultConfirmed:true};
const reviewBody=stamp=>({decision:'publish',expectedUpdatedAt:stamp,confirmBarcode:true,confirmLabelFacts:true,confirmCategory:true});
try{
 let r=await request('/v1/ambassadors/me',{as:privateToken});assert.equal(r.status,403);
 r=await request('/v1/ambassadors/me',{as:null});assert.equal(r.status,401);
 r=await request('/v1/ambassadors/me');assert.equal(r.status,200);assert.equal((await r.json()).profile,null);
 r=await request('/v1/ambassadors/me',{method:'POST',body:joinBody});assert.equal(r.status,200);let profile=(await r.json()).profile;assert.equal(profile.leaderboardVisible,false);assert.match(profile.profileID,/^[a-f0-9-]{36}$/);
 r=await request('/v1/product-contributions',{method:'POST',body:submission()});assert.equal(r.status,200);const pending=await waitStatus(id);assert.equal(pending.status,'pending_review');
 r=await request('/v1/admin/product-contributions/'+id+'/review',{method:'POST',as:admin,body:reviewBody(pending.updatedAt)});assert.equal(r.status,200);
 r=await request('/v1/ambassadors/me');profile=(await r.json()).profile;assert.equal(profile.allTimePoints,1);assert.equal(profile.weekPoints,1);assert.equal(profile.badge,'newcomer');
 r=await request('/v1/ambassadors/leaderboard?period=week');assert.deepEqual((await r.json()).entries,[]);
 r=await request('/v1/ambassadors/me',{method:'POST',body:{...joinBody,leaderboardVisible:true}});assert.equal((await r.json()).profile.handle,profile.handle);
 r=await request('/v1/ambassadors/leaderboard?period=all');const board=await r.json();assert.deepEqual(board.entries,[{rank:1,profileID:profile.profileID,handle:profile.handle,points:1,badge:'newcomer'}]);assert.equal(board.myRank,1);assert.equal(r.headers.get('cache-control'),'no-store');
 await mf.dispose();mf=new Miniflare(options());r=await request('/v1/ambassadors/me');assert.equal((await r.json()).profile.allTimePoints,1);
 const repeat='b0000000-0000-4000-8000-000000000002';r=await request('/v1/product-contributions',{method:'POST',body:submission(repeat)});assert.equal(r.status,200);const duplicate=await waitStatus(repeat);
 r=await request('/v1/admin/product-contributions/'+repeat+'/review',{method:'POST',as:admin,body:reviewBody(duplicate.updatedAt)});assert.equal(r.status,200);r=await request('/v1/ambassadors/me');assert.equal((await r.json()).profile.allTimePoints,1);
 r=await request('/v1/admin/ambassadors/moderate',{as:admin,method:'POST',body:{profileID:profile.profileID,suspended:true}});assert.equal(r.status,200);
 r=await request('/v1/ambassadors/me');assert.equal((await r.json()).profile.participationStatus,'paused');
 r=await request('/v1/ambassadors/leaderboard');assert.deepEqual((await r.json()).entries,[]);
 r=await request('/v1/ambassadors/me',{method:'DELETE'});assert.equal(r.status,200);r=await request('/v1/ambassadors/me');assert.equal((await r.json()).profile,null);
 r=await request('/v1/ambassadors/me',{method:'POST',body:joinBody});const rejoined=(await r.json()).profile;assert.equal(rejoined.allTimePoints,0);assert.equal(rejoined.participationStatus,'paused');assert.notEqual(rejoined.profileID,profile.profileID);
 r=await request('/v1/account',{method:'DELETE'});assert.equal(r.status,200);assert.equal(deleted,true);r=await request('/v1/ambassadors/me');assert.equal(r.status,401);
 r=await request('/v1/products/reviewed/'+barcode,{as:null});assert.equal(r.status,200,'Public independently reviewed facts survive account erasure');
 assert.equal(calls,2);assert.equal(sourceCalls,1);if(outboundError)throw outboundError;
 console.log('PASS: real Workers SQLite managed-account auth, consent and private defaults, atomic reviewed-publication points, duplicate suppression, opt-in ranking, durable restart, admin suspension, profile delete/rejoin, account erasure and public-fact preservation. Two synthetic model calls, no external network.');
}finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
