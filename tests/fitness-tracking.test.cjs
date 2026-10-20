const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const w={Date,console};w.window=w;vm.createContext(w);
for(const file of ['shared-controls','streaks','core/food-log','food-patterns','core/nutrition-profile','nudge-fit','today-goals'])vm.runInContext(fs.readFileSync('Web/'+file+'.js','utf8'),w);
w.NudgeIcons=()=>'';
const n=w.NudgeNutrition,t=w.NudgeToday,today='2026-10-04';
const original=n.saveDraft({...n.draft({}),target:100,calorieTarget:2000,carbTarget:200,fibreTarget:30,weeklyPlantTarget:20,dailyPlantTarget:null},{},'2026-09-01');
const profile=n.saveDraft({...original,target:120,calorieTarget:2400,carbTarget:250,weeklyPlantTarget:30},original,'2026-10-01');
const entry=(id,day,more={})=>({id,day,name:'Synthetic confirmed food',slot:'Lunch',portions:1,plants:[],ferments:[],...more});
const carbs=portion=>({carbohydrate:{portion,portionStatus:'calculated',per100:null,per100Status:'unknown',unit:'g'}});
const state={nutritionProfile:profile,history:[{name:'Scan only',calories:9000,protein:900}],foodLog:{entries:[
  entry('old','2026-09-21',{proteinPerPortion:50,plants:['rice']}),
  entry('monday','2026-09-28',{proteinPerPortion:100,energyPerPortion:500,plants:['oats']}),
  entry('zero','2026-09-29',{proteinPerPortion:0,energyPerPortion:0,nutritionSnapshot:carbs(0),fibrePerPortion:0,sourceMeta:{plantKnowledge:'known'}}),
  entry('unknown','2026-09-30'),
  entry('partial-known','2026-10-01',{proteinPerPortion:60,plants:['oat','almond']}),
  entry('partial-unknown','2026-10-01'),
  entry('today','2026-10-04',{proteinPerPortion:180,energyPerPortion:3000,nutritionSnapshot:carbs(250),fibrePerPortion:15,plants:['almonds','rice']}),
  entry('future','2026-10-05',{proteinPerPortion:999,energyPerPortion:9000,plants:['carrot']})
]}};
const before=JSON.stringify(state),m=t.model(state,'2026-09-29',today);
assert.equal(m.protein.target,100,'Selected date keeps its historical target');
assert.equal(m.weekProtein.value,340,'Looking back within the week includes later recorded days up to actual today');
assert.equal(m.weekProtein.days[6].value,180);assert.equal(m.weekProtein.days[6].target,120);
assert.equal(m.weekTarget,30,'Weekly comparison uses the dated target at the visible week end');
assert.equal(m.weekPlants,3,'Canonical plants count once across the whole selected week');
assert.equal(t.model(state,'2026-09-23',today).weekTarget,20,'Previous weeks retain their earlier plant target');
assert.equal(t.model(state,today,today).weekProtein.value,340,'A future entry cannot contribute to this week');
const selected=t.ringItems(m);
assert.equal(selected[0].value,0);assert.equal(t.progress(selected[0]),0,'Recorded zero is 0%');
const selectedPlants=selected.find(item=>item.key==='plants');
assert.equal(selectedPlants.period,'day');assert.equal(selectedPlants.value,null,'This legacy plant hint is not confirmed evidence; the daily ring must not borrow earlier days’ known plants');
assert.equal(selectedPlants.target,3,'Plants without a daily goal use the pacing guide from that day’s dated weekly goal');assert.equal(selectedPlants.targetRole,'guide');
assert.equal(t.progress(t.ringItems(m,'2026-10-02')[0]),null,'Unlogged is not 0%');
assert.equal(t.status(t.ringItems(m,'2026-09-30')[0]),'unknown');
assert.equal(t.status(t.ringItems(m,'2026-10-01')[0]),'partial');
assert.equal(t.progress(t.ringItems(m,today)[0]),150,'Over target percentages stay uncapped');
assert.equal(t.progress(t.ringItems(m,today)[1]),125);
assert.equal(t.progress({recorded:true,value:10,target:0}),null,'A zero target never divides by zero');
assert.equal(t.progress({recorded:true,value:10,target:20,targetKnown:false}),null,'Historical missing targets do not become comparisons');
const future=t.model(state,'2026-10-05',today);
assert.equal(future.protein.recorded,false);assert.equal(t.progress(future.protein),null);
assert.equal(future.weekProtein.value,null,'Future entries remain excluded even when their week is inspected');
const legacy=t.model({nutritionProfile:{saved:true,age:55,sex:'male',height:185,weight:80,care:'none',activity:'moderate',goal:'muscle'},foodLog:{entries:[]}},'2026-09-01',today);
assert.equal(legacy.protein.target,null,'No current legacy target is invented for a historical date');
assert.equal(legacy.weekTarget,null,'No current legacy weekly plant target is invented for a historical week');
const october=t.calendarDays('2026-10');assert.equal(october.length,35);assert.equal(october[0].day,'2026-09-28');assert.equal(october.filter(d=>d.inMonth).length,31);
assert.equal(t.calendarDays('2024-02').filter(d=>d.inMonth).length,29);assert.equal(t.calendarDays('2026-99').length,0);
assert.equal(t.calendarDays('2026-10')[27].day,'2026-10-25','Local day keys remain stable across daylight-saving change');
const html=t.screen(state,today,String,{today,calendarOpen:true,calendarMonth:'2026-10'});
assert.match(html,/n-fitness-summary/);assert.ok(html.indexOf('class="n-fitness-calendar"')<html.indexOf('class="n-fitness-summary"'),'Open calendar is near its toggle, before the main rings');
assert.doesNotMatch(t.screen(state,'2026-09-29',String,{today}),/Back to today|data-action="tracking-today"/);assert.match(html,/n-fitness-calendar-grid/);assert.match(html,/data-action="tracking-day" data-value="2026-10-04"[^>]*aria-current="date"/);
assert.match(html,/data-action="tracking-day" data-value="2026-10-05"[^>]* disabled/);
assert.match(html,/data-progress-state="unknown" data-progress-percent="" data-progress-value=""/);
assert.match(html,/data-progress-state="recorded" data-progress-percent="0" data-progress-value="0"/);
assert.match(html,/data-progress-percent="150"/);assert.match(html,/125%/);assert.match(html,/600 kcal over target/);
assert.doesNotMatch(html,/(?:NaN|Infinity)%/);assert.doesNotMatch(html,/Plants · week/);assert.match(html,/3 of 30 different plants this week/,'The weekly panel retains its distinct cumulative comparison');
assert.equal((html.match(/class="n-week n-week-graphic/g)||[]).length,6);
assert.equal(JSON.stringify(state),before,'Rendering dates, rings and calendar must not write to intake, history or targets');
// A profile with current targets but no dated history must agree across Today,
// week miniatures and calendar. Its current target is never backfilled.
const noHistoryProfile={...original,targetHistory:[]};
const legacyState={nutritionProfile:noHistoryProfile,foodLog:{entries:[entry('legacy-past','2026-10-01',{proteinPerPortion:40,plants:['rice']}),entry('legacy-today',today,{proteinPerPortion:99.6,plants:['oats']})]}};
const legacyToday=t.model(legacyState,today,today),legacyPast=t.model(legacyState,'2026-10-01',today);
assert.equal(legacyToday.protein.target,100);assert.equal(legacyToday.weekProtein.days[6].target,100);
assert.equal(legacyPast.weekProtein.days[6].target,100);assert.equal(legacyPast.protein.target,null);
assert.equal(legacyToday.weekProtein.days[3].target,null);assert.equal(legacyToday.weekProtein.comparison.days,1);
assert.equal(t.ringItems(legacyToday).find(item=>item.key==='plants').target,3);assert.equal(t.ringItems(legacyPast,today).find(item=>item.key==='plants').target,3);
assert.equal(t.ringItems(legacyPast,'2026-10-01').find(item=>item.key==='plants').target,null);
assert.equal(t.progress(legacyToday.protein),99,'99.6% must not display completed 100%');
assert.equal(t.status(legacyToday.protein),'recorded');assert.equal(t.progressRatio(legacyToday.protein),.996);
const legacyHTML=t.screen(legacyState,today,String,{today,calendarOpen:true,calendarMonth:'2026-10'});
const todayCell=legacyHTML.match(/class="n-fitness-calendar-day[^"]*" data-action="tracking-day" data-value="2026-10-04"[^>]*>([\s\S]*?)<\/button>/)[1];
assert.match(todayCell,/data-metric="protein" data-progress-state="recorded" data-progress-percent="99"/);
assert.match(todayCell,/data-metric="plants" data-progress-state="recorded" data-progress-percent="33"/,'The calendar compares one daily plant with the three-type pacing guide');
const summary=legacyHTML.split('<div class="n-fitness-summary">')[1];
const arc=summary.match(/class="n-fitness-ring-fill"[^>]*stroke-dasharray="([\d.]+) ([\d.]+)"/);
assert.ok(Math.abs(Number(arc[1])/Number(arc[2])-.996)<1e-10,'SVG geometry uses exact ratio rather than integer label');
legacyState.foodLog.entries[1].proteinPerPortion=.04;
const tiny=t.model(legacyState,today,today).protein;
assert.equal(tiny.value,0);assert.equal(tiny.rawValue,.04);assert.equal(t.progress(tiny),0);assert.equal(t.progressRatio(tiny),.0004);
const tinyHTML=t.screen(legacyState,today,String,{today}).split('<div class="n-fitness-summary">')[1];
const tinyArc=tinyHTML.match(/class="n-fitness-ring-fill"[^>]*stroke-dasharray="([\d.]+) ([\d.]+)"/);
assert.ok(Number(tinyArc[1])>0&&Number(tinyArc[1])<1,'Positive fractional intake retains its small arc');
assert.match(tinyHTML,/data-progress-value="0.04"/,'A rounded displayed zero is not stored as recorded zero in the ring');
assert.doesNotMatch(fs.readFileSync('Web/today-goals.js','utf8'),/icon\('(?:chevron-left|chevron-right|calendar)'\)/,'Navigation must not use unsupported fallback icons');
console.log('PASS: fitness rings use confirmed totals, dated targets, actual-today cutoffs, missing/partial/zero/over-target states, daily plant pacing, unique weekly plants and read-only Monday calendars across DST.');
