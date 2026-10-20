// Synthetic per-100 g fixtures exercising public label patterns. No owner data.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const s={};s.window=s;s.globalThis=s;vm.createContext(s);
for(const file of ['core/nudge-score.js','core/meal-score.js','food-detail-model.js'])vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),s,{filename:file});
const core=s.NudgeScoreCore,model=s.NudgeFoodDetailModel,copy=v=>JSON.parse(JSON.stringify(v));
const n=(value,unit='g',extra={})=>({value,unit,status:value===null?'unknown':'supplied',...extra});
const banana=()=>({name:'Fairtrade bananas',sourceName:'Open Food Facts',basisUnit:'g',nutritionPreparation:'as_sold',
  categories:['en:fruits','en:bananas','en:fruit-based-foods-and-beverages','en:plant-based-foods-and-beverages'],ingredients:'Bananas.',ingredientItems:[{id:'en:banana',text:'Bananas'}],
  energyKj:n(435,'kJ'),nutrients:{energyKcal:n(103,'kcal'),sugars:n(20.9),carbohydrate:n(23.2),protein:n(1.2),fibre:n(1.1),
    fat:n(.5,'g',{relation:'<'}),saturatedFat:n(.1,'g',{relation:'<'}),salt:n(.01,'g',{relation:'<'})}});

const p=banana(),before=copy(p),score=model.score(p);
assert.equal(score.status,'rated');assert.equal(score.value,75);assert.equal(score.rawScore,2);
assert.equal(score.negativePoints,7);assert.equal(score.positivePoints,5);
assert.equal(score.inputs.salt,null);assert.equal(score.inputs.saturatedFat,null);
assert.equal(score.inputs.fvlPercent,100);assert.equal(score.inputs.fvlSource,'supported-single-whole-fruit-identity');
assert.deepEqual(copy(p),before,'Scoring must not manufacture exact source quantities');
for(const key of ['salt','saturatedFat']){
  const part=score.components.find(c=>c.id===key);
  assert.equal(part.value,null);assert.equal(part.points,0);assert.equal(part.pointsLower,part.pointsUpper);
  assert.equal(part.missing,false);assert.equal(part.quantityIsExact,false);assert.equal(part.bound.relation,'lt');
  assert.equal(model.portionNutrients(p,model.createPortion(p))[key],null,'Scoring evidence cannot become diary nutrition');
}
assert.ok(score.reasonCodes.includes('point_invariant_nutrient_bounds'));
for(const relation of ['<','lt','<=','lte','≤']){
  const q=banana();q.nutrients.salt=n(.2,'g',{relation});q.nutrients.saturatedFat=n(1,'g',{relation});
  assert.equal(core.calculateScore(q).rawScore,2,relation+' stays within zero-point bins');
}
for(const [key,value] of [['salt',.201],['saturatedFat',1.001],['sugars',6.8],['protein',2.401],['fibre',3.001]]){
  const q=banana();q.nutrients[key]=n(value,'g',{relation:'<'});
  assert.equal((['protein','fibre'].includes(key)?core.Legacy:core).calculateScore(q).status,'unrated',key+' historical interval crosses component threshold');
}
for(const extra of [{value:null,status:'unknown'},{value:0,relation:'<'},{value:1,unit:'mg',relation:'<'},{value:.1,status:'estimated',relation:'<'},{value:0,relation:'~'}]){
  const q=banana();q.nutrients.salt={...n(.01),...extra};
  assert.equal(core.calculateScore(q).status,'unrated',JSON.stringify(extra));
}
const positive=banana();positive.nutrients.fibre=n(7.4,'g',{relation:'>'});
assert.equal(core.calculateScore(positive).components.positive.find(c=>c.id==='fibre').points,5);
positive.nutrients.fibre=n(7.4,'g',{relation:'>='});assert.equal(core.Legacy.calculateScore(positive).status,'unrated');
const impossible=banana();impossible.nutrients.protein=n(100,'g',{relation:'>'});assert.equal(core.calculateScore(impossible).status,'unrated');

for(const name of ['Banana','Bananas','Fresh banana','Organic Bananas','5 Fairtrade Bananas','Rainforest Alliance Bananas','Small ripe bananas']){
  const q={...banana(),name};assert.equal(core.calculateScore(q).value,75,name);
}
const branded={...banana(),name:'Example Organic Bananas',brand:'Example'};assert.equal(core.calculateScore(branded).value,75);
const exact=banana();exact.name='Banana';delete exact.ingredients;delete exact.ingredientItems;delete exact.energyKj;
Object.assign(exact.nutrients,{energyKcal:n(89,'kcal'),sugars:n(12),fat:n(.3),saturatedFat:n(.1),salt:n(.001),protein:n(1.1),fibre:n(2.6)});
assert.equal(core.calculateScore(exact).rawScore,-1);assert.equal(core.calculateScore(exact).value,100);
for(const fruit of ['Apples','Pears','Oranges','Strawberries','Avocados','Peach','Peaches']){
  const q={...banana(),name:fruit,ingredients:fruit,categories:['en:fruits'],ingredientItems:[]};
  assert.equal(core.calculateScore(q).inputs.fvlPercent,100,fruit);
}
for(const change of [
  {name:'Banana chips'},{name:'Banana milkshake'},{name:'Banana cake'},{name:'Dried bananas'},{name:'Banana powder'},
  {ingredients:'Bananas, sugar'},{ingredients:'Bananas (90%)'},{ingredients:'Banana puree'},{ingredientsNeedsReview:true},
  {ingredients:'Apples'},{categories:['en:bananas','en:dried-fruits']},{categories:['en:bananas','en:apples']},
  {ingredientItems:[{text:'Bananas'},{text:'Sugar'}]},{ingredientItems:[{text:'Bananas',percent:80}]},
  {scoringFacts:{isBeverage:true}},{unresolvedFields:['ingredients']},{unresolvedFields:['identity']}
])assert.equal(core.calculateScore({...banana(),...change}).inputs.fvlPercent,null,JSON.stringify(change));
const unknownIdentity={...banana(),name:'Fruit snack',ingredients:'Bananas.'};assert.equal(core.wholeFruitIdentity(unknownIdentity),null);
const missing=banana();delete missing.nutrients.salt;assert.equal(core.calculateScore(missing).status,'unrated');
assert.equal(missing.nutrients.salt,undefined);assert.equal(core.calculateScore(missing).inputs.salt,null);

const estimated=banana();estimated.name='Organic Bananas';
const values={energyKcal:90.5,carbohydrate:19.7,sugars:15.6,protein:1.06,fibre:2.7,fat:.25,saturatedFat:.005,salt:.0063};
estimated.nutrients=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,n(v,k==='energyKcal'?'kcal':'g',{status:'estimated',relation:'~'})]));
estimated.energyKj=n(383,'kJ',{status:'estimated',relation:'~'});
estimated.nutrientSources=Object.fromEntries([...Object.keys(values),'energyKj'].map(k=>[k,'estimate']));
const original=copy(estimated),estimate=model.score(estimated);
assert.equal(core.calculateScore(estimated).status,'unrated','Provider estimates are never verified label values');
assert.equal(estimate.status,'estimated');assert.equal(estimate.scoreBasis,'provider_nutrient_estimate');assert.equal(estimate.value,100);
assert.equal(estimate.inputs.estimatedInputs.salt.relation,'~');assert.equal(estimate.breakdownAvailable,true);
assert.deepEqual(copy(estimated),original);
const noProvenance=copy(estimated);delete noProvenance.nutrientSources.salt;
assert.equal(s.NudgeMealScore.calculateProductEstimate(noProvenance),null,'Approximate values need explicit source-estimate provenance');
const hybrid=copy(estimated);hybrid.nutrients.sugars=n(20.9);hybrid.nutrientSources.sugars='packaging';
assert.equal(s.NudgeMealScore.calculateProductEstimate(hybrid),null,'Conflicting known sugar and estimated carbohydrate cannot produce a detailed estimate');
hybrid.nutrients.carbohydrate=n(23.2);hybrid.nutrientSources.carbohydrate='packaging';
assert.equal(model.score(hybrid).value,75,'Known high sugar cannot be overwritten by generic/provider estimates');
assert.equal(model.score(hybrid).inputs.sugars,20.9);
const kcalWins=copy(estimated);kcalWins.nutrients.energyKcal=n(50,'kcal');kcalWins.nutrientSources.energyKcal='packaging';
assert.equal(model.score(kcalWins).inputs.energyKj,50*4.184,'Known kcal beats estimated kJ');

// The supported fruit deduction does not classify nuts/pulses/grains as fruit.
for(const name of ['Eggs','Chickpeas','Almonds','Rice'])assert.equal(core.wholeFruitIdentity({...banana(),name,ingredients:name,categories:[],ingredientItems:[]}),null,name);
console.log('whole-fruit score, bounded nutrients, estimated sources and processed-fruit regressions passed');
