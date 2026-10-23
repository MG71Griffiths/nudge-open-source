const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {test}=require('node:test');
const n=require('../Web/core/nutrition-profile.js');
const day='2026-10-05';
const copy=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const profile=()=>({saved:true,schemaVersion:2,age:55,sex:'male',weight:78,height:185,activity:'moderate',care:'none',goal:'muscle',goals:['muscle'],trainingTypes:['weight_training']});

test('profile rules load with explicit exports and no DOM or application dependencies',()=>{
  assert.equal(typeof window,'undefined');
  assert.equal(typeof document,'undefined');
  assert.equal(typeof n.reconcileAutomaticTargets,'function');
  const browser={window:{}};
  vm.createContext(browser);
  vm.runInContext(fs.readFileSync(require.resolve('../Web/core/nutrition-profile.js'),'utf8'),browser);
  assert.deepEqual(copy(browser.window.NudgeNutrition.automaticSuggestions(profile())),copy(n.automaticSuggestions(profile())));
  assert.equal(browser.window.createNudgeFit,undefined,'Loading rules does not install a profile screen');
});

test('55-year-old 78kg 185cm male training profile preserves the existing coherent automatic targets',()=>{
  const input=freeze(profile()),before=JSON.stringify(input);
  const p=n.reconcileAutomaticTargets(input,day).profile;
  assert.deepEqual(n.targetValues(p),{protein:125,calories:2650,carbs:340,fat:88,fibre:30,plants:30,dailyPlants:null});
  assert.ok(n.automaticMetrics.every(metric=>p.targetModes[metric]==='automatic'));
  assert.equal(p.targetSourceDetails.protein.inputs.gramsPerKg,1.6);
  assert.equal(p.targetSourceDetails.calories.inputs.goalPolicy,'maintenance; no automatic surplus or deficit');
  assert.equal(p.targetSourceDetails.calories.inputs.restingKcal,1670);
  assert.equal(p.targetSourceDetails.calories.inputs.activityFactor,1.6);
  assert.deepEqual(n.macroBudget(p),{energyKcal:2650,macroKcal:2652,complete:true,known:3,differenceKcal:2,state:'balanced'});
  assert.equal(JSON.stringify(input),before,'Reconciliation never changes the supplied saved profile');
  assert.equal(n.reconcileAutomaticTargets(freeze(copy(p)),day).changed,false,'Reload is idempotent');
});

test('explicit targets stay authoritative and automatic macros use that energy budget',()=>{
  const p=n.reconcileAutomaticTargets({...profile(),target:150,calorieTarget:2750,targetModes:{protein:'manual',calories:'manual'}},day).profile;
  assert.deepEqual(n.targetValues(p),{protein:150,calories:2750,carbs:331,fat:92,fibre:30,plants:30,dailyPlants:null});
  assert.equal(n.macroBudget(p).state,'balanced');
  assert.equal(n.macroBudget(p).differenceKcal,2);
  const updated=n.saveDraft({...copy(p),weight:82,fatTarget:90},freeze(copy(p)),'2026-10-06');
  assert.equal(updated.target,150);
  assert.equal(updated.calorieTarget,2750);
  assert.equal(updated.fatTarget,90);
  assert.equal(updated.targetModes.fat,'manual');
  assert.equal(updated.carbTarget,335);
  assert.equal(n.macroBudget(updated).differenceKcal,0);
  const impossible=n.reconcileAutomaticTargets({...profile(),target:250,calorieTarget:1200,fatTarget:90},day).profile;
  assert.equal(impossible.carbTarget,null,'An exhausted energy budget does not invent a negative carbohydrate target');
  assert.equal(n.macroBudget(impossible).state,'over');
});

test('saved profile extensions, manual zero and target history survive prospective updates',()=>{
  const first=n.reconcileAutomaticTargets({...profile(),carbTarget:0,extension:{futureField:['retained']},foodPreferences:{customPreference:'retained'}},day).profile;
  assert.equal(first.targetModes.carbs,'manual');
  const old=freeze(copy(first)),bytes=JSON.stringify(old);
  const next=n.saveDraft({...copy(first),weight:80},old,'2026-10-06');
  assert.equal(next.carbTarget,0);
  assert.deepEqual(next.extension,first.extension);
  assert.equal(next.foodPreferences.customPreference,'retained');
  assert.deepEqual(next.targetHistory.slice(0,first.targetHistory.length),first.targetHistory);
  assert.equal(n.targetAt(next,day,'protein').value,125);
  assert.equal(n.targetAt(next,'2026-10-06','protein').value,128);
  assert.equal(n.targetAt(next,'2026-10-04','protein').known,false,'New targets never backfill earlier dates');
  for(const read of [n.clean,n.target,n.calories,n.carbs,n.fat,n.macroBudget,n.automaticSuggestions])read(old);
  assert.equal(JSON.stringify(old),bytes);
});

test('missing inputs and agreed nutrition contexts remain distinct from zero',()=>{
  const incomplete=n.reconcileAutomaticTargets({...profile(),height:null,activity:'unknown'},day).profile;
  assert.equal(incomplete.target,125);
  assert.equal(incomplete.fibreTarget,30);
  assert.equal(incomplete.calorieTarget,null);
  assert.equal(incomplete.fatTarget,null);
  assert.equal(incomplete.carbTarget,null);
  for(const care of ['clinical','glp1']){
    const automatic=n.reconcileAutomaticTargets({...profile(),care},day).profile;
    assert.ok(n.automaticMetrics.every(metric=>automatic[n.targetFields[metric]]===null));
    const agreed=n.reconcileAutomaticTargets({...profile(),care,target:130,calorieTarget:2300,fibreTarget:25},day).profile;
    assert.equal(agreed.target,130);
    assert.equal(agreed.calorieTarget,2300);
    assert.equal(agreed.fibreTarget,25);
  }
});

test('missing target reasons identify separate activity inputs without inventing a target',()=>{
  const p=n.saveDraft({...profile(),activity:'unknown'},n.clean(),day),targets=n.effectiveTargets(p,day,day).targets;
  assert.equal(targets.protein.value,125);assert.equal(targets.fibre.value,30);
  assert.equal(targets.calories.value,null);assert.equal(targets.calories.reason,'Add activity');
  for(const metric of ['fat','carbs']){
    assert.equal(targets[metric].value,null);assert.equal(targets[metric].reason,'Add activity to estimate energy');
  }
  const next=n.saveDraft({...p,activity:'moderate'},p,'2026-10-06');
  const completed=n.effectiveTargets(next,'2026-10-06','2026-10-06').targets;
  assert.equal(completed.calories.value,2650);assert.equal(completed.calories.reason,null);
  assert.equal(completed.fat.value,88);assert.equal(completed.carbs.value,340);
  const historical=n.effectiveTargets(next,day,'2026-10-06').targets;
  assert.equal(historical.calories.value,null);assert.equal(historical.calories.reason,'Add activity','Historic explanation uses its own recorded inputs');
  assert.equal(historical.fat.reason,'Add activity to estimate energy');
  assert.equal(n.effectiveTargets(next,'2026-10-04','2026-10-06').targets.calories.reason,'Historical target not recorded');
});

test('missing reasons distinguish deliberate clears, zero, medical plans and unavailable history',()=>{
  const automatic=n.saveDraft(profile(),n.clean(),day);
  const manual=n.saveDraft({...automatic,target:null,fatTarget:0},automatic,day);
  const targets=n.effectiveTargets(manual,day,day).targets;
  assert.equal(targets.protein.reason,'Target left unset');assert.equal(targets.fat.reason,'No percentage for a zero target');
  assert.equal(targets.carbs.value,null);assert.equal(targets.carbs.reason,'Complete your protein and fat targets');
  for(const care of ['clinical','glp1']){
    const p=n.saveDraft({...profile(),care},n.clean(),day);
    assert.equal(n.effectiveTargets(p,day,day).targets.calories.reason,'Use your agreed nutrition plan');
  }
  const earlier={...automatic,targetHistory:[{effectiveFrom:day,targets:{calories:null},targetModes:{calories:'automatic'}}]};
  assert.equal(n.effectiveTargets(earlier,day,'2026-10-06').targets.calories.reason,'Target not set for this date','Do not infer historical missing-input reasons from current details');
});

test('missing-target help routes to the actual required input without changing saved data',()=>{
  const complete=n.saveDraft(profile(),n.clean(),day);
  assert.equal(n.targetSetup(complete,day,day),null);
  for(const field of ['activity','height','sex','weight','age']){
    const p=freeze(n.saveDraft({...profile(),[field]:['activity','sex'].includes(field)?'unknown':null},n.clean(),day)),before=JSON.stringify(p);
    const help=n.targetSetup(p,day,day);
    assert.equal(help.section,field==='activity'?'activity':'stats');
    assert.ok(help.missingFields.includes(field));
    assert.equal(JSON.stringify(p),before,'Help is a pure projection');
    if(field==='activity'){
      assert.equal(help.title,'Choose activity');
      assert.equal(help.detail,'To estimate energy, carbs and fat.');
      assert.deepEqual(help.missingMetrics,['calories','carbs','fat']);
    }
  }
  const both=n.saveDraft({...profile(),height:null,activity:'unknown'},n.clean(),day);
  assert.deepEqual(n.targetSetup(both,day,day).missingFields,['height','activity']);
  assert.equal(n.targetSetup(both,day,day).section,'stats');
  const heightAdded=n.saveDraft({...both,height:185},both,day);
  assert.equal(n.targetSetup(heightAdded,day,day).section,'activity','After details, only the remaining activity question is offered');
  assert.equal(n.targetSetup(n.clean(),day,day).section,'stats');
});

test('missing-target help preserves explicit clears, agreed plans, zero targets and past dates',()=>{
  const complete=n.saveDraft(profile(),n.clean(),day);
  const manual=n.saveDraft({...complete,calorieTarget:null},complete,day),before=JSON.stringify(manual);
  assert.equal(n.targetSetup(manual,day,day).section,'tracking');
  assert.equal(n.targetSetup(manual,day,day).title,'Review your targets');
  assert.equal(JSON.stringify(manual),before);
  const manualEnergy=n.saveDraft({...profile(),activity:'unknown',calorieTarget:2100},n.clean(),day);
  assert.equal(n.targetSetup(manualEnergy,day,day),null,'A supplied energy budget removes the need for activity');
  assert.equal(manualEnergy.fatTarget,70);assert.equal(manualEnergy.carbTarget,243);
  const zero=n.saveDraft({...complete,carbTarget:0,fatTarget:0},complete,day);
  assert.equal(n.targetSetup(zero,day,day),null,'An intentional zero is not an unset target');
  for(const care of ['clinical','glp1']){
    const p=n.saveDraft({...profile(),care},n.clean(),day);
    assert.equal(n.targetSetup(p,day,day).title,'Add agreed targets');
    assert.equal(n.targetSetup(p,day,day).section,'tracking');
    assert.ok(n.automaticMetrics.every(metric=>p[n.targetFields[metric]]===null));
  }
  assert.equal(n.targetSetup(manual,day,'2026-10-06'),null,'Do not offer a current-profile fix for historical targets');
});
