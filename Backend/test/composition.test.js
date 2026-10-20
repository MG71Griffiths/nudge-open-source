import test from 'node:test';import assert from 'node:assert/strict';
import data from '../data/cofid-2021.json' with {type:'json'};
import usda from '../data/usda-meal-fallbacks.json' with {type:'json'};
import {compositionRecord,compositionCandidates,resolveMealComponents,compositionMath} from '../src/composition.js';
test('plate side descriptions retain food identity while mixed-dish parts remain distinct',()=>{
 const cabbage=compositionCandidates('cooked cabbage side','cooked, boiled or steamed visible');assert.ok(cabbage.some(r=>r.code==='13-581'));assert.ok(cabbage.every(r=>/^Cabbage,/.test(r.name)&&/boiled|steamed/.test(r.name)));
 const mash=compositionCandidates('mashed potato topping','cooked, baked');assert.ok(mash.some(r=>r.code==='13-553'));assert.ok(mash.every(r=>/^Potatoes,.*mashed/.test(r.name)));
 const result=resolveMealComponents([{name:'mashed potato topping',preparation:'cooked, baked',amountGrams:150}],{estimatedServing:true});assert.equal(result.components[0].recordId,null,'Candidate milk/butter proportions still need evidence');
 for(const name of ['fish pie filling','fish pie topping','pie base'])assert.deepEqual(compositionCandidates(name,'cooked'),[],name);
 const side=resolveMealComponents([{name:'broccoli side dish',preparation:'steamed',amountGrams:80}],{estimatedServing:true}).components[0];assert.equal(side.sourceRecord.code,'13-504');assert.equal(side.name,'broccoli side dish');assert.equal(side.amountGrams,80);
});
test('versioned CoFID import retains duplicate codes with distinct name keys and AOAC missing meanings',()=>{
 assert.equal(data.foods.length,2887);const duplicates=data.foods.filter(r=>r.code==='13-669');assert.equal(duplicates.length,2);assert.notEqual(duplicates[0].id,duplicates[1].id);
 assert.equal(compositionMath.value('Tr').status,'trace');assert.equal(compositionMath.value('N').value,null);assert.equal(compositionMath.value('').value,null);assert.equal(compositionMath.value('0').value,0);
});
test('raw smoked-haddock recipe weights select explicitly raw edible flesh',()=>{
 const input=(preparation,name='smoked haddock')=>resolveMealComponents([{name,preparation,amountGrams:350}],{estimatedServing:true});
 const raw=input('raw'),c=raw.components[0];assert.equal(c.recordId,'16-492:d35747a63193');assert.match(c.sourceRecord.name,/smoked, raw/);assert.equal(c.sourceRecord.foodGroup,'fish');
 assert.ok(Math.abs(raw.nutrients.energyKcal.value-290.5)<1e-9);assert.ok(Math.abs(raw.nutrients.protein.value-68.95)<1e-9);
 for(const prep of ['cooked','unknown','raw and cooked','raw in sauce'])assert.notEqual(input(prep).components[0].recordId,c.recordId,prep);
 assert.notEqual(input('raw','smoked haddock filling').components[0].recordId,c.recordId);
});
test('plain raw haddock uses one UK source with available carbohydrate without changing preparations',()=>{
 const c=resolveMealComponents([{name:'fresh haddock',preparation:'raw',amountGrams:350}],{estimatedServing:true}).components[0];
 assert.equal(c.recordId,'16-375:fcf21536084f');assert.equal(c.sourceRecord.carbohydrateDefinition,'available');assert.equal(c.sourceRecord.foodGroup,'fish');assert.deepEqual(c.nutrients,c.sourceRecord.nutrients);assert.equal(c.nutrients.carbohydrate.value,0);
 for(const preparation of ['cooked','raw and cooked','raw in sauce'])assert.notEqual(resolveMealComponents([{name:'haddock',preparation,amountGrams:350}],{estimatedServing:true}).components[0].recordId,c.recordId,preparation);
 assert.notEqual(resolveMealComponents([{name:'smoked haddock',preparation:'raw',amountGrams:350}],{estimatedServing:true}).components[0].recordId,c.recordId);
});
test('explicit raw peeled potato recipe weights select flesh-only source data',()=>{
 for(const [name,preparation]of [['potatoes','raw, peeled'],['peeled potatoes','raw'],['potatoes peeled','raw'],['potatoes','raw, flesh only']]){
  const input={name,preparation,amountGrams:900},before=structuredClone(input),result=resolveMealComponents([input],{estimatedServing:true}),c=result.components[0];
  assert.deepEqual(input,before);assert.equal(c.recordId,'13-489:214c339aadef');assert.match(c.sourceRecord.name,/raw, flesh only/);assert.equal(c.name,name);assert.equal(c.preparation,preparation);assert.equal(c.amountGrams,900);
  assert.equal(result.nutrients.energyKcal.value,738);assert.ok(Math.abs(result.nutrients.protein.value-17.1)<1e-9);
 }
 for(const preparation of ['raw','raw, unpeeled','raw, peeled with skin','raw, peeled in sauce','raw, peeled and boiled','boiled, peeled'])assert.notEqual(resolveMealComponents([{name:'potatoes',preparation,amountGrams:900}],{estimatedServing:true}).components[0].recordId,'13-489:214c339aadef',preparation);
 const quoted={name:'potatoes',preparation:'raw',amountGrams:900,evidence:'Recipe photo 1: 900g/2lb potatoes, peeled and cut into even-sized pieces'};
 const matched=resolveMealComponents([quoted],{estimatedServing:true}).components[0];assert.equal(matched.recordId,'13-489:214c339aadef');assert.equal(matched.preparation,'raw');assert.equal(matched.evidence,quoted.evidence);
 for(const evidence of ['Recipe photo 1: 900g potatoes','Recipe photo 1: 900g unpeeled potatoes','Recipe photo 1: 900g potatoes, peeled and cooked'])assert.notEqual(resolveMealComponents([{...quoted,evidence}],{estimatedServing:true}).components[0].recordId,'13-489:214c339aadef',evidence);
});
test('new serving estimates use explicit whole-record proxies with official USDA provenance',()=>{
 const result=resolveMealComponents([{name:'cauliflower',preparation:'fried',amountGrams:150},{name:'spinach',preparation:'raw',amountGrams:30},{name:'pomegranate seeds',preparation:'raw',amountGrams:20}],{estimatedServing:true});
 assert.equal(result.components[0].sourceRecord.name,'Cauliflower, boiled in unsalted water');
 assert.equal(result.components[0].preparationProxy,true);assert.match(result.components[0].excludedPreparation,/oil, batter/);
 assert.equal(result.components[1].sourceRecord.id,'usda:168462');assert.equal(result.components[2].sourceRecord.id,'usda:169134');
 assert.ok(result.components.every(c=>c.amountSource==='standard_portion_estimate'&&c.matchMethod==='curated_proxy'&&c.sourceRecord.fvlEligible===true));
 assert.ok(result.components.every(c=>c.assumptions.some(a=>/one portion/.test(a))));
 assert.ok(Math.abs(result.nutrients.energyKcal.value-67)<1e-8);
 assert.ok(Math.abs(result.nutrients.protein.value-4.042)<1e-8);
 assert.ok(Math.abs(result.nutrients.fibre.value-4.31)<1e-8);
 for(const key of ['energyKcal','protein','fibre','sugars','saturatedFat','salt'])assert.equal(typeof result.nutrients[key].value,'number');
 assert.match(usda.sourceURL,/^https:\/\/fdc.nal.usda.gov\//);assert.equal(usda.foods.length,17);assert.match(usda.sourceSHA256,/^[0-9a-f]{64}$/);
 assert.equal(compositionRecord('usda:168462').nutrients.fibre.original,'2.2');
 assert.equal(compositionRecord('usda:169134').nutrients.fibre.value,4);
 assert.equal(compositionRecord('usda:171413').foodGroup,'fat_oil');assert.equal(compositionRecord('usda:171413').fvlEligible,false);
 assert.equal(compositionRecord('usda:172475').fvlEligible,null,'Processed tofu is not assumed whole-legume eligible');
});
test('curated aliases cover ordinary meals without silently accepting sauce, preparation or subtype changes',()=>{
 for(const [name,preparation,code] of [['broccolini','raw','13-502'],['red sweet pointed pepper','raw','170108'],['cucumber','raw','168409'],['spring onions','raw','170005'],['chicken breast','grilled','18-323'],['white rice','boiled','169757'],['brown rice','boiled','169704'],['pasta','cooked','168928'],['wholewheat pasta','cooked','168910'],['chickpeas','cooked','173757'],['lentils','cooked','172421'],['salmon','baked','175168']]){
  const c=resolveMealComponents([{name,preparation,amountGrams:100}],{estimatedServing:true}).components[0];
  assert.equal(c.sourceRecord?.code,code,name);assert.equal(c.matchStatus,'matched');
 }
 for(const [name,preparation] of [['cauliflower cheese','roasted'],['cauliflower','battered and fried'],['chicken','cooked'],['chicken breast','breaded and fried'],['spinach','raw and cooked'],['unidentified sauce','unknown'],['pomegranate','cooked'],['peas','fried']]){
  const c=resolveMealComponents([{name,preparation,amountGrams:100}],{estimatedServing:true}).components[0];
  assert.equal(c.recordId,null,`${name}/${preparation}`);
 }
 const rice=resolveMealComponents([{name:'rice',preparation:'unknown',amountGrams:150}],{estimatedServing:true}).components[0];
 assert.equal(rice.preparationProxy,true);assert.match(rice.assumptions.join(' '),/actual recipe may differ/);
 assert.equal(rice.nutrients.sugars.value,0.05,'Generic rice uses a whole verified USDA record, not guessed zero');
 const exactRice=resolveMealComponents([{name:'Rice, white, long grain, boiled in unsalted water',preparation:'boiled',amountGrams:150}],{estimatedServing:true}).components[0];
 assert.equal(exactRice.sourceRecord.source,'UK CoFID');assert.equal(exactRice.nutrients.sugars.value,null,'Explicit CoFID trace is not replaced by zero');
});
test('confirmed edible cooked weights match official chicken rice broccoli fixture',()=>{
 const components=[['18-323',150],['11-869',150],['13-503',80]].map(([code,amountGrams])=>{const r=compositionRecord(data.foods.find(r=>r.code===code).id);return {...r,amountGrams};});
 const n=compositionMath.total(components);assert.ok(Math.abs(n.energyKcal.value-442.4)<1e-8);assert.ok(Math.abs(n.protein.value-56.04)<1e-8);assert.ok(Math.abs(n.fibre.value-4.49)<1e-8);
});
test('uncertain component or mass preserves partial totals instead of freeform nutrient guesses',()=>{
 const x=resolveMealComponents([{name:'Unidentified sauce',preparation:'unknown',amountGrams:10}]);assert.equal(x.nutrients.energyKcal.value,null);assert.equal(x.components[0].recordId,null);
 const n=compositionMath.total([{amountGrams:100,nutrients:{protein:{value:10}}},{amountGrams:null,nutrients:{protein:{value:10}}}]);assert.equal(n.protein.value,null);assert.equal(n.protein.knownSubtotal,10);
});
test('a visible ingredient never silently matches a composite recipe containing it',()=>{
 for(const [name,preparation] of [['cauliflower','cooked and possibly fried or roasted'],['spinach','cooked'],['rice','unknown']]){
  const options=compositionCandidates(name,preparation);
  assert.ok(options.every(r=>!/^pakora|^bhaji|^curry|^pie|^pilaf|cheese|white sauce/i.test(r.name)));
 }
 const result=resolveMealComponents([{name:'cauliflower',preparation:'fried',amountGrams:150}]);
 assert.equal(result.components[0].recordId,null);
 assert.equal(result.nutrients.energyKcal.value,null);
 const peas=resolveMealComponents([{name:'peas',preparation:'fried',amountGrams:100}]);
 assert.equal(peas.components[0].recordId,null,'A sole mange-tout/rapeseed-oil candidate needs confirmation');
 assert.equal(peas.nutrients.energyKcal.value,null);
 assert.ok(compositionCandidates('Carrots, old, raw','raw').some(r=>r.name==='Carrots, old, raw'));
});
