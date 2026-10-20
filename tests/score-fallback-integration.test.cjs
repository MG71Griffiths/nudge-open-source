// Actual product controller + renderer with isolated storage and mocked native calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {boot}=require('./food-detail.test.cjs');
function setup(options){
  const app=boot(options);
  for(const file of ['core/meal-score.js','diet.js','core/product-evidence.js','scan-results.js','food-detail-screen.js'])vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),app.sandbox,{filename:file});
  return app;
}
const product={name:'Sugar frosted corn flakes',ingredients:'Maize (61%), sugar (37%), barley malt extract, salt',ingredientsNeedsReview:false,sourceName:'Photo label extraction',basisUnit:'g',nutritionPreparation:'as_sold',servingAmount:30,servingUnit:'g',nutrients:{protein:{value:4,unit:'g',status:'supplied'}}};
const app=setup(),before=JSON.stringify(app.data);app.receive(product);
let score=app.controller.detail().score;assert.equal(score.status,'unrated');assert.equal(score.methodId,app.sandbox.NudgeScoreCore.SCORE_METHOD);assert.equal(score.grade,null);assert.equal(score.value,null);
assert.equal(app.controller.detail().nutrients.energyKcal,null);assert.equal(JSON.stringify(app.data),before);
assert.doesNotMatch(app.controller.screen(),/nf-dial-marker|Rough estimate/);assert.match(app.controller.screen(),/Checking product facts|More label data needed/);assert.doesNotMatch(app.controller.screen(),/Grade null|Model v0.2 · category food_pattern/);
const requests=()=>app.messages.filter(m=>m.action==='product-score');assert.equal(requests().length,1,'Rough fallback must not prevent the source/classification check');
for(let n=0;n<4;n++)app.controller.screen();assert.equal(requests().length,1,'Rendering must not add paid requests');
const request=requests()[0];app.controller.receive({type:'product-score-error',requestId:request.requestId,draftId:request.draftId,code:'offline',error:'Offline'});
assert.equal(app.controller.detail().score.value,score.value);assert.doesNotMatch(app.controller.screen(),/nf-dial-marker/);
app.action('detail-log');app.action('detail-log');assert.equal(app.data.foodLog.entries.length,1);
const saved=JSON.stringify(app.data.foodLog.entries),entry=app.data.foodLog.entries[0];assert.equal(entry.energyPerPortion,null);assert.equal(entry.proteinPerPortion,1.2);assert.equal(entry.sourceMeta.scoreMethod.value,score.value);
assert.match(app.history.screen(),/n-score-unknown/);assert.doesNotMatch(app.history.screen(),/Rough estimate/);
const reloaded=setup({storage:app.storage,reload:true});reloaded.history.reopen('scan-fixture');assert.equal(JSON.stringify(reloaded.data.foodLog.entries),saved);assert.equal(reloaded.controller.detail().score.value,score.value);reloaded.action('detail-log');assert.equal(reloaded.data.foodLog.entries.length,1);
// Strict numeric methods still win, including a genuine zero; no fallback for no identified food.
const full={...product,scoringFacts:{fvlPercent:{value:0,source:'declared',evidence:'Synthetic complete cereal fixture'}},nutrients:Object.fromEntries(Object.entries({energyKcal:500,protein:3,fibre:1,fat:20,saturatedFat:10,carbohydrate:60,sugars:35,salt:2}).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:'supplied'}]))};
assert.equal(app.model.score(full).value,0);assert.notEqual(app.model.score(full).status,'estimated_rough');
// Earlier confirmed product estimates remain historical, even when current source facts differ.
const historicalScore=app.sandbox.NudgeMealScore.estimate(product);assert.equal(historicalScore.status,'estimated_rough');
const historicalEntry={...entry,sourceMeta:{...entry.sourceMeta,scoreMethod:historicalScore}},historicalBefore=JSON.stringify(historicalEntry);
const historical=app.sandbox.NudgeDiet.scoreResultForEntry(historicalEntry,{productForEntry:()=>full});
assert.equal(historical.saved,true);assert.equal(historical.legacy,true);assert.equal(historical.score.value,historicalScore.value);assert.equal(JSON.stringify(historicalEntry),historicalBefore);
assert.equal(app.model.score({name:'Your food',nutrients:{}}).value,null);
for(const food of [{name:'Orange wine',categories:['en:wines']},{name:'Fruit beer',categories:['en:beers']},{name:'Salad',isFood:false},{name:'Salad',nonFood:true}])assert.equal(app.model.score(food).value,null,'Product adaptation must preserve exclusion evidence');
for(const [value,tone] of [[0,'red'],[24,'red'],[25,'amber'],[49,'amber'],[50,'green'],[100,'green']])assert.equal(app.sandbox.NudgeScoreCore.displayTone(value),tone);
console.log('PASS: incomplete photo product stays unrated without unrelated heuristic, source check still runs once, offline retains score, confirmation/reload keeps ID and unknown nutrients, complete zero wins.');
