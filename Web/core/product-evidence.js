/* Product evidence contract. Label conversion, source comparison and identity
 * checks use supplied facts only; source timestamps are explicit input data.
 * Rendering and platform image routing remain in the application adapter. */
(function(root){
  'use strict';
  const imageURL=v=>typeof v==='string'&&/^https:\/\//.test(v)?v:'';
  const publicImageURL=value=>typeof value==='string'&&value.length<=2000&&/^https:\/\/images\.openfoodfacts\.(?:org|net)\/[^?#\\\s]+\.(?:jpe?g|png|webp)$/i.test(value)&&!/\/(?:\.|%2e){1,2}(?:\/|%2f)/i.test(value)?value:'';
  // A retained image is display metadata, not nutrition evidence. It is only
  // reusable for the exact public barcode after native identity checks.
  function publicProductImage(p){
    const primary=[p?.imageURL,p?.imageUrl,p?.imageFrontURL].map(publicImageURL).find(Boolean);
    if(primary)return primary;
    if(p?.sourceName!=='Open Food Facts'||p.communityProvenance||p.sourceKind&&p.sourceKind!=='open_food_facts'||!/^\d{4,18}$/.test(p?.barcode||''))return '';
    const retained=publicImageURL(p.retainedPublicImageURL),parts=retained.match(/^https:\/\/images\.openfoodfacts\.(?:org|net)\/images\/products\/((?:\d+\/)+)[^/]+$/i);
    return parts&&parts[1].replace(/\//g,'')===p.barcode?retained:'';
  }
  function ingredients(p){
    const text=p.ingredients||'',label=text.split(/\b(?:may contain|traces? of|made in (?:a |an )?(?:factory|facility|site)|manufactured in|allergy advice|allergen advice)\b/i)[0];
    const oils=[...new Set(label.match(/\b(?:olive|sunflower|rapeseed|canola|palm|coconut|soy(?:a|bean)?|corn|sesame|peanut|vegetable|avocado)(?:\s+(?:seed|kernel|virgin|extra virgin))?\s+oil\b/gi)||[])];
    const sugars=[...new Set(label.match(/\b(?:sugar|dextrose|fructose|glucose(?:[- ]fructose)?(?: syrup)?|(?:corn|rice|agave|maple) syrup|honey|molasses|invert sugar)\b/gi)||[])];
    const starches=[...new Set(label.match(/\b(?:maltodextrin|(?:modified\s+)?(?:(?:corn|maize|potato|wheat|tapioca|rice)\s+)?starch)\b/gi)||[])];
    const sourceAdditives=Array.isArray(p.additives)?p.additives:Array.isArray(p.additiveTags)?p.additiveTags:[];
    const additives=sourceAdditives.length?sourceAdditives.map(a=>typeof a==='string'?{name:a.replace(/^en:/,''),function:''}:a).filter(a=>a&&typeof a.name==='string'):[];
    for(const match of label.matchAll(/\bE\s?\d{3,4}[a-z]?(?:\([ivx]+\))?\b/gi))if(!additives.some(a=>a.name.toLowerCase().replace(/\s/g,'')===match[0].toLowerCase().replace(/\s/g,'')))additives.push({name:match[0],function:''});
    const functions=[...label.matchAll(/\b(emulsifier|stabiliser|stabilizer|preservative|antioxidant|raising agent|acidity regulator|colour|color|thickener|sweetener)s?\s*[:(]\s*([^;)]{1,100})/gi)].map(m=>({name:m[2].trim(),function:m[1]}));
    return {oils,sugars,starches,additives:additives.concat(functions)};
  }
  function fromExtraction(e){
    const physicalServing=e.basis==='perServing'&&Number.isFinite(e.servingSize?.value)&&e.servingSize.value>0&&e.servingSize.value<=5000&&['g','ml'].includes(e.servingSize.unit);
    const basis=e.basis==='per100ml'?'ml':e.basis==='per100g'?'g':physicalServing?e.servingSize.unit:null,nutrients={},nutrientSources={};
    const scale=physicalServing?100/e.servingSize.value:1,sourceBasis=physicalServing?'per labelled serving, normalised to 100 '+basis:'per 100 '+basis;
    const finite=n=>typeof n?.value==='number'&&Number.isFinite(n.value)&&n.value>=0;
    const exact=n=>!n?.relation||['=','eq'].includes(n.relation);
    // Preserve printed kJ separately. Converting kcal back to kJ is not label evidence.
    const printed=finite(e.energyKj)&&e.energyKj.unit==='kJ'&&exact(e.energyKj)?e.energyKj:finite(e.nutrients?.energyKcal)&&e.nutrients.energyKcal.unit==='kJ'&&exact(e.nutrients.energyKcal)?e.nutrients.energyKcal:null;
    const energyKj=basis&&printed&&Number.isFinite(printed.value*scale)?{value:printed.value*scale,unit:'kJ',status:'supplied'}:null;
    if(energyKj)nutrientSources.energyKj='Photo label extraction: printed kJ '+sourceBasis;
    for(const [key,n] of Object.entries(e.nutrients||{})){
      if(!finite(n)||!basis)continue;let value=n.value;
      if(key==='energyKcal'&&n.unit==='kJ')value/=4.184;else if(n.unit==='mg')value/=1000;else if(n.unit!==(key==='energyKcal'?'kcal':'g'))continue;
      value*=scale;if(!Number.isFinite(value))continue;
      nutrients[key]={value,status:'extracted',...(typeof n.relation==='string'?{relation:n.relation}:{})};
      nutrientSources[key]='Photo label extraction: printed '+n.unit+' '+sourceBasis;
    }
    const metadata=e.metadata||null,net=metadata?.netQuantity;
    const servingFacts=physicalServing?{servingNutrients:Object.fromEntries(Object.entries(nutrients).map(([key,n])=>[key,{...n,value:n.value/scale,status:'supplied',unit:key==='energyKcal'?'kcal':'g'}])),servingNutrientSource:{title:'Printed per-serving photo label',kind:'printed_per_serving',analysisId:e.analysisId||'',version:e.analysisVersion||'',basis:'Original per-serving declaration'},servingPreparation:e.nutritionPreparation}:{};
    return {...servingFacts,analysisId:e.analysisId||'',analysisVersion:e.analysisVersion||'',captureRevision:e.captureRevision??null,photoIds:e.photoIds||[],inputRoute:e.inputRoute||'packaging_photos',metadata,nutritionEvidence:e.nutritionEvidence||null,country:metadata?.country||null,variant:metadata?.variant||null,claims:metadata?.claims||[],ingredientTree:metadata?.ingredientTree||[],packAmount:net?.value??null,packUnit:net?.unit||null,quantity:net?`${net.value} ${net.unit}`:'',allergensText:metadata?.allergenWording?.contains||null,tracesText:metadata?.allergenWording?.mayContain||null,manufacturingAdvice:metadata?.allergenWording?.factoryHandling||null,name:e.productName||'Your product',brand:e.brand||'',basisUnit:basis,ingredients:e.ingredients?.text||'',allergens:e.allergens||null,traces:e.traces||null,nutrients,energyKj,nutrientSources,sourceName:'Photo label extraction',message:e.message||'',categoryTag:e.categoryTag,retailer:e.retailer,ingredientPlants:e.ingredients?.plants||[],ingredientsNeedsReview:e.ingredients?.needsReview===true,servingSuggestion:e.servingSuggestion||null,servingAmount:Number.isFinite(e.servingSize?.value)&&e.servingSize.value>0?e.servingSize.value:null,servingUnit:e.servingSize?.unit||null,servingDescription:e.servingSuggestion?.source==='label'&&e.servingSuggestion.amount===e.servingSize?.value&&e.servingSuggestion.unit===e.servingSize?.unit?e.servingSuggestion.label:'',nutritionPreparation:['as_sold','prepared','unknown'].includes(e.nutritionPreparation)?e.nutritionPreparation:'unknown'};
  }
  const sourceText=v=>typeof v==='string'?v.trim().slice(0,1000):'';
  const identityText=(value,field)=>{
    let text=sourceText(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/^en:/,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();
    if(field==='country'&&['uk','gb','great britain','united kingdom'].includes(text))text='united kingdom';
    if(field==='brand'&&['m and s','m and s food','marks and spencer'].includes(text))text='marks and spencer';
    return text.replace(/\s/g,'');
  };
  const sourceFact=(p,value,unit='',original=null)=>({value,unit,basis:['g','ml'].includes(p.basisUnit)?'per 100 '+p.basisUnit:'unknown',preparation:p.nutritionPreparation||'unknown',source:sourceText(p.sourceName),url:imageURL(p.sourceURL),retrievedAt:sourceText(p.retrievedAt),photoIds:(Array.isArray(p.photoIds)?p.photoIds:[]).filter(x=>typeof x==='string').slice(0,4),...(original?{original}:{} )});
  function sourceComparison(e,label,previous){
    const prior=(Array.isArray(previous.sourceDifferences)?previous.sourceDifferences:[]).slice(-12),differences=[],identity=[];
    for(const field of ['brand','country','variant']){
      const pending=prior.find(d=>d.field===field&&d.status==='unresolved_identity');
      // Country tags are market availability, not proof of a formulation's country.
      const before=pending?.previous?.value??previous[field]??previous.metadata?.[field],after=label[field];
      const match=sourceText(before)&&sourceText(after)&&identityText(before,field)===identityText(after,field);
      if(sourceText(before)&&sourceText(after)&&!match||pending&&!sourceText(after)){
        const difference={field,previous:pending?.previous||sourceFact(previous,sourceText(before)),current:sourceFact(label,sourceText(after)||null),status:'unresolved_identity',reason:'The '+field+' differs between the stored product and this label. Check that the photos belong to the scanned product.'};
        differences.push(difference);identity.push(field);
      }else if(pending&&match)differences.push({field,previous:pending.previous,current:sourceFact(label,sourceText(after)),status:'resolved_by_current_label',reason:'The new label matches the original '+field+'. Only current-photo facts are used after this identity check.'});
    }
    const unclear=e.needsClearerPhoto===true&&['nutrition','both'].includes(e.labelKind)||e.metadata?.conflicts?.some(c=>['identity','nutrition','preparation'].includes(c.field));
    const compatible=!identity.length&&!unclear&&['g','ml'].includes(label.basisUnit)&&label.basisUnit===previous.basisUnit&&['as_sold','prepared'].includes(label.nutritionPreparation)&&label.nutritionPreparation===previous.nutritionPreparation;
    if(compatible)for(const field of ['energyKcal','energyKj','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt']){
      const before=field==='energyKj'?previous.energyKj:previous.nutrients?.[field],after=field==='energyKj'?label.energyKj:label.nutrients?.[field];
      const exact=n=>Number.isFinite(n?.value)&&n.value>=0&&(!n.relation||['=','eq'].includes(n.relation));
      // Comparison tolerance covers small display-rounding differences only; it never changes either stored value.
      const tolerance=field==='energyKcal'||field==='energyKj'?1:field==='salt'?.005:.05;
      if(!exact(before)||!exact(after)||Math.abs(before.value-after.value)<=tolerance+Number.EPSILON*Math.max(1,before.value,after.value)*8)continue;
      const unit=field==='energyKcal'?'kcal':field==='energyKj'?'kJ':'g',raw=field==='energyKj'?e.energyKj:e.nutrients?.[field];
      differences.push({field,previous:sourceFact(previous,before.value,unit),current:sourceFact(label,after.value,unit,raw?{value:raw.value,unit:raw.unit,basis:e.basis,servingSize:e.servingSize||null}:null),status:'resolved_by_current_label',tolerance,reason:'Readable current-pack nutrition replaces the stored value on the same basis; both source values are retained.'});
    }
    const replaced=new Set(differences.map(d=>d.field));
    return {identity,differences:[...prior.filter(d=>!replaced.has(d.field)),...differences].slice(-12),wasUnresolved:prior.some(d=>d.status==='unresolved_identity')};
  }
  function augmentFromLabel(e,previous,extractionSource){
    const label=fromExtraction(e);
    if(extractionSource&&typeof extractionSource==='object'){
      label.extractionSource=Object.fromEntries(['provider','model','retrievedAt'].filter(k=>sourceText(extractionSource[k])).map(k=>[k,sourceText(extractionSource[k])]));
      if(label.extractionSource.retrievedAt)label.retrievedAt=label.extractionSource.retrievedAt;
    }
    if(!previous)return label;
    const comparison=sourceComparison(e,label,previous);
    const explicitIdentity=e.metadata?.conflicts?.some(c=>c.field==='identity');
    if(comparison.identity.length||explicitIdentity||comparison.wasUnresolved){
      const metadata={...(label.metadata||{}),conflicts:[...(label.metadata?.conflicts||[])],recovery:[...(label.metadata?.recovery||[])]};
      if(comparison.identity.length){metadata.conflicts.push({field:'identity',description:'Stored product and label '+comparison.identity.join(', ')+' do not agree. Check the pack before combining these sources.',evidenceIds:[]});metadata.recovery.push({field:'identity',action:'add_photo',photoIndex:null,reason:'Check the front of this pack and its barcode; keep photos from one product together.'});}
      const unclear=e.needsClearerPhoto===true&&['nutrition','both'].includes(e.labelKind)||metadata.conflicts.some(c=>['nutrition','preparation'].includes(c.field));
      // An uncertain identity cannot carry old nutrients, claims, allergens, portions, categories, image or barcode into another product.
      return {...label,metadata,sourceDifferences:comparison.differences,barcode:'',imageURL:'',sourceURL:'',scoreResult:null,scoringFacts:null,nutrients:unclear?{}:label.nutrients,energyKj:unclear?null:label.energyKj};
    }
    label.country=label.country||previous.country||previous.metadata?.country||null;
    label.variant=label.variant||previous.variant||previous.metadata?.variant||null;
    const unresolvedNutrition=e.metadata?.conflicts?.some(c=>['nutrition','preparation'].includes(c.field))||e.needsClearerPhoto===true&&['nutrition','both'].includes(e.labelKind);
    if(unresolvedNutrition&&!label.metadata?.conflicts?.length)label.metadata={...(label.metadata||{}),conflicts:[{field:'nutrition',description:'The new label needs checking. Previous nutrition is retained until the photo is clear.',evidenceIds:[]}],recovery:label.metadata?.recovery||[{field:'nutrition',action:'retake',photoIndex:null,reason:'Retake the unclear nutrition panel.'}]};
    const unclearIngredients=e.ingredients?.needsReview===true&&Boolean(previous.ingredients);
    const hasNew=!unresolvedNutrition&&(Object.keys(label.nutrients).length>0||label.energyKj!==null||['nutrition','both'].includes(e.labelKind)||['per100g','per100ml','perServing'].includes(e.basis));
    const changesIngredients=Boolean(e.ingredients?.text)&&!unclearIngredients,invalidatesScore=hasNew||changesIngredients||unresolvedNutrition||unclearIngredients;
    // A quantity and its household description are one evidence pair. Never reuse an
    // old count/density with a replacement table or label serving.
    const replacesServing=hasNew||label.servingAmount!==null||label.servingSuggestion!==null;
    const suggested=label.servingSuggestion?.source==='label'?label.servingSuggestion:null;
    const matchingDescription=suggested&&suggested.amount===label.servingAmount&&suggested.unit===label.servingUnit?suggested.label:'';
    const serving=replacesServing?{servingNutrients:label.servingNutrients||null,servingNutrientSource:label.servingNutrientSource||null,confirmedPortion:null,servingAmount:label.servingAmount,servingUnit:label.servingUnit,servingDescription:matchingDescription,servingLabel:'',servingPreparation:label.servingPreparation||'unknown',servingSuggestion:label.servingSuggestion}:{servingAmount:previous.servingAmount,servingUnit:previous.servingUnit,servingDescription:previous.servingDescription,servingLabel:previous.servingLabel,servingPreparation:previous.servingPreparation,servingSuggestion:previous.servingSuggestion};
    // A label's preparation basis may differ: never fill its missing nutrients from another table.
    const nutrients=!hasNew?previous.nutrients||{}:label.nutrients;
    return {...previous,...label,sourceDifferences:comparison.differences,name:e.productName||previous.name||label.name,brand:e.brand||previous.brand||'',barcode:previous.barcode||'',imageURL:publicProductImage(previous),quantity:label.quantity||previous.quantity||'',packAmount:label.packAmount||previous.packAmount||null,packUnit:label.packUnit||previous.packUnit||null,nutrients,energyKj:hasNew?label.energyKj:previous.energyKj||null,nutrientSources:hasNew?label.nutrientSources:previous.nutrientSources||{},scoringFacts:invalidatesScore?null:previous.scoringFacts,scoreResult:invalidatesScore?null:previous.scoreResult,ingredientItems:changesIngredients?[]:previous.ingredientItems,basisUnit:hasNew?label.basisUnit:previous.basisUnit||label.basisUnit,ingredients:changesIngredients?e.ingredients.text:previous.ingredients||'',allergensText:label.allergensText||previous.allergensText||null,tracesText:label.tracesText||previous.tracesText||null,manufacturingAdvice:label.manufacturingAdvice||previous.manufacturingAdvice||null,allergens:label.allergens||previous.allergens||null,traces:label.traces||previous.traces||null,ingredientPlants:changesIngredients?e.ingredients.plants:previous.ingredientPlants||[],ingredientsNeedsReview:unclearIngredients?true:e.ingredients?e.ingredients.needsReview===true:previous.ingredientsNeedsReview,...serving,categoryTag:label.categoryTag||previous.categoryTag,retailer:label.retailer||previous.retailer,nutritionPreparation:hasNew?label.nutritionPreparation:previous.nutritionPreparation||'unknown',sourceName:previous.sourceName==='Open Food Facts'||previous.scoreSource?.provider==='Open Food Facts'?'Photo label extraction + stored Open Food Facts':label.sourceName,sourceURL:previous.sourceURL||'',scoreSource:previous.scoreSource||(previous.sourceName==='Open Food Facts'?{provider:previous.sourceName,url:previous.sourceURL||'',retrievedAt:previous.retrievedAt||''}:null),nutriScoreGrade:invalidatesScore?null:previous.nutriScoreGrade,nutriScore2023:invalidatesScore?null:previous.nutriScore2023,novaGroup:previous.novaGroup};
  }
  const api=Object.freeze({fromExtraction,sourceComparison,augmentFromLabel,ingredientDetail:ingredients,imageURL,publicProductImage});
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.NudgeProductEvidence=api;
})(typeof window==='object'?window:globalThis);
