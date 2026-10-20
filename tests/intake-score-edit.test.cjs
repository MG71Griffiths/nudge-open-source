// Explicit generic diary edits must never retain stale occasion frequency.
const assert=require('node:assert/strict');
const {boot}=require('./label-photo.test.cjs');
const copy=value=>JSON.parse(JSON.stringify(value));
const score={methodId:'nudge_nutrition_v0_2',methodVersion:'0.2',model_version:'0.2',available:true,status:'rated',value:75,grade:'B',inputs:{salt:0.3,protein:12},sourceVersion:'test-source-v1',baseFrequency:'Daily',finalFrequency:'Daily',frequencyStatus:'prototype_guidance',reasonCodes:['base_frequency_retained'],eatingOccasion:{day:'2026-10-01',slot:'Lunch',saltGrams:0.3},frequencyPolicy:{policyVersion:'nudge-frequency-0.2',status:'prototype_guidance',frequencyStatus:'prototype_guidance',frequency:'Daily',finalFrequency:'Daily',portionSaltGrams:0.3,reasonCodes:['base_frequency_retained']}};
const entry=kind=>({id:'preserved-intake',name:'Test food',day:'2026-10-01',slot:'Lunch',portions:1,portionAmount:100,portionUnit:'g',plants:['oats'],ferments:[],energyPerPortion:200,proteinPerPortion:12,fibrePerPortion:4,source:'Original analysed food',sourceMeta:kind==='product'?{entryKind:'product-consumption',scanEventId:'deleted-scan',productScanEventId:'deleted-scan',scoreMethod:copy(score)}:{scanEventId:'deleted-scan',mealComposition:[{name:'oats',amountGrams:100}],mealScore:copy(score)}});
for(const kind of ['product','meal']){
  const key=kind==='product'?'scoreMethod':'mealScore';
  for(const change of ['portion','day']){
    const app=boot([entry(kind)]),before=copy(app.data.foodLog.entries[0]),oldScore=copy(before.sourceMeta[key]);
    app.fit.handleAction('food-edit',before.id);
    assert.deepEqual(copy(app.data.foodLog.entries[0]),before,'Opening a fallback diary editor is read-only');
    if(change==='portion')app.fit.handleAction('fit-portions','2');
    if(change==='day')app.fit.handleChange({id:'review-day',value:'2026-09-30'});
    app.fit.handleAction('fit-confirm');
    const saved=app.data.foodLog.entries[0],current=saved.sourceMeta[key];
    assert.equal(app.data.foodLog.entries.length,1);assert.equal(saved.id,before.id);
    assert.equal(saved.slot,'Lunch','Editing amount or date retains the saved legacy category');
    assert.deepEqual(copy(saved.sourceMeta.scoreHistory),[oldScore]);
    assert.equal(current.finalFrequency,null);assert.equal(current.frequencyStatus,'pending');assert.equal(current.eatingOccasion,null);
    assert.equal(current.frequencyPolicy.frequency,null);assert.equal(current.frequencyPolicy.portionSaltGrams,null);
    assert.ok(current.reasonCodes.includes('intake_edited_recheck_required'));
    for(const field of ['value','grade','inputs','methodId','methodVersion','sourceVersion'])assert.deepEqual(copy(current[field]),oldScore[field]);
    const reloaded=boot(copy(app.data.foodLog.entries));assert.equal(reloaded.data.foodLog.entries[0].sourceMeta[key].finalFrequency,null);
    app.fit.handleAction('food-edit',saved.id);app.fit.handleAction('fit-confirm');
    assert.equal(app.data.foodLog.entries[0].sourceMeta.scoreHistory.length,1,'Saving unchanged data does not append another archival score');
  }
  {
    const app=boot([entry(kind)]),before=copy(app.data.foodLog.entries[0]);
    app.fit.handleAction('food-edit',before.id);
    app.fit.handleAction('fit-slot','Dinner');
    assert.equal(app.view.foodDraft.slot,'Lunch','Removed category controls cannot change the existing draft');
    app.fit.handleAction('fit-confirm');
    assert.deepEqual(copy(app.data.foodLog.entries[0]),before,'An obsolete category action must not change intake or invalidate saved evidence');
  }
  for(const field of ['energyPerPortion','proteinPerPortion','fibrePerPortion']){
    const app=boot([entry(kind)]),original=copy(app.data.foodLog.entries[0]);
    app.fit.handleAction('food-edit',original.id);app.view.foodDraft[field]=null;app.fit.handleAction('fit-confirm');
    const edited=app.data.foodLog.entries[0];assert.equal(edited[field],null);assert.equal(edited.sourceMeta[key],kind==='product'?null:undefined,'Canonical product metadata stores absent current score as null');
    assert.deepEqual(copy(edited.sourceMeta.scoreHistory),[original.sourceMeta[key]]);
    const reloaded=boot(copy(app.data.foodLog.entries));assert.ok(!reloaded.data.foodLog.entries[0].sourceMeta[key],'An edited nutrient cannot present the archived grade as current after reload');assert.deepEqual(copy(reloaded.data.foodLog.entries[0].sourceMeta),copy(edited.sourceMeta),'Canonical absence and exact score history are stable before and after reload');
  }
  const failed=boot([entry(kind)]),before=copy(failed.data.foodLog.entries);
  failed.fit.handleAction('food-edit','preserved-intake');failed.fit.handleAction('fit-portions','2');failed.canSave(false);failed.fit.handleAction('fit-confirm');
  assert.deepEqual(copy(failed.data.foodLog.entries),before);assert.equal(failed.view.foodDraft.portions,2);assert.match(failed.toasts.at(-1),/could not be saved/);
  failed.canSave(true);failed.fit.handleAction('fit-confirm');assert.equal(failed.data.foodLog.entries[0].sourceMeta.scoreHistory.length,1);assert.equal(failed.data.foodLog.entries[0].portions,2);
}
console.log('PASS: generic diary edits archive exact v0.2 provenance, invalidate occasion frequency, remove active score after nutrient changes, retain IDs/unknowns, survive reload, and roll back failed saves.');
// Carbohydrate editing uses the same review/confirmation transaction and provenance guard.
for(const kind of ['product','meal']){
  const key=kind==='product'?'scoreMethod':'mealScore';
  const originalEntry={...entry(kind),nutritionSnapshot:{carbohydrate:{per100:25,portion:25,unit:'g',per100Status:'supplied',portionStatus:'calculated'},protein:{per100:12,portion:12,unit:'g',per100Status:'supplied',portionStatus:'calculated'}}};
  const app=boot([originalEntry]),before=copy(app.data.foodLog.entries[0]);app.fit.handleAction('food-edit',before.id);
  assert.match(app.fit.reviewScreen(),/Carbs in one portion/);
  app.fit.handleChange({id:'review-carbs',value:'25'});assert.deepEqual(copy(app.view.foodDraft),before,'Applying the same carb value is a no-op');
  app.fit.handleChange({id:'review-carbs',value:'0'});assert.equal(app.view.foodDraft.nutritionSnapshot.carbohydrate.portion,0);assert.equal(app.data.foodLog.entries[0].nutritionSnapshot.carbohydrate.portion,25,'Review changes do not change intake before confirmation');
  app.fit.handleAction('fit-confirm');let saved=app.data.foodLog.entries[0];assert.equal(saved.id,before.id);assert.equal(app.data.foodLog.entries.length,1);assert.equal(saved.nutritionSnapshot.carbohydrate.portion,0);assert.equal(saved.nutritionSnapshot.carbohydrate.per100,0);assert.equal(saved.sourceMeta[key],kind==='product'?null:undefined,'Canonical current score is absent after nutrient editing');assert.deepEqual(copy(saved.sourceMeta.scoreHistory),[before.sourceMeta[key]]);assert.deepEqual(copy(saved.nutritionSnapshot.protein),before.nutritionSnapshot.protein);assert.match(saved.sourceMeta.retainedNutrients,/edited by user/);
  app.fit.handleAction('food-edit',saved.id);app.fit.handleChange({id:'review-carbs',value:''});app.fit.handleAction('fit-confirm');saved=app.data.foodLog.entries[0];assert.equal(saved.nutritionSnapshot.carbohydrate.portion,null);assert.equal(saved.nutritionSnapshot.carbohydrate.portionStatus,'unknown');assert.equal(saved.nutritionSnapshot.carbohydrate.per100,null);assert.equal(saved.proteinPerPortion,12);assert.equal(saved.energyPerPortion,200);assert.equal(saved.sourceMeta.scoreHistory.length,1);assert.equal(boot(copy(app.data.foodLog.entries)).data.foodLog.entries[0].nutritionSnapshot.carbohydrate.portion,null);
}
console.log('PASS: carbohydrate editor retains unknown/zero distinction, saves only on food confirmation, preserves other nutrients and entry ID, archives stale score, and survives reload.');

// A new replay has no diary ID: invalidate before either library saving or intake
// confirmation so an edited draft cannot retain its original evidence as current.
for(const kind of ['product','meal']){
  const key=kind==='product'?'scoreMethod':'mealScore',original={...entry(kind),nutritionSnapshot:{carbohydrate:{per100:25,portion:25,unit:'g',per100Status:'supplied',portionStatus:'calculated'}}};
  const app=boot([original]),before=copy(app.data.foodLog.entries),storage=new Map();
  app.sandbox.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  require('node:vm').runInContext(require('node:fs').readFileSync(require('node:path').join(__dirname,'../Web/repertoire.js'),'utf8'),app.sandbox);
  const repertoire=app.sandbox.createNudgeRepertoire(app.ctx);repertoire.saveEntry(before[0]);const id=repertoire.items()[0].id;repertoire.open(id);
  assert.equal(app.view.foodDraft.id,undefined);app.fit.handleChange({id:'review-carbs',value:'30'});
  assert.equal(app.view.foodDraft.sourceMeta[key],undefined);assert.deepEqual(copy(app.view.foodDraft.sourceMeta.scoreHistory),[before[0].sourceMeta[key]]);assert.deepEqual(copy(app.data.foodLog.entries),before);
  repertoire.handleAction('repertoire-save-draft');const saved=repertoire.items()[0].draft;
  assert.equal(saved.sourceMeta[key]??null,null);assert.equal(saved.nutritionSnapshot.carbohydrate.portion,30);assert.equal(saved.sourceMeta.scoreHistory.length,1);assert.deepEqual(copy(app.data.foodLog.entries),before,'Updating a template leaves original intake unchanged');
  app.fit.handleAction('fit-confirm');const eaten=app.data.foodLog.entries[1];assert.equal(eaten.sourceMeta[key]??null,null);assert.equal(eaten.sourceMeta.scoreHistory.length,1);assert.equal(eaten.nutritionSnapshot.carbohydrate.portion,30);assert.deepEqual(copy(app.data.foodLog.entries[0]),before[0]);
  const reloaded=app.sandbox.createNudgeRepertoire(app.ctx);reloaded.open(id);assert.equal(app.view.foodDraft.sourceMeta[key]??null,null);assert.equal(app.view.foodDraft.sourceMeta.scoreHistory.length,1);
}
console.log('PASS: new saved-food drafts archive changed score evidence before library save or intake confirmation without mutating original records.');

// Defensive bridge validation also blocks confirmation, although the exact dialog
// already rejects this value before dispatching a normal UI change.
{
  const app=boot([entry('meal')]),before=copy(app.data.foodLog.entries);
  app.fit.handleAction('food-edit','preserved-intake');app.fit.handleChange({id:'review-carbs',value:'-1'});app.fit.handleAction('fit-confirm');
  assert.deepEqual(copy(app.data.foodLog.entries),before);assert.ok(app.view.foodDraft.carbohydrateEditError);assert.match(app.fit.reviewScreen(),/review-carbs-error/);assert.match(app.toasts.at(-1),/Check the carbohydrate amount/);
  app.fit.handleChange({id:'review-carbs',value:'0'});assert.equal(app.view.foodDraft.carbohydrateEditError,undefined);app.fit.handleAction('fit-confirm');assert.equal(app.data.foodLog.entries[0].nutritionSnapshot.carbohydrate.portion,0);
  app.fit.handleAction('food-edit','preserved-intake');app.fit.handleChange({id:'review-carbs',value:'bad'});app.fit.handleAction('food-edit','preserved-intake');assert.equal(app.view.foodDraft.carbohydrateEditError,undefined,'A fresh review does not inherit a discarded draft error');
}

// A user-cleared carb value must beat old source arithmetic in Today and replay.
// Use a linked, quantified source so this exercises the actual legacy fallback.
{
  const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
  const withProjection=entries=>{const app=boot(entries);for(const file of ['core/food-composition.js','today-goals.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),app.sandbox,{filename:file});return app;};
  const sourced=entry('meal');sourced.sourceMeta.photoPortions='1';
  sourced.sourceMeta.mealComposition=[{name:'oats',amountGrams:100,recordId:'test:source',sourceRecord:{id:'test:source',basis:'per100g',carbohydrateDefinition:'available'},nutrients:{carbohydrate:{value:20,unit:'g'},energyKcal:{value:200,unit:'kcal'}}}];
  sourced.nutritionSnapshot={carbohydrate:{per100:20,portion:20,unit:'g',per100Status:'calculated',portionStatus:'calculated'}};
  // Older entries display source-derived carbs even though their stored snapshot
  // is unknown. An explicit blank edit must still create the correction marker.
  const legacy=copy(sourced);legacy.nutritionSnapshot.carbohydrate={per100:null,portion:null,unit:'g',per100Status:'unknown',portionStatus:'unknown'};
  const legacyApp=withProjection([legacy]);assert.equal(legacyApp.sandbox.NudgeToday.model(legacyApp.data,'2026-10-01').carbs.value,20);
  legacyApp.fit.handleAction('food-edit',legacy.id);legacyApp.fit.handleChange({id:'review-carbs',value:''});legacyApp.fit.handleAction('fit-confirm');
  assert.match(legacyApp.data.foodLog.entries[0].sourceMeta.retainedNutrients,/Carbohydrate amount edited by user/);
  assert.equal(legacyApp.sandbox.NudgeToday.model(legacyApp.data,'2026-10-01').carbs.value,null);
  const app=withProjection([sourced]),sourceBefore=copy(app.data.foodLog.entries[0].sourceMeta.mealComposition);
  assert.equal(app.sandbox.NudgeToday.model(app.data,'2026-10-01').carbs.value,20);
  app.fit.handleAction('food-edit',sourced.id);app.fit.handleChange({id:'review-carbs',value:''});app.fit.handleAction('fit-confirm');
  let saved=app.data.foodLog.entries[0],model=app.sandbox.NudgeToday.model(app.data,'2026-10-01');
  assert.equal(saved.nutritionSnapshot.carbohydrate.portion,null);assert.equal(model.carbs.value,null);assert.equal(model.carbs.unknown,1);assert.equal(app.sandbox.NudgeToday.status(model.carbs),'unknown');assert.equal(model.weekCarbs.value,null);
  assert.deepEqual(copy(saved.sourceMeta.mealComposition),sourceBefore,'Corrections preserve the original source evidence');
  const reloaded=withProjection(copy(app.data.foodLog.entries));assert.equal(reloaded.sandbox.NudgeToday.model(reloaded.data,'2026-10-01').carbs.value,null,'Unknown correction persists after restart');
  const storage=new Map();app.sandbox.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web/repertoire.js'),'utf8'),app.sandbox);
  const repertoire=app.sandbox.createNudgeRepertoire(app.ctx);repertoire.saveEntry(saved);repertoire.open(repertoire.items()[0].id);app.fit.handleAction('fit-confirm');
  assert.equal(app.data.foodLog.entries.length,2);assert.equal(app.sandbox.NudgeToday.model(app.data,'2026-10-01').carbs.value,null,'Replaying saved food must not restore a cleared value');
  app.fit.handleAction('food-edit',saved.id);app.fit.handleChange({id:'review-carbs',value:'0'});app.fit.handleAction('fit-confirm');
  model=app.sandbox.NudgeToday.model(app.data,'2026-10-01');assert.equal(model.carbs.value,0);assert.equal(model.carbs.unknown,1,'The replay remains unknown while an explicitly supplied zero is known');
}
console.log('PASS: source-linked carbohydrate clearing stays unknown in daily/weekly projections, reload and saved-food replay; later explicit zero remains known.');
