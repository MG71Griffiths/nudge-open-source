import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import data from '../data/cofid-2021.json' with {type:'json'};
import {compositionRecord,compositionMath as calc,resolveMealComponents,reconcileMealPlants} from '../src/composition.js';
import '../../Web/core/nudge-score.js';
import '../../Web/core/meal-score.js';
const scoring=globalThis.NudgeMealScore,copy=v=>structuredClone(v),id='19-468:ec99331e0ea1';
const component=(name,amountGrams,preparation='cooked')=>({name,amountGrams,preparation,photoIndex:1,evidence:name,recordId:null,sourceRecord:null,amountSource:'standard_portion_estimate',matchStatus:'unmatched',assumptions:['Synthetic serving estimate']});
const whole=()=>({name:'Sausage roll',portionMode:'estimated_serving',basis:'perPortion',components:[component('sausage roll',150)],ingredients:[{name:'puff pastry',evidence:'puff pastry'}],plants:[],scoreSnapshot:{available:false,value:null,methodId:'nudge_meal_v0_1'}});
const pieces=()=>({...whole(),components:[component('pastry',120,'baked'),component('sausage meat',100)]});

test('reviewed generic recipe preserves the exact complete official CoFID source row and uncertainty',()=>{
  const actual=calc.compoundRecord(id),official=data.foods.find(r=>r.id===id);
  assert.deepEqual(actual,compositionRecord(id));assert.deepEqual(actual.nutrients,calc.nutrients(official));
  for(const field of ['id','code','name','description'])assert.equal(actual[field],official[field]);
  assert.equal(actual.sourceReference,official.reference);assert.equal(actual.sourceURL,data.sourceURL);assert.equal(actual.sourceVersion,data.version);
  assert.equal(actual.fvlEligible,null);assert.equal(actual.plantIdentity,null);assert.equal(actual.foodGroup,'mixed_dish');
  assert.equal(actual.nutrients.salt.value,577*2.5/1000);assert.equal(actual.nutrients.salt.status,'derived');
  actual.nutrients.protein.value=0;assert.equal(calc.compoundRecord(id).nutrients.protein.value,8.4,'Registry reads are independent');
});
test('whole and decomposed estimates use one whole-recipe source without changing total grams or observations',()=>{
  for(const [input,grams,kcal,protein,fibre] of [[whole(),150,528,12.6,5.1],[pieces(),220,774.4,18.48,7.48]]){
    const original=copy(input),result=calc.proposeMeal(input);
    assert.notEqual(result,input);assert.deepEqual(input,original);assert.equal(result.components.length,1);assert.equal(result.components[0].recordId,id);
    assert.equal(result.components[0].amountGrams,grams);assert.equal(result.portion.amount,grams);assert.equal(result.portion.unit,'g');
    for(const [key,expected] of [['energyKcal',kcal],['protein',protein],['fibre',fibre]])assert.ok(Math.abs(result.nutrients[key].value-expected)<1e-10,key);
    assert.deepEqual(result.ingredients,input.ingredients);assert.deepEqual(result.plants,input.plants);assert.equal(result.scoreSnapshot,undefined);
    assert.deepEqual(result.compoundProposal.originalComponents,input.components);assert.equal(result.components[0].photoIndex,1);
    assert.match(result.components[0].assumptions.join(' '),/Generic whole-recipe estimate/);assert.match(result.components[0].assumptions.join(' '),/no meat, pastry or ingredient percentages/);
    const score=scoring.calculate(result);assert.equal(score.methodId,globalThis.NudgeScoreCore.SCORE_METHOD);assert.equal(score.available,true);assert.equal(score.status,'estimated_provisional');
    assert.equal(score.value,0);assert.equal(score.grade,'E');assert.equal(score.displayLower,0);assert.equal(score.displayUpper,0);assert.equal(score.rawLower,20);assert.equal(score.rawUpper,20);assert.equal(score.rawScore,20);assert.equal(score.inputs.fvlPercent,null);assert.equal(score.band.id,'red');
    assert.equal(calc.proposeMeal(result),result,'Repeated proposals are idempotent');
  }
});
test('only explicitly supported unconfirmed whole foods qualify; sources, edits and uncertain amounts are protected',()=>{
  const variants=[
    {...whole(),name:'Vegan sausage roll'}, {...whole(),name:'Sausage roll and salad'}, {...whole(),portionMode:'photographed_portion'},
    {...whole(),scoreSnapshot:{available:true,value:45,methodId:'nudge_meal_v0_1'}},
    {...whole(),ingredients:[{name:'vegetarian sausage',evidence:'vegetarian sausage'}]},
    {...whole(),ingredients:[{name:'vegan filling',evidence:'vegan filling'}]},
    {...whole(),ingredients:[{name:'shortcrust pastry',evidence:'shortcrust pastry'}]},
    {...whole(),ingredients:[{name:'chicken meat',evidence:'chicken meat'}]},
    {...whole(),subject:{description:'Turkey sausage roll on a plate'}},
    {...whole(),components:[{...component('sausage roll',150),amountSource:'confirmed'}]},
    {...whole(),components:[{...component('sausage roll',150),userEdited:true}]},
    {...whole(),components:[{...component('sausage roll',150),matchStatus:'confirmed'}]},
    {...whole(),components:[{...component('sausage roll',150),matchMethod:'user_selected'}]},
    {...whole(),components:[{...component('sausage roll',150),recordId:id,sourceRecord:calc.compoundRecord(id)}]},
    {...whole(),components:[{...component('sausage roll',150),selected:false}]},
    {...whole(),components:[component('sausage roll',null)]}, {...whole(),components:[component('sausage roll',0)]}, {...whole(),components:[component('sausage roll',1501)]},
    {...whole(),components:[component('sausage roll',150,'raw')]},
    {...pieces(),components:[component('pastry',120),component('sausage meat',100),component('sauce',20)]},
    {...pieces(),components:[component('pastry',120),component('pastry',100)]},
    {...pieces(),components:[component('pastry',120),{...component('sausage meat',100),photoIndex:2}]},
    ...[0,5,null,undefined].map(photoIndex=>({...whole(),components:[{...component('sausage roll',150),photoIndex}]})),
    {...whole(),components:[{...component('sausage roll',150),evidence:''}]}
  ];
  for(const input of variants)assert.equal(calc.proposeMeal(input),input,JSON.stringify(input));
  const input=whole();assert.equal(calc.proposeMeal(input,{confirmed:true}),input);assert.equal(calc.proposeMeal(input,{userEdited:true}),input);
});
test('backend and browser apply the same pure proposal, preserving photo and original assumptions',()=>{
  const input=pieces(),server=resolveMealComponents(input.components,{estimatedServing:true,mealName:input.name});
  assert.equal(server.components.length,1);assert.equal(server.components[0].recordId,id);assert.equal(server.components[0].photoIndex,1);
  assert.equal(server.compoundProposal.originalComponents.length,2);assert.ok(server.compoundProposal.originalComponents.every(c=>c.photoIndex===1&&c.assumptions.includes('Synthetic serving estimate')));
  const browser={};browser.window=browser;vm.createContext(browser);vm.runInContext(fs.readFileSync(new URL('../../Web/core/food-composition.js',import.meta.url),'utf8'),browser);
  assert.deepEqual(JSON.parse(JSON.stringify(browser.NudgeComposition.proposeMeal(input))),calc.proposeMeal(input));
  const legacy=resolveMealComponents(input.components,{estimatedServing:false,mealName:input.name});assert.equal(legacy.compoundProposal,undefined);assert.equal(legacy.components.length,2);
  const variant=resolveMealComponents(input.components,{estimatedServing:true,mealName:input.name,mealIngredients:[{name:'vegan sausage',evidence:'vegan sausage'}]});assert.equal(variant.compoundProposal,undefined);
  const subject=resolveMealComponents(input.components,{estimatedServing:true,mealName:input.name,mealSubject:{description:'Chicken sausage roll'}});assert.equal(subject.compoundProposal,undefined);
});
test('compact original-component provenance survives confirmed diary cleaning without adding ingredients',()=>{
  const browser={};browser.window=browser;vm.createContext(browser);for(const file of ['streaks.js','core/diary.js','core/food-log.js','food-patterns.js'])vm.runInContext(fs.readFileSync(new URL('../../Web/'+file,import.meta.url),'utf8'),browser);
  const result=calc.proposeMeal(pieces()),components=result.components.map(({candidates,...component})=>component);
  const entry={id:'synthetic',name:'Sausage roll',day:'2026-10-04',portions:1,plants:[],sourceMeta:{mealComposition:components,mealPortionMode:'estimated_serving',mealScore:scoring.calculate(result)}};
  const saved=browser.WmdFoodLog.clean({entries:[entry]}).entries[0];
  assert.deepEqual(JSON.parse(JSON.stringify(saved.sourceMeta.mealComposition[0].compoundProxy)),result.components[0].compoundProxy);
  assert.equal(saved.sourceMeta.mealScore.methodId,globalThis.NudgeScoreCore.SCORE_METHOD);assert.equal(saved.sourceMeta.mealScore.displayUpper,0);assert.deepEqual(Array.from(saved.plants),[]);
});
test('oil-only plant evidence cannot become a seed; explicit seed plus oil evidence stays counted',()=>{
  const plant={name:'sunflower',evidence:'sunflower oil'};
  assert.equal(calc.plantIsOilOnly(plant,[{name:'sunflower oil',evidence:'sunflower oil'}]),true);
  assert.deepEqual(reconcileMealPlants([],[{name:'sunflower oil',evidence:'sunflower oil'}],[plant]).plants,[]);
  assert.equal(calc.plantIsOilOnly(plant,[{name:'sunflower seeds',evidence:'sunflower seeds'},{name:'sunflower oil',evidence:'sunflower oil'}]),false);
  assert.equal(calc.plantIsOilOnly({name:'sunflower',evidence:'sunflower seeds'},[{name:'sunflower oil',evidence:'sunflower oil'}]),false);
  assert.equal(calc.plantIsOilOnly({name:'wheat',evidence:'rusk'},[{name:'rusk',evidence:'rusk'}]),false,'No botanical identity is inferred from rusk');
});
