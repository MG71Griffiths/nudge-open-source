// Synthetic recipe evidence only. Review projection never writes the diary.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const s={Date,console};s.window=s;vm.createContext(s);
for(const file of ['streaks.js','core/food-log.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/product-evidence.js','core/frequency-policy.js','core/analysis-result.js','native-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),s,{filename:file});
const copy=x=>JSON.parse(JSON.stringify(x)),R=s.NudgeNativeReview;
const milk=s.NudgeMealRecovery.record('12-596:d379c671eb80');
const original=[{name:'smoothie',amountGrams:null,recordId:null,sourceRecord:null,nutrients:{}}];
const batch=[{name:'pea protein powder',amountGrams:null,recordId:null,sourceRecord:null,nutrients:{},recipeIngredient:{name:'pea protein powder',amount:null,unit:null,preparation:'unknown',evidence:'Pea protein powder x 2 tbs'}},{name:'milk',amountGrams:100,recordId:milk.id,sourceRecord:milk,nutrients:milk.nutrients,recipeIngredient:{name:'milk',amount:100,unit:'g',preparation:'unknown',evidence:'100 g milk'}}];
const meal=s.NudgeRecipeComposition.apply({name:'Smoothie with pea protein and milk',compositionVersion:'regression',basis:'perPortion',portionMode:'estimated_serving',components:original,ingredients:[{name:'pea protein powder',evidence:'Pea protein powder x 2 tbs'},{name:'milk',evidence:'100 g milk'}],plants:[],recipeCalculation:{version:s.NudgeRecipeComposition.VERSION,servings:null,componentIndexes:[0],batchComponents:batch}},null,{source:'recipe',portionFraction:1});
const extraction={type:'meal',productName:meal.name,nutrients:{},meal},before=JSON.stringify(extraction),state={foodLog:{entries:[]},nutritionProfile:{}},options={today:'2026-10-11'};
const review=R.prepare({kind:'analysis',extraction,eventId:'synthetic-archive',confirmationId:'synthetic-new'},state,options),model=R.model(review,state,options);
const protein=model.nutrients.find(n=>n.key==='protein');assert.equal(protein.value,15.4);assert.equal(model.score.status,'estimated_rough');assert.ok(model.evidenceWarnings.some(w=>w.includes('Spoon sizes')));assert.ok(model.sources.some(row=>row.url==='https://www.bulksupplements.com/products/pea-protein-powder'));
assert.equal(JSON.stringify(extraction),before);assert.equal(state.foodLog.entries.length,0);
const pending=R.record(review,state,options);assert.equal(pending.ok,true);assert.equal(pending.record.energyPerPortion,122.1);assert.equal(pending.record.proteinPerPortion,15.4);assert.equal(state.foodLog.entries.length,0);
const saved=copy(pending.record),savedState={foodLog:{entries:[saved]},nutritionProfile:{}},savedBefore=JSON.stringify(savedState);
const reopened=R.model({kind:'entry',entryId:saved.id},savedState,options);assert.equal(reopened.nutrients.find(n=>n.key==='protein').value,15.4);assert.equal(JSON.stringify(savedState),savedBefore);
console.log('PASS: native history review upgrades unconfirmed recipe estimates, exposes uncertainty and amount sources, retains source evidence, and requires explicit diary confirmation.');
