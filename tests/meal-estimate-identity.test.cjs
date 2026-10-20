const assert=require('node:assert/strict');
const {test}=require('node:test');
require('../Web/core/nudge-score.js');
const composition=require('../Web/core/food-composition.js');
const score=require('../Web/core/meal-score.js');
const analysis=require('../Web/core/analysis-result.js');
const foodLog=require('../Web/core/food-log.js');
const clone=v=>JSON.parse(JSON.stringify(v));
const proposal=()=>({version:1,basis:'perPortion',portionGrams:280,category:'general',fvlPercent:35,
  nutrients:{energyKcal:270,protein:8,carbohydrate:32,sugars:18,fat:12,saturatedFat:4,fibre:5,salt:.3},
  assumptions:['Synthetic typical serving; recipe and topping are assumed.']});
function observed(name='Berry smoothie with topping'){
  const m={name,basis:'perPortion',compositionVersion:'synthetic',portionMode:'estimated_serving',ingredients:[],plants:[],
    subject:{kind:'loose_food',description:'Foreground portion of '+name,photoIndex:1},
    components:[{name,preparation:'Blended',amountGrams:265,recordId:null,nutrients:{},photoIndex:1,evidence:'Visible foreground serving.'},
      {name:'Topping',preparation:'Uncooked',amountGrams:15,recordId:null,nutrients:{},photoIndex:1,evidence:'Visible topping.'}],nutrientEstimate:proposal()};
  m.nutrientEstimateContext=composition.nutrientEstimateContext(m);
  // Existing unconfirmed observations may already contain discarded totals.
  m.nutrients=composition.total(m.components);return m;
}
const model=analysis.create({composition,mealScore:score,names:v=>v,suggestion:()=>null});
test('linked visual food supports numeric estimates independently of English food-pattern vocabulary',()=>{
  for(const name of ['Berry smoothie with topping','Khachapuri','酸辣粉']){
    const m=observed(name),before=JSON.stringify(m);
    assert.equal(score.estimate(m).available,false,'The legacy vocabulary intentionally remains unchanged for '+name);
    assert.equal(score.supportsNutrientEstimateIdentity(m),true,name);assert.ok(composition.activeNutrientEstimate(m),name);
    const nutrition=composition.mealNutrition(m),rating=score.calculate(m);
    for(const key of composition.keys){assert.equal(nutrition[key].value,m.nutrientEstimate.nutrients[key]);assert.equal(nutrition[key].source,'model_photo_estimate');}
    assert.equal(rating.available,true,name);assert.equal(rating.scoreBasis,'model_nutrient_estimate');assert.equal(rating.estimated,true);assert.ok(score.validResult(rating));
    assert.equal(JSON.stringify(m),before,'Projection does not change the observation');
  }
});
test('numbers and an unfamiliar name alone do not establish a photographed food subject',()=>{
  for(const edit of [m=>delete m.subject,m=>m.subject.kind='unknown',m=>m.subject.photoIndex=null,m=>m.subject.photoIndex=5,
    m=>m.subject.description='',m=>m.subject.description='Not food',m=>m.components.forEach(c=>c.evidence=''),
    m=>m.components.forEach(c=>c.photoIndex=null),m=>m.components.forEach(c=>c.photoIndex=2),m=>m.components=[],
    m=>{m.name='Unknown food';m.components[0].name='Unknown food';m.components[1].name='Unknown ingredient';},
    m=>{m.name='Unidentified object';m.components[0].name='Unidentified object';},m=>{m.name='soap';m.components[0].name='soap';},
    m=>m.type='unknown',m=>m.nonFood=true,m=>m.isFood=false,m=>m.category='unsupported',m=>m.foodGroup='medical_food']){
    const m=observed('Khachapuri');edit(m);m.nutrientEstimateContext=composition.nutrientEstimateContext(m);
    assert.equal(composition.activeNutrientEstimate(m),null);assert.equal(composition.mealNutrition(m).energyKcal.value,null);assert.equal(score.calculateNutrientEstimate(m),null);
  }
  for(const name of ['Ceramic plate','wooden table']){
    const m=observed(name);delete m.subject;assert.equal(score.supportsNutrientEstimateIdentity(m),false);
  }
});
test('the visual eligibility change preserves edit, context, recipe and numeric validity guards',()=>{
  for(const edit of [m=>m.userEdited=true,m=>m.components[0].userEdited=true,m=>m.components[0].matchStatus='confirmed',
    m=>m.components[0].amountSource='confirmed',m=>m.components[0].matchMethod='user_selected',m=>m.components[0].selected=false,
    m=>m.components[0].amountGrams=500,m=>m.recipeCalculation={applied:true},m=>m.nutrientEstimate.nutrients.fibre=null,
    m=>m.nutrientEstimate.nutrients.energyKcal=0,m=>m.nutrientEstimate.nutrients.sugars=100]){
    const m=observed();edit(m);assert.equal(composition.activeNutrientEstimate(m),null);assert.equal(composition.mealNutrition(m).energyKcal.value,null);
  }
});
test('explicit non-food evidence overrides visual classification without treating ordinary absence as non-food',()=>{
  for(const [name,evidence] of [['Ceramic plate','An empty ceramic plate, not food'],
    ['Wooden table','Not edible: a wooden table'],['Uncatalogued preparation','The object is not food'],
    ['Curry','This is an inedible display'],['Khachapuri','A plastic toy is visible']]){
    const m=observed(name);m.components[0].evidence=evidence;
    assert.equal(score.supportsNutrientEstimateIdentity(m),false,name);
    assert.equal(composition.activeNutrientEstimate(m),null,name);
    for(const key of composition.keys)assert.equal(composition.mealNutrition(m)[key].value,null,name+' '+key);
    assert.equal(score.calculateNutrientEstimate(m),null,name);
    assert.equal(score.calculate(m).available,false,name+' cannot receive a rough fallback score either');
  }
  for(const description of ['Not a meal','An inedible display','A plastic toy']){
    const m=observed('Curry');m.subject.description=description;
    assert.equal(score.supportsNutrientEstimateIdentity(m),false,description);
  }
  for(const evidence of ['No garnish is visible.','No sauce is visible.','Visible serving without a topping.']){
    const m=observed('Khachapuri');m.components[0].evidence=evidence;
    assert.equal(score.supportsNutrientEstimateIdentity(m),true,evidence);
    assert.equal(composition.mealNutrition(m).energyKcal.value,proposal().nutrients.energyKcal);
  }
});
test('an existing unconfirmed smoothie observation restores eight estimated nutrients through save/reload and portions',()=>{
  const raw={type:'meal',labelKind:'both',basis:'perPortion',nutrients:{},meal:observed()},before=JSON.stringify(raw);
  const e=model.normalise(raw);assert.equal(e.meal.portion.amount,280);assert.equal(model.mealScore(e).scoreBasis,'model_nutrient_estimate');
  for(const amount of [.5,1,2]){
    const record=model.buildRecord({extraction:e,amount,unit:'portion',day:'2026-10-20',draft:{confirmationId:'synthetic-identity-'+amount,name:'Berry smoothie with topping',slot:'Snack'},selection:{fraction:amount},retrievedAt:'2026-10-20T12:00:00Z'});
    const log=foodLog.create({dayNumber:()=>1,recipeKnown:()=>false,composition:()=>composition}),[saved]=log.clean({entries:[record]}).entries;
    assert.equal(saved.nutritionStatus,'complete');assert.equal(saved.sourceMeta.mealScore.scoreBasis,'model_nutrient_estimate');
    for(const key of composition.keys){assert.equal(saved.nutritionSnapshot[key].portion,proposal().nutrients[key]*amount);assert.equal(saved.nutritionSnapshot[key].estimated,true);assert.equal(composition.intakeNutrient(saved,key).value,proposal().nutrients[key]*amount);}
  }
  assert.equal(JSON.stringify(raw),before);assert.equal(raw.meal.nutrients.energyKcal.value,null,'No automatic diary/history rewrite');
  const confirmed=model.normalise(clone(raw),{confirmedSnapshot:true});assert.equal(confirmed.nutrients.energyKcal.value,null,'Confirmed missing fields remain confirmed');
});
