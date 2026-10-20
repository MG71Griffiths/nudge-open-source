// Native screens use these projections over the established domain engines.
// No browser, storage, API, or UI is required to confirm the same food evidence.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const s={Date,console};s.window=s;vm.createContext(s);
for(const file of ['streaks.js','core/food-log.js','core/nudge-score.js','core/food-composition.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/product-evidence.js','core/frequency-policy.js','core/analysis-result.js','native-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),s,{filename:file});
const R=s.NudgeNativeReview,clone=x=>JSON.parse(JSON.stringify(x)),options={today:'2026-10-07',now:'2026-10-07T12:00:00Z'},state={foodLog:{entries:[]},nutritionProfile:{}};
const n=(model,key)=>model.nutrients.find(x=>x.key===key),near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const nutrients=values=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:'supplied'}]));
const product={name:'Smoothie',brand:'Test',barcode:'1234567890123',basisUnit:'ml',nutritionPreparation:'as_sold',ingredients:'Blueberries, milk, oats.',nutrients:nutrients({energyKcal:50,protein:2,carbohydrate:8,fat:1,saturatedFat:.2,sugars:5,salt:0}),sourceName:'Test label'};
const original=JSON.stringify(product);
let r=R.prepare({kind:'product',product,confirmationId:'product-1'},state,options),m=R.model(r,state,options);
assert.equal(m.valid,true);assert.equal(m.amount,250);assert.equal(n(m,'energyKcal').value,125);assert.equal(n(m,'carbohydrate').value,20);assert.equal(n(m,'salt').value,0);assert.equal(n(m,'fibre').value,null);
assert.ok(m.measures.some(x=>x.id==='cup'));assert.ok(m.measures.some(x=>x.id==='half-pint'));assert.equal(m.measures.some(x=>x.id==='g'),false);
r=R.update(r,{measureId:'half-pint'},state,options);r=R.update(r,{quantity:1},state,options);m=R.model(r,state,options);near(m.amount,284.130625);near(n(m,'carbohydrate').value,22.73045);
let result=R.record(r,state,options);assert.equal(result.ok,true);near(result.record.nutritionSnapshot.carbohydrate.portion,22.73045);assert.equal(result.record.nutritionSnapshot.fibre.portion,null);
assert.equal(R.record(r,state,options).record.id,result.record.id,'Retries share the same confirmation identity');assert.equal(state.foodLog.entries.length,0,'Projection never writes the diary');assert.equal(JSON.stringify(product),original);
for(const quantity of ['',0,-1,'n/a',5001,Infinity])assert.equal(R.model(R.update(r,{quantity},state,options),state,options).valid,false,String(quantity));
assert.equal(R.model(R.update(r,{day:'2026-10-08'},state,options),state,options).valid,false);
assert.equal(R.model(R.update(r,{day:'2026-02-30'},state,options),state,options).valid,false);
assert.equal(R.model(R.update(r,{name:''},state,options),state,options).valid,false);
const invalid=R.update(r,{nutrient:{key:'carbohydrate',value:'banana'}},state,options);assert.equal(R.model(invalid,state,options).valid,false);assert.equal(invalid.product.nutrients.carbohydrate.value,8);
const zero=R.update(r,{nutrient:{key:'carbohydrate',value:'0'}},state,options);assert.equal(R.model(zero,state,options).valid,true);assert.equal(n(R.model(zero,state,options),'carbohydrate').value,0);
const unknown=R.update(r,{nutrient:{key:'carbohydrate',value:''}},state,options);assert.equal(n(R.model(unknown,state,options),'carbohydrate').value,null);
const renamed=R.update(r,{brand:'New brand'},state,options);assert.equal(renamed.product.brand,'New brand');
const mass=R.model({kind:'product',product:{...product,basisUnit:'g'},confirmationId:'mass'},state,options);assert.equal(mass.measures.some(x=>x.id==='cup'),false,'Mass is not volume');

// Missing recipe quantities retain a known subtotal, never a fabricated total.
const component=(name,grams,values)=>{const record={id:name,name,basis:'per100g',source:'Fixture',carbohydrateDefinition:'available',nutrients:nutrients(values)};return {name,amountGrams:grams,recordId:name,sourceRecord:record,nutrients:record.nutrients,amountSource:'confirmed',candidates:[]};};
const batch=[component('fish',300,{energyKcal:100,protein:20,carbohydrate:0,fat:1}),component('potato',600,{energyKcal:80,protein:2,carbohydrate:20,fat:0}),component('milk',null,{energyKcal:60,protein:3,carbohydrate:5,fat:3})];
const side=component('cabbage',50,{energyKcal:20,protein:1,carbohydrate:4,fat:0});
let pie={type:'meal',productName:'Fish pie and cabbage',nutrients:{},meal:{name:'Fish pie and cabbage',compositionVersion:'test',ingredients:[],plants:[],components:[component('pie',700,{}),side],recipeCalculation:{version:s.NudgeRecipeComposition.VERSION,batchComponents:batch,componentIndexes:[0],servings:4},portion:{amount:750,unit:'g'},nutrients:{}}};
pie.meal=s.NudgeRecipeComposition.apply(pie.meal,4,{portionFraction:1,source:'user'});
const beforePie=JSON.stringify(pie);
r=R.prepare({kind:'analysis',extraction:pie,confirmationId:'pie-1'},state,options);m=R.model(r,state,options);
assert.equal(m.recipe.selectedFraction,1);assert.equal(m.amount,null);assert.equal(m.measures.some(x=>x.id==='g'),false);assert.equal(m.measures.some(x=>x.id==='cup'),false);
assert.equal(n(m,'energyKcal').value,null);assert.equal(n(m,'energyKcal').knownSubtotal,790);assert.equal(n(m,'carbohydrate').knownSubtotal,122);
r=R.update(r,{recipeFraction:.25},state,options);m=R.model(r,state,options);assert.equal(n(m,'energyKcal').knownSubtotal,205);assert.equal(n(m,'carbohydrate').knownSubtotal,32,'Quarter pie retains full side');
assert.equal(n({nutrients:m.recipe.nutrients},'carbohydrate').knownSubtotal,120,'Whole dish excludes separate side');
r=R.update(r,{recipeServings:6},state,options);m=R.model(r,state,options);assert.equal(m.recipe.servings,6);assert.equal(m.recipe.selectedFraction,.25);assert.equal(n(m,'carbohydrate').knownSubtotal,32,'Yield does not reset share');
result=R.record(r,state,options);assert.equal(result.ok,true);assert.equal(result.record.nutritionSnapshot.carbohydrate.portion,null);assert.equal(result.record.nutritionSnapshot.carbohydrate.knownPortionSubtotal,32);assert.equal(result.record.sourceMeta.mealRecipeCalculation.selectedFraction,.25);assert.equal(result.record.portionAmount,null);
assert.equal(JSON.stringify(pie),beforePie);
r=R.update(r,{component:{index:1,amountGrams:100}},state,options);m=R.model(r,state,options);assert.equal(m.recipe.userEdited,true);assert.equal(n(m,'carbohydrate').knownSubtotal,22,'Ingredient edit recalculates source-backed carbohydrate');
const badIngredient=R.update(r,{component:{index:1,amountGrams:'no'}},state,options);assert.equal(R.model(badIngredient,state,options).valid,false);assert.equal(badIngredient.extraction.meal.components[1].amountGrams,100);

// A saved portion can be multiplied, edited, and reopened without re-estimating.
const saved=clone(result.record);saved.portions=2;saved.day='2026-10-06';const savedState={foodLog:{entries:[saved]},nutritionProfile:{}};
r=R.prepare({kind:'entry',entryId:saved.id,confirmationId:'different'},savedState,options);m=R.model(r,savedState,options);assert.equal(n(m,'carbohydrate').knownSubtotal,64);assert.equal(m.editing,true);
let edited=R.record(r,savedState,options);assert.equal(edited.record.id,saved.id);assert.equal(edited.record.portions,2);assert.equal(edited.record.nutritionSnapshot.carbohydrate.knownPortionSubtotal,32,'Save does not compound base values');
r=R.update(r,{quantity:3},savedState,options);assert.equal(n(R.model(r,savedState,options),'carbohydrate').knownSubtotal,96);edited=R.record(r,savedState,options);assert.equal(edited.record.portions,3);
const cleared=R.update(r,{nutrient:{key:'carbohydrate',value:''}},savedState,options);assert.equal(n(R.model(cleared,savedState,options),'carbohydrate').knownSubtotal,null);assert.equal(n(R.model(cleared,savedState,options),'carbohydrate').value,null);
assert.equal(R.record({kind:'entry',entryId:'deleted',confirmationId:'missing'},savedState,options).ok,false,'Stale edit cannot turn into new intake');
const fresh=R.record({kind:'entry',entry:saved,confirmationId:'fresh'},state,options);assert.equal(fresh.record.id,'fresh');assert.equal(fresh.record.sourceMeta.confirmationId,'fresh');
assert.equal(fresh.record.sourceMeta.entryKind,'saved-food');assert.equal(fresh.record.sourceMeta.productScanEventId,'');
const editCalculation=R.update(R.prepare({kind:'entry',entryId:saved.id},savedState,options),{editSavedCalculation:true},savedState,options);
assert.equal(editCalculation.kind,'analysis');assert.equal(n(R.model(editCalculation,savedState,options),'carbohydrate').knownSubtotal,64,'Explicit component edit retains the saved multiplier');
assert.equal(R.record(editCalculation,savedState,options).record.id,saved.id);

// Photos retain basis, named plant evidence, and calories/protein/carbs/fat.
const raw={type:'label',productName:'Yoghurt',labelKind:'both',basis:'per100g',nutrients:nutrients({energyKcal:100,protein:10,carbohydrate:6,fat:4,fibre:0}),ingredients:{text:'Milk, oats. May contain peanuts.',plants:[{name:'oats',evidence:'oats'},{name:'peanut',evidence:'peanuts'}]}};
r=R.prepare({kind:'analysis',extraction:raw,confirmationId:'label'},state,options);r=R.update(r,{quantity:150},state,options);m=R.model(r,state,options);assert.equal(n(m,'energyKcal').value,150);assert.equal(n(m,'protein').value,15);assert.equal(n(m,'carbohydrate').value,9);assert.equal(n(m,'fat').value,6);assert.deepEqual(clone(m.plants),['oats']);
assert.equal(R.record(r,state,options).record.nutritionSnapshot.carbohydrate.portion,9);
const meal={type:'meal',productName:'Smoothie',nutrients:{},meal:{name:'Smoothie',portion:{amount:900,unit:'g'},ingredients:[],plants:[],nutrients:nutrients({energyKcal:600,protein:30,carbohydrate:80,fat:20})}};
r=R.prepare({kind:'analysis',extraction:meal,confirmationId:'smoothie'},state,options);assert.equal(R.model(r,state,options).measures.some(x=>x.id==='cup'),false);r=R.update(r,{batchVolumeMl:1000},state,options);r=R.update(r,{measureId:'cup'},state,options);r=R.update(r,{quantity:1},state,options);m=R.model(r,state,options);assert.equal(n(m,'energyKcal').value,150);assert.equal(n(m,'carbohydrate').value,20);

// Estimate labels follow values actually used, including saved values when no
// rating is available. A retained but unused proposal is not model nutrition.
{
  const estimatedMeal={name:'Synthetic vegetable stew',compositionVersion:'test',portionMode:'estimated_serving',components:[],ingredients:[],plants:[],nutrients:{},
    nutrientEstimate:{version:1,basis:'perPortion',portionGrams:250,category:'general',fvlPercent:null,
      nutrients:{energyKcal:300,protein:10,carbohydrate:40,sugars:5,fat:10,saturatedFat:3,fibre:4,salt:.7},assumptions:['Synthetic test portion.']}};
  estimatedMeal.nutrientEstimateContext=s.NudgeComposition.nutrientEstimateContext(estimatedMeal);
  const input={kind:'analysis',extraction:{type:'meal',nutrients:{},meal:estimatedMeal},confirmationId:'synthetic-estimate-label'},before=JSON.stringify(input);
  const projected=R.model(input,state,options);
  assert.equal(projected.nutritionEstimated,true);assert.equal(n(projected,'energyKcal').value,300);assert.equal(JSON.stringify(input),before);
  const sourceBacked=clone(estimatedMeal);
  sourceBacked.components=[component('synthetic source',250,{energyKcal:120,protein:4,carbohydrate:16,sugars:2,fat:4,saturatedFat:1.2,fibre:1.6,salt:.28})];
  sourceBacked.nutrientEstimateContext=s.NudgeComposition.nutrientEstimateContext(sourceBacked);
  assert.equal(R.model({...input,extraction:{type:'meal',nutrients:{},meal:sourceBacked}},state,options).nutritionEstimated,false);
  const entry={id:'synthetic-estimated-entry',name:'Synthetic saved estimate',day:options.today,slot:'Snack',portions:1,plants:[],
    nutritionSnapshot:{energyKcal:{portion:300,portionStatus:'calculated',unit:'kcal',estimated:true,source:'model_photo_estimate'}},sourceMeta:{}};
  const entryBefore=JSON.stringify(entry),entryModel=R.model({kind:'entry',entry,confirmationId:'synthetic-estimated-review'},state,options);
  assert.equal(entryModel.score.value,null);assert.equal(entryModel.nutritionEstimated,true);assert.equal(JSON.stringify(entry),entryBefore);
  const noAppliedValue=clone(entry);noAppliedValue.nutritionSnapshot.energyKcal.portion=null;
  assert.equal(R.model({kind:'entry',entry:noAppliedValue,confirmationId:'synthetic-unknown-review'},state,options).nutritionEstimated,false);
  assert.equal(R.model({kind:'product',product,confirmationId:'synthetic-label-review'},state,options).nutritionEstimated,false);
}
// An unresolved general food receives estimated nutrition without a database
// source. Opening/saving its calculation retains the saved serving and score.
{
  const m={name:'Curry',compositionVersion:'test',portionMode:'estimated_serving',components:[{name:'curry',preparation:'cooked; recipe unknown',amountGrams:null,nutrients:{},recordId:null}],ingredients:[],plants:[],nutrients:{},
    nutrientEstimate:{version:1,basis:'perPortion',portionGrams:350,category:'general',fvlPercent:30,nutrients:{energyKcal:450,protein:15,carbohydrate:50,sugars:8,fat:20,saturatedFat:4,fibre:9,salt:1.5},assumptions:['Synthetic typical serving with assumed oil and seasoning.']}};
  m.nutrientEstimateContext=s.NudgeComposition.nutrientEstimateContext(m);
  const capture=R.prepare({kind:'analysis',extraction:{type:'meal',nutrients:{},meal:m},confirmationId:'synthetic-curry'},state,options);
  const half=R.update(capture,{quantity:.5},state,options),projection=R.model(half,state,options);
  assert.equal(projection.nutritionEstimated,true);assert.equal(projection.score.scoreBasis,'model_nutrient_estimate');assert.equal(n(projection,'energyKcal').value,225);
  const saved=R.record(half,state,options);assert.equal(saved.ok,true);assert.equal(saved.record.nutritionStatus,'complete');assert.equal(saved.record.sourceMeta.mealComposition[0].amountGrams,null);
  const savedBefore=JSON.stringify(saved.record),savedState={foodLog:{entries:[saved.record]},nutritionProfile:{}};
  const reopened=R.prepare({kind:'entry',entryId:saved.record.id},savedState,options),edit=R.update(reopened,{editSavedCalculation:true},savedState,options),visible=R.model(edit,savedState,options);
  assert.equal(visible.nutritionEstimated,true);assert.equal(n(visible,'energyKcal').value,225);assert.equal(visible.score.value,projection.score.value);
  const unchanged=R.record(edit,savedState,options);assert.equal(unchanged.ok,true);assert.equal(unchanged.record.id,saved.record.id);
  for(const key of s.NudgeComposition.keys){assert.equal(unchanged.record.nutritionSnapshot[key].portion,saved.record.nutritionSnapshot[key].portion);assert.equal(unchanged.record.nutritionSnapshot[key].estimated,true);}
  assert.equal(unchanged.record.portionAmount,saved.record.portionAmount);assert.equal(JSON.stringify(saved.record),savedBefore);
  const changed=R.update(edit,{component:{index:0,amountGrams:400}},savedState,options),changedModel=R.model(changed,savedState,options);
  assert.equal(n(changedModel,'energyKcal').value,null);assert.notEqual(changedModel.score.scoreBasis,'model_nutrient_estimate');assert.equal(JSON.stringify(saved.record),savedBefore);
}

// Label repair delegates source identity and preparation compatibility. Replacing
// the table may not import its missing nutrients from a stale database table.
const prior=R.prepare({kind:'product',product:{...product,sourceURL:'https://world.openfoodfacts.org/product/1234567890123',licenceName:'ODbL',licenceURL:'https://opendatacommons.org/licenses/odbl/',retrievedAt:'2026-10-06'},confirmationId:'prior'},state,options);
const label={type:'product',productName:'Smoothie',brand:'Test',labelKind:'nutrition',basis:'per100ml',nutritionPreparation:'as_sold',nutrients:nutrients({energyKcal:70,protein:3})};
let repaired=R.prepare({kind:'analysis',extraction:label,previousReview:prior,eventId:'repair-label',confirmationId:'repair-confirm'},state,options);
assert.equal(repaired.kind,'product');assert.equal(repaired.product.barcode,product.barcode);assert.equal(repaired.product.nutrients.energyKcal.value,70);assert.equal(repaired.product.nutrients.carbohydrate,undefined);
m=R.model(repaired,state,options);assert.equal(m.amount,250);assert.equal(n(m,'energyKcal').value,175);assert.equal(n(m,'carbohydrate').value,null);assert.ok(m.sources.some(x=>x.url.includes('opendatacommons')));
const mismatched=R.prepare({kind:'analysis',extraction:{...label,brand:'Another product'},previousReview:prior,confirmationId:'conflict'},state,options);assert.equal(mismatched.product.barcode,'');assert.equal(mismatched.product.imageURL,'');assert.ok(R.model(mismatched,state,options).evidenceWarnings.length);
const ingredientsRepair=R.prepare({kind:'analysis',extraction:{...label,labelKind:'ingredients',ingredients:{text:'Milk, strawberries',plants:[{name:'strawberry',evidence:'strawberries'}]}},previousReview:prior,confirmationId:'ingredients-only'},state,options);
assert.equal(ingredientsRepair.product.nutrients.carbohydrate.value,8);assert.equal(ingredientsRepair.product.ingredients,'Milk, strawberries');
const logged=R.record(R.update(prior,{measureId:'ml',quantity:120},state,options),state,options).record;logged.portions=2;
const repairState={foodLog:{entries:[logged]}};
const loggedRepair=R.prepare({kind:'analysis',entryId:logged.id,extraction:label,previousReview:prior,confirmationId:'logged-repair'},repairState,options);
assert.equal(loggedRepair.kind,'analysis');assert.equal(loggedRepair.draft.amount,120);assert.equal(loggedRepair.draft.unit,'ml');
const loggedResult=R.record(loggedRepair,repairState,options);assert.equal(loggedResult.record.id,logged.id);assert.equal(loggedResult.record.portions,2);assert.equal(loggedResult.record.nutritionSnapshot.energyKcal.portion,84);
assert.equal(loggedResult.record.barcode,product.barcode);
const malformed=R.model({kind:'analysis',extraction:null,confirmationId:'broken'},state,options);assert.equal(malformed.valid,false);assert.equal(n(malformed,'energyKcal').value,null);

// Planning is recalculated from the same shared rules as barcode review. It
// includes the selected portion, other food in the occasion and live suitability.
const wrap={name:'Pinned test wrap',scoringFacts:{fvlPercent:{value:0,source:'declared',evidence:'Synthetic fixture'}},barcode:'wrap-fixture',categoryTag:'en:wraps',basisUnit:'g',nutritionPreparation:'as_sold',ingredients:'Chicken, wheat wrap, vegetables',servingAmount:250,servingUnit:'g',energyKj:{value:772,unit:'kJ',status:'supplied'},nutrients:nutrients({energyKcal:184,protein:9.8,fibre:1.9,saturatedFat:1.4,sugars:3.6,salt:.96,fat:7,carbohydrate:20}),servingNutrients:nutrients({salt:2.39}),servingNutrientSource:{title:'Pinned fixture serving',url:'https://example.test/pinned-serving'}};
let planned=R.prepare({kind:'product',product:wrap,confirmationId:'wrap'},state,options);planned=R.update(planned,{slot:'Lunch'},state,options);
m=R.model(planned,state,options);assert.equal(m.score.value,50);assert.equal(m.planning,null);assert.equal(n(m,'salt').value,2.39);
const priorFood={id:'prior-salt',name:'Earlier meal',day:options.today,slot:'Lunch',portions:1,nutritionSnapshot:{salt:{portion:2,portionStatus:'calculated',unit:'g'}}};
const occasion={foodLog:{entries:[priorFood]}};m=R.model(planned,occasion,options);assert.equal(m.planning,null);assert.equal(m.score.value,50,'Other meals cannot turn nutrient quality into an eating prescription');
const unknownOccasion={foodLog:{entries:[{...priorFood,nutritionSnapshot:{}}]}};m=R.model(planned,unknownOccasion,options);assert.equal(m.planning,null);
const conflict=clone(planned);conflict.product.servingNutrients.salt.value=.1;m=R.model(conflict,state,options);assert.equal(m.planning,null);
for(const [status,expected] of [['checking','check_required'],['potential_match','check_required'],['check_unavailable','check_required'],['matched','unsuitable']]){
  const current=clone(planned);current.product.recallAssessment={status};m=R.model(current,state,options);assert.equal(m.planning,null);assert.equal(m.score.value,50,'Suitability does not alter nutrition quality');
}
m=R.model(planned,{foodLog:{entries:[]},nutritionProfile:{allergies:['gluten']}},options);assert.equal(m.planning,null);assert.equal(m.allergies.conflict,true);
m=R.model(planned,{foodLog:{entries:[]},nutritionProfile:{care:'clinical'}},options);assert.equal(m.planning,null);
const recordedWrap=R.record(planned,state,options).record,wrapState={foodLog:{entries:[recordedWrap,priorFood]}};
const savedWrap=R.model({kind:'entry',entryId:recordedWrap.id,confirmationId:'same'},wrapState,options);assert.equal(savedWrap.planning,null);assert.equal(savedWrap.score.value,50);
assert.equal(typeof s.document,'undefined');assert.equal(typeof s.localStorage,'undefined');
console.log('Native food review: pure projections, exact units, all nutrients, recipe shares/sides, partial totals, saved edits, unknowns, validation and stable confirmations passed.');
