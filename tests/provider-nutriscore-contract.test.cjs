const {test}=require('node:test');
const assert=require('node:assert/strict');
// Historical v0.3 provider-adoption contract remains frozen after promotion.
const Core=require('../Web/core/nudge-score.js').Legacy;
globalThis.NudgeScoreCore=Core;
const Meal=require('../Web/core/meal-score.js');
const copy=x=>structuredClone(x);
const n=(value,unit='g',extra={})=>({value,unit,status:value===null?'unknown':'supplied',...extra});
function tomato(){
  return {name:'Finely chopped tomatoes',brand:'Fixture',barcode:'8005110170348',sourceName:'Open Food Facts',
    sourceURL:'https://world.openfoodfacts.org/product/8005110170348',basisUnit:'g',nutritionPreparation:'as_sold',
    ingredients:'Tomato 99.8%, salt.',categories:['en:vegetables'],ingredientItems:[{id:'en:tomato',text:'Tomato',percent:99.8},{id:'en:salt',text:'salt'}],
    scoringFacts:{isBeverage:false,isCheese:false,isWater:false,isFatOilNutsSeeds:false,isRedMeatProduct:false},
    energyKj:n(110,'kJ'),nutrients:{energyKcal:n(26,'kcal'),protein:n(1.2),carbohydrate:n(3.9),sugars:n(2.8),fat:n(.2),saturatedFat:n(.1),fibre:n(1.2),salt:n(.3)}};
}
function bind(p,estimated=false){
  const part=(id,value,unit,points,pointsMax)=>({id,value,unit,points,pointsMax});
  p.providerNutriScore={source:'Open Food Facts',version:'2023',barcode:p.barcode,sourceURL:p.sourceURL,
    computed:true,applicable:true,categoryAvailable:true,nutrientsAvailable:true,preparation:p.nutritionPreparation,estimated,
    category:'general',grade:'a',rawScore:-4,negativePoints:1,positivePoints:5,countProteins:true,
    components:{negative:[part('energy',110,'kJ',0,10),part('sugars',2.8,'g',0,15),part('saturated_fat',.1,'g',0,10),part('salt',.3,'g',1,20)],
      positive:[part('proteins',1.2,'g',0,7),part('fiber',1.2,'g',0,5),part('fruits_vegetables_legumes',99.8,'%',5,5)]},
    factsFingerprint:Core.providerFactsFingerprint(p)};
  return p;
}
test('validated versioned OFF result keeps source, uncertainty and an explicit display conversion',()=>{
  const p=bind(tomato(),true),before=JSON.stringify(p),score=Core.calculateScore(p);
  assert.equal(score.methodId,'nudge_nutrition_v0_3');assert.equal(score.version,'0.3');
  assert.equal(score.value,100);assert.equal(score.grade,'A');assert.equal(score.rawScore,-4);
  assert.equal(score.status,'estimated');assert.equal(score.provider.estimated,true);
  assert.equal(score.provider.sourceURL,p.sourceURL);assert.equal(score.scoreBasis,'provider_nutriscore_2023');
  assert.match(score.explanation,/A100\/B75\/C50\/D25\/E0/);assert.match(score.explanation,/not an official percentage/);
  assert.equal(score.baseFrequency,null);assert.equal(score.finalFrequency,null);assert.equal(Core.validResult(score),true);
  assert.equal(JSON.stringify(p),before);
});
test('a letter alone and unvalidated, contradictory or tampered provider envelopes are rejected',()=>{
  assert.equal(Core.providerScore({...tomato(),nutriScoreGrade:'A'}),null);
  const edits=[
    p=>p.providerNutriScore.source='Other',p=>p.sourceName='User supplied',p=>p.providerNutriScore.version='2021',
    p=>p.providerNutriScore.computed=false,p=>p.providerNutriScore.applicable=false,p=>p.providerNutriScore.categoryAvailable=false,
    p=>p.providerNutriScore.nutrientsAvailable=false,p=>delete p.providerNutriScore.estimated,
    p=>p.providerNutriScore.barcode='12345678',p=>p.providerNutriScore.sourceURL='https://example.com/product',
    p=>p.providerNutriScore.preparation='prepared',p=>p.providerNutriScore.category='beverage',p=>p.providerNutriScore.grade='D',
    p=>p.providerNutriScore.rawScore=-3.5,p=>p.providerNutriScore.positivePoints=4,p=>p.providerNutriScore.countProteins=false,
    p=>p.providerNutriScore.components.positive.push(copy(p.providerNutriScore.components.positive[0])),
    p=>p.providerNutriScore.components.negative[0].unit='kcal',p=>p.providerNutriScore.components.negative[0].points=99,
    p=>p.providerNutriScore.factsFingerprint='forged',p=>p.nutrients.sugars.value=20,
    p=>p.ingredients='Tomato, sugar',p=>p.name='Tomato sweets',p=>p.unresolvedFields=['nutrition']
  ];
  for(const edit of edits){const p=bind(tomato());edit(p);assert.equal(Core.providerScore(p),null,String(edit));}
});
test('provider binding survives equivalent native/browser shapes and image or timestamp changes',()=>{
  const p=bind(tomato()),q=copy(p);
  q.imageURL='https://example.com/picture';q.retrievedAt='later';q.categoriesTags=q.categories;delete q.categories;
  q.ingredientsNeedsReview=null;q.categoryTag='';q.nutrientSources={protein:'packaging'};
  q.ingredientItems=q.ingredientItems.map(x=>({id:x.id||'',text:x.text||'',percent:x.percent??null}));
  q.scoringFacts={...q.scoringFacts,hasNonNutritiveSweeteners:null,fvlPercent:null,source:'different provenance wording'};
  assert.equal(Core.providerFactsFingerprint(p),Core.providerFactsFingerprint(q));assert.equal(Core.providerScore(q).value,100);
});
test('provider preparation must match the actual source nutrition basis',()=>{
  const p=tomato();p.nutritionPreparation='prepared';bind(p);
  assert.equal(Core.providerScore(p).calculationBasis.preparation,'prepared');
  p.nutritionPreparation='as_sold';assert.equal(Core.providerScore(p),null);
});
test('declared tomato percentage repairs a local calculation without changing nutrition',()=>{
  const p=tomato(),before=JSON.stringify(p),score=Core.calculateScore(p);
  assert.equal(score.value,100);assert.equal(score.rawScore,-4);assert.equal(score.inputs.fvlPercent,99.8);
  assert.equal(score.components.positive.find(x=>x.id==='fvl').points,5);
  assert.equal(JSON.stringify(p),before);
});
test('whole single-ingredient pulses and dates qualify; ambiguous mixtures and review conflicts do not',()=>{
  for(const ingredients of ['Red split lentils','Medjool dates','Chickpeas (100%)']){
    assert.equal(Core.declaredFvlIngredients({...tomato(),ingredients}).lower,100);
  }
  for(const ingredients of ['Tomato soup','Lentils, mystery sauce','Dates 120%, salt','Tomato (sauce), salt','Dates, chocolate','Tomato 0%','Tomato 20%','Dried dates 30%, sugar']){
    assert.equal(Core.declaredFvlIngredients({...tomato(),ingredients}),null,ingredients);
  }
  assert.equal(Core.declaredFvlIngredients({...tomato(),ingredientsNeedsReview:true}),null);
  assert.equal(Core.declaredFvlIngredients({...tomato(),unresolvedFields:['ingredients']}),null);
});
test('missing qualifying ingredients remain unscored instead of losing all plant points',()=>{
  const p=tomato();p.ingredients=null;p.ingredientItems=[];
  const score=Core.calculateScore(p);assert.equal(score.available,false);assert.equal(score.value,null);
  assert.ok(score.missingInputs.includes('fruit, vegetable and legume percentage'));
  assert.equal(Meal.calculateProductEstimate(p),null);
});
test('lentils with missing saturated fat use a total-fat bound without inventing nutrient quantities',()=>{
  const p={...tomato(),name:'Red split lentils',ingredients:'Red lentils',categories:['en:lentils','en:seeds'],ingredientItems:[],
    scoringFacts:{isBeverage:false,isCheese:false,isWater:false,isFatOilNutsSeeds:true,isRedMeatProduct:false},nutrientSources:{}};
  const values={energyKcal:328.4,protein:27.7,carbohydrate:44.9,sugars:1.29,fat:.8,fibre:15.4,salt:.13};
  p.nutrients=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,n(v,k==='energyKcal'?'kcal':'g',{status:'estimated',relation:'~'})]));
  p.nutrients.saturatedFat=n(null);p.energyKj=n(1387,'kJ',{status:'estimated',relation:'~'});
  for(const k of Object.keys(values).concat('energyKj'))p.nutrientSources[k]='estimate';
  const before=JSON.stringify(p),score=Meal.calculateProductEstimate(p);
  assert.equal(score.value,100);assert.equal(score.status,'estimated');assert.equal(score.category,'general');
  const saturated=score.components.negative.find(x=>x.id==='saturatedFat');
  assert.equal(saturated.value,null);assert.equal(saturated.points,0);assert.equal(saturated.quantityIsExact,false);
  assert.equal(saturated.bound.value,.8);assert.equal(saturated.bound.relation,'lte');
  assert.equal(JSON.stringify(p),before);
  p.nutrients.fat.value=5;assert.equal(Meal.calculateProductEstimate(p),null,'A bound crossing point thresholds cannot yield an exact component');
});
test('old cached methods and rough product scores are not valid current results',()=>{
  const result=Core.calculateScore(bind(tomato()));
  assert.equal(Core.validResult({...result,methodId:'nudge_nutrition_v0_2',version:'0.2'}),false);
  assert.equal(Core.validResult({...result,status:'estimated_rough',value:55}),false);
  assert.equal(Core.validResult({...result,baseFrequency:'Daily'}),false);
  assert.equal(Core.validResult({...result,finalFrequency:'Monthly'}),false);
});

test('water provider results cannot bypass contradictory source nutrition',()=>{
  const p={...tomato(),name:'Mineral water',categories:['en:waters','en:beverages'],ingredients:'Water',ingredientItems:[],scoringFacts:{isWater:true,isBeverage:true},energyKj:n(null,'kJ'),nutrients:{}};
  bind(p);Object.assign(p.providerNutriScore,{category:'water',grade:'A',rawScore:0,negativePoints:0,positivePoints:0,countProteins:false,components:{negative:[],positive:[]}});
  p.providerNutriScore.factsFingerprint=Core.providerFactsFingerprint(p);
  assert.equal(Core.providerScore(p).value,100);
  p.nutrients.sugars=n(3);p.providerNutriScore.factsFingerprint=Core.providerFactsFingerprint(p);
  assert.equal(Core.providerScore(p),null);
});

test('current product results never infer frequency from portions or restrictions',()=>{
  const rated=Core.calculateScore(bind(tomato()));
  for(const salt of [null,0,2,4,10])for(const suitability of ['no_known_conflict','confirmed_conflict','unchecked']){
    const result=Core.withPortion(rated,salt,{suitability});
    assert.equal(result.frequencyPolicy,null);assert.equal(result.frequencyStatus,'not_provided');
    assert.equal(result.finalFrequency,null);assert.equal(result.personalSuitability,suitability);assert.equal(result.value,100);
  }
  assert.equal(Core.unratedScore('Missing facts').frequencyStatus,'not_provided');
});
test('strict packaged FVL does not change the existing provisional composition-meal contract',()=>{
  const p=tomato();delete p.ingredients;p.ingredientItems=[];
  assert.equal(Core.calculateScore(p).status,'unrated');
  const meal=Core.calculateScore({...p,sourceKind:'composition',nutritionPreparation:'as_consumed'},{category:'general',sweeteners:null});
  assert.equal(meal.status,'provisional');assert.equal(meal.inputs.fvlPercent,null);
  assert.ok(meal.missingInputs.includes('qualifying fruit, vegetable and legume percentage'));
});

test('browser scoreFacts preserves source bindings at the public adapter length limits',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),context={};context.window=context;vm.createContext(context);
  for(const file of ['core/nudge-score.js','food-detail-model.js']){vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../Web',file),'utf8'),context);if(file==='core/nudge-score.js')context.NudgeScoreCore=context.NudgeScoreCore.Legacy;}
  const p=tomato();p.name='Finely chopped tomatoes '+('fixture '.repeat(26)).trim();
  p.ingredients='Tomato 99.8%, '+('water, '.repeat(700))+'salt';
  p.ingredientItems=Array.from({length:160},(_,index)=>({id:'en:'+('a'.repeat(140))+index,text:'Tomato'}));
  bind(p);assert.equal(Core.providerScore(p).value,100);
  const projected=context.NudgeFoodDetailModel.scoreFacts(p);
  assert.equal(Core.providerFactsFingerprint(projected),Core.providerFactsFingerprint(p));
  assert.equal(context.NudgeFoodDetailModel.score(p).provider.source,'Open Food Facts');
  p.nutrients.salt.value=2;assert.notEqual(Core.providerFactsFingerprint(context.NudgeFoodDetailModel.scoreFacts(p)),p.providerNutriScore.factsFingerprint);
});
