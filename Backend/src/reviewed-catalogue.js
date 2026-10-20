import { catalogueRecordFromPayload, validCatalogueBarcode } from './food-catalogue.js';
import { ScoreCore } from './nutrition-core.js';
import { stableStringify, scorePackagedProduct } from './product-score.js';

export const REVIEWED_SOURCE_ORIGIN='https://configure-nudge-backend.invalid';
export const reviewedSourceURL=barcode=>`${REVIEWED_SOURCE_ORIGIN}/v1/products/reviewed/${barcode}`;
const words=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
// Select a complete, independently reviewed record as one source. Never splice
// private predictions into OFF or erase conflicting identity/allergen evidence.
export function compatibleReviewedReplacement(offRow,product,metadata,{now=Date.now()}={}){
 try{
  if(!product||metadata?.sourceKind!=='nudge_community'||metadata.expiresAt<=now||metadata.reviewedAt<offRow.fetched_at)return false;
  const off=JSON.parse(offRow.provider_json),a=catalogueRecordFromPayload({product:off},offRow.barcode,offRow.fetched_at).product,b=catalogueRecordFromPayload({product},offRow.barcode,metadata.reviewedAt).product;
  if(!words(a.name)||words(a.name)!==words(b.name)||!words(a.brand)||words(a.brand)!==words(b.brand))return false;
  if(['on','true','1'].includes(String(off.no_nutrition_data).toLowerCase()))return false;
  if(off.nutrition_data_prepared==='on'&&off.nutrition_data!=='on'&&!off.nutrition?.aggregated_set)return false;
  if(a.basisUnit!==b.basisUnit||a.nutritionPreparation!==b.nutritionPreparation)return false;
  let oldKnown=0,newKnown=0;
  for(const key of new Set([...Object.keys(a.nutrients),...Object.keys(b.nutrients),'energyKj'])){
   const before=key==='energyKj'?a.energyKj:a.nutrients[key],after=key==='energyKj'?b.energyKj:b.nutrients[key];
   const known=n=>typeof n?.value==='number'&&Number.isFinite(n.value);
   if(known(after))newKnown++;
   if(known(before)){oldKnown++;if(!known(after)||before.unit!==after.unit||Math.abs(before.value-after.value)>1e-6||(before.relation||'=')!==(after.relation||'='))return false;}
  }
  if(newKnown<=oldKnown)return false;
  if(a.ingredients&&words(a.ingredients)!==words(b.ingredients))return false;
  for(const field of ['allergens','traces'])if(words(off[field])&&words(off[field])!==words(product[field]))return false;
  for(const field of ['allergens_tags','traces_tags','ingredients_analysis_tags','labels_tags']){
   const existing=Array.isArray(off[field])?off[field]:[];if(existing.some(tag=>!(product[field]||[]).includes(tag)))return false;
  }
  // Scores based on complete source nutrition continue to use that source.
  if(ScoreCore.calculateScore(a).available)return false;
  return true;
 }catch{return false;}
}
function reviewedScore(record){
 const facts={...record.product,sourceName:'Nudge community',sourceURL:reviewedSourceURL(record.barcode),countriesTags:[],ingredientsNeedsReview:false,
  nutrientSources:Object.fromEntries(Object.keys(record.product.nutrientSources).map(key=>[key,'Nudge community: reviewed packaging photograph']))};
 delete facts.providerNutriScore;
 return scorePackagedProduct(facts);
}
export async function reviewedProductRow(candidate,barcode,{observedAt,reviewedAt}={}) {
 if(!validCatalogueBarcode(barcode)||candidate?.readyForReview!==true||candidate.product?.code!==barcode)throw new Error('Reviewable product evidence required');
 // Reuse the strict food-field sanitizer, but assign our own provenance. This
 // wire shape is compatible with the app; the facts are not supplied by OFF.
 const publicFacts={...candidate.product,last_modified_t:Math.floor(reviewedAt/1000)};
 // A photograph/model candidate cannot publish an OFF-authored score or flags.
 for(const key of ['nutriscore','nutriscore_grade','nutrition_grades'])delete publicFacts[key];
 const record=catalogueRecordFromPayload({product:publicFacts},barcode,reviewedAt);
 const product=record.providerPayload.product;delete product.countries_tags;delete product.stores;delete product.stores_tags;
 delete product.nutriscore;delete product.nutriscore_grade;delete product.nutrition_grades;
 const score=reviewedScore(record);
 const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stableStringify(product)))),n=>n.toString(16).padStart(2,'0')).join('');
 return {barcode,providerJSON:JSON.stringify(product),scoreJSON:JSON.stringify(score),fingerprint,sourceRevision:Math.floor(reviewedAt/1000),observedAt,reviewedAt,
  expiresAt:reviewedAt+30*86400000,method:ScoreCore.SCORE_METHOD,version:ScoreCore.SCORE_VERSION,classifierVersion:ScoreCore.CLASSIFIER_VERSION,
  provenanceJSON:JSON.stringify({sourceKind:'nudge_community',sourceName:'Nudge community',sourceURL:reviewedSourceURL(barcode),verification:'reviewed_packaging_photos',observedAt,reviewedAt,photosPublic:false,
    engineVersion:typeof candidate.engineVersion==='string'?candidate.engineVersion.slice(0,100):null,categoryReview:'administrator_confirmed',
    evidence:(candidate.prediction?.evidence||[]).slice(0,24).filter(e=>/^[a-f0-9]{64}$/.test(e.photoSHA256||'')).map(e=>({id:String(e.id||'').slice(0,32),field:String(e.field||'').slice(0,40),photoSHA256:e.photoSHA256})),
    fieldEvidence:candidate.prediction?.fieldEvidence||{},allergenWording:candidate.prediction?.allergens||{contains:null,mayContain:null,factoryHandling:null}})};
}
export function reviewedWriteStatement(db,row) {
 return db.prepare(`INSERT INTO reviewed_products(barcode,provider_json,score_json,source_fingerprint,source_revision,observed_at,reviewed_at,expires_at,score_method,score_version,classifier_version,provenance_json,calculated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(barcode) DO UPDATE SET provider_json=excluded.provider_json,score_json=excluded.score_json,source_fingerprint=excluded.source_fingerprint,source_revision=excluded.source_revision,observed_at=excluded.observed_at,reviewed_at=excluded.reviewed_at,expires_at=excluded.expires_at,score_method=excluded.score_method,score_version=excluded.score_version,classifier_version=excluded.classifier_version,provenance_json=excluded.provenance_json,calculated_at=excluded.calculated_at WHERE excluded.reviewed_at>=reviewed_products.reviewed_at`)
  .bind(row.barcode,row.providerJSON,row.scoreJSON,row.fingerprint,row.sourceRevision,row.observedAt,row.reviewedAt,row.expiresAt,row.method,row.version,row.classifierVersion,row.provenanceJSON,row.reviewedAt);
}
export async function reviewedCatalogueBatch(db,codes,{now=Date.now()}={}) {
 if(!codes.length)return {products:[],ratings:[]};
 const result=await db.prepare('SELECT * FROM reviewed_products WHERE barcode IN (SELECT value FROM json_each(?))').bind(JSON.stringify(codes)).all();
 return {products:(result.results||[]).map(row=>JSON.parse(row.provider_json)),ratings:(result.results||[]).map(row=>({barcode:row.barcode,method:row.score_method,version:row.score_version,classifierVersion:row.classifier_version,
  sourceRevision:row.source_revision,sourceFingerprint:row.source_fingerprint,fetchedAt:row.reviewed_at,expiresAt:row.expires_at,calculatedAt:row.calculated_at,
  freshness:row.expires_at<=now?'stale':'current',discoveryScope:'barcode_only',sourceKind:'nudge_community',sourceName:'Nudge community',sourceURL:reviewedSourceURL(row.barcode),
  observedAt:row.observed_at,reviewedAt:row.reviewed_at,provenance:JSON.parse(row.provenance_json),score:JSON.parse(row.score_json)}))};
}
export async function refreshReviewedProducts(db,{now=Date.now()}={}){
 const rows=(await db.prepare('SELECT * FROM reviewed_products WHERE score_method!=? OR score_version!=? OR classifier_version!=? LIMIT 100').bind(ScoreCore.SCORE_METHOD,ScoreCore.SCORE_VERSION,ScoreCore.CLASSIFIER_VERSION).all()).results||[];
 const statements=rows.map(row=>{
  const score=reviewedScore(catalogueRecordFromPayload({product:JSON.parse(row.provider_json)},row.barcode,row.reviewed_at));
  return db.prepare('UPDATE reviewed_products SET score_json=?,score_method=?,score_version=?,classifier_version=?,calculated_at=? WHERE barcode=? AND source_fingerprint=? AND reviewed_at=? RETURNING barcode').bind(JSON.stringify(score),ScoreCore.SCORE_METHOD,ScoreCore.SCORE_VERSION,ScoreCore.CLASSIFIER_VERSION,now,row.barcode,row.source_fingerprint,row.reviewed_at);
 });
 return statements.length?(await db.batch(statements)).reduce((n,r)=>n+(r.results?.length||0),0):0;
}
