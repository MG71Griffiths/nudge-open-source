// Offline checks for the simplified native-camera/review contract and supermarket controls.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {boot,extraction}=require('./label-photo.test.cjs');
const plain=value=>JSON.parse(JSON.stringify(value));
const nutrition=(more={})=>({...extraction({energyKcal:619,protein:26.3},'per100g',null,{productName:'Peanut butter',brand:'Test brand'}),...more});
const serving={label:'1 tablespoon',amount:15,unit:'g',source:'label'};
const app=boot();app.review(nutrition({servingSuggestion:serving}));
assert.equal(app.controller._state.amount,15);assert.match(app.html(),/Label serving · 1 tablespoon · 15 g/);
assert.equal(app.data.foodLog.entries.length,0);app.action('label-step','0.25');assert.equal(app.controller._state.amount,18.75);
app.action('label-step','-0.25');assert.equal(app.controller._state.amount,15);app.action('label-portion','0.5');assert.equal(app.controller._state.amount,7.5);
app.action('label-portion','1.25');assert.equal(app.controller._state.amount,18.75);app.action('label-save');
const saved=app.data.foodLog.entries[0];assert.equal(saved.energyPerPortion,116.0625);assert.equal(saved.proteinPerPortion,4.93125);assert.equal(saved.portionAmount,18.75);assert.equal(saved.portionUnit,'g');assert.equal(saved.fibrePerPortion,null);
assert.equal(saved.sourceMeta.portionLabel,'1 tablespoon');assert.equal(saved.sourceMeta.portionSource,'label');assert.equal(saved.sourceMeta.portionBase,'15');
assert.match(boot(app.persisted().foodLog.entries).patterns.dashboard(),/18.75 g/);

// Model suggestions remain visibly estimated, and neither invalid sizes nor g/ml mismatches supply a conversion.
const estimated=boot();estimated.review(nutrition({servingSuggestion:{...serving,label:'1 portion',source:'estimated'}}));assert.match(estimated.html(),/Suggested portion · 15 g/);assert.doesNotMatch(estimated.html(),/Label serving/);
const mismatch=boot();mismatch.review(nutrition({servingSize:{value:30,unit:'g'},servingSuggestion:serving}));assert.equal(mismatch.controller._state.amount,30);assert.doesNotMatch(mismatch.html(),/tablespoon/);
const sizeMatch=boot();sizeMatch.review(nutrition({servingSize:{value:15,unit:'g'},servingSuggestion:serving}));assert.match(sizeMatch.html(),/1 tablespoon/);
const mixedUnit=boot();mixedUnit.review(nutrition({servingSuggestion:{...serving,unit:'ml'}}));assert.equal(mixedUnit.controller._state.amount,100);assert.equal(mixedUnit.controller._state.unit,'g');assert.doesNotMatch(mixedUnit.html(),/tablespoon/);
for(const amount of [0,-1,5001,'30',Infinity]){const bad=boot();bad.review(nutrition({servingSuggestion:{...serving,amount}}));assert.equal(bad.controller._state.amount,100);}
const drink=boot();drink.review({...nutrition(),basis:'per100ml',servingSuggestion:{label:'1 glass',amount:200,unit:'ml',source:'estimated'}});drink.action('label-portion','1.25');assert.equal(drink.controller._state.amount,250);assert.equal(drink.controller._state.unit,'ml');
const bounds=boot();bounds.review(nutrition({servingSuggestion:serving}));bounds.action('label-portion','0.25');bounds.action('label-step','-0.25');assert.equal(bounds.controller._state.amount,3.75);bounds.action('label-portion','999');assert.equal(bounds.controller._state.amount,3.75);

// Retakes cannot reinterpret a user-entered physical amount or edited nutrition basis.
const grams=boot();grams.review(nutrition());grams.input('label-amount','45',{change:true});grams.action('label-retake');grams.analyse();grams.receive('result',{result:{extraction:{...nutrition(),basis:'per100ml'}}});
assert.equal(grams.controller._state.amount,45);assert.equal(grams.controller._state.unit,'g');grams.action('label-save');assert.equal(grams.writes(),0);grams.input('label-amount-unit','ml',{change:true});grams.action('label-save');assert.equal(grams.data.foodLog.entries[0].portionAmount,45);assert.equal(grams.data.foodLog.entries[0].portionUnit,'ml');
const basis=boot();basis.review(nutrition());basis.input('label-protein','30');basis.action('label-retake');basis.analyse();basis.receive('result',{result:{extraction:{...nutrition(),basis:'perServing',servingSize:{value:15,unit:'g'}}}});
assert.equal(basis.controller._state.extraction.basis,'per100g');assert.equal(basis.controller._state.extraction.nutrients.protein.value,30);assert.ok(basis.controller._state.pendingExtraction);basis.action('label-save');assert.equal(basis.writes(),0);basis.action('label-keep-edits');basis.action('label-save');assert.equal(basis.data.foodLog.entries[0].nutritionSnapshot.protein.per100,30);
const chooseNew=boot();chooseNew.review(nutrition());chooseNew.input('label-protein','30');chooseNew.action('label-retake');chooseNew.analyse();chooseNew.receive('result',{result:{extraction:{...nutrition(),basis:'perServing',servingSize:{value:15,unit:'g'}}}});chooseNew.action('label-use-new-result');assert.equal(chooseNew.controller._state.extraction.basis,'perServing');assert.equal(chooseNew.controller._state.extraction.nutrients.protein.value,26.3);assert.equal(chooseNew.controller._state.amount,15);chooseNew.action('label-save');assert.equal(chooseNew.data.foodLog.entries[0].proteinPerPortion,26.3);

// Incomplete product facts never trigger nutrient-only recommendations or expose empty alternatives.
// Full eligibility, dietary evidence, stale replies and ranking are covered by alternatives.test.cjs.
const alt=boot();alt.review(nutrition({servingSuggestion:serving,categoryTag:'en:peanut-butters',retailer:"Sainsbury's"}));
assert.equal(alt.messages.filter(m=>m.action==='product-alternatives').length,0);
alt.input('label-name','My checked name');alt.input('label-protein','27');alt.input('label-amount','20');
alt.action('label-alternatives');assert.equal(alt.messages.filter(m=>m.action==='product-alternatives').length,0);
assert.doesNotMatch(alt.html(),/Better alternatives|Find alternatives|stock may vary|Other options/);
alt.action('label-save');assert.equal(alt.data.foodLog.entries[0].name,'My checked name');assert.equal(alt.data.foodLog.entries[0].proteinPerPortion,5.4);

// Camera remains a native session across retries; front-only results invite another label photo.
const retry=boot();retry.selected();retry.analyse();retry.receive('error',{message:'Temporary error'});retry.receive('loading');assert.equal(retry.controller._state.phase,'loading');retry.receive('result',{result:{extraction:nutrition()}});assert.equal(retry.controller._state.phase,'review');
const cancel=boot();cancel.selected();cancel.analyse();cancel.receive('cancelled');assert.equal(cancel.controller._state.phase,'idle');cancel.receive('result',{result:{extraction:nutrition()}});assert.equal(cancel.controller._state.phase,'idle');
const front=boot();front.review({...nutrition(),labelKind:'unreadable',needsClearerPhoto:true,message:'Add a label photo for more detail.'});assert.match(front.html(),/Add label photo/);assert.doesNotMatch(front.html(),/data-action="label-save"/);const draft=front.controller._state.confirmationId;front.action('label-retake');assert.equal(front.messages.at(-1).draftId,draft);assert.equal(front.messages.at(-1).action,'smart-scan');

// A native barcode result lands directly on the shopping result without intake logging.
const barcode=boot();barcode.selected();const product={name:'Peanut butter',brand:'Test brand',barcode:'12345678',basisUnit:'g',servingAmount:15,servingLabel:'1 tbsp',categories:['en:peanut-butters'],retailer:"Sainsbury's",retrievedAt:'2026-10-01T00:00:00Z',sourceName:'Open Food Facts',sourceURL:'https://world.openfoodfacts.org/product/12345678',licenceName:'ODbL',licenceURL:'https://opendatacommons.org/licenses/odbl/',nutrients:{energyKcal:{value:619,status:'supplied'},protein:{value:26.3,status:'supplied'}}};
barcode.receive('barcode-product',{product});assert.equal(barcode.view.screen,'barcode');assert.equal(barcode.data.foodLog.entries.length,0);assert.equal(barcode.sandbox.NudgeBarcode._scan.amount,15);
assert.doesNotMatch(barcode.sandbox.NudgeBarcode.screen(),/This matches my product|Confirm the identity/);assert.equal(barcode.messages.filter(m=>m.action==='product-alternatives').length,0);
barcode.sandbox.NudgeBarcode.handleAction('barcode-portion','1.25');barcode.sandbox.NudgeBarcode.handleAction('barcode-ate');barcode.sandbox.NudgeBarcode.handleAction('barcode-ate');assert.equal(barcode.data.foodLog.entries.length,0);assert.doesNotMatch(barcode.sandbox.NudgeBarcode.screen(),/barcode-portion|Add to diary/);

// Visible copy measured with closed details. The 4 October component contract
// explicitly adds four visible meal choices and an optional Edit action (+10 words).
// Decorative aria-hidden check glyphs are not words; their visible text labels remain counted.
// Before: nutrition204, ingredients262, barcode274 words (baseline measured from parent implementation).
function visibleWords(html){return html.replace(/<span\b[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g,'').replace(/<details\b[^>]*>[\s\S]*?<\/details>/g,m=>m.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]||'').replace(/<[^>]+>/g,' ').replace(/&[^;]+;/g,' ').trim().split(/\s+/).filter(Boolean).length;}
const simple=boot();simple.review(nutrition());assert.ok(visibleWords(simple.html())<=55,'Nutrition copy remains concise with four required meal choices');
const ingredients=boot();ingredients.review({...nutrition(),labelKind:'ingredients',ingredients:{text:'Ingredients: oats, almonds, pumpkin seeds, chickpeas.',plants:[{name:'Oats',evidence:'oats'},{name:'Almond',evidence:'almonds'},{name:'Pumpkin',evidence:'pumpkin seeds'},{name:'Chickpea',evidence:'chickpeas'}],needsReview:false}});assert.ok(visibleWords(ingredients.html())<=65,'Ingredients copy remains concise with four required meal choices');
assert.doesNotMatch(simple.html()+ingredients.html(),/type="checkbox"|label-upload-consent/);
const css=fs.readFileSync(path.join(__dirname,'../Web/nudge-fit.css'),'utf8');assert.match(css,/min-height:54px/);assert.match(css,/scan-home-button\{min-height:68px/);
console.log('Passed: simple camera flow, quarter portions/presets/bounds, household measure provenance, unknowns and g/ml isolation, unsupported alternatives hidden, edit retention, shopping scan isolation, front-only continuation, and concise review copy with required visible meal choices.');
