/* Shared arithmetic for sourced meal components. Trace/unknown stay nonnumeric. */
(function(root){
  'use strict';
  const keys=['energyKcal','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'];
  const known=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  // Reviewed edible-plant identities, independent of nutrient-score FVL rules.
  // Exact source IDs also repair display of old unconfirmed scan records. Oils,
  // isolated extracts and unreviewed recipes deliberately have no plant identity.
  // These names follow Nudge's existing culinary-plant counting convention.
  const plantRecords=Object.freeze({
    '13-512:aa47829fcf50':'cauliflower','13-513:936f5522b3cb':'cauliflower',
    '13-502:1c50fd61ac12':'broccoli','13-503:6cc77412db57':'broccoli','13-504:db13d270a92d':'broccoli',
    '13-521:3b11cafbaf89':'spinach','13-550:266ca392c88d':'spinach','13-572:983674eff243':'spinach','13-573:6cc997aa5798':'spinach',
    '13-496:de0beb92f1f5':'carrot','13-497:5208f9d27b6c':'carrot',
    '13-523:a4b201014ed4':'cucumber','13-352:3abe968fcf4a':'onion',
    '13-662:feefdaf61a08':'chickpea','13-661:15e2beb3d110':'lentil','14-226:f1799691c34b':'pomegranate',
    '11-862:6d8905b398f7':'rice','11-869:d96b18563943':'rice','11-1129:3a40cd57ac4d':'wheat','11-723:342cdc54cac4':'wheat',
    'usda:168409':'cucumber','usda:168462':'spinach','usda:168463':'spinach','usda:169134':'pomegranate',
    'usda:168910':'wheat','usda:168928':'wheat','usda:169704':'rice','usda:169757':'rice',
    'usda:170005':'onion','usda:170108':'capsicum','usda:170427':'capsicum',
    'usda:172421':'lentil','usda:172475':'soybean','usda:172476':'soybean','usda:173757':'chickpea',
    'usda:170554':'chia','usda:169414':'flax','14-325:b05499af697f':'blueberry'
  });
  // This existing recipe source names both plants. Generic mixed-nut, seed and
  // berry proxies remain excluded: their nutrient source does not identify the mix.
  const namedPlantBlends=Object.freeze({'linwoods:flaxseed-goji-2026-10-11':['flax','goji berry']});
  const plantAliases=Object.freeze({
    'cauliflower florets':'cauliflower','broccoli florets':'broccoli',broccolini:'broccoli','tenderstem broccoli':'broccoli',
    'spinach leaves':'spinach','baby spinach':'spinach','baby spinach leaves':'spinach',
    pomegranates:'pomegranate','pomegranate seeds':'pomegranate','pomegranate arils':'pomegranate',
    carrots:'carrot',cucumbers:'cucumber','cucumber slices':'cucumber',
    'spring onion':'onion','spring onions':'onion',scallion:'onion',scallions:'onion',onions:'onion',
    'red pepper':'capsicum','red peppers':'capsicum','red bell pepper':'capsicum','red bell peppers':'capsicum','red sweet pointed pepper':'capsicum',
    'green pepper':'capsicum','green peppers':'capsicum','green bell pepper':'capsicum','green bell peppers':'capsicum','red capsicum':'capsicum','green capsicum':'capsicum',
    'yellow pepper':'capsicum','yellow peppers':'capsicum',paprika:'capsicum',chilli:'capsicum',chillies:'capsicum',
    chickpeas:'chickpea','chick peas':'chickpea','garbanzo beans':'chickpea',lentils:'lentil','green lentils':'lentil','brown lentils':'lentil',
    peas:'pea','green peas':'pea',cowpeas:'cowpea','black eyed peas':'cowpea','black-eyed peas':'cowpea',
    'white rice':'rice','brown rice':'rice','wholegrain rice':'rice','whole grain rice':'rice',
    oats:'oat','rolled oats':'oat','porridge oats':'oat',
    'wholemeal wheat':'wheat','wholewheat pasta':'wheat','whole wheat pasta':'wheat','white pasta':'wheat',pasta:'wheat',spaghetti:'wheat',
    soybeans:'soybean','soy beans':'soybean','soya beans':'soybean',soya:'soybean',soy:'soybean',tofu:'soybean',edamame:'soybean',
    sweetcorn:'maize',corn:'maize',
    cilantro:'coriander',arugula:'rocket',zucchini:'courgette',eggplant:'aubergine',eggplants:'aubergine',cacao:'cocoa',
    'chia seed':'chia','chia seeds':'chia',flaxseed:'flax','flax seed':'flax','flax seeds':'flax',linseed:'flax',linseeds:'flax',
    blueberries:'blueberry','goji berries':'goji berry'
  });
  function canonicalPlantName(name){const value=typeof name==='string'?name.toLowerCase().trim().replace(/\s+/g,' '):'';return Object.hasOwn(plantAliases,value)?plantAliases[value]:value;}
  // Identify only plants actually named in an ingredient, including catalogue
  // wording such as "Chutney, apple, homemade". This does not identify an
  // anonymous mix, infer a bread's grain, or supply nutrient quantities.
  const namedPlantForms=Object.freeze({
    blueberry:'blueberr(?:y|ies)',raspberry:'raspberr(?:y|ies)',strawberry:'strawberr(?:y|ies)',blackberry:'blackberr(?:y|ies)',
    cranberry:'cranberr(?:y|ies)','goji berry':'goji berr(?:y|ies)',banana:'bananas?',apple:'apples?',pear:'pears?',orange:'oranges?',
    mango:'mango(?:es|s)?',pineapple:'pineapples?',kiwi:'kiwi(?:fruit)?s?',peach:'peach(?:es)?',apricot:'apricots?',cherry:'cherr(?:y|ies)',
    grape:'grapes?|raisins?|sultanas?',date:'dates?',fig:'figs?',lemon:'lemons?',lime:'limes?',avocado:'avocados?',pomegranate:'pomegranates?',
    chia:'chia(?: seeds?)?',flax:'flax(?:seeds?| seeds?)?|linseeds?',hemp:'hemp(?: seeds?)?',pumpkin:'pumpkin(?: seeds?)?',
    sunflower:'sunflower seeds?',sesame:'sesame(?: seeds?)?|tahini',almond:'almonds?',walnut:'walnuts?',cashew:'cashews?',peanut:'peanuts?',
    'brazil nut':'brazil nuts?',pecan:'pecans?',hazelnut:'hazelnuts?',macadamia:'macadamias?',pistachio:'pistachios?','pine nut':'pine nuts?',
    chestnut:'chestnuts?',coconut:'coconuts?',spinach:'spinach',kale:'kale',broccoli:'broccoli|broccolini',carrot:'carrots?',tomato:'tomato(?:es)?',
    cucumber:'cucumbers?',capsicum:'capsicum|(?:red|green|yellow|bell) peppers?|chilli(?:es)?|paprika',courgette:'courgettes?|zucchini',
    aubergine:'aubergines?|eggplants?',mushroom:'mushrooms?',onion:'onions?|scallions?',garlic:'garlic',pea:'peas?',
    maize:'maize|sweetcorn|corn',cauliflower:'cauliflower',cabbage:'cabbages?',lettuce:'lettuce',beetroot:'beetroots?',
    celery:'celery','sweet potato':'sweet potatoes?|sweet potato',potato:'potato(?:es)?',oat:'oats?',rice:'rice',wheat:'wheat|wholewheat',
    rye:'rye',barley:'barley',buckwheat:'buckwheat',quinoa:'quinoa',millet:'millet',lentil:'lentils?',chickpea:'chick ?peas?|garbanzo beans?',cowpea:'cowpeas?|black[- ]eyed peas?',
    'black beans':'black beans?','kidney beans':'kidney beans?','cannellini beans':'cannellini beans?',soybean:'soybeans?|soya beans?|soy beans?|edamame|tofu',
    watercress:'watercress',rocket:'rocket|arugula',parsley:'parsley',basil:'basil',coriander:'coriander|cilantro',mint:'mint',
    rosemary:'rosemary',thyme:'thyme',oregano:'oregano',sage:'sage',dill:'dill',chives:'chives?',ginger:'ginger',turmeric:'turmeric',
    cinnamon:'cinnamon',cumin:'cumin','black pepper':'black pepper',mustard:'mustard',cocoa:'cocoa|cacao'
  });
  const namedPlantPatterns=Object.entries(namedPlantForms).map(([name,pattern])=>[name,new RegExp('\\b(?:'+pattern+')\\b','i')]);
  function namedIngredientPlants(value){
    const result=[],seen=new Set();
    for(const raw of (Array.isArray(value)?value:[]).slice(0,40)){
      if(typeof raw!=='string'||!raw.trim()||raw.length>160)continue;
      // A warning, alternative or absence statement is not presence evidence.
      const text=raw.replace(/\b(?:may contain|traces? of|allergy advice|made in|manufactured in|produced in|without|free from|no|not)\b[\s\S]*/i,'')
        .replace(/\b[\p{L}]+(?:[- ]+free)\b/giu,'');
      if(!/\s+and\s+|[+&]/i.test(text)&&/\b(?:oil|juice|drink|extract|protein powder|protein isolate|creatine)\b/i.test(text))continue;
      for(const segment of text.split(/[;,()]+|\s+and\s+|[+&]/i)){
        if(/\b(?:no|not|without|free from|or|oil|sugar|syrup|starch|lecithin|flavou?ring|extract|isolates?|juice|drink|protein powder|protein isolate|creatine)\b/i.test(segment))continue;
        // Named plant drinks do not establish whole-plant intake under the
        // existing diary policy. Nut butters and ground spices remain foods.
        if(/\b(?:milk|cream|water)\b/i.test(segment))continue;
        for(const [name,pattern] of namedPlantPatterns){
          const match=segment.match(pattern);if(!match||seen.has(name))continue;
          if(name==='potato'&&/\bsweet potato(?:es)?\b/i.test(segment))continue;
          if(name==='pea'&&/\b(?:chick|black[- ]eyed)\s+$/i.test(segment.slice(0,match.index)))continue;
          seen.add(name);result.push({name,evidence:raw.trim().slice(0,160),source:'named_ingredient'});
        }
      }
    }
    return result;
  }
  function namedComponentPlants(components){
    const result=[],seen=new Set();
    for(const c of (Array.isArray(components)?components:[]).slice(0,40)){
      if(!c||c.selected===false||c.amountGrams===0||typeof c.name!=='string')continue;
      if(c.recovery?.identity==='generic_proxy'||c.recordId&&(c.sourceRecord?.id!==c.recordId||c.sourceRecord.basis!=='per100g'))continue;
      const proof=typeof c.evidence==='string'?c.evidence.trim():'';
      if(!proof||/\b(?:not (?:food|edible)|inedible|could not be linked|unidentified|unknown ingredient)\b/i.test(proof))continue;
      for(const p of namedIngredientPlants([c.userConfirmedIngredient||c.name])){
        if(seen.has(p.name))continue;seen.add(p.name);
        result.push({...p,evidence:proof.slice(0,160),source:'named_food_component'});
      }
    }
    return result;
  }
  function plantIdentity(recordId){return typeof recordId==='string'&&Object.hasOwn(plantRecords,recordId)?plantRecords[recordId]:null;}
  function plantIsOilOnly(plant,ingredients=[]){
    const name=canonicalPlantName(plant?.name),names={sunflower:['sunflower','sunflower seeds?'],olive:['olive','olives?'],sesame:['sesame','sesame seeds?'],rapeseed:['rapeseed','rapeseeds?'],peanut:['peanut','peanuts?'],coconut:['coconut','(?:coconut flesh|coconut flakes|desiccated coconut)']}[name];
    if(!names)return false;
    const oil=new RegExp('\\b'+names[0]+' oil\\b','gi'),food=new RegExp('\\b'+names[1]+'\\b','i'),proof=typeof plant.evidence==='string'?plant.evidence:'';
    if(!new RegExp(oil.source,'i').test(proof))return false;
    const wholeEvidence=[proof,...(Array.isArray(ingredients)?ingredients:[]).flatMap(i=>[i?.name,i?.evidence])].filter(v=>typeof v==='string');
    return !wholeEvidence.some(v=>food.test(v.replace(oil,'')));
  }
  function componentPlants(components){
    const result=[],seen=new Map();
    for(const c of (Array.isArray(components)?components:[]).slice(0,40)){
      if(!c||c.selected===false||c.amountGrams===0||c.recovery?.identity==='generic_proxy'||!c.recordId||c.sourceRecord?.id!==c.recordId||c.sourceRecord.basis!=='per100g')continue;
      const identities=Object.hasOwn(namedPlantBlends,c.recordId)?namedPlantBlends[c.recordId]:[plantIdentity(c.recordId)].filter(Boolean);if(!identities.length)continue;
      const proof=typeof c.evidence==='string'?c.evidence.trim().slice(0,160):'';
      // A selected composition estimate needs linked visual evidence or an
      // explicit food-source selection. Merely confirming grams is insufficient.
      if(!proof&&c.matchStatus!=='confirmed')continue;
      for(const name of identities){
        const evidence=proof||'User-selected food composition: '+name;
        if(seen.has(name)){seen.get(name).componentRecordIds.push(c.recordId);continue;}
        const plant={name,evidence,componentRecordIds:[c.recordId],source:'selected_food_components'};
        seen.set(name,plant);result.push(plant);
      }
    }
    for(const p of result)p.componentRecordIds=[...new Set(p.componentRecordIds)];
    return result;
  }
  function value(raw,unit='g') {
    const text=String(raw??'').trim();
    if(/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text))return {value:Number(text),unit,status:'composition_estimate',original:raw};
    return {value:null,unit,status:text.toLowerCase()==='tr'?'trace':'unknown',original:raw??null,missingReason:text.toLowerCase()==='tr'?'Trace, not a quantified value':'No reliable quantity in the source record'};
  }
  function nutrients(record){
    const result=Object.fromEntries(keys.filter(k=>k!=='salt').map(k=>[k,value(record.values?.[k],k==='energyKcal'?'kcal':'g')]));
    const sodium=value(record.values?.sodiumMg,'mg');
    result.salt={...sodium,value:known(sodium.value)?sodium.value*2.5/1000:null,unit:'g',status:known(sodium.value)?'derived':sodium.status,conversion:'Sodium mg × 2.5 ÷ 1000 = salt g'};
    return result;
  }
  function total(components){
    return Object.fromEntries(keys.map(key=>{
      // Retain a subtotal on one compatible basis. Different carbohydrate
      // definitions must not be added, but they must not erase known potato,
      // flour or other values either. Prefer the UK available-carbohydrate basis.
      const definition=c=>c.sourceRecord?.carbohydrateDefinition||c.carbohydrateDefinition||'unspecified';
      const definitions=key==='carbohydrate'?new Set((components||[]).filter(c=>known(c.amountGrams)&&c.amountGrams>0&&known(c.nutrients?.[key]?.value)).map(definition)):null;
      const basis=definitions?.has('available')?'available':definitions?.has('by_difference_including_fibre')?'by_difference_including_fibre':definitions?.values().next().value;
      let subtotal=0,unknown=0,contributions=0,excludedBasis=0;
      for(const c of components||[]){
        const n=c.nutrients?.[key];
        if(known(c.amountGrams)&&c.amountGrams>0&&known(n?.value)){
          if(key==='carbohydrate'&&definition(c)!==basis){unknown++;excludedBasis++;continue;}
          subtotal+=n.value*c.amountGrams/100;contributions++;
        }
        else unknown++;
      }
      return [key,{value:unknown||!components?.length?null:subtotal,knownSubtotal:subtotal,knownContributions:contributions,unknownContributions:unknown,unit:key==='energyKcal'?'kcal':'g',status:unknown?'unknown':'composition_estimate',...(key==='carbohydrate'&&basis?{carbohydrateDefinition:basis}:{}),...(excludedBasis?{missingReason:'Partial carbohydrate subtotal; incompatible source definitions are excluded.'}:{})}];
    }));
  }
  // Model quantities are a separate, bounded estimate of ONE edible portion.
  // They never become food database records or substitute a known subtotal for
  // a complete meal. Carbohydrate here excludes fibre; salt is grams, not sodium.
  const MODEL_ESTIMATE_SOURCE='model_photo_estimate';
  function validateNutrientEstimate(input){
    const exact=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...names].sort().join(',');
    if(!exact(input,['version','basis','portionGrams','category','fvlPercent','nutrients','assumptions'])
      ||input.version!==1||input.basis!=='perPortion'||!known(input.portionGrams)||input.portionGrams<1||input.portionGrams>1500
      ||!['general','red_meat','cheese','fats_nuts_seeds'].includes(input.category)
      ||input.fvlPercent!==null&&(!known(input.fvlPercent)||input.fvlPercent>100)
      ||!exact(input.nutrients,keys)||!Array.isArray(input.assumptions)||!input.assumptions.length||input.assumptions.length>6
      ||input.assumptions.some(s=>typeof s!=='string'||!s.trim()||s.length>180||/[\u0000-\u001f]/.test(s)))return null;
    const n=input.nutrients,g=input.portionGrams;
    const macroEnergy=4*(n.protein+n.carbohydrate)+9*n.fat+2*n.fibre;
    if(keys.some(k=>!known(n[k])||n[k]>(k==='energyKcal'?10*g:g))
      ||n.sugars>n.carbohydrate+.05||n.saturatedFat>n.fat+.05
      ||n.protein+n.carbohydrate+n.fat+n.fibre+n.salt>g*1.05
      ||n.energyKcal===0&&macroEnergy>0||Math.abs(n.energyKcal-macroEnergy)>Math.max(50,macroEnergy*.5))return null;
    return JSON.parse(JSON.stringify(input));
  }
  function nutrientEstimateContext(meal){
    return JSON.stringify({name:meal?.name||'',components:(meal?.components||[]).map(c=>[c.name,c.preparation,c.amountGrams,c.selected!==false]),
      recipe:meal?.recipeCalculation?.applied===true});
  }
  function activeNutrientEstimate(meal){
    if(!meal||meal.userEdited||meal.isFood===false||meal.nonFood===true||meal.type==='unknown'
      ||root.NudgeMealScore?.supportsNutrientEstimateIdentity?.(meal)!==true
      ||meal.recipeCalculation?.applied||meal.components?.some(c=>c?.recipeQuantity||c?.userEdited||c?.amountSource==='confirmed'||c?.matchMethod==='user_selected'||c?.matchStatus==='confirmed'||c?.selected===false)
      ||meal.nutrientEstimateContext!==nutrientEstimateContext(meal))return null;
    const estimate=validateNutrientEstimate(meal.nutrientEstimate);
    if(estimate&&meal.userPortion?.unit==='g'&&meal.userPortion.amount!==estimate.portionGrams)return null;
    return estimate;
  }
  function estimatePortionGrams(meal,estimate=activeNutrientEstimate(meal)){
    if(!estimate)return null;
    const components=meal.components||[];
    return components.length&&components.every(c=>known(c.amountGrams)&&c.amountGrams>0)?components.reduce((sum,c)=>sum+c.amountGrams,0):estimate.portionGrams;
  }
  function mealNutrition(meal){
    const result=total(meal?.components),estimate=activeNutrientEstimate(meal);
    if(!estimate)return result;
    const scale=estimatePortionGrams(meal,estimate)/estimate.portionGrams;
    for(const key of keys)if(!known(result[key].value))result[key]={...result[key],value:estimate.nutrients[key]*scale,status:'estimated',estimated:true,
      source:MODEL_ESTIMATE_SOURCE,basis:'perPortion',relation:'approx',carbohydrateDefinition:key==='carbohydrate'?'available':undefined};
    return result;
  }
  // Read only: recover arithmetic from the exact source/amount snapshot the user
  // already confirmed. Never rematch foods or update a saved diary on display.
  function intakeNutrient(entry,key){
    if(!keys.includes(key))return {value:null,partial:false};
    const item=entry.nutritionSnapshot?.[key],unit=key==='energyKcal'?'kcal':'g';
    if(item?.unit===unit&&item.portionStatus==='calculated'&&known(item.portion))return {value:item.portion,partial:false,...(item.estimated===true?{estimated:true}:{})};
    const scalar={energyKcal:'energyPerPortion',protein:'proteinPerPortion',fibre:'fibrePerPortion'}[key];
    if(scalar&&known(entry[scalar]))return {value:entry[scalar],partial:false};
    // An explicitly cleared diary value is a correction, not legacy missing
    // metadata. Keep the original composition as provenance without restoring it.
    if(key==='carbohydrate'&&item?.portion===null&&item.portionStatus==='unknown'&&
      /(?:^|;\s*)Carbohydrate amount edited by user(?:;|$)/.test(entry.sourceMeta?.retainedNutrients||''))return {value:null,partial:false};
    if(item?.unit===unit&&item.portionStatus==='partial'&&known(item.knownPortionSubtotal)&&item.knownContributions>0&&item.unknownContributions>0)return {value:item.knownPortionSubtotal,partial:true,estimated:true};
    const components=entry.sourceMeta?.mealComposition,scale=Number(entry.sourceMeta?.photoPortions);
    if(!Array.isArray(components)||!components.length||components.length>40||!Number.isFinite(scale)||scale<.0001||scale>8)return {value:null,partial:false};
    const safe=components.map(c=>{
      const source=c?.sourceRecord,linked=Boolean(c?.recordId&&source?.id===c.recordId&&source.basis==='per100g');
      const nutrients=Object.fromEntries(keys.map(k=>{const n=c?.nutrients?.[k],expected=k==='energyKcal'?'kcal':'g';return [k,linked&&n?.unit===expected?n:{value:null,unit:expected}];}));
      return {...c,nutrients};
    });
    const result=total(safe)[key];
    return result.knownContributions>0?{value:result.knownSubtotal*scale,partial:result.unknownContributions>0,estimated:true}:{value:null,partial:false};
  }
  const COMPOUND_VERSION='compound-proxies-v1';
  // A small reviewed subset of the bundled CoFID dataset. Complete source rows,
  // not generated recipe percentages; parity is tested against the imported data.
  const compoundProfiles=[{
    names:['sausage roll','sausage rolls','pork sausage roll','pork sausage rolls'],
    groups:[['pastry','puff pastry','flaky pastry'],['sausage meat','pork sausage meat','lincolnshire sausage meat']],
    record:{id:'19-468:ec99331e0ea1',code:'19-468',name:'Sausage roll, flaky pastry, ready-to-eat, retail',
      description:'10 samples, 10 products, mini and large',sourceReference:'DH, Nutrient analysis of a range of processed foods with particular reference to trans fatty acids, 2013',
      source:'UK CoFID',sourceVersion:'CoFID-2021-proximates-v1',
      sourceURL:'https://assets.publishing.service.gov.uk/media/60538b91e90e07527df82ae4/McCance_Widdowsons_Composition_of_Foods_Integrated_Dataset_2021..xlsx',
      licenceURL:'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
      basis:'per100g',valueStatus:'composition_estimate',foodGroup:'mixed_dish',fvlEligible:null,plantIdentity:null,carbohydrateDefinition:'available'},
    values:{energyKcal:'352',protein:'8.4',carbohydrate:'27.0',sugars:'1.3',fat:'24.1',saturatedFat:'10.36',fibre:'3.4',sodiumMg:'577'}
  }];
  const foodName=s=>typeof s==='string'?s.toLowerCase().trim().replace(/[-_]/g,' ').replace(/\s+/g,' '):'';
  const clone=v=>JSON.parse(JSON.stringify(v));
  function compoundRecord(id){const p=compoundProfiles.find(p=>p.record.id===id);return p?{...p.record,nutrients:nutrients({values:p.values})}:null;}
  function proposeMeal(meal,{confirmed=false,userEdited=false}={}){
    if(!meal||confirmed||userEdited||meal.portionMode!=='estimated_serving'||meal.scoreSnapshot?.available||meal.compoundProposal)return meal;
    const input=meal.components;
    if(!Array.isArray(input)||!input.length||input.length>2)return meal;
    const identity=foodName(meal.name||input.length===1&&input[0]?.name),profile=compoundProfiles.find(p=>p.names.includes(identity));
    if(!profile)return meal;
    const context=[meal.name,meal.subject?.description,...input.flatMap(c=>[c?.name,c?.preparation,c?.evidence]),...(Array.isArray(meal.ingredients)?meal.ingredients:[]).flatMap(i=>[i?.name,i?.evidence])].map(foodName).join(' ');
    if(/\b(?:vegan|vegetarian|meat free|plant based|gluten free|shortcrust|short pastry|homemade|home made|chicken|turkey)\b/.test(context))return meal;
    // An edit, selected match or discarded component is the user's evidence.
    // Never overwrite it just to make a generic estimate available.
    if(input.some(c=>!c||c.recordId||c.sourceRecord||c.userEdited||c.selected===false||c.matchStatus==='confirmed'||c.matchMethod==='user_selected'||c.amountSource==='confirmed'
      ||!known(c.amountGrams)||c.amountGrams<=0||!['','unknown','cooked','baked','oven baked','ready to eat'].includes(foodName(c.preparation))))return meal;
    const names=input.map(c=>foodName(c.name));
    const whole=input.length===1&&profile.names.includes(names[0]);
    const parts=input.length===profile.groups.length&&profile.groups.every(group=>names.filter(name=>group.includes(name)).length===1);
    if(!whole&&!parts)return meal;
    if(input.some(c=>!Number.isInteger(c.photoIndex)||c.photoIndex<1||c.photoIndex>4||typeof c.evidence!=='string'||!c.evidence.trim()))return meal;
    const photoIndexes=new Set(input.map(c=>c.photoIndex)),photoIds=new Set(input.map(c=>c.photoId).filter(v=>typeof v==='string'&&v));
    if(photoIndexes.size>1||photoIds.size>1)return meal;
    const amountGrams=input.reduce((sum,c)=>sum+c.amountGrams,0);if(amountGrams>1500)return meal;
    const record=compoundRecord(profile.record.id),originalComponents=clone(input),source=input[0];
    const candidates=[record,...input.flatMap(c=>Array.isArray(c.candidates)?c.candidates:[])].filter((r,i,a)=>r?.id&&a.findIndex(x=>x?.id===r.id)===i).slice(0,3);
    const component={...source,name:meal.name||source.name,amountGrams,amountSource:'standard_portion_estimate',recordId:record.id,sourceRecord:record,nutrients:record.nutrients,candidates,
      matchStatus:'matched',matchMethod:'curated_compound_proxy',preparationProxy:true,excludedPreparation:null,
      compoundProxy:{version:COMPOUND_VERSION,sourceRecordId:record.id,originalComponents:input.map(c=>({name:c.name,preparation:c.preparation,amountGrams:c.amountGrams,amountSource:c.amountSource||'',evidence:c.evidence,photoIndex:c.photoIndex,photoId:c.photoId||'',assumptions:(Array.isArray(c.assumptions)?c.assumptions:[]).join('\n')}))},
      assumptions:[...new Set(input.flatMap(c=>Array.isArray(c.assumptions)?c.assumptions:[])),
        'Generic whole-recipe estimate: '+record.name+'. The actual product or recipe may differ.',
        'Uses one complete composition record; no meat, pastry or ingredient percentages are inferred.',
        'The proposed grams are retained. Extra toppings and sauces are not included.']};
    const result={...meal,components:[component],nutrients:total([component]),portion:{...meal.portion,amount:amountGrams,unit:'g',source:'estimated'},
      compositionVersion:[meal.compositionVersion,COMPOUND_VERSION].filter(Boolean).join('+'),
      compoundProposal:{version:COMPOUND_VERSION,sourceRecordId:record.id,originalComponents}};
    if(result.scoreSnapshot?.available===false)delete result.scoreSnapshot;
    return result;
  }
  const api={keys,value,nutrients,total,MODEL_ESTIMATE_SOURCE,validateNutrientEstimate,nutrientEstimateContext,activeNutrientEstimate,estimatePortionGrams,mealNutrition,intakeNutrient,plantIdentity,canonicalPlantName,namedIngredientPlants,namedComponentPlants,componentPlants,plantIsOilOnly,COMPOUND_VERSION,compoundRecord,proposeMeal};root.NudgeComposition=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window==='object'?window:globalThis);
