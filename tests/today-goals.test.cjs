const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const sandbox={window:{},Date};sandbox.window=sandbox;
vm.createContext(sandbox);
for(const file of ['shared-controls.js','streaks.js','core/diary.js','core/food-log.js','food-patterns.js','core/nutrition-profile.js','nudge-fit.js','today-goals.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),sandbox,{filename:file});
const empty=()=>({foodLog:sandbox.WmdFoodLog.initial(),nutritionProfile:sandbox.NudgeNutrition.clean()});
const day='2026-10-01',model=sandbox.NudgeToday.model;
const entry=(id,more={})=>({id,name:'Test meal',day,portions:1,plants:[],energyPerPortion:null,proteinPerPortion:null,fibrePerPortion:null,...more});
let state=empty(),m=model(state,day);
assert.equal(m.protein.value,0);assert.equal(m.energy.value,0);assert.equal(m.fibre.value,0);assert.equal(m.plants.value,0);
assert.equal(m.protein.target,null);assert.equal(m.energy.target,null);assert.equal(m.fibre.target,null);assert.equal(m.plants.target,null);
assert.equal(m.weekTarget,null);assert.equal(m.days[0].day,'2026-09-28');assert.equal(m.days[6].day,'2026-10-04');
state.foodLog.entries=[entry('unknown')];m=model(state,day);assert.equal(m.protein.value,null);assert.equal(m.energy.value,null);assert.equal(m.fibre.value,null);assert.equal(m.protein.unknown,1);
state.foodLog.entries.push(entry('known',{proteinPerPortion:26.3,energyPerPortion:620,fibrePerPortion:0,portions:.3,plants:['peanuts','peanut','oat']}));
m=model(state,day);assert.equal(m.protein.value,7.9);assert.equal(m.energy.value,186);assert.equal(m.fibre.value,0);assert.equal(m.protein.unknown,1);assert.equal(m.plants.value,2);
state.foodLog.entries.push(entry('repeat',{plants:['peanut','Oats']}),entry('monday',{day:'2026-09-28',plants:['almond','peanuts']}),entry('previous',{day:'2026-09-27',plants:['orange']}),entry('future',{day:'2026-10-02',plants:['carrot']}));
m=model(state,day);assert.equal(m.plants.value,2);assert.equal(m.weekPlants,3);assert.equal(m.days.filter(d=>d.recorded).length,2);
state.foodLog.entries[1].plants=['rice'];state.foodLog.entries[1].portions=2;m=model(state,day);assert.equal(m.protein.value,52.6);assert.equal(m.energy.value,1240);assert.equal(m.weekPlants,4);
state.foodLog.entries=state.foodLog.entries.filter(e=>e.id!=='known');m=model(state,day);assert.equal(m.protein.value,null);assert.equal(m.weekPlants,3);
// Loading/reading and repeated canonical model derivation do not mutate persistent records.
const before=JSON.stringify(state);model(state,day);assert.equal(JSON.stringify(state),before);
state.nutritionProfile=sandbox.NudgeNutrition.clean({saved:true,age:55,weight:78,height:186,sex:'male',care:'none',activity:'moderate',goal:'muscle',dailyPlantTarget:7,fibreTarget:27.5});
m=model(state,day);assert.equal(m.protein.target,125);assert.equal(m.energy.target,2700);assert.equal(m.plants.target,7);assert.equal(m.fibre.target,27.5);
const reloaded=JSON.parse(JSON.stringify(state));assert.equal(model(reloaded,day).fibre.target,27.5);
for(const invalid of [-1,0,Infinity,'8',45])assert.equal(sandbox.NudgeNutrition.clean({dailyPlantTarget:invalid}).dailyPlantTarget,null);
assert.equal(sandbox.NudgeNutrition.clean({dailyPlantTarget:1.5}).dailyPlantTarget,null);
assert.equal(sandbox.NudgeNutrition.clean({fibreTarget:101}).fibreTarget,null);
// Duplicate confirmation IDs cannot increase daily totals.
state.foodLog.entries=[entry('first',{sourceMeta:{confirmationId:'same'},proteinPerPortion:10}),entry('second',{sourceMeta:{confirmationId:'same'},proteinPerPortion:10})];assert.equal(model(state,day).protein.value,10);
// Week boundary uses local calendar keys, independent of UTC offset and DST.
assert.equal(model(empty(),'2026-10-26').days[0].day,'2026-10-26');assert.equal(model(empty(),'2026-10-25').days[0].day,'2026-10-19');
// Energy is rounded once for presentation; nutrient records and fractional sums stay intact.
sandbox.NudgeIcons=()=>'';const precision=empty();precision.foodLog.entries=[entry('exact',{energyPerPortion:185.7,proteinPerPortion:7.92,fibrePerPortion:2.73})];const rawBefore=JSON.stringify(precision);let html=sandbox.NudgeToday.screen(precision,day,String);assert.match(html,/186<small>kcal/);assert.match(html,/7.9<small>g/);assert.match(html,/2.7<small>g/);assert.equal(JSON.stringify(precision),rawBefore);precision.foodLog.entries[0].energyPerPortion=.49;html=sandbox.NudgeToday.screen(precision,day,String);assert.match(html,/0<small>kcal/,'Do not round 0.49 to 0.5 then to 1 kcal');
console.log('PASS: Today empty/unknown/partial/zero totals, exact portion math, daily and weekly canonical plants, edits/deletion, Monday boundary/DST, actual saved targets, duplicate confirmations and no read-time writes.');
