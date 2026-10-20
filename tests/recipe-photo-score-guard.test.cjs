// Raw recipe masses can supply total nutrition, but not a cooked per-100 g rating.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const clone=x=>JSON.parse(JSON.stringify(x));
const fields={energyKcal:100,protein:5,carbohydrate:10,sugars:2,fat:4,saturatedFat:1,fibre:3,salt:.1};
const rawComponent={name:'Potato',recordId:'synthetic-raw-potato',amountGrams:100,sourceRecord:{id:'synthetic-raw-potato',basis:'per100g',foodGroup:'vegetable',fvlEligible:false,source:'Synthetic arithmetic fixture',nutrients:Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:'composition_estimate'}]))}};
const recipeCalculation={version:'recipe-composition-v1',applied:true,servings:4,selectedFraction:.25,status:'ready',batchComponents:[{...clone(rawComponent),amountGrams:400}],originalPlateComponents:[]};
function boot(entries=[],storage=new Map()){
 const sandbox={console,Date,Math,setTimeout(){},clearTimeout(){},document:{getElementById:()=>null},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}};
 sandbox.window=sandbox;sandbox.NudgeIcons=()=>'';sandbox.NudgeResults={imageURL:()=>'',finding:()=>''};vm.createContext(sandbox);
 for(const file of ['streaks.js','core/diary.js','core/food-log.js','food-patterns.js','core/nudge-score.js','core/meal-score.js','core/nutrition-profile.js','nudge-fit.js','core/frequency-policy.js','diet.js','scan-history.js','repertoire.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),sandbox,{filename:file});
 const data={foodLog:sandbox.WmdFoodLog.clean({entries})},view={},ctx={getState:()=>data,view,todayKey:()=> '2026-10-05',escapeHtml:v=>String(v??''),render(){},navigate:screen=>view.screen=screen,showToast(){},showDialog(){},save:()=>true};
 const history=sandbox.createNudgeHistory(ctx),repertoire=sandbox.createNudgeRepertoire({...ctx,history}),fit=sandbox.createNudgeFit({...ctx,button:()=>'',nudge:()=>'',foodPatterns:{recipeBy:()=>null}});
 return {sandbox,data,view,history,repertoire,fit,storage};
}
const app=boot(),score=app.sandbox.NudgeMealScore;
const meal={name:'Fish pie',basis:'perPortion',components:[clone(rawComponent)]};
assert.equal(score.calculateDetailed(meal).available,true,'Control: complete ordinary portion can be scored');
for(const variant of [
 {...clone(meal),recipeCalculation:clone(recipeCalculation)},
 {...clone(meal),components:[{...clone(rawComponent),recipeQuantity:{batchAmountGrams:400,servings:4,selectedFraction:.25}}]}
]){
 assert.equal(score.calculateDetailed(variant).available,false);
 const estimated=score.calculate(variant);
 assert.equal(estimated.status,'estimated_rough');
 assert.deepEqual(clone(estimated.inputs.partialNutrition),{},'Neither detailed nor rough scoring divides raw recipe totals by raw mass');
 assert.equal(estimated.inputs.identifiedFood,'fish pie');
}

// Saved records may retain recipe-level provenance without component flags.
// Both the diet and the history-only fallback must carry that provenance forward.
const entry={id:'recipe-entry',name:'Fish pie',day:'2026-10-05',slot:'Dinner',portions:1,plants:['potato'],ferments:[],energyPerPortion:100,proteinPerPortion:5,fibrePerPortion:3,portionAmount:null,portionUnit:null,sourceMeta:{mealComposition:[clone(rawComponent)],mealRecipeCalculation:clone(recipeCalculation),nutritionEstimate:'photo'}};
const saved=boot([entry]);
assert.equal(saved.sandbox.NudgeDiet.scoreResultForEntry(saved.data.foodLog.entries[0]).score.status,'estimated_rough');
assert.match(saved.history.screen(),/Rough/);
const diet=saved.sandbox.NudgeDiet;delete saved.sandbox.NudgeDiet;
assert.match(saved.history.screen(),/Rough/,'Standalone history reconstruction retains recipe provenance');
saved.sandbox.NudgeDiet=diet;
const immutable=JSON.stringify(saved.data.foodLog);
assert.equal(saved.repertoire.saveEntry(saved.data.foodLog.entries[0]),true);
assert.equal(JSON.stringify(saved.data.foodLog),immutable,'Saving a reusable dish does not alter intake');
const template=saved.repertoire.items()[0],reloaded=boot([],saved.storage);
reloaded.repertoire.open(template.id);
assert.deepEqual(clone(reloaded.view.foodDraft.sourceMeta.mealRecipeCalculation),recipeCalculation,'Recipe source records, whole-batch amounts and selected fraction survive save/reload');
reloaded.fit.handleAction('fit-portions','0.5');reloaded.fit.handleAction('fit-confirm');reloaded.fit.handleAction('fit-confirm');
assert.equal(reloaded.data.foodLog.entries.length,1,'Replay still needs one fresh confirmation and ignores duplicate confirmation');
const replay=reloaded.data.foodLog.entries[0],summary=reloaded.sandbox.NudgeDiet.summary(reloaded.data.foodLog.entries);
assert.equal(summary.totals.energyKcal.value,50,'Reusing half the saved quarter scales selected nutrition once');
assert.equal(summary.totals.protein.value,2.5);
assert.deepEqual(clone(replay.sourceMeta.mealRecipeCalculation),recipeCalculation);
assert.equal(reloaded.sandbox.NudgeDiet.scoreResultForEntry(replay).score.status,'estimated_rough');
console.log('PASS: raw-recipe score guard, history/diet reconstruction, durable recipe provenance, and once-only saved-fraction scaling.');
