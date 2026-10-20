// Synthetic records exercise missing plant arrays with retained recipe evidence.
// No owner records, images or identifiers are included in this fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const w={Date,console};w.window=w;vm.createContext(w);
for(const file of ['streaks.js','core/food-log.js','core/nutrition-profile.js','core/nudge-score.js','core/food-composition.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/product-evidence.js','core/frequency-policy.js','core/analysis-result.js','today-goals.js','native-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),w,{filename:file});
const copy=x=>JSON.parse(JSON.stringify(x)),day='2026-10-15',options={today:day},empty={foodLog:{entries:[]}},R=w.NudgeNativeReview;
const component=(recordId,name)=>({name,recordId,sourceRecord:{id:recordId,basis:'per100g'},amountGrams:10,amountSource:'recipe_serving',matchStatus:'matched',evidence:'Printed recipe: '+name,nutrients:{}});
const components=[component('usda:170554','chia seed'),component('linwoods:flaxseed-goji-2026-10-11','flaxseed and goji berry'),component('14-325:b05499af697f','blueberries'),component('usda:170562','3 seed mix'),component('usda:167755','mixed berries'),component('usda:170585','5 nut mix'),component('proxy:bulk-plain-pea-protein-2026-10-11','pea protein powder')];
for(const key of ['constructor','toString','__proto__'])assert.deepEqual(copy(w.NudgeComposition.componentPlants([component(key,'Unknown ingredient')])),[],'Prototype names cannot act as source identifiers');
const partial=value=>({portion:null,portionStatus:'partial',unit:'g',knownPortionSubtotal:value,knownContributions:2,unknownContributions:1});
const smoothie={id:'synthetic-smoothie',name:'Synthetic recipe smoothie',day,slot:'Breakfast',portions:1,plants:[],ingredients:{text:components.map(c=>c.name).join(', '),plants:[],needsReview:true},nutritionSnapshot:{sugars:partial(18.25),saturatedFat:partial(6.125)},sourceMeta:{nutritionEstimate:'photo',photoPortions:'1',mealComposition:components,compositionVersion:'fixture'}};
const earlier={id:'synthetic-earlier',name:'Earlier berries',day:'2026-10-14',slot:'Lunch',portions:2,plants:['blueberries','chia seeds','almonds']};
const repeated={...copy(smoothie),id:'synthetic-second-portion',portions:2};
const state={foodLog:{entries:[earlier,smoothie,repeated]}},before=JSON.stringify(state);
let m=w.NudgeToday.projection(state,day),metric=key=>m.compactMetrics.find(x=>x.key===key);
assert.equal(m.dayPlants,4);assert.equal(m.plants.value,4);assert.equal(metric('plants').value,4);
assert.equal(m.weekPlants,5,'Daily repeats and portions never multiply named plant types');
assert.equal(m.weekPlantProgress.value,5);assert.equal(m.weekPlantProgress.days[3].value,4);
assert.equal(m.weekPlantProgress.days[3].cumulative.value,5);
assert.equal(w.NudgeToday.projection(state,'2026-10-14',day).dayPlants,3,'Each day has its own distinct set');
assert.equal(metric('sugars').rawValue,54.75);assert.equal(metric('saturatedFat').rawValue,18.375);
assert.equal(metric('sugars').unknown,2);assert.equal(metric('saturatedFat').unknown,2);
assert.equal(metric('sugars').target,90);assert.equal(metric('sugars').ratio,54.75/90,'A known partial intake fills against the explicit adult reference');
assert.equal(m.weekSugars.value,54.75);assert.equal(m.weekSaturatedFat.value,18.375);
assert.equal(JSON.stringify(state),before,'Projection never rewrites saved plants, source components or partial nutrition');
assert.deepEqual(copy(w.WmdFoodLog.intakePlants(smoothie)),['chia','flax','goji berry','blueberry']);
for(const invalid of [{selected:false},{amountGrams:0},{sourceRecord:{id:'different',basis:'per100g'}},{recovery:{identity:'generic_proxy'}},{evidence:'',matchStatus:'matched'}]){
  const altered=copy(smoothie);altered.sourceMeta.mealComposition=components.map(c=>({...c,...invalid}));
  assert.deepEqual(copy(w.WmdFoodLog.intakePlants(altered)),[],'Unsupported component evidence cannot recover plants');
}
const knownZero={...copy(smoothie),sourceMeta:{...smoothie.sourceMeta,plantSelectionConfirmed:true}};
assert.deepEqual(copy(w.WmdFoodLog.intakePlants(w.WmdFoodLog.clean({entries:[knownZero]}).entries[0])),[],'An explicit empty plant choice survives cleaning and prevents recovery');
const knownSaved={...copy(smoothie),plants:['blueberry']};
assert.deepEqual(copy(w.WmdFoodLog.intakePlants(knownSaved)),['blueberry'],'Existing saved plant choices are not broadened from old provenance');
const missing={...copy(smoothie),nutritionSnapshot:{},sourceMeta:{},ingredients:null};
const zero={...copy(missing),id:'synthetic-zero',nutritionSnapshot:{sugars:{portion:0,portionStatus:'calculated',unit:'g'},saturatedFat:{portion:0,portionStatus:'calculated',unit:'g'}}};
for(const key of ['sugars','saturatedFat']){
  assert.equal(w.NudgeToday.projection({foodLog:{entries:[missing]}},day).compactMetrics.find(x=>x.key===key).value,null);
  assert.equal(w.NudgeToday.projection({foodLog:{entries:[zero]}},day).compactMetrics.find(x=>x.key===key).value,0);
}

// Reanalysis can echo identities without populating its redundant plants array.
const raw={type:'meal',productName:'Synthetic smoothie',nutrients:{},meal:{name:'Synthetic smoothie',ingredients:[],plants:[],components:[],nutrients:{},userIngredientSelection:{source:'user',confirmed:true,names:['Blueberries','Chia seeds','Milk','Pea protein powder']}}};
const rawBefore=JSON.stringify(raw),review=R.prepare({kind:'analysis',extraction:raw,confirmationId:'synthetic-refinement'},empty,options);
assert.deepEqual(copy(R.model(review,empty,options).plants),['blueberry','chia']);
const recorded=R.record(review,empty,options);assert.equal(recorded.ok,true);
assert.deepEqual(copy(recorded.record.plants),['blueberry','chia']);
assert.ok(Object.values(recorded.record.nutritionSnapshot).every(n=>n.portion===null),'Ingredient identities do not invent nutrient amounts');
assert.equal(JSON.stringify(raw),rawBefore);
const legacyTags={...copy(missing),sourceMeta:{mealIngredientSelection:{source:'user',names:['Blueberries','Chia seeds']}}};
assert.deepEqual(copy(w.WmdFoodLog.intakePlants(legacyTags)),['blueberry','chia']);
const conflicting=copy(raw);conflicting.meal.components=components;conflicting.meal.userIngredientSelection.names=['Blueberries'];
const selectedOnly=R.prepare({kind:'analysis',extraction:conflicting,confirmationId:'synthetic-conflict'},empty,options);
assert.deepEqual(copy(R.model(selectedOnly,empty,options).plants),['blueberry'],'Unselected component identities cannot return after reanalysis');
const cleared=R.update(selectedOnly,{mealIngredients:[]},empty,options),clearedRecord=R.record(cleared,empty,options);
assert.equal(clearedRecord.ok,true);assert.equal(clearedRecord.record.sourceMeta.mealIngredientSelection.confirmed,true);
assert.deepEqual(copy(clearedRecord.record.plants),[]);
assert.deepEqual(copy(w.WmdFoodLog.intakePlants(clearedRecord.record)),[],'Explicit empty ingredient selection suppresses source fallback');
assert.equal(w.NudgeToday.projection({foodLog:{entries:[clearedRecord.record]}},day).dayPlants,0);
assert.deepEqual(copy(R.model({kind:'entry',entry:clearedRecord.record,confirmationId:'synthetic-empty-reopen'},empty,options).plants),[]);
const oldEmpty=copy(smoothie);oldEmpty.sourceMeta.mealIngredientSelection={source:'user',names:[]};
assert.equal(w.WmdFoodLog.intakePlants(oldEmpty).length,4,'An old unconfirmed empty hint is still absent, not an explicit removal');
const selected=R.update(R.prepare({kind:'entry',entry:smoothie,confirmationId:'synthetic-edit'},empty,options),{plants:[]},empty,options);
const removed=R.record(selected,empty,options);assert.equal(removed.ok,true);assert.equal(removed.record.sourceMeta.plantSelectionConfirmed,true);
assert.deepEqual(copy(R.model({kind:'entry',entry:removed.record,confirmationId:'synthetic-reopen'},empty,options).plants),[]);
assert.equal(w.NudgeToday.projection({foodLog:{entries:[removed.record]}},day).dayPlants,0);
console.log('Passed named recipe plants, daily/week unions, retained partial sugars/saturates, missing vs zero, read-only legacy repair, reanalysis tags and explicit deselection.');
