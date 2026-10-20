// Synthetic food descriptions only. No source quantities, diary or network calls.
const assert=require('node:assert/strict');
require('../Web/core/nudge-score.js');const score=require('../Web/core/meal-score.js');
const component=(name,amountGrams=null)=>({name,amountGrams,recordId:null,sourceRecord:null,nutrients:{salt:{value:null}}});
const meal={name:'Taco Pizza',components:[component('pizza base',120),component('ground meat',50),component('cheese',40),component('lettuce',15),component('tomato',15)]};
const before=JSON.stringify(meal),rough=score.calculate(meal);
assert.equal(rough.available,true);assert.equal(rough.status,'estimated_rough');assert.equal(rough.methodId,'nudge_food_estimate_v3');
assert.equal(rough.label,'Rough estimate');assert.equal(rough.confidence,'low');assert.equal(rough.scoreBasis,'food_pattern');
assert.equal(score.validResult(rough),true);assert.equal(JSON.stringify(meal),before);
assert.ok(rough.value>=5&&rough.value<=95&&rough.value%5===0);
for(const key of ['grade','rawScore','baseFrequency','finalFrequency'])assert.equal(rough[key],null,key+' cannot imply a detailed nutrition result');
assert.ok(rough.reasonCodes.includes('detailed_score_unavailable'));assert.ok(rough.rationale.length);assert.match(rough.explanation,/no missing nutrient quantities/i);
for(const factor of [.25,.5,2,4]){
 const scaled=structuredClone(meal);scaled.components.forEach(c=>c.amountGrams*=factor);assert.equal(score.calculate(scaled).value,rough.value);
}
for(const name of ['Raw vegetables assortment','Roasted cauliflower and spinach salad','Vegetable soup','Marmite','Sugar Frosted Flakes of Corn','Ground almonds','Chicken salad','Vegan sausage roll','Sandwich','Pasta bake','Lentil curry','Fish and chips']){
 const r=score.estimate({name});assert.equal(r.available,true,name);assert.equal(r.label,'Rough estimate');assert.equal(score.validResult(r),true,name);
}
assert.ok(score.estimate({name:'Vegetable salad'}).value>score.estimate({name:'Battered sausage and chips'}).value);
assert.notEqual(score.estimate({name:'Vegan sausage roll'}).factors.proteinType,'processed_meat');
assert.equal(score.estimate({name:'Bacon sandwich with vegan mayonnaise'}).factors.proteinType,'processed_meat');
assert.equal(score.estimate({name:'Baby spinach salad'}).available,true,'Baby spinach is not infant food');
for(const [name,category] of [['Orange wine','en:wines'],['Fruit beer','en:beers'],['Apple cider','en:ciders'],['Chocolate cream liqueur','en:liqueurs']])assert.equal(score.estimate({name,categories:[category]}).available,false,'Alcohol category must override food words: '+name);
const excludedDetailed=globalThis.NudgeScoreCore.unratedScore('Unsupported category',['supported food category'],'unsupported');
assert.equal(score.estimate({name:'Orange wine'},excludedDetailed),excludedDetailed,'Detailed category exclusions survive fallback');
assert.equal(score.estimate({name:'Chicken with red wine vinegar',categories:['en:prepared-meals']}).available,true,'A food ingredient containing wine is not an alcoholic-product category');
for(const input of [null,[],{}, {name:'Your food'},{name:'Unidentified dish'}, {name:'Snorfblatt'}, {name:'A purple chair'}, {name:'Banana phone'}, {name:'Chocolate shampoo'}, {name:'Dog food'}, {name:'Beer'}, {name:'Red wine'}, {name:'Infant formula'}, {name:'Protein powder'}, {name:'Vitamin supplement'}, {name:'Salad',type:'unknown'}, {name:'Salad',isFood:false}, {name:'Salad',categoryTag:'sports nutrition'}, {name:'Salad',components:[{name:'salad',sourceRecord:{foodGroup:'medical_food'}}]}])assert.equal(score.estimate(input).available,false,JSON.stringify(input));
const qualitative={wholePlants:'high',wholeGrains:'yes',legumesNuts:'yes',proteinType:'plant',refinedStarch:'no',sugaryFood:'no',frying:'no',confidence:'medium',evidence:'Visible vegetables, chickpeas and whole grains.'};
assert.equal(score.estimate({name:'Unidentified item',qualityEstimate:qualitative}).available,false,'Factors cannot identify the food');
const plant={name:'Vegetable grain bowl',ingredients:[{name:'chickpeas'}],qualityEstimate:qualitative};
assert.equal(score.estimate(plant).value,95);assert.equal(score.estimate({...plant,score:0,grade:'E',value:0}).value,95,'Caller numeric output is ignored');
assert.ok(score.estimate({...plant,qualityEstimate:{...qualitative,wholePlants:'low'}}).value<95);
assert.ok(score.estimate({...plant,qualityEstimate:{...qualitative,frying:'yes',evidence:'Visible deep-fried battered vegetables and chickpeas.'}}).value<95);
for(const ingredients of ['Tomatoes, lentils, onion',{text:'Tomatoes, lentils, onion'},[{name:'Tomatoes'},{name:'lentils'},{name:'onion'}]])assert.equal(score.estimate({name:'Unknown product',ingredients}).available,true,'Product ingredient shapes share the fallback');
const sparse={name:'Chicken soup',nutrients:{salt:null,protein:{value:null}},components:[component('chicken'),component('carrot')]};
const sparseBefore=JSON.stringify(sparse),sparseResult=score.calculate(sparse);assert.equal(sparseResult.available,true);assert.equal(JSON.stringify(sparse),sparseBefore);assert.ok(sparseResult.missingInputs.length);
const complete={name:'Salad',basis:'perPortion',components:[{name:'Vegetable',amountGrams:100,recordId:'qa',sourceRecord:{id:'qa',basis:'per100g',foodGroup:'vegetable',fvlEligible:true,nutrients:Object.fromEntries(Object.entries({energyKcal:50,protein:3,carbohydrate:8,sugars:2,fat:1,saturatedFat:.2,fibre:4,salt:.1}).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:'composition_estimate'}]))}}]};
assert.deepEqual(score.calculate(complete),score.calculateDetailed(complete));assert.equal(score.calculate(complete).methodId,globalThis.NudgeScoreCore.SCORE_METHOD);
const zero={...score.calculateDetailed(complete),value:0};assert.equal(score.estimate(sparse,zero),zero,'An available zero result wins');
const historical={available:true,value:40,status:'estimated_rough',methodVersion:'nudge_food_estimate_v1',scoreBasis:'food_pattern',confidence:'low'};
assert.equal(score.validResult(historical),true);assert.notEqual(score.calculate({...plant,scoreSnapshot:historical}).value,40,'Saved snapshots are not silently used as new calculations');
for(const patch of [{value:100},{value:0},{value:42},{confidence:'high'},{status:'rated'},{scoreBasis:'laboratory'},{available:false},{grade:'A'},{rawScore:0},{finalFrequency:'Daily'},{methodVersion:'nudge_food_estimate_v1'},{version:'0.3'}])assert.equal(score.validResult({...rough,...patch}),false);
console.log('Passed: separate v3 rough food estimates, identified-food gates and exclusions, deterministic rationale, screenshot foods, source/zero precedence, generic product ingredient inputs, quantity invariance, untouched unknown nutrients and historical admission.');
