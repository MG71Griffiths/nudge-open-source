import {catalogueRecordFromPayload, validCatalogueBarcode, CATALOGUE_SOURCE} from './food-catalogue.js';
import {ScoreCore} from './nutrition-core.js';
import {stableStringify, validateScoreBody} from './product-score.js';
import {activeQualityHoldSQL} from './catalogue-quality-hold.js';

export const CATALOGUE_SCORE_EVIDENCE_VERSION='public-classification-evidence-v1';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const allowed=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stableStringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
const nutrientNames=['energyKcal','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'];
const flags=['isBeverage','isCheese','isWater','isFatOilNutsSeeds','isRedMeatProduct','hasNonNutritiveSweeteners'];
const unique=value=>[...new Set(value||[])].sort();
const relation=value=>({'<':'lt','<=':'lte','≤':'lte','=':'eq','~':'approx','>':'gt','>=':'gte','≥':'gte'}[value]||value||'eq');
const nutrient=(n,unit)=>n?.value==null?{value:null,unit,status:'unknown',relation:relation(n?.relation)}:{value:n.value,unit,status:n.status,relation:relation(n.relation)};
const categorySources=new Set([
  'Open Food Facts: supplied 2023 category flags and declared ingredient percentage',
  'Open Food Facts: explicitly supplied 2023 category flags and/or declared ingredient percentage'
]);
// Canonicalisation changes representation only: no rounding, truncation,
// ingredient parsing, nutrient completion or manual/estimated status promotion.
function canonicalFacts(p) {
  const f={};
  for(const key of ['name','brand','barcode','categoryTag','sourceName','sourceURL','basisUnit','nutritionPreparation','ingredients'])f[key]=p[key]??null;
  f.categories=unique([...(p.categories||[]),...(p.categoriesTags||[])]);
  for(const key of ['countriesTags','ingredientsAnalysisTags','unresolvedFields'])f[key]=unique(p[key]);
  f.ingredientsNeedsReview=p.ingredientsNeedsReview===true;
  f.ingredientItems=(p.ingredientItems||[]).map(item=>({id:item.id??null,text:item.text??null,percent:item.percent??null}));
  f.nutrients=Object.fromEntries(nutrientNames.map(key=>[key,nutrient(p.nutrients?.[key],key==='energyKcal'?'kcal':'g')]));
  f.energyKj=nutrient(p.energyKj,'kJ');
  f.nutrientSources=p.nutrientSources||{};
  const facts=p.scoringFacts||{};
  f.scoringFacts={source:facts.source??null,fvlPercent:facts.fvlPercent??null,...Object.fromEntries(flags.map(key=>[key,facts[key]??null]))};
  return f;
}
const providerNutrients={energyKcal:['energy-kcal'],protein:['proteins'],carbohydrate:['carbohydrates'],sugars:['sugars'],fat:['fat'],saturatedFat:['saturated-fat'],fibre:['fiber','fibre'],salt:['salt'],energyKj:['energy-kj','energy']};
function normalizeSourceAliases(submitted, trusted, raw) {
  const clean=structuredClone(submitted);
  // Swift retains an explicit provider source (e.g. packaging); the server
  // adapter names its OFF nutrition container. Admit only the exact public
  // source on that same nutrient, never arbitrary client attribution.
  for(const key of [...nutrientNames,'energyKj']) {
    const expected=trusted.nutrientSources?.[key], actual=clean.nutrientSources?.[key];
    if(actual===expected)continue;
    const aliases=new Set([expected]);
    const structured=raw.nutrition?.aggregated_set?.nutrients;
    for(const name of providerNutrients[key])if(typeof structured?.[name]?.source==='string')aliases.add(structured[name].source.trim());
    if(key==='energyKj'&&expected==='Open Food Facts nutrient energy') {
      aliases.add(structured?'Open Food Facts structured nutrition':'Open Food Facts legacy nutriments');
    }
    if(expected&&aliases.has(actual))clean.nutrientSources[key]=expected;
  }
  if(clean.scoringFacts&&trusted.scoringFacts&&categorySources.has(clean.scoringFacts.source)&&categorySources.has(trusted.scoringFacts.source))clean.scoringFacts.source=trusted.scoringFacts.source;
  return clean;
}

// Internal-only boundary. `score` must be the server's /score result, never a
// client submission. Nevertheless only its grounded category quotations are
// admitted; every numeric result is recomputed from the reloaded public row.
export async function admitCatalogueScoreEvidence(row,submittedProduct,score,{now=Date.now()}={}) {
  try {
    if(!Number.isSafeInteger(now)||!row||!validCatalogueBarcode(row.barcode)
      ||typeof row.provider_json!=='string'||row.provider_json.length>96_000
      ||!Number.isSafeInteger(row.fetched_at)||row.fetched_at>now
      ||!Number.isSafeInteger(row.expires_at)||row.expires_at<=now
      ||row.source_url!==`https://world.openfoodfacts.org/product/${row.barcode}`
      ||!object(score)||score.methodId!==ScoreCore.SCORE_METHOD||score.version!==ScoreCore.SCORE_VERSION
      ||!['rated','provisional'].includes(score.status)||score.available!==true
      ||score.classificationEvidence?.version!==ScoreCore.CLASSIFIER_VERSION)return null;
    if(score.recovery&&(score.recovery.estimate||score.recovery.addedFields?.length||score.recovery.conflicts?.length||!['unresolved','verified'].includes(score.recovery.status)))return null;
    const raw=JSON.parse(row.provider_json);
    if(await digest(raw)!==row.source_fingerprint)return null;
    const record=catalogueRecordFromPayload({product:raw},row.barcode,row.fetched_at),trusted=record.product;
    const submitted=validateScoreBody({product:submittedProduct});
    if(submitted.barcode!==row.barcode||submitted.sourceName!==CATALOGUE_SOURCE||submitted.sourceURL!==row.source_url)return null;
    // Generic estimates remain separate from verified label quantities. A
    // category-only cache never promotes them, even if a provider stores one.
    if([...Object.values(trusted.nutrients||{}),trusted.energyKj,...Object.values(submitted.nutrients||{}),submitted.energyKj].some(n=>n?.status==='estimated'))return null;
    const a=canonicalFacts(normalizeSourceAliases(submitted,trusted,raw)),b=canonicalFacts(trusted);
    const factsFingerprint=await digest(b);
    if(await digest(a)!==factsFingerprint)return null;
    const evidence=score.classificationEvidence;
    if(!allowed(evidence,['version','evidence','resolutions','conflicts'])||!Array.isArray(evidence.conflicts)||evidence.conflicts.length)return null;
    const classification=ScoreCore.validateClassification(trusted,{category:score.category,evidence:evidence.evidence,sweeteners:'unknown',sweetenerEvidence:[]});
    if(classification.category!==score.category||classification.conflicts.length)return null;
    const result=ScoreCore.calculateScore(trusted,classification);
    if(!result.available||!['rated','provisional'].includes(result.status)||!Number.isInteger(result.value))return null;
    return Object.freeze({barcode:row.barcode,sourceFingerprint:row.source_fingerprint,fetchedAt:row.fetched_at,factsFingerprint,
      method:ScoreCore.SCORE_METHOD,version:ScoreCore.SCORE_VERSION,classifierVersion:ScoreCore.CLASSIFIER_VERSION,
      evidenceVersion:CATALOGUE_SCORE_EVIDENCE_VERSION,classification,score:result,calculatedAt:now});
  } catch { return null; }
}

export function applyCatalogueScoreEvidenceStatements(record) {
  const r=record,scoreJSON=JSON.stringify(r.score),identity=[r.barcode,r.sourceFingerprint,r.fetchedAt];
  return [
    {sql:`INSERT INTO catalogue_score_evidence(barcode,source_fingerprint,facts_fingerprint,score_method,score_version,classifier_version,evidence_version,classification_json,score_json,rating_value,calculated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM catalogue_products WHERE barcode=? AND source_fingerprint=? AND fetched_at=?)
      ON CONFLICT(barcode) DO UPDATE SET source_fingerprint=excluded.source_fingerprint,facts_fingerprint=excluded.facts_fingerprint,
      score_method=excluded.score_method,score_version=excluded.score_version,classifier_version=excluded.classifier_version,evidence_version=excluded.evidence_version,
      classification_json=excluded.classification_json,score_json=excluded.score_json,rating_value=excluded.rating_value,calculated_at=excluded.calculated_at`,
      values:[r.barcode,r.sourceFingerprint,r.factsFingerprint,r.method,r.version,r.classifierVersion,r.evidenceVersion,JSON.stringify(r.classification),scoreJSON,r.score.value,r.calculatedAt,...identity]},
    {sql:`UPDATE catalogue_products SET score_json=?,rating_value=?,score_method=?,score_version=?,classifier_version=?,calculated_at=?
      WHERE barcode=? AND source_fingerprint=? AND fetched_at=? RETURNING barcode`,values:[scoreJSON,r.score.value,r.method,r.version,r.classifierVersion,r.calculatedAt,...identity]},
    activeQualityHoldSQL({barcode:r.barcode,sourceFingerprint:r.sourceFingerprint,fetchedAt:r.fetchedAt})
  ];
}

export async function rememberCatalogueScoreEvidence(db,body,{now=Date.now()}={}) {
  if(!allowed(body,['product','score'])||!validCatalogueBarcode(body.product?.barcode))return {stored:false};
  const row=await db.prepare('SELECT * FROM catalogue_products WHERE barcode=?').bind(body.product.barcode).first();
  const record=await admitCatalogueScoreEvidence(row,body.product,body.score,{now});
  if(!record)return {stored:false};
  const results=await db.batch(applyCatalogueScoreEvidenceStatements(record).map(({sql,values})=>db.prepare(sql).bind(...values)));
  return {stored:results[1]?.results?.length===1};
}
