import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {classifyWomensFoodTags,WOMENS_FOOD_TAG_VERSION,WOMENS_FOOD_CONTEXTS} from '../src/womens-food-tags.js';
import rulebook from '../data/womens-food-tagging.v1.json' with {type:'json'};

const product = (name,extra={}) => ({product_name:name,...extra});
const tags = value => classifyWomensFoodTags(value);
const ids = value => tags(value).map(tag=>tag.id);
const get = (value,id) => tags(value).find(tag=>tag.id===id);
const has = (value,...wanted) => {for(const id of wanted) assert.ok(ids(value).includes(id),`${value.product_name} should include ${id}: ${ids(value)}`);};
const lacks = (value,...unwanted) => {for(const id of unwanted) assert.ok(!ids(value).includes(id),`${value.product_name} should omit ${id}`);};
const nutrients = (name,values,extra={}) => product(name,{serving_size:'100 g',serving_quantity:100,serving_quantity_unit:'g',nutriments:values,...extra});

describe('public women’s food candidate classification',()=>{
  it('has a stable explicit version and public filter contexts',()=>{
    assert.equal(WOMENS_FOOD_TAG_VERSION,'womens-food-candidates-v1-2026-10-08');
    assert.deepEqual(WOMENS_FOOD_CONTEXTS,['period','follicular','ovulation','luteal','perimenopause','postmenopause']);
  });
  it('keeps banana useful with unknown micronutrients without calling B6 measured or treating PMS',()=>{
    const banana=product('Organic bananas',{categories_tags:['en:bananas']});
    has(banana,'plant_food_option','b6_premenstrual_candidate');
    lacks(banana,'iron_contribution','protein_contribution','vitamin_c_iron_pairing');
    const b6=get(banana,'b6_premenstrual_candidate');
    assert.equal(b6.foodDataConfidence,'source_reported_identity');
    assert.equal(b6.evidence,'research_only');
    assert.deepEqual(b6.contexts,['luteal']);
    assert.match(b6.limitations.join(' '),/not verified/);
  });
  it('uses substantial declared pulse identity and does not copy generic nutrient values',()=>{
    const beans=product('Baked beans',{categories_tags:['en:baked-beans'],ingredients_text:'Beans (51%), water, tomatoes, sugar, salt'});
    has(beans,'pulse_satisfying_candidate','magnesium_premenstrual_candidate','folate_food_adequacy_candidate','plant_food_option');
    lacks(beans,'iron_contribution','fibre_contribution','protein_contribution');
    has(product('Chickpeas',{ingredients_text:'Chickpeas (60%), water, salt'}),'b6_premenstrual_candidate','pulse_satisfying_candidate');
    has(product('Cooked lentils',{ingredients_text:'Lentils, water'}),'zinc_premenstrual_candidate','folate_food_adequacy_candidate');
  });
  it('does not confuse coffee, cocoa, vanilla, jelly or green beans with pulse candidates',()=>{
    for(const name of ['Coffee beans','Cocoa beans','Vanilla beans','Jelly beans','Green beans','Chickpea flour','Dried lentils','Chickpea crisps']) lacks(product(name),'pulse_satisfying_candidate');
  });
  it('keeps oily-fish candidates without pretending EPA/DHA or bones were measured',()=>{
    const sardines=product('Sardines in spring water',{categories_tags:['en:sardines'],ingredients_text:'Sardines (75%), water, salt'});
    has(sardines,'period_omega3_research','b12_food_adequacy_candidate');
    lacks(sardines,'calcium_contribution','vitamin_d_contribution','protein_contribution');
    assert.deepEqual(get(sardines,'period_omega3_research').contexts,['period']);
    assert.match(get(sardines,'period_omega3_research').wording,/supplements/);
    lacks(product('Tuna in water'),'period_omega3_research');
    lacks(product('Ground linseed'),'period_omega3_research');
    has(product('Salmon fillet'),'period_omega3_research','b6_premenstrual_candidate');
  });
  it('treats soy identity, fortification and individual nutrient amounts independently',()=>{
    const plain=product('Unsweetened soya drink',{ingredients_text:'Water, soya beans (8.7%), salt',product_quantity_unit:'ml',serving_size:'250 ml'});
    has(plain,'soy_hot_flush_research');
    lacks(plain,'calcium_contribution','vitamin_d_contribution','b12_food_adequacy_candidate');
    const fortified={...plain,product_name:'Unsweetened fortified soya drink',ingredients_text:'Water, soya beans (8.7%), calcium carbonate, vitamin D2, vitamin B12',nutriments:{calcium_100g:0.12,'vitamin-d_100g':0.00000075,proteins_100g:3.3}};
    has(fortified,'soy_hot_flush_research','calcium_contribution','vitamin_d_contribution','b12_food_adequacy_candidate','premenstrual_calcium_candidate');
    lacks(fortified,'protein_contribution'); // 8.25 g in declared serving, not 10 g.
    lacks({...plain,nutriments:fortified.nutriments},'calcium_contribution','vitamin_d_contribution');
    lacks({...fortified,ingredients_text:'Water, soya beans (8.7%), calcium carbonate'},'b12_food_adequacy_candidate');
  });
  it('does not transfer soy hypotheses to sauces, lecithin, trace allergens or desserts',()=>{
    for(const value of [product('Soy sauce',{ingredients_text:'Water, soya beans (12%), salt, wheat'}),product('Chocolate soy dessert',{categories_tags:['en:soy-drinks'],ingredients_text:'Sugar, water, soy (1%)'}),product('Chocolate biscuit',{ingredients_text:'Flour, sugar, soy lecithin. May contain soya.'})]) lacks(value,'soy_hot_flush_research');
    has(product('Tofu',{ingredients_text:'Water, soybeans (25%), magnesium chloride'}),'soy_hot_flush_research');
    has(product('Calcium-set tofu',{ingredients_text:'Water, soybeans (25%), calcium sulphate'}),'soy_hot_flush_research');
  });
  it('keeps ginger, linseed and chocolate hypotheses visible but excludes trace and flavoured composites',()=>{
    has(product('Fresh ginger'),'ginger_period_comfort_candidate');
    has(product('Ginger infusion',{ingredients_text:'Ginger (70%), lemon peel (30%)'}),'ginger_period_comfort_candidate');
    has(product('Ground linseed',{ingredients_text:'Linseed (100%)'}),'flax_hot_flush_candidate','soluble_fibre_option');
    has(product('Dark chocolate 70%',{ingredients_text:'Cocoa mass, sugar, cocoa butter'}),'dark_chocolate_comfort_candidate');
    for(const value of [product('Ginger biscuits',{ingredients_text:'Wheat flour, sugar, ginger (2%)'}),product('Ginger tea',{ingredients_text:'Black tea, ginger flavouring (1%)'}),product('Ginger beer'),product('Ginger dessert',{ingredients_text:'Water, ginger (60%)'}),product('Flaxseed chocolate cookie',{ingredients_text:'Wheat flour, sugar, flaxseed (1%)'}),product('Dark chocolate cake',{ingredients_text:'Flour, dark chocolate (10%)'}),product('Banana flavoured milk',{categories_tags:['en:bananas'],ingredients_text:'Milk, sugar, banana flavouring'})]) {
      lacks(value,'ginger_period_comfort_candidate','flax_hot_flush_candidate','dark_chocolate_comfort_candidate','b6_premenstrual_candidate');
    }
    assert.equal(get(product('Ground linseed'),'flax_hot_flush_candidate').evidenceDirection,'mixed_or_null');
    assert.match(get(product('Ground linseed'),'flax_hot_flush_candidate').wording,/not shown a reliable benefit/);
  });
  it('rejects marketing/category and tiny ingredient evidence even when an estimated percentage is large',()=>{
    const misleading=product('Banana cream dessert',{categories_tags:['en:bananas'],ingredients:[{id:'en:banana',text:'Banana',percent:1,percent_estimate:90}]});
    assert.deepEqual(tags(misleading),[]);
    const nested=product('Snack bar',{ingredients:[{id:'en:filling',text:'Fruit filling',percent:5,ingredients:[{id:'en:banana',text:'Banana',percent:100}]}],ingredients_text:'Fruit filling (banana 100%) (5%), wheat flour, sugar'});
    lacks(nested,'b6_premenstrual_candidate','plant_food_option');
    lacks(product('Banana',{ingredients_text:'Sugar, banana (2%)'}),'b6_premenstrual_candidate');
    lacks(product('Mango drink',{categories_tags:['en:bananas']}),'b6_premenstrual_candidate');
    lacks(product('Banana bread',{categories_tags:['en:bananas']}),'b6_premenstrual_candidate');
    lacks(product('Banana yoghurt',{categories_tags:['en:bananas']}),'b6_premenstrual_candidate');
    lacks(product('Chocolate coated almonds',{categories_tags:['en:almonds']}),'magnesium_premenstrual_candidate');
  });
  it('supports ordinary wholegrains and nuts and retains evidence qualifications',()=>{
    for(const value of [product('Porridge oats',{ingredients_text:'Oats (100%)'}),product('Wholemeal bread',{ingredients_text:'Wholemeal wheat flour (65%), water, yeast, salt'}),product('Brown rice'),product('Wholegrain pasta',{ingredients_text:'Wholegrain durum wheat semolina'})]) has(value,'wholegrain_premenstrual_candidate');
    has(product('Pumpkin seeds'),'magnesium_premenstrual_candidate','zinc_premenstrual_candidate');
    has(product('Almonds'),'magnesium_premenstrual_candidate');
    has(product('Walnuts'),'walnuts_sleep_candidate');
    lacks(product('Brown bread'),'wholegrain_premenstrual_candidate');
    lacks(product('Oat biscuit',{ingredients_text:'Wheat flour, oats (5%)'}),'wholegrain_premenstrual_candidate');
  });
  it('keeps green-kiwi bowel evidence separate from weaker sleep evidence and mixed berries',()=>{
    has(product('Green kiwifruit'),'kiwifruit_bowel_candidate','kiwifruit_sleep_candidate');
    has(product('Kiwifruit'),'kiwifruit_sleep_candidate');
    lacks(product('Kiwifruit'),'kiwifruit_bowel_candidate');
    has(product('Prunes'),'prunes_bowel_candidate','prunes_bone_candidate');
    has(product('Blueberries'),'berries_cognitive_ageing_candidate');
    has(product('Mixed berries'),'berries_cognitive_ageing_candidate');
    has(product('Baby spinach'),'folate_food_adequacy_candidate','plant_food_option');
    lacks(product('Blueberry muffin',{ingredients_text:'Flour, blueberries (5%)'}),'berries_cognitive_ageing_candidate');
  });
  it('requires culture evidence and separates dairy from coconut yoghurt or water kefir',()=>{
    const plain=product('Plain yoghurt',{ingredients_text:'Milk, yoghurt cultures'});
    has(plain,'b12_food_adequacy_candidate');
    lacks(plain,'fermented_milk_gut_candidate');
    has({...plain,ingredients_text:'Milk, live cultures'},'fermented_milk_gut_candidate');
    has(product('Milk kefir',{ingredients_text:'Pasteurised milk, kefir cultures'}),'kefir_bowel_candidate');
    lacks(product('Water kefir'),'kefir_bowel_candidate');
    lacks(product('Coconut yoghurt'),'b12_food_adequacy_candidate','fermented_milk_gut_candidate');
    lacks(product('Raw milk kefir'),'kefir_bowel_candidate');
  });
  it('keeps lower-caffeine replacements conditional and never infers caffeine-free from missing data',()=>{
    has(product('Decaf coffee'),'lower_caffeine_option');
    lacks(product('Coffee'),'lower_caffeine_option');
    assert.match(get(product('Decaf coffee'),'lower_caffeine_option').limitations.join(' '),/Decaf may still contain caffeine/);
    has(product('Still water'),'hydration_bowel_candidate');
    lacks(product('Sparkling water'),'hydration_bowel_candidate');
  });
  it('does not apply whole-meal or whole-diet effects to a single product',()=>{
    for(const value of [product('Walnuts'),product('Olive oil'),product('Plain yoghurt'),product('Mixed berries')]) lacks(value,'satisfying_option','easy_regular_meal_candidate','plant_ferment_stress_pattern_candidate','mediterranean_mood_pattern_candidate');
  });
});

describe('source-reported nutrient contributions and public payload boundaries',()=>{
  it('applies exact editorial thresholds to compatible source values and the declared portion',()=>{
    const lentils=nutrients('Cooked lentils',{iron_100g:0.003,proteins_100g:9,fiber_100g:8},{serving_size:'150 g',serving_quantity:150});
    has(lentils,'iron_contribution','protein_contribution','fibre_contribution');
    const iron=get(lentils,'iron_contribution');
    assert.equal(iron.foodDataConfidence,'source_reported_nutrients');
    assert.match(iron.limitations[0],/150 g/);
    assert.match(iron.limitations[0],/not independently verified/);
    assert.ok(!iron.contexts.includes('postmenopause'));
    const small={...lentils,serving_size:'30 g',serving_quantity:30};
    lacks(small,'iron_contribution','protein_contribution','fibre_contribution');
    has(small,'pulse_satisfying_candidate');
  });
  it('uses standardized OFF grams, not the originally entered unit, for legacy micronutrients',()=>{
    const milk=nutrients('Milk',{calcium_100g:0.12,calcium_unit:'mg'},{product_quantity_unit:'ml',serving_size:'250 ml',serving_quantity:250,serving_quantity_unit:'ml'});
    has(milk,'calcium_contribution','premenstrual_calcium_candidate');
    lacks({...milk,nutriments:{calcium_100g:120,calcium_unit:'mg'}},'calcium_contribution'); // Not normalized; cannot silently guess.
  });
  it('does not treat missing, null, empty, boolean, invalid or less-than nutrients as zero or qualifying facts',()=>{
    for(const value of [undefined,null,'',false,true,'a lot',Infinity,-1]) lacks(nutrients('Cooked beans',{proteins_100g:value}),'protein_contribution');
    lacks(nutrients('Cooked beans',{proteins_100g:15,proteins_modifier:'<'}),'protein_contribution');
    lacks(nutrients('Cooked beans',{proteins_100g:15},{no_nutrition_data:'on'}),'protein_contribution');
    lacks(nutrients('Cooked beans',{proteins_100g:15},{data_quality_errors_tags:['en:nutrition-value-outside-range']}),'protein_contribution');
  });
  it('requires a valid supported serving and does not assume 100 g or density',()=>{
    lacks(product('Cooked beans',{nutriments:{proteins_100g:20}}),'protein_contribution');
    lacks(nutrients('Cooked beans',{proteins_100g:20},{serving_size:'1 bowl',serving_quantity_unit:'',serving_quantity:null}),'protein_contribution');
    lacks(nutrients('Cooked beans',{proteins_100g:20},{serving_size:'100 ml',serving_quantity_unit:'ml'}),'protein_contribution');
    lacks(nutrients('Cooked beans',{proteins_100g:20},{serving_size:'150 g',serving_quantity:100}),'protein_contribution');
    lacks(nutrients('Cooked beans',{proteins_100g:20},{serving_size:'3000 g',serving_quantity:3000}),'protein_contribution');
  });
  it('does not borrow micronutrients across prepared, estimated or incompatible measurement sets',()=>{
    const base=nutrients('Cooked beans',{proteins_100g:20});
    lacks({...base,nutrition_data_prepared:'on',nutrition_data:''},'protein_contribution');
    for(const set of [
      {preparation:'prepared',per:'100g',nutrients:{proteins:{value:20,unit:'g',source:'packaging'}}},
      {preparation:'as_sold',per:'100ml',nutrients:{proteins:{value:20,unit:'g',source:'packaging'}}},
      {preparation:'as_sold',per:'100g',nutrients:{proteins:{value:20,unit:'g',source:'estimate'}}},
      {preparation:'as_sold',per:'serving',nutrients:{proteins:{value:20,unit:'g',source:'packaging'}}},
      {preparation:'as_sold',per:'100g',nutrients:{}}
    ]) lacks({...base,nutrition:{aggregated_set:set}},'protein_contribution');
    has({...base,nutrition:{aggregated_set:{preparation:'as_sold',per:'100g',nutrients:{proteins:{value:12,unit:'g',source:'packaging'},iron:{value:3,unit:'mg',source:'manufacturer'}}}}},'protein_contribution','iron_contribution');
  });
  it('does not presume vitamin D fortification or preferred calcium from spinach',()=>{
    lacks(nutrients('Milk',{'vitamin-d_100g':0.000003}),'vitamin_d_contribution');
    has(nutrients('Milk',{'vitamin-d_100g':0.000003},{ingredients_text:'Milk, vitamin D3'}),'vitamin_d_contribution');
    lacks(nutrients('Spinach',{calcium_100g:0.3}),'calcium_contribution');
  });
  it('has bounded canonical sources, stable ordering, general follicular wording and no private data or score changes',()=>{
    const value=nutrients('Cooked chickpeas',{proteins_100g:12,fiber_100g:5},{symptoms:'PRIVATE symptom text',user_id:'PRIVATE_ID',cyclePhase:'luteal',rating:75});
    const before=structuredClone(value),first=tags(value);
    assert.deepEqual(value,before);
    assert.deepEqual(tags(value),first);
    assert.doesNotMatch(JSON.stringify(first),/PRIVATE|PRIVATE_ID|rating|cyclePhase/);
    for(const tag of first) {
      assert.ok(tag.sources.length>0 && tag.sources.length<=3);
      assert.ok(tag.limitations.length<=8);
      assert.deepEqual(Object.keys(tag).sort(),['id','label','contexts','evidence','evidenceDirection','wording','foodDataConfidence','foodFamilies','sources','limitations'].sort());
      assert.ok(rulebook.rules.some(rule=>rule.id===tag.id));
      assert.ok(tag.contexts.every(context=>WOMENS_FOOD_CONTEXTS.includes(context)));
      for(const source of tag.sources) assert.ok(rulebook.sources.some(original=>original.id===source.id && original.url===source.url));
      if(tag.contexts.includes('follicular') || tag.contexts.includes('ovulation')) assert.match(tag.limitations.join(' '),/no special follicular or ovulatory effect/);
    }
  });
  it('rejects unsupported foods and malformed inputs without throwing',()=>{
    for(const value of [null,undefined,[],false,'banana',{},product('Ginger capsules'),product('Iron supplement'),product('Baby banana puree'),product('Soy infant formula'),product('Ginger beer')]) assert.deepEqual(tags(value),[]);
  });
});
