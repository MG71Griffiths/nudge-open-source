const assert=require('node:assert/strict');
const {test}=require('node:test');
require('../Web/core/nudge-score.js');
const composition=require('../Web/core/food-composition.js');
const score=require('../Web/core/meal-score.js');
const analysis=require('../Web/core/analysis-result.js');
const foodLog=require('../Web/core/food-log.js');
const clone=v=>JSON.parse(JSON.stringify(v));
const proposal=()=>({version:1,basis:'perPortion',portionGrams:350,category:'general',fvlPercent:40,
  nutrients:{energyKcal:450,protein:15,carbohydrate:50,sugars:8,fat:20,saturatedFat:4,fibre:9,salt:1.5},
  assumptions:['Estimated 350 g serving; typical oil and seasoning.','General mixed meal; estimated qualifying plant share 40%.']});
function meal(components=[{name:'vegetable stew',preparation:'cooked',amountGrams:null,nutrients:{},recordId:null}]){
  const m={name:'Vegetable stew',basis:'perPortion',portionMode:'estimated_serving',compositionVersion:'test-v1',ingredients:[],plants:[],components,nutrientEstimate:proposal()};
  m.nutrientEstimateContext=composition.nutrientEstimateContext(m);m.nutrients=composition.mealNutrition(m);return m;
}
const model=analysis.create({composition,mealScore:score,names:v=>v,suggestion:()=>null});
const normalise=m=>model.normalise({type:'meal',labelKind:'both',basis:'perPortion',nutrients:{},meal:m});
test('complete estimate is bounded, unit-specific and separate from food sources',()=>{
  const p=proposal();assert.deepEqual(composition.validateNutrientEstimate(p),p);
  for(const edit of [x=>delete x.nutrients.fibre,x=>x.nutrients.salt=null,x=>x.nutrients.protein=NaN,x=>x.nutrients.sugars=60,
    x=>x.nutrients.saturatedFat=25,x=>x.nutrients.fat=351,x=>x.nutrients.energyKcal=3501,x=>x.portionGrams=0,
    x=>x.fvlPercent=101,x=>x.category='beverage',x=>x.basis='per100g',x=>x.nutrients.sodium=3,x=>x.score=99,
    x=>x.assumptions=[],x=>x.nutrients.fat='20',x=>x.nutrients.energyKcal=0,x=>x.nutrients.energyKcal=2000]){
    const invalid=proposal();edit(invalid);assert.equal(composition.validateNutrientEstimate(invalid),null);
  }
  const m=meal(),before=JSON.stringify(m),n=composition.mealNutrition(m);
  for(const k of composition.keys){assert.equal(n[k].value,p.nutrients[k]);assert.equal(n[k].status,'estimated');assert.equal(n[k].unit,k==='energyKcal'?'kcal':'g');}
  assert.equal(JSON.stringify(m),before);assert.equal(m.components[0].recordId,null);assert.equal(m.components[0].amountGrams,null);
});
test('only complete fields override the estimate, never known component subtotals',()=>{
  const c={name:'stew',preparation:'cooked',amountGrams:350,nutrients:{protein:{value:10,unit:'g',status:'composition_estimate'}}};
  const m=meal([c]),n=composition.mealNutrition(m);assert.equal(n.protein.value,35);assert.notEqual(n.protein.source,'model_photo_estimate');assert.equal(n.energyKcal.value,450);
  const partial=meal([c,{name:'sauce',preparation:'cooked',amountGrams:10,nutrients:{}}]);
  assert.equal(composition.total(partial.components).protein.knownSubtotal,35);
  assert.ok(Math.abs(composition.mealNutrition(partial).protein.value-15*360/350)<1e-12,'Full serving estimate scales to complete observed gram total; subtotal is not a complete field');
  assert.equal(composition.mealNutrition(partial).protein.source,'model_photo_estimate');
  c.carbohydrateDefinition='by_difference_including_fibre';c.nutrients.carbohydrate={value:20,unit:'g',status:'composition_estimate'};
  const byDifference=normalise(meal([c]));assert.equal(byDifference.nutrients.carbohydrate.value,70);assert.equal(byDifference.nutrients.carbohydrate.carbohydrateDefinition,'by_difference_including_fibre');
  assert.equal(model.snapshot(byDifference,{amount:1,unit:'portion'}).carbohydrate.carbohydrateDefinition,'by_difference_including_fibre');
});
test('component changes, selections, recipe transformations and non-food cannot reuse an estimate',()=>{
  for(const edit of [x=>x.components[0].amountGrams=100,x=>x.components[0].name='different meal',x=>x.components[0].userEdited=true,
    x=>x.components[0].selected=false,x=>x.components[0].amountSource='confirmed',x=>x.components[0].matchMethod='user_selected',x=>x.components[0].matchStatus='confirmed',
    x=>x.recipeCalculation={applied:true},x=>x.components[0].recipeQuantity={},x=>x.userEdited=true,x=>x.nonFood=true,x=>x.type='unknown',
    x=>x.userPortion={amount:500,unit:'g'}]){
    const m=meal();edit(m);assert.equal(composition.activeNutrientEstimate(m),null);assert.equal(composition.mealNutrition(m).energyKcal.value,null);
  }
  const m=meal();m.userPortion={amount:350,unit:'g'};assert.ok(composition.activeNutrientEstimate(m));
  const edited=model.normalise({type:'meal',labelKind:'both',basis:'perPortion',nutrients:{},meal:meal()},{userEdited:true});
  assert.equal(edited.nutrients.energyKcal.value,null);assert.notEqual(model.mealScore(edited).scoreBasis,'model_nutrient_estimate');
});
test('deterministic nutrient score ignores arbitrary model scores and retains estimated provenance',()=>{
  const m=meal(),a=score.calculate(m);assert.equal(a.available,true);assert.equal(a.estimated,true);assert.equal(a.scoreBasis,'model_nutrient_estimate');
  assert.equal(a.sourceData.source,'model_photo_estimate');assert.ok(score.validResult(a));
  for(const n of [0,100,-999]){m.score=n;m.grade='A';assert.equal(score.calculate(m).value,a.value);}
  const stronger=meal();stronger.nutrientEstimate.nutrients.salt=10;assert.ok(score.calculate(stronger).value<a.value);
  const unknownFvl=meal();unknownFvl.nutrientEstimate.fvlPercent=null;assert.equal(score.calculate(unknownFvl).available,true);
  const nonfood=meal();nonfood.name='soap';nonfood.nutrientEstimateContext=composition.nutrientEstimateContext(nonfood);assert.equal(score.calculateNutrientEstimate(nonfood),null);
  const components=[{name:'carrot',preparation:'raw',amountGrams:350,recordId:'test:carrot',nutrients:Object.fromEntries(composition.keys.map(k=>[k,{value:proposal().nutrients[k]/3.5,unit:k==='energyKcal'?'kcal':'g',status:'composition_estimate'}])),
    sourceRecord:{id:'test:carrot',basis:'per100g',foodGroup:'vegetable',fvlEligible:true}}];components[0].sourceRecord.nutrients=clone(components[0].nutrients);
  const exact=meal(components);assert.equal(score.calculate(exact).scoreBasis,'sourced_composition');
  for(const name of ['Unknown food','Unidentified object','Ceramic plate','wooden table','soap']){
    const invalid=meal([{name,preparation:'unknown',amountGrams:null,nutrients:{}}]);invalid.name=name;invalid.nutrientEstimateContext=composition.nutrientEstimateContext(invalid);
    assert.equal(composition.mealNutrition(invalid).energyKcal.value,null,name);assert.equal(score.calculate(invalid).available,false,name);
  }
});
test('saving and cleaning retain estimated values, eight units, servings and Today intake',()=>{
  const e=normalise(meal());assert.equal(e.meal.portion.amount,350);assert.equal(e.meal.portionAmbiguity.requiresSelection,false);
  for(const amount of [.5,1,2]){
    const record=model.buildRecord({extraction:e,amount,unit:'portion',day:'2026-10-20',draft:{confirmationId:'estimate-'+amount,slot:'Dinner',name:'Vegetable stew',portionLabel:'portion',portionSource:'estimated',portionBase:1},selection:{fraction:amount,measureId:'serving'},retrievedAt:'2026-10-20T12:00:00Z'});
    const log=foodLog.create({dayNumber:()=>1,recipeKnown:()=>false,composition:()=>composition});
    const [clean]=log.clean({entries:[record]}).entries;assert.ok(clean);assert.equal(clean.portionAmount,350*amount);assert.equal(clean.nutritionStatus,'complete');
    assert.equal(clean.sourceMeta.mealNutrientEstimate.source,'model_photo_estimate');assert.equal(clean.sourceMeta.mealNutrientEstimate.appliedFields.length,8);
    assert.equal(clean.sourceMeta.mealScore.scoreBasis,'model_nutrient_estimate');
    for(const key of composition.keys){const n=clean.nutritionSnapshot[key];assert.equal(n.portion,proposal().nutrients[key]*amount);assert.equal(n.estimated,true);assert.equal(n.source,'model_photo_estimate');assert.equal(n.unit,key==='energyKcal'?'kcal':'g');assert.deepEqual(composition.intakeNutrient(clean,key),{value:n.portion,partial:false,estimated:true});}
  }
  const invalid=meal();invalid.nutrientEstimate.nutrients.fibre=null;const rejected=normalise(invalid);assert.equal(model.snapshot(rejected,{amount:1,unit:'portion'}).fibre.portion,null);
  const zero=meal();zero.nutrientEstimate.nutrients.sugars=0;assert.equal(model.snapshot(normalise(zero),{amount:1,unit:'portion'}).sugars.portion,0);
});
test('confirmed nutrient and score snapshots are not rewritten by current estimation',()=>{
  const m=meal();m.nutrients.energyKcal={value:123,unit:'kcal',status:'confirmed'};m.nutrients.salt={value:null,unit:'g',status:'unknown'};
  const previous=meal();previous.nutrientEstimate.nutrients.salt=10;m.scoreSnapshot=score.calculate(previous);const input={type:'meal',labelKind:'both',basis:'perPortion',nutrients:{},meal:m},before=JSON.stringify(input);
  const e=model.normalise(input,{confirmedSnapshot:true});assert.equal(e.nutrients.energyKcal.value,123);assert.equal(e.nutrients.salt.value,null);assert.equal(model.mealScore(e).value,m.scoreSnapshot.value);assert.equal(JSON.stringify(input),before);
});
