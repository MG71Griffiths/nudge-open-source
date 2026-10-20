import {catalogueRecordFromPayload, validCatalogueBarcode} from './food-catalogue.js';
import {ScoreCore} from './nutrition-core.js';
import {stableStringify,scorePackagedProduct} from './product-score.js';
import {ENRICHMENT_VERSION,evaluateCatalogueEnrichment} from './catalogue-enrichment-evidence.js';
import {publicCatalogueQualityHoldMatches,applyActiveQualityHoldStatement} from './catalogue-quality-hold.js';

export const ENRICHMENT_MAX_ATTEMPTS=3, ENRICHMENT_LEASE_MS=180_000, ENRICHMENT_MAX_ACTIVE=5, ENRICHMENT_PILOT_LIMIT=1000;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),allowed=(v,keys)=>object(v)&&Object.keys(v).every(k=>keys.includes(k));
const current=()=>[ScoreCore.SCORE_METHOD,ScoreCore.SCORE_VERSION,ScoreCore.CLASSIFIER_VERSION];
const sourceColumns='barcode,provider_json,source_fingerprint,fetched_at,expires_at,source_url,import_source_url,score_json,rating_value,score_method,score_version,classifier_version';
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stableStringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
const priorities={scan:3,search:2,pilot:1,recovery:1},priorityReasons={2:'search',3:'scan'};
const jobReason=job=>priorityReasons[job.priority]||(job.recovery_selected===1?'recovery':'pilot');
const validFingerprint=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const popularity=raw=>Number.isSafeInteger(raw.unique_scans_n)&&raw.unique_scans_n>0?Math.min(raw.unique_scans_n,2147483647):0;
export class CatalogueEnrichmentError extends Error {
 constructor(message='Invalid catalogue enrichment request.',status=400,code='catalogue_enrichment_invalid'){super(message);this.status=status;this.code=code;}
}
function checkTime(now){if(!Number.isSafeInteger(now)||now<=0)throw new CatalogueEnrichmentError();}
function parsedScore(row){try{return JSON.parse(row.score_json);}catch{return null;}}
export function currentEnrichmentScore(row,{now=Date.now()}={}){
 const score=parsedScore(row),e=score?.catalogueEnrichment;
 if(!e)return null;
 return e.version===ENRICHMENT_VERSION&&e.sourceFingerprint===row.source_fingerprint&&Number.isSafeInteger(e.expiresAt)&&e.expiresAt>now&&row.expires_at>now
  &&row.score_method===ScoreCore.SCORE_METHOD&&row.score_version===ScoreCore.SCORE_VERSION&&row.classifier_version===ScoreCore.CLASSIFIER_VERSION&&ScoreCore.validResult(score)?score:null;
}
export function hasEnrichedScore(row){return Boolean(parsedScore(row)?.catalogueEnrichment);}
function baseScore(row){
 const raw=JSON.parse(row.provider_json),p=catalogueRecordFromPayload({product:raw},row.barcode,row.fetched_at).product;
 return scorePackagedProduct(p);
}
// Core reasons can be display labels, not just identifier-like words. Retain
// every bounded reason with one stable JSON/SQL-friendly diagnostic spelling.
const missingInputs=score=>[...new Set((score?.missingInputs||[]).filter(v=>typeof v==='string'&&v.length<=500)
 .map(v=>v.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,80)).filter(Boolean))].slice(0,30);
function unscored(row,now){
 if(publicCatalogueQualityHoldMatches(parsedScore(row),{barcode:row.barcode,sourceFingerprint:row.source_fingerprint}))return false;
 if(row.expires_at<=now||row.fetched_at>now)return false;
 if(currentEnrichmentScore(row,{now}))return false;
 if(!hasEnrichedScore(row)&&row.score_method===ScoreCore.SCORE_METHOD&&row.score_version===ScoreCore.SCORE_VERSION&&row.classifier_version===ScoreCore.CLASSIFIER_VERSION&&ScoreCore.validResult(parsedScore(row)))return false;
 return !baseScore(row).available;
}
// Admission uses the already-calculated current score. Candidate pagination never
// recalculates the catalogue or calls a provider; raw parsing is bounded per page.
async function recoveryAdmission(row,now,expectedFingerprint,{allowExpiredOverlay=false}={}){
 let score=parsedScore(row);
 if(publicCatalogueQualityHoldMatches(score,{barcode:row.barcode,sourceFingerprint:row.source_fingerprint}))return {excluded:'source_quality_hold'};
 if(!Number.isSafeInteger(row.fetched_at)||!Number.isSafeInteger(row.expires_at)||row.fetched_at>now||row.expires_at<=now)return {excluded:'source_expired_or_invalid'};
 if(row.score_method!==ScoreCore.SCORE_METHOD||row.score_version!==ScoreCore.SCORE_VERSION||row.classifier_version!==ScoreCore.CLASSIFIER_VERSION
   ||score?.methodId!==ScoreCore.SCORE_METHOD||score?.version!==ScoreCore.SCORE_VERSION||score?.classifierVersion!==ScoreCore.CLASSIFIER_VERSION)return {excluded:'score_revision_changed'};
 if(score.category==='unsupported')return {excluded:'unsupported'};
 // Ordinary demand can renew an expired overlay after the same public facts
 // have been refreshed. Administrative recovery remains current-unrated only.
 const overlay=score.catalogueEnrichment,expiredOverlay=allowExpiredOverlay&&overlay?.version===ENRICHMENT_VERSION
  &&overlay.sourceFingerprint===row.source_fingerprint&&Number.isSafeInteger(overlay.expiresAt)&&overlay.expiresAt>0&&overlay.expiresAt<=now
  &&row.rating_value===score.value&&ScoreCore.validResult(score);
 if(!expiredOverlay&&(score.available!==false||score.value!==null||row.rating_value!==null||score.status!=='unrated'||!Array.isArray(score.missingInputs)))return {excluded:'not_unrated'};
 if(expectedFingerprint!==undefined&&expectedFingerprint!==row.source_fingerprint)return {excluded:'source_changed'};
 try{
  if(!validFingerprint(row.source_fingerprint)||typeof row.provider_json!=='string'||new TextEncoder().encode(row.provider_json).length>2_000_000)return {excluded:'source_invalid'};
  const raw=JSON.parse(row.provider_json);
  if(!object(raw)||raw.code!==row.barcode||await digest(raw)!==row.source_fingerprint)return {excluded:'source_invalid'};
  const product=catalogueRecordFromPayload({product:raw},row.barcode,row.fetched_at).product;
  if(!product?.name||product.barcode!==row.barcode)return {excluded:'source_invalid'};
  if(expiredOverlay){
   score=scorePackagedProduct(product);
   if(score.category==='unsupported')return {excluded:'unsupported'};
   if(score.available!==false||score.value!==null||score.status!=='unrated'||!Array.isArray(score.missingInputs))return {excluded:'not_unrated'};
  }
  return {raw,product,score,offUniqueScans:popularity(raw)};
 }catch{return {excluded:'source_invalid'};}
}
const identityGuard='barcode=? AND source_fingerprint=? AND expires_at>?';
async function enqueueRows(db,rows,reason,{now,pilot=false,expectedSources,carry}={}){
 let queued=0,alreadyKnown=0,skipped=0;const excluded={};
 for(const row of rows){
  const admitted=await recoveryAdmission(row,now,expectedSources?.get(row.barcode),{allowExpiredOverlay:reason!=='recovery'});
  if(admitted.excluded){skipped++;excluded[admitted.excluded]=(excluded[admitted.excluded]||0)+1;continue;}
  const revision=current(),id=await digest([row.barcode,row.source_fingerprint,ENRICHMENT_VERSION,...revision]),userDemand=!carry&&(reason==='scan'||reason==='search');
  const before=await db.prepare('SELECT id,pilot_selected FROM catalogue_enrichment_jobs WHERE id=?').bind(id).first();
  const carryGuard=carry?" AND EXISTS(SELECT 1 FROM catalogue_enrichment_jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>?)":'',carryBindings=carry?[carry.id,carry.lease_token,now]:[];
  const pilotGuard=pilot?' AND (EXISTS(SELECT 1 FROM catalogue_enrichment_jobs WHERE evidence_version=? AND barcode=? AND pilot_selected=1) OR (SELECT count(DISTINCT barcode) FROM catalogue_enrichment_jobs WHERE evidence_version=? AND pilot_selected=1)<?)':'';
  const insert=db.prepare(`INSERT INTO catalogue_enrichment_jobs(id,barcode,source_fingerprint,evidence_version,score_method,score_version,classifier_version,priority,demand_count,pilot_selected,status,created_at,updated_at,last_requested_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,'pending',?,?,? WHERE EXISTS(SELECT 1 FROM catalogue_products WHERE ${identityGuard} AND score_json=?)${carryGuard}${pilotGuard}
   ON CONFLICT(id) DO UPDATE SET priority=max(priority,excluded.priority),
    demand_count=CASE WHEN ${userDemand?1:0}=1 THEN min(1000000,CASE WHEN priority>1 THEN demand_count ELSE 0 END+1) ELSE max(demand_count,excluded.demand_count) END,
    last_requested_at=max(last_requested_at,excluded.last_requested_at),
    updated_at=excluded.updated_at,pilot_selected=max(pilot_selected,excluded.pilot_selected),
    status=CASE WHEN status='succeeded' AND next_retry_at<=excluded.updated_at THEN 'pending' ELSE status END,
    attempts=CASE WHEN status='succeeded' AND next_retry_at<=excluded.updated_at THEN 0 ELSE attempts END,
    completed_at=CASE WHEN status='succeeded' AND next_retry_at<=excluded.updated_at THEN NULL ELSE completed_at END,
    next_retry_at=CASE WHEN status='succeeded' AND next_retry_at<=excluded.updated_at THEN NULL ELSE next_retry_at END
   WHERE excluded.priority>priority OR excluded.pilot_selected>pilot_selected
    OR (${userDemand?1:0}=1 AND last_requested_at<=excluded.last_requested_at-60000)
    OR (${carry?1:0}=1 AND (demand_count<excluded.demand_count OR last_requested_at<excluded.last_requested_at))
    OR (status='succeeded' AND next_retry_at<=excluded.updated_at)
   RETURNING id`).bind(id,row.barcode,row.source_fingerprint,ENRICHMENT_VERSION,...revision,priorities[reason],carry?.priority>1?carry.demand_count:userDemand?1:0,pilot?1:0,now,now,carry?.priority>1?carry.last_requested_at:userDemand?now:0,row.barcode,row.source_fingerprint,now,row.score_json,...carryBindings,...(pilot?[ENRICHMENT_VERSION,row.barcode,ENRICHMENT_VERSION,ENRICHMENT_PILOT_LIMIT]:[]));
  // Separate additive metadata avoids rewriting existing queue rows at rollout.
  // Its source-bound count is OFF popularity, never invented user scan demand.
  const metadata=db.prepare(`INSERT INTO catalogue_enrichment_priority_metadata(job_id,off_unique_scans,recovery_selected)
   SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM catalogue_enrichment_jobs WHERE id=?)
    AND EXISTS(SELECT 1 FROM catalogue_products WHERE ${identityGuard} AND score_json=?)${carryGuard}
   ON CONFLICT(job_id) DO UPDATE SET recovery_selected=max(recovery_selected,excluded.recovery_selected) RETURNING job_id`)
   .bind(id,admitted.offUniqueScans,reason==='recovery'||carry?.recovery_selected===1?1:0,id,row.barcode,row.source_fingerprint,now,row.score_json,...carryBindings);
  const [receipt,metadataReceipt]=await db.batch([insert,metadata]);
  if(!metadataReceipt.results?.length||!receipt.results?.length&&(!before||pilot&&!before.pilot_selected)){skipped++;excluded[pilot?'pilot_limit':'source_changed']=(excluded[pilot?'pilot_limit':'source_changed']||0)+1;continue;}
  await db.prepare(`INSERT INTO catalogue_enrichment_observations(job_id,outcome,missing_inputs_json,evaluated_at) VALUES(?,'pending',?,?)
   ON CONFLICT(job_id) DO UPDATE SET missing_inputs_json=excluded.missing_inputs_json,evaluated_at=excluded.evaluated_at
   WHERE catalogue_enrichment_observations.outcome='pending' AND catalogue_enrichment_observations.missing_inputs_json!=excluded.missing_inputs_json`).bind(id,JSON.stringify(missingInputs(admitted.score)),now).run();
  if(before)alreadyKnown++;else queued++;
 }
 return {queued,alreadyKnown,skipped,excluded};
}
export async function enqueueCatalogueEnrichment(db,body,{now=Date.now()}={}){
 checkTime(now);const recovery=body?.reason==='recovery';
 if(recovery){
  if(!allowed(body,['products','reason'])||!Array.isArray(body.products)||!body.products.length||body.products.length>50
   ||body.products.some(p=>!allowed(p,['barcode','sourceFingerprint'])||!validCatalogueBarcode(p.barcode)||!validFingerprint(p.sourceFingerprint))
   ||new Set(body.products.map(p=>p.barcode)).size!==body.products.length)throw new CatalogueEnrichmentError();
 }else if(!allowed(body,['barcodes','reason'])||!Array.isArray(body.barcodes)||!body.barcodes.length||body.barcodes.length>50||body.barcodes.some(code=>!validCatalogueBarcode(code))||!Object.hasOwn(priorities,body.reason))throw new CatalogueEnrichmentError();
 const codes=recovery?body.products.map(p=>p.barcode):[...new Set(body.barcodes)],rows=(await db.prepare(`SELECT ${sourceColumns} FROM catalogue_products WHERE barcode IN(SELECT value FROM json_each(?))`).bind(JSON.stringify(codes)).all()).results||[];
 const expectedSources=recovery?new Map(body.products.map(p=>[p.barcode,p.sourceFingerprint])):undefined;
 return {version:ENRICHMENT_VERSION,...await enqueueRows(db,rows,body.reason,{now,pilot:body.reason==='pilot',expectedSources}),missing:codes.length-rows.length};
}
// Internal runner operation only: a source refresh is not another user scan.
// The active original lease binds the carried demand, priority and membership.
export async function refreshCatalogueEnrichment(db,body,{now=Date.now()}={}){
 checkTime(now);
 if(!allowed(body,['id','leaseToken','sourceFingerprint'])||!validFingerprint(body.id)||!validFingerprint(body.sourceFingerprint)
  ||!/^[a-f0-9-]{36}$/.test(body.leaseToken||''))throw new CatalogueEnrichmentError();
 const job=await db.prepare(`SELECT j.*,coalesce(m.recovery_selected,0) AS recovery_selected FROM catalogue_enrichment_jobs j
  LEFT JOIN catalogue_enrichment_priority_metadata m ON m.job_id=j.id WHERE j.id=? AND j.status='running' AND j.lease_token=? AND j.lease_until>?
  AND j.evidence_version=? AND j.score_method=? AND j.score_version=? AND j.classifier_version=?`).bind(body.id,body.leaseToken,now,ENRICHMENT_VERSION,...current()).first();
 if(!job||job.source_fingerprint===body.sourceFingerprint)return {version:ENRICHMENT_VERSION,queued:0,stale:true};
 const row=await db.prepare(`SELECT ${sourceColumns} FROM catalogue_products WHERE barcode=? AND source_fingerprint=?`).bind(job.barcode,body.sourceFingerprint).first();
 if(!row)return {version:ENRICHMENT_VERSION,queued:0,stale:true};
 return {version:ENRICHMENT_VERSION,...await enqueueRows(db,[row],jobReason(job),{now,pilot:job.pilot_selected===1,carry:job,
  expectedSources:new Map([[job.barcode,body.sourceFingerprint]])})};
}
// Keyset pages scan at most 50 current source records. Rank all pages together
// when building a manifest; never discard the cursor after an empty valid page.
export async function catalogueRecoveryCandidates(db,body={}, {now=Date.now()}={}){
 checkTime(now);const limit=body.limit??50,after=body.after??'';
 if(!allowed(body,['limit','after'])||!Number.isInteger(limit)||limit<1||limit>50||typeof after!=='string'||after&&!validCatalogueBarcode(after))throw new CatalogueEnrichmentError();
 const selected=(await db.prepare(`SELECT ${sourceColumns.split(',').map(c=>'p.'+c).join(',')},j.priority,j.demand_count,j.status AS job_status,j.next_retry_at,
  coalesce(m.recovery_selected,0) AS recovery_selected
  FROM catalogue_products p LEFT JOIN catalogue_enrichment_jobs j ON j.barcode=p.barcode AND j.source_fingerprint=p.source_fingerprint
   AND j.evidence_version=? AND j.score_method=? AND j.score_version=? AND j.classifier_version=?
  LEFT JOIN catalogue_enrichment_priority_metadata m ON m.job_id=j.id
  WHERE p.barcode>? AND p.is_uk=1 AND p.rating_value IS NULL AND p.score_method=? AND p.score_version=? AND p.classifier_version=?
  ORDER BY p.barcode LIMIT ?`).bind(ENRICHMENT_VERSION,...current(),after,...current(),limit+1).all()).results||[];
 const rows=selected.slice(0,limit),products=[],excluded={};
 for(const row of rows){
  const admitted=await recoveryAdmission(row,now);
  const reason=admitted.excluded||(['running','unresolved','exhausted','stale'].includes(row.job_status)?'already_processed_or_running':null);
  if(reason){excluded[reason]=(excluded[reason]||0)+1;continue;}
  products.push({barcode:row.barcode,sourceFingerprint:row.source_fingerprint,fetchedAt:row.fetched_at,expiresAt:row.expires_at,
   name:admitted.product.name,missingInputs:missingInputs(admitted.score),offUniqueScans:admitted.offUniqueScans,
   priority:row.priority>1?row.priority:1,demandCount:row.priority>1?row.demand_count:0,
   reason:row.priority>1?jobReason(row):'recovery',jobStatus:row.job_status||null});
 }
 products.sort((a,b)=>b.priority-a.priority||b.demandCount-a.demandCount||b.offUniqueScans-a.offUniqueScans||a.barcode.localeCompare(b.barcode));
 const hasMore=selected.length>limit;
 return {version:ENRICHMENT_VERSION,method:ScoreCore.SCORE_METHOD,scoreVersion:ScoreCore.SCORE_VERSION,classifierVersion:ScoreCore.CLASSIFIER_VERSION,
  ranking:'priority,demandCount,offUniqueScans descending; barcode ascending; rank across pages for a complete manifest',
  products,scanned:rows.length,excluded,hasMore,nextAfter:hasMore?rows.at(-1).barcode:null};
}
async function expireLeases(db,now){
 await db.prepare("UPDATE catalogue_enrichment_jobs SET status=CASE WHEN attempts>=? THEN 'exhausted' ELSE 'retryable' END,next_retry_at=CASE WHEN attempts>=? THEN NULL ELSE ?+attempts*60000 END,lease_token=NULL,lease_until=NULL,updated_at=?,error_code='lease_expired' WHERE status='running' AND lease_until<=?").bind(ENRICHMENT_MAX_ATTEMPTS,ENRICHMENT_MAX_ATTEMPTS,now,now,now).run();
}
export async function claimCatalogueEnrichment(db,body={}, {now=Date.now()}={}){
 checkTime(now);const limit=body.limit??1;
 if(!allowed(body,['limit'])||!Number.isInteger(limit)||limit<1||limit>5)throw new CatalogueEnrichmentError();
 await expireLeases(db,now);
 const revision=current(),jobs=[];
 for(let i=0;i<limit;i++){
  const lease=crypto.randomUUID();
  const job=await db.prepare(`UPDATE catalogue_enrichment_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=?,error_code=NULL
   WHERE id=(SELECT j.id FROM catalogue_enrichment_jobs j WHERE j.evidence_version=? AND j.score_method=? AND j.score_version=? AND j.classifier_version=? AND j.status IN('pending','retryable','deferred') AND j.attempts<? AND COALESCE(j.next_retry_at,0)<=?
    AND (SELECT count(*) FROM catalogue_enrichment_jobs WHERE status='running' AND lease_until>?)<?
    ORDER BY j.priority DESC,CASE WHEN j.priority>1 THEN j.demand_count ELSE 0 END DESC,
     coalesce((SELECT m.off_unique_scans FROM catalogue_enrichment_priority_metadata m WHERE m.job_id=j.id),0) DESC,j.created_at,j.id LIMIT 1) RETURNING *`).bind(lease,now+ENRICHMENT_LEASE_MS,now,ENRICHMENT_VERSION,...revision,ENRICHMENT_MAX_ATTEMPTS,now,now,ENRICHMENT_MAX_ACTIVE).first();
  if(!job)break;
  const row=await db.prepare(`SELECT ${sourceColumns} FROM catalogue_products WHERE barcode=? AND source_fingerprint=? AND expires_at>?`).bind(job.barcode,job.source_fingerprint,now).first();
  const admitted=row?await recoveryAdmission(row,now,undefined,{allowExpiredOverlay:job.priority>1||job.pilot_selected===1}):{excluded:'source_missing'};
  if(admitted.excluded){
   await db.prepare("UPDATE catalogue_enrichment_jobs SET status='stale',lease_token=NULL,lease_until=NULL,completed_at=?,updated_at=? WHERE id=? AND lease_token=?").bind(now,now,job.id,lease).run();continue;
  }
  const metadata=await db.prepare('SELECT off_unique_scans,recovery_selected FROM catalogue_enrichment_priority_metadata WHERE job_id=?').bind(job.id).first()||{};
  jobs.push({id:job.id,barcode:job.barcode,reason:jobReason({...job,...metadata}),offUniqueScans:metadata.off_unique_scans||0,demandCount:job.priority>1?job.demand_count:0,priority:job.priority,isPilot:job.pilot_selected===1,sourceFingerprint:job.source_fingerprint,evidenceVersion:ENRICHMENT_VERSION,attempt:job.attempts,leaseToken:lease,leaseUntil:job.lease_until,sourceRow:row});
 }
 return {version:ENRICHMENT_VERSION,jobs};
}
const errorCodes=['source_unavailable','analysis_unavailable','analysis_timeout','analysis_response_invalid','incompatible_source','unneeded_composition','rate_limited','invalid_evidence','unsupported','insufficient_evidence','enrichment_budget','provider_cooldown'];
export async function completeCatalogueEnrichment(db,body,{now=Date.now()}={}){
 checkTime(now);
 if(!allowed(body,['id','leaseToken','sourceFingerprint','outcome','evidence','errorCode','retryAt'])||!/^[a-f0-9]{64}$/.test(body.id||'')||!/^[a-f0-9-]{36}$/.test(body.leaseToken||'')||!/^[a-f0-9]{64}$/.test(body.sourceFingerprint||'')
  ||!['evidence','unresolved','retryable_error','deferred'].includes(body.outcome)||body.errorCode!=null&&!errorCodes.includes(body.errorCode)
  ||body.outcome==='evidence'&&(!allowed(body.evidence,['classification','compositionRecordId','nutritionEvidence'])||new TextEncoder().encode(JSON.stringify(body.evidence)).length>24000)
  ||body.outcome!=='evidence'&&body.evidence!=null
  ||body.outcome==='deferred'&&(!['enrichment_budget','provider_cooldown'].includes(body.errorCode)||!Number.isSafeInteger(body.retryAt)||body.retryAt<now+60000||body.retryAt>now+86400000)
  ||body.outcome!=='deferred'&&body.retryAt!=null)throw new CatalogueEnrichmentError();
 const job=await db.prepare("SELECT * FROM catalogue_enrichment_jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>? AND source_fingerprint=? AND evidence_version=? AND score_method=? AND score_version=? AND classifier_version=?").bind(body.id,body.leaseToken,now,body.sourceFingerprint,ENRICHMENT_VERSION,...current()).first();
 if(!job)return {stored:false,stale:true};
 const row=await db.prepare(`SELECT ${sourceColumns} FROM catalogue_products WHERE barcode=? AND source_fingerprint=? AND expires_at>?`).bind(job.barcode,job.source_fingerprint,now).first();
 const guard="id=? AND status='running' AND lease_token=? AND lease_until>? AND source_fingerprint=?";
 const guardValues=[job.id,body.leaseToken,now,body.sourceFingerprint];
 if(!row){await db.prepare(`UPDATE catalogue_enrichment_jobs SET status='stale',lease_token=NULL,lease_until=NULL,completed_at=?,updated_at=? WHERE ${guard}`).bind(now,now,...guardValues).run();return {stored:false,stale:true};}
 if(!unscored(row,now)){
  await db.prepare(`UPDATE catalogue_enrichment_jobs SET status='stale',lease_token=NULL,lease_until=NULL,completed_at=?,updated_at=? WHERE ${guard}`).bind(now,now,...guardValues).run();
  return {stored:false,alreadyRated:true};
 }
 if(body.outcome==='deferred'){
  await db.prepare(`UPDATE catalogue_enrichment_jobs SET status='deferred',attempts=max(0,attempts-1),next_retry_at=?,lease_token=NULL,lease_until=NULL,updated_at=?,error_code=? WHERE ${guard}`).bind(body.retryAt,now,body.errorCode,...guardValues).run();
  return {stored:false,status:'deferred',retryAt:body.retryAt};
 }
 let evaluated=null;
 if(body.outcome==='evidence'||body.outcome==='unresolved'){
  const raw=JSON.parse(row.provider_json);if(await digest(raw)!==row.source_fingerprint)throw new CatalogueEnrichmentError('Public source fingerprint mismatch.',409,'catalogue_enrichment_stale');
  try{evaluated=evaluateCatalogueEnrichment(raw,{...body.evidence,now});}
  catch{throw new CatalogueEnrichmentError('Invalid catalogue enrichment evidence.',400,'catalogue_enrichment_evidence_invalid');}
 }
 const canonical=evaluated?JSON.stringify({version:ENRICHMENT_VERSION,classification:evaluated.classification,evidence:evaluated.evidence,provenance:evaluated.provenance}):null;
 if(canonical&&new TextEncoder().encode(canonical).length>48000)throw new CatalogueEnrichmentError('Validated evidence is too large.');
 const observedFresh='EXISTS(SELECT 1 FROM catalogue_products WHERE '+identityGuard+' AND score_json=?)';
 const observedValues=[row.barcode,row.source_fingerprint,now,row.score_json];
 const observation=()=>db.prepare(`INSERT INTO catalogue_enrichment_observations(job_id,outcome,evidence_json,missing_inputs_json,evaluated_at) SELECT ?,?,?,?,? WHERE ${observedFresh} AND EXISTS(SELECT 1 FROM catalogue_enrichment_jobs WHERE ${guard})
  ON CONFLICT(job_id) DO UPDATE SET outcome=excluded.outcome,evidence_json=excluded.evidence_json,missing_inputs_json=excluded.missing_inputs_json,evaluated_at=excluded.evaluated_at`).bind(job.id,evaluated.outcome,canonical,JSON.stringify(missingInputs(evaluated.score)),now,...observedValues,...guardValues);
 const accepted=evaluated&&['enriched','estimated'].includes(evaluated.outcome)&&evaluated.score?.available===true&&ScoreCore.validResult(evaluated.score);
 if(!accepted){
  const retry=body.outcome==='retryable_error'&&job.attempts<ENRICHMENT_MAX_ATTEMPTS,status=retry?'retryable':body.outcome==='retryable_error'?'exhausted':'unresolved';
  const update=db.prepare(`UPDATE catalogue_enrichment_jobs SET status=?,next_retry_at=?,lease_token=NULL,lease_until=NULL,completed_at=?,updated_at=?,error_code=? WHERE ${guard} AND ${observedFresh} RETURNING id`).bind(status,retry?now+60000*2**(job.attempts-1):null,retry?null:now,now,body.errorCode||'insufficient_evidence',...guardValues,...observedValues);
  const writes=await db.batch([...(evaluated?[observation()]:[]),update]);
  return writes.at(-1)?.results?.length?{stored:false,status}:{stored:false,stale:true};
 }
 const expiresAt=Math.min(row.expires_at,now+30*86400000),score={...evaluated.score,catalogueEnrichment:{version:ENRICHMENT_VERSION,sourceFingerprint:row.source_fingerprint,expiresAt}};
 const evidence=canonical;
 const scoreJSON=JSON.stringify(score);if(new TextEncoder().encode(scoreJSON).length>96000)throw new CatalogueEnrichmentError('Validated evidence is too large.');
 const fresh=observedFresh,leaseGuard='EXISTS(SELECT 1 FROM catalogue_enrichment_jobs WHERE '+guard+')';
 const bindings=[...observedValues,...guardValues];
 const statements=[observation(),
  db.prepare(`INSERT INTO catalogue_enrichment_scores(barcode,source_fingerprint,source_fetched_at,evidence_version,score_method,score_version,classifier_version,evidence_json,score_json,rating_value,calculated_at,expires_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${fresh} AND ${leaseGuard}
   ON CONFLICT(barcode) DO UPDATE SET source_fingerprint=excluded.source_fingerprint,source_fetched_at=excluded.source_fetched_at,evidence_version=excluded.evidence_version,score_method=excluded.score_method,score_version=excluded.score_version,classifier_version=excluded.classifier_version,evidence_json=excluded.evidence_json,score_json=excluded.score_json,rating_value=excluded.rating_value,calculated_at=excluded.calculated_at,expires_at=excluded.expires_at`).bind(row.barcode,row.source_fingerprint,row.fetched_at,ENRICHMENT_VERSION,...current(),evidence,scoreJSON,score.value,now,expiresAt,...bindings),
  db.prepare(`UPDATE catalogue_products SET score_json=?,rating_value=?,score_method=?,score_version=?,classifier_version=?,calculated_at=? WHERE ${identityGuard} AND score_json=? AND ${leaseGuard} RETURNING barcode`).bind(scoreJSON,score.value,...current(),now,...bindings),
  db.prepare(`UPDATE catalogue_enrichment_jobs SET status='succeeded',next_retry_at=?,lease_token=NULL,lease_until=NULL,completed_at=?,updated_at=?,error_code=NULL WHERE ${guard} AND EXISTS(SELECT 1 FROM catalogue_products WHERE ${identityGuard} AND score_json=?)`).bind(expiresAt,now,now,...guardValues,row.barcode,row.source_fingerprint,now,scoreJSON),
  applyActiveQualityHoldStatement(db,{barcode:row.barcode,sourceFingerprint:row.source_fingerprint,fetchedAt:row.fetched_at})
 ];
 const results=await db.batch(statements);return results[2]?.results?.length===1?{stored:true,status:'succeeded',value:score.value,estimated:score.estimated===true}:{stored:false,stale:true};
}
export async function catalogueEnrichmentStatus(db,body={}, {now=Date.now()}={}){
 checkTime(now);if(!allowed(body,[]))throw new CatalogueEnrichmentError();
 const revision=[ENRICHMENT_VERSION,...current()],scope='evidence_version=? AND score_method=? AND score_version=? AND classifier_version=?';
 const counts=(await db.prepare(`SELECT status,count(*) AS n,sum(attempts) AS attempts FROM catalogue_enrichment_jobs WHERE ${scope} GROUP BY status`).bind(...revision).all()).results||[];
 const priorities=(await db.prepare(`SELECT CASE WHEN priority=3 THEN 'scan' WHEN priority=2 THEN 'search' WHEN coalesce(m.recovery_selected,0)=1 THEN 'recovery' ELSE 'pilot' END AS reason,count(*) AS n
  FROM catalogue_enrichment_jobs j LEFT JOIN catalogue_enrichment_priority_metadata m ON m.job_id=j.id WHERE ${scope.split(' AND ').map(x=>'j.'+x).join(' AND ')} AND status IN('pending','retryable','deferred') GROUP BY reason`).bind(...revision).all()).results||[];
 const next=await db.prepare(`SELECT min(CASE WHEN status='running' THEN lease_until WHEN status='pending' THEN ? ELSE next_retry_at END) AS next FROM catalogue_enrichment_jobs WHERE ${scope} AND status IN('pending','running','retryable','deferred')`).bind(now,...revision).first();
 const scored=await db.prepare(`SELECT count(*) AS total,sum(json_extract(score_json,'$.estimated')=1) AS estimated FROM catalogue_enrichment_scores WHERE ${scope} AND expires_at>? AND EXISTS(SELECT 1 FROM catalogue_products p WHERE p.barcode=catalogue_enrichment_scores.barcode AND p.source_fingerprint=catalogue_enrichment_scores.source_fingerprint AND p.expires_at>?)`).bind(...revision,now,now).first();
 const errors=(await db.prepare(`SELECT error_code AS code,count(*) AS n FROM catalogue_enrichment_jobs WHERE ${scope} AND error_code IS NOT NULL GROUP BY error_code`).bind(...revision).all()).results||[];
 const missing=(await db.prepare(`SELECT m.value AS reason,count(*) AS n FROM catalogue_enrichment_jobs j JOIN catalogue_enrichment_observations o ON o.job_id=j.id,json_each(o.missing_inputs_json) m WHERE ${scope.split(' AND ').map(x=>'j.'+x).join(' AND ')} GROUP BY m.value`).bind(...revision).all()).results||[];
 const pilotOutcomes=(await db.prepare(`WITH latest AS (SELECT id,row_number() OVER(PARTITION BY barcode ORDER BY created_at DESC,id DESC) AS rank FROM catalogue_enrichment_jobs WHERE ${scope} AND pilot_selected=1) SELECT o.outcome,count(*) AS n FROM latest j JOIN catalogue_enrichment_observations o ON o.job_id=j.id WHERE j.rank=1 GROUP BY o.outcome`).bind(...revision).all()).results||[];
 const pilotCoverage=await db.prepare(`SELECT count(*) AS rated,sum(COALESCE(json_extract(p.score_json,'$.estimated'),0)=1) AS estimated FROM catalogue_products p
  WHERE p.barcode IN(SELECT DISTINCT barcode FROM catalogue_enrichment_jobs WHERE evidence_version=? AND pilot_selected=1)
  AND p.score_method=? AND p.score_version=? AND p.classifier_version=? AND p.expires_at>? AND p.rating_value IS NOT NULL
  AND (json_extract(p.score_json,'$.catalogueEnrichment') IS NULL OR (json_extract(p.score_json,'$.catalogueEnrichment.version')=? AND json_extract(p.score_json,'$.catalogueEnrichment.sourceFingerprint')=p.source_fingerprint AND json_extract(p.score_json,'$.catalogueEnrichment.expiresAt')>?))`).bind(...revision,now,ENRICHMENT_VERSION,now).first();
 const superseded=await db.prepare(`SELECT count(*) AS n FROM catalogue_enrichment_jobs WHERE NOT(${scope})`).bind(...revision).first();
 const pilot=await db.prepare('SELECT cursor,scanned,finished FROM catalogue_enrichment_pilots WHERE evidence_version=?').bind(ENRICHMENT_VERSION).first();
 const selected=await db.prepare('SELECT count(DISTINCT barcode) AS n FROM catalogue_enrichment_jobs WHERE evidence_version=? AND pilot_selected=1').bind(ENRICHMENT_VERSION).first();
 return {version:ENRICHMENT_VERSION,method:ScoreCore.SCORE_METHOD,scoreVersion:ScoreCore.SCORE_VERSION,classifierVersion:ScoreCore.CLASSIFIER_VERSION,
  counts:Object.fromEntries(counts.map(r=>[r.status,Number(r.n)])),supersededJobs:Number(superseded?.n||0),attempts:counts.reduce((n,r)=>n+Number(r.attempts),0),
  errorCodes:Object.fromEntries(errors.map(r=>[r.code,Number(r.n)])),missingInputs:Object.fromEntries(missing.map(r=>[r.reason,Number(r.n)])),
  queuedByPriority:Object.fromEntries(priorities.map(r=>[r.reason,Number(r.n)])),nextAttemptAt:next?.next??null,
  scored:{total:Number(scored?.total||0),exact:Number(scored?.total||0)-Number(scored?.estimated||0),estimated:Number(scored?.estimated||0)},
  pilot:{selected:Number(selected?.n||0),currentRated:Number(pilotCoverage?.rated||0),currentEstimated:Number(pilotCoverage?.estimated||0),currentExact:Number(pilotCoverage?.rated||0)-Number(pilotCoverage?.estimated||0),limit:ENRICHMENT_PILOT_LIMIT,scanned:Number(pilot?.scanned||0),finished:pilot?.finished===1,outcomes:Object.fromEntries(pilotOutcomes.map(r=>[r.outcome,Number(r.n)]))},
  limits:{maxAttempts:ENRICHMENT_MAX_ATTEMPTS,maxActive:ENRICHMENT_MAX_ACTIVE,leaseMs:ENRICHMENT_LEASE_MS}};
}
export async function seedCatalogueEnrichment(db,body={}, {now=Date.now()}={}){
 checkTime(now);const limit=body.limit??1000;if(!allowed(body,['limit'])||!Number.isInteger(limit)||limit<1||limit>1000)throw new CatalogueEnrichmentError();
 await db.prepare('INSERT OR IGNORE INTO catalogue_enrichment_pilots(evidence_version,updated_at) VALUES(?,?)').bind(ENRICHMENT_VERSION,now).run();
 const pilot=await db.prepare('SELECT * FROM catalogue_enrichment_pilots WHERE evidence_version=?').bind(ENRICHMENT_VERSION).first();
 const selected=await db.prepare('SELECT count(DISTINCT barcode) AS n FROM catalogue_enrichment_jobs WHERE evidence_version=? AND pilot_selected=1').bind(ENRICHMENT_VERSION).first();
 if(pilot.finished||selected.n>=ENRICHMENT_PILOT_LIMIT)return {version:ENRICHMENT_VERSION,queued:0,alreadyKnown:0,skipped:0,...await catalogueEnrichmentStatus(db,{}, {now})};
 // Scan at most 1,000 compact public candidates per call, in primary-key order.
 // The pilot cursor and lifetime cap prevent repeated requests from seeding an
 // unbounded population. Detailed source payloads are hydrated in pages of 50.
 const ids=(await db.prepare('SELECT barcode FROM catalogue_products WHERE barcode>? AND is_uk=1 AND expires_at>? AND rating_value IS NULL ORDER BY barcode LIMIT 1000').bind(pilot.cursor,now).all()).results||[];
 let remaining=Math.min(limit,ENRICHMENT_PILOT_LIMIT-Number(selected.n)),queued=0,alreadyKnown=0,skipped=0,scanned=0,last=pilot.cursor;
 for(let offset=0;offset<ids.length&&remaining>0;offset+=50){
  const chunk=ids.slice(offset,offset+50),rows=(await db.prepare(`SELECT ${sourceColumns} FROM catalogue_products WHERE barcode IN(SELECT value FROM json_each(?)) ORDER BY barcode`).bind(JSON.stringify(chunk.map(r=>r.barcode))).all()).results||[];
  for(const row of rows){
   last=row.barcode;scanned++;
   const p=catalogueRecordFromPayload({product:JSON.parse(row.provider_json)},row.barcode,row.fetched_at).product;
   if(Object.values(p.nutrients).filter(n=>n.value!==null).length<4){skipped++;continue;}
   const r=await enqueueRows(db,[row],'pilot',{now,pilot:true});queued+=r.queued;alreadyKnown+=r.alreadyKnown;skipped+=r.skipped;if(r.queued||r.alreadyKnown)remaining--;
   if(!remaining)break;
  }
 }
 await db.prepare('UPDATE catalogue_enrichment_pilots SET cursor=max(cursor,?),scanned=scanned+?,finished=CASE WHEN ? THEN 1 ELSE finished END,updated_at=? WHERE evidence_version=?').bind(last,scanned,ids.length<1000&&scanned===ids.length?1:0,now,ENRICHMENT_VERSION).run();
 return {version:ENRICHMENT_VERSION,queued,alreadyKnown,skipped,...await catalogueEnrichmentStatus(db,{}, {now})};
}
// Admin-only review exposes bounded public-source observations, never retained
// source payloads, private contribution media, model responses or credentials.
export async function reviewCatalogueEnrichment(db,body={}, {now=Date.now()}={}){
 checkTime(now);const limit=body.limit??20;
 if(!allowed(body,['limit'])||!Number.isInteger(limit)||limit<1||limit>20)throw new CatalogueEnrichmentError();
 const rows=(await db.prepare(`SELECT j.barcode,j.priority,j.pilot_selected,j.status,j.attempts,j.error_code,j.updated_at,j.source_fingerprint,coalesce(m.recovery_selected,0) AS recovery_selected,coalesce(m.off_unique_scans,0) AS off_unique_scans,
  o.outcome,o.evidence_json,o.missing_inputs_json,o.evaluated_at
  FROM catalogue_enrichment_jobs j LEFT JOIN catalogue_enrichment_observations o ON o.job_id=j.id
  LEFT JOIN catalogue_enrichment_priority_metadata m ON m.job_id=j.id
  WHERE j.evidence_version=? AND j.score_method=? AND j.score_version=? AND j.classifier_version=?
  ORDER BY CASE WHEN j.status IN('exhausted','retryable') THEN 0 WHEN j.status='succeeded' THEN 1 WHEN j.status='unresolved' THEN 2 ELSE 3 END,j.updated_at DESC,j.id DESC LIMIT ?`).bind(ENRICHMENT_VERSION,...current(),limit).all()).results||[];
 const result={version:ENRICHMENT_VERSION,method:ScoreCore.SCORE_METHOD,scoreVersion:ScoreCore.SCORE_VERSION,classifierVersion:ScoreCore.CLASSIFIER_VERSION,jobs:[],truncated:false};
 for(const row of rows){
  let observation=null;
  if(row.outcome){
   const canonical=row.evidence_json?JSON.parse(row.evidence_json):null;
   observation={outcome:row.outcome,missingInputs:missingInputs({missingInputs:JSON.parse(row.missing_inputs_json||'[]')}),evaluatedAt:row.evaluated_at,
    ...(canonical?{classification:canonical.classification,evidence:canonical.evidence,provenance:canonical.provenance}:{})};
  }
  result.jobs.push({barcode:row.barcode,priority:row.priority,reason:jobReason(row),isPilot:row.pilot_selected===1,offUniqueScans:row.off_unique_scans,
   status:row.status,attempts:row.attempts,errorCode:row.error_code,updatedAt:row.updated_at,sourceFingerprint:row.source_fingerprint,observation});
  if(new TextEncoder().encode(JSON.stringify(result)).length>99000){result.jobs.pop();result.truncated=true;break;}
 }
 return result;
}
export async function handleCatalogueEnrichment(db,action,body,options){
 const operations={enqueue:enqueueCatalogueEnrichment,claim:claimCatalogueEnrichment,complete:completeCatalogueEnrichment,status:catalogueEnrichmentStatus,seed:seedCatalogueEnrichment,review:reviewCatalogueEnrichment,candidates:catalogueRecoveryCandidates,refresh:refreshCatalogueEnrichment};
 if(!Object.hasOwn(operations,action))throw new CatalogueEnrichmentError();
 return operations[action](db,body,options);
}
export {ENRICHMENT_VERSION};
