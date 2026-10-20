import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter,FoodCatalogueIndex} from '../src/catalogue-index-object.js';
import {importCatalogue,searchCatalogue,patchCatalogueImages} from '../src/catalogue-index.js';
import {evaluateDiscovery,AISLES,DISCOVERY_VERSION} from '../src/catalogue-discovery.js';
import {reindexDiscovery} from '../src/catalogue-discovery-index.js';
import worker from '../src/worker.js';
const now=Date.now(),sourceURL='https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz';
const food=(code='5000000000001',extra={})=>({code,product_name:'Food',countries_tags:['en:united-kingdom'],stores:'Tesco',last_modified_t:1700000000,nutriments:{'energy-kcal_100g':100,proteins_100g:3,fiber_100g:3},...extra});
function fixture(){const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');sql.exec(catalogueSchema);const storage={sql:{exec:(q,...values)=>({toArray:()=>sql.prepare(q).all(...values)})},transactionSync:fn=>{sql.exec('BEGIN');try{const value=fn();sql.exec('COMMIT');return value;}catch(e){sql.exec('ROLLBACK');throw e;}}};return {sql,db:catalogueSQLAdapter(storage)};}
const load=(db,products)=>importCatalogue(db,{products,sourceURL,fetchedAt:now},{now});
describe('versioned source-backed discovery',()=>{
 it('preserves exact28 aisle IDs, supports justified OR memberships and deduplicates',async()=>{
  assert.equal(Object.keys(AISLES).length,28);assert.deepEqual(Object.keys(AISLES).slice(0,8),['fruit','vegetables','salad','dairy','eggs','cheese','yoghurt','meat']);
  const {db}=fixture();await load(db,[food(undefined,{categories_tags:['en:baked-beans','en:legumes','en:canned-foods']})]);
  for(const aisle of ['pulses','tins']){const r=await searchCatalogue(db,{aisle},{now});assert.equal(r.total,1);assert.equal(r.products.length,1);assert.equal(r.discovery.coverage.complete,true);}
 });
 it('keeps yoghurt distinct from cheese despite their shared fermented-milk ancestor',async()=>{
  const {db}=fixture();const nutrition={calcium_100g:.13};await load(db,[food('5000000000001',{product_name:'Cheddar',categories_tags:['en:fermented-milk-products','en:cheeses'],nutriments:nutrition}),food('5000000000002',{product_name:'Yoghurt',categories_tags:['en:fermented-milk-products','en:yogurts'],nutriments:nutrition})]);
  const result=await searchCatalogue(db,{aisle:'yoghurt',nutrition:['calcium']},{now});assert.equal(result.total,1);assert.equal(result.products[0].product_name,'Yoghurt');
 });
 it('caches only aggregate coverage and invalidates it after catalogue writes',async()=>{
  const {db}=fixture();await load(db,[food()]);const instance=Object.create(FoodCatalogueIndex.prototype);let reads=0;
  instance.db={...db,prepare(query){if(query.includes('LEFT JOIN catalogue_discovery d INDEXED BY catalogue_discovery_binding'))reads++;return db.prepare(query);}};
  const request=(path,body)=>instance.fetch(new Request('https://index'+path,{method:'POST',body:JSON.stringify(body)}));
  for(let i=0;i<2;i++)assert.equal((await request('/search',{aisle:'dairy'})).status,200);assert.equal(reads,1);
  await request('/import',{products:[food('5000000000002')],sourceURL,fetchedAt:now});let response=await request('/search',{});assert.equal((await response.json()).discovery.coverage.total,2);assert.equal(reads,2);
  await instance.searchCoverage(Date.now()+60_001);assert.equal(reads,3);
 });
 it('imports canonical OFF free-from labels and preserves conflicting/unknown states through indexed search',async()=>{
  const {db}=fixture();const cases=[['gluten','no-gluten','Rice flour, water','Wheat gluten, water'],['lactose','no-lactose','Lactose-free milk, cultures','Lactose, milk'],['milk','no-milk','Coconut milk, water','Skimmed milk, water'],['wheat','no-wheat','Rice flour, water','Wheat flour, water'],['peanut','no-peanuts','Almond flour, water','Peanuts, salt'],['soya','no-soy','Pea protein, water','Soya flour, water']];
  for(const [i,[requirement,label,ingredients,conflicting]]of cases.entries()){
   const code=n=>String(5000000001000+i*10+n),base={categories_tags:['en:breads'],labels_tags:['en:'+label]};
   await load(db,[food(code(1),{...base,ingredients_text:ingredients}),food(code(2),{...base,ingredients_text:conflicting}),food(code(3),{categories_tags:['en:breads']})]);
   const result=await searchCatalogue(db,{aisle:'bakery',dietary:[requirement]},{now});assert.ok(result.products.some(p=>p.code===code(1)),requirement+' supports the actual OFF label');assert.ok(!result.products.some(p=>p.code===code(2)),requirement+' rejects the contradictory ingredient');assert.ok(!result.products.some(p=>p.code===code(3)),requirement+' never assumes an absent label');
   const entry=result.discovery.evidence.find(e=>e.barcode===code(1));assert.equal(entry.dietary[requirement].claim,label);assert.equal(entry.dietary[requirement].state,'supported');assert.ok(result.discovery.excludedDietary.conflicting>=1);
  }
  const both=food('5000000001090',{categories_tags:['en:breads'],labels_tags:['en:no-gluten','en:no-milk'],ingredients_text:'Rice flour, water'});await load(db,[both]);const result=await searchCatalogue(db,{aisle:'bakery',dietary:['gluten','milk']},{now});assert.deepEqual(result.products.map(p=>p.code),[both.code]);
  assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:no-gluten'],allergens_tags:['en:gluten']})).dietary.gluten.state,'conflicting');
  assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:no-peanuts'],traces_tags:['en:peanuts']})).dietary.peanut.state,'conflicting');
 });
 it('finds the retained OFF gluten-free white loaf using its real canonical label',async()=>{
  const {product}=JSON.parse(readFileSync(new URL('./fixtures/off-gluten-free-bread.json',import.meta.url),'utf8'));const {db}=fixture();await load(db,[product]);const result=await searchCatalogue(db,{aisle:'bakery',dietary:['gluten']},{now});assert.equal(result.total,1);assert.equal(result.products[0].code,'00731515');assert.deepEqual(result.products[0].labels_tags,product.labels_tags);assert.equal(result.discovery.evidence[0].dietary.gluten.claim,'no-gluten');
 });
 it('requires every dietary label, keeps lactose/milk and gluten/wheat separate and rejects conflicting traces',()=>{
  const p=evaluateDiscovery(food(undefined,{labels_tags:['en:lactose-free','en:gluten-free','en:vegan'],allergens_tags:['en:milk','en:wheat'],traces_tags:['en:peanuts']}));
  assert.equal(p.dietary.lactose.state,'supported');assert.equal(p.dietary.milk.state,'conflicting');assert.equal(p.dietary.gluten.state,'supported');assert.equal(p.dietary.wheat.state,'conflicting');assert.equal(p.dietary.peanut.state,'conflicting');assert.equal(p.dietary.soya.state,'unconfirmed');assert.equal(p.dietary.vegan.state,'supported');
  assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:milk-free'],traces_tags:['en:milk']})).dietary.milk.state,'conflicting');
  assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:milk-free'],ingredients_text:'Skimmed milk, sugar'})).dietary.milk.state,'conflicting');
  assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:milk-free'],ingredients_text:'Coconut milk, cocoa butter'})).dietary.milk.state,'supported');
  assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:peanut-free'],ingredients_text:'Peanuts, salt'})).dietary.peanut.state,'conflicting');
  assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:lactose-free'],ingredients_text:'Lactose-free milk, cultures'})).dietary.lactose.state,'supported');
 });
 it('rejects explicit ingredient contradictions even without ingredient-analysis tags',()=>{
  for(const ingredient of ['salted butter','Milk chocolate (sugar, milk, cocoa)','Coating (milk powder)']){
   assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:milk-free','en:vegan'],ingredients_text:ingredient})).dietary.milk.state,'conflicting',ingredient);
  }
  for(const ingredient of ['Beef, water','Egg, flour','Milk chocolate, sugar','Vegan chicken (chicken powder)']){
   assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:vegan'],ingredients_text:ingredient})).dietary.vegan.state,'conflicting',ingredient);
  }
  for(const ingredient of ['Beef, water','Fish, water','Gelatine, sugar'])assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:vegetarian'],ingredients_text:ingredient})).dietary.vegetarian.state,'conflicting',ingredient);
  for(const ingredient of ['Coconut milk, cocoa butter','Almond butter, oat milk','Egg-free pasta, coconut meat','Peanuts, may contain milk','Butter beans, cream of tartar, milk thistle','Vegan chicken, plant-based beef, water'])assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:vegan'],ingredients_text:ingredient})).dietary.vegan.state,'supported',ingredient);
  assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:vegetarian'],ingredients_text:'Egg, milk, flour'})).dietary.vegetarian.state,'supported');
 });
 it('retains explicit raw allergen and trace declarations when taxonomy tags are absent',()=>{
  assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:milk-free'],allergens:'en:milk'})).dietary.milk.state,'conflicting');
  assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:peanut-free'],traces:'en:peanuts'})).dietary.peanut.state,'conflicting');
  assert.equal(evaluateDiscovery(food(undefined,{labels_tags:['en:soy-free'],allergens:'Contains soy'})).dietary.soya.state,'conflicting');
 });
 it('requires an explicit cereal wholegrain ingredient, not mustard or negated claims',()=>{
  for(const ingredient of ['Wholegrain mustard, water','0% wholegrain wheat','No wholegrain flour','Without wholemeal flour','Wholegrain seeds'])assert.equal(evaluateDiscovery(food(undefined,{ingredients_text:ingredient})).nutrition.wholegrain.state,'unconfirmed',ingredient);
  for(const ingredient of ['Wholemeal wheat flour, water','100% wholegrain oats','Whole wheat flour','Brown rice'])assert.equal(evaluateDiscovery(food(undefined,{ingredients_text:ingredient})).nutrition.wholegrain.state,'supported',ingredient);
 });
 it('uses nutrient thresholds and source units, never a protein gram value without energy',()=>{
  let p=evaluateDiscovery(food());assert.equal(p.nutrition.protein.state,'supported');assert.equal(p.nutrition.protein.energyPercent,12);assert.equal(p.nutrition.highfibre.gramsPer100Kcal,3);assert.equal(p.nutrition.fibre.state,'supported');assert.equal(p.nutrition.highfibre.state,'supported');
  p=evaluateDiscovery(food(undefined,{nutriments:{proteins_100g:20}}));assert.equal(p.nutrition.protein.state,'unconfirmed');assert.equal(p.nutrition.calcium.state,'unconfirmed');
  p=evaluateDiscovery(food(undefined,{nutriments:{calcium_100g:.12,calcium_unit:'mg','vitamin-d_100g':.00000075,iron_100g:.0021}}));assert.equal(p.nutrition.calcium.value,120);assert.equal(p.nutrition.calcium.state,'supported');assert.equal(p.nutrition.vitd.state,'supported');assert.equal(p.nutrition.iron.state,'supported');
  p=evaluateDiscovery(food(undefined,{categories_tags:['en:beverages'],nutrition_data_per:'100ml',nutriments:{calcium_100g:.06}}));assert.equal(p.nutrition.calcium.threshold,60);assert.equal(p.nutrition.calcium.state,'supported');
  p=evaluateDiscovery(food(undefined,{nutrition:{aggregated_set:{per:'100g',preparation:'as_sold',nutrients:{calcium:{value:120,unit:'mg',source:'packaging'},iron:{value:2.1,unit:'mg',source:'estimate'}}}}}));assert.equal(p.nutrition.calcium.state,'supported');assert.equal(p.nutrition.iron.state,'unconfirmed');
 });
 it('combines nutrition any/all without weakening dietary AND and counts before pagination',async()=>{
  const {db}=fixture();await load(db,[food('5000000000001',{labels_tags:['en:gluten-free','en:milk-free'],nutriments:{'energy-kcal_100g':100,proteins_100g:3,fiber_100g:0}}),food('5000000000002',{labels_tags:['en:gluten-free','en:milk-free'],nutriments:{'energy-kcal_100g':300,proteins_100g:1,fiber_100g:3}}),food('5000000000003',{labels_tags:['en:gluten-free'],nutriments:{'energy-kcal_100g':100,proteins_100g:3,fiber_100g:3}}),food('5000000000004',{labels_tags:['en:gluten-free','en:milk-free'],allergens_tags:['en:milk']})]);
  const query={dietary:['gluten','milk'],nutrition:['protein','fibre'],nutritionMode:'any',pageSize:1};const r=await searchCatalogue(db,query,{now});assert.equal(r.total,2);assert.deepEqual(r.discovery.excludedDietary,{conflicting:1,unconfirmed:1});assert.equal(r.products.length,1);assert.equal(r.hasMore,true);assert.equal((await searchCatalogue(db,{...query,nutritionMode:'all'},{now})).total,0);
 });
 it('keeps unknown wholegrain evidence separate, reindexes bounded old records without source calls',async()=>{
  const {db,sql}=fixture();await load(db,[food(undefined,{ingredients_text:'Wholemeal wheat flour, water',nutriments:{fiber_100g:1,'energy-kcal_100g':300}})]);let r=await searchCatalogue(db,{nutrition:['wholegrain']},{now});assert.equal(r.total,1);assert.equal(r.discovery.evidence[0].nutrition.highfibre.state,'conflicting');
  sql.exec("UPDATE catalogue_discovery SET rule_version='food-discovery-2026-10-09-v1'");r=await searchCatalogue(db,{nutrition:['wholegrain']},{now});assert.equal(r.total,0);assert.equal(r.discovery.coverage.complete,false);
  const backfill=await reindexDiscovery(db,{limit:1},{now});assert.equal(backfill.processed,1);assert.equal((await reindexDiscovery(db,{statusOnly:true},{now})).processed,1);
  assert.equal((await reindexDiscovery(db,{limit:1},{now})).processed,0);
 });
 it('admin reindex rejects ordinary app credentials',async()=>{
  let called=false;const response=await worker.fetch(new Request('https://example.com/v1/catalogue/discovery-index',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer app-token'},body:'{}'}),{PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update('app-token').digest('hex'),CATALOGUE_ADMIN_TOKEN_SHA256:createHash('sha256').update('admin-token').digest('hex'),FOOD_CATALOGUE_INDEX:{idFromName:()=>'',get:()=>({fetch:()=>{called=true;}})}});assert.equal(response.status,401);assert.equal(called,false);
 });
});
