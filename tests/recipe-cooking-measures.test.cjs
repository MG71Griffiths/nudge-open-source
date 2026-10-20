const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const root=process.env.RECIPE_MEASURES_ROOT||path.resolve(__dirname,'..'),scope={console};scope.window=scope;vm.createContext(scope);
for(const file of ['core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js']){
  const source=file==='core/recipe-composition.js'&&process.env.RECIPE_MEASURES_CANDIDATE?process.env.RECIPE_MEASURES_CANDIDATE:path.join(root,'Web',file);
  vm.runInContext(fs.readFileSync(source,'utf8'),scope,{filename:file});
}
const R=scope.NudgeRecipeComposition,copy=v=>JSON.parse(JSON.stringify(v));
const row=(name,amount,unit,extra={})=>({name,amount,unit,preparation:'raw',evidence:amount+' '+unit+' '+name,...extra});
const measure=(name,amount,unit,extra)=>R.householdMeasure(row(name,amount,unit,extra));

test('coconut volume uses the sourced canned-food cup weight and keeps missing nutrients unknown',()=>{
  const result=measure('coconut milk',400,'ml');
  assert.ok(Math.abs(result.amountGrams-400*226/(8*29.573))<1e-9);
  assert.notEqual(result.amountGrams,400);
  assert.equal(result.sourceRecord.id,'usda:170173');assert.equal(result.sourceRecord.nutrients.energyKcal.value,197);
  assert.equal(result.sourceRecord.nutrients.fibre.value,null);assert.equal(result.sourceRecord.nutrients.sugars.value,null);
  assert.equal(result.conversion.sourcePortionId,'86171');assert.equal(result.conversion.sourceSHA256,'b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0');
  assert.ok(result.assumptions.some(text=>text.includes('canned')&&text.includes('brand')));
  assert.equal(measure('canned coconut milk',2,'tbsp').amountGrams,30);
  for(const name of ['light coconut milk','reduced fat coconut milk','coconut milk drink','coconut cream','frozen coconut milk'])assert.equal(measure(name,400,'ml'),null,name);
  assert.equal(measure('coconut milk',400,'ml',{evidence:'400ml coconut milk drink'}),null);
});
test('a whole red pepper uses a disclosed edible-weight estimate, including explicit sizes',()=>{
  const result=measure('red bell pepper',1,'count');assert.equal(result.amountGrams,119);assert.equal(result.conversion.sourcePortionId,'86066');
  assert.ok(result.assumptions.some(text=>text.includes('unspecified')));
  assert.equal(measure('small red bell pepper',2,'count').amountGrams,148);
  assert.equal(measure('large red pepper',1,'count').amountGrams,164);
  assert.equal(measure('red bell pepper',90,'g').amountGrams,90);
  assert.equal(measure('red bell pepper',100,'ml'),null);
  assert.equal(measure('red bell pepper',1,'count',{preparation:'pickled'}),null);
});
test('oil and sweetener spoons use distinct whole-food sources and preserve teaspoon scaling',()=>{
  for(const [name,grams,id] of [['olive oil',13.5,'usda:171413'],['rapeseed oil',14,'usda:172336'],['canola oil',14,'usda:172336'],['vegetable oil',13.6,'usda:172370'],['honey',21,'usda:169640'],['sugar',12.6,'usda:169655']]){
    const result=measure(name,3,'tbsp');assert.ok(Math.abs(result.amountGrams-3*grams)<1e-9,name);assert.equal(result.sourceRecord.id,id);
    assert.ok(Math.abs(measure(name,3,'tsp').amountGrams-grams)<1e-9,name);assert.equal(result.conversion.nutrientSourceId,id);
  }
  assert.ok(measure('vegetable oil',1,'tbsp').assumptions.some(text=>text.includes('actual oil type')&&text.includes('soybean')));
  for(const name of ['palm sugar','brown sugar','icing sugar','coconut sugar','oil spray','olive oil dressing'])assert.equal(measure(name,1,'tbsp'),null,name);
});
test('green chillies use their own raw source with only explicit grams, never a pepper count',()=>{
  const result=measure('green chillies',30,'g');assert.equal(result.amountGrams,30);assert.equal(result.sourceRecord.id,'usda:170497');
  assert.equal(result.sourceRecord.nutrients.protein.value,2);
  assert.equal(measure('green chilli',6,'count'),null);assert.equal(measure('green chilli sauce',30,'g'),null);
  assert.equal(measure('green chillies',30,'g',{preparation:'cooked'}),null);
});
test('printed alternatives are never silently treated as independently selected ingredients',()=>{
  for(const [name,amount,unit,evidence] of [['olive oil',3,'tbsp','3 tbs rapeseed/vegetable/olive oil'],['honey',1,'tbsp','1 tbs honey (or palm sugar, sugar)'],['coconut milk',400,'ml','400 ml coconut milk or cream'],['green chillies',30,'g','30 g green chillies or red peppers']])assert.equal(measure(name,amount,unit,{evidence}),null);
});
test('a validated choice marker enables only its exact selected identity without rewriting its quote',()=>{
  const input=row('olive oil',3,'tbsp',{evidence:'3 tbs rapeseed/vegetable/olive oil',recipeChoiceSelection:{choiceId:'synthetic-oil',optionId:'olive',evidence:'User selected olive oil'}}),before=JSON.stringify(input);
  assert.equal(R.householdMeasure(input).amountGrams,40.5);assert.equal(JSON.stringify(input),before);
  for(const marker of [{choiceId:'synthetic-oil',optionId:'olive',evidence:'User selected honey'},{choiceId:'synthetic-oil',evidence:'User selected olive oil'}])assert.equal(R.householdMeasure({...input,recipeChoiceSelection:marker}),null);
});
test('confirmed or edited recipe snapshots remain unchanged by household recovery',()=>{
  const original=[{name:'synthetic curry',amountGrams:null,recordId:null,sourceRecord:null,nutrients:{}}];
  const ingredient=row('red bell pepper',1,'count');
  const meal=R.apply({name:'Synthetic recipe',components:original,recipeCalculation:{version:R.VERSION,servings:4,componentIndexes:[0],batchComponents:[{name:ingredient.name,recipeIngredient:ingredient,amountGrams:null,recordId:null,sourceRecord:null,nutrients:{}}]}},4,{source:'recipe',portionFraction:.25});
  const before=JSON.stringify(meal),next=R.recover(meal);assert.equal(next.components[0].amountGrams,29.75);assert.equal(JSON.stringify(meal),before);
  assert.deepEqual(copy(R.recover(meal,{confirmed:true})),copy(meal));assert.deepEqual(copy(R.recover(meal,{userEdited:true})),copy(meal));
});
test('only recovered raw shallot quantities use one complete compatible source while retaining prior provenance',()=>{
  const exact=scope.NudgeMealRecovery.record('usda:170499'),pepper=scope.NudgeMealRecovery.record('usda:170108');
  const prior={...copy(exact),id:'synthetic:prior-shallot',source:'Synthetic available-carbohydrate fixture',carbohydrateDefinition:'available',nutrients:{...copy(exact.nutrients),carbohydrate:{...copy(exact.nutrients.carbohydrate),value:3}}};
  const component=(source,name)=>({name,preparation:'raw',amountGrams:100,recordId:source.id,sourceRecord:source,nutrients:source.nutrients});
  const mixed=scope.NudgeComposition.total([component(prior,'shallots'),component(pepper,'red bell pepper')]);
  assert.equal(mixed.carbohydrate.value,null);assert.equal(mixed.carbohydrate.knownSubtotal,3,'Different carbohydrate definitions cannot be silently summed');
  const sentinel='Recipe ingredient could not be linked to the printed text.';
  const ingredients=['shallots','red bell pepper'].map(name=>row(name,null,null,{evidence:sentinel}));
  const batch=ingredients.map((ingredient,i)=>({...component(i===0?prior:pepper,ingredient.name),amountGrams:null,recipeIngredient:ingredient}));
  const meal=R.apply({name:'Synthetic recipe',components:[{name:'recipe',amountGrams:null,nutrients:{}}],recipeEvidence:{text:'Shopping list\n100g shallots\n100g red bell pepper'},recipeCalculation:{version:R.VERSION,servings:4,componentIndexes:[0],batchComponents:batch}},4,{source:'recipe',portionFraction:.25});
  const before=JSON.stringify(meal),next=R.recover(meal),recovered=next.recipeCalculation.batchComponents[0];
  assert.equal(recovered.recordId,exact.id);assert.deepEqual(copy(recovered.sourceRecord),copy(exact));assert.deepEqual(copy(recovered.nutrients),copy(exact.nutrients),'Use the entire source, never nutrient splicing');
  assert.deepEqual(copy(recovered.recipeSourceRecovery.original),{recordId:prior.id,sourceRecord:prior,nutrients:prior.nutrients});
  assert.equal(recovered.recipeEvidenceRecovery.original.evidence,sentinel);assert.equal(recovered.recipeIngredient.evidence,'100g shallots');
  assert.equal(next.nutrients.carbohydrate.value,(exact.nutrients.carbohydrate.value+pepper.nutrients.carbohydrate.value)/4);
  assert.equal(next.recipeCalculation.selectedFraction,.25);assert.equal(JSON.stringify(meal),before);
  assert.equal(R.recover(meal,{confirmed:true}),meal);assert.equal(R.recover(meal,{userEdited:true}),meal);
  for(const extra of [{},{recipeTextRecovered:true,preparation:'cooked'},{recipeTextRecovered:true,preparation:'pickled'}])assert.equal(measure('shallots',100,'g',extra),null);
  const alreadyKnown=copy(meal);alreadyKnown.recipeCalculation.batchComponents[0]={...batch[0],amountGrams:100};
  assert.equal(R.recover(alreadyKnown).recipeCalculation.batchComponents[0].recordId,prior.id,'An existing sourced quantity is not rewritten');
});
