const test=require('node:test'),assert=require('node:assert/strict');
require('../Web/core/nudge-score.js');
// Frozen strict-FVL admission; directional scoring separately asserts no bonus.
const core=globalThis.NudgeScoreCore.Legacy;
const value=(v,unit='g')=>({value:v,unit,status:'supplied'});
const food=(ingredients,extra={})=>({name:'Porridge oats',sourceName:'Open Food Facts',ingredients,basisUnit:'g',nutritionPreparation:'as_sold',
  nutrients:{energyKcal:value(370,'kcal'),sugars:value(1),fat:value(7),saturatedFat:value(1),salt:value(.02),fibre:value(9),protein:value(12)},...extra});
const inputs=p=>core.scoringInputs(p,core.resolveClassification(p));

test('complete grain and fortification ingredient statements establish zero qualifying fruit without guessing nutrients',()=>{
  for(const ingredients of ['100% Organic Wholegrain Rolled Oats','100% rolled oats','oat flakes','Basmati rice','Buckwheat Flour (100%)','long grain brown rice',
    'WHOLE _WHEAT_ (95%), _Barley_ Malt Extract, Sugar, Salt, Niacin, Iron, Riboflavin, Thiamin, Folic Acid',
    'Cooked Wholegrain Rice (98%) (Water, Brown Rice), Sunflower Oil.']){
    const p=food(ingredients),before=structuredClone(p),score=core.calculateScore(p);
    assert.equal(inputs(p).fvlPercent,0,ingredients);assert.ok(score.available,ingredients);
    assert.deepEqual(p,before);assert.equal(p.scoringFacts?.fvlPercent,undefined);
  }
});
test('trusted OFF complete-list admission does not admit unreviewed user lists or review conflicts',()=>{
  const ingredients='Cooked Wholegrain Rice (98%) (Water, Brown Rice), Sunflower Oil.';
  for(const extra of [{ingredientsNeedsReview:true},{sourceName:'User text'},{unresolvedFields:['ingredients']}]){
    const p=food(ingredients,extra);assert.equal(inputs(p).fvlBounds,null,JSON.stringify(extra));assert.equal(core.calculateScore(p).available,false);
  }
  assert.equal(inputs(food(ingredients,{sourceName:'User text',ingredientsNeedsReview:false})).fvlPercent,0);
});
test('unknown ingredients and unreadable compounds never become zero qualifying ingredients',()=>{
  for(const ingredients of ['Rolled oats, superfruit blend','Rolled oats, unidentified flavour','Oats, apple','Oats (water, mystery ingredient)',
    'Rolled oats, lentil flour','Chickpeas, water, antioxidant (ascorbic acid)','Rice (water, rice','Steamed rice, vegetable stock',
    'Whole wheat, vitamins and minerals']){
    const p=food(ingredients);assert.equal(inputs(p).fvlBounds,null,ingredients);assert.equal(core.calculateScore(p).available,false,ingredients);
  }
});
test('whole fruits and simple legumes retain positive qualifying shares; mixed dried percentages remain bounded',()=>{
  for(const [name,ingredients]of[['Banana','Banana'],['Red split lentils','Red split lentils'],['Chickpeas','Chickpeas'],['Dates','Dates']]){
    const p=food(ingredients,{name,...(name==='Dates'?{categories:['en:fruits']}: {})});assert.equal(inputs(p).fvlPercent,100,name);
  }
  const mixed=inputs(food('dates (49%), cashews (51%)',{name:'Fruit bar'}));
  assert.equal(mixed.fvlPercent,null);assert.equal(mixed.fvlBounds.lower,0);assert.ok(mixed.fvlBounds.upper>49&&mixed.fvlBounds.upper<66);
  const undeclared=inputs(food('dates, cashews',{name:'Fruit bar'}));assert.equal(undeclared.fvlBounds,null);
});
test('pure eligible oils use the special category share rather than the general non-FVL exclusions',()=>{
  for(const [ingredients,share]of[['Extra virgin olive oil',100],['Sunflower oil',0],['Rapeseed oil',0]]){
    const p=food(ingredients,{name:ingredients});assert.equal(core.resolveClassification(p).category,'fats_nuts_seeds');assert.equal(inputs(p).fvlPercent,share);
  }
  assert.equal(inputs(food('Vegetable oil',{name:'Vegetable oil'})).fvlPercent,null);
});
