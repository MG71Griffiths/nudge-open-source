// Public catalogue rating payloads survive native history without lifting photo limits.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const key='nudge-scan-history-v1',copy=v=>JSON.parse(JSON.stringify(v));
function boot(storage=new Map()){
  const s={console,document:{},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}};s.window=s;vm.createContext(s);
  for(const file of ['streaks.js','core/food-log.js','core/diary.js','core/nudge-score.js','core/meal-score.js','food-detail-model.js','scan-history.js'])vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),s,{filename:file});
  const state={foodLog:{entries:[]}},history=s.createNudgeHistory({getState:()=>state,view:{},escapeHtml:String,todayKey:()=> '2026-10-07',render(){},navigate(){},showToast(){}});
  return {s,history,storage};
}
const app=boot(),n=value=>({value,unit:'g',status:'supplied'}),product={name:'Rice',ingredients:'Rice (100%)',ingredientsNeedsReview:false,barcode:'1234567890123',basisUnit:'g',nutritionPreparation:'as_sold',sourceName:'Open Food Facts',nutrients:{energyKcal:{value:130,unit:'kcal',status:'supplied'},protein:n(3),fibre:n(4),fat:n(1),saturatedFat:n(.1),sugars:n(.3),salt:n(.1)}};
const score=copy(app.s.NudgeFoodDetailModel.score(product));assert.equal(score.value,100);
score.explanation='Evidence – nutrition '.repeat(230);score.limits=['Public source attribution '.repeat(120)];
const scoreData=Buffer.from(JSON.stringify(score)).toString('base64');assert.ok(scoreData.length>10000);assert.ok(Buffer.from(scoreData,'base64').length<32768);
const rating={method:'nudge_nutrition_v0_3',version:'0.3',classifierVersion:app.s.NudgeScoreCore.CLASSIFIER_VERSION,sourceRevision:1770000000,fetchedAt:810000000,calculatedAt:810000001,expiresAt:812592000,snapshotFingerprint:'a'.repeat(64),scoreData};
const item=(id,r=rating)=>({id,kind:'product',status:'ready',createdAt:'2026-10-07T20:00:00Z',product:{...product,catalogueRating:r}});
app.history.record(item('intact'));
assert.deepEqual(copy(app.history.find('intact').product.catalogueRating),rating);
assert.deepEqual(JSON.parse(Buffer.from(app.history.find('intact').product.catalogueRating.scoreData,'base64')),score);
const reloaded=boot(app.storage);assert.deepEqual(copy(reloaded.history.find('intact').product.catalogueRating),rating,'Reload keeps every byte, including Unicode');
reloaded.history.toggleFavourite(reloaded.history.find('intact').product);
assert.deepEqual(JSON.parse(app.storage.get(key)).favouriteProducts[0].product.catalogueRating,rating);
reloaded.history.record({...item('intact'),product:{...product,name:'Brown rice',catalogueRating:rating}});
assert.deepEqual(copy(reloaded.history.find('intact').analysisVersions[0].product.catalogueRating),rating,'Prior evidence versions keep intact ratings');

const invalids=[
  {...rating,scoreData:scoreData.slice(0,6000)},
  {...rating,scoreData:'%%%='},
  {...rating,scoreData:Buffer.from('not JSON').toString('base64')},
  {...rating,scoreData:Buffer.from(JSON.stringify({...score,limits:['x'.repeat(40000)]})).toString('base64')},
  {...rating,scoreData:Buffer.from(JSON.stringify({...score,value:103})).toString('base64')},
  {...rating,scoreData:Buffer.from(JSON.stringify({...score,photo:'data:image/jpeg;base64,private'})).toString('base64')},
  {...rating,snapshotFingerprint:'invalid'},
  {...rating,sourceRevision:1.5},
  {...rating,expiresAt:rating.fetchedAt-1}
];
invalids.forEach((bad,i)=>{app.history.record(item('bad-'+i,bad));const p=app.history.find('bad-'+i).product;assert.equal(Object.hasOwn(p,'catalogueRating'),false,'Invalid payload is dropped whole: '+i);assert.equal(p.nutrients.protein.value,3);});
const legacy=new Map([[key,JSON.stringify({events:[item('legacy-truncated',invalids[0])]})]]);assert.equal(Object.hasOwn(boot(legacy).history.find('legacy-truncated').product,'catalogueRating'),false,'Existing corrupt history remains readable');
app.history.record({...item('private'),product:{...product,catalogueRating:rating,photo:'data:image/jpeg;base64,private',notes:'x'.repeat(7000),otherEncoded:'A'.repeat(10001)}});
const privateProduct=app.history.find('private').product;assert.equal(Object.hasOwn(privateProduct,'photo'),false);assert.equal(privateProduct.notes.length,6000);assert.equal(privateProduct.otherEncoded,'');
assert.equal(app.s.atob,undefined,'Works in JavaScriptCore without browser decoding globals');
console.log('Passed: bounded catalogue rating survives history, favourites, prior versions and reload; malformed, oversized and private payloads are dropped whole while ordinary limits remain.');
