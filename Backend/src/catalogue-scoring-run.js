import { ScoreCore } from './nutrition-core.js';
import { replayDirectionalCatalogueEvidence } from './catalogue-scoring-evidence.js';
import { catalogueRecordFromPayload } from './food-catalogue.js';
import { DIRECTIONAL_SCORE_REVISION, stableStringify } from './product-score.js';
import { QUALITY_HOLD_VERSION, QUALITY_HOLD_REASONS, qualityHoldCandidateSHA256, parseCatalogueQualityHold,
 qualityHoldMatches, withheldCatalogueScore, getActiveCatalogueQualityHold, applyActiveQualityHoldStatement } from './catalogue-quality-hold.js';

export const SCORING_SELECTION_VERSION = 'aisle-completeness-round-robin-v1';
export const NON_UK_SCORING_SELECTION_VERSION = SCORING_SELECTION_VERSION+':non-uk';
export class CatalogueScoringRunError extends Error {
  constructor(message, status=400, code='catalogue_scoring_run_invalid') { super(message); this.status=status; this.code=code; }
}
const fail=(message,status=400,code)=>{throw new CatalogueScoringRunError(message,status,code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const allowed=(body,keys)=>object(body)&&Object.keys(body).every(key=>keys.includes(key));
const revision=()=>({method:DIRECTIONAL_SCORE_REVISION.method,version:DIRECTIONAL_SCORE_REVISION.version,classifierVersion:DIRECTIONAL_SCORE_REVISION.classifierVersion});
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(value);
const selectionVersion=scope=>scope==='non-uk'?NON_UK_SCORING_SELECTION_VERSION:SCORING_SELECTION_VERSION;
function runScope(run){
 if(run.selection_version===SCORING_SELECTION_VERSION)return 'uk';
 if(run.selection_version===NON_UK_SCORING_SELECTION_VERSION)return 'non-uk';
 fail('This run uses an unsupported selection scope. Keep its results and create a new run.',409,'catalogue_scoring_selection_changed');
}
async function getRun(db,runID,{requireCurrent=true}={}) {
 const run=await db.prepare('SELECT * FROM catalogue_scoring_runs WHERE id=?').bind(runID).first();
 if(!run)fail('Scoring run was not found.',404,'catalogue_scoring_run_missing');
 runScope(run);
 const rev=revision();
 if(requireCurrent&&(run.score_method!==rev.method||run.score_version!==rev.version||run.classifier_version!==rev.classifierVersion))fail('This run belongs to a different scoring revision. Keep its results and create a new run.',409,'catalogue_scoring_revision_changed');
 return run;
}
// Select using the small existing aisle index, with source binding. Rotate
// through aisle/completeness strata rather than taking the first 500 barcodes.
// All ranking occurs on narrow columns; nutrition payloads hydrate per step.
const selectionSQL=`WITH aisle AS (
 SELECT f.barcode,min(f.value) AS name FROM catalogue_discovery_filters f
 JOIN catalogue_discovery d INDEXED BY catalogue_discovery_binding ON d.barcode=f.barcode
 JOIN catalogue_products p INDEXED BY catalogue_discovery_sources ON p.barcode=d.barcode AND p.source_fingerprint=d.source_fingerprint
 WHERE f.kind='aisle' GROUP BY f.barcode
), candidates AS (
 SELECT p.barcode,coalesce(a.name,'unclassified') || ':' || CASE
 WHEN p.rating_value IS NOT NULL THEN 'rated'
 WHEN lower(json_extract(p.score_json,'$.missingInputs')) LIKE '%sugar%' OR lower(json_extract(p.score_json,'$.missingInputs')) LIKE '%saturated%' OR lower(json_extract(p.score_json,'$.missingInputs')) LIKE '%salt%' THEN 'missing_adverse_nutrients'
 ELSE 'other_unrated' END AS stratum
 FROM catalogue_products p LEFT JOIN aisle a ON a.barcode=p.barcode
 WHERE p.is_uk=? AND EXISTS(SELECT 1 FROM catalogue_scoring_runs gate WHERE gate.id=? AND gate.target=500
 AND coalesce((p.score_method=gate.score_method AND p.score_version=gate.score_version AND p.classifier_version=gate.classifier_version
  AND p.calculated_at>=p.fetched_at AND json_valid(p.score_json)
  AND json_extract(p.score_json,'$.methodId')=gate.score_method AND json_extract(p.score_json,'$.version')=gate.score_version
  AND json_extract(p.score_json,'$.classifierVersion')=gate.classifier_version
  AND ((json_extract(p.score_json,'$.available')=1 AND json_type(p.score_json,'$.rawScore')='integer'
    AND json_extract(p.score_json,'$.value')=CASE json_extract(p.score_json,'$.grade') WHEN 'A' THEN 100 WHEN 'B' THEN 75 WHEN 'C' THEN 50 WHEN 'D' THEN 25 WHEN 'E' THEN 0 END)
   OR (json_extract(p.score_json,'$.available')=0 AND json_extract(p.score_json,'$.status')='unrated'
    AND json_type(p.score_json,'$.value')='null' AND json_type(p.score_json,'$.missingInputs')='array'))),0)=0) AND NOT EXISTS(SELECT 1 FROM catalogue_scoring_run_items i WHERE i.run_id=? AND i.barcode=p.barcode)
), ranked AS (SELECT barcode,stratum,row_number() OVER(PARTITION BY stratum ORDER BY barcode) AS rank FROM candidates),
selected AS MATERIALIZED (
 SELECT barcode,stratum,rank FROM ranked ORDER BY rank,stratum,barcode
 LIMIT max(0,?-(SELECT count(*) FROM catalogue_scoring_run_items WHERE run_id=?))
)
INSERT INTO catalogue_scoring_run_items(run_id,barcode,stratum,cohort,selected_fingerprint,selected_fetched_at,
 before_score_json,before_rating,before_method,before_version,before_classifier,before_calculated_at)
SELECT ?,p.barcode,r.stratum,?,p.source_fingerprint,p.fetched_at,p.score_json,p.rating_value,p.score_method,p.score_version,p.classifier_version,p.calculated_at
FROM selected r JOIN catalogue_products p ON p.barcode=r.barcode
ORDER BY r.rank,r.stratum,r.barcode`;
async function selectCohort(db,run,cohort,count,now) {
 await db.batch([
  db.prepare(selectionSQL).bind(runScope(run)==='uk'?1:0,run.id,run.id,cohort,run.id,run.id,cohort),
  db.prepare("UPDATE catalogue_scoring_runs SET target=?,state='running',updated_at=? WHERE id=? AND target=500").bind(cohort,now,run.id)
 ]);
}
export async function scoringRunStatus(db,runID) {
 const run=await getRun(db,runID,{requireCurrent:false});
 const rows=(await db.prepare(`SELECT stratum,count(*) AS selected,sum(state='pending') AS pending,
 sum(before_rating IS NOT NULL) AS previously_rated,sum(before_rating IS NULL) AS previously_unrated,
 sum(state='scored') AS scored,sum(state='scored' AND before_rating IS NULL) AS newly_rated,
 sum(state='scored' AND before_rating IS NOT NULL) AS previously_rated_still_scored,
 sum(state='insufficient') AS insufficient,sum(state='insufficient' AND before_rating IS NOT NULL) AS previously_rated_now_unrated,
 sum(state='error') AS errors,sum(state='source_changed') AS source_changed,sum(error_code='current_score_reused') AS skipped_current,sum(json_extract(result_json,'$.catalogueEvidenceReplay.reused')=1) AS evidence_reused,sum(json_extract(result_json,'$.catalogueEvidenceReplay.rejected')=1) AS evidence_rejected,
 sum(activation_state='applied') AS activated,sum(activation_state='conflict') AS activation_conflicts,
 sum(activation_state='source_changed') AS activation_source_changed,
 sum(activation_state='rolled_back') AS rolled_back,sum(activation_state='rollback_conflict') AS rollback_conflicts,
 sum(EXISTS(SELECT 1 FROM catalogue_scoring_run_holds h WHERE h.run_id=catalogue_scoring_run_items.run_id AND h.barcode=catalogue_scoring_run_items.barcode)) AS quality_held,
 sum(elapsed_ms) AS scoring_ms FROM catalogue_scoring_run_items WHERE run_id=? GROUP BY stratum ORDER BY stratum`).bind(runID).all()).results||[];
 const totals={selected:0,pending:0,previously_rated:0,previously_unrated:0,scored:0,newly_rated:0,previously_rated_still_scored:0,insufficient:0,previously_rated_now_unrated:0,errors:0,source_changed:0,skipped_current:0,evidence_reused:0,evidence_rejected:0,quality_held:0,activated:0,activation_conflicts:0,activation_source_changed:0,rolled_back:0,rollback_conflicts:0,scoring_ms:0};
 for(const row of rows)for(const key of Object.keys(totals))totals[key]+=Number(row[key]||0);
 const missing=(await db.prepare(`SELECT CAST(j.value AS TEXT) AS reason,count(*) AS products FROM catalogue_scoring_run_items i,json_each(i.missing_json) j WHERE i.run_id=? AND i.state='insufficient' GROUP BY j.value ORDER BY products DESC,reason LIMIT 40`).bind(runID).all()).results||[];
 const transitions=(await db.prepare('SELECT before_rating AS before,result_rating AS after,state,count(*) AS products FROM catalogue_scoring_run_items WHERE run_id=? GROUP BY before_rating,result_rating,state ORDER BY before_rating,result_rating,state').bind(runID).all()).results||[];
 const assumptions=(await db.prepare(`SELECT CAST(j.value AS TEXT) AS assumption,count(*) AS products FROM catalogue_scoring_run_items i,json_each(i.result_json,'$.assumptions') j WHERE i.run_id=? AND i.state='scored' GROUP BY j.value ORDER BY products DESC,assumption LIMIT 40`).bind(runID).all()).results||[];
 // Workerd may freeze its clock within a request. Old runs also clamped
 // every zero-duration batch to 1 ms; do not turn those into throughput.
 const processed=totals.selected-totals.pending,clockMeasured=totals.scoring_ms>0&&run.active_ms>0;
 const activeElapsedMs=clockMeasured?run.active_ms:null,rate=clockMeasured?processed/(activeElapsedMs/1000):null;
 return {runID,method:run.score_method,version:run.score_version,classifierVersion:run.classifier_version,selectionVersion:run.selection_version,scope:runScope(run),state:run.state,target:run.target,pilotReviewed:!!run.pilot_review_json,activationReviewed:!!run.activation_review_json,activationReview:run.activation_review_json?JSON.parse(run.activation_review_json):null,
 createdAt:run.created_at,updatedAt:run.updated_at,counts:totals,strata:rows,missingReasons:missing,scoreTransitions:transitions,assumptions,
 complete:totals.pending===0&&totals.selected===run.target,eligibleShortfall:Math.max(0,run.target-totals.selected),
 metrics:{processed,activeElapsedMs,clockStatus:clockMeasured?'measured':'unmeasurable',productsPerSecond:rate,wallElapsedMs:Math.max(0,run.updated_at-run.created_at),
  rulesProcessed:totals.scored+totals.insufficient-totals.skipped_current,aiCalls:0,aiInputTokens:0,aiOutputTokens:0,estimatedAICostUSD:0,offRequests:0,
  projected10000ActiveMs:rate?Math.round(10000/rate*1000):null,projectionBasis:clockMeasured?'Observed active processing only; excludes pauses and network round-trip time.':'Server clock did not advance during scoring; use the runner’s client timing, including requests and throttle delays.'}};
}
async function scoringCoverage(db,runID,now) {
 // The covering index keeps the large source/score JSON out of this census.
 // Revision counts are not a substitute for the selection/activation guards.
 const rev=revision(),values=[rev.method,rev.version,rev.classifierVersion];
 const rows=(await db.prepare(`SELECT is_uk,(score_method=? AND score_version=? AND classifier_version=?) AS current_revision,
  count(*) AS total,sum(rating_value IS NOT NULL) AS rated
  FROM catalogue_products INDEXED BY catalogue_rating_candidates GROUP BY is_uk,current_revision`).bind(...values).all()).results||[];
 const reviewedRows=(await db.prepare(`SELECT (score_method=? AND score_version=? AND classifier_version=?) AS current_revision,
  count(*) AS total,sum(CASE WHEN json_valid(score_json) THEN json_extract(score_json,'$.available')=1
   AND json_type(score_json,'$.value')='integer' AND json_extract(score_json,'$.value') BETWEEN 0 AND 100 ELSE 0 END) AS rated
  FROM reviewed_products GROUP BY current_revision`).bind(...values).all()).results||[];
 const empty=()=>({total:0,storedRated:0,storedUnrated:0,currentRevision:0,currentRated:0,currentUnrated:0,outdatedRevision:0,outdatedRated:0,outdatedUnrated:0});
 const uk=empty(),nonUK=empty(),reviewed=empty();
 const add=(group,row)=>{
  const total=Number(row.total||0),rated=Number(row.rated||0),unrated=total-rated;
  group.total+=total;group.storedRated+=rated;group.storedUnrated+=unrated;
  if(row.current_revision){group.currentRevision+=total;group.currentRated+=rated;group.currentUnrated+=unrated;}
  else{group.outdatedRevision+=total;group.outdatedRated+=rated;group.outdatedUnrated+=unrated;}
 };
 for(const row of rows)add(row.is_uk?uk:nonUK,row);
 for(const row of reviewedRows)add(reviewed,row);
 const combined=empty();for(const group of [uk,nonUK,reviewed])for(const key of Object.keys(combined))combined[key]+=group[key];
 const overlap=await db.prepare('SELECT count(*) AS n FROM reviewed_products r JOIN catalogue_products p ON p.barcode=r.barcode').first();
 return {runID,...rev,generatedAt:now,coverage:{catalogue:{uk,nonUK},reviewed,combinedRows:combined,
  reviewedBarcodesAlsoInCatalogue:Number(overlap?.n||0),distinctBarcodes:combined.total-Number(overlap?.n||0)},
  eligibility:{ukCatalogueOutdatedRevision:uk.outdatedRevision,nonUKCatalogueOutdatedRevision:nonUK.outdatedRevision,reviewedOutdatedRevision:reviewed.outdatedRevision,
   exactSelectionCount:null,basis:'Stored revision columns only. Each outdated count is a lower bound for its catalogue scope: same-revision results with changed source timestamps or invalid score envelopes may also be selected. UK is the default scope; non-UK requires an explicit separate cohort. Reviewed products are outside this scoring-run selector.'},
  ratingBasis:'Stored rating availability on the stated revision; not a fresh source/score validation. Combined rows count reviewed and catalogue records separately; distinctBarcodes removes their overlap.'};
}
async function claim(db,run,now) {
 const token=crypto.randomUUID();
 const claimed=await db.prepare('UPDATE catalogue_scoring_runs SET lease_token=?,lease_until=? WHERE id=? AND (lease_until IS NULL OR lease_until<=?) RETURNING id').bind(token,now+120000,run.id,now).all();
 if(!claimed.results?.length)fail('A scoring batch is already running. Retry after the current lease.',409,'catalogue_scoring_run_busy');
 return token;
}
async function step(db,run,limit,now) {
 if(run.state==='paused')return scoringRunStatus(db,run.id);
 if(run.state!=='running')return scoringRunStatus(db,run.id);
 const token=await claim(db,run,now),started=performance.now(),market=runScope(run)==='uk'?1:0;
 try {
  const rows=(await db.prepare(`SELECT i.*,p.provider_json,p.source_fingerprint,p.fetched_at,p.is_uk,p.score_json AS live_score_json,p.score_method AS live_method,p.score_version AS live_version,p.classifier_version AS live_classifier,p.calculated_at AS live_calculated_at,ce.classification_json AS classification_evidence,ee.evidence_json AS enrichment_evidence
   FROM catalogue_scoring_run_items i LEFT JOIN catalogue_products p ON p.barcode=i.barcode
   LEFT JOIN catalogue_score_evidence ce ON ce.barcode=p.barcode AND ce.source_fingerprint=p.source_fingerprint AND ce.evidence_version='public-classification-evidence-v1' AND p.expires_at>? AND ce.calculated_at<=?
   LEFT JOIN catalogue_enrichment_scores ee ON ee.barcode=p.barcode AND ee.source_fingerprint=p.source_fingerprint AND ee.evidence_version='catalogue-enrichment-v1' AND ee.expires_at>? AND p.expires_at>? AND ee.calculated_at<=?
   WHERE i.run_id=? AND i.state='pending' ORDER BY i.cohort,i.stratum,i.barcode LIMIT ?`).bind(now,now,now,now,now,run.id,limit).all()).results||[];
  const statements=[];
  for(const row of rows){
   const began=performance.now();let state='source_changed',result=null,missing=[],error=null,heldCandidate=null,qualityHold=null;
   if(row.source_fingerprint===row.selected_fingerprint&&row.fetched_at===row.selected_fetched_at&&row.is_uk===market){
    try {
     const raw=JSON.parse(row.provider_json),product=catalogueRecordFromPayload({product:raw},row.barcode,row.fetched_at).product;
     let current=null;try{current=JSON.parse(row.live_score_json);}catch{}
     const currentRevision=row.live_method===run.score_method&&row.live_version===run.score_version&&row.live_classifier===run.classifier_version&&row.live_calculated_at>=row.fetched_at;
     const currentRated=currentRevision&&current?.classifierVersion===run.classifier_version&&ScoreCore.Directional.validResult(current)&&current.inputFingerprint===ScoreCore.Directional.inputFingerprint(product);
     if(currentRated){result=current;error='current_score_reused';}else result=replayDirectionalCatalogueEvidence(raw,product,{classificationJSON:row.classification_evidence,enrichmentJSON:row.enrichment_evidence},row.fetched_at);
     if(result?.available===true&&(!Number.isInteger(result.value)||result.value<0||result.value>100))throw new Error('invalid_score');
     qualityHold=await getActiveCatalogueQualityHold(db,row.barcode,row.source_fingerprint);
     if(qualityHold){heldCandidate=result;result=withheldCatalogueScore(result,qualityHold);}
     state=result?.available===true?'scored':'insufficient';
     missing=Array.isArray(result?.missingInputs)?result.missingInputs.slice(0,30):[result?.reason||'Insufficient nutrition evidence'];
    }catch{state='error';error='retained_product_scoring_failed';}
   }
   // The source or market may change after hydration. Check again inside the
   // same transaction before storing the calculation for this fixed cohort.
   statements.push(db.prepare(`UPDATE catalogue_scoring_run_items SET state='source_changed',result_json=NULL,result_rating=NULL,missing_json='[]',error_code=NULL,evaluated_at=?,elapsed_ms=?
    WHERE run_id=? AND barcode=? AND state='pending' AND EXISTS(SELECT 1 FROM catalogue_scoring_runs WHERE id=? AND lease_token=?)
    AND NOT EXISTS(SELECT 1 FROM catalogue_products WHERE barcode=? AND source_fingerprint=? AND fetched_at=? AND is_uk=?)`).bind(now,performance.now()-began,run.id,row.barcode,run.id,token,row.barcode,row.selected_fingerprint,row.selected_fetched_at,market));
   statements.push(db.prepare(`UPDATE catalogue_scoring_run_items SET state=?,result_json=?,result_rating=?,missing_json=?,error_code=?,evaluated_at=?,elapsed_ms=?
    WHERE run_id=? AND barcode=? AND state='pending' AND EXISTS(SELECT 1 FROM catalogue_scoring_runs WHERE id=? AND lease_token=?)`).bind(state,result?JSON.stringify(result):null,state==='scored'?result.value:null,JSON.stringify(missing),error,now,performance.now()-began,run.id,row.barcode,run.id,token));
   if(qualityHold&&heldCandidate)statements.push(db.prepare(`INSERT INTO catalogue_scoring_run_holds(run_id,barcode,source_fingerprint,source_fetched_at,candidate_json,hold_json)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM catalogue_scoring_run_items i JOIN catalogue_scoring_runs r ON r.id=i.run_id
     WHERE i.run_id=? AND i.barcode=? AND i.state='insufficient' AND i.result_json=? AND r.lease_token=?)
    ON CONFLICT(run_id,barcode) DO NOTHING`).bind(run.id,row.barcode,row.selected_fingerprint,row.selected_fetched_at,JSON.stringify(heldCandidate),JSON.stringify(qualityHold),run.id,row.barcode,JSON.stringify(result),token));
  }
  statements.push(db.prepare(`UPDATE catalogue_scoring_runs SET active_ms=active_ms+?,updated_at=?,lease_token=NULL,lease_until=NULL,
   state=CASE WHEN state='paused' THEN 'paused' WHEN NOT EXISTS(SELECT 1 FROM catalogue_scoring_run_items WHERE run_id=? AND state='pending') THEN 'review' ELSE state END WHERE id=? AND lease_token=?`).bind(Math.max(0,Math.round(performance.now()-started)),now,run.id,run.id,token));
  await db.batch(statements);
 }catch(error){await db.prepare('UPDATE catalogue_scoring_runs SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').bind(run.id,token).run();throw error;}
 return scoringRunStatus(db,run.id);
}
async function records(db,run,body) {
 const after=body.after||'',limit=body.limit||50;
 if(typeof after!=='string'||after&&!/^[0-9]{4,18}$/.test(after)||!Number.isInteger(limit)||limit<1||limit>100)fail('Invalid results page.');
 const rows=(await db.prepare(`SELECT i.*,p.name,p.brand,p.provider_json,p.source_fingerprint,p.fetched_at,p.is_uk,h.candidate_json,h.hold_json FROM catalogue_scoring_run_items i LEFT JOIN catalogue_products p ON p.barcode=i.barcode
  LEFT JOIN catalogue_scoring_run_holds h ON h.run_id=i.run_id AND h.barcode=i.barcode WHERE i.run_id=? AND i.barcode>? ORDER BY i.barcode LIMIT ?`).bind(run.id,after,limit+1).all()).results||[];
 return {runID:run.id,method:run.score_method,version:run.score_version,classifierVersion:run.classifier_version,scope:runScope(run),selectionVersion:run.selection_version,records:await Promise.all(rows.slice(0,limit).map(async row=>{
  let nutrition=null,source=null;
  try{if(row.source_fingerprint===row.selected_fingerprint&&row.fetched_at===row.selected_fetched_at&&row.is_uk===(runScope(run)==='uk'?1:0)){
   const raw=JSON.parse(row.provider_json);
   if(body.includeSource)source={raw,sourceFingerprint:row.source_fingerprint,sourceFetchedAt:row.fetched_at};
   nutrition=catalogueRecordFromPayload({product:raw},row.barcode,row.selected_fetched_at).product.nutrients;
  }}catch{}
  const {qualityHold,computedCandidate}=await validateRunHold(row,run);
  const held=qualityHold?{computedCandidate,qualityHold,holdApplication:{runID:run.id,sourceFetchedAt:row.selected_fetched_at,candidateSHA256:await qualityHoldCandidateSHA256(computedCandidate)}}:{};
  return {barcode:row.barcode,name:row.name||null,brand:row.brand||null,stratum:row.stratum,cohort:row.cohort,state:row.state,sourceFingerprint:row.selected_fingerprint,sourceFetchedAt:row.selected_fetched_at,...held,
   before:{rating:row.before_rating,method:row.before_method,version:row.before_version,score:JSON.parse(row.before_score_json)},
   after:row.result_json?JSON.parse(row.result_json):null,nutrition,...(body.includeSource?{source}:{}),missing:JSON.parse(row.missing_json),errorCode:row.state==='error'?row.error_code:null,scoringAction:row.error_code==='current_score_reused'?'reused_current':'calculated',elapsedMs:row.elapsed_ms,activationState:row.activation_state};
 })),hasMore:rows.length>limit,nextAfter:rows.length>limit?rows[limit-1].barcode:null};
}
async function validateRunHold(row,run) {
 let candidate=null,hold=null,result=null;
 try{candidate=row.candidate_json?JSON.parse(row.candidate_json):null;hold=row.hold_json?parseCatalogueQualityHold(row.hold_json):null;result=row.result_json?JSON.parse(row.result_json):null;}catch{}
 if(!row.hold_json&&!row.candidate_json&&!result?.catalogueQualityHold)return {qualityHold:null,computedCandidate:null};
 if(!qualityHoldMatches(hold,{barcode:row.barcode,sourceFingerprint:row.selected_fingerprint})||!object(candidate)
   ||candidate.methodId!==run.score_method||candidate.version!==run.score_version||candidate.classifierVersion!==run.classifier_version
   ||row.state!=='insufficient'||row.result_rating!==null||stableStringify(result)!==stableStringify(withheldCatalogueScore(candidate,hold)))
  fail('Stored quality review is invalid.',500,'catalogue_quality_hold_invalid');
 // An inherited hold retains the original review hash. The current run's
 // independently replayable candidate is bound separately in holdApplication.
 if(hold.runID===run.id&&await qualityHoldCandidateSHA256(candidate)!==hold.candidateSHA256)
  fail('Stored quality candidate does not match its review.',500,'catalogue_quality_hold_invalid');
 if(hold.runID===run.id&&(hold.revision.method!==run.score_method||hold.revision.version!==run.score_version||hold.revision.classifierVersion!==run.classifier_version))
  fail('Stored quality revision does not match its review.',500,'catalogue_quality_hold_invalid');
 return {qualityHold:hold,computedCandidate:candidate};
}
async function recordQualityHolds(db,run,body,now) {
 if(!allowed(body,['runID','reviewID','reviewNote','items'])||!id(body.reviewID)||typeof body.reviewNote!=='string'||!body.reviewNote.trim()||body.reviewNote.length>2000
   ||!Array.isArray(body.items)||body.items.length<1||body.items.length>50)fail('Provide a review ID, note and 1 to 50 source-bound quality holds.');
 const seen=new Set();
 for(const item of body.items){
  if(!allowed(item,['barcode','sourceFingerprint','sourceFetchedAt','reasonCode','evidenceNote'])||!/^\d{4,18}$/.test(item.barcode||'')
    ||!/^([a-f0-9]{64})$/.test(item.sourceFingerprint||'')||!Number.isSafeInteger(item.sourceFetchedAt)||item.sourceFetchedAt<=0||item.sourceFetchedAt>now
    ||!QUALITY_HOLD_REASONS.includes(item.reasonCode)||typeof item.evidenceNote!=='string'||!item.evidenceNote.trim()||item.evidenceNote.length>2000||seen.has(item.barcode))fail('Invalid or duplicate source-bound quality hold.');
  seen.add(item.barcode);
 }
 const rows=(await db.prepare(`SELECT i.*,p.source_fingerprint,p.fetched_at,p.provider_json,p.is_uk,h.candidate_json,h.hold_json FROM catalogue_scoring_run_items i
  LEFT JOIN catalogue_products p ON p.barcode=i.barcode LEFT JOIN catalogue_scoring_run_holds h ON h.run_id=i.run_id AND h.barcode=i.barcode
  WHERE i.run_id=? AND i.barcode IN(SELECT value FROM json_each(?))`).bind(run.id,JSON.stringify([...seen])).all()).results||[];
 if(rows.length!==seen.size)fail('Every held product must belong to this run.',409,'catalogue_quality_hold_source_changed');
 const selected=new Map(rows.map(row=>[row.barcode,row])),pending=[];
 for(const item of body.items){
  const row=selected.get(item.barcode);
  if(row.source_fingerprint!==item.sourceFingerprint||row.selected_fingerprint!==item.sourceFingerprint||row.fetched_at!==item.sourceFetchedAt||row.selected_fetched_at!==item.sourceFetchedAt
    ||row.is_uk!==(runScope(run)==='uk'?1:0)||!['scored','insufficient'].includes(row.state)||!row.result_json)
    fail('A selected source changed or has not finished scoring.',409,'catalogue_quality_hold_source_changed');
  let raw;try{raw=JSON.parse(row.provider_json);}catch{}
  if(!raw||await qualityHoldCandidateSHA256(raw)!==item.sourceFingerprint)fail('The retained raw source does not match its fingerprint.',409,'catalogue_quality_hold_source_changed');
  if(row.hold_json){
   const prior=parseCatalogueQualityHold(row.hold_json);
   if(!qualityHoldMatches(prior,{barcode:row.barcode,sourceFingerprint:row.selected_fingerprint})||prior.reviewID!==body.reviewID||prior.reviewNote!==body.reviewNote||prior.reasonCode!==item.reasonCode||prior.evidenceNote!==item.evidenceNote)
    fail('This product already has a different quality review.',409,'catalogue_quality_hold_conflict');
   await validateRunHold(row,run);
   continue;
  }
  if(run.state!=='review'||row.activation_state!=='pending')fail('New quality holds require a completed, unactivated review cohort.',409,'catalogue_quality_hold_review_closed');
  const candidate=JSON.parse(row.result_json);
  if(candidate.methodId!==run.score_method||candidate.version!==run.score_version||candidate.classifierVersion!==run.classifier_version)
   fail('The candidate revision does not match this run.',409,'catalogue_quality_hold_revision_changed');
  const hold={version:QUALITY_HOLD_VERSION,runID:run.id,barcode:item.barcode,sourceFingerprint:item.sourceFingerprint,sourceFetchedAt:item.sourceFetchedAt,
   reasonCode:item.reasonCode,reviewID:body.reviewID,reviewNote:body.reviewNote,evidenceNote:item.evidenceNote,reviewedAt:now,
   revision:{method:run.score_method,version:run.score_version,classifierVersion:run.classifier_version},candidateSHA256:await qualityHoldCandidateSHA256(candidate)};
  pending.push({row,hold,score:withheldCatalogueScore(candidate,hold)});
 }
 if(!pending.length)return scoringRunStatus(db,run.id);
 const token=await claim(db,run,now),statements=[];
 try{
  for(const {row,hold,score} of pending){
   const guard=token+':'+row.barcode;
   statements.push(db.prepare(`INSERT INTO catalogue_quality_hold_guards(token,valid) SELECT ?,CASE WHEN EXISTS(
    SELECT 1 FROM catalogue_scoring_run_items i JOIN catalogue_scoring_runs r ON r.id=i.run_id JOIN catalogue_products p ON p.barcode=i.barcode
    WHERE i.run_id=? AND i.barcode=? AND i.result_json=? AND i.activation_state='pending' AND r.state='review' AND r.lease_token=?
     AND p.source_fingerprint=? AND p.fetched_at=? AND p.provider_json=? AND p.is_uk=?
     AND NOT EXISTS(SELECT 1 FROM catalogue_scoring_run_holds h WHERE h.run_id=i.run_id AND h.barcode=i.barcode)) THEN 1 ELSE 0 END`)
    .bind(guard,run.id,row.barcode,row.result_json,token,row.selected_fingerprint,row.selected_fetched_at,row.provider_json,runScope(run)==='uk'?1:0));
   statements.push(db.prepare('INSERT INTO catalogue_scoring_run_holds(run_id,barcode,source_fingerprint,source_fetched_at,candidate_json,hold_json) VALUES(?,?,?,?,?,?)')
    .bind(run.id,row.barcode,row.selected_fingerprint,row.selected_fetched_at,row.result_json,JSON.stringify(hold)));
   statements.push(db.prepare("UPDATE catalogue_scoring_run_items SET state='insufficient',result_json=?,result_rating=NULL,missing_json=? WHERE run_id=? AND barcode=?")
    .bind(JSON.stringify(score),JSON.stringify(score.missingInputs),run.id,row.barcode));
   statements.push(db.prepare('DELETE FROM catalogue_quality_hold_guards WHERE token=?').bind(guard));
  }
  statements.push(db.prepare('UPDATE catalogue_scoring_runs SET updated_at=?,activation_review_json=NULL,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').bind(now,run.id,token));
  await db.batch(statements);
 }catch(error){await db.prepare('UPDATE catalogue_scoring_runs SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').bind(run.id,token).run();
  if(/CHECK constraint failed/i.test(error.message||''))fail('The selected source or review changed before the hold was saved.',409,'catalogue_quality_hold_source_changed');throw error;}
 return scoringRunStatus(db,run.id);
}
async function activate(db,run,body,now,activeRevision) {
 if(activeRevision.method!==run.score_method||activeRevision.version!==run.score_version||activeRevision.classifierVersion!==run.classifier_version)fail('Enable the reviewed score revision before publishing its catalogue results.',409,'catalogue_scoring_revision_not_active');
 if(body.reviewPassed!==true||typeof body.reviewNote!=='string'||!body.reviewNote.trim()||body.reviewNote.length>2000)fail('A recorded quality review is required before activation.');
 if(!['review','activating','activated'].includes(run.state))fail('Complete the current cohort before activation.',409);
 const status=await scoringRunStatus(db,run.id);
 if(status.counts.pending||status.counts.errors||!status.counts.selected)fail('Resolve incomplete work, errors or an empty cohort before activation.',409);
 if(body.expectedSelected!=null&&body.expectedSelected!==status.counts.selected)fail('The reviewed product count does not match the selected cohort.',409,'catalogue_scoring_review_count_changed');
 if(status.eligibleShortfall&&body.expectedSelected==null)fail('Review the smaller cohort and supply its exact expectedSelected count before activation.',409,'catalogue_scoring_partial_review_required');
 const review={note:body.reviewNote,passed:true,at:now,selected:status.counts.selected,target:run.target,shortfall:status.eligibleShortfall,partialCohort:status.eligibleShortfall>0,scope:runScope(run),selectionVersion:run.selection_version};
 const token=await claim(db,run,now),market=runScope(run)==='uk'?1:0;
 try {
  const rows=(await db.prepare(`SELECT i.*,p.source_fingerprint,p.fetched_at,p.is_uk,p.score_json AS live_score_json,p.score_method AS live_method,p.score_version AS live_version,p.classifier_version AS live_classifier,h.candidate_json,h.hold_json FROM catalogue_scoring_run_items i LEFT JOIN catalogue_products p ON p.barcode=i.barcode
   LEFT JOIN catalogue_scoring_run_holds h ON h.run_id=i.run_id AND h.barcode=i.barcode WHERE i.run_id=? AND i.activation_state='pending' ORDER BY i.barcode LIMIT ?`).bind(run.id,body.limit||100).all()).results||[];
  const statements=[];
  for(const row of rows){
   const {qualityHold}=await validateRunHold(row,run),holdJSON=qualityHold?JSON.stringify(qualityHold):'';
   const sourceOK=row.source_fingerprint===row.selected_fingerprint&&row.fetched_at===row.selected_fetched_at&&row.is_uk===market;
   const beforeOK=row.live_score_json===row.before_score_json&&row.live_method===row.before_method&&row.live_version===row.before_version&&row.live_classifier===row.before_classifier;
   const state=!sourceOK||row.state==='source_changed'?'source_changed':!row.result_json||!beforeOK?'conflict':'applied';
   if(state==='applied'){
    statements.push(db.prepare(`UPDATE catalogue_products SET score_json=?,rating_value=?,score_method=?,score_version=?,classifier_version=?,calculated_at=? WHERE barcode=? AND source_fingerprint=? AND fetched_at=? AND score_json=? AND is_uk=?
     AND EXISTS(SELECT 1 FROM catalogue_scoring_runs WHERE id=? AND lease_token=?)
     AND NOT EXISTS(SELECT 1 FROM catalogue_quality_holds h WHERE h.barcode=catalogue_products.barcode AND h.source_fingerprint=catalogue_products.source_fingerprint AND h.hold_json<>?)`)
     .bind(row.result_json,row.result_rating,run.score_method,run.score_version,run.classifier_version,now,row.barcode,row.selected_fingerprint,row.selected_fetched_at,row.before_score_json,market,run.id,token,holdJSON));
    if(qualityHold)statements.push(db.prepare(`INSERT INTO catalogue_quality_holds(barcode,source_fingerprint,run_id,hold_json,score_json,activated_at)
     SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM catalogue_products p JOIN catalogue_scoring_runs r ON r.id=?
      WHERE p.barcode=? AND p.source_fingerprint=? AND p.fetched_at=? AND p.is_uk=? AND p.score_json=? AND r.lease_token=?)
     ON CONFLICT(barcode,source_fingerprint) DO NOTHING`).bind(row.barcode,row.selected_fingerprint,qualityHold.runID,holdJSON,row.result_json,now,run.id,row.barcode,row.selected_fingerprint,row.selected_fetched_at,market,row.result_json,token));
    statements.push(applyActiveQualityHoldStatement(db,{barcode:row.barcode,sourceFingerprint:row.selected_fingerprint,fetchedAt:row.selected_fetched_at}));
   }
   if(state==='applied')statements.push(db.prepare(`UPDATE catalogue_scoring_run_items SET activation_state=CASE
    WHEN EXISTS(SELECT 1 FROM catalogue_products WHERE barcode=? AND source_fingerprint=? AND fetched_at=? AND score_json=? AND score_method=? AND score_version=? AND classifier_version=? AND is_uk=?)
     AND NOT EXISTS(SELECT 1 FROM catalogue_quality_holds h WHERE h.barcode=? AND h.source_fingerprint=? AND h.hold_json<>?) THEN 'applied'
    WHEN EXISTS(SELECT 1 FROM catalogue_products WHERE barcode=? AND source_fingerprint=? AND fetched_at=? AND is_uk=?) THEN 'conflict' ELSE 'source_changed' END
    WHERE run_id=? AND barcode=? AND activation_state='pending'`).bind(row.barcode,row.selected_fingerprint,row.selected_fetched_at,row.result_json,run.score_method,run.score_version,run.classifier_version,market,row.barcode,row.selected_fingerprint,holdJSON,row.barcode,row.selected_fingerprint,row.selected_fetched_at,market,run.id,row.barcode));
   else statements.push(db.prepare(`UPDATE catalogue_scoring_run_items SET activation_state=? WHERE run_id=? AND barcode=? AND activation_state='pending'`).bind(state,run.id,row.barcode));
  }
  statements.push(db.prepare(`UPDATE catalogue_scoring_runs SET state=CASE WHEN EXISTS(SELECT 1 FROM catalogue_scoring_run_items WHERE run_id=? AND activation_state='pending') THEN 'activating' ELSE 'activated' END,updated_at=?,activation_review_json=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?`).bind(run.id,now,JSON.stringify(review),run.id,token));
  await db.batch(statements);
 }catch(error){await db.prepare('UPDATE catalogue_scoring_runs SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').bind(run.id,token).run();throw error;}
 return scoringRunStatus(db,run.id);
}
async function rollback(db,run,body,now) {
 if(!['activating','activated','rolling_back','rolled_back'].includes(run.state))fail('This run has not been activated.',409);
 const token=await claim(db,run,now),market=runScope(run)==='uk'?1:0;
 try {
  const rows=(await db.prepare(`SELECT i.*,p.source_fingerprint,p.fetched_at,p.is_uk,p.score_json AS live_score_json FROM catalogue_scoring_run_items i LEFT JOIN catalogue_products p ON p.barcode=i.barcode WHERE i.run_id=? AND i.activation_state='applied' ORDER BY i.barcode LIMIT ?`).bind(run.id,body.limit||100).all()).results||[];
  const statements=[];
  for(const row of rows){
   const matches=row.source_fingerprint===row.selected_fingerprint&&row.fetched_at===row.selected_fetched_at&&row.live_score_json===row.result_json&&row.is_uk===market;
   if(matches){
    statements.push(db.prepare(`UPDATE catalogue_products SET score_json=?,rating_value=?,score_method=?,score_version=?,classifier_version=?,calculated_at=? WHERE barcode=? AND source_fingerprint=? AND fetched_at=? AND score_json=? AND is_uk=?
     AND NOT EXISTS(SELECT 1 FROM catalogue_quality_holds h WHERE h.barcode=catalogue_products.barcode AND h.source_fingerprint=catalogue_products.source_fingerprint)`)
     .bind(row.before_score_json,row.before_rating,row.before_method,row.before_version,row.before_classifier,row.before_calculated_at,row.barcode,row.selected_fingerprint,row.selected_fetched_at,row.result_json,market));
    statements.push(db.prepare(`UPDATE catalogue_scoring_run_items SET activation_state=CASE WHEN EXISTS(
     SELECT 1 FROM catalogue_products WHERE barcode=? AND source_fingerprint=? AND fetched_at=? AND is_uk=? AND score_json=? AND score_method=? AND score_version=? AND classifier_version=? AND calculated_at=?) THEN 'rolled_back' ELSE 'rollback_conflict' END
     WHERE run_id=? AND barcode=? AND activation_state='applied'`).bind(row.barcode,row.selected_fingerprint,row.selected_fetched_at,market,row.before_score_json,row.before_method,row.before_version,row.before_classifier,row.before_calculated_at,run.id,row.barcode));
   }else statements.push(db.prepare("UPDATE catalogue_scoring_run_items SET activation_state='rollback_conflict' WHERE run_id=? AND barcode=? AND activation_state='applied'").bind(run.id,row.barcode));
  }
  statements.push(db.prepare(`UPDATE catalogue_scoring_runs SET state=CASE WHEN EXISTS(SELECT 1 FROM catalogue_scoring_run_items WHERE run_id=? AND activation_state='applied') THEN 'rolling_back' ELSE 'rolled_back' END,updated_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?`).bind(run.id,now,run.id,token));
  await db.batch(statements);
 }catch(error){await db.prepare('UPDATE catalogue_scoring_runs SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').bind(run.id,token).run();throw error;}
 return scoringRunStatus(db,run.id);
}
export async function handleCatalogueScoringRun(db,action,body,{now=Date.now(),activeRevision={method:ScoreCore.SCORE_METHOD,version:ScoreCore.SCORE_VERSION,classifierVersion:ScoreCore.CLASSIFIER_VERSION}}={}) {
 if(action==='quality-hold'){
  if(!object(body)||!id(body.runID))fail('A stable scoring run ID is required.');
  return recordQualityHolds(db,await getRun(db,body.runID),body,now);
 }
 if(!allowed(body,['runID','limit','after','reviewPassed','reviewNote','expectedSelected','includeSource','scope'])||!id(body.runID))fail('A stable scoring run ID is required.');
 if(body.scope!==undefined&&(action!=='create'||!['uk','non-uk'].includes(body.scope)))fail('scope is a create-only option: uk or non-uk.');
 if(body.limit!=null&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>100))fail('A scoring step processes at most 100 products.');
 if(body.expectedSelected!==undefined&&(action!=='activate'||!Number.isInteger(body.expectedSelected)||body.expectedSelected<1||body.expectedSelected>10000))fail('expectedSelected is an activation review count between 1 and 10000.');
 if(body.includeSource!==undefined&&(action!=='records'||typeof body.includeSource!=='boolean'))fail('includeSource is a boolean records export option.');
 if(action==='coverage'){
  if(!allowed(body,['runID']))fail('Coverage accepts only a report run ID.');
  return scoringCoverage(db,body.runID,now);
 }
 if(action==='create'){
  const rev=revision(),scope=body.scope??'uk';
  const created=await db.prepare("INSERT INTO catalogue_scoring_runs(id,score_method,score_version,classifier_version,state,target,created_at,updated_at,selection_version) VALUES (?,?,?,?,'running',500,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id").bind(body.runID,rev.method,rev.version,rev.classifierVersion,now,now,selectionVersion(scope)).all();
  const run=await getRun(db,body.runID);
  if(runScope(run)!==scope)fail('This run ID already belongs to a different scope. Use its original scope or a new run ID.',409,'catalogue_scoring_scope_changed');
  // Recover an interruption between job creation and cohort selection.
  const count=await db.prepare('SELECT count(*) AS n FROM catalogue_scoring_run_items WHERE run_id=?').bind(run.id).first();
  if(created.results?.length||count.n===0)await selectCohort(db,run,500,500,now);
  return scoringRunStatus(db,run.id);
 }
 const run=await getRun(db,body.runID,{requireCurrent:!['status','records'].includes(action)});
 if(action==='status')return scoringRunStatus(db,run.id);
 if(action==='records')return records(db,run,body);
 if(action==='step')return step(db,run,body.limit||100,now);
 if(action==='extend'){
  if(run.target===10000)return scoringRunStatus(db,run.id);
  if(body.reviewPassed!==true||typeof body.reviewNote!=='string'||!body.reviewNote.trim()||body.reviewNote.length>2000)fail('A recorded 500-product quality review is required before extending the run.');
  const status=await scoringRunStatus(db,run.id);
  if(run.state!=='review'||!status.complete||status.counts.errors)fail('Complete and review the 500-product pilot first.',409);
  await db.prepare('UPDATE catalogue_scoring_runs SET pilot_review_json=? WHERE id=?').bind(JSON.stringify({note:body.reviewNote,passed:true,at:now}),run.id).run();
  await selectCohort(db,run,10000,9500,now);return scoringRunStatus(db,run.id);
 }
 if(action==='pause'||action==='resume'){
  if(!['running','paused','review'].includes(run.state))fail('Cannot change processing state after activation.',409);
  if(action==='pause')await db.prepare("UPDATE catalogue_scoring_runs SET state='paused',updated_at=? WHERE id=?").bind(now,run.id).run();
  else await db.prepare("UPDATE catalogue_scoring_runs SET state=CASE WHEN EXISTS(SELECT 1 FROM catalogue_scoring_run_items WHERE run_id=? AND state='pending') THEN 'running' ELSE 'review' END,updated_at=? WHERE id=?").bind(run.id,now,run.id).run();
  return scoringRunStatus(db,run.id);
 }
 if(action==='activate')return activate(db,run,body,now,activeRevision);
 if(action==='rollback')return rollback(db,run,body,now);
 fail('Unknown scoring run action.',404);
}
