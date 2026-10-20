// Real schema + injected persistence, without a browser, storage or network.
const assert=require('node:assert/strict');
const {create}=require('../Web/core/diary.js');
const foodLog=require('../Web/core/food-log.js').create({
  dayNumber:day=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day))?Date.parse(day)/86400000:null,
  recipeKnown:id=>id==='fixture-recipe'
});
const copy=value=>JSON.parse(JSON.stringify(value));
const cleanEntry=raw=>foodLog.clean({entries:[raw]}).entries[0];
const meal=(id,extra={})=>({id,name:'Fish pie and peas',day:'2026-10-05',slot:'Dinner',portions:2,plants:['potatoes','peas'],ferments:[],energyPerPortion:205,proteinPerPortion:19,fibrePerPortion:null,portionAmount:320,portionUnit:'g',recipe:'fixture-recipe',
  nutritionSnapshot:{energyKcal:{per100:null,portion:205,unit:'kcal',per100Status:'unknown',portionStatus:'calculated'},carbohydrate:{per100:null,portion:null,unit:'g',per100Status:'unknown',portionStatus:'partial',knownPortionSubtotal:31.5,knownContributions:2,unknownContributions:1}},
  sourceMeta:{confirmationId:id,scanEventId:'scan-'+id,mealComposition:[{id:'recipe',role:'recipe',portion:{amount:1200,unit:'g'}},{id:'side',role:'side',portion:{amount:80,unit:'g'}}],mealRecipeCalculation:{selection:{mode:'whole_dish',fraction:.25},servings:4},mealPortionSelection:{kind:'fraction',fraction:.25,recipeOnly:true},mealBatchVolumeMl:1000},...extra});
function setup(entries=[]){
  let state={foodLog:foodLog.clean({entries,savedRecipes:['fixture-recipe'],plantGoal:20}),other:{retain:true}},writes=0,saved=null,mode='ok';
  const repository=create({getState:()=>state,cleanEntry,save:()=>{writes++;if(mode==='throw')throw Error('Disk unavailable');if(mode==='false')return false;if(mode==='async')return Promise.resolve(true);saved=copy(state);return true;}});
  return {repository,get state(){return state},replace:next=>state=next,writes:()=>writes,saved:()=>saved,mode:next=>mode=next};
}
assert.equal(global.NudgeDiary,undefined);assert.equal(global.WmdFoodLog,undefined);
assert.throws(()=>create({getState:()=>({})}),/adapters/);
assert.deepEqual(foodLog.names(['potatoes','potato','CHICKPEAS','chickpea']),['potato','chickpea']);
const original=meal('first'),app=setup();
assert.equal(app.repository.add(original).status,'saved');
const first=app.state.foodLog.entries[0],exact=copy(first);
original.sourceMeta.mealPortionSelection.fraction=.5;original.plants.push('carrot');
assert.deepEqual(first,exact,'Saving takes a detached cleaned snapshot');
assert.equal(first.nutritionSnapshot.carbohydrate.portion,null);
assert.equal(first.nutritionSnapshot.carbohydrate.knownPortionSubtotal,31.5);
assert.equal(first.sourceMeta.mealRecipeCalculation.selection.fraction,.25);
assert.equal(first.sourceMeta.mealComposition[1].portion.amount,80);
assert.equal(first.portions,2);
assert.deepEqual(app.state.foodLog.savedRecipes,['fixture-recipe']);assert.equal(app.state.foodLog.plantGoal,20);
assert.deepEqual(app.saved().other,{retain:true});
const writes=app.writes();
assert.equal(app.repository.add(meal('first')).status,'duplicate');
assert.equal(app.repository.add(meal('other',{sourceMeta:{confirmationId:'first'}})).status,'duplicate');
assert.equal(app.writes(),writes,'Repeated confirmations never write or add another meal');
assert.equal(app.repository.add(meal('another-occasion')).ok,true,'Same food on another occasion remains a distinct intake');
assert.equal(app.repository.update('first',{...exact,portions:3}).ok,true);
assert.deepEqual(app.state.foodLog.entries.map(e=>e.id),['first','another-occasion']);
assert.deepEqual(app.state.foodLog.entries[0].sourceMeta,exact.sourceMeta,'A portion update preserves recipe fraction, whole side and evidence');
assert.equal(app.repository.update('first',{...exact,id:'renamed'}).status,'invalid');
assert.equal(app.repository.update('missing',meal('missing')).status,'missing','A stale edit cannot resurrect deleted intake');
assert.equal(app.repository.update('first',{...exact,sourceMeta:{confirmationId:'another-occasion'}}).status,'duplicate');
let before=app.writes();assert.equal(app.repository.update('first',app.state.foodLog.entries[0]).status,'unchanged');assert.equal(app.writes(),before);
for(const mode of ['false','throw','async']){
  app.mode(mode);
  for(const change of [()=>app.repository.add(meal('retry')),()=>app.repository.update('first',{...exact,name:'Changed'}),()=>app.repository.remove('first')]){
    const previous=app.state.foodLog.entries,bytes=JSON.stringify(app.state);
    assert.equal(change().status,'save_failed');assert.equal(app.state.foodLog.entries,previous,'Failure restores the exact entries array');assert.equal(JSON.stringify(app.state),bytes);
  }
}
app.mode('ok');assert.equal(app.repository.add(meal('retry')).ok,true);assert.equal(app.repository.add(meal('retry')).status,'duplicate');
const deleted=copy(app.state.foodLog.entries[0]);assert.equal(app.repository.remove('first').ok,true);
before=app.writes();assert.equal(app.repository.remove('first').status,'unchanged');assert.equal(app.writes(),before,'Crash replay of an applied deletion is a no-op');
assert.equal(app.repository.restore(deleted).ok,true);assert.deepEqual(app.state.foodLog.entries.at(-1),deleted);
before=app.writes();assert.equal(app.repository.restore(deleted).status,'unchanged');assert.equal(app.writes(),before,'Crash replay of an applied undo is a no-op');
assert.equal(app.repository.restore({...deleted,name:'Older edit'}).status,'conflict');
assert.equal(app.repository.restore({...deleted,id:'different'}).status,'duplicate','Undo cannot duplicate a confirmation');
assert.equal(app.repository.add(meal('bad',{day:'not-a-day'})).status,'invalid');
const replacement={foodLog:foodLog.initial()};app.replace(replacement);assert.equal(app.repository.add(meal('new-store')).ok,true);assert.equal(replacement.foodLog.entries.length,1,'Commands resolve the current store at execution');

// The persistence adapter cannot recursively mutate the same repository.
let nested,repo;const state={foodLog:foodLog.initial()};repo=create({getState:()=>state,cleanEntry,save:()=>{nested=repo.add(meal('nested'));return true;}});
assert.equal(repo.add(meal('outer')).ok,true);assert.equal(nested.status,'busy');assert.deepEqual(state.foodLog.entries.map(e=>e.id),['outer']);
console.log('PASS: DOM-free diary schema/commands; exact evidence, fractions and nulls; duplicate guards; stable edits; durable rollback; replayable deletion and conflict-safe undo.');
