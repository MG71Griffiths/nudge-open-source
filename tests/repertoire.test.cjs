// Reusable foods use immutable private snapshots and require a fresh eating confirmation.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {boot,product}=require('./food-detail.test.cjs');
function setup(options={}){
 const app=boot(options);app.sandbox.NudgeResults.imageURL=v=>/^https:\/\//.test(v||'')?v:'';
 vm.runInContext(fs.readFileSync('Web/repertoire.js','utf8'),app.sandbox);
 const ctx={getState:()=>app.data,view:app.view,todayKey:()=> '2026-10-05',render(){},navigate:s=>app.view.screen=s,escapeHtml:v=>String(v??'').replace(/</g,'&lt;'),showToast:t=>app.toasts.push(t),showDialog(){},history:app.history};
 const repertoire=app.sandbox.createNudgeRepertoire(ctx);
 const fit=app.sandbox.createNudgeFit({...ctx,button:()=>'',nudge:()=>'',foodPatterns:{recipeBy:()=>null},save(){if(app.canSaveNow===false)return false;app.storage.set('wmd-nudge-prototype-v1',JSON.stringify(app.data));return true;}});
 return {...app,repertoire,fit};
}
const food={id:'old-entry',name:'My daily smoothie',day:'2026-10-01',slot:'Breakfast',portions:1,plants:['banana','blueberry','oats'],ferments:[],portionAmount:250,portionUnit:'ml',energyPerPortion:300,proteinPerPortion:18,fibrePerPortion:9,nutritionSnapshot:{carbohydrate:{per100:10,portion:25,unit:'g',per100Status:'calculated',portionStatus:'calculated'},fat:{per100:null,portion:null,unit:'g',per100Status:'unknown',portionStatus:'unknown'}},sourceMeta:{scanEventId:'old-scan',confirmationId:'old-confirmation',nutritionEstimate:'photo',mealComposition:[{name:'Banana',amountGrams:100}],mealPortionMode:'estimated_serving'}};
const a=setup({entries:[food]}),before=JSON.stringify(a.data);assert.equal(a.repertoire.saveEntry(food),true);assert.equal(JSON.stringify(a.data),before);assert.equal(a.repertoire.items().length,1);
a.repertoire.saveEntry(food);assert.equal(a.repertoire.items().length,1,'Saving same source updates one reusable food');
const saved=a.repertoire.items()[0];assert.equal(saved.draft.sourceMeta.confirmationId,undefined);assert.equal(saved.draft.sourceMeta.scanEventId,undefined);
const b=setup({storage:a.storage,entries:[food]});assert.equal(b.repertoire.items().length,1);b.repertoire.open(saved.id);assert.equal(b.view.screen,'food-entry');assert.equal(b.view.foodDraft.day,'2026-10-05');assert.equal(b.view.foodDraft.id,undefined);assert.equal(b.view.foodDraft.diaryIntent,'add');assert.equal(b.data.foodLog.entries.length,1);assert.equal(b.messages.length,0,'Reusing a food makes no network/AI request');
b.fit.handleAction('fit-confirm');b.fit.handleAction('fit-confirm');assert.equal(b.data.foodLog.entries.length,2,'Double confirmation logs once');assert.equal(b.data.foodLog.entries[1].energyPerPortion,300);assert.equal(b.data.foodLog.entries[1].nutritionSnapshot.fat.portion,null);assert.equal(b.data.foodLog.entries[0].id,'old-entry');
b.repertoire.open(saved.id);b.fit.handleAction('fit-portions','0.5');b.fit.handleAction('fit-confirm');assert.equal(b.data.foodLog.entries.length,3);assert.equal(b.data.foodLog.entries[2].portions,.5);assert.equal(b.data.foodLog.entries[2].energyPerPortion,300,'Base values scale once via portions');assert.notEqual(b.data.foodLog.entries[1].id,b.data.foodLog.entries[2].id);assert.equal(b.data.foodLog.entries[1].diaryIntent,undefined);assert.equal(b.data.foodLog.entries[2].diaryIntent,undefined);
assert.equal(b.sandbox.WmdFoodLog.summarise(b.data.foodLog.entries).plants.length,3,'Repeating plants does not create extra variety');
b.history.handleAction('history-filter','eaten');assert.equal(b.history.items().length,3);b.history.handleAction('history-filter','scanned');assert.equal(b.history.items().length,0,'A saved meal replay is not a new scan');
const stored=JSON.stringify(b.repertoire.items()),diary=JSON.stringify(b.data.foodLog);b.canHistory(false);assert.equal(b.repertoire.saveDraft({...food,name:'Failure'}),false);assert.equal(JSON.stringify(b.repertoire.items()),stored);assert.equal(JSON.stringify(b.data.foodLog),diary);b.canHistory(true);
b.repertoire.handleAction('repertoire-remove',saved.id);assert.equal(b.repertoire.items().length,0);assert.equal(JSON.stringify(b.data.foodLog),diary,'Removing reusable food leaves prior eating records intact');
const c=setup();c.receive(product);const counts=c.history.items().length;c.repertoire.handleAction('repertoire-save-product');assert.equal(c.repertoire.items().length,1);assert.equal(c.data.foodLog.entries.length,0);assert.equal(c.history.items().length,counts);assert.equal(c.repertoire.items()[0].draft.portionAmount,15);assert.equal(c.repertoire.items()[0].draft.energyPerPortion,92.85);
console.log('PASS: repertoire save/reload, idempotent saving, offline replay, new intake identity, exact scaling, missing values, plant uniqueness, rollback and deletion isolation.');

const corrupt=setup({storage:new Map([['nudge-my-foods-v1','broken json']])});
assert.equal(corrupt.repertoire.saveDraft(food),false,'Unreadable saved foods are not overwritten on save');
assert.equal(corrupt.repertoire.clear(),true,'Explicit reset can recover a malformed saved-food store');
assert.equal(corrupt.storage.has('nudge-my-foods-v1'),false);assert.equal(corrupt.repertoire.saveDraft(food),true);
const picture='data:image/jpeg;base64,AQID';const images=setup();images.repertoire.saveDraft(food,{thumbnail:picture});images.repertoire.open(images.repertoire.items()[0].id);images.fit.handleAction('fit-confirm');
const imageEntry=images.data.foodLog.entries[0];assert.equal(imageEntry.sourceMeta.repertoireImage,picture);assert.match(images.history.screen(),/data:image\/jpeg;base64,AQID/);
images.repertoire.handleAction('repertoire-remove',images.repertoire.items()[0].id);assert.match(images.history.screen(),/data:image\/jpeg;base64,AQID/,'Historical image survives deleting the saved template');

const recipeDraft=setup();recipeDraft.view.foodDraft={...food,id:undefined,recipe:'berry'};recipeDraft.repertoire.handleAction('repertoire-save-draft');recipeDraft.repertoire.handleAction('repertoire-save-draft');assert.equal(recipeDraft.repertoire.items().length,1,'Repeated Save from a prepared recipe updates one template');assert.equal(recipeDraft.data.foodLog.entries.length,0);
const plainDraft=setup();plainDraft.view.foodDraft={...food,id:undefined};plainDraft.repertoire.handleAction('repertoire-save-draft');plainDraft.repertoire.handleAction('repertoire-save-draft');assert.equal(plainDraft.repertoire.items().length,1,'Repeated Save from an unsaved draft updates one template');

const nativePicture=setup();nativePicture.sandbox.location={protocol:'nudge-local:'};for(const file of ['core/product-evidence.js','scan-results.js'])vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),nativePicture.sandbox);
const sourceImage='https://images.openfoodfacts.org/images/products/123/front_en.2.400.jpg';nativePicture.receive({...product,imageURL:sourceImage});nativePicture.repertoire.handleAction('repertoire-save-product');
assert.equal(nativePicture.repertoire.items()[0].image,sourceImage,'Saved evidence retains canonical product image URL');assert.match(nativePicture.repertoire.markup(),/src="\/catalogue-image\?url=/,'Native saved card uses allowed cache route');
nativePicture.repertoire.open(nativePicture.repertoire.items()[0].id);nativePicture.fit.handleAction('fit-confirm');assert.match(nativePicture.history.screen(),/src="\/catalogue-image\?url=/,'Native reused intake image uses allowed cache route');

assert.doesNotMatch(a.repertoire.markup(),/Breakfast ·|Lunch ·|Dinner ·|Snack ·/);
assert.equal(b.data.foodLog.entries[0].slot,'Breakfast','Historical entry category remains exact');
assert.equal(b.data.foodLog.entries[1].slot,'','Reusing saved food logs a neutral new record');
assert.equal(b.data.foodLog.entries[2].slot,'');
assert.equal(saved.draft.slot,'Breakfast','The saved template itself is preserved');
