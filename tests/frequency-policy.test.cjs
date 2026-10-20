const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const c={console};c.window=c;vm.createContext(c);for(const f of ['streaks.js','core/diary.js','core/food-log.js','food-patterns.js','core/nutrition-profile.js','nudge-fit.js','core/nudge-score.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','core/product-evidence.js','scan-results.js','barcode.js'])vm.runInContext(fs.readFileSync('Web/'+f,'utf8'),c,{filename:f});
const values={energyKcal:184,protein:9.8,fibre:1.9,saturatedFat:1.4,sugars:3.6,salt:.96,fat:7,carbohydrate:20};
const p={name:'Pinned Pret test wrap',categoryTag:'en:wraps',sourceName:'Pinned manufacturer test fixture',sourceURL:'https://example.test/pinned-pret',basisUnit:'g',nutritionPreparation:'as_sold',ingredients:'Chicken, wheat wrap, vegetables',servingAmount:250,servingUnit:'g',energyKj:{value:772,unit:'kJ',status:'supplied'},nutrients:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,status:'supplied'}])),servingNutrients:Object.fromEntries(Object.entries({energyKcal:460,protein:24.4,fibre:4.6,salt:2.39}).map(([key,value])=>[key,{value,status:'supplied',unit:key==='energyKcal'?'kcal':'g'}])),servingNutrientSource:{title:'Manufacturer whole wrap (pinned fixture)',url:'https://example.test/pinned-pret',version:'fixture-only'}};
// Current nutrition grades do not prescribe how often a food may be eaten.
p.scoringFacts={fvlPercent:{value:0,source:'declared',evidence:'Synthetic fixture'}};
const m=c.NudgeFoodDetailModel,f=c.NudgeFrequency,base=m.score(p),day='2026-10-04';
assert.equal(base.value,50);assert.equal(base.rawScore,4);assert.equal(base.grade,'C');assert(m.validScoreResult(base));
for(const factor of [.5,1,2]){
 const selection={measureId:'serving',unit:'g',canonicalAmount:250*factor},ns=m.portionNutrients(p,selection);
 assert.equal(ns.salt,2.39*factor);assert.equal(ns.protein,24.4*factor);assert.equal(ns.energyKcal,460*factor);assert.equal(ns.fibre,4.6*factor);
 const result=f.apply(base,{product:p,profile:{},day,slot:'Lunch',salt:ns.salt});
 assert.equal(result.value,50);assert.equal(result.finalFrequency,null);assert.equal(result.baseFrequency,null);assert.equal(f.render(result),'');
 assert(c.NudgeAlternatives.canOffer(result));
}
const entry={id:'food1',name:'Earlier wrap',day,slot:'Lunch',portions:1,portionAmount:250,portionUnit:'g',plants:[],ferments:[],energyPerPortion:460,proteinPerPortion:24.4,fibrePerPortion:4.6,nutritionSnapshot:{salt:{portion:2.39,portionStatus:'calculated'}},sourceMeta:{entryKind:'product-consumption',confirmationId:'food1',scoreMethod:base}};
const neutralEntries=[{...entry,slot:''},{...entry,id:'unknown-salt',slot:'',nutritionSnapshot:{}}];
const neutralBefore=JSON.stringify(neutralEntries);
for(const slot of ['',undefined,'Other','lunch']){
 const occasion=f.occasionSalt(neutralEntries,{day,slot,salt:.5});
 assert.equal(occasion.value,.5,'Without an explicit legacy category, only this item contributes salt');
 assert.equal(occasion.otherFoods,0);
 assert.equal(occasion.unknownFoods,0);
 const applied=f.apply(base,{product:p,entries:neutralEntries,day,slot,salt:.5});
 assert.equal(applied.eatingOccasion.saltGrams,.5);
 assert.equal(applied.eatingOccasion.slot,null);
 assert.equal(applied.eatingOccasion.groupingPolicy,'current-item-only-v1');
 assert.equal(applied.value,base.value,'Meal categorization does not change nutrient quality');
}
assert.equal(f.occasionSalt(neutralEntries,{day,slot:'',salt:null}).value,null,'Unknown current salt stays unknown');
const explicit=f.apply(base,{product:p,entries:[entry,...neutralEntries],day,slot:'Lunch',salt:.5});
assert.equal(explicit.eatingOccasion.saltGrams,2.89);
assert.equal(explicit.eatingOccasion.otherFoods,1);
assert.equal(explicit.eatingOccasion.slot,'Lunch');
assert.equal(explicit.eatingOccasion.groupingPolicy,'same-local-date-and-explicit-meal-v1');
assert.equal(f.occasionSalt([entry],{day,slot:'Lunch',excludeId:entry.id,salt:.5}).value,.5);
assert.equal(JSON.stringify(neutralEntries),neutralBefore,'Projection never rewrites saved categories or nutrients');
assert.doesNotMatch(f.render({methodId:'legacy-test',finalFrequency:'Weekly',eatingOccasion:explicit.eatingOccasion}),/Lunch|selected meal/);
for(const profile of [{},{age:12},{care:'clinical'},{allergies:['gluten'],allergiesAnswered:true}]){
 const result=f.apply(base,{product:p,profile,entries:[entry],day,slot:'Lunch',salt:5});
 assert.equal(result.value,base.value);assert.equal(result.finalFrequency,null);assert.equal(f.render(result),'');
}
assert.equal(f.safety(p,{allergies:['gluten'],allergiesAnswered:true}).suitability,'confirmed_conflict','Allergen checks remain independent of nutrition');
const old={methodId:'nudge_label_v0_1',version:'1',status:'rated',value:62,grade:'C',rawScore:4};assert(f.legacy(old));assert.match(f.historical(old),/62\/100/);
const oldFrequency={...base,methodId:'nudge_nutrition_v0_2',version:'0.2',baseFrequency:'Weekly',finalFrequency:'Monthly'},beforeOld=JSON.stringify(oldFrequency);
assert.equal(f.savedDisplay(oldFrequency).finalFrequency,null);assert.equal(f.render(oldFrequency),'');assert.equal(JSON.stringify(oldFrequency),beforeOld);
const current=f.apply(base,{product:p,day,slot:'Lunch',salt:2.39}),raw={...entry,sourceMeta:{...entry.sourceMeta,scoreMethod:current,scoreHistory:[old,current]}},before=JSON.stringify(raw);
const saved=c.WmdFoodLog.clean({entries:[raw]}).entries[0];assert.equal(JSON.stringify(raw),before);assert.equal(saved.sourceMeta.scoreMethod.value,current.value);assert.deepEqual(saved.sourceMeta.scoreMethod.inputs,current.inputs);
const registry={version:'test-only',items:{brandA:{groupId:'test-wraps',amount:250,unit:'g',source:'pinned test fixture',version:'1'},brandB:{groupId:'test-wraps',amount:250,unit:'g',source:'pinned test fixture',version:'1'}}};
const consumed=(id,barcode,amount,date=day,frequency='Weekly')=>({...entry,id,barcode,day:date,portionAmount:amount,sourceMeta:{confirmationId:id,scoreMethod:{...current,finalFrequency:frequency}}});
const items=[consumed('a','brandA',125),consumed('b','brandB',250),consumed('daily','brandA',250,day,'Daily'),consumed('outside','brandA',250,'2026-09-27')];const usage=f.rolling(items,{registry,day,groupId:'test-wraps',frequency:'Weekly'});assert.equal(usage.used,1.5);assert.equal(usage.remaining,.5);assert.equal(f.rolling([...items,items[0]],{registry,day,groupId:'test-wraps',frequency:'Weekly'}).used,1.5);assert.equal(f.rolling(items,{day,groupId:'test-wraps',frequency:'Weekly'}).available,false);
const extraction={type:'product',basis:'perServing',servingSize:{value:250,unit:'g'},nutritionPreparation:'as_sold',nutrients:{salt:{value:2.39,unit:'g'},protein:{value:24.4,unit:'g'}}};const photo=c.NudgeResults.fromExtraction(extraction);assert.equal(m.portionNutrients(photo,{measureId:'serving',canonicalAmount:500,unit:'g'}).salt,4.78);
console.log('Passed: v0.3 has no grade-to-frequency prescription, serving arithmetic and allergen checks remain independent, historical evidence is immutable, legacy counters and label serving precision preserved.');
// A new current label retires old rounded/declared serving fields as one evidence pair.
const corrected=c.NudgeResults.augmentFromLabel({...extraction,basis:'per100g',productName:p.name,nutritionPreparation:'as_sold',labelKind:'nutrition',nutrients:{salt:{value:.1,unit:'g'}},servingSize:{value:100,unit:'g'}},p);
assert.equal(corrected.servingNutrients,null);assert.equal(m.portionNutrients(corrected,{measureId:'serving',canonicalAmount:100,unit:'g'}).salt,.1);
const {boot}=require('./food-detail.test.cjs');const app=boot();app.receive({...p,barcode:'declared-fixture'});app.action('detail-log');const eaten=app.data.foodLog.entries[0];assert.equal(eaten.nutritionSnapshot.salt.portion,2.39);assert.equal(app.controller.detail().nutrients.protein,24.4,'Reopening preserves declared serving precision');eaten.nutritionSnapshot.salt={per100:.04,portion:.1,portionStatus:'calculated',per100Status:'supplied',unit:'g'};app.history.reopen('diary:'+eaten.id);assert.equal(app.controller.detail().nutrients.salt,.1,'Old serving table cannot undo a saved correction');app.action('detail-edit');app.action('detail-log');assert.equal(app.data.foodLog.entries[0].nutritionSnapshot.salt.portion,.1);assert.equal(app.data.foodLog.entries.length,1);
assert.equal(m.servingConflict(p,{measureId:'serving',canonicalAmount:250,unit:'g'}),false,'Permitted manufacturer rounding is not a conflict');assert.equal(m.servingConflict({...p,servingNutrients:{salt:{value:.1,unit:'g',status:'supplied'}}},{measureId:'serving',canonicalAmount:250,unit:'g'}),true,'Contradictory salt cannot clear portion guidance');
const conflicting=boot();conflicting.receive({...p,barcode:'conflict',servingNutrients:{...p.servingNutrients,salt:{value:.1,unit:'g',status:'supplied'}}});assert.equal(conflicting.controller.detail().score.finalFrequency,null);conflicting.action('detail-log');assert.equal(conflicting.data.foodLog.entries[0].sourceMeta.portionSaltConflict,true);assert.equal(conflicting.controller.detail().score.finalFrequency,null,'Logging does not silently resolve contradictory source salt');
