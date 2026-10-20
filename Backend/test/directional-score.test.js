import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {catalogueRecordFromPayload} from '../src/food-catalogue.js';
import {scoreDirectionalProduct,validateScoreBody} from '../src/product-score.js';
import {DirectionalScoreCore as Core,ScoreCore} from '../src/nutrition-core.js';
import {evaluateCatalogueEnrichment} from '../src/catalogue-enrichment-evidence.js';
const base={code:'1001',product_name:'Named dessert',nutrition:{aggregated_set:{per:'100g',preparation:'as_sold',nutrients:{
  'energy-kcal':{value:433,unit:'kcal'},proteins:{value:5.8,unit:'g'},carbohydrates:{value:39,unit:'g'},
  sugars:{value:34,unit:'g'},fat:{value:28,unit:'g'},'saturated-fat':{value:13,unit:'g'},fiber:{value:.6,unit:'g'}
}}}};
const normalize=p=>catalogueRecordFromPayload({product:p},'1001',Date.now());
test('structured and legacy sodium normalize to salt without altering reported source',()=>{
  for(const [source,value,unit] of [['structured',300,'mg'],['structured',.3,'g'],['legacy',.3,'g']]){
    const raw=structuredClone(base);
    if(source==='structured')raw.nutrition.aggregated_set.nutrients.sodium={value,unit,source:'packaging'};
    else raw.nutriments={sodium_100g:value,sodium_unit:'mg'}; // OFF *_100g is already grams.
    const original=JSON.stringify(raw),record=normalize(raw),p=record.product;
    assert.equal(p.nutrients.salt.value,.75);assert.equal(p.nutrients.salt.status,'calculated');
    assert.match(p.nutrientSources.salt,/Calculated from source sodium/);
    assert.equal(scoreDirectionalProduct(validateScoreBody({product:p})).available,true);
    assert.equal(JSON.stringify(raw),original);
    assert.deepEqual(record.providerPayload.product.nutrition,raw.nutrition);
  }
});
test('reported salt wins; malformed, unknown and estimated sodium cannot manufacture salt',()=>{
  const raw=structuredClone(base);
  raw.nutrition.aggregated_set.nutrients.salt={value:1,unit:'g'};
  raw.nutrition.aggregated_set.nutrients.sodium={value:300,unit:'mg'};
  assert.equal(normalize(raw).product.nutrients.salt.value,1);
  for(const sodium of [{value:null,unit:'mg'},{value:300,unit:'spoon'},{value:300,unit:'mg',source:'estimate'},{value_computed:300,unit:'mg'}, {value:-3,unit:'mg'}]){
    const p=structuredClone(base);p.nutrition.aggregated_set.nutrients.sodium=sodium;
    const result=normalize(p).product;assert.equal(result.nutrients.salt.value,null);
    assert.equal(scoreDirectionalProduct(result).available,false);
  }
});
test('prepared nutrition stays separate and supported prepared records can be scored',()=>{
  const raw=structuredClone(base);raw.nutrition.aggregated_set.preparation='prepared';raw.nutriments={salt_100g:.75,sodium_100g:.3};
  assert.equal(normalize(raw).product.nutrients.salt.value,null,'Cannot borrow as-sold salt or sodium');
  raw.nutrition.aggregated_set.nutrients.sodium={value:300,unit:'mg'};
  const score=scoreDirectionalProduct(normalize(raw).product);
  assert.equal(score.available,true);assert.equal(score.calculationBasis.preparation,'prepared');
});

const pilot=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-directional-pilot-products.json',import.meta.url),'utf8'));
const pilotProduct=code=>catalogueRecordFromPayload({product:pilot.products.find(p=>p.code===code)},code,Date.UTC(2026,9,11)).product;
const rebind=product=>{product.providerNutriScore.factsFingerprint=Core.providerFactsFingerprint(product);return product;};
const qualityPilot=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-directional-quality-products.json',import.meta.url),'utf8'));
const qualityProduct=code=>catalogueRecordFromPayload({product:qualityPilot.products.find(p=>p.code===code)},code,Date.UTC(2026,9,11)).product;
const wholeFruitPilot=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-directional-whole-fruit-products.json',import.meta.url),'utf8'));
const nutButterPilot=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-directional-nut-butter-product.json',import.meta.url),'utf8'));

test('declared cashew nuts share remains counted alongside the smaller peanut share',()=>{
  const raw=nutButterPilot.products[0],product=catalogueRecordFromPayload({product:raw},raw.code,Date.UTC(2026,9,11)).product;
  const before=structuredClone(product),rawBefore=structuredClone(raw),score=scoreDirectionalProduct(product);
  assert.equal(product.scoringFacts.isFatOilNutsSeeds,true);
  assert.equal(Core.resolveClassification(product).category,'fats_nuts_seeds');
  assert.equal(score.category,'fats_nuts_seeds');assert.equal(score.value,25);
  assert.equal(score.classifierVersion,'food-evidence-2026-10-11-v16');
  assert.equal(ScoreCore.Legacy.resolveClassification(product).category,'unknown','Frozen historical admission remains unchanged');
  for(const spelling of ['Cashew Nut','Cashew Nuts','Cashew','Cashews','Roasted Cashew Nuts']){
    const variation=structuredClone(product);variation.ingredientItems[0].text=spelling;
    assert.equal(Core.resolveClassification(variation).category,'fats_nuts_seeds',spelling);
  }
  assert.deepEqual(product,before);assert.deepEqual(raw,rawBefore);
});

test('low-nut declarations and processed cashew aliases cannot establish a majority whole-nut share',()=>{
  const raw=nutButterPilot.products[0],product=catalogueRecordFromPayload({product:raw},raw.code,Date.UTC(2026,9,11)).product;
  for(const spelling of ['Cashew nut flour','Cashew nut powder','Cashew nut oil','Cashew nut flavour','Cashew nut cake','Cashew nuts and sugar','Not cashew nuts']){
    const variation=structuredClone(product);variation.ingredientItems[0].text=spelling;
    assert.equal(Core.resolveClassification(variation).category,'unknown',spelling);
  }
  for(const [share,expected] of [[45,'unknown'],[45.4,'unknown'],[45.5,'fats_nuts_seeds']]){
    const variation=structuredClone(product);variation.ingredientItems[0].percent=share;
    assert.equal(Core.resolveClassification(variation).category,expected,String(share));
  }
});

test('standalone frozen mango and Pink Lady apples retain independently supported whole-fruit evidence',()=>{
  for(const raw of wholeFruitPilot.products){
    const product=catalogueRecordFromPayload({product:raw},raw.code,Date.UTC(2026,9,11)).product;
    const before=structuredClone(product),rawBefore=structuredClone(raw),score=scoreDirectionalProduct(product);
    assert.ok(Core.providerScore(product).components.positive.find(p=>p.id==='fvl').value>100);
    assert.equal(score.value,100,raw.code);assert.equal(score.inputs.fvlPercent,100);
    assert.equal(score.inputs.fvlSource,'supported-single-whole-fruit-identity');
    assert.equal(score.inferredInputs.fvlPercent,undefined,'Rejected provider quantities cannot become inferred percentages');
    assert.equal(score.classifierVersion,Core.CLASSIFIER_VERSION);
    assert.equal(score.inputFingerprint,Core.inputFingerprint(product));
    const withoutProvider=structuredClone(product);delete withoutProvider.providerNutriScore;
    assert.equal(scoreDirectionalProduct(withoutProvider).value,100,'Whole-fruit evidence does not depend on the old provider score');
    assert.deepEqual(product,before);assert.deepEqual(raw,rawBefore);
  }
});

test('whole-fruit aliases still reject processed, compound and contradictory source identities',()=>{
  const raw=wholeFruitPilot.products.find(p=>p.code==='00263207');
  const product=catalogueRecordFromPayload({product:raw},raw.code,Date.UTC(2026,9,11)).product;
  for(const name of ['Frozen Mango juice','Frozen Mango powder','Frozen Mango smoothie','Frozen Mango yoghurt','Frozen Mango and pineapple','Frozen sweetened Mango','Frozen dried Mango','Pink Lady apple cake','Pink Lady apple puree']){
    assert.equal(Core.wholeFruitIdentity({...product,name}),null,name);
  }
  for(const change of [
    {ingredients:'Mango, sugar'},
    {ingredientItems:[{text:'Mango',percent:80}]},
    {ingredientItems:[{text:'Mango'},{text:'Sugar'}]},
    {categoriesTags:['en:mango-juice']},
    {categoriesTags:['en:apples']},
    {scoringFacts:{isBeverage:true}},
    {ingredientsNeedsReview:true},
    {unresolvedFields:['ingredients']}
  ])assert.equal(Core.wholeFruitIdentity({...product,...change}),null,JSON.stringify(change));
  assert.equal(Core.wholeFruitIdentity({...product,ingredients:null,ingredientItems:[],categories:[],categoriesTags:[]}),null,'A name alone is insufficient');
  assert.equal(Core.wholeFruitIdentity({...product,name:'Frozen whole mango'}).name,'mango');
});

test('grossly conflicting source energy is withheld instead of choosing a favourable computed quantity',()=>{
  for(const [code,kcal,kj] of [['00022750',616,1286.8],['21157042',347.2,597.1]]){
    const product=qualityProduct(code),before=structuredClone(product),score=scoreDirectionalProduct(product);
    assert.equal(product.nutrients.energyKcal.value,kcal);assert.equal(product.energyKj.value,kj);assert.equal(product.energyKj.relation,'~');
    assert.equal(score.available,false,code);assert.equal(score.value,null);
    assert.deepEqual(score.reasonCodes,['conflicting_source_energy']);
    assert.equal(Core.calculateSourceEstimate(product),null,'Estimate projection cannot bypass the conflict');
    assert.ok(Core.providerScore(product),'Retained provider reference remains independently readable');
    const withoutProvider={...product};delete withoutProvider.providerNutriScore;
    assert.deepEqual(scoreDirectionalProduct(withoutProvider).reasonCodes,['conflicting_source_energy']);
    assert.deepEqual(product,before);
  }
  const modest=qualityProduct('21157042');modest.nutrients.energyKcal.value=150;
  assert.equal(scoreDirectionalProduct(modest).available,true,'Rounding and modest computed-energy variation are not gross conflicts');
  const single=qualityProduct('21157042');delete single.energyKj;delete single.providerNutriScore;
  assert.equal(scoreDirectionalProduct(single).available,true,'No energy is reconstructed from an old provider component');
});

test('all-zero non-water panels stay unrated while supported plain water retains its rating',()=>{
  const product=qualityProduct('0007082979360'),before=structuredClone(product),score=scoreDirectionalProduct(product);
  assert.equal(score.available,false);assert.deepEqual(score.reasonCodes,['all_zero_non_water_nutrition']);
  const lessComplete=structuredClone(product);lessComplete.nutrients.fibre={value:null,unit:'g',status:'unknown'};
  assert.equal(scoreDirectionalProduct(lessComplete).available,false,'Dropping an optional quantity cannot validate an all-zero panel');
  const water={...product,name:'Mineral water',categories:[],categoriesTags:[],scoringFacts:undefined,providerNutriScore:undefined,basisUnit:'ml'};
  assert.equal(scoreDirectionalProduct(water).value,100);
  assert.deepEqual(product,before);
});

test('unknown sugar uses a carbohydrate bound only when every possible amount has identical points',()=>{
  const source=pilotProduct('00018647');delete source.providerNutriScore;
  for(const [carbohydrate,available] of [[0,true],[3.4,true],[3.41,false],[10,false]]){
    const product=structuredClone(source);product.nutrients.carbohydrate.value=carbohydrate;
    const before=structuredClone(product),score=scoreDirectionalProduct(product);
    assert.equal(score.available,available,String(carbohydrate));assert.equal(score.inputs.sugars,null);
    if(available){const sugars=score.components.negative.find(p=>p.id==='sugars');assert.equal(sugars.points,0);assert.equal(sugars.value,null);assert.equal(sugars.quantityIsExact,false);}
    assert.deepEqual(product,before);
  }
  const unknownCarbs=structuredClone(source);unknownCarbs.nutrients.carbohydrate={value:null,unit:'g',status:'unknown'};
  assert.equal(scoreDirectionalProduct(unknownCarbs).available,false);
  const inconsistent=structuredClone(source);inconsistent.nutrients.sugars={value:null,unit:'g',status:'supplied',relation:'<'};
  inconsistent.nutrients.sugars.value=0;
  assert.equal(scoreDirectionalProduct(inconsistent).available,false,'An impossible supplied bound is never replaced');
});

test('milk and no-sugars drink names cannot manufacture absent sweetener evidence',()=>{
  for(const [code,expected] of [['0000195212035',25],['00032247',0]]){
    const product=qualityProduct(code),before=structuredClone(product),score=scoreDirectionalProduct(product);
    assert.equal(product.ingredients,null);assert.equal(score.inputs.hasNonNutritiveSweeteners,null);
    assert.equal(score.inferredInputs.sweetenerPoints.value,4);assert.equal(score.value,expected);
    assert.deepEqual(product,before);
  }
});

test('reviewed pilot fruit and vegetables retain source-backed qualifying plant evidence',()=>{
  for(const [code,value,fvl,method] of [
    ['00010665',100,100,'supported-single-whole-fruit-identity'],
    ['00041737',100,100,'supported-single-whole-fruit-identity'],
    ['00004689',100,100,'off_2023_component_estimate'],
    ['00019453',100,90,'off_2023_component_estimate'],
    ['0000350034007',75,75,'off_2023_component_estimate']
  ]){
    const product=pilotProduct(code),before=structuredClone(product),score=scoreDirectionalProduct(product);
    assert.equal(score.value,value,code);assert.equal(score.inputs.fvlPercent,fvl,code);
    assert.equal(score.inputs.fvlSource,method,code);assert.equal(score.methodId,'nudge_nutrition_v0_4');
    assert.equal(score.providerReference.version,'2023');assert.deepEqual(product,before);
    if(method==='off_2023_component_estimate'){
      assert.equal(score.sourceInputs.fvlPercent,null);assert.equal(product.scoringFacts.fvlPercent,undefined);
      assert.equal(score.inferredInputs.fvlPercent.value,fvl);assert.equal(score.inferredInputs.fvlPercent.status,'estimated');
    }
  }
  const product=pilotProduct('00010665');delete product.providerNutriScore;
  for(const name of ['Golden Delicious apple cake','Royal Gala apple juice','Royal Gala apple puree']){
    assert.equal(Core.wholeFruitIdentity({...product,name}),null,name);
  }
  assert.equal(Core.wholeFruitIdentity({...product,ingredients:'Apples, sugar'}),null);
  assert.equal(Core.wholeFruitIdentity({...product,ingredientsNeedsReview:true}),null);
});

test('retained OFF component estimates never replace exact facts, supported bounds or missing adverse nutrients',()=>{
  const tomato=pilotProduct('0000350034007');
  const declared=rebind({...structuredClone(tomato),scoringFacts:{...tomato.scoringFacts,fvlPercent:{value:20,source:'declared',evidence:'Tomatoes 20%'}}});
  const exact=scoreDirectionalProduct(declared);assert.equal(exact.inputs.fvlPercent,20);assert.equal(exact.inferredInputs.fvlPercent,undefined);
  const bounded=rebind({...structuredClone(tomato),ingredients:'Tomatoes (20%), Water (80%)',ingredientsNeedsReview:false,ingredientItems:[]});
  const bound=scoreDirectionalProduct(bounded);assert.ok(bound.inputs.fvlBounds.upper<75);assert.equal(bound.inferredInputs.fvlPercent,undefined);
  const stale=structuredClone(tomato);stale.nutrients.salt.value+=.1;
  assert.equal(Core.providerScore(stale),null);assert.equal(scoreDirectionalProduct(stale).inferredInputs.fvlPercent,undefined);
  const unknown=structuredClone(tomato);unknown.providerNutriScore.components.positive.find(p=>p.id==='fruits_vegetables_legumes').value=null;
  assert.equal(scoreDirectionalProduct(unknown).inputs.fvlPercent,null);assert.equal(scoreDirectionalProduct(unknown).inferredInputs.fvlPoints.value,0);
  for(const key of ['sugars','salt','saturatedFat']){
    const missing=structuredClone(tomato);missing.nutrients[key]={value:null,unit:'g',status:'unknown'};
    // Prevent the pre-existing point-invariant total-fat bound in this missing-saturates check.
    if(key==='saturatedFat')missing.nutrients.fat={value:5,unit:'g',status:'supplied'};
    rebind(missing);assert.equal(scoreDirectionalProduct(missing).available,false,key);
    assert.equal(scoreDirectionalProduct(missing).inputs[key],null,key);
  }
  const eggs=pilotProduct('00018647');assert.ok(Core.providerScore(eggs));
  const eggScore=scoreDirectionalProduct(eggs);
  assert.equal(eggScore.available,true);assert.equal(eggs.nutrients.sugars.value,null);assert.equal(eggScore.inputs.sugars,null);
  assert.deepEqual(eggScore.inputs.nutrientBounds.sugars,{value:0,relation:'lte',source:'supplied-carbohydrate-upper-bound'});
});

test('numeric approximate source salt is usable with its original qualifier and provenance retained',()=>{
  const product=pilotProduct('0000200000296'),before=structuredClone(product),score=scoreDirectionalProduct(product);
  assert.equal(product.nutrients.salt.relation,'~');assert.equal(product.nutrients.salt.value,1.18);
  assert.equal(score.available,true);assert.equal(score.value,25);assert.equal(score.estimated,true);
  assert.equal(score.inputs.salt,1.18);assert.equal(score.sourceInputs.salt,null);
  assert.deepEqual(score.inferredInputs.nutrients.salt,{...product.nutrients.salt,source:product.nutrientSources.salt});
  assert.equal(score.providerReference.version,'2023');assert.equal(score.inputFingerprint,Core.inputFingerprint(product));
  assert.deepEqual(product,before);
  for(const change of [
    p=>p.nutrients.salt={...p.nutrients.salt,value:null,status:'unknown'},
    p=>p.nutrients.salt={...p.nutrients.salt,value:0,relation:'<'},
    p=>p.nutrients.salt={...p.nutrients.salt,value:.25,relation:'<'},
    p=>p.nutrientSources.salt='unverified interpretation',
    p=>p.sourceName='Different source'
  ]){const p=structuredClone(product);change(p);assert.equal(scoreDirectionalProduct(p).available,false);}
});

test('candidate fingerprints include retained component quantities but never take provider totals as their calculation',()=>{
  const product=pilotProduct('0000350034007'),original=Core.inputFingerprint(product),score=scoreDirectionalProduct(product);
  const differentQuantity=structuredClone(product);differentQuantity.providerNutriScore.components.positive.find(p=>p.id==='fruits_vegetables_legumes').value=76;
  assert.ok(Core.providerScore(differentQuantity));assert.notEqual(Core.inputFingerprint(differentQuantity),original);
  // A self-consistent alternate provider total changes attribution, not any source quantity.
  const differentTotal=structuredClone(product),provider=differentTotal.providerNutriScore;
  provider.components.negative.find(p=>p.id==='energy').points+=1;provider.negativePoints+=1;provider.rawScore+=1;provider.grade=Core.gradeFor(provider.rawScore,provider.category);
  assert.ok(Core.providerScore(differentTotal));assert.equal(Core.inputFingerprint(differentTotal),original);
  assert.equal(scoreDirectionalProduct(differentTotal).rawScore,score.rawScore);
  assert.equal(scoreDirectionalProduct(differentTotal).value,score.value);
});

test('validated sweetener component quantities preserve known absence without copying a provider final score',()=>{
  const n=value=>({value,unit:'g',status:'supplied'});
  const product={name:'Coffee milk drink',barcode:'12345001',sourceName:'Open Food Facts',sourceURL:'https://world.openfoodfacts.org/product/12345001',basisUnit:'ml',nutritionPreparation:'as_sold',
    nutrients:{energyKcal:{value:45,unit:'kcal',status:'supplied'},sugars:n(5),fat:n(1),saturatedFat:n(.5),salt:n(.1),fibre:n(0),protein:n(3)},scoringFacts:{isBeverage:true}};
  const known=Core.calculateScore({...product,scoringFacts:{...product.scoringFacts,hasNonNutritiveSweeteners:false}});
  const ids={saturatedFat:'saturated_fat',fibre:'fiber',protein:'proteins',fvl:'fruits_vegetables_legumes',sweeteners:'non_nutritive_sweeteners'};
  const rows=parts=>parts.map(p=>({id:ids[p.id]||p.id,value:p.id==='sweeteners'?0:p.value,unit:p.id==='sweeteners'?'number':p.unit,points:p.points,pointsMax:p.pointsMax}));
  product.providerNutriScore={source:'Open Food Facts',version:'2023',computed:true,applicable:true,categoryAvailable:true,nutrientsAvailable:true,estimated:false,
    barcode:product.barcode,sourceURL:product.sourceURL,preparation:'as_sold',category:'beverage',grade:known.grade,rawScore:known.rawScore,negativePoints:known.negativePoints,positivePoints:known.positivePoints,countProteins:known.countProteins,
    components:{negative:rows(known.components.negative),positive:rows(known.components.positive)},factsFingerprint:Core.providerFactsFingerprint(product)};
  const before=structuredClone(product),scored=scoreDirectionalProduct(product);
  assert.ok(Core.providerScore(product));assert.equal(scored.value,known.value);
  assert.equal(scored.sourceInputs.hasNonNutritiveSweeteners,null);assert.equal(scored.inferredInputs.hasNonNutritiveSweeteners.value,false);
  assert.equal(scored.components.negative.find(p=>p.id==='sweeteners').points,0);
  const unknown=structuredClone(product);unknown.providerNutriScore.components.negative.find(p=>p.id==='non_nutritive_sweeteners').value=null;
  assert.equal(scoreDirectionalProduct(unknown).inferredInputs.sweetenerPoints.value,4);
  assert.deepEqual(product,before);
});

test('shadow enrichment revalidates retained classification and composition under the candidate core',()=>{
  const raw=pilot.products.find(p=>p.code==='00018647'),before=structuredClone(raw);
  const first=evaluateCatalogueEnrichment(raw,{now:Date.UTC(2026,9,11)},Core);
  assert.equal(first.score.available,true);assert.equal(first.score.methodId,Core.SCORE_METHOD);
  assert.equal(first.score.scoreBasis,'nudge_directional');assert.equal(first.product.nutrients.sugars.value,null);
  const recordId='12-937:bf53bb737a77'; // Existing approved CoFID whole raw egg row.
  const retained={classification:{category:'general',evidence:[{field:'name',quote:first.product.name}],sweeteners:'unknown',sweetenerEvidence:[]},compositionRecordId:recordId,now:Date.UTC(2026,9,11)};
  const replay=evaluateCatalogueEnrichment(raw,retained,Core);
  assert.equal(replay.score.value,first.score.value);assert.equal(replay.provenance.classifierVersion,Core.CLASSIFIER_VERSION);
  assert.equal(replay.score.inputs.sugars,0);assert.match(replay.score.assumptions.join(' '),/declared 0 g carbohydrate bound/);
  assert.throws(()=>evaluateCatalogueEnrichment(raw,{...retained,compositionRecordId:'usda:173944'},Core),/not offered/);
  assert.deepEqual(raw,before);
  const named={...structuredClone(base),product_name:'Quark',nutrition:{aggregated_set:{per:'100g',preparation:'as_sold',nutrients:{
    'energy-kcal':{value:250,unit:'kcal'},proteins:{value:22,unit:'g'},carbohydrates:{value:1,unit:'g'},sugars:{value:1,unit:'g'},fat:{value:18,unit:'g'},'saturated-fat':{value:10,unit:'g'},salt:{value:1,unit:'g'},fiber:{value:0,unit:'g'}
  }}}};
  const enriched=evaluateCatalogueEnrichment(named,{now:Date.UTC(2026,9,11),classification:{category:'cheese',evidence:[{field:'name',quote:'Quark'}],sweeteners:'unknown',sweetenerEvidence:[]}},Core);
  assert.equal(enriched.classification.category,'cheese');assert.equal(enriched.score.category,'cheese');
  assert.equal(enriched.score.countProteins,true,'Retained category is applied even when general fallback could already score the product');
  const withKnownSugar=structuredClone(raw);withKnownSugar.nutrition.aggregated_set.nutrients.sugars={value:0,unit:'g',source:'packaging'};
  const conservative=evaluateCatalogueEnrichment(withKnownSugar,{now:retained.now},Core);
  assert.equal(conservative.score.available,true);assert.equal(conservative.score.inputs.fibre,null);
  const reused=evaluateCatalogueEnrichment(withKnownSugar,retained,Core);
  assert.equal(reused.score.scoreBasis,'sourced_composition');assert.equal(reused.product.nutrients.fibre.value,null);
  assert.equal(reused.score.inputs.fibre,0,'Approved composition supplies the existing optional fibre evidence only in its projection');
});

test('retained public-label fibre is revalidated even when nutrition-only scoring already returns a number',()=>{
  const code='5000000000001',url='https://images.openfoodfacts.org/images/products/500/000/000/0001/nutrition_en.1.400.jpg';
  const raw={code,product_name:'Named grain food',last_modified_t:123,image_nutrition_url:url,
    nutriments:{'energy-kcal_100g':300,proteins_100g:8,carbohydrates_100g:50,sugars_100g:5,fat_100g:5,'saturated-fat_100g':1,salt_100g:.2}};
  const nutritionEvidence={version:'public-label-extraction-v1',barcode:code,sourceRevision:123,sourceURL:'https://world.openfoodfacts.org/product/'+code,images:[{role:'nutrition',url}],
    extraction:{conflictingProduct:false,basis:'100g',basisQuote:'Per 100 g',preparation:'as_sold',preparationQuote:null,
      nutrients:Object.fromEntries(['energyKcal','energyKj','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'].map(k=>[k,k==='fibre'?{value:12,quote:'Fibre 12 g',imageIndex:0}:null])),ingredients:null,ingredientsImageIndex:null}};
  const before=structuredClone(raw),options={now:Date.UTC(2026,9,11)},baseline=evaluateCatalogueEnrichment(raw,options,Core);
  assert.equal(baseline.score.available,true);assert.equal(baseline.score.inputs.fibre,null);
  const result=evaluateCatalogueEnrichment(raw,{...options,nutritionEvidence},Core);
  assert.equal(result.score.inputs.fibre,12);assert.equal(result.score.scoreBasis,'public_label_estimate');
  assert.equal(result.product.nutrients.fibre.value,null);assert.equal(result.score.estimated,true);
  assert.ok(result.score.value>baseline.score.value);assert.deepEqual(raw,before);
});
