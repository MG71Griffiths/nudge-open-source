// Real SwiftUI domain adapter, storage, history, catalogue and scoring modules.
// Synthetic product fixtures only; no provider requests or owner data.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const copy=value=>JSON.parse(JSON.stringify(value));
const web=path.resolve(__dirname,'../Web');
const historyKey='nudge-scan-history-v1';
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
  session.open=(product=complete,confirmationId='confirmation-1',eventId='scan-1')=>{
    assert.equal(session.perform('recordHistory',{id:eventId,kind:'product',status:'ready',name:product.name,barcode:product.barcode,product}).ok,true);
    assert.equal(session.perform('setReview',{kind:'product',product,confirmationId,eventId}).ok,true);
    return session.project('productRecovery');
  };
  return session;
}
const nutrients=values=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:value===null?'unknown':'supplied'}]));
const complete={name:'Chickpeas',brand:'Fixture Foods',barcode:'12345678',sourceName:'Open Food Facts',sourceURL:'https://world.openfoodfacts.org/product/12345678',basisUnit:'g',servingAmount:100,servingUnit:'g',nutritionPreparation:'as_sold',categoriesTags:['en:legumes'],nutrients:nutrients({energyKcal:100,protein:6.7,fibre:5.7,salt:.53,sugars:1,fat:2,saturatedFat:.3,carbohydrate:13.9})};

const source='https://images.openfoodfacts.org/images/products/12345678/front_en.1.400.jpg';
const pictured={...complete,imageURL:null,retainedPublicImageURL:source};

test('retained catalogue image survives scan, detail, durable history and saved-food roundtrip',()=>{
  const a=boot(),before=JSON.stringify(pictured),diary=a.snapshot().state.foodLog;
  assert.equal(a.project('productScanModel',{product:pictured}).image,source);
  assert.equal(a.snapshot().history.events.length,0,'Scan projection is read-only');
  a.open(pictured);
  assert.equal(a.project('reviewModel').image,source);
  assert.equal(a.project('history').rows[0].imageURL,source);
  assert.equal(a.snapshot().history.events[0].product.retainedPublicImageURL,source);
  assert.equal(a.perform('reviewSaveFood').ok,true);
  const saved=a.snapshot().foods.foods[0];assert.equal(saved.image,source);
  assert.deepEqual(a.snapshot().state.foodLog,diary,'Saving an image never logs intake');
  assert.equal(JSON.stringify(pictured),before);
  const b=a.restart(),history=b.snapshot().history.events[0];
  assert.equal(history.product.retainedPublicImageURL,source);
  assert.equal(b.project('history').rows[0].imageURL,source);
  b.perform('setReview',{kind:'product',product:history.product,eventId:history.id,confirmationId:'reopen'});
  assert.equal(b.project('reviewModel').image,source);
  assert.equal(b.perform('openSaved',{id:saved.id,confirmationId:'saved-reopen'}).ok,true);
  assert.equal(b.project('reviewModel').image,source);
  assert.equal(b.perform('reviewConfirm').ok,true);
  const logged=b.snapshot().state.foodLog.entries;assert.equal(logged.length,1);
  assert.equal(logged[0].sourceMeta.repertoireId,saved.id);
  assert.equal(logged[0].sourceMeta.repertoireImage,source);
  assert.equal(logged[0].nutritionSnapshot.protein.portion,complete.nutrients.protein.value);
  assert.equal(b.project('history',{filter:'all'}).rows.filter(row=>row.imageURL===source).length,2);
  const c=b.restart();
  assert.equal(c.project('history',{filter:'all'}).rows.filter(row=>row.imageURL===source).length,2);
  assert.deepEqual(c.snapshot().state.foodLog.entries,logged,'Restart preserves the confirmed intake and its image');
});

test('retained fallback rejects wrong identity, private photos and untrusted source metadata',()=>{
  const a=boot();
  for(const patch of [{barcode:'87654321'},{sourceName:'Photo analysis'},{sourceKind:'nudge_community'},
    {communityProvenance:{}},{retainedPublicImageURL:'data:image/jpeg;base64,YWJj'},
    {retainedPublicImageURL:source+'?token=private'},{retainedPublicImageURL:source.replace('/12345678/','/87654321/')}]){
    const product={...pictured,...patch};
    assert.equal(a.s.NudgeProductEvidence.publicProductImage(product),'');
    assert.equal(a.project('productScanModel',{product}).image,'');
  }
  const primary=source.replace('front_en.1','front_en.2');
  assert.equal(a.s.NudgeProductEvidence.publicProductImage({...pictured,imageURL:primary}),primary);
  assert.equal(a.s.NudgeProductEvidence.publicProductImage({...pictured,barcode:'5012345678901',retainedPublicImageURL:'https://images.openfoodfacts.org/images/products/501/234/567/8901/front_en.1.400.jpg'}),'https://images.openfoodfacts.org/images/products/501/234/567/8901/front_en.1.400.jpg');
});

test('compatible label enrichment keeps retained public photo but identity conflicts do not',()=>{
  const a=boot(),extraction={schemaVersion:1,productName:complete.name,brand:complete.brand,basis:'per100g',nutritionPreparation:'as_sold',nutrients:complete.nutrients};
  const enriched=a.s.NudgeProductEvidence.augmentFromLabel(extraction,pictured);
  assert.equal(enriched.imageURL,source);
  assert.equal(a.project('productScanModel',{product:enriched}).image,source);
  const different=a.s.NudgeProductEvidence.augmentFromLabel({...extraction,brand:'Different fixture brand'},pictured);
  assert.equal(a.s.NudgeProductEvidence.publicProductImage(different),'');
  assert.equal(a.snapshot().state.foodLog.entries.length,0);
});
