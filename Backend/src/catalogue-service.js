import { catalogueFetch, readCatalogue, writeCatalogue, validCatalogueBarcode, catalogueRecordFromPayload, CatalogueNotFoundError } from './food-catalogue.js';
import { publicCatalogueQualityHoldMatches } from './catalogue-quality-hold.js';

// Each barcode has its own durable object. No user identifier, photo or diary is
// retained. A failed public-source fetch is cooled down, not cached as a food.
export async function lookupCatalogue(storage, barcode, {signal, now=Date.now(), fetchImpl=fetch}={}) {
  return (await lookupCatalogueOutcome(storage,barcode,{signal,now,fetchImpl})).record||null;
}
export async function lookupCatalogueOutcome(storage, barcode, {signal, now=Date.now(), fetchImpl=fetch,archive}={}) {
  if (!validCatalogueBarcode(barcode)) throw new Error('Invalid barcode');
  const saved=await readCatalogue(storage,barcode,{now});
  if(saved)return {status:'found',record:saved};
  const failed=await storage.get('public-source-failure');
  if(failed?.barcode===barcode&&failed.until>now)return {status:failed.status==='not_found'?'not_found':'unavailable',retryAfter:Math.ceil((failed.until-now)/1000)};
  const controller=new AbortController(),cancel=()=>controller.abort();
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  const timer=setTimeout(cancel,4000);
  try {
    const record=await catalogueFetch(barcode,{signal:controller.signal,now,fetchImpl,archive});
    return {status:'found',record:await writeCatalogue(storage,record,{now})};
  } catch(error) {
    const status=error instanceof CatalogueNotFoundError?'not_found':'unavailable';
    if(!signal?.aborted)await storage.put('public-source-failure',{barcode,until:now+300_000,status});
    return {status,retryAfter:300};
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}

export async function getCatalogue(env,barcode,signal,options) {
  return (await getCatalogueOutcome(env,barcode,signal,options)).record||null;
}
// Fast trusted catalogue read for scoring: no OFF fallback or quota admission.
export class CatalogueIndexUnavailableError extends Error {}
class CatalogueIndexNotFoundError extends Error {}
export async function getCatalogueFromIndex(env,barcode,signal,{classifyMissing=false}={}) {
  if(!validCatalogueBarcode(barcode))return null;
  const index=env.FOOD_CATALOGUE_INDEX?.get(env.FOOD_CATALOGUE_INDEX.idFromName('uk-public-products-v1'),{locationHint:'weur'});
  const bounded=()=>signal?AbortSignal.any([signal,AbortSignal.timeout(1500)]):AbortSignal.timeout(1500);
  if(index)try {
    const response=await index.fetch('https://catalogue-index/batch',{method:'POST',body:JSON.stringify({codes:[barcode]}),signal:bounded()});
    if(!response.ok)throw new CatalogueIndexUnavailableError('Catalogue index unavailable');
    {
      const body=await response.json();
      if(!Array.isArray(body.products)||!Array.isArray(body.ratings)||body.products.length>1||body.ratings.length!==body.products.length)
        throw new CatalogueIndexUnavailableError('Invalid catalogue index response');
      // Only a valid empty response proves absence for this one-code request.
      if(!body.products.length&&classifyMissing)throw new CatalogueIndexNotFoundError();
      const p=body.products[0],meta=body.ratings[0];
      if(body.products.length&&(!p||typeof p!=='object'||Array.isArray(p)||!meta||typeof meta!=='object'||Array.isArray(meta)))
        throw new CatalogueIndexUnavailableError('Invalid catalogue index entries');
      if(p&&(p.code!==barcode||meta?.barcode!==barcode))throw new CatalogueIndexUnavailableError('Mismatched catalogue index response');
      const held=publicCatalogueQualityHoldMatches(meta?.score,{barcode,sourceFingerprint:meta?.sourceFingerprint});
      if(meta){
        const score=meta.score,hasHoldIndication=score&&(Object.hasOwn(score,'catalogueQualityHold')||score.scoreBasis==='catalogue_quality_hold'||score.reasonCodes?.includes('catalogue_quality_hold'));
        if(!Number.isSafeInteger(meta.fetchedAt)||meta.fetchedAt<=0||meta.fetchedAt>Date.now()+60000
          ||!Number.isSafeInteger(meta.expiresAt)||meta.expiresAt<=meta.fetchedAt
          ||!Number.isSafeInteger(meta.calculatedAt)||meta.calculatedAt<=0||meta.calculatedAt>Date.now()+60000
          ||typeof meta.sourceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(meta.sourceFingerprint)
          ||!score||typeof score!=='object'||Array.isArray(score)||typeof score.available!=='boolean'
          ||typeof score.methodId!=='string'||!score.methodId||score.methodId!==meta.method
          ||typeof score.version!=='string'||!score.version||score.version!==meta.version
          ||typeof score.classifierVersion!=='string'||!score.classifierVersion||score.classifierVersion!==meta.classifierVersion
          ||(score.available?(!['rated','provisional','estimated','estimated_provisional'].includes(score.status)||!Number.isFinite(score.value)||score.value<0||score.value>100)
            :score.status!=='unrated'||['value','grade','rawScore'].some(key=>score[key]!=null))
          ||hasHoldIndication&&!held)throw new CatalogueIndexUnavailableError('Unverified catalogue index response');
      }
      if(p&&meta?.sourceKind!=='nudge_community'&&Number.isSafeInteger(meta?.fetchedAt)&&meta.fetchedAt<=Date.now()+60000&&(meta.expiresAt>Date.now()||held)){
        const record=catalogueRecordFromPayload({product:p},barcode,meta.fetchedAt);
        if(!record||record.barcode!==barcode||!record.product||!record.providerPayload)throw new CatalogueIndexUnavailableError('Unusable catalogue source');
        return {...record,...(meta.score?.catalogueEnrichment||held?{catalogueRating:meta.score,catalogueCalculatedAt:meta.calculatedAt,catalogueSourceFingerprint:meta.sourceFingerprint}: {})};
      }
    }
  } catch(error) {
    if(classifyMissing&&error instanceof CatalogueIndexNotFoundError)throw error;
    // An outage is not proof that the barcode has no active source review.
    // Never recalculate or fetch around an unverified catalogue decision.
    throw new CatalogueIndexUnavailableError('Catalogue index unavailable');
  }
  return null;
}
export async function getCatalogueOutcome(env,barcode,signal,{skipIndex=false,allowSourceFetch=false}={}) {
  if(!validCatalogueBarcode(barcode))return {status:'unavailable'};
  // Foreground reads use only the cleaned, source-bound Nudge catalogue.
  // A missing index, expired/unusable source or outage is not a proven miss.
  // Background contribution processing must explicitly opt into source fetch.
  if(allowSourceFetch!==true){
    try{
      const record=await getCatalogueFromIndex(env,barcode,signal,{classifyMissing:true});
      return record?{status:'found',record}:{status:'unavailable',retryAfter:60};
    }catch(error){
      if(error instanceof CatalogueIndexNotFoundError)return {status:'not_found'};
      if(error instanceof CatalogueIndexUnavailableError)return {status:'unavailable',retryAfter:60};
      throw error;
    }
  }
  let known;
  try{known=skipIndex?null:await getCatalogueFromIndex(env,barcode,signal);}
  catch(error){if(error instanceof CatalogueIndexUnavailableError)return {status:'unavailable',retryAfter:60};throw error;}
  if(known)return {status:'found',record:known};
  const index=env.FOOD_CATALOGUE_INDEX?.get(env.FOOD_CATALOGUE_INDEX.idFromName('uk-public-products-v1'),{locationHint:'weur'});
  const bounded=()=>signal?AbortSignal.any([signal,AbortSignal.timeout(1500)]):AbortSignal.timeout(1500);
  if(!env.LABEL_QUOTA)return {status:'unavailable'};
  const stub=env.LABEL_QUOTA.get(env.LABEL_QUOTA.idFromName('food-catalogue:'+barcode));
  const response=await stub.fetch('https://catalogue/catalogue-lookup',{method:'POST',body:JSON.stringify({barcode}),signal});
  if(!response.ok)return {status:'unavailable'};
  const result=await response.json(),record=result.record||null;
  // Only a server-fetched, allowlisted public source record can grow the index.
  // User photos, label transcriptions and diary fields never enter this path.
  // A valid exact scan remains reusable even when country metadata is absent
  // or wrong. The index keeps such records outside UK/store discovery.
  if(index&&record?.providerPayload)try {
    await index.fetch('https://catalogue-index/retain',{method:'POST',body:JSON.stringify({product:record.providerPayload,sourceURL:record.product.sourceURL,fetchedAt:record.fetchedAt}),signal:bounded()});
  } catch { /* The scan remains usable even if indexing is temporarily unavailable. */ }
  return record?{status:'found',record}:{status:result.status==='not_found'?'not_found':'unavailable',retryAfter:result.retryAfter||300};
}
