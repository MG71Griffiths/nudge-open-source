/* Confirmed-intake schema, evidence cleaning and plant-name rules.
 * Pure consumers inject calendar validation and the known-recipe lookup. */
(function(root){
  'use strict';
  function create({dayNumber,recipeKnown,composition=()=>null}){
    if(typeof dayNumber!=='function'||typeof recipeKnown!=='function')throw new TypeError('Food log requires calendar and recipe adapters.');
  const validDay = key => dayNumber(key)!==null;
  const normalise = text => String(text).trim().toLowerCase().replace(/\s+/g,' ');
  const aliases={grapes:'grape',raisin:'grape',raisins:'grape',sultana:'grape',sultanas:'grape',apricots:'apricot',cranberries:'cranberry',almonds:'almond',cashews:'cashew',hazelnuts:'hazelnut',pistachios:'pistachio',pecans:'pecan',soybeans:'soybean',oat:'oats',blueberries:'blueberry',raspberries:'raspberry',walnuts:'walnut',chickpeas:'chickpea',tomatoes:'tomato',lentils:'lentil',potatoes:'potato',carrots:'carrot',oranges:'orange',peanuts:'peanut',avocados:'avocado','white rice':'rice','brown rice':'rice','wholemeal wheat':'wheat'};
  function names(value,limit=40){return [...new Set((Array.isArray(value)?value:String(value||'').split(',')).map(normalise).map(x=>Object.hasOwn(aliases,x)?aliases[x]:x).filter(x=>x&&x.length<=40))].slice(0,limit);}
  const plantAliases={'peanut butter':'peanut','almond butter':'almond',tahini:'sesame','sesame seeds':'sesame','sunflower seeds':'sunflower','pumpkin seeds':'pumpkin','chia seed':'chia','chia seeds':'chia',flaxseed:'flax','flax seed':'flax','flax seeds':'flax',linseed:'flax',linseeds:'flax','hemp seeds':'hemp','brazil nuts':'brazil nut',macadamias:'macadamia','pine nuts':'pine nut',chestnuts:'chestnut',strawberries:'strawberry',blackberries:'blackberry',cherries:'cherry',dates:'date',mushrooms:'mushroom','goji berries':'goji berry'};
  const wholeIngredients=new Set(('Blueberries|Raspberries|Strawberries|Blackberries|Banana|Apple|Pear|Orange|Mango|Pineapple|Kiwi|Peach|Apricot|Cherries|Grapes|Dates|Lemon|Lime|Avocado|Pomegranate|Goji berry|Chia seeds|Flaxseed|Hemp seeds|Pumpkin seeds|Sunflower seeds|Sesame seeds|Almonds|Walnuts|Cashews|Peanuts|Brazil nuts|Pecans|Hazelnuts|Macadamias|Pistachios|Pine nuts|Chestnuts|Coconut|Peanut butter|Almond butter|Tahini|Spinach|Kale|Broccoli|Carrot|Tomato|Cucumber|Red pepper|Courgette|Aubergine|Mushrooms|Onion|Garlic|Peas|Sweetcorn|Cauliflower|Cabbage|Lettuce|Beetroot|Celery|Sweet potato|Oats|Brown rice|White rice|Quinoa|Pasta|Wholewheat pasta|Couscous|Potato|Lentils|Chickpeas|Black beans|Kidney beans|Cannellini beans|Edamame|Tofu').split('|').map(normalise));
  const plantKey=value=>{
    const name=normalise(value),alias=Object.hasOwn(plantAliases,name)?plantAliases[name]:name;
    return names([composition()?.canonicalPlantName?.(alias)||alias],1)[0]||'';
  };
  function plantNames(value,limit=40){return [...new Set((Array.isArray(value)?value:[]).map(plantKey).filter(Boolean))].slice(0,limit);}
  let ingredientSource,canonicalIngredients;
  function ingredientPlants(value,{plants=[],components=[]}={}){
    // Exact reviewed identities only. A mixed food, oil, extract or protein
    // powder does not establish unnamed whole plants or any nutrient quantity.
    const source=composition();
    if(!canonicalIngredients||ingredientSource!==source){ingredientSource=source;canonicalIngredients=new Set([...wholeIngredients].map(plantKey));}
    const selected=(Array.isArray(value)?value:[]).filter(name=>typeof name==='string'),named=source?.namedIngredientPlants?.(selected)||[],
      keys=new Set([...selected.map(plantKey),...named.map(p=>plantKey(p.name))]);
    const matched=(Array.isArray(components)?components:[]).filter(c=>typeof c?.name==='string'&&keys.has(plantKey(c.userConfirmedIngredient||c.name)));
    return plantNames([...selected.filter(name=>canonicalIngredients.has(plantKey(name))),...named.map(p=>p.name),
      ...plants.filter(name=>keys.has(plantKey(name))),
      ...(source?.componentPlants?.(matched)||[]).map(p=>p.name),...(source?.namedComponentPlants?.(matched)||[]).map(p=>p.name)]);
  }
  function intakePlants(entry){
    const saved=plantNames(entry?.plants),meta=entry?.sourceMeta||{};
    if(meta.plantSelectionConfirmed===true)return saved;
    const selection=meta.mealIngredientSelection;
    if(selection?.source==='user'&&Array.isArray(selection.names)&&(selection.confirmed===true||selection.names.length)){
      const selected=ingredientPlants(selection.names,{plants:saved,components:meta.mealComposition});
      // Reanalysis hints establish presence, not a complete exclusion list.
      // Older explicit lists retain their prior semantics unless marked includes.
      return selection.scope==='includes'?plantNames([...saved,...selected,...(composition()?.namedComponentPlants?.(meta.mealComposition)||[]).map(p=>p.name)]):selected;
    }
    // Older recipe saves could retain source components but omit both plant
    // arrays. Recover that missing projection only; keep saved choices intact.
    if(saved.length||entry?.ingredients?.plants?.length||meta.plantKnowledge==='known'||entry?.ingredients?.needsReview!==true)return saved;
    return plantNames([...(composition()?.componentPlants?.(meta.mealComposition)||[]),...(composition()?.namedComponentPlants?.(meta.mealComposition)||[])].map(p=>p.name));
  }
  const finiteOrNull=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
  function nutritionSnapshot(value){const result={};if(!value||typeof value!=='object')return result;for(const key of ['energyKcal','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt']){const item=value[key];if(!item||typeof item!=='object')continue;
    const unit=key==='energyKcal'?'kcal':'g',partial=item.portion===null&&item.portionStatus==='partial'&&item.unit===unit&&finiteOrNull(item.knownPortionSubtotal)!==null&&Number.isInteger(item.knownContributions)&&item.knownContributions>0&&Number.isInteger(item.unknownContributions)&&item.unknownContributions>0&&item.knownContributions+item.unknownContributions<=40;
    result[key]={...(key==='carbohydrate'&&['available','by_difference_including_fibre','unspecified'].includes(item.carbohydrateDefinition)?{carbohydrateDefinition:item.carbohydrateDefinition}:{}),per100:finiteOrNull(item.per100),portion:finiteOrNull(item.portion),unit,per100Status:finiteOrNull(item.per100)!==null&&['supplied','calculated'].includes(item.per100Status)?item.per100Status:'unknown',...(item.estimated===true&&['model_photo_estimate','typed_food_estimate'].includes(item.source)&&finiteOrNull(item.portion)!==null?{estimated:true,source:item.source,relation:'approx'}:{}),portionStatus:finiteOrNull(item.portion)!==null&&item.portionStatus==='calculated'?'calculated':partial?'partial':'unknown',...(partial?{knownPortionSubtotal:item.knownPortionSubtotal,knownContributions:item.knownContributions,unknownContributions:item.unknownContributions}:{})};}return result;}
  function ingredients(value){
    if(!value||typeof value!=='object'||typeof value.text!=='string')return null;
    const text=value.text.trim().slice(0,4000);if(!text)return null;
    const seen=new Set(),plants=[];
    for(const item of (Array.isArray(value.plants)?value.plants:[]).slice(0,40)){
      if(!item||typeof item.name!=='string'||typeof item.evidence!=='string')continue;
      const name=names([item.name],1)[0];if(!name||seen.has(name))continue;
      seen.add(name);plants.push({name,evidence:item.evidence.trim().slice(0,160)});
    }
    return {text,plants,needsReview:value.needsReview===true};
  }
  // Small structured provenance only; never retain image bodies or arbitrary source payloads.
  function provenance(value,depth=0){
    if(depth>9)return null;
    if(value===null||typeof value==='boolean')return value;
    if(typeof value==='number')return Number.isFinite(value)?value:null;
    if(typeof value==='string')return /^data:/.test(value)?'':value.slice(0,2000);
    if(Array.isArray(value))return value.slice(0,40).map(x=>provenance(x,depth+1));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['__proto__','prototype','constructor','imageBase64','photos','images','thumbnail','imageData','base64','audioBase64','audio','voiceMemo'].includes(key)).slice(0,100).map(([key,item])=>[key,provenance(item,depth+1)]));
    return null;
  }
  const repertoireImage=value=>typeof value==='string'&&((value.length<=2048&&/^https:\/\//.test(value))||(value.length<=49152&&/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(value)))?value:'';
  const photoReferences=value=>[...new Set((Array.isArray(value)?value:[]).filter(v=>typeof v==='string'&&/^nudge-photo:[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\.jpg$/.test(v)))].slice(0,4);
  const entryImage=entry=>photoReferences(entry?.sourceMeta?.entryPhotos)[0]||repertoireImage(entry?.sourceMeta?.entryThumbnail)||repertoireImage(entry?.sourceMeta?.repertoireImage)||'';
  function sourceMeta(value){if(!value||typeof value!=='object')return null;const text=(key,limit)=>typeof value[key]==='string'?value[key].slice(0,limit):'';return {...(value.typedFood?.version===1&&value.typedFood.analysisVersion==='nudge-text-food-v1'&&typeof value.typedFood.description==='string'&&value.typedFood.description.length<=2000&&Array.isArray(value.typedFood.components)&&value.typedFood.components.length<=20?{typedFood:provenance(value.typedFood)}:{}),...(value.localLabelEvidence?.version==='local-food-label-v1'&&Array.isArray(value.localLabelEvidence.evidence)&&value.localLabelEvidence.evidence.length<=24?{localLabelEvidence:provenance(value.localLabelEvidence)}:{}),...(photoReferences(value.entryPhotos).length?{entryPhotos:photoReferences(value.entryPhotos)}:{}),...(repertoireImage(value.entryThumbnail)?{entryThumbnail:repertoireImage(value.entryThumbnail)}:{}),...(text('repertoireId',120)?{repertoireId:text('repertoireId',120)}:{}),...(repertoireImage(value.repertoireImage)?{repertoireImage:repertoireImage(value.repertoireImage)}:{}),...(value.recipeSnapshot&&typeof value.recipeSnapshot==='object'?{recipeSnapshot:provenance(value.recipeSnapshot)}:{}),provider:text('provider',80),url:text('url',300),retrievedAt:text('retrievedAt',40),licence:text('licence',100),licenceURL:text('licenceURL',300),confirmationId:text('confirmationId',100),...(Array.isArray(value.scoreHistory)?{scoreHistory:provenance(value.scoreHistory.slice(-12))}:{}),scanEventId:text('scanEventId',120),...(value.plantSelectionConfirmed===true?{plantSelectionConfirmed:true}:{}),...(['product-consumption','saved-food'].includes(value.entryKind)?{entryKind:value.entryKind,productScanEventId:text('productScanEventId',120),consumedAt:text('consumedAt',40),portionSelection:provenance(value.portionSelection),...(value.portionSaltConflict===true?{portionSaltConflict:true}:{}),plantKnowledge:value.plantKnowledge==='known'?'known':'unknown',nutritionPreparation:['as_sold','prepared'].includes(value.nutritionPreparation)?value.nutritionPreparation:'unknown',scoreMethod:provenance(value.scoreMethod)}:{}),...(Array.isArray(value.mealComposition)?{mealComposition:provenance(value.mealComposition),...(value.mealRecipeCalculation&&typeof value.mealRecipeCalculation==='object'?{mealRecipeCalculation:provenance(value.mealRecipeCalculation)}:{}),...(value.mealNutrientEstimate?.version===1&&value.mealNutrientEstimate.source==='model_photo_estimate'&&composition()?.validateNutrientEstimate?.(value.mealNutrientEstimate.estimate)?{mealNutrientEstimate:provenance(value.mealNutrientEstimate)}:{}),compositionVersion:text('compositionVersion',100),...(['estimated_serving','photographed_portion'].includes(value.mealPortionMode)?{mealPortionMode:value.mealPortionMode}:{}),...(value.mealScore&&typeof value.mealScore==='object'?{mealScore:provenance(value.mealScore)}:{})}:{}),...(value.mealIngredientSelection?.source==='user'&&Array.isArray(value.mealIngredientSelection.names)?{mealIngredientSelection:{version:'meal-ingredients-v1',source:'user',...(value.mealIngredientSelection.scope==='includes'?{scope:'includes'}:{}),...(value.mealIngredientSelection.confirmed===true?{confirmed:true}:{}),names:[...new Set(value.mealIngredientSelection.names.filter(n=>typeof n==='string'&&n.trim()).map(n=>n.trim().slice(0,80)))].slice(0,40)}}:{}),...(value.mealWholePortion?.source==='user'&&finiteOrNull(value.mealWholePortion.amount)>0&&value.mealWholePortion.amount<=5000&&['g','ml'].includes(value.mealWholePortion.unit)?{mealWholePortion:{source:'user',amount:value.mealWholePortion.amount,unit:value.mealWholePortion.unit,nutritionScaled:value.mealWholePortion.nutritionScaled===true}}:{}),...(value.intakePortionSelection&&typeof value.intakePortionSelection==='object'?{intakePortionSelection:provenance(value.intakePortionSelection)}:{}),...(value.mealPortionSelection&&typeof value.mealPortionSelection==='object'?{mealPortionSelection:provenance(value.mealPortionSelection)}:{}),...(typeof value.mealBatchVolumeMl==='number'&&Number.isFinite(value.mealBatchVolumeMl)&&value.mealBatchVolumeMl>0&&value.mealBatchVolumeMl<=5000?{mealBatchVolumeMl:value.mealBatchVolumeMl}:{}),nutritionEstimate:text('nutritionEstimate',20),photoPortions:text('photoPortions',30),...(value.photoPortionBasis==='saved_portion'?{photoPortionBasis:'saved_portion'}:{}),labelBasis:text('labelBasis',20),labelServingSize:text('labelServingSize',80),labelUnits:text('labelUnits',300),retainedNutrients:text('retainedNutrients',150),priorSource:text('priorSource',180),...(text('portionLabel',80)?{portionLabel:text('portionLabel',80),portionSource:['label','estimated'].includes(value.portionSource)?value.portionSource:'estimated',portionBase:text('portionBase',30)}:{}),labelKind:['nutrition','ingredients','both','unreadable'].includes(value.labelKind)?value.labelKind:''};}
  function clean(raw){
    const result={entries:[],savedRecipes:[],plantGoal:30};
    if(!raw||typeof raw!=='object')return result;
    result.plantGoal=[10,20,30].includes(raw.plantGoal)?raw.plantGoal:30;
    result.savedRecipes=Array.isArray(raw.savedRecipes)?[...new Set(raw.savedRecipes.filter(recipeKnown))]:[];
    const seen=new Set(),seenConfirmations=new Set();
    result.entries=(Array.isArray(raw.entries)?raw.entries:[]).filter(x=>x&&typeof x.id==='string'&&x.id.length<=100&&validDay(x.day)&&typeof x.name==='string'&&x.name.trim()&&Number.isFinite(x.portions)&&x.portions>0&&x.portions<=8).flatMap(x=>{
      const meta=sourceMeta(x.sourceMeta);if(seen.has(x.id)||(meta?.confirmationId&&seenConfirmations.has(meta.confirmationId)))return [];seen.add(x.id);if(meta?.confirmationId)seenConfirmations.add(meta.confirmationId);
      const ingredientRecord=ingredients(x.ingredients),snapshot=nutritionSnapshot(x.nutritionSnapshot),barcode=typeof x.barcode==='string'&&/^\d{4,18}$/.test(x.barcode)?x.barcode:'';
      const hasNutrition=Boolean(barcode||meta?.labelBasis||Object.keys(snapshot).length||['complete','incomplete'].includes(x.nutritionStatus));
      const nutritionStatus=hasNutrition?['energyKcal','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'].every(key=>finiteOrNull(snapshot[key]?.portion)!==null)?'complete':'incomplete':'';
      return [{id:x.id,name:x.name.trim().slice(0,100),brand:typeof x.brand==='string'?x.brand.trim().slice(0,80)||null:null,day:x.day,slot:['Breakfast','Lunch','Dinner','Snack'].includes(x.slot)?x.slot:'',portions:x.portions,plants:names(x.plants),ingredients:ingredientRecord,ferments:names(x.ferments),energyPerPortion:finiteOrNull(x.energyPerPortion),proteinPerPortion:finiteOrNull(x.proteinPerPortion),fibrePerPortion:finiteOrNull(x.fibrePerPortion),...(x.ironMgPerPortion!==undefined?{ironMgPerPortion:finiteOrNull(x.ironMgPerPortion)}:{}),...(x.calciumMgPerPortion!==undefined?{calciumMgPerPortion:finiteOrNull(x.calciumMgPerPortion)}:{}),recipe:recipeKnown(x.recipe)?x.recipe:'',source:typeof x.source==='string'?x.source.slice(0,180):'Manual entry',barcode,portionAmount:typeof x.portionAmount==='number'&&Number.isFinite(x.portionAmount)&&x.portionAmount>0&&x.portionAmount<=5000?x.portionAmount:null,portionUnit:['g','ml'].includes(x.portionUnit)?x.portionUnit:null,nutritionStatus,nutritionSnapshot:snapshot,sourceMeta:meta}];
    });
    return result;
  }
  function summarise(entries){const known=entries.filter(e=>finiteOrNull(e.fibrePerPortion)!==null);return {plants:plantNames(entries.flatMap(intakePlants),Infinity),ferments:names(entries.flatMap(e=>e.ferments),Infinity),fibre:Math.round(known.reduce((sum,e)=>sum+e.fibrePerPortion*e.portions,0)*10)/10,fibreKnown:known.length,unknown:entries.length-known.length,meals:entries.length};}
  return {initial:()=>clean(null),clean,names,plantNames,ingredientPlants,intakePlants,ingredients,summarise,photoReferences,entryImage};
  }
  const api=Object.freeze({create});
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root){
    root.NudgeFoodLog=api;
    // Compatibility composition for the existing browser controllers. Resolve
    // catalogue/calendar dependencies when used, so script order stays stable.
    root.WmdFoodLog=create({
      dayNumber:key=>root.WmdStreakMath.dayNumber(key),
      recipeKnown:id=>Boolean(root.NudgeRecipeCatalogue?.byId(id)||['berry','chickpea','salmon'].includes(id)),
      composition:()=>root.NudgeComposition
    });
  }
})(typeof window==='object'?window:null);
