import {it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {catalogueRecordFromPayload} from '../src/food-catalogue.js';
import {buildCatalogueRow,catalogueWriteStatements,batchCatalogue,searchCatalogue} from '../src/catalogue-index.js';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter} from '../src/catalogue-index-object.js';
import {ScoreCore} from '../src/nutrition-core.js';
import {admitCatalogueScoreEvidence,applyCatalogueScoreEvidenceStatements,rememberCatalogueScoreEvidence} from '../src/catalogue-score-evidence.js';

const now=1_791_388_800_000,barcode='1234567890123',source='https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz';
const raw=()=>({code:barcode,product_name:'Dhal makhani',brands:'Example Foods',countries_tags:['en:united-kingdom'],categories_tags:['en:dhal-makhani'],last_modified_t:1_700_000_000,
 ingredients_text:'Lentils (60%), tomatoes (10%), water, cream, salt',nutriments:{'energy-kcal_100g':110,'energy-kj_100g':460,proteins_100g:6,carbohydrates_100g:14,sugars_100g:2,fat_100g:3,'saturated-fat_100g':1,fiber_100g:4,salt_100g:.5}});
async function fixture(extra={}) {
 const p={...raw(),...extra},row=await buildCatalogueRow(p,{fetchedAt:now-1000,source,now});
 const product=catalogueRecordFromPayload({product:p},barcode,row.fetched_at).product;
 const classification=ScoreCore.validateClassification(product,{category:'general',evidence:[{field:'name',quote:product.name}],sweeteners:'unknown',sweetenerEvidence:[]});
 const score=ScoreCore.calculateScore(product,classification);return {row,product,score};
}
function database(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');sql.exec(catalogueSchema);
 const storage={sql:{exec:(query,...values)=>({toArray:()=>sql.prepare(query).all(...values)})},transactionSync:callback=>{sql.exec('BEGIN');try{const result=callback();sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
 return {sql,db:catalogueSQLAdapter(storage)};
}
const writeRow=(db,row)=>db.batch(catalogueWriteStatements(row).map(({sql,values})=>db.prepare(sql).bind(...values)));
const copy=value=>structuredClone(value);

it('admits grounded public classification and recalculates every numeric result',async()=>{
 const {row,product,score}=await fixture();assert.equal(ScoreCore.calculateScore(product).status,ScoreCore.ACTIVE_DIRECTIONAL?'rated':'unrated');assert.equal(score.status,'rated');
 const altered={...score,value:1,rawScore:999,components:{},model:'PRIVATE MODEL FIELD',inputHash:'private hash'};
 const admitted=await admitCatalogueScoreEvidence(row,product,altered,{now});assert.ok(admitted);
 assert.equal(admitted.score.value,score.value);assert.equal(admitted.score.rawScore,score.rawScore);
 assert.deepEqual(admitted.score.components,score.components);assert.equal(admitted.classifierVersion,ScoreCore.CLASSIFIER_VERSION);
 assert.doesNotMatch(JSON.stringify(admitted),/PRIVATE MODEL FIELD|private hash/);
 assert.equal(admitted.score.sourceData.retrievedAt,product.retrievedAt);
 assert.match(admitted.factsFingerprint,/^[a-f0-9]{64}$/);
});

it('matches real scoreFacts empty-field/category representations and only known native source aliases',async()=>{
 const {row,product,score}=await fixture(),context={window:{}};
 vm.runInNewContext(readFileSync(new URL('../../Web/food-detail-model.js',import.meta.url),'utf8'),context);
 const native=JSON.parse(JSON.stringify(context.window.NudgeFoodDetailModel.scoreFacts(product)));
 for(const key of Object.keys(native))if(native[key]===''||key==='nutritionDataSource')delete native[key];
 if(!native.scoringFacts.source)delete native.scoringFacts;
 for(const item of native.ingredientItems){for(const key of Object.keys(item))if(item[key]===''||item[key]===null)delete item[key];}
 if(native.energyKj.value===null)delete native.energyKj;
 native.nutrientSources.energyKj='Open Food Facts legacy nutriments';
 const admitted=await admitCatalogueScoreEvidence(row,native,score,{now});assert.ok(admitted);
 assert.equal(admitted.factsFingerprint,(await admitCatalogueScoreEvidence(row,product,score,{now})).factsFingerprint);
 native.nutrientSources.energyKj='Private photo extraction';assert.equal(await admitCatalogueScoreEvidence(row,native,score,{now}),null);
});

it('rejects any changed identity, source, preparation, nutrition, inequality or ingredient fact',async()=>{
 const {row,product,score}=await fixture();
 const changes=[p=>p.name+=' low fat',p=>p.brand='Different brand',p=>p.barcode='1234567890124',p=>p.sourceName='Photo label extraction',
  p=>p.sourceURL='https://example.org/product/'+barcode,p=>p.basisUnit='ml',p=>p.nutritionPreparation='prepared',p=>p.categories=['en:beverages'],
  p=>p.ingredients+=' PRIVATE DIARY',p=>p.ingredientItems=[{text:'milk',percent:50}],p=>p.ingredientsNeedsReview=true,
  p=>p.nutrients.salt.value=.1,p=>p.nutrients.salt.status='confirmed',p=>p.nutrients.salt.relation='lt',p=>p.nutrients.fibre.status='estimated',
  p=>p.energyKj.value=459,p=>p.unresolvedFields=['identity'],p=>p.nutrientSources.fat='User supplied',p=>p.photo='private photo',
  p=>p.ingredientsAnalysisTags=['en:vegan'],p=>p.scoringFacts={source:'user',isBeverage:false}];
 for(const change of changes){const candidate=copy(product);change(candidate);assert.equal(await admitCatalogueScoreEvidence(row,candidate,score,{now}),null,change.toString());}
});

it('rejects invalid quotes, category conflicts, expired rows, changed source snapshots and stale engines',async()=>{
 const {row,product,score}=await fixture();
 for(const altered of [
  {...score,classificationEvidence:{...score.classificationEvidence,evidence:[{field:'name',quote:'Not this public food'}]}},
  {...score,classificationEvidence:{...score.classificationEvidence,conflicts:['incompatible_source_categories']}},
  {...score,classificationEvidence:{...score.classificationEvidence,version:'old'}},
  {...score,methodId:'external'}, {...score,version:'old'}, {...score,status:'estimated'}, {...score,available:false},
  {...score,recovery:{status:'verified',addedFields:['fibre']}}, {...score,recovery:{status:'estimated',estimate:{score:{value:100}}}}
 ])assert.equal(await admitCatalogueScoreEvidence(row,product,altered,{now}),null);
 for(const changed of [{...row,expires_at:now},{...row,fetched_at:now+1},{...row,source_fingerprint:'0'.repeat(64)},
  {...row,provider_json:JSON.stringify({...raw(),ingredients_text:'Changed recipe'})}])assert.equal(await admitCatalogueScoreEvidence(changed,product,score,{now}),null);
 const cheese=await fixture({product_name:'Cheese',categories_tags:['en:cheeses']});
 assert.equal(await admitCatalogueScoreEvidence(cheese.row,cheese.product,{...cheese.score,category:'general'},{now}),null);
});

it('does not fill unknown nutrients or promote provider estimates',async()=>{
 for(const variant of [
  {nutriments:{...raw().nutriments,salt_100g:undefined}},
  {nutrition:{aggregated_set:{per:'100g',preparation:'as_sold',nutrients:{proteins:{value:6,unit:'g',source:'estimate'}}}}}
 ]){
  const {row,product,score}=await fixture(variant);
  assert.equal(await admitCatalogueScoreEvidence(row,product,{...score,available:true,status:'provisional',methodId:ScoreCore.SCORE_METHOD,version:ScoreCore.SCORE_VERSION,
   classificationEvidence:{version:ScoreCore.CLASSIFIER_VERSION,evidence:[{field:'name',quote:product.name}],conflicts:[],resolutions:[]}},{now}),null);
 }
});

it('atomically updates searchable score and preserves source dates, facts and later-reader rating agreement',async()=>{
 const {row,product,score}=await fixture(),{sql,db}=database();await writeRow(db,row);
 assert.deepEqual(await rememberCatalogueScoreEvidence(db,{product,score},{now}),{stored:true});
 const stored=sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(barcode);
 for(const key of ['provider_json','source_fingerprint','source_revision','source_url','fetched_at','expires_at'])assert.equal(stored[key],row[key]);
 assert.equal(stored.rating_value,score.value);assert.equal(stored.calculated_at,now);
 const search=await searchCatalogue(db,{query:'dhal',minimumRating:score.value,sort:'ratingHighest'},{now});assert.equal(search.products.length,1);
 const batch=await batchCatalogue(db,{codes:[barcode]},{now});assert.deepEqual(search.ratings[0].score,batch.ratings[0].score);
 assert.equal(sql.prepare('SELECT count(*) AS n FROM catalogue_score_evidence').get().n,1);
 assert.deepEqual(await rememberCatalogueScoreEvidence(db,{product,score},{now:now+1}),{stored:true});
 assert.equal(sql.prepare('SELECT count(*) AS n FROM catalogue_score_evidence').get().n,1);
});

it('source changes and same-facts newer retrieval races cannot overwrite newer catalogue evidence',async()=>{
 for(const changeSource of [false,true]){
  const {row,product,score}=await fixture(),{sql,db}=database();await writeRow(db,row);
  const record=await admitCatalogueScoreEvidence(row,product,score,{now});assert.ok(record);
  const next=await buildCatalogueRow({...raw(),...(changeSource?{ingredients_text:'Lentils, water, cream, salt',last_modified_t:1_700_000_001}:{})},{fetchedAt:now+100,source,now:now+100});await writeRow(db,next);
  const results=await db.batch(applyCatalogueScoreEvidenceStatements(record).map(({sql,values})=>db.prepare(sql).bind(...values)));
  assert.equal(results[1].results.length,0);assert.equal(sql.prepare('SELECT count(*) AS n FROM catalogue_score_evidence').get().n,0);
  assert.equal(sql.prepare('SELECT score_json FROM catalogue_products WHERE barcode=?').get(barcode).score_json,next.score_json);
 }
});

it('ignores missing catalogue identities and blocks private extra body fields',async()=>{
 const {db}=database(),{product,score}=await fixture();
 assert.deepEqual(await rememberCatalogueScoreEvidence(db,{product,score},{now}),{stored:false});
 assert.deepEqual(await rememberCatalogueScoreEvidence(db,{product,score,owner:'private owner'},{now}),{stored:false});
});

it('retains accepted classification across an identical source import without changing evidence observation dates',async()=>{
 const {row,product,score}=await fixture(),{sql,db}=database();await writeRow(db,row);
 await rememberCatalogueScoreEvidence(db,{product,score},{now});
 const next=await buildCatalogueRow(raw(),{fetchedAt:now+100,source,now:now+100});await writeRow(db,next);
 const current=sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(barcode);
 assert.equal(current.rating_value,score.value);assert.equal(JSON.parse(current.score_json).category,'general');
 assert.equal(current.fetched_at,now+100);assert.equal(current.calculated_at,now+100);
 assert.equal(sql.prepare('SELECT calculated_at FROM catalogue_score_evidence').get().calculated_at,now);
 assert.equal(JSON.parse(current.score_json).sourceData.retrievedAt,product.retrievedAt);
});

it('does not reuse accepted classification for a changed provider source snapshot',async()=>{
 const {row,product,score}=await fixture(),{sql,db}=database();await writeRow(db,row);
 await rememberCatalogueScoreEvidence(db,{product,score},{now});
 const next=await buildCatalogueRow({...raw(),last_modified_t:1_700_000_001,nutriments:{...raw().nutriments,salt_100g:2}},{fetchedAt:now+100,source,now:now+100});await writeRow(db,next);
 const current=sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(barcode);
 assert.equal(current.score_json,next.score_json);assert.equal(current.source_fingerprint,next.source_fingerprint);
 assert.notEqual(sql.prepare('SELECT source_fingerprint FROM catalogue_score_evidence').get().source_fingerprint,next.source_fingerprint);
});

it('does not reuse classification from an obsolete method, classifier or admission policy',async()=>{
 for(const key of ['score_method','score_version','classifier_version','evidence_version']){
  const {row,product,score}=await fixture(),{sql,db}=database();await writeRow(db,row);
  await rememberCatalogueScoreEvidence(db,{product,score},{now});
  sql.prepare(`UPDATE catalogue_score_evidence SET ${key}=?`).run('old');
  const next=await buildCatalogueRow(raw(),{fetchedAt:now+100,source,now:now+100});await writeRow(db,next);
  assert.equal(sql.prepare('SELECT score_json FROM catalogue_products WHERE barcode=?').get(barcode).score_json,next.score_json);
 }
});
