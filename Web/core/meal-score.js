/* Shared nutrition calculation with an explicitly separate rough food estimate.
 * Source composition always wins. The fallback uses recognised food patterns;
 * it never supplies missing nutrients, grams or an official nutrient grade.
 */
(function(root) {
  'use strict';
  const METHOD_VERSION=root.NudgeScoreCore?.SCORE_VERSION||'0.3', ESTIMATE_VERSION='nudge_food_estimate_v3', LEGACY_ESTIMATE_VERSIONS=['nudge_food_estimate_v1','nudge_food_estimate_v2'];
  const REQUIRED=['energyKcal','sugars','saturatedFat','salt','fibre','protein'];
  const LABELS={energyKcal:'energy',sugars:'sugars',saturatedFat:'saturated fat',salt:'salt',fibre:'fibre',protein:'protein'};
  const known=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const statuses=new Set(['composition_estimate','derived','supplied','confirmed']);
  function nutrient(record,key) {
    const n=record?.nutrients?.[key];
    return n&&known(n.value)&&statuses.has(n.status)&&n.unit===(key==='energyKcal'?'kcal':'g')
      &&(n.relation==null||['=','eq'].includes(n.relation))?n.value:null;
  }
  function base(reason='',missingInputs=[]) {
    const core=root.NudgeScoreCore;
    return {...(core?.unratedScore(reason,missingInputs,'unknown')||{}),available:false,value:null,status:'unavailable',label:'Nudge nutrition score',
      scoreBasis:'sourced_composition',estimated:true,reason,explanation:reason,missingInputs,
      assumptions:['Source composition and selected food weights are estimates. Unobserved oil, dressing and salt are not included.'],
      calculationBasis:{per:100,unit:'g',preparation:'selected_composition_records'}};
  }
  function calculateDetailed(meal) {
    const core=root.NudgeScoreCore;
    if(!core?.calculateScore)return base('Meal scoring is not available in this build.');
    if(!meal||!Array.isArray(meal.components)||!meal.components.length)return base('Choose the foods and amounts first.',['food components']);
    if(meal.recipeCalculation?.applied||meal.components.some(c=>c?.recipeQuantity))return base('Recipe ingredients provide total nutrition; the cooked weight is unknown.',['cooked recipe weight']);
    if(meal.basis&&meal.basis!=='perPortion'||meal.portion?.unit==='ml')return base('This meal method needs food amounts in grams.',['gram amounts']);
    const components=meal.components;
    if(components.some(c=>!c||!known(c.amountGrams)||c.amountGrams<=0||c.amountGrams>5000))return base('Add an amount for every food.',['component gram amounts']);
    if(components.some(c=>!c.recordId||c.sourceRecord?.id!==c.recordId||c.sourceRecord.basis!=='per100g'))return base('Choose a composition match for every food.',['sourced food composition']);
    if(components.some(c=>['beverage','alcohol','supplement','infant_food','medical_food','sports_nutrition'].includes(c.sourceRecord.foodGroup)))return base('This type of food is outside the meal method.',['supported meal']);
    const supportedGroups=new Set(['fruit','vegetable','legume','grain','poultry','fish','egg','dairy','mixed_dish','red_meat','cheese','fat_oil','nuts_seeds']);
    const metadata=components.map(c=>root.NudgeMealRecovery?.scoringMetadata?.(c.sourceRecord)||{
      mealScoringProfile:c.sourceRecord.mealScoringProfile||
        (['red_meat','cheese'].includes(c.sourceRecord.foodGroup)?c.sourceRecord.foodGroup:
          ['fat_oil','nuts_seeds'].includes(c.sourceRecord.foodGroup)?'fats_nuts_seeds':
          supportedGroups.has(c.sourceRecord.foodGroup)?'general':'unknown'),specialOilFvlEligible:null});
    // The original curated composition catalogue predates recovery profile metadata.
    // Its reviewed general-food group remains supported; special/unknown groups
    // require their dedicated profile rather than silently becoming general.
    metadata.forEach((m,i)=>{if(m.mealScoringProfile==='unknown'&&['fruit','vegetable','legume','grain','poultry','fish','egg','dairy','mixed_dish'].includes(components[i].sourceRecord.foodGroup))metadata[i]={...m,mealScoringProfile:'general'};});
    if(metadata.some(m=>!['general','red_meat','cheese','fats_nuts_seeds'].includes(m.mealScoringProfile)))return base('Choose a source with a supported food profile.',['supported meal profile']);
    const grams=components.reduce((sum,c)=>sum+c.amountGrams,0);
    // Current capture quantities are as-consumed grams and therefore their sum
    // is the yielded portion. A separately supplied recipe yield needs provenance.
    if(meal.recipeYield&&!(meal.recipeYield.verified===true&&known(meal.recipeYield.grams)&&meal.recipeYield.grams>0
      &&typeof meal.recipeYield.source==='string'&&meal.recipeYield.source.trim()))return base('Confirm the cooked recipe yield.',['verified recipe yield']);
    const yieldGrams=meal.recipeYield?meal.recipeYield.grams:grams;
    const profiles=metadata.map(m=>m.mealScoringProfile),homogeneous=profiles.every(p=>p===profiles[0]);
    // SPF FAQ pp18–19 excludes complete meals, sandwiches and wraps from
    // the meat-product exception. Homogeneous reviewed meat uses that profile;
    // a complete mixture retains general-food rules, never a name-based override.
    const category=homogeneous&&['red_meat','cheese','fats_nuts_seeds'].includes(profiles[0])?profiles[0]:'general';
    const required=category==='fats_nuts_seeds'?[...REQUIRED,'fat']:REQUIRED,per100={},missing=[];
    for(const key of [...new Set([...required,'carbohydrate','fat'])]) {
      const values=components.map(c=>nutrient(c.sourceRecord,key));
      per100[key]=values.some(v=>v===null)?null:values.reduce((sum,v,i)=>sum+v*components[i].amountGrams/yieldGrams,0);
      if(per100[key]===null&&required.includes(key))missing.push(LABELS[key]||key);
    }
    if(missing.length)return base('The selected food records still need '+missing.join(', ')+'.',missing);
    if(components.some(c=>{
      const r=c.sourceRecord,sat=nutrient(r,'saturatedFat'),fat=nutrient(r,'fat'),sugars=nutrient(r,'sugars'),carbs=nutrient(r,'carbohydrate');
      return (fat!==null&&sat>fat+.05)||(carbs!==null&&sugars>carbs+.05)
        ||required.filter(k=>k!=='energyKcal').some(k=>nutrient(r,k)>100)||nutrient(r,'energyKcal')>1000;
    }))return base('Check the selected food composition; some values conflict.',['consistent source nutrients']);
    const eligibility=components.map((c,i)=>category==='fats_nuts_seeds'?metadata[i].specialOilFvlEligible:c.sourceRecord.fvlEligible);
    const fvlPercent=eligibility.every(v=>typeof v==='boolean')
      ?components.reduce((sum,c,i)=>sum+(eligibility[i]?c.amountGrams:0),0)/yieldGrams*100:null;
    // A yield can change water concentration, but cannot establish the official
    // reconstitution factor for plants. Require an explicit evidenced share if
    // a cooked yield differs; keep that share unknown otherwise.
    const qualifiedFvl=yieldGrams===grams?fvlPercent:
      meal.recipeYield?.fvlPercentSource&&known(meal.recipeYield.fvlPercent)&&meal.recipeYield.fvlPercent<=100?meal.recipeYield.fvlPercent:null;
    const product={name:meal.name||'Selected meal composition',sourceKind:'composition',sourceName:'Selected source composition records',
      basisUnit:'g',nutritionPreparation:'as_consumed',
      nutrients:Object.fromEntries(Object.entries(per100).map(([key,value])=>[key,{value,status:value===null?'unknown':'supplied',unit:key==='energyKcal'?'kcal':'g'}])),
      scoringFacts:{fvlPercent:qualifiedFvl===null?null:{value:qualifiedFvl,source:'selected-composition-quantities',evidence:'Selected qualifying source records and as-consumed weights'}}};
    const scored=core.calculateScore(product,{category,sweeteners:null});
    if(!scored.available)return {...base(scored.reason,scored.missingInputs),inputs:scored.inputs};
    const sourceRecords=components.map((c,i)=>({id:c.recordId,amountGrams:c.amountGrams,source:c.sourceRecord.source??null,
      sourceURL:c.sourceRecord.sourceURL??null,version:c.sourceRecord.sourceVersion??c.sourceRecord.version??null,fvlEligible:typeof eligibility[i]==='boolean'?eligibility[i]:null}));
    const assumptions=[...scored.assumptions,'Source composition and selected food weights are estimates. Unobserved oil, dressing and salt are not included.'];
    return {...scored,available:true,estimated:true,status:scored.status==='provisional'?'estimated_provisional':'estimated',scoreBasis:'sourced_composition',
      assumptions,inputs:{...scored.inputs,energyKcal:per100.energyKcal,portionGrams:yieldGrams,sourceRecords},
      sourceData:{...scored.sourceData,sourceRecords,yield:{grams:yieldGrams,source:yieldGrams===grams?'sum-of-as-consumed-component-grams':meal.recipeYield.source}},
      explanation:scored.explanation+' Source composition and selected weights are estimated. Portion scaling changes intake and frequency, not the nutrition grade.',
      calculationBasis:{per:100,unit:'g',preparation:'selected_composition_records'}};
  }
  // The owner's latest instruction restores a labelled best guess when source
  // composition is incomplete. It is not an official nutrient grade, and never
  // changes source values, selected records, quantities or stored snapshots.
  const normal=value=>typeof value==='string'?value.toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim().slice(0,1000):'';
  const genericName=name=>!name||/^(?:(?:your|unknown|unidentified|unrecognised|unrecognized|visible|foreground|mixed|assorted|prepared) )*(?:food|ingredient|component|meal|dish|item|product)s?$/.test(name);
  const patterns={
    plant:/\b(vegetables?|salad|lettuce|tomatoes?|carrots?|broccoli|broccolini|cauliflower|spinach|greens?|onions?|peppers?|capsicum|cucumber|courgette|zucchini|aubergine|eggplant|cabbage|mushrooms?|peas?|fruit|apples?|berries|pomegranate|banana|orange|lime|avocado|potatoes?)\b/,
    pulse:/\b(lentils?|chickpeas?|beans?|tofu|tempeh|nuts?|almonds?|walnuts?|cashews?|peanuts?|sunflower seeds?|pumpkin seeds?|chia|flax|linseed|sesame)\b/,
    whole:/\b(wholegrain|whole grain|wholemeal|whole wheat|brown rice|oats?|oatmeal|quinoa|barley|bulgur)\b/,
    refined:/\b(white (?:bread|rice|pasta)|pizza|pasta|noodles?|bread|baguette|croissant|pastry|crust|tortilla|rice|wraps?|rolls?)\b/,
    sugary:/\b(cakes?|cookies?|biscuits?|sweets|candy|sugary|frosted|frosties|syrup|doughnuts?|donuts?|ice cream|dessert|chocolate|sugar|soda|cola|lemonade)\b/,
    fish:/\b(fish|salmon|sardines?|mackerel|tuna|cod|prawns?|shrimp)\b/,
    poultry:/\b(chicken|turkey|eggs?)\b/,
    red:/\b(beef|pork|lamb|mutton|veal|steak|meat|m[ia]nce[dt]?)\b/,
    processed:/\b(bacon|ham|sausages?|salami|pepperoni|chorizo|hot dog|processed meat)\b/
  };
  const otherFoods=/\b(soups?|sandwich(?:es)?|curry|stew|casserole|lasagne|lasagna|tacos?|burritos?|sushi|risotto|omelette|porridge|cereals?|cornflakes?|maize|corn|wheat|weetabix|cheese|yoghurts?|yogurts?|milk|cream|butter|margarine|olive oil|rapeseed oil|sunflower oil|yeast extract|marmite|hummus|houmous|falafel|dumplings?|pancakes?|pasta bake|granola|muesli|peanut butter|coffee|tea|juice|water)\b/;
  const nonFood=/\b(soap|detergent|shampoo|cosmetics?|bleach|cleaning fluid|washing powder|toothpaste|phones?|laptop|keyboard|shoes?|plastic toy|pet food|dog food|cat food)\b/;
  const excluded=/\b(infant|baby food|baby formula|supplements?|medical food|meal replacements?|sports nutrition|protein powder|alcoholic drinks?|alcoholic beverages?)\b/;
  const alcoholic=/^(?:(?:red|white|rose|sparkling|alcoholic|craft|lager|strong|light) )*(?:wine|beer|cider|vodka|whisky|whiskey|gin|rum|spirits|liqueur)s?$/;
  const recognised=text=>Object.values(patterns).some(pattern=>pattern.test(text))||otherFoods.test(text);
  // A numeric estimate can use the validated visual food classification and
  // linked observations. The older qualitative heuristic still needs its known
  // food vocabulary: unfamiliar dish names must not erase valid photo nutrients.
  function supportsFoodEstimateIdentity(food,allowVisualEvidence=false){
    if(!food||food.isFood===false||food.nonFood===true||food.type==='unknown'||food.category==='unsupported')return false;
    const components=Array.isArray(food.components)?food.components:Array.isArray(food.mealComposition)?food.mealComposition:[],raw=Array.isArray(food.ingredients)?food.ingredients:typeof food.ingredients==='string'?food.ingredients.split(/[,;]/):typeof food.ingredients?.text==='string'?food.ingredients.text.split(/[,;]/):[];
    const name=normal(food.name||food.productName),parts=components.length?components:raw,names=parts.map(c=>normal(typeof c==='string'?c:c?.name||c?.text||c?.sourceRecord?.name)).filter(Boolean);
    const tags=[food.categoryTag,...(Array.isArray(food.categories)?food.categories:[]),...(Array.isArray(food.categoriesTags)?food.categoriesTags:[])].filter(v=>typeof v==='string'),categoryText=normal(tags.join(' ')),text=[name,...names,categoryText].join(' ');
    const mixedFood=/\b(?:smoothie|porridge|oatmeal|pancakes?|bread|meal|bowl)\b/.test(name)&&names.length>1&&names.some(n=>recognised(n)&&!excluded.test(n));
    const supplement=n=>/\b(?:pea protein|protein powder|protein isolate|creatine)\b/.test(n),excludedText=mixedFood?[name,categoryText,...names.filter(n=>!supplement(n))].join(' '):text;
    const excludedGroups=new Set(['alcohol','supplement','infant_food','medical_food','sports_nutrition']);
    if(nonFood.test(text)||excluded.test(excludedText)||!mixedFood&&supplement(name)||alcoholic.test(name)||excludedGroups.has(food.foodGroup)
      ||tags.some(v=>/^(?:alcohol(?:ic (?:drinks?|beverages?))?|beers?|wines?|spirits|ciders?|liqueurs?|cocktails?)$/.test(normal(v.replace(/^[a-z]{2}:/i,''))))
      ||components.some(c=>excludedGroups.has(c?.sourceRecord?.foodGroup)&&!(mixedFood&&supplement(normal(c?.name))&&['supplement','sports_nutrition'].includes(c.sourceRecord.foodGroup))))return false;
    const sourceIdentity=components.some(c=>c?.recordId&&c.sourceRecord?.id===c.recordId&&['fruit','vegetable','legume','grain','poultry','fish','egg','dairy','mixed_dish','red_meat','cheese','fat_oil','nuts_seeds'].includes(c.sourceRecord.foodGroup));
    const named=value=>typeof value==='string'&&value.trim().length<=160&&/\p{L}/u.test(value)
      &&!(normal(value)&&genericName(normal(value)))&&!/^(?:unknown|unidentified|unrecognised|unrecognized|unreadable)(?:\s|$)/.test(normal(value));
    const photoIndex=value=>Number.isInteger(value)&&value>=1&&value<=4,subject=food.subject;
    const contradictsFoodEvidence=value=>nonFood.test(normal(value))
      ||/\b(?:non food|not (?:a |an )?(?:food|meal|edible)|inedible)\b/.test(normal(value));
    // Explicit non-food evidence cannot be overridden by a food classification
    // or a familiar name. Ordinary absence claims such as "no garnish" are fine.
    if(contradictsFoodEvidence(subject?.description)
      ||components.some(c=>contradictsFoodEvidence(c?.evidence)))return false;
    const visualIdentity=allowVisualEvidence&&named(food.name||food.productName)
      &&['plated_meal','serving_dish','loose_food'].includes(subject?.kind)&&photoIndex(subject.photoIndex)
      &&typeof subject.description==='string'&&subject.description.trim().length>0&&subject.description.length<=180
      &&components.some(c=>named(c?.name)&&photoIndex(c.photoIndex)&&c.photoIndex===subject.photoIndex
        &&typeof c.evidence==='string'&&c.evidence.trim().length>0&&c.evidence.length<=160);
    if(visualIdentity)return true;
    return (recognised(text)||sourceIdentity)&&(!genericName(name)||names.some(n=>!genericName(n)&&recognised(n))||recognised(categoryText)||sourceIdentity);
  }
  function supportsNutrientEstimateIdentity(food){return supportsFoodEstimateIdentity(food,true);}
  // Partial nutrition can constrain an estimate without becoming complete
  // nutrition. Read only compatible per-100-unit facts (or a full matched
  // component subtotal for that nutrient); null/upper bounds stay unknown.
  function partialNutrition(food,components) {
    if(food.recipeCalculation?.applied||components.some(c=>c?.recipeQuantity))return {}; // Raw recipe mass is not an as-consumed per-100 g basis, including saved ingredient snapshots.
    const keys=['energyKcal','salt','sugars','saturatedFat','fat'];
    const read=(record,key)=>{
      const n=record?.nutrients?.[key],unit=key==='energyKcal'?'kcal':'g';
      if(!n||n.unit!==unit||!known(n.value)||n.value>(key==='energyKcal'?1000:100)
        ||!['supplied','confirmed','composition_estimate','derived','calculated','estimated'].includes(n.status)
        ||n.relation!=null&&!['eq','=','~','approx','gt','>','gte','>=','≥'].includes(n.relation))return null;
      return {value:n.value,status:n.status,relation:n.relation||'eq',source:record.sourceName||record.source||'Supplied nutrition'};
    };
    if((food.unresolvedFields||[]).some(key=>['nutrition','preparation','identity'].includes(key)))return {};
    const direct=['g','ml'].includes(food.basisUnit)&&['as_sold','as_consumed'].includes(food.nutritionPreparation)
      ||['per100g','per100ml'].includes(food.basis);
    if(direct)return Object.fromEntries(keys.map(key=>[key,read(food,key)]));
    const completeWeights=components.length&&components.every(c=>known(c.amountGrams)&&c.amountGrams>0&&c.recordId&&c.sourceRecord?.id===c.recordId&&c.sourceRecord.basis==='per100g');
    if(!completeWeights)return {};
    const grams=components.reduce((sum,c)=>sum+c.amountGrams,0);
    if(food.recipeYield)return {}; // a yielded recipe needs the detailed preparation path
    return Object.fromEntries(keys.map(key=>{
      const inputs=components.map(c=>read(c.sourceRecord,key));
      return [key,inputs.some(n=>!n)?null:{value:inputs.reduce((sum,n,i)=>sum+n.value*components[i].amountGrams/grams,0),status:'composition_estimate',relation:'eq',source:'Selected compatible composition records'}];
    }));
  }
  function nutritionAdjustments(food,components,category) {
    const core=root.NudgeScoreCore,n=partialNutrition(food,components),parts=[];
    // A lower bound on fat cannot be used as a ratio denominator; it would
    // artificially lower the saturated-fat proportion. Known conflicting
    // quantities are retained as source facts but not used in this heuristic.
    if(n.saturatedFat&&n.fat&&n.saturatedFat.value>n.fat.value+.05)return {parts,nutrition:{},reason:'inconsistent_nutrient_values'};
    const add=(id,key,table,weight)=>{if(n[key])parts.push({id,observation:n[key].value+' '+(key==='energyKcal'?'kcal':'g')+' per 100 '+(food.basisUnit||'g'),points:-weight*core.pointsFor(n[key].value,table),input:n[key]});};
    if(!core)return {parts,nutrition:n};
    add('known_salt','salt',core.TABLES.salt,2);
    add('known_sugars','sugars',category==='beverage'?core.TABLES.beverageSugars:core.TABLES.sugars,1);
    if(category==='fats_nuts_seeds'){
      if(n.saturatedFat){parts.push({id:'known_saturated_fat_energy',observation:n.saturatedFat.value+' g saturated fat per 100 '+(food.basisUnit||'g'),points:-core.pointsFor(n.saturatedFat.value*37,core.TABLES.energyFromSaturates),input:n.saturatedFat});}
      if(n.saturatedFat&&n.fat?.value>0&&['eq','=','~','approx'].includes(n.fat.relation))parts.push({id:'known_saturate_ratio',observation:'Saturated fat / total fat',points:-core.pointsFor(n.saturatedFat.value/n.fat.value*100,core.TABLES.saturateRatio,true),input:{saturatedFat:n.saturatedFat,fat:n.fat}});
    }else{
      add('known_saturated_fat','saturatedFat',core.TABLES.saturatedFat,2);
      if(n.energyKcal)parts.push({id:'known_energy',observation:n.energyKcal.value+' kcal per 100 '+(food.basisUnit||'g'),points:-core.pointsFor(n.energyKcal.value*4.184,category==='beverage'?core.TABLES.beverageEnergy:core.TABLES.energy),input:n.energyKcal});
    }
    return {parts,nutrition:n};
  }
  function calculateProductEstimate(food,core=root.NudgeScoreCore,classification) {
    if(core?.CONFIG?.status==='nudge_directional')return core.calculateSourceEstimate(food,classification);
    if(!core||food?.sourceName!=='Open Food Facts'||!['g','ml'].includes(food.basisUnit)
      ||!(core.CONFIG?.status==='nudge_directional'?['as_sold','prepared'].includes(food.nutritionPreparation):food.nutritionPreparation==='as_sold')||(food.unresolvedFields||[]).some(k=>['identity','nutrition','preparation'].includes(k)))return null;
    // Use explicitly marked provider estimates as point estimates in a separate
    // result. The supplied record, its approximate relations and all verified
    // label fields remain unchanged. No provider letter or model score is read.
    const estimatedInputs={},adapt=(n,key)=>{
      const unit=key==='energyKj'?'kJ':key==='energyKcal'?'kcal':'g';
      if(!n||n.unit!==unit||!known(n.value)||food.nutrientSources?.[key]!=='estimate'
        ||n.status!=='estimated'||n.relation!=null&&!['~','approx','=','eq'].includes(n.relation))return n;
      estimatedInputs[key]={...n,source:food.nutrientSources[key]};
      return {...n,status:'supplied',relation:'eq'};
    };
    const input={...food,nutrients:Object.fromEntries(Object.entries(food.nutrients||{}).map(([key,n])=>[key,adapt(n,key)])),energyKj:adapt(food.energyKj,'energyKj')};
    if(!Object.keys(estimatedInputs).length)return null;
    // A supplied kcal value takes precedence over an estimated kJ field.
    const kcal=food.nutrients?.energyKcal;
    if(estimatedInputs.energyKj&&kcal&&['supplied','confirmed'].includes(kcal.status)
      &&(kcal.relation==null||['eq','='].includes(kcal.relation)))input.energyKj=food.energyKj;
    const result=core.calculateScore(input);
    if(!result.available)return null;
    return {...result,estimated:true,status:result.status==='provisional'?'estimated_provisional':'estimated',scoreBasis:'provider_nutrient_estimate',
      label:core.CONFIG?.status==='nudge_directional'?'Nudge score':'Estimated nutrition score',confidence:'estimated',
      ...(core.CONFIG?.status==='nudge_directional'?{inputFingerprint:core.inputFingerprint(food),inferredInputs:{...result.inferredInputs,nutrients:estimatedInputs}}:{}),
      inputs:{...result.inputs,estimatedInputs},sourceData:{...result.sourceData,estimatedInputs},
      reasonCodes:[...result.reasonCodes,'provider_nutrients_estimated'],
      assumptions:[...result.assumptions,'Marked provider nutrient estimates are approximate; verified label values are retained.'],
      explanation:result.explanation+' This calculation includes explicitly marked provider nutrient estimates and may change when label values are available.'};
  }
  function estimate(food,unavailable=null) {
    // A complete source result, including zero, can never be overwritten by this fallback.
    if(unavailable?.available===true)return unavailable;
    const fail=(reason,missing=['food identity'])=>unavailable||base(reason,missing);
    if(!food||typeof food!=='object'||Array.isArray(food)||food.isFood===false||food.nonFood===true||food.type==='unknown')return fail('Identify the food first.');
    // A supported-food guess cannot override an explicit category exclusion
    // established by the detailed calculator (for example fruit-flavoured beer).
    if(unavailable?.category==='unsupported')return fail('This item is outside the food estimate.',['supported food']);
    const productEstimate=calculateProductEstimate(food);
    if(productEstimate)return productEstimate;
    const components=(Array.isArray(food.components)?food.components:Array.isArray(food.mealComposition)?food.mealComposition:[]).slice(0,40);
    const rawIngredients=Array.isArray(food.ingredients)?food.ingredients:typeof food.ingredients==='string'?food.ingredients.split(/[,;]/):typeof food.ingredients?.text==='string'?food.ingredients.text.split(/[,;]/):[];
    const ingredients=rawIngredients.slice(0,60).map(item=>typeof item==='string'?{name:item}:item);
    const parts=components.length?components:ingredients,name=normal(food.name||food.productName);
    const names=parts.map(c=>normal(c?.name||c?.text||c?.sourceRecord?.name)).filter(Boolean);
    const categoryNames=[food.categoryTag,...(Array.isArray(food.categories)?food.categories:[]),...(Array.isArray(food.categoriesTags)?food.categoriesTags:[])].filter(v=>typeof v==='string');
    const categoryText=normal(categoryNames.join(' '));
    // Check category records separately from ingredients: wine vinegar and a
    // wine sauce are foods, whereas a product categorised as wine is excluded.
    const alcoholCategory=categoryNames.some(value=>/^(?:alcohol(?:ic (?:drinks?|beverages?))?|beers?|wines?|spirits|ciders?|liqueurs?|cocktails?)$/.test(normal(value.replace(/^[a-z]{2}:/i,''))));
    const text=[name,...names,categoryText].join(' ').slice(0,12000);
    const excludedGroups=new Set(['alcohol','supplement','infant_food','medical_food','sports_nutrition']);
    const mixedFood=/\b(?:smoothie|porridge|oatmeal|pancakes?|bread|meal|bowl)\b/.test(name)&&names.length>1&&names.some(n=>recognised(n)&&!excluded.test(n));
    const supplementIngredient=n=>/\b(?:pea protein|protein powder|protein isolate|creatine)\b/.test(n);
    const excludedText=mixedFood?[name,categoryText,...names.filter(n=>!supplementIngredient(n))].join(' '):text;
    if(nonFood.test(text)||excluded.test(excludedText)||!mixedFood&&supplementIngredient(name)||alcoholic.test(name)||alcoholCategory||components.some(c=>excludedGroups.has(c?.sourceRecord?.foodGroup)&&!(mixedFood&&supplementIngredient(normal(c?.name))&&['supplement','sports_nutrition'].includes(c.sourceRecord.foodGroup)))||excludedGroups.has(food.foodGroup)||food.category==='unsupported')return fail('This item is outside the food estimate.',['supported food']);
    const foodGroups=new Set(['fruit','vegetable','legume','grain','poultry','fish','egg','dairy','mixed_dish','red_meat','cheese','fat_oil','nuts_seeds']);
    const sourceIdentity=components.some(c=>c?.recordId&&c.sourceRecord?.id===c.recordId&&foodGroups.has(c.sourceRecord.foodGroup));
    if(!supportsFoodEstimateIdentity(food))return fail('Identify a food or its ingredients first.');
    const rawQuality=food.qualityEstimate&&typeof food.qualityEstimate==='object'?food.qualityEstimate:{};
    // Qualitative observations may adjust an identified food, but cannot invent
    // its identity. Caller score/value/grade fields are never read.
    const q=typeof rawQuality.evidence==='string'&&rawQuality.evidence.trim()?rawQuality:{};
    const grams=parts.map(c=>known(c?.amountGrams)&&c.amountGrams>0?c.amountGrams:null);
    const total=grams.length&&grams.every(g=>g!==null)?grams.reduce((a,b)=>a+b,0):null;
    const partNames=parts.map(c=>normal(c?.name||c?.text||c?.sourceRecord?.name));
    const atomicPlant=(c,i)=>['fruit','vegetable','legume'].includes(c?.sourceRecord?.foodGroup)||patterns.plant.test(partNames[i])&&!/\b(salad|soup|pie|pizza|pasta|noodles?|rice|sandwich|curry|stew|bowl|sauce|with|and|mix)\b/.test(partNames[i]);
    const plantShare=total?parts.reduce((sum,c,i)=>sum+(atomicPlant(c,i)?grams[i]:0),0)/total:null;
    // A vegan condiment inside a meat dish does not reclassify its protein.
    const meatFree=/^(?:vegan|vegetarian|meat free|plant based)\b/.test(name);
    const yesNo=(key,inferred)=>['yes','no','unknown'].includes(q[key])?q[key]:inferred?'yes':'unknown';
    const wholePlants=['low','medium','high','unknown'].includes(q.wholePlants)?q.wholePlants:plantShare!==null?(plantShare>=.6?'high':plantShare>=.15?'medium':'low'):patterns.plant.test(text)?(/\b(salad|vegetables?|fruit plate)\b/.test(name)?'high':'medium'):'unknown';
    const proteinType=['plant','fish','poultry_egg','red_meat','processed_meat','none','unknown'].includes(q.proteinType)?q.proteinType:meatFree?'plant':patterns.processed.test(text)?'processed_meat':patterns.red.test(text)?'red_meat':patterns.fish.test(text)?'fish':patterns.poultry.test(text)?'poultry_egg':patterns.pulse.test(text)?'plant':'unknown';
    const evidence=normal(q.evidence),fryingText=(text+' '+evidence).replace(/\b(?:not|no|without) (?:deep fried|deep frying|batter(?:ed)?|bread(?:ed|ing))\b/g,'');
    const deepFried=/\b(?:deep fried|deep frying|battered|breaded|french fries|chips)\b/.test(fryingText);
    const savoury=/\b(?:curry|stew|soup|casserole|salad|savoury|savory)\b/.test(name);
    // The rule penalises deep-fried food, not the use of a frying pan or oil.
    // A little honey/sugar in a savoury recipe does not classify the whole dish
    // as a sugary food. Compatible measured nutrition still constrains it.
    const sugary=savoury&&!/\b(?:sugary|sugar heavy|very sweet|sugar sweetened)\b/.test(evidence)?'unknown':yesNo('sugaryFood',patterns.sugary.test(text)&&!/\b(sugar free|no added sugar|unsweetened)\b/.test(text));
    const factors={wholePlants,wholeGrains:yesNo('wholeGrains',patterns.whole.test(text)),legumesNuts:yesNo('legumesNuts',patterns.pulse.test(text)),proteinType,
      refinedStarch:yesNo('refinedStarch',patterns.refined.test(text)&&!patterns.whole.test(text)),
      sugaryFood:sugary,
      frying:deepFried?'yes':q.frying==='no'?'no':'unknown'};
    const weights={wholePlants:{low:0,medium:10,high:25,unknown:0},wholeGrains:{yes:10,no:0,unknown:0},legumesNuts:{yes:10,no:0,unknown:0},
      proteinType:{plant:0,fish:5,poultry_egg:0,red_meat:-5,processed_meat:-20,none:0,unknown:0},
      refinedStarch:{yes:-5,no:0,unknown:0},sugaryFood:{yes:-20,no:0,unknown:0},frying:{yes:-10,no:0,unknown:0}};
    const nutritionCategory=unavailable?.category||root.NudgeScoreCore?.resolveClassification?.(food)?.category||'unknown';
    const partial=nutritionAdjustments(food,components,nutritionCategory);
    const adjustments=Object.entries(factors).map(([id,observation])=>({id,observation,points:weights[id][observation]}));
    // The sugar observation and measured sugar constrain the same factor; use
    // the larger deduction rather than double-counting both descriptions.
    const qualitativeSugar=adjustments.find(part=>part.id==='sugaryFood');
    const measuredSugar=partial.parts.find(part=>part.id==='known_sugars');
    if(qualitativeSugar&&measuredSugar)measuredSugar.points=Math.min(0,measuredSugar.points-qualitativeSugar.points);
    adjustments.push(...partial.parts);
    const value=Math.max(5,Math.min(95,Math.round((50+adjustments.reduce((sum,f)=>sum+f.points,0))/5)*5));
    const supportedEvidence=adjustments.filter(f=>f.observation!=='unknown');
    const explanation='Rough food-pattern estimate: start at 50; identified whole plants add up to 25, whole grains and legumes/nuts up to 10 each, fish 5; red meat subtracts 5, processed meat or sugary foods 20, refined starch 5 and deep frying 10. Rounded to 5 and limited to 5–95. Available compatible per-100 nutrition additionally constrains the estimate: 2 points per known salt or saturated-fat nutrient point, 1 per sugar or energy point; fats/nuts use their saturated-fat energy and ratio instead. Sugar descriptions and measured sugar are not double counted. Unknown factors make no adjustment; this does not mean they are absent. Recipe, missing salt, oil and portion uncertainty can change the result. This is not the detailed nutrient calculation, and no missing nutrient quantities are filled in.';
    return {...base(),available:true,value,status:'estimated_rough',estimated:true,label:'Rough estimate',methodVersion:ESTIMATE_VERSION,methodId:ESTIMATE_VERSION,version:'3',model_version:'3',sourceVersion:ESTIMATE_VERSION,promptVersion:null,baseAlgorithmVersion:null,
      grade:null,category:'food_pattern',rawScore:null,rawLower:null,rawUpper:null,displayLower:null,displayUpper:null,band:null,baseFrequency:null,finalFrequency:null,frequencyStatus:'incomplete',personalSuitability:'unchecked',
      reason:supportedEvidence.length?'Best guess from the identified food and preparation.':'Recognised food; limited detail for this rough estimate.',explanation,rationale:supportedEvidence.map(f=>f.id+': '+f.observation+' ('+(f.points>0?'+':'')+f.points+')'),
      reasonCodes:['rough_food_pattern_estimate','low_confidence',...(unavailable?['detailed_score_unavailable']:[]),...(partial.parts.length?['known_nutrition_constraints']:[])],scoreBasis:'food_pattern',confidence:'low',completeness:'rough_food_pattern',
      missingInputs:unavailable?.missingInputs||[],missingFields:unavailable?.missingInputs||[],detailedReason:unavailable?.reason||null,factors,components:{adjustments},inputs:{identifiedFood:name||null,identifiedParts:names.slice(0,20),plantShare,partialNutrition:partial.nutrition,nutritionCategory},
      sources:[],sourceData:{source:'Identified food description, qualitative observations and available compatible nutrition',version:ESTIMATE_VERSION},
      assumptions:['Food identity, recipe and preparation may be incomplete.','Unknown factors leave the starting estimate unchanged, not zero nutrient values.','This rough estimate does not establish eating frequency or suitability.'],calculationBasis:{kind:'qualitative_food_pattern',version:ESTIMATE_VERSION}};
  }
  function calculateNutrientEstimate(meal){
    const composition=root.NudgeComposition,core=root.NudgeScoreCore,proposal=composition?.activeNutrientEstimate?.(meal);
    if(!proposal||!core?.calculateScore)return null;
    if(!supportsNutrientEstimateIdentity(meal))return null;
    const grams=composition.estimatePortionGrams(meal,proposal),totals=composition.mealNutrition(meal);
    const per100=Object.fromEntries(composition.keys.map(key=>[key,totals[key].value*100/grams]));
    if(composition.keys.some(key=>!known(per100[key])||per100[key]>(key==='energyKcal'?1000:100))
      ||per100.sugars>per100.carbohydrate+.05||per100.saturatedFat>per100.fat+.05)return null;
    const nutrientSources=Object.fromEntries(composition.keys.map(key=>[key,totals[key].source===composition.MODEL_ESTIMATE_SOURCE?'model_photo_estimate':'complete_source_composition']));
    const product={name:meal.name||'Estimated meal',sourceKind:'composition',sourceName:'Estimated photo nutrients',basisUnit:'g',nutritionPreparation:'as_consumed',
      nutrients:Object.fromEntries(composition.keys.map(key=>[key,{value:per100[key],unit:key==='energyKcal'?'kcal':'g',status:'supplied'}])),
      scoringFacts:{fvlPercent:proposal.fvlPercent===null?null:{value:proposal.fvlPercent,source:'model_photo_estimate',evidence:'Estimated qualifying ingredient share; not a measured recipe.'}}};
    // Only the existing deterministic algorithm produces the number. "supplied"
    // is the calculator's numeric input state, not a claim of label verification.
    const result=core.calculateScore(product,{category:proposal.category,sweeteners:null});
    if(!result.available)return null;
    return {...result,estimated:true,status:result.status==='provisional'?'estimated_provisional':'estimated',scoreBasis:'model_nutrient_estimate',confidence:'low',
      assumptions:[...result.assumptions,...proposal.assumptions,'Photo nutrient amounts, edible weight, category and qualifying plant share are estimates; complete source nutrients take precedence.'],
      inputs:{...result.inputs,portionGrams:grams,nutrientSources},sourceData:{...result.sourceData,source:'model_photo_estimate',nutrientSources,estimate:proposal},
      reasonCodes:[...result.reasonCodes,'photo_nutrients_estimated'],
      explanation:result.explanation+' Calculated from labelled photo nutrient estimates; recipe, portion and hidden ingredients may differ.',
      calculationBasis:{per:100,unit:'g',preparation:'estimated_as_consumed',source:'model_photo_estimate'}};
  }
  function calculate(meal) {const detailed=calculateDetailed(meal);return detailed.available?detailed:calculateNutrientEstimate(meal)||estimate(meal,detailed);}
  function validResult(score) {
    if(root.NudgeScoreCore?.validResult(score))return score.available===true;
    if(score?.methodVersion===ESTIMATE_VERSION||score?.methodId===ESTIMATE_VERSION){
      return score.methodId===ESTIMATE_VERSION&&score.methodVersion===ESTIMATE_VERSION&&score.version==='3'&&score.model_version==='3'
        &&score.available===true&&score.status==='estimated_rough'&&score.scoreBasis==='food_pattern'&&score.confidence==='low'
        &&score.grade===null&&score.rawScore===null&&score.baseFrequency===null&&score.finalFrequency===null
        &&Number.isInteger(score.value)&&score.value>=5&&score.value<=95&&score.value%5===0;
    }
    // Read-only historical validity. Never convert these numbers to v0.2.
    if(LEGACY_ESTIMATE_VERSIONS.includes(score?.methodVersion)||LEGACY_ESTIMATE_VERSIONS.includes(score?.methodId))return !(score?.methodVersion===ESTIMATE_VERSION||score?.methodId===ESTIMATE_VERSION)&&(!score.methodId||!score.methodVersion||score.methodId===score.methodVersion)&& score.available===true&&score.status==='estimated_rough'&&score.scoreBasis==='food_pattern'&&score.confidence==='low'&&Number.isInteger(score.value)&&score.value>=5&&score.value<=95&&score.value%5===0;
    if(!score||score.available!==true||!['nudge_meal_v0_1','nudge_meal_v0_2','nudge_meal_v0_3','nudge_meal_v0_4'].includes(score.methodVersion||score.methodId)
      ||!Number.isInteger(score.value)||score.value<0||score.value>100||!['estimated','estimated_provisional'].includes(score.status))return false;
    return score.status!=='estimated_provisional'||Number.isInteger(score.displayLower)&&Number.isInteger(score.displayUpper)
      &&score.displayLower>=0&&score.displayUpper<=100&&score.displayLower<=score.displayUpper&&score.value===score.displayLower;
  }
  const api=Object.freeze({METHOD_VERSION,ESTIMATE_VERSION,supportsNutrientEstimateIdentity,calculate,calculateDetailed,calculateNutrientEstimate,calculateProductEstimate,estimate,validResult});
  root.NudgeMealScore=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window==='object'?window:globalThis);
