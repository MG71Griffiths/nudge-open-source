import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {catalogueRecordFromPayload} from '../src/food-catalogue.js';
import {scoreDirectionalProduct} from '../src/product-score.js';
import {DirectionalScoreCore as core,ScoreCore} from '../src/nutrition-core.js';

const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-directional-whole-fruit-alias-products.json',import.meta.url),'utf8'));
const record=code=>fixture.records.find(r=>r.barcode===code);
const product=code=>{const r=record(code);return catalogueRecordFromPayload({product:r.raw},code,r.sourceFetchedAt).product;};

test('source-backed whole-fruit varieties retain qualifying fruit without accepting provider estimates above100%',()=>{
 for(const code of ['00035309','03249536','03266151','10066140','4088600161150','5000169542613']){
  const p=product(code),before=structuredClone(p),rawBefore=structuredClone(record(code).raw),score=scoreDirectionalProduct(p);
  assert.equal(score.value,100,code);assert.equal(score.inputs.fvlPercent,100,code);
  assert.equal(score.inputs.fvlSource,'supported-single-whole-fruit-identity',code);
  assert.equal(score.inferredInputs.fvlPercent,undefined,code);
  assert.equal(score.classifierVersion,'food-evidence-2026-10-11-v16');
  const withoutProvider=structuredClone(p);delete withoutProvider.providerNutriScore;
  assert.equal(scoreDirectionalProduct(withoutProvider).inputs.fvlPercent,100,'Identity is independent of the provider score');
  assert.deepEqual(p,before);assert.deepEqual(record(code).raw,rawBefore);
 }
 const chips=product('5059604645716');assert.equal(core.wholeFruitIdentity(chips),null);
 assert.equal(scoreDirectionalProduct(chips).value,75,'Processed apple chips are not promoted by whole-fruit identity');
});

test('finite produce aliases require the same single fruit in independently retained ingredients or taxonomy',()=>{
 const cases=[
  ['British Cox Apples','apple'],['Scottish Red Cherries','cherry'],['Mini Bananas','banana'],
  ['Braeburn Apples','apple'],['Gala apples','apple'],['Granny Smith apples','apple'],['Jazz apples','apple'],['Envy apples','apple'],
  ['PINK LADY® APPLES','apple'],['Organic red apples','apple'],['Frozen Organic Braeburn Apples','apple'],
  ['Red seedless grapes','grape'],['Seedless black grapes','grape'],['White Seedless Grapes','grape'],['Green grapes','grape'],
  ['Dark sweet cherries','cherry'],['Frozen sweet cherries','cherry'],['Kiwi fruit','kiwi'],['Kiwifruits','kiwi']
 ];
 for(const [name,fruit] of cases){
  const p={sourceName:'Open Food Facts',name,ingredients:fruit,ingredientItems:[{text:fruit}]};
  assert.equal(core.wholeFruitIdentity(p)?.name,fruit,name);
  assert.equal(core.wholeFruitIdentity({...p,ingredients:null,ingredientItems:[],categories:['en:'+fruit]})?.name,fruit,name+' taxonomy');
  assert.equal(core.wholeFruitIdentity({...p,ingredients:null,ingredientItems:[]}),null,name+' name alone');
  assert.equal(core.wholeFruitIdentity({...p,ingredients:fruit+', sugar'}),null,name+' compound ingredients');
  assert.equal(core.wholeFruitIdentity({...p,ingredientItems:[{text:fruit,percent:80}]}),null,name+' incomplete declared share');
 }
 assert.equal(ScoreCore.Legacy.wholeFruitIdentity({sourceName:'Open Food Facts',name:'Braeburn Apples',ingredients:'Apple'}),null,'Historical classifier is frozen');
});

test('produce aliases never strip processed food, oil, supplement or mixed-food wording',()=>{
 const p={sourceName:'Open Food Facts',ingredients:'Apple',categories:['en:apples']};
 for(const name of ['Braeburn Apple juice','British Cox apple flavoured yoghurt','Granny Smith apple oil','Apple supplement',
  'Braeburn apple extract','Braeburn apple powder','Braeburn apples and pears','Sweetened cherries','Dark sweet cherry syrup',
  'Red seedless grape oil','Mini banana smoothie','Frozen apple chips','Frozen dried apples','Unknown variety apples','Not apples']){
  assert.equal(core.wholeFruitIdentity({...p,name}),null,name);
 }
 const recognised={...p,name:'Braeburn Apples',ingredientItems:[{text:'Apple'}]};
 for(const extra of [{categories:['en:apple-juice']},{categories:['en:fruit-oils']},{categories:['en:dried-apples']},
  {ingredients:'Pear'},{ingredientItems:[{text:'Pear'}]},{ingredientsNeedsReview:true},{unresolvedFields:['identity']},
  {scoringFacts:{isBeverage:true}},{scoringFacts:{isFatOilNutsSeeds:true}}]){
  assert.equal(core.wholeFruitIdentity({...recognised,...extra}),null,JSON.stringify(extra));
 }
});

test('recognized fruit taxonomy ancestry is one-way and never resolves contradictory ingredients',()=>{
 for(const [name,fruit,ancestor] of [['Nectarines','nectarine','peach'],['Watermelons','watermelon','melon']]){
  const p={sourceName:'Open Food Facts',name,ingredients:fruit,ingredientItems:[{text:fruit}],categories:['en:'+ancestor,'en:fresh-'+ancestor,'en:'+fruit]};
  assert.equal(core.wholeFruitIdentity(p)?.name,fruit);
  assert.equal(core.wholeFruitIdentity({...p,ingredients:ancestor}),null,'Related fruit is not the same ingredient');
  assert.equal(core.wholeFruitIdentity({...p,name:ancestor,ingredients:ancestor,ingredientItems:[],categories:['en:'+fruit]}),null,'The relationship is not reversible');
  assert.equal(core.wholeFruitIdentity({...p,categories:['en:pears']}),null,'Unrelated fruit remains conflicting');
 }
 assert.equal(core.wholeFruitIdentity({sourceName:'Open Food Facts',name:'Kiwi',ingredients:'Kiwifruit',categories:['en:kiwifruits']})?.name,'kiwi');
});

test('complete declared vegetable aliases count only supported eligible ingredients and preserve source facts',()=>{
 for(const code of ['20242152','5010251733911','5016143005630']){
  const p=product(code),before=structuredClone(p),score=scoreDirectionalProduct(p);
  assert.equal(score.inputs.fvlPercent,100,code);assert.equal(score.inputs.fvlSource,'complete-declared-qualifying-ingredients',code);
  assert.equal(score.value,100,code);assert.deepEqual(p,before);
 }
 for(const ingredients of ['Bell peppers','Red Bell Peppers (100%)','Cucumbers','Cooked Beetroot']){
  assert.equal(core.declaredFvlIngredients({sourceName:'Open Food Facts',ingredients})?.lower,100,ingredients);
 }
 for(const ingredients of ['Bell pepper flavour','Bell pepper oil','Bell pepper powder','Cucumber supplement','Beetroot extract',
  'Beetroot starch','Potatoes','Sweet potatoes','Cassava','Bell peppers, unidentified ingredient']){
  assert.equal(core.declaredFvlIngredients({sourceName:'Open Food Facts',ingredients}),null,ingredients);
 }
 assert.equal(core.declaredFvlIngredients({sourceName:'Open Food Facts',ingredients:'Bell peppers (60%), water'})?.lower,60);
 assert.equal(core.declaredFvlIngredients({sourceName:'Open Food Facts',ingredients:'Bell peppers, water'}),null,'Undeclared mixture share remains unknown');
 assert.equal(core.declaredFvlIngredients({sourceName:'Open Food Facts',ingredients:'Beetroot',ingredientsNeedsReview:true}),null);
 assert.equal(ScoreCore.Legacy.declaredFvlIngredients({sourceName:'Open Food Facts',ingredients:'Beetroot'}),null);
});
