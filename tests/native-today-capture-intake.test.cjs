// Actual native adapter with isolated synthetic storage; no owner records/network.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const copy=value=>JSON.parse(JSON.stringify(value));
const files=['streaks.js','recipe-catalogue-data.js','recipe-catalogue.js','core/food-log.js','core/diary.js','core/nutrition-profile.js','core/product-evidence.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','core/analysis-result.js','scan-results.js','today-goals.js','cycle-support.js','search-model.js','diet.js','scan-history.js','repertoire.js','native-review.js','native-session.js','food-catalogue.js'];
const main='wmd-nudge-prototype-v1',archive='nudge-scan-history-v1',owner='ab'.repeat(32),day='2026-10-14';
const photo='nudge-photo:11111111-1111-4111-8111-111111111111.jpg';
const nutrients=Object.fromEntries(Object.entries({energyKcal:100,protein:6,fibre:5,salt:.3,sugars:1,fat:2,saturatedFat:.3,carbohydrate:14}).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:'supplied'}]));
const product={name:'Synthetic chickpeas',barcode:'12345678',basisUnit:'g',servingAmount:100,servingUnit:'g',nutritionPreparation:'as_sold',categoriesTags:['en:legumes'],ingredients:'Chickpeas, water',nutrients};
const event=(id='capture-1',extra={})=>({id,kind:'product',status:'ready',product,barcode:product.barcode,createdAt:day+'T10:00:00Z',captureOwnerKey:owner,captureID:'11111111-1111-4111-8111-111111111111',processingState:'complete',addToEaten:true,diaryAddState:'pending',loggingDay:day,loggingMeal:'Lunch',photos:[photo],...extra});
function boot(values=new Map()){
  let failedKey='';const io=[];
  const scope={console,Date,Math,JSON,URL,document:{addEventListener(){},getElementById(){return null;}},location:{protocol:'native:'},nativeToday:()=>day,nativeNow:()=>day+'T12:00:00Z',nativeDiagnostic(){},nativeStorage:input=>{
    const r=JSON.parse(input);io.push(r);
    if(r.operation==='get')return JSON.stringify({ok:true,value:values.get(r.key)??null});
    if(r.key===failedKey)return '{"ok":false}';
    if(r.operation==='set')values.set(r.key,r.value);else if(r.operation==='remove')values.delete(r.key);else throw Error('Unexpected operation');
    return '{"ok":true}';
  }};
  scope.window=scope;vm.createContext(scope);
  for(const file of files)vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),scope,{filename:file});
  const api=scope.NudgeNativeSession;assert.equal(api.init().readFailed,false);io.length=0;
  return {api,scope,values,io,fail:key=>failedKey=key,run:(op,p={})=>copy(api.perform(op,p,true)),snapshot:()=>copy(api.snapshot()),restart:()=>boot(values)};
}
const add=(a,id='capture-1',extra={})=>a.run('captureAddToEaten',{eventID:id,generation:0,ownerKey:owner,...extra});
const reversed=value=>Array.isArray(value)?value.map(reversed):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,child])=>[key,reversed(child)])):value;

test('reordered nested JSON evidence cannot grow versions across 42 duplicate completions',()=>{
  const a=boot();assert.equal(a.run('recordHistory',event()).ok,true);
  for(let i=0;i<42;i++)assert.equal(a.run('recordScannedProducts',{eventIDs:['capture-1'],product:i%2?product:reversed(product)}).ok,true);
  assert.equal(a.snapshot().history.events[0].analysisVersions.length,0);
  const changed={...product,nutrients:{...nutrients,protein:{value:0,unit:'g',status:'supplied'}}};
  a.run('recordHistory',{id:'capture-1',product:changed});
  const saved=a.snapshot().history.events[0];assert.equal(saved.analysisVersions.length,1);assert.equal(saved.analysisVersions[0].product.nutrients.protein.value,6);assert.equal(saved.product.nutrients.protein.value,0);
  a.run('recordHistory',{id:'capture-1',product:reversed(changed)});assert.equal(a.snapshot().history.events[0].analysisVersions.length,1);
});
test('extraction changes preserve prior unknown values and ordered ingredient evidence',()=>{
  const a=boot(),extraction={type:'meal',analysisId:'evidence',meal:{name:'Synthetic meal',ingredients:['oats','milk'],nutrients:{protein:{value:null,unit:'g'}}}};
  a.run('recordHistory',event('photo',{product:null,extraction,kind:'meal'}));
  a.run('recordHistory',{id:'photo',extraction:reversed(extraction)});assert.equal(a.snapshot().history.events[0].analysisVersions.length,0);
  a.run('recordHistory',{id:'photo',extraction:{...extraction,meal:{...extraction.meal,ingredients:['milk','oats']}}});
  const row=a.snapshot().history.events[0];assert.equal(row.analysisVersions.length,1);assert.equal(row.analysisVersions[0].extraction.meal.nutrients.protein.value,null);
});
test('background add atomically commits one intake and claim without changing open review',()=>{
  const a=boot();a.run('recordHistory',event());
  a.run('setReview',{kind:'product',product:{...product,name:'Unrelated open draft'},confirmationId:'open-draft'});
  const review=a.snapshot().review,archiveBefore=a.values.get(archive);a.io.length=0;
  const saved=add(a);assert.equal(saved.status,'added');assert.equal(saved.ok,true);
  assert.deepEqual(a.io.map(r=>[r.operation,r.key]),[['set',main]]);
  assert.equal(a.values.get(archive),archiveBefore);assert.deepEqual(a.snapshot().review,review);
  const entry=a.snapshot().state.foodLog.entries[0];assert.equal(entry.day,day);assert.equal(entry.slot,'','New intake is neutral while its original capture evidence stays unchanged');assert.deepEqual(entry.sourceMeta.entryPhotos,[photo]);
  assert.equal(a.api.project('today').entryCount,1);assert.equal(a.api.project('history').rows[0].entry.id,entry.id);
  assert.equal(a.api.project('pendingEaten',{day,ownerKey:owner}).rows.length,0);
  a.io.length=0;assert.equal(add(a.restart()).status,'alreadyAdded');assert.equal(a.snapshot().state.foodLog.entries.length,1);
});
test('swipe removal deletes only selected intake, recomputes totals and preserves source bytes and claims',()=>{
  const a=boot();a.run('recordHistory',event());a.run('recordHistory',event('other'));add(a);add(a,'other');
  const before=a.snapshot(),removed=before.state.foodLog.entries[0],archiveBefore=a.values.get(archive);
  const calories=a.api.project('today').compactMetrics.find(x=>x.key==='energy').rawValue;
  a.io.length=0;const result=a.run('diaryRemove',{entryId:removed.id});assert.equal(result.ok,true);assert.equal(result.message,'');
  assert.deepEqual(a.io.map(r=>[r.operation,r.key]),[['set',main]]);assert.equal(a.values.get(archive),archiveBefore);
  assert.equal(a.snapshot().state.foodLog.entries.length,1);assert.equal(a.api.project('today').compactMetrics.find(x=>x.key==='energy').rawValue,calories/2);
  const source=a.api.project('historyItem',{id:'capture-1'}).row;assert.equal(source.entry,undefined);assert.equal(source.entryId,'');assert.deepEqual(copy(source.photos),[photo]);
  const restarted=a.restart();assert.equal(add(restarted).status,'cancelled');assert.equal(restarted.snapshot().state.foodLog.entries.length,1);
});
test('failed diary removal rolls back exactly, with no success message or archive writes',()=>{
  const a=boot();a.run('recordHistory',event());add(a);const before=a.snapshot(),bytes=new Map(a.values);a.io.length=0;a.fail(main);
  const result=a.run('diaryRemove',{entryId:before.state.foodLog.entries[0].id});assert.equal(result.ok,false);assert.match(result.message,/could not be saved/);
  assert.deepEqual(a.snapshot().state,before.state);assert.deepEqual(a.values,bytes);
  assert.equal(a.io.filter(r=>r.operation==='set'&&r.key===archive).length,0);
});
test('failed background save retains no claim or intake, then retry succeeds exactly once',()=>{
  const a=boot();a.run('recordHistory',event());a.fail(main);const result=add(a);assert.equal(result.status,'saveFailed');assert.equal(result.ok,false);
  assert.equal(a.snapshot().state.captureIntakeClaims,undefined);assert.equal(a.snapshot().state.foodLog.entries.length,0);
  a.fail('');assert.equal(add(a).status,'added');assert.equal(add(a).status,'alreadyAdded');assert.equal(a.snapshot().state.foodLog.entries.length,1);
});
test('owner, generation, deletion, cancellation and unknown analysis fences do not invent intake',()=>{
  const a=boot();a.run('recordHistory',event());
  for(const p of [{ownerKey:'cd'.repeat(32)},{ownerKey:''},{generation:1},{generation:-1}])assert.equal(add(a,'capture-1',p).status,'cancelled');
  a.run('recordHistory',{id:'capture-1',diaryAddState:'cancelled'});assert.equal(add(a).status,'cancelled');
  a.run('recordHistory',event('unknown',{product:null,extraction:{type:'unknown',nutrients:{}},kind:'unknown'}));assert.equal(add(a,'unknown').status,'needsReview');
  a.run('historyDelete',{id:'capture-1',keepIntake:true});assert.equal(add(a).status,'cancelled');assert.equal(a.snapshot().state.foodLog.entries.length,0);
});
test('repairs update unchanged intake but never overwrite edited or removed intake',()=>{
  for(const mode of ['unchanged','edited','deleted','missing-snapshot']){
    const a=boot();a.run('recordHistory',event());add(a);const entry=a.snapshot().state.foodLog.entries[0];
    const updated={...product,nutrients:{...nutrients,protein:{value:9,unit:'g',status:'supplied'}}};
    a.run('recordHistory',event('repair',{product:null,extraction:{type:'product',basis:'per100g',nutritionPreparation:'as_sold',productName:product.name,nutrients:updated.nutrients},repairProduct:product,repairEntryId:entry.id,...(mode!=='missing-snapshot'?{repairEntrySnapshot:entry}:{})}));
    if(mode==='edited'){a.run('setReview',{kind:'entry',entryId:entry.id});a.run('reviewUpdate',{name:'Edited while analysis ran'});a.run('reviewConfirm');}
    if(mode==='deleted')a.run('diaryRemove',{entryId:entry.id});
    const before=a.snapshot().state.foodLog.entries;
    const result=add(a,'repair');assert.equal(result.status,mode==='unchanged'?'added':'needsReview',mode);
    if(mode!=='unchanged')assert.deepEqual(a.snapshot().state.foodLog.entries,before,mode);
    else {assert.equal(a.snapshot().state.foodLog.entries.length,1);assert.equal(a.snapshot().state.foodLog.entries[0].id,entry.id);assert.equal(a.snapshot().state.foodLog.entries[0].proteinPerPortion,9);assert.equal(add(a,'repair').status,'alreadyAdded');}
  }
});
test('pending eaten cards stay private to owner and destination, without invented nutrition',()=>{
  const a=boot();a.run('recordHistory',event('queued',{status:'pending',processingState:'queued',product:null}));
  const rows=copy(a.api.project('pendingEaten',{day,ownerKey:owner}).rows);assert.equal(rows.length,1);assert.match(rows[0].status,/Analysing/);assert.equal(rows[0].nutritionSnapshot,undefined);
  assert.equal(a.api.project('today').entryCount,0);assert.equal(a.api.project('pendingEaten',{day:'2026-10-13',ownerKey:owner}).rows.length,0);assert.equal(a.api.project('pendingEaten',{day,ownerKey:'cd'.repeat(32)}).rows.length,0);
  a.run('recordHistory',{id:'queued',diaryAddState:'cancelled'});assert.equal(a.api.project('pendingEaten',{day,ownerKey:owner}).rows.length,0);
});


test('stale pending Delete removes only the intake created by that exact capture, keeping replay claim',()=>{
  const a=boot();a.run('recordHistory',event());add(a);const claim=copy(a.snapshot().state.captureIntakeClaims['capture-1']);
  const historyBefore=a.values.get(archive);a.io.length=0;
  const result=a.run('captureRemoveIntake',{eventID:'capture-1',generation:0,ownerKey:owner});
  assert.equal(result.ok,true);assert.equal(a.snapshot().state.foodLog.entries.length,0);assert.deepEqual(a.snapshot().state.captureIntakeClaims['capture-1'],claim);
  assert.equal(a.values.get(archive),historyBefore);assert.deepEqual(a.io.filter(r=>r.operation==='set').map(r=>r.key),[main]);assert.equal(add(a).status,'cancelled');
});
test('stale pending Delete rejects wrong identities and preserves repairs or replacement source',()=>{
  for(const mode of ['owner','generation','repair','source','missing-claim']){
    const a=boot();a.run('recordHistory',event());add(a);const before=a.snapshot();
    if(mode==='repair')a.run('recordHistory',{id:'capture-1',repairEntryId:before.state.foodLog.entries[0].id});
    if(mode==='source'||mode==='missing-claim'){
      const mainValue=JSON.parse(a.values.get(main));
      if(mode==='source')mainValue.foodLog.entries[0].sourceMeta.scanEventId='replacement-source';
      else delete mainValue.captureIntakeClaims;
      a.values.set(main,JSON.stringify(mainValue));a.api.init();
    }
    const current=a.snapshot().state;
    const result=a.run('captureRemoveIntake',{eventID:'capture-1',generation:mode==='generation'?1:0,ownerKey:mode==='owner'?'cd'.repeat(32):owner});
    assert.equal(result.ok,!['owner','generation'].includes(mode),mode);assert.deepEqual(a.snapshot().state,current,mode);
  }
});
test('failed raced Delete preserves intake and retries only its local diary write',()=>{
  const a=boot();a.run('recordHistory',event());add(a);const before=a.snapshot().state;a.fail(main);
  const payload={eventID:'capture-1',generation:0,ownerKey:owner};
  assert.equal(a.run('captureRemoveIntake',payload).ok,false);assert.deepEqual(a.snapshot().state,before);
  a.fail('');assert.equal(a.run('captureRemoveIntake',payload).ok,true);assert.equal(a.snapshot().state.foodLog.entries.length,0);
});
