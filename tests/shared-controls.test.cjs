// The controls edit existing drafts; no fixture touches owner storage or services.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={window:null};context.window=context;vm.createContext(context);
vm.runInContext(fs.readFileSync('Web/shared-controls.js','utf8'),context);
const controls=context.NudgeControls;
assert.equal(controls.parseDecimal('1,25',{minimum:.25,maximum:8}).value,1.25);
assert.equal(controls.parseDecimal(' .5 ',{minimum:.25,maximum:8}).value,.5);
for(const raw of ['', '1,2.3','1e2','Infinity','NaN','-1','0','8.1','1 000','1foo'])assert.ok(controls.parseDecimal(raw,{minimum:.25,maximum:8}).error,raw);
assert.equal(controls.parseDecimal('',{minimum:18,maximum:110,optional:true}).value,null);
assert.ok(controls.parseDecimal('18.5',{minimum:18,maximum:110,integer:true}).error);
assert.equal(controls.mealChoices,undefined,'Meal categories are no longer a shared UI control');
const tags=controls.tags({label:'Goals',items:['Plants','Protein'],name:'goals',selected:['Plants','Protein']});
assert.equal((tags.match(/ checked/g)||[]).length,2);assert.equal((tags.match(/type="checkbox"/g)||[]).length,2);
const lower=controls.stepper({label:'Portions',value:.25,unit:'portions',step:.25,minimum:.25,maximum:8,action:'step',increment:'¼'});
assert.match(lower,/data-value="-0.25"[^>]*disabled/);assert.doesNotMatch(lower,/data-value="0.25"[^>]*disabled/);
const firstUnit=controls.stepper({label:'Amount',value:1,unit:'g',step:1,minimum:Number.MIN_VALUE,maximum:5000,action:'step'});
assert.match(firstUnit,/data-value="-1"[^>]*disabled/,'A zero-result decrement is disabled even with a strictly positive microscopic domain minimum');
const upper=controls.stepper({label:'Portions',value:8,unit:'portions',step:.25,minimum:.25,maximum:8,action:'step',increment:'¼'});
assert.match(upper,/data-value="0.25"[^>]*disabled/);
assert.doesNotMatch(controls.numberField({id:'age',name:'age',label:'Age',value:null,minimum:18,maximum:110}),/type="number"|autofocus/);

// Partial updates retain mounted controls and keep spoken values in sync with
// the visible amount, just as a full rerender does.
const element=(text,label='')=>({textContent:text,attributes:{'aria-label':label},setAttribute(key,value){this.attributes[key]=value;},getAttribute(key){return this.attributes[key];}});
const beforeValue=element('','1 portions'),afterValue=element('','1.5 portions'),beforeAmount=element('1'),afterAmount=element('1.5');
const beforeNodes={'.scan-stepper .nc-stepper-value':beforeValue,'.scan-stepper strong':beforeAmount,'.scan-stepper .nc-stepper-value>span':element('portions')};
const afterNodes={'.scan-stepper .nc-stepper-value':afterValue,'.scan-stepper strong':afterAmount,'.scan-stepper .nc-stepper-value>span':element('portions')};
const beforeRoot={querySelector:selector=>beforeNodes[selector]||null,querySelectorAll:()=>[]},afterRoot={querySelector:selector=>afterNodes[selector]||null};
context.document={querySelector:()=>beforeRoot,createElement:()=>afterRoot};
vm.runInContext(fs.readFileSync('Web/barcode.js','utf8'),context);
assert.equal(context.NudgeScanUI.refresh('isolated amount update'),true);
assert.equal(beforeAmount.textContent,'1.5');assert.equal(beforeValue.getAttribute('aria-label'),'1.5 portions');
assert.equal(beforeNodes['.scan-stepper .nc-stepper-value'],beforeValue,'The existing accessible value node stays mounted');

const {boot,extraction}=require('./label-photo.test.cjs');
const label=boot();label.review(extraction({protein:10},'per100g',null,{productName:'Test label'}));
assert.doesNotMatch(label.html(),/data-action="label-slot"|Meal time/);
label.action('label-slot','Lunch');assert.equal(label.controller._state.slot,'');assert.equal(label.writes(),0);
label.data.nutritionProfile=label.sandbox.NudgeNutrition.clean();
const setup=label.fit.setupScreen();assert.doesNotMatch(setup,/<select/);assert.match(setup,/name="avoid-milk"/);assert.match(setup,/name="avoid-gluten"/);
assert.doesNotMatch(label.fit.profileScreen(),/125|2,700|Moderate activity is assumed/);
assert.equal(label.data.nutritionProfile.activity,'unknown');assert.equal(label.data.nutritionProfile.target,null);
assert.equal(label.data.nutritionProfile.calorieTarget,null);

const productApp=require('./food-detail.test.cjs').boot();
const product=require('./food-detail.test.cjs').product;
productApp.controller.receive({type:'result',requestId:productApp.controller._scan.requestId,product});
// Existing full controller tests above verify real quantity changes, supported
// unit conversion, Add/Undo, reload, unrelated record retention and rollback.
console.log('Passed: shared visible/exclusive choices, independent native tags, locale-safe exact amounts, bounds, optional keyboard entry and unknown unsaved profile defaults.');
