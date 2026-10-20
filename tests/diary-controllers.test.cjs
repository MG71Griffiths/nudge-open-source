// Screen adapters use the same confirmed-intake commands; synthetic state only.
const assert=require('node:assert/strict');
const {boot,today}=require('./label-photo.test.cjs');
const copy=value=>JSON.parse(JSON.stringify(value));
const meal={id:'meal-existing',name:'Fish pie and peas',day:today,slot:'Dinner',portions:1,plants:['potato','pea'],ferments:[],energyPerPortion:205,proteinPerPortion:19,fibrePerPortion:null,portionAmount:320,portionUnit:'g',nutritionSnapshot:{carbohydrate:{portion:null,per100:null,unit:'g',portionStatus:'partial',per100Status:'unknown',knownPortionSubtotal:31.5,knownContributions:2,unknownContributions:1}},sourceMeta:{confirmationId:'meal-existing',mealComposition:[{id:'recipe',role:'recipe'},{id:'side',role:'side'}],mealRecipeCalculation:{selection:{fraction:.25},servings:4},mealPortionSelection:{fraction:.25,recipeOnly:true}}};

// Manual entry used to ignore a failed main-store save and close its draft.
const manual=boot(),error={textContent:''};
manual.sandbox.document.getElementById=()=>error;
manual.sandbox.FormData=class{constructor(form){this.values=form;}get(key){return this.values[key]??null;}};
manual.view.screen='food-entry';manual.view.foodDraft={name:'Manual meal',plants:[],ferments:[]};
const form={name:'Manual meal',day:today,slot:'Lunch',portions:'1.5',plants:'tomatoes, tomato',ferments:'',fibre:'',eaten:'on'};
const initial=manual.data.foodLog.entries;manual.canSave(false);manual.patterns.saveForm(form);
assert.equal(manual.data.foodLog.entries,initial);assert.equal(manual.view.screen,'food-entry');assert.ok(manual.view.foodDraft);assert.match(error.textContent,/could not be saved/);
manual.canSave(true);manual.patterns.saveForm(form);assert.equal(manual.data.foodLog.entries.length,1);assert.equal(manual.view.foodDraft,null);assert.equal(manual.data.foodLog.entries[0].fibrePerPortion,null);assert.deepEqual(Array.from(manual.data.foodLog.entries[0].plants),['tomato']);
manual.patterns.saveForm(form);assert.equal(manual.data.foodLog.entries.length,1,'A repeated submit after navigation is a no-op');
const savedManual=copy(manual.data.foodLog.entries[0]);manual.canSave(false);manual.patterns.handleAction('food-delete',savedManual.id);assert.deepEqual(copy(manual.data.foodLog.entries),[savedManual]);assert.match(manual.toasts.at(-1),/could not be removed/);
manual.canSave(true);manual.patterns.handleAction('food-delete',savedManual.id);assert.equal(manual.data.foodLog.entries.length,0);

// Editing a saved recipe changes the multiplier without losing the selected
// quarter dish, whole side, uncertainty or original diary identity.
const app=boot([meal,{...meal,id:'keep',sourceMeta:{confirmationId:'keep'}}]);
app.fit.handleAction('food-edit',meal.id);const before=copy(app.data.foodLog.entries);
app.fit.handleAction('fit-portions','2');app.canSave(false);app.fit.handleAction('fit-confirm');
assert.deepEqual(copy(app.data.foodLog.entries),before);assert.equal(app.view.foodDraft.portions,2);assert.equal(app.view.screen,'food-entry');
app.canSave(true);app.fit.handleAction('fit-confirm');assert.equal(app.data.foodLog.entries[0].id,meal.id);assert.equal(app.data.foodLog.entries[0].portions,2);assert.equal(app.data.foodLog.entries[1].id,'keep');
assert.deepEqual(copy(app.data.foodLog.entries[0].sourceMeta),before[0].sourceMeta);assert.deepEqual(copy(app.data.foodLog.entries[0].nutritionSnapshot),before[0].nutritionSnapshot);
app.fit.handleAction('fit-confirm');assert.equal(app.data.foodLog.entries.length,2);

// A draft can outlive deletion elsewhere. Saving it must not recreate the entry.
app.fit.handleAction('food-edit',meal.id);app.data.foodLog.entries=app.data.foodLog.entries.filter(e=>e.id!==meal.id);
const writes=app.writes();app.fit.handleAction('fit-confirm');assert.equal(app.writes(),writes);assert.equal(app.data.foodLog.entries.length,1);assert.match(app.toasts.at(-1),/no longer available/);assert.ok(app.view.foodDraft);

// Candidate IDs are not proof of an existing eating occasion. A reusable
// analysis explicitly requests an add; an ID collision must never become edit.
const candidate=boot(),draft={...copy(meal),id:'reusable-candidate',diaryIntent:'add',sourceMeta:{...copy(meal.sourceMeta),confirmationId:''}};
candidate.view.foodDraft=copy(draft);candidate.view.screen='food-entry';
assert.match(candidate.fit.reviewScreen(),/data-action="fit-confirm"[^>]*>Add to today/);assert.doesNotMatch(candidate.fit.reviewScreen(),/Save changes|data-action="food-delete"/);
candidate.fit.handleAction('fit-confirm');assert.equal(candidate.data.foodLog.entries.length,1);assert.equal(candidate.data.foodLog.entries[0].id,draft.id);assert.equal(candidate.data.foodLog.entries[0].diaryIntent,undefined);assert.equal(candidate.persisted().foodLog.entries[0].diaryIntent,undefined,'Draft intent never enters the persisted schema');
const confirmed=copy(candidate.data.foodLog.entries),confirmedWrites=candidate.writes();candidate.view.foodDraft={...copy(draft),name:'Repeated candidate must not replace intake'};candidate.view.screen='food-entry';candidate.fit.handleAction('fit-confirm');
assert.deepEqual(copy(candidate.data.foodLog.entries),confirmed);assert.equal(candidate.writes(),confirmedWrites);assert.ok(candidate.view.foodDraft,'Duplicate candidates remain available for review rather than silently editing');

// Adapters that throw receive the same rollback as a false acknowledgement.
const throwing=boot([meal]),fit=throwing.sandbox.createNudgeFit({...throwing.ctx,foodPatterns:throwing.patterns,save:()=>{throw Error('Unavailable');}});
fit.handleAction('food-edit',meal.id);fit.handleAction('fit-portions','2');const unchanged=JSON.stringify(throwing.data);assert.doesNotThrow(()=>fit.handleAction('fit-confirm'));assert.equal(JSON.stringify(throwing.data),unchanged);assert.equal(throwing.view.foodDraft.portions,2);
console.log('PASS: manual/repertoire review diary adapters preserve drafts on failure, reject stale edits, keep fractional recipe evidence and roll back thrown saves.');
