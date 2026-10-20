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
const nutrients=values=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:value===null?'unknown':'supplied'}]));
const complete={name:'Chickpeas',ingredients:'Chickpeas (100%)',ingredientsNeedsReview:false,brand:'Fixture Foods',barcode:'12345678',sourceName:'Open Food Facts',sourceURL:'https://world.openfoodfacts.org/product/12345678',basisUnit:'g',servingAmount:100,servingUnit:'g',nutritionPreparation:'as_sold',categoriesTags:['en:legumes'],nutrients:nutrients({energyKcal:100,protein:6.7,fibre:5.7,salt:.53,sugars:1,fat:2,saturatedFat:.3,carbohydrate:13.9})};
const partial={...complete,nutrients:{...complete.nutrients,fibre:{value:null,unit:'g',status:'unknown'},sugars:{value:null,unit:'g',status:'unknown'}}};
const recovered={...complete,nutrientSources:{fibre:'Open Food Facts exact barcode record'}};
const recovery={version:'food-recovery-v1',status:'verified',product:recovered,addedFields:['nutrients.fibre','nutrients.sugars'],conflicts:[],provenance:[{title:'Open Food Facts',url:complete.sourceURL,retrievedAt:'2026-10-07T12:00:00Z'}]};
const unresolved={version:'food-recovery-v1',status:'unresolved',addedFields:[],conflicts:[],provenance:[]};

test('durable capture metadata survives restart and background completion preserves History identity without intake',()=>{
  const a=boot(),captured='2026-10-01T12:30:00.123Z',owner='a'.repeat(64),id='native-scan:durable';
  assert.equal(a.perform('recordHistory',{id,kind:'product',barcode:complete.barcode,status:'pending',createdAt:captured,
    captureOwnerKey:owner,captureID:'12345678-1234-1234-1234-123456789012',processingState:'queued',message:'Saved — waiting for connection'}).ok,true);
  const b=a.restart(),saved=b.project('captureState',{id});
  assert.equal(saved.deleted,false);assert.equal(saved.event.captureOwnerKey,owner);assert.equal(saved.event.processingState,'queued');
  assert.equal(b.project('recoverableCaptures').events.length,0,'Owned captures use the native outbox rather than legacy adoption');
  assert.equal(b.perform('recordHistory',{id,status:'ready',product:complete,name:complete.name,processingState:'complete',createdAt:'2026-10-07T12:00:00Z'}).ok,true);
  assert.equal(b.project('captureState',{id}).event.createdAt,captured);
  assert.equal(b.project('captureCachedProduct',{barcode:complete.barcode}).product.name,complete.name);
  assert.deepEqual(b.snapshot().state.foodLog.entries,[]);
  assert.equal(b.perform('historyDelete',{id,keepIntake:true}).ok,true);
  assert.equal(b.project('captureState',{id}).deleted,true);
  assert.equal(b.perform('recordHistory',{id,status:'ready',product:complete}).ok,false,'Late completion cannot revive a deleted capture');
  assert.equal(b.restart().project('captureState',{id}).deleted,true);
});

test('background estimates share one visible score while logged nutrition and saved portions remain unchanged',()=>{
  for(const basis of ['sourced_composition','public_label_estimate']){
    const a=boot(),source={...partial,imageURL:'https://images.openfoodfacts.org/images/products/12345678/front_en.1.400.jpg'},before=copy(source);
    const marker={version:'catalogue-enrichment-v1',sourceFingerprint:'a'.repeat(64),expiresAt:initialTime+600000};
    const score={...copy(a.model.calculatedScore(complete)),status:'estimated_provisional',estimated:true,scoreBasis:basis,
      inputs:{nutrients:nutrients({energyKcal:300,protein:20,fibre:5.7})},catalogueEnrichment:marker};
    const bind=(result,calculatedAt)=>a.project('productWithCatalogueScore',{product:source,score:result,expiresAt:marker.expiresAt,calculatedAt}).product;
    const prepared=bind(score,initialTime),request=a.open(prepared);
    assert.equal(request.needsRecovery,false,'No scan-time analysis is needed for a prepared catalogue estimate');
    assert.equal(request.canApplyCache,false,'Prepared evidence must not replay as a facts-repair operation');
    assert.equal(a.project('productScanModel',{product:prepared}).scoreStatus,(score.methodId==='nudge_nutrition_v0_4'?'Nudge score':'Estimated · provisional rating'));
    assert.equal(a.project('reviewModel').scoreStatus,(score.methodId==='nudge_nutrition_v0_4'?'Nudge score':'Estimated · provisional rating'));
    assert.match(a.s.NudgeResults.finding(prepared),score.methodId==='nudge_nutrition_v0_4'?/Nudge score/:/100\/100 · estimated · provisional/);
    assert.deepEqual(source,before);assert.deepEqual(prepared.nutrients,source.nutrients);
    assert.equal(a.snapshot().state.foodLog.entries.length,0);
    const logged=a.perform('reviewConfirm');assert.equal(logged.ok,true);
    const diary=copy(logged.state.foodLog),entry=diary.entries[0];
    assert.equal(entry.nutritionSnapshot.protein.portion,6.7,'Supplied protein, not generic estimate protein');
    assert.equal(entry.nutritionSnapshot.energyKcal.portion,100,'Supplied energy, not generic estimate energy');
    assert.equal(entry.nutritionSnapshot.fibre.portion,null,'Estimated fibre stays outside label/diary nutrition');
    const corrected=bind({...score,band:null,value:0,grade:'E',rawScore:30,rawLower:30,rawUpper:30,displayLower:0,displayUpper:0},initialTime+1000);
    assert.equal(corrected.scoreResult.result.value,0);
    a.perform('recordHistory',{id:'unconsumed',kind:'product',status:'ready',name:source.name,barcode:source.barcode,product:prepared});
    const rows=a.project('history',{currentProducts:{[source.barcode]:corrected}}).rows;
    const consumed=rows.find(row=>row.entry),unconsumed=rows.find(row=>row.id==='unconsumed');
    assert.equal(unconsumed.scoreDisplay.value,0,'Current score updates unconsumed history');
    assert.equal(consumed.scoreDisplay.value,score.value,'Confirmed intake retains its original rating snapshot');
    assert.equal(unconsumed.imageURL,source.imageURL);assert.equal(consumed.imageURL,source.imageURL);
    assert.deepEqual(a.snapshot().state.foodLog,diary);
    const restarted=a.restart();assert.deepEqual(restarted.snapshot().state.foodLog,diary);
    restarted.advance(600001);
    assert.equal(restarted.model.cachedScore(prepared),null,'A restored estimate must expire without refreshing label dates');
  }
});

test('native recovery requests skip complete products and expose only public facts for incomplete foods',()=>{
  const a=boot(),good=a.open(complete);
  assert.equal(good.needsRecovery,false);assert.equal(good.canApplyCache,false);assert.equal(a.model.calculatedScore(complete).status,'rated');
  const dirty={...partial,imageBase64:'private-media',email:'private-person',voice:'private-voice',selectedPortion:999};
  const request=a.open(dirty,'incomplete');assert.equal(request.needsRecovery,true);
  assert.equal(request.facts.nutrients.fibre.value,null);assert.equal(request.facts.nutrients.salt.value,.53);
  assert.doesNotMatch(JSON.stringify(request.facts),/private-|selectedPortion/);
  assert.equal(a.snapshot().state.foodLog.entries.length,0);
  for(let n=0;n<4;n++)a.project('productRecovery');
  assert.equal(a.snapshot().state.foodLog.entries.length,0,'Rendering recovery does not log food');
});

test('HTTP catalogue enrichment keeps its source-bound expiry through the private recovery cache',()=>{
  const a=boot(),request=a.open(),base=copy(a.model.calculatedScore(complete));
  const marker={version:'catalogue-enrichment-v1',sourceFingerprint:'b'.repeat(64),expiresAt:initialTime+120000};
  const score={...base,status:'estimated',estimated:true,scoreBasis:'public_label_estimate',catalogueEnrichment:marker};
  assert.equal(a.apply(request,score).ok,true);
  assert.deepEqual(a.snapshot().review.product.nutrients,partial.nutrients);
  const cache=a.s.NudgeFoodCatalogue.get(partial);assert.deepEqual(copy(cache.result.catalogueEnrichment),marker);
  assert.equal(a.project('reviewModel').scoreStatus,score.methodId==='nudge_nutrition_v0_4'?'Nudge score':'Estimated rating');
  const b=a.restart();b.open();assert.equal(b.project('productRecovery').canApplyCache,true);
  b.advance(120001);
  assert.equal(b.s.NudgeFoodCatalogue.get(partial),null,'Longer private-cache TTL cannot extend evidence expiry');
  assert.equal(b.model.cachedScore(a.snapshot().review.product),null);
  assert.deepEqual(b.project('productRating',{product:partial}),{});
  assert.equal(b.project('productRecovery').needsRecovery,true);
  for(const bad of [{...marker,version:'unknown'},{...marker,sourceFingerprint:'invalid'},{...marker,expiresAt:true},{...marker,expiresAt:initialTime-1},null]){
    const c=boot(),r=c.open(),before=c.snapshot();
    assert.equal(c.apply(r,{...score,catalogueEnrichment:bad}).ok,false);
    assert.deepEqual(c.snapshot().review,before.review);
    assert.deepEqual(c.project('productWithCatalogueScore',{product:partial,score:{...score,catalogueEnrichment:bad},expiresAt:initialTime+86400000}),{});
  }
});

test('newer unrated catalogue publication supersedes older HTTP estimate even if the old response arrived later',()=>{
  const a=boot(),request=a.open(),base=copy(a.model.calculatedScore(complete));
  const score={...base,status:'estimated',estimated:true,scoreBasis:'sourced_composition',catalogueEnrichment:{version:'catalogue-enrichment-v1',sourceFingerprint:'a'.repeat(64),expiresAt:initialTime+3600000}};
  assert.equal(a.apply(request,score,null,{calculatedAt:initialTime-2000}).ok,true);
  assert.equal(a.project('productRating',{product:partial}).score.value,base.value);
  const b=a.restart(),cached=b.open();b.applyCache(cached);
  assert.equal(b.snapshot().review.product.scoreResult.catalogueCalculatedAt,initialTime-2000,'Replay preserves publication time');
  const withdrawn=copy(b.model.calculatedScore(partial));assert.equal(withdrawn.status,'unrated');
  assert.deepEqual(b.project('productRating',{product:partial,catalogueScore:withdrawn,catalogueCalculatedAt:initialTime-1000}),{});
  const product=b.project('productWithCatalogueScore',{product:partial,score:withdrawn,expiresAt:initialTime+3600000,calculatedAt:initialTime-1000}).product;
  const current=b.open(product,'new-publication');
  assert.equal(current.canApplyCache,false,'Automatic detail recovery cannot replay a withdrawn estimate');
  assert.equal(b.project('reviewModel').score.value,null);
  assert.equal(b.project('productScanModel',{product}).score.value,null);
  assert.equal(b.snapshot().state.foodLog.entries.length,0);
  const before=b.snapshot();
  assert.equal(b.apply(current,score,null,{calculatedAt:initialTime-2000}).ok,false,'A delayed older HTTP callback cannot replace a newer publication');
  assert.deepEqual(b.snapshot().review,before.review);
  assert.deepEqual(b.snapshot().history,before.history);
});

test('exact recovery enriches the current draft and history without changing intake, and is reusable after restart',()=>{
  const a=boot(),request=a.open(),state=copy(a.snapshot().state),result=a.model.calculatedScore(recovered);
  const applied=a.apply(request,result,recovery);assert.equal(applied.ok,true);
  assert.equal(applied.review.product.nutrients.fibre.value,5.7);assert.equal(applied.review.product.nutrients.salt.value,.53);
  assert.deepEqual(applied.state,state);assert.equal(applied.history.events.length,1);
  assert.equal(applied.history.events[0].product.nutrients.fibre.value,5.7);
  assert.ok(applied.history.events[0].analysisVersions.some(v=>v.product.nutrients.fibre.value===null));
  assert.equal(a.project('productRecovery').needsRecovery,false);
  const b=a.restart(),cached=b.open(partial,'offline','new-scan');
  assert.equal(cached.needsRecovery,false);assert.equal(cached.canApplyCache,true);assert.ok(cached.cache);
  const repeated=b.applyCache(cached);assert.equal(repeated.ok,true);
  assert.equal(repeated.review.product.nutrients.fibre.value,5.7);
  assert.equal(b.project('reviewModel').score.value,result.value);
  assert.equal(repeated.state.foodLog.entries.length,0);
  const source=JSON.parse(b.values.get(historyKey)).events.find(e=>e.id==='scan-1');
  b.perform('setReview',{kind:'product',product:source.product,eventId:source.id,confirmationId:'history-reopen'});
  assert.equal(b.project('productRecovery').needsRecovery,false);
  assert.equal(b.snapshot().review.product.nutrients.fibre.value,5.7,'Reopened history retains repaired evidence');
});

test('late responses cannot replace a different confirmation or edited evidence',()=>{
  for(const replacement of ['confirmation','facts']){
    const a=boot(),request=a.open(),result=a.model.calculatedScore(recovered);
    if(replacement==='confirmation')a.open(partial,'replacement','scan-2');
    else a.perform('reviewUpdate',{nutrient:{key:'salt',value:'1.2'}});
    const before=a.snapshot(),stored=[...a.values];
    assert.equal(a.apply(request,result,recovery).ok,false,replacement);
    assert.deepEqual(a.snapshot().review,before.review);assert.deepEqual([...a.values],stored);
  }
  const a=boot(),request=a.open();
  assert.equal(a.apply(request,{status:'rated',value:100},recovery).ok,false,'Malformed or other-method scores are rejected');
  assert.equal(a.snapshot().review.product.nutrients.fibre.value,null);
});

test('confirmed intake and explicit diary edits refuse automatic recovery even with the original request',()=>{
  const a=boot(),request=a.open(),result=a.model.calculatedScore(recovered);
  const logged=a.perform('reviewConfirm');assert.equal(logged.ok,true);
  assert.equal(logged.state.foodLog.entries.length,1);const diary=copy(logged.state.foodLog);
  assert.deepEqual(a.project('productRecovery'),{});
  assert.equal(a.apply(request,result,recovery).ok,false);assert.deepEqual(a.snapshot().state.foodLog,diary);
  a.perform('setReview',{kind:'product',product:partial,entryId:logged.review.entryId,eventId:'scan-1',confirmationId:'edit'});
  assert.deepEqual(a.project('productRecovery'),{});
  assert.equal(a.apply({...request,confirmationId:a.snapshot().review.confirmationId},result,recovery).ok,false);
  assert.deepEqual(a.snapshot().state.foodLog,diary);
});

test('a lookup cannot replace known salt, food identity, or preparation basis',()=>{
  const candidates=[{...recovered,nutrients:{...recovered.nutrients,salt:{value:0,unit:'g',status:'supplied'}}},{...recovered,barcode:'87654321'},{...recovered,nutritionPreparation:'prepared'},{...recovered,brand:'Different brand'}];
  for(const product of candidates){
    const a=boot(),request=a.open(),before=copy(a.snapshot().review.product);
    const r=a.apply(request,a.model.calculatedScore(recovered),{...recovery,product});
    assert.equal(r.ok,true,'Rejected supplementary evidence leaves a usable original result');
    assert.deepEqual(r.review.product.nutrients,before.nutrients);
    assert.equal(r.review.product.barcode,before.barcode);
    assert.equal(r.review.product.nutritionPreparation,before.nutritionPreparation);
    assert.equal(r.review.product.scoreResult.result.status,'unrated');
    assert.equal(r.review.product.scoreResult.recovery,undefined);
    assert.equal(r.state.foodLog.entries.length,0);
  }
});

test('transport failures and unresolved responses use separate persistent cooldowns without suppressing changed evidence',()=>{
  const a=boot(),request=a.open();
  assert.equal(a.perform('productRecoveryFailed',request).ok,true);
  assert.equal(a.project('productRecovery').needsRecovery,false);
  const b=a.restart();b.open();assert.equal(b.project('productRecovery').needsRecovery,false);
  b.advance(3600001);assert.equal(b.project('productRecovery').needsRecovery,true);
  const req=b.project('productRecovery');b.apply(req,b.model.calculatedScore(partial),unresolved);
  assert.equal(b.project('productRecovery').needsRecovery,false);
  const c=b.restart();c.open();assert.equal(c.project('productRecovery').needsRecovery,false);
  c.advance(6*3600000+1);assert.equal(c.project('productRecovery').needsRecovery,true);
  c.perform('reviewUpdate',{nutrient:{key:'salt',value:'1.2'}});
  assert.equal(c.project('productRecovery').needsRecovery,true,'A new evidence fingerprint has its own recovery budget');
  const d=boot(),old=d.open();d.open(partial,'next-confirmation');d.perform('productRecoveryFailed',old);
  assert.equal(d.project('productRecovery').needsRecovery,true,'An obsolete failure cannot cool down a newer review');
});

test('generic estimates remain labelled and reusable without inventing verified label nutrients',()=>{
  const a=boot(),request=a.open(),result=a.model.calculatedScore(complete);
  const estimate={...result,status:'estimated_provisional',estimated:true,scoreBasis:'sourced_composition',sources:[{title:'Generic food reference',url:'https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid'}],assumptions:['Generic reference; actual recipe may differ.']};
  const generic={version:'food-recovery-v1',status:'estimated',addedFields:[],conflicts:[],provenance:[],estimate:{sourceRecord:{id:'generic-fixture',name:'Cooked chickpeas'},score:estimate}};
  const response=a.apply(request,a.model.calculatedScore(partial),generic);assert.equal(response.ok,true);
  assert.equal(a.project('reviewModel').score.status,'estimated_provisional');
  assert.equal(response.review.product.nutrients.fibre.value,null);
  const b=a.restart(),cached=b.open(partial,'generic-reopen');
  assert.ok(cached.cache.recovery.estimate.score);assert.equal(cached.needsRecovery,false);assert.equal(cached.canApplyCache,true,'Swift must apply an estimate whose underlying verified score is unrated');
  assert.equal(b.applyCache(cached).ok,true);
  assert.equal(b.project('reviewModel').score.status,'estimated_provisional');
  assert.equal(b.snapshot().review.product.nutrients.fibre.value,null);
  assert.equal(b.perform('reviewConfirm').state.foodLog.entries[0].nutritionSnapshot.fibre.portion,null);
});

test('a deleted history event is never resurrected by a still-open recovery callback',()=>{
  const a=boot(),request=a.open();assert.equal(a.perform('historyDelete',{id:'scan-1',keepIntake:true}).ok,true);
  assert.equal(a.snapshot().history.events.length,0);
  assert.equal(a.apply(request,a.model.calculatedScore(recovered),recovery).ok,true);
  assert.equal(a.snapshot().history.events.length,0);assert.equal(a.snapshot().state.foodLog.entries.length,0);
  assert.ok(JSON.parse(a.values.get(historyKey)).deleted.includes('scan-1'));
});

test('replaying cached incomplete evidence cannot extend the recovery cooldown on every visit',()=>{
  const a=boot(),request=a.open();a.apply(request,a.model.calculatedScore(partial),unresolved);
  a.advance(5*3600000);const b=a.restart(),cached=b.open(partial,'near-expiry');
  assert.equal(cached.canApplyCache,true);assert.equal(b.applyCache(cached).ok,true);
  b.advance(3600001);
  assert.equal(b.project('productRecovery').canApplyCache,false);
  assert.equal(b.project('productRecovery').needsRecovery,true,'Retry is allowed six hours after actual recovery, irrespective of cached visits');
});

test('an old incomplete history cache cannot hide newer successful evidence for the same facts',()=>{
  const a=boot(),request=a.open(),unrated=a.model.calculatedScore(partial);
  a.apply(request,unrated,unresolved);const oldProduct=copy(a.snapshot().review.product);
  a.advance(6*3600000+1);
  const second=a.open(partial,'second-check','scan-2');
  a.apply(second,a.model.calculatedScore(recovered),recovery);
  const b=a.restart();b.perform('setReview',{kind:'product',product:oldProduct,eventId:'scan-1',confirmationId:'old-history'});
  const available=b.project('productRecovery');
  assert.equal(available.canApplyCache,true);assert.equal(available.needsRecovery,false);
  assert.equal(available.cache.result.status,'rated');
  assert.equal(b.applyCache(available).review.product.nutrients.fibre.value,5.7);
  assert.equal(b.snapshot().state.foodLog.entries.length,0);
});

test('native label repair persists the compatible product table in history without copying stale missing values',()=>{
  const a=boot();a.open(complete);const previousReview=a.snapshot().review;
  const label={type:'product',productName:'Chickpeas',brand:'Fixture Foods',labelKind:'nutrition',basis:'per100g',nutritionPreparation:'as_sold',nutrients:nutrients({energyKcal:120,protein:7,carbohydrate:18})};
  const repaired=a.perform('setReview',{kind:'analysis',extraction:label,previousReview,eventId:'scan-1',confirmationId:'label-repair'});
  assert.equal(repaired.ok,true);assert.equal(repaired.review.kind,'product');
  assert.equal(repaired.review.product.barcode,complete.barcode);assert.equal(repaired.review.product.nutrients.carbohydrate.value,18);
  assert.equal(repaired.review.product.nutrients.fibre,undefined);
  assert.equal(repaired.history.events[0].product.nutrients.carbohydrate.value,18);
  assert.equal(repaired.history.events[0].product.nutrients.fibre,undefined);
  assert.equal(repaired.state.foodLog.entries.length,0);
  const b=a.restart(),event=b.snapshot().history.events[0];
  b.perform('setReview',{kind:'product',product:event.product,eventId:event.id,confirmationId:'repaired-reopen'});
  assert.equal(b.project('reviewModel').nutrients.find(n=>n.key==='carbohydrate').value,18);
  assert.equal(b.project('reviewModel').nutrients.find(n=>n.key==='fibre').value,null);
});

test('search uses the same recovered evidence as detail, including after restart, without editing intake',()=>{
  const a=boot(),original=copy(partial),request=a.open(original);
  assert.deepEqual(a.project('productRating',{product:original}),{});
  a.apply(request,a.model.calculatedScore(recovered),recovery);
  const before=a.snapshot(),writes=a.writes.length;
  const card=a.project('productRating',{product:original}).score;
  assert.equal(card.value,a.project('reviewModel').score.value);
  assert.equal(card.status,a.project('reviewModel').score.status);
  assert.equal(a.writes.length,writes,'Rendering cards never persists or duplicates diary rows');
  assert.deepEqual(a.snapshot(),before);
  const b=a.restart();
  assert.equal(b.project('productRating',{product:original}).score.value,card.value);
  const changed={...original,nutrients:{...original.nutrients,salt:{value:2,unit:'g',status:'supplied'}}};
  assert.deepEqual(b.project('productRating',{product:changed}),{},'Changed source facts invalidate the recovery');
  b.advance(31*86400000);
  assert.deepEqual(b.project('productRating',{product:original}),{},'Expired recovery cannot override current catalogue facts');
});

test('classification-only recovery is shared with cards without inventing nutrients',()=>{
  const a=boot(),unknown={...complete,nutrients:{...complete.nutrients,fibre:{value:null,unit:'g',status:'unknown'}},name:'Garden beans',ingredients:'',categoriesTags:[],categories:[]};
  const request=a.open(unknown),result=a.model.calculatedScore({...recovered,name:unknown.name});
  a.apply(request,result,unresolved);
  const score=a.project('productRating',{product:unknown}).score;
  assert.equal(score.value,a.project('reviewModel').score.value);
  assert.equal(a.snapshot().review.product.nutrients.fibre.value,null,'A category decision cannot write missing nutrients');
  assert.deepEqual(a.snapshot().state.foodLog.entries,[]);
});

test('unresolved checks do not replace an otherwise valid catalogue card score',()=>{
  const a=boot(),request=a.open();
  a.apply(request,a.model.calculatedScore(partial),unresolved);
  assert.deepEqual(a.project('productRating',{product:partial}),{},'An empty recovery has no score override');
});

test('validated detailed catalogue result reaches detail and does not trigger repeated recovery',()=>{
  const a=boot(),unknown={...complete,name:'Garden beans',ingredients:'Haricot beans (100%)',categoriesTags:[],categories:[]};
  const result=a.model.calculatedScore({...unknown,categoriesTags:['en:legumes']});
  assert.equal(a.model.calculatedScore(unknown).status,result.methodId==='nudge_nutrition_v0_4'?'rated':'unrated');
  assert.equal(result.status,'rated');
  const prepared=a.project('productWithCatalogueScore',{product:unknown,expiresAt:initialTime+60000,score:result}).product;
  assert.deepEqual(prepared.nutrients,unknown.nutrients);
  assert.deepEqual(prepared.categoriesTags,[]);
  const request=a.open(prepared);
  assert.equal(request.needsRecovery,false);
  assert.equal(a.project('reviewModel').score.value,result.value);
  const changed={...prepared,nutrients:{...prepared.nutrients,salt:{value:4,unit:'g',status:'supplied'}}};
  assert.equal(a.model.cachedScore(changed),null);
  assert.deepEqual(a.project('productWithCatalogueScore',{product:unknown,expiresAt:initialTime+60000,score:{...result,version:'old'}}),{});
  assert.ok(a.project('productWithCatalogueScore',{product:unknown,expiresAt:initialTime+60000,score:{...result,status:'estimated',estimated:true}}).product,'Current estimated nutrition uses the same validated contract');
  assert.equal(a.snapshot().state.foodLog.entries.length,0);
});

 test('fresh validated catalogue results take precedence consistently and expire without renewing on reads',()=>{
  const a=boot(),result=a.model.calculatedScore({...complete,nutrients:{...complete.nutrients,salt:{value:5,unit:'g',status:'supplied'}}});
  assert.notEqual(result.value,a.model.calculatedScore(complete).value);
  const product=a.project('productWithCatalogueScore',{product:complete,score:result,expiresAt:initialTime+60000}).product;
  assert.equal(a.model.score(product).value,result.value);
  a.open(product);assert.equal(a.project('reviewModel').score.value,result.value);
  assert.equal(a.project('productRecovery').canApplyCache,false,'An already bound catalogue score is not replayed through the ordinary recovery cache');
  assert.equal(a.project('productRecovery').needsRecovery,false);
  a.advance(60001);assert.equal(a.model.cachedScore(product),null);
  assert.equal(a.model.score(product).value,a.model.calculatedScore(complete).value);
  assert.deepEqual(a.project('productWithCatalogueScore',{product:complete,score:result,expiresAt:initialTime+60000}),{});
 });

test('new detailed catalogue evidence takes priority over older classification cache without discarding additional verified facts',()=>{
  const a=boot(),unknown={...complete,name:'Fixture food',ingredients:'',categoriesTags:[]},request=a.open(unknown);
  const result=a.model.calculatedScore(complete);
  a.apply(request,result,unresolved);
  assert.ok(a.project('productRating',{product:unknown}).score);
  assert.deepEqual(a.project('productRating',{product:unknown,catalogueScore:result,catalogueCalculatedAt:initialTime+1}),{});
  assert.ok(a.project('productRating',{product:unknown,catalogueScore:result,catalogueCalculatedAt:initialTime-1}).score);
  const b=boot(),missing=b.open(partial);b.apply(missing,b.model.calculatedScore(recovered),recovery);
  assert.ok(b.project('productRating',{product:partial,catalogueScore:result,catalogueCalculatedAt:initialTime+1}).score,
    'A verified newly supplied nutrient remains useful');
});

test('verified additional facts take the same precedence in detail as in cards',()=>{
  const a=boot(),request=a.open(partial),result=a.model.calculatedScore(recovered);
  a.apply(request,result,recovery);
  a.advance(1000);
  const prepared=a.project('productWithCatalogueScore',{product:partial,score:result,expiresAt:initialTime+60000}).product;
  const reopened=a.open(prepared,'new-catalogue','scan-new-catalogue');
  assert.equal(reopened.canApplyCache,true);
  assert.equal(reopened.cache.recovery.status,'verified');
  a.applyCache(reopened);
  assert.equal(a.snapshot().review.product.nutrients.fibre.value,recovered.nutrients.fibre.value);
  assert.equal(a.project('reviewModel').score.value,a.project('productRating',{product:partial,catalogueScore:result,catalogueCalculatedAt:initialTime+1000}).score.value);
});


test('compact scan model reads current score and allergy evidence without changing review, history or intake',()=>{
  const a=boot();a.open(complete,'existing-review','existing-history');
  const before=a.snapshot(),count=a.writes.length;
  const scan=a.project('productScanModel',{product:partial});
  assert.equal(scan.title,partial.name);assert.equal(scan.score.value,a.model.score(partial).value);
  assert.deepEqual(a.snapshot(),before);assert.equal(a.writes.length,count);
  const different={...complete,name:'Milk snack',ingredients:'Milk, peanuts',allergens:['en:milk','en:peanuts']};
  const second=a.project('productScanModel',{product:different});
  assert.ok(second.allergies.contains.some(v=>/milk/.test(v)));
  assert.deepEqual(a.snapshot(),before);assert.equal(a.writes.length,count);
});

test('compact scan and cards prefer current prepared score over an older private rough score',()=>{
  const a=boot(),request=a.open(partial),result=a.model.calculatedScore(partial);
  assert.equal(a.apply(request,result,unresolved).ok,true);
  a.advance(1000);
  const detailed=a.model.calculatedScore(complete);
  const prepared=a.project('productWithCatalogueScore',{product:partial,score:detailed,
    expiresAt:initialTime+100000,calculatedAt:initialTime+1000}).product;
  const scan=a.project('productScanModel',{product:prepared});
  assert.equal(scan.score.value,detailed.value);assert.equal(scan.score.methodId,detailed.methodId);
  assert.equal(a.snapshot().state.foodLog.entries.length,0);
});

test('source-bound catalogue quality hold suppresses local and recovered scores across restart, expiry and retries',()=>{
  const a=boot(), product={...complete,catalogueSourceFingerprint:'a'.repeat(64)};
  const core=a.s.NudgeScoreCore, result={methodId:core.SCORE_METHOD,version:core.SCORE_VERSION,classifierVersion:core.CLASSIFIER_VERSION,status:'unrated',available:false,value:null,grade:null,rawScore:null,category:'unknown',scoreBasis:'catalogue_quality_hold',reasonCodes:['catalogue_quality_hold','source_identity_conflict'],reason:'Source information needs checking before a score can be shown.',catalogueQualityHold:{version:'catalogue-quality-hold-v1',barcode:product.barcode,sourceFingerprint:product.catalogueSourceFingerprint,sourceFetchedAt:initialTime-1000,reviewedAt:initialTime,runID:'test-run-0001',reviewID:'test-review-0001',reasonCode:'source_identity_conflict',candidateSHA256:'b'.repeat(64)}};
  const bind=(score=result,facts=product)=>a.project('productWithCatalogueScore',{product:facts,score,expiresAt:initialTime+1000,calculatedAt:initialTime}).product;
  const held=bind();assert.ok(held);assert.notEqual(a.model.calculatedScore(product).value,null);
  a.s.NudgeFoodCatalogue.put(product,{inputFingerprint:a.model.scoreFingerprint(product),methodId:core.SCORE_METHOD,version:core.SCORE_VERSION,result:a.model.calculatedScore(product),checkedAt:new Date(initialTime+500).toISOString(),recovery:{...recovery,product}});
  const req=a.open(held);assert.equal(req.blockedByQualityHold,true);assert.equal(req.needsRecovery,false);assert.equal(req.canApplyCache,false);
  assert.equal(a.project('reviewModel').score.value,null);
  assert.equal(a.project('productRating',{product,catalogueScore:result,catalogueCalculatedAt:initialTime}).score.value,null);
  assert.equal(a.apply(req,a.model.calculatedScore(product),recovery).ok,false,'An in-flight older recovery cannot replace a hold');
  a.advance(40*86400000);assert.equal(a.model.score(held).value,null,'Source expiry alone cannot repair conflicting facts');
  const restarted=a.restart();assert.equal(restarted.open(held).blockedByQualityHold,true);assert.equal(restarted.project('reviewModel').score.value,null);
  assert.notEqual(a.model.score({...held,catalogueSourceFingerprint:'c'.repeat(64)}).value,null,'A different raw source cannot inherit a hold');
  assert.notEqual(a.model.score({...held,nutrients:{...held.nutrients,salt:{value:2,unit:'g',status:'supplied'}}}).value,null,'Edited facts invalidate the snapshot binding');
  assert.notEqual(a.model.score({...held,scoreResult:{...held.scoreResult,catalogueValidated:false}}).value,null,'Ordinary recovery cannot self-declare a hold');
  for(const change of [{barcode:'99999999'},{sourceFingerprint:'c'.repeat(64)},{version:'invented'},{reviewedAt:true},{candidateSHA256:'invalid'}])assert.equal(bind({...result,catalogueQualityHold:{...result.catalogueQualityHold,...change}}),undefined);
  assert.equal(bind({...result,value:100}),undefined);
});


test('authenticated score endpoint check sentinel without catalogue envelope cannot resurrect a local score',()=>{
 const a=boot(),request=a.open(complete),score=a.model.calculatedScore(complete);
 assert.notEqual(score.value,null);
 const check={methodId:score.methodId,version:score.version,classifierVersion:score.classifierVersion,status:'unrated',available:false,value:null,grade:null,rawScore:null,scoreBasis:'catalogue_quality_check',catalogueCheckRequired:true,catalogueCheckBarcode:complete.barcode,reasonCodes:['catalogue_quality_hold']};
 assert.equal(a.apply(request,check,null).ok,true);
 assert.equal(a.project('reviewModel').score.value,null);
 assert.equal(a.project('productRecovery').blockedByQualityCheck,true);
 assert.equal(a.project('productRecovery').needsRecovery,false);
 assert.equal(a.apply(request,score,recovery).ok,false,'Late numeric recovery cannot undo the pending catalogue check');
 assert.equal(a.s.NudgeFoodCatalogue.get(complete),null,'The sentinel is not durable catalogue authority');
});
