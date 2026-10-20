// Synthetic retained recipe text only; never owner photographs or diary records.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const s={Date,console};s.window=s;vm.createContext(s);
for(const file of ['streaks.js','core/food-log.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/product-evidence.js','core/frequency-policy.js','core/analysis-result.js','native-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),s,{filename:file});
const clone=x=>JSON.parse(JSON.stringify(x)),C=s.NudgeRecipeComposition,R=s.NudgeNativeReview;
const sentinel='Recipe ingredient could not be linked to the printed text.';
const row=(name,extra={})=>({name,preparation:'raw',amount:null,unit:null,evidence:sentinel,...extra});

test('retained exact ingredient lines restore only unambiguous printed quantities',()=>{
  const rows=[row('milk'),row('onion'),row('red pepper'),row('chicken'),row('tofu'),row('honey'),row('oil'),row('salt')];
  const text='Shopping list\n - 125g milk\n - 200g onion (approx qty 2-3)\n - 1x red pepper\n - 300g chicken (or tofu)\n - 1 tbs honey (or sugar)\n - 2 tbs olive/vegetable oil\nSalt to taste';
  const before=JSON.stringify(rows),result=C.recoverIngredientRows(rows,text);
  assert.deepEqual(clone(result.slice(0,3).map(r=>[r.amount,r.unit,r.evidence])),[[125,'g','- 125g milk'],[200,'g','- 200g onion (approx qty 2-3)'],[1,'count','- 1x red pepper']]);
  assert.ok(result.slice(3).every(r=>r.amount===null&&r.unit===null));
  assert.equal(JSON.stringify(rows),before);
});

test('text recovery cannot override contradictory evidence, duplicate rows, ranges, fractions or multiple amounts',()=>{
  for(const text of ['100–200g milk','-100g milk','100 g milk and 50 g milk','100 g milk, 50 g milk','1/2 tbsp milk','100 g milk\n200 g milk','100 g milk or cream','100 g milk; 50 g oil','100 g milk (50%)']){
    const rows=[row('milk')];assert.deepEqual(clone(C.recoverIngredientRows(rows,text)),rows,text);
  }
  for(const rows of [[row('milk'),row('milk')],[row('milk',{amount:99,unit:'g'})],[row('milk',{evidence:'100 g sugar'})]]){
    const text='100 g milk';
    assert.deepEqual(clone(C.recoverIngredientRows(rows,text)),rows);
  }
  for(const [name,text] of [['milk','300 ml coconut milk'],['milk','300 ml milk (coconut)'],['milk','300 ml milk, coconut'],['chicken','200 g chicken stock'],['tomatoes','2 x 400 g tomatoes']])assert.equal(C.recoverIngredientRows([row(name)],text)[0].amount,null,text);
  const kinds=C.recoverIngredientRows([row('milk'),row('coconut milk')],'300 ml coconut milk');assert.equal(kinds[0].amount,null);assert.equal(kinds[1].amount,300);
});

test('unlogged recipe review recovers sourced partial nutrients and preserves original evidence and saved intake',()=>{
  const milk=s.NudgeMealRecovery.record('12-596:d379c671eb80');
  const rows=[row('milk'),row('salt')];
  const batch=rows.map((r,i)=>({name:r.name,preparation:'raw',amountGrams:null,amountSource:'standard_portion_estimate',photoIndex:1,evidence:sentinel,recipeIngredient:r,
    recordId:i===0?milk.id:null,sourceRecord:i===0?milk:null,nutrients:i===0?milk.nutrients:{}}));
  const meal=C.apply({name:'Synthetic recipe',compositionVersion:'test',portionMode:'estimated_serving',ingredients:rows,plants:[],components:[{name:'prepared dish',amountGrams:300,nutrients:{}}],
    recipeEvidence:{text:'125g milk\nSalt to taste',ingredients:rows,photoIndex:1,componentIndexes:[0]},
    recipeCalculation:{version:C.VERSION,servings:null,photoIndex:1,componentIndexes:[0],batchComponents:batch}},null,{source:'recipe',portionFraction:.5});
  const raw={type:'meal',productName:meal.name,nutrients:{},meal},before=JSON.stringify(raw),state={foodLog:{entries:[]}},options={today:'2026-10-11'};
  const draft=R.prepare({kind:'analysis',extraction:raw,confirmationId:'synthetic-recipe'},state,options),model=R.model(draft,state,options);
  const energy=model.nutrients.find(n=>n.key==='energyKcal');assert.equal(energy.value,null);assert.equal(energy.partial,true);assert.equal(energy.knownSubtotal,125*.5*milk.nutrients.energyKcal.value/100);
  assert.equal(model.recipe.selectedFraction,.5);assert.equal(model.recipe.servings,null);
  assert.match(model.nutritionExplanation,/not whole-meal totals/);
  assert.equal(model.components[0].recipeAmountLabel,'125 g');assert.equal(model.components[0].recipeEvidence,'125g milk');
  assert.equal(model.components[1].recipeAmountLabel,'');assert.equal(model.components[1].recipeEvidence,'');
  assert.equal(model.components[1].missingAmount,true);assert.equal(model.components[1].missingSource,true);
  assert.equal(draft.extraction.meal.recipeCalculation.batchComponents[0].amountGrams,125);
  assert.equal(draft.extraction.meal.recipeCalculation.batchComponents[0].recipeEvidenceRecovery.original.evidence,sentinel);
  assert.equal(JSON.stringify(raw),before);assert.equal(state.foodLog.entries.length,0);
  assert.equal(C.recover(meal,{confirmed:true}),meal);assert.equal(C.recover(meal,{userEdited:true}),meal);
  const saved={id:'saved-unknown',name:'Saved unknown recipe',day:options.today,slot:'Lunch',portions:1,energyPerPortion:null,proteinPerPortion:null,fibrePerPortion:null,plants:[],sourceMeta:{mealComposition:meal.components,mealRecipeCalculation:meal.recipeCalculation}};
  const savedState={foodLog:{entries:[saved]}},savedBefore=JSON.stringify(savedState);
  assert.equal(R.model({kind:'entry',entryId:saved.id},savedState,options).nutrients.find(n=>n.key==='energyKcal').value,null);
  assert.equal(JSON.stringify(savedState),savedBefore);
});
