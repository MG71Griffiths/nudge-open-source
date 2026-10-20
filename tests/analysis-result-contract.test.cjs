// These contracts run without a screen, browser, native bridge or storage.
const assert=require('node:assert/strict');
const analysis=require('../Web/core/analysis-result.js');
const composition=require('../Web/core/food-composition.js');
const recipe=require('../Web/core/recipe-composition.js');
const clone=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const model=analysis.create({composition,names:(values,limit=40)=>[...new Set(values.map(v=>String(v).trim().toLowerCase()))].slice(0,limit),suggestion:()=>null});
const keys=['energyKcal','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'];
const values=(energy=200)=>Object.fromEntries(keys.map((key,i)=>[key,{value:i?i:energy,unit:i?'g':'kcal'}]));
const raw=(extra={})=>({type:'legacy',productName:' Food ',labelKind:'nutrition',basis:'per100g',nutrients:values(),...extra});
assert.equal(analysis.version,'analysis-result-v1');
assert.equal(typeof global.document,'undefined');
assert.equal(model.normalise(null),null);

// Source values remain immutable and unit/basis conversion is done exactly once.
for(const [basis,unit,serving] of [['per100g','g',null],['per100ml','ml',null],['perServing','g',{value:40,unit:'g'}]]){
  const input=freeze(raw({basis,servingSize:serving}));
  const before=JSON.stringify(input),result=model.normalise(input);
  for(const amount of [.1,25,100,478,5000]){
    const snapshot=model.snapshot(result,{amount,unit});
    assert.equal(snapshot.energyKcal.portion,200*(serving?100/40:1)*amount/100);
    assert.equal(snapshot.carbohydrate.portion,2*(serving?100/40:1)*amount/100);
    assert.equal(model.snapshot(result,{amount,unit:unit==='g'?'ml':'g'}).energyKcal.portion,null);
  }
  assert.equal(JSON.stringify(input),before);
}
const printed=raw();printed.nutrients.energyKcal={value:418.4,unit:'kJ',relation:'lt'};printed.nutrients.salt={value:250,unit:'mg'};printed.nutrients.fibre=null;
const result=model.normalise(freeze(printed));
assert.equal(result.nutrients.energyKcal.relation,'lt','Relations survive normalization for scoring eligibility');
const converted=model.snapshot(result,{amount:50,unit:'g'});
assert.ok(Math.abs(converted.energyKcal.portion-50)<1e-12);
assert.equal(converted.salt.portion,.125);
assert.equal(converted.fibre.portion,null,'Missing is never zero');

// Ingredient-only evidence cannot replace or manufacture saved nutrition.
const ingredients=model.normalise(freeze(raw({labelKind:'ingredients',ingredients:{text:'Chickpeas, water. May contain sesame.',plants:[{name:'chickpeas',evidence:'Chickpeas'},{name:'sesame',evidence:'sesame'}]}})));
assert.equal(ingredients.basis,'unknown');
assert.deepEqual(model.selectedPlants(ingredients),['chickpeas']);
assert.equal(model.snapshot(ingredients,{amount:100,unit:'g'}).protein.portion,null);
const old=freeze({id:'saved',portionAmount:100,energyPerPortion:180,proteinPerPortion:8,nutritionSnapshot:{protein:{portion:8,per100:8,portionStatus:'calculated',per100Status:'supplied'}}});
assert.equal(model.snapshot(ingredients,{amount:100,unit:'g',old}).protein.retained,true);

// Recipe inputs describe a batch, not the cooked plate weight. A selected share
// scales the recipe only; a side remains a separate component, then eaten counts
// scale that entire selection once.
const component=(name,grams,n)=>({name,amountGrams:grams,nutrients:n,amountSource:'confirmed'});
const batch=[component('fish',400,values(100)),component('milk',null,values(60))];
const meal={name:'Fish pie and side',compositionVersion:'fixture-v1',portionMode:'estimated_serving',ingredients:[],plants:[],components:[component('pie',200,values()),component('side',100,values(20))],recipeCalculation:{version:recipe.VERSION,batchComponents:batch,componentIndexes:[0],servings:4}};
const selected=recipe.apply(meal,4,{portionFraction:.25});
const input=freeze(raw({type:'meal',meal:selected})),before=JSON.stringify(input);
const normalized=model.normalise(input,{recipeLabel:'¼ dish'});
assert.equal(normalized.meal.portion.amount,null);
assert.equal(normalized.nutrients.energyKcal.value,null);
assert.equal(normalized.nutrients.energyKcal.knownSubtotal,120);
const partial=model.snapshot(normalized,{amount:2,unit:'portion',old});
assert.equal(partial.energyKcal.portion,null);
assert.equal(partial.energyKcal.knownPortionSubtotal,240);
assert.equal(partial.energyKcal.portionStatus,'partial');
assert.equal(partial.energyKcal.retained,undefined,'New component evidence does not inherit unrelated old intake');
assert.equal(JSON.stringify(input),before);
const recalculated=model.calculateComposition(freeze(clone(normalized)),{recipeLabel:'¼ dish'});
assert.equal(recalculated.portionConfirmed,true);

const record=model.buildRecord({extraction:normalized,amount:2,unit:'portion',day:'2026-10-05',draft:{confirmationId:'meal-1',slot:'Dinner',name:'Fish pie',brand:'',portionLabel:'portion',portionSource:'estimated',portionBase:1,mealBatchVolumeMl:null},selection:{fraction:2,measureId:'serving'},retrievedAt:'2026-10-05T18:00:00.000Z'});
assert.equal(record.id,'meal-1');assert.equal(record.portions,1);
assert.equal(record.energyPerPortion,null);
assert.equal(record.nutritionSnapshot.energyKcal.knownPortionSubtotal,240);
assert.equal(record.sourceMeta.photoPortions,'2');
assert.equal(record.sourceMeta.mealRecipeCalculation.selectedFraction,.25);
assert.equal(record.sourceMeta.retrievedAt,'2026-10-05T18:00:00.000Z');
assert.equal(JSON.stringify(input),before);

// Explicit clearing of a meal nutrient is not undone by a legacy saved scalar.
const edited=model.normalise(raw({type:'meal',meal:{name:'Meal',ingredients:[],plants:[],nutrients:{}}}));
assert.equal(model.snapshot(edited,{amount:1,unit:'portion',old,corrections:{protein:{value:null}}}).protein.portion,null);
assert.equal(model.snapshot(edited,{amount:1,unit:'portion',old}).protein.portion,8);
console.log('Analysis contract: immutable evidence, measurement bases, unknowns, repairs, recipe shares, partial intake and saved provenance passed without a UI.');
