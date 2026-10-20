// Confirmed-intake projection: no network, owner storage, aggregate cache or photo data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const clone=x=>JSON.parse(JSON.stringify(x));
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function boot(input=[],storage=new Map(),today='2026-10-04'){
  let writes=0,historyWrites=0,saveOK=true,dialog=null,destination=null,productOpened=null,mealOpened=null;
  const sandbox={console,Date,Math,document:{getElementById:()=>null},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>{historyWrites++;storage.set(k,v)},removeItem:k=>storage.delete(k)}};
  sandbox.window=sandbox;sandbox.NudgeIcons=()=>'';sandbox.NudgeResults={finding:()=>'',productImage:(p,t)=>({src:p?.imageURL||t||'',fallback:p?.imageURL&&t||''})};
  vm.createContext(sandbox);
  for(const file of ['streaks.js','core/diary.js','core/food-log.js','food-patterns.js','core/nutrition-profile.js','nudge-fit.js','core/food-composition.js','core/recipe-composition.js','today-goals.js','core/nudge-score.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','diet.js','scan-history.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),sandbox,{filename:file});
  const data={foodLog:sandbox.WmdFoodLog.clean({entries:input})},view={};
  sandbox.NudgeBarcode={openStored:(event,options)=>productOpened={event,options}};
  sandbox.NudgeLabel={openStored:event=>mealOpened=event};
  const history=sandbox.createNudgeHistory({getState:()=>data,view,escapeHtml:esc,todayKey:()=>today,render(){},navigate:value=>destination=value,showToast(){},showDialog:(title,html)=>dialog={title,html},save(){writes++;return saveOK;}});
  return {data,view,history,model:sandbox.NudgeDiet,sandbox,storage,writes:()=>writes,historyWrites:()=>historyWrites,canSave:value=>saveOK=value,dialog:()=>dialog,destination:()=>destination,productOpened:()=>productOpened,mealOpened:()=>mealOpened};
}
const score=(value,extra={})=>({available:true,value,status:'estimated',methodVersion:'nudge_meal_v0_3',...extra});
const nutrient=(value,status='calculated')=>({per100:null,per100Status:'unknown',portion:value,portionStatus:status,unit:'g'});
const entry=(id,extra={})=>({id,name:'Vegetable bowl',day:'2026-10-04',slot:'Lunch',portions:1,plants:['tomato'],ferments:[],energyPerPortion:100,proteinPerPortion:5,fibrePerPortion:2,portionAmount:150,portionUnit:'g',sourceMeta:{mealComposition:[],mealScore:score(80)},...extra});
const scan=(id,extra={})=>({id,createdAt:'2026-10-04T10:00:00Z',kind:'meal',status:'ready',name:'Unconfirmed pizza',extraction:{type:'meal',meal:{name:'Pizza',portionMode:'estimated_serving'}},...extra});
const diet=app=>{app.history.handleAction('history-filter','diet');return app.history.screen();};
const remove=(app,id,keep=false)=>{app.history.handleAction('history-filter','all');app.history.handleAction('history-delete',id);app.history.handleAction(keep?'history-delete-only':'history-delete-confirm');};

// Tabs have exactly the requested names; unconfirmed scans appear in History, never Diet.
const app=boot([entry('eaten')]);app.history.record(scan('pending-review'));app.history.record(scan('product',{kind:'product',extraction:null,product:{name:'Scanned cereal'}}));
let html=app.history.screen();assert.deepEqual([...html.matchAll(/data-action="history-filter"[^>]*>([^<]+)</g)].map(m=>m[1]),['All','Scanned','Photos','Eaten']);
app.history.handleAction('history-filter','scanned');assert.equal(app.history.items().length,1);assert.equal(app.history.items()[0].id,'product');
app.history.handleAction('history-filter','photos');assert.equal(app.history.items().length,1);
html=diet(app);assert.match(html,/Diet quality/);assert.match(html,/data-action="diet-open" data-value="eaten"/);assert.doesNotMatch(html,/pending-review|Unconfirmed pizza|Scanned cereal/);
assert.match(html,/Historical Nudge score 80 out of 100/);assert.match(html,/1 of 1 foods have saved scores/);assert.match(html,/150 g/);
assert.match(html,/aria-label="Next day" disabled/);assert.match(html,/data-action="diet-period" data-value="28"/);

// Saved scores, consumed calories and portions drive weighting, including valid zero.
const weighted=boot([
  entry('a',{portions:2,sourceMeta:{mealComposition:[],mealScore:score(20)},nutritionSnapshot:{fat:nutrient(3),carbohydrate:nutrient(12)}}),
  entry('b',{energyPerPortion:300,proteinPerPortion:null,fibrePerPortion:null,sourceMeta:{mealComposition:[],mealScore:score(80,{status:'estimated_provisional',displayLower:80,displayUpper:90})},nutritionSnapshot:{fat:nutrient(null),carbohydrate:nutrient(30)}}),
  entry('unknown',{name:'Unknown food',energyPerPortion:100,sourceMeta:null,plants:[],proteinPerPortion:null,fibrePerPortion:null}),
  entry('missing-calories',{name:'Unknown food',energyPerPortion:null,sourceMeta:null,plants:[]})
]);
const snapshot=JSON.stringify(weighted.data),s=weighted.model.day(weighted.data.foodLog.entries,'2026-10-04');
assert.equal(s.score.basis,null);assert.equal(s.score.value,null);assert.equal(s.score.scoredFoods,2);assert.equal(s.score.historicalFoods,2);assert.equal(s.score.unknownEnergy,1);
assert.deepEqual(clone(s.totals.energyKcal),{value:600,known:3,unknown:1,partial:true,partialFoods:0});assert.equal(s.totals.protein.value,15);assert.equal(s.totals.protein.unknown,2);assert.equal(s.totals.fat.value,6);assert.equal(s.totals.fat.unknown,3);assert.equal(s.totals.carbohydrate.value,54);assert.equal(s.totals.salt.value,null);
assert.equal(weighted.model.portion(weighted.data.foodLog.entries[0]),'300 g');assert.equal(JSON.stringify(weighted.data),snapshot);
html=diet(weighted);assert.doesNotMatch(html,/Provisional range|Estimated diet score/);assert.match(html,/Partial · 2 foods unknown/);
const zero=boot([entry('zero',{sourceMeta:{mealComposition:[],mealScore:score(0)}})]);assert.equal(zero.model.summary(zero.data.foodLog.entries).score.value,null);assert.match(diet(zero),/n-score-red[^>]+>0<small>\/100/);
const noEnergy=boot([entry('zero-energy',{energyPerPortion:0})]);assert.equal(noEnergy.model.summary(noEnergy.data.foodLog.entries).score.value,null);assert.equal(noEnergy.model.summary(noEnergy.data.foodLog.entries).totals.energyKcal.value,0);
const empty=boot();const e=empty.model.day([],'2026-10-04');assert.equal(e.score.value,null);assert.equal(e.totals.energyKcal.value,null);assert.match(diet(empty),/No food logged for this day/);
assert.equal(weighted.model.nutrient(entry('stale',{nutritionSnapshot:{fat:nutrient(20,'unknown')}}),'fat'),null);

// A quarter recipe keeps its full photographed side. Diet and Today must project
// the same compatible carbohydrate subtotal, not discard it or call it complete.
const recipeApp=boot(),composition=recipeApp.sandbox.NudgeComposition;
const ingredient=(name,grams,energy,carbs,definition='available')=>({name,amountGrams:grams,recordId:name,sourceRecord:{id:name,basis:'per100g',carbohydrateDefinition:definition},nutrients:Object.fromEntries(composition.keys.map(key=>[key,{value:key==='energyKcal'?energy:key==='carbohydrate'?carbs:0,unit:key==='energyKcal'?'kcal':'g'}]))});
const batch=[ingredient('fish',300,100,0),ingredient('potato',600,80,20),ingredient('milk',50,null,12,'by_difference_including_fibre')];
const selected=recipeApp.sandbox.NudgeRecipeComposition.apply({components:[ingredient('pie',400,null,null),ingredient('cabbage side',50,20,3)],recipeCalculation:{version:'recipe-composition-v1',applied:false,batchComponents:batch,componentIndexes:[0]}},4,{source:'user',portionFraction:.25});
assert.equal(selected.components.at(-1).amountGrams,50);
const partialSnapshot=Object.fromEntries(Object.entries(selected.nutrients).map(([key,n])=>[key,{per100:null,per100Status:'unknown',portion:n.value,unit:n.unit,portionStatus:n.value!==null?'calculated':'partial',...(n.value===null?{knownPortionSubtotal:n.knownSubtotal,knownContributions:n.knownContributions,unknownContributions:n.unknownContributions}:{})}]));
const quarter=entry('quarter-pie',{name:'Fish pie and cabbage',energyPerPortion:null,proteinPerPortion:null,fibrePerPortion:null,portionAmount:null,portionUnit:null,nutritionSnapshot:partialSnapshot,sourceMeta:{mealComposition:selected.components,mealRecipeCalculation:selected.recipeCalculation,photoPortions:'1',nutritionEstimate:'photo'}});
for(const savedSnapshot of [true,false])for(const portions of [1,2]){
  const food={...clone(quarter),portions,...(savedSnapshot?{}:{nutritionSnapshot:null})},partial=boot([food]);
  partial.data.nutritionProfile=partial.sandbox.NudgeNutrition.saveDraft({...partial.sandbox.NudgeNutrition.draft({}),carbTarget:20},{},food.day);
  const before=JSON.stringify(partial.data),historyBefore=JSON.stringify([...partial.storage]);
  const summary=partial.model.day(partial.data.foodLog.entries,food.day),today=partial.sandbox.NudgeToday.model(partial.data,food.day);
  assert.equal(summary.totals.carbohydrate.value,31.5*portions);assert.equal(today.carbs.value,summary.totals.carbohydrate.value);assert.equal(today.carbs.unknown,1);
  assert.equal(summary.totals.carbohydrate.partial,true);assert.equal(summary.totals.carbohydrate.partialFoods,1);assert.equal(summary.totals.carbohydrate.unknown,0);
  assert.equal(partial.sandbox.NudgeToday.status(today.carbs),'partial','An incomplete subtotal above the target is still partial');
  assert.equal(partial.model.period(partial.data.foodLog.entries,food.day).totals.carbohydrate.value,31.5*portions);
  assert.equal(today.weekCarbs.value,31.5*portions);assert.equal(summary.totals.energyKcal.value,205*portions);
  const page=diet(partial);assert.match(page,new RegExp('data-diet-nutrient="carbohydrate"><span>Carbs<small>Partial · 1 food incomplete</small></span><strong>≥ '+(31.5*portions)+' <small>g</small>'));
  assert.match(page,new RegExp('≥ '+(205*portions)+' kcal · partial'));
  assert.equal(JSON.stringify(partial.data),before);assert.equal(JSON.stringify([...partial.storage]),historyBefore);assert.equal(partial.writes(),0);assert.equal(partial.historyWrites(),0);
  const restarted=boot(clone(partial.data.foodLog.entries));assert.equal(restarted.model.summary(restarted.data.foodLog.entries).totals.carbohydrate.value,31.5*portions);
}
const mixedPartial=boot([quarter,entry('unknown-carbs',{energyPerPortion:null,proteinPerPortion:null,fibrePerPortion:null,sourceMeta:null})]);
assert.match(diet(mixedPartial),/Partial · 1 food incomplete · 1 food unknown/);assert.equal(mixedPartial.model.summary(mixedPartial.data.foodLog.entries).totals.carbohydrate.value,31.5);
const clearedCarbs=clone(quarter);clearedCarbs.nutritionSnapshot.carbohydrate={...nutrient(null,'unknown')};clearedCarbs.sourceMeta.retainedNutrients='Carbohydrate amount edited by user';
const cleared=boot([clearedCarbs]);assert.equal(cleared.model.summary(cleared.data.foodLog.entries).totals.carbohydrate.value,null);assert.equal(cleared.sandbox.NudgeToday.model(cleared.data,clearedCarbs.day).carbs.value,null);assert.match(diet(cleared),/data-diet-nutrient="carbohydrate"><span>Carbs<small>1 food unknown<\/small><\/span><strong>—/);
const partialZero=clone(quarter);partialZero.nutritionSnapshot.carbohydrate.knownPortionSubtotal=0;
const zeroSubtotal=boot([partialZero]);assert.equal(zeroSubtotal.model.summary(zeroSubtotal.data.foodLog.entries).totals.carbohydrate.value,0);assert.match(diet(zeroSubtotal),/data-diet-nutrient="carbohydrate"><span>Carbs<small>Partial · 1 food incomplete<\/small><\/span><strong>≥ 0 <small>g/);
// Product consumption shares a scan but has distinct confirmed IDs; each portion counts once.
const productScore=app.sandbox.NudgeFoodDetailModel.score({name:'Oats',categoryTag:'en:breakfast-cereals',basisUnit:'g',nutritionPreparation:'as_sold',nutrients:{energyKcal:{value:375,unit:'kcal',status:'supplied'},protein:{value:5,unit:'g',status:'supplied'},fibre:{value:2,unit:'g',status:'supplied'},saturatedFat:{value:.1,unit:'g',status:'supplied'},sugars:{value:37,unit:'g',status:'supplied'},salt:{value:.83,unit:'g',status:'supplied'}}});
assert.equal(app.sandbox.NudgeFoodDetailModel.validScoreResult(productScore),true);
const productEntry=(id,extra={})=>entry(id,{sourceMeta:{entryKind:'product-consumption',confirmationId:id,scanEventId:'same-product',productScanEventId:'same-product',consumedAt:'2026-10-03T23:30:00Z',scoreMethod:clone(productScore)},...extra});
const consumption=boot([productEntry('portion1'),productEntry('portion2',{portionAmount:200,portionUnit:'ml'})]);
consumption.history.record(scan('same-product',{kind:'product',extraction:null,product:{name:'A different current source'}}));
assert.equal(consumption.model.summary(consumption.data.foodLog.entries).count,2);assert.equal(consumption.model.summary(consumption.data.foodLog.entries).totals.energyKcal.value,200);assert.equal(consumption.model.summary(consumption.data.foodLog.entries).score.value,null);assert.equal(consumption.model.day(consumption.data.foodLog.entries,'2026-10-03').count,0);
html=diet(consumption);assert.match(html,/200 ml/);consumption.history.handleAction('diet-open','portion2');assert.equal(consumption.productOpened().options.entryId,'portion2');
const duplicates=[entry('same'),entry('same',{energyPerPortion:999}),entry('id-a',{sourceMeta:{confirmationId:'one-confirmation'}}),entry('id-b',{sourceMeta:{confirmationId:'one-confirmation'}})];assert.equal(consumption.model.summary(duplicates).count,2);assert.equal(consumption.model.summary(duplicates).totals.energyKcal.value,200);

// Unknown saved ratings can display a disclosed estimate, never newer scan facts or new nutrition.
const fallback=boot([entry('rough',{name:'Pizza',energyPerPortion:null,proteinPerPortion:null,fibrePerPortion:null,sourceMeta:{scanEventId:'later',mealComposition:[{name:'Pizza base'}],mealScore:{available:false,value:null}}})]);
fallback.history.record(scan('later',{entryId:'rough',extraction:{type:'meal',meal:{name:'Changed salad',scoreSnapshot:score(95)}}}));
const beforeFallback=JSON.stringify(fallback.data),rough=fallback.model.scoreForEntry(fallback.data.foodLog.entries[0]);assert.equal(rough.rough,true);assert.equal(rough.saved,false);assert.match(diet(fallback),/Rough estimate/);assert.notEqual(rough.value,95);assert.equal(fallback.model.summary(fallback.data.foodLog.entries).totals.energyKcal.value,null);assert.equal(JSON.stringify(fallback.data),beforeFallback);
const savedOld=boot([entry('older',{name:'Pizza',sourceMeta:{mealComposition:[],mealScore:score(80)}})]);assert.equal(savedOld.model.scoreForEntry(savedOld.data.foodLog.entries[0]).value,80);assert.equal(savedOld.model.scoreForEntry(savedOld.data.foodLog.entries[0]).saved,true);
// Numeric RAG never becomes grey merely because the method is historical or
// the independent eating-frequency check is pending.
for(const [value,tone] of [[0,'red'],[24,'red'],[25,'amber'],[49,'amber'],[50,'green'],[100,'green']]){
  const old=boot([entry('boundary',{sourceMeta:{mealComposition:[],mealScore:score(value)}})]),bytes=JSON.stringify(old.data);
  old.sandbox.NudgeMealScore={...old.sandbox.NudgeMealScore,calculate(){throw Error('A valid saved number wins over recalculation');},estimate(){throw Error('A valid saved number wins over estimation');}};
  const rating=old.model.scoreForEntry(old.data.foodLog.entries[0]);assert.equal(rating.value,value);assert.equal(rating.tone,tone);assert.equal(rating.legacy,true);assert.match(diet(old),new RegExp('n-score-'+tone+'[^>]+>'+value+'<small>/100'));
  assert.equal(JSON.stringify(old.data),bytes);assert.equal(old.writes(),0);
}
const foodOnly=boot([entry('pizza',{name:'Pizza',energyPerPortion:null,proteinPerPortion:null,fibrePerPortion:null,sourceMeta:null,plants:[]})]);
const foodOnlyBefore=JSON.stringify(foodOnly.data),foodOnlyScore=foodOnly.model.scoreForEntry(foodOnly.data.foodLog.entries[0]);assert.equal(foodOnlyScore.rough,true);assert.equal(foodOnlyScore.saved,false);assert.equal(foodOnlyScore.frequency,null);assert.equal(foodOnlyScore.tone,foodOnly.sandbox.NudgeScoreCore.displayTone(foodOnlyScore.value));assert.match(diet(foodOnly),/Rough estimate/);assert.match(diet(foodOnly),/Rough Nudge score/);assert.match(diet(foodOnly),/<small>Rough<\/small>/);
for(const key of ['energyKcal','protein','fibre'])assert.equal(foodOnly.model.summary(foodOnly.data.foodLog.entries).totals[key].value,null);
assert.equal(JSON.stringify(foodOnly.data),foodOnlyBefore);assert.equal(foodOnly.writes(),0);

// Archived results are evidence of an explicit edit, not permission to resurrect
// the former scan's nutrition, composition or qualitative observations.
const edited=boot([entry('edited',{name:'Chocolate cake',ingredients:{text:'Sugar, chocolate'},sourceMeta:{scoreHistory:[score(95)],scanEventId:'old-product',mealComposition:[{name:'spinach',amountGrams:100}]},energyPerPortion:null,proteinPerPortion:null,fibrePerPortion:null})]);
edited.history.record(scan('old-product',{kind:'product',entryId:'edited',extraction:null,product:{name:'Wholegrain vegetable salad',ingredients:'Spinach, wholegrain bread',scoreResult:score(95)}}));
const editedBefore=JSON.stringify(edited.data),editedEntry=edited.data.foodLog.entries[0],editedContext={productForEntry(){throw Error('An invalidated score must not consult its old product');},mealForEntry(){throw Error('An invalidated score must not consult its old meal');}};
const editedRating=edited.model.scoreForEntry(editedEntry,editedContext);assert.equal(editedRating.value,30);assert.equal(editedRating.rough,true);assert.equal(editedRating.saved,false);assert.equal(editedRating.tone,'amber');
assert.match(diet(edited),/Rough Nudge score 30 out of 100/);edited.history.handleAction('history-filter','all');assert.match(edited.history.screen(),/n-score-amber[^>]+>30<small>\/100/);
assert.equal(JSON.stringify(edited.data),editedBefore);assert.equal(edited.model.summary(edited.data.foodLog.entries).totals.energyKcal.value,null);assert.equal(edited.writes(),0);
const unresolvedEdit=clone(editedEntry);unresolvedEdit.name='Unknown food';unresolvedEdit.ingredients=null;assert.equal(edited.model.scoreForEntry(unresolvedEdit,editedContext),null);
const unresolved=boot([unresolvedEdit]);assert.match(unresolved.history.screen(),/class="n-score n-score-unknown" aria-label="Score unavailable">—/);

// Day keys, rather than consumedAt instants, stay authoritative across DST/month boundaries.
const dated=boot([entry('first',{day:'2026-10-20'}),entry('dst',{day:'2026-10-25'}),entry('last',{day:'2026-10-26'}),entry('too-old',{day:'2026-10-19'}),entry('future',{day:'2026-10-27'})],new Map(),'2026-10-26');
const week=dated.model.period(dated.data.foodLog.entries,'2026-10-26',7);assert.equal(week.start,'2026-10-20');assert.equal(week.windowDays,7);assert.equal(week.count,3);assert.equal(week.loggedDays,3);assert.equal(week.windowDays,week.days.length);assert.equal(week.score.value,null);assert.equal(week.days.find(x=>x.day==='2026-10-24').score.value,null);
assert.equal(dated.model.period(dated.data.foodLog.entries,'2026-10-26',28).start,'2026-09-29');
diet(dated);dated.history.handleAction('diet-day-step','-1');assert.match(dated.history.screen(),/data-diet-day="2026-10-25"/);dated.history.handleAction('diet-day-step','1');assert.match(dated.history.screen(),/data-diet-day="2026-10-26"/);dated.history.handleAction('diet-day-step','1');assert.match(dated.history.screen(),/data-diet-day="2026-10-26"/);dated.history.handleAction('diet-day','2026-02-30');assert.match(dated.history.screen(),/data-diet-day="2026-10-26"/);
dated.history.handleAction('diet-period','28');assert.match(dated.history.screen(),/28-day food record/);assert.match(dated.history.screen(),/4 of 28 days logged/);assert.match(dated.history.screen(),/No food logged/);

// Delete/Undo uses the existing journal. History-only deletion must keep Diet intake.
for(const keep of [false,true]){
  const food=entry('logged',{sourceMeta:{scanEventId:'linked',confirmationId:'linked',mealComposition:[],mealScore:score(70)}}),deleted=boot([food]);deleted.history.record(scan('linked',{entryId:'logged'}));const exact=clone(deleted.data.foodLog.entries[0]);
  remove(deleted,'linked',keep);assert.equal(deleted.model.summary(deleted.data.foodLog.entries).count,keep?1:0);assert.equal(deleted.history.isEntryDeleted('logged'),true);html=diet(deleted);assert.match(html,/history-undo/);assert.equal(html.includes('data-action="diet-open" data-value="logged"'),keep);
  const restarted=boot(clone(deleted.data.foodLog.entries),deleted.storage);html=diet(restarted);assert.equal(html.includes('data-action="diet-open" data-value="logged"'),keep);
  if(keep){restarted.history.handleAction('diet-open','logged');assert.equal(restarted.destination(),'food-entry');assert.equal(restarted.view.foodDraft.id,'logged');assert.equal(restarted.history.find('linked'),undefined);}
  restarted.history.handleAction('history-undo');restarted.history.handleAction('history-undo');assert.deepEqual(clone(restarted.data.foodLog.entries),[exact]);assert.equal(restarted.model.summary(restarted.data.foodLog.entries).score.value,null);assert.match(restarted.history.screen(),/data-value="logged"/);
}
remove(consumption,'same-product',true);assert.equal(consumption.model.summary(consumption.data.foodLog.entries).count,2);remove(consumption,'diary:portion1');assert.equal(consumption.model.summary(consumption.data.foodLog.entries).count,1);consumption.history.handleAction('history-undo');assert.equal(consumption.model.summary(consumption.data.foodLog.entries).count,2);
const failed=boot([entry('write-failure')]);failed.canSave(false);remove(failed,'diary:write-failure');assert.equal(failed.model.summary(failed.data.foodLog.entries).count,1);assert.match(diet(failed),/Deletion needs another try/);failed.history.handleAction('history-undo');assert.equal(failed.model.summary(failed.data.foodLog.entries).count,1);

// Reading and date/window changes may estimate missing scores but never write snapshots or intake.
for(const current of [app,weighted,consumption,fallback,dated]){
  const data=JSON.stringify(current.data),stored=JSON.stringify([...current.storage]),hw=current.historyWrites(),dw=current.writes();
  diet(current);current.history.handleAction('diet-period','28');current.history.handleAction('diet-day-step','-1');current.history.handleAction('diet-today');current.history.screen();
  assert.equal(JSON.stringify(current.data),data);assert.equal(JSON.stringify([...current.storage]),stored);assert.equal(current.historyWrites(),hw);assert.equal(current.writes(),dw);
}
console.log('Passed: Diet confirmed-intake-only tabs/cards; historical scores and frequency counts without mixed-model averages; partial nutrition, unknowns and zero, exact portions, DST/7/28-day gaps, deduplication, independent product portions, read-only navigation and deletion/Undo/restart consistency.');

assert.doesNotMatch(diet(app),/Lunch ·|Dinner ·|Breakfast ·|Snack ·/,'Diary subtitles omit saved categories');
