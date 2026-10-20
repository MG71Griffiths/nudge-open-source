import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {ScoreCore} from '../src/nutrition-core.js';
// These historical contracts document v0.3 completeness and display rules.
const core=ScoreCore.Legacy,calculateScore=core.calculateScore;
const n=(value,unit='g')=>({value,unit,status:value===null?'unknown':'supplied'});
const ingredients='Gluten Free Oats (28%), Golden Syrup (Invert Sugar Syrup), Margarine (Vegetable Oil (Palm, Rapeseed), water, Emulsifier (Mono- and Diglycerides of Fatty Acids)), Demerara Sugar, Chopped Apricots (8%) (Apricots, Sunflower Oil), Chopped Cranberries (5%) (Sugar, Cranberries, Sunflower Oil), Sultanas (5%) (Sultanas, Sunflower Oil), Pumpkin Seeds (2%), Chia Seeds (2%), Sunflower Seeds (1%).';
// Exact supplied transcription. This proves arithmetic, not extraction from an unavailable photograph.
const flapjack=()=>({name:'The Cotswold Bakery Gluten Free & Vegan Fruit Flapjack',sourceName:'Photographed label',categoryTag:'en:flapjacks',basisUnit:'g',nutritionPreparation:'as_sold',ingredients,ingredientsNeedsReview:false,energyKj:n(1699,'kJ'),nutrients:Object.fromEntries(Object.entries({energyKcal:405,fat:17.5,saturatedFat:6.1,carbohydrate:52.9,sugars:35.8,protein:5.4,salt:.39,fibre:null}).map(([k,v])=>[k,n(v,k==='energyKcal'?'kcal':'g')]))});
test('v0.3 flapjack refuses missing essential fibre and preserves source FVL uncertainty',()=>{
 const p=flapjack(),before=JSON.stringify(p),s=calculateScore(p);
 assert.equal(s.methodId,'nudge_nutrition_v0_3');assert.equal(s.value,null);assert.equal(s.status,'unrated');
 assert.deepEqual(s.missingInputs,['fibre']);assert.equal(s.inputs.fibre,null);assert.equal(s.inputs.fvlPercent,null);assert.equal(s.inputs.fvlBounds.upper,200*18/118);
 assert.equal(JSON.stringify(p),before);
});
test('verified fibre and point-invariant ingredient bounds permit a fixed grade; portions never change it',()=>{
 const p=flapjack();p.nutrients.fibre=n(5.3);const complete=calculateScore(p);assert.equal(complete.status,'rated');assert.equal(complete.value,0);assert.equal(complete.rawScore,19);assert.equal(complete.grade,'E');
 assert.equal(complete.inputs.fvlPercent,null);assert.equal(complete.components.positive.find(c=>c.id==='fvl').points,0);assert.ok(complete.reasonCodes.includes('point_invariant_ingredient_bounds'));assert.equal(complete.components.positive.find(c=>c.id==='fvl').quantityIsExact,false);
 assert.deepEqual(calculateScore({...p,selectedPortion:15}),calculateScore({...p,selectedPortion:60}));
 p.energyKj=n(1200,'kJ');p.nutrients.saturatedFat=n(4.1);p.nutrients.sugars=n(28);p.nutrients.fibre=n(null);
 assert.equal(calculateScore(p).value,null,'The previous consumer interval is superseded by essential-input recovery');
});
test('missing negative inputs, preparation/category ambiguity and contradictions suppress numbers',()=>{
 for(const key of ['salt','sugars','saturatedFat']){const p=flapjack();p.nutrients[key]=n(null);const s=calculateScore(p);assert.equal(s.status,'unrated');assert.equal(s.value,null);}
 const noEnergy=flapjack();noEnergy.energyKj=null;noEnergy.nutrients.energyKcal=n(null,'kcal');assert.equal(calculateScore(noEnergy).status,'unrated');
 for(const p of [{...flapjack(),categoryTag:null},{...flapjack(),nutritionPreparation:'prepared'},{...flapjack(),basisUnit:null}])assert.equal(calculateScore(p).status,'unrated');
 const bad=flapjack();bad.nutrients.sugars=n(90);assert.equal(calculateScore(bad).status,'unrated');
});
test('incomplete or unknown ingredient words cannot award a plant bonus',()=>{
 for(const p of [{...flapjack(),ingredientsNeedsReview:true},{...flapjack(),ingredients:ingredients+', unknown ingredient'},{...flapjack(),ingredients:ingredients.replace('Chopped Apricots (8%)','Chopped Apricots')}]){
  p.nutrients.fibre=n(5.3);const s=calculateScore(p);assert.equal(s.inputs.fvlPercent,null);assert.equal(s.inputs.fvlBounds,null);
  assert.equal(s.value,null);assert.equal(s.grade,null);assert.equal(s.status,'unrated');assert.equal(s.displayLower,s.displayUpper);
 }
});
test('category-correct fixed scores use colour bands without frequency labels',()=>{
 for(const [raw,expected]of [[22,0],[17,25],[10,50],[2,75],[0,100]])assert.equal(core.displayFor(raw),expected);
 for(const [value,expected]of [[0,'Red'],[25,'Red'],[50,'Amber'],[75,'Green'],[100,'Green']])assert.equal(core.bandFor(value).label,expected);
 for(const value of [39,40,69,70])assert.equal(core.bandFor(value),null);
 assert.equal(core.CONFIG.version,'0.3');assert.equal(core.CONFIG.offset,undefined);
});
test('browser and backend execute identical core, retain unknowns and gluten-free oat wording',()=>{
 const sandbox={};sandbox.window=sandbox;vm.createContext(sandbox);
 for(const file of ['core/nudge-score.js','food-detail-model.js']){vm.runInContext(readFileSync(new URL('../../Web/'+file,import.meta.url),'utf8'),sandbox);if(file==='core/nudge-score.js')sandbox.NudgeScoreCore=sandbox.NudgeScoreCore.Legacy;}
 const a=calculateScore(flapjack()),b=sandbox.NudgeScoreCore.calculateScore(flapjack());assert.deepEqual(JSON.parse(JSON.stringify(b)),a);
 const model=sandbox.NudgeFoodDetailModel;const displayProduct={...flapjack(),packAmount:60,packUnit:'g'};const portion=model.createPortion(displayProduct);assert.equal(portion.canonicalAmount,30);assert.equal(portion.measureId,'pack');assert.equal(model.measures(displayProduct).options.find(m=>m.id==='pack').step,.25);assert.equal(model.measures({...displayProduct,servingAmount:20}).startingCanonical,20);assert.deepEqual(Array.from(model.plants(displayProduct).names).sort(),['apricot','chia','cranberry','grape','oats','pumpkin','sunflower']);for(const grams of [15,30,60]){const nutrients=model.portionNutrients(displayProduct,{...portion,canonicalAmount:grams});assert.equal(nutrients.energyKcal,405*grams/100);assert.equal(nutrients.fibre,null);}const displayed=sandbox.NudgeFoodDetailModel.score(flapjack());assert.equal(displayed.value,null);assert.equal(displayed.displayUpper,null);assert.equal(displayed.calculationBasis.per,100);
 const allergy=sandbox.NudgeFoodDetailModel.allergies({...flapjack(),manufacturingAdvice:'Produced in a factory that handles Nuts, Eggs, Soya and Milk.'},{avoids:['gluten','milk']});
 assert.equal(allergy.contains.some(x=>/gluten|milk/i.test(x)),false);assert.equal(allergy.conflicts.some(x=>x.preference==='gluten'),false);assert.equal(allergy.conflicts.some(x=>x.type==='manufacturing'&&x.preference==='milk'),true);
});

test('decimal boundary comparisons remove machine noise without rounding real source differences',()=>{
 assert.equal(core.pointsFor(.34*100/10,core.TABLES.sugars),0);
 assert.equal(core.pointsFor(3.4+1e-9,core.TABLES.sugars),1);
 assert.equal(core.pointsFor(9.999999999999998,core.TABLES.saturateRatio,true),1);
 assert.equal(core.pointsFor(10-1e-9,core.TABLES.saturateRatio,true),0);
});
test('positive nutrient inequalities stay unknown and require exact source values',()=>{
 for(const relation of ['<','>','>=']){
  const p=flapjack();p.nutrients.fibre={value:4.1,unit:'g',status:'supplied',relation};
  const result=calculateScore(p);assert.equal(result.inputs.fibre,null);assert.equal(result.value,null);assert.equal(result.status,'unrated');
 }
});
test('fats use their own FVL oil rule; unspecified oil cannot prove eligible-oil absence',()=>{
 const p={...flapjack(),name:'Olive oil',categoryTag:'en:olive-oils',ingredients:'Extra virgin olive oil',nutrients:{fat:n(100),saturatedFat:n(14),sugars:n(0),salt:n(0),fibre:n(0),protein:n(0)}};
 const olive=calculateScore(p);assert.equal(olive.category,'fats_nuts_seeds');assert.equal(olive.inputs.fvlPercent,100);assert.equal(olive.components.positive.find(c=>c.id==='fvl').points,5);
 const unknown=calculateScore({...p,ingredients:'Vegetable oil'});assert.equal(unknown.inputs.fvlPercent,null);assert.equal(unknown.status,'unrated');
 const seed=calculateScore({...p,name:'Rapeseed oil',categoryTag:'en:rapeseed-oils',ingredients:'Rapeseed oil'});assert.equal(seed.inputs.fvlPercent,0);assert.equal(seed.status,'rated');
});
test('declared gluten-free wholegrain oats remain an excluded FVL cereal, never a scoring bonus',()=>{
 assert.equal(core.ingredientFvlBounds({ingredients:'Gluten-free wholegrain oats (80%), water (20%)',ingredientsNeedsReview:false}).upper,0);
 const oat={...flapjack(),name:'Porridge',categoryTag:'en:porridge',ingredients:'Gluten-free wholegrain oats (80%), water (20%)'};
 assert.equal(calculateScore(oat).value,calculateScore({...oat,ingredients:'Wholegrain oats (80%), water (20%)'}).value);
});

test('unresolved source conflicts block dependent scores and are not erased by retained old values',()=>{
 for(const field of ['identity','nutrition','preparation']){const s=calculateScore({...flapjack(),unresolvedFields:[field]});assert.equal(s.status,'unrated');assert.equal(s.value,null);assert.match(s.reason,/Conflicting/);}
 const ingredients=calculateScore({...flapjack(),unresolvedFields:['ingredients']});assert.equal(ingredients.inputs.fvlBounds,null);assert.equal(ingredients.displayUpper,null);
 const claims=calculateScore({...flapjack(),unresolvedFields:['claims']});assert.equal(claims.value,null,'A claim is separate from nutrient points');
});
