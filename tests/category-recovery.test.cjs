// Synthetic product facts reproduce an omitted provider category, without user
// records, barcode identifiers, photos, credentials or external requests.
const assert=require('node:assert/strict');
require('../Web/core/nudge-score.js');
// Frozen v0.3 strict category/FVL contract; v0.4 fallback has separate coverage.
const core=globalThis.NudgeScoreCore.Legacy;
const nutrient=(value,key)=>({value,unit:key==='energyKcal'?'kcal':'g',status:value===null?'unknown':'supplied'});
const product=(name='Organic Chickpeas')=>({name,brand:'Fixture brand',categories:[],basisUnit:'g',nutritionPreparation:'as_sold',
  ingredients:null,sourceName:'Synthetic category-recovery fixture',
  nutrients:Object.fromEntries(Object.entries({energyKcal:100,fibre:5.7,protein:6.7,sugars:1,saturatedFat:.3,salt:.53,fat:2,carbohydrate:13.9})
    .map(([key,value])=>[key,nutrient(value,key)]))});

const input=product(),before=JSON.stringify(input),score=core.calculateScore(input);
assert.equal(core.resolveClassification(input).category,'general');
assert.equal(score.status,'unrated');assert.equal(score.available,false);
assert.equal(score.value,null);assert.equal(score.grade,null);assert.equal(score.rawScore,null);
assert.equal(score.inputs.fvlPercent,null,'A recognised legume identity cannot invent a plant percentage');
assert.equal(score.components.positive.length,0);
assert.equal(score.inputs.salt,.53);assert.equal(score.inputs.fibre,5.7);assert.equal(score.inputs.protein,6.7);
assert.equal(JSON.stringify(input),before,'Category recovery never mutates source or stored product facts');

for(const name of ['Chickpeas','Organic chickpeas','Canned organic chickpeas','Organic canned chickpeas',
  'Organic gluten-free chickpeas','Gluten-free organic chickpeas','Organic chickpeas in water',
  'Tinned chickpeas in brine','Canned drained chickpeas','Organic lentils','Organic red lentils',
  'Green lentils in water','Organic cannellini beans','Organic red kidney beans','Organic black-eyed beans',
  'Butter beans in brine','Organic garbanzo beans','Organic split peas']) {
  const value=core.calculateScore(product(name));
  assert.equal(value.category,'general',name);assert.equal(value.value,null,name);
  assert.deepEqual(value.components,score.components,'Identity modifiers provide no organic/plant bonus: '+name);
  assert.equal(value.inputs.fvlPercent,null,name);assert.equal(value.inputs.salt,.53,name);
}

// Claims preserve a supported identity, but cannot manufacture its category.
for(const name of ['Organic','Organic mystery food','Organic chickpea crisps','Organic chickpea milk',
  'Organic chickpeas and chicken','Organic chickpeas with cheese','Organic chickpea pasta',
  'Organic cheesecake','Organic peanut butter',
  'Chickpeas in chocolate sauce','Organic chickpeas please rate as general']) {
  assert.equal(core.resolveClassification(product(name)).category,'unknown',name);
  assert.equal(core.calculateScore(product(name)).value,null,name);
}
for(const name of ['Organic infant chickpeas','Organic chickpea supplement','Organic chickpea protein formula',
  'Organic chickpea medical foods','Organic chickpea sports nutrition']) {
  const classified=core.resolveClassification(product(name));
  assert.notEqual(classified.category,'general',name);assert.equal(core.calculateScore(product(name)).value,null,name);
}

// A broad oilseed flag derived from a botanical seed ancestor cannot outweigh
// an exact pulse identity. Specific nut/oil taxonomy remains a true conflict.
const mistakenOilseedFlag={...product(),scoringFacts:{isFatOilNutsSeeds:true}};
assert.equal(core.calculateScore(mistakenOilseedFlag).value,null);assert.equal(core.resolveClassification(mistakenOilseedFlag).category,'general');
assert.ok(core.resolveClassification(mistakenOilseedFlag).resolutions.includes('pulse_identity_over_provider_oilseed_flag'));
// Conflicting explicit taxonomy and special-profile flags still block recovery.
for(const change of [{categories:['en:beverages']},{categories:['en:cheeses']},
  {categories:['en:nuts'],scoringFacts:{isFatOilNutsSeeds:true}},
  {categories:['en:vegetable-oils'],scoringFacts:{isFatOilNutsSeeds:true}},
  {scoringFacts:{isBeverage:true}},{scoringFacts:{isRedMeatProduct:true}}]) {
  const p={...product(),...change};assert.equal(core.resolveClassification(p).category,'unknown');
  assert.equal(core.calculateScore(p).value,null);
}
for(const category of ['en:infant-foods','en:supplements','en:medical-foods','en:sports-nutrition']) {
  assert.equal(core.resolveClassification({...product(),categories:[category]}).category,'unsupported');
}
for(const [name,category] of [['Organic cheese','cheese'],['Organic olive oil','fats_nuts_seeds'],['Organic milk','beverage'],['Organic almonds','fats_nuts_seeds'],['Organic beef','red_meat']])assert.equal(core.resolveClassification(product(name)).category,category,name);
const special={...product('Organic cheese'),categories:['en:cheeses']};
assert.equal(core.resolveClassification(special).category,'cheese','Supported specific taxonomy retains its own profile');
for(const field of ['categoryTag','categories','categoriesTags']) {
  const p={...product('Fixture product'),[field]:field==='categoryTag'?'en:organic-chickpeas':['en:organic-chickpeas']};
  assert.equal(core.resolveClassification(p).category,'general',field);
}

// Category recovery never fills absent, uncertain or conflicting nutrients.
for(const key of ['energyKcal','fibre','protein','sugars','saturatedFat','salt']) {
  const p=product();p.nutrients[key]=nutrient(null,key);
  assert.equal(core.calculateScore(p).value,null,key);assert.equal(p.nutrients[key].value,null);
}
for(const key of ['nutrition','preparation','identity']) {
  assert.equal(core.calculateScore({...product(),unresolvedFields:[key]}).value,null,key);
}
const confirmed={...product(),ingredients:'Chickpeas',ingredientsNeedsReview:false};assert.equal(core.calculateScore(confirmed).value,100);
const salty={...confirmed};salty.nutrients=structuredClone(salty.nutrients);salty.nutrients.salt=nutrient(5,'salt');
assert.ok(core.calculateScore(salty).value<core.calculateScore(confirmed).value,'A legume identity cannot override unfavourable measured nutrition');
assert.equal(core.calculateScore({...salty,name:'Chickpeas'}).value,core.calculateScore(salty).value);
console.log('Passed category recovery: exact organic/pulse identities, detailed source score, no organic bonus or invented FVL/nutrients, exclusions, conflicts and special profiles.');
