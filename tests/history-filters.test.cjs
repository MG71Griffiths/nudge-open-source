// Real History controller with isolated synthetic records; never production data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const copy=x=>JSON.parse(JSON.stringify(x));
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function boot(entries=[],storage=new Map()){
  let diaryWrites=0,historyWrites=0,opened=null;const sandbox={console,Date,Math,document:{getElementById:()=>null},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>{historyWrites++;storage.set(k,v)},removeItem:k=>storage.delete(k)}};
  sandbox.window=sandbox;sandbox.NudgeIcons=()=>'';sandbox.NudgeBarcode={openStored:(row,options)=>opened={row,options}};sandbox.NudgeLabel={openStored:row=>opened={row}};vm.createContext(sandbox);
  for(const file of ['streaks.js','core/diary.js','core/food-log.js','food-patterns.js','scan-history.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),sandbox,{filename:file});
  const data={foodLog:sandbox.WmdFoodLog.clean({entries})};const history=sandbox.createNudgeHistory({getState:()=>data,view:{},escapeHtml:esc,todayKey:()=> '2026-10-04',render(){},navigate(){},showToast(){},save(){diaryWrites++;return true;}});
  return {data,history,storage,opened:()=>opened,writes:()=>({diaryWrites,historyWrites})};
}
const entry=(id,extra={})=>({id,name:id,day:'2026-10-04',slot:'Lunch',portions:1,plants:[],ferments:[],energyPerPortion:100,proteinPerPortion:5,fibrePerPortion:null,...extra});
const productEntry=(id,extra={})=>entry(id,{sourceMeta:{entryKind:'product-consumption',confirmationId:id,scanEventId:'barcode',productScanEventId:'barcode',consumedAt:'2026-10-04T12:00:00Z'},...extra});
const scan=(id,extra={})=>({id,name:id,kind:'product',status:'ready',createdAt:'2026-10-03T10:00:00Z',product:{name:id,nutrients:{}},...extra});
const a=boot([productEntry('first'),productEntry('second'),entry('photo',{sourceMeta:{confirmationId:'photo-scan',scanEventId:'photo-scan',nutritionEstimate:'photo'}}),entry('recipe',{recipe:'berry'}),entry('manual')]);
a.history.record(scan('barcode',{barcode:'12345678',entryId:'first'}));
a.history.record(scan('label',{extraction:{type:'product',nutrients:{}},photoCount:2}));
a.history.record(scan('photo-scan',{kind:'meal',product:null,photoCount:1,entryId:'photo',extraction:{type:'meal',meal:{name:'Meal fixture'}}}));
a.history.record(scan('unconfirmed-photo',{kind:'meal',product:null,photoCount:1,extraction:{type:'meal',meal:{name:'Unconfirmed fixture'}}}));
a.history.record(scan('failed-photo',{kind:'unknown',status:'failed',product:null,photoCount:1}));
a.history.record(scan('failed-barcode',{kind:'unknown',status:'failed',product:null,barcode:'87654321'}));
const filter=value=>{a.history.handleAction('history-filter',value);return Array.from(a.history.items());};
const ids=value=>filter(value).map(row=>row.id).sort();
const rows=ids('all');assert.equal(rows.length,9);assert.equal(new Set(rows).size,rows.length);assert.ok(rows.includes('barcode'));assert.ok(!rows.includes('diary:first'));assert.ok(rows.includes('diary:second'));assert.ok(!rows.includes('diary:photo'));
const html=a.history.screen();assert.deepEqual([...html.matchAll(/data-action="history-filter"[^>]*>([^<]+)</g)].map(m=>m[1]),['All','Scanned','Photos','Eaten']);assert.equal((html.match(/class="n-eaten-badge"/g)||[]).length,5);assert.equal((html.match(/✓ Eaten/g)||[]).length,5);
assert.deepEqual(ids('scanned'),['barcode','diary:second','failed-barcode','label']);
assert.deepEqual(ids('photos'),['failed-photo','photo-scan','unconfirmed-photo']);
assert.deepEqual(ids('eaten'),['barcode','diary:manual','diary:recipe','diary:second','photo-scan']);
assert.equal((a.history.screen().match(/class="n-eaten-badge"/g)||[]).length,5);assert.doesNotMatch(a.history.screen(),/data-value="(?:label|unconfirmed-photo|failed-photo|failed-barcode)"/);
assert.match(a.history.screen(),/<span>Today<\/span>/);assert.doesNotMatch(a.history.screen(),/<span>Yesterday<\/span>/,'Eaten groups by confirmed diary day, not the day its source was scanned');
a.history.reopen('barcode');assert.equal(a.opened().options.entryId,'first','Joined row reopens its exact intake even when later portions exist');
a.history.reopen('diary:second');assert.equal(a.opened().options.entryId,'second');
const before=JSON.stringify(a.data),stored=JSON.stringify([...a.storage]),writes=a.writes();for(let n=0;n<3;n++)for(const name of ['all','scanned','photos','eaten']){filter(name);a.history.screen();}assert.equal(JSON.stringify(a.data),before);assert.equal(JSON.stringify([...a.storage]),stored);assert.deepEqual(a.writes(),writes);assert.equal(writes.diaryWrites,0);
// Duplicate legacy IDs/confirmation callbacks cannot multiply displayed intake.
const duplicate=boot([entry('same'),entry('same'),entry('id-a',{sourceMeta:{confirmationId:'one-confirmation'}}),entry('id-b',{sourceMeta:{confirmationId:'one-confirmation'}})]);
assert.equal(duplicate.history.items().length,2);duplicate.history.handleAction('history-filter','eaten');assert.equal(duplicate.history.items().length,2);
// Existing manual barcode text is not evidence of a scanned event; photo/label metadata is.
const old=boot([entry('manual-code',{barcode:'12345678'}),entry('old-photo',{sourceMeta:{nutritionEstimate:'photo'}}),entry('old-label',{sourceMeta:{labelKind:'ingredients',provider:'User-confirmed label extraction'}})]);
old.history.handleAction('history-filter','scanned');assert.deepEqual(Array.from(old.history.items().map(x=>x.entry.id)),['old-label']);old.history.handleAction('history-filter','photos');assert.deepEqual(Array.from(old.history.items().map(x=>x.entry.id)),['old-photo']);old.history.handleAction('history-filter','eaten');assert.equal(old.history.items().length,3);
// Scanning/photographing alone never contributes intake, including after restart.
const onlyScans=boot();onlyScans.history.record(scan('only-barcode'));onlyScans.history.record(scan('only-photo',{kind:'meal',product:null,extraction:{type:'meal',meal:{name:'Photo fixture'}}}));onlyScans.history.handleAction('history-filter','eaten');assert.equal(onlyScans.history.items().length,0);assert.match(onlyScans.history.screen(),/No food added yet/);assert.equal(onlyScans.data.foodLog.entries.length,0);const reloaded=boot([],onlyScans.storage);reloaded.history.handleAction('history-filter','eaten');assert.equal(reloaded.history.items().length,0);assert.equal(reloaded.writes().diaryWrites,0);
// Deleting a joined source/intake row cannot remove a different confirmed portion.
const separate=boot([productEntry('first'),productEntry('second',{day:'2026-10-03'})]);
separate.history.record(scan('barcode',{barcode:'12345678',entryId:'first'}));const original=copy(separate.data.foodLog.entries);
separate.history.handleAction('history-delete','barcode');separate.history.handleAction('history-delete-confirm');
assert.deepEqual(Array.from(separate.data.foodLog.entries.map(e=>e.id)),['second']);assert.equal(separate.history.find('barcode'),undefined);assert.equal(separate.history.items().length,1);assert.equal(separate.history.items()[0].id,'diary:second');
assert.equal(separate.history.record(scan('barcode')),null,'Deleted source cannot reappear from a late response');
const undone=boot(copy(separate.data.foodLog.entries),separate.storage);undone.history.handleAction('history-undo');undone.history.handleAction('history-undo');
assert.deepEqual(copy(undone.data.foodLog.entries).sort((a,b)=>a.id.localeCompare(b.id)),original.sort((a,b)=>a.id.localeCompare(b.id)));assert.equal(undone.history.items().length,2);undone.history.handleAction('history-filter','eaten');assert.equal(undone.history.items().length,2);
const restarted=boot(copy(a.data.foodLog.entries),a.storage);restarted.history.handleAction('history-filter','eaten');assert.equal(restarted.history.items().length,5);assert.equal(restarted.data.foodLog.entries[0].fibrePerPortion,null);
console.log('Passed: All/Scanned/Photos/Eaten category overlap, exact consumed badges, source/intake deduplication, repeated independent portions, diary-day groups, original entry reopening, unknown preservation, restart and read-only filters without automatic intake.');
