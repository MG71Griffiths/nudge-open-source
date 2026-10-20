import {afterEach, describe, it, mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';
import {catalogueRecordFromPayload, supplementProduct, readCatalogue, writeCatalogue} from '../src/food-catalogue.js';
import {scorePackagedProduct, validateScoreBody} from '../src/product-score.js';
import {ScoreCore} from '../src/nutrition-core.js';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter} from '../src/catalogue-index-object.js';
import {importCatalogue, batchCatalogue, searchCatalogue, recalculateCatalogue} from '../src/catalogue-index.js';

const directional=ScoreCore.ACTIVE_DIRECTIONAL;
const source=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-nutriscore-products.json',import.meta.url),'utf8'));
const compatibilitySource=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-provider-compatibility-products.json',import.meta.url),'utf8'));
const now=Date.now(), token='a7'.repeat(32), raw=code=>structuredClone(source.products.find(p=>p.code===code));
const normalize=p=>catalogueRecordFromPayload({product:p},p.code,now);
const dates=()=>raw('5061048250081'), tuna=()=>raw('8004030103191');
const request=(product,auth=token)=>new Request('https://nudge.example/v1/products/score',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+auth},body:JSON.stringify({product})});
function environment(record){
  let reads=0;
  const score=record?scorePackagedProduct(record.product):null;
  return {get reads(){return reads;},PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),
    FOOD_CATALOGUE_INDEX:{idFromName:v=>v,get:()=>({fetch:async()=>{reads++;return Response.json({products:record?[record.providerPayload.product]:[],ratings:record?[{barcode:record.barcode,fetchedAt:record.fetchedAt,expiresAt:record.expiresAt,calculatedAt:now,sourceFingerprint:'f'.repeat(64),method:score.methodId,version:score.version,classifierVersion:score.classifierVersion,score}]:[]});}})}};
}
function database(){
  const sql=new DatabaseSync(':memory:');sql.exec(catalogueSchema);
  const storage={sql:{exec:(query,...values)=>({toArray:()=>sql.prepare(query).all(...values)})},transactionSync:fn=>{sql.exec('BEGIN');try{const result=fn();sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  return {sql,db:catalogueSQLAdapter(storage)};
}
afterEach(()=>mock.restoreAll());

describe('retained OFF 2023 scoring evidence',()=>{
  it('retains OFF beverage count units and red-meat protein evidence without substituting provider ratings',()=>{
    const expected={'5449000214744':50,'5010251268215':75,'5057545713952':75,'0219954007250':50};
    for(const raw of compatibilitySource.products){
      const record=normalize(raw),score=scorePackagedProduct(record.product);
      assert.equal(score.value,expected[raw.code],raw.code);if(score.available){assert.equal(score.scoreBasis,directional?'nudge_directional':'provider_nutriscore_2023');if(directional)assert.equal(score.providerReference.version,'2023');}else assert.ok(score.missingInputs.includes('sugars'));
      if(directional&&raw.code==='5449000214744'){
        assert.equal(score.inputs.sugars,null,'A zero-carbohydrate bound must not invent a sugar quantity');
        assert.deepEqual(score.inputs.nutrientBounds.sugars,{value:0,relation:'lte',source:'supplied-carbohydrate-upper-bound'});
      }
      if(score.category==='beverage')assert.equal(record.product.providerNutriScore.components.negative.find(p=>p.id==='non_nutritive_sweeteners').unit,'number');
      else {
        assert.equal(score.category,'red_meat');
        const protein=record.product.providerNutriScore.components.positive.find(p=>p.id==='proteins');
        assert.equal(protein.pointsMax,7);assert.equal(protein.points,2);
      }
    }
  });
  it('still rejects incorrect count units and red-meat protein points above the category cap',()=>{
    const drink=structuredClone(compatibilitySource.products[0]);
    drink.nutriscore['2023'].data.components.negative.find(p=>p.id==='non_nutritive_sweeteners').unit='g';
    assert.equal(normalize(drink).product.providerNutriScore,undefined);
    const beef=structuredClone(compatibilitySource.products.find(p=>p.code==='5057545713952')),ns=beef.nutriscore['2023'];
    ns.data.components.positive.find(p=>p.id==='proteins').points=3;
    ns.data.positive_points=3;ns.score=0;ns.grade='b';
    assert.equal(normalize(beef).product.providerNutriScore,undefined,'Even arithmetically consistent red-meat points cannot exceed 2');
  });
  it('reproduces the six public variants without a packaged heuristic or changed nutrition facts',()=>{
    const expected={'5020580199784':[100,'estimated'],'5020580161231':[100,'rated'],'5061048250005':[25,'rated'],'5061048250081':[50,'rated'],'8004030103191':[25,'rated'],'8005110170348':[100,directional?'rated':'estimated']};
    for(const item of source.products){
      const record=normalize(item),before=structuredClone(record.product),score=scorePackagedProduct(record.product);
      assert.deepEqual([score.value,score.status],expected[item.code],item.code);
      assert.equal(score.methodId,ScoreCore.SCORE_METHOD);assert.equal(score.version,ScoreCore.SCORE_VERSION);
      assert.equal(score.baseFrequency,null);assert.equal(score.finalFrequency,null);
      assert.deepEqual(record.product,before,'Scoring does not overwrite source facts');
      if(item.code==='5020580199784'){
        assert.equal(record.product.nutrients.saturatedFat.value,null);assert.equal(score.inputs.saturatedFat,null);
        assert.equal(score.inputs.nutrientBounds.saturatedFat.value,.8);
      }else if(item.code==='5020580161231')assert.equal(record.product.providerNutriScore,undefined,'A conflicting OFF oilseed category does not override the explicit pulse identity');
      else if(score.available){assert.equal(score.scoreBasis,directional?'nudge_directional':'provider_nutriscore_2023');if(directional)assert.equal(score.providerReference.version,'2023');}else assert.ok(score.missingInputs.includes('sugars'));
    }
  });
  it('requires computed applicable 2023 evidence with matching preparation, category, grade and point totals',()=>{
    assert.ok(normalize(dates()).product.providerNutriScore);
    for(const change of [
      p=>{p.nutriscore={'2021':p.nutriscore['2023']};},
      p=>{p.nutriscore['2023'].nutriscore_computed=0;},
      p=>{p.nutriscore['2023'].nutriscore_applicable=0;},
      p=>{p.nutriscore['2023'].preparation='prepared';},
      p=>{p.nutriscore['2023'].grade='a';},
      p=>{p.nutriscore['2023'].data.negative_points++;},
      p=>{p.nutriscore['2023'].data.is_cheese=1;},
      p=>{p.nutriscore['2023'].data.components.negative=[];},
    ]){const p=dates();change(p);assert.equal(normalize(p).product.providerNutriScore,undefined);}
  });
  it('reconstructs stored provider metadata from the public source instead of a poisoned normalized cache',async()=>{
    const values=new Map(),storage={get:async k=>structuredClone(values.get(k)),put:async(k,v)=>values.set(k,structuredClone(v))};
    const record=normalize(tuna());await writeCatalogue(storage,record,{now});
    for(const value of values.values())value.product.providerNutriScore.rawScore=-15;
    const read=await readCatalogue(storage,record.barcode,{now});
    assert.equal(read.product.providerNutriScore.rawScore,14);assert.equal(scorePackagedProduct(read.product).value,25);
  });
  it('removes HTTP caller provider metadata and refuses to rebind a grade onto edited nutrition',()=>{
    const record=normalize(tuna()),p=structuredClone(record.product);
    assert.equal(validateScoreBody({product:p}).providerNutriScore,undefined);
    p.nutrients.salt.value+=2;delete p.providerNutriScore;
    const supplement=supplementProduct(p,record);
    assert.ok(supplement.conflicts.includes('salt'));assert.equal(supplement.product.providerNutriScore,undefined);
  });
});

describe('retained-facts score route without AI configuration',()=>{
  it('scores trusted retained products immediately without external calls or quota, and still authenticates',async()=>{
    const record=normalize(tuna()),env=environment(record),external=mock.method(globalThis,'fetch',async()=>{throw new Error('No external lookup or AI is allowed');});
    const p=structuredClone(record.product);p.providerNutriScore={...p.providerNutriScore,grade:'A',rawScore:-15};
    const response=await worker.fetch(request(p),env);assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.score.value,25);assert.equal(result.score.scoreBasis,directional?'nudge_directional':'provider_nutriscore_2023');if(directional)assert.equal(result.score.providerReference.grade,'D');
    assert.equal(result.recovery.product.providerNutriScore.rawScore,14);assert.equal(external.mock.callCount(),0);assert.equal(env.reads,1);
    assert.equal((await worker.fetch(request(p,'invalid'),env)).status,401);assert.equal(env.reads,1);
  });
  it('does not accept OFF-looking source strings or provider envelopes without server evidence',async()=>{
    const p=normalize(tuna()).product,env=environment(null);p.nutrients.salt.value=null;
    const response=await worker.fetch(request(p),env);assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.score.available,false);assert.equal(result.score.value,null);
    assert.notEqual(result.score.scoreBasis,'provider_nutriscore_2023');
  });
  it('recovers retained catalogue facts before AI admission even while image analysis is busy',async()=>{
    const record=normalize(tuna()),env=environment(record);let sourceReads=0,aiAdmissions=0;
    env.LABEL_QUOTA={idFromName:v=>v,get:name=>({fetch:async()=>{
      if(name==='food-catalogue:'+record.barcode){sourceReads++;return Response.json({record});}
      aiAdmissions++;return Response.json({allowed:false,busy:true},{status:429});
    }})};
    const submitted=structuredClone(record.product);submitted.nutrients.salt.value=null;
    const response=await worker.fetch(request(submitted),env);assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.score.value,25);assert.equal(result.score.scoreBasis,directional?'nudge_directional':'provider_nutriscore_2023');if(directional)assert.equal(result.score.providerReference.grade,'D');
    assert.equal(sourceReads,0);assert.equal(aiAdmissions,0);assert.equal(env.reads,1);
  });
});

describe('catalogue score revision migration',()=>{
  it('refreshes display and indexed ratings from retained facts without changing images, tags or source freshness',async()=>{
    const {sql,db}=database();
    await importCatalogue(db,{products:source.products,sourceURL:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',fetchedAt:now},{now});
    const original=sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all();
    sql.exec("UPDATE catalogue_products SET rating_value=35,score_method='nudge_nutrition_v0_2',score_version='0.2',classifier_version='old',score_json='{\"available\":true,\"value\":35}'");
    const status=await recalculateCatalogue(db,{statusOnly:true},{now:now+1});assert.equal(status.remaining,6);assert.equal(status.updated,0);assert.equal(status.complete,false);
    assert.deepEqual(status.scoreCoverage,{currentRated:0,currentUnrated:0,outdated:6,total:6});
    const direct=await batchCatalogue(db,{codes:['5061048250081']},{now});assert.equal(direct.ratings[0].score.value,50,'Lazy reads discard old scores before the index refresh');
    assert.equal(sql.prepare('SELECT rating_value FROM catalogue_products WHERE barcode=?').get('5061048250081').rating_value,35,'Read does not silently mutate records');
    const refreshed=await recalculateCatalogue(db,{}, {now:now+1000});assert.equal(refreshed.updated,6);assert.equal(refreshed.remaining,0);assert.equal(refreshed.complete,true);
    const after=sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all();
    for(let i=0;i<after.length;i++)for(const key of ['provider_json','name','brand','is_uk','fetched_at','expires_at','source_fingerprint','source_revision'])assert.equal(after[i][key],original[i][key],key);
    const search=await searchCatalogue(db,{query:'',sort:'ratingHighest',minimumRating:75},{now});
    assert.equal(search.total,3);assert.deepEqual(search.ratings.map(r=>r.score.value),[100,100,100]);
    assert.equal((await recalculateCatalogue(db,{}, {now:now+2000})).updated,0,'Migration is resumable and idempotent');
    assert.deepEqual((await recalculateCatalogue(db,{statusOnly:true},{now:now+2000})).scoreCoverage,{currentRated:6,currentUnrated:0,outdated:0,total:6});
  });
});
