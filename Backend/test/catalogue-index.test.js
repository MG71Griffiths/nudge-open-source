import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter,FoodCatalogueIndex} from '../src/catalogue-index-object.js';
import {buildCatalogueRow,importCatalogue,searchCatalogue,batchCatalogue,exportCatalogue,refreshCatalogue,recalculateCatalogue,queueCatalogueImport,catalogueSearchSQL,patchCatalogueImages,retainCatalogueProduct} from '../src/catalogue-index.js';
import {ScoreCore} from '../src/nutrition-core.js';
import worker from '../src/worker.js';

const now=Date.now(), sourceURL='https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');sql.exec(catalogueSchema);
 const storage={sql:{exec:(query,...values)=>{const statement=sql.prepare(query);return {toArray:()=>statement.all(...values)};}},transactionSync:callback=>{sql.exec('BEGIN');try{const result=callback();sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
 return {sql,storage,db:catalogueSQLAdapter(storage)};
}
function product(code='5000000000001',extra={}){return {code,product_name:'Baked beans',brands:'Test',countries_tags:['en:united-kingdom'],stores:"Sainsbury's",categories_tags:['en:baked-beans'],last_modified_t:1700000000,ingredients_text:'Beans (60%), water, tomatoes, sugar, salt',nutriments:{'energy-kcal_100g':90,proteins_100g:5,carbohydrates_100g:14,fat_100g:.5,'saturated-fat_100g':.1,sugars_100g:4,fiber_100g:4,salt_100g:.5},...extra};}
const load=(db,products,options={})=>importCatalogue(db,{products,sourceURL,fetchedAt:now,...options},{now:Math.max(now,options.fetchedAt||0)});
const search=(db,options={})=>searchCatalogue(db,{query:'beans',market:'unitedKingdom',...options},{now});

describe('searchable public food catalogue with real SQLite FTS5',()=>{
 it('keeps migration and bundled schema identical',()=>assert.equal(catalogueSchema,readFileSync(new URL('../migrations/0001_food_catalogue.sql',import.meta.url),'utf8')));
 it('normalizes beans, baked bean and yoghurt aliases and does not loosen a retailer filter',async()=>{
  const {db}=fixture();await load(db,[product(),product('5000000000002',{product_name:'Natural yogurt',categories_tags:['en:yogurts'],stores:'Tesco'}),product('5000000000003',{stores:'Tesco',brands:"Sainsbury's"})]);
  for(const query of ['beans','bean','baked bean','baked beans'])assert.equal((await search(db,{query,store:'sainsburys'})).total,1);
  for(const query of ['yogurt','yoghurt','yogurts'])assert.equal((await search(db,{query,store:'tesco'})).total,1);
  assert.equal((await search(db,{store:'waitrose'})).total,0);
  assert.equal((await search(db,{query:'beans OR 1=1 --'})).total,0);
 });
 it('sorts and applies a rating threshold before pagination, keeping missing rating distinct from zero',async()=>{
  const {db,sql}=fixture();await load(db,[product('5000000000001',{product_name:'Zed beans'}),product('5000000000002',{product_name:'Alpha beans'}),product('5000000000003',{product_name:'Middle beans'})]);
  sql.exec("UPDATE catalogue_products SET rating_value=CASE barcode WHEN '5000000000001' THEN 95 WHEN '5000000000002' THEN 10 ELSE NULL END");
  assert.equal((await search(db,{sort:'ratingHighest',pageSize:1})).products[0].code,'5000000000001');
  assert.equal((await search(db,{sort:'ratingLowest',pageSize:1})).products[0].code,'5000000000002');
  assert.equal((await search(db,{sort:'nameAscending',pageSize:1})).products[0].code,'5000000000002');
  assert.equal((await search(db,{sort:'nameDescending',pageSize:1})).products[0].code,'5000000000001');
  assert.equal((await search(db,{minimumRating:75,pageSize:1})).total,1);
  sql.exec("UPDATE catalogue_products SET classifier_version='old' WHERE barcode='5000000000001'");
  assert.equal((await search(db,{minimumRating:75})).total,0);
 });
 it('keeps source freshness and stale evidence explicit instead of silently emptying the catalogue',async()=>{
  const {db}=fixture();await load(db,[product()]);const future=now+31*86400000;
  const result=await searchCatalogue(db,{query:'beans'},{now:future});assert.equal(result.total,1);assert.equal(result.catalogue.freshness,'stale');assert.equal(result.ratings[0].freshness,'stale');assert.equal(result.ratings[0].fetchedAt,now);
 });
 it('does not let obsolete retained overlays hide a current independent score, while dependent publications stay excluded',async()=>{
  const {db,sql}=fixture();await load(db,[product()]);
  const row=sql.prepare('SELECT * FROM catalogue_products').get(),score=JSON.parse(row.score_json);assert.equal(score.available,true);
  sql.prepare(`INSERT INTO catalogue_enrichment_scores(barcode,source_fingerprint,source_fetched_at,evidence_version,score_method,score_version,classifier_version,evidence_json,score_json,rating_value,calculated_at,expires_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.barcode,row.source_fingerprint,row.fetched_at,'catalogue-enrichment-v1',row.score_method,row.score_version,'old','{}',row.score_json,row.rating_value,now,now-1);
  for(const query of ['beans',''])for(const sort of ['ratingHighest','ratingLowest']){
   const result=await search(db,{query,sort,minimumRating:score.value});assert.equal(result.total,1);assert.equal(result.ratings[0].score.value,score.value);
  }
  const retained=sql.prepare('SELECT * FROM catalogue_enrichment_scores').get();
  for(const dependency of [{catalogueEnrichment:{version:'catalogue-enrichment-v1',sourceFingerprint:row.source_fingerprint,expiresAt:now-1}},
   {catalogueEvidenceReplay:{version:'retained-facts-replay-v1',reused:true,rejected:false}}]){
   sql.prepare('UPDATE catalogue_products SET score_json=? WHERE barcode=?').run(JSON.stringify({...score,...dependency}),row.barcode);
   assert.equal((await search(db,{minimumRating:0,sort:'ratingHighest'})).total,0,'A dependent publication must still respect obsolete/expired evidence');
  }
  sql.prepare('UPDATE catalogue_products SET score_json=? WHERE barcode=?').run(JSON.stringify({...score,catalogueEvidenceReplay:{version:'retained-facts-replay-v1',reused:false,rejected:true}}),row.barcode);
  assert.equal((await search(db,{minimumRating:0})).total,1,'Rejected old evidence does not make the new direct score dependent on it');
  assert.deepEqual(sql.prepare('SELECT * FROM catalogue_enrichment_scores').get(),retained,'Search preserves retained evidence for audit/replay');
 });
 it('paginates global rating candidates with stable name/barcode ties and outdated ratings last',async()=>{
  const {db,sql}=fixture(),code=n=>'50000000000'+String(n).padStart(2,'0');
  const names=['Alpha','Alpha','Zed','Mid','Zero','Beta','Gamma','Delta','Epsilon','Expired'];
  await load(db,names.map((name,i)=>product(code(i+1),{product_name:name+' beans',stores:[3,4].includes(i+1)?'Tesco':"Sainsbury's"})));
  for(const [i,value] of [100,100,100,75,0,95,null,100,100,50].entries())sql.prepare('UPDATE catalogue_products SET rating_value=? WHERE barcode=?').run(value,code(i+1));
  sql.prepare("UPDATE catalogue_products SET classifier_version='old' WHERE barcode=?").run(code(6));
  sql.prepare("UPDATE catalogue_products SET score_method='old' WHERE barcode=?").run(code(8));
  sql.prepare("UPDATE catalogue_products SET score_version='old' WHERE barcode=?").run(code(9));
  sql.prepare('UPDATE catalogue_products SET expires_at=? WHERE barcode=?').run(now-1,code(10));
  for(const [sort,expected] of [['ratingHighest',[1,2,3,4,10,5,6,8,9,7]],['ratingLowest',[5,10,4,1,2,3,6,8,9,7]]]){
   const all=[];
   for(let page=1;page<=4;page++){
    const result=await search(db,{query:'',sort,pageSize:3,page});assert.equal(result.total,10);all.push(...result.products.map(p=>p.code));
    const stale=result.ratings.find(r=>r.barcode===code(10));if(stale)assert.equal(stale.freshness,'stale');
   }
   assert.deepEqual(all,expected.map(code));assert.equal(new Set(all).size,10);
   assert.deepEqual((await search(db,{query:'beans',sort,pageSize:20})).products.map(p=>p.code),expected.map(code),'FTS ranking preserves the same rating order');
  }
  const filtered=await search(db,{query:'',sort:'ratingHighest',minimumRating:75,store:'sainsburys',pageSize:1,page:2});
  assert.equal(filtered.total,2);assert.deepEqual(filtered.products.map(p=>p.code),[code(2)]);
 });
 it('uses a covering rating candidate index and hydrates only the selected wide rows',()=>{
  const {sql}=fixture();
  for(const sort of ['ratingHighest','ratingLowest']){
   const plan=catalogueSearchSQL({query:'',sort});
   const details=sql.prepare('EXPLAIN QUERY PLAN '+plan.rows.sql).all(...plan.rows.values).map(row=>row.detail);
   assert.ok(details.some(detail=>/COVERING INDEX catalogue_rating_candidates/.test(detail)),details.join('\n'));
   assert.ok(details.some(detail=>/SEARCH p USING INTEGER PRIMARY KEY/.test(detail)),details.join('\n'));
   assert.match(plan.rows.sql,/WHERE p\.rowid IN \(SELECT p\.rowid/);
  }
 });
 it('starts filtered text searches from FTS once before applying the rating threshold',()=>{
  const {sql}=fixture();
  for(const sort of ['ratingHighest','ratingLowest','relevance','nameAscending','nameDescending']){
   const plan=catalogueSearchSQL({query:'organic baked beans',sort,minimumRating:75,store:'sainsburys'});
   for(const operation of [plan.count,plan.rows]){
    const details=sql.prepare('EXPLAIN QUERY PLAN '+operation.sql).all(...operation.values).map(row=>row.detail);
    assert.ok(details.some(detail=>/catalogue_fts VIRTUAL TABLE INDEX 0:M1/.test(detail)),details.join('\n'));
    assert.ok(!details.some(detail=>/catalogue_fts VIRTUAL TABLE INDEX 0:=M1/.test(detail)),details.join('\n'));
   }
  }
 });
 it('keeps threshold, source-version, supermarket and page ties correct for filtered multiword search',async()=>{
  const {db,sql}=fixture();await load(db,[product('5000000000001',{product_name:'Organic baked beans'}),product('5000000000002',{product_name:'Organic baked beans'}),product('5000000000003',{product_name:'Organic baked beans',stores:'Tesco'}),product('5000000000004',{product_name:'Organic baked beans'}),product('5000000000005',{product_name:'Organic baked beans'}),product('5000000000006',{product_name:'Organic baked beans'})]);
  sql.exec("UPDATE catalogue_products SET rating_value=100;UPDATE catalogue_products SET rating_value=50 WHERE barcode='5000000000004';UPDATE catalogue_products SET rating_value=NULL WHERE barcode='5000000000005';UPDATE catalogue_products SET classifier_version='old' WHERE barcode='5000000000006'");
  for(const sort of ['ratingHighest','ratingLowest','nameAscending','nameDescending','relevance']){
   const first=await search(db,{query:'organic baked bean',sort,minimumRating:75,store:'sainsburys',pageSize:1,page:1}),second=await search(db,{query:'organic baked beans',sort,minimumRating:75,store:'sainsburys',pageSize:1,page:2});
   assert.equal(first.total,2);assert.equal(second.total,2);assert.equal(first.products[0].code,'5000000000001');assert.equal(second.products[0].code,'5000000000002');assert.equal(first.hasMore,true);assert.equal(second.hasMore,false);
  }
 });
 it('protects source revisions and retailer membership against out-of-order imports',async()=>{
  const {db}=fixture();await load(db,[product()]);await load(db,[product('5000000000001',{stores:'Tesco',last_modified_t:1600000000})],{fetchedAt:now+1000});
  assert.equal((await search(db,{store:'sainsburys'})).total,1);assert.equal((await search(db,{store:'tesco'})).total,0);
  await load(db,[product('5000000000001',{stores:'Tesco',last_modified_t:Math.floor(now/1000)-100})],{fetchedAt:now+2000});
  assert.equal((await search(db,{store:'sainsburys'})).total,0);assert.equal((await search(db,{store:'tesco'})).total,1);
 });
 it('has an exact ordered batch response, reusable licensed export and no personal input fields',async()=>{
  const {db}=fixture();await load(db,[product('5000000000001',{voiceMemo:'PRIVATE',diary:'PRIVATE',image_url:'https://evil.example/photo'}),product('5000000000002')]);
  const result=await batchCatalogue(db,{codes:['5000000000002','5000000000001','9999999999999']},{now});assert.deepEqual(result.products.map(p=>p.code),['5000000000002','5000000000001']);assert.deepEqual(result.missing,['9999999999999']);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|evil/);
  const first=await exportCatalogue(db,new URL('https://nudge.example/export?limit=1'),{now});assert.equal(first.nextAfter,'5000000000001');assert.match(first.catalogue.licenceURL,/odbl/);assert.equal(first.sources[0].importSourceURL,sourceURL);
 });
 it('rejects untrusted import sources, invalid identifiers and atomic invalid batches',async()=>{
  const {db}=fixture();await assert.rejects(()=>load(db,[product(),product('not-barcode')]),/barcode/);assert.equal((await search(db)).total,0);
  await assert.rejects(()=>load(db,[product()],{sourceURL:'https://evil.example/export'}),/official/);
  await assert.rejects(()=>buildCatalogueRow(product('5000000000001',{last_modified_t:Math.floor(now/1000)+600}),{fetchedAt:now,source:sourceURL,now}),/modification date/);
  await assert.rejects(()=>buildCatalogueRow(product(5000000000001),{fetchedAt:now,source:sourceURL,now}),/barcode/);
  const result=await load(db,[product('5000000000001',{countries_tags:['en:france']})]);assert.equal(result.skipped,1);
 });
 it('rescores old engine versions without changing retained source date or filters',async()=>{
  const {db,sql}=fixture();await load(db,[product()]);sql.exec("UPDATE catalogue_products SET classifier_version='old',rating_value=NULL");await refreshCatalogue({FOOD_CATALOGUE_DB:db},{now:now+1000});
  const result=await search(db,{store:'sainsburys'});assert.equal(result.ratings[0].classifierVersion,ScoreCore.CLASSIFIER_VERSION);assert.equal(result.ratings[0].fetchedAt,now);assert.equal(result.ratings[0].calculatedAt,now+1000);
 });
 it('drains old revisions in bounded batches while preserving stale facts, images and source timestamps',async()=>{
  const {db,sql}=fixture();const products=Array.from({length:501},(_,i)=>product('500000000'+String(i).padStart(4,'0'),{image_url:'https://images.openfoodfacts.org/images/products/500/000/000/0001/front_en.2.400.jpg'}));for(let start=0;start<products.length;start+=200)await load(db,products.slice(start,start+200));
  const before=sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode LIMIT 1').get();sql.exec("UPDATE catalogue_products SET classifier_version='old',rating_value=NULL");
  const later=now+31*86400000,one=await recalculateCatalogue(db,{}, {now:later});assert.equal(one.updated,500);assert.equal(one.remaining,1);
  const two=await recalculateCatalogue(db,{}, {now:later});assert.equal(two.updated,1);assert.equal(two.remaining,0);assert.equal((await recalculateCatalogue(db,{}, {now:later})).updated,0);
  const after=sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode LIMIT 1').get();for(const key of ['provider_json','fetched_at','expires_at','source_fingerprint','source_revision','import_source_url'])assert.equal(after[key],before[key],key);assert.equal(after.classifier_version,ScoreCore.CLASSIFIER_VERSION);
  await assert.rejects(()=>recalculateCatalogue(db,{limit:10000},{now:later}));
 });
 it('supports one bounded trusted queued export chunk and records a failed oversized job',async()=>{
  const {db,sql}=fixture();await queueCatalogueImport(db,{objectKey:'off-exports/one.json',sourceURL,fetchedAt:now},{now});
  await refreshCatalogue({FOOD_CATALOGUE_DB:db,FOOD_CATALOGUE_EXPORTS:{get:async()=>({size:1000,text:async()=>JSON.stringify({products:[product()]})})}},{now});assert.equal((await search(db)).total,1);
  await queueCatalogueImport(db,{objectKey:'off-exports/huge.json',sourceURL,fetchedAt:now},{now});await refreshCatalogue({FOOD_CATALOGUE_DB:db,FOOD_CATALOGUE_EXPORTS:{get:async()=>({size:2000000})}},{now});assert.equal(sql.prepare("SELECT status FROM catalogue_import_queue WHERE object_key='off-exports/huge.json'").get().status,'failed');
 });
 it('preserves preparation flags and treats explicit prepared-only legacy values as unknown',async()=>{
  const row=await buildCatalogueRow(product('5000000000001',{nutrition_data:'',nutrition_data_prepared:'on',nutrition_data_prepared_per:'100g'}),{fetchedAt:now,source:sourceURL,now});
  assert.equal(JSON.parse(row.provider_json).nutrition_data_prepared,'on');const score=JSON.parse(row.score_json);assert.notEqual(score.status,'rated');assert.notEqual(score.status,'provisional');
 });
});

describe('catalogue worker authorization boundary',()=>{
 const appToken='67'.repeat(32),adminToken='89'.repeat(32),hash=token=>createHash('sha256').update(token).digest('hex');
 function env(){let calls=0;return {get calls(){return calls;},PRIVATE_ACCESS_TOKEN_SHA256:hash(appToken),CATALOGUE_ADMIN_TOKEN_SHA256:hash(adminToken),FOOD_CATALOGUE_INDEX:{idFromName:name=>name,get:()=>({fetch:async()=>{calls++;return Response.json({ok:true});}})}};}
 const request=(route,token,body={query:'beans'})=>new Request('https://nudge.example'+route,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
 it('search works independently of AI configuration and quota; unauthenticated search is denied',async()=>{const e=env();assert.equal((await worker.fetch(request('/v1/products/search',appToken),e)).status,200);assert.equal((await worker.fetch(request('/v1/products/search'),e)).status,401);assert.equal(e.calls,1);});
 it('exact barcode lookup works without AI configuration while retaining authentication and analysis configuration checks',async()=>{
  const e=env(),{db,sql}=fixture();await load(db,[product()]);const row=sql.prepare('SELECT * FROM catalogue_products').get();let reads=0;
  e.FOOD_CATALOGUE_INDEX.get=()=>({fetch:async()=>{reads++;return Response.json(await batchCatalogue(db,{codes:[row.barcode]},{now}));}});
  assert.equal((await worker.fetch(request('/v1/products/lookup',appToken,{barcode:row.barcode}),e)).status,200);assert.equal(reads,1);
  assert.equal((await worker.fetch(request('/v1/products/lookup',null,{barcode:row.barcode}),e)).status,401);assert.equal(reads,1);
  assert.equal((await worker.fetch(request('/v1/products/score',appToken),e)).status,400,'Public fact scoring validates its body without requiring AI configuration');
  assert.equal((await worker.fetch(request('/v1/nutrition-label/analyse',appToken),e)).status,503);
 });
 it('requires the separate administration secret for publishing',async()=>{const e=env();assert.equal((await worker.fetch(request('/v1/catalogue/import',appToken),e)).status,401);assert.equal((await worker.fetch(request('/v1/catalogue/import',adminToken),e)).status,200);assert.equal(e.calls,1);});
 it('protects image-only publishing with the same separate administration secret and byte limit',async()=>{const e=env();assert.equal((await worker.fetch(request('/v1/catalogue/images',appToken),e)).status,401);assert.equal((await worker.fetch(request('/v1/catalogue/images',adminToken),e)).status,200);assert.equal((await worker.fetch(request('/v1/catalogue/images',adminToken,{data:'x'.repeat(1500100)}),e)).status,413);assert.equal(e.calls,1);});
 it('restricts classifier refresh to the separate administration credential',async()=>{const e=env();assert.equal((await worker.fetch(request('/v1/catalogue/recalculate',appToken,{}),e)).status,401);assert.equal((await worker.fetch(request('/v1/catalogue/recalculate',adminToken,{}),e)).status,200);assert.equal(e.calls,1);});
 it('provides a public read-only export and refuses oversized imports',async()=>{const e=env();assert.equal((await worker.fetch(new Request('https://nudge.example/v1/catalogue/export?limit=1'),e)).status,200);assert.equal((await worker.fetch(request('/v1/catalogue/import',adminToken,{data:'x'.repeat(1500100)}),e)).status,413);});
 it('forwards authenticated import bytes unchanged without parsing and serializing in the public worker',async()=>{
  const raw=' { "products" : [], "sourceURL" : "https://static.openfoodfacts.org/data/export.jsonl" }\n';let forwarded;
  const e=env();e.FOOD_CATALOGUE_INDEX.get=()=>({fetch:async(_url,init)=>{forwarded=init.body;return Response.json({accepted:0});}});
  const response=await worker.fetch(new Request('https://nudge.example/v1/catalogue/import',{method:'POST',headers:{authorization:'Bearer '+adminToken,'content-type':'application/json'},body:raw}),e);
  assert.equal(response.status,200);assert.ok(forwarded instanceof Uint8Array);assert.equal(new TextDecoder().decode(forwarded),raw);
 });
 it('rejects a chunked import over the limit even without Content-Length',async()=>{
  const e=env(),body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(800000));controller.enqueue(new Uint8Array(800000));controller.close();}});
  const response=await worker.fetch(new Request('https://nudge.example/v1/catalogue/import',{method:'POST',headers:{authorization:'Bearer '+adminToken,'content-type':'application/json'},body,duplex:'half'}),e);
  assert.equal(response.status,413);assert.equal(e.calls,0);
 });
});

describe('shared index barcode lookup and catalogue growth',()=>{
 it('uses fresh shared facts before a product-source request and never freshens expired rows',async()=>{
  const {getCatalogue}=await import('../src/catalogue-service.js');let upstream=0,writes=0;
  const {db,sql}=fixture();await load(db,[product()],{fetchedAt:now-2*86400000});const row=sql.prepare('SELECT * FROM catalogue_products').get();
  const env={FOOD_CATALOGUE_INDEX:{idFromName:v=>v,get:()=>({fetch:async(url)=>{if(url.endsWith('/retain')){writes++;return Response.json({accepted:1});}return Response.json(await batchCatalogue(db,{codes:[row.barcode]},{now}));}})},LABEL_QUOTA:{idFromName:v=>v,get:()=>({fetch:async()=>{upstream++;return Response.json({record:null});}})}};
  assert.equal((await getCatalogue(env,row.barcode)).barcode,row.barcode);assert.equal(upstream,0);assert.equal(writes,0);
  sql.prepare('UPDATE catalogue_products SET expires_at=? WHERE barcode=?').run(now-1,row.barcode);
  const stale=(await batchCatalogue(db,{codes:[row.barcode]},{now})).ratings[0];assert.ok(stale.expiresAt>stale.fetchedAt&&stale.expiresAt<now,'Expired source metadata retains a valid retrieval-to-expiry timeline');
  assert.equal(await getCatalogue(env,row.barcode),null);assert.equal(upstream,0,'Foreground does not refresh expired source records');
  assert.equal(await getCatalogue(env,row.barcode,undefined,{allowSourceFetch:true}),null);assert.equal(upstream,1,'Background refresh is explicit');
 });
 it('grows the index only from public records returned by the server lookup, without requiring UK tags',async()=>{
  const {getCatalogue}=await import('../src/catalogue-service.js');const {catalogueRecordFromPayload}=await import('../src/food-catalogue.js');let posted;
  const record=catalogueRecordFromPayload({product:product('5000000000001',{countries_tags:['en:france']})},'5000000000001',now);
  const env={FOOD_CATALOGUE_INDEX:{idFromName:v=>v,get:()=>({fetch:async(url,init)=>{if(url.endsWith('/retain')){posted=JSON.parse(init.body);return Response.json({accepted:1});}return Response.json({products:[],ratings:[]});}})},LABEL_QUOTA:{idFromName:v=>v,get:()=>({fetch:async()=>Response.json({record})})}};
  assert.equal((await getCatalogue(env,record.barcode,undefined,{allowSourceFetch:true})).barcode,record.barcode);assert.deepEqual(posted.product,record.providerPayload);assert.equal(posted.fetchedAt,now);assert.equal(posted.sourceURL,record.product.sourceURL);
 });
});

describe('exact barcode-only catalogue retention',()=>{
 const retain=(db,p,options={})=>retainCatalogueProduct(db,{product:p,sourceURL:`https://world.openfoodfacts.org/product/${p.code}`,fetchedAt:now,...options},{now:Math.max(now,options.fetchedAt||0)});
 it('keeps foreign and unknown-country scans with scores while excluding them from both discovery modes',async()=>{
  const {db,sql}=fixture();
  const foreign=product('5060003830306',{countries_tags:['en:france'],product_name:'Bhut Jolokia beans',voiceMemo:'PRIVATE',image_url:'https://evil.example/private'});
  const unknown=product('5000000000002',{countries_tags:[],product_name:'Unknown country beans',stores:''});
  await retain(db,foreign);await retain(db,unknown);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM catalogue_products WHERE is_uk=0').get().n,2);
  const result=await batchCatalogue(db,{codes:[foreign.code,unknown.code]},{now});
  assert.equal(result.products.length,2);assert.equal(result.ratings.length,2);
  assert.deepEqual(result.products[0].countries_tags,['en:france']);assert.deepEqual(result.products[1].countries_tags,[]);
  for(const meta of result.ratings){assert.equal(meta.discoveryScope,'barcode_only');assert.equal(meta.classifierVersion,ScoreCore.CLASSIFIER_VERSION);assert.equal(meta.fetchedAt,now);assert.equal(meta.score.available,ScoreCore.ACTIVE_DIRECTIONAL);assert.equal(meta.score.value,ScoreCore.ACTIVE_DIRECTIONAL?75:null);if(ScoreCore.ACTIVE_DIRECTIONAL)assert.equal(meta.score.scoreBasis,'nudge_directional');else assert.ok(meta.score.missingInputs.length);}
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|evil/);
  for(const market of ['unitedKingdom','allCountries'])for(const sort of ['relevance','ratingHighest','ratingLowest','nameAscending']){
   assert.equal((await search(db,{query:'',market,sort})).total,0);
   assert.equal((await search(db,{query:'beans',market,sort})).total,0);
  }
  assert.equal((await search(db,{query:'',store:'sainsburys'})).total,0,'retailer tags never imply UK availability');
  const exported=await exportCatalogue(db,new URL('https://nudge.example/export'),{now});assert.equal(exported.products.length,2);assert.ok(exported.ratings.every(r=>r.discoveryScope==='barcode_only'));
 });
 it('admits and removes discovery membership only from a newer source record with actual country evidence',async()=>{
  const {db}=fixture(),code='5000000000001';
  await retain(db,product(code,{countries_tags:['en:france']}));
  await load(db,[product(code,{last_modified_t:1700000001})],{fetchedAt:now+1000});assert.equal((await search(db)).total,1);
  assert.equal((await batchCatalogue(db,{codes:[code]},{now})).ratings[0].discoveryScope,'uk_discovery');
  await retain(db,product(code,{countries_tags:['en:france'],last_modified_t:1700000002}),{fetchedAt:now+2000});assert.equal((await search(db)).total,0);
  await load(db,[product(code)],{fetchedAt:now+3000});assert.equal((await search(db)).total,0,'older bulk evidence must not restore UK membership');
  assert.deepEqual((await batchCatalogue(db,{codes:[code]},{now})).products[0].countries_tags,['en:france']);
 });
 it('rescores barcode-only records without changing facts, country, source date or expiry',async()=>{
  const {db,sql}=fixture();await retain(db,product('5000000000001',{countries_tags:[]}));
  const before=sql.prepare('SELECT * FROM catalogue_products').get();sql.exec("UPDATE catalogue_products SET classifier_version='old',rating_value=NULL");
  await refreshCatalogue({FOOD_CATALOGUE_DB:db},{now:now+1000});const after=sql.prepare('SELECT * FROM catalogue_products').get();
  for(const key of ['provider_json','is_uk','fetched_at','expires_at','source_fingerprint','source_revision'])assert.equal(after[key],before[key],key);
  assert.equal(after.classifier_version,ScoreCore.CLASSIFIER_VERSION);assert.equal(after.calculated_at,now+1000);assert.equal((await search(db)).total,0);
 });
 it('does not expose a publishing route or allow a mismatched product source',async()=>{
  const {db}=fixture(),p=product('5000000000001',{countries_tags:[]});
  await assert.rejects(()=>retain(db,p,{sourceURL:'https://world.openfoodfacts.org/product/5000000000002'}),/exact public product source/);
  await assert.rejects(()=>retainCatalogueProduct(db,{product:p,sourceURL:`https://world.openfoodfacts.org/product/${p.code}`,fetchedAt:now,diary:'PRIVATE'},{now}));
  const response=await worker.fetch(new Request('https://nudge.example/v1/catalogue/retain',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)}),{});assert.equal(response.status,404);
  const bulk=await load(db,[p]);assert.equal(bulk.accepted,0);assert.equal(bulk.skipped,1);
 });
 it('reuses retained fallback facts on the next lookup without another public source request',async()=>{
  const {getCatalogue}=await import('../src/catalogue-service.js'),{catalogueRecordFromPayload}=await import('../src/food-catalogue.js');
  const {db}=fixture(),p=product('5060003830306',{countries_tags:['en:france']}),record=catalogueRecordFromPayload({product:p},p.code,now);let upstream=0;
  const instance=Object.create(FoodCatalogueIndex.prototype);instance.db=db;
  const env={FOOD_CATALOGUE_INDEX:{idFromName:v=>v,get:()=>({fetch:(url,init)=>instance.fetch(new Request(url,init))})},LABEL_QUOTA:{idFromName:v=>v,get:()=>({fetch:async()=>{upstream++;return Response.json({record});}})}};
  assert.equal((await getCatalogue(env,p.code,undefined,{allowSourceFetch:true})).barcode,p.code);
  assert.equal((await getCatalogue(env,p.code)).barcode,p.code,'Foreground reuses already ingested exact facts');
  assert.equal(upstream,1);assert.equal((await batchCatalogue(db,{codes:[p.code]},{now})).ratings[0].discoveryScope,'barcode_only');
 });
});

describe('catalogue storage failure observability',()=>{
 it('returns invalid JSON as a client error before any catalogue writes',async()=>{
  const instance=Object.create(FoodCatalogueIndex.prototype);
  instance.db={batch:async()=>{assert.fail('Invalid JSON must not write');}};
  for(const body of ['{invalid',new Uint8Array([123,34,120,34,58,34,255,34,125])]){
   const response=await instance.fetch(new Request('https://catalogue-index/import',{method:'POST',body}));
   assert.equal(response.status,400);assert.equal((await response.json()).code,'catalogue_request_invalid');
  }
 });
 it('distinguishes capacity failures without returning raw storage errors to clients',async()=>{
  const instance=Object.create(FoodCatalogueIndex.prototype),logs=[];
  instance.db={prepare:()=>({bind:()=>({})}),batch:async()=>{throw new Error('SQLITE_FULL: database or disk is full');}};
  const original=console.error;console.error=value=>logs.push(JSON.parse(value));
  try{
   const response=await instance.fetch(new Request('https://catalogue-index/import',{method:'POST',body:JSON.stringify({products:[product()],fetchedAt:now,sourceURL})}));
   assert.equal(response.status,503);const body=await response.json();assert.equal(body.code,'catalogue_storage_limit');assert.doesNotMatch(body.message,/SQLITE_FULL/);
   assert.equal(logs[0].action,'/import');assert.equal(logs[0].category,'resource_limit');assert.equal(logs[0].name,'Error');assert.ok(logs[0].message.length<=300);
  }finally{console.error=original;}
 });
 it('records bounded internal diagnostics for an unknown failure but keeps the public response generic',async()=>{
  const instance=Object.create(FoodCatalogueIndex.prototype),logs=[];
  instance.db={prepare:()=>({bind:()=>({first:async()=>({})})}),batch:async()=>{throw new Error('storage-internal-detail'.repeat(30));}};
  const original=console.error;console.error=value=>logs.push(JSON.parse(value));
  try{
   const response=await instance.fetch(new Request('https://catalogue-index/search',{method:'POST',body:JSON.stringify({query:'beans'})}));const body=await response.json();
   assert.equal(body.code,'catalogue_unavailable');assert.doesNotMatch(JSON.stringify(body),/storage-internal-detail/);assert.equal(logs[0].message.length,300);
  }finally{console.error=original;}
 });
});

describe('image-only public catalogue enrichment',()=>{
 const image='https://images.openfoodfacts.org/images/products/500/000/000/0001/front_en.2.400.jpg';
 const imageSource='https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';
 const patch=(records,extra={})=>({records,sourceURL:imageSource,retrievedAt:now,...extra});
 const imageRecord=(extra={})=>({barcode:'5000000000001',sourceRevision:1700000000,imageFrontURL:image,...extra});
 it('fills missing images while preserving every nutrition, rating, source date and filter field',async()=>{
  const {db,sql}=fixture();await load(db,[product()]);
  const before=sql.prepare('SELECT * FROM catalogue_products').get(),filterBefore=sql.prepare('SELECT * FROM catalogue_filters').all();
  const result=await patchCatalogueImages(db,patch([imageRecord({imageURL:image})]),{now});assert.equal(result.updated,1);
  const after=sql.prepare('SELECT * FROM catalogue_products').get(),oldJSON=JSON.parse(before.provider_json),newJSON=JSON.parse(after.provider_json);
  assert.equal(newJSON.image_front_url,image);assert.equal(newJSON.image_url,image);delete newJSON.image_front_url;delete newJSON.image_url;assert.deepEqual(newJSON,oldJSON);
  for(const key of Object.keys(before).filter(k=>!['provider_json','source_fingerprint'].includes(k)))assert.deepEqual(after[key],before[key],key);
  assert.notEqual(after.source_fingerprint,before.source_fingerprint);assert.deepEqual(sql.prepare('SELECT * FROM catalogue_filters').all(),filterBefore);
  assert.equal((await search(db)).products[0].image_front_url,image);assert.equal((await batchCatalogue(db,{codes:[after.barcode]})).products[0].image_front_url,image);
  const exported=await exportCatalogue(db,new URL('https://nudge.example/export'));assert.equal(exported.sources[0].imageSources.length,2);assert.equal(exported.sources[0].imageSources[0].sourceURL,imageSource);assert.equal(exported.sources[0].imageSources[0].retrievedAt,now);
 });
 it('is idempotent and never overwrites an existing source URL',async()=>{
  const {db,sql}=fixture();const old=image.replace('.2.','.1.');await load(db,[product('5000000000001',{image_front_url:old})]);
  const result=await patchCatalogueImages(db,patch([imageRecord({imageFrontSmallURL:image.replace('.400.','.200.')})]),{now});assert.equal(result.updated,1);
  const provider=JSON.parse(sql.prepare('SELECT provider_json FROM catalogue_products').get().provider_json);assert.equal(provider.image_front_url,old);assert.ok(provider.image_front_small_url);
  assert.equal((await patchCatalogueImages(db,patch([imageRecord({imageFrontSmallURL:image.replace('.400.','.200.')})]),{now})).unchanged,1);
 });
 it('requires exact source revisions, rejects missing revision identity and never creates products',async()=>{
  const {db,sql}=fixture();await load(db,[product()]);const before=sql.prepare('SELECT * FROM catalogue_products').get();
  let result=await patchCatalogueImages(db,patch([imageRecord({sourceRevision:1700000001}),imageRecord({barcode:'5999999999999'})]),{now});assert.equal(result.revisionMismatch,1);assert.equal(result.missing,1);assert.equal(result.updated,0);assert.deepEqual(sql.prepare('SELECT * FROM catalogue_products').get(),before);
  await assert.rejects(()=>patchCatalogueImages(db,patch([imageRecord({sourceRevision:null})]),{now}),/identity/);
 });
 it('rejects unsafe URLs, nutrition mutations, duplicate identities and oversized record counts before writes',async()=>{
  const {db,sql}=fixture();await load(db,[product()]);
  for(const bad of [imageRecord({imageFrontURL:'https://evil.example/a.jpg'}),imageRecord({imageFrontURL:'https://secret@images.openfoodfacts.org/a.jpg'}),imageRecord({nutriments:{sugars_100g:0}})])await assert.rejects(()=>patchCatalogueImages(db,patch([bad]),{now}));
  await assert.rejects(()=>patchCatalogueImages(db,patch([imageRecord(),imageRecord()]),{now}));
  await assert.rejects(()=>patchCatalogueImages(db,patch(Array(1001).fill(imageRecord())),{now}));
  assert.equal(sql.prepare('SELECT count(*) AS n FROM catalogue_image_sources').get().n,0);
 });
 it('does not attach a stale image or provenance after a concurrent source revision update',async()=>{
  const {db,sql}=fixture();await load(db,[product()]);let raced=false;
  const racing={...db,batch:async statements=>{if(!raced){raced=true;sql.prepare('UPDATE catalogue_products SET source_revision=1700000001,source_fingerprint=?').run('new-facts');}return db.batch(statements);}};
  const result=await patchCatalogueImages(racing,patch([imageRecord()]),{now});assert.equal(result.conflicts,1);assert.equal(result.updated,0);
  assert.equal(JSON.parse(sql.prepare('SELECT provider_json FROM catalogue_products').get().provider_json).image_front_url,undefined);assert.equal(sql.prepare('SELECT count(*) AS n FROM catalogue_image_sources').get().n,0);
 });
 it('hydrates large accepted patch requests in at most fifty-record chunks',async()=>{
  const {db}=fixture(),codes=Array.from({length:51},(_,i)=>String(5000000000000+i));await load(db,codes.map(code=>product(code)));
  const reads=[],bounded={...db,prepare:statement=>{const prepared=db.prepare(statement);if(!statement.startsWith('SELECT barcode,provider_json'))return prepared;return {bind:value=>{reads.push(JSON.parse(value).length);return prepared.bind(value);}};}};
  const result=await patchCatalogueImages(bounded,patch(codes.map(barcode=>imageRecord({barcode}))),{now});assert.equal(result.updated,51);assert.deepEqual(reads,[50,1]);
 });
});
