// Real SwiftUI domain adapter, storage, history, catalogue and scoring modules.
// Synthetic product fixtures only; no provider requests or owner data.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const copy=value=>JSON.parse(JSON.stringify(value));
const web=path.resolve(__dirname,'../Web');
const mainKey='wmd-nudge-prototype-v1',historyKey='nudge-scan-history-v1';
const initialTime=Date.parse('2026-10-07T12:00:00Z');
const files=['streaks.js','recipe-catalogue-data.js','recipe-catalogue.js','core/food-log.js','core/diary.js','core/nutrition-profile.js','core/product-evidence.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','core/analysis-result.js','scan-results.js','today-goals.js','cycle-support.js','search-model.js','diet.js','scan-history.js','repertoire.js','native-review.js','native-session.js','food-catalogue.js'];
function boot(values=new Map(),clock=initialTime){
  let now=clock;const writes=[],diagnostics=[];
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const s={console,Date:Clock,Math,JSON,URL,document:{addEventListener(){},getElementById(){return null;}},location:{protocol:'native:'},
    nativeToday:()=>new Clock().toISOString().slice(0,10),nativeNow:()=>new Clock().toISOString(),
    nativeDiagnostic:(...args)=>diagnostics.push(args),nativeStorage:request=>{
      const r=JSON.parse(request);
      if(r.operation==='get')return JSON.stringify({ok:true,value:values.get(r.key)??null});
      if(r.operation==='set'){writes.push(r);values.set(r.key,r.value);return '{"ok":true}';}
      if(r.operation==='remove'){values.delete(r.key);return '{"ok":true}';}
      throw Error('Unexpected native storage operation');
    }};
  s.window=s;vm.createContext(s);
  for(const file of files)vm.runInContext(fs.readFileSync(path.join(web,file),'utf8'),s,{filename:file});
  const api=s.NudgeNativeSession;assert.equal(api.init().readFailed,false);
  const session={s,values,writes,diagnostics,api,model:s.NudgeFoodDetailModel,
    project:(op,p={})=>copy(api.project(op,p)),perform:(op,p={})=>copy(api.perform(op,p)),
    snapshot:()=>copy(api.snapshot()),advance:ms=>now+=ms,restart:()=>boot(values,now)};
  session.open=(product=partial,confirmationId='confirmation-1',eventId='scan-1')=>{
    assert.equal(session.perform('recordHistory',{id:eventId,kind:'product',status:'ready',name:product.name,barcode:product.barcode,product}).ok,true);
    assert.equal(session.perform('setReview',{kind:'product',product,confirmationId,eventId}).ok,true);
    return session.project('productRecovery');
  };
  session.apply=(request,result,recovery,extra={})=>session.perform('productRecoveryApply',{fingerprint:request.fingerprint,confirmationId:request.confirmationId,result,recovery,...extra});
  session.applyCache=request=>session.apply(request,request.cache.result,request.cache.recovery,{checkedAt:request.cache.checkedAt,catalogueCalculatedAt:request.cache.catalogueCalculatedAt,cacheReplay:true});
  return session;
}

const source={name:'Synthetic stored food',barcode:'12345678',nutrients:{}};
test('native capture metadata and logging destination survive restart and background completion',()=>{
 const a=boot(),id='native-photo:durable',created='2026-10-01T12:30:00.123Z',photo='nudge-photo:12345678-1234-1234-1234-123456789012.jpg';
 assert.equal(a.perform('recordHistory',{id,kind:'meal',status:'pending',createdAt:created,photos:[photo],loggingDay:'2026-10-01',loggingMeal:'Dinner',captureOwnerKey:'local-guest',captureID:'12345678-1234-1234-1234-123456789013',processingState:'processing'}).ok,true);
 const b=a.restart();assert.equal(b.perform('historyInterruptPending',{resumableIDs:[id]}).ok,true);
 let row=b.project('captureState',{id}).event;assert.equal(row.status,'pending');assert.equal(row.processingState,'processing');assert.equal(row.loggingDay,'2026-10-01');assert.deepEqual(row.photos,[photo]);
 assert.equal(b.project('recoverableCaptures').events.length,0);
 assert.equal(b.perform('recordHistory',{id,status:'ready',kind:'product',product:source,processingState:'complete'}).ok,true);
 row=b.project('captureState',{id}).event;assert.equal(row.createdAt,created);assert.equal(row.loggingMeal,'Dinner');assert.deepEqual(row.photos,[photo]);assert.deepEqual(b.snapshot().state.foodLog.entries,[]);
});
test('startup interrupts only orphan pending history and retains its photos',()=>{
 const a=boot(),photo='nudge-photo:12345678-1234-1234-1234-123456789012.jpg';
 for(const id of ['legacy','orphan','durable'])assert.equal(a.perform('recordHistory',{id,status:'pending',kind:'meal',photos:[photo],...(id==='legacy'?{}:{captureOwnerKey:'local-guest',processingState:'processing'})}).ok,true);
 assert.equal(a.perform('historyInterruptPending',{resumableIDs:['durable']}).ok,true);
 assert.equal(a.project('captureState',{id:'durable'}).event.status,'pending');
 for(const id of ['legacy','orphan']){const row=a.project('captureState',{id}).event;assert.equal(row.status,'failed');assert.equal(row.errorCode,'analysis_interrupted');assert.deepEqual(row.photos,[photo]);}
});
test('delete and Undo revoke the pending generation without discarding destination or photo refs',()=>{
 const a=boot(),id='native-photo:undo',photo='nudge-photo:12345678-1234-1234-1234-123456789012.jpg';
 assert.equal(a.perform('recordHistory',{id,status:'pending',kind:'meal',photos:[photo],captureOwnerKey:'local-guest',loggingDay:'2026-10-01',loggingMeal:'Lunch'}).ok,true);
 assert.equal(a.perform('historyDelete',{id,keepIntake:true}).ok,true);assert.equal(a.project('captureState',{id}).deleted,true);
 assert.equal(a.perform('historyUndo').ok,true);const row=a.project('captureState',{id}).event;
 assert.equal(row.status,'failed');assert.deepEqual(row.photos,[photo]);assert.equal(row.loggingMeal,'Lunch');
 assert.equal(a.perform('recordHistory',{id,generation:0,status:'ready',product:source}).ok,false);assert.deepEqual(a.snapshot().state.foodLog.entries,[]);
});
