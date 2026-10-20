const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {boot}=require('./label-photo.test.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
function setup(entries=[],storage=new Map()){
  const app=boot(entries);
  for(const file of ['core/food-composition.js','core/recipe-composition.js','core/meal-score.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),app.sandbox);
  app.sandbox.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web/scan-history.js'),'utf8'),app.sandbox);
  app.sandbox.NudgeHistory=app.sandbox.createNudgeHistory(app.ctx);
  let dialog=null;app.sandbox.NudgeControls.exact=options=>{dialog=options;};
  return {...app,storage,history:app.sandbox.NudgeHistory,applyServings(n){app.action('label-recipe-servings');assert.ok(dialog);return dialog.onApply(n);}};
}
const nutrients=(energy,protein)=>Object.fromEntries(['energyKcal','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'].map(k=>[k,{value:k==='energyKcal'?energy:k==='protein'?protein:0,unit:k==='energyKcal'?'kcal':'g'}]));
const source=(id,name,n)=>({id,name,basis:'per100g',source:'test',carbohydrateDefinition:'available',nutrients:n});
function component(name,grams,n){const record=n?source(name,name,n):null;return {name,amountGrams:grams,recordId:record?.id||null,sourceRecord:record,nutrients:n||{},photoIndex:1,evidence:'Observed '+name,amountSource:'standard_portion_estimate',candidates:[]};}
const original=[component('pie filling',400),component('potato topping',300),component('cabbage side',50,nutrients(20,1))];
const batch=[component('fish',300,nutrients(100,20)),component('potato',600,nutrients(80,2)),component('milk',null,nutrients(60,3))];
const raw={type:'meal',labelKind:'unreadable',basis:'unknown',nutrients:{},meal:{name:'Fish pie and cabbage',portionMode:'estimated_serving',compositionVersion:'test',components:original,ingredients:[],plants:[],recipeCalculation:{version:'recipe-composition-v1',status:'needs_servings',applied:false,servings:null,batchComponents:batch,componentIndexes:[0,1],photoIndex:2,unsupportedAmounts:[{name:'milk',unit:'ml'}]},portion:{amount:750,unit:'g',source:'estimated'},nutrients:{}}};
const app=setup();const whole=clone(raw);whole.meal=app.sandbox.NudgeRecipeComposition.apply(whole.meal,null,{source:'recipe',portionFraction:1});app.review(whole);
assert.match(app.html(),/Set recipe servings/);assert.equal(app.data.foodLog.entries.length,0);
assert.equal(app.controller._state.extraction.nutrients.energyKcal.knownSubtotal,790);
assert.match(app.html(),/Whole dish/);assert.equal(app.applyServings(4),true);
assert.equal(app.controller._state.extraction.meal.components.length,4,'Recipe replaces both filling and topping, retaining one side');
assert.equal(app.controller._state.extraction.meal.portion.amount,null,'Raw recipe weight is not cooked plate weight');
assert.equal(app.controller._state.extraction.nutrients.energyKcal.knownSubtotal,790);
assert.equal(app.controller._state.extraction.nutrients.protein.knownSubtotal,72.5);
assert.match(app.html(),/790 · partial/);assert.doesNotMatch(app.html(),/data-action="label-batch-servings"/);
assert.doesNotMatch(app.html(),/data-action="label-save" disabled/);
app.action('label-recipe-fraction','.25');assert.equal(app.controller._state.extraction.nutrients.energyKcal.knownSubtotal,205,'Quarter recipe includes the full side');
assert.equal(app.applyServings(6),true);assert.equal(app.controller._state.extraction.nutrients.energyKcal.knownSubtotal,205,'Yield edits preserve the selected fraction');
app.action('label-recipe-fraction','.5');assert.equal(app.controller._state.extraction.nutrients.energyKcal.knownSubtotal,400);assert.equal(app.controller._state.extraction.nutrients.protein.knownSubtotal,36.5);
const id=app.controller._state.confirmationId;app.action('label-save');app.action('label-save');
assert.equal(app.data.foodLog.entries.length,1);const saved=clone(app.data.foodLog.entries[0]);
assert.equal(saved.nutritionSnapshot.energyKcal.knownPortionSubtotal,400);assert.equal(saved.energyPerPortion,null);
assert.equal(saved.sourceMeta.mealRecipeCalculation.servings,6);assert.equal(saved.sourceMeta.mealRecipeCalculation.selectedFraction,.5);assert.equal(saved.portionAmount,null);
const reload=setup([saved],app.storage);reload.history.reopen(id);
assert.match(reload.html(),/400 · partial/);assert.equal(reload.controller._state.extraction.meal.recipeCalculation.servings,6);
reload.action('label-save');assert.equal(reload.data.foodLog.entries.length,1);assert.equal(reload.data.foodLog.entries[0].nutritionSnapshot.energyKcal.knownPortionSubtotal,400);
reload.history.reopen(id);reload.action('label-meal-edit');reload.input('label-component-grams-0','90',{change:true});
assert.equal(reload.controller._state.extraction.meal.recipeCalculation.userEdited,true);assert.doesNotMatch(reload.html(),/data-action="label-recipe-servings"/);
const originalSaved=clone(saved);originalSaved.id='old-fish-pie';originalSaved.portionAmount=850;originalSaved.portionUnit='g';originalSaved.nutritionSnapshot=null;originalSaved.energyPerPortion=null;originalSaved.proteinPerPortion=null;delete originalSaved.sourceMeta.mealRecipeCalculation;
const repair=setup([originalSaved]);repair.review(clone(whole),'old-fish-pie');repair.action('label-recipe-fraction','.25');repair.action('label-save');repair.action('label-save');assert.equal(repair.data.foodLog.entries.length,1);assert.equal(repair.data.foodLog.entries[0].id,'old-fish-pie');assert.equal(repair.data.foodLog.entries[0].nutritionSnapshot.energyKcal.knownPortionSubtotal,205);assert.equal(repair.data.foodLog.entries[0].portionAmount,null);
const tiny=setup();const tinyRaw=clone(whole);tinyRaw.meal.recipeCalculation.batchComponents[0].amountGrams=.1;tiny.review(tinyRaw);tiny.action('label-recipe-fraction','.25');tiny.action('label-save');assert.equal(tiny.data.foodLog.entries.length,1,'Positive fractional ingredient grams can be saved');
const missing=setup();missing.review({...raw,meal:{...raw.meal,recipeCalculation:null,components:original.slice(0,2)}});
assert.match(missing.html(),/Nutrition has not been calculated/);assert.match(missing.html(),/rough food score does not provide calories or protein/);
// A replacement analysis must not leave the previous recipe attached to its new
// components: the old fraction controls could otherwise regenerate stale food.
const oldRecipe=clone(saved);oldRecipe.id='old-recipe';oldRecipe.sourceMeta.confirmationId='old-recipe';
const noRecipe=clone(raw);delete noRecipe.meal.recipeCalculation;noRecipe.meal.components=[component('new food',100,nutrients(200,10))];noRecipe.meal.ingredients=[{name:'new food',evidence:'new food'}];
const replacement=setup([oldRecipe]);replacement.review(noRecipe,'old-recipe');const replacementId=replacement.controller._state.confirmationId;replacement.action('label-save');
assert.equal(replacement.data.foodLog.entries.length,1);assert.equal(replacement.data.foodLog.entries[0].sourceMeta.mealRecipeCalculation,undefined);
replacement.history.reopen(replacementId);assert.doesNotMatch(replacement.html(),/data-action="label-recipe-fraction"/);assert.equal(replacement.controller._state.extraction.meal.components[0].name,'new food');
// Diary/repertoire portion edits can multiply a saved recipe share and its side.
// Merely reopening or editing the printed yield must retain that multiplier.
const doubled=clone(saved);doubled.portions=2;
const multiple=setup([doubled],app.storage);multiple.history.reopen(id);
assert.match(multiple.html(),/800 · partial/);assert.match(multiple.html(),/2 × ½ dish/);assert.equal(multiple.element('label-amount').value,'2');
assert.equal(multiple.applyServings(4),true);assert.equal(multiple.controller._state.amount,2);assert.match(multiple.html(),/800 · partial/);
multiple.action('label-save');assert.equal(multiple.data.foodLog.entries.length,1);assert.equal(multiple.data.foodLog.entries[0].nutritionSnapshot.energyKcal.knownPortionSubtotal,800);
multiple.history.reopen(id);multiple.action('label-save');assert.equal(multiple.data.foodLog.entries[0].nutritionSnapshot.energyKcal.knownPortionSubtotal,800,'Repeated review must not compound or discard the saved multiplier');
// Recompute the displayed batch subtotal from its retained ingredient evidence;
// an old cached unknown total must not hide newly supported compatible arithmetic.
const stale=clone(whole);stale.meal.recipeCalculation.batchNutrients={carbohydrate:{value:null,knownSubtotal:0,knownContributions:0}};
stale.meal.recipeCalculation.batchComponents[1].nutrients.carbohydrate.value=20;
stale.meal.recipeCalculation.batchComponents[1].sourceRecord.nutrients.carbohydrate.value=20;
const staleBefore=JSON.stringify(stale),staleReview=setup();staleReview.review(stale);
assert.match(staleReview.html(),/≥ 120 g carbs/);assert.equal(JSON.stringify(stale),staleBefore);assert.equal(staleReview.data.foodLog.entries.length,0);
console.log('Recipe photo review, serving changes, partial totals, saved edits and duplicate prevention passed.');
