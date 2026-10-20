const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const sandbox={window:{},Date};sandbox.window=sandbox;vm.createContext(sandbox);
for(const file of ['streaks.js','core/diary.js','core/food-log.js','food-patterns.js','core/nutrition-profile.js','nudge-fit.js','core/nudge-score.js','food-detail-model.js','core/frequency-policy.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),sandbox,{filename:file});
const M=sandbox.NudgeFoodDetailModel,json=v=>JSON.parse(JSON.stringify(v)),close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
// This supplied example is a test fixture only. Runtime has no manufacturer nutrient fixture or 84-point score.
const fixture={name:'ManiLife Deep Roast Crunchy Peanut Butter',brand:'ManiLife',basisUnit:'g',nutritionPreparation:'as_sold',servingAmount:15,servingLabel:'portion',packAmount:275,packUnit:'g',sourceName:'Open Food Facts',sourceURL:'https://world.openfoodfacts.org/product/123456789',nutriScoreGrade:'c',ingredients:'Hi-Oleic Peanuts 99.1%, Sea Salt 0.9%. Made in a factory that handles other nuts.',allergens:['peanuts'],traces:[],nutrients:Object.fromEntries(Object.entries({energyKcal:619,protein:26.4,fibre:9.1,fat:50.5,saturatedFat:6,carbohydrate:10.1,sugars:5.5,salt:.9}).map(([key,value])=>[key,{value,status:'supplied'}]))};
let s=M.createPortion(fixture),measures=M.measures(fixture);
assert.equal(s.canonicalAmount,15);assert.equal(s.measureId,'tablespoon');assert.equal(M.quantity(fixture,s),1);
assert.match(measures.startingSource.basis,/Manufacturer/);assert.equal(measures.options.find(m=>m.id==='tablespoon').estimated,true);
assert.match(measures.options.find(m=>m.id==='tablespoon').source.url,/cuh\.nhs\.uk/);
for(let i=0;i<1000;i++){s=M.switchMeasure(fixture,s,'teaspoon');assert.equal(M.quantity(fixture,s),3);s=M.switchMeasure(fixture,s,'g');assert.equal(M.quantity(fixture,s),15);s=M.switchMeasure(fixture,s,'tablespoon');}
assert.equal(s.canonicalAmount,15);
const nutrition15=M.portionNutrients(fixture,s);
for(const [key,expected] of Object.entries({energyKcal:92.85,protein:3.96,fibre:1.365,fat:7.575,saturatedFat:.9,carbohydrate:1.515,sugars:.825,salt:.135}))close(nutrition15[key],expected);
const twice=M.setAmount(fixture,s,2),nutrition30=M.portionNutrients(fixture,twice);
for(const key of M.keys)close(nutrition30[key],nutrition15[key]*2);
assert.equal(Math.round(nutrition30.energyKcal),186);assert.equal(Math.round(nutrition30.protein*10)/10,7.9);
assert.equal(M.setAmount(fixture,s,.5).canonicalAmount,7.5);
const weighed=M.setAmount(fixture,M.switchMeasure(fixture,s,'g'),'27.123456');assert.equal(weighed.canonicalAmount,27.123456);
for(const input of ['', ' ', '-1', '0', 'NaN', 'Infinity', '2g', '1e2', false, null, undefined, -1, 0, Infinity, 5001])assert.equal(M.setAmount(fixture,s,input),null,`invalid ${String(input)}`);
assert.ok(M.valid(fixture,M.setAmount(fixture,M.switchMeasure(fixture,s,'g'),2500)));
assert.equal(M.measures({name:'Olive oil',basisUnit:'g'}).options.some(m=>m.id==='tablespoon'),false);
assert.equal(M.measures({name:'Flour',basisUnit:'g'}).startingCanonical,100);
assert.equal(M.measures({name:'Peanut butter biscuits',basisUnit:'g'}).options.some(m=>m.id==='tablespoon'),false);
assert.equal(M.measures({name:'Bread with peanut butter',basisUnit:'g'}).options.some(m=>m.id==='tablespoon'),false);
assert.equal(M.createPortion({name:'Deep roast crunchy',categories:['en:peanut-butters'],basisUnit:'g',servingAmount:15}).measureId,'tablespoon');
assert.equal(M.createPortion({name:'Deep roast crunchy',categoriesTags:['en:peanut-butters'],basisUnit:'g',servingAmount:15}).measureId,'tablespoon');
// Real product spoon weights take priority, and the other spoon is a ratio of that same food.
const honey={name:'Honey',basisUnit:'g',servingAmount:7,servingDescription:'1 level teaspoon (7g)'};
assert.equal(M.measures(honey).options.find(m=>m.id==='tablespoon').factor,21);
assert.equal(M.measures(honey).options.find(m=>m.id==='tablespoon').estimated,true);
assert.equal(M.measures({...honey,servingDescription:'1 heaped teaspoon (7g)'}).options.some(m=>m.id==='tablespoon'),false);
const labelledPB={...fixture,servingAmount:6,servingDescription:'1 teaspoon (6g)'};
assert.equal(M.measures(labelledPB).options.find(m=>m.id==='teaspoon').factor,6);assert.equal(M.measures(labelledPB).options.find(m=>m.id==='tablespoon').factor,18);
const marmite={name:'Marmite Original Yeast Extract',brand:'Marmite',basisUnit:'g',nutritionPreparation:'as_sold',countriesTags:['en:united-kingdom'],nutrients:{protein:{value:34},salt:{value:10.8}}};
let marmiteS=M.createPortion(marmite);const mm=M.measures(marmite);
assert.equal(marmiteS.canonicalAmount,8);assert.equal(marmiteS.measureId,'serving');close(M.quantity(marmite,marmiteS),1);
assert.equal(mm.options.find(m=>m.id==='teaspoon').factor,9);assert.equal(mm.options.find(m=>m.id==='tablespoon').factor,27);
assert.equal(mm.options.find(m=>m.id==='teaspoon').estimated,true);assert.match(mm.options.find(m=>m.id==='teaspoon').source.url,/mrc-epid\.cam\.ac\.uk/);
assert.match(mm.startingSource.url,/marmite\.co\.uk/);
for(let i=0;i<1000;i++){marmiteS=M.switchMeasure(marmite,marmiteS,'tablespoon');marmiteS=M.switchMeasure(marmite,marmiteS,'g');marmiteS=M.switchMeasure(marmite,marmiteS,'teaspoon');}
assert.equal(marmiteS.canonicalAmount,8);close(M.portionNutrients(marmite,marmiteS).protein,2.72);
const twoMarmite=M.setAmount(marmite,marmiteS,2);assert.equal(twoMarmite.canonicalAmount,18);close(M.portionNutrients(marmite,twoMarmite).salt,1.944);
assert.equal(M.createPortion({...marmite,servingAmount:4}).canonicalAmount,4);
const makerMarmite={...marmite,servingAmount:6,servingDescription:'1 teaspoon (6g)'};
assert.equal(M.measures(makerMarmite).options.find(m=>m.id==='teaspoon').factor,6);assert.equal(M.measures(makerMarmite).options.find(m=>m.id==='tablespoon').factor,18);
assert.equal(M.createPortion(makerMarmite).canonicalAmount,6);
assert.equal(M.createPortion({...marmite,servingSuggestion:{source:'label',unit:'g',amount:4,label:'1 teaspoon'}}).canonicalAmount,4);
for(const name of ['Marmite Reduced Salt','Marmite Truffle','Marmite XO','Marmite Squeezy','Marmite crisps','Cheese with Marmite','Marmite rice cakes','Marmite Ale'])assert.equal(M.measures({...marmite,name}).options.some(m=>m.id==='teaspoon'),false,name);
assert.notEqual(M.measures({...marmite,name:'Marmite Peanut Butter'}).options.find(m=>m.id==='teaspoon')?.factor,9);
assert.equal(M.measures({...marmite,countriesTags:['en:new-zealand']}).options.some(m=>m.id==='teaspoon'),false);
assert.equal(M.measures({...marmite,brand:'Sanitarium Marmite'}).options.some(m=>m.id==='teaspoon'),false);
assert.equal(M.measures({...marmite,nutritionPreparation:'prepared'}).options.some(m=>m.id==='teaspoon'),false);
assert.equal(M.measures({...marmite,basisUnit:'ml'}).options.some(m=>m.id==='teaspoon'),false);
assert.equal(M.measures({name:'Yeast extract',brand:'Other brand',basisUnit:'g'}).options.some(m=>m.id==='teaspoon'),false);
assert.equal(M.measures({name:'',brand:'Marmite',basisUnit:'g'}).options.some(m=>m.id==='teaspoon'),false);
assert.equal(M.measures({name:'Unknown bar',basisUnit:'g'}).options.some(m=>m.id==='piece'),false);
assert.equal(M.valid({basisUnit:null},M.createPortion({basisUnit:null})),true);
const ingredientsOnly={ingredients:'Peanuts, salt.',basisUnit:null,nutrients:{protein:{value:26.4}}};
const weighedUnknown=M.setAmount(ingredientsOnly,M.createPortion(ingredientsOnly),25);
assert.equal(weighedUnknown.unit,'g');assert.ok(M.valid(ingredientsOnly,weighedUnknown));assert.equal(M.portionNutrients(ingredientsOnly,weighedUnknown).protein,null);assert.deepEqual(json(M.plants(ingredientsOnly).names),['peanut']);
const bread={name:'Wholemeal bread',basisUnit:'g',servingAmount:80,servingDescription:'2 medium slices (80 g)',packAmount:400,packUnit:'g'},breadS=M.createPortion(bread);
assert.equal(breadS.measureId,'slice');assert.equal(M.quantity(bread,breadS),2);assert.equal(M.selectedMeasure(bread,breadS).factor,40);
assert.equal(M.createPortion({...bread,servingDescription:'2 thick slices (80 g)'}).measureId,'slice');
assert.equal(M.selectedMeasure({...bread,servingDescription:'2 thin slices (80 g)'},M.createPortion({...bread,servingDescription:'2 thin slices (80 g)'})).factor,40);
const halfSlice=M.setAmount(bread,breadS,.5);assert.equal(halfSlice.canonicalAmount,20);
const pack=M.switchMeasure(bread,breadS,'pack');assert.equal(pack.canonicalAmount,80);close(M.quantity(bread,pack),.2);
assert.equal(M.setAmount(bread,pack,.25).canonicalAmount,100);
const chocolate={name:'Chocolate',basisUnit:'g',servingAmount:12,servingDescription:'2 squares (12g)'};
assert.equal(M.selectedMeasure(chocolate,M.createPortion(chocolate)).factor,6);
const prepared={...bread,nutritionPreparation:'prepared',packPreparation:'as_sold'};
assert.equal(M.measures(prepared).options.length,1);assert.equal(M.measures(prepared).startingCanonical,100);
const ml={name:'Drink',categoryTag:'en:drinks',basisUnit:'ml',nutritionPreparation:'as_sold',servingAmount:200,servingUnit:'ml',nutrients:{energyKcal:{value:41},protein:{value:0}}};
assert.equal(M.portionNutrients(ml,M.createPortion(ml)).energyKcal,82);
assert.equal(M.measures({...ml,packAmount:250,packUnit:'g'}).options.some(m=>m.id==='pack'),false);
assert.equal(M.measures({...ml,servingUnit:'g'}).startingCanonical,250);
assert.equal(M.portionNutrients(ml,M.createPortion(ml)).fibre,null);assert.equal(M.portionNutrients(ml,M.createPortion(ml)).protein,0);
const saved=json(M.portionRecord(fixture,twice)),restored=M.createPortion({...fixture,servingAmount:20,servingDescription:'1 tablespoon (20 g)'},saved);
assert.equal(restored.canonicalAmount,30);assert.equal(M.quantity(fixture,restored),2);assert.equal(M.selectedMeasure(fixture,restored).factor,15);
const fallback=M.createPortion({name:'Unknown',basisUnit:'g'},saved);assert.equal(fallback.measureId,'g');assert.equal(fallback.canonicalAmount,30);
const scoreSourceBefore=JSON.stringify(fixture),score=M.score(fixture);assert.equal(score.value,sandbox.NudgeScoreCore.ACTIVE_DIRECTIONAL?75:null);assert.equal(score.label,sandbox.NudgeScoreCore.ACTIVE_DIRECTIONAL?'Nudge score':'More label data needed');assert.equal(score.providerGrade,null);if(!sandbox.NudgeScoreCore.ACTIVE_DIRECTIONAL)assert.equal(score.components.length,0);
if(sandbox.NudgeScoreCore.ACTIVE_DIRECTIONAL){
 assert.equal(score.category,'fats_nuts_seeds');assert.equal(score.rawScore,2);assert.equal(score.negativePoints,7);assert.equal(score.positivePoints,5);assert.equal(score.countProteins,false);
 assert.equal(score.components.find(c=>c.id==='energyFromSaturates').value,222);assert.equal(score.components.find(c=>c.id==='fibre').points,5);assert.equal(score.components.find(c=>c.id==='protein').counted,false);
}
assert.equal(JSON.stringify(fixture),scoreSourceBefore,'Correcting the nut-butter category leaves the original public fixture untouched');
assert.deepEqual(json(M.score({...fixture,selectedPortion:30})),json(score));assert.equal(M.score({score:84,nutriScoreGrade:'A'}).value,null);assert.equal(M.score({score:84,nutriScoreGrade:'A'}).providerGrade,null);
assert.ok(score.methodId&&score.version&&score.calculationBasis&&score.inputs&&score.sources);
const allergy=M.allergies(fixture,{avoids:['nuts','milk']});
assert.equal(allergy.conflict,true);assert.ok(allergy.conflicts.some(c=>c.type==='contains'&&c.preference==='nuts'));assert.ok(allergy.conflicts.some(c=>c.type==='manufacturing'));
assert.equal(allergy.conflicts.some(c=>c.preference==='milk'),false);assert.deepEqual(json(allergy.traces),[]);assert.match(allergy.manufacturing.join(' '),/factory that handles other nuts/);
const may=M.allergies({ingredients:'Sugar. May contain milk.',allergens:[],traces:['milk']},{avoids:['milk']});
assert.equal(may.conflicts[0].type,'mayContain');assert.equal(may.conflicts.some(c=>c.type==='contains'),false);
const factory=M.allergies({ingredients:'Rice flour.',tracesText:'Made in a factory that handles milk.'},{avoids:['milk']});
assert.equal(factory.conflicts[0].type,'manufacturing');assert.deepEqual(json(factory.traces),[]);assert.equal(factory.mayContainText,'');
assert.deepEqual(json(M.allergies({...fixture,traces:['nuts']},{avoids:['nuts']}).traces),[]);
assert.equal(M.allergies({ingredients:'Almond milk, cocoa butter.'},{avoids:['milk']}).conflict,false);
assert.equal(M.allergies({ingredients:'Peanuts. Made in a factory that handles dairy and other nuts.'},{avoids:['milk']}).conflicts[0].type,'manufacturing');
assert.equal(M.allergies({ingredients:'Peanuts. Dairy-free.'},{avoids:['milk']}).conflict,false);
assert.equal(M.allergies({ingredients:'Milk, oats.'},{diet:'vegan'}).conflict,true);
assert.equal(M.allergies({ingredients:'Peanuts.'},{avoids:['nuts']}).contains[0].toLowerCase(),'peanuts');
// Optional metadata can be discarded while readable ingredients survive. That
// must remain unknown, rather than displaying a misleading absence statement.
for(const field of ['allergens','ingredients']){
 const recovered={ingredients:'Rice, water.',allergens:null,metadata:{missingFields:[field],allergenWording:{contains:null,mayContain:null,factoryHandling:null}}};
 assert.equal(M.allergies(recovered).unknown,true);
 const knownConflict=M.allergies({...recovered,ingredients:'Milk, rice.'},{avoids:['milk']});
 assert.equal(knownConflict.unknown,true);assert.equal(knownConflict.conflict,true);assert.ok(knownConflict.contains.some(s=>/milk/i.test(s)),'Known conflicting ingredients stay visible');
}
assert.equal(M.allergies({ingredients:'Rice, water.',ingredientsNeedsReview:true}).unknown,true);
assert.equal(M.allergies({ingredients:'Rice, water.',metadata:{missingFields:['netQuantity']}}).unknown,false);
const flags=M.risks(fixture,s).flags;assert.equal(flags.find(f=>f.key==='saturatedFat').classification,'high');assert.equal(flags.find(f=>f.key==='salt').classification,'medium');
close(flags.find(f=>f.key==='salt').portion,.135);assert.equal(M.risks(fixture,twice).flags.find(f=>f.key==='salt').classification,'medium');
for(const [kind,unit,limits] of [['food','g',{fat:[3,17.5],saturatedFat:[1.5,5],sugars:[5,22.5],salt:[.3,1.5]}],['drink','ml',{fat:[1.5,8.75],saturatedFat:[.75,2.5],sugars:[2.5,11.25],salt:[.3,.75]}]]) {
 for(const [key,[low,high]] of Object.entries(limits))for(const [v,classification] of [[low,'low'],[low+.0001,'medium'],[high,'medium'],[high+.0001,'high']]) {
  const p={basisUnit:unit,nutritionPreparation:'as_sold',categoryTag:kind==='drink'?'en:beverages':'en:foods',nutrients:{[key]:{value:v}}};
  assert.equal(M.risks(p,M.createPortion(p)).flags.find(f=>f.key===key).classification,classification);
 }
}
assert.equal(M.risks({...fixture,nutritionPreparation:'unknown'},s).flags[0].classification,null);
assert.equal(M.risks({basisUnit:'ml',nutritionPreparation:'as_sold',name:'Oil',nutrients:{salt:{value:.8}}},s).flags.find(f=>f.key==='salt').classification,null);
assert.equal(M.risks({...fixture,categoryTag:'en:infant-formula'},s).flags[0].classification,null);
assert.equal(M.risks(fixture,s).testing.label,'No product test data');assert.equal(M.risks(fixture,s).energy.classification,null);
assert.deepEqual(json(M.plants(fixture).names),['peanut']);assert.equal(M.plants(fixture).known,true);
assert.deepEqual(json(M.plants({ingredients:'Rapeseed oil, corn starch, sugar. May contain peanuts.'}).names),[]);
assert.equal(M.plants({}).known,false);assert.equal(M.plants({ingredients:'Mixed nuts.'}).known,false);
assert.equal(M.plants({ingredients:'Unidentified vegetables.'}).known,false);
assert.deepEqual(json(M.plants({ingredientItems:[{text:'Peanuts'}]}).names),['peanut']);assert.equal(M.plants({ingredientItems:[{text:'Peanuts'}]}).known,false);
assert.deepEqual(json(M.plants({ingredients:'Hemp seeds.',ingredientPlants:[{name:'hemp',evidence:'Hemp seeds'}]}).names),['hemp']);
assert.equal(M.plants({ingredients:'Peanuts',ingredientsNeedsReview:true}).known,false);
const reviewed={...fixture,reviewedPlants:{source:'confirmed-diary',names:[],known:true,evidence:[]}};
assert.deepEqual(json(M.plants(reviewed).names),[]);assert.equal(M.plants(reviewed).known,true);
assert.deepEqual(json(M.plants({...reviewed,reviewedPlants:{source:'photo-extraction',names:[],known:true}}).names),['peanut']);
const day='2026-10-02',entry=(id,more={})=>({id,name:'Food',day,portions:1,plants:[],energyPerPortion:null,proteinPerPortion:null,fibrePerPortion:null,...more});
const state={foodLog:{entries:[entry('baseline',{proteinPerPortion:82,energyPerPortion:1420,fibrePerPortion:17,plants:['oats']})],plantGoal:30},nutritionProfile:{saved:true,age:55,care:'clinical',target:140,calorieTarget:2400,fibreTarget:30}};
let projected=M.projection(state,day,fixture,s);close(projected.protein.total,85.96);close(projected.energy.total,1512.85);close(projected.fibre.total,18.365);
assert.equal(projected.protein.target,140);assert.equal(projected.energy.target,2400);assert.equal(projected.fibre.target,30);assert.equal(projected.weekly.total,2);assert.deepEqual(json(projected.weekly.newNames),['peanut']);
state.foodLog.entries.push(entry('earlier',{day:'2026-09-28',plants:['peanuts','peanut']}),entry('old',{day:'2026-09-27',plants:['almond']}),entry('future',{day:'2026-10-03',plants:['rice']}));
projected=M.projection(state,day,fixture,twice);assert.equal(projected.weekly.logged,2);assert.equal(projected.weekly.total,2);assert.deepEqual(json(projected.weekly.newNames),[]);assert.equal(projected.weekly.weekStart,'2026-09-28');
const historical={foodLog:{entries:[entry('today-peanut',{plants:['peanut']}),entry('next-week',{day:'2026-10-05',plants:['rice']})]}};
const historicalWeek=M.projection(historical,'2026-10-01',fixture,s,{asOfDay:day}).weekly;
assert.equal(historicalWeek.logged,1);assert.deepEqual(json(historicalWeek.newNames),[]);assert.equal(historicalWeek.total,1);assert.equal(historicalWeek.weekEnd,'2026-10-04');
const unknownBaseline={foodLog:{entries:[entry('incomplete-plants',{sourceMeta:{entryKind:'product-consumption',plantKnowledge:'unknown'}})]}};
assert.equal(M.projection(unknownBaseline,day,fixture,s).weekly.known,false);assert.equal(M.projection(unknownBaseline,day,fixture,s).weekly.unknownEntries,1);
assert.equal(M.projection(unknownBaseline,day,fixture,s).weekly.total,1);
state.foodLog.entries.push(entry('confirmed',{energyPerPortion:nutrition15.energyKcal,proteinPerPortion:nutrition15.protein,fibrePerPortion:nutrition15.fibre,plants:['peanut']}));
const excluded=M.projection(state,day,fixture,s,{entryId:'confirmed'});close(excluded.protein.total,85.96);
const before=JSON.stringify(state);M.projection(state,day,fixture,s);assert.equal(JSON.stringify(state),before);
const missing=M.projection({foodLog:{entries:[entry('unknown')]}},day,{},M.createPortion({}));assert.equal(missing.protein.logged,null);assert.equal(missing.protein.portion,null);assert.equal(missing.protein.total,null);assert.equal(missing.protein.target,null);assert.equal(missing.weekly.known,false);assert.equal(missing.weekly.total,0);
state.foodLog.entries.push(entry('partial'));assert.equal(M.projection(state,day,fixture,s).protein.unknownEntries,1);
state.foodLog.entries=state.foodLog.entries.filter(e=>e.id!=='confirmed'&&e.id!=='earlier');assert.equal(M.projection(state,day,fixture,s).weekly.newNames.length,1);
console.log('PASS: canonical household conversions and restoration, food-specific measures, prepared/volume fallback, unrounded fixture math, invalid amounts, honest score provenance, allergy wording, UK food/drink threshold boundaries, dated projections and canonical plant deduplication.');

// A printed pack amount can support portions even when no nutrition panel was captured.
const frontOnly={name:'Front-only pack',basisUnit:null,packAmount:250,packUnit:'ml',ingredients:'Water, oats',nutritionPreparation:'unknown'};
const frontMeasures=M.measures(frontOnly);assert.equal(frontMeasures.options.find(x=>x.id==='pack').factor,250);assert.equal(frontMeasures.unit,'ml');
const frontPortion=M.setAmount(frontOnly,M.switchMeasure(frontOnly,M.createPortion(frontOnly),'pack'),.5);assert.equal(frontPortion.canonicalAmount,125);assert.equal(M.portionNutrients(frontOnly,frontPortion).energyKcal,null);assert.equal(M.score(frontOnly).value,null);

assert.deepEqual(json(sandbox.WmdFoodLog.names(['raisin','grape','sultanas','grapes'])),['grape']);
