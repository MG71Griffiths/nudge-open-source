// Real native adapter and private stores with synthetic records only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const copy=value=>JSON.parse(JSON.stringify(value));
const files=['streaks.js','recipe-catalogue-data.js','recipe-catalogue.js','core/food-log.js','core/diary.js','core/nutrition-profile.js','core/product-evidence.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','core/analysis-result.js','scan-results.js','today-goals.js','cycle-support.js','search-model.js','diet.js','scan-history.js','repertoire.js','native-review.js','native-session.js','food-catalogue.js'];
function boot(values=new Map()){
  let failedKey='';const writes=[];
  const s={console,Date,Math,JSON,URL,document:{addEventListener(){},getElementById(){return null;}},location:{protocol:'native:'},nativeToday:()=> '2026-10-11',nativeNow:()=> '2026-10-11T12:00:00Z',nativeDiagnostic(){},nativeStorage:input=>{
    const r=JSON.parse(input);
    if(r.operation==='get')return JSON.stringify({ok:true,value:values.get(r.key)??null});
    if(r.key===failedKey)return '{"ok":false}';
    writes.push(r);if(r.operation==='set')values.set(r.key,r.value);else if(r.operation==='remove')values.delete(r.key);else throw Error('Unexpected operation');return '{"ok":true}';
  }};
  s.window=s;vm.createContext(s);for(const file of files)vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),s,{filename:file});
  const api=s.NudgeNativeSession;assert.equal(api.init().readFailed,false);
  return {api,values,writes,fail:key=>failedKey=key,perform:(op,p={})=>copy(api.perform(op,p)),project:(op,p={})=>copy(api.project(op,p)),snapshot:()=>copy(api.snapshot()),restart:()=>boot(values)};
}
const values={energyKcal:100,protein:6,fibre:5,salt:.3,sugars:1,fat:2,saturatedFat:.3,carbohydrate:14};
const nutrients=Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{value,unit:k==='energyKcal'?'kcal':'g',status:'supplied'}]));
const product={name:'Fixture chickpeas',brand:'Test',barcode:'12345678',basisUnit:'g',servingAmount:100,servingUnit:'g',nutritionPreparation:'as_sold',categoriesTags:['en:legumes'],ingredients:'Chickpeas, water',nutrients};
const photo='nudge-photo:12345678-1234-1234-1234-123456789abc.jpg';
const meal={type:'meal',productName:'Fixture lunch',nutrients:{},meal:{name:'Fixture lunch',portion:{amount:250,unit:'g'},plants:[],ingredients:[],nutrients}};
const historyRow=(a,id)=>a.project('history').rows.find(r=>r.id===id);
function scan(a,id,extra={}){assert.equal(a.perform('recordHistory',{id,kind:'product',status:'ready',name:product.name,product,createdAt:'2026-10-11T10:00:00Z',...extra}).ok,true);}

test('Search bookmark shares favourites without opening a draft, creating History or logging food',()=>{
  const a=boot();scan(a,'existing-scan');a.perform('setReview',{kind:'product',product,eventId:'other',confirmationId:'untouched-draft'});
  const before=a.snapshot(),writes=a.writes.length;
  const saved=a.perform('foodsToggleProduct',{product});
  assert.equal(saved.ok,true);assert.equal(saved.foods.foods.length,1);
  assert.equal(saved.foods.foods[0].sourceKey,'product:'+product.barcode);
  assert.equal(saved.foods.foods[0].draft.barcode,product.barcode);
  assert.deepEqual(saved.history,before.history);assert.deepEqual(saved.state,before.state);assert.deepEqual(saved.review,before.review);
  assert.equal(historyRow(a,'existing-scan').isFavourite,true);
  assert.deepEqual(a.writes.slice(writes).map(r=>r.key),['nudge-my-foods-v1']);
  const b=a.restart();assert.equal(b.snapshot().foods.foods.length,1);
  assert.equal(b.perform('foodsToggleProduct',{product}).ok,true);assert.equal(b.snapshot().foods.foods.length,0);
  assert.deepEqual(b.snapshot().state,before.state);assert.deepEqual(b.snapshot().history,before.history);
});

test('Search recognises a History favourite and removes its existing template without duplicates',()=>{
  const a=boot();scan(a,'history-saved');assert.equal(a.perform('historyToggleFavourite',{id:'history-saved'}).ok,true);
  const before=a.snapshot();assert.equal(before.foods.foods[0].sourceKey,'analysis:history-saved');
  assert.equal(a.perform('foodsToggleProduct',{product}).ok,true);
  assert.equal(a.snapshot().foods.foods.length,0);assert.equal(historyRow(a,'history-saved').isFavourite,false);
  assert.deepEqual(a.snapshot().history,before.history);assert.deepEqual(a.snapshot().state,before.state);
});

test('Search bookmark failed writes preserve saved state and unrelated records',()=>{
  const a=boot(),before=a.snapshot();a.fail('nudge-my-foods-v1');
  assert.equal(a.perform('foodsToggleProduct',{product}).ok,false);assert.equal(a.snapshot().foods.foods.length,0);
  a.fail('');assert.equal(a.perform('foodsToggleProduct',{product}).ok,true);a.fail('nudge-my-foods-v1');
  assert.equal(a.perform('foodsToggleProduct',{product}).ok,false);assert.equal(a.snapshot().foods.foods.length,1);
  assert.deepEqual(a.snapshot().history,before.history);assert.deepEqual(a.snapshot().state,before.state);
  assert.equal(a.perform('foodsToggleProduct',{product:{name:'Invalid',barcode:'bad'}}).ok,false);
});

test('History heart creates one durable My Foods template without opening or logging the scan',()=>{
  const a=boot();scan(a,'scan');a.perform('setReview',{kind:'product',product,eventId:'other',confirmationId:'open-draft'});
  const before=a.snapshot();assert.equal(historyRow(a,'scan').isFavourite,false);assert.equal(historyRow(a,'scan').canFavourite,true);
  const saved=a.perform('historyToggleFavourite',{id:'scan'});assert.equal(saved.ok,true);assert.equal(saved.foods.foods.length,1);
  assert.deepEqual(saved.state,before.state);assert.deepEqual(saved.review,before.review);assert.deepEqual(saved.history,before.history);
  assert.equal(saved.foods.foods[0].sourceKey,'analysis:scan');assert.equal(saved.foods.foods[0].draft.energyPerPortion,100);
  assert.equal(saved.foods.foods[0].draft.sourceMeta.confirmationId,undefined);
  const b=a.restart();assert.equal(historyRow(b,'scan').isFavourite,true);
  assert.equal(b.perform('historyToggleFavourite',{id:'scan'}).ok,true);assert.equal(historyRow(b,'scan').isFavourite,false);
  assert.equal(b.snapshot().foods.foods.length,0);assert.deepEqual(b.snapshot().state,before.state);
});

test('photo and confirmed History favourites retain photographs and exact saved nutrition',()=>{
  const a=boot();scan(a,'photo',{kind:'meal',product:null,extraction:meal,photos:[photo]});
  assert.equal(a.perform('historyToggleFavourite',{id:'photo'}).ok,true);let food=a.snapshot().foods.foods[0];
  assert.deepEqual(food.draft.sourceMeta.entryPhotos,[photo]);assert.equal(a.snapshot().state.foodLog.entries.length,0);
  a.perform('setReview',{kind:'analysis',extraction:meal,eventId:'photo',confirmationId:'lunch',photos:[photo],day:'2026-10-08',slot:'Lunch'});
  const logged=a.perform('reviewConfirm');assert.equal(logged.ok,true);const entry=logged.review.entry;
  assert.equal(a.perform('foodsSaveEntry',{entryId:entry.id}).ok,true);assert.equal(a.snapshot().foods.foods.length,1,'Saving the linked entry updates its favourite');
  const state=copy(a.snapshot().state);assert.equal(historyRow(a,'photo').isFavourite,true);
  food=a.snapshot().foods.foods[0];assert.deepEqual(food.draft.nutritionSnapshot,entry.nutritionSnapshot);assert.deepEqual(food.draft.sourceMeta.entryPhotos,[photo]);
  a.perform('historyToggleFavourite',{id:'photo'});assert.deepEqual(a.snapshot().state,state,'Unfavouriting never removes the eaten meal');
});

test('save from review, edit saved food and remove from My Foods all keep History hearts in sync',()=>{
  const a=boot();scan(a,'scan');a.perform('setReview',{kind:'product',product,eventId:'scan',confirmationId:'review'});
  assert.equal(a.perform('reviewSaveFood').ok,true);assert.equal(historyRow(a,'scan').isFavourite,true);
  const id=a.snapshot().foods.foods[0].id;a.perform('openSaved',{id,confirmationId:'saved-edit'});a.perform('reviewUpdate',{name:'My chickpeas'});
  assert.equal(a.perform('reviewSaveFood').ok,true);assert.equal(a.snapshot().foods.foods.length,1);assert.equal(historyRow(a,'scan').isFavourite,true);
  assert.equal(a.snapshot().foods.foods[0].sourceKey,'analysis:scan','Editing retains the original archive relationship');
  assert.equal(a.perform('foodsDelete',{id}).ok,true);assert.equal(historyRow(a,'scan').isFavourite,false);
  assert.equal(a.snapshot().state.foodLog.entries.length,0);
});

test('unavailable results and failed favourite writes cannot show false saved state or alter diary',()=>{
  const a=boot();for(const status of ['pending','failed','unknown']){scan(a,status,{status,product:null,kind:'unknown'});assert.equal(historyRow(a,status).canFavourite,false);assert.equal(a.perform('historyToggleFavourite',{id:status}).ok,false);}
  scan(a,'ready');const before=a.snapshot();a.fail('nudge-my-foods-v1');assert.equal(a.perform('historyToggleFavourite',{id:'ready'}).ok,false);
  assert.equal(historyRow(a,'ready').isFavourite,false);assert.deepEqual(a.snapshot().state,before.state);assert.deepEqual(a.snapshot().history,before.history);
  a.fail('');assert.equal(a.perform('historyToggleFavourite',{id:'ready'}).ok,true);a.fail('nudge-my-foods-v1');
  assert.equal(a.perform('historyToggleFavourite',{id:'ready'}).ok,false);assert.equal(historyRow(a,'ready').isFavourite,true);
});

function legacyFavouriteFixture({modern=false}={}){
  const a=boot();scan(a,'legacy-scan');
  if(modern){a.perform('setReview',{kind:'product',product,eventId:'legacy-scan',confirmationId:'modern'});assert.equal(a.perform('reviewSaveFood').ok,true);}
  const raw=JSON.parse(a.values.get('nudge-scan-history-v1'));raw.favourites=['barcode:'+product.barcode];raw.favouriteProducts=[{key:raw.favourites[0],product}];
  a.values.set('nudge-scan-history-v1',JSON.stringify(raw));return a.restart();
}

test('legacy favourites project into History, Camera foods and Saved without startup writes',()=>{
  const a=legacyFavouriteFixture(),before=[...a.values],writes=a.writes.length;
  const foods=a.snapshot().foods.foods;assert.equal(foods.length,1);assert.equal(foods[0].draft.barcode,product.barcode);assert.ok(foods[0].legacyProduct);
  assert.equal(historyRow(a,'legacy-scan').isFavourite,true);
  const saved=a.project('search',{savedOnly:true,kind:'product'}).rows;assert.equal(saved.length,1);assert.equal(saved[0].kind,'saved');
  assert.equal(a.perform('openSaved',{id:foods[0].id,confirmationId:'legacy-open',day:'2026-10-09',slot:'Lunch'}).ok,true);
  assert.equal(a.snapshot().review.product.barcode,product.barcode);assert.equal(a.snapshot().review.draft.day,'2026-10-09');
  assert.equal(a.snapshot().state.foodLog.entries.length,0);assert.deepEqual([...a.values],before);assert.equal(a.writes.length,writes);
});

test('legacy unfavourite and modern template removal succeed atomically in My Foods, including after restart',()=>{
  for(const modern of [false,true]){
    const a=legacyFavouriteFixture({modern}),before=[...a.values],history=a.values.get('nudge-scan-history-v1');assert.equal(a.snapshot().foods.foods.length,1);
    a.fail('nudge-my-foods-v1');assert.equal(a.perform('historyToggleFavourite',{id:'legacy-scan'}).ok,false);assert.equal(historyRow(a,'legacy-scan').isFavourite,true);assert.equal(a.snapshot().foods.foods.length,1);assert.deepEqual([...a.values],before);
    a.fail('');const writeCount=a.writes.length;assert.equal(a.perform('historyToggleFavourite',{id:'legacy-scan'}).ok,true);
    assert.equal(a.writes.length,writeCount+1);assert.equal(a.writes.at(-1).key,'nudge-my-foods-v1');assert.equal(a.values.get('nudge-scan-history-v1'),history);
    assert.equal(historyRow(a,'legacy-scan').isFavourite,false);assert.equal(a.snapshot().foods.foods.length,0);assert.equal(a.project('search',{savedOnly:true,kind:'product'}).rows.length,0);
    const b=a.restart();assert.equal(historyRow(b,'legacy-scan').isFavourite,false);assert.equal(b.snapshot().foods.foods.length,0);
    assert.equal(b.perform('historyToggleFavourite',{id:'legacy-scan'}).ok,true);assert.equal(historyRow(b,'legacy-scan').isFavourite,true);assert.equal(b.snapshot().foods.foods.length,1);assert.equal(b.snapshot().state.foodLog.entries.length,0);
  }
});

test('virtual legacy favourite can be renamed, saved from review and removed without resurrecting the old favourite',()=>{
  const a=legacyFavouriteFixture(),id=a.snapshot().foods.foods[0].id;
  assert.equal(a.perform('foodsRename',{id,name:'My chickpeas'}).ok,true);assert.equal(a.snapshot().foods.foods.length,1);assert.equal(a.snapshot().foods.foods[0].name,'My chickpeas');assert.equal(historyRow(a,'legacy-scan').isFavourite,true);
  const real=a.snapshot().foods.foods[0].id;assert.equal(a.perform('foodsDelete',{id:real}).ok,true);assert.equal(a.restart().snapshot().foods.foods.length,0);
  const b=legacyFavouriteFixture();assert.equal(b.perform('openSaved',{id:b.snapshot().foods.foods[0].id,confirmationId:'edit-legacy'}).ok,true);assert.equal(b.perform('reviewSaveFood').ok,true);
  assert.equal(b.snapshot().foods.foods.length,1);assert.equal(b.snapshot().foods.foods[0].legacyProduct,undefined);assert.equal(historyRow(b,'legacy-scan').isFavourite,true);assert.equal(b.snapshot().state.foodLog.entries.length,0);
});

test('archive ordering uses capture instants across photo and product scans, independently of eaten date',()=>{
  const a=boot();scan(a,'older-photo',{kind:'meal',product:null,extraction:meal,createdAt:'2026-10-10T09:00:00Z'});
  scan(a,'new-photo',{kind:'meal',product:null,extraction:meal,createdAt:'2026-10-11T11:00:00Z'});scan(a,'product',{createdAt:'2026-10-11T10:00:00Z'});
  a.perform('setReview',{kind:'analysis',extraction:meal,eventId:'new-photo',confirmationId:'eaten',day:'2026-10-01',slot:'Breakfast'});assert.equal(a.perform('reviewConfirm').ok,true);
  assert.deepEqual(a.project('history').rows.map(r=>r.id),['new-photo','product','older-photo']);
  assert.deepEqual(a.project('history',{filter:'photos'}).rows.map(r=>r.id),['new-photo','older-photo']);
  assert.equal(historyRow(a,'new-photo').historyDay,'2026-10-11');assert.equal(a.project('history',{filter:'eaten'}).rows[0].historyDay,'2026-10-01');
  scan(a,'older-photo',{kind:'meal',product:null,extraction:meal,createdAt:'2026-10-11T12:00:00Z'});
  assert.equal(historyRow(a,'older-photo').createdAt,'2026-10-10T09:00:00Z','A refreshed result keeps the original capture time');
  const before=[...a.values],writes=a.writes.length;for(let n=0;n<3;n++)a.project('history');assert.deepEqual([...a.values],before);assert.equal(a.writes.length,writes);
});

test('legacy photo-only history uses its recorded instant rather than eating day noon',()=>{
  const a=boot();const state=a.api.snapshot().state;
  state.foodLog.entries=[{id:'legacy-photo',name:'Earlier diary day',day:'2026-10-01',slot:'Breakfast',portions:1,plants:[],ferments:[],energyPerPortion:100,proteinPerPortion:6,fibrePerPortion:5,sourceMeta:{nutritionEstimate:'photo',retrievedAt:'2026-10-11T11:30:00Z'}}];
  scan(a,'scan',{createdAt:'2026-10-11T11:00:00Z'});
  const rows=a.project('history').rows;assert.deepEqual(rows.map(r=>r.id),['diary:legacy-photo','scan']);assert.equal(rows[0].historyDay,'2026-10-11');
  assert.equal(a.project('history',{filter:'eaten'}).rows[0].historyDay,'2026-10-01');
});

test('startup interruption durably resolves stale pending rows and preserves their retry photographs',()=>{
  const a=boot();scan(a,'photo',{kind:'meal',status:'pending',product:null,photos:[photo],photoCount:1,loggingDay:'2026-10-08',loggingMeal:'Breakfast'});
  scan(a,'barcode',{status:'pending'});scan(a,'complete');
  a.perform('setReview',{kind:'product',product,eventId:'other',confirmationId:'untouched-review'});
  const before=a.snapshot(),b=a.restart();assert.equal(historyRow(b,'photo').status,'pending');
  assert.equal(b.perform('historyInterruptPending').ok,true);const interrupted=historyRow(b,'photo');
  assert.equal(interrupted.status,'failed');assert.equal(interrupted.errorCode,'analysis_interrupted');assert.deepEqual(interrupted.photos,[photo]);
  assert.equal(interrupted.createdAt,before.history.events.find(r=>r.id==='photo').createdAt);assert.match(interrupted.message,/retry using the saved photos/);
  assert.equal(interrupted.loggingDay,'2026-10-08');assert.equal(interrupted.loggingMeal,'Breakfast');
  assert.equal(historyRow(b,'barcode').status,'failed');assert.equal(historyRow(b,'complete').status,'ready');
  assert.deepEqual(b.snapshot().state,before.state);assert.equal(b.snapshot().foods.foods.length,0);
  const persisted=b.restart();assert.equal(historyRow(persisted,'photo').status,'failed');assert.deepEqual(historyRow(persisted,'photo').photos,[photo]);
  const writes=persisted.writes.length;assert.equal(persisted.perform('historyInterruptPending').ok,true);assert.equal(persisted.writes.length,writes,'Repeated startup does not rewrite completed interruptions');
});

test('failed startup interruption retains pending data unchanged and can be retried',()=>{
  const a=boot();scan(a,'photo',{kind:'meal',status:'pending',product:null,photos:[photo]});const before=a.snapshot();
  a.fail('nudge-scan-history-v1');assert.equal(a.perform('historyInterruptPending').ok,false);assert.equal(historyRow(a,'photo').status,'pending');
  assert.deepEqual(a.snapshot().history,before.history);assert.deepEqual(a.snapshot().state,before.state);
  a.fail('');assert.equal(a.perform('historyInterruptPending').ok,true);assert.equal(historyRow(a,'photo').status,'failed');
});

test('orphan interruption preserves exact completed legacy row keys and explicit capture metadata clears',()=>{
  const a=boot();scan(a,'legacy-complete',{photos:[photo],loggingDay:'2026-10-08',loggingMeal:'Lunch'});scan(a,'orphan',{status:'pending',product:null});
  const key='nudge-scan-history-v1',before=JSON.parse(a.values.get(key)),legacy=before.events.find(row=>row.id==='legacy-complete');
  for(const field of ['captureOwnerKey','captureID','processingState','nextAttemptAt'])assert.equal(Object.hasOwn(legacy,field),false);
  const b=a.restart();assert.equal(b.perform('historyInterruptPending').ok,true);
  const after=JSON.parse(b.values.get(key)),retained=after.events.find(row=>row.id==='legacy-complete');
  assert.deepEqual(retained,legacy);assert.deepEqual(Object.keys(retained),Object.keys(legacy));assert.deepEqual(retained.photos,[photo]);
  const changed=after.events.find(row=>row.id==='orphan'),old=before.events.find(row=>row.id==='orphan');
  assert.deepEqual(Object.keys(changed).filter(field=>JSON.stringify(changed[field])!==JSON.stringify(old[field])).sort(),['errorCode','message','status','updatedAt'].filter(field=>JSON.stringify(changed[field])!==JSON.stringify(old[field])).sort());
  assert.equal(b.perform('recordHistory',{id:'legacy-complete',captureOwnerKey:'',captureID:'',processingState:'',nextAttemptAt:''}).ok,true);
  const cleared=JSON.parse(b.values.get(key)).events.find(row=>row.id==='legacy-complete');
  for(const field of ['captureOwnerKey','captureID','processingState','nextAttemptAt']){assert.equal(Object.hasOwn(cleared,field),true);assert.equal(cleared[field],'');}
});

test('undoing a deleted pending scan restores retryable photos without reviving the revoked generation',()=>{
  const a=boot();scan(a,'pending-photo',{kind:'meal',product:null,status:'pending',photos:[photo]});
  const before=historyRow(a,'pending-photo');assert.equal(a.perform('historyDelete',{id:'pending-photo',keepIntake:true}).ok,true);
  const generation=a.snapshot().history.generations['pending-photo'];assert.ok(generation>0);
  assert.equal(a.perform('historyUndo').ok,true);const restored=historyRow(a,'pending-photo');
  assert.equal(restored.status,'failed');assert.equal(restored.errorCode,'analysis_interrupted');assert.deepEqual(restored.photos,[photo]);assert.equal(restored.createdAt,before.createdAt);
  assert.equal(a.snapshot().history.generations['pending-photo'],generation);assert.equal(a.snapshot().state.foodLog.entries.length,0);
  assert.equal(historyRow(a.restart(),'pending-photo').status,'failed');
});

test('analysis destinations survive completed results and restart without changing archive dates',()=>{
  const a=boot();scan(a,'photo',{kind:'meal',status:'pending',product:null,photos:[photo],loggingDay:'2026-10-08',loggingMeal:'Breakfast'});
  a.perform('recordHistory',{id:'photo',status:'ready',extraction:meal});
  const row=historyRow(a.restart(),'photo');assert.equal(row.loggingDay,'2026-10-08');assert.equal(row.loggingMeal,'Breakfast');assert.equal(row.historyDay,'2026-10-11');
  scan(a,'invalid',{loggingDay:'2026-02-30',loggingMeal:'Invalid'});const invalid=historyRow(a,'invalid');assert.equal(invalid.loggingDay,undefined);assert.equal(invalid.loggingMeal,undefined);
});

test('background label repair keeps only bounded source context and selected portion across restart',()=>{
  const a=boot();scan(a,'repair',{status:'pending',repairEntryId:'original-entry',repairProduct:{...product,photos:['private-upload'],imageBase64:'private-upload'},repairPortion:{canonicalAmount:250,unit:'g',measureId:'g'}});
  a.perform('recordHistory',{id:'repair',status:'ready',extraction:{type:'product',basis:'per100g',productName:product.name,nutritionPreparation:'as_sold',nutrients}});
  const row=historyRow(a.restart(),'repair');assert.equal(row.repairEntryId,'original-entry');assert.equal(row.repairProduct.barcode,product.barcode);assert.equal(row.repairProduct.photos,undefined);assert.equal(row.repairProduct.imageBase64,undefined);
  assert.equal(row.repairPortion.canonicalAmount,250);assert.equal(row.repairPortion.unit,'g');
  a.perform('setReview',{kind:'analysis',eventId:row.id,confirmationId:'reopen',extraction:row.extraction,previousProduct:row.repairProduct,previousReview:{product:row.repairProduct,draft:{portion:row.repairPortion}}});
  assert.equal(a.project('reviewModel').quantity,250,'Reopening an unlogged repair keeps its previously selected portion');
  scan(a,'unlogged-repair',{kind:'product',product:null,extraction:row.extraction,repairProduct:row.repairProduct,repairPortion:row.repairPortion});
  assert.equal(a.perform('historyToggleFavourite',{id:'unlogged-repair'}).ok,true);
  assert.equal(a.snapshot().foods.foods[0].draft.portionAmount,250,'Favouriting a repaired label keeps its selected portion too');
  assert.equal(a.snapshot().foods.foods[0].draft.barcode,product.barcode);
  for(const amount of [-1,0,5001,'250']){scan(a,'invalid-'+amount,{repairProduct:product,repairPortion:{canonicalAmount:amount,unit:'g',measureId:'g'}});assert.equal(historyRow(a,'invalid-'+amount).repairPortion,undefined);}
  assert.equal(a.snapshot().state.foodLog.entries.length,0);
});
