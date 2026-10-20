// Local-only scale proof of production discovery SQL. Synthetic products;
// no deployed database, source provider, image job or AI calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {searchCatalogue} from '../src/catalogue-index.js';
import {DISCOVERY_VERSION} from '../src/catalogue-discovery.js';
import {PLACE_VERSION} from '../src/catalogue-places.js';
import {ScoreCore} from '../src/nutrition-core.js';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const directory=mkdtempSync(join(tmpdir(),'nudge-discovery-scale-'));
const cases=[{name:'Fruit aisle',body:{aisle:'fruit'}},{name:'Gluten-free bread',body:{aisle:'bakery',dietary:['gluten']}},{name:'Milk-free and gluten-free bread',body:{aisle:'bakery',dietary:['gluten','milk']}},{name:'Protein or fibre',body:{nutrition:['protein','fibre'],nutritionMode:'any'}},{name:'Protein and fibre',body:{nutrition:['protein','fibre'],nutritionMode:'all'}},{name:'Alphabetical descending',body:{aisle:'fruit',sort:'nameDescending'}},{name:'Rating highest',body:{aisle:'fruit',sort:'ratingHighest'}}];
cases.push({name:'Chain products',body:{placeID:'greggs'}},{name:'Chain with dietary and nutrition',body:{placeID:'greggs',dietary:['gluten'],nutrition:['protein','fibre'],nutritionMode:'all'}},{name:'Chain rating order',body:{placeID:'greggs',sort:'ratingHighest'}});
async function searchQueries(body){
 const queries=[];const db={prepare(sql){return{bind:(...values)=>({sql,values})};},async batch(items){queries.push(...items);return items.map(()=>({results:[]}));}};
 await searchCatalogue(db,body,{coverage:{discovery:{},support:{},places:{}}});return queries;
}
const seedSQL=`WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
 INSERT INTO catalogue_products(barcode,name,brand,name_sort,search_text,is_uk,provider_json,source_revision,source_fingerprint,fetched_at,expires_at,source_url,licence_url,import_source_url,score_json,rating_value,score_method,score_version,classifier_version,calculated_at)
 SELECT printf('%013d',5000000000000+x),'Synthetic food','Synthetic',printf('food %06d',x),'synthetic food',1,?,1,'synthetic-source',1,9999999999999,'https://example.org','https://example.org','https://example.org','{"available":false}',x%101,?,?,?,1 FROM n`;
const filterSQL=[
 "INSERT INTO catalogue_discovery_filters SELECT barcode,'aisle',CASE WHEN rowid%100=0 THEN 'fruit' WHEN rowid%10=0 THEN 'bakery' ELSE 'drinks' END FROM catalogue_products",
 "INSERT INTO catalogue_discovery_filters SELECT barcode,CASE WHEN rowid%5=0 THEN 'dietary_supported' ELSE 'dietary_unconfirmed' END,'gluten' FROM catalogue_products",
 "INSERT INTO catalogue_discovery_filters SELECT barcode,CASE WHEN rowid%7=0 THEN 'dietary_conflicting' WHEN rowid%11=0 THEN 'dietary_supported' ELSE 'dietary_unconfirmed' END,'milk' FROM catalogue_products",
 "INSERT INTO catalogue_discovery_filters SELECT barcode,CASE WHEN rowid%2=0 THEN 'nutrition_supported' ELSE 'nutrition_conflicting' END,'protein' FROM catalogue_products",
 "INSERT INTO catalogue_discovery_filters SELECT barcode,CASE WHEN rowid%3=0 THEN 'nutrition_supported' ELSE 'nutrition_conflicting' END,'fibre' FROM catalogue_products"
];
const script=`
export class DiscoveryBenchmark {
 constructor(ctx){this.ctx=ctx;this.sql=ctx.storage.sql;this.sql.exec(${JSON.stringify(catalogueSchema)});}
 async fetch(request){
  if(new URL(request.url).pathname==='/seed'){
   const count=179245,started=Date.now();
   this.ctx.storage.transactionSync(()=>{
    this.sql.exec(${JSON.stringify(seedSQL)},count,JSON.stringify({synthetic:'x'.repeat(2048)}),${JSON.stringify(ScoreCore.SCORE_METHOD)},${JSON.stringify(ScoreCore.SCORE_VERSION)},${JSON.stringify(ScoreCore.CLASSIFIER_VERSION)});
    this.sql.exec('INSERT INTO catalogue_discovery SELECT barcode,source_fingerprint,?,?,1 FROM catalogue_products',${JSON.stringify(DISCOVERY_VERSION)},JSON.stringify({synthetic:'x'.repeat(2048)}));
    this.sql.exec('INSERT INTO catalogue_places SELECT barcode,source_fingerprint,?,?,1 FROM catalogue_products',${JSON.stringify(PLACE_VERSION)},JSON.stringify({synthetic:'x'.repeat(512)}));
    this.sql.exec("INSERT INTO catalogue_place_memberships SELECT barcode,'greggs','brand','source_metadata' FROM catalogue_products WHERE rowid%40=0");
    this.sql.exec("INSERT INTO catalogue_place_memberships SELECT barcode,'greggs','retailer','source_metadata' FROM catalogue_products WHERE rowid%100=0");
    for(const sql of ${JSON.stringify(filterSQL)})this.sql.exec(sql);
   });return Response.json({seeded:count,elapsedMs:Date.now()-started});
  }
  const {queries}=await request.json(),started=Date.now();
  const results=queries.map(({sql,values})=>this.sql.exec(sql,...values).toArray());
  return Response.json({elapsedMs:Date.now()-started,counts:results.map(rows=>rows[0]?.total??rows.length),codes:(results[1]||[]).map(row=>row.barcode).filter(Boolean)});
 }
}
export default{fetch(request,env){return env.BENCH.get(env.BENCH.idFromName('synthetic')).fetch(request);}};
`;
const mf=new Miniflare(convertV4MiniflareOptions({resourcePersistencePath:directory,workers:[{name:'discovery-scale',modules:true,script,compatibilityDate:'2026-09-01',durableObjects:{BENCH:{className:'DiscoveryBenchmark',useSQLite:true}}}]}));
try{
 let response=await mf.dispatchFetch('https://local/seed');assert.equal(response.status,200);console.log(JSON.stringify(await response.json()));
 for(const {name,body} of cases){
  const queries=await searchQueries(body);
  response=await mf.dispatchFetch('https://local/query',{method:'POST',body:JSON.stringify({queries})});assert.equal(response.status,200);const result=await response.json();assert.equal(result.codes.length,20);assert.equal(new Set(result.codes).size,20);assert.ok(result.elapsedMs<5000,`${name} must not approach the app timeout`);console.log(JSON.stringify({name,...result}));
 }
 response=await mf.dispatchFetch('https://local/query',{method:'POST',body:JSON.stringify({queries:[{sql:'SELECT count(*) AS total,sum(CASE WHEN d.rule_version=? AND d.source_fingerprint=p.source_fingerprint THEN 1 ELSE 0 END) AS processed FROM catalogue_products p INDEXED BY catalogue_discovery_sources LEFT JOIN catalogue_discovery d INDEXED BY catalogue_discovery_binding ON d.barcode=p.barcode',values:[DISCOVERY_VERSION]}]})});assert.equal(response.status,200);console.log(JSON.stringify({name:'Cold coverage aggregate',...await response.json()}));
 console.log('PASS: 179245 synthetic products with wide source/evidence JSON; production candidate SQL, real Workers SQLite and stable bounded pages.');
}finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
