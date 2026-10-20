const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ctx={window:{},Date};ctx.window=ctx;vm.createContext(ctx);
for(const file of ['shared-controls.js','streaks.js','core/diary.js','core/food-log.js','food-patterns.js','core/nutrition-profile.js','nudge-fit.js','core/food-composition.js','today-goals.js'])vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),ctx,{filename:file});
ctx.NudgeIcons=()=>'';const day='2026-10-05',keys=ctx.NudgeComposition.keys;
const source={id:'source:test',basis:'per100g',carbohydrateDefinition:'available'};
const nutrients=Object.fromEntries(keys.map(key=>[key,{value:key==='energyKcal'?100:key==='fibre'?0:10,unit:key==='energyKcal'?'kcal':'g'}]));
const component={recordId:source.id,sourceRecord:source,amountGrams:100,nutrients};
const makeEntry=(patch={})=>({id:'meal',day,name:'Confirmed test meal',portions:1,plants:['carrot'],energyPerPortion:null,proteinPerPortion:null,fibrePerPortion:null,sourceMeta:{photoPortions:'2',mealComposition:[component,{amountGrams:50,nutrients:{}}]},...patch});
const profile=ctx.NudgeNutrition.saveDraft({...ctx.NudgeNutrition.draft({}),target:150,calorieTarget:2750,carbTarget:330,fibreTarget:30,fatTarget:85},{},day);
const state={nutritionProfile:profile,foodLog:{entries:[makeEntry()]}};const before=JSON.stringify(state);
let model=ctx.NudgeToday.model(state,day);
assert.equal(model.energy.value,200);assert.equal(model.protein.value,20);assert.equal(model.carbs.value,20);assert.equal(model.fat.value,20);assert.equal(model.fibre.value,0);
for(const metric of ['protein','energy','carbs','fat','fibre']){assert.equal(model[metric].unknown,1);assert.equal(model[metric].estimated,true);}
assert.equal(model.weekEnergy.value,200);assert.equal(model.weekEnergy.days[0].value,200);assert.equal(model.weekEnergy.days[0].unknown,1);assert.equal(model.weekEnergy.days[1].value,null);
let html=ctx.NudgeToday.screen(state,day,String);assert.match(html,/data-metric="energy" data-progress-state="partial" data-progress-percent="\d+" data-progress-value="200"/);assert.match(html,/Known values · partial/);assert.equal(JSON.stringify(state),before,'Read-only arithmetic must not rewrite saved intake or matched source data');
// Diagnostics contain bounded counts only and do not flood on repeated rendering.
const diagnostic=[];ctx.NudgeDiagnostics={record:(category,outcome,detail)=>diagnostic.push({category,outcome,detail})};ctx.NudgeToday.screen(state,day,String);ctx.NudgeToday.screen(state,day,String);assert.equal(diagnostic.length,1);assert.equal(diagnostic[0].category,'nutrition');assert.equal(diagnostic[0].outcome,'incomplete');assert.deepEqual(JSON.parse(JSON.stringify(diagnostic[0].detail)),{entryCount:1,knownNutrientCount:5,missingNutrientCount:0,partialNutrientCount:5});
const partialAtTarget={...model.energy,target:100};assert.equal(ctx.NudgeToday.status(partialAtTarget),'partial');assert.equal(ctx.NudgeToday.progress(partialAtTarget),200);assert.match(html,/≥ \d+%/);assert.match(html,/Partial totals show only known nutrition/);
// Stored partial fields have already been scaled for the confirmed serving. Do not scale twice.
const snapshot=Object.fromEntries(keys.map(key=>[key,{portion:null,per100:null,unit:key==='energyKcal'?'kcal':'g',portionStatus:'partial',per100Status:'unknown',knownPortionSubtotal:key==='energyKcal'?250:25,knownContributions:1,unknownContributions:1}]));
state.foodLog.entries=[makeEntry({nutritionSnapshot:snapshot,portions:.5})];model=ctx.NudgeToday.model(state,day);assert.equal(model.energy.value,125);assert.equal(model.protein.value,12.5);
const cleaned=ctx.WmdFoodLog.clean(state.foodLog).entries[0];assert.equal(cleaned.nutritionSnapshot.energyKcal.knownPortionSubtotal,250);assert.equal(cleaned.nutritionSnapshot.energyKcal.portion,null);assert.equal(cleaned.nutritionStatus,'incomplete');
assert.equal(ctx.NudgeToday.model(JSON.parse(JSON.stringify(state)),day).energy.value,125);
// A full confirmed value takes precedence over any stale partial/source record.
state.foodLog.entries=[makeEntry({energyPerPortion:700,proteinPerPortion:0})];model=ctx.NudgeToday.model(state,day);assert.equal(model.energy.value,700);assert.equal(model.energy.unknown,0);assert.equal(model.protein.value,0);assert.equal(model.protein.unknown,0);
// No identified source, no amount, invalid unit, or absent portion basis never creates numeric zero.
for(const patch of [{sourceMeta:{photoPortions:'2',mealComposition:[{amountGrams:100,nutrients:{}}]}},{sourceMeta:{photoPortions:'2',mealComposition:[{...component,amountGrams:null}]}},{sourceMeta:{photoPortions:'2',mealComposition:[{...component,sourceRecord:{...source,id:'wrong'}}]}},{sourceMeta:{photoPortions:'2',mealComposition:[{...component,nutrients:{energyKcal:{value:100,unit:'kJ'}}}]}},{sourceMeta:{mealComposition:[component]}}]){state.foodLog.entries=[makeEntry(patch)];model=ctx.NudgeToday.model(state,day);assert.equal(model.energy.value,null);assert.equal(model.energy.unknown,1);}
// Known zero is partial zero, whereas an empty input is wholly unknown.
assert.equal(ctx.NudgeComposition.total([component,{amountGrams:null}]).fibre.knownContributions,1);
assert.equal(ctx.NudgeComposition.total([{amountGrams:100}]).fibre.knownContributions,0);
// Preserve compatible carbohydrates without summing incompatible definitions or
// rewriting the historical entry. The recorded serving multiplier still applies.
state.foodLog.entries=[makeEntry({sourceMeta:{photoPortions:'1',mealComposition:[component,{...component,sourceRecord:{...source,carbohydrateDefinition:'by_difference_including_fibre'}}]}})];
const mixedBefore=JSON.stringify(state);model=ctx.NudgeToday.model(state,day);assert.equal(model.carbs.value,10);assert.equal(model.carbs.unknown,1);assert.equal(model.energy.value,200);assert.equal(JSON.stringify(state),mixedBefore);
state.foodLog.entries[0].portions=.25;model=ctx.NudgeToday.model(state,day);assert.equal(model.carbs.value,2.5);assert.equal(model.carbs.unknown,1);
// Cleaner rejects forged partial metadata and retains unknownness.
for(const bad of [{knownContributions:0},{unknownContributions:0},{knownContributions:40,unknownContributions:1},{knownPortionSubtotal:-1},{unit:'kJ'}]){const item={...snapshot.energyKcal,...bad};const e=ctx.WmdFoodLog.clean({entries:[makeEntry({sourceMeta:null,nutritionSnapshot:{energyKcal:item}})]}).entries[0];assert.equal(e.nutritionSnapshot.energyKcal.portionStatus,'unknown');assert.equal(e.nutritionSnapshot.energyKcal.knownPortionSubtotal,undefined);}
console.log('PASS: confirmed partial nutrient subtotals survive cleaning/reload; daily/weekly rings show known values; zero, unknown, source/basis mismatch, exact serving scales and no read-time writes are preserved.');
