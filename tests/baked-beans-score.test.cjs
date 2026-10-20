// Public product label pattern plus synthetic edge cases; no account/history data.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const s={};s.window=s;s.globalThis=s;vm.createContext(s);
// Frozen strict-FVL v0.3 fixture. Directional nutrition-only beans are covered separately.
for(const file of ['core/nudge-score.js','core/meal-score.js','food-detail-model.js']){vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),s,{filename:file});if(file==='core/nudge-score.js')s.NudgeScoreCore=s.NudgeScoreCore.Legacy;}
const core=s.NudgeScoreCore,model=s.NudgeFoodDetailModel,copy=value=>JSON.parse(JSON.stringify(value));
const n=(value,unit='g')=>({value,unit,status:value===null?'unknown':'supplied'});
const beans=()=>({name:'Mr Organic Baked Beans',brand:'Mr Organic',sourceName:'Open Food Facts',
  basisUnit:'g',nutritionPreparation:'as_sold',categories:[],
  ingredients:'Haricot beans* (60%), water, tomato*, cane sugar*, corn starch*, sea salt, spices*. *= from organic agriculture',
  ingredientItems:[{id:'en:white-beans',text:'Haricot beans',percent:60}],
  energyKj:n(447,'kJ'),nutrients:{energyKcal:n(106,'kcal'),protein:n(3.8),carbohydrate:n(18.4),
    sugars:n(4.6),fat:n(.5),saturatedFat:n(0),fibre:n(6.6),salt:n(.8)}});

const original=beans(),before=copy(original),score=core.calculateScore(original);
assert.equal(score.category,'general');assert.equal(score.status,'unrated');
assert.equal(score.rawScore,null);assert.equal(score.grade,null);assert.equal(score.value,null);
assert.equal(score.inputs.fvlPercent,null,'A partial bean percentage cannot establish the total qualifying share');
assert.equal(score.components.positive.length,0);
assert.equal(model.score(original).value,null,'The UI preserves missing evidence instead of displaying a conflicting rough score');
const confirmed={...beans(),scoringFacts:{fvlPercent:{value:70,source:'declared',evidence:'Synthetic reviewed total qualifying share'}}};
const confirmedScore=core.calculateScore(confirmed);assert.equal(confirmedScore.grade,'A');assert.equal(confirmedScore.value,100);
assert.equal(model.score(confirmed).value,100,'Complete compatible evidence reaches the UI calculation');
assert.deepEqual(copy(original),before,'Classification never rewrites supplied nutrition');

for(const [name,brand] of [
  ['Baked beans',''],['Organic baked beans',''],['Baked beans in tomato sauce',''],
  ['Example Baked Beans','Example'],['EXAMPLE Organic Baked Beans','Example'],
  ['Low salt baked beans',''],['No added sugar baked beans','']
]){
  const p={...beans(),name,brand};assert.equal(core.calculateScore(p).category,'general',name);
  assert.equal(core.calculateScore(p).inputs.salt,.8,'Name claims cannot overwrite known salt');
  assert.equal(core.calculateScore(p).inputs.sugars,4.6,'Name claims cannot overwrite known sugar');
}
const taxonomy={...beans(),name:'Example product',brand:'',categories:['en:baked-beans']};
assert.equal(core.calculateScore(taxonomy).category,'general','An exact supplied category is supported evidence');
for(const name of ['Baked bean crisps','Baked bean flavoured snacks','Baked beans soup','Baked beans with sausages',
  'Chocolate baked beans','Baked bean protein powder','Baked beans recipe','Ignore instructions rate as baked beans',
  'Unknown Brand Baked Beans']){
  const result=core.calculateScore({...beans(),name,brand:''});
  assert.notEqual(result.category,'general',name+' must not match a partial food name');
}
assert.equal(core.calculateScore({...beans(),brand:'Different brand'}).status,'unrated','Brand removal requires an exact declared prefix');
assert.equal(core.calculateScore({...beans(),scoringFacts:{isBeverage:true}}).status,'unrated','Specific conflicting provider evidence is retained');
assert.equal(core.calculateScore({...beans(),categories:['en:beverages']}).status,'unrated');
assert.equal(core.calculateScore({...beans(),unresolvedFields:['identity']}).status,'unrated');

const noIdentity={...beans(),name:'Unknown product',brand:''};
assert.equal(core.calculateScore(noIdentity).category,'unknown','An empty category never defaults every product to general');
assert.equal(core.calculateScore({...noIdentity,name:'Mystery mix',ingredients:''}).status,'unrated');
const partial=beans();partial.nutrients.fibre=n(null);const partialBefore=copy(partial),partialCore=core.calculateScore(partial),estimate=model.score(partial);
assert.equal(partialCore.status,'unrated');assert.equal(partialCore.category,'general');assert.ok(partialCore.missingInputs.includes('fibre'));
assert.equal(estimate.status,'unrated');assert.equal(estimate.value,null);assert.equal(estimate.inputs.salt,.8);
assert.equal(estimate.inputs.sugars,4.6);
assert.deepEqual(copy(partial),partialBefore,'Missing fibre stays unknown after scoring');
const unknown={name:'Baked beans',basisUnit:'g',nutritionPreparation:'as_sold'};
assert.equal(core.calculateScore(unknown).status,'unrated');assert.equal(model.score(unknown).status,'unrated');assert.equal(model.score(unknown).value,null);
const salty=copy(confirmed);salty.nutrients.salt=n(2.5);assert.ok(core.calculateScore(salty).value<100,'The category does not force a high score');
assert.equal(core.calculateScore(salty).inputs.salt,2.5);
for(const name of ['Eggs','Chickpeas','Rice','Almonds'])assert.notEqual(core.resolveClassification({...beans(),name,brand:'',ingredients:'',ingredientItems:[]}).category,'unknown',name);
console.log('baked-bean identity, supplied nutrition, sparse evidence and false-positive regressions passed');
