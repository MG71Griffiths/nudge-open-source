const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const w={Date,console};w.window=w;vm.createContext(w);
for(const file of ['shared-controls','streaks','core/food-log','food-patterns','core/nutrition-profile','nudge-fit','today-goals'])vm.runInContext(fs.readFileSync('Web/'+file+'.js','utf8'),w);
w.NudgeIcons=()=>'';
const n=w.NudgeNutrition,t=w.NudgeToday,today='2026-10-04';
const previous=n.saveDraft({...n.draft({}),target:120,calorieTarget:2400,carbTarget:300,fibreTarget:30,fatTarget:60,weeklyPlantTarget:30},{},'2026-09-01');
const profile=n.saveDraft({...previous,fatTarget:80},previous,'2026-10-01');
const fat=(portion,portionStatus='calculated')=>({fat:{portion,portionStatus,per100:null,per100Status:'unknown',unit:'g'}});
const entry=(id,day,more={})=>({id,day,name:'Synthetic confirmed food',slot:'Lunch',portions:1,plants:[],ferments:[],...more});
const state={nutritionProfile:profile,history:[{name:'Scanned only',nutritionSnapshot:fat(999)}],foodLog:{entries:[
  entry('old','2026-09-28',{nutritionSnapshot:fat(10),portions:2}),
  entry('zero','2026-09-29',{nutritionSnapshot:fat(0)}),
  entry('unknown','2026-09-30',{nutritionSnapshot:fat(18,'unknown')}),
  entry('fraction','2026-10-01',{nutritionSnapshot:fat(4),portions:1.5}),
  entry('missing','2026-10-01',{energyPerPortion:900,proteinPerPortion:0}),
  entry('today',today,{nutritionSnapshot:fat(20),portions:2}),
  entry('future','2026-10-05',{nutritionSnapshot:fat(999)})
]}};
const before=JSON.stringify(state),m=t.model(state,today,today);
assert.equal(m.fat.value,40);assert.equal(m.fat.rawValue,40);assert.equal(m.fat.target,80);assert.equal(t.progress(m.fat),50);
assert.equal(m.weekFat.value,66);assert.deepEqual(JSON.parse(JSON.stringify(m.weekFat.comparison)),{intake:66,target:280,days:4});
assert.equal(m.weekFat.days[0].target,60);assert.equal(m.weekFat.days[3].target,80);
assert.equal(m.weekFat.days[1].value,0);assert.equal(t.progress(m.weekFat.days[1]),0);
assert.equal(m.weekFat.days[2].value,null);assert.equal(t.status(m.weekFat.days[2]),'unknown');
assert.equal(m.weekFat.days[3].value,6);assert.equal(m.weekFat.days[3].unknown,1);assert.equal(t.status(m.weekFat.days[3]),'partial');
assert.equal(m.weekFat.days[4].recorded,false);assert.equal(t.progress(m.weekFat.days[4]),null);
assert.equal(t.model(state,'2026-10-05',today).weekFat.value,null);
assert.equal(t.nutrientValue({energyPerPortion:900,nutritionSnapshot:{saturatedFat:{portion:10,portionStatus:'calculated'}}},'fat'),null,'Never infer total fat from energy or saturated fat');
assert.equal(t.nutrientValue({nutritionSnapshot:fat(0,'unknown')},'fat'),null,'Unverified zero remains unknown');
const html=t.screen(state,today,String,{today,calendarOpen:true});
assert.match(html,/aria-label="Fat: 40 g, target 80 g"/);assert.match(html,/aria-label="Weekly fat progress"/);
assert.match(html,/data-metric="fat" data-progress-state="recorded" data-progress-percent="50" data-progress-value="40"/);
assert.match(html,/Custom targets/);assert.match(html,/Review targets/);
const summary=html.split('<div class="n-fitness-summary">')[1].split('</svg>')[0];
assert.equal((summary.match(/data-metric=/g)||[]).length,6);
const radii=Array.from(summary.matchAll(/class="n-fitness-ring-track"[^>]+ r="([\d.]+)"/g),m=>Number(m[1]));
assert.equal(radii.length,6);assert.ok(radii.every(r=>r>=26),'Six concentric rings must retain an open centre');
for(let i=1;i<radii.length;i++)assert.ok(radii[i-1]-radii[i]>18,'All rings have distinct tracks without overlap');
assert.equal(JSON.stringify(state),before,'Read-only fat projection preserves intake, scans and historic target records');
const duplicate={nutritionProfile:profile,foodLog:{entries:[entry('one',today,{nutritionSnapshot:fat(10),sourceMeta:{confirmationId:'same'}}),entry('two',today,{nutritionSnapshot:fat(10),sourceMeta:{confirmationId:'same'}})]}};
assert.equal(t.model(duplicate,today).fat.value,10,'Repeated confirmation cannot double fat intake');
duplicate.foodLog.entries=[];
assert.equal(t.model(duplicate,today).fat.recorded,false);assert.equal(t.model(duplicate,today).weekFat.value,null);
const noHistory={nutritionProfile:{...profile,targetHistory:[]},foodLog:state.foodLog};
assert.equal(t.model(noHistory,today,today).fat.target,80);
assert.equal(t.model(noHistory,'2026-09-28',today).fat.target,null,'Current fat targets cannot backfill historical days');
assert.equal(t.model(noHistory,today,today).weekFat.comparison.target,80);
const onlyFat={nutritionProfile:{...profile,tracking:['fat']},foodLog:state.foodLog};
assert.equal(t.ringItems(t.model(onlyFat,today)).length,1);
assert.equal((t.screen(onlyFat,today,String).match(/class="n-week n-week-graphic/g)||[]).length,1);
// Contradictory custom macros are explained on Today without changing saved targets.
const conflict={...state,nutritionProfile:{...profile,target:201,carbTarget:652,fatTarget:null,calorieTarget:2771,targetModes:{...profile.targetModes,protein:'manual',calories:'manual',carbs:'manual',fat:'manual'}}};
const conflictBefore=JSON.stringify(conflict),conflictHtml=t.screen(conflict,today,String,{today});
assert.match(conflictHtml,/class="notice small n-target-budget-warning" role="status"/);
assert.match(conflictHtml,/known macro targets total at least 3,412 kcal against 2,771 kcal/);
assert.doesNotMatch(t.screen(conflict,'2026-09-29',String,{today}),/n-target-budget-warning|Targets don’t match/,'Current profile warnings do not rewrite the meaning of historic days');
assert.equal(JSON.stringify(conflict),conflictBefore);
assert.doesNotMatch(t.screen({...conflict,nutritionProfile:{...conflict.nutritionProfile,saved:false}},today,String,{today}),/n-target-budget-warning/,'Unsaved drafts do not become current-day target warnings');
const balanced={...conflict,nutritionProfile:{...conflict.nutritionProfile,target:120,carbTarget:300,fatTarget:80,calorieTarget:2400}};
assert.doesNotMatch(t.screen(balanced,today,String,{today}),/n-target-budget-warning/);
const incomplete={...conflict,nutritionProfile:{...conflict.nutritionProfile,carbTarget:null}};
assert.doesNotMatch(t.screen(incomplete,today,String,{today}),/n-target-budget-warning/,'Incomplete targets alone cannot establish a budget mismatch');
console.log('PASS: fat uses confirmed portion snapshots, dated targets, zero/unknown/partial distinctions, repeat-confirmation deduplication, no inference/backfill, six spaced rings and target provenance.');
