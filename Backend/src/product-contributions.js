import { ambassadorPublicationStatements, ambassadorRemovalStatements, purgeAmbassadorModeration } from './ambassadors.js';
import { validCatalogueBarcode } from './food-catalogue.js';
import { getCatalogueOutcome } from './catalogue-service.js';
import { stableStringify } from './product-score.js';
import { contributionAnalysis } from './product-contribution-analysis.js';
import { reviewedProductRow, reviewedCatalogueBatch } from './reviewed-catalogue.js';

export const CONTRIBUTION_VERSION='product-contribution-v1';
export const CONTRIBUTION_MAX_BYTES=3_010_000;
const TTL=30*86400000,LEASE=120000,MAX_ATTEMPTS=3;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ROLES=['front','ingredients','nutrition'];
const CORRECTION_FIELDS=['identity','nutrition','ingredients','allergens','category'];
const STORES=['tesco','sainsburys','asda','morrisons','aldi','lidl','waitrose','marksAndSpencer','coOp','ocado','iceland'];
const COUNTRY_TAGS={GB:'en:united-kingdom',FR:'en:france',US:'en:united-states',IE:'en:ireland',DE:'en:germany',ES:'en:spain',IT:'en:italy',NL:'en:netherlands',BE:'en:belgium',PT:'en:portugal',AU:'en:australia',NZ:'en:new-zealand',CA:'en:canada'};
// A mismatch describes source metadata, never exclusive retail availability.
export function contributionSourceLookup(outcome,marketCountry){
 if(outcome?.status!=='found')return outcome?.status==='not_found'?'not_found':'unavailable';
 const expected=COUNTRY_TAGS[marketCountry],tags=outcome.record?.product?.countriesTags;
 return expected&&Array.isArray(tags)&&tags.some(tag=>typeof tag==='string'&&/^en:/.test(tag))&&!tags.includes(expected)?'found_other_market':'found';
}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key));
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value)),v=>v.toString(16).padStart(2,'0')).join('');
export class ContributionError extends Error {
 constructor(message='Invalid product contribution.',status=400,code='contribution_invalid'){super(message);this.status=status;this.code=code;}
}
function ownerID(owner){if(owner!=='private-owner'&&!/^[a-f0-9]{64}$/.test(owner||''))throw new ContributionError('Authentication required.',401,'authentication_required');return owner;}
function contributionID(id){if(typeof id!=='string'||!UUID.test(id)||/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id))throw new ContributionError();return id.toLowerCase();}
function correctionProposal(value){
 if(value===undefined)return null;
 if(!keys(value,['fields','note'])||!Array.isArray(value.fields)||value.fields.length>5||value.fields.some(field=>!CORRECTION_FIELDS.includes(field))||new Set(value.fields).size!==value.fields.length
 ||typeof value.note!=='string'||[...value.note].length>600||new TextEncoder().encode(value.note).length>1200||/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/.test(value.note))throw new ContributionError('Choose product details and keep the correction note to 600 characters.',400,'contribution_correction_invalid');
 const note=value.note.trim();if(!value.fields.length&&!note)throw new ContributionError('Choose what needs correcting or describe the product fact.');
 return {fields:[...value.fields].sort(),note,source:'user_proposed'};
}
function jpegBytes(photo){
 if(!keys(photo,['role','mimeType','imageBase64'])||!ROLES.includes(photo.role)||photo.mimeType!=='image/jpeg'||typeof photo.imageBase64!=='string')throw new ContributionError();
 const encoded=photo.imageBase64;
 if(!encoded.length||encoded.length>1000000||encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new ContributionError('Use JPEG photos no larger than 750 KB.',413,'contribution_photo_too_large');
 let raw;try{raw=atob(encoded);}catch{throw new ContributionError();}
 if(btoa(raw)!==encoded||raw.length<20||raw.length>750000)throw new ContributionError();
 const at=i=>raw.charCodeAt(i);
 if(at(0)!==255||at(1)!==216||at(raw.length-2)!==255||at(raw.length-1)!==217)throw new ContributionError('A JPEG packaging photo is required.');
 let offset=2,dimensions=false,scan=false;
 while(offset<raw.length-2){
  if(at(offset++)!==255)throw new ContributionError();while(at(offset)===255)offset++;
  const marker=at(offset++);if([0,216,217].includes(marker)||marker>=208&&marker<=215)throw new ContributionError();
  const length=at(offset)*256+at(offset+1);if(length<2||offset+length>raw.length-2)throw new ContributionError();
  if([192,193,194].includes(marker)){const height=at(offset+3)*256+at(offset+4),width=at(offset+5)*256+at(offset+6);if(length<8||!height||!width||height>2400||width>2400)throw new ContributionError('Resize photos to at most 2400 pixels per side.');dimensions=true;}
  if(marker===218){scan=offset+length<raw.length-2;break;}offset+=length;
 }
 if(!dimensions||!scan)throw new ContributionError('A readable JPEG packaging photo is required.');
 return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function purgeExpired(db,now){
 await purgeAmbassadorModeration(db,now);
 await db.batch([db.prepare('DELETE FROM product_contribution_details WHERE contribution_id IN(SELECT id FROM product_contributions WHERE expires_at<=?)').bind(now),db.prepare('DELETE FROM product_contribution_photos WHERE contribution_id IN(SELECT id FROM product_contributions WHERE expires_at<=?)').bind(now),db.prepare('DELETE FROM product_contributions WHERE expires_at<=?').bind(now)]);
}
async function statusView(db,row,now){
 const details=await db.prepare('SELECT correction_json,points_awarded FROM product_contribution_details WHERE contribution_id=?').bind(row.id).first();
 const candidate=row.candidate_json?JSON.parse(row.candidate_json):null;
 const messages={queued:'Saved privately and queued for analysis.',processing:'Reading the packaging photos.',pending_review:'Packaging details are awaiting Nudge review.',needs_photos:'More readable packaging photos are needed.',retryable_error:row.attempts>=MAX_ATTEMPTS?'Analysis could not finish. You can submit clearer photos.':'Analysis is temporarily unavailable. Your photos are saved for retry.',published:'Reviewed product facts are available for future scans.',rejected:'This submission could not be added to the shared catalogue.'};
 return {id:row.id,barcode:row.barcode,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,expiresAt:row.expires_at,attempts:row.attempts,nextRetryAt:row.next_retry_at,
  missingPhotoRoles:candidate?.missingPhotoRoles?.filter(role=>ROLES.includes(role))||[],sourceLookup:row.source_lookup,message:messages[row.status]||'Submission saved.',
  canRetry:row.status==='retryable_error'&&row.attempts<MAX_ATTEMPTS&&(row.next_retry_at||0)<=now,canDelete:row.status!=='published',
  ...(details?.correction_json?{correction:JSON.parse(details.correction_json)}:{}),...(row.status==='published'&&[0,1].includes(details?.points_awarded)?{pointsAwarded:details.points_awarded}:{})};
}
async function rowFor(db,id,owner,admin=false){
 const row=await db.prepare(admin?"SELECT * FROM product_contributions WHERE id=? AND status!='deleted'":"SELECT * FROM product_contributions WHERE id=? AND owner=? AND status!='deleted'").bind(...(admin?[contributionID(id)]:[contributionID(id),ownerID(owner)])).first();
 if(!row)throw new ContributionError('This contribution is no longer available.',404,'contribution_not_found');return row;
}
export async function submitContribution(db,owner,body,{now=Date.now(),deadline=Date.now()+60_000}={}){
 ownerID(owner);
 if(!keys(body,['id','barcode','marketCountry','store','consent','photos','correction'])||!validCatalogueBarcode(body.barcode)||!Array.isArray(body.photos)||body.photos.length<1||body.photos.length>3)throw new ContributionError();
 const correction=correctionProposal(body.correction);
 const id=contributionID(body.id),country=body.marketCountry??null,store=body.store??null;
 if(country!==null&&!/^[A-Z]{2}$/.test(country)||store!==null&&!STORES.includes(store))throw new ContributionError();
 if(!keys(body.consent,['version','shareProductFacts','retainPhotosForReview'])||body.consent.version!==CONTRIBUTION_VERSION||body.consent.shareProductFacts!==true||body.consent.retainPhotosForReview!==true)throw new ContributionError('Consent to private photo review and sharing reviewed product facts is required.',400,'contribution_consent_required');
 if(new Set(body.photos.map(p=>p.role)).size!==body.photos.length)throw new ContributionError('Use one photo for each packaging role.');
 const photos=[];for(const photo of body.photos){const bytes=jpegBytes(photo);photos.push({role:photo.role,bytes,sha:await hash(bytes)});}
 const fingerprint=await hash(stableStringify({id,barcode:body.barcode,country,store,consent:body.consent,photos:photos.map(p=>({role:p.role,sha:p.sha})).sort((a,b)=>a.role.localeCompare(b.role)),...(correction?{correction}:{})}));
 await purgeExpired(db,now);
 const old=await db.prepare('SELECT * FROM product_contributions WHERE id=?').bind(id).first();
 if(old){if(old.owner!==owner||old.request_hash!==fingerprint)throw new ContributionError('This submission identifier already has different content.',409,'contribution_idempotency_conflict');if(old.status==='deleted')throw new ContributionError('This submission was withdrawn.',410,'contribution_deleted');return {contribution:await statusView(db,old,now),replayed:true};}
 const count=await db.prepare("SELECT count(*) AS total,sum(CASE WHEN owner=? THEN 1 ELSE 0 END) AS owned FROM product_contributions WHERE status NOT IN('published','rejected','deleted')").bind(owner).first();
 if(Number(count?.owned)>=20||Number(count?.total)>=1000)throw new ContributionError('The review queue is full. Try again later.',429,'contribution_queue_full');
 // Guard quotas again inside the atomic write: hashing yields, so concurrent
 // requests must not bypass the initial cheap count or overwrite an existing ID.
 const insert=db.prepare(`INSERT OR IGNORE INTO product_contributions(id,owner,barcode,market_country,store,consent_version,request_hash,status,created_at,updated_at,expires_at) SELECT ?,?,?,?,?,?,?,'queued',?,?,? WHERE (SELECT count(*) FROM product_contributions WHERE owner=? AND status NOT IN('published','rejected','deleted'))<20 AND (SELECT count(*) FROM product_contributions WHERE status NOT IN('published','rejected','deleted'))<1000 AND NOT EXISTS(SELECT 1 FROM community_deletion_fences WHERE owner=? AND expires_at>?) AND CAST(strftime('%s','now') AS INTEGER)*1000<=?`).bind(id,owner,body.barcode,country,store,CONTRIBUTION_VERSION,fingerprint,now,now,now+TTL,owner,owner,now,deadline);
 await db.batch([insert,db.prepare("INSERT OR IGNORE INTO product_contribution_details(contribution_id,correction_json) SELECT ?,? WHERE EXISTS(SELECT 1 FROM product_contributions WHERE id=? AND owner=? AND request_hash=? AND status='queued')").bind(id,correction?JSON.stringify(correction):null,id,owner,fingerprint),...photos.map(photo=>db.prepare("INSERT OR IGNORE INTO product_contribution_photos(contribution_id,role,mime_type,sha256,image) SELECT ?,?,'image/jpeg',?,? WHERE EXISTS(SELECT 1 FROM product_contributions WHERE id=? AND owner=? AND request_hash=? AND status='queued')").bind(id,photo.role,photo.sha,photo.bytes,id,owner,fingerprint))]);
 const row=await db.prepare('SELECT * FROM product_contributions WHERE id=?').bind(id).first();
 if(!row)throw new ContributionError('The review queue is full. Try again later.',429,'contribution_queue_full');
 if(row.owner!==owner||row.request_hash!==fingerprint)throw new ContributionError('This submission identifier already has different content.',409,'contribution_idempotency_conflict');
 return {contribution:await statusView(db,row,now),replayed:false};
}
export async function claimContribution(db,{now=Date.now()}={}){
 await purgeExpired(db,now);
 // An exhausted crashed lease remains visible as an error, never locked forever.
 await db.prepare("UPDATE product_contributions SET status='retryable_error',lease_token=NULL,lease_until=NULL,error_code='analysis_unavailable',updated_at=? WHERE status='processing' AND lease_until<=? AND attempts>=?").bind(now,now,MAX_ATTEMPTS).run();
 const lease=crypto.randomUUID();
 const row=await db.prepare(`UPDATE product_contributions SET status='processing',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=(SELECT id FROM product_contributions WHERE expires_at>? AND attempts<? AND NOT EXISTS(SELECT 1 FROM product_contributions WHERE status='processing' AND lease_until>?) AND ((status IN('queued','retryable_error') AND COALESCE(next_retry_at,0)<=?) OR (status='processing' AND lease_until<=?)) ORDER BY created_at,id LIMIT 1) RETURNING *`).bind(lease,now+LEASE,now,now,MAX_ATTEMPTS,now,now,now).first();
 if(!row)return null;
 const photos=(await db.prepare('SELECT role,mime_type,image,sha256 FROM product_contribution_photos WHERE contribution_id=? ORDER BY role').bind(row.id).all()).results||[];
 const encode=bytes=>{const array=new Uint8Array(bytes);let text='';for(let i=0;i<array.length;i+=8192)text+=String.fromCharCode(...array.subarray(i,i+8192));return btoa(text);};
 return {id:row.id,owner:row.owner,barcode:row.barcode,marketCountry:row.market_country,lease,attempt:row.attempts,photos:photos.map(p=>({role:p.role,mimeType:p.mime_type,imageBase64:encode(p.image)}))};
}
export async function nextContributionAlarm(db,{now=Date.now()}={}){
 const active=await db.prepare("SELECT min(lease_until) AS next FROM product_contributions WHERE status='processing' AND lease_until>?").bind(now).first();
 const queued=active?.next?null:await db.prepare("SELECT min(CASE WHEN status='processing' THEN lease_until ELSE COALESCE(next_retry_at,0) END) AS next FROM product_contributions WHERE attempts<? AND status IN('queued','processing','retryable_error')").bind(MAX_ATTEMPTS).first();
 const expiry=await db.prepare('SELECT min(expires_at) AS next FROM product_contributions').first();
 const moderation=await db.prepare('SELECT min(expires_at) AS next FROM (SELECT expires_at FROM ambassador_reports UNION ALL SELECT expires_at FROM ambassador_restrictions UNION ALL SELECT expires_at FROM ambassador_report_limits UNION ALL SELECT expires_at FROM community_deletion_fences)').first();
 const times=[active?.next,queued?.next,expiry?.next,moderation?.next].filter(value=>value!==null&&value!==undefined);
 return times.length?Math.max(now+100,Math.min(...times)):null;
}
export async function completeContribution(db,body,{now=Date.now()}={}){
 if(!keys(body,['id','lease','sourceLookup','candidate','errorCode'])||!['found','found_other_market','not_found','unavailable'].includes(body.sourceLookup)||!UUID.test(body.lease||''))throw new ContributionError();
 const candidate=body.candidate??null;
 if(candidate!==null&&(!object(candidate)||typeof candidate.readyForReview!=='boolean'||!Array.isArray(candidate.missingPhotoRoles)||candidate.missingPhotoRoles.some(role=>!ROLES.includes(role))||JSON.stringify(candidate).length>100000))throw new ContributionError();
 const status=candidate?candidate.readyForReview?'pending_review':'needs_photos':'retryable_error';
 const result=await db.prepare(`UPDATE product_contributions SET status=?,source_lookup=?,candidate_json=?,error_code=?,lease_token=NULL,lease_until=NULL,next_retry_at=CASE WHEN ?='retryable_error' THEN ?+(attempts*300000) ELSE NULL END,updated_at=? WHERE id=? AND status='processing' AND lease_token=? AND lease_until>? AND expires_at>? RETURNING id`).bind(status,body.sourceLookup,candidate?JSON.stringify(candidate):null,candidate?null:'analysis_unavailable',status,now,now,contributionID(body.id),body.lease,now,now).all();
 return {completed:!!result.results?.length};
}
export async function reviewContribution(db,id,body,{now=Date.now()}={}){
 if(!keys(body,['decision','expectedUpdatedAt','confirmBarcode','confirmLabelFacts','confirmCategory','confirmCorrection'])||!['publish','reject'].includes(body.decision)||!Number.isSafeInteger(body.expectedUpdatedAt))throw new ContributionError();
 const old=await rowFor(db,id,null,true);
 if(old.updated_at!==body.expectedUpdatedAt||old.expires_at<=now||!['pending_review','needs_photos'].includes(old.status))throw new ContributionError('This submission changed. Reload it before reviewing.',409,'contribution_review_conflict');
 let published;
 const detail=await db.prepare('SELECT correction_json FROM product_contribution_details WHERE contribution_id=?').bind(old.id).first();
 const correction=detail?.correction_json?JSON.parse(detail.correction_json):null;
 if(body.decision==='publish'){
  if(body.confirmBarcode!==true||body.confirmLabelFacts!==true||body.confirmCategory!==true||old.status!=='pending_review')throw new ContributionError('Confirm the barcode, food category and every published label fact against the packaging.');
  if(correction&&body.confirmCorrection!==true)throw new ContributionError('Check the proposed correction against the photos and proposed published facts before confirming it.');
  published=await reviewedProductRow(JSON.parse(old.candidate_json),old.barcode,{observedAt:old.created_at,reviewedAt:now,correctionReviewed:!!correction});
 }
 // The guard protects against owner deletion or a competing reviewer while the
 // fact fingerprint is computed. All publication/photos/status changes commit together.
 const guard='EXISTS(SELECT 1 FROM product_contributions WHERE id=? AND updated_at=? AND status=? AND expires_at>?)';
 const awards=published?await ambassadorPublicationStatements(db,old,published,now):[];
 const statements=[];
 if(published){
  // Recheck in the same transaction before the insert through a conditional
  // INSERT statement; an unguarded upsert could resurrect a withdrawn product.
  statements.push(db.prepare(`INSERT INTO reviewed_products(barcode,provider_json,score_json,source_fingerprint,source_revision,observed_at,reviewed_at,expires_at,score_method,score_version,classifier_version,provenance_json,calculated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(barcode) DO UPDATE SET provider_json=excluded.provider_json,score_json=excluded.score_json,source_fingerprint=excluded.source_fingerprint,source_revision=excluded.source_revision,observed_at=excluded.observed_at,reviewed_at=excluded.reviewed_at,expires_at=excluded.expires_at,score_method=excluded.score_method,score_version=excluded.score_version,classifier_version=excluded.classifier_version,provenance_json=excluded.provenance_json,calculated_at=excluded.calculated_at WHERE excluded.reviewed_at>=reviewed_products.reviewed_at`)
   .bind(published.barcode,published.providerJSON,published.scoreJSON,published.fingerprint,published.sourceRevision,published.observedAt,published.reviewedAt,published.expiresAt,published.method,published.version,published.classifierVersion,published.provenanceJSON,now,old.id,old.updated_at,old.status,now));
 }
 statements.push(...awards);
 statements.push(db.prepare(`DELETE FROM product_contribution_photos WHERE contribution_id=? AND ${guard}`).bind(old.id,old.id,old.updated_at,old.status,now));
 statements.push(db.prepare(`UPDATE product_contributions SET status=?,reviewed_at=?,published_at=?,updated_at=?,candidate_json=NULL WHERE id=? AND updated_at=? AND status=? AND expires_at>? RETURNING *`).bind(published?'published':'rejected',now,published?now:null,now,old.id,old.updated_at,old.status,now));
 const result=await db.batch(statements),updated=result.at(-1)?.results?.[0];
 if(!updated)throw new ContributionError('This submission changed. Reload it before reviewing.',409,'contribution_review_conflict');
 return {contribution:await statusView(db,updated,now)};
}
async function boundedBytes(request,maximum=CONTRIBUTION_MAX_BYTES){
 if(Number(request.headers.get('content-length'))>maximum)throw new ContributionError('Contribution upload is too large.',413,'contribution_too_large');
 const reader=request.body?.getReader();if(!reader)return new Uint8Array();const chunks=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maximum){await reader.cancel();throw new ContributionError('Contribution upload is too large.',413,'contribution_too_large');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export async function handleContributionStoreRequest(db,request,{now=Date.now()}={}){
 try{
  const url=new URL(request.url),action=url.pathname.replace('/contributions/',''),owner=request.headers.get('x-nudge-owner'),admin=request.headers.get('x-nudge-admin')==='true',internal=request.headers.get('x-nudge-internal')==='true',id=url.searchParams.get('id');
  if(!admin&&!internal)ownerID(owner);await purgeExpired(db,now);
  const bytes=await boundedBytes(request);let body={};try{if(bytes.length)body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ContributionError();}
  if(action==='submit'&&!admin&&!internal)return Response.json(await submitContribution(db,owner,body,{now,deadline:Number(request.headers.get('x-nudge-request-deadline'))||Date.now()+60_000}));
  if(action==='claim'&&internal)return Response.json({job:await claimContribution(db,{now})});
  if(action==='complete'&&internal)return Response.json(await completeContribution(db,body,{now}));
  if(action==='purge-owner'&&internal){
   ownerID(owner);
   const purgeToken=crypto.randomUUID();
   // Account erasure removes the private queue, photos, predictions and status
   // history. Independently reviewed public facts have no owner identifier.
   const result=await db.batch([db.prepare('INSERT INTO community_deletion_fences(owner,expires_at,recovery_token) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET expires_at=excluded.expires_at,recovery_token=excluded.recovery_token').bind(owner,now+600_000,purgeToken),...(owner==='private-owner'?[]:[...ambassadorRemovalStatements(db,owner),db.prepare('DELETE FROM ambassador_restrictions WHERE owner=?').bind(owner),db.prepare('DELETE FROM ambassador_report_limits WHERE owner=?').bind(owner)]),db.prepare('DELETE FROM product_contribution_details WHERE contribution_id IN(SELECT id FROM product_contributions WHERE owner=?)').bind(owner),db.prepare('DELETE FROM product_contribution_photos WHERE contribution_id IN(SELECT id FROM product_contributions WHERE owner=?)').bind(owner),db.prepare('DELETE FROM product_contributions WHERE owner=? RETURNING id').bind(owner)]);
   return Response.json({deleted:true,removed:result.at(-1)?.results?.length||0,purgeToken});
  }
  if(action==='reactivate-owner'&&internal){
   ownerID(owner);if(!keys(body,['purgeToken'])||!UUID.test(body.purgeToken||''))throw new ContributionError();
   await db.prepare('DELETE FROM community_deletion_fences WHERE owner=? AND recovery_token=?').bind(owner,body.purgeToken).run();
   return Response.json({reactivated:true});
  }
  if(action==='reviewed'){
   if(!validCatalogueBarcode(url.searchParams.get('barcode')))throw new ContributionError();
   const result=await reviewedCatalogueBatch(db,[url.searchParams.get('barcode')],{now});return Response.json(result,{status:result.products.length?200:404});
  }
  if(action==='reviewed-export'&&internal){
   const after=url.searchParams.get('after')||'',limit=Number(url.searchParams.get('limit')||50);
   if(after&&!validCatalogueBarcode(after)||!Number.isInteger(limit)||limit<1||limit>100)throw new ContributionError();
   const rows=(await db.prepare('SELECT barcode FROM reviewed_products WHERE barcode>? ORDER BY barcode LIMIT ?').bind(after,limit+1).all()).results||[];
   const result=await reviewedCatalogueBatch(db,rows.slice(0,limit).map(row=>row.barcode),{now});
   return Response.json({...result,hasMore:rows.length>limit,nextAfter:rows.length>limit?rows[limit-1].barcode:null,catalogue:{sourceKind:'nudge_community',source:'Nudge community',attribution:'Product facts reviewed against packaging photos.',licenceURL:null,photosPublic:false}});
  }
  if(action==='list'){
   const rows=(await db.prepare(admin?"SELECT * FROM product_contributions WHERE status!='deleted' ORDER BY created_at DESC LIMIT 50":"SELECT * FROM product_contributions WHERE owner=? AND status!='deleted' ORDER BY created_at DESC LIMIT 50").bind(...(admin?[]:[owner])).all()).results||[];
   return Response.json({contributions:await Promise.all(rows.map(row=>statusView(db,row,now)))});
  }
  const row=await rowFor(db,id,owner,admin);
  if(action==='status')return Response.json({contribution:await statusView(db,row,now),...(admin?{candidate:row.candidate_json?JSON.parse(row.candidate_json):null,observedMarket:{country:row.market_country,store:row.store,verification:'user_observation'},photos:(await db.prepare('SELECT role,sha256,mime_type FROM product_contribution_photos WHERE contribution_id=?').bind(row.id).all()).results||[]}: {})});
  if(action==='photo'&&admin){const role=url.searchParams.get('role');if(!ROLES.includes(role))throw new ContributionError();const photo=await db.prepare('SELECT image FROM product_contribution_photos WHERE contribution_id=? AND role=?').bind(row.id,role).first();if(!photo)throw new ContributionError('Photo is no longer available.',404,'contribution_not_found');return new Response(photo.image,{headers:{'content-type':'image/jpeg','cache-control':'no-store','x-content-type-options':'nosniff','content-disposition':'inline'}});}
  if(action==='review'&&admin)return Response.json(await reviewContribution(db,row.id,body,{now}));
  if(action==='delete'&&!admin){
   if(row.status==='published')throw new ContributionError('Reviewed shared product facts cannot be withdrawn through a pending submission.',409,'contribution_already_published');
   const result=await db.batch([db.prepare("DELETE FROM product_contribution_details WHERE contribution_id=? AND EXISTS(SELECT 1 FROM product_contributions WHERE id=? AND owner=? AND status!='published')").bind(row.id,row.id,owner),db.prepare("DELETE FROM product_contribution_photos WHERE contribution_id=? AND EXISTS(SELECT 1 FROM product_contributions WHERE id=? AND owner=? AND status!='published')").bind(row.id,row.id,owner),db.prepare("UPDATE product_contributions SET status='deleted',barcode='',market_country=NULL,store=NULL,candidate_json=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND owner=? AND status!='published' RETURNING id").bind(now,row.id,owner)]);
   if(!result.at(-1)?.results?.length)throw new ContributionError('This contribution was already published.',409,'contribution_already_published');
   return Response.json({deleted:true,id:row.id});
  }
  if(action==='retry'&&!admin){
   if(!(await statusView(db,row,now)).canRetry)throw new ContributionError('This submission cannot be retried yet.',409,'contribution_retry_unavailable');
   await db.prepare("UPDATE product_contributions SET status='queued',updated_at=?,next_retry_at=NULL WHERE id=? AND owner=? AND status='retryable_error' AND attempts<? AND next_retry_at<=?").bind(now,row.id,owner,MAX_ATTEMPTS,now).run();return Response.json({contribution:await statusView(db,await rowFor(db,row.id,owner),now)});
  }
  throw new ContributionError('Not found.',404,'route_not_found');
 }catch(error){if(error instanceof ContributionError)return Response.json({code:error.code,message:error.message},{status:error.status});throw error;}
}
function indexStub(env){if(!env.FOOD_CATALOGUE_INDEX)throw new ContributionError('Product submissions are temporarily unavailable.',503,'contribution_unavailable');return env.FOOD_CATALOGUE_INDEX.get(env.FOOD_CATALOGUE_INDEX.idFromName('uk-public-products-v1'),{locationHint:'weur'});}
export async function processContributionQueue(env,{analyse,validateUpload,signal}={}){
 const index=indexStub(env),headers={'x-nudge-internal':'true'};
 const response=await index.fetch('https://catalogue-index/contributions/claim',{method:'POST',headers,body:'{}'});if(!response.ok)return;
 const {job}=await response.json();if(!job)return;
 let sourceLookup='unavailable',candidate=null;
 try{sourceLookup=contributionSourceLookup(await getCatalogueOutcome(env,job.barcode,signal,{allowSourceFetch:true}),job.marketCountry);}catch{/* Outages do not assert a missing product. */}
 try{candidate=await contributionAnalysis({barcode:job.barcode,photos:job.photos},{analyse,validateUpload,env,signal,owner:job.owner});}catch{/* Private provider output and photos never enter logs or public errors. */}
 await index.fetch('https://catalogue-index/contributions/complete',{method:'POST',headers,body:JSON.stringify({id:job.id,lease:job.lease,sourceLookup,candidate,errorCode:candidate?null:'analysis_unavailable'})});
}
// Authentication belongs to the existing Worker. Only its trusted owner/admin
// result is forwarded in headers on the internal service-binding request.
export async function handleContributionRequest(request,env,{owner,admin=false,deadline=Date.now()+60_000}={}){
 try{
  const url=new URL(request.url),prefix=admin?'/v1/admin/product-contributions':'/v1/product-contributions',tail=url.pathname.slice(prefix.length).split('/').filter(Boolean);
  if(url.search||!url.pathname.startsWith(prefix)||tail.length>3)throw new ContributionError();
  const id=tail[0]?contributionID(tail[0]):null;let action;
  if(!tail.length)action=request.method==='GET'?'list':request.method==='POST'&&!admin?'submit':null;
  else if(tail.length===1)action=request.method==='GET'?'status':request.method==='DELETE'&&!admin?'delete':null;
  else if(tail[1]==='retry'&&tail.length===2&&!admin&&request.method==='POST')action='retry';
  else if(tail[1]==='review'&&tail.length===2&&admin&&request.method==='POST')action='review';
  else if(tail[1]==='photos'&&tail.length===3&&admin&&request.method==='GET'&&ROLES.includes(tail[2]))action='photo';
  if(!action)throw new ContributionError('Not found.',404,'route_not_found');
  if(!admin)ownerID(owner);
  if(request.method==='POST'&&!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw new ContributionError('JSON upload required.',415,'contribution_invalid');
  const body=await boundedBytes(request,action==='submit'?CONTRIBUTION_MAX_BYTES:4096),params=new URLSearchParams();if(id)params.set('id',id);if(action==='photo')params.set('role',tail[2]);
  const response=await indexStub(env).fetch('https://catalogue-index/contributions/'+action+(params.size?'?'+params:''),{method:'POST',headers:admin?{'x-nudge-admin':'true'}:{'x-nudge-owner':owner,'x-nudge-request-deadline':String(deadline)},body});
  return new Response(response.body,{status:response.status,headers:{'content-type':response.headers.get('content-type')||'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
 }catch(error){if(error instanceof ContributionError)return Response.json({code:error.code,message:error.message},{status:error.status});throw error;}
}
