const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const clone=value=>JSON.parse(JSON.stringify(value));
const sandbox={window:null,Date,Math,console,document:{getElementById:()=>null}};sandbox.window=sandbox;sandbox.NudgeIcons=()=>'';vm.createContext(sandbox);
for(const file of ['shared-controls.js','streaks.js','core/diary.js','core/food-log.js','food-patterns.js','cycle-support.js'])vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),sandbox,{filename:file});
const model=sandbox.NudgeCycle;
assert.equal(model.clean().enabled,false);assert.equal(model.clean().start,null);assert.equal(model.clean().length,null);assert.equal(model.clean().contraception,'unknown');
assert.equal(model.dateNumber('2026-02-30'),null);assert.equal(model.dateNumber('2024-02-29')!==null,true);
const raw={enabled:true,start:'2026-09-12',length:28,regularity:'regular',contraception:'none',focus:['Hunger','unexpected'],checkins:[{day:'2026-10-01',hunger:'About usual'},{day:'2026-10-01',hunger:'More than usual',energy:'injected'}, {day:'garbage',bleeding:'Heavy'}]},before=JSON.stringify(raw);
const clean=model.clean(raw);assert.equal(JSON.stringify(raw),before);assert.deepEqual(clone(clean.focus),['Hunger']);assert.deepEqual(clone(clean.checkins),[{day:'2026-10-01',hunger:'More than usual'}]);
assert.deepEqual(clone(model.phase(clean,'2026-10-04')),{estimated:true,id:'luteal',cycleDay:23,remaining:6});
assert.equal(model.phase(clean,'2026-09-12').id,'period');assert.equal(model.phase(clean,'2026-09-20').id,'follicular');assert.equal(model.phase(clean,'2026-09-25').id,'ovulation');
for(const change of [{enabled:false},{contraception:'hormonal'},{contraception:'unknown'},{regularity:'irregular'},{regularity:'unknown'},{length:null},{start:null}])assert.equal(model.phase({...clean,...change},'2026-10-04').estimated,false);
assert.equal(model.phase(clean,'2026-09-01').estimated,false,'Future start cannot infer a stage');assert.equal(model.phase(clean,'2026-10-15').estimated,false,'Do not roll old starts into invented new cycles');assert.equal(model.phase(clean,'bad').estimated,false);
assert.equal(model.recipeMatches('berry','period'),false);assert.equal(model.recipeMatches('chickpea','period'),true);assert.equal(model.recipeMatches('salmon','ovulation'),true);assert.equal(model.recipeMatches('berry','luteal'),true);assert.equal(model.recipeMatches('berry','all'),true);
const allUnknown=model.micronutrients([{day:'2026-10-04',portions:1}], '2026-10-04');assert.equal(allUnknown.iron.value,null);assert.equal(allUnknown.calcium.value,null);assert.equal(allUnknown.iron.unknown,1);
const knownZero=model.micronutrients([{day:'2026-10-04',portions:2,ironMgPerPortion:0,calciumMgPerPortion:10},{day:'2026-10-04',portions:1},{day:'2026-10-04',portions:1,confirmedByUser:false,ironMgPerPortion:100}], '2026-10-04');assert.equal(knownZero.iron.value,0);assert.equal(knownZero.calcium.value,20);assert.equal(knownZero.calcium.unknown,1);
let state={cycleSupport:clean,foodLog:{entries:[],savedRecipes:[]},nutritionProfile:{target:125,calorieTarget:2000}},view={},persisted=0,allowSave=true,toasts=[],route='';const protectedBefore=JSON.stringify({foodLog:state.foodLog,nutritionProfile:state.nutritionProfile});
const ctx={getState:()=>state,view,save:()=>{persisted++;return allowSave;},render(){},navigate:value=>route=value,showToast:value=>toasts.push(value),escapeHtml:String,todayKey:()=> '2026-10-04',recipeBy:id=>({id,name:id,image:id+'.webp',category:'Lunch',minutes:10})};
const cycle=sandbox.createNudgeCycle(ctx);
assert.match(cycle.screen(),/Day 23/);assert.match(cycle.screen(),/Next period in about 6 days/);assert.doesNotMatch(cycle.screen(),/8\.6|460 \/|14\.8/);assert.match(cycle.screen(),/not available for your logged foods/);
assert.match(cycle.settingsScreen(),/save automatically/);assert.match(cycle.settingsScreen(),/id="cycle-start"/);
cycle.handleAction('cycle-checkin');assert.equal(route,'cycle-checkin');cycle.handleAction('cycle-check-choice','hunger|More than usual');cycle.handleAction('cycle-check-choice','cramps|Mild');cycle.handleAction('cycle-check-save');assert.equal(route,'cycle');assert.equal(state.cycleSupport.checkins.length,2);assert.equal(state.cycleSupport.checkins.at(-1).hunger,'More than usual');
cycle.handleAction('cycle-checkin');cycle.handleAction('cycle-check-choice','hunger|Less than usual');cycle.handleAction('cycle-open');assert.equal(state.cycleSupport.checkins.at(-1).hunger,'More than usual','Cancelling check-in leaves persisted answers unchanged');
cycle.handleAction('cycle-checkin');cycle.handleAction('cycle-check-choice','hunger|Less than usual');cycle.handleAction('cycle-check-save');assert.equal(state.cycleSupport.checkins.length,2,'Same-day edits replace rather than duplicate check-in');
const reloaded=sandbox.createNudgeCycle({...ctx,getState:()=>({...state,cycleSupport:model.clean(clone(state.cycleSupport))})});assert.match(reloaded.screen(),/Less than usual/);
cycle.handleAction('cycle-recipes','luteal');assert.equal(view.recipePhase,'luteal');assert.equal(route,'recipes');
cycle.handleChange({id:'cycle-enabled',checked:false});assert.equal(state.cycleSupport.enabled,false);assert.equal(state.cycleSupport.checkins.length,2,'Disabling does not erase checks');assert.doesNotMatch(cycle.screen(),/Your daily check-in/);
cycle.handleChange({id:'cycle-enabled',checked:true});assert.equal(state.cycleSupport.enabled,true);
const calls=persisted;cycle.handleChange({id:'cycle-start',value:'2026-10-05'});assert.equal(state.cycleSupport.start,'2026-09-12');assert.equal(persisted,calls);
cycle.handleChange({id:'cycle-length',value:'28.5'});assert.equal(state.cycleSupport.length,28);assert.equal(persisted,calls);
cycle.handleChange({id:'cycle-start',value:'2026-10-04'});assert.equal(state.cycleSupport.start,'2026-10-04');assert.deepEqual(clone(state.cycleSupport.periodStarts),['2026-09-12','2026-10-04']);
cycle.handleChange({id:'cycle-length',value:''});assert.equal(state.cycleSupport.length,null);assert.equal(model.phase(state.cycleSupport,'2026-10-04').estimated,false);
const bytes=JSON.stringify(state.cycleSupport);allowSave=false;cycle.handleAction('cycle-regularity','irregular');assert.equal(JSON.stringify(state.cycleSupport),bytes,'Save failure rolls state back');assert.match(toasts.at(-1),/Could not save/);
assert.equal(JSON.stringify({foodLog:state.foodLog,nutritionProfile:state.nutritionProfile}),protectedBefore,'Cycle actions do not alter food, intake, scores or targets');
const patterns=sandbox.createWmdFoodPatterns({...ctx,button:()=>'',nudge:()=>'',showDialog(){}});view.recipePhase='period';const filtered=patterns.recipeScreen();assert.match(filtered,/Crunchy chickpea/);assert.doesNotMatch(filtered,/Berry, oat|Salmon, rice/);assert.match(filtered,/Follicular/);patterns.handleAction('recipe-phase','all');assert.match(patterns.recipeScreen(),/Berry, oat/);
view.recipeId='berry';view.recipeServings=1;assert.match(patterns.recipeDetail(),/aria-label="Decrease recipe servings by one" disabled>−<\/button>/);assert.match(patterns.recipeDetail(),/<strong>1<\/strong><span>serving<\/span>/);patterns.handleAction('recipe-servings','1');assert.match(patterns.recipeDetail(),/<strong>2<\/strong><span>servings<\/span>/);
let midnightDay='2026-10-04';allowSave=true;const midnight=sandbox.createNudgeCycle({...ctx,todayKey:()=>midnightDay});midnight.handleAction('cycle-checkin');midnight.handleAction('cycle-check-choice','energy|Good');midnightDay='2026-10-05';const beforeMidnight=JSON.stringify(state.cycleSupport.checkins);midnight.handleAction('cycle-check-save');assert.equal(JSON.stringify(state.cycleSupport.checkins),beforeMidnight);assert.match(toasts.at(-1),/new day/);midnight.checkinScreen();assert.deepEqual(clone(view.cycleCheckDraft),{});
console.log('PASS: optional cycle persistence, conservative phase estimation, no invented cycles/data, isolated check-ins with same-day replacement and rollback, phase recipe filters, accessible serving controls and unchanged intake/targets.');

assert.equal(model.context(raw,'2026-10-04').name,'Luteal');
assert.match(model.context({...raw,regularity:'irregular'},'2026-10-04').reason,/irregular/);
assert.match(model.context({...raw,contraception:'hormonal'},'2026-10-04').reason,/hormonal contraception/);
assert.match(model.context({...raw,start:null},'2026-10-04').reason,/last period start/);
assert.match(model.context({...raw,start:'2026-08-01'},'2026-10-04').reason,/do not cover today/);
// Cycle meal ideas share Search's evidence and requirements checks. A known
// allergen conflict can never become a recommendation on the cycle screen.
sandbox.URL=URL;vm.runInContext(fs.readFileSync('Web/search-model.js','utf8'),sandbox,{filename:'search-model.js'});
const recipes=[
  {id:'calcium',name:'Calcium breakfast',category:'Breakfast',minutes:5,image:'berry.webp',allergenCodes:['milk'],allergensKnown:true,ingredients:[[150,'g','yoghurt']],nutrition:{basis:'per_serving',perServing:{calcium:{value:230,unit:'mg',status:'calculated',complete:true,sourceURL:'https://www.gov.uk/food-data'}}}},
  {id:'everyday',name:'Everyday vegetable bowl',category:'Lunch',minutes:10,image:null,allergenCodes:[],allergensKnown:true,ingredients:[[150,'g','vegetables']],nutrition:null},
  {id:'unknown',name:'Unverified milk-free bowl',category:'Lunch',minutes:10,ingredients:[[1,'','unknown sauce']],nutrition:null}
];
sandbox.NudgeRecipeCatalogue={all:()=>recipes};
const mealState={cycleSupport:model.clean(raw),nutritionProfile:{},foodLog:{entries:[]}},mealView={};
const meals=sandbox.createNudgeCycle({...ctx,getState:()=>mealState,view:mealView,recipeBy:id=>recipes.find(r=>r.id===id)});
assert.match(meals.entryLink(),/Estimated luteal phase/);assert.match(meals.screen(),/Luteal · before your period/);assert.match(meals.screen(),/Calcium breakfast/);assert.match(meals.screen(),/230 mg calcium/);assert.doesNotMatch(meals.screen(),/Everyday vegetable bowl/);
mealState.nutritionProfile.allergies=['milk'];assert.doesNotMatch(meals.screen(),/Calcium breakfast|Unverified milk-free bowl/);assert.match(meals.screen(),/Everyday vegetable bowl/);assert.match(meals.screen(),/Everyday meal ideas shown/);assert.doesNotMatch(meals.screen(),/assets\/null/);
mealState.nutritionProfile.glutenRequirement='coeliac';mealState.nutritionProfile.allergies=['milk'];
recipes[1].allergensKnown=false;assert.doesNotMatch(meals.screen(),/data-action="recipe-open"/);assert.match(meals.screen(),/Gluten-free ingredient and preparation evidence is missing/);
mealView.cyclePhase='period';assert.match(meals.screen(),/Current estimate: Luteal · Day 23/);assert.match(meals.screen(),/Period · during your period/);
console.log('PASS: clear cycle names and unknown reasons; meal suggestions use sourced nutrients, hide conflicts, and label everyday fallbacks.');
