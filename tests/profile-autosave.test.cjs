const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const copy=value=>JSON.parse(JSON.stringify(value)),elements=new Map();
class FormDataFixture{constructor(form){this.values=form.values;}get(key){const v=this.values[key];return v===undefined||Array.isArray(v)&&!v.length?null:Array.isArray(v)?v[0]:v;}getAll(key){return this.values[key]===undefined?[]:[].concat(this.values[key]);}}
const sandbox={window:null,Date,Math,console,FormData:FormDataFixture,document:{getElementById:id=>elements.get(id)||null,querySelector:()=>null}};sandbox.window=sandbox;vm.createContext(sandbox);
for(const name of ['core/diary.js','shared-controls.js','core/nutrition-profile.js','nudge-fit.js'])vm.runInContext(fs.readFileSync('Web/'+name,'utf8'),sandbox,{filename:name});
const model=sandbox.NudgeNutrition;
assert.equal(model.clean({}).carbTarget,null);
assert.deepEqual(copy(model.clean({tracking:['protein','calories','plants','fibre']}).tracking),['protein','calories','carbs','fat','fibre','plants']);
assert.deepEqual(copy(model.clean({tracking:['protein','plants']}).tracking),['protein','plants']);
assert.deepEqual(copy(model.clean({choiceVersion:model.choiceVersion,tracking:['protein','calories','plants','fibre']}).tracking),['protein','calories','plants','fibre'],'A current explicit preference can hide carbs');
const previous=model.saveDraft({...model.draft({}),age:40,sex:'female',height:170,weight:65,target:90,calorieTarget:2000,weeklyPlantTarget:20,goals:['muscle','retired-goal'],habits:['fibre'],allergies:['milk'],allergiesAnswered:true,tracking:['protein','calories','carbs','fibre','plants'],foodPreferences:{dislikes:['saved dislike'],cuisines:['saved cuisine']},extraFutureSetting:{retain:true}}, {},'2026-10-03');
const carbSaved=model.saveDraft({...previous,carbTarget:240},previous,'2026-10-04');
assert.equal(carbSaved.targetHistory.length,2);assert.equal(model.targetAt(carbSaved,'2026-10-04','carbs').value,240);assert.equal(model.targetAt(carbSaved,'2026-10-03','carbs').value,259);
const historicalWithoutCarbs={...previous,targetHistory:[{effectiveFrom:'2026-10-01',targets:{protein:90}}]};assert.equal(model.targetAt(historicalWithoutCarbs,'2026-10-04','carbs').known,false);
assert.equal(model.carbs({...carbSaved,carbTarget:0}).grams,0,'Zero target is explicit, not unset');assert.equal(model.clean({...previous,carbTarget:1001}).carbTarget,null);
const sum=model.summary([{day:'2026-10-04',portions:2,nutritionSnapshot:{carbohydrate:{portion:15,portionStatus:'calculated'}}},{day:'2026-10-04',portions:1,nutritionSnapshot:{carbohydrate:{portion:0,portionStatus:'calculated'}}},{day:'2026-10-04',portions:1,nutritionSnapshot:{carbohydrate:{portion:50,portionStatus:'unknown'}}},{day:'2026-10-03',portions:1,nutritionSnapshot:{carbohydrate:{portion:100,portionStatus:'calculated'}}}],'2026-10-04');assert.equal(sum.carbs,30);assert.equal(sum.carbKnown,2);assert.equal(sum.carbUnknown,1);
sandbox.NudgeIcons=()=>'';
let stored=null,saves=0,allowSave=true,renders=0,navigation=[];
const state={nutritionProfile:copy(carbSaved),profile:{},foodLog:{plantGoal:20,entries:[{id:'keep-intake',name:'Keep',portions:1}]}},view={};const intakeBytes=JSON.stringify(state.foodLog.entries);
const fit=sandbox.createNudgeFit({getState:()=>state,view,button:(label,action,style,value='')=>`<button data-action="${action}" data-value="${value}">${label}</button>`,escapeHtml:String,todayKey:()=> '2026-10-04',save:()=>{saves++;if(!allowSave)return false;stored=copy(state);return true;},render:()=>renders++,navigate:screen=>navigation.push(screen),showToast(){},showDialog(){},foodPatterns:{}});
for(const id of ['nutrition-error','nutrition-save-status'])elements.set(id,{textContent:''});
const profileHTML=fit.profileScreen();assert.ok(profileHTML.indexOf('data-profile-group="stats"')<profileHTML.indexOf('data-profile-group="goals"'));assert.match(profileHTML,/Edit Personal details/);assert.match(profileHTML,/Sex/);assert.match(profileHTML,/Carbs/);
fit.beginProfileEdit('stats');const statsHTML=fit.setupScreen();assert.match(statsHTML,/data-profile-group="stats"/);assert.doesNotMatch(statsHTML,/data-profile-group="goals"/);assert.doesNotMatch(statsHTML,/type="submit"|Save &amp;/);assert.match(statsHTML,/Changes save automatically/);
function form(values,names=Object.keys(values)){const f={id:'nutrition-profile-form',values,elements:names.map(name=>({name}))};elements.set('nutrition-profile-form',f);return f;}
function change(f,name){fit.handleChange({name,id:'context-'+name,closest:selector=>selector==='#nutrition-profile-form'?f:null});}
const statsForm=form({age:'41',weight:'66.5',height:'170',sex:'female',care:'unknown'});
change(statsForm,'age');assert.equal(stored.nutritionProfile.age,41);assert.equal(stored.nutritionProfile.weight,65,'Untouched fields are not prematurely saved');assert.deepEqual(stored.nutritionProfile.goals,['muscle','retired-goal']);assert.deepEqual(stored.nutritionProfile.foodPreferences.dislikes,['saved dislike']);assert.equal(stored.nutritionProfile.carbTarget,240);assert.equal(renders,0,'Autosave must not replace the focused control');assert.deepEqual(navigation,[],'Autosave stays in its section');
change(statsForm,'weight');assert.equal(stored.nutritionProfile.weight,66.5);assert.equal(stored.nutritionProfile.target,90);assert.equal(stored.nutritionProfile.calorieTarget,2000);assert.equal(stored.nutritionProfile.targetHistory.length,3,'The age edit records updated automatic fibre provenance; manual targets remain fixed');
statsForm.values.height='abc';change(statsForm,'height');assert.equal(state.nutritionProfile.height,170);assert.match(elements.get('nutrition-error').textContent,/Check height/);
statsForm.values.sex='male';change(statsForm,'sex');assert.equal(stored.nutritionProfile.sex,'male','Another valid field saves while an invalid value remains unsaved');assert.equal(stored.nutritionProfile.height,170);
fit.leaveProfileEdit('you');assert.equal(view.profileDraft,null);fit.beginProfileEdit('stats');assert.equal(view.profileDraft.age,41);assert.equal(view.profileDraft.weight,66.5);assert.equal(model.clean(copy(stored.nutritionProfile)).sex,'male','Reload keeps changes');
fit.beginProfileEdit('goals');const goalForm=form({goals:[]},['goals']);change(goalForm,'goals');assert.deepEqual(stored.nutritionProfile.goals,['retired-goal'],'Clearing reviewed choices retains unknown saved choice');assert.deepEqual(stored.nutritionProfile.allergies,['milk'],'A section edit cannot clear unrelated allergies');
fit.beginProfileEdit('tracking');const trackingForm=form({carbTarget:'0',weeklyPlantTarget:'30',tracking:['protein','calories','fibre','plants']});change(trackingForm,'carbTarget');assert.equal(stored.nutritionProfile.carbTarget,0);assert.equal(stored.nutritionProfile.targetHistory.at(-1).targets.carbs,0);change(trackingForm,'tracking');assert.ok(!stored.nutritionProfile.tracking.includes('carbs'),'An explicit hide survives autosave');
const beforeFailure=copy(state);allowSave=false;change(trackingForm,'weeklyPlantTarget');assert.deepEqual(copy(state),beforeFailure,'A write failure rolls back both profile and plant goal');assert.match(elements.get('nutrition-error').textContent,/Could not save/);allowSave=true;fit.handleAction('profile-retry');assert.equal(stored.foodLog.plantGoal,30);assert.equal(stored.nutritionProfile.weeklyPlantTarget,30);assert.equal(elements.get('nutrition-error').textContent,'');assert.deepEqual(stored.nutritionProfile.extraFutureSetting,{retain:true});assert.equal(JSON.stringify(state.foodLog.entries),intakeBytes,'Profile edits never alter confirmed food');
assert.ok(saves>4);
console.log('PASS: section autosave, focus retention, partial and invalid edits, retry rollback, reload persistence, personal details order, carb target history/zero/unknown and preserved profile/intake.');
// Explicitly removing a muscle goal must clear its legacy single-goal fallback.
const muscleProfile=model.reconcileAutomaticTargets({saved:true,schemaVersion:2,age:55,weight:75,care:'none',goal:'muscle',goals:['muscle'],trainingTypes:[]},'2026-10-04').profile;
state.nutritionProfile=copy(muscleProfile);fit.beginProfileEdit('goals');
change(form({goals:['stay_active']},['goals']),'goals');
assert.equal(stored.nutritionProfile.goal,'balance');assert.equal(stored.nutritionProfile.target,56,'Deselecting muscle without resistance training restores the standard adult guide');
state.nutritionProfile=copy(muscleProfile);fit.beginProfileEdit('goals');
change(form({goals:[]},['goals']),'goals');assert.equal(stored.nutritionProfile.goal,'balance');assert.equal(stored.nutritionProfile.target,56,'Clearing all goals removes the legacy muscle fallback');
state.nutritionProfile={...copy(muscleProfile),trainingTypes:['weight_training']};fit.beginProfileEdit('goals');
change(form({goals:['stay_active']},['goals']),'goals');
assert.equal(stored.nutritionProfile.goal,'balance');assert.equal(stored.nutritionProfile.target,120,'Saved weight training independently retains the resistance-training guide');
state.nutritionProfile=copy(muscleProfile);fit.beginProfileEdit('stats');
change(form({age:'56'},['age']),'age');assert.equal(stored.nutritionProfile.goal,'muscle');assert.equal(stored.nutritionProfile.target,120,'Editing another section does not discard a saved goal');
assert.equal(JSON.stringify(state.foodLog.entries),intakeBytes);
