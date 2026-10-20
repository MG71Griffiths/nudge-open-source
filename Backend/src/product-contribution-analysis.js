// Packaging observations are private, unreviewed predictions until an independent
// administrator confirms this exact barcode, its photographs and proposed facts.
import { ScoreCore } from './nutrition-core.js';
import { validCatalogueBarcode } from './food-catalogue.js';

export const CONTRIBUTION_ANALYSIS_VERSION='nudge-contribution-evidence-v1';
export const CONTRIBUTION_PHOTO_MAX_BYTES=750_000;
const roles=['front','nutrition','ingredients'];
const nutrientNames={energyKcal:'energy-kcal',protein:'proteins',carbohydrate:'carbohydrates',sugars:'sugars',fat:'fat',saturatedFat:'saturated-fat',fibre:'fiber',salt:'salt'};
const requiredNutrition=['protein','carbohydrate','sugars','fat','saturatedFat','salt'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=160)=>typeof v==='string'&&v.trim()&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/.test(v)?v.trim():null;
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const exact=n=>object(n)&&finite(n.value)&&(!n.relation||['=','eq'].includes(n.relation))&&(!n.status||['supplied','confirmed','extracted'].includes(n.status));
const norm=v=>String(v||'').toLowerCase().normalize('NFKC').replace(/\s+/g,' ').trim();
const unique=v=>[...new Set(v)];
const words=v=>norm(v).replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).filter(Boolean);
export class ContributionAnalysisError extends Error {
  constructor(message='These photos could not be read as one packaged product.',status=422,code='contribution_analysis_invalid'){super(message);this.status=status;this.code=code;}
}
const fail=code=>new ContributionAnalysisError(undefined,422,code);
const byteLength=s=>new TextEncoder().encode(s).byteLength;
const amountIn=(quote,n)=>{
  if(!exact(n)||!['kcal','kJ','g','mg','ml'].includes(n.unit))return false;
  return [...quote.matchAll(/(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*(kcal|kj|mg|ml|g)\b/gi)]
    .some(m=>Number(m[1].replace(',','.'))===n.value&&m[2].toLowerCase()===n.unit.toLowerCase());
};

export function contributionCandidate(extraction,barcode,{photoEvidence=[],engineVersion=null}={}) {
  if(!validCatalogueBarcode(barcode))throw fail('contribution_barcode_invalid');
  if(!object(extraction)||byteLength(JSON.stringify(extraction))>60_000)throw fail('contribution_analysis_invalid');
  if(extraction.type!=='product'||extraction.meal!=null||extraction.photoConsistency&&extraction.photoConsistency!=='sameProduct')throw fail('contribution_not_product');
  if(extraction.barcode!=null&&extraction.barcode!==barcode)throw fail('contribution_identity_conflict');
  const metadata=object(extraction.metadata)?extraction.metadata:{},conflicts=Array.isArray(metadata.conflicts)?metadata.conflicts:[];
  if(conflicts.some(c=>c?.field==='identity'))throw fail('contribution_identity_conflict');
  if(photoEvidence.length>3||photoEvidence.some(p=>!object(p)||!roles.includes(p.role)||!Number.isInteger(p.photoIndex)||p.photoIndex<1||p.photoIndex>3||!/^\w[\w-]{0,99}$/.test(p.photoId||'')||!/^[a-f0-9]{64}$/.test(p.sha256||''))
    ||new Set(photoEvidence.map(p=>p.photoIndex)).size!==photoEvidence.length||new Set(photoEvidence.map(p=>p.photoId)).size!==photoEvidence.length||new Set(photoEvidence.map(p=>p.role)).size!==photoEvidence.length)throw fail('contribution_photo_evidence_invalid');
  const photos=photoEvidence.map(p=>({role:p.role,photoIndex:p.photoIndex,photoId:p.photoId,sha256:p.sha256}));
  const evidence=[],evidenceIds=new Set();
  for(const e of (Array.isArray(metadata.evidence)?metadata.evidence:[]).slice(0,24)){
    const photo=photos.find(p=>p.photoIndex===e?.photoIndex);
    if(!photo||!text(e.id,32)||evidenceIds.has(e.id)||!text(e.text,1000)||!text(e.region,80)||!['identity','nutrition','ingredients','allergens','claims','netQuantity','preparation','batch-date'].includes(e.field))continue;
    evidenceIds.add(e.id);evidence.push({id:e.id,field:e.field,quote:e.text,region:e.region,photoId:photo.photoId,photoRole:photo.role,photoSHA256:photo.sha256});
  }
  const proof=(field,test=()=>true)=>evidence.filter(e=>e.field===field&&test(e));
  const identityProof=proof('identity',e=>e.photoRole==='front');
  const printedCodes=unique(identityProof.flatMap(e=>[...e.quote.matchAll(/(?:\b(?:barcode|ean|gtin|upc)\s*[:#]?\s*)([0-9][0-9 -]{3,24}[0-9])|\b(\d{13,14})\b/gi)].map(m=>(m[1]||m[2]).replace(/[ -]/g,'')).filter(validCatalogueBarcode)));
  if(printedCodes.some(code=>code!==barcode))throw fail('contribution_identity_conflict');
  const name=text(extraction.productName),brand=text(extraction.brand,80),identityEvidence=identityProof.filter(e=>name&&norm(e.quote).includes(norm(name)));
  const hasIdentity=Boolean(name&&identityEvidence.length);
  const reasons=[],missingPhotoRoles=[];
  if(!hasIdentity){reasons.push('identity_evidence_missing');missingPhotoRoles.push('front');}
  const nutritionProof=proof('nutrition',e=>['nutrition','ingredients'].includes(e.photoRole));
  const basis=extraction.basis,serving=extraction.servingSize;
  const physicalServing=basis==='perServing'&&exact(serving)&&serving.value>0&&serving.value<=5000&&['g','ml'].includes(serving.unit)
    &&nutritionProof.some(e=>/\b(?:serving|portion)\b/i.test(e.quote)&&amountIn(e.quote,serving));
  const unit=basis==='per100g'?'g':basis==='per100ml'?'ml':physicalServing?serving.unit:null;
  const basisProof=nutritionProof.filter(e=>basis==='per100g'?/\b100\s*g\b/i.test(e.quote):basis==='per100ml'?/\b100\s*ml\b/i.test(e.quote):physicalServing&&/\b(?:serving|portion)\b/i.test(e.quote)&&amountIn(e.quote,serving));
  const preparation=['as_sold','prepared'].includes(extraction.nutritionPreparation)?extraction.nutritionPreparation:null;
  const nutritionConflict=conflicts.some(c=>['nutrition','preparation'].includes(c?.field));
  const nutritionUsable=Boolean(unit&&preparation&&basisProof.length&&!nutritionConflict&&['nutrition','both'].includes(extraction.labelKind));
  const scale=physicalServing?100/serving.value:1,observed={},normalised={},fieldEvidence={};
  for(const key of [...Object.keys(nutrientNames),'energyKj']){
    const n=key==='energyKj'?extraction.energyKj:extraction.nutrients?.[key],allowed=key==='energyKj'?['kJ']:key==='energyKcal'?['kcal','kJ']:['g','mg'];
    const matches=exact(n)&&allowed.includes(n.unit)?nutritionProof.filter(e=>amountIn(e.quote,n)):[];
    observed[key]=matches.length?{value:n.value,unit:n.unit,basis,preparation:extraction.nutritionPreparation||'unknown',evidenceIds:matches.map(e=>e.id)}:null;
    let value=nutritionUsable&&matches.length?n.value*scale:null,outputUnit=key==='energyKj'?'kJ':key==='energyKcal'&&n?.unit==='kJ'?'kJ':key==='energyKcal'?'kcal':'g';
    if(value!==null&&n.unit==='mg')value/=1000;
    if(value!==null&&(!Number.isFinite(value)||value>(outputUnit==='g'?100:outputUnit==='kcal'?5000:25000))){value=null;reasons.push('nutrition_value_out_of_range');}
    normalised[key]=value===null?null:{value,unit:outputUnit};
    if(matches.length)fieldEvidence['nutrition.'+key]=matches.map(e=>e.id);
  }
  for(const [part,total] of [['sugars','carbohydrate'],['saturatedFat','fat']])if(normalised[part]&&normalised[total]&&normalised[part].value-normalised[total].value>.100000001)reasons.push('nutrition_values_conflict');
  const invalidNutrition=nutritionConflict||reasons.includes('nutrition_values_conflict');
  if(invalidNutrition)for(const key of Object.keys(normalised))normalised[key]=null;
  if(invalidNutrition)reasons.push('nutrition_evidence_conflict');
  const completeNutrition=Boolean(nutritionUsable&&!invalidNutrition&&(normalised.energyKcal||normalised.energyKj)&&requiredNutrition.every(k=>normalised[k]));
  if(!completeNutrition){reasons.push('nutrition_evidence_incomplete');missingPhotoRoles.push('nutrition');}
  const ingredientText=text(extraction.ingredients?.text,4000),ingredientsProof=proof('ingredients',e=>['nutrition','ingredients'].includes(e.photoRole));
  const ingredientWords=new Set(ingredientsProof.flatMap(e=>words(e.quote)));
  const hasIngredients=Boolean(ingredientText&&['ingredients','both'].includes(extraction.labelKind)&&extraction.ingredients?.needsReview===false&&!conflicts.some(c=>c?.field==='ingredients')&&ingredientsProof.length&&words(ingredientText).every(w=>ingredientWords.has(w)));
  if(!hasIngredients){reasons.push('ingredients_evidence_incomplete');missingPhotoRoles.push('ingredients');}
  const allergens={contains:null,mayContain:null,factoryHandling:null};
  for(const key of Object.keys(allergens)){
    const wording=text(metadata.allergenWording?.[key],500),matches=proof('allergens',e=>['nutrition','ingredients'].includes(e.photoRole)&&wording&&norm(e.quote).includes(norm(wording)));
    if(matches.length&&!conflicts.some(c=>c?.field==='allergens')){allergens[key]=wording;fieldEvidence['allergens.'+key]=matches.map(e=>e.id);}
  }
  if(identityEvidence.length)fieldEvidence['identity.name']=identityEvidence.map(e=>e.id);
  const brandProof=identityProof.filter(e=>brand&&norm(e.quote).includes(norm(brand)));if(brandProof.length)fieldEvidence['identity.brand']=brandProof.map(e=>e.id);
  if(hasIngredients)fieldEvidence.ingredients=ingredientsProof.map(e=>e.id);
  const category=text(extraction.categoryTag,80),categoryTag=category&&/^en:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(category)?category:null;
  const aggregated={};
  for(const [key,n] of Object.entries(normalised))if(n){const name=key==='energyKj'||key==='energyKcal'&&n.unit==='kJ'?'energy-kj':nutrientNames[key];if(name)aggregated[name]={value:n.value,unit:n.unit,source:'packaging'};}
  const product=hasIdentity?{code:barcode,product_name:name,...(brandProof.length?{brands:brand}:{}),...(categoryTag?{categories_tags:[categoryTag]}:{}),
    ...(hasIngredients?{ingredients_text:ingredientText}:{}),...(allergens.contains?{allergens:allergens.contains}:{}),...(allergens.mayContain?{traces:allergens.mayContain}:{}),
    ...(nutritionUsable&&!invalidNutrition?{nutrition:{aggregated_set:{per:unit==='ml'?'100ml':'100g',preparation,nutrients:aggregated}}}:{}),
    ...(physicalServing?{serving_size:`${serving.value} ${serving.unit}`,serving_quantity:serving.value,serving_quantity_unit:serving.unit}:{})}:null;
  // The calculator sees label observations solely for a review preview. No
  // generic composition, model numeric rating or missing-as-zero fallback runs.
  const scoreFacts={name:name||'',brand:brandProof.length?brand:'',barcode,categoryTag,categories:categoryTag?[categoryTag]:[],basisUnit:unit,nutritionPreparation:preparation||'unknown',sourceName:'Nudge community label prediction',ingredients:hasIngredients?ingredientText:'',ingredientsNeedsReview:!hasIngredients,
    nutrients:Object.fromEntries(Object.keys(nutrientNames).map(key=>{const n=normalised[key];return[key,n&&n.unit!=='kJ'?{...n,status:'supplied'}:{value:null,unit:key==='energyKcal'?'kcal':'g',status:'unknown'}];})),
    energyKj:normalised.energyKj||normalised.energyKcal?.unit==='kJ'?{...(normalised.energyKj||normalised.energyKcal),status:'supplied'}:null};
  const result=product?ScoreCore.calculateScore(scoreFacts):null;
  const retainedConflicts=conflicts.slice(0,8).filter(c=>['identity','nutrition','preparation','ingredients','allergens','claims','other'].includes(c?.field)).map(c=>({field:c.field,description:text(c.description,240)||null,evidenceIds:Array.isArray(c.evidenceIds)?c.evidenceIds.filter(id=>evidenceIds.has(id)).slice(0,4):[]}));
  if(retainedConflicts.some(c=>c.field==='allergens'))reasons.push('allergen_evidence_conflict');
  const candidate={version:CONTRIBUTION_ANALYSIS_VERSION,source:'Nudge community',verification:'unreviewed_photo_prediction',readyForReview:hasIdentity&&completeNutrition&&hasIngredients&&!retainedConflicts.some(c=>c.field==='allergens'),
    missingPhotoRoles:unique(missingPhotoRoles),reasons:unique(reasons),product,
    prediction:{barcode:{value:barcode,source:'user_scan',observedPhotoValue:printedCodes[0]||null,requiresReview:true},identity:{name:hasIdentity?name:null,brand:brandProof.length?brand:null},
      nutrition:{basis,preparation:extraction.nutritionPreparation||'unknown',servingSize:physicalServing?{value:serving.value,unit:serving.unit}:null,observed,per100:normalised},
      ingredients:hasIngredients?ingredientText:null,allergens,category:{value:categoryTag,source:'model_classification',requiresReview:true},evidence,fieldEvidence,conflicts:retainedConflicts},
    scorePreview:result?{verification:'unreviewed_photo_prediction',result}:null,photos,
    engineVersion:text(engineVersion,100)||text(extraction.analysisVersion,100)||CONTRIBUTION_ANALYSIS_VERSION};
  if(byteLength(JSON.stringify(candidate))>60_000)throw fail('contribution_candidate_too_large');
  return candidate;
}

export async function contributionAnalysis(body,{analyse,validateUpload,env={},signal,owner}={}) {
  if(!object(body)||Object.keys(body).some(k=>!['barcode','photos'].includes(k))||!validCatalogueBarcode(body.barcode)||!Array.isArray(body.photos)||body.photos.length<1||body.photos.length>3
    ||body.photos.some(p=>!object(p)||Object.keys(p).some(k=>!['role','mimeType','imageBase64'].includes(k))||!roles.includes(p.role)||p.mimeType!=='image/jpeg'||typeof p.imageBase64!=='string'||p.imageBase64.length>1_000_000)
    ||new Set(body.photos.map(p=>p.role)).size!==body.photos.length)throw new ContributionAnalysisError('Add up to three JPEG photos of this product: front, nutrition and ingredients.',400,'contribution_upload_invalid');
  if(typeof analyse!=='function'||typeof validateUpload!=='function')throw new ContributionAnalysisError('Product contribution analysis is unavailable.',503,'contribution_analysis_unavailable');
  signal?.throwIfAborted();
  const upload={images:body.photos.map(p=>({mimeType:p.mimeType,imageBase64:p.imageBase64})),photoIds:body.photos.map(()=>crypto.randomUUID())};
  const validated=validateUpload(upload);
  if(!Array.isArray(validated.images)||validated.images.some(p=>!Number.isInteger(p.bytes)||p.bytes<1||p.bytes>CONTRIBUTION_PHOTO_MAX_BYTES))throw new ContributionAnalysisError('Each product photo must be no larger than 750 KB.',413,'contribution_photo_too_large');
  const photoEvidence=[];
  for(const [index,photo] of body.photos.entries()){
    const bytes=Uint8Array.from(atob(photo.imageBase64),c=>c.charCodeAt(0));
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    photoEvidence.push({photoIndex:index+1,photoId:upload.photoIds[index],role:photo.role,sha256:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')});
  }
  let response;
  try{response=await analyse(upload,env,signal,{productOnly:true,...(typeof owner==='string'?{owner}:{})});}
  catch(error){if(signal?.aborted)throw error;throw new ContributionAnalysisError('The label analysis could not finish. Try again with clear product photos.',error?.status===504?504:502,'contribution_analysis_failed');}
  signal?.throwIfAborted();
  const candidate=contributionCandidate(response?.extraction||response,body.barcode,{photoEvidence,engineVersion:response?.extraction?.analysisVersion});
  return candidate;
}
