const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('Web/storage.js','utf8'),diagnostics=fs.readFileSync('Web/diagnostics.js','utf8');
const main='wmd-nudge-prototype-v1';
function setup({native=true,legacy={},records={},fail=false}={}){
  const browser=new Map(Object.entries(legacy)),disk=new Map(Object.entries(records)),events=[];
  const window={__nudgePrivateStorage:native,NudgeDiagnostics:{record:(...a)=>events.push(a)},localStorage:{getItem:k=>browser.get(k)??null,setItem:()=>{throw Object.assign(Error(),{name:'QuotaExceededError'})},removeItem:k=>browser.delete(k)},prompt:(marker,raw)=>{
    assert.equal(marker,'__NUDGE_PRIVATE_STORAGE_V1__');const {operation,key,value}=JSON.parse(raw);
    if(fail&&operation!=='get')return JSON.stringify({ok:false,error:'native_write'});
    if(operation==='get'||operation==='import'&&disk.has(key))return JSON.stringify({ok:true,exists:disk.has(key),value:disk.get(key)??null});
    disk.set(key,operation==='remove'?null:value);return JSON.stringify({ok:true,exists:true,value:operation==='import'?value:null});
  }};
  vm.runInNewContext(source,{window,TextEncoder});return {storage:window.NudgeStorage,browser,disk,events};
}
test('native storage imports exact legacy bytes, survives full browser storage, preserves reset tombstone',()=>{
  const value='{"version":1,"foodLog":{"entries":[{"id":"keep"}]}}',s=setup({legacy:{[main]:value}});
  assert.equal(s.storage.getItem(main),value);assert.equal(s.disk.get(main),value);assert.equal(s.browser.get(main),value);
  s.storage.setItem(main,'{"version":1,"new":true}');assert.equal(s.disk.get(main),'{"version":1,"new":true}');
  s.storage.removeItem(main);assert.equal(s.storage.getItem(main),null);assert.equal(s.browser.get(main),value);
  assert.equal(setup({legacy:{[main]:value},records:{[main]:null}}).storage.getItem(main),null);
});
test('existing native records take precedence without touching legacy source',()=>{
  const s=setup({legacy:{[main]:'{"old":true}'},records:{[main]:'{"new":true}'}});
  assert.equal(s.storage.getItem(main),'{"new":true}');assert.equal(s.browser.get(main),'{"old":true}');
});
test('failed native import/write cannot report saved or overwrite legacy',()=>{
  const s=setup({legacy:{[main]:'{"version":1}'},fail:true});
  assert.throws(()=>s.storage.getItem(main));assert.throws(()=>s.storage.setItem(main,'{}'));
  assert.equal(s.disk.size,0);assert.equal(s.browser.get(main),'{"version":1}');
  assert.equal(s.events.some(e=>e[1]==='saved'),false);
});
test('unreadable data is preserved instead of replacing with defaults',()=>{
  const s=setup({legacy:{[main]:'corrupt data'}});assert.throws(()=>s.storage.getItem(main));assert.throws(()=>s.storage.setItem(main,'{}'));assert.equal(s.disk.size,0);assert.equal(s.browser.get(main),'corrupt data');
  assert.equal(s.events[0][1],'parse_failed');
});
test('browser preview quota is distinguished and never acknowledged as saved',()=>{
  const s=setup({native:false});assert.throws(()=>s.storage.setItem(main,'{}'));
  assert.equal(s.events.at(-1)[1],'quota_exceeded');assert.equal(s.events.at(-1)[2].errorClass,'quota');
});
test('diagnostics strips all free-form fields and deduplicates recalculation noise',()=>{
  const events=[],listeners={},window={addEventListener:(k,v)=>listeners[k]=v,webkit:{messageHandlers:{nudgeBarcode:{postMessage:e=>events.push(e)}}}};
  vm.runInNewContext(diagnostics,{window,document:{addEventListener:()=>{}},navigator:{onLine:true}});
  const secret='personal transcript';
  window.NudgeDiagnostics.record('nutrition','incomplete',{entryCount:3,knownNutrientCount:2,food:secret,stack:secret,screen:secret,operation:'calculate'});
  window.NudgeDiagnostics.record('nutrition','incomplete',{entryCount:3,knownNutrientCount:2,operation:'calculate'});
  listeners.error({message:secret,error:{stack:secret}});listeners.unhandledrejection({reason:secret});
  assert.equal(events.filter(e=>e.stage==='nutrition').length,1);
  assert.equal(JSON.stringify(events).includes(secret),false);
  assert.equal(window.NudgeDiagnostics.record('http_response','received',{status:200}),false);
});

test('diagnostic failure cannot undo or falsely fail an acknowledged write',()=>{
  const values=new Map(),window={localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},NudgeDiagnostics:{record:()=>{throw Error('diagnostic unavailable')}}};
  vm.runInNewContext(source,{window}); // Older test/embedded runtimes may omit TextEncoder.
  assert.doesNotThrow(()=>window.NudgeStorage.setItem(main,'{"version":1}'));
  assert.equal(window.NudgeStorage.getItem(main),'{"version":1}');
});
