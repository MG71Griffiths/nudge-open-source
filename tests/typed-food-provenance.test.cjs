const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const files=['streaks.js','core/food-log.js','core/nutrition-profile.js','core/product-evidence.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','core/text-food-analysis.js','food-detail-model.js','core/frequency-policy.js','core/analysis-result.js','native-review.js'];
const scope={console,Date,Math,JSON};scope.window=scope;vm.createContext(scope);for(const f of files)vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',f),'utf8'),scope,{filename:f});
const copy=x=>JSON.parse(JSON.stringify(x)),R=scope.NudgeNativeReview,state={foodLog:{entries:[]},nutritionProfile:{}},options={today:'2026-10-25'},id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function draft(description='sourdough cheese sandwich with chutney'){
 const response=scope.NudgeTextFood.localTextFood({description,requestId:id});assert.ok(response);
 return R.prepare({kind:'entry',entry:response.entry,confirmationId:'typed-food:'+id,day:'2026-10-25'},state,options);
}
test('typed review visibly exposes estimate assumptions and excludes photo-only calculation controls',()=>{
 const m=R.model(draft(),state,options);assert.equal(m.nutritionEstimated,true);assert.match(m.nutritionExplanation,/description/);assert.ok(m.evidenceWarnings.some(x=>/chutney/.test(x)));assert.equal(m.canEditSavedCalculation,false);assert.equal(m.mealBuilder,null);assert.ok(m.sources.some(s=>/CoFID|USDA/.test(s.title)));
});
test('typed nutrient or ingredient edits invalidate prior nutrition score while retaining it as history',()=>{
 for(const patch of [{nutrient:{key:'salt',value:10}},{ingredients:'Different ingredients'},{plants:['apple']}]){
  const before=draft(),score=copy(before.entry.sourceMeta.mealScore),edited=R.update(before,patch,state,options),m=R.model(edited,state,options);
  assert.equal(edited.entry.sourceMeta.mealScore,undefined);assert.deepEqual(copy(edited.entry.sourceMeta.scoreHistory.at(-1)),score);assert.equal(m.score.value,null);
  const result=R.record(edited,state,options);assert.equal(result.ok,true);assert.equal(result.record.sourceMeta.mealScore,undefined);assert.ok(result.record.sourceMeta.typedFood);
 }
});
test('portion edits scale intake without replacing generic composition or restoring unknown nutrients',()=>{
 const original=draft(),before=R.model(original,state,options),edited=R.update(original,{quantity:.5},state,options),after=R.model(edited,state,options);
 const n=(m,key)=>m.nutrients.find(n=>n.key===key);assert.equal(n(after,'energyKcal').value,n(before,'energyKcal').value/2);assert.equal(n(after,'carbohydrate').value,null);assert.equal(n(after,'carbohydrate').knownSubtotal,n(before,'carbohydrate').knownSubtotal/2);assert.equal(after.score.value,before.score.value);
 const result=R.record(edited,state,options);assert.equal(result.ok,true);const cleaned=scope.WmdFoodLog.clean({entries:[result.record]}).entries[0];assert.equal(cleaned.portions,.5);assert.equal(cleaned.nutritionSnapshot.energyKcal.source,'typed_food_estimate');assert.equal(cleaned.nutritionSnapshot.carbohydrate.portion,null);assert.equal(cleaned.sourceMeta.typedFood.description,'sourdough cheese sandwich with chutney');
});
test('two sandwiches disclose bread and cheese multiplied, with separately stated chutney assumption',()=>{
 const response=scope.NudgeTextFood.localTextFood({description:'2 cheese sandwich with chutney',requestId:id});assert.ok(response);assert.deepEqual(copy(response.entry.sourceMeta.typedFood.components.map(c=>c.amountGrams)),[160,60,20]);assert.ok(response.warnings.some(x=>x.includes('Estimated 20 g tomato chutney')));
});
