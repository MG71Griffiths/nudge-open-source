import {it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter} from '../src/catalogue-index-object.js';
import {catalogueSearchSQL,importCatalogue,searchCatalogue} from '../src/catalogue-index.js';
import {AISLES,NUTRITION_IDS,evaluateDiscovery} from '../src/catalogue-discovery.js';

const now=Date.now(),sourceURL='https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz';
const code=n=>String(5000000800000+n);
const food=(n,name,extra={})=>({code:code(n),product_name:name,brands:'Test fixture',countries_tags:['en:united-kingdom'],stores:'Tesco',
 categories_tags:['en:breads'],ingredients_text:'Wholemeal wheat flour, water',nutrition_data_per:'100g',
 nutriments:{'energy-kcal_100g':320,proteins_100g:20,carbohydrates_100g:50,fat_100g:4,'saturated-fat_100g':1,sugars_100g:2,fiber_100g:8,salt_100g:.3,iron_100g:.003,calcium_100g:.2,'vitamin-d_100g':.000002},...extra});
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');sql.exec(catalogueSchema);
 const storage={sql:{exec:(q,...v)=>({toArray:()=>sql.prepare(q).all(...v)})},transactionSync:fn=>{
  sql.exec('BEGIN');try{const result=fn();sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}
 }};
 return {sql,db:catalogueSQLAdapter(storage)};
}
async function load(db,products){await importCatalogue(db,{products,sourceURL,fetchedAt:now},{now});}
// Controlled score fixtures isolate ranking from the separately tested score
// calculation. No source nutrient/ingredient field is changed by the query.
function scores(sql,values){for(const [n,value] of values.entries())sql.prepare('UPDATE catalogue_products SET rating_value=? WHERE barcode=?').run(value,code(n+1));}
async function pages(db,options,pageSize=2){
 const rows=[];let result;
 for(let page=1;page<=10;page++){
  result=await searchCatalogue(db,{...options,pageSize,page,includeCoverage:false},{now});
  rows.push(...result.products.map(p=>p.code));if(!result.hasMore)break;
 }
 assert.equal(new Set(rows).size,rows.length,'Stable pages never repeat a barcode');assert.equal(rows.length,result.total);
 return rows;
}

it('ranks every aisle and nutrition browse by current Nudge score before pagination',async()=>{
 const {sql,db}=fixture();
 // Membership fixtures cover all existing routes without claiming that one
 // real product belongs to every aisle. Their actual nutrient evidence is valid.
 const categories_tags=[...new Set(Object.values(AISLES).flat())].map(tag=>'en:'+tag);
 await load(db,['Alpha low','Beta zero','Gamma good','Zed best','Unknown'].map((name,i)=>food(i+1,name,{categories_tags})));
 scores(sql,[25,0,50,100,null]);
 const before=sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all();
 for(const options of [...Object.keys(AISLES).map(aisle=>({aisle})),{store:'tesco'},{}]){
  assert.deepEqual(await pages(db,options),[4,3,1,2,5].map(code),JSON.stringify(options));
 }
 assert.deepEqual(sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all(),before,'Browsing never writes facts, nutrition or scores');
 sql.close();
});

it('ranks all nutrition choices using their own required source evidence',async()=>{
 const {sql,db}=fixture();await load(db,['Alpha low','Beta zero','Gamma good','Zed best','Unknown'].map((name,i)=>food(i+1,name)));scores(sql,[25,0,50,100,null]);
 for(const nutrition of NUTRITION_IDS)assert.deepEqual(await pages(db,{nutrition:[nutrition]}),[4,3,1,2,5].map(code),nutrition);
 sql.close();
});

it('interleaves repeated names only at identical scores, with stable complete pagination',async()=>{
 const {sql,db}=fixture();
 await load(db,[food(1,'A bread',{quantity:'400g'}),food(2,'A bread',{quantity:'800g'}),food(3,'A bread',{brands:'Another fixture'}),food(4,'B crispbread'),food(5,'Z bread'),food(6,'C lower'),food(7,'D unknown')]);
 scores(sql,[100,100,100,100,75,50,null]);
 const expected=[1,4,2,3,5,6,7].map(code);
 for(const size of [1,2,3,20])assert.deepEqual(await pages(db,{nutrition:['wholegrain']},size),expected);
 // Explicit sorts retain their ordinary name/barcode ties; text relevance is
 // still FTS relevance instead of silently becoming recommendation order.
 assert.deepEqual(await pages(db,{sort:'ratingHighest'}),[1,2,3,4,5,6,7].map(code));
 assert.deepEqual(await pages(db,{sort:'nameAscending'}),[1,2,3,4,6,7,5].map(code));
 assert.match(catalogueSearchSQL({query:'wholemeal'}).rows.sql,/bm25/);
 sql.close();
});

it('puts obsolete and absent ratings after genuine zero without weakening filters',async()=>{
 const {sql,db}=fixture();await load(db,[food(1,'Alpha old'),food(2,'Beta zero'),food(3,'Gamma good'),food(4,'Delta other',{stores:'Sainsburys'}),food(5,'Epsilon unknown')]);
 scores(sql,[100,0,50,100,null]);sql.prepare("UPDATE catalogue_products SET score_version='old' WHERE barcode=?").run(code(1));
 assert.deepEqual(await pages(db,{aisle:'bakery',store:'tesco'}),[3,2,1,5].map(code));
 assert.deepEqual(await pages(db,{aisle:'bakery',store:'tesco',minimumRating:50}),[code(3)]);
 sql.close();
});

it('preserves real iron and wholegrain requirements instead of treating a quality score as nutrient evidence',async()=>{
 const {sql,db}=fixture();
 await load(db,[food(1,'Fortified wholemeal bread'),food(2,'Iron wholegrain promise',{ingredients_text:'Wheat flour, water',nutriments:{...food(2,'').nutriments,iron_100g:0}}),food(3,'Wholegrain mustard',{ingredients_text:'Wholegrain mustard, water',nutriments:{...food(3,'').nutriments,iron_100g:undefined}})]);
 scores(sql,[50,100,100]);
 for(const nutrition of ['iron','wholegrain'])assert.deepEqual(await pages(db,{nutrition:[nutrition]}),[code(1)]);
 assert.equal(evaluateDiscovery(food(1,'Fixture bread')).nutrition.iron.value,3,'3 mg per100g source iron remains3 mg, not quality rating50');
 sql.close();
});

it('ranks narrow covering-index candidates and hydrates only a bounded page',()=>{
 const {sql}=fixture();
 for(const options of [{},{aisle:'bakery'},{nutrition:['iron']}]){
  const plan=catalogueSearchSQL(options,now),details=sql.prepare('EXPLAIN QUERY PLAN '+plan.rows.sql).all(...plan.rows.values).map(row=>row.detail);
  assert.ok(details.some(detail=>/COVERING INDEX catalogue_(?:rating|search)_candidates/.test(detail)),details.join('\n'));
  assert.ok(details.some(detail=>/SEARCH p USING INTEGER PRIMARY KEY/.test(detail)),details.join('\n'));
  assert.match(plan.rows.sql,/fast_page AS \([\s\S]*LIMIT \? OFFSET \?[\s\S]*slow_page AS \([\s\S]*LIMIT \? OFFSET \?/);
  assert.match(plan.rows.sql,/SELECT p\.\* FROM page_candidates c CROSS JOIN catalogue_products p ON p\.rowid=c\.product_rowid/);
  if(options.aisle||options.nutrition)assert.ok(details.some(detail=>/COVERING INDEX catalogue_discovery_sources/.test(detail)),details.join('\n'));
 }
 sql.close();
});

it('matches complete ranking at exact fast prefixes, duplicate variants and score-tier boundaries',async()=>{
 const {sql,db}=fixture();
 const products=Array.from({length:44},(_,i)=>food(i+1,'Bread '+String(i%42).padStart(2,'0')));
 await load(db,products);scores(sql,products.map((_,i)=>i<41||i>=42?100:75));
 // 41 distinct top-score names: page2 is a full fast prefix, page3 must
 // include both duplicate packs before the lower score, without repeats.
 const expected=[...Array.from({length:41},(_,i)=>i+1),43,44,42].map(code);
 assert.deepEqual(await pages(db,{nutrition:['wholegrain']},20),expected);
 const rowQuery=page=>{const p=catalogueSearchSQL({nutrition:['wholegrain'],page,pageSize:20},now);return sql.prepare(p.rows.sql).all(...p.rows.values).map(r=>r.barcode);};
 assert.deepEqual(rowQuery(2),expected.slice(20,40));
 // Exactly40 distinct top names and then just39 exercise both sides of
 // the prefix proof for page2; ranking remains independent of branch.
 for(const n of [41,40]){
  sql.prepare('UPDATE catalogue_products SET rating_value=75 WHERE barcode=?').run(code(n));
  const top=Array.from({length:n-1},(_,i)=>i+1),lower=Array.from({length:43-n},(_,i)=>n+i);
  const ordered=[...top,43,44,...lower].map(code);
  assert.deepEqual(await pages(db,{nutrition:['wholegrain']},20),ordered);
 }
 sql.close();
});

it('keeps fast browsing source-bound across intersecting filters and falls back for unrated rows',async()=>{
 const {sql,db}=fixture();
 const products=Array.from({length:25},(_,i)=>food(i+1,'Bread '+String(i+1).padStart(2,'0'),{brands:'Pret',labels_tags:['en:no-gluten','en:no-milk']}));
 await load(db,products);scores(sql,products.map(()=>100));
 const options={placeID:'pret',aisle:'bakery',store:'tesco',categoryTags:['en:breads'],dietary:['gluten','milk'],nutrition:['iron','wholegrain'],nutritionMode:'all',minimumRating:50};
 sql.prepare("UPDATE catalogue_discovery SET source_fingerprint='stale' WHERE barcode=?").run(code(1));
 sql.prepare("UPDATE catalogue_places SET source_fingerprint='stale' WHERE barcode=?").run(code(2));
 sql.prepare("UPDATE catalogue_products SET score_version='obsolete' WHERE barcode=?").run(code(3));
 assert.deepEqual(await pages(db,options,20),Array.from({length:22},(_,i)=>code(i+4)));
 sql.exec('UPDATE catalogue_products SET rating_value=NULL');
 const allUnrated={...options,minimumRating:undefined};
 assert.deepEqual(await pages(db,allUnrated,20),Array.from({length:23},(_,i)=>code(i+3)));
 assert.deepEqual(await pages(db,{...options,minimumRating:50},20),[]);
 sql.close();
});
