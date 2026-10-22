const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {test}=require('node:test');
const copy=value=>JSON.parse(JSON.stringify(value));
const mainKey='wmd-nudge-prototype-v1';
const today='2026-10-07';
const fields=['target','calorieTarget','carbTarget','fatTarget','fibreTarget','weeklyPlantTarget'];
const manualProfile=()=>({saved:true,schemaVersion:2,choiceVersion:'nudge_profile_v3_3',goal:'muscle',goals:['muscle'],trainingTypes:['weight_training'],age:55,weight:78,height:185,sex:'male',activity:'moderate',care:'none',target:150,calorieTarget:2750,carbTarget:331,fatTarget:92,fibreTarget:30,weeklyPlantTarget:30,targetModes:{protein:'manual',calories:'manual',carbs:'automatic',fat:'automatic',fibre:'automatic',plants:'automatic'},extension:{retained:true},foodPreferences:{custom:'retained'},targetHistory:[{id:'earlier-targets',effectiveFrom:'2026-10-04',targets:{protein:150,calories:2750,carbs:331,fat:92,fibre:30,plants:30,dailyPlants:null},source:'earlier profile'}]});
const baseState=()=>({version:1,nutritionProfile:manualProfile(),cycleSupport:{enabled:true,start:'2026-09-15',length:28,regularity:'regular',contraception:'none',focus:['Hunger'],periodStarts:['2026-09-15'],checkins:[{day:'2026-10-06',hunger:'About usual'},{day:today,energy:'Low'}]},motionEnabled:true,focus:'food',goal:5,avoidMilk:false,profile:{},foodLog:{entries:[{id:'existing-diary',day:today,name:'Existing food',portions:1,proteinPerPortion:20,ironMgPerPortion:0,calciumMgPerPortion:100}],savedRecipes:[],plantGoal:30},unknownTopLevel:{keep:'me'}});

// Execute the production application adapter with a deterministic native storage
// boundary. History/repertoire rendering is outside these profile/cycle contracts.
function session(input=baseState(), recipes=[], options={}) {
  const values=new Map([[mainKey,JSON.stringify(input)]]), writes=[], diagnostics=[];
  let failWrites=options.failWrites===true,currentDay=today;
  const sandbox={console,Date,Math,JSON,URL,window:null,
    nativeToday:()=>currentDay,nativeNow:()=>currentDay+'T12:00:00Z',
    nativeDiagnostic:(...args)=>diagnostics.push(args),
    nativeStorage:request=>{
      const r=JSON.parse(request);
      if(r.operation==='get')return JSON.stringify({ok:true,exists:values.has(r.key),value:values.get(r.key)??null});
      if(failWrites)return JSON.stringify({ok:false,error:'native_write'});
      if(r.operation==='set'){writes.push(r);values.set(r.key,r.value);return '{"ok":true}';}
      if(r.operation==='remove'){values.delete(r.key);return '{"ok":true}';}
      throw Error('unexpected storage operation');
    },
    WmdFoodLog:{initial:()=>({entries:[],savedRecipes:[],plantGoal:30}),clean:raw=>raw},
    NudgeRecipeCatalogue:{byId:id=>recipes.find(r=>r.id===id)||null,all:()=>recipes},
    createNudgeHistory:()=>({nativeProjection:()=>({rows:[]}),productCandidates:()=>[]}),
    createNudgeRepertoire:()=>({items:()=>[],hiddenLegacyFavourites:()=>[]}),
    NudgeNativeReview:{model:()=>({})}
  };
  sandbox.window=sandbox;vm.createContext(sandbox);
  for(const file of ['core/nutrition-profile.js','core/diary.js','cycle-support.js','search-model.js','native-session.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),sandbox,{filename:file});
  const api=sandbox.NudgeNativeSession;
  const result=copy(api.init());
  assert.equal(result.readFailed,false);
  return {api,result,writes,diagnostics,
    perform:(op,p={})=>copy(api.perform(op,p)),project:(op,p={})=>copy(api.project(op,p)),snapshot:()=>copy(api.snapshot()),
    saved:()=>JSON.parse(values.get(mainKey)),rawSaved:()=>values.get(mainKey),failWrites:value=>failWrites=value,day:value=>currentDay=value};
}

test('opening SwiftUI profile/cycle reads existing records without rewriting overrides or diary',()=>{
  const original=baseState(),s=session(original),bytes=s.rawSaved();
  const p=s.project('profile').profile,c=s.project('cycle');
  assert.equal(p.target,150);assert.equal(p.targetModes.protein,'manual');
  assert.equal(c.context.id,'luteal');assert.equal(c.context.cycleDay,23);
  assert.equal(c.nutrients.iron.value,0,'A known micronutrient zero stays known');
  assert.equal(c.nutrients.calcium.value,100);
  assert.equal(s.rawSaved(),bytes);assert.equal(s.writes.length,0);
  assert.deepEqual(s.snapshot().state.foodLog,original.foodLog);
});

test('automatic profile targets use the established complete macro budget and keep historical targets',()=>{
  const original=baseState();original.foodLog.plantGoal=20;
  const s=session(original),p=s.project('profile').profile;
  p.targetModes=Object.fromEntries(['protein','calories','carbs','fat','fibre','plants'].map(k=>[k,'automatic']));
  const result=s.perform('profileSave',{profile:p});
  assert.equal(result.ok,true);
  assert.deepEqual(fields.map(k=>result.state.nutritionProfile[k]),[125,2650,340,88,30,30]);
  assert.equal(result.state.foodLog.plantGoal,30,'The legacy plant-goal projection is updated with the active target');
  assert.deepEqual(result.state.nutritionProfile.targetHistory[0],original.nutritionProfile.targetHistory[0]);
  assert.equal(result.state.nutritionProfile.targetHistory.at(-1).effectiveFrom,today);
  assert.deepEqual(result.state.foodLog.entries,original.foodLog.entries);
  assert.deepEqual(result.state.unknownTopLevel,original.unknownTopLevel);
  assert.deepEqual(result.state.nutritionProfile.extension,{retained:true});
  assert.equal(result.state.nutritionProfile.foodPreferences.custom,'retained');
  assert.equal(s.project('profile').budget.state,'balanced');
  assert.ok(Math.abs(s.project('profile').budget.differenceKcal)<=10);
});

test('editing personal details preserves explicit targets and recomputes only automatic metrics',()=>{
  const s=session(),p=s.project('profile').profile;p.weight=90;
  const r=s.perform('profileSave',{profile:p});assert.equal(r.ok,true);
  assert.equal(r.state.nutritionProfile.target,150);assert.equal(r.state.nutritionProfile.calorieTarget,2750);
  assert.equal(r.state.nutritionProfile.fatTarget,92);assert.equal(r.state.nutritionProfile.carbTarget,331);
  assert.equal(r.state.nutritionProfile.targetModes.protein,'manual');
  assert.equal(r.state.nutritionProfile.targetHistory[0].targets.protein,150);
});

test('native startup repairs available missing automatic targets prospectively without changing intake or overrides',()=>{
  const original=baseState();
  original.nutritionProfile={...manualProfile(),carbTarget:null,fatTarget:null,fibreTarget:null,
    targetModes:{protein:'manual',calories:'manual',carbs:'automatic',fat:'automatic',fibre:'manual',plants:'automatic'},
    targetSourceDetails:{carbs:{status:'pending',reason:'Add activity'},fat:{status:'pending',reason:'Add activity'}}};
  original.foodLog.entries[0].retiredField={mustKeep:'exactly'};
  const before=copy(original),s=session(original),p=s.snapshot().state.nutritionProfile;
  assert.equal(p.carbTarget,331);assert.equal(p.fatTarget,92);
  assert.equal(p.target,150);assert.equal(p.calorieTarget,2750);
  assert.equal(p.fibreTarget,null,'A deliberately cleared manual target stays cleared');
  assert.deepEqual(p.targetHistory[0],before.nutritionProfile.targetHistory[0]);
  assert.equal(p.targetHistory.at(-1).effectiveFrom,today);
  assert.deepEqual(s.snapshot().state.foodLog,before.foodLog,'Do not normalize or resave intake fields');
  assert.deepEqual(s.snapshot().state.unknownTopLevel,before.unknownTopLevel);
  assert.equal(s.writes.length,1,'Save one atomic main-store repair');
  const restarted=session(s.saved());assert.equal(restarted.writes.length,0,'Repair is idempotent');
});

test('native startup preserves legacy targets and weekly goal while filling only eligible missing targets',()=>{
  const original=baseState();original.foodLog.plantGoal=20;
  original.nutritionProfile={saved:true,goal:'muscle',age:55,weight:78,height:185,sex:'male',activity:'moderate',care:'none'};
  const s=session(original),p=s.snapshot().state.nutritionProfile;
  assert.equal(p.target,125);assert.equal(p.calorieTarget,2650);
  assert.equal(p.targetModes.protein,'manual','Retain the established legacy target as an accepted value');
  assert.equal(p.fatTarget,88);assert.equal(p.carbTarget,340);assert.equal(p.fibreTarget,30);
  assert.equal(p.weeklyPlantTarget,20);assert.equal(s.saved().foodLog.plantGoal,20);
  assert.deepEqual(s.saved().foodLog.entries,original.foodLog.entries);
});

test('native startup does not invent missing inputs or overwrite clinical or deliberately cleared targets',()=>{
  const incomplete=baseState();
  incomplete.nutritionProfile={...manualProfile(),height:null,activity:'unknown',target:null,calorieTarget:null,carbTarget:null,fatTarget:null,
    targetModes:{protein:'manual',calories:'automatic',carbs:'automatic',fat:'automatic',fibre:'automatic',plants:'automatic'}};
  for(const p of [incomplete.nutritionProfile,{...incomplete.nutritionProfile,care:'clinical'},
    {...incomplete.nutritionProfile,care:'glp1'},{...incomplete.nutritionProfile,age:17},
    {...incomplete.nutritionProfile,saved:false}]) {
    const original={...incomplete,nutritionProfile:p},s=session(original);
    assert.equal(s.writes.length,0);assert.deepEqual(s.snapshot().state,original);
  }
});

test('failed startup target repair keeps all persisted and in-memory records unchanged',()=>{
  const original=baseState();original.nutritionProfile.fatTarget=null;
  const s=session(original,[],{failWrites:true});
  assert.equal(s.writes.length,0);assert.deepEqual(s.saved(),original);assert.deepEqual(s.snapshot().state,original);
  assert.match(s.result.message,/targets.*could not be saved|could not.*targets/i);
  assert.equal(session(s.saved()).snapshot().state.nutritionProfile.fatTarget,92,'A later successful opening can retry');
});

test('new profile with missing age cannot invent automatic targets, and medical contexts retain agreed values',()=>{
  for(const care of ['none','clinical','glp1']) {
    const state=baseState();state.nutritionProfile={saved:false,age:care==='none'?null:55,weight:78,height:185,sex:'male',activity:'moderate',goal:'muscle',goals:['muscle'],care};
    const s=session(state),r=s.perform('profileSave',{profile:s.project('profile').profile});
    assert.equal(r.ok,true);
    assert.deepEqual(fields.map(k=>r.state.nutritionProfile[k]),Array(6).fill(null));
    assert.ok(fields.every(k=>r.state.nutritionProfile[k]!==0));
  }
  const state=baseState();state.nutritionProfile.care='clinical';
  const s=session(state),p=s.project('profile').profile;p.target=130;p.targetModes.protein='manual';
  assert.equal(s.perform('profileSave',{profile:p}).state.nutritionProfile.target,130);
});

test('invalid numeric profile input is rejected without replacing valid targets with null',()=>{
  for(const [key,value] of [['age',17],['age',55.5],['height',400],['weight',10],['sessions',8],['target',251],['calorieTarget',1199],['carbTarget',-1],['fatTarget',301],['fibreTarget',101],['weeklyPlantTarget',17],['dailyPlantTarget',1.2]]) {
    const s=session(),bytes=s.rawSaved(),before=s.snapshot().state,p=s.project('profile').profile;p[key]=value;
    const r=s.perform('profileSave',{profile:p});
    assert.equal(r.ok,false,key+' must be validated before writing');
    assert.equal(s.rawSaved(),bytes);assert.deepEqual(r.state,before);assert.equal(s.writes.length,0);
  }
});

test('profile write failure rolls back target history, nutrient targets, and mirrored plant goal together',()=>{
  const s=session(),before=s.snapshot().state,bytes=s.rawSaved(),p=s.project('profile').profile;
  p.weight=80;p.weeklyPlantTarget=20;p.targetModes.plants='manual';s.failWrites(true);
  const failed=s.perform('profileSave',{profile:p});assert.equal(failed.ok,false);
  assert.deepEqual(failed.state,before);assert.equal(s.rawSaved(),bytes);
  s.failWrites(false);const retry=s.perform('profileSave',{profile:p});assert.equal(retry.ok,true);
  assert.equal(retry.state.nutritionProfile.weight,80);assert.equal(retry.state.foodLog.plantGoal,20);
  assert.deepEqual(retry.state.foodLog.entries,before.foodLog.entries);
});

test('legacy profile editor retains actual onboarding choices and the prior weekly goal',()=>{
  const state=baseState();state.profile={edited:true,goals:['Eat more plants','Build a steady routine'],cooking:'Under 15 minutes'};
  state.foodLog.plantGoal=20;state.nutritionProfile={saved:true,goal:'balance',age:55,weight:78,care:'none'};
  const s=session(state),startupWrites=s.writes.length,p=s.project('profile').profile;
  assert.ok(p.goals.includes('more_plants'));assert.ok(p.goals.includes('steady_routine'));
  assert.equal(p.weeklyPlantTarget,20);assert.equal(p.foodPreferences.mealPlanning,'Under 15 minutes');
  assert.equal(s.writes.length,startupWrites,'Viewing the migration draft does not alter saved data after startup repair');
});

test('cycle edits preserve check-ins and never rewrite profile, scores, or confirmed intake',()=>{
  const s=session(),before=s.snapshot().state,c=s.project('cycle').cycle;
  c.start=today;c.regularity='irregular';c.enabled=false;
  const r=s.perform('cycleSave',{cycle:c});assert.equal(r.ok,true);
  assert.deepEqual(r.state.nutritionProfile,before.nutritionProfile);assert.deepEqual(r.state.foodLog,before.foodLog);
  assert.deepEqual(r.state.cycleSupport.checkins,before.cycleSupport.checkins);
  assert.ok(r.state.cycleSupport.periodStarts.includes(today));
  assert.equal(s.project('cycle').context.estimated,false);
});

test('invalid cycle dates/lengths and failed storage cannot discard the saved cycle',()=>{
  for(const patch of [{start:'2026-02-30'},{start:'2026-10-08'},{length:20},{length:28.5},{length:46}]) {
    const s=session(),bytes=s.rawSaved(),before=s.snapshot().state;
    assert.equal(s.perform('cycleSave',{cycle:{...s.project('cycle').cycle,...patch}}).ok,false);
    assert.equal(s.rawSaved(),bytes);assert.deepEqual(s.snapshot().state,before);
  }
  const s=session(),before=s.snapshot().state,bytes=s.rawSaved();s.failWrites(true);
  assert.equal(s.perform('cycleSave',{cycle:{...s.project('cycle').cycle,enabled:false}}).ok,false);
  assert.deepEqual(s.snapshot().state,before);assert.equal(s.rawSaved(),bytes);
});

test('native daily check-in replaces same day once, filters answers and clearing removes the day',()=>{
  const s=session(),before=s.snapshot().state;
  const r=s.perform('cycleCheckin',{day:today,answers:{hunger:'More than usual',energy:'Good',cramps:'invented',unknown:'ignore'}});
  assert.equal(r.ok,true);
  assert.equal(r.state.cycleSupport.checkins.filter(c=>c.day===today).length,1);
  assert.deepEqual(r.state.cycleSupport.checkins.find(c=>c.day===today),{day:today,hunger:'More than usual',energy:'Good'});
  assert.deepEqual(r.state.cycleSupport.checkins.find(c=>c.day==='2026-10-06'),before.cycleSupport.checkins[0]);
  assert.deepEqual(r.state.foodLog,before.foodLog);assert.deepEqual(r.state.nutritionProfile,before.nutritionProfile);
  const cleared=s.perform('cycleCheckin',{day:today,answers:{}});assert.equal(cleared.ok,true);
  assert.equal(cleared.state.cycleSupport.checkins.some(c=>c.day===today),false);
});

test('disabled support, day rollover and write failure leave existing check-ins untouched',()=>{
  const disabled=baseState();disabled.cycleSupport.enabled=false;
  let s=session(disabled),before=s.rawSaved();
  assert.equal(s.perform('cycleCheckin',{day:today,answers:{energy:'Good'}}).ok,false);assert.equal(s.rawSaved(),before);
  s=session();before=s.rawSaved();s.day('2026-10-08');
  const stale=s.perform('cycleCheckin',{day:today,answers:{energy:'Good'}});
  assert.equal(stale.ok,false);assert.match(stale.message,/new day|today/i);assert.equal(s.rawSaved(),before);
  s=session();before=s.rawSaved();const state=s.snapshot().state;s.failWrites(true);
  assert.equal(s.perform('cycleCheckin',{day:today,answers:{energy:'Good'}}).ok,false);
  assert.equal(s.rawSaved(),before);assert.deepEqual(s.snapshot().state,state);
});

test('read-only cycle projections preserve uncertainty for irregular, hormonal, stale and missing dates',()=>{
  for(const change of [{regularity:'irregular'},{contraception:'hormonal'},{start:'2026-08-01'},{start:null,length:null}]) {
    const state=baseState();Object.assign(state.cycleSupport,change);const s=session(state),bytes=s.rawSaved(),p=s.project('cycle');
    assert.equal(p.context.estimated,false);assert.equal(p.context.name,null);assert.ok(p.context.reason.length>0);
    assert.equal(s.rawSaved(),bytes);assert.equal(s.writes.length,0);
  }
});


test('native cycle meal ideas reuse sourced stage criteria and saved food requirements automatically',()=>{
  const recipes=[
    {id:'calcium',name:'Calcium breakfast',category:'Breakfast',minutes:5,image:'berry-bowl.webp',allergenCodes:['milk'],allergensKnown:true,ingredients:[[150,'g','yoghurt']],nutrition:{basis:'per_serving',perServing:{calcium:{value:230,unit:'mg',status:'calculated',complete:true,sourceURL:'https://www.gov.uk/food-data'}}}},
    {id:'everyday',name:'Everyday vegetable bowl',category:'Lunch',minutes:10,image:null,allergenCodes:[],allergensKnown:true,ingredients:[[150,'g','vegetables']],nutrition:null},
    {id:'unknown',name:'Unverified milk-free bowl',category:'Lunch',minutes:10,ingredients:[[1,'','unknown sauce']],nutrition:null}
  ];
  let s=session(baseState(),recipes),p=s.project('cycle');
  assert.deepEqual(p.ideas.map(i=>i.id),['calcium']);assert.match(p.ideas[0].reason,/230 mg calcium/);
  assert.equal(p.ideas[0].image,'/assets/berry-bowl.webp');assert.equal(s.writes.length,0);
  const restricted=baseState();restricted.nutritionProfile.allergies=['milk'];s=session(restricted,recipes);p=s.project('cycle');
  assert.deepEqual(p.ideas.map(i=>i.id),['everyday']);assert.equal(p.ideas[0].image,null);assert.match(p.ideasNote,/Everyday meal ideas/);
  assert.equal(p.ideas[0].reason,'Everyday meal idea');assert.doesNotMatch(p.ideasNote,/review|check your requirements/i);
  restricted.nutritionProfile.glutenRequirement='coeliac';s=session(restricted,recipes);p=s.project('cycle');
  assert.equal(p.ideas.length,0);assert.match(p.ideasNote,/Gluten-free ingredient and preparation evidence is missing/);
  s=session(baseState(),recipes);p=s.project('cycle',{phase:'period'});
  assert.equal(p.context.id,'luteal','Exploring another stage does not relabel the saved date estimate');
  assert.match(p.ideasNote,/sourced iron/);assert.ok(p.ideas.every(i=>i.reason==='Everyday meal idea'));
  assert.equal(s.writes.length,0);
});
