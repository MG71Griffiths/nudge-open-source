import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluateCatalogueEnrichment,ENRICHMENT_VERSION} from '../src/catalogue-enrichment-evidence.js';
import {catalogueRecordFromPayload} from '../src/food-catalogue.js';
import {ScoreCore} from '../src/nutrition-core.js';

const directional=ScoreCore.ACTIVE_DIRECTIONAL;
const now=1780000000000;
const raw=(name,extra={})=>({code:'5000000000001',product_name:name,ingredients_text:name,nutriments:{proteins_100g:10},...extra});
const evaluate=(p,options={})=>evaluateCatalogueEnrichment(p,{now,...options});
const choice=name=>({category:'general',evidence:[{field:'name',quote:name}],sweeteners:'unknown',sweetenerEvidence:[]});
const unknown=()=>({category:'unknown',evidence:[],sweeteners:'unknown',sweetenerEvidence:[]});
const full={ 'energy-kcal_100g':110,'energy-kj_100g':460,proteins_100g:6,carbohydrates_100g:14,sugars_100g:2,fat_100g:3,'saturated-fat_100g':1,fiber_100g:4,salt_100g:.5 };

describe('server-computed source-bound catalogue enrichment',()=>{
  it('retains a complete OFF reference while computing the directional score without changing nutrition',()=>{
    const source=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-nutriscore-products.json',import.meta.url),'utf8'));
    const p=source.products.find(p=>p.code==='8004030103191'),before=structuredClone(p),result=evaluate(p);
    assert.equal(result.outcome,'already_rated');assert.equal(result.score.value,25);
    assert.equal(result.score.scoreBasis,directional?'nudge_directional':'provider_nutriscore_2023');if(directional)assert.equal(result.score.providerReference.grade,'D');assert.deepEqual(p,before);
    assert.equal(result.version,ENRICHMENT_VERSION);assert.equal(result.provenance.classifierVersion,ScoreCore.CLASSIFIER_VERSION);
  });
  it('uses grounded classification with declared ingredients, not a model-authored percentage',()=>{
    const p=raw('Dhal makhani',{ingredients_text:'Lentils (60%), tomatoes (10%), water, cream, salt',nutriments:full}),before=structuredClone(p);
    assert.equal(evaluate(p).outcome,directional?'already_rated':'unresolved');
    const result=evaluate(p,{classification:choice(p.product_name)});
    assert.equal(result.outcome,directional?'already_rated':'enriched');assert.ok(result.score.available);assert.equal(result.score.inputs.fvlPercent,70);
    assert.equal(result.classification.category,'general');assert.ok(ScoreCore.validResult(result.score));assert.deepEqual(p,before);
    assert.deepEqual(result.product,catalogueRecordFromPayload({product:p},p.code,now).product);
    assert.equal(result.score.inputs.fvlPercent,70,'Declared source percentages remain the only plant bonus evidence');
  });
  it('never admits numeric scores, numeric nutrition, forged quotations or malformed classifications',()=>{
    const p=raw('Dhal makhani',{nutriments:full});
    for(const options of [{score:100},{nutrients:{salt:0}},{classification:null},
      {classification:{...choice(p.product_name),score:100}},
      {classification:{...choice(p.product_name),evidence:[{field:'name',quote:'Banana'}]}}])assert.throws(()=>evaluate(p,options));
    assert.throws(()=>evaluate(p,{now:-1}));
  });
  it('does not turn absent fruit/vegetable evidence into zero or ignore conflicting categories',()=>{
    const p=raw('Dhal makhani',{ingredients_text:'Lentils, tomatoes, cream, salt',nutriments:full});
    const r=evaluate(p,{classification:choice(p.product_name)});
    assert.equal(r.outcome,directional?'already_rated':'unresolved');assert.equal(r.score.available,directional);assert.equal(r.score.inputs.fvlPercent,null);if(directional)assert.equal(r.score.components.positive.find(p=>p.id==='fvl').points,0);else assert.equal(r.score.value,null);
    const conflict=evaluate(raw('Raw salmon',{categories_tags:['en:cheeses'],nutriments:full}),{classification:choice('Raw salmon')});
    assert.equal(conflict.outcome,'unresolved');assert.equal(conflict.recoveryContext.candidates.length,0);
  });
  it('fills a recognised simple food only in a labelled composition estimate, preserving known salt',()=>{
    const p=raw('Raw salmon',{brands:'Example Foods',nutriments:{proteins_100g:20,salt_100g:2.1}}),before=structuredClone(p);
    const result=evaluate(p);
    assert.equal(result.outcome,'estimated');assert.equal(result.score.scoreBasis,'sourced_composition');assert.equal(result.score.inputs.salt,2.1);
    assert.equal(result.product.nutrients.salt.value,2.1);assert.equal(result.product.nutrients.energyKcal.value,null);
    assert.ok(result.provenance.composition.sourceSHA256);assert.ok(result.score.sourceData.compositionRecordId);
    assert.ok(ScoreCore.validResult(result.score));assert.deepEqual(p,before);
    assert.equal(evaluate({...p,nutriments:{proteins_100g:20}}).product.nutrients.salt.value,null);
  });
  it('recovers plain packaged eggs and whole fruit, with trace values remaining unknown',()=>{
    const egg=evaluate(raw('Eggs',{nutriments:{carbohydrates_100g:0}}));
    assert.equal(egg.outcome,'estimated');assert.equal(egg.product.nutrients.sugars.value,null);
    assert.equal(egg.score.inputs.sugars,0,'Declared zero carbohydrate provides a separate bound, not a stored sugar value');
    const fruit=evaluate(raw('Banana',{nutriments:{}}));assert.equal(fruit.outcome,'estimated');assert.equal(fruit.score.value,100);
    assert.equal(fruit.provenance.composition.recordId,'usda:173944');assert.equal(fruit.product.nutrients.protein.value,null);
    const nameOnly=evaluate(raw('Organic Pear',{ingredients_text:'',nutriments:{}}));
    assert.equal(nameOnly.outcome,'estimated');assert.equal(nameOnly.score.inputs.fvlPercent,100);
    assert.equal(nameOnly.score.value,100);assert.equal(nameOnly.product.scoringFacts?.fvlPercent,undefined);
  });
  it('keeps composite products, ambiguous preparation and a ml basis out of generic recovery',()=>{
    for(const p of [raw('Salmon'),raw('Salmon pie'),raw('Raw salmon',{ingredients_text:'Salmon, cream'}),
      raw('Raw salmon',{ingredients_text:'Raw chicken'}),raw('Red split lentils'),raw('Plain yogurt'),
      raw('Raw salmon',{nutrition:{aggregated_set:{per:'100ml',preparation:'as_sold',nutrients:{}}}}),raw('Banana smoothie'),raw('Organic almonds',{ingredients_text:'Almonds, sugar'})]){
      const r=evaluate(p);assert.equal(r.outcome,'unresolved',p.product_name);assert.equal(r.recoveryContext.candidates.length,0,p.product_name);
    }
  });
  it('offers multiple compatible preparations for explicit selection, never chooses an arbitrary candidate',()=>{
    const p=raw('Cooked lentils',{nutriments:{proteins_100g:8,sugars_100g:1,salt_100g:.2}}),r=evaluate(p);
    assert.equal(r.outcome,'unresolved');assert.ok(r.recoveryContext.candidates.length>1);
    assert.ok(r.recoveryContext.candidates.every(c=>/cooked|boiled/i.test(c.name)&&!/raw/i.test(c.name)));
    const chosen=evaluate(p,{classification:unknown(),compositionRecordId:r.recoveryContext.candidates[0].id});
    assert.equal(chosen.outcome,'estimated');assert.equal(chosen.score.inputs.salt,.2);
    assert.throws(()=>evaluate(p,{compositionRecordId:'usda:173944'}),/not offered/);
    assert.throws(()=>evaluate({...p,product_name:'Raw salmon',ingredients_text:'Raw salmon'},{compositionRecordId:r.recoveryContext.candidates[0].id}),/not offered/);
  });
});

function labelFixture(){
  const barcode='5000000000001',url='https://images.openfoodfacts.org/images/products/500/000/000/0001/nutrition_en.1.400.jpg';
  const p=raw('Plain lentils',{last_modified_t:1234,nutriments:{proteins_100g:24},ingredients_text:'Lentils',image_nutrition_url:url});
  const values={energyKcal:350,energyKj:null,protein:24,carbohydrate:50,sugars:1,fat:2,saturatedFat:.2,fibre:12,salt:.03};
  const names={energyKcal:'Energy',energyKj:'Energy',protein:'Protein',carbohydrate:'Carbohydrate',sugars:'Sugars',fat:'Fat',saturatedFat:'Saturated fat',fibre:'Fibre',salt:'Salt'};
  const extraction={conflictingProduct:false,basis:'100g',basisQuote:'Nutrition per 100 g',preparation:'as_sold',preparationQuote:null,
    nutrients:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value===null?null:{value,quote:names[key]+' '+value+' '+(key==='energyKcal'?'kcal':key==='energyKj'?'kJ':'g'),imageIndex:0}])),ingredients:null,ingredientsImageIndex:null};
  return {p,nutritionEvidence:{version:'public-label-extraction-v1',barcode,sourceRevision:1234,sourceURL:`https://world.openfoodfacts.org/product/${barcode}`,images:[{role:'nutrition',url}],extraction}};
}
describe('catalogue public-label scoring projection',()=>{
  it('scores registered label observations as estimates while keeping imported facts and missing fields unchanged',()=>{
    const {p,nutritionEvidence}=labelFixture(),before=structuredClone(p),r=evaluate(p,{nutritionEvidence});
    assert.equal(r.outcome,'estimated');assert.equal(r.score.scoreBasis,'public_label_estimate');assert.equal(r.score.value,100);
    assert.equal(r.product.nutrients.salt.value,null);assert.equal(r.product.nutrients.energyKcal.value,null);assert.equal(r.product.nutrients.protein.value,24);
    assert.equal(r.score.inputs.estimatedInputs.salt.status,'estimated');assert.ok(r.provenance.publicLabel.addedFields.includes('salt'));
    assert.ok(ScoreCore.validResult(r.score));assert.deepEqual(p,before);
  });
  it('rejects stale source revisions, unregistered photos and conflicting label readings',()=>{
    for(const alter of [e=>e.sourceRevision++,e=>e.barcode='5000000000002',e=>e.images[0].url=e.images[0].url.replace('.1.','.2.'),
      e=>{e.extraction.nutrients.protein.value=10;e.extraction.nutrients.protein.quote='Protein 10 g';},e=>e.extraction.basis='100ml']){
      const {p,nutritionEvidence}=labelFixture();alter(nutritionEvidence);assert.throws(()=>evaluate(p,{nutritionEvidence}));
    }
  });
  it('does not fill unreadable nutrients with zero or a composition match for an ambiguous product',()=>{
    const {p,nutritionEvidence}=labelFixture();nutritionEvidence.extraction.nutrients.salt=null;
    const r=evaluate(p,{nutritionEvidence});assert.equal(r.outcome,'unresolved');assert.equal(r.score.value,null);assert.equal(r.product.nutrients.salt.value,null);
  });
});
