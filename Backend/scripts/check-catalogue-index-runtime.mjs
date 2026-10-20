// Actual Workers SQLite/FTS5 smoke test, with no external network requests.
// Run wrangler deploy --dry-run --outdir .wrangler/dry-run first.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const directory=mkdtempSync(join(tmpdir(),'nudge-catalogue-index-'));
const token='49'.repeat(32),hash=createHash('sha256').update(token).digest('hex');
const foreignCode='5060003830306';let syntheticSourceCalls=0;
const options=()=>convertV4MiniflareOptions({resourcePersistencePath:directory,workers:[{
 name:'catalogue-index-runtime',modules:true,scriptPath:fileURLToPath(new URL('../.wrangler/dry-run/index.js',import.meta.url)),compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],
 durableObjects:{FOOD_CATALOGUE_INDEX:{className:'FoodCatalogueIndex',useSQLite:true},LABEL_QUOTA:{className:'LabelQuota',useSQLite:true}},
 bindings:{PRIVATE_ACCESS_TOKEN_SHA256:hash,CATALOGUE_ADMIN_TOKEN_SHA256:hash},outboundService:async request=>{
  const url=new URL(request.url);
  if(url.hostname==='world.openfoodfacts.org'&&url.pathname===`/api/v3.6/product/${foreignCode}.json`){
   syntheticSourceCalls++;return Response.json({status:'success',product:{code:foreignCode,product_name:'Synthetic foreign baked beans',categories_tags:['en:baked-beans'],countries_tags:['en:france'],stores:"Sainsbury's",ingredients_text:'Beans (60%), tomato (20%), water',nutriments:{'energy-kcal_100g':90,sugars_100g:4,salt_100g:.5,'saturated-fat_100g':.1,fiber_100g:5,proteins_100g:5},last_modified_t:1700000000}});
  }
  throw new Error('No external provider or AI network allowed');
 }
}]});
let mf=new Miniflare(options());
const send=(route,body)=>mf.dispatchFetch('https://nudge.example'+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
try {
 const products=[{code:'5000000000001',product_name:'Synthetic baked beans',countries_tags:['en:united-kingdom'],categories_tags:['en:baked-beans'],stores:"Sainsbury's",ingredients_text:'Beans (60%), tomato (20%), water',nutriments:{'energy-kcal_100g':90,sugars_100g:4,salt_100g:.5,'saturated-fat_100g':.1,fiber_100g:5,proteins_100g:5},last_modified_t:1700000000}];
 const imported=await send('/v1/catalogue/import',{products,sourceURL:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',fetchedAt:Date.now()});assert.equal(imported.status,200);assert.equal((await imported.json()).accepted,1);
 const recalculated=await send('/v1/catalogue/recalculate',{});assert.equal(recalculated.status,200);const recalculation=await recalculated.json();assert.equal(recalculation.updated,0);assert.equal(recalculation.remaining,0);assert.equal((await send('/v1/catalogue/recalculate',{limit:10000})).status,400);
 const importURL='https://nudge.example/v1/catalogue/import',headers={authorization:'Bearer '+token,'content-type':'application/json'};
 let invalid=await mf.dispatchFetch(importURL,{method:'POST',headers:{...headers,authorization:'Bearer '+'00'.repeat(32)},body:'{invalid'});assert.equal(invalid.status,401,'Authentication runs before JSON parsing');
 invalid=await mf.dispatchFetch(importURL,{method:'POST',headers,body:'{invalid'});assert.equal(invalid.status,400);assert.equal((await invalid.json()).code,'catalogue_request_invalid','Only the DO parses and rejects malformed JSON');
 invalid=await mf.dispatchFetch(importURL,{method:'POST',headers,body:new Uint8Array([123,34,120,34,58,34,255,34,125])});assert.equal(invalid.status,400,'Invalid UTF-8 remains rejected');
 const oversized=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(800000));controller.enqueue(new Uint8Array(800000));controller.close();}});
 invalid=await mf.dispatchFetch(importURL,{method:'POST',headers,body:oversized,duplex:'half'});assert.equal(invalid.status,413,'Chunked bodies remain bounded without trusting Content-Length');
 invalid=await send('/v1/catalogue/import',{products:Array(201).fill(products[0]),sourceURL:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',fetchedAt:Date.now()});assert.equal(invalid.status,400,'The 200-record cap still applies inside the DO');
 let response=await send('/v1/products/search',{query:'baked bean',store:'sainsburys'});assert.equal(response.status,200);let body=await response.json();assert.equal(body.total,1);assert.equal(body.ratings.length,1);
 const originalRating=body.ratings[0];
 response=await send('/v1/products/search',{aisle:'pulses',nutrition:['protein','fibre'],nutritionMode:'all'});body=await response.json();assert.equal(response.status,200);assert.equal(body.total,1);assert.equal(body.discovery.coverage.complete,true);
 response=await send('/v1/products/search',{aisle:'pulses',dietary:['milk']});body=await response.json();assert.equal(body.total,0,'Unknown dietary evidence never passes');assert.deepEqual(body.discovery.excludedDietary,{conflicting:0,unconfirmed:1});
 response=await send('/v1/catalogue/discovery-index',{statusOnly:true});assert.equal(response.status,200);assert.equal((await response.json()).processed,1);
 response=await send('/v1/catalogue/discovery-index',{limit:500});assert.equal(response.status,200);assert.equal((await response.json()).processed,0);
 for(const sort of ['ratingHighest','ratingLowest','relevance','nameAscending']){response=await send('/v1/products/search',{query:'baked bean',store:'sainsburys',minimumRating:75,sort});assert.equal(response.status,200);const filtered=await response.json();assert.equal(filtered.total,1);assert.equal(filtered.products[0].code,products[0].code);assert.equal(filtered.ratings[0].score.value,originalRating.score.value);}
 const imageURL='https://images.openfoodfacts.org/images/products/500/000/000/0001/front_en.2.400.jpg';
 response=await send('/v1/catalogue/images',{records:[{barcode:products[0].code,sourceRevision:1700000000,imageFrontURL:imageURL}],sourceURL:'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz',retrievedAt:Date.now()});assert.equal(response.status,200);assert.equal((await response.json()).updated,1);
 response=await send('/v1/products/search',{aisle:'pulses',nutrition:['protein']});assert.equal((await response.json()).total,1,'Image-only update retains discovery binding');
 response=await send('/v1/products/batch',{codes:[products[0].code]});body=await response.json();assert.equal(body.products[0].image_front_url,imageURL);assert.deepEqual(body.ratings[0].score,originalRating.score);assert.equal(body.ratings[0].fetchedAt,originalRating.fetchedAt);assert.equal(body.ratings[0].expiresAt,originalRating.expiresAt);
 response=await send('/v1/products/search',{query:'beans',store:'tesco'});assert.equal((await response.json()).total,0);
 for(const sort of ['ratingHighest','ratingLowest']){
  response=await send('/v1/products/search',{query:'',sort});body=await response.json();assert.equal(response.status,200);assert.equal(body.total,1);assert.equal(body.products[0].code,products[0].code);
 }
 response=await send('/v1/products/lookup',{barcode:foreignCode});assert.equal(response.status,200);assert.equal(syntheticSourceCalls,1);
 response=await send('/v1/products/batch',{codes:[foreignCode]});body=await response.json();assert.equal(response.status,200);assert.equal(body.products[0].code,foreignCode);assert.deepEqual(body.products[0].countries_tags,['en:france']);assert.equal(body.ratings[0].discoveryScope,'barcode_only');assert.ok(body.ratings[0].score.available);
 response=await send('/v1/products/lookup',{barcode:foreignCode});assert.equal(response.status,200);assert.equal(syntheticSourceCalls,1,'Retained exact facts avoid another source fetch');
 for(const market of ['unitedKingdom','allCountries']){response=await send('/v1/products/search',{query:'beans',market,sort:'ratingHighest'});body=await response.json();assert.equal(body.total,1,'Foreign source tags do not imply UK discovery or retailer availability');}
 await mf.dispose();mf=new Miniflare(options());
 response=await send('/v1/products/search',{query:'beans',sort:'ratingHighest'});body=await response.json();assert.equal(body.total,1,'SQLite index persists across worker restart');
 response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/export?limit=1');assert.equal(response.status,200);assert.equal((await response.json()).products[0].code,products[0].code);
 const canonical=JSON.parse(readFileSync(new URL('../test/fixtures/off-gluten-free-bread.json',import.meta.url),'utf8')).product;
 response=await send('/v1/catalogue/import',{products:[canonical,{...canonical,code:'5000000000099',allergens_tags:['en:gluten']}],sourceURL:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',fetchedAt:Date.now()});assert.equal(response.status,200);
 response=await send('/v1/products/search',{aisle:'bakery',dietary:['gluten']});body=await response.json();assert.equal(response.status,200);assert.equal(body.total,1);assert.equal(body.products[0].code,canonical.code);assert.equal(body.discovery.evidence[0].dietary.gluten.claim,'no-gluten');assert.equal(body.discovery.excludedDietary.conflicting,1,'A canonical free-from label never overrides explicit gluten evidence');
 const placeProduct={...products[0],code:'5000000000081',product_name:'Brand beans',brands_tags:['en:greggs'],stores:'Iceland',labels_tags:['en:no-gluten']};
 response=await send('/v1/catalogue/import',{products:[placeProduct,{...placeProduct,code:'5000000000082',product_name:'Greggs beans',brands_tags:[],stores:'Tesco'}],sourceURL:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',fetchedAt:Date.now()});assert.equal(response.status,200);
 response=await send('/v1/products/search',{placeID:'greggs',aisle:'pulses',dietary:['gluten'],nutrition:['protein','fibre'],nutritionMode:'all'});body=await response.json();assert.equal(response.status,200);assert.equal(body.total,1,'Place combines with existing discovery filters and excludes title guesses');assert.equal(body.products[0].code,placeProduct.code);assert.equal(body.places.selected.menuAvailable,false);assert.equal(body.places.evidence[0].sourceFingerprint,body.ratings[0].sourceFingerprint);assert.deepEqual(body.places.evidence[0].associations.map(a=>[a.placeID,a.relation]).sort(),[['greggs','brand'],['iceland','retailer']]);
 response=await send('/v1/products/search',{placeID:'greggs',store:'tesco'});assert.equal((await response.json()).total,0,'A brand association never becomes retailer evidence');
 for(const store of ['farmfoods','heronFoods','booths','budgens','spar','boots']){response=await send('/v1/products/search',{store});assert.equal(response.status,200);assert.equal((await response.json()).total,0,'New retailer scopes remain strict when no retailer evidence exists');}
 response=await send('/v1/catalogue/place-index',{statusOnly:true,summary:true});assert.equal(response.status,200);body=await response.json();assert.equal(body.complete,true);assert.equal(body.places.length,63);assert.equal(body.places.find(p=>p.id==='greggs').total,1);assert.equal(body.places.find(p=>p.id==='greggs').titleCandidate,1);
 response=await send('/v1/catalogue/place-index',{limit:500});assert.equal(response.status,200);assert.equal((await response.json()).processed,0);
 response=await send('/v1/products/search',{placeID:'not-a-place'});assert.equal(response.status,400);
 console.log('PASS: authenticated import, Workers FTS5, strict UK/store discovery, reusable foreign-barcode facts and scores, image enrichment, durable restart, public export, canonical OFF free-from labels and source-bound place filtering/admin summary; one synthetic source fixture, no external network or AI calls.');
} finally {await mf.dispose();rmSync(directory,{recursive:true,force:true});}
