// Small, replaceable on-device analysis cache. Intake and History remain authoritative.
// Only public product facts and structured scoring evidence belong here; no media,
// account identifiers, selected portions, symptoms or diary records are retained.
window.NudgeFoodCatalogue = (() => {
  'use strict';
  const KEY='nudge-food-catalogue-v1', VERSION=1, DAY=86400000;
  const MAX_ITEMS=128, MAX_BYTES=524288, MAX_ITEM=49152, SUCCESS_TTL=30*DAY, INCOMPLETE_TTL=6*3600000;
  const model=()=>window.NudgeFoodDetailModel;
  const clone=v=>JSON.parse(JSON.stringify(v));
  const cleanText=(v,max=2000)=>typeof v==='string'&&!/^data:|^[A-Za-z0-9+/]{10000}/.test(v)?v.slice(0,max):'';
  // Recursively allow known score/provenance fields rather than accepting arbitrary response data.
  const scoreKeys=new Set(('estimatedInputs inferredInputs inputFingerprint calculatedAt providerReference method fvlPoints fibrePoints proteinPoints sweetenerPoints nutrientBounds bound quantityIsExact assumption catalogueEnrichment catalogueQualityHold sourceFingerprint sourceFetchedAt runID reviewID reviewedAt reasonCode candidateSHA256 expiresAt providerGrade barcode factsFingerprint status classifierVersion classificationEvidence resolutions quote partialNutrition nutritionCategory methodId methodVersion version model_version sourceVersion promptVersion baseAlgorithmVersion methodStatus available estimated value grade rawScore rawLower rawUpper displayLower displayUpper category band id label interpretation baseFrequency finalFrequency frequencyStatus personalSuitability reason reasonCodes explanation rationale completeness confidence scoreBasis detailedReason missingInputs missingFields assumptions limits components negative positive adjustments negativePoints positivePoints positivePointsUpper countProteins inputs sources sourceData quality calculationBasis factors evidence sourceRecord sourceRecords source sourceURL sourceSHA256 compositionVersion licenceURL verification fields basis valueStatus foodGroup nutrients sourceReference description code mealScoringProfile specialOilFvlEligible carbohydrateDefinition url title retrievedAt checkedAt recordId dataset licence license provider nutrientSources name basisUnit nutritionPreparation per unit preparation kind lower upper relation points pointsLower pointsUpper pointsMax counted missing pointsMax amountGrams grams yield value status observation identifiedFood identifiedParts plantShare wholePlants wholeGrains legumesNuts proteinType refinedStarch sugaryFood frying energyKcal energyKj energySource protein fibre fat saturatedFat carbohydrate sugars salt fvlPercent fvlBounds fvlSource fvlEligible hasNonNutritiveSweeteners positiveBounds portionGrams extraction match portion evidenceStrength certainty matchType sourceId field action reason description key addedFields conflicts provenance').split(' '));
  function metadata(value,depth=0){
    if(depth>9)return null;
    if(value===null||typeof value==='boolean')return value;
    if(typeof value==='number')return Number.isFinite(value)?value:null;
    if(typeof value==='string')return cleanText(value);
    if(Array.isArray(value))return value.slice(0,60).map(v=>metadata(v,depth+1));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>scoreKeys.has(key)).slice(0,100).map(([key,v])=>[key,metadata(v,depth+1)]));
    return null;
  }
  function cleanRecovery(raw){
    if(!raw||raw.version!=='food-recovery-v1'||!['verified','estimated','unresolved','conflict'].includes(raw.status))return null;
    const recovery={version:raw.version,status:raw.status,addedFields:Array.isArray(raw.addedFields)?raw.addedFields.slice(0,24).map(v=>cleanText(v,120)):[],conflicts:metadata(raw.conflicts||[]),provenance:metadata(raw.provenance||[])};
    if(raw.product&&typeof raw.product==='object')recovery.product=model()?.scoreFacts(raw.product);
    const estimate=raw.estimate;
    if(estimate?.score&&window.NudgeMealScore?.validResult(estimate.score)&&estimate.score.estimated===true){
      const score=metadata(estimate.score);
      if(window.NudgeMealScore.validResult(score))recovery.estimate={score,sourceRecord:metadata(estimate.sourceRecord)};
    }
    return JSON.stringify(recovery).length<=MAX_ITEM?recovery:null;
  }
  function cleanCache(cache,product){
    const m=model();if(!m||!cache||cache.result?.catalogueCheckRequired||cache.inputFingerprint!==m.scoreFingerprint(product)||!m.validScoreResult(cache.result))return null;
    const result=metadata(cache.result),held=cache.catalogueValidated===true&&m.isCatalogueQualityHold(result,product);if(result?.catalogueQualityHold&&!held||!m.validScoreResult(result)||m.catalogueEvidenceExpiry(result)<=Date.now())return null;
    const checked=Date.parse(cache.checkedAt||'');
    const value={inputFingerprint:cache.inputFingerprint,methodId:result.methodId,version:result.version,result,checkedAt:Number.isFinite(checked)?new Date(checked).toISOString():''};
    if(Number.isSafeInteger(cache.catalogueCalculatedAt)&&cache.catalogueCalculatedAt>0&&cache.catalogueCalculatedAt<=Date.now()+60000)value.catalogueCalculatedAt=cache.catalogueCalculatedAt;
    if(held){value.catalogueValidated=true;value.catalogueExpiresAt=cache.catalogueExpiresAt;}
    const recovery=held?null:cleanRecovery(cache.recovery);if(recovery)value.recovery=recovery;
    return value;
  }
  let records=[];
  try{const raw=JSON.parse((window.NudgeStorage||localStorage).getItem(KEY)||'null');if(raw?.version===VERSION&&Array.isArray(raw.records))records=raw.records.slice(-MAX_ITEMS).filter(r=>r&&typeof r.fingerprint==='string'&&Number.isFinite(r.expiresAt)&&r.expiresAt>Date.now()&&r.expiresAt<=Date.now()+SUCCESS_TTL+DAY);}catch{}
  function persist(){
    records=records.filter(r=>r.expiresAt>Date.now()).slice(-MAX_ITEMS);
    while(records.length&&JSON.stringify({version:VERSION,records}).length*2>MAX_BYTES)records.shift();
    try{(window.NudgeStorage||localStorage).setItem(KEY,JSON.stringify({version:VERSION,records}));return true;}catch{return false;}
  }
  const keyFor=product=>model()?.scoreFingerprint(product);
  function get(product){
    const fingerprint=keyFor(product),record=records.find(r=>r.fingerprint===fingerprint&&r.expiresAt>Date.now());
    return record?.cache?cleanCache(record.cache,product):null;
  }
  function put(product,cache){
    const facts=model()?.scoreFacts(product),safe=cleanCache(cache,product);if(!facts||!safe)return false;
    const now=Date.now(),ttl=['unrated','provisional','estimated_provisional'].includes(safe.result.status)?INCOMPLETE_TTL:SUCCESS_TTL;
    const expiresAt=Math.min(now+ttl,model().catalogueEvidenceExpiry(safe.result));
    const record={fingerprint:keyFor(product),facts,cache:safe,savedAt:now,expiresAt,retryAfter:['unrated','provisional','estimated_provisional'].includes(safe.result.status)?Math.min(now+INCOMPLETE_TTL,expiresAt):0};
    if(JSON.stringify(record).length*2>MAX_ITEM)return false;
    records=records.filter(r=>r.fingerprint!==record.fingerprint);records.push(record);return persist();
  }
  function canRecover(product){const r=records.find(r=>r.fingerprint===keyFor(product));return !r||!(r.retryAfter>Date.now());}
  function attempted(product,{failed=false}={}){
    const fingerprint=keyFor(product),now=Date.now(),cooldown=failed?3600000:INCOMPLETE_TTL;
    const old=records.find(r=>r.fingerprint===fingerprint);
    records=records.filter(r=>r.fingerprint!==fingerprint);records.push({...old,fingerprint,retryAfter:now+cooldown,expiresAt:Math.max(old?.expiresAt||0,now+cooldown)});persist();
  }
  function freshIncomplete(cache){const at=Date.parse(cache?.checkedAt||'');return ['unrated','provisional','estimated_provisional'].includes(cache?.result?.status)&&Number.isFinite(at)&&at<=Date.now()+60000&&Date.now()-at<INCOMPLETE_TTL;}
  // A server lookup can supplement missing facts only. It cannot replace a
  // printed/confirmed value, change the food or mix prepared and as-sold tables.
  function mergeRecovery(product,raw){
    const recovery=cleanRecovery(raw),m=model();if(!recovery||recovery.status!=='verified'||!recovery.product||recovery.conflicts?.length)return null;
    const before=m.scoreFacts(product),after=recovery.product;
    if(!before.barcode||before.barcode!==after.barcode)return null;
    for(const key of ['name','brand','basisUnit','nutritionPreparation','ingredients']){
      const existing=before[key];if(existing&&existing!=='unknown'&&after[key]&&after[key]!=='unknown'&&String(existing).trim().toLowerCase()!==String(after[key]).trim().toLowerCase())return null;
    }
    const known=n=>Number.isFinite(n?.value)&&n.status!=='unknown';
    for(const key of [...m.keys,'energyKj']){
      const a=key==='energyKj'?before.energyKj:before.nutrients[key],b=key==='energyKj'?after.energyKj:after.nutrients[key];
      if(known(a)&&known(b)&&(a.value!==b.value||a.unit!==b.unit||(a.relation||'eq')!==(b.relation||'eq')))return null;
    }
    const merged={...product,nutrients:{...product.nutrients},nutrientSources:{...product.nutrientSources}};
    for(const key of ['basisUnit','nutritionPreparation','ingredients'])if((!before[key]||before[key]==='unknown')&&after[key])merged[key]=after[key];
    for(const key of [...m.keys,'energyKj']){
      const a=key==='energyKj'?before.energyKj:before.nutrients[key],b=key==='energyKj'?after.energyKj:after.nutrients[key];
      if(!known(a)&&known(b)&&['supplied','confirmed'].includes(b.status)&&after.nutrientSources?.[key]){
        if(key==='energyKj')merged.energyKj=clone(b);else merged.nutrients[key]=clone(b);
        merged.nutrientSources[key]=after.nutrientSources[key];
      }
    }
    merged.categories=[...new Set([...(before.categories||[]),...(after.categories||[])])].slice(0,60);
    if(!before.categoryTag&&after.categoryTag)merged.categoryTag=after.categoryTag;
    if(!before.ingredientItems?.length&&after.ingredientItems?.length)merged.ingredientItems=clone(after.ingredientItems);
    merged.scoringFacts={...product.scoringFacts};
    for(const key of ['isBeverage','isCheese','isWater','isFatOilNutsSeeds','isRedMeatProduct','hasNonNutritiveSweeteners'])if(typeof before.scoringFacts?.[key]!=='boolean'&&typeof after.scoringFacts?.[key]==='boolean')merged.scoringFacts[key]=after.scoringFacts[key];
    if(!before.scoringFacts?.fvlPercent&&after.scoringFacts?.fvlPercent)merged.scoringFacts.fvlPercent=clone(after.scoringFacts.fvlPercent);
    if(!before.scoringFacts?.source&&after.scoringFacts?.source)merged.scoringFacts.source=after.scoringFacts.source;
    if(!before.ingredients&&after.ingredients)merged.ingredientsNeedsReview=after.ingredientsNeedsReview;
    merged.scoreRecovery=recovery;
    return merged;
  }
  return Object.freeze({key:KEY,version:VERSION,get,put,canRecover,attempted,freshIncomplete,cleanRecovery,mergeRecovery,metadata,limits:Object.freeze({items:MAX_ITEMS,bytes:MAX_BYTES,successDays:30,incompleteHours:6})});
})();
