// Synthetic ingredient reviews exercise the same controllers/cleaner as the app.
// The fixture keeps storage, network and camera isolated from real user records.
const assert=require('node:assert/strict');
const {boot,extraction,keys,today}=require('./label-photo.test.cjs');
const plain=value=>JSON.parse(JSON.stringify(value));
const product=(overrides={})=>({...extraction({},'unknown',null,{productName:'Seed and oat mix',brand:'Test kitchen'}),labelKind:'ingredients',ingredients:{text:'Ingredients: rolled oats (50%), almonds (20%), pumpkin seeds, chickpeas, chickpea flour, mixed spices. May contain hazelnuts.',plants:[{name:'Oat',evidence:'rolled oats'},{name:'Almond',evidence:'almonds'},{name:'Pumpkin',evidence:'pumpkin seeds'},{name:'Chickpeas',evidence:'chickpeas'},{name:'Chickpea',evidence:'chickpea flour'},{name:'Mixed spices',evidence:'mixed spices'},{name:'Hazelnut',evidence:'hazelnuts'},{name:'Banana',evidence:'not on this pack'}],needsReview:true},...overrides});
const check=(app,id,value)=>{const index=Number(id.split('-').at(-1));if(app.controller._state.extraction.ingredients.plants[index].selected!==value)app.action('label-toggle-plant',String(index));};
const again=(app,result,kind='label')=>{app.action('label-capture',kind);app.receive('capture-status',{photoCount:1});app.analyse();app.receive('result',{result:{extraction:result}});};

// Ingredient list review, deduplication, trace/generic rejection and explicit save.
const app=boot();app.review(product());
assert.match(app.html(),/Ingredients/);assert.match(app.html(),/<b>4<\/b> plants/);assert.doesNotMatch(app.html(),/type="checkbox"/);
assert.match(app.html(),/Check unclear ingredients/);assert.match(app.html(),/Nutrition unknown/);
assert.equal(app.element('label-basis'),undefined);assert.equal(app.element('label-energyKcal'),undefined);
assert.equal(app.data.foodLog.entries.length,0);assert.equal(app.writes(),0);
assert.deepEqual(plain(app.controller._state.extraction.ingredients.plants.map(p=>p.name)),['oats','almond','pumpkin','chickpea']);
check(app,'label-plant-selected-2',false);assert.match(app.html(),/<b>3<\/b> plants/);
app.input('label-amount',35,{change:true});app.action('label-slot','Breakfast');app.action('label-save');app.action('label-save');
assert.equal(app.writes(),1);assert.equal(app.data.foodLog.entries.length,1);
const food=app.data.foodLog.entries[0];assert.equal(food.portionAmount,35);assert.equal(food.portionUnit,'g');assert.equal(food.slot,'','Obsolete category actions cannot categorize a new entry');
assert.equal(food.energyPerPortion,null);assert.equal(food.proteinPerPortion,null);assert.equal(food.fibrePerPortion,null);
for(const key of keys){assert.equal(food.nutritionSnapshot[key].portion,null);assert.equal(food.nutritionSnapshot[key].per100,null);assert.equal(food.nutritionSnapshot[key].portionStatus,'unknown');}
assert.equal(food.ingredients.needsReview,true);assert.equal(food.sourceMeta.labelKind,'ingredients');
assert.deepEqual(plain(food.plants),['oats','almond','chickpea']);assert.deepEqual(plain(food.ingredients.plants.map(p=>p.name)),plain(food.plants));
const reload=boot(app.persisted().foodLog.entries);
assert.deepEqual(plain(reload.data.foodLog.entries[0].ingredients),plain(food.ingredients));
assert.deepEqual(plain(reload.sandbox.WmdFoodLog.summarise(reload.data.foodLog.entries).plants),plain(food.plants));
assert.match(reload.patterns.dashboard(),/<small>35 g/);assert.doesNotMatch(reload.patterns.dashboard(),/Breakfast ·/);assert.match(reload.patterns.dashboard(),/3 plant types · nutrition unknown/);
assert.match(reload.fit.homeCard(),/No known values logged/);assert.doesNotMatch(reload.fit.homeCard(),/>0 kcal logged|>0 g logged/);
const totals=reload.sandbox.NudgeNutrition.summary(reload.data.foodLog.entries,today);assert.equal(totals.calorieKnown,0);assert.equal(totals.calorieUnknown,1);assert.equal(totals.known,0);assert.equal(totals.unknown,1);
assert.doesNotMatch(JSON.stringify(app.persisted()),/image\/jpeg|preview|imageBase64/);
reload.fit.handleAction('food-edit',food.id);assert.match(reload.fit.reviewScreen(),/Reviewed ingredients label/);reload.fit.handleAction('fit-portions','2');reload.fit.handleAction('fit-confirm');
assert.deepEqual(plain(reload.data.foodLog.entries[0].ingredients),plain(food.ingredients));assert.match(reload.patterns.dashboard(),/70 g/);

// ml quantities remain actual ml and cannot accidentally become grams.
const drink=boot();drink.review(product());drink.input('label-amount-unit','ml',{change:true});drink.input('label-amount',200);drink.action('label-save');assert.equal(drink.data.foodLog.entries[0].portionUnit,'ml');assert.match(drink.patterns.dashboard(),/200 ml/);

// Editable transcription and names retain review corrections; evidence is not falsely attributed.
const edited=boot();edited.review(product());edited.input('label-ingredients-text','Ingredients: oats, almonds, pumpkin seeds, chickpeas, sesame. May contain hazelnuts.',{change:true});
assert.ok(edited.controller._state.extraction.ingredients.plants.every(p=>p.evidence===''));
edited.action('label-add-plant');edited.input('label-plant-name-4','Sesame',{change:true});assert.match(edited.html(),/<b>5<\/b> plants/);
edited.action('label-add-plant');edited.input('label-plant-name-5','Hazelnut',{change:true});assert.match(edited.html(),/<b>5<\/b> plants/);assert.match(edited.html(),/Not counted/);
edited.action('label-capture','product');edited.receive('cancelled');assert.equal(edited.element('label-plant-name-4').value,'Sesame');
again(edited,product());assert.equal(edited.element('label-plant-name-4').value,'Sesame');assert.match(edited.element('label-ingredients-text').value,/sesame/);
edited.action('label-save');assert.deepEqual(plain(edited.data.foodLog.entries[0].plants),['oats','almond','pumpkin','chickpea','sesame']);

// Both labels use independently sourced nutrients and reviewed ingredient plants.
const both=boot();both.review(product({...extraction({energyKcal:400,protein:15},'per100g',null,{productName:'Combined pack'}),labelKind:'both'}));
assert.ok(both.element('label-basis'));assert.ok(both.element('label-energyKcal'));both.input('label-amount',25);both.action('label-save');assert.equal(both.data.foodLog.entries[0].energyPerPortion,100);assert.equal(both.data.foodLog.entries[0].proteinPerPortion,3.75);assert.equal(both.data.foodLog.entries[0].plants.length,4);

// Cross-mode retakes discard prior nutrition corrections; ingredient mode rejects rogue values.
const cross=boot();cross.review(extraction({energyKcal:100,protein:10},'per100g',null,{productName:'Original'}));cross.input('label-protein',90);cross.input('label-name','My checked name');cross.input('label-amount',30);again(cross,product({nutrients:extraction({energyKcal:999,protein:99}).nutrients,basis:'per100g'}));
assert.equal(cross.element('label-name').value,'My checked name');assert.equal(cross.element('label-amount').value,'30');assert.equal(cross.controller._state.extraction.nutrients.protein.value,null);assert.equal(cross.controller._state.extraction.basis,'unknown');
assert.equal(Object.keys(cross.controller._state.corrections).length,0);cross.action('label-save');assert.equal(cross.data.foodLog.entries[0].proteinPerPortion,null);
const back=boot();back.review(product());check(back,'label-plant-selected-0',false);again(back,extraction({energyKcal:100},'per100g',null,{productName:'Nutrition'}));assert.equal(back.element('label-ingredients-text'),undefined);back.action('label-save');assert.equal(back.data.foodLog.entries[0].ingredients,null);assert.equal(back.data.foodLog.entries[0].plants.length,0);

// Ingredient repair retains all known nutrients, record identity/time/amount, and prevents duplicates.
const original={...food,id:'saved',day:'2026-09-30',slot:'Dinner',portions:2,energyPerPortion:186,proteinPerPortion:7.9,nutritionSnapshot:{energyKcal:{portion:186,per100:620,portionStatus:'calculated',per100Status:'supplied'},protein:{portion:7.9,per100:26.3,portionStatus:'calculated',per100Status:'supplied'}},sourceMeta:{...food.sourceMeta,confirmationId:'original-confirmation',labelBasis:'per100g'}};
const repair=boot([original]);repair.review(product(),'saved');assert.equal(repair.element('label-amount'),undefined);assert.equal(repair.element('label-amount-unit'),undefined);assert.match(repair.html(),/existing diary value/);repair.action('label-save');repair.action('label-save');
assert.equal(repair.data.foodLog.entries.length,1);const updated=repair.data.foodLog.entries[0];for(const key of ['id','day','slot','portions','portionAmount','portionUnit','energyPerPortion','proteinPerPortion'])assert.equal(updated[key],original[key]);assert.equal(updated.sourceMeta.confirmationId,'original-confirmation');assert.equal(updated.sourceMeta.labelBasis,'per100g');assert.equal(updated.plants.length,4);
// A later nutrition-only repair must preserve the reviewed ingredients and plants.
const nutritionRepair=boot([updated]);nutritionRepair.review(extraction({fibre:5},'per100g'),'saved');nutritionRepair.action('label-save');assert.deepEqual(plain(nutritionRepair.data.foodLog.entries[0].ingredients),plain(updated.ingredients));assert.deepEqual(plain(nutritionRepair.data.foodLog.entries[0].plants),plain(updated.plants));
const deleted=boot([original]);deleted.review(product(),'saved');deleted.data.foodLog.entries=[];deleted.action('label-save');assert.equal(deleted.data.foodLog.entries.length,0);assert.equal(deleted.writes(),0);

// Storage failure is reversible; no duplicate confirmation even on repeated taps.
const storage=boot();storage.review(product());storage.canSave(false);storage.action('label-save');assert.equal(storage.data.foodLog.entries.length,0);assert.equal(storage.controller._state.phase,'review');storage.canSave(true);storage.action('label-save');storage.action('label-save');assert.equal(storage.data.foodLog.entries.length,1);
const duplicate=boot();duplicate.review(product());duplicate.data.foodLog.entries.push({...food,id:'other',sourceMeta:{...food.sourceMeta,confirmationId:duplicate.controller._state.confirmationId}});duplicate.action('label-save');assert.equal(duplicate.writes(),0);assert.equal(duplicate.data.foodLog.entries.length,1);

// Escaped display, malformed candidates, absent text, required physical amount and unreadable results.
const unsafe=boot();unsafe.review(product({ingredients:{text:'Ingredients: oats. </textarea><img src=x onerror=alert(1)>',plants:[{name:'Oats',evidence:'oats'},{name:{invalid:true},evidence:'oats'},{name:'<script>',evidence:'oats'}],needsReview:false}}));assert.match(unsafe.html(),/&lt;\/textarea&gt;&lt;img/);assert.doesNotMatch(unsafe.html(),/<img src=x/);unsafe.action('label-save');assert.equal(unsafe.data.foodLog.entries[0].plants.length,1);
const noText=boot();noText.review(product({ingredients:null,needsClearerPhoto:true,message:'Retake the full ingredient list.'}));assert.match(noText.html(),/Retake the full ingredient list/);assert.match(noText.html(),/Scan again/);noText.action('label-save');assert.equal(noText.writes(),0);
const noName=boot();noName.review(product({productName:null}));noName.action('label-save');assert.equal(noName.writes(),0);noName.input('label-name','Known food');noName.input('label-amount','0');noName.action('label-save');assert.equal(noName.writes(),0);
const unreadable=boot();unreadable.review(product({labelKind:'unreadable',ingredients:null}));unreadable.action('label-save');assert.equal(unreadable.writes(),0);
const zeroPlants=boot();zeroPlants.review(product({ingredients:{text:'Ingredients: milk, salt.',plants:[],needsReview:false}}));assert.match(zeroPlants.html(),/No named plants identified/);zeroPlants.action('label-save');assert.equal(zeroPlants.data.foodLog.entries[0].plants.length,0);assert.equal(zeroPlants.data.foodLog.entries[0].energyPerPortion,null);
const partial=boot();partial.review(product({ingredients:{text:'Ingredients: [unclear], oats.',plants:[{name:'oats',evidence:'oats'}],needsReview:true}}));partial.action('label-save');assert.equal(partial.data.foodLog.entries[0].ingredients.needsReview,true);assert.equal(partial.data.foodLog.entries[0].plants.length,1);
// A remove-only correction overlays the improved retake, so new plants still appear.
const improved=boot();improved.review(product({ingredients:{text:'Ingredients: oats.',plants:[{name:'oats',evidence:'oats'}],needsReview:true}}));check(improved,'label-plant-selected-0',false);
again(improved,product({ingredients:{text:'Ingredients: oats, almonds.',plants:[{name:'oats',evidence:'oats'},{name:'almond',evidence:'almonds'}],needsReview:false}}));
assert.equal(improved.element('label-ingredients-text').value,'Ingredients: oats, almonds.');assert.equal(improved.controller._state.extraction.ingredients.plants[0].selected,false);assert.equal(improved.controller._state.extraction.ingredients.plants[1].selected,true);assert.match(improved.html(),/<b>1<\/b> plants/);improved.action('label-save');assert.deepEqual(plain(improved.data.foodLog.entries[0].plants),['almond']);
// The explicit ingredient-only option releases a combined label from unusable nutrition fields.
const optOut=boot();optOut.review(product({labelKind:'both',needsClearerPhoto:true,message:'Check missing nutrition values.'}));assert.match(optOut.html(),/Use ingredients only/);optOut.input('label-protein',20);optOut.action('label-ingredients-only');assert.equal(optOut.element('label-basis'),undefined);assert.doesNotMatch(optOut.html(),/Check missing nutrition values/);assert.equal(optOut.element('label-protein'),undefined);assert.equal(Object.keys(optOut.controller._state.corrections).length,0);optOut.action('label-save');assert.equal(optOut.data.foodLog.entries[0].proteinPerPortion,null);assert.equal(optOut.data.foodLog.entries[0].plants.length,4);
const optOutRepair=boot([original]);optOutRepair.review(product({labelKind:'both'}),'saved');optOutRepair.action('label-ingredients-only');optOutRepair.action('label-save');assert.equal(optOutRepair.data.foodLog.entries[0].energyPerPortion,186);assert.equal(optOutRepair.data.foodLog.entries[0].proteinPerPortion,7.9);
// Already-complete nutrition entries can add ingredients without losing their prior values.
const complete=boot([{...original,nutritionSnapshot:Object.fromEntries(keys.map(key=>[key,{portion:1,per100:2,portionStatus:'calculated',per100Status:'supplied'}]))}]);complete.fit.handleAction('food-edit','saved');assert.match(complete.fit.reviewScreen(),/Photograph label to update this entry/);complete.review(product(),'saved');complete.action('label-save');assert.equal(complete.data.foodLog.entries[0].nutritionStatus,'complete');assert.equal(complete.data.foodLog.entries[0].id,'saved');assert.equal(complete.data.foodLog.entries[0].ingredients.plants.length,4);
console.log('Passed: ingredients-only review/edits/confirmation, distinct plant evidence/dedup/traces, g/ml amounts, null nutrition/Today, reload and existing meal edits, both-label arithmetic, cross-mode retakes, repair preservation/idempotency, escaping, malformed results and storage rollback.');
