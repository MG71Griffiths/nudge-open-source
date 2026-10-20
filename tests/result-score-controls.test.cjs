// One visual scale, conservative identity matching, nearby confirmation and verified image choice.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {boot,product}=require('./food-detail.test.cjs');
const app=boot();for(const file of ['core/product-evidence.js','scan-results.js','food-detail-screen.js'])vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),app.sandbox);
const core=app.sandbox.NudgeScoreCore,results=app.sandbox.NudgeResults;
const nutrients=Object.fromEntries(Object.entries({energyKcal:405,protein:5.4,fibre:2,fat:17.5,carbohydrate:52.9,sugars:35.8,saturatedFat:6.1,salt:.39}).map(([k,value])=>[k,{value,unit:k==='energyKcal'?'kcal':'g',status:'supplied'}]));
const flapjack={scoringFacts:{fvlPercent:{value:0,source:'declared',evidence:'Synthetic fixture with no qualifying fruit'}},name:'GLUTEN FREE & VEGAN FRUIT FLAPJACK',basisUnit:'g',nutritionPreparation:'as_sold',energyKj:{value:1699,unit:'kJ',status:'supplied'},nutrients,ingredientsNeedsReview:true};
for(const name of ['GLUTEN FREE & VEGAN FRUIT FLAPJACK','Gluten-free and vegan fruit flapjack','Vegan fruit flapjack','Wheat free fruit flapjack']){
 const score=core.calculateScore({...flapjack,name});assert.equal(score.value,0);assert.equal(score.status,'rated');assert.equal(score.inputs.fibre,2);assert.equal(score.inputs.fvlPercent,0);
}
for(const name of ['Gluten free & vegan mystery snack','Gluten free not a flapjack','Vegan fruit flapjack milkshake','Gluten free infant flapjack'])assert.equal(core.calculateScore({...flapjack,name}).value,core.ACTIVE_DIRECTIONAL&&!/infant|milkshake/i.test(name)?0:null);
const unresolvedDrink={...flapjack,name:'Vegan fruit flapjack milkshake'},drinkBefore=JSON.stringify(unresolvedDrink);
if(core.ACTIVE_DIRECTIONAL)assert.ok(core.calculateScore(unresolvedDrink).reasonCodes.includes('special_category_identity_unresolved'),'A drink name cannot inherit the general flapjack profile');
assert.equal(JSON.stringify(unresolvedDrink),drinkBefore,'The admission hold preserves every supplied source fact');
for(const name of ['Vegan cheese','Dairy-free cheese','Vegetarian beef','Vegan butter'])assert.equal(core.calculateScore({...flapjack,name}).value,core.ACTIVE_DIRECTIONAL?0:null,'Directional fallback does not claim a special food category: '+name);
assert.equal(core.calculateScore({...flapjack,categories:['en:milks']}).value,null);
const noSalt=structuredClone(flapjack);delete noSalt.nutrients.salt;assert.equal(core.calculateScore(noSalt).value,null);
for(const value of [0,25,34,50,66,75,80,85,100]){const html=core.renderDial(value);assert.match(html,/nf-dial-marker/);assert.equal((html.match(/<path class="nf-arc-/g)||[]).length,3);assert.doesNotMatch(html,/nf-grade-step|nf-score-discrete/);assert.match(html,new RegExp('<strong>'+value+'</strong><span>/100</span>'));}
for(const value of [null,undefined,NaN,Infinity,-1,101,'80']){const html=core.renderDial(value);assert.doesNotMatch(html,/nf-dial-marker|NaN/);assert.match(html,/>—</);}
const thumbnail='data:image/jpeg;base64,AA==',url='https://images.openfoodfacts.org/images/products/123/front.jpg';
assert.equal(results.productImage({imageURL:url},thumbnail).src,url);assert.equal(results.productImage({imageURL:url},thumbnail).fallback,thumbnail);
assert.equal(results.productImage({},thumbnail).src,thumbnail);assert.equal(results.productImage({imageURL:'javascript:alert(1)'},'bad').src,'');
const target={tagName:'IMG',style:{},dataset:{nudgeFallback:thumbnail},src:url,matches:()=>true,getAttribute(){return this.src},setAttribute(k,v){this[k]=v},removeAttribute(k){delete this[k]}};
results.imageFailed(target);assert.equal(target.src,thumbnail);assert.equal(target.dataset.nudgeFallback,undefined);results.imageFailed(target);assert.equal(target.style.visibility,'hidden');
app.receive({...product,...flapjack,servingAmount:30,servingUnit:'g',imageURL:url});app.controller._scan.thumbnail=thumbnail;
let html=app.controller.screen();assert.equal((html.match(/data-action="detail-log"/g)||[]).length,1);assert.match(html,/data-action="detail-log"[^>]*>[\s\S]*?Add to today/);
assert.ok(html.indexOf('id="detail-measure"')<html.indexOf('data-action="detail-log"'));assert.ok(html.indexOf('data-action="detail-log"')<html.indexOf('class="nf-four"'));
assert.match(html,/data-nudge-fallback="data:image\/jpeg/);assert.match(html,/nf-product-photo" src="https:\/\/images.openfoodfacts.org/);
assert.equal(app.data.foodLog.entries.length,0);app.action('detail-log');assert.equal(app.data.foodLog.entries.length,1);const original=JSON.stringify(app.data);
html=app.controller.screen();assert.match(html,/data-action="detail-undo"/);assert.equal(JSON.stringify(app.data),original);
console.log('Passed: qualified food names retain category/unknown guards; shared dial boundaries; Add to today adjacent to portion controls; exact-product library image with captured fallback; intake unchanged by presentation.');
