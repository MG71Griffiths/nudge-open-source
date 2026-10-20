// The same public source records must produce one rating through server, cards,
// detail and history adapters. No diary nutrition is rewritten by a refresh.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const copy=v=>JSON.parse(JSON.stringify(v));
function boot(storage=new Map()) {
  const s={console,document:{addEventListener(){}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}};
  s.window=s;vm.createContext(s);
  for(const file of ['streaks.js','core/food-log.js','core/diary.js','core/nudge-score.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','food-catalogue.js','scan-history.js'])
    vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),s,{filename:file});
  const state={foodLog:{entries:[]}},history=s.createNudgeHistory({getState:()=>state,view:{},escapeHtml:String,todayKey:()=> '2026-10-08',render(){},navigate(){},showToast(){}});
  return {s,history,state,storage};
}
(async()=>{
  const {catalogueRecordFromPayload}=await import('../Backend/src/food-catalogue.js');
  const fixture=JSON.parse(fs.readFileSync('tests/fixtures/off-nutriscore-products.json','utf8'));
  const expected={'5020580199784':100,'5020580161231':100,'5061048250005':25,'5061048250081':50,'8004030103191':25,'8005110170348':100};
  const app=boot(),core=app.s.NudgeScoreCore,model=app.s.NudgeFoodDetailModel;
  const products=[];
  for(const raw of fixture.products){
    const p=catalogueRecordFromPayload({status:'success',product:raw},raw.code,Date.now()).product;
    products.push(p);
    const before=JSON.stringify(p),facts=model.scoreFacts(p),rating=model.score(p);
    assert.equal(core.providerFactsFingerprint(p),core.providerFactsFingerprint(facts),'Browser adaptation retains original provider binding: '+raw.code);
    assert.equal(rating.value,expected[raw.code],raw.code);
    assert.equal(rating.methodId,core.SCORE_METHOD);
    assert.equal(rating.version,core.SCORE_VERSION);
    assert.notEqual(rating.status,'estimated_rough');
    assert.equal(rating.baseFrequency,null);assert.equal(rating.finalFrequency,null);
    assert.equal(app.s.NudgeFrequency.render(rating),'');
    assert.equal(app.s.NudgeFrequency.legacy(rating),false);
    assert.equal(model.validScoreResult(rating),true);
    assert.equal(JSON.stringify(p),before,'Scoring preserves nutrients and source facts');
    app.history.record({id:raw.code,kind:'product',status:'ready',createdAt:'2026-10-08T12:00:00Z',product:p});
    assert.equal(app.history.nativeProjection().rows.find(r=>r.id===raw.code).scoreDisplay.value,rating.value);
    const cache={inputFingerprint:model.scoreFingerprint(p),methodId:rating.methodId,version:rating.version,result:rating,checkedAt:new Date().toISOString()};
    assert.equal(app.s.NudgeFoodCatalogue.put(p,cache),true);
    assert.equal(app.s.NudgeFoodCatalogue.get(p).result.value,rating.value,'The versioned result survives the public evidence cache');
  }
  const reloaded=boot(app.storage);
  for(const p of products)assert.equal(reloaded.history.nativeProjection().rows.find(r=>r.id===p.barcode).scoreDisplay.value,expected[p.barcode],'History reload parity');
  const tomato=products.find(p=>p.barcode==='8005110170348');
  assert.equal(model.score(tomato).scoreBasis,core.ACTIVE_DIRECTIONAL?'nudge_directional':'provider_nutriscore_2023');
  const changed=copy(tomato);changed.nutrients.salt={value:10,unit:'g',status:'supplied'};
  assert.equal(core.providerScore(model.scoreFacts(changed)),null,'Edited facts cannot inherit an old OFF score');
  assert.notEqual(model.score(changed).value,100);
  const missing={name:'Rice',barcode:'1234567890123',basisUnit:'g',nutritionPreparation:'as_sold',sourceName:'Open Food Facts',nutrients:{}};
  const incomplete=model.score(missing);assert.equal(incomplete.value,null);assert.notEqual(incomplete.status,'estimated_rough');
  app.history.record({id:'missing',kind:'product',status:'ready',createdAt:'2026-10-08T12:00:00Z',product:missing});
  assert.equal(app.history.nativeProjection().rows.find(r=>r.id==='missing').scoreDisplay,null,'History cannot restore the retired heuristic');
  const old={...copy(tomato),providerNutriScore:null,nutrients:{},scoreResult:{methodId:'nudge_nutrition_v0_2',version:'0.2',result:{value:75,status:'provisional'}}};
  assert.equal(model.cachedScore(old),null);
  app.history.record({id:'refresh',kind:'product',status:'ready',createdAt:'2026-10-08T12:00:00Z',product:old});
  const storedBefore=JSON.stringify(app.history.find('refresh'));
  assert.equal(app.history.nativeProjection('all',{[tomato.barcode]:tomato}).rows.find(r=>r.id==='refresh').scoreDisplay.value,100);
  assert.equal(JSON.stringify(app.history.find('refresh')),storedBefore,'Public history hydration does not rewrite a saved scan');
  assert.deepEqual(app.state.foodLog.entries,[],'Read-only score refresh creates no diary entries');
  console.log('PASS: six public OFF records agree across source normalization, browser cards/details, cache and history reload; stale edits, missing data and old methods are rejected; diary remains unchanged.');
})().catch(error=>{console.error(error);process.exitCode=1;});
