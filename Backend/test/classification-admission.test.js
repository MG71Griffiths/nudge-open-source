import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {catalogueRecordFromPayload} from '../src/food-catalogue.js';
import {scoreDirectionalProduct,stableStringify} from '../src/product-score.js';
import {DirectionalScoreCore as core,ScoreCore} from '../src/nutrition-core.js';

const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-directional-classification-admission-products.json',import.meta.url),'utf8'));
const record=code=>fixture.records.find(row=>row.barcode===code);
const product=code=>{const row=record(code);return catalogueRecordFromPayload({product:row.raw},code,row.sourceFetchedAt).product;};
const digest=value=>createHash('sha256').update(stableStringify(value)).digest('hex');
const nutrient=(value,key)=>({value,unit:key==='energyKcal'?'kcal':'g',status:'supplied'});
const food=name=>({name,brand:null,basisUnit:'g',nutritionPreparation:'as_sold',nutrients:Object.fromEntries(Object.entries({energyKcal:150,sugars:2,fat:5,saturatedFat:1,salt:.1,protein:6,fibre:2,carbohydrate:20}).map(([key,value])=>[key,nutrient(value,key)]))});

test('admission fixtures retain their exact public source binding and never change source facts',()=>{
 assert.equal(fixture.attribution,'Open Food Facts contributors');assert.equal(fixture.records.length,58);
 assert.equal(new Set(fixture.records.map(row=>row.barcode)).size,fixture.records.length);
 for(const row of fixture.records){
  assert.equal(row.raw.code,row.barcode);assert.equal(digest(row.raw),row.sourceFingerprint,row.barcode);
  assert.equal(row.sourceURL,'https://world.openfoodfacts.org/product/'+row.barcode);
  const rawBefore=structuredClone(row.raw),normalized=catalogueRecordFromPayload({product:row.raw},row.barcode,row.sourceFetchedAt),before=structuredClone(normalized.product);
  assert.deepEqual(normalized.providerPayload.product,row.raw,row.barcode+' retains the complete source row');
  core.resolveClassification(normalized.product);scoreDirectionalProduct(normalized.product);core.calculateSourceEstimate(normalized.product);
  assert.deepEqual(normalized.product,before,row.barcode+' normalized facts unchanged');assert.deepEqual(row.raw,rawBefore,row.barcode+' raw unchanged');
 }
});

test('complete real drink, meat, cheese and fat identities use their existing special profiles',()=>{
 const expected=[['0004331222902','beverage',25],['00128063','beverage',25],['0006118203630','beverage',50],['00034944','red_meat',50],['0004715144059','cheese',25],['00105132','fats_nuts_seeds',25],['00122214','red_meat',50],['00150958','red_meat',100],['00162548','fats_nuts_seeds',25],['0016410808846','red_meat',75]];
 for(const [code,category,value] of expected){const p=product(code),score=scoreDirectionalProduct(p);assert.equal(core.resolveClassification(p).category,category,code);assert.equal(score.category,category,code);assert.equal(score.value,value,code);assert.equal(score.available,true,code);assert.ok(!score.reasonCodes.includes('directional_general_fallback'),code);}
 // A drink identity does not silently rewrite the retained source's units.
 assert.equal(scoreDirectionalProduct(product('0004331222902')).inputs.basisUnit,'g');
 assert.ok(scoreDirectionalProduct(product('0004715144059')).reasonCodes.includes('provider_nutrients_estimated'),'Approximate source salt remains labelled when the cheese profile is resolved');
});

test('real ambiguous identities, contradictory categories and concentrates remain explicitly unrated',()=>{
 const expected=[['00051378','unknown','special_category_identity_unresolved'],['0015958310507','unsupported','unsupported_protein_concentrate_identity'],['0015958628695','unsupported','unsupported_protein_concentrate_identity'],['00162333','unknown','ambiguous_source_identity'],['00062004','unsupported','unsupported_protein_concentrate_identity'],['00234139','unknown','special_category_identity_unresolved'],['00576307','unsupported','unsupported_protein_concentrate_identity'],['29036738','unknown','special_category_identity_unresolved'],['0003020704439','unknown','special_category_identity_unresolved'],['0006457450375','unknown','special_category_identity_unresolved'],['00148683','unsupported','unsupported_protein_concentrate_identity'],['00153004','unknown','special_category_identity_unresolved'],['4056489620129','unknown','special_category_identity_unresolved']];
 for(const [code,category,reason] of expected){const p=product(code),score=scoreDirectionalProduct(p);assert.equal(score.available,false,code);assert.equal(score.value,null,code);assert.equal(score.category,category,code);assert.ok(score.reasonCodes.includes(reason),code);assert.equal(core.calculateSourceEstimate(p),null,code+' source estimates cannot bypass admission');}
 assert.equal(product('0004331222902').scoringFacts,undefined,'Unavailable OFF category does not manufacture false flags');
 assert.ok(core.resolveClassification(product('00234139')).conflicts.includes('negative_provider_flags_conflict_with_identity'));
 assert.ok(core.resolveClassification(product('29036738')).conflicts.includes('negative_provider_flags_conflict_with_identity'));
});

test('ordinary compound foods and powder ingredients retain general food admission',()=>{
 for(const name of ['Milk chocolate','Dark chocolate biscuits with whey','Whey protein cookies','Protein pancakes','Protein pancake mix','Protein pudding','Protein crisps','Egg protein pot','Yoghurt','Natural kefir yogurt','Protein yoghurt','Beef casserole','Roast beef sandwich','Beef noodles','Lamb stew','Peanut butter cookies','Butter beans','Pink lemonade lollies','Ice cream','Cocoa powder','Curry powder','Cheddar cheese sauce','Mozzarella pizza','Walnut bread','Granola with nuts','Beer battered fish','Rum and raisin ice cream','Wine vinegar','Water crackers','Rice protein pancakes','Rice protein bars','Rice protein isolate pancakes','Rice protein isolate bars','Protein bar with rice protein isolate','Biscuits with whey protein isolate','Sour cream dip with rice protein isolate']){
  const score=core.calculateScore(food(name));assert.equal(score.available,true,name);assert.equal(score.category,'general',name);
 }
 assert.equal(core.calculateScore(food('Cream cheese')).category,'cheese','A complete special identity is still recognised');
 assert.equal(scoreDirectionalProduct(product('00125196')).value,75,'A real protein pancake mix is an ordinary food');
 assert.equal(scoreDirectionalProduct(product('00131319')).value,100,'Psyllium powder is not automatically classified as a supplement');
 const p={...food('Chocolate biscuits'),ingredients:'Whey protein, milk, wheat flour, sugar, cocoa butter'};assert.equal(core.calculateScore(p).category,'general','Ingredient words do not classify the product profile');
});

test('concentrated protein forms cannot bypass admission through an ordinary grain word',()=>{
 for(const name of ['Organic rice protein isolate','Organic pea protein concentrate','Organic isolated rice protein','Raw rice protein isolate','Organic whey protein isolate','Organic rice protein isolate with biscuit pieces','Whey protein with biscuit pieces']){
  const result=core.calculateScore(food(name));assert.equal(result.available,false,name);assert.equal(result.category,'unsupported',name);assert.ok(result.reasonCodes.includes('unsupported_protein_concentrate_identity'),name);
 }
});

test('complete aliases and exact supplied-brand trimming do not broaden ambiguous identities',()=>{
 for(const [name,category] of [['Mozzarella','cheese'],['Mature cheddar cheese','cheese'],['Feta cheese','cheese'],['Pure spring water','water'],['Bottled water','water'],['Whole cashew nuts','fats_nuts_seeds'],['Mixed nuts','fats_nuts_seeds'],['Pure rapeseed oil','fats_nuts_seeds'],['Double cream','fats_nuts_seeds'],['Raw beef','red_meat']])assert.equal(core.resolveClassification(food(name)).category,category,name);
 for(const name of ['Pale ale','Prosecco','Tequila','Red wine']){const result=core.calculateScore(food(name));assert.equal(result.available,false,name);assert.equal(result.category,'unsupported',name);}
 for(const name of ['Kefir Protein Drink','Biotiful Kefir Protein Drink','Kefir Protein Drink by Biotiful','Kefir Protein Drink Biotiful'])assert.equal(core.resolveClassification({...food(name),brand:'Biotiful'}).category,'beverage',name);
 for(const name of ['Lemonade by Unrelated Brand','Diet Sparkling red cherry','Pure Qhey Protein Vanilla','Organic Sunflower Seeds Butter'])assert.equal(core.calculateScore({...food(name),brand:'Biotiful'}).available,false,name);
});

test('caller classifications, quoted evidence and source estimates cannot repair an explicit barcode clash',()=>{
 const p=product('00162333');
 for(const category of ['general','beverage','red_meat','cheese','fats_nuts_seeds','water']){
  assert.equal(core.calculateScore(p,{category,evidence:[],sweeteners:null,resolutions:[],conflicts:[]}).available,false,category+' direct classification');
  const classified=core.validateClassification(p,{category,evidence:[{field:'name',quote:p.name}],sweeteners:'unknown',sweetenerEvidence:[]});assert.equal(classified.category,'unknown');assert.ok(classified.conflicts.includes('ambiguous_source_identity'));
 }
 const estimated=structuredClone(p);estimated.nutrients.salt={value:.1,unit:'g',status:'estimated',relation:'~'};estimated.nutrientSources={...estimated.nutrientSources,salt:'estimate'};
 assert.equal(core.calculateSourceEstimate(estimated),null);assert.equal(scoreDirectionalProduct(estimated).available,false);
 const conflict={...food('Kefir Protein Drink'),scoringFacts:{isBeverage:false,isWater:false,isCheese:false,isFatOilNutsSeeds:false,isRedMeatProduct:false}};assert.equal(core.calculateScore(conflict).available,false,'Negative flags remain a contradiction');
 assert.equal(core.calculateScore({...food('Kefir Protein Drink'),unresolvedFields:['nutrition']}).available,false,'Existing adverse-evidence guard remains active');
});

test('directional admission changes leave the frozen legacy identity contract intact',()=>{
 const legacy=ScoreCore.Legacy;
 for(const code of ['0004331222902','00128063','0015958310507','00162333'])assert.equal(legacy.resolveClassification(product(code)).category,'unknown',code);
 assert.equal(legacy.resolveClassification(product('00234139')).category,'general');
 assert.equal(legacy.CLASSIFIER_VERSION,'food-evidence-2026-10-09-v10');
 assert.equal(core.resolveClassification(product('0004331222902')).category,'beverage');
 assert.equal(core.resolveClassification(product('0015958310507')).category,'unsupported');
});


test('source-bound compound foods preserve resolved general profiles and seed-ancestor resolutions',()=>{
 const rows=fixture.records.filter(row=>row.expectedGeneral);assert.equal(rows.length,20);
 for(const row of rows){
  const p=product(row.barcode),score=scoreDirectionalProduct(p),classification=core.resolveClassification(p);
  assert.equal(score.available,true,row.barcode+' '+p.name);assert.equal(score.category,'general',row.barcode);
  assert.equal(score.value,row.expectedGeneral.value,row.barcode);assert.equal(score.rawScore,row.expectedGeneral.rawScore,row.barcode);
  assert.ok(!score.reasonCodes.includes('special_category_identity_unresolved'),row.barcode);
  assert.ok(!classification.conflicts.includes('special_category_identity_unresolved'),row.barcode);
 }
 for(const code of ['29061808','29062102','4088600140858','5010793380611']){
  const result=core.resolveClassification(product(code));assert.equal(result.category,'general');
  assert.ok(result.resolutions.includes('pulse_identity_over_seed_ancestor'));assert.ok(result.resolutions.includes('pulse_identity_over_provider_oilseed_flag'));
 }
 assert.ok(core.resolveClassification(product('3254474027101')).resolutions.includes('cereal_identity_over_seed_ancestor'));
 for(const code of ['0010304000095','0010525455013','5010793380611','3254474027101','4088600293417'])assert.ok(scoreDirectionalProduct(product(code)).reasonCodes.includes('provider_nutrients_estimated'),code+' approximate source facts retain provenance');
});

test('primary product heads and positive ordinary taxonomy keep ingredient words out of admission',()=>{
 for(const name of ['Carrots in water','Sardines in olive oil','Tuna with spring water','Prawns with garlic butter','Cold water prawns','Cheese scones','Sour cream and chive dip','Mozzarella focaccia','Gin truffles','No beef strips']){
  const score=core.calculateScore(food(name));assert.equal(score.available,true,name);assert.equal(score.category,'general',name);
 }
 for(const [name,categoriesTags] of [['Custard creams',['en:biscuits']],['Protein strawberry',['en:yogurts']],['Beetroot and feta',['en:vegetables']]]){
  const p={...food(name),categoriesTags},score=core.calculateScore(p);assert.equal(score.available,true,name);assert.equal(score.category,'general',name);
 }
 // Positive general taxonomy cannot turn an explicit special form into a food:
 // these adversarial categories exercise both normal and caller-supplied paths.
 for(const name of ['Whey Protein','Organic rice protein isolate','Diet Sparkling red cherry','Unknown Brand Original Drinks','Unknown Brand Beef Fillet Steaks','Beef fillet steaks with soup seasoning','Soy milk with cookies','Whisky with chocolate','Olive oil with biscuit crumbs','Soy milk with rice','Olive oil with rice','Soy milk with potatoes']){
  const p={...food(name),categoriesTags:['en:sauces']};assert.equal(core.calculateScore(p).available,false,name);
  assert.equal(core.calculateScore(p,{category:'general',evidence:[],resolutions:[],conflicts:[]}).available,false,name+' direct');
  const suppliedIngredients={...p,ingredients:'Water, salt',ingredientsNeedsReview:false};
  assert.equal(core.calculateScore(suppliedIngredients).available,false,name+' additive source ingredients');
  assert.equal(core.calculateScore(suppliedIngredients,{category:'general',evidence:[],resolutions:[],conflicts:[]}).available,false,name+' direct additive source ingredients');
  const contradictorySubstitute={...p,categoriesTags:['en:cheese-substitutes']};
  assert.equal(core.calculateScore(contradictorySubstitute,{category:'general',evidence:[],resolutions:[],conflicts:[]}).available,false,name+' unrelated substitute taxonomy');
 }
 const alternative={...food('Plant Menu Soft Cheese'),brand:'Plant Menu'};
 assert.notEqual(core.resolveClassification(alternative).category,'cheese','Removing a plant brand cannot manufacture dairy identity');
 assert.equal(core.calculateScore(alternative).category,'general');
});


test('all 90 reviewed withdrawals retain exact source binding and the approved evidence outcome',()=>{
 const reviewed=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-directional-admission-withdrawals.json',import.meta.url),'utf8'));assert.equal(reviewed.records.length,90);
 for(const row of reviewed.records){
  assert.equal(digest(row.raw),row.sourceFingerprint,row.barcode);const before=structuredClone(row.raw);
  const normalized=catalogueRecordFromPayload({product:row.raw},row.barcode,row.sourceFetchedAt),p=normalized.product,facts=structuredClone(p),score=scoreDirectionalProduct(p);
  assert.deepEqual(normalized.providerPayload.product,row.raw,row.barcode+' complete source retained');
  if(row.expectedOutcome.startsWith('restore_')){
   assert.equal(score.available,true,row.barcode+' '+row.raw.product_name);assert.equal(score.category,row.expectedOutcome==='restore_beverage'?'beverage':'general',row.barcode);
   assert.equal(score.value,row.baselineValue,row.barcode+' unchanged nutrient arithmetic');
  }else{assert.equal(score.available,false,row.barcode+' '+row.reviewReason);assert.equal(score.value,null,row.barcode);}
  assert.deepEqual(p,facts,row.barcode+' normalized facts unchanged');assert.deepEqual(row.raw,before,row.barcode+' public source unchanged');
 }
});

test('explicit cheese-substitute taxonomy precedes dairy-name aliases and preserves flag conflicts',()=>{
 for(const name of ['Brie','Gouda','Feta cheese','Cheddar']){
  const p={...food(name),categoriesTags:['en:cheese-alternatives'],ingredients:'Water, coconut oil, starch',nutrients:{...food(name).nutrients,energyKcal:nutrient(500,'energyKcal'),sugars:nutrient(20,'sugars'),fat:nutrient(25,'fat'),saturatedFat:nutrient(15,'saturatedFat'),salt:nutrient(1,'salt'),protein:nutrient(20,'protein'),fibre:nutrient(0,'fibre')}},before=structuredClone(p);
  const score=core.calculateScore(p);assert.equal(score.available,true,name);assert.equal(score.category,'general',name);assert.equal(score.countProteins,false,name);assert.deepEqual(p,before);
  const conflict={...p,scoringFacts:{isCheese:true}};assert.equal(core.calculateScore(conflict).available,false,name+' contradictory animal-profile flag');
 }
});

test('declared nut majority supports only standalone butter and uses the existing fats arithmetic',()=>{
 const p={...food('ManiLife Deep Roast Crunchy Peanut Butter'),brand:'ManiLife',ingredients:'Hi-Oleic Peanuts 99.1%, Sea Salt 0.9%. Made in a factory that handles other nuts.',nutrients:Object.fromEntries(Object.entries({energyKcal:619,protein:26.4,fibre:9.1,fat:50.5,saturatedFat:6,carbohydrate:10.1,sugars:5.5,salt:.9}).map(([key,value])=>[key,nutrient(value,key)]))},before=structuredClone(p),score=core.calculateScore(p);
 assert.equal(score.category,'fats_nuts_seeds');assert.equal(score.negativePoints,7);assert.equal(score.positivePoints,5);assert.equal(score.countProteins,false);assert.equal(score.rawScore,2);assert.equal(score.value,75);assert.deepEqual(p,before);
 for(const name of ['Peanut butter bar','Peanut sauce']){const compound={...p,name,categoriesTags:['en:bars']};assert.notEqual(core.resolveClassification(compound).category,'fats_nuts_seeds',name);}
 assert.equal(core.calculateScore({...p,ingredients:'Peanuts, salt'}).available,false,'No majority is inferred from order alone');
 assert.equal(core.calculateScore({...p,ingredientsNeedsReview:true}).available,false,'Unreviewed ingredients cannot supply the majority');
});


test('standalone beef patties and a contradictory mixed lasagne cannot inherit general or meat advantages',()=>{
 for(const code of ['01832839','00632812']){const p=product(code),before=structuredClone(p),score=scoreDirectionalProduct(p);assert.equal(score.available,false,code);assert.equal(score.value,null,code);assert.deepEqual(p,before);}
 assert.ok(core.resolveClassification(product('01832839')).conflicts.includes('special_category_identity_unresolved'),'Beef patties cannot use their sandwich ancestor to escape the special-profile conflict');
 assert.ok(core.resolveClassification(product('00632812')).conflicts.includes('provider_flag_conflicts_with_identity'),'A mixed pasta dish cannot inherit a conflicting red-meat flag');
});


test('known supported cheese and ground nuts keep compatible taxonomy ancestors subordinate',()=>{
 const expected=[['20954017','cheese'],['0002000860004','cheese'],['00341042','cheese'],['00672184','cheese'],['00174398','fats_nuts_seeds'],['00174411','fats_nuts_seeds'],['00294652','fats_nuts_seeds'],['21049798','fats_nuts_seeds'],['4088600476063','fats_nuts_seeds']];
 for(const [code,category] of expected){const p=product(code),before=structuredClone(p),score=scoreDirectionalProduct(p);assert.equal(score.category,category,code);assert.equal(score.value,100,code);assert.deepEqual(p,before,code);}
 const stew=product('00486842'),before=structuredClone(stew),score=scoreDirectionalProduct(stew);assert.equal(score.available,true);assert.equal(score.category,'general');assert.equal(score.value,100);assert.ok(core.resolveClassification(stew).resolutions.includes('declared_red_meat_share_under_threshold'),'The existing recognized16% share excludes the red-meat profile before the new compound alias');assert.deepEqual(stew,before);
});


test('all144 additionally reviewed hierarchy cases preserve source, literal preparation and agreed outcomes',()=>{
 const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-directional-hierarchy-products.json',import.meta.url),'utf8'));assert.equal(fixture.records.length,144);
 for(const row of fixture.records){
  assert.equal(digest(row.raw),row.sourceFingerprint,row.barcode);const rawBefore=structuredClone(row.raw);
  const record=catalogueRecordFromPayload({product:row.raw},row.barcode,row.sourceFetchedAt),p=record.product,before=structuredClone(p),score=scoreDirectionalProduct(p);
  assert.deepEqual(record.providerPayload.product,row.raw,row.barcode+' full source retained');assert.equal(score.available,row.expectedAvailable,row.barcode+' '+p.name+' '+row.reviewReason);
  if(row.expectedAvailable){assert.equal(score.category,row.expectedCategory,row.barcode);assert.equal(score.value,row.baselineValue,row.barcode+' literal source arithmetic retained');assert.equal(score.calculationBasis.unit,p.basisUnit,row.barcode+' no density conversion');assert.equal(score.calculationBasis.preparation,p.nutritionPreparation,row.barcode+' no inferred reconstitution');}
  else assert.equal(score.value,null,row.barcode+' unresolved source remains held');
  assert.deepEqual(p,before,row.barcode+' normalized source unchanged');assert.deepEqual(row.raw,rawBefore,row.barcode+' raw source unchanged');
 }
});

test('missing taxonomy cannot turn a nut-butter ingredient suffix into a standalone fat product',()=>{
 const nutrients=Object.fromEntries(Object.entries({energyKcal:619,protein:26.4,fibre:9.1,fat:50.5,saturatedFat:6,carbohydrate:10.1,sugars:5.5,salt:.9}).map(([key,value])=>[key,nutrient(value,key)]));
 for(const [name,tag] of [['Chocolate bar with peanut butter','en:bars'],['Oat cookies with peanut butter','en:biscuits'],['Satay sauce with peanut butter','en:sauces'],['Peanut butter chocolate bar','en:bars'],['Peanut butter oat cookies','en:biscuits'],['Peanut butter satay sauce','en:sauces']]){
  const p={...food(name),ingredients:'Peanuts60%, sugar20%, cocoa butter10%, oats10%',nutrients};
  for(const variant of [p,{...p,ingredients:'Peanuts, sugar, cocoa butter, oats',ingredientItems:[{text:'Peanuts',percent:60}]},{...p,categoriesTags:[tag]},{...p,ingredients:'Peanuts50%, sugar30%, cocoa butter10%, oats10%'},{...p,ingredientsNeedsReview:true}]){
   const before=structuredClone(variant),score=core.calculateScore(variant);assert.equal(score.category,'general',name);assert.equal(score.value,25,name);assert.equal(score.rawScore,12,name);assert.deepEqual(variant,before,name);
  }
 }
});

test('named plant substitutes share complete cheese aliases across normal, quoted and direct paths',()=>{
 for(const alias of ['Brie','Gouda','Feta cheese','Cheddar','Soft Cheese']){
  const p={...food('Plant Menu '+alias),brand:'Plant Menu',ingredients:'Water, coconut oil, starch',nutrients:Object.fromEntries(Object.entries({energyKcal:500,sugars:20,fat:25,saturatedFat:15,salt:1,protein:20,fibre:0}).map(([key,value])=>[key,nutrient(value,key)]))},before=structuredClone(p);
  const score=core.calculateScore(p);assert.equal(score.category,'general',alias);assert.equal(score.value,0,alias);assert.equal(score.countProteins,false,alias);
  const quoted=core.validateClassification(p,{category:'cheese',evidence:[{field:'name',quote:p.name}],sweeteners:'unknown',sweetenerEvidence:[]});assert.notEqual(quoted.category,'cheese',alias+' quoted dairy assertion');assert.equal(core.calculateScore(p,quoted).available,false,alias+' quoted cannot reintroduce dairy');
  const direct=core.calculateScore(p,{category:'cheese',evidence:[],resolutions:[],conflicts:[]});assert.equal(direct.available,false,alias+' direct dairy assertion');assert.ok(direct.reasonCodes.includes('dairy_profile_conflicts_with_substitute'));
  assert.equal(core.calculateScore({...p,scoringFacts:{isCheese:true}}).available,false,alias+' contradictory dairy flag');assert.equal(core.calculateSourceEstimate({...p,scoringFacts:{isCheese:true}}),null,alias+' source projection cannot restore conflicting dairy');
  const dairy={...p,name:alias,brand:null,ingredients:'Milk, salt'};assert.equal(core.calculateScore(dairy).category,'cheese',alias+' true dairy control');
  assert.deepEqual(p,before,alias+' facts unchanged');
 }
});

test('source-backed cheese substitutes admit bounded style wording without a dairy profile',()=>{
 const p=product('00239639'),before=structuredClone(p),score=scoreDirectionalProduct(p);
 assert.equal(score.available,true);assert.equal(score.category,'general');assert.equal(score.value,0);assert.equal(score.rawScore,20);assert.equal(score.countProteins,false);
 assert.equal(score.inputs.nutrientBounds.sugars.relation,'lt');assert.equal(score.inputs.sugars,null,'The source inequality remains an inequality');
 const classification=category=>({category,evidence:[{field:'name',quote:p.name}],sweeteners:'unknown',sweetenerEvidence:[]});
 const quotedGeneral=core.validateClassification(p,classification('general'));assert.equal(quotedGeneral.category,'general');assert.equal(core.calculateScore(p,quotedGeneral).category,'general');
 assert.equal(core.calculateScore(p,{category:'general',evidence:[],resolutions:[],conflicts:[]}).category,'general');
 const quotedDairy=core.validateClassification(p,classification('cheese'));assert.notEqual(quotedDairy.category,'cheese');
 const directDairy=core.calculateScore(p,{category:'cheese',evidence:[],resolutions:[],conflicts:[]});assert.equal(directDairy.available,false);assert.ok(directDairy.reasonCodes.includes('dairy_profile_conflicts_with_substitute'));
 const conflict={...p,scoringFacts:{...p.scoringFacts,isCheese:true}};assert.equal(scoreDirectionalProduct(conflict).available,false);assert.equal(core.calculateSourceEstimate(conflict),null);assert.ok(core.resolveClassification(conflict).conflicts.includes('provider_flag_conflicts_with_substitute'));
 assert.deepEqual(p,before,'The complete source facts, bounds and profile flags are unchanged');
 for(const alias of ['Cheddar','Brie','Gouda']){
  for(const prefix of ['', 'Free From ', 'Deliciously Free From ']){
   const candidate={...food(prefix+alias+'-style Cheese'),categoriesTags:['en:cheese-substitutes'],ingredients:'Water, coconut oil, starch'};
   assert.equal(core.calculateScore(candidate).category,'general',candidate.name);
   assert.equal(core.calculateScore({...candidate,scoringFacts:{isCheese:true}}).available,false,candidate.name+' dairy flag conflict');
  }
  assert.equal(core.calculateScore({...food(alias),ingredients:'Milk, salt'}).category,'cheese',alias+' actual dairy identity remains');
 }
 for(const name of ['Mystery Cheddar-style Cheese','Deliciously Free From Soy milk-style Cheese'])assert.equal(core.calculateScore({...food(name),categoriesTags:['en:cheese-substitutes']}).available,false,name+' is not a complete canonical substitute form');
 assert.equal(core.calculateScore(food('Deliciously Free From Cheddar-style Cheese')).available,false,'Free From wording alone is not substitute evidence');
 for(const name of ['Macaroni with Cheddar-style Cheese','Cheddar-style Cheese pasta','Cheddar-style Cheese sauce'])assert.equal(core.calculateScore({...food(name),categoriesTags:['en:cheese-substitutes']}).category,'general',name+' remains a compound dish');
 for(const name of ['Diet Sparkling red cherry with Cheddar-style Cheese','Soy milk with Cheddar-style Cheese','Olive oil with Cheddar-style Cheese','Whey protein with Cheddar-style Cheese']){
  const candidate={...food(name),categoriesTags:['en:cheese-substitutes']};
  assert.equal(core.calculateScore(candidate,{category:'general',evidence:[],resolutions:[],conflicts:[]}).available,false,name+' cannot borrow its addition’s substitute form');
 }
});
