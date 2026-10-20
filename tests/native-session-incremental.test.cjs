const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {test} = require('node:test');
const copy = value => JSON.parse(JSON.stringify(value));
const files = ['streaks.js','recipe-catalogue-data.js','recipe-catalogue.js','core/food-log.js','core/diary.js','core/nutrition-profile.js','core/product-evidence.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','core/analysis-result.js','scan-results.js','today-goals.js','cycle-support.js','search-model.js','diet.js','scan-history.js','repertoire.js','native-review.js','native-session.js','food-catalogue.js'];
const mainKey='wmd-nudge-prototype-v1', historyKey='nudge-scan-history-v1', foodsKey='nudge-my-foods-v1';
const nutrientValues={energyKcal:100,protein:6,fibre:5,salt:.3,sugars:1,fat:2,saturatedFat:.3,carbohydrate:14};
const product={name:'Synthetic chickpeas',barcode:'12345678',basisUnit:'g',servingAmount:100,servingUnit:'g',nutritionPreparation:'as_sold',categoriesTags:['en:legumes'],ingredients:'Chickpeas, water',nutrients:Object.fromEntries(Object.entries(nutrientValues).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:'supplied'}]))};
function boot(count=0) {
  let failedKey=''; const io=[];
  const values=new Map([[historyKey,JSON.stringify({version:3,events:Array.from({length:count},(_,i)=>({id:'fixture-'+i,name:'Synthetic food '+i,kind:'product',status:'ready',createdAt:'2026-10-10T12:00:00Z',product:{...product,barcode:String(10000000+i),ingredients:'Synthetic ingredient description. '.repeat(100)}})),favourites:[],deleted:[],generations:{}})]]);
  const scope={console,Date,Math,JSON,URL,document:{addEventListener(){},getElementById(){return null;}},location:{protocol:'native:'},nativeToday:()=> '2026-10-11',nativeNow:()=> '2026-10-11T12:00:00Z',nativeDiagnostic(){},nativeStorage:input=>{
    const request=JSON.parse(input);io.push(request);
    if(request.operation==='get')return JSON.stringify({ok:true,value:values.get(request.key)??null});
    if(request.key===failedKey)return '{"ok":false}';
    if(request.operation==='set')values.set(request.key,request.value);else if(request.operation==='remove')values.delete(request.key);else throw Error('Unexpected storage operation');
    return '{"ok":true}';
  }};
  scope.window=scope;vm.createContext(scope);
  for(const file of files)vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),scope,{filename:file});
  const api=scope.NudgeNativeSession, initial=copy(api.init());assert.equal(initial.readFailed,false);io.length=0;
  return {api,scope,initial,io,values,fail:key=>failedKey=key};
}
function storedParts(snapshot){return Object.fromEntries(['state','history','foods','review','message','readFailed'].map(key=>[key,snapshot[key]]));}

test('draft edits return a small delta without reading or rebridging a large history',()=>{
  const a=boot(220);
  a.api.perform('setReview',{kind:'product',product,confirmationId:'synthetic-review'});
  a.io.length=0;
  const delta=copy(a.api.perform('reviewUpdate',{name:'Edited synthetic food'},true));
  assert.equal(delta.ok,true);assert.deepEqual(a.io,[]);
  assert.deepEqual(Object.keys(delta).sort(),['message','ok','readFailed','review']);
  assert.equal(delta.review.draft.name,'Edited synthetic food');
  const full=copy(a.api.snapshot());
  assert.deepEqual(delta.review,full.review);
  assert.ok(JSON.stringify(delta).length<JSON.stringify(full).length/50,'Draft edits must not include saved records');
});

test('applying incremental replies gives the same acknowledged state as full snapshots',()=>{
  const a=boot(3);let mirror=a.initial;
  function apply(operation,payload={}){
    const result=copy(a.api.perform(operation,payload,true));assert.equal(result.ok,true,result.message);
    mirror={...mirror,...result};assert.deepEqual(storedParts(mirror),storedParts(copy(a.api.snapshot())),operation);
    return result;
  }
  apply('setReview',{kind:'product',product,confirmationId:'synthetic',eventId:'new-scan'});
  apply('recordHistory',{id:'new-scan',kind:'product',status:'ready',name:product.name,product});
  apply('reviewUpdate',{name:'Saved synthetic food',quantity:1.5});
  apply('reviewSaveFood');apply('reviewConfirm');
  assert.equal(mirror.state.foodLog.entries.length,1);
  apply('foodsRename',{id:mirror.foods.foods[0].id,name:'Renamed reusable food'});
  apply('historyDelete',{id:'new-scan',keepIntake:true});apply('historyUndo');
  apply('settingsSave',{motionEnabled:false});
  apply('foodsToggleProduct',{product});apply('foodsToggleProduct',{product});
});

test('failed acknowledged writes cannot publish optimistic favourites or diary changes',()=>{
  const a=boot();a.api.perform('setReview',{kind:'product',product,confirmationId:'synthetic'});
  const before=copy(a.api.snapshot());
  a.fail(foodsKey);const favourite=copy(a.api.perform('reviewSaveFood',{},true));
  assert.equal(favourite.ok,false);assert.deepEqual({...before,...favourite}.foods,before.foods);
  assert.deepEqual(copy(a.api.snapshot()).foods,before.foods);
  a.fail(mainKey);const intake=copy(a.api.perform('reviewConfirm',{},true));
  assert.equal(intake.ok,false);assert.deepEqual({...before,...intake}.state,before.state);
  assert.deepEqual(copy(a.api.snapshot()).state,before.state);
  a.fail('');assert.equal(a.api.perform('reviewConfirm',{},true).ok,true);
  assert.equal(a.api.snapshot().state.foodLog.entries.length,1);
});

test('legacy favourites are refreshed when an archived product changes',()=>{
  const a=boot();
  a.values.set(historyKey,JSON.stringify({version:3,events:[{id:'legacy',name:product.name,kind:'product',status:'ready',createdAt:'2026-10-10T12:00:00Z',product}],favourites:['barcode:'+product.barcode],deleted:[],generations:{}}));
  // A new session loads the seeded legacy store; this re-init is read-only.
  let mirror=copy(a.api.init());assert.equal(mirror.foods.foods.length,1);
  const result=copy(a.api.perform('recordHistory',{id:'legacy',product:{...product,name:'Updated public name'}},true));
  assert.equal(result.ok,true);assert.ok(result.foods);
  mirror={...mirror,...result};assert.deepEqual(storedParts(mirror),storedParts(copy(a.api.snapshot())));
});

test('nutrition diagnostics use identical totals without projecting the archive',()=>{
  const a=boot(20);
  a.api.perform('setReview',{kind:'product',product,confirmationId:'nutrition'});a.api.perform('reviewConfirm');
  const expected=copy(a.api.project('today'));
  const original=a.scope.NudgeFoodDetailModel.score;
  a.scope.NudgeFoodDetailModel.score=()=>{throw Error('Diagnostic should not score archived food');};
  const totals=copy(a.api.project('nutritionTotals'));
  a.scope.NudgeFoodDetailModel.score=original;
  for(const key of ['protein','energy','carbs','fibre','fat','entryCount'])assert.deepEqual(totals[key],expected[key]);
  assert.equal(totals.rows,undefined);
});

test('list projections keep display and action identity without copying source evidence',()=>{
  const a=boot(30),photo='nudge-photo:11111111-1111-4111-8111-111111111111.jpg';
  a.api.perform('setReview',{kind:'product',product,photos:[photo],eventId:'fixture-0',confirmationId:'compact-entry'});
  assert.equal(a.api.perform('reviewConfirm').ok,true);
  const saved=copy(a.api.snapshot()),before=new Map(a.values);a.io.length=0;
  const full=copy(a.api.project('history')),thin=copy(a.api.project('history',{presentation:true}));
  assert.deepEqual(thin.rows.map(r=>r.id),full.rows.map(r=>r.id));
  for(let i=0;i<full.rows.length;i++){
    const original=full.rows[i],row=thin.rows[i];
    for(const key of ['id','name','historyDay','scoreDisplay','isFavourite','canFavourite','note','status'])assert.deepEqual(row[key],original[key],key);
    assert.equal(row.product,undefined);assert.equal(row.extraction,undefined);assert.equal(row.analysisVersions,undefined);
    const opened=copy(a.api.project('historyItem',{id:row.id})).row;
    assert.deepEqual(opened.product,original.product);
    assert.deepEqual(opened.entry,original.entry);
  }
  const linked=thin.rows.find(r=>r.entry);assert.equal(linked.imageURL,photo);assert.equal(linked.entry.sourceMeta,undefined);
  assert.ok(JSON.stringify(thin).length<JSON.stringify(full).length/3);
  const today=copy(a.api.project('today',{presentation:true}));
  assert.equal(today.rows[0].entry.id,saved.state.foodLog.entries[0].id);
  assert.equal(today.entries[0].nutritionSnapshot,undefined);
  assert.deepEqual(a.io,[]);assert.deepEqual(a.values,before,'Projection must not compact persisted records');
  assert.equal(a.api.perform('historyDelete',{id:linked.id,keepIntake:false}).ok,true);
  assert.equal(a.api.project('historyItem',{id:linked.id}).row,null,'An old list row cannot reopen a deleted intake');
  const undo=copy(a.api.project('history',{presentation:true})).undo;
  assert.ok(undo.ids.length);assert.equal(undo.events,undefined);assert.equal(undo.entry,undefined);
  assert.equal(a.api.perform('historyUndo').ok,true);
  assert.deepEqual(copy(a.api.project('historyItem',{id:linked.id})).row.entry,saved.state.foodLog.entries[0]);
});

test('screen cache lifetime ends at the earliest pending evidence deadline',()=>{
  const a=boot();let clock=Date.now();
  a.scope.Date=class extends Date {static now(){return clock;}};
  const early=clock+1500,later=clock+4000;
  const p={...product,scoreResult:{catalogueValidated:true,catalogueExpiresAt:later,result:{catalogueEnrichment:{expiresAt:early}}}};
  assert.equal(a.api.perform('recordHistory',{id:'expiring',kind:'product',status:'ready',name:p.name,product:p}).ok,true);
  assert.equal(a.api.project('history',{presentation:true,nativeCache:true}).nativeCacheUntil,early);
  clock=early;
  assert.equal(a.api.project('history',{presentation:true,nativeCache:true}).nativeCacheUntil,later,'Already expired evidence is recalculated and must not cause permanent cache misses');
  clock=later;
  assert.equal(a.api.project('history',{presentation:true,nativeCache:true}).nativeCacheUntil,null);
});

test('background record changes do not republish an untouched open draft',()=>{
  const a=boot();a.api.perform('setReview',{kind:'product',product,confirmationId:'kept-draft'});
  const review=copy(a.api.snapshot().review);
  const result=copy(a.api.perform('recordHistory',{id:'background',kind:'product',status:'ready',name:product.name,product},true));
  assert.ok(result.history);assert.equal(result.review,undefined);
  assert.deepEqual(copy(a.api.snapshot().review),review);
  const edited=copy(a.api.perform('reviewUpdate',{name:'New draft name'},true));
  assert.equal(edited.review.draft.name,'New draft name');
});

test('opening or bookmarking one scan does not score the rest of the archive',()=>{
  const a=boot(60),original=a.scope.NudgeFoodDetailModel.score;let scored=0;
  a.scope.NudgeFoodDetailModel.score=(...args)=>{scored++;return original(...args);};
  const row=a.api.project('historyItem',{id:'fixture-0'}).row;
  assert.equal(row.id,'fixture-0');assert.equal(scored,0);
  assert.equal(a.api.perform('historyToggleFavourite',{id:row.id},true).ok,true);
  assert.ok(scored<10,'Only the selected product may need a new saved-food calculation');
  assert.equal(a.api.snapshot().foods.foods.length,1);
  assert.equal(a.api.snapshot().state.foodLog.entries.length,0);
});

test('a History status write returns its exact acknowledged bytes without rereading the archive',()=>{
  const a=boot(400);
  const delta=copy(a.api.perform('recordHistory',{id:'fixture-0',status:'pending',processingState:'processing'},true));
  assert.equal(delta.ok,true);
  assert.deepEqual(a.io.map(r=>[r.operation,r.key]),[['set',historyKey]]);
  assert.deepEqual(delta.history,JSON.parse(a.values.get(historyKey)));
  a.io.length=0;
  assert.deepEqual(copy(a.api.snapshot()).history,delta.history);
  assert.ok(a.io.some(r=>r.operation==='get'),'A standalone snapshot still reads current durable data');
});

test('native direct writes use the same acknowledged strings and failures never publish optimistic data',()=>{
  const a=boot();let direct=0;
  a.scope.nativeStorageWrite=(key,value)=>{direct++;assert.equal(typeof value,'string');return a.scope.nativeStorage(JSON.stringify({operation:'set',key,value}));};
  a.api.perform('setReview',{kind:'product',product,confirmationId:'direct'});
  const previous=a.values.get(mainKey);a.fail(mainKey);
  const failed=copy(a.api.perform('reviewConfirm',{},true));
  assert.equal(failed.ok,false);assert.equal(a.values.get(mainKey),previous);assert.equal(failed.state,undefined);
  a.fail('');const saved=copy(a.api.perform('reviewConfirm',{},true));
  assert.equal(saved.ok,true);assert.equal(saved.state.foodLog.entries.length,1);assert.equal(direct,2);
});

test('a shared barcode completion preserves every observation in one atomic History write',()=>{
  const a=boot(),photo='nudge-photo:11111111-1111-4111-8111-111111111111.jpg';
  const events=Array.from({length:42},(_,i)=>({id:'burst-'+i,kind:'product',status:'pending',processingState:'queued',barcode:product.barcode,
    createdAt:new Date(Date.UTC(2026,9,11,10,0,i)).toISOString(),loggingDay:i%2?'2026-10-10':'2026-10-11',loggingMeal:i%2?'Lunch':'Dinner',
    captureOwnerKey:'local-guest',captureID:'capture-'+i,photos:[photo],photoCount:1,thumbnail:'data:image/jpeg;base64,YQ==',errorCode:'analysis_connection',nextAttemptAt:'2026-10-11T12:01:00Z',product:{...product,name:'Previous facts'}}));
  events.push({id:'other',kind:'product',status:'pending',barcode:'87654321',createdAt:'2026-10-11T08:00:00Z'});
  a.values.set(historyKey,JSON.stringify({version:3,events,favourites:[],deleted:[],generations:{}}));a.api.init();
  const before=copy(a.api.snapshot());a.io.length=0;
  const completed=copy(a.api.perform('recordScannedProducts',{eventIDs:events.slice(0,42).map(e=>e.id),product},true));
  assert.equal(completed.ok,true);assert.deepEqual(a.io.map(r=>[r.operation,r.key]),[['set',historyKey]]);
  assert.deepEqual(completed.history.events.map(e=>e.id),before.history.events.map(e=>e.id));
  for(let i=0;i<42;i++){
    const old=before.history.events[i],row=completed.history.events[i];
    for(const key of ['id','createdAt','loggingDay','loggingMeal','captureOwnerKey','captureID','photos','photoCount','thumbnail'])assert.deepEqual(row[key],old[key],key);
    assert.equal(row.status,'ready');assert.equal(row.processingState,'complete');assert.equal(row.errorCode,'');assert.equal(row.message,'');assert.equal(row.nextAttemptAt,'');
    assert.equal(row.product.name,product.name);assert.equal(row.analysisVersions.at(-1).product.name,'Previous facts');
  }
  for(const [key,value] of Object.entries(before.history.events[42]))assert.deepEqual(completed.history.events[42][key],value,'Unrelated '+key);
  assert.deepEqual(completed.history,JSON.parse(a.values.get(historyKey)));
  const persisted=a.values.get(historyKey);a.io.length=0;
  for(const eventIDs of [['burst-0','burst-0'],['burst-0','missing'],['burst-0','other'],[],Array(501).fill('burst-0')]){
    assert.equal(a.api.perform('recordScannedProducts',{eventIDs,product},true).ok,false);
    assert.equal(a.values.get(historyKey),persisted);
  }
  assert.deepEqual(a.io,[]);
  a.api.perform('historyDelete',{id:'burst-0',keepIntake:true});a.io.length=0;
  assert.equal(a.api.perform('recordScannedProducts',{eventIDs:['burst-1','burst-0'],product},true).ok,false);
  assert.deepEqual(a.io,[],'Deleted observations cannot be resurrected by a batch');
});

test('a failed barcode batch rolls every pending row back before a later successful operation',()=>{
  const a=boot(),events=Array.from({length:3},(_,i)=>({id:'failed-'+i,kind:'product',status:'pending',barcode:product.barcode,createdAt:'2026-10-11T10:00:00Z',product:{...product,name:'Retained evidence'}}));
  a.values.set(historyKey,JSON.stringify({version:3,events,favourites:[],deleted:[],generations:{}}));a.api.init();
  const original=a.values.get(historyKey),ids=events.map(e=>e.id);a.fail(historyKey);
  const failed=copy(a.api.perform('recordScannedProducts',{eventIDs:ids,product},true));
  assert.equal(failed.ok,false);assert.equal(failed.history,undefined);assert.equal(a.values.get(historyKey),original);
  for(const id of ids){const row=a.api.project('historyItem',{id}).row;assert.equal(row.status,'pending');assert.equal(row.product.name,'Retained evidence');}
  a.fail('');a.io.length=0;
  assert.equal(a.api.perform('recordScannedProducts',{eventIDs:ids,product},true).ok,true);
  assert.equal(a.io.filter(r=>r.operation==='set').length,1);
});

test('native compact History replies retain queue/undo metadata while full source detail stays exact',()=>{
  const a=boot(400),before=new Map(a.values),full=copy(a.api.snapshot());
  const compact=copy(a.api.init({nativeHistory:true}));
  assert.equal(compact.history.events.length,full.history.events.length);
  const fields=['id','captureOwnerKey','processingState','status','message','errorCode','nextAttemptAt'];
  const expected=row=>Object.fromEntries(fields.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
  assert.deepEqual(compact.history.events,full.history.events.map(expected));
  assert.ok(JSON.stringify(compact.history).length<JSON.stringify(full.history).length/20);
  assert.deepEqual(a.values,before,'Compact initialization is read-only');
  a.io.length=0;
  const delta=copy(a.api.perform('recordHistory',{id:'fixture-0',captureOwnerKey:'local-guest',status:'pending',processingState:'queued',nextAttemptAt:'2026-10-11T13:00:00Z'},true,true));
  assert.equal(delta.ok,true);assert.deepEqual(delta.history.events,JSON.parse(a.values.get(historyKey)).events.map(expected));
  assert.deepEqual(a.io.map(r=>[r.operation,r.key]),[['set',historyKey]]);
  assert.deepEqual(copy(a.api.project('historyItem',{id:'fixture-0'})).row.product,full.history.events[0].product);
  const deleted=copy(a.api.perform('historyDelete',{id:'fixture-0',keepIntake:true},true,true));
  const durable=JSON.parse(a.values.get(historyKey));
  assert.deepEqual(deleted.history.deleted,durable.deleted);assert.deepEqual(deleted.history.generations,durable.generations);
  assert.deepEqual(deleted.history.undo,{phase:durable.undo.phase,name:durable.undo.name,ids:durable.undo.ids});
  assert.equal(deleted.history.undo.events,undefined);
  assert.equal(a.api.perform('historyUndo',{},true,true).ok,true);
  assert.deepEqual(copy(a.api.project('historyItem',{id:'fixture-0'})).row.product,full.history.events[0].product);
  a.fail(historyKey);const failed=copy(a.api.perform('recordHistory',{id:'fixture-0',name:'Must not acknowledge'},true,true));
  assert.equal(failed.ok,false);assert.equal(failed.history,undefined);
});
