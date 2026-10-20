import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RecipeComposition,MealScore,MealRecovery,Composition} from '../src/nutrition-core.js';
import {prepareRecipeCalculation,validateRecipeEvidence} from '../src/recipe-evidence.js';
const rows=()=>[
 ['pea protein powder',2,'tbsp','Pea protein powder x 2 tbs'],
 ['creatine powder',2,'tsp','Creatine powder x 2 tsp'],
 ['chia seed',1,'tbsp','Chia seed x 1 tablespoon'],
 ['3 seed mix',1,'tbsp','3 seed mix x 1 tablespoon'],
 ['flaxseed',1,'tbsp','Linwoods flaxseed, goji berry x 1 tablespoon'],
 ['goji berry',1,'tbsp','Linwoods flaxseed, goji berry x 1 tablespoon'],
 ['blueberries',2,'tbsp','Blueberries x 2 tablespoons'],
 ['mixed berries',2,'tbsp','Mixed berries x 2 tablespoons'],
 ['5 nut mix',2,'tbsp','5 nut mix x 2 tablespoons'],
 ['kefir',200,'ml','200 ml kefir'],['milk',100,'ml','100 ml milk']
].map(([name,amount,unit,evidence])=>({name,amount,unit,evidence,preparation:'unknown'}));
function input(){const ingredients=rows();return {name:'Blueberry smoothie with seeds, nuts, kefir and milk',basis:'perPortion',portionMode:'estimated_serving',compositionVersion:'synthetic-regression',ingredients:ingredients.map(r=>({name:r.name,evidence:r.evidence})),qualityEstimate:{wholePlants:'high',legumesNuts:'yes',wholeGrains:'unknown',refinedStarch:'no',sugaryFood:'no',frying:'no',proteinType:'plant',evidence:'A smoothie with berries, seeds, nuts, dairy and added pea protein.'},components:[{name:'smoothie',preparation:'blended',amountGrams:null,evidence:'Visible smoothie',photoIndex:1}],recipeEvidence:{photoIndex:1,text:ingredients.map(r=>r.evidence).join('\n'),servings:null,servingsEvidence:null,componentIndexes:[0],ingredients}};}
test('recipe spoon abbreviations and one blended ingredient retain one explicit quantity',()=>{
 const meal=input(),result=validateRecipeEvidence(meal.recipeEvidence,meal.components);
 assert.equal(result.ingredients[0].amount,2);assert.equal(result.ingredients[0].unit,'tbsp');
 assert.equal(result.ingredients.length,10);assert.equal(result.ingredients.filter(r=>r.evidence.includes('Linwoods')).length,1);
 assert.equal(result.ingredients.find(r=>r.evidence.includes('Linwoods')).amount,1);
 const separate=[{name:'carrot',amount:100,unit:'g',evidence:'100 g carrot and 100 g peas'},{name:'peas',amount:100,unit:'g',evidence:'100 g carrot and 100 g peas'}];assert.equal(RecipeComposition.normaliseRows(separate).length,2);
 for(const evidence of ['2–3 tbs pea protein powder','-2 tbs pea protein powder','between 2 and 3 tbs pea protein powder'])assert.equal(RecipeComposition.normaliseRows([{name:'pea protein powder',amount:null,unit:null,evidence}])[0].amount,null);
});
test('legacy tbs recovery never resurrects choices, percentages, packs or several amounts',()=>{
 for(const evidence of ['2 tbs olive/rapeseed oil','2 tbs olive oil or butter','2 tbs olive oil (50%)','2 x 3 tbs olive oil','2 × 3 tbs olive oil','2 tbs olive oil and 1 tbs butter','2 tbs olive oil; 1 egg']){
  const input=[{name:'olive oil',amount:null,unit:null,evidence}],before=JSON.stringify(input),result=RecipeComposition.normaliseRows(input)[0];
  assert.equal(result.amount,null,evidence);assert.equal(result.unit,null);assert.equal(JSON.stringify(input),before);
 }
 const valid=RecipeComposition.normaliseRows([{name:'pea protein powder',amount:null,unit:null,evidence:'Pea protein powder x 2 tbs'}])[0];
 assert.equal(valid.amount,2);assert.equal(valid.unit,'tbsp','The established unambiguous smoothie correction remains available');
});
test('smoothie recipe has traceable source contributions rather than milk-only nutrition',()=>{
 const meal=input(),before=JSON.stringify(meal),result=prepareRecipeCalculation(meal);assert.equal(JSON.stringify(meal),before);
 assert.equal(result.components.length,10);assert.equal(result.components.find(c=>c.name==='pea protein powder').amountGrams,15);
 assert.ok(Math.abs(result.nutrients.energyKcal.knownSubtotal-476.4783206387583)<1e-8);
 assert.ok(Math.abs(result.nutrients.protein.knownSubtotal-32.27471648040442)<1e-8);
 assert.ok(Math.abs(result.nutrients.fibre.knownSubtotal-9.704375)<1e-8);
 assert.equal(result.nutrients.protein.value,null,'Unverified creatine is retained as missing, never treated as dietary protein or silently dropped');
 assert.equal(result.nutrients.carbohydrate.value,null,'UK available carbohydrate and US total carbohydrate are not spliced together');
 assert.equal(result.components.find(c=>c.name==='creatine powder').recordId,null);
 for(const c of result.components.filter(c=>c.householdMeasure))assert.equal(c.sourceRecord.id,c.householdMeasure.nutrientSourceId);
 const score=MealScore.calculate(result);assert.equal(score.status,'estimated_rough');assert.equal(score.value,85);assert.equal(score.grade,null);assert.deepEqual(score.inputs.partialNutrition,{});
 assert.equal(MealScore.estimate({name:'Pea protein powder'}).available,false,'Standalone powders remain outside the meal estimate');
 const half=RecipeComposition.apply(result,null,{source:'user',portionFraction:.5});assert.equal(half.nutrients.protein.knownSubtotal,result.nutrients.protein.knownSubtotal/2);
});
test('reopening legacy unconfirmed recipe proposes fixes without rewriting confirmed or user-edited evidence',()=>{
 const prepared=prepareRecipeCalculation(input());
 const old=structuredClone(prepared);old.recipeCalculation.batchComponents=rows().map(row=>({name:row.name,preparation:'unknown',amountGrams:null,recordId:null,sourceRecord:null,nutrients:{},recipeIngredient:{...row,...(row.name==='pea protein powder'?{amount:null,unit:null}:{})},evidence:row.evidence,photoIndex:1}));
 // Keep the already matched milk as it was in the old analysis.
 old.recipeCalculation.batchComponents.at(-1).amountGrams=prepared.recipeCalculation.batchComponents.at(-1).amountGrams;
 Object.assign(old.recipeCalculation.batchComponents.at(-1),{recordId:prepared.components.at(-1).recordId,sourceRecord:prepared.components.at(-1).sourceRecord,nutrients:prepared.components.at(-1).nutrients});
 const before=JSON.stringify(old),repaired=RecipeComposition.recover(old);
 assert.equal(JSON.stringify(old),before);assert.equal(repaired.components.length,10);assert.ok(repaired.nutrients.protein.knownSubtotal>30);assert.equal(repaired.recipeCalculation.householdRecoveryVersion,RecipeComposition.HOUSEHOLD_VERSION);
 assert.equal(RecipeComposition.recover(old,{confirmed:true}),old);assert.equal(RecipeComposition.recover(old,{userEdited:true}),old);
 assert.equal(RecipeComposition.recover({...old,recipeCalculation:{...old.recipeCalculation,userEdited:true}}).recipeCalculation.userEdited,true);
 assert.deepEqual(RecipeComposition.recover(repaired),repaired,'Read-only recovery is idempotent');
});
test('plain pea-protein aliases retain a mixed-food rating while standalone supplements stay excluded',()=>{
 for(const name of ['pea protein','pea protein powder','pea protein isolate','pea protein isolate powder']){
  const meal=input(),old=meal.recipeEvidence.ingredients[0].evidence,evidence=`2 tbsp ${name}`;
  meal.recipeEvidence.ingredients[0]={...meal.recipeEvidence.ingredients[0],name,evidence};
  meal.recipeEvidence.text=meal.recipeEvidence.text.replace(old,evidence);meal.ingredients[0]={name,evidence};
  const result=prepareRecipeCalculation(meal),component=result.components.find(c=>c.name===name);
  assert.equal(component.sourceRecord.foodGroup,'sports_nutrition');
  assert.equal(MealScore.calculate(result).value,85,`${name} is one ingredient in the smoothie`);
  assert.equal(MealScore.estimate({name}).available,false,`${name} alone is outside the meal estimate`);
  assert.equal(MealScore.estimate({name,components:[component]}).available,false);
 }
});
test('household proxies reject specialised alternatives and source rows match bundled evidence',()=>{
 for(const row of [{name:'flavoured pea protein powder',unit:'tbsp'},{name:'chia seeds',preparation:'soaked',unit:'tbsp'},{name:'kefir',unit:'ml'}]){
  assert.equal(RecipeComposition.householdMeasure({...row,amount:1,evidence:''},row.name==='kefir'?'Coconut dairy free kefir':''),null);
 }
 const usda={ 'usda:170554':{energyKcal:486,protein:16.54,fibre:34.4},'usda:170562':{energyKcal:584,protein:20.78,fibre:8.6},'usda:170904':{energyKcal:43,protein:3.79,fibre:0}};
 for(const [id,values] of Object.entries(usda))for(const [key,value] of Object.entries(values))assert.equal(MealRecovery.record(id).nutrients[key].value,value);
 const whole=prepareRecipeCalculation(input());assert.deepEqual(whole.nutrients,Composition.total(whole.components));
});
