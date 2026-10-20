// Source-category regressions for the shared browser/Worker core. No API, photos or owner data.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const context={};vm.createContext(context);vm.runInContext(fs.readFileSync('Web/core/nudge-score.js','utf8'),context);
const core=context.NudgeScoreCore.Legacy;
const nutrient=(value,unit='g')=>({value,unit,status:'supplied'});
const cereal=()=>({name:'Cereal fixture',categoryTag:'en:corn-flakes',sourceName:'Photographed label',basisUnit:'g',nutritionPreparation:'as_sold',
  ingredients:null,ingredientsNeedsReview:true,energyKj:nutrient(1594,'kJ'),
  nutrients:Object.fromEntries(Object.entries({energyKcal:375,protein:4.5,fibre:2,fat:.6,saturatedFat:.1,carbohydrate:87,sugars:37,salt:.83}).map(([key,value])=>[key,nutrient(value,key==='energyKcal'?'kcal':'g')]))});

// These whole names identify ordinary solid cereals; they supply no nutrient or ingredient facts.
for(const categoryTag of ['en:corn-flakes','en:cornflakes','en:maize-flakes','en:bran-flakes','en:rice-flakes','en:wheat-flakes','en:frosted-corn-flakes','en:wholegrain-wheat-flakes']) {
  const product={...cereal(),categoryTag},before=JSON.stringify(product),score=core.calculateScore(product);
  assert.equal(score.category,'general',categoryTag);assert.equal(score.status,'unrated',categoryTag);
  assert.equal(score.value,null);assert.equal(score.grade,null);assert.equal(score.baseFrequency,null);
  assert.deepEqual(Array.from(score.missingInputs),['fruit, vegetable and legume percentage']);
  assert.equal(score.inputs.fvlPercent,null);
  assert.equal(JSON.stringify(product),before,'Classification does not mutate the source facts');
}
for(const name of ['Corn flakes','Cornflakes','Frosted corn flakes','Sugar Frosted Flakes of Corn']) {
  assert.equal(core.calculateScore({...cereal(),name,categoryTag:null}).category,'general',name);
}

// A supported category does not bypass source conflicts or invent exact missing inputs.
for(const product of [
  {...cereal(),categoryTag:'en:corn-flake-milk'},
  {...cereal(),categoryTag:'en:corn-flakes-drinks'},
  {...cereal(),categoryTag:'en:corn-flakes',categories:['en:milks']},
  {...cereal(),categoryTag:'en:corn-flakes',scoringFacts:{isBeverage:true}},
  {...cereal(),categoryTag:'en:infant-corn-flakes'},
  {...cereal(),nutritionPreparation:'prepared'},
  {...cereal(),unresolvedFields:['nutrition']}
])assert.equal(core.calculateScore(product).status,'unrated');
for(const status of ['unknown','estimated','extracted','calculated']) {
  const product=cereal();product.nutrients.salt={...product.nutrients.salt,status};
  assert.equal(core.calculateScore(product).status,'unrated',status+' cannot itself establish an exact label value');
}
const missing=cereal();missing.nutrients.sugars={value:null,unit:'g',status:'unknown'};
assert.equal(core.calculateScore(missing).value,null);
const complete={...cereal(),scoringFacts:{fvlPercent:{value:0,source:'declared',evidence:'Synthetic complete ingredient fixture'}}};
assert.equal(core.calculateScore(complete).value,25);assert.equal(core.calculateScore(complete).status,'rated');
assert.equal(core.CONFIG.methodId,'nudge_nutrition_v0_3');assert.equal(core.CONFIG.version,'0.3');
assert.deepEqual(JSON.parse(JSON.stringify(core.CONFIG.gradeToScore)),{A:100,B:75,C:50,D:25,E:0});
assert.equal(core.CONFIG.offset,undefined);assert.equal(core.CONFIG.multiplier,undefined);
console.log('Passed: solid cereal category aliases; fixed grade mapping; missing FVL stays unrated until compatible evidence is supplied; conflicting categories, unknown/estimated nutrients and preparation remain unrated.');
