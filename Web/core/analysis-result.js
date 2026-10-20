/* Analysis-result contract v1. Evidence transformations; no diary writes or screen state.
 * Engines and compatibility normalisers are injected by the application adapter.
 * Unknown values, source precision and saved evidence retain their existing schema.
 * normalise/snapshot/buildRecord/repairProductRecord leave supplied evidence intact.
 * supplementMealPlants explicitly edits a review draft, never a saved snapshot.
 */
(function(root){
  'use strict';
  const version='analysis-result-v1';
  const fields=[['energyKcal','Energy'],['protein','Protein'],['carbohydrate','Carbohydrate'],['sugars','Sugars'],['fat','Fat'],['saturatedFat','Saturated fat'],['fibre','Fibre'],['salt','Salt']];
  const bases={unknown:true,per100g:true,per100ml:true,perServing:true,perPortion:true};
  const known=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  const identityText=(value,maximum=100)=>typeof value==='string'&&value.trim()?value.trim().slice(0,maximum):null;
  const estimatedServing=e=>e?.meal?.portionMode==='estimated_serving';
  const compositionMeal=e=>e?.type==='meal'&&e.meal?.compositionVersion&&Array.isArray(e.meal.components);
  function fastCaptureMarker(value){
    // The native coordinator stamps this after accepting a response. Preserve
    // its small routing contract; never infer it from model or nutrition fields.
    if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1
      ||Object.keys(value).sort().join(',')!=='captureRevision,inputKind,requestId,version'
      ||typeof value.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.requestId)
      ||!Number.isSafeInteger(value.captureRevision)||value.captureRevision<0
      ||!['packaging','nutrition_label','recipe_text','meal_photo'].includes(value.inputKind))return null;
    return {version:1,requestId:value.requestId,captureRevision:value.captureRevision,inputKind:value.inputKind};
  }
  function create(deps){
  const ingredientMode=e=>e?.labelKind==='ingredients';
  const hasIngredients=e=>['ingredients','both'].includes(e?.labelKind)&&Boolean(e.ingredients);
  const canonical=value=>deps.names([value],1)[0]||'';
  const mealPlantKey=value=>canonical(deps.composition?.canonicalPlantName?.(value)||value);
  const genericPlant=name=>/^(?:(?:mixed|assorted|natural)\s+)?(?:plants?|spices?|herbs?|vegetables?|fruits?|nuts?|seeds?|berries|grains?|flavou?r(?:ing)?s?|starch|sugars?|syrup|protein|fibre|fiber|colou?rs?)$|\b(?:blends?|mix|mixture|may contain|traces? of|refined|extract|isolates?)\b|^(?:vegetable|plant) oil$/i.test(name);
  const ingredientText=text=>{const source=text.toLowerCase().replace(/\s+/g,' '),trace=source.search(/\b(?:may contain|traces? of|made in|manufactured in|produced in|not suitable for|allergy advice)\b/);return trace<0?source:source.slice(0,trace);};
  function namedInText(name,text){
    const words=ingredientText(text).match(/[\p{L}\p{N}]+/gu)||[],wanted=canonical(name);if(!wanted)return false;
    for(let i=0;i<words.length;i++)for(let n=1;n<=4&&i+n<=words.length;n++)if(canonical(words.slice(i,i+n).join(' '))===wanted)return true;
    return false;
  }
  function ingredientPlants(raw,text){
    const result=[],seen=new Set(),actual=ingredientText(text);
    for(const item of (Array.isArray(raw)?raw:[]).slice(0,40)){
      if(!item||typeof item.name!=='string'||typeof item.evidence!=='string')continue;
      const name=canonical(item.name),evidence=item.evidence.trim().slice(0,160),proof=evidence.toLowerCase().replace(/\s+/g,' ');
      if(!name||genericPlant(name)||seen.has(name)||!proof||!actual.includes(proof))continue;
      seen.add(name);result.push({name,evidence,selected:true,originalName:name,userEdited:false});
    }
    return result;
  }
  function supportedPlant(e,plant){
    if(!plant||genericPlant(plant.name))return false;
    if(e.type==='meal'&&e.ingredients?.fromConfirmedSnapshot&&!e.ingredients.textEdited&&!plant.userEdited)return true;
    if(e.type==='meal'&&!e.ingredients?.fromConfirmedSnapshot&&deps.composition?.plantIsOilOnly?.(plant,[...(e.meal?.ingredients||[]),{name:e.ingredients?.text||''}]))return false;
    if(e.type==='meal'&&plant.source==='selected_food_components'&&!plant.userEdited&&!e.ingredients?.textEdited){
      return (deps.composition?.componentPlants?.(e.meal?.components)||[]).some(p=>mealPlantKey(p.name)===mealPlantKey(plant.name)&&p.componentRecordIds.some(id=>plant.componentRecordIds?.includes(id)));
    }
    if(namedInText(plant.name,e.ingredients?.text||''))return true;
    // Meal extraction identifies botanical names from visible food evidence. A
    // supported name such as capsicum need not literally occur in “red pepper”.
    // Keep that evidence link only while the ingredient and plant are unedited.
    if(e.type!=='meal'||plant.userEdited||e.ingredients?.textEdited||typeof plant.evidence!=='string')return false;
    const proof=plant.evidence.trim().toLowerCase();if(!proof)return false;
    return (e.meal?.ingredients||[]).some(item=>typeof item.name==='string'
      &&namedInText(item.name,e.ingredients.text)
      &&[item.name,item.evidence].some(text=>typeof text==='string'&&text.toLowerCase().includes(proof)));
  }
  function selectedPlants(e){
    const names=deps.names((e?.ingredients?.plants||[]).filter(p=>p.selected!==false&&supportedPlant(e,p)).map(p=>p.name));
    if(e?.type!=='meal'||e.ingredients?.fromConfirmedSnapshot)return names;
    const seen=new Set();return names.filter(name=>{const key=mealPlantKey(name);if(seen.has(key))return false;seen.add(key);return true;});
  }
  function supplementMealPlants(e){
    if(e.type!=='meal'||!e.ingredients||e.ingredients.textEdited||e.ingredients.fromConfirmedSnapshot)return;
    for(const plant of [...(deps.composition?.componentPlants?.(e.meal?.components)||[]),...(deps.composition?.namedComponentPlants?.(e.meal?.components)||[])]){
      // Both provider arrays may omit an evidenced component. Add only reviewed
      // source identities; aliases and explicit corrections must not duplicate it.
      if(e.ingredients.plants.some(p=>mealPlantKey(p.originalName||p.name)===mealPlantKey(plant.name)))continue;
      e.ingredients.plants.push({...plant,selected:true,originalName:plant.name,userEdited:false});
      if(!namedInText(plant.name,e.ingredients.text))e.ingredients.text=[e.ingredients.text,plant.name].filter(Boolean).join(', ');
    }
  }
  function recoverMeal(meal,options={}){
    const originalScore=meal?.scoreSnapshot;
    // A historical rating is provenance, not a reason to block a read-only
    // recovery proposal for an unconfirmed scan under the current method.
    const current=root.NudgeRecipeComposition?.recover?.(meal,options)||meal;
    const input=!options.confirmed&&!options.userEdited&&deps.frequency?.legacy(originalScore)?{...current,scoreSnapshot:null}:current;
    const recovered=deps.mealRecovery?.recover?.(input,options)||deps.composition?.proposeMeal?.(input,options)||input;
    return originalScore?{...recovered,scoreSnapshot:originalScore}:recovered;
  }
  const validMealScore=score=>deps.mealScore?.validResult?.(score)===true;
  const mealScore=e=>e?.confirmedSnapshot&&validMealScore(e.meal?.scoreSnapshot)?e.meal.scoreSnapshot:deps.mealScore?.calculate(e?.meal)||{available:false,value:null,reason:'Choose sourced food and amount details.'};
  function calculateComposition(input,{recipeLabel='Whole dish'}={}){
    if(!compositionMeal(input)||!deps.composition)return {extraction:input};
    if(input.confirmedSnapshot&&deps.composition.validateNutrientEstimate(input.meal.nutrientEstimate)
      &&fields.every(([key])=>Object.hasOwn(input.meal.nutrients||{},key)))return {extraction:input};
    const e={...input,meal:{...input.meal}},nutrients=input.userEdited?deps.composition.total(e.meal.components):deps.composition.mealNutrition(e.meal);
    e.nutrients=nutrients;e.meal.nutrients=JSON.parse(JSON.stringify(nutrients));
    if(e.meal.recipeCalculation?.applied){
      // Pre-cooking ingredient weight does not establish plated weight.
      e.meal.portion={label:recipeLabel,amount:null,unit:null,source:'estimated'};
      e.meal.portionAmbiguity={requiresSelection:false,reason:'Recipe quantities multiplied by the selected fraction; sides stay separate.'};
      return {extraction:e,portionConfirmed:true};
    }
    const complete=e.meal.components.length&&e.meal.components.every(c=>known(c.amountGrams)&&c.amountGrams>0);
    const confirmed=complete&&e.meal.components.every(c=>c.amountSource==='confirmed');
    const estimate=!input.userEdited&&deps.composition.activeNutrientEstimate(e.meal),grams=complete?e.meal.components.reduce((sum,c)=>sum+c.amountGrams,0):estimate?.portionGrams||null;
    e.meal.portion={label:'1 portion',amount:grams,unit:grams!==null?'g':null,source:confirmed?'confirmed':'estimated'};
    if(estimatedServing(e)){
      e.meal.portionAmbiguity={requiresSelection:!complete&&!estimate,reason:estimate?'One estimated portion is proposed; adjust the assumed recipe and weight.':complete?'One editable portion is proposed.':'Add the missing ingredient amounts in Edit.'};
      return {extraction:e,portionConfirmed:Boolean(complete||estimate)};
    }
    return {extraction:e};
  }
  function normalise(raw,{confirmedSnapshot=false,userEdited=false,recipeLabel='Whole dish'}={}) {
    if(!raw||typeof raw!=='object'||!raw.nutrients||typeof raw.nutrients!=='object')return null;
    const labelKind=['nutrition','ingredients','both','unreadable'].includes(raw.labelKind)?raw.labelKind:'nutrition';
    let meal=raw.type==='meal'&&raw.meal?JSON.parse(JSON.stringify(raw.meal)):null;
    if(meal)meal=recoverMeal(meal,{confirmed:confirmedSnapshot,userEdited:userEdited});
    if(meal&&userEdited)meal.userEdited=true;
    const e={type:raw.type||'legacy',meal,confirmedSnapshot,...(userEdited?{userEdited:true}:{}),labelKind,ingredients:null,productName:identityText(raw.productName),brand:identityText(raw.brand,80),basis:Object.hasOwn(bases,raw.basis)?raw.basis:'unknown',servingSize:null,needsClearerPhoto:raw.needsClearerPhoto===true,message:typeof raw.message==='string'?raw.message.slice(0,500):'',nutrients:{}};
    // Repairs need the same source constraints as a new product result. Losing
    // preparation, inequalities or conflicts here could turn a stale score into
    // an apparently current one after confirmed nutrition has changed.
    e.nutritionPreparation=['as_sold','prepared'].includes(raw.nutritionPreparation)?raw.nutritionPreparation:'unknown';
    e.energyKj=raw.energyKj?.unit==='kJ'&&known(raw.energyKj.value)?{value:raw.energyKj.value,unit:'kJ',...(typeof raw.energyKj.relation==='string'?{relation:raw.energyKj.relation}:{})}:null;
    e.metadata=raw.metadata&&typeof raw.metadata==='object'?JSON.parse(JSON.stringify(raw.metadata)):null;
    e.analysisId=identityText(raw.analysisId,160);e.analysisVersion=identityText(raw.analysisVersion,160);
    const fastCapture=fastCaptureMarker(raw.fastCapture);if(fastCapture)e.fastCapture=fastCapture;
    e.voiceNote=raw.voiceNote&&typeof raw.voiceNote.text==='string'?{text:raw.voiceNote.text.trim().slice(0,4000)}:null;
    e.servingSuggestion=deps.suggestion(raw.servingSuggestion);e.categoryTag=identityText(raw.categoryTag,100);e.retailer=identityText(raw.retailer,80);
    if(raw.servingSize&&known(raw.servingSize.value)&&raw.servingSize.value>=0.1&&raw.servingSize.value<=5000&&['g','ml'].includes(raw.servingSize.unit))e.servingSize={value:raw.servingSize.value,unit:raw.servingSize.unit};
    fields.forEach(([key])=>{const item=raw.nutrients[key],units=key==='energyKcal'?['kcal','kJ']:['g','mg'];e.nutrients[key]={value:item&&known(item.value)&&units.includes(item.unit)?item.value:null,unit:units.includes(item?.unit)?item.unit:units[0],...(typeof item?.relation==='string'?{relation:item.relation}:{})};});
    if(['ingredients','both'].includes(labelKind)&&raw.ingredients&&typeof raw.ingredients.text==='string'){
      const text=raw.ingredients.text.trim().slice(0,4000);
      if(text)e.ingredients={text,plants:ingredientPlants(raw.ingredients.plants,text),needsReview:raw.ingredients.needsReview===true};
    }
    if(meal){e.productName=identityText(meal.name);e.labelKind='both';e.basis='perPortion';e.servingSize=null;e.needsClearerPhoto=false;e.message='Estimated from your photos. Check ingredients and amounts.';e.nutrients=Object.fromEntries(fields.map(([key])=>[key,{value:known(meal.nutrients?.[key]?.value)&&meal.nutrients[key].unit===(key==='energyKcal'?'kcal':'g')?meal.nutrients[key].value:null,unit:key==='energyKcal'?'kcal':'g',...(meal.nutrients?.[key]?.source==='model_photo_estimate'?{status:'estimated',estimated:true,source:'model_photo_estimate',relation:'approx'}:{}),...(known(meal.nutrients?.[key]?.knownSubtotal)&&Number.isInteger(meal.nutrients[key].knownContributions)&&Number.isInteger(meal.nutrients[key].unknownContributions)?{knownSubtotal:meal.nutrients[key].knownSubtotal,knownContributions:meal.nutrients[key].knownContributions,unknownContributions:meal.nutrients[key].unknownContributions}:{}),...(key==='carbohydrate'&&['available','by_difference_including_fibre','unspecified'].includes(meal.nutrients?.[key]?.carbohydrateDefinition)?{carbohydrateDefinition:meal.nutrients[key].carbohydrateDefinition}:{})}]));const visible=(meal.ingredients||[]).filter(p=>typeof p.name==='string').map(p=>p.name).join(', ');e.ingredients={text:visible,plants:(meal.plants||[]).filter(p=>typeof p.name==='string'&&!genericPlant(p.name)).map(p=>({name:canonical(p.name),evidence:p.evidence||'',selected:true,originalName:canonical(p.name),userEdited:false})),needsReview:true};}
    supplementMealPlants(e);Object.assign(e,calculateComposition(e,{recipeLabel}).extraction);
    if(ingredientMode(e)||e.labelKind==='unreadable'){e.basis='unknown';e.servingSize=null;fields.forEach(([key])=>{e.nutrients[key].value=null;});}
    return e;
  }
  // Keep source/calculated precision in confirmed records; rounding belongs in display helpers.
  function snapshot(e,{amount,unit,old=null,corrections={}}){const result={};fields.forEach(([key])=>{const item=e?.nutrients[key],outUnit=key==='energyKcal'?'kcal':'g',printedUnit=item?.unit||outUnit;let v=known(item?.value)?item.value:null;if(!((key==='energyKcal'?['kcal','kJ']:['g','mg']).includes(printedUnit)))v=null;if(v!==null&&printedUnit==='kJ')v/=4.184;if(v!==null&&printedUnit==='mg')v/=1000;let per100=null,portion=null;if(v!==null){if(e.type==='meal'&&e.basis==='perPortion'){portion=v*amount;}if((e.basis==='per100g'&&unit==='g')||(e.basis==='per100ml'&&unit==='ml'))per100=v;else if(e.basis==='perServing'&&e.servingSize?.unit===unit&&e.servingSize.value>0)per100=v*100/e.servingSize.value;if(per100!==null&&Number.isFinite(amount)&&amount>0)portion=per100*amount/100;}result[key]={per100:known(per100)?per100:null,portion:known(portion)?portion:null,unit:outUnit,per100Status:known(per100)?e.basis==='perServing'||printedUnit!==outUnit?'calculated':'supplied':'unknown',portionStatus:known(portion)?'calculated':'unknown',...(key==='carbohydrate'&&['available','by_difference_including_fibre','unspecified'].includes(item?.carbohydrateDefinition)?{carbohydrateDefinition:item.carbohydrateDefinition}:{}),...(known(portion)&&item?.source==='model_photo_estimate'?{estimated:true,source:'model_photo_estimate',relation:'approx'}:{})};
      if(portion===null&&compositionMeal(e)&&e.basis==='perPortion'&&known(amount)&&amount>0&&item?.unit===outUnit&&known(item.knownSubtotal)&&item.knownContributions>0&&item.unknownContributions>0){
        result[key]={...result[key],portionStatus:'partial',knownPortionSubtotal:item.knownSubtotal*amount,knownContributions:item.knownContributions,unknownContributions:item.unknownContributions};
      }
    });if(old){fields.forEach(([key])=>{if(result[key].portion!==null||(e.type==='meal'&&(compositionMeal(e)||Object.hasOwn(corrections,key))))return;const prior=old.nutritionSnapshot?.[key],fallback={energyKcal:'energyPerPortion',protein:'proteinPerPortion',fibre:'fibrePerPortion'}[key],portion=known(prior?.portion)?prior.portion:fallback&&known(old[fallback])?old[fallback]:null;if(portion===null)return;result[key]={per100:known(prior?.per100)?prior.per100:old.portionAmount?portion*100/old.portionAmount:null,portion,unit:key==='energyKcal'?'kcal':'g',per100Status:prior?.per100Status||'calculated',portionStatus:prior?.portionStatus||'calculated',retained:true};});}return result;}
  function buildRecord({extraction:e,old=null,amount,unit,day,draft,selection,profile={},avoidMilk=false,entries=[],retrievedAt}){const snap=snapshot(e,{amount,unit,old,corrections:draft.corrections||{}}),complete=fields.every(([key])=>snap[key].portion!==null);
    const base=old||{id:draft.confirmationId,barcode:draft.context?.barcode||'',day,slot:draft.slot,plants:[],ferments:[],recipe:'',portions:1};
    const ingredientRecord=hasIngredients(e)?{text:e.ingredients.text,needsReview:e.ingredients.needsReview,plants:selectedPlants(e).map(name=>({name,evidence:e.ingredients.plants.find(p=>p.selected!==false&&canonical(p.name)===name)?.evidence||''}))}:old?.ingredients||null;
    const record={...base,ingredients:ingredientRecord,plants:hasIngredients(e)?ingredientRecord.plants.map(p=>p.name):base.plants,name:draft.name,brand:draft.brand||null,portionAmount:e.type==='meal'?known(e.meal?.portion?.amount)&&['g','ml'].includes(e.meal.portion.unit)?e.meal.portion.amount*amount:draft.mealBatchVolumeMl?draft.mealBatchVolumeMl*amount:null:amount,portionUnit:e.type==='meal'?known(e.meal?.portion?.amount)&&['g','ml'].includes(e.meal.portion.unit)?e.meal.portion.unit:draft.mealBatchVolumeMl?'ml':null:unit,...(e.type==='meal'?{portions:1}:{}),energyPerPortion:snap.energyKcal.portion,proteinPerPortion:snap.protein.portion,fibrePerPortion:snap.fibre.portion,nutritionSnapshot:snap,nutritionStatus:complete?'complete':'incomplete',source:e.type==='meal'?'User-confirmed meal photo estimate':ingredientMode(e)?'User-confirmed ingredients-label extraction':e.labelKind==='both'?'User-confirmed nutrition and ingredients extraction':'User-confirmed nutrition-label extraction',sourceMeta:{...old?.sourceMeta,...(old?.sourceMeta?.portionSaltConflict===true&&snap.salt.portion!==null&&!snap.salt.retained?{portionSaltConflict:false}:{}),...(compositionMeal(e)?{mealComposition:e.meal.components.map(({candidates,...component})=>component),...(e.meal.recipeCalculation?{mealRecipeCalculation:JSON.parse(JSON.stringify(e.meal.recipeCalculation))}:{}),compositionVersion:e.meal.compositionVersion,mealPortionMode:estimatedServing(e)?'estimated_serving':'photographed_portion',mealScore:JSON.parse(JSON.stringify(deps.frequency?.apply(mealScore(e),{product:{ingredients:e.ingredients,ingredientsNeedsReview:true},profile:profile,avoidMilk:avoidMilk,entries:entries,day:base.day,slot:base.slot,excludeId:old?.id,salt:snap.salt.portion})||mealScore(e))),...(old?.sourceMeta?.mealScore?{scoreHistory:[...(old.sourceMeta.scoreHistory||[]),old.sourceMeta.mealScore].slice(-12)}:{})}:{}),...(e.type==='meal'?{mealPortionSelection:selection,mealBatchVolumeMl:draft.mealBatchVolumeMl}:{}),provider:e.type==='meal'?'User-confirmed meal photo estimate':'User-confirmed label extraction',scanEventId:draft.confirmationId,nutritionEstimate:e.type==='meal'?'photo':'',photoPortions:e.type==='meal'?String(amount):old?.sourceMeta?.photoPortions||'',retrievedAt:retrievedAt,confirmationId:old?.sourceMeta?.confirmationId||draft.confirmationId,labelKind:e.labelKind,portionLabel:old?.sourceMeta?.portionLabel||draft.portionLabel,portionSource:old?.sourceMeta?.portionSource||draft.portionSource,portionBase:old?.sourceMeta?.portionBase||String(draft.portionBase),labelBasis:ingredientMode(e)?old?.sourceMeta?.labelBasis||'unknown':e.basis,labelServingSize:ingredientMode(e)?old?.sourceMeta?.labelServingSize||'':e.servingSize?`${e.servingSize.value} ${e.servingSize.unit}`:'',labelUnits:ingredientMode(e)?old?.sourceMeta?.labelUnits||'':JSON.stringify(Object.fromEntries(fields.map(([key])=>[key,e.nutrients[key].unit]))),retainedNutrients:fields.filter(([key])=>snap[key].retained).map(([key])=>key).join(','),priorSource:old?.sourceMeta?.priorSource||old?.source||''}};
    // A new confirmed analysis replaces the old recipe provenance as well as
    // its components. Otherwise reopening can restore an obsolete batch.
    if(e.type==='meal'&&!e.meal?.recipeCalculation)delete record.sourceMeta.mealRecipeCalculation;
    if(e.type==='meal'){
      const estimate=deps.composition?.validateNutrientEstimate?.(e.meal?.nutrientEstimate);
      if(estimate)record.sourceMeta.mealNutrientEstimate={version:1,source:'model_photo_estimate',estimate,appliedFields:fields.filter(([key])=>snap[key].source==='model_photo_estimate').map(([key])=>key)};
      else delete record.sourceMeta.mealNutrientEstimate;
    }
    return record;
  }
  function refreshRepairedProductScore(record,old,e,{previousProduct,corrections={},profile={},avoidMilk=false,entries=[]}){
    if(!old||e.type==='meal')return;
    const meta=record.sourceMeta,history=[...(old.sourceMeta?.scoreHistory||[])];
    for(const key of ['scoreMethod','mealScore']){
      if(old.sourceMeta?.[key])history.push(JSON.parse(JSON.stringify(old.sourceMeta[key])));
      delete meta[key];
    }
    if(history.length)meta.scoreHistory=history.slice(-12);
    // Legacy manual entries need no new scan identity. Existing product intake
    // keeps its link, while its score is replaced even when recovery is incomplete.
    if(meta.entryKind!=='product-consumption')return;
    const core=deps.score,model=deps.foodDetail;
    if(!core||!model)return;
    const product=deps.productEvidence.fromExtraction(e),basis=record.portionUnit;
    const newTable=!ingredientMode(e),preparation=newTable?e.nutritionPreparation:old.sourceMeta?.nutritionPreparation||'unknown';
    // A partial table may retain saved intake, but cannot use nutrients from a
    // different or unknown preparation to complete its current quality score.
    const compatibleRetained=!newTable||preparation!=='unknown'&&preparation===old.sourceMeta?.nutritionPreparation;
    product.name=record.name;product.brand=record.brand;product.basisUnit=basis;product.nutritionPreparation=preparation;
    product.sourceName='User-confirmed label repair';product.retrievedAt=meta.retrievedAt;product.sourceVersion=e.analysisVersion||null;
    product.ingredients=record.ingredients?.text||'';product.ingredientsNeedsReview=record.ingredients?.needsReview??true;
    product.nutrientSources={};
    product.nutrients=Object.fromEntries(fields.map(([key])=>{
      const n=record.nutritionSnapshot[key],original=e.nutrients[key];
      const exact=!original?.relation||['=','eq'].includes(original.relation);
      const supported=known(n.per100)&&(n.retained?compatibleRetained:exact);
      product.nutrientSources[key]=n.retained?'Retained confirmed per-100 value from '+(old.sourceMeta?.provider||old.source||'saved diary'):'User-confirmed repair: '+e.basis+' '+original.unit;
      return [key,{value:supported?n.per100:null,unit:key==='energyKcal'?'kcal':'g',status:supported?'confirmed':'unknown'}];
    }));
    // A reviewed energy edit invalidates a separately extracted kJ column.
    if(Object.hasOwn(corrections,'energyKcal')||Object.hasOwn(corrections,'basis')||Object.hasOwn(corrections,'servingSize'))product.energyKj=null;
    if(!newTable&&previousProduct){product.categoryTag=previousProduct.categoryTag;product.categories=previousProduct.categories||previousProduct.categoriesTags;}
    product.recallAssessment=previousProduct?.recallAssessment;
    product.portionSaltConflict=meta.portionSaltConflict===true;
    const unresolved=new Set((e.metadata?.conflicts||[]).map(c=>c.field));
    if(e.needsClearerPhoto&&newTable)unresolved.add('nutrition');
    product.unresolvedFields=[...unresolved];
    const score=model.score(product);
    // Reopen both successful and incomplete repairs from these reviewed facts,
    // never from the old scan's now-superseded nutrient/classification cache.
    score.sourceData={source:product.sourceName,url:product.sourceURL||null,retrievedAt:product.retrievedAt,version:product.sourceVersion,nutrientSources:product.nutrientSources};
    score.reviewedProductFacts=model.scoreFacts(product);
    const salt=!product.portionSaltConflict&&known(product.nutrients.salt.value)&&known(record.nutritionSnapshot.salt.portion)?record.nutritionSnapshot.salt.portion*record.portions:null;
    meta.nutritionPreparation=preparation;
    // Snapshot labelBasis remains the original printed column; the per100 values
    // used above retain their exact conversion in nutritionSnapshot.
    meta.scoreMethod=deps.frequency?.apply(score,{product,profile:profile,avoidMilk:avoidMilk,entries:entries,day:record.day,slot:record.slot,excludeId:old.id,salt})||core.withPortion(score,salt);
  }
  function repairProductRecord(record,old,e,options={}){
    const result={...record,sourceMeta:JSON.parse(JSON.stringify(record.sourceMeta||{}))};
    refreshRepairedProductScore(result,old,e,options);
    return result;
  }
  return Object.freeze({version,repairProductRecord,normalise,calculateComposition,snapshot,buildRecord,ingredientMode,hasIngredients,canonical,mealPlantKey,supportedPlant,selectedPlants,recoverMeal,validMealScore,mealScore});
  }
  const api=Object.freeze({version,create});
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.NudgeAnalysisResult=api;
})(typeof window!=='undefined'?window:globalThis);
