// Partial known nutrition constrains only the separate rough estimate.
const assert=require('node:assert/strict');require('../Web/core/nudge-score.js');const meal=require('../Web/core/meal-score.js');
const n=(value,unit='g',status='supplied',relation='eq')=>({value,unit,status,relation});
const sparse={name:'Yeast extract',ingredients:'Yeast extract, barley, oats, salt, vegetable juice',basisUnit:'g',nutritionPreparation:'as_sold',nutrients:{salt:n(10.8),sugars:n(1.2),energyKcal:n(260,'kcal'),saturatedFat:n(0),fibre:n(null),protein:n(34)}};
const before=JSON.stringify(sparse),scored=meal.estimate(sparse),noNutrition=meal.estimate({...sparse,nutrients:{}});
assert.equal(scored.methodId,'nudge_food_estimate_v3');assert.equal(meal.validResult(scored),true);assert.ok(scored.value<40);assert.ok(scored.value<noNutrition.value);
assert.equal(scored.inputs.partialNutrition.salt.value,10.8);assert.equal(scored.grade,null);assert.equal(sparse.nutrients.fibre.value,null);assert.equal(JSON.stringify(sparse),before);
assert.ok(scored.reasonCodes.includes('known_nutrition_constraints'));assert.equal(scored.components.adjustments.find(x=>x.id==='known_salt').points,-40);
// Both before and after are necessarily low-confidence estimates. Unknown,
// units, basis, conflicting preparation and upper bounds cannot become zeros.
for(const patch of [{basisUnit:null},{nutritionPreparation:'unknown'},{unresolvedFields:['nutrition']},{unresolvedFields:['preparation']}])assert.equal(meal.estimate({...sparse,...patch}).value,noNutrition.value);
for(const salt of [n(null),n(10.8,'mg'),n(10.8,'g','unknown'),n(10.8,'g','supplied','lt'),n(NaN),n(Infinity),n(-1),n(101)]){
 const p={...sparse,nutrients:{salt}};assert.equal(meal.estimate(p).value,noNutrition.value);
}
assert.ok(meal.estimate({...sparse,nutrients:{salt:n(10.8,'g','supplied','gte')}}).value<noNutrition.value,'A known minimum salt level still constrains the estimate');
const sugar={name:'Fruit flapjack',ingredients:'Oats, fruit',basisUnit:'g',nutritionPreparation:'as_sold',nutrients:{sugars:n(35.8),saturatedFat:n(6.1),fat:n(17.5),fibre:n(null)}};
assert.ok(meal.estimate(sugar).value<meal.estimate({...sugar,nutrients:{}}).value);
for(const key of ['salt','sugars','saturatedFat']){
 const values=key==='salt'?[0,.5,1.5,3,10.8]:key==='sugars'?[0,5,15,30,50]:[0,2,5,10,15];
 let previous=100;for(const value of values){const p={...sugar,nutrients:{[key]:n(value)}};const score=meal.estimate(p);assert.ok(score.value<=previous,`${key} monotonic at ${value}`);previous=score.value;}
}
const component=amount=>({name:'Vegetable soup',amountGrams:amount,recordId:'known-soup',sourceRecord:{id:'known-soup',basis:'per100g',foodGroup:'mixed_dish',nutrients:{salt:n(2,'g','composition_estimate')}}});
const one={name:'Vegetable soup',basis:'perPortion',components:[component(200)]},two={...one,components:[component(400)]};
assert.equal(meal.calculate(one).value,meal.calculate(two).value,'Per100 estimate is portion-invariant');
assert.equal(meal.calculate(one).inputs.partialNutrition.salt.value,2);
const mixed={...one,components:[component(200),{name:'Carrot',amountGrams:50,recordId:'carrot',sourceRecord:{id:'carrot',basis:'per100g',foodGroup:'vegetable',nutrients:{salt:n(null)}}}]};
assert.equal(meal.calculate(mixed).inputs.partialNutrition.salt,null,'An incomplete component subtotal is not whole-meal salt');
const withoutBasis={name:'Soup',basis:'perPortion',portion:{amount:200,unit:'g'},nutrients:{salt:n(2)}};assert.deepEqual(meal.estimate(withoutBasis).inputs.partialNutrition,{},'A portion nutrient must not be mistaken for per100');
// Both old estimate versions remain read-only valid and untouched.
for(const version of ['nudge_food_estimate_v1','nudge_food_estimate_v2']){
 const old={available:true,value:70,status:'estimated_rough',methodId:version,methodVersion:version,scoreBasis:'food_pattern',confidence:'low'};const saved=JSON.stringify(old);assert.equal(meal.validResult(old),true);assert.equal(JSON.stringify(old),saved);
}
console.log('Passed nutrient-aware v3 rough estimates: known salt/sugar/saturates, monotonic constraints, unknown/basis/preparation guards, composed meal scaling, source immutability and v1/v2 historical validity.');
