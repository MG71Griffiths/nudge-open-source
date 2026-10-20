// Synthetic facts only: real web model/controller/storage, no provider calls or owner data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const web=path.resolve(__dirname,'../Web'),copy=v=>JSON.parse(JSON.stringify(v)),DAY=86400000;
function boot(storage=new Map(),now=Date.now()){
  const messages=[],data={foodLog:{entries:[],savedRecipes:[],plantGoal:30},nutritionProfile:{},completions:{}},view={screen:'barcode'};
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const sandbox={Date:Clock,Math,console,document:{getElementById:()=>null},scrollTo(){},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}};
  sandbox.window=sandbox;sandbox.webkit={messageHandlers:{nudgeBarcode:{postMessage:m=>messages.push(m)}}};
  sandbox.NudgeResults={product:()=>'',finding:()=>''};vm.createContext(sandbox);
  for(const file of ['shared-controls.js','streaks.js','core/diary.js','core/food-log.js','food-patterns.js','core/nutrition-profile.js','nudge-fit.js','core/nudge-score.js','core/meal-score.js','food-detail-model.js','food-catalogue.js','core/frequency-policy.js','scan-history.js','barcode.js'])vm.runInContext(fs.readFileSync(path.join(web,file),'utf8'),sandbox,{filename:file});
  const ctx={getState:()=>data,view,escapeHtml:v=>String(v??''),todayKey:()=>new Clock().toISOString().slice(0,10),save:()=>true,render(){},navigate:s=>view.screen=s,showToast(){}};
  sandbox.NudgeHistory=sandbox.createNudgeHistory(ctx);sandbox.NudgeBarcode=sandbox.createNudgeBarcode(ctx);
  const app={sandbox,data,view,storage,messages,catalogue:sandbox.NudgeFoodCatalogue,model:sandbox.NudgeFoodDetailModel,controller:sandbox.NudgeBarcode,history:sandbox.NudgeHistory,advance:ms=>now+=ms};
  app.receive=(product,id='fixture')=>app.controller.receive({type:'product',eventId:id,product:copy(product)});
  app.requests=()=>messages.filter(m=>m.action==='product-score');
  app.respond=(score,recovery,request=app.requests().at(-1))=>app.controller.receive({type:'product-score',requestId:request.requestId,draftId:request.draftId,result:{score:copy(score),recovery:recovery&&copy(recovery)}});
  return app;
}
const complete={name:'Chickpeas',ingredients:'Chickpeas (100%)',ingredientsNeedsReview:false,brand:'Test Foods',barcode:'12345678',sourceName:'Open Food Facts',sourceURL:'https://world.openfoodfacts.org/product/12345678',basisUnit:'g',servingAmount:100,servingUnit:'g',nutritionPreparation:'as_sold',categories:[],categoriesTags:['en:legumes'],nutrients:Object.fromEntries(Object.entries({energyKcal:100,protein:6.7,fibre:5.7,salt:.53,sugars:1,fat:2,saturatedFat:.3,carbohydrate:13.9}).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:'supplied'}]))};
const partial={...complete,nutrients:{...complete.nutrients,fibre:{value:null,unit:'g',status:'unknown'},sugars:{value:null,unit:'g',status:'unknown'}}};
const initial=boot(),m=initial.model;
assert.deepEqual(copy(m.scoreFacts(complete).categories),['en:legumes'],'Empty categories must retain useful category tags');
assert.deepEqual(copy(m.scoreFacts({...complete,categories:['en:legumes','en:pulses']}).categories),['en:legumes','en:pulses']);
assert.match(m.scoreFingerprint(complete),new RegExp(initial.sandbox.NudgeScoreCore.CLASSIFIER_VERSION));
const result=m.calculatedScore(complete),unrated=m.calculatedScore(partial);
assert.equal(result.status,'rated');assert.equal(unrated.status,'unrated');

// Persistence is fingerprint-specific, bounded, independent of media/account/intake and expires.
const dirty={...complete,imageURL:'private-photo',imageBase64:'private-body',audio:'private-voice',email:'private-account',sourceMeta:{confirmationId:'private-intake'}};
const cache={inputFingerprint:m.scoreFingerprint(dirty),methodId:result.methodId,version:result.version,result:{...result,profile:{email:'private-score'},sourceData:{...result.sourceData,voiceMemo:'private-nested'}},checkedAt:new Date().toISOString()};
assert.equal(initial.catalogue.put(dirty,cache),true);
const serial=initial.storage.get(initial.catalogue.key);assert.doesNotMatch(serial,/private-/);
const second=boot(initial.storage);assert.equal(second.catalogue.get(complete).result.value,result.value);
assert.equal(second.catalogue.get({...complete,brand:'Different variant'}),null);
assert.equal(second.catalogue.get({...complete,nutrients:{...complete.nutrients,salt:{value:1.4,unit:'g',status:'supplied'}}}),null);
assert.equal(boot(initial.storage,Date.now()+31*DAY).catalogue.get(complete),null);
for(let n=0;n<180;n++){const food={...complete,barcode:String(10000000+n),name:'Chickpeas '+n};initial.catalogue.put(food,{...cache,inputFingerprint:m.scoreFingerprint(food)});}
const bounded=JSON.parse(initial.storage.get(initial.catalogue.key));assert.ok(bounded.records.length<=128);assert.ok(JSON.stringify(bounded).length*2<=initial.catalogue.limits.bytes);

// Old unavailable results retry once; rendering, restart and repeated callbacks do not loop.
const stale=boot(),old={...partial,scoreResult:{inputFingerprint:stale.model.scoreFingerprint(partial),methodId:unrated.methodId,version:unrated.version,result:copy(unrated)}};
stale.receive(old);assert.equal(stale.requests().length,1);
stale.respond(unrated,{version:'food-recovery-v1',status:'unresolved',provenance:[],conflicts:[],addedFields:[]});
for(let n=0;n<5;n++)stale.controller.screen();stale.receive(partial);assert.equal(stale.requests().length,1);
const retry=boot(stale.storage);retry.receive(partial,'later');assert.equal(retry.requests().length,0,'Incomplete recovery cooldown survives restart');
retry.advance(6*3600000+1);retry.controller.screen();assert.equal(retry.requests().length,1,'Incomplete results can recover again after bounded cooldown');
retry.controller.screen();assert.equal(retry.requests().length,1);
const revised={...partial,scoreResult:{...old.scoreResult,inputFingerprint:old.scoreResult.inputFingerprint.replace(initial.sandbox.NudgeScoreCore.CLASSIFIER_VERSION,'older-classifier')}};
assert.equal(m.cachedScore(revised),null,'Classifier revision invalidates old analysis, not intake');

// Exact matched evidence only fills missing values; original analysis is archived once.
const sourced={...complete,nutrientSources:{fibre:'Open Food Facts exact barcode record'}};
const recovery={version:'food-recovery-v1',status:'verified',product:sourced,addedFields:['nutrients.fibre','nutrients.sugars'],conflicts:[],provenance:[{title:'Open Food Facts',url:complete.sourceURL,retrievedAt:new Date().toISOString()}]};
const recovered=boot();recovered.receive(partial);const before=JSON.stringify(recovered.data);recovered.respond(result,recovery);
assert.equal(recovered.controller._scan.product.nutrients.fibre.value,5.7);assert.equal(recovered.controller._scan.product.nutrients.salt.value,.53);
assert.equal(recovered.history.items().length,1);assert.equal(JSON.stringify(recovered.data),before);
assert.ok(recovered.history.find('fixture').analysisVersions.some(v=>v.product.nutrients.fibre.value===null));
const offline=boot(recovered.storage);offline.receive(partial,'offline-repeat');assert.equal(offline.requests().length,0);assert.equal(offline.controller._scan.product.nutrients.fibre.value,5.7);assert.equal(offline.controller.detail().score.value,result.value);
assert.equal(recovered.catalogue.mergeRecovery(partial,{...recovery,product:{...sourced,barcode:'87654321'}}),null);
assert.equal(recovered.catalogue.mergeRecovery(partial,{...recovery,product:{...sourced,nutritionPreparation:'prepared'}}),null);
assert.equal(recovered.catalogue.mergeRecovery(partial,{...recovery,product:{...sourced,nutrients:{...sourced.nutrients,salt:{value:0,unit:'g',status:'supplied'}}}}),null,'Known salt can never be replaced by lookup');

// Source composition is explicitly estimated and never supplies intake nutrients.
const estimate={...result,status:'estimated_provisional',estimated:true,scoreBasis:'sourced_composition',sources:[{title:'Generic food reference',url:'https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid'}],assumptions:['Generic reference; actual recipe may differ.']};
const estimated=boot();estimated.receive(partial);estimated.respond(unrated,{version:'food-recovery-v1',status:'estimated',addedFields:[],conflicts:[],provenance:[],estimate:{sourceRecord:{id:'generic-fixture',name:'Cooked chickpeas'},score:estimate}});
assert.equal(estimated.controller.detail().score.status,'estimated_provisional');assert.equal(estimated.controller.detail().score.value,result.value);assert.equal(estimated.controller._scan.product.nutrients.fibre.value,null);assert.equal(estimated.data.foodLog.entries.length,0);
const estimatedReload=boot(estimated.storage);estimatedReload.receive(partial,'new-estimate');assert.equal(estimatedReload.requests().length,0);assert.equal(estimatedReload.controller.detail().score.status,'estimated_provisional');assert.equal(estimatedReload.controller._scan.product.nutrients.fibre.value,null);
estimatedReload.controller.handleAction('detail-log');assert.equal(estimatedReload.data.foodLog.entries[0].fibrePerPortion,null);const diaryBefore=JSON.stringify(estimatedReload.data.foodLog);
estimatedReload.controller.handleAction('detail-score-retry');estimatedReload.respond(result,recovery);assert.equal(JSON.stringify(estimatedReload.data.foodLog),diaryBefore,'Recovery must never rewrite a consumed record');

// Deleted scans remain deleted when a recovery callback arrives.
const deleted=boot();deleted.receive(partial);const request=deleted.requests()[0];deleted.history.handleAction('history-delete','fixture');deleted.history.handleAction('history-delete-confirm');deleted.respond(result,recovery,request);assert.equal(deleted.history.items().length,0);assert.equal(deleted.data.foodLog.entries.length,0);
console.log('Passed: category merge/revision; bounded persistent public evidence; offline score reuse; stale-unrated bounded recovery; exact-only missing supplements; explicit generic estimates; source/diary/deletion preservation.');


// An authenticated catalogue hold must survive the bounded display cache and
// stop even an explicit barcode recovery retry from rescoring unchanged facts.
{
 const app=boot(),p={...complete,catalogueSourceFingerprint:'a'.repeat(64)},core=app.sandbox.NudgeScoreCore,now=Date.now();
 const held={methodId:core.SCORE_METHOD,version:core.SCORE_VERSION,classifierVersion:core.CLASSIFIER_VERSION,status:'unrated',available:false,value:null,grade:null,rawScore:null,category:'unknown',scoreBasis:'catalogue_quality_hold',reasonCodes:['catalogue_quality_hold'],catalogueQualityHold:{version:'catalogue-quality-hold-v1',barcode:p.barcode,sourceFingerprint:p.catalogueSourceFingerprint,sourceFetchedAt:now-1000,reviewedAt:now,runID:'test-run-0001',reviewID:'test-review-0001',reasonCode:'source_identity_conflict',candidateSHA256:'b'.repeat(64)}};
 const cache={inputFingerprint:app.model.scoreFingerprint(p),methodId:core.SCORE_METHOD,version:core.SCORE_VERSION,result:held,catalogueValidated:true,catalogueExpiresAt:now+1000,checkedAt:new Date(now).toISOString()};
 assert.equal(app.catalogue.put(p,cache),true);const restored=app.catalogue.get(p);assert.equal(restored.catalogueValidated,true);assert.deepEqual(copy(restored.result.catalogueQualityHold),held.catalogueQualityHold);
 assert.equal(app.catalogue.put(p,{...cache,catalogueValidated:false}),false);
 assert.equal(app.catalogue.get({...p,catalogueSourceFingerprint:'c'.repeat(64)}),null);
 app.receive({...p,scoreResult:restored});app.controller.screen();assert.equal(app.requests().length,0);assert.equal(app.model.score({...p,scoreResult:restored}).value,null);
 app.advance(2*86400000);app.controller.screen();assert.equal(app.requests().length,0,'Expiry alone must not retry held facts');
}
