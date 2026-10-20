// Actual screen/controller adapters; synthetic data only, with no network.
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const {boot, extraction, today} = require('./label-photo.test.cjs');
const {boot: productBoot, product} = require('./food-detail.test.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const noCategories = html => assert.doesNotMatch(html,
  /data-action="(?:label-slot|fit-slot|recipe-category)"|id="(?:food-slot|detail-meal|search-meal)"|Meal time|Meal category|(?:Breakfast|Lunch|Dinner|Snack) ·/);
const legacy = {id:'legacy-category', name:'Existing food', day:today, slot:'Dinner',
  portions:1, plants:['pea'], ferments:[], proteinPerPortion:15, fibrePerPortion:5};

const app = boot([legacy]), before = copy(app.data);
noCategories(app.patterns.dashboard());
noCategories(app.patterns.recipeScreen());
app.patterns.handleAction('recipe-open','berry');
noCategories(app.patterns.recipeDetail());
app.patterns.handleAction('recipe-log','berry');
assert.equal(app.view.foodDraft.slot,'');
app.fit.handleAction('food-edit',legacy.id);
noCategories(app.fit.reviewScreen());
assert.deepEqual(copy(app.data),before,'Opening legacy diary screens is read-only');
app.fit.handleAction('fit-slot','Breakfast');
assert.equal(app.view.foodDraft.slot,'Dinner','Removed actions cannot rewrite a legacy category');
app.fit.handleAction('fit-portions','2');
app.fit.handleAction('fit-confirm');
assert.equal(app.data.foodLog.entries[0].slot,'Dinner');
assert.equal(app.data.foodLog.entries[0].portions,2);

const manual = boot();
manual.sandbox.FormData = class { constructor(value){this.value=value;} get(key){return this.value[key]??null;} };
manual.sandbox.document.getElementById = () => ({textContent:''});
manual.view.screen='food-entry';
noCategories(manual.patterns.formScreen());
assert.equal(manual.view.foodDraft.slot,'');
manual.patterns.saveForm({name:'New food',day:today,portions:'1',plants:'pea',ferments:'',fibre:'5',eaten:'on',slot:'Snack'});
assert.equal(manual.data.foodLog.entries[0].slot,'','A new manual entry is neutral even if obsolete form data is supplied');
manual.view.foodDraft=copy(manual.data.foodLog.entries[0]);manual.view.screen='food-entry';
manual.patterns.saveForm({name:'Updated food',day:today,portions:'2',plants:'pea',ferments:'',fibre:'5',eaten:'on'});
assert.equal(manual.data.foodLog.entries.length,1);
assert.equal(manual.data.foodLog.entries[0].slot,'');

const label = boot();
label.review(extraction({energyKcal:100,protein:10},'per100g',null,{productName:'New label food'}));
noCategories(label.html());
label.action('label-save');
assert.equal(label.data.foodLog.entries[0].slot,'');
const reloaded = boot(label.persisted().foodLog.entries);
reloaded.fit.handleAction('food-edit',label.data.foodLog.entries[0].id);
noCategories(reloaded.fit.reviewScreen());
assert.equal(reloaded.writes(),0);

const barcode = productBoot();
for (const file of ['core/product-evidence.js','scan-results.js','food-detail-screen.js'])
  vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),barcode.sandbox);
barcode.receive(product);
const detail = () => barcode.sandbox.NudgeFoodDetailScreen(product,{detail:barcode.controller.detail()});
noCategories(detail());
barcode.action('detail-log');
assert.equal(barcode.data.foodLog.entries[0].slot,'');
assert.match(detail(),/to your diary/);
noCategories(detail());
const saved = barcode.data.foodLog.entries[0];
saved.slot='Lunch'; // Synthetic historical record, never owner data.
barcode.history.reopen('diary:'+saved.id);
const historical = copy(barcode.data);
noCategories(detail());
assert.deepEqual(copy(barcode.data),historical);
barcode.action('detail-edit');barcode.input('detail-quantity','2');barcode.action('detail-log');
assert.equal(barcode.data.foodLog.entries[0].slot,'Lunch');
barcode.action('detail-another');barcode.action('detail-log');
assert.equal(barcode.data.foodLog.entries.length,2);
assert.equal(barcode.data.foodLog.entries[1].slot,'','Another portion starts a neutral new entry');
assert.equal(barcode.data.foodLog.entries[0].slot,'Lunch');
console.log('PASS: category-free diary/manual/photo/product screens, neutral new records, exact legacy slot retention, read-only reopen, and neutral second portions.');
