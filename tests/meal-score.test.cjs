// Synthetic composition records isolate arithmetic; no photos, user data or API.
const assert=require('node:assert/strict');
require('../Web/core/nudge-score.js');
const score=require('../Web/core/meal-score.js');
const core=globalThis.NudgeScoreCore;
const clone=value=>structuredClone(value);
const fields={energyKcal:50,protein:3,carbohydrate:8,sugars:2,fat:1,saturatedFat:.2,fibre:4,salt:.1};
const component=(id,amountGrams,values=fields,fvlEligible=true)=>({recordId:id,amountGrams,nutrients:{},
  sourceRecord:{id,basis:'per100g',foodGroup:'vegetable',fvlEligible,source:'Synthetic test composition',nutrients:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:'composition_estimate'}]))}});
const meal=(...components)=>({basis:'perPortion',portion:{unit:'g'},components});
const baseline=meal(component('vegetable-a',180),component('vegetable-b',70));
const first=score.calculateDetailed(baseline);
assert.equal(first.available,true);assert.equal(first.value,100);assert.equal(first.rawScore,-7);
assert.equal(first.methodVersion,core.SCORE_VERSION);assert.equal(first.status,'estimated');assert.equal(first.methodStatus,core.ACTIVE_DIRECTIONAL?'directional':'proposed_beta');
assert.equal(first.band.id,'green');assert.equal(first.grade,'A');assert.equal(first.finalFrequency,null);
const frozen=JSON.stringify(baseline);score.calculateDetailed(baseline);assert.equal(JSON.stringify(baseline),frozen,'Calculation never mutates supplied data');
const versioned=clone(baseline);versioned.components[0].sourceRecord.sourceVersion='CoFID-2021-proximates-v1';versioned.components[0].sourceRecord.version='older-field';versioned.components[1].sourceRecord.version='legacy-fixture-version';
const sourced=score.calculateDetailed(versioned);
for(const records of [sourced.inputs.sourceRecords,sourced.sourceData.sourceRecords])assert.deepEqual(records.map(r=>r.version),['CoFID-2021-proximates-v1','legacy-fixture-version'],'Source dataset version survives current and legacy field names');
assert.equal(first.sourceData.sourceRecords[0].version,null,'A missing source version remains unknown');
for(const multiplier of [.25,.5,1,1.25,2,4]){
  const scaled=clone(baseline);scaled.components.forEach(c=>c.amountGrams*=multiplier);
  assert.equal(score.calculateDetailed(scaled).value,first.value,`Uniform portion multiplier ${multiplier} cannot alter food quality`);
  assert.equal(score.calculateDetailed(scaled).inputs.portionGrams,250*multiplier);
}
for(const key of ['energyKcal','protein','sugars','saturatedFat','fibre','salt']){
  for(const value of [null,undefined,NaN,Infinity,-1,'4']){
    const invalid=clone(baseline);invalid.components[1].sourceRecord.nutrients[key].value=value;
    assert.equal(score.calculateDetailed(invalid).available,false,`${key} ${value} cannot become zero`);
  }
  const trace=clone(baseline);trace.components[0].sourceRecord.nutrients[key]={value:0,unit:key==='energyKcal'?'kcal':'g',status:'trace'};
  assert.equal(score.calculateDetailed(trace).available,false,'Trace remains unknown even with a stale numeric copy');
}
for(const invalid of [null,{},meal(),meal(component('x',0)),meal(component('x',-1)),meal(component('x',NaN)),meal(component('x',5001))])assert.equal(score.calculateDetailed(invalid).available,false);
const mismatched=clone(baseline);mismatched.components[0].recordId='different';assert.equal(score.calculateDetailed(mismatched).available,false);
const wrongBasis=clone(baseline);wrongBasis.components[0].sourceRecord.basis='perPortion';assert.equal(score.calculateDetailed(wrongBasis).available,false);
const guessed=clone(baseline);guessed.components[0].sourceRecord=null;guessed.nutrients={energyKcal:{value:1}};assert.equal(score.calculateDetailed(guessed).available,false,'AI totals never bypass missing source records');
const stale=clone(baseline);stale.nutrients={energyKcal:{value:9999}};stale.components[0].nutrients={energyKcal:{value:9999}};assert.equal(score.calculateDetailed(stale).value,first.value,'Only the selected source record supplies scoring values');
const badUnit=clone(baseline);badUnit.components[0].sourceRecord.nutrients.salt.unit='mg';assert.equal(score.calculateDetailed(badUnit).available,false);
const badRatio=clone(baseline);badRatio.components[0].sourceRecord.nutrients.fat.value=.01;assert.equal(score.calculateDetailed(badRatio).available,false);
const sweet=clone(baseline);sweet.components[0].sourceRecord.nutrients.sugars.value=20;assert.equal(score.calculateDetailed(sweet).available,false);
const bounds=clone(baseline);bounds.components[0].sourceRecord.nutrients.protein.relation='<';assert.equal(score.calculateDetailed(bounds).available,false);
for(const foodGroup of ['beverage','alcohol','supplement','infant_food','medical_food']){
  const unsupported=clone(baseline);unsupported.components[0].sourceRecord.foodGroup=foodGroup;assert.equal(score.calculateDetailed(unsupported).available,false);
}
for(const foodGroup of ['red_meat','cheese','fat_oil','nuts_seeds']){
  const special=component('special',100,fields,false);special.sourceRecord.foodGroup=foodGroup;
  special.sourceRecord.mealScoringProfile=['fat_oil','nuts_seeds'].includes(foodGroup)?'fats_nuts_seeds':foodGroup;
  assert.equal(score.calculateDetailed(meal(special)).available,true,'A reviewed special food uses its own source profile');
  assert.equal(score.calculateDetailed(meal(special)).category,special.sourceRecord.mealScoringProfile);
  for(const amount of [49.9,50,50.1,100]){
    special.amountGrams=amount;const mixedScore=score.calculateDetailed(meal(special,component('vegetables',50)));
    assert.equal(mixedScore.available,true,'Mixed dishes have no arbitrary special-weight refusal');
    assert.equal(mixedScore.category,'general');
  }
}
const red=component('red',100,{...fields,protein:30},false);red.sourceRecord.mealScoringProfile='red_meat';
assert.equal(score.calculateDetailed(meal(red)).components.positive.find(p=>p.id==='protein').points,2);
const cheese=component('cheese',100,{...fields,protein:30,salt:2.4},false);cheese.sourceRecord.mealScoringProfile='cheese';
assert.equal(score.calculateDetailed(meal(cheese)).countProteins,true);
const oil=component('oil',100,{...fields,energyKcal:900,fat:100,saturatedFat:16,protein:0,fibre:0},false);
oil.sourceRecord.foodGroup='fat_oil';oil.sourceRecord.mealScoringProfile='fats_nuts_seeds';
const oilScore=score.calculateDetailed(meal(oil));assert.equal(oilScore.available,true);assert.equal(oilScore.inputs.fvlPercent,null);
assert.equal(oilScore.components.negative.find(p=>p.id==='saturateRatio').points,2,'Ratio uses inclusive threshold');
assert.equal(oilScore.components.negative.find(p=>p.id==='energyFromSaturates').points,4);
assert.equal(oilScore.status,'estimated_provisional','Unknown oil provenance cannot become zero FVL');
for(const value of [0,null]){const bad=clone(oil);bad.sourceRecord.nutrients.fat.value=value;assert.equal(score.calculateDetailed(meal(bad)).available,false);}
for(const threshold of core.TABLES.saturateRatio){for(const delta of [-.00001,0,.00001]){
 const c=clone(oil);c.sourceRecord.nutrients.saturatedFat.value=threshold+delta;
 const actual=score.calculateDetailed(meal(c)).components.negative.find(p=>p.id==='saturateRatio').points;
 assert.equal(actual,core.pointsFor(threshold+delta,core.TABLES.saturateRatio,true));
}}
const denseMixed=meal(red,component('greens',50),component('egg',30,fields,false));
assert.equal(score.calculateDetailed(denseMixed).available,true);assert.equal(score.calculateDetailed(denseMixed).category,'general');
const mixed=meal(component('rice',150,fields,false),component('vegetables',150),component('fish',120,fields,false));
mixed.components[0].sourceRecord.foodGroup='grain';mixed.components[1].sourceRecord.foodGroup='vegetable';mixed.components[2].sourceRecord.foodGroup='fish';
assert.equal(score.calculateDetailed(mixed).available,true,'An ordinary rice, vegetable and fish meal stays supported');
const unknownPlants=meal(component('unknown',100,fields,null));assert.equal(score.calculateDetailed(unknownPlants).available,true,'Missing plant eligibility alone gives a provisional no-bonus score');assert.equal(score.calculateDetailed(unknownPlants).inputs.fvlPercent,null);
const reviewedCompound=clone(unknownPlants);reviewedCompound.components[0].sourceRecord.foodGroup='mixed_dish';
const partial=score.calculateDetailed(reviewedCompound);assert.equal(partial.available,true);assert.equal(partial.status,'estimated_provisional');assert.equal(partial.rawScore,-2);assert.equal(partial.inputs.fvlPercent,null);assert.equal(partial.inputs.fvlRange,undefined);assert.equal(partial.displayLower,100);assert.equal(partial.displayUpper,100);assert.equal(partial.value,partial.displayLower);assert.equal(partial.band.id,'green');assert.equal(partial.grade,'A');
for(const factor of [.25,2,4]){const scaled=clone(reviewedCompound);scaled.components[0].amountGrams*=factor;const s=score.calculateDetailed(scaled);assert.equal(s.value,partial.value);assert.equal(s.displayUpper,partial.displayUpper);}
const missingCompound=clone(reviewedCompound);missingCompound.components[0].sourceRecord.nutrients.salt.value=null;assert.equal(score.calculateDetailed(missingCompound).available,false,'Provisional FVL never invents a required nutrient');
const stableBounds=meal(component('known vegetable',90),component('unknown food',10,fields,null));assert.equal(score.calculateDetailed(stableBounds).available,true,'An unknown share is harmless when both bounds have the same points');assert.equal(score.calculateDetailed(stableBounds).inputs.fvlPercent,null);
const exclusions=meal(component('potato',50,fields,false),component('nuts',50,fields,false));assert.equal(score.calculateDetailed(exclusions).components.positive[0].points,0,'Explicit excluded foods do not count as FVL');
const fvlPoints=fraction=>score.calculateDetailed(meal(component('veg',fraction,fields,true),component('other',100-fraction,fields,false))).components.positive[0].points;
assert.equal(fvlPoints(40),0);assert.equal(fvlPoints(40.001),1);assert.equal(fvlPoints(60),1);assert.equal(fvlPoints(60.001),2);assert.equal(fvlPoints(80),2);assert.equal(fvlPoints(80.001),5);
// Every general-food threshold is exercised through the meal adapter, including
// exact equality and floating representation at a kcal-to-kJ conversion.
for(const [table,key] of [['energy','energyKcal'],['sugars','sugars'],['saturatedFat','saturatedFat'],['salt','salt'],['fibre','fibre'],['protein','protein']]){
  core.TABLES[table].forEach((threshold,index)=>{
    for(const delta of [0,.00001]){
      const values={...fields,carbohydrate:100,fat:100,[key]:key==='energyKcal'?(threshold+delta)/4.184:threshold+delta};
      const actual=score.calculateDetailed(meal(component('threshold',100,values,false)));
      assert.equal(actual.available,true,`${key} threshold should be supported`);
      const part=[...actual.components.negative,...actual.components.positive].find(p=>p.id===table);
      assert.equal(part.points,index+(delta?1:0),`${key}: ${threshold}+${delta}`);
    }
  });
}
const highNegative=score.calculateDetailed(meal(component('high negative',100,{...fields,salt:2.21,protein:18},false)));
assert.equal(highNegative.negativePoints,11);assert.equal(highNegative.countProteins,false);assert.equal(highNegative.positivePoints,1);
const justBelow=score.calculateDetailed(meal(component('below gate',100,{...fields,salt:2.2,protein:18},false)));
assert.equal(justBelow.countProteins,true);assert.equal(justBelow.positivePoints,8);
const withSalt=score.calculateDetailed(meal(component('saltier',100,{...fields,salt:1},true)));
assert.ok(withSalt.value<=first.value,'Additional salt cannot improve the grade; within-grade changes retain the same fixed value');
const low=score.calculateDetailed(meal(component('low',100,{energyKcal:1000,protein:0,carbohydrate:100,sugars:100,fat:100,saturatedFat:100,fibre:0,salt:100},false)));assert.equal(low.value,0);
const high=score.calculateDetailed(meal(component('high',100,{...fields,protein:20,fibre:10},true)));assert.equal(high.value,100);
// Point-table sharing is deliberate, but the packaged calculator still rejects
// meal inputs and this adapter never obtains frequency labels from that code.
assert.equal(core.calculateScore({type:'meal',nutrients:{}}).status,'unrated');
console.log('Passed: estimated meal source gating, six nutrient unknowns, FVL bounds/exclusions, all general-profile boundaries, protein gate, portion invariance, monotonic salt, clipping and unchanged product scope.');

// v0.2 makes fibre/protein essential; no provisional positive-nutrient ranges.
for(const key of ['fibre','protein']) {
  const sparse=clone(baseline);sparse.components[0].sourceRecord.nutrients[key]={value:null,status:'unknown',unit:'g'};
  const before=JSON.stringify(sparse),result=score.calculateDetailed(sparse);
  assert.equal(result.available,false);assert.equal(result.value,null);assert.ok(result.missingInputs.includes(key));
  assert.equal(JSON.stringify(sparse),before);
  for(const factor of [.25,2]){const scaled=clone(sparse);scaled.components.forEach(c=>c.amountGrams*=factor);assert.equal(score.calculateDetailed(scaled).available,false);}
  for(const status of ['estimated','extracted','conflict']){const bad=clone(sparse);bad.components[0].sourceRecord.nutrients[key].status=status;assert.equal(score.calculateDetailed(bad).available,false);}
}
const excludedProtein=meal(component('high',100,{...fields,salt:2.21},false));excludedProtein.components[0].sourceRecord.nutrients.protein={value:null,status:'unknown',unit:'g'};
assert.equal(score.calculateDetailed(excludedProtein).available,false,'Essential inputs remain required even where protein points would be excluded');
assert.equal(score.validResult(first),true);assert.equal(score.validResult(partial),true);
for(const methodVersion of ['nudge_meal_v0_1','nudge_meal_v0_2','nudge_meal_v0_3','nudge_meal_v0_4'])assert.equal(score.validResult({...first,methodVersion,methodId:methodVersion}),true);
for(const bad of [{...first,value:101},{...first,value:2.5},{...first,methodVersion:'nudge_meal_v99'},{...partial,value:partial.value-1},{...first,grade:'C'},{...first,status:'made_up'}])assert.equal(score.validResult(bad),false);
assert.equal(score.calculateDetailed({name:'salad',qualityEstimate:{wholePlants:'high'}}).available,false,'Qualitative observations do not become a detailed nutrient score');
assert.equal(score.calculate({name:'salad'}).status,'estimated_rough');
assert.deepEqual(score.calculate(baseline),score.calculateDetailed(baseline),'A complete source score has priority over a rough estimate');
const noCategory=clone(baseline);delete noCategory.components[0].sourceRecord.foodGroup;assert.equal(score.calculateDetailed(noCategory).available,false);
const yieldMeal=clone(baseline);yieldMeal.recipeYield={grams:200,verified:true,source:'Reviewed recipe yield'};
const yielded=score.calculateDetailed(yieldMeal);assert.equal(yielded.inputs.portionGrams,200);assert.equal(yielded.inputs.protein,3*250/200);assert.equal(yielded.inputs.fvlPercent,null);
assert.equal(score.calculateDetailed({...baseline,recipeYield:{grams:200}}).available,false);
assert.equal(score.calculateDetailed({...baseline,recipeYield:{grams:250,verified:true}}).available,false,'Matching component total does not establish yield provenance');
assert.equal(score.calculateDetailed({...baseline,recipeYield:{grams:250,verified:true,source:'   '}}).available,false);
console.log('Passed v0.2 meal: source/yield aggregation, essential missing fields, provisional FVL, legacy read-only validity, distinct rough fallback and unsupported detailed-profile guards.');
