// Read-only personal scan totals from the actual native History adapter.
// Fixtures contain no real accounts, meals, photos or remote requests.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const copy=value=>JSON.parse(JSON.stringify(value));
const now=Date.parse('2026-10-14T12:00:00Z'),joined=Date.parse('2026-10-05T12:00:00Z'),owner='ab'.repeat(32);
const historyKey='nudge-scan-history-v1';
const files=['streaks.js','recipe-catalogue-data.js','recipe-catalogue.js','core/food-log.js','core/diary.js','core/nutrition-profile.js','core/product-evidence.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','core/analysis-result.js','scan-results.js','today-goals.js','cycle-support.js','search-model.js','diet.js','scan-history.js','repertoire.js','native-review.js','native-session.js','food-catalogue.js'];
const photo=n=>'nudge-photo:11111111-1111-4111-8111-'+String(n).padStart(12,'0')+'.jpg';
const row=(id,extra={})=>({id,createdAt:'2026-10-14T11:00:00Z',kind:'product',status:'ready',captureOwnerKey:owner,captureID:'11111111-1111-4111-8111-111111111111',processingState:'complete',barcode:'12345678',product:{name:'Synthetic product',barcode:'12345678',nutrients:{}},...extra});
const totals=(extra={})=>({captured:0,ready:0,pending:0,needsInput:0,failed:0,products:0,photos:0,readyProducts:0,...extra});
function boot(events=[],deleted=[]){
 const io=[],values=new Map([[historyKey,JSON.stringify({version:3,events,deleted,generations:{},favourites:[]})]]);
 const scope={console,Date,Math,JSON,URL,document:{addEventListener(){},getElementById(){return null;}},location:{protocol:'native:'},nativeToday:()=> '2026-10-14',nativeNow:()=>new Date(now).toISOString(),nativeDiagnostic(){},nativeStorage:input=>{
   const request=JSON.parse(input);io.push(request);
   if(request.operation==='get')return JSON.stringify({ok:true,value:values.get(request.key)??null});
   if(request.operation==='set')values.set(request.key,request.value);else if(request.operation==='remove')values.delete(request.key);else throw Error('Unexpected storage operation');
   return '{"ok":true}';
 }};
 scope.window=scope;vm.createContext(scope);
 for(const file of files)vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),scope,{filename:file});
 const api=scope.NudgeNativeSession;assert.equal(api.init().readFailed,false);io.length=0;
 return {api,io,values,scope,activity:(p={})=>copy(api.project('ambassadorActivity',{ownerKey:owner,joinedAt:joined,...p}))};
}
test('104 repeated barcodes count one local lap without writes, scores, food details or points',()=>{
 const a=boot(Array.from({length:104},(_,i)=>row('duplicate-'+i,{status:i<62?'ready':'pending',processingState:i<62?'complete':'queued',product:i<62?row('').product:null})));
 a.scope.NudgeFoodDetailModel.score=()=>{throw Error('Progress cannot calculate scores');};
 const result=a.activity();
 assert.equal(result.available,true);assert.equal(result.weekStartsAt,Date.parse('2026-10-12T00:00:00Z'));
 assert.deepEqual(result.week,totals({captured:1,ready:1,products:1,readyProducts:1}));assert.deepEqual(result.all,result.week);
 assert.deepEqual(a.io,[],'Projection only reads in-memory acknowledged History');
 assert.doesNotMatch(JSON.stringify(result),/12345678|Synthetic|captureOwner|barcode|profile|points|photos:/);
});
test('photo groups, retry refinements and statuses remain distinct from completed products',()=>{
 const a=boot([
   row('photo-pending',{barcode:'',kind:'meal',status:'pending',processingState:'processing',product:null,photos:[photo(1),photo(2)]}),
   row('photo-refined',{barcode:'',kind:'meal',status:'ready',processingState:'complete',product:null,photos:[photo(2),photo(1)],extraction:{type:'meal',meal:{name:'Synthetic meal'}}}),
   row('photo-input',{barcode:'',kind:'meal',status:'unknown',processingState:'needsUserInput',product:null,photos:[photo(3)]}),
   row('product-pending',{barcode:'22345678',status:'pending',processingState:'queued',product:null}),
   row('product-failed',{barcode:'32345678',status:'failed',processingState:'retryableFailure',product:null}),
   row('not-really-ready',{barcode:'42345678',status:'ready',processingState:'complete',product:null})
 ]);
 assert.deepEqual(a.activity().week,totals({captured:5,ready:1,pending:1,needsInput:1,failed:2,products:3,photos:2}));
});
test('owner, join, tombstone, search, future and unsent-draft fences exclude unrelated activity',()=>{
 const a=boot([
   row('valid'),row('other-owner',{barcode:'22345678',captureOwnerKey:'cd'.repeat(32)}),
   row('before-join',{barcode:'32345678',createdAt:'2026-10-01T00:00:00Z'}),
   row('future',{barcode:'42345678',createdAt:'2026-10-15T00:00:00Z'}),
   row('deleted',{barcode:'52345678'}),row('search',{barcode:'62345678',origin:'search'}),
   row('legacy',{barcode:'72345678',captureOwnerKey:undefined}),row('missing-capture',{barcode:'82345678',captureID:''}),
   row('draft',{barcode:'',photos:[photo(4)],processingState:'draft',status:'pending',product:null}),
   row('no-photos',{barcode:'',photos:[],processingState:'queued',status:'pending',product:null}),
   row('unknown-state',{barcode:'92345678',processingState:'madeUp'})
 ],['deleted']);
 assert.deepEqual(a.activity().all,totals({captured:1,ready:1,products:1,readyProducts:1}));
 for(const p of [{ownerKey:''},{ownerKey:'local-guest'},{joinedAt:0},{joinedAt:NaN},{joinedAt:now+1}])assert.deepEqual(a.activity(p),{available:false});
 assert.deepEqual(a.activity({ownerKey:'ef'.repeat(32)}).all,totals());
 assert.equal(a.values.get(historyKey).includes('before-join'),true,'No cleanup or retrospective awards');
});
test('UTC weekly totals dedupe within each week and all-time once per product',()=>{
 const a=boot([
   row('last-week',{createdAt:'2026-10-11T23:59:59Z'}),row('same-this-week',{createdAt:'2026-10-12T00:00:00Z'}),
   row('last-week-only',{barcode:'22345678',createdAt:'2026-10-11T23:59:59Z'})
 ]);
 assert.equal(a.activity().week.readyProducts,1);assert.equal(a.activity().all.readyProducts,2);
 assert.deepEqual(a.activity({joinedAt:Date.parse('2026-10-12T00:00:01Z')}).all,totals(),'Rejoining never recovers pre-join scan laps');
});
test('a newly persisted scan appears before analysis and moves to ready on completion',()=>{
 const a=boot();assert.equal(a.activity().week.captured,0);
 assert.equal(a.api.perform('recordHistory',row('new',{status:'pending',processingState:'queued',product:null})).ok,true);
 assert.equal(a.activity().week.pending,1);assert.equal(a.activity().week.ready,0);
 assert.equal(a.api.perform('recordHistory',{id:'new',status:'ready',processingState:'complete',product:row('').product}).ok,true);
 assert.equal(a.activity().week.captured,1);assert.equal(a.activity().week.ready,1);assert.equal(a.activity().week.pending,0);
 assert.equal(a.api.perform('historyDelete',{id:'new',keepIntake:true}).ok,true);
 assert.deepEqual(a.activity().week,totals(),'Deleted private source records do not remain as fabricated scan totals');
});
