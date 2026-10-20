const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const s={Date,console};s.window=s;vm.createContext(s);
for(const file of ['streaks.js','core/food-log.js','core/nudge-score.js','core/food-composition.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/product-evidence.js','core/frequency-policy.js','core/analysis-result.js','native-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),s,{filename:file});
const R=s.NudgeNativeReview,clone=x=>JSON.parse(JSON.stringify(x)),state={foodLog:{entries:[]}},options={today:'2026-10-07',now:'2026-10-07T12:00:00Z'};
const nutrients=Object.fromEntries(Object.entries({energyKcal:90,protein:1,carbohydrate:20,fat:.3,fibre:3,salt:0,sugars:12,saturatedFat:.1}).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:'supplied'}]));
const banana={name:'Banana',amountGrams:100,amountSource:'estimated',recordId:'banana-test',sourceRecord:{id:'banana-test',name:'Banana',basis:'per100g',carbohydrateDefinition:'available',nutrients,source:'Test fixture'},nutrients,evidence:'Visible banana'};
const raw={type:'meal',productName:'Smoothie',nutrients:{},meal:{name:'Smoothie',compositionVersion:'test',components:[banana],ingredients:[{name:'Banana',evidence:'Visible banana'}],plants:[{name:'banana',evidence:'banana'}],portion:{amount:100,unit:'g'},nutrients:{}}};
let r=R.prepare({kind:'analysis',extraction:raw,confirmationId:'test-tags'},state,options),m=R.model(r,state,options);
assert.equal(m.mealBuilder.allIngredients.length,130);assert.ok(m.mealBuilder.catalogue.length<130);assert.deepEqual(clone(m.mealBuilder.selected),[]);
const additionalNuts=['Brazil nuts','Pecans','Hazelnuts','Macadamias','Pistachios','Pine nuts','Chestnuts','Coconut'];
for(const name of additionalNuts)assert.ok(m.mealBuilder.catalogue.some(c=>c.name===name),name+' must be selectable');
assert.equal(r.extraction.meal.components.length,1,'Displaying the full catalogue cannot silently add ingredients');
const original=JSON.stringify(r);
r=R.update(r,{mealIngredients:['Banana','Kefir','Chia seeds'],mealPortion:{amount:500,unit:'ml'}},state,options);m=R.model(r,state,options);
assert.equal(r.extraction.meal.components[0].amountGrams,100);assert.equal(r.extraction.meal.components[0].sourceRecord.id,'banana-test');
assert.equal(r.extraction.meal.components[0].amountSource,'estimated','Confirming identity does not confirm estimated weight');
assert.equal(r.extraction.meal.components[1].amountGrams,null);assert.equal(r.extraction.meal.components[2].recordId,null);
assert.equal(m.nutrients.find(n=>n.key==='energyKcal').value,null);assert.equal(m.nutrients.find(n=>n.key==='energyKcal').knownSubtotal,90);
assert.equal(m.amount,500);assert.equal(m.amountUnit,'ml');assert.equal(r.draft.amount,1,'500 ml cannot scale a 100 g source portion');
assert.equal(m.mealBuilder.portion.nutritionScaled,false);
assert.ok(!m.score.available||m.score.status==='estimated_rough','Unknown ratios must not produce a detailed score');
assert.equal(r.extraction.voiceNote,null,'Tag selection cannot create a voice transcript');
let result=R.record(r,state,options);assert.equal(result.ok,true);assert.equal(result.record.portionAmount,500);assert.equal(result.record.portionUnit,'ml');
assert.equal(result.record.nutritionStatus,'incomplete');assert.equal(result.record.nutritionSnapshot.energyKcal.knownPortionSubtotal,90);
assert.deepEqual(clone(result.record.sourceMeta.mealIngredientSelection.names),['Banana','Kefir','Chia seeds']);
assert.equal(result.record.sourceMeta.mealWholePortion.source,'user');
let reopened=R.prepare({kind:'entry',entry:result.record,confirmationId:'test-reopen'},state,options);
assert.deepEqual(clone(R.model(reopened,state,options).mealBuilder.selected),['Banana','Kefir','Chia seeds']);
reopened=R.update(reopened,{mealIngredients:['Banana','Olive oil']},state,options);
assert.equal(reopened.kind,'analysis');assert.ok(!reopened.extraction.meal.components.some(c=>c.name==='Kefir'));
assert.ok(!reopened.extraction.ingredients.text.includes('Chia'));assert.ok(!R.model(reopened,state,options).plants.some(p=>/olive|chia/i.test(p)),'Deselected tags and oil cannot inflate whole-plant counts');
assert.equal(reopened.extraction.meal.components.find(c=>c.name==='Banana').amountGrams,100);
const after=R.update(reopened,{mealIngredients:['Banana','Olive oil']},state,options);assert.equal(after.extraction.meal.components.length,2,'Repeated apply is idempotent');
const custom=R.update(after,{mealIngredients:['Watercress from the garden']},state,options);assert.equal(R.model(custom,state,options).valid,true);assert.equal(custom.extraction.meal.components.find(c=>c.name==='Watercress from the garden').amountGrams,null);
for(const name of ['', 'x'.repeat(81), '<script>', 'Apple\nBanana']){const invalid=R.update(after,{mealIngredients:[name]},state,options);assert.equal(R.model(invalid,state,options).valid,false);}
assert.equal(JSON.stringify(R.prepare({kind:'analysis',extraction:raw,confirmationId:'test-tags'},state,options)),original,'Projections do not mutate supplied evidence');

// A whole weight only scales source arithmetic when the full matching basis exists.
let mass=R.update(R.prepare({kind:'analysis',extraction:raw,confirmationId:'mass'},state,options),{mealPortion:{amount:500,unit:'g'}},state,options);
assert.equal(mass.draft.amount,5);assert.equal(R.record(mass,state,options).record.nutritionSnapshot.energyKcal.portion,450);
let unknownMass=R.update(R.prepare({kind:'analysis',extraction:raw,confirmationId:'unknown-mass'},state,options),{mealIngredients:['Kefir'],mealPortion:{amount:500,unit:'g'}},state,options);
assert.equal(unknownMass.draft.amount,1,'Unknown newly identified mass cannot silently change all source grams');
assert.equal(R.model(unknownMass,state,options).nutrients.find(n=>n.key==='energyKcal').knownSubtotal,90);
const pint=R.update(r,{mealPortion:{amount:568.26125,unit:'ml'}},state,options);assert.equal(R.record(pint,state,options).record.portionAmount,568.26125);
for(const portion of [{amount:0,unit:'g'},{amount:Infinity,unit:'ml'},{amount:5001,unit:'g'},{amount:500,unit:'pint'}])assert.equal(R.model(R.update(r,{mealPortion:portion},state,options),state,options).valid,false);

// Saved totals and portion multipliers cannot be applied twice on resize/reopen.
const known=R.record(mass,state,options).record;
let saved=R.prepare({kind:'entry',entry:known,confirmationId:'resize'},state,options);
saved=R.update(saved,{mealPortion:{amount:250,unit:'g'}},state,options);
const resized=R.record(saved,state,options).record;
assert.equal(resized.portions,1);assert.equal(resized.portionAmount,250);assert.equal(resized.nutritionSnapshot.energyKcal.portion,225);
assert.equal(R.model({kind:'entry',entry:resized,confirmationId:'read'},state,options).nutrients.find(n=>n.key==='energyKcal').value,225);

// Packaged foods and printed recipes retain their existing precise editors.
assert.equal(R.model({kind:'product',product:{name:'Pack',basisUnit:'g',nutrients},confirmationId:'product'},state,options).mealBuilder,null);
const recipe=clone(raw);recipe.meal.recipeCalculation={version:s.NudgeRecipeComposition.VERSION,batchComponents:[banana],componentIndexes:[0],servings:1};
assert.equal(R.model({kind:'analysis',extraction:recipe,confirmationId:'recipe'},state,options).mealBuilder,null);

// Rejected recipe quotes used to hide every ingredient choice, even when no
// quantity or source survived. Reproduce the six-row diagnostic shape without
// private photos, transcripts or provider requests.
const rejectedNames=['Chicken','Tomato','Onion','Garlic','Yoghurt','Cumin'];
const rejectedRows=rejectedNames.map(name=>({name,amountGrams:null,amountSource:'recipe_serving',recordId:null,sourceRecord:null,nutrients:{},matchStatus:'unmatched',
  recipeIngredient:{name,amount:null,unit:null,evidence:'Recipe ingredient could not be linked to the printed text.'}}));
const rejectedRecipe={...clone(raw),productName:'Synthetic chicken curry',meal:{name:'Synthetic chicken curry',compositionVersion:'test',portionMode:'estimated_serving',
  components:clone(rejectedRows),ingredients:rejectedNames.map(name=>({name,evidence:name})),plants:[],nutrients:{},portion:{amount:null,unit:null},
  recipeEvidence:{text:'Synthetic recipe. Serves 2.',ingredients:rejectedRows.map(c=>clone(c.recipeIngredient)),photoIndex:1},
  recipeCalculation:{version:s.NudgeRecipeComposition.VERSION,status:'incomplete',applied:true,servings:2,selectedFraction:1,fractionSource:'recipe',
    validationIssues:['meal_recipe_evidence'],componentIndexes:[0],originalPlateComponents:[{name:'Synthetic curry',amountGrams:null,nutrients:{}}],batchComponents:clone(rejectedRows)}}};
const rejectedBefore=JSON.stringify(rejectedRecipe),rejectedInput={kind:'analysis',extraction:rejectedRecipe,confirmationId:'rejected-recipe'};
const rejectedModel=R.model(rejectedInput,state,options);
assert.ok(rejectedModel.mealBuilder);assert.equal(rejectedModel.mealBuilder.confirmed,false);
assert.ok(rejectedModel.mealBuilder.catalogue.some(c=>c.name==='Yoghurt'));
assert.equal(rejectedModel.recipe,null,'An unusable recipe must not replace the ingredient picker with recipe-share controls');
assert.ok(rejectedModel.nutrients.every(n=>n.value===null),'Showing suggestions cannot invent nutrition');
assert.equal(JSON.stringify(rejectedRecipe),rejectedBefore,'Opening the fallback must retain rejected evidence unchanged');
const rejectedPrepared=R.prepare(rejectedInput,state,options),retainedRejectedRows=clone(rejectedPrepared.extraction.meal.recipeCalculation.batchComponents);
let rejectedEdited=R.update(rejectedPrepared,{mealIngredients:['Chicken','Tomato','Spinach'],mealPortion:{amount:400,unit:'g'}},state,options);
assert.equal(R.model(rejectedEdited,state,options).valid,true);
assert.deepEqual(clone(rejectedEdited.draft.mealIngredients),['Chicken','Tomato','Spinach']);
assert.equal(rejectedEdited.extraction.meal.recipeCalculation.userEdited,true,'Explicit tags disable recipe reapplication');
assert.deepEqual(clone(rejectedEdited.extraction.meal.recipeCalculation.batchComponents),retainedRejectedRows,'Explicit tags leave retained recipe rows unchanged');
assert.ok(rejectedEdited.extraction.meal.components.some(c=>c.name==='Spinach'&&c.userIngredientTag&&c.amountGrams===null));
assert.ok(R.model(rejectedEdited,state,options).nutrients.every(n=>n.value===null));
const rejectedReprepared=R.prepare({kind:'analysis',extraction:rejectedEdited.extraction,confirmationId:'rejected-reprepared'},state,options);
assert.ok(rejectedReprepared.extraction.meal.components.some(c=>c.name==='Spinach'&&c.userIngredientTag),'Reopening must not replace the confirmed tags with the old recipe batch');
assert.ok(rejectedReprepared.extraction.meal.components.every(c=>c.amountGrams===null));
const rejectedRefinement=R.prepare({kind:'analysis',extraction:rejectedRecipe,previousReview:rejectedEdited,confirmationId:'rejected-refinement'},state,options);
assert.deepEqual(clone(rejectedRefinement.draft.mealIngredients),['Chicken','Tomato','Spinach'],'A reanalysis result without echoed hints retains the explicit selections');
assert.ok(R.model(rejectedRefinement,state,options).mealBuilder);
const rejectedSaved=R.record(rejectedEdited,state,options);assert.equal(rejectedSaved.ok,true);
const rejectedReload=s.WmdFoodLog.clean({entries:[JSON.parse(JSON.stringify(rejectedSaved.record))]}).entries[0];
const rejectedSavedBefore=JSON.stringify(rejectedReload),rejectedReopen={kind:'entry',entry:rejectedReload,confirmationId:'rejected-saved-reopen'};
assert.deepEqual(clone(R.model(rejectedReopen,state,options).mealBuilder.selected),['Chicken','Tomato','Spinach']);
const rejectedSavedEdit=R.update(rejectedReopen,{mealIngredients:['Chicken','Tomato','Kale']},state,options);
assert.ok(rejectedSavedEdit.extraction.meal.components.some(c=>c.name==='Kale'&&c.userIngredientTag));
assert.ok(!rejectedSavedEdit.extraction.meal.components.some(c=>c.name==='Spinach'));
assert.ok(rejectedSavedEdit.extraction.meal.components.every(c=>c.amountGrams===null));
assert.equal(JSON.stringify(rejectedReload),rejectedSavedBefore,'Editing a review draft cannot rewrite saved intake');
const unconfirmedSaved=clone(rejectedReload);delete unconfirmedSaved.sourceMeta.mealIngredientSelection;
assert.equal(R.model({kind:'entry',entry:unconfirmedSaved,confirmationId:'rejected-untouched-saved'},state,options).mealBuilder.confirmed,false);
// Incomplete nutrition alone is not a reason to abandon genuine recipe units,
// quantities or alternatives. These still need their exact recipe editor.
for(const retained of [
  {...clone(banana),nutrients:{},sourceRecord:{...clone(banana.sourceRecord),nutrients:{}}},
  {...clone(rejectedRows[0]),recipeIngredient:{name:'Milk',amount:200,unit:'ml',evidence:'200 ml milk'}},
  {...clone(rejectedRows[0]),recipeIngredient:{name:'Pea protein powder',amount:2,unit:'tbsp',evidence:'2 tbsp pea protein powder'}},
  {...clone(rejectedRows[0]),recipeIngredient:{name:'Eggs',amount:2,unit:'count',evidence:'2 eggs'}},
  {...clone(rejectedRows[0]),recipeChoice:{id:'choice',options:[{id:'milk',name:'Milk',amount:200,unit:'ml'}]}}
]){
  const partial=clone(rejectedRecipe);partial.meal.recipeCalculation.batchComponents[0]=retained;
  partial.meal.recipeCalculation.userEdited=true; // Inspect retained evidence without optional source recovery.
  assert.equal(R.model({kind:'analysis',extraction:partial,confirmationId:'partial-valid-recipe'},state,options).mealBuilder,null);
  const savedPartial=clone(rejectedReload);savedPartial.sourceMeta.mealRecipeCalculation=partial.meal.recipeCalculation;
  assert.equal(R.model({kind:'entry',entry:savedPartial,confirmationId:'partial-valid-saved'},state,options).mealBuilder,null);
}
for(const batchComponents of [[],[null]]){
  const unusableSaved=clone(rejectedReload);unusableSaved.sourceMeta.mealRecipeCalculation={...unusableSaved.sourceMeta.mealRecipeCalculation,applied:true,userEdited:true,batchComponents};
  assert.ok(R.model({kind:'entry',entry:unusableSaved,confirmationId:'empty-or-malformed-retained-batch'},state,options).mealBuilder,'Empty or malformed retained batch rows cannot hide tagging or crash saved review');
}

// Background refinements retain explicit hints, while returned hints take priority.
const previousReview=clone(r);
let refinement=R.prepare({kind:'analysis',extraction:raw,previousReview,confirmationId:'refinement'},state,options);
assert.deepEqual(clone(refinement.draft.mealIngredients),['Banana','Kefir','Chia seeds']);assert.equal(refinement.draft.mealPortion.unit,'ml');
const hinted=clone(raw);hinted.meal.userIngredientSelection={version:'meal-ingredients-v1',names:['Banana','Yoghurt'],source:'user'};
hinted.meal.userPortion={amount:568.26125,unit:'ml',source:'user',estimated:false};
refinement=R.prepare({kind:'analysis',extraction:hinted,previousReview,confirmationId:'returned-hints'},state,options);
assert.deepEqual(clone(refinement.draft.mealIngredients),['Banana','Yoghurt']);assert.equal(refinement.draft.mealPortion.amount,568.26125);assert.equal(refinement.draft.amount,1);

// Confirmed selection is the visible ingredient list across every review route.
// AI guesses stay as source evidence, never as extra selected chips. Opening or
// projecting a scan cannot alter its nutrient inputs or launch another analysis.
assert.equal(R.model({kind:'analysis',extraction:raw,confirmationId:'initial-picker'},state,options).mealBuilder.confirmed,false);
assert.equal(m.mealBuilder.confirmed,true);
assert.equal(R.model(custom,state,options).ingredients,'Watercress from the garden');
const guessed=clone(raw);
guessed.meal.ingredients.push({name:'Peanut butter',evidence:'Possible peanut butter'});
guessed.meal.userIngredientSelection={version:'meal-ingredients-v1',names:['Kefir','Chia seeds'],source:'user'};
const guessedBefore=JSON.stringify(guessed);
let selectedOnly=R.prepare({kind:'analysis',extraction:guessed,confirmationId:'selected-only'},state,options);
const selectedModel=R.model(selectedOnly,state,options);
assert.equal(selectedModel.ingredients,'Kefir, Chia seeds');
assert.equal(selectedModel.mealBuilder.confirmed,true);
assert.deepEqual(clone(selectedModel.mealBuilder.selected),['Kefir','Chia seeds']);
assert.ok(selectedModel.mealBuilder.allIngredients.some(item=>item.name==='Peanut butter'),'An explicit edit can still use the entire catalogue');
assert.equal(JSON.stringify(guessed),guessedBefore);
assert.equal(selectedOnly.extraction.meal.components[0].amountGrams,100,'Displaying selected names cannot rewrite photographed quantities');
const selectedSaved=R.record(selectedOnly,state,options);assert.equal(selectedSaved.ok,true);
const selectedReopened=R.model({kind:'entry',entry:selectedSaved.record,confirmationId:'selected-reopen'},state,options);
assert.equal(selectedReopened.ingredients,'Kefir, Chia seeds');assert.equal(selectedReopened.mealBuilder.confirmed,true);
const legacyRefinement=R.model({kind:'analysis',extraction:raw,previousReview:selectedOnly,confirmationId:'legacy-refinement'},state,options);
assert.equal(legacyRefinement.ingredients,'Kefir, Chia seeds','Previous explicit selections survive a result without echoed hints');
const cleared=R.update(selectedOnly,{mealIngredients:[]},state,options);
assert.equal(R.model(cleared,state,options).ingredients,'');assert.equal(R.model(cleared,state,options).mealBuilder.confirmed,true,'Clearing choices in an explicit edit must not restore AI guesses');
const clearedRecord=R.record(cleared,state,options);assert.equal(clearedRecord.ok,true);
const reloadedCleared=s.WmdFoodLog.clean({entries:[JSON.parse(JSON.stringify(clearedRecord.record))]}).entries[0];
assert.equal(reloadedCleared.sourceMeta.mealIngredientSelection.confirmed,true,'Explicit confirmation survives diary storage cleaning and reload');
const emptyReopened=R.model({kind:'entry',entry:reloadedCleared,confirmationId:'empty-reopened'},state,options);
assert.equal(emptyReopened.mealBuilder.confirmed,true);assert.deepEqual(clone(emptyReopened.mealBuilder.selected),[]);assert.equal(emptyReopened.ingredients,'');
const emptyExtraction=R.model({kind:'analysis',extraction:cleared.extraction,confirmationId:'empty-extraction-reopen'},state,options);
assert.equal(emptyExtraction.mealBuilder.confirmed,true);assert.equal(emptyExtraction.ingredients,'');
// Old app versions stored source:user/names:[] for untouched meals, too. Their
// initial ingredient picker must remain open until the user actually confirms.
const legacyEmpty=clone(reloadedCleared);delete legacyEmpty.sourceMeta.mealIngredientSelection.confirmed;
const legacyEmptyModel=R.model({kind:'entry',entry:legacyEmpty,confirmationId:'legacy-empty'},state,options);
assert.equal(legacyEmptyModel.mealBuilder.confirmed,false);assert.equal(legacyEmptyModel.ingredients,legacyEmpty.ingredients.text);
const absentSelection=clone(legacyEmpty);delete absentSelection.sourceMeta.mealIngredientSelection;
assert.equal(R.model({kind:'entry',entry:absentSelection,confirmationId:'absent-selection'},state,options).mealBuilder.confirmed,false);
const untouched=R.record({kind:'analysis',extraction:raw,confirmationId:'untouched'},state,options);assert.equal(untouched.ok,true);
assert.notEqual(untouched.record.sourceMeta.mealIngredientSelection.confirmed,true,'Saving an untouched meal cannot invent ingredient confirmation');


// A returned user portion confirms the whole meal even if some ingredient grams
// remain unresolved. It must not reopen a disabled save with an uneditable share.
const returnedPartial=clone(hinted);returnedPartial.meal.portionMode='estimated_serving';
returnedPartial.meal.components.push({name:'Yoghurt',amountGrams:null,nutrients:{},userIngredientTag:true});
const ready=R.model({kind:'analysis',extraction:returnedPartial,confirmationId:'returned-partial'},state,options);
assert.equal(ready.draft.portionConfirmed,true);assert.equal(ready.valid,true);
assert.equal(ready.nutrients.find(n=>n.key==='energyKcal').value,null);
assert.equal(ready.nutrients.find(n=>n.key==='energyKcal').knownSubtotal,90);

// Dish choices change without a second selected list. Catalogue browsing
// remains available, and extra analysed ingredients appear once.
const curry=clone(raw);curry.meal.name='Chicken curry';curry.productName='Chicken curry';curry.meal.ingredients.push({name:'Yoghurt'});
const curryBuilder=R.model({kind:'analysis',extraction:curry,confirmationId:'curry'},state,options).mealBuilder;
assert.notDeepEqual(clone(curryBuilder.catalogue),clone(m.mealBuilder.catalogue));
assert.ok(curryBuilder.catalogue.some(c=>c.name==='Olive oil'));assert.ok(!curryBuilder.catalogue.some(c=>c.name==='Whey protein powder'));
assert.ok(m.mealBuilder.catalogue.some(c=>c.name==='Whey protein powder'));
assert.ok(!m.mealBuilder.catalogue.some(c=>c.name==='Pork'));
assert.equal(curryBuilder.suggestions,undefined);assert.equal(curryBuilder.allIngredients.length,130);
assert.deepEqual(clone(curryBuilder.selected),[]);
const extra=clone(raw);extra.meal.ingredients.push({name:'Pine nut'},{name:'Watercress'},{name:'Watercress'});
const extraBuilder=R.model({kind:'analysis',extraction:extra,confirmationId:'extra'},state,options).mealBuilder;
assert.equal(extraBuilder.catalogue.filter(c=>/^Pine nut/.test(c.name)).length,1);
assert.equal(extraBuilder.catalogue.filter(c=>c.name==='Watercress').length,1);
const empty={kind:'analysis',confirmationId:'empty',extraction:{type:'meal',productName:'Meal',nutrients:{},meal:{name:'Meal',ingredients:[],plants:[],components:[],nutrients:{}}}};
assert.ok(R.model(empty,state,options).mealBuilder);

// Actual spoken evidence remains actual spoken evidence on repeated tag edits.
const spoken=clone(raw);spoken.voiceNote={text:'I used a small banana.'};
let voice=R.prepare({kind:'analysis',extraction:spoken,confirmationId:'spoken'},state,options);
voice=R.update(voice,{mealIngredients:['Kefir']},state,options);
voice=R.update(voice,{mealIngredients:['Yoghurt']},state,options);
assert.equal(voice.extraction.voiceNote.text,'I used a small banana.');
assert.deepEqual(clone(voice.extraction.meal.userIngredientSelection.names),['Yoghurt']);

// User-identified whole plants count once without fabricating nutrient amounts;
// oils and isolated protein powders do not establish whole-plant identities.
let plantReview=R.update(empty,{mealIngredients:['Olive oil','Sesame oil','Pea protein powder','Whey protein powder']},state,options);
assert.deepEqual(clone(R.model(plantReview,state,options).plants),[]);
assert.ok(plantReview.extraction.meal.components.every(c=>c.amountGrams===null));
assert.ok(R.model(plantReview,state,options).nutrients.every(n=>n.value===null));
plantReview=R.update(empty,{mealIngredients:['Peanuts','Peanut butter','Almonds','Almond butter','Sesame seeds','Tahini']},state,options);
assert.deepEqual(clone(R.model(plantReview,state,options).plants).sort(),['almond','peanut','sesame']);
plantReview=R.update(plantReview,{mealIngredients:['Peanut butter','Almond butter','Tahini']},state,options);
assert.deepEqual(clone(R.model(plantReview,state,options).plants).sort(),['almond','peanut','sesame']);

// Newly available nuts establish identities only, with each plant counted once
// after repeated selections and saved/reopened edits. Coconut oil/drink add none.
let nuts=R.update(empty,{mealIngredients:[...additionalNuts,'Coconut oil','Coconut drink']},state,options);
const nutPlants=['brazil nut','pecan','hazelnut','macadamia','pistachio','pine nut','chestnut','coconut'].sort();
assert.deepEqual(clone(R.model(nuts,state,options).plants).sort(),nutPlants);
assert.ok(nuts.extraction.meal.components.every(c=>c.amountGrams===null));
assert.ok(R.model(nuts,state,options).nutrients.every(n=>n.value===null));
nuts=R.update(nuts,{mealIngredients:[...additionalNuts,'Pine nut','Brazil nut','Macadamia','Coconut oil']},state,options);
assert.equal(nuts.draft.mealIngredients.length,additionalNuts.length+1,'Singular nut names cannot duplicate a selected ingredient');
assert.deepEqual(clone(R.model(nuts,state,options).plants).sort(),nutPlants);
const nutSaved=R.record(nuts,state,options);assert.equal(nutSaved.ok,true);
const nutsReopened=R.prepare({kind:'entry',entry:nutSaved.record,confirmationId:'nuts-reopen'},state,options);
assert.deepEqual(clone(R.model(nutsReopened,state,options).mealBuilder.selected),clone(nuts.draft.mealIngredients));
assert.deepEqual(clone(R.model(nutsReopened,state,options).plants).sort(),nutPlants);
nuts=R.update(nuts,{mealIngredients:['Pine nuts','Coconut oil']},state,options);
assert.deepEqual(clone(R.model(nuts,state,options).plants),['pine nut']);
console.log('Meal ingredient selection: catalogue, explicit evidence, unknown ratios, source preservation, exact units, saved reopen and recipe boundaries passed.');

// Whole-portion choices follow the dish without converting grams into ml.
const builderFor=name=>R.model({kind:'analysis',confirmationId:'portion-'+name,extraction:{...clone(raw),productName:name,meal:{...clone(raw.meal),name,portion:{}}}},state,options).mealBuilder;
for(const name of ['Berry smoothie','Orange juice','Cappuccino']){const b=builderFor(name);assert.equal(b.defaultUnit,'ml');assert.ok(b.options.filter(o=>!o.label.startsWith('Photo estimate')).every(o=>o.unit==='ml'));assert.equal(b.options.find(o=>o.label==='UK pint').amount,568.26125);}
const soup=builderFor('Tomato soup');assert.equal(soup.defaultUnit,'ml');assert.ok(!soup.options.some(o=>o.label==='UK pint'));
const snack=builderFor('Mixed nuts snack');assert.equal(snack.step,10);assert.ok(snack.options.some(o=>o.amount===30&&o.unit==='g'));
const dinner=builderFor('Chicken curry');assert.equal(dinner.defaultUnit,'g');assert.ok(dinner.options.every(o=>o.unit==='g'));
const breakfast=builderFor('Greek yoghurt bowl');assert.ok(breakfast.options.some(o=>o.amount===150));

// Search spans all bundled source identities, while labels-only selection adds
// no weights, nutrient values or authoritative source match. Long names remain
// searchable by their full description and fit the 80-character hints contract.
s.NudgeMealRecoveryData={records:[['source1','c','1','Watercress, raw'],['source2','u','2','Adzuki beans, boiled'],['source3','u','3','Food with a very long catalogue description that must remain searchable without exceeding eighty characters, special suffix']],sources:{}};
let found=R.ingredientSearch('adzuki');assert.equal(found.items[0].name,'Adzuki beans, boiled');assert.equal(found.total,1);
found=R.ingredientSearch('special suffix');assert.equal(found.total,1);assert.ok(found.items[0].name.length<=80);
assert.deepEqual(clone(R.ingredientSearch('')), {items:[],total:0});
const searched=R.update(empty,{mealIngredients:['Adzuki beans, boiled']},state,options);
assert.equal(searched.extraction.meal.components[0].recordId,null);assert.equal(searched.extraction.meal.components[0].amountGrams,null);assert.ok(R.model(searched,state,options).nutrients.every(n=>n.value===null));
const reopenedCustom=R.prepare({kind:'entry',entry:R.record(searched,state,options).record,confirmationId:'custom-reopened'},state,options);
assert.deepEqual(clone(R.model(reopenedCustom,state,options).mealBuilder.selected),['Adzuki beans, boiled']);
assert.ok(R.model(reopenedCustom,state,options).mealBuilder.catalogue.some(c=>c.name==='Adzuki beans, boiled'));
const tooMany=R.update(empty,{mealIngredients:Array.from({length:41},(_,i)=>'Ingredient '+i)},state,options);assert.equal(R.model(tooMany,state,options).valid,false);
console.log('Dish choices, exact contextual measures, custom ingredient validation, full catalogue search, and no invented nutrition passed.');

// Exercise the shipped dataset rather than a 112-choice stand-in. Keeping search
// bounded avoids sending thousands of source rows through the native bridge.
for(const file of ['core/meal-recovery-data.js','core/meal-recovery.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),s,{filename:file});
assert.ok(s.NudgeMealRecoveryData.records.length>9000);
const wholeSearch=R.ingredientSearch('watercress');assert.ok(wholeSearch.items.some(x=>/watercress/i.test(x.name)));
const broadSearch=R.ingredientSearch('a');assert.ok(broadSearch.total>60);assert.equal(broadSearch.items.length,60);
const longSearch=R.ingredientSearch('separable lean');assert.ok(longSearch.total>0);assert.ok(longSearch.items.every(x=>x.name.length<=80));
const fullDatasetMeal=R.update({...clone(empty),extraction:{...clone(empty.extraction),meal:{...clone(empty.extraction.meal),portionMode:'estimated_serving'}}},{mealIngredients:[wholeSearch.items[0].name]},state,options);
assert.equal(fullDatasetMeal.extraction.meal.components[0].recordId,null);assert.equal(fullDatasetMeal.extraction.meal.components[0].amountGrams,null);assert.ok(R.model(fullDatasetMeal,state,options).nutrients.every(n=>n.value===null));
console.log('Full bundled catalogue: '+s.NudgeMealRecoveryData.records.length+' records searchable, 60-result bridge bound, labels remain non-nutritional.');
