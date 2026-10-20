import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter,FoodCatalogueIndex} from '../src/catalogue-index-object.js';
import {importCatalogue,searchCatalogue,patchCatalogueImages} from '../src/catalogue-index.js';
import {backfillWomensFoodTags,womensFoodTagStatus} from '../src/womens-food-tag-index.js';
import {WOMENS_FOOD_TAG_VERSION} from '../src/womens-food-tags.js';
import worker from '../src/worker.js';

const now=Date.now(),sourceURL='https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz';
function fixture(){
  const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');sql.exec(catalogueSchema);
  const storage={sql:{exec:(query,...values)=>({toArray:()=>sql.prepare(query).all(...values)})},transactionSync:callback=>{sql.exec('BEGIN');try{const result=callback();sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  return {sql,db:catalogueSQLAdapter(storage),storage};
}
function food(code,extra={}){return {code,product_name:'Bananas',countries_tags:['en:united-kingdom'],categories_tags:['en:bananas'],last_modified_t:1700000000,stores:'Tesco',...extra};}
const load=(db,products)=>importCatalogue(db,{products,sourceURL,fetchedAt:now},{now});
describe('public candidate tag projection',()=>{
  it('classifies new imports without changing scores and filters before sorting/pagination',async()=>{
    const {db,sql}=fixture();await load(db,[food('5000000000001'),food('5000000000002',{stores:'Sainsburys'}),food('5000000000003',{product_name:'Orange sweets',categories_tags:['en:sweets']})]);
    const before=sql.prepare('SELECT barcode,score_json,rating_value FROM catalogue_products ORDER BY barcode').all();
    const all=await searchCatalogue(db,{supportContext:'luteal',sort:'nameAscending',pageSize:1},{now});
    assert.equal(all.total,2);assert.equal(all.products.length,1);assert.equal(all.hasMore,true);assert.equal(all.support.complete,true);
    assert.equal(all.supportTags[0].barcode,all.products[0].code);assert.ok(all.supportTags[0].tags.some(t=>t.contexts.includes('luteal')));
    assert.equal((await searchCatalogue(db,{supportContext:'luteal',store:'tesco'},{now})).total,1);
    assert.equal((await searchCatalogue(db,{supportContext:'luteal',query:'sweets'},{now})).total,0);
    assert.deepEqual(sql.prepare('SELECT barcode,score_json,rating_value FROM catalogue_products ORDER BY barcode').all(),before);
    await assert.rejects(()=>searchCatalogue(db,{supportContext:'cure_anxiety'},{now}));
  });
  it('backfills every record including unclassified foods, resumes and keeps the catalogue snapshot intact',async()=>{
    const {db,sql}=fixture();await load(db,[food('5000000000001'),food('5000000000002',{product_name:'Unknown product',categories_tags:[]}),food('5000000000003')]);
    sql.exec('DELETE FROM catalogue_womens_food_tags');
    const snapshot=sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all();
    assert.equal((await womensFoodTagStatus(db)).complete,false);
    const first=await backfillWomensFoodTags(db,{limit:2},{now});assert.equal(first.updated,2);assert.equal(first.hasMore,true);
    const last=await backfillWomensFoodTags(db,{after:first.nextAfter,limit:2},{now});assert.equal(last.updated,1);assert.equal(last.hasMore,false);
    const status=await womensFoodTagStatus(db,{details:true});assert.equal(status.processed,3);assert.equal(status.complete,true);assert.equal(status.tagged,2);
    assert.equal((await backfillWomensFoodTags(db,{limit:2},{now})).updated,0);
    assert.deepEqual(sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all(),snapshot);
    sql.prepare('UPDATE catalogue_womens_food_tags SET rule_version=?').run('old');
    sql.prepare('UPDATE catalogue_womens_food_contexts SET rule_version=?').run('old');
    assert.equal((await searchCatalogue(db,{supportContext:'luteal'},{now})).total,0);
    await backfillWomensFoodTags(db,{limit:10},{now});assert.equal((await womensFoodTagStatus(db)).version,WOMENS_FOOD_TAG_VERSION);
  });
  it('preserves tags through image patches while invalidating changed food evidence immediately',async()=>{
    const {db,sql}=fixture();await load(db,[food('5000000000001')]);
    const before=sql.prepare('SELECT * FROM catalogue_womens_food_tags').get();
    await patchCatalogueImages(db,{sourceURL,retrievedAt:now,records:[{barcode:'5000000000001',sourceRevision:1700000000,imageFrontURL:'https://images.openfoodfacts.org/images/products/500/000/000/0001/front_en.4.400.jpg'}]},{now});
    assert.deepEqual(sql.prepare('SELECT * FROM catalogue_womens_food_tags').get(),before);
    assert.equal((await searchCatalogue(db,{supportContext:'luteal'},{now})).total,1);
    sql.prepare("UPDATE catalogue_products SET provider_json=json_set(provider_json,'$.product_name','Orange sweets','$.categories_tags',json('[\"en:sweets\"]')) WHERE barcode=?").run('5000000000001');
    assert.equal((await searchCatalogue(db,{supportContext:'luteal'},{now})).total,0);
    assert.equal((await womensFoodTagStatus(db)).processed,0);
  });
  it('rejects oversized or personal backfill input and requires administration authentication',async()=>{
    const {storage}=fixture(),instance=new FoodCatalogueIndex({storage},{});
    for(const body of [{limit:251},{after:'injected'},{symptoms:['pain']},{statusOnly:'true'}]){
      const response=await instance.fetch(new Request('https://catalogue/support-tags',{method:'POST',body:JSON.stringify(body)}));assert.equal(response.status,400);
    }
    const response=await worker.fetch(new Request('https://nudge.example/v1/catalogue/support-tags',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{CATALOGUE_ADMIN_TOKEN_SHA256:'a'.repeat(64)});
    assert.equal(response.status,401);
  });
});
