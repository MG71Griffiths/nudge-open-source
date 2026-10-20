const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const w={Date,console};w.window=w;vm.createContext(w);
for(const file of ['streaks.js','core/food-log.js','core/nutrition-profile.js','core/nudge-score.js','core/food-composition.js','today-goals.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),w,{filename:file});
const clone=x=>JSON.parse(JSON.stringify(x)),day='2026-10-15',N=w.NudgeNutrition,T=w.NudgeToday;
const profile={saved:true,schemaVersion:2,weeklyPlantTarget:30,dailyPlantTarget:null,targetHistory:[{effectiveFrom:'2026-10-12',targets:{plants:30,dailyPlants:null}}]};
const nutrient=value=>({unit:'g',portion:value,portionStatus:value===null?'unknown':'calculated'});
const entry=(id,date,plants=['oats','blueberries'],more={})=>({id,name:'Synthetic meal',day:date,slot:'Breakfast',portions:1,plants,ferments:[],nutritionSnapshot:{sugars:nutrient(18),saturatedFat:nutrient(5)},sourceMeta:{plantKnowledge:'known'},...more});
const metric=(m,key)=>m.compactMetrics.find(x=>x.key===key);

test('daily rings fill known intake against labelled adult references and a saved weekly pacing guide',()=>{
 const state={nutritionProfile:clone(profile),foodLog:{entries:[entry('earlier','2026-10-14',['almonds','oats']),entry('today',day),entry('repeated',day,['oat','blueberry'])]}};
 const before=JSON.stringify(state),m=T.projection(state,day);
 assert.equal(metric(m,'plants').value,2);assert.equal(metric(m,'plants').target,5);assert.equal(metric(m,'plants').percent,40);
 assert.equal(metric(m,'plants').targetRole,'guide');assert.equal(metric(m,'plants').guideWeeklyTarget,30);
 assert.match(metric(m,'plants').referenceNote,/daily counts are not added together/);assert.equal(m.weekPlants,3);
 assert.equal(metric(m,'sugars').rawValue,36);assert.equal(metric(m,'sugars').target,90);assert.equal(metric(m,'sugars').percent,40);
 assert.equal(metric(m,'saturatedFat').rawValue,10);assert.equal(metric(m,'saturatedFat').target,20);assert.equal(metric(m,'saturatedFat').percent,50);
 for(const key of ['sugars','saturatedFat']){assert.equal(metric(m,key).targetRole,'reference');assert.equal(metric(m,key).referenceKind,'adult_label');assert.match(metric(m,key).referenceNote,/not a goal to reach/);}
 assert.equal(metric(m,'sugars').title,'Total sugars');assert.match(metric(m,'sugars').referenceNote,/not the 30 g free-sugars limit/);
 assert.equal(m.weekPlantProgress.days[2].target,5);assert.equal(m.weekPlantProgress.days[3].target,5);
 assert.equal(T.progressRatio(m.plants),.4);assert.equal(JSON.stringify(state),before,'Pure projection must not create targets or change saved food');
});

test('explicit daily targets win, pacing follows dated weekly goals, and absent historical goals stay absent',()=>{
 const p={...clone(profile),weeklyPlantTarget:30,dailyPlantTarget:9,targetHistory:[{effectiveFrom:'2026-10-12',targets:{plants:10,dailyPlants:null}},{effectiveFrom:day,targets:{plants:30,dailyPlants:9}}]};
 assert.equal(N.effectiveTargets(p,day,day).targets.dailyPlants.value,9);
 assert.equal(N.effectiveTargets(p,day,day).targets.dailyPlants.targetRole,'goal');
 assert.equal(N.effectiveTargets(p,'2026-10-14',day).targets.dailyPlants.value,2);
 assert.equal(N.effectiveTargets(p,'2026-10-14',day).targets.dailyPlants.targetRole,'guide');
 assert.equal(N.effectiveTargets(p,'2026-10-11',day).targets.dailyPlants.value,null);
 assert.equal(N.effectiveTargets({},day,day).targets.dailyPlants.value,null,'No invented weekly or daily plant goal');
 for(const [weekly,guide] of [[10,2],[20,3],[30,5]])assert.equal(N.effectiveTargets({saved:true,schemaVersion:2,weeklyPlantTarget:weekly},day,day).targets.dailyPlants.value,guide);
});

test('saved sugar and saturated-fat references remain dated and authoritative',()=>{
 const p={...clone(profile),sugarsTarget:60,saturatedFatTarget:15,targetHistory:[{effectiveFrom:'2026-10-12',targets:{plants:30,sugars:50,saturatedFat:12}},{effectiveFrom:day,targets:{plants:30,sugars:60,saturatedFat:15}}]};
 const before=JSON.stringify(p),old=N.effectiveTargets(p,'2026-10-13',day),current=N.effectiveTargets(p,day,day),unrecorded=N.effectiveTargets(p,'2026-10-11',day);
 assert.equal(old.targets.sugars.value,50);assert.equal(old.targets.saturatedFat.value,12);
 assert.equal(current.targets.sugars.value,60);assert.equal(current.targets.saturatedFat.value,15);assert.equal(current.targets.sugars.referenceKind,'saved_reference');
 assert.equal(unrecorded.targets.sugars.value,90);assert.equal(unrecorded.targets.sugars.referenceKind,'adult_label');
 assert.equal(unrecorded.targets.protein.value,null,'A population reference does not backfill any personal target');
 const state={nutritionProfile:p,foodLog:{entries:[entry('old','2026-10-13'),entry('new',day)]}},m=T.projection(state,day);
 assert.deepEqual(clone(m.weekSugars.comparison),{intake:36,target:110,days:2});assert.deepEqual(clone(m.weekSaturatedFat.comparison),{intake:10,target:27,days:2});
 assert.equal(JSON.stringify(p),before);
 assert.equal(N.effectiveTargets({...p,targetHistory:[]},day,day).targets.sugars.value,60);
 assert.equal(N.effectiveTargets({...p,targetHistory:[]},'2026-10-14',day).targets.sugars.value,90,'Current custom values never backfill an unrecorded day');
 assert.equal(N.effectiveTargets({...p,targetHistory:profile.targetHistory},day,day).targets.sugars.value,60,'Legacy target rows without this field do not erase a saved current reference');
});

test('missing, recorded zero, partial and future values retain their distinct ring states',()=>{
 const state=rows=>({nutritionProfile:clone(profile),foodLog:{entries:rows}});
 const missing=entry('missing',day,[],{nutritionSnapshot:{},sourceMeta:{}}),zero=entry('zero',day,[],{nutritionSnapshot:{sugars:nutrient(0),saturatedFat:nutrient(0)},sourceMeta:{plantSelectionConfirmed:true}});
 for(const key of ['sugars','saturatedFat','plants']){
  assert.equal(metric(T.projection(state([]),day),key).percent,null);
  assert.equal(metric(T.projection(state([missing]),day),key).percent,null);
  assert.equal(metric(T.projection(state([zero]),day),key).percent,0);
  assert.equal(metric(T.projection(state([entry('future','2026-10-16')]),'2026-10-16',day),key).percent,null);
 }
 const partial=entry('partial',day,[],{nutritionSnapshot:{sugars:{unit:'g',portion:null,portionStatus:'partial',knownPortionSubtotal:45,knownContributions:1,unknownContributions:1},saturatedFat:nutrient(25)}});
 const m=T.projection(state([partial]),day),sugar=metric(m,'sugars'),sat=metric(m,'saturatedFat');
 assert.equal(sugar.percent,50);assert.equal(sugar.unknown,1);assert.equal(T.status(sugar),'partial');
 assert.equal(sat.percent,125);assert.equal(sat.ratio,1);assert.equal(T.status(sat),'above_reference');
 assert.equal(T.status({...sat,rawValue:20,value:20}),'at_reference');
 assert.equal(T.status({...sat,unknown:1}),'above_reference','A known subtotal already above reference cannot look like an achievement');
});
