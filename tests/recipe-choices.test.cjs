// Synthetic shopping-list structure, not owner screenshots or intake records.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const s={Date,console};s.window=s;vm.createContext(s);
for(const file of ['streaks.js','core/food-log.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/product-evidence.js','core/frequency-policy.js','core/analysis-result.js','native-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),s,{filename:file});
const C=s.NudgeRecipeComposition,R=s.NudgeNativeReview,clone=x=>JSON.parse(JSON.stringify(x));
const sentinel='Recipe ingredient could not be linked to the printed text.';
function fixture(){
 const text='Shopping list\n- 500g chicken breast (or tofu)\n- 300ml coconut milk\n- 20g green chillies\n- 1x red bell pepper\n- 2 tbs rapeseed/vegetable/olive oil\n- 1 tbs honey (or palm sugar, sugar)\nIngredients & allergies\nAromatic Paste (Ginger, Garlic, Salt). Seasoning Sauce (Anchovy extract, Salt, Sugar).';
 const names=['chicken breast','tofu','coconut milk','green chillies','red bell pepper','rapeseed/vegetable/olive oil','honey','palm sugar','sugar','Ginger','Garlic','Salt','Anchovy extract'];
 const rows=names.map(name=>({name,preparation:'raw',amount:null,unit:null,evidence:sentinel}));
 const batch=rows.map(row=>({name:row.name,preparation:row.preparation,amountGrams:null,recordId:null,sourceRecord:null,nutrients:{},photoIndex:2,evidence:sentinel,recipeIngredient:row}));
 return C.apply({name:'Synthetic curry recipe',compositionVersion:'test',portionMode:'estimated_serving',ingredients:rows.map(r=>({name:r.name,evidence:r.name})),plants:[{name:'soya',evidence:'tofu'}],qualityEstimate:{proteinType:'poultry_egg'},components:[{name:'recipe illustration',amountGrams:null,nutrients:{}}],recipeEvidence:{text,ingredients:rows,photoIndex:2},recipeCalculation:{version:C.VERSION,photoIndex:2,servings:4,componentIndexes:[0],batchComponents:batch}},4,{source:'user',portionFraction:.25});
}
test('exact printed alternatives become one unresolved component each and nested kit stays one unknown contribution',()=>{
 const input=fixture(),before=JSON.stringify(input),meal=C.recover(input),batch=meal.recipeCalculation.batchComponents,choices=batch.filter(c=>c.recipeChoice);
 assert.equal(choices.length,3);assert.ok(choices.every(c=>c.amountGrams===null&&c.recipeChoice.selected===''));
 assert.deepEqual(clone(choices[1].recipeChoice.options.map(o=>o.title)),['rapeseed oil','vegetable oil','olive oil']);
 assert.equal(batch.filter(c=>c.recipeGroup==='kit').length,1);assert.equal(batch.length,7);
 assert.ok(batch.find(c=>c.name==='coconut milk').amountGrams>280);assert.equal(batch.find(c=>c.name==='red bell pepper').amountGrams,119);
 assert.equal(meal.nutrients.energyKcal.value,null);assert.ok(meal.nutrients.energyKcal.knownSubtotal>100);
 assert.equal(meal.recipeCalculation.selectedFraction,.25);assert.equal(JSON.stringify(input),before);assert.equal(meal.recipeEvidence.text,input.recipeEvidence.text);
 assert.deepEqual(clone(C.recover(meal)),clone(meal),'Reopening an unresolved recipe does not duplicate components');
});
test('choosing one protein contributes once, preserves fraction, and invalidates stale poultry observations',()=>{
 const before=C.recover(fixture()),choice=before.recipeCalculation.batchComponents.find(c=>c.recipeChoice).recipeChoice;
 const chicken=C.selectChoice(before,choice.id,'chicken-breast');
 const poultry=chicken.components.find(c=>c.recipeChoice?.id===choice.id);assert.equal(poultry.name,'chicken breast');assert.equal(poultry.amountGrams,125);assert.ok(poultry.recordId);
 assert.ok(!chicken.ingredients.some(i=>i.name==='tofu'));assert.ok(!chicken.plants.some(p=>p.name==='soya'),'Unselected tofu cannot remain a counted plant');
 const tofu=C.selectChoice(chicken,choice.id,'tofu'),component=tofu.components.find(c=>c.recipeChoice?.id===choice.id);
 assert.equal(component.name,'tofu');assert.equal(component.amountGrams,125);assert.ok(component.recordId);assert.equal(tofu.components.filter(c=>/chicken|tofu/.test(c.name)).length,1);
 assert.equal(tofu.qualityEstimate.proteinType,'plant');assert.ok(!tofu.ingredients.some(i=>i.name==='chicken breast'));assert.equal(tofu.recipeCalculation.selectedFraction,.25);
 assert.deepEqual(clone(C.recover(tofu)),clone(tofu),'Selected option persists through recovery');
 const half=C.apply(tofu,4,{source:'user',portionFraction:.5});assert.equal(half.components.find(c=>c.recipeChoice).amountGrams,250);
 assert.equal(C.selectChoice(tofu,choice.id,'not-printed'),tofu);assert.equal(C.selectChoice(tofu,choice.id,'chicken-breast',{confirmed:true}),tofu);
 const cleared=C.selectChoice(tofu,choice.id,'');assert.equal(cleared.components.find(c=>c.recipeChoice).amountGrams,null);
});
test('native review exposes bounded choices and applies selection without breaking later portion controls',()=>{
 const meal=fixture(),state={foodLog:{entries:[]}},options={today:'2026-10-11'};
 const input={kind:'analysis',confirmationId:'recipe-choice-test',extraction:{type:'meal',productName:meal.name,nutrients:{},meal}};
 const draft=R.prepare(input,state,options),model=R.model(draft,state,options);
 assert.equal(model.recipeChoices.length,3);const choice=model.recipeChoices[0];assert.deepEqual(Object.keys(choice).sort(),['evidence','id','options','selected','title']);
 const edited=R.update(draft,{recipeChoice:{id:choice.id,value:'tofu'}},state,options),selected=R.model(edited,state,options);
 assert.equal(selected.recipeChoices[0].selected,'tofu');assert.equal(selected.recipe.userEdited,false);assert.equal(selected.recipe.selectedFraction,.25);
 const half=R.update(edited,{recipeFraction:.5},state,options);assert.equal(half.extraction.meal.components.find(c=>c.recipeChoice).amountGrams,250);
 assert.equal(state.foodLog.entries.length,0);assert.equal(input.extraction.meal.recipeCalculation.batchComponents[0].amountGrams,null);
 assert.match(selected.nutritionExplanation,/not whole-meal totals/);
});
test('choices do not emerge from ambiguous quantities or paragraphs without a shopping-list section',()=>{
 const row={name:'chicken',amount:null,unit:null,evidence:sentinel};
 for(const text of ['500g chicken or tofu','Shopping list\n300–500g chicken or tofu','Shopping list\n2 x 500g chicken or tofu','Shopping list\n-500g chicken or tofu','Shopping list\n500g chicken or tofu (50%)'])assert.ok(C.planRows([row],text).every(r=>!r.recipeChoice),text);
 const confirmed=fixture();assert.equal(C.recover(confirmed,{confirmed:true}),confirmed);assert.equal(C.recover(confirmed,{userEdited:true}),confirmed);
});
test('explicit recipe-list headings share the same conservative choice rules and stop before other sections',()=>{
 const input=fixture();
 for(const heading of ['Shopping list','Ingredients:','Ingredients list','Recipe ingredients','You will need','You’ll need:','What you will need','What you\'ll need']){
  const meal=clone(input);meal.recipeEvidence.text=meal.recipeEvidence.text.replace('Shopping list',heading);
  const result=C.recover(meal),choices=result.recipeCalculation.batchComponents.filter(c=>c.recipeChoice);
  assert.equal(choices.length,3,heading);assert.ok(choices.every(c=>c.amountGrams===null&&c.recipeChoice.selected===''),heading);
  assert.equal(result.recipeCalculation.batchComponents.filter(c=>c.recipeGroup==='kit').length,1,heading);
 }
 const rows=[{name:'chicken',amount:null,unit:null,evidence:sentinel},{name:'tofu',amount:null,unit:null,evidence:sentinel}];
 for(const heading of ['Ingredients & allergies','Ingredients and allergens','Allergens','May contain','Nutrition facts','Ingredient guesses'])assert.ok(C.planRows(rows,heading+'\n500g chicken or tofu').every(r=>!r.recipeChoice),heading);
 for(const section of ['Method','Instructions:','Directions','Preparation','Nutrition information','Allergens','Storage','Ingredients & allergies'])assert.ok(C.planRows(rows,'Ingredients\n'+section+'\n500g chicken or tofu').every(r=>!r.recipeChoice),section);
 for(const line of ['500g chicken or tofu (optional)','300–500g chicken or tofu','2 x 500g chicken or tofu','-500g chicken or tofu','500g chicken or tofu (50%)'])assert.ok(C.planRows(rows,'Ingredients\n'+line).every(r=>!r.recipeChoice),line);
 assert.ok(C.planRows([{name:'milk',amount:null,unit:null,evidence:sentinel}],'Ingredients\n200ml coconut milk or cream').every(r=>!r.recipeChoice),'An unrelated token is not a matching ingredient identity');
});
test('saved choices stay unchanged until explicit ingredient editing and an explicit save result',()=>{
 const state={foodLog:{entries:[]}},options={today:'2026-10-11'},meal=fixture();
 meal.plants=[]; // Let the selected tofu source supply its botanical evidence.
 const initial=R.prepare({kind:'analysis',confirmationId:'saved-choice',extraction:{type:'meal',productName:meal.name,nutrients:{},meal}},state,options);
 const choice=R.model(initial,state,options).recipeChoices[0];
 const selected=R.update(initial,{recipeChoice:{id:choice.id,value:'tofu'}},state,options),savedResult=R.record(selected,state,options);
 assert.equal(savedResult.ok,true);const saved=savedResult.record,savedState={foodLog:{entries:[saved]}},before=JSON.stringify(savedState);
 const reopened=R.prepare({kind:'entry',entryId:saved.id},savedState,options);
 assert.equal(R.model(reopened,savedState,options).recipeChoices.length,0,'Ordinary opening does not recalculate or expose automatic corrections');
 const ignored=R.update(reopened,{recipeChoice:{id:choice.id,value:'chicken-breast'}},savedState,options);
 assert.equal(R.record(ignored,savedState,options).record.sourceMeta.mealRecipeCalculation.batchComponents[0].recipeChoice.selected,'tofu');
 const editing=R.update(reopened,{editSavedCalculation:true},savedState,options),model=R.model(editing,savedState,options);
 assert.equal(model.recipeChoices[0].selected,'tofu');assert.equal(model.recipe.selectedFraction,.25);
 const changed=R.update(editing,{recipeChoice:{id:choice.id,value:'chicken-breast'}},savedState,options);
 assert.equal(R.model(changed,savedState,options).recipeChoices[0].selected,'chicken-breast');
 assert.match(R.model(changed,savedState,options).ingredients,/coconut milk/);assert.match(R.model(changed,savedState,options).ingredients,/Anchovy extract/,'Other saved ingredient/allergen evidence is retained');
 assert.doesNotMatch(R.model(changed,savedState,options).ingredients,/tofu/,'The unselected protein is removed from active ingredient facts');
 assert.doesNotMatch(R.model(changed,savedState,options).ingredients,/\bsoya\b/,'A source-derived plant alias cannot outlive the removed tofu');
 assert.equal(changed.extraction.meal.components.filter(c=>c.recipeChoice?.id===choice.id).length,1);
 assert.equal(changed.extraction.meal.components.find(c=>c.recipeChoice?.id===choice.id).amountGrams,125);
 const result=R.record(changed,savedState,options);assert.equal(result.ok,true);assert.equal(result.record.id,saved.id);
 assert.equal(result.record.sourceMeta.mealRecipeCalculation.batchComponents[0].recipeChoice.selected,'chicken-breast');
 assert.equal(JSON.stringify(savedState),before,'Draft edit and record construction never write the confirmed entry');
 const nextState={foodLog:{entries:[result.record]}},again=R.update(R.prepare({kind:'entry',entryId:saved.id},nextState,options),{editSavedCalculation:true},nextState,options);
 assert.equal(R.model(again,nextState,options).recipeChoices[0].selected,'chicken-breast');assert.equal(R.model(again,nextState,options).recipe.selectedFraction,.25);
});
test('recipe review computes the whole-batch subtotal once for all eight nutrient rows',()=>{
 const state={foodLog:{entries:[]}},options={today:'2026-10-11'},meal=fixture();
 const prepared=R.prepare({kind:'analysis',confirmationId:'count-batch-totals',extraction:{type:'meal',productName:meal.name,nutrients:{},meal}},state,options);
 const original=s.NudgeComposition,batch=JSON.stringify(prepared.extraction.meal.recipeCalculation.batchComponents);let calls=0;
 s.NudgeComposition={...original,total(components){if(JSON.stringify(components)===batch)calls++;return original.total(components);}};
 try{const model=R.model(prepared,state,options);assert.equal(model.recipe.nutrients.length,8);assert.equal(calls,1);}finally{s.NudgeComposition=original;}
});
test('plain photos, labels and barcode products do not acquire recipe choices from guessed ingredient text',()=>{
 const state={foodLog:{entries:[]}},options={today:'2026-10-11'},text='Ingredients\n500g chicken or tofu';
 const inputs=[
  {kind:'product',product:{name:'Synthetic product',barcode:'1234567890123',basisUnit:'g',ingredients:text,nutrients:{energyKcal:{value:100,unit:'kcal'}}}},
  {kind:'analysis',extraction:{type:'label',labelKind:'both',productName:'Synthetic label',basis:'per100g',ingredients:{text,plants:[]},nutrients:{energyKcal:{value:100,unit:'kcal'}}}},
  {kind:'analysis',extraction:{type:'meal',productName:'Uncertain plate',nutrients:{},meal:{name:'Uncertain plate',compositionVersion:'fixture',portionMode:'estimated_serving',ingredients:[{name:'chicken or tofu',evidence:'Visual interpretation'}],plants:[],components:[{name:'chicken or tofu',amountGrams:null,nutrients:{},evidence:'Visual interpretation'}],recipeEvidence:{text}}}}
 ];
 for(const [i,input]of inputs.entries()){
  const before=JSON.stringify(input),model=R.model({...input,confirmationId:'non-recipe-'+i},state,options);
  assert.equal(model.recipeChoices.length,0);assert.equal(model.recipe,null);assert.equal(JSON.stringify(input),before);
 }
});
