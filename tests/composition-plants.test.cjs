// Source-backed plants must not depend on redundant model ingredient arrays or
// the unrelated FVL percentage used for nutrient scoring.
const assert=require('node:assert/strict');
const calc=require('../Web/core/food-composition.js');
const component=(id,evidence='Visible food',extra={})=>({recordId:id,sourceRecord:{id,basis:'per100g'},amountGrams:80,matchStatus:'matched',evidence,...extra});
const names=components=>calc.componentPlants(components).map(p=>p.name);
const salad=[component('13-513:936f5522b3cb','Visible browned cauliflower florets'),component('usda:168462','Visible spinach leaves'),component('usda:169134','Visible pomegranate seeds')];
const before=JSON.stringify(salad);assert.deepEqual(names(salad),['cauliflower','spinach','pomegranate']);assert.equal(JSON.stringify(salad),before);
assert.equal(calc.componentPlants(salad)[2].evidence,'Visible pomegranate seeds');
assert.deepEqual(names([component('usda:169757'),component('usda:169704'),component('usda:168928'),component('usda:168910'),component('usda:172475'),component('usda:172476')]),['rice','wheat','soybean']);
assert.deepEqual(names([component('usda:170108'),component('usda:170427'),component('13-521:3b11cafbaf89'),component('usda:168462')]),['capsicum','spinach']);
assert.deepEqual(calc.componentPlants([component('usda:170108'),component('usda:170427')])[0].componentRecordIds,['usda:170108','usda:170427']);
assert.deepEqual(names([component('usda:171413'),component('usda:175168'),component('18-323:unknown'),component('made-up-id','Visible spinach',{sourceRecord:{id:'made-up-id',basis:'per100g',fvlEligible:true,foodGroup:'vegetable',plantIdentity:'spinach'}})]),[],'Oils, fish and invented eligible metadata never add plants');
assert.deepEqual(names([component('usda:169757','Visible rice',{sourceRecord:{id:'usda:169757',basis:'per100g',fvlEligible:false}})]),['rice'],'Grain plants count despite FVL exclusion');
assert.deepEqual(names([component('usda:169134','',{amountSource:'confirmed'})]),[],'Confirmed grams cannot invent missing food evidence');
assert.deepEqual(names([component('usda:169134','',{matchStatus:'confirmed'})]),['pomegranate'],'Explicit selected food source can identify a plant');
assert.deepEqual(names([component('usda:169134','  ')]),[]);
assert.deepEqual(names([component('usda:169134','Visible seeds',{recordId:'usda:170108'})]),[]);
assert.deepEqual(names([component('usda:169134','Visible seeds',{sourceRecord:{id:'usda:169134',basis:'perPortion'}})]),[]);
assert.deepEqual(names([component('usda:169134','Visible seeds',{selected:false}),component('usda:168462','Visible spinach',{amountGrams:0})]),[]);
assert.deepEqual(names([component('usda:169134','Visible seeds',{amountGrams:null})]),['pomegranate'],'Plant identity can be known while amount remains unknown');
for(const [alias,canonical] of [['red pepper','capsicum'],['green bell peppers','capsicum'],['white rice','rice'],['brown rice','rice'],['wholewheat pasta','wheat'],['tofu','soybean'],['spring onions','onion'],['broccolini','broccoli'],['pomegranate seeds','pomegranate']])assert.equal(calc.canonicalPlantName(alias),canonical);
assert.equal(calc.canonicalPlantName('banana'),'banana','Other named plants remain available to the existing validator');
(async()=>{
 const {compositionRecord,resolveMealComponents,reconcileMealPlants}=await import('../Backend/src/composition.js');
 assert.equal(compositionRecord('usda:169134').plantIdentity,'pomegranate');assert.equal(compositionRecord('usda:171413').plantIdentity,null);
 const result=resolveMealComponents([{name:'roasted cauliflower florets',preparation:'roasted',amountGrams:130,evidence:'Roasted florets visible'},{name:'fresh spinach leaves',preparation:'raw',amountGrams:60,evidence:'Spinach visible'},{name:'pomegranate seeds',preparation:'raw',amountGrams:20,evidence:'Pomegranate seeds visible'}],{estimatedServing:true});
 assert.deepEqual(names(result.components),['cauliflower','spinach','pomegranate']);
 for(const c of result.components)assert.equal(c.sourceRecord.plantIdentity,calc.plantIdentity(c.recordId));
 const originalIngredients=[{name:'cauliflower',evidence:'Roasted florets visible'},{name:'spinach',evidence:'Spinach visible'}];
 const originalPlants=structuredClone(originalIngredients),unchanged=JSON.stringify([originalIngredients,originalPlants]);
 const reconciled=reconcileMealPlants(result.components,originalIngredients,originalPlants);
 assert.deepEqual(reconciled.plants.map(p=>p.name),['cauliflower','spinach','pomegranate']);
 assert.equal(reconciled.ingredients.at(-1).name,'pomegranate');assert.equal(reconciled.ingredients.at(-1).evidence,'Pomegranate seeds visible');
 assert.equal(JSON.stringify([originalIngredients,originalPlants]),unchanged,'Normalizing a result cannot mutate input or prior evidence');
 const alias=reconcileMealPlants([component('13-502:1c50fd61ac12')],[{name:'broccolini',evidence:'Broccolini visible'}],[{name:'broccolini',evidence:'Broccolini visible'}]);
 assert.deepEqual(alias.plants.map(p=>p.name),['broccoli']);assert.equal(alias.ingredients.length,1);
 console.log('Passed: selected-record plant reconciliation, actual salad shape, aliases/deduplication, independent grain and FVL treatment, oil exclusion, missing/mismatched evidence, source metadata and input immutability.');
})().catch(error=>{console.error(error);process.exitCode=1;});
