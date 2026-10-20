// Operational source-quality review. This never changes the scoring algorithm
// or source facts; the original calculation stays in the private run export.
import { stableStringify } from './product-score.js';

export const QUALITY_HOLD_VERSION = 'catalogue-quality-hold-v1';
export const QUALITY_HOLD_REASONS = Object.freeze([
 'source_salt_sodium_conflict', 'source_alcohol_not_represented', 'source_identity_conflict'
]);
export const catalogueQualityHoldSchema = String.raw`
CREATE TABLE IF NOT EXISTS catalogue_scoring_run_holds (
 run_id TEXT NOT NULL, barcode TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
 source_fetched_at INTEGER NOT NULL, candidate_json TEXT NOT NULL, hold_json TEXT NOT NULL,
 PRIMARY KEY(run_id,barcode)
);
CREATE TABLE IF NOT EXISTS catalogue_quality_holds (
 barcode TEXT NOT NULL, source_fingerprint TEXT NOT NULL, run_id TEXT NOT NULL,
 hold_json TEXT NOT NULL, score_json TEXT NOT NULL, activated_at INTEGER NOT NULL,
 PRIMARY KEY(barcode,source_fingerprint)
);
CREATE TABLE IF NOT EXISTS catalogue_quality_hold_guards (
 token TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1)
);
`;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(v);
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const keys=(value,names)=>object(value)&&Object.keys(value).length===names.length&&Object.keys(value).every(key=>names.includes(key));
const publicHoldKeys=['version','barcode','sourceFingerprint','sourceFetchedAt','runID','reviewID','reviewedAt','reasonCode','candidateSHA256'];
export async function qualityHoldCandidateSHA256(candidate) {
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stableStringify(candidate)));
 return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
}
export function validCatalogueQualityHold(h) {
 return keys(h,[...publicHoldKeys,'reviewNote','evidenceNote','revision'])&&h.version===QUALITY_HOLD_VERSION&&id(h.runID)&&/^[0-9]{4,18}$/.test(h.barcode||'')
  &&hash(h.sourceFingerprint)&&Number.isSafeInteger(h.sourceFetchedAt)&&h.sourceFetchedAt>0
  &&QUALITY_HOLD_REASONS.includes(h.reasonCode)&&id(h.reviewID)&&text(h.reviewNote,2000)&&text(h.evidenceNote,2000)
  &&Number.isSafeInteger(h.reviewedAt)&&h.reviewedAt>=h.sourceFetchedAt&&hash(h.candidateSHA256)
  &&keys(h.revision,['method','version','classifierVersion'])&&text(h.revision.method,100)&&text(h.revision.version,30)&&text(h.revision.classifierVersion,100);
}
export function parseCatalogueQualityHold(value) {
 let hold=value;try{if(typeof value==='string')hold=JSON.parse(value);}catch{return null;}
 return validCatalogueQualityHold(hold)?hold:null;
}
// A refresh timestamp alone never clears a review. A different raw fingerprint
// is new evidence and cannot inherit the old source's hold.
export function qualityHoldMatches(hold,{barcode,sourceFingerprint}) {
 return validCatalogueQualityHold(hold)&&hold.barcode===barcode&&hold.sourceFingerprint===sourceFingerprint;
}
export function withheldCatalogueScore(candidate,hold) {
 if(!validCatalogueQualityHold(hold)||!object(candidate))throw new Error('Invalid catalogue quality hold');
 return publicWithheldScore(candidate,Object.fromEntries(publicHoldKeys.map(key=>[key,hold[key]])));
}
function publicWithheldScore(candidate,marker) {
 return {
  status:'unrated',available:false,value:null,grade:null,rawScore:null,
  methodId:candidate.methodId,version:candidate.version,methodVersion:candidate.version,model_version:candidate.version,
  classifierVersion:candidate.classifierVersion,methodStatus:candidate.methodStatus||'directional',
  category:'unknown',label:'Nudge score',scoreBasis:'catalogue_quality_hold',
  missingInputs:['verified consistent source evidence'],missingFields:['verified consistent source evidence'],
  reasonCodes:['catalogue_quality_hold',marker.reasonCode],
  reason:'Source information needs checking before a score can be shown.',
  catalogueQualityHold:marker
 };
}
// Call only after the caller establishes a trusted catalogue origin. This
// validates the public, note-free envelope; it never establishes that origin.
export function publicCatalogueQualityHoldMatches(score,{barcode,sourceFingerprint}={}) {
 const h=score?.catalogueQualityHold;
 if(!keys(h,publicHoldKeys)||h.version!==QUALITY_HOLD_VERSION||h.barcode!==barcode||!/^\d{4,18}$/.test(h.barcode||'')
  ||h.sourceFingerprint!==sourceFingerprint||!hash(h.sourceFingerprint)||!id(h.runID)||!id(h.reviewID)
  ||!Number.isSafeInteger(h.sourceFetchedAt)||h.sourceFetchedAt<=0||!Number.isSafeInteger(h.reviewedAt)||h.reviewedAt<h.sourceFetchedAt
  ||!hash(h.candidateSHA256)||!QUALITY_HOLD_REASONS.includes(h.reasonCode)
  ||score.methodId!=='nudge_nutrition_v0_4'||score.version!=='0.4'||!text(score.classifierVersion,100)||score.methodStatus!=='directional')return false;
 return stableStringify(score)===stableStringify(publicWithheldScore(score,h));
}
export async function getActiveCatalogueQualityHold(db,barcode,sourceFingerprint) {
 const row=await db.prepare('SELECT hold_json,score_json FROM catalogue_quality_holds WHERE barcode=? AND source_fingerprint=?').bind(barcode,sourceFingerprint).first();
 if(!row)return null;
 const hold=parseCatalogueQualityHold(row.hold_json);
 if(!qualityHoldMatches(hold,{barcode,sourceFingerprint}))throw new Error('Invalid stored catalogue quality hold');
 return hold;
}
// Append after every same-source score write, in its atomic batch. Keep the
// current scoring revision headers, but expose no candidate score/points. The
// active table contains the full review separately from this public template.
export function activeQualityHoldSQL({barcode,sourceFingerprint,fetchedAt}={}) {
 const where=[],values=[];
 if(barcode!==undefined){where.push('p.barcode=?');values.push(barcode);}
 if(sourceFingerprint!==undefined){where.push('p.source_fingerprint=?');values.push(sourceFingerprint);}
 if(fetchedAt!==undefined){where.push('p.fetched_at=?');values.push(fetchedAt);}
 where.push('EXISTS(SELECT 1 FROM catalogue_quality_holds h WHERE h.barcode=p.barcode AND h.source_fingerprint=p.source_fingerprint)');
 return {sql:`UPDATE catalogue_products AS p SET rating_value=NULL,score_json=(SELECT json_set(h.score_json,
  '$.methodId',p.score_method,'$.version',p.score_version,'$.methodVersion',p.score_version,'$.model_version',p.score_version,
  '$.classifierVersion',p.classifier_version) FROM catalogue_quality_holds h WHERE h.barcode=p.barcode AND h.source_fingerprint=p.source_fingerprint)
  WHERE ${where.join(' AND ')}`,values};
}
export function applyActiveQualityHoldStatement(db,options={}) {
 const {sql,values}=activeQualityHoldSQL(options);return db.prepare(sql).bind(...values);
}
