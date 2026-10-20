// Destructive-history checks use isolated storage and synthetic intake only.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {boot}=require('./label-photo.test.cjs');
const source=fs.readFileSync(path.join(__dirname,'../Web/scan-history.js'),'utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
function setup(entries=[],storage=new Map()){
  const app=boot(entries);let historyWrites=0,failAt=0,failAll=false,confirmation=null,closed=0;
  app.sandbox.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>{historyWrites++;if(failAll||historyWrites===failAt)throw Error('Full');storage.set(key,value);},removeItem:key=>storage.delete(key)};
  vm.runInContext(source,app.sandbox);
  app.sandbox.NudgeHistory=app.sandbox.createNudgeHistory({...app.ctx,showDialog:(title,html,options)=>confirmation={title,html,options},closeDialog:()=>closed++});
  const history=app.sandbox.NudgeHistory;
  const request=id=>history.handleAction('history-delete',id);
  const confirm=(keep=false)=>history.handleAction(keep?'history-delete-only':'history-delete-confirm');
  return {...app,history,storage,request,confirm,confirmation:()=>confirmation,closed:()=>closed,failHistory:value=>failAll=value,failNextHistory:(offset=1)=>failAt=historyWrites+offset};
}
const product={name:'Synthetic beans',barcode:'12345678',basisUnit:'g',nutritionPreparation:'as_sold',nutriScoreGrade:'b',ingredients:'Chickpeas, tomato.',nutrients:{energyKcal:{value:100},protein:{value:8},fibre:{value:6},salt:{value:.3}}};
const record={id:'scan-a',createdAt:'2026-10-01T10:00:00Z',kind:'product',status:'ready',name:product.name,product};
const meal={id:'meal-a',name:'Synthetic meal',day:'2026-10-01',slot:'Lunch',portions:1,plants:['chickpea','tomato'],ferments:[],energyPerPortion:200,proteinPerPortion:16,fibrePerPortion:null,portionAmount:200,portionUnit:'g'};
const remove=(app,id,keep=false)=>{app.request(id);app.confirm(keep);};

// Delete exposes a labelled non-gesture action; opening confirmation changes nothing.
const scan=setup([meal]);scan.history.record(record);const before=copy(scan.data.foodLog);
assert.match(scan.history.screen(),/n-history-swipe/);assert.match(scan.history.screen(),/aria-label="Delete Synthetic beans"/);
scan.request(record.id);assert.match(scan.confirmation().html,/intake will not change/);assert.equal(scan.confirmation().options.closeLabel,'Cancel');assert.equal(scan.confirmation().options.focusClose,true);assert.equal(scan.history.items().length,2);
scan.confirm();assert.equal(scan.history.find(record.id),undefined);assert.deepEqual(copy(scan.data.foodLog),before);assert.equal(scan.writes(),0);assert.equal(scan.history.isDeleted(record.id),true);assert.match(scan.history.screen(),/history-undo/);assert.equal(scan.closed(),1);
assert.equal(scan.history.record({...record,name:'Late response'}),null);scan.history.link(record.id,meal.id);assert.equal(scan.history.find(record.id),undefined);
const scanReload=setup(scan.data.foodLog.entries,scan.storage);assert.equal(scanReload.history.isDeleted(record.id),true);assert.equal(scanReload.history.items().length,1);scanReload.history.handleAction('history-undo');scanReload.history.handleAction('history-undo');assert.equal(scanReload.history.items().length,2);assert.deepEqual(copy(scanReload.history.find(record.id).product),product);assert.deepEqual(copy(scanReload.data.foodLog),before);

// Source scan and first confirmed portion share a row; deletion makes intake handling explicit.
const portion={...meal,id:'food:scan-a',sourceMeta:{entryKind:'product-consumption',confirmationId:'food:scan-a',scanEventId:'scan-a',productScanEventId:'scan-a',consumedAt:'2026-10-01T10:30:00Z'}};
const productScan=setup([portion]);productScan.history.record({...record,entryId:portion.id});assert.equal(productScan.history.items().length,1);
const exact=copy(productScan.data.foodLog.entries[0]);const dailyBefore=copy(productScan.sandbox.NudgeNutrition.summary(productScan.data.foodLog.entries,'2026-10-01'));
remove(productScan,record.id,true);assert.match(productScan.confirmation().html,/Delete history only/);assert.equal(productScan.data.foodLog.entries.length,1);assert.equal(productScan.history.items()[0].id,'diary:'+portion.id);assert.equal(productScan.history.find(record.id),undefined);
productScan.history.handleAction('history-undo');assert.equal(productScan.history.items().length,1);assert.equal(productScan.history.find(record.id).entryId,portion.id);
remove(productScan,record.id);assert.match(productScan.confirmation().html,/Delete history and intake/);assert.equal(productScan.data.foodLog.entries.length,0);assert.equal(productScan.history.items().length,0);assert.equal(productScan.sandbox.NudgeNutrition.summary(productScan.data.foodLog.entries,'2026-10-01').calories,0);
productScan.history.handleAction('history-undo');productScan.history.handleAction('history-undo');assert.deepEqual(copy(productScan.data.foodLog.entries),[exact]);assert.equal(productScan.history.find(record.id).entryId,portion.id);assert.deepEqual(copy(productScan.sandbox.NudgeNutrition.summary(productScan.data.foodLog.entries,'2026-10-01')),dailyBefore);

// Joined photo meal: history-only deletion retains an intake-only row and cannot restore its scan.
const photoMeal={...meal,sourceMeta:{scanEventId:'photo-a',confirmationId:'photo-a',nutritionEstimate:'photo',photoPortions:'1.5'}};
const photoRecord={...record,id:'photo-a',kind:'meal',entryId:meal.id,extraction:{type:'meal',meal:{name:meal.name,portion:{amount:200,unit:'g'}}}};
for(const keep of [true,false]){
  const app=setup([photoMeal]);app.history.record(photoRecord);const saved=copy(app.data.foodLog.entries[0]);remove(app,photoRecord.id,keep);
  assert.match(app.confirmation().html,/Delete history only/);assert.match(app.confirmation().html,/Delete history and intake/);assert.equal(app.data.foodLog.entries.length,keep?1:0);assert.equal(app.history.items().length,keep?1:0);assert.equal(app.history.isEntryDeleted(meal.id),true);
  const reload=setup(app.data.foodLog.entries,app.storage);assert.equal(reload.history.items().length,keep?1:0);reload.history.record({...photoRecord,status:'ready'});assert.equal(reload.history.items().length,keep?1:0);assert.equal(reload.history.find(photoRecord.id),undefined);if(keep){assert.equal(reload.history.items()[0].id,'diary:'+meal.id);reload.history.handleAction('history-filter','eaten');assert.equal(reload.history.items().length,1);reload.history.handleAction('history-filter','all');}
  reload.history.handleAction('history-undo');reload.history.handleAction('history-undo');assert.equal(reload.history.items().length,1);assert.deepEqual(copy(reload.data.foodLog.entries),[saved]);assert.equal(reload.history.items()[0].entry.id,meal.id);
}
// Original legacy entries get the same exact, one-time Undo including unknown values.
const legacy=setup([meal]);const legacyExact=copy(legacy.data.foodLog.entries[0]);remove(legacy,'diary:'+meal.id);assert.equal(legacy.data.foodLog.entries.length,0);const legacyReload=setup([],legacy.storage);legacyReload.history.handleAction('history-undo');assert.deepEqual(copy(legacyReload.data.foodLog.entries),[legacyExact]);assert.equal(legacyReload.data.foodLog.entries[0].fibrePerPortion,null);

// Failure before the deletion journal persists is a no-op, with a visible retry.
const full=setup([meal]);full.failHistory(true);remove(full,'diary:'+meal.id);assert.equal(full.data.foodLog.entries.length,1);assert.equal(full.history.items().length,1);assert.equal(full.history.isEntryDeleted(meal.id),false);assert.equal(full.history.isSaved(),false);full.failHistory(false);full.history.handleAction('history-save');assert.equal(full.history.isSaved(),true);
// A diary write failure leaves a retryable journal, never a false successful total.
const intakeFail=setup([meal]);intakeFail.canSave(false);remove(intakeFail,'diary:'+meal.id);assert.equal(intakeFail.data.foodLog.entries.length,1);const beforeReopen=JSON.stringify(intakeFail.view);intakeFail.history.reopen('diary:'+meal.id);assert.equal(JSON.stringify(intakeFail.view),beforeReopen,'A stale button cannot reopen intake whose deletion is still pending');assert.match(intakeFail.history.screen(),/Deletion needs another try/);assert.equal(JSON.parse(intakeFail.storage.get(intakeFail.history._key)).undo.phase,'remove');intakeFail.history.handleAction('history-undo');assert.equal(intakeFail.data.foodLog.entries.length,1);assert.equal(intakeFail.history.items().length,1);
// A restarted pending deletion finishes once; it cannot remove an unrelated meal.
const pending=setup([meal,{...meal,id:'unrelated',plants:['oat']}]);pending.canSave(false);remove(pending,'diary:'+meal.id);const recovered=setup(pending.data.foodLog.entries,pending.storage);assert.deepEqual(Array.from(recovered.data.foodLog.entries.map(x=>x.id)),['unrelated']);assert.equal(JSON.parse(recovered.storage.get(recovered.history._key)).undo.phase,'deleted');recovered.history.handleAction('history-undo');assert.equal(recovered.data.foodLog.entries.length,2);
// Crash-equivalent failure after the diary saved but before final History write.
const finalWrite=setup([meal]);finalWrite.failNextHistory(2);remove(finalWrite,'diary:'+meal.id);assert.equal(finalWrite.data.foodLog.entries.length,0);assert.equal(JSON.parse(finalWrite.storage.get(finalWrite.history._key)).undo.phase,'remove');const finalReload=setup([],finalWrite.storage);assert.equal(finalReload.data.foodLog.entries.length,0);finalReload.history.handleAction('history-undo');assert.equal(finalReload.data.foodLog.entries.length,1);
// Undo never overwrites later edits to an intake record hidden from History.
const conflict=setup([meal]);conflict.canSave(false);remove(conflict,'diary:'+meal.id);conflict.data.foodLog.entries[0].name='Edited elsewhere';conflict.canSave(true);conflict.history.handleAction('history-undo');assert.equal(conflict.data.foodLog.entries[0].name,'Edited elsewhere');assert.match(conflict.toasts.at(-1),/will not overwrite/);
// Dismissing Undo does not discard deletion tombstones, nor do later scans.
const dismissed=setup();dismissed.history.record(record);remove(dismissed,record.id);dismissed.history.handleAction('history-dismiss-undo');dismissed.history.record({...record,id:'new-scan'});assert.equal(dismissed.history.record(record),null);assert.equal(JSON.parse(dismissed.storage.get(dismissed.history._key)).undo,null);assert.equal(dismissed.history.items().length,1);
// The native action uses the same journal: dismiss must survive a restart and
// must never restore a scan or intake, including a later accidental Undo call.
for(const keep of [true,false]){
  const app=setup([portion]);app.history.record({...record,entryId:portion.id});
  assert.equal(app.history.nativeDelete(record.id,keep),true);
  app.history.handleAction('history-dismiss-undo');
  assert.equal(app.history.undoDelete(),false);assert.equal(app.history.find(record.id),undefined);
  const restart=setup(app.data.foodLog.entries,app.storage);
  assert.equal(restart.history.undoDelete(),false);assert.equal(restart.history.find(record.id),undefined);
  assert.equal(restart.history.isDeleted(record.id),true);assert.equal(restart.history.record(record),null);
  assert.equal(restart.data.foodLog.entries.length,keep?1:0);
  assert.equal(restart.history.items().length,keep?1:0);
  assert.equal(JSON.parse(restart.storage.get(restart.history._key)).undo,null);
}
// A failed dismissal keeps Undo available without restoring anything; retrying
// only clears that journal after the deletion itself is already durable.
const dismissFailure=setup();dismissFailure.history.record(record);remove(dismissFailure,record.id);
dismissFailure.failHistory(true);dismissFailure.history.handleAction('history-dismiss-undo');
assert.equal(dismissFailure.history.find(record.id),undefined);assert.equal(dismissFailure.history.nativeProjection().undo.phase,'deleted');
dismissFailure.failHistory(false);dismissFailure.history.handleAction('history-dismiss-undo');
assert.equal(dismissFailure.history.undoDelete(),false);assert.equal(setup([],dismissFailure.storage).history.find(record.id),undefined);
// A stale native result or confirmation cannot resurrect a deleted product draft.
const stale=setup();stale.sandbox.NudgeBarcode.receive({type:'product',eventId:record.id,product});remove(stale,record.id);stale.sandbox.NudgeBarcode.receive({type:'product',eventId:record.id,product});stale.sandbox.NudgeBarcode.handleAction('detail-log');assert.equal(stale.history.items().length,0);assert.equal(stale.data.foodLog.entries.length,0);
// Undo restores evidence, never the pre-deletion job generation.
const restored=setup();restored.controller.begin();const draft=restored.controller._state.confirmationId,request=restored.controller._state.requestId;restored.controller.receive({type:'loading',draftId:draft,requestId:request,photoCount:1});const generation=restored.history.generation(draft);remove(restored,draft);restored.history.handleAction('history-undo');assert.equal(restored.history.find(draft).status,'failed');assert.equal(restored.history.isCurrent(draft,generation),false);assert.equal(restored.history.record({id:draft,generation,status:'ready',name:'Old response'}),null);restored.controller.receive({type:'result',draftId:draft,requestId:request,result:{extraction:{type:'product',productName:'Stale product',nutrients:{}}}});assert.equal(restored.history.find(draft).status,'failed');const restoredReload=setup([],restored.storage);assert.equal(restoredReload.history.isCurrent(draft,generation),false);assert.equal(restoredReload.history.generation(draft),generation+1);
console.log('Passed: History deletion confirmations, persistent Undo, exact intake and unknown-value restoration, independent scans/portions, hidden legacy fallback, durable tombstones, stale result guards, interrupted writes, retry/restart and duplicate prevention.');
