import {it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {readFileSync} from 'node:fs';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter,FoodCatalogueIndex} from '../src/catalogue-index-object.js';
import {catalogueSearchSQL,importCatalogue,searchCatalogue} from '../src/catalogue-index.js';

const now=Date.now(),sourceURL='https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');sql.exec(catalogueSchema);
 const storage={sql:{exec:(q,...v)=>({toArray:()=>sql.prepare(q).all(...v)})},transactionSync:fn=>{
  sql.exec('BEGIN');try{const result=fn();sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}
 }};
 return {sql,db:catalogueSQLAdapter(storage)};
}
const food=(code,name,extra={})=>({code,product_name:name,brands:'Test',countries_tags:['en:united-kingdom'],stores:'Tesco',
 categories_tags:['en:baked-beans'],last_modified_t:1700000000,ingredients_text:'Beans (60%), water, tomatoes, salt',
 nutriments:{'energy-kcal_100g':90,proteins_100g:5,carbohydrates_100g:14,fat_100g:.5,'saturated-fat_100g':.1,sugars_100g:4,fiber_100g:4,salt_100g:.5},...extra});
const load=(db,products)=>importCatalogue(db,{products,sourceURL,fetchedAt:now},{now});
const search=(db,body,options={})=>searchCatalogue(db,body,{now,...options});

it('requires an optional boolean and adds a prefix only to the final normalized token',()=>{
 const exact=catalogueSearchSQL({query:'Huel van'},now),live=catalogueSearchSQL({query:'Huel van',prefixMatch:true},now);
 assert.deepEqual(catalogueSearchSQL({query:'Huel van',prefixMatch:false},now),exact);
 assert.equal(exact.count.values[0],'"huel" AND "van"');
 assert.equal(live.count.values[0],'"huel" AND "van"*');
 assert.equal(live.rows.values[0],live.count.values[0]);
 assert.equal(catalogueSearchSQL({query:'Natural yógurts',prefixMatch:true},now).count.values[0],'"natural" AND "yoghurt"*');
 assert.equal(catalogueSearchSQL({query:'huel" OR (van*)',prefixMatch:true},now).count.values[0],'"huel" AND "or" AND "van"*');
 assert.deepEqual(catalogueSearchSQL({query:'',prefixMatch:true},now).rows,catalogueSearchSQL({query:''},now).rows);
 for(const value of [null,undefined,0,1,'true','false',[],{}])assert.throws(()=>catalogueSearchSQL({query:'huel',prefixMatch:value},now),error=>error.code==='catalogue_request_invalid');
});

it('finds partial Huel and yoghurt words without widening earlier words or accepting FTS operators',async()=>{
 const {sql,db}=fixture();
 await load(db,[food('5000000000001','Vanilla',{brands:'Huel',categories_tags:[]}),food('5000000000002','Natural yogurt',{categories_tags:['en:yogurts']}),food('5000000000003','Natural yoghurt',{stores:'Sainsburys',categories_tags:['en:yogurts']})]);
 for(const query of ['hu','hue','huel van']){
  assert.equal((await search(db,{query,prefixMatch:true})).products[0].code,'5000000000001');
  assert.equal((await search(db,{query})).total,0,'An explicit exact search keeps existing token semantics');
 }
 assert.equal((await search(db,{query:'huel',prefixMatch:true})).total,1);
 assert.equal((await search(db,{query:'natural yoghur',prefixMatch:true,store:'tesco'})).total,1);
 assert.equal((await search(db,{query:'natural yoghur',store:'tesco'})).total,0);
 for(const query of ['hue van','huel OR yoghurt','huel" OR (yoghur*)','huel NOT vanilla'])assert.equal((await search(db,{query,prefixMatch:true})).total,0);
 assert.equal(sql.prepare('SELECT count(*) AS n FROM catalogue_products').get().n,3);
 sql.close();
});

it('preserves filtered pagination, evidence, freshness and ratings for live prefixes',async()=>{
 const {sql,db}=fixture();
 await load(db,[food('5000000000001','Alpha beans',{labels_tags:['en:no-gluten']}),food('5000000000002','Beta beans',{labels_tags:['en:no-gluten']}),food('5000000000003','Other beans',{labels_tags:['en:no-gluten'],stores:'Sainsburys'}),food('5000000000004','Conflicting beans',{labels_tags:['en:no-gluten'],ingredients_text:'Wheat gluten, beans'}),food('5000000000005','Unconfirmed beans')]);
 const snapshot=sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all();
 for(const sort of ['relevance','ratingHighest','ratingLowest','nameAscending','nameDescending'])for(const page of [1,2]){
  const options={store:'tesco',placeID:'tesco',dietary:['gluten'],categoryTags:['en:baked-beans'],sort,page,pageSize:1,minimumRating:0};
  const exact=await search(db,{...options,query:'beans'}),live=await search(db,{...options,query:'bea',prefixMatch:true});
  assert.equal(live.total,2);assert.deepEqual(live,exact);
  assert.deepEqual(live.discovery.excludedDietary,{conflicting:1,unconfirmed:1});
  assert.equal(live.places.evidence[0].sourceFingerprint,live.ratings[0].sourceFingerprint);
 }
 assert.deepEqual(sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all(),snapshot,'Reads do not rewrite scores, source facts or provenance');
 sql.close();
});

function delayedReads(db){
 const started=new Set(),gates=new Map(),gate=label=>{if(!gates.has(label))gates.set(label,Promise.withResolvers());return gates.get(label);};
 const kind=q=>q.startsWith('SELECT a.barcode')?'placeEvidence':q.startsWith('SELECT d.barcode')?'discoveryEvidence':q.startsWith('SELECT barcode,tags_json')?'supportTags':q.includes('LEFT JOIN catalogue_places')?'placeCoverage':q.includes('LEFT JOIN catalogue_discovery')?'discoveryCoverage':q.startsWith('SELECT (SELECT count(*)')?'supportCoverage':null;
 const wrap=(statement,q)=>{
  const read=method=>async()=>{const label=kind(q);if(label){started.add(label);await gate(label).promise;}return statement[method]();};
  return {...statement,bind:(...v)=>wrap(statement.bind(...v),q),all:read('all'),first:read('first')};
 };
 return {started,gate,db:{prepare:q=>wrap(db.prepare(q),q),batch:async statements=>{started.add('page');await gate('page').promise;return db.batch(statements);}},release:()=>{for(const g of gates.values())g.resolve();}};
}

it('starts uncached coverage with the page and hydrates all independent page evidence concurrently',async()=>{
 const {sql,db}=fixture();await load(db,[food('5000000000001','Beans')]);
 const expected=await search(db,{query:'bea',prefixMatch:true}),delayed=delayedReads(db);
 const result=search(delayed.db,{query:'bea',prefixMatch:true});
 await nextTurn();
 try{
  assert.deepEqual([...delayed.started].sort(),['discoveryCoverage','page','placeCoverage','supportCoverage']);
  delayed.gate('page').resolve();await nextTurn();
  assert.deepEqual([...delayed.started].sort(),['discoveryCoverage','discoveryEvidence','page','placeCoverage','placeEvidence','supportCoverage','supportTags']);
 }finally{delayed.release();}
 assert.deepEqual(await result,expected);sql.close();
});

it('the actual index route starts its page and all evidence before cached coverage resolves',async()=>{
 const {sql,db}=fixture();await load(db,[food('5000000000001','Beans')]);
 const expected=await search(db,{query:'bea',prefixMatch:true}),delayed=delayedReads(db),coverage=Promise.withResolvers();
 const instance=Object.create(FoodCatalogueIndex.prototype);instance.db=delayed.db;
 instance.searchCoverage=()=>{delayed.started.add('cachedCoverage');return coverage.promise;};
 const response=instance.fetch(new Request('https://catalogue-index/search',{method:'POST',body:JSON.stringify({query:'bea',prefixMatch:true})}));
 await nextTurn();
 try{
  assert.deepEqual([...delayed.started].sort(),['cachedCoverage','page']);
  delayed.gate('page').resolve();await nextTurn();
  assert.deepEqual([...delayed.started].sort(),['cachedCoverage','discoveryEvidence','page','placeEvidence','supportTags']);
 }finally{coverage.resolve({places:expected.places.coverage,discovery:expected.discovery.coverage,support:expected.support});delayed.release();}
 const reply=await response;assert.equal(reply.status,200);const actual=await reply.json();
 assert.ok(actual.catalogue.generatedAt>=expected.catalogue.generatedAt);actual.catalogue.generatedAt=expected.catalogue.generatedAt;
 assert.deepEqual(actual,expected);sql.close();
});

it('validates live query bodies before starting page or coverage reads',async()=>{
 const instance=Object.create(FoodCatalogueIndex.prototype);
 instance.db={prepare:()=>assert.fail('Invalid input must not query storage')};
 instance.searchCoverage=()=>assert.fail('Invalid input must not query coverage');
 const response=await instance.fetch(new Request('https://catalogue-index/search',{method:'POST',body:JSON.stringify({query:'beans',prefixMatch:'true'})}));
 assert.equal(response.status,400);assert.equal((await response.json()).code,'catalogue_request_invalid');
});

it('propagates either coverage or page evidence failures instead of publishing incomplete evidence',async()=>{
 const {sql,db}=fixture();await load(db,[food('5000000000001','Beans')]);
 await assert.rejects(search(db,{query:'bea',prefixMatch:true},{coverage:()=>Promise.reject(new Error('coverage failed'))}),/coverage failed/);
 const failing={...db,prepare(q){const s=db.prepare(q);return q.startsWith('SELECT a.barcode')?{bind:()=>({all:async()=>{throw new Error('evidence failed');}})}:s;}};
 await assert.rejects(search(failing,{query:'bea',prefixMatch:true}),/evidence failed/);
 sql.close();
});

it('omits optional catalogue censuses while retaining identical products, ratings and filtered page evidence',async()=>{
 const {sql,db}=fixture();
 await load(db,[food('5000000000001','Alpha beans',{labels_tags:['en:no-gluten']}),food('5000000000002','Beta beans',{labels_tags:['en:no-gluten']}),food('5000000000003','Conflicting beans',{labels_tags:['en:no-gluten'],ingredients_text:'Wheat gluten, beans'})]);
 const before=sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all();
 for(const value of [null,undefined,0,1,'true','false',[],{}])assert.throws(()=>catalogueSearchSQL({query:'beans',includeCoverage:value},now),error=>error.code==='catalogue_request_invalid');
 for(const sort of ['relevance','ratingHighest','ratingLowest','nameAscending','nameDescending'])for(const page of [1,2]){
  const options={query:'bea',prefixMatch:true,placeID:'tesco',dietary:['gluten'],page,pageSize:1,sort};
  const expected=await search(db,options);
  const noCensus={...db,prepare(q){
   assert.ok(!q.includes(' AS processed')&&!q.startsWith('SELECT (SELECT count(*)'),'Interactive results must not run aggregate coverage scans');
   return db.prepare(q);
  }};
  const actual=await search(noCensus,{...options,includeCoverage:false},{coverage:()=>assert.fail('Coverage cache must not be requested')});
  delete expected.places.coverage;delete expected.discovery.coverage;delete expected.support;
  assert.deepEqual(actual,expected,'Only optional aggregate metadata is omitted');
 }
 assert.deepEqual(sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all(),before);
 const instance=Object.create(FoodCatalogueIndex.prototype);instance.db=db;
 instance.searchCoverage=()=>assert.fail('Actual interactive route must skip coverage');
 const response=await instance.fetch(new Request('https://catalogue-index/search',{method:'POST',body:JSON.stringify({query:'bea',prefixMatch:true,includeCoverage:false})}));
 assert.equal(response.status,200);const wire=await response.json();
 assert.equal(Object.hasOwn(wire.discovery,'coverage'),false);
 assert.equal(Object.hasOwn(wire.places,'coverage'),false);
 assert.equal(Object.hasOwn(wire,'support'),false);
 const failing={...db,prepare(q){const s=db.prepare(q);return q.startsWith('SELECT a.barcode')?{bind:()=>({all:async()=>{throw new Error('evidence failed');}})}:s;}};
 await assert.rejects(search(failing,{query:'bea',prefixMatch:true,includeCoverage:false}),/evidence failed/,'Optional census does not weaken per-product evidence');
 sql.close();
});

it('matches the frozen native wire fixture and removes only legacy null census fields',async()=>{
 const clock=Date.parse('2026-10-15T14:00:00Z'),{sql,db}=fixture();
 await importCatalogue(db,{products:[food('5000000000001','Catalogue test beans')],sourceURL,fetchedAt:clock},{now:clock});
 const result=await searchCatalogue(db,{query:'bea',prefixMatch:true,includeCoverage:false},{now:clock,coverage:()=>assert.fail('Unrequested coverage must not run')});
 const load=name=>JSON.parse(readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8'));
 assert.deepEqual(result,load('catalogue-search-no-coverage.json'));
 // Captured from the actual pre-fix searchCatalogue output using this same
 // synthetic public product and frozen clock; native tests retain this shape.
 const legacy=load('catalogue-search-no-coverage-legacy-null.json');
 assert.equal(legacy.support,null);assert.equal(legacy.discovery.coverage,null);assert.equal(legacy.places.coverage,null);
 delete legacy.support;delete legacy.discovery.coverage;delete legacy.places.coverage;
 assert.deepEqual(result,legacy,'No products, scoring provenance, page evidence or other fields change');
 sql.close();
});
