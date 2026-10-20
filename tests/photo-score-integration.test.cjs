// Offline regression: photo facts, score fallback, and existing History never log intake.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {boot}=require('./food-detail.test.cjs');
const labelBoot=require('./label-photo.test.cjs').boot;
const values={energyKcal:375,protein:4.5,fibre:2,fat:.6,saturatedFat:.1,carbohydrate:87,sugars:37,salt:.83};
const extraction={type:'product',productName:'Corn flakes',brand:'Test fixture',basis:'per100g',nutritionPreparation:'as_sold',categoryTag:'en:corn-flakes',labelKind:'both',needsClearerPhoto:false,ingredients:{text:'Maize (61%), sugar (37%), salt (2%)',needsReview:false,plants:[]},energyKj:{value:1594,unit:'kJ'},nutrients:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g'}]))};
const app=boot();for(const file of ['core/product-evidence.js','scan-results.js'])vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),app.sandbox);
const product=app.sandbox.NudgeResults.fromExtraction(extraction),original=JSON.stringify(product),facts=app.model.scoreFacts(product);
assert.equal(facts.nutrients.salt.status,'supplied');assert.equal(facts.nutrients.salt.value,.83);
assert.equal(product.nutrients.salt.status,'extracted');assert.equal(JSON.stringify(product),original);
assert.equal(facts.nutrientSources.salt,'Photo label extraction: printed g per 100 g');
const score=app.model.score(product);assert.equal(score.status,'rated');assert.equal(score.value,25);assert.equal(score.displayUpper,25);assert.equal(score.inputs.fvlPercent,0);
// Every field needs its own compatible label source. Similar text, unknown/estimated values
// and inequalities cannot turn into exact inputs, even if another field is readable.
for(const change of [
 {sourceName:'AI estimate'},
 {nutrientSources:{...product.nutrientSources,salt:'Photo label extraction: printed g per 100 ml'}},
 {nutrientSources:{...product.nutrientSources,salt:'Photo label extraction: printed kcal per 100 g'}},
 {nutrientSources:{...product.nutrientSources,salt:''}},
 {nutrients:{...product.nutrients,salt:{value:.83,status:'estimated'}}},
 {nutrients:{...product.nutrients,salt:{value:.83,status:'unknown'}}},
 {nutrients:{...product.nutrients,salt:{value:.83,status:'extracted',relation:'approx'}}},
 {metadata:{conflicts:[{field:'nutrition'}]}}
])assert.equal(app.model.score({...product,...change}).status,'unrated');
const milk={...product,sourceName:'Photo label extraction + stored Open Food Facts'};
assert.equal(app.model.score(milk).value,25);
const serving=app.sandbox.NudgeResults.fromExtraction({...extraction,basis:'perServing',servingSize:{value:25,unit:'g'},energyKj:{value:398.5,unit:'kJ'},nutrients:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value:value/4,unit:key==='energyKcal'?'kcal':'g'}]))});
assert.equal(app.model.score(serving).value,25);assert.equal(app.model.scoreFacts(serving).nutrients.salt.value,.83);
const absent=structuredClone(extraction);absent.nutrients.salt=null;
assert.equal(app.model.score(app.sandbox.NudgeResults.fromExtraction(absent)).value,null);
// Old saved photo scans acquire a locally calculated result, replacing an unrated
// cache while preserving the original facts and all confirmed intake snapshots.
const old={...product,scoreResult:{methodId:'nudge_label_v0_1',version:'1',inputFingerprint:'old-extracted-facts',result:{status:'unrated',methodId:'nudge_label_v0_1',version:'1',value:null,grade:null,rawScore:null}}};
app.history.record({id:'old-photo',kind:'product',status:'ready',product:old});
const before=JSON.stringify(app.data);app.history.reopen('old-photo');
assert.equal(app.controller.detail().score.value,25);assert.equal(JSON.stringify(app.data),before);assert.equal(app.writes(),0);
assert.equal(app.messages.filter(m=>m.action==='product-score').length,0);
assert.match(app.history.screen(),/Nudge (?:nutrition )?score 25 out of 100/);
app.input('detail-measure','g');app.input('detail-quantity','30');app.action('detail-log');const saved=JSON.stringify(app.data),savedID=app.data.foodLog.entries[0].id;
const restarted=boot({storage:app.storage,reload:true});restarted.history.reopen('old-photo');
assert.equal(restarted.controller.detail().score.value,25);assert.equal(JSON.stringify(restarted.data),saved);assert.equal(restarted.data.foodLog.entries[0].id,savedID);assert.equal(restarted.writes(),0);
// A photo result arrives while the label screen is active. Once its detail renders,
// an unavailable local classification must start the existing protected fallback once.
const unknown=labelBoot();unknown.review({...extraction,categoryTag:null,productName:'Unknown product'});
assert.equal(unknown.view.screen,'barcode');const barcode=unknown.sandbox.NudgeBarcode;
barcode.screen();assert.equal(unknown.messages.filter(m=>m.action==='product-score').length,1);
for(let i=0;i<10;i++)barcode.screen();assert.equal(unknown.messages.filter(m=>m.action==='product-score').length,1);
assert.equal(unknown.writes(),0);assert.equal(unknown.data.foodLog.entries.length,0);
const first=unknown.messages.find(m=>m.action==='product-score');unknown.view.screen='history';
barcode.receive({type:'product-score-error',requestId:first.requestId,draftId:first.draftId,error:'Stale response'});
assert.equal(unknown.data.foodLog.entries.length,0);
console.log('Passed: extracted-label provenance, per-serving normalization, conservative score, saved-scan recovery, intake preservation, photo-screen score fallback once and stale callback guard.');
