// History presentation uses isolated synthetic records and never writes intake or requests analysis.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy=value=>JSON.parse(JSON.stringify(value));
function boot(entries=[],storage=new Map()){
  let writes=0,historyWrites=0;const sandbox={console,Date,Math,document:{getElementById:()=>null},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>{historyWrites++;storage.set(key,value);},removeItem:key=>storage.delete(key)}};
  sandbox.window=sandbox;sandbox.NudgeIcons=()=>'';sandbox.NudgeResults={finding:()=>'',imageURL:()=>''};vm.createContext(sandbox);
  for(const file of ['streaks.js','core/diary.js','core/food-log.js','food-patterns.js','core/nutrition-profile.js','nudge-fit.js','core/nudge-score.js','core/meal-score.js','food-detail-model.js','core/product-evidence.js','core/frequency-policy.js','diet.js','scan-history.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),sandbox,{filename:file});
  const data={foodLog:sandbox.WmdFoodLog.clean({entries})};const history=sandbox.createNudgeHistory({getState:()=>data,view:{},escapeHtml:esc,todayKey:()=> '2026-10-03',render(){},navigate(){},showToast(){},save(){writes++;return true;}});
  return {data,history,sandbox,storage,writes:()=>writes,historyWrites:()=>historyWrites};
}
const n=(value,unit='g')=>({value,unit,status:value===null?'unknown':'supplied'});
const product=()=>({name:'Cereal fixture',scoringFacts:{fvlPercent:{value:0,source:'declared',evidence:'Synthetic fixture'}},sourceName:'Photographed label',categoryTag:'en:corn-flakes',basisUnit:'g',nutritionPreparation:'as_sold',ingredientsNeedsReview:true,servingAmount:100,servingUnit:'g',energyKj:n(1594,'kJ'),nutrients:Object.fromEntries(Object.entries({energyKcal:375,protein:4.5,fibre:2,fat:.6,saturatedFat:.1,carbohydrate:87,sugars:37,salt:.83}).map(([key,value])=>[key,n(value,key==='energyKcal'?'kcal':'g')]))});
const record=(id,overrides={})=>({id,createdAt:'2026-10-03T12:00:00Z',kind:'product',status:'ready',name:'Synthetic food',product:product(),...overrides});
const entry=(id,overrides={})=>({id,name:'Logged fixture',day:'2026-10-03',slot:'Lunch',portions:1,plants:[],ferments:[],energyPerPortion:100,proteinPerPortion:8,fibrePerPortion:2,portionAmount:125,portionUnit:'g',...overrides});
const mealRecord={id:'synthetic-veg',basis:'per100g',foodGroup:'vegetable',fvlEligible:true,nutrients:Object.fromEntries(Object.entries({energyKcal:25,sugars:2,saturatedFat:.1,salt:.03,fibre:2.5,protein:2,fat:.5,carbohydrate:3}).map(([key,value])=>[key,n(value,key==='energyKcal'?'kcal':'g')]))};
const meal=()=>({name:'Vegetable fixture',basis:'perPortion',portionMode:'estimated_serving',portion:{amount:200,unit:'g'},nutrients:{energyKcal:n(50,'kcal'),protein:n(4),salt:n(.06)},components:[{name:'Vegetable',amountGrams:200,recordId:mealRecord.id,sourceRecord:copy(mealRecord)}]});
const row=(html,id)=>{const match=html.match(new RegExp('data-action="history-open" data-value="'+id+'">([\\s\\S]*?)</button>'));assert.ok(match,'Missing row '+id);return match[1];};
const hasScore=(html,id,value,tone)=>{const content=row(html,id);assert.match(content,new RegExp('class="n-score n-score-'+tone+'"'));assert.match(content,new RegExp('>'+value+'<small>/100</small>'));assert.doesNotMatch(content,/g protein|<small>(?:provisional|estimated)|\d+%/);return content;};
const unknown=(html,id)=>assert.match(row(html,id),/class="n-score n-score-unknown" aria-label="Score unavailable">—<\/span>/);

// Product and meal analyses use the same right-side score slot. Qualifiers remain outside the badge.
const app=boot();app.history.record(record('cereal'));app.history.record(record('meal',{kind:'meal',product:null,extraction:{type:'meal',meal:meal()}}));
const expectedMeal=app.sandbox.NudgeMealScore.calculate(meal());assert.equal(expectedMeal.available,true);
let html=app.history.screen();const cerealRow=hasScore(html,'cereal',25,'amber');assert.match(cerealRow,app.sandbox.NudgeScoreCore.ACTIVE_DIRECTIONAL?/Nudge score · Saved/:/v0.3 · Saved/);assert.doesNotMatch(cerealRow,/25 to 25|25–25/);
const mealRow=hasScore(html,'meal',expectedMeal.value,'green');assert.match(mealRow,app.sandbox.NudgeScoreCore.ACTIVE_DIRECTIONAL?/200 g · 50 kcal · estimated · Nudge score · ready to log/:/200 g · 50 kcal · estimated · v0.3 · ready to log/);
assert.doesNotMatch(html,/n-meal-value|g protein/);

// A genuine zero score is displayed as 0/100, never treated as missing.
const high=product();high.energyKj=n(3500,'kJ');high.nutrients={energyKcal:n(837,'kcal'),fat:n(20),saturatedFat:n(11),carbohydrate:n(60),sugars:n(55),salt:n(4.5),fibre:n(0),protein:n(0)};high.scoringFacts={fvlPercent:{value:0,source:'declared',evidence:'Synthetic fixture'}};
app.history.record(record('zero',{product:high}));hasScore(app.history.screen(),'zero',0,'red');
for(const status of ['pending','failed','unknown']){app.history.record(record(status,{status}));unknown(app.history.screen(),status);}
// Legacy portion semantics do not change which score is shown in History vs detail:
// the shared calculator uses supported nutrition first, otherwise a rough estimate.
const legacyAnalysis={...meal(),portionMode:'photographed_portion'};
app.history.record(record('legacy-meal',{kind:'meal',product:null,extraction:{type:'meal',meal:legacyAnalysis}}));hasScore(app.history.screen(),'legacy-meal',app.sandbox.NudgeMealScore.calculate(legacyAnalysis).value,'green');assert.doesNotMatch(row(app.history.screen(),'legacy-meal'),/Rough estimate/);
const legacyRough={name:'Pizza',portionMode:'photographed_portion',components:[]};
app.history.record(record('legacy-rough',{kind:'meal',product:null,extraction:{type:'meal',meal:legacyRough}}));const roughScore=app.sandbox.NudgeMealScore.estimate(legacyRough);hasScore(app.history.screen(),'legacy-rough',roughScore.value,app.sandbox.NudgeScoreCore.displayTone(roughScore.value));assert.match(row(app.history.screen(),'legacy-rough'),/Rough estimate/);
assert.match(row(app.history.screen(),'legacy-rough'),/<small>Rough<\/small>/);
const partialProduct=boot();partialProduct.sandbox.NudgeResults.finding=()=> 'Ingredients available · more label data needed';partialProduct.history.record(record('rough-label',{product:{name:'Wholegrain oat snack',ingredients:'Wholegrain oats',basisUnit:'g',nutrients:{}}}));
unknown(partialProduct.history.screen(),'rough-label');assert.doesNotMatch(row(partialProduct.history.screen(),'rough-label'),/Rough estimate/);
app.history.record(record('unidentified',{kind:'unknown',product:null,extraction:null}));unknown(app.history.screen(),'unidentified');
app.history.record(record('unknown-with-stale-product',{kind:'unknown'}));unknown(app.history.screen(),'unknown-with-stale-product');

// Confirmed intake preserves the exact saved product score even if source analysis now differs.
const savedProductScore=copy(app.sandbox.NudgeFrequency.apply(app.sandbox.NudgeFoodDetailModel.score(high),{salt:4.5}));
const loggedProduct=entry('product-intake',{portions:2,sourceMeta:{entryKind:'product-consumption',confirmationId:'product-intake',productScanEventId:'changed-scan',scanEventId:'changed-scan',scoreMethod:savedProductScore}});
const loggedMeal=entry('meal-intake',{portionAmount:150,sourceMeta:{scanEventId:'changed-meal',mealComposition:meal().components,mealPortionMode:'estimated_serving',nutritionEstimate:'photo',mealScore:{available:true,status:'estimated',methodVersion:'nudge_meal_v0_3',value:60}}});
const legacy=entry('legacy-intake',{proteinPerPortion:80});
const savedUnknown=entry('unavailable-intake',{sourceMeta:{entryKind:'product-consumption',productScanEventId:'changed-scan',scoreMethod:{methodId:'nudge_label_v0_1',version:'1',status:'unrated',value:null}}});
const confirmed=boot([loggedProduct,loggedMeal,legacy,savedUnknown]);confirmed.history.record(record('changed-scan'));confirmed.history.record(record('changed-meal',{kind:'meal',entryId:'meal-intake',product:null,extraction:{type:'meal',meal:meal()}}));
html=confirmed.history.screen();hasScore(html,'changed-scan',0,'red');assert.match(row(html,'changed-scan'),/250 g/);assert.doesNotMatch(row(html,'changed-scan'),/frequency needs recheck/);if(!app.sandbox.NudgeScoreCore.ACTIVE_DIRECTIONAL)assert.match(row(html,'changed-scan'),/<small>Grade E<\/small>/);else assert.doesNotMatch(row(html,'changed-scan'),/Grade E/);assert.equal(confirmed.data.foodLog.entries[0].sourceMeta.scoreMethod.finalFrequency,null);
hasScore(html,'changed-meal',60,'green');assert.match(row(html,'changed-meal'),/150 g/);unknown(html,'diary:legacy-intake');hasScore(html,'diary:unavailable-intake',25,'amber');
// A failed or pending source re-analysis must not hide the already confirmed score.
for(const status of ['failed','pending','unknown']){
  const saved=boot([loggedProduct]);saved.history.record(record('changed-scan',{status}));
  saved.history.handleAction('history-filter','eaten');hasScore(saved.history.screen(),'changed-scan',0,'red');assert.match(saved.history.screen(),/✓ Eaten/);assert.equal(saved.writes(),0);
}
// Missing saved ratings project available source scores without replacing snapshots or intake.
const compositionOnly=entry('composition-intake',{portionAmount:200,sourceMeta:{mealComposition:meal().components,mealPortionMode:'estimated_serving',nutritionEstimate:'photo'}});
const sourceOnly=entry('source-intake',{sourceMeta:{entryKind:'product-consumption',productScanEventId:'source-scan'}});
const fallback=boot([compositionOnly,sourceOnly]);fallback.history.record(record('source-scan'));
hasScore(fallback.history.screen(),'diary:composition-intake',expectedMeal.value,fallback.sandbox.NudgeScoreCore.displayTone(expectedMeal.value));hasScore(fallback.history.screen(),'source-scan',25,'amber');assert.equal(fallback.data.foodLog.entries[0].sourceMeta.mealScore,undefined);assert.equal(fallback.data.foodLog.entries[1].sourceMeta.scoreMethod,null);
for(const value of [0,24,25,49,50,100]){const current=boot([entry('boundary',{sourceMeta:{mealComposition:[],mealScore:{available:true,status:'estimated',methodVersion:'nudge_meal_v0_3',value}}})]);hasScore(current.history.screen(),'diary:boundary',value,value<25?'red':value<50?'amber':'green');assert.match(current.history.screen(),/Historical/);}
for(const value of [-1,101,NaN,1.5,60]){const current=boot([entry('invalid',{sourceMeta:{mealComposition:[],mealScore:{...copy(expectedMeal),value}}})]);unknown(current.history.screen(),'diary:invalid');}
// History uses the shared image policy and retains only its explicitly supplied fallback.
const images=boot(),photo='data:image/jpeg;base64,YWJj',front='https://example.test/food-front.jpg';
images.sandbox.NudgeResults.productImage=(product,thumbnail)=>({src:product?.imageURL||thumbnail||'',fallback:product?.imageURL&&thumbnail||''});
images.history.record(record('front-photo',{product:{...product(),imageURL:front},thumbnail:photo}));
const imageRow=row(images.history.screen(),'front-photo');assert.match(imageRow,/src="https:\/\/example.test\/food-front.jpg"/);assert.match(imageRow,/data-nudge-fallback="data:image\/jpeg;base64,YWJj"/);
images.history.record(record('captured-photo',{thumbnail:photo}));assert.match(row(images.history.screen(),'captured-photo'),/src="data:image\/jpeg;base64,YWJj"/);assert.doesNotMatch(row(images.history.screen(),'captured-photo'),/data-nudge-fallback=/);
images.history.record(record('no-photo'));assert.match(row(images.history.screen(),'no-photo'),/n-meal-thumb/);assert.doesNotMatch(row(images.history.screen(),'no-photo'),/<img/);

// A recognised front label needs its recovery action, not an invitation to log
// unknown nutrition. Projection remains display-only and waits for deferred scores.
const labels=boot(),frontOnly={type:'product',productName:'Yeast extract spread',basis:'unknown',labelKind:'unreadable',needsClearerPhoto:true,
  message:'Add a label photo for more detail.',nutrients:{energyKcal:null,sugars:null,saturatedFat:null,salt:null},
  metadata:{recovery:[{field:'nutrition',action:'retake'}]}};
labels.history.record(record('front-only',{product:null,extraction:frontOnly}));
labels.history.record(record('recovery-only',{product:null,extraction:{...frontOnly,needsClearerPhoto:false,message:''}}));
labels.history.record(record('rated-label',{extraction:frontOnly}));
labels.history.record(record('meal-needs-photo',{kind:'meal',product:null,extraction:{type:'meal',meal:meal(),needsClearerPhoto:true,message:'Review this meal.'}}));
const labelsStored=JSON.stringify([...labels.storage]),labelWrites=labels.historyWrites(),labelState=JSON.stringify(labels.data);
const labelRows=labels.history.nativeProjection().rows,labelRow=id=>labelRows.find(item=>item.id===id);
assert.equal(labelRow('front-only').scoreDisplay,null);assert.equal(labelRow('front-only').note,frontOnly.message);
assert.equal(labelRow('recovery-only').note,'Add nutrition and ingredient labels.');
assert.equal(labelRow('rated-label').scoreDisplay.value,25);assert.doesNotMatch(labelRow('rated-label').note,/label photo|ingredient labels/);
assert.doesNotMatch(labelRow('meal-needs-photo').note,/label photo|ingredient labels/);
assert.equal(labels.history.nativeProjection('all',{}, {deferScores:true,id:'rated-label'}).rows[0].note,'Ready to log');
assert.equal(labels.history.nativeProjection('all',{}, {id:'front-only'}).rows[0].note,frontOnly.message);
assert.equal(JSON.stringify([...labels.storage]),labelsStored);assert.equal(labels.historyWrites(),labelWrites);assert.equal(JSON.stringify(labels.data),labelState);

// Rendering/reloading does not save intake, cache a score, alter portions or request any API.
for(const current of [app,confirmed,fallback]){
  const before=JSON.stringify(current.data),stored=JSON.stringify([...current.storage]),writes=current.historyWrites();
  for(let i=0;i<3;i++)current.history.screen();assert.equal(JSON.stringify(current.data),before);assert.equal(current.writes(),0);assert.equal(current.historyWrites(),writes);assert.equal(JSON.stringify([...current.storage]),stored);
  const reloaded=boot(copy(current.data.foodLog.entries),current.storage);assert.equal(reloaded.history.screen(),current.history.screen());assert.equal(reloaded.writes(),0);
}
console.log('Passed: uniform History score badges, RAG boundaries and zero; product/meal/confirmed snapshots, honest unknowns and failures, actionable missing-label notes, preserved gram amounts, saved-evidence rough fallback and reload without intake changes.');
