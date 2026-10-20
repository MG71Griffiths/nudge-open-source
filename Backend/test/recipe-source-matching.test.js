import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/worker.js';
import {prepareRecipeCalculation} from '../src/recipe-evidence.js';

test('live-style recipe ingredient names retain raw, peeled and hard-boiled nutrient sources',()=>{
 const rows=[['butter','raw',75,'g','75 g butter'],['onion','raw, roughly chopped',1,'count','1 large onion, roughly chopped'],['plain flour','raw',50,'g','50 g plain flour'],
  ['milk','raw',570,'ml','570 ml milk'],['lemon juice','raw',2,'tbsp','2 tbsp lemon juice'],['fresh haddock','raw',350,'g','350 g fresh haddock, raw'],
  ['smoked haddock','raw',350,'g','350 g smoked haddock, uncooked'],['hard-boiled eggs','hard-boiled',4,'count','4 hard-boiled eggs'],['potatoes','raw, peeled',900,'g','900 g potatoes, peeled, raw weight'],
  ['butter','raw',50,'g','50 g butter'],['milk','hot',8,'tbsp','8 tbsp hot milk']].map(([name,preparation,amount,unit,evidence])=>({name,preparation,amount,unit,evidence}));
 const input={name:'Fish pie',portionMode:'estimated_serving',components:[{name:'fish pie',preparation:'cooked',amountGrams:400,evidence:'Visible fish pie',photoIndex:1}],ingredients:[],plants:[],
  recipeEvidence:{photoIndex:2,text:'Serves 4\n'+rows.map(r=>r.evidence).join('\n'),servings:4,servingsEvidence:'Serves 4',componentIndexes:[0],ingredients:rows}};
 const before=structuredClone(input),result=prepareRecipeCalculation(input),batch=result.recipeCalculation.batchComponents,nutrients=result.recipeCalculation.batchNutrients;
 assert.deepEqual(input,before);assert.equal(batch.length,11);assert.deepEqual(result.recipeCalculation.unsupportedAmounts,[]);
 for(const component of batch){assert.equal(component.recordId,component.sourceRecord.id);assert.ok(component.amountGrams>0);assert.ok(component.nutrients.energyKcal.value>0);assert.ok(component.nutrients.protein.value>0);assert.deepEqual(component.nutrients,component.sourceRecord.nutrients);}
 assert.equal(batch[5].recordId,'16-375:fcf21536084f');assert.match(batch[5].sourceRecord.name,/haddock, flesh only, raw/i);
 assert.equal(batch[7].recordId,'12-940:dbad4525e00a');assert.equal(batch[7].amountGrams,200);assert.match(batch[7].sourceRecord.name,/whole, boiled/i);
 assert.equal(batch[8].recordId,'13-489:214c339aadef');assert.equal(batch[8].amountGrams,900);
 assert.ok(Math.abs(nutrients.energyKcal.value-3183.591406181314)<1e-8);assert.ok(Math.abs(nutrients.protein.value-207.50898858756298)<1e-8);
 assert.ok(batch.every(c=>c.sourceRecord.carbohydrateDefinition==='available'));
 assert.equal(batch[7].nutrients.carbohydrate.status,'trace');assert.equal(batch[7].nutrients.carbohydrate.value,null);
 assert.equal(nutrients.carbohydrate.value,null);assert.ok(Math.abs(nutrients.carbohydrate.knownSubtotal-262.6498963243499)<1e-8);assert.equal(nutrients.carbohydrate.knownContributions,10);assert.equal(nutrients.carbohydrate.unknownContributions,1);
 assert.ok(Math.abs(batch[3].amountGrams-570*30.5/29.573)<1e-9);assert.equal(batch[10].amountGrams,120);assert.equal(batch[4].amountGrams,30.5);
 for(const i of [1,3,4,7,10]){const c=batch[i];assert.equal(c.sourceRecord.source,'UK CoFID');assert.match(c.householdMeasure.sourceFoodId,/^usda:/);assert.equal(c.householdMeasure.nutrientSourceId,c.recordId);assert.equal(c.householdMeasure.nutrientSourceURL,c.sourceRecord.sourceURL);assert.notEqual(c.householdMeasure.sourceFoodId,c.recordId);}
 const quarter=globalThis.NudgeRecipeComposition.apply(result,4,{source:'user',portionFraction:.25});assert.ok(Math.abs(quarter.nutrients.carbohydrate.knownSubtotal-nutrients.carbohydrate.knownSubtotal/4)<1e-8);assert.equal(quarter.nutrients.carbohydrate.value,null);
 // The actual saved scan retained peeling in its printed quote but shortened
 // preparation to "raw". Use that ingredient's own evidence, not other rows.
 const quoted=structuredClone(input),potato=quoted.recipeEvidence.ingredients[8];potato.preparation='raw';potato.evidence='900g/2lb potatoes, peeled and cut into even-sized pieces';quoted.recipeEvidence.text='Serves 4\n'+quoted.recipeEvidence.ingredients.map(r=>r.evidence).join('\n');
 const quotedResult=prepareRecipeCalculation(quoted).recipeCalculation;assert.equal(quotedResult.batchComponents[8].recordId,'13-489:214c339aadef');assert.equal(quotedResult.batchNutrients.carbohydrate.knownSubtotal,nutrients.carbohydrate.knownSubtotal);
 // A quantity that was not printed stays unknown; useful sourced subtotals
 // remain available without treating seasoning as numeric zero.
 const unquantified=structuredClone(input);unquantified.recipeEvidence.ingredients.push({name:'salt',preparation:'raw',amount:null,unit:null,evidence:'Salt, to taste'});unquantified.recipeEvidence.text+='\nSalt, to taste';
 const partial=prepareRecipeCalculation(unquantified).recipeCalculation;
 assert.equal(partial.batchNutrients.energyKcal.value,null);assert.equal(partial.batchNutrients.energyKcal.knownSubtotal,nutrients.energyKcal.value);assert.equal(partial.batchNutrients.energyKcal.unknownContributions,1);assert.equal(partial.batchComponents.at(-1).amountGrams,null);
 assert.equal(partial.batchNutrients.carbohydrate.value,null);assert.equal(partial.batchNutrients.carbohydrate.knownSubtotal,nutrients.carbohydrate.knownSubtotal);assert.equal(partial.batchNutrients.carbohydrate.unknownContributions,2);
});
