import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {catalogueRecordFromPayload} from '../src/food-catalogue.js';
import {ScoreCore} from '../src/nutrition-core.js';
import {scorePackagedProduct,scoreCacheKey,stableStringify,SCORE_METHOD,SCORE_VERSION,SCORE_PROMPT_VERSION,SCORE_CACHE_REVISION,CLASSIFICATION_PROMPT,EXPLANATION_PROMPT} from '../src/product-score.js';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter} from '../src/catalogue-index-object.js';
import {importCatalogue,batchCatalogue,recalculateCatalogue} from '../src/catalogue-index.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/off-brown-basmati-rice.json',import.meta.url),'utf8'));
const raw=fixture.product,now=Date.parse(fixture.retrievedAt);
const normalize=()=>catalogueRecordFromPayload({product:structuredClone(raw)},raw.code,now).product;

describe('complete rice ingredient evidence',()=>{
  it('rates the exact public rice record under general rules while retaining incompatible OFF B provenance',()=>{
    const sourceBefore=structuredClone(raw),product=normalize(),before=structuredClone(product);
    assert.equal(raw.nutriscore['2023'].grade,'b');
    assert.equal(raw.nutriscore['2023'].data.is_fat_oil_nuts_seeds,1);
    assert.equal(product.scoringFacts.isFatOilNutsSeeds,true,'Original category flag remains source evidence');
    assert.equal(product.providerNutriScore,undefined,'An incompatible provider category cannot be inherited');
    assert.equal(ScoreCore.providerScore(product),null);
    const score=scorePackagedProduct(product);
    assert.equal(score.available,true);assert.equal(score.category,'general');
    assert.equal(score.grade,'A');assert.equal(score.value,100);assert.equal(score.rawScore,-1);
    assert.notEqual(score.scoreBasis,'provider_nutriscore_2023');
    assert.equal(score.inputs.fvlPercent,0);
    assert.equal(score.inputs.fvlBounds.evidence,raw.ingredients_text);
    assert.ok(score.classificationEvidence.resolutions.includes('cereal_identity_over_provider_oilseed_flag'));
    assert.equal(score.negativePoints,1);assert.equal(score.positivePoints,2);
    assert.deepEqual(product,before);assert.deepEqual(raw,sourceBefore);
  });

  it('keeps per-100g source nutrition separate from the 125g serving displayed on the phone',()=>{
    const product=normalize(),score=scorePackagedProduct(product);
    assert.equal(product.basisUnit,'g');assert.equal(product.nutritionPreparation,'as_sold');
    for(const [key,per100,perServing] of [['energyKcal',133.6,167],['protein',2.56,3.2],['carbohydrate',24,30],['fat',1.44,1.8],['fibre',4.08,5.1],['sugars',.4,.5]]){
      assert.equal(product.nutrients[key].value,per100,key);
      assert.ok(Math.abs(per100*1.25-perServing)<1e-9,key);
    }
    assert.equal(product.energyKj.value,537.44);assert.equal(product.energyKj.relation,'~');
    assert.equal(score.inputs.energySource,'derived-kcal-times-4.184');
    assert.equal(score.inputs.energyKj,133.6*4.184);
    const providerParts=raw.nutriscore['2023'].data.components;
    for(const [id,key] of [['sugars','sugars'],['salt','salt'],['fiber','fibre'],['proteins','protein']]){
      const part=[...providerParts.negative,...providerParts.positive].find(v=>v.id===id);
      assert.equal(part.value,product.nutrients[key].value,id+' uses the same 100g source basis');
    }
    assert.equal(providerParts.negative.find(v=>v.id==='energy_from_saturated_fat').value,product.nutrients.saturatedFat.value*37);
    assert.equal(providerParts.negative.find(v=>v.id==='saturated_fat_ratio').value,Math.round(product.nutrients.saturatedFat.value/product.nutrients.fat.value*1000)/10);
  });

  it('recognises preparation, colour and variety only within a fully known ingredient list',()=>{
    for(const ingredients of [
      'Cooked Brown Basmati Rice',
      'Cooked White Basmati Rice, Vegetable Oil (Rapeseed, Sunflower), Salt',
      'Cooked Brown Long Grain Rice, Vegetable Oil (Sunflower Oil, Rapeseed Oil), Salt',
      'Cooked Brown Basmati Rice (98%), Vegetable Oil (Sunflower, Rapeseed), Salt'
    ]){
      const product={...normalize(),ingredients,ingredientItems:[]},before=structuredClone(product);
      const score=scorePackagedProduct(product);
      assert.equal(score.available,true,ingredients);assert.equal(score.inputs.fvlPercent,0,ingredients);
      assert.deepEqual(product,before);
    }
  });

  it('does not turn missing, unreviewed or unresolved compound ingredients into zero',()=>{
    for(const changes of [
      {ingredients:null},{ingredients:''},
      {ingredients:'Cooked Brown Basmati Rice, Vegetable Oil (Sunflower, Flavouring), Salt'},
      {ingredients:'Cooked Brown Basmati Rice, Vegetable Oil (Sunflower, Rapeseed'},
      {ingredients:'Brown Rice (Vegetables), Salt'},
      {ingredients:'Cooked Brown Basmati Rice, Peas'},
      {ingredientsNeedsReview:true},
      {unresolvedFields:['ingredients']}
    ]){
      const product={...normalize(),...changes,ingredientItems:[]},score=scorePackagedProduct(product);
      assert.equal(score.available,ScoreCore.ACTIVE_DIRECTIONAL,JSON.stringify(changes));
      assert.equal(score.inputs.fvlPercent,null,JSON.stringify(changes));
      if(ScoreCore.ACTIVE_DIRECTIONAL){assert.equal(score.components.positive.find(p=>p.id==='fvl').points,0);assert.ok(score.assumptions.some(a=>/unverified plant bonus/i.test(a)));}else assert.ok(score.missingInputs.includes('fruit, vegetable and legume percentage'));
    }
    const oil={...normalize(),name:'Vegetable Oil',ingredients:'Vegetable Oil (Sunflower, Rapeseed)',categoriesTags:['en:vegetable-oils'],categories:['en:vegetable-oils']};
    assert.equal(ScoreCore.ingredientFvlBounds(oil,'fats_nuts_seeds'),null,'Compound oil needs the separate fat-profile evidence rules');
  });

  it('refreshes a retained old score without rewriting original nutrition, images or place evidence',async()=>{
    const sql=new DatabaseSync(':memory:');sql.exec(catalogueSchema);
    const storage={sql:{exec:(query,...values)=>({toArray:()=>sql.prepare(query).all(...values)})},transactionSync:callback=>{sql.exec('BEGIN');try{const result=callback();sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
    const db=catalogueSQLAdapter(storage);
    await importCatalogue(db,{products:[raw],sourceURL:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',fetchedAt:now},{now});
    const before=sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(raw.code);
    const placeBefore=sql.prepare('SELECT * FROM catalogue_places WHERE barcode=?').all(raw.code);
    sql.prepare('UPDATE catalogue_products SET classifier_version=?,rating_value=NULL,score_json=? WHERE barcode=?')
      .run('food-evidence-2026-10-09-v9',JSON.stringify({value:null,available:false,classifierVersion:'food-evidence-2026-10-09-v9'}),raw.code);
    const read=await batchCatalogue(db,{codes:[raw.code]},{now:now+1000});
    assert.equal(read.ratings[0].score.value,100,'Existing public lookups immediately recalculate outdated results');
    assert.equal(read.ratings[0].classifierVersion,ScoreCore.CLASSIFIER_VERSION);
    const refreshed=await recalculateCatalogue(db,{}, {now:now+2000});assert.equal(refreshed.remaining,0);
    const after=sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(raw.code);
    for(const key of ['provider_json','fetched_at','expires_at','source_fingerprint','source_revision','import_source_url'])assert.equal(after[key],before[key],key);
    assert.deepEqual(sql.prepare('SELECT * FROM catalogue_places WHERE barcode=?').all(raw.code),placeBefore);
    assert.equal(after.rating_value,100);sql.close();
  });

  it('keys classification caches by the current classifier as well as the fixed numeric method',async()=>{
    const product=normalize(),model='test-model',base={product:ScoreCore.ACTIVE_DIRECTIONAL?ScoreCore.inputFingerprint(product):product,model,method:SCORE_METHOD,version:SCORE_VERSION,cacheRevision:SCORE_CACHE_REVISION,
      promptVersion:SCORE_PROMPT_VERSION,classificationPrompt:CLASSIFICATION_PROMPT,explanationPrompt:EXPLANATION_PROMPT};
    const hash=value=>createHash('sha256').update(stableStringify(value)).digest('hex');
    assert.equal(await scoreCacheKey(product,model),hash({...base,classifierVersion:ScoreCore.CLASSIFIER_VERSION}));
    assert.notEqual(await scoreCacheKey(product,model),hash({...base,classifierVersion:'food-evidence-2026-10-09-v9'}));
    assert.notEqual(await scoreCacheKey(product,model),hash(base));
  });
});
