// Synthetic records only: verify bounded joins without timing-dependent limits.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const copy=value=>JSON.parse(JSON.stringify(value));
const day='2026-10-11',oldDay='2026-10-10';
const entry=(id,eventID,extra={})=>({id,name:id,day,slot:'Lunch',portions:1,plants:[],ferments:[],energyPerPortion:100,proteinPerPortion:5,fibrePerPortion:null,sourceMeta:{entryKind:'product-consumption',productScanEventId:eventID,consumedAt:day+'T12:00:00Z'},...extra});
const scan=(id,extra={})=>({id,name:id,kind:'product',status:'ready',createdAt:oldDay+'T10:00:00Z',product:{name:id,nutrients:{}},...extra});
function boot(events,entries,extra={}){
  let historyWrites=0,diaryWrites=0,scores=0;
  const storage=new Map([['nudge-scan-history-v1',JSON.stringify({version:3,events,favourites:[],...extra})]]);
  const s={console,Date,Math,document:{getElementById:()=>null},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>{historyWrites++;storage.set(key,value);},removeItem:key=>storage.delete(key)}};
  s.window=s;vm.createContext(s);
  for(const file of ['streaks.js','core/diary.js','core/food-log.js','scan-history.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),s,{filename:file});
  const state={foodLog:s.WmdFoodLog.clean({entries})};
  s.NudgeDiet={scoreResultForEntry(){scores++;return {score:null,saved:false};}};
  const history=s.createNudgeHistory({getState:()=>state,view:{},escapeHtml:String,todayKey:()=>day,render(){},navigate(){},showToast(){},save(){diaryWrites++;return true;}});
  return {s,history,state,storage,scores:()=>scores,writes:()=>({historyWrites,diaryWrites})};
}

test('indexed History links preserve explicit source precedence, fallback order and exact preferred portion',()=>{
  const events=[scan('source-a',{entryId:'preferred'}),scan('fallback',{entryId:'fallback-entry'}),scan('fallback-second',{entryId:'fallback-entry'}),scan('source-a',{entryId:'duplicate-linked',product:{name:'Duplicate source evidence',nutrients:{}}})];
  const a=boot(events,[entry('first','source-a'),entry('preferred','source-a'),entry('fallback-entry','missing'),entry('duplicate-linked','missing'),entry('confirmation-only',null,{sourceMeta:{confirmationId:'fallback'}})]);
  const rows=a.history.items(),byID=new Map(rows.map(row=>[row.id,row]));
  assert.equal(byID.get('source-a').entry.id,'preferred');
  assert.equal(byID.get('source-a').name,'source-a','First source evidence wins duplicate IDs');
  assert.equal(byID.get('fallback').entry.id,'fallback-entry','First fallback record retains its preferred portion');
  assert.equal(byID.get('fallback-second').entry,undefined);
  assert.equal(byID.get('diary:first').product.name,'source-a');
  assert.equal(byID.get('diary:duplicate-linked').product.name,'Duplicate source evidence','A fallback can refer to a later duplicate record without changing the displayed first source');
  assert.equal(byID.get('diary:confirmation-only').product.name,'fallback');
  assert.equal(rows.length,6);
  assert.deepEqual(a.writes(),{historyWrites:0,diaryWrites:0});
});

test('projection indices honour tombstones and rebuild after link changes and undo',()=>{
  const a=boot([scan('deleted-source',{entryId:'retained'}),scan('fallback',{entryId:'retained'}),scan('other')],
    [entry('retained','deleted-source'),entry('later','other')],{deleted:['deleted-source','diary:retained']});
  assert.equal(a.history.items().find(row=>row.id==='fallback').entry.id,'retained','History-only deletion still shows retained intake');
  assert.equal(a.history.items().some(row=>row.id==='deleted-source'),false);
  a.history.nativeDelete('fallback',false);
  assert.equal(a.history.items().some(row=>row.entry?.id==='retained'),false);
  a.history.undoDelete();
  assert.equal(a.history.items().find(row=>row.id==='fallback').entry.id,'retained');
  a.history.unlink('fallback','retained');
  assert.equal(a.history.items().find(row=>row.id==='diary:retained').entry.id,'retained');
  a.history.link('other','retained');
  assert.equal(a.history.items().find(row=>row.id==='other').entry.id,'retained');
  assert.equal(a.history.items().find(row=>row.id==='diary:later').entry.id,'later');
});

test('History source metadata work grows linearly across an entire synthetic diary',()=>{
  const size=240,a=boot(Array.from({length:size},(_,i)=>scan('scan-'+i)),Array.from({length:size},(_,i)=>entry('entry-'+i,'scan-'+i)));
  let metadataReads=0;
  for(const row of a.state.foodLog.entries){const meta=row.sourceMeta;Object.defineProperty(row,'sourceMeta',{enumerable:true,get(){metadataReads++;return meta;}});}
  const rows=a.history.items();
  assert.equal(rows.length,size);
  assert.equal(rows.every(row=>row.entry.id==='entry-'+row.id.slice(5)),true);
  assert.ok(metadataReads<=size*8,`Expected bounded joining work; observed ${metadataReads} source metadata reads for ${size} records`);
  assert.deepEqual(a.writes(),{historyWrites:0,diaryWrites:0});
});

test('dated native projection scores only the selected day and preserves filtered projection byte-for-byte',()=>{
  const events=[scan('shared',{entryId:'old-portion'}),scan('today'),scan('tomorrow')];
  const entries=[entry('old-portion','shared',{day:oldDay}),entry('today-repeat','shared'),entry('today-portion','today'),entry('future-portion','tomorrow',{day:'2026-10-12'})];
  const a=boot(events,entries),before=copy(a.state),storageBefore=copy([...a.storage]);
  a.history.handleAction('history-filter','photos');
  const selected=copy(a.history.nativeProjection('eaten',{}, {day}));
  assert.equal(a.scores(),2,'Other days must not run score/image projections');
  assert.deepEqual(selected.rows.map(row=>row.id),['today','diary:today-repeat'],'Equal consumption timestamps retain prior stable ordering');
  const full=copy(a.history.nativeProjection('eaten'));
  assert.deepEqual(selected,{...full,rows:full.rows.filter(row=>row.entry.day===day)});
  assert.equal(a.history.items().length,0,'Native projection restores the existing browser filter');
  assert.deepEqual(copy(a.state),before);assert.deepEqual(copy([...a.storage]),storageBefore);
  assert.deepEqual(a.writes(),{historyWrites:0,diaryWrites:0});
});

test('dated projection deduplicates confirmations before filtering across days',()=>{
  const a=boot([], [entry('old-confirmation',null,{day:oldDay,sourceMeta:{confirmationId:'replayed'}}),entry('replay',null,{sourceMeta:{confirmationId:'replayed'}})]);
  assert.equal(a.history.nativeProjection('eaten',{}, {day}).rows.length,0,'Filtering must not resurrect a duplicate confirmation hidden by an earlier day');
  assert.equal(a.scores(),0);
});

const nativeFiles=['streaks.js','recipe-catalogue-data.js','recipe-catalogue.js','core/food-log.js','core/diary.js','core/nutrition-profile.js','core/product-evidence.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','core/analysis-result.js','scan-results.js','today-goals.js','cycle-support.js','search-model.js','diet.js','scan-history.js','repertoire.js','native-review.js','native-session.js','food-catalogue.js'];
function nativeBoot(history={version:3,events:[]},{allowWrites=false}={}){
  const values=new Map([['nudge-scan-history-v1',JSON.stringify(history)]]),writes=[];
  const s={console,Date,Math,JSON,URL,document:{addEventListener(){},getElementById(){return null;}},location:{protocol:'native:'},nativeToday:()=>day,nativeNow:()=>day+'T12:00:00Z',nativeDiagnostic(){},nativeStorage:raw=>{
    const request=JSON.parse(raw);if(request.operation==='get')return JSON.stringify({ok:true,value:values.get(request.key)??null});
    writes.push(request);if(!allowWrites)throw Error('Projection must not write');
    if(request.operation==='set')values.set(request.key,request.value);else if(request.operation==='remove')values.delete(request.key);else throw Error('Unexpected operation');return '{"ok":true}';
  }};s.window=s;vm.createContext(s);
  for(const file of nativeFiles)vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),s,{filename:file});
  const api=s.NudgeNativeSession;assert.equal(api.init().readFailed,false);return {s,api,values,writes};
}
const testProduct=(barcode='12345678')=>({barcode,name:'Synthetic chickpeas',ingredients:'Chickpeas, water',basisUnit:'g',nutritionPreparation:'as_sold',categoriesTags:['en:legumes'],nutrients:Object.fromEntries(Object.entries({energyKcal:110,protein:6,fibre:5,fat:2,saturatedFat:.2,carbohydrate:15,sugars:1,salt:.3}).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:'supplied'}]))});

test('safety projection preserves all conservative normalization without traversing unrelated profile history',()=>{
  const n=require('../Web/core/nutrition-profile.js'),keys=['glutenRequirement','glutenFreePreference','allergies','allergiesAnswered','avoids','diet'];
  for(const raw of [undefined,null,7,[],{},...['coeliac','sensitivity','unknown','retired',null].flatMap(glutenRequirement=>['vegan','vegetarian','pescatarian','mixed','retired',null].map(diet=>({glutenRequirement,diet,glutenFreePreference:1,allergiesAnswered:'true',allergies:['milk','milk','',7,'unsupported', 'x'.repeat(161)],avoids:['gluten','nuts',null,'milk']}))),{glutenFreePreference:true,allergiesAnswered:true,allergies:['milk'],avoids:[] }]){
    const clean=n.clean(raw);assert.deepEqual(n.safetyProfile(raw),Object.fromEntries(keys.map(key=>[key,clean[key]])));
  }
  const profile={diet:'vegan',allergies:['milk'],get targetHistory(){throw Error('Targets are unrelated to allergy safety');}};
  const safety=n.safetyProfile(profile);assert.equal(safety.diet,'vegan');safety.allergies.push('nuts');assert.deepEqual(profile.allergies,['milk']);
});

test('one dated-target reader preserves unsorted history, equal-date precedence, missing targets and fresh edits',()=>{
  const n=require('../Web/core/nutrition-profile.js'),profile={targetHistory:[{effectiveFrom:'2026-10-10',targets:{protein:100},source:'first'},{effectiveFrom:'2026-10-01',targets:{protein:80,carbs:0},source:'older'},{effectiveFrom:'2026-02-30',targets:{protein:999},source:'invalid date'},{effectiveFrom:'2026-10-10',targets:{protein:120,fibre:null,carbs:'bad'},source:'last'}]};
  const read=n.targetReader(profile);
  for(const date of ['2026-09-30','2026-10-01','2026-10-09','2026-10-10','2026-10-12'])for(const metric of ['protein','fibre','carbs','plants']){
    const record=n.clean(profile).targetHistory.filter(row=>row.effectiveFrom<=date).sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1);
    const expected=record?{value:typeof record.targets[metric]==='number'&&Number.isFinite(record.targets[metric])?record.targets[metric]:null,known:Object.hasOwn(record.targets,metric),effectiveFrom:record.effectiveFrom,source:record.source}:{value:null,known:false,reason:'Historical target not recorded'};
    assert.deepEqual(read(date,metric),expected);assert.deepEqual(n.targetAt(profile,date,metric),expected);
  }
  read(day,'protein').value=999;assert.equal(read(day,'protein').value,120);
  profile.targetHistory.at(-1).targets.protein=150;
  assert.equal(read(day,'protein').value,120,'A projection owns an isolated read snapshot');
  assert.equal(n.targetReader(profile)(day,'protein').value,150,'The next projection sees profile edits immediately');
});

test('combined Today projection shares one cleaned diary and each nutrient reading while preserving full outputs',()=>{
  const a=nativeBoot(),state=copy(a.api.snapshot().state),n=a.s.NudgeNutrition,t=a.s.NudgeToday;
  state.foodLog.entries=[entry('partial',null,{plants:['Carrot'],fibrePerPortion:null,sourceMeta:{plantKnowledge:'known'},nutritionSnapshot:{salt:{portion:0,portionStatus:'calculated'}}}),entry('old',null,{day:oldDay,proteinPerPortion:0}),entry('future',null,{day:'2026-10-12'})];
  state.nutritionProfile={saved:true,schemaVersion:2,tracking:['protein','calories','carbs','fat','fibre','plants'],targetHistory:[{effectiveFrom:oldDay,targets:{protein:110,calories:2200,carbs:230,fat:70,fibre:30,plants:30,dailyPlants:5}}]};
  for(const selected of [oldDay,day,'2026-10-12']){
    const expected=copy({...t.model(state,selected,day),...t.compactSummary(state,selected,day)}),originalClean=a.s.WmdFoodLog.clean,originalReading=a.s.NudgeComposition.intakeNutrient,readings=new Map();let cleanCount=0;
    a.s.WmdFoodLog={...a.s.WmdFoodLog,clean:(...args)=>{cleanCount++;return originalClean(...args);}};
    a.s.NudgeComposition={...a.s.NudgeComposition,intakeNutrient:(e,key)=>{const identity=e.id+':'+key;readings.set(identity,(readings.get(identity)||0)+1);return originalReading(e,key);}};
    const before=JSON.stringify(state),actual=copy(t.projection(state,selected,day));
    assert.deepEqual(actual,expected);assert.equal(cleanCount,1);assert.ok([...readings.values()].every(count=>count===1),'A nutrient must be read once per confirmed entry');assert.equal(JSON.stringify(state),before);
    a.s.WmdFoodLog.clean=originalClean;a.s.NudgeComposition.intakeNutrient=originalReading;
  }
  state.foodLog.entries[0].proteinPerPortion=11;state.nutritionProfile.targetHistory[0].targets.protein=130;
  assert.equal(t.projection(state,day,day).protein.value,11);assert.equal(t.projection(state,day,day).protein.target,130);assert.deepEqual(a.writes,[]);
});

test('History hearts read favourite identities without reconstructing reusable nutrition drafts',()=>{
  const product=testProduct(),other=testProduct('87654321'),a=nativeBoot({version:3,events:[scan('favourite',{product}),scan('ordinary',{product:other}),scan('pending',{product:null,status:'pending',kind:'unknown'}),scan('photo',{product:null,kind:'meal',extraction:{type:'unknown'}})],favourites:['barcode:'+product.barcode],favouriteProducts:[{key:'barcode:'+product.barcode,product}]});
  const before=copy([...a.values]),initialFoods=copy(a.api.snapshot().foods);let records=0;
  const original=a.s.NudgeNativeReview.record;a.s.NudgeNativeReview={...a.s.NudgeNativeReview,record:(...args)=>{records++;return original(...args);}};
  const full=copy(a.api.project('history')),compact=copy(a.api.project('history',{presentation:true}));
  assert.equal(full.rows.find(row=>row.id==='favourite').isFavourite,true);assert.equal(full.rows.find(row=>row.id==='ordinary').isFavourite,false);assert.equal(records,0,'Drawing hearts must not prepare or calculate a reusable draft');
  assert.deepEqual(compact.rows.map(row=>[row.id,row.canReuse]),full.rows.map(row=>[row.id,Boolean(row.entry||row.product||row.extraction)]));
  assert.deepEqual(copy(a.api.snapshot().foods),initialFoods,'Membership optimisation does not change full reusable food drafts');assert.deepEqual(copy([...a.values]),before);assert.deepEqual(a.writes,[]);
});

test('product scoring reuses normalized facts within a call and rechecks edited facts and expired cache',()=>{
  const a=nativeBoot(),m=a.s.NudgeFoodDetailModel,base=testProduct(),local=m.calculatedScore(base),fingerprint=m.scoreFingerprint(base);
  const product={...base,scoreResult:{methodId:local.methodId,version:local.version,inputFingerprint:fingerprint,result:local,catalogueValidated:true,catalogueExpiresAt:Date.now()+60000}};
  let reads=0;Object.defineProperty(product,'nutrientSources',{enumerable:true,get(){reads++;return {};}});
  assert.equal(m.score(product).value,local.value);assert.ok(reads<=9,`Each of the nine nutrient source facts is read once, observed ${reads}`);
  const cached=m.cachedScore(product);assert.ok(cached);product.scoreResult.catalogueExpiresAt=Date.now()-1;assert.equal(m.cachedScore(product),null);assert.equal(m.score(product).value,local.value);
  product.scoreResult.catalogueExpiresAt=Date.now()+60000;product.nutrients={};assert.notEqual(m.scoreFingerprint(product),fingerprint);assert.equal(m.cachedScore(product),null);assert.deepEqual(a.writes,[]);
});

test('deferred native History scores zero archive rows and individual visible scores preserve the authoritative projection',()=>{
  const events=Array.from({length:18},(_,i)=>scan('row-'+i,{product:testProduct(String(10000000+i))}));
  events.push(scan('pending',{status:'pending',product:null,kind:'unknown'}));
  const a=nativeBoot({version:3,events,favourites:['barcode:10000000']},{allowWrites:true}),currentProducts={'10000001':{...testProduct('10000001'),ingredients:'Cream, milk',categoriesTags:['en:creams']}};
  a.api.perform('setReview',{kind:'product',product:events[0].product,eventId:'row-0',confirmationId:'confirmed',day,slot:'Lunch'});
  assert.equal(a.api.perform('reviewConfirm').ok,true);
  const before=copy([...a.values]),writes=a.writes.length,expected=copy(a.api.project('history',{presentation:true,currentProducts}));
  let scored=0;const original=a.s.NudgeFoodDetailModel.score;a.s.NudgeFoodDetailModel={...a.s.NudgeFoodDetailModel,score:(...args)=>{scored++;return original(...args);}};
  const deferred=copy(a.api.project('history',{presentation:true,deferScores:true,currentProducts}));
  assert.equal(scored,0,'Entering History must not calculate scores for the entire archive');
  assert.deepEqual(deferred.rows.map(row=>row.id),expected.rows.map(row=>row.id));
  for(const row of deferred.rows){
    assert.equal(row.scoreDeferred,true);assert.equal(row.scoreDisplay,null);
    const actual=copy(a.api.project('historyScore',{id:row.id,currentProducts})),reference=expected.rows.find(other=>other.id===row.id);
    assert.equal(actual.available,true);assert.equal(actual.id,row.id);assert.deepEqual(actual.scoreDisplay,reference.scoreDisplay);assert.equal(actual.note,reference.note);
    const {scoreDeferred,scoreDisplay,note,...identity}=row,{scoreDisplay:oldScore,note:oldNote,...oldIdentity}=reference;assert.deepEqual(identity,oldIdentity);
  }
  assert.equal(scored,17,'Only requested unlogged products calculate a score; saved and pending rows do not');
  assert.deepEqual(copy([...a.values]),before);assert.equal(a.writes.length,writes);
  assert.equal(a.api.perform('historyDelete',{id:'row-1',keepIntake:false}).ok,true);
  assert.deepEqual(copy(a.api.project('historyScore',{id:'row-1',currentProducts})),{id:'row-1',available:false,scoreDisplay:null,note:'',nativeCacheUntil:null});
  assert.equal(a.api.perform('historyUndo').ok,true);
  assert.deepEqual(copy(a.api.project('historyScore',{id:'row-1',currentProducts})).scoreDisplay,expected.rows.find(row=>row.id==='row-1').scoreDisplay);
});

test('a visible History score publishes the same exact evidence deadline and re-evaluates after expiry',()=>{
  let clock=Date.now();const early=clock+2000,later=clock+4000,product={...testProduct(),scoreResult:{catalogueValidated:true,catalogueExpiresAt:later,result:{catalogueEnrichment:{expiresAt:early}}}};
  const a=nativeBoot({version:3,events:[scan('expires',{product})]});a.s.Date=class extends Date{static now(){return clock;}};
  assert.equal(a.api.project('historyScore',{id:'expires'}).nativeCacheUntil,early);
  assert.equal(a.api.project('history',{presentation:true,nativeCache:true}).nativeCacheUntil,early);
  clock=early;assert.equal(a.api.project('historyScore',{id:'expires'}).nativeCacheUntil,later);
  clock=later;assert.equal(a.api.project('historyScore',{id:'expires'}).nativeCacheUntil,null);
  assert.deepEqual(copy(a.api.project('historyScore',{})),{id:'',available:false,scoreDisplay:null,note:'',nativeCacheUntil:null});assert.deepEqual(a.writes,[]);
});
