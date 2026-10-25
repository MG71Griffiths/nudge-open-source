import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter,FoodCatalogueIndex} from '../src/catalogue-index-object.js';
import {importCatalogue,searchCatalogue,patchCatalogueImages,catalogueSearchSQL} from '../src/catalogue-index.js';
import {PLACE_VERSION,PLACES,evaluatePlaces} from '../src/catalogue-places.js';
import {placeIndexStatus,reindexPlaces} from '../src/catalogue-place-index.js';
import worker from '../src/worker.js';

const now=Date.now(),sourceURL='https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz';
const food=(code='5000000000001',extra={})=>({code,product_name:'Beans',countries_tags:['en:united-kingdom'],categories_tags:['en:baked-beans'],last_modified_t:1700000000,nutriments:{'energy-kcal_100g':100,proteins_100g:3,fiber_100g:3},...extra});
function fixture(){const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');sql.exec(catalogueSchema);const storage={sql:{exec:(q,...values)=>({toArray:()=>sql.prepare(q).all(...values)})},transactionSync:fn=>{sql.exec('BEGIN');try{const value=fn();sql.exec('COMMIT');return value;}catch(error){sql.exec('ROLLBACK');throw error;}}};return {sql,db:catalogueSQLAdapter(storage)};}
const load=(db,products,fetchedAt=now)=>importCatalogue(db,{products,sourceURL,fetchedAt},{now:fetchedAt});
const associations=product=>evaluatePlaces(product).associations;
describe('source-bound UK place discovery',()=>{
 it('uses the one shared taxonomy, with Subway once and explicit multi-group membership',()=>{
  assert.equal(PLACES.length,63);assert.equal(new Set(PLACES.map(p=>p.id)).size,63);
  assert.deepEqual(PLACES.find(p=>p.id==='subway').groups,['cafe','restaurant']);
  const found=associations({brands:'Subway',stores:'Subway'});assert.equal(found.length,2);assert.deepEqual(found.map(item=>item.relation),['brand','retailer']);
  assert.deepEqual(associations({brands:'Cosy Club'}).map(item=>item.placeID),['loungers']);assert.deepEqual(associations({brands:'Lounge',product_name:'Lounge breakfast'}),[]);
 });
 it('requires exact metadata aliases while tolerating case, accents, apostrophes and taxonomy punctuation',()=>{
  for(const [product,id,relation] of [[{brands_tags:['en:nando-s']},'nandos','brand'],[{brands:'Greggs Bake At Home'},'greggs','brand'],[{brands:'Café Nero'},'caffenero','brand'],[{stores_tags:['en:marks-and-spencer']},'mands','retailer'],[{stores:'Co-op Food'},'coOp','retailer'],[{brands:'BEAR Coffee Company'},'bear','brand']]){
   assert.ok(associations(product).some(item=>item.placeID===id&&item.relation===relation&&item.confidence==='source_metadata'));
  }
  for(const product of [{brands:'Bear',product_name:'BEAR fruit YoYos'},{brands:'Leonidas',product_name:'Chorizo de Leon'},{brands:'Costa Rica',product_name:'Costa Rica pineapple'},{brands:'Costa & Mollica'},{brands:'Alce Nero'},{brands:"Bill's",product_name:"Bill's biscuits"},{brands:'Generic',product_name:'Subway sandwich'}])assert.deepEqual(associations(product),[]);
 });
 it('preserves separate brand and retailer relationships and never invents menu or stock evidence',async()=>{
  const {db}=fixture(),raw=food(undefined,{brands:'Greggs',brands_tags:['greggs'],stores:'Iceland'});await load(db,[raw]);
  const result=await searchCatalogue(db,{placeID:'greggs'},{now});assert.equal(result.total,1);assert.deepEqual(result.products[0].brands_tags,['greggs']);assert.equal(result.products[0].stores,'Iceland');
  const row=result.places.evidence[0];assert.equal(row.sourceFingerprint,result.ratings[0].sourceFingerprint);assert.equal(row.version,PLACE_VERSION);assert.equal(row.menuAvailable,false);assert.equal(row.stockConfirmed,false);
  assert.deepEqual(row.associations.map(a=>[a.placeID,a.relation]).sort(),[['greggs','brand'],['iceland','retailer']]);assert.equal(result.places.selected.menuAvailable,false);
  assert.equal((await searchCatalogue(db,{placeID:'greggs',store:'iceland'},{now})).total,1);
  assert.equal((await searchCatalogue(db,{placeID:'greggs',store:'tesco'},{now})).total,0);
 });
 it('accepts observed brand variants without promoting them into retailer aliases',()=>{
  for(const [id,names]of [['greggs',['Greggs (Iceland)','Greggs Bake At Home']],['costa',['Costa UK','Costa Express','Costa - Barista Creations','Costa coffee barista creations','Costa Dolce Gusto']],['pret',['Pret a Manger UK','Pret UK']]]){
   for(const name of names){const matched=associations({brands:name});assert.ok(matched.some(item=>item.placeID===id&&item.relation==='brand'&&item.confidence==='source_metadata'),name);assert.deepEqual(associations({stores:name}),[],name+' is brand evidence, not a retailer alias');}
  }
 });
 it('normalizes evidence display whitespace without editing the raw source snapshot',async()=>{
  const {db}=fixture(),raw=food(undefined,{brands:'Greggs\nBake At Home',stores:'Co-op\tFood'});await load(db,[raw]);
  const result=await searchCatalogue(db,{placeID:'greggs'},{now});assert.equal(result.total,1);assert.equal(result.products[0].brands,raw.brands);assert.equal(result.products[0].stores,raw.stores);
  assert.deepEqual(result.places.evidence[0].associations.map(item=>item.value),['Greggs Bake At Home','Co-op Food']);assert.equal(result.places.evidence[0].sourceFingerprint,result.ratings[0].sourceFingerprint);
 });
 it('retains title candidates for review but excludes them from default place results',async()=>{
  const {db}=fixture();await load(db,[food(undefined,{product_name:'Greggs sausage rolls'}),food('5000000000002',{brands:'Greggs'}),food('5000000000003',{product_name:'Burger King foot lettuce'})]);
  const candidates=associations({product_name:'Greggs sausage rolls'});assert.equal(candidates[0].relation,'title_candidate');assert.equal(candidates[0].confidence,'candidate');
  const result=await searchCatalogue(db,{placeID:'greggs'},{now});assert.deepEqual(result.products.map(p=>p.code),['5000000000002']);assert.equal((await searchCatalogue(db,{placeID:'burgerking'},{now})).total,0);
  const status=await placeIndexStatus(db,{summary:true});const greggs=status.places.find(p=>p.id==='greggs');assert.equal(greggs.total,1);assert.equal(greggs.brand,1);assert.equal(greggs.titleCandidate,1);assert.equal(status.places.length,63);
  for(const name of ['Greggs-style rolls','Inspired by Greggs rolls','Copycat Greggs rolls','Homemade Nandos chicken','Alternative to Starbucks coffee','Starbucksville coffee'])assert.deepEqual(associations({product_name:name}),[]);
 });
 it('keeps legacy retailer filtering strict and supports every new supermarket through its place identity',async()=>{
  const {db}=fixture();await load(db,[food(undefined,{brands:'Tesco',stores:'Ocado'}),food('5000000000002',{stores:'Tesco'}),food('5000000000003',{stores:'Heron Foods'})]);
  assert.equal((await searchCatalogue(db,{placeID:'tesco'},{now})).total,2);assert.equal((await searchCatalogue(db,{store:'tesco'},{now})).total,1);assert.equal((await searchCatalogue(db,{placeID:'heronfoods'},{now})).total,1);
  for(const [index,[store,label]]of [['farmfoods','Farm Foods'],['heronFoods','Heron Foods'],['booths','Booths Supermarkets'],['budgens','Budgens'],['spar','SPAR'],['boots','Boots UK']].entries()){
   const code=String(5000000000100+index);await load(db,[food(code,{stores:label}),food(String(5000000000200+index),{brands:label})]);
   const result=await searchCatalogue(db,{store},{now});assert.ok(result.products.some(product=>product.code===code));assert.ok(result.products.every(product=>product.stores===label));
  }
  await assert.rejects(()=>searchCatalogue(db,{placeID:'made-up'},{now}),error=>error.status===400);
 });
 it('intersects place, query, aisles, dietary AND and nutrition any/all before paging and sorting',async()=>{
  const {db}=fixture();const base={brands:'Pret',categories_tags:['en:breads'],labels_tags:['en:no-gluten','en:no-milk']};
  await load(db,[food('5000000000001',{...base,product_name:'Alpha bread'}),food('5000000000002',{...base,product_name:'Zed bread',nutriments:{'energy-kcal_100g':100,proteins_100g:3,fiber_100g:0}}),food('5000000000003',{...base,brands:'Greggs',product_name:'Other bread'}),food('5000000000004',{...base,product_name:'Unknown bread',labels_tags:[]})]);
  const query={query:'bread',placeID:'pret',aisle:'bakery',dietary:['gluten','milk'],nutrition:['protein','fibre'],nutritionMode:'any',pageSize:1,sort:'nameDescending'};
  const result=await searchCatalogue(db,query,{now});assert.equal(result.total,2);assert.equal(result.products[0].product_name,'Zed bread');assert.equal(result.hasMore,true);assert.deepEqual(result.discovery.excludedDietary,{conflicting:0,unconfirmed:1});
  assert.equal((await searchCatalogue(db,{...query,page:2},{now})).products[0].product_name,'Alpha bread');assert.equal((await searchCatalogue(db,{...query,nutritionMode:'all'},{now})).total,1);
 });
 it('rejects stale source/version bindings and repairs a bounded projection without changing original facts',async()=>{
  const {db,sql}=fixture();await load(db,[food(undefined,{brands:'Greggs'})]);const original=sql.prepare('SELECT provider_json,source_revision,fetched_at FROM catalogue_products').get();
  sql.exec("UPDATE catalogue_places SET rule_version='old'");assert.equal((await searchCatalogue(db,{placeID:'greggs'},{now})).total,0);assert.equal((await placeIndexStatus(db)).complete,false);
  assert.equal((await reindexPlaces(db,{limit:1},{now})).processed,1);assert.equal((await reindexPlaces(db,{statusOnly:true},{now})).complete,true);assert.deepEqual(sql.prepare('SELECT provider_json,source_revision,fetched_at FROM catalogue_products').get(),original);
  sql.exec("UPDATE catalogue_places SET source_fingerprint='mismatch'");assert.equal((await searchCatalogue(db,{placeID:'greggs'},{now})).total,0);
  await reindexPlaces(db,{limit:1},{now});await load(db,[food(undefined,{brands:'Pret',last_modified_t:1700000001})],now+1);
  assert.equal((await searchCatalogue(db,{placeID:'greggs'},{now})).total,0);assert.equal((await searchCatalogue(db,{placeID:'pret'},{now})).total,1);
  assert.equal((await reindexPlaces(db,{limit:1},{now})).processed,0);
 });
 it('carries source binding through image-only additions, without changing associations or source dates',async()=>{
  const {db}=fixture();await load(db,[food(undefined,{brands:'Greggs'})]);const before=await searchCatalogue(db,{placeID:'greggs'},{now});
  await patchCatalogueImages(db,{records:[{barcode:'5000000000001',sourceRevision:1700000000,imageFrontURL:'https://images.openfoodfacts.org/images/products/500/000/000/0001/front_en.2.400.jpg'}],sourceURL,retrievedAt:now},{now});
  const after=await searchCatalogue(db,{placeID:'greggs'},{now});assert.equal(after.total,1);assert.deepEqual(after.places.evidence[0].associations,before.places.evidence[0].associations);assert.notEqual(after.places.evidence[0].sourceFingerprint,before.places.evidence[0].sourceFingerprint);assert.equal(after.places.evidence[0].sourceFingerprint,after.ratings[0].sourceFingerprint);assert.equal(after.ratings[0].fetchedAt,before.ratings[0].fetchedAt);
 });
 it('uses indexed place candidates and inspects score JSON only for the stale overlay subset',async()=>{
  const {sql,db}=fixture();
  await load(db,Array.from({length:64},(_,i)=>food(String(5000000000001+i),{brands:'Greggs',product_name:'Beans '+String(i+1).padStart(2,'0')})));
  sql.exec('UPDATE catalogue_products SET rating_value=100');
  for(const row of sql.prepare('SELECT barcode,score_json FROM catalogue_products').all())
   sql.prepare('UPDATE catalogue_products SET score_json=? WHERE barcode=?').run(JSON.stringify({...JSON.parse(row.score_json),testMarker:row.barcode}),row.barcode);
  const direct='5000000000063',dependent='5000000000064';
  // Retaining expired evidence must not suppress a later independent direct
  // score. A live publication still dependent on that evidence is ineligible.
  for(const code of [direct,dependent])sql.prepare(`INSERT INTO catalogue_enrichment_scores
   (barcode,source_fingerprint,source_fetched_at,evidence_version,score_method,score_version,classifier_version,evidence_json,score_json,rating_value,calculated_at,expires_at)
   SELECT barcode,source_fingerprint,fetched_at,'old',score_method,score_version,classifier_version,'{}',score_json,100,calculated_at,? FROM catalogue_products WHERE barcode=?`).run(now-1,code);
  const stored=sql.prepare('SELECT score_json FROM catalogue_products WHERE barcode=?').get(dependent);
  sql.prepare('UPDATE catalogue_products SET score_json=? WHERE barcode=?').run(JSON.stringify({...JSON.parse(stored.score_json),catalogueEnrichment:{version:'old'}}),dependent);
  const allowedScoreJSON=new Set(sql.prepare('SELECT score_json FROM catalogue_products WHERE barcode IN (?,?)').all(direct,dependent).map(r=>r.score_json));
  // Delegate JSON semantics to a separate SQLite connection while observing
  // every JSON marker read in the real production query, not a copied query.
  const jsonSQL=new DatabaseSync(':memory:'),reads=[];
  for(const name of ['json_type','json_extract']){
   const evaluate=jsonSQL.prepare(`SELECT ${name}(?,?) AS value`);
   sql.function(name,(value,path)=>{reads.push({value,path});return evaluate.get(value,path).value;});
  }
  const plan=catalogueSearchSQL({placeID:'greggs',nutrition:['protein'],minimumRating:100,page:4},now);
  const explain=sql.prepare('EXPLAIN QUERY PLAN '+plan.rows.sql).all(...plan.rows.values).map(row=>row.detail).join('\n');
  assert.match(explain,/catalogue_place_lookup/);assert.match(explain,/catalogue_place_binding/);
  assert.match(explain,/COVERING INDEX catalogue_search_candidates/);
  assert.match(explain,/SEARCH p USING INTEGER PRIMARY KEY/);
  assert.doesNotMatch(explain,/SCAN ep(?:$|\s)/m,'Overlay score markers use exact barcode lookups');
  assert.doesNotMatch(plan.rows.sql,/(?:json_extract|json_type)\s*\(\s*[^,]*provider_json/i);
  const rows=sql.prepare(plan.rows.sql).all(...plan.rows.values);
  assert.deepEqual(rows.map(row=>row.barcode),['5000000000061','5000000000062',direct]);
  assert.ok(reads.length>0&&reads.length<64,'Only the small retained-overlay subset needs score marker reads');
  assert.ok(reads.every(read=>allowedScoreJSON.has(read.value)&&['$.catalogueEnrichment','$.catalogueEvidenceReplay.reused'].includes(read.path)),
   'No source JSON or unrelated candidate score JSON is parsed to select the page');
  jsonSQL.close();sql.close();
 });
 it('keeps admin backfill private and returns bounded validation errors',async()=>{
  let called=false;const response=await worker.fetch(new Request('https://example.com/v1/catalogue/place-index',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer app-token'},body:'{}'}),{PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update('app-token').digest('hex'),CATALOGUE_ADMIN_TOKEN_SHA256:createHash('sha256').update('admin-token').digest('hex'),FOOD_CATALOGUE_INDEX:{idFromName:()=>'',get:()=>({fetch:()=>{called=true;}})}});assert.equal(response.status,401);assert.equal(called,false);
  const {db}=fixture(),instance=Object.create(FoodCatalogueIndex.prototype);instance.db=db;
  for(const body of [{limit:501},{statusOnly:'true'},{summary:'yes'},{unknown:true}]){const r=await instance.fetch(new Request('https://index/place-index',{method:'POST',body:JSON.stringify(body)}));assert.equal(r.status,400);}
 });
});
