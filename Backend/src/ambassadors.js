import { stableStringify } from './product-score.js';
import { catalogueRecordFromPayload } from './food-catalogue.js';

export const AMBASSADOR_TERMS_VERSION = 'ambassador-v1';
export const AMBASSADOR_ADJECTIVES = ['Bright','Calm','Cheerful','Curious','Gentle','Happy','Kind','Little','Mighty','Nimble','Sunny','Thoughtful'];
export const AMBASSADOR_NOUNS = ['Badger','Bee','Bluebird','Bumblebee','Fox','Hedgehog','Otter','Owl','Panda','Puffin','Robin','Squirrel'];
export const ambassadorSchema = `
CREATE TABLE IF NOT EXISTS ambassador_profiles (
 owner TEXT PRIMARY KEY, profile_id TEXT NOT NULL UNIQUE, handle TEXT NOT NULL UNIQUE, adjective TEXT NOT NULL, noun TEXT NOT NULL,
 leaderboard_visible INTEGER NOT NULL DEFAULT 0 CHECK(leaderboard_visible IN(0,1)),
 joined_at INTEGER NOT NULL, terms_version TEXT NOT NULL, adult_confirmed INTEGER NOT NULL CHECK(adult_confirmed=1)
);
CREATE TABLE IF NOT EXISTS ambassador_awards (
 owner TEXT NOT NULL REFERENCES ambassador_profiles(owner) ON DELETE CASCADE,
 barcode TEXT NOT NULL, fact_fingerprint TEXT NOT NULL, awarded_at INTEGER NOT NULL,
 points INTEGER NOT NULL CHECK(points=1), PRIMARY KEY(owner,barcode)
);
CREATE INDEX IF NOT EXISTS ambassador_awards_week ON ambassador_awards(awarded_at,owner);
-- No owner, handle, contribution ID, timestamp or joinable award identifier is
-- retained here. These irreversible digests describe public product facts only.
CREATE TABLE IF NOT EXISTS ambassador_fact_receipts (fact_fingerprint TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ambassador_blocks (owner TEXT NOT NULL,target TEXT NOT NULL,PRIMARY KEY(owner,target));
CREATE TABLE IF NOT EXISTS ambassador_reports (id TEXT PRIMARY KEY,reporter TEXT NOT NULL,target TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ambassador_reports_owner ON ambassador_reports(reporter,created_at);
CREATE INDEX IF NOT EXISTS ambassador_reports_expiry ON ambassador_reports(expires_at);
CREATE TABLE IF NOT EXISTS ambassador_restrictions (owner TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS community_deletion_fences (owner TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,recovery_token TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ambassador_report_limits (owner TEXT PRIMARY KEY,day INTEGER NOT NULL,used INTEGER NOT NULL CHECK(used BETWEEN 1 AND 5),expires_at INTEGER NOT NULL);

`;
export class AmbassadorError extends Error {
 constructor(message='Invalid ambassador request.',status=400,code='ambassador_invalid'){super(message);this.status=status;this.code=code;}
}
const headers = {'cache-control':'no-store','x-content-type-options':'nosniff'};
const json = (body,status=200) => Response.json(body,{status,headers});
function ownerID(owner){if(!/^[a-f0-9]{64}$/.test(owner||''))throw new AmbassadorError('Sign in to a Nudge account to join ambassadors.',403,'ambassador_account_required');return owner;}
export function ambassadorWeekStart(now=Date.now()){
 const date=new Date(now);date.setUTCHours(0,0,0,0);date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);return date.getTime();
}
export const ambassadorBadge = points => points>=100?'trailblazer':points>=25?'champion':points>=5?'helper':'newcomer';
export async function ambassadorProfile(db,owner,{now=Date.now()}={}){
 ownerID(owner);
 const row=await db.prepare(`SELECT p.*,COALESCE(sum(a.points),0) AS all_points,
 COALESCE(sum(CASE WHEN a.awarded_at>=? AND a.awarded_at<? THEN a.points ELSE 0 END),0) AS week_points
 ,EXISTS(SELECT 1 FROM ambassador_restrictions r WHERE r.owner=p.owner AND r.expires_at>?) AS paused
 FROM ambassador_profiles p LEFT JOIN ambassador_awards a ON a.owner=p.owner WHERE p.owner=? GROUP BY p.owner`)
 .bind(ambassadorWeekStart(now),ambassadorWeekStart(now)+7*86400000,now,owner).first();
 return {profile:row?{profileID:row.profile_id,handle:row.handle,adjective:row.adjective,noun:row.noun,leaderboardVisible:row.leaderboard_visible===1,joinedAt:row.joined_at,
 allTimePoints:row.all_points,weekPoints:row.week_points,badge:ambassadorBadge(row.all_points),participationStatus:row.paused?'paused':'active'}:null,
 termsVersion:AMBASSADOR_TERMS_VERSION,adjectives:AMBASSADOR_ADJECTIVES,nouns:AMBASSADOR_NOUNS};
}
export async function updateAmbassador(db,owner,body,{now=Date.now(),deadline=Date.now()+60_000,suffix=()=>1000+crypto.getRandomValues(new Uint32Array(1))[0]%9000}={}){
 ownerID(owner);
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['adjective','noun','leaderboardVisible','termsVersion','acceptedTerms','adultConfirmed'].includes(key))
 ||!AMBASSADOR_ADJECTIVES.includes(body.adjective)||!AMBASSADOR_NOUNS.includes(body.noun)||typeof body.leaderboardVisible!=='boolean'
 ||body.termsVersion!==AMBASSADOR_TERMS_VERSION||body.acceptedTerms!==true||body.adultConfirmed!==true)throw new AmbassadorError('Choose a suggested name and confirm the ambassador terms and that you are 18 or older.',400,'ambassador_consent_required');
 // Existing credit and join time are immutable on profile edits. The SQL CASE
 // also preserves the handle when two concurrent saves use the same word pair.
 for(let attempt=0;attempt<12;attempt++){
  const number=suffix();if(!Number.isInteger(number)||number<1000||number>9999)throw new Error('Invalid handle suffix');
  try{
   const written=await db.prepare(`INSERT INTO ambassador_profiles(owner,profile_id,handle,adjective,noun,leaderboard_visible,joined_at,terms_version,adult_confirmed)
   SELECT ?,?,?,?,?,?,?,?,1 WHERE NOT EXISTS(SELECT 1 FROM community_deletion_fences WHERE owner=? AND expires_at>?) AND CAST(strftime('%s','now') AS INTEGER)*1000<=? ON CONFLICT(owner) DO UPDATE SET
   handle=CASE WHEN ambassador_profiles.adjective=excluded.adjective AND ambassador_profiles.noun=excluded.noun THEN ambassador_profiles.handle ELSE excluded.handle END,
   adjective=excluded.adjective,noun=excluded.noun,leaderboard_visible=excluded.leaderboard_visible,terms_version=excluded.terms_version RETURNING owner`)
   .bind(owner,crypto.randomUUID(),body.adjective+body.noun+number,body.adjective,body.noun,body.leaderboardVisible?1:0,now,AMBASSADOR_TERMS_VERSION,owner,now,deadline).first();
   if(!written)throw new AmbassadorError('Account deletion is in progress or this request expired.',409,'ambassador_account_unavailable');
   const profile=await ambassadorProfile(db,owner,{now});
   if(!profile.profile)throw new AmbassadorError('Account deletion is in progress or this request expired.',409,'ambassador_account_unavailable');
   return profile;
  }catch(error){if(!/UNIQUE constraint failed: ambassador_profiles\.handle/.test(String(error?.message)))throw error;}
 }
 throw new AmbassadorError('That name is busy. Try another suggested name.',409,'ambassador_handle_unavailable');
}
export function ambassadorRemovalStatements(db,owner){
 ownerID(owner);return [db.prepare('DELETE FROM ambassador_awards WHERE owner=?').bind(owner),db.prepare('DELETE FROM ambassador_blocks WHERE owner=? OR target=?').bind(owner,owner),db.prepare('DELETE FROM ambassador_reports WHERE reporter=? OR target=?').bind(owner,owner),db.prepare('DELETE FROM ambassador_profiles WHERE owner=?').bind(owner)];
}
export async function deleteAmbassador(db,owner){await db.batch(ambassadorRemovalStatements(db,owner));return {deleted:true};}
export async function purgeAmbassadorModeration(db,now=Date.now()){
 await db.batch([db.prepare('DELETE FROM ambassador_reports WHERE expires_at<=?').bind(now),db.prepare('DELETE FROM ambassador_restrictions WHERE expires_at<=?').bind(now),db.prepare('DELETE FROM ambassador_report_limits WHERE expires_at<=?').bind(now),db.prepare('DELETE FROM community_deletion_fences WHERE expires_at<=?').bind(now)]);
}
function exactBody(body,allowed){return body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===allowed.length&&Object.keys(body).every(key=>allowed.includes(key));}
async function targetProfile(db,owner,profileID,{admin=false}={}){
 if(typeof profileID!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(profileID))throw new AmbassadorError();
 const target=await db.prepare('SELECT owner FROM ambassador_profiles WHERE profile_id=?'+(admin?'':' AND leaderboard_visible=1')).bind(profileID).first();
 if(!target)throw new AmbassadorError('This ambassador is no longer available.',404,'ambassador_not_found');
 if(target.owner===owner)throw new AmbassadorError('Choose another ambassador.');return target.owner;
}
async function blockAmbassador(db,owner,body,blocked,now,deadline){
 if(!exactBody(body,['profileID']))throw new AmbassadorError();
 if(blocked){
  const target=await targetProfile(db,owner,body.profileID);
  await db.prepare(`INSERT OR IGNORE INTO ambassador_blocks(owner,target) SELECT ?,? WHERE
  (SELECT count(*) FROM ambassador_blocks WHERE owner=?)<200 AND EXISTS(SELECT 1 FROM ambassador_profiles WHERE owner=? AND profile_id=? AND leaderboard_visible=1)
  AND NOT EXISTS(SELECT 1 FROM community_deletion_fences WHERE owner=? AND expires_at>?) AND CAST(strftime('%s','now') AS INTEGER)*1000<=?`)
  .bind(owner,target,owner,target,body.profileID,owner,now,deadline).run();
  if(!await db.prepare('SELECT target FROM ambassador_blocks WHERE owner=? AND target=?').bind(owner,target).first())throw new AmbassadorError('Your hidden list is full or this ambassador is no longer available.',409,'ambassador_block_unavailable');
 } else {
  if(typeof body.profileID!=='string'||body.profileID.length>36)throw new AmbassadorError();
  await db.prepare('DELETE FROM ambassador_blocks WHERE owner=? AND target IN(SELECT owner FROM ambassador_profiles WHERE profile_id=?)').bind(owner,body.profileID).run();
 }
 return {blocked};
}
async function reportAmbassador(db,owner,body,now,deadline){
 if(!exactBody(body,['profileID','reason'])||!['points','conduct','other'].includes(body.reason))throw new AmbassadorError();
 const target=await targetProfile(db,owner,body.profileID),day=Math.floor(now/86400000)*86400000,id=crypto.randomUUID();
 // The content-free daily receipt survives deleting a profile, so five reports
 // cannot be bypassed by leaving/rejoining. Account erasure removes it too.
 const result=await db.batch([
  db.prepare(`INSERT INTO ambassador_reports(id,reporter,target,reason,created_at,expires_at)
  SELECT ?,?,?,?,?,? WHERE COALESCE((SELECT used FROM ambassador_report_limits WHERE owner=? AND day=?),0)<5
  AND NOT EXISTS(SELECT 1 FROM ambassador_reports WHERE reporter=? AND target=? AND created_at>=?)
  AND EXISTS(SELECT 1 FROM ambassador_profiles WHERE owner=? AND profile_id=? AND leaderboard_visible=1)
  AND NOT EXISTS(SELECT 1 FROM community_deletion_fences WHERE owner=? AND expires_at>?) AND CAST(strftime('%s','now') AS INTEGER)*1000<=? RETURNING id`)
  .bind(id,owner,target,body.reason,now,now+30*86400000,owner,day,owner,target,day,target,body.profileID,owner,now,deadline),
  db.prepare(`INSERT INTO ambassador_report_limits(owner,day,used,expires_at) SELECT ?,?,1,? WHERE EXISTS(SELECT 1 FROM ambassador_reports WHERE id=?)
  ON CONFLICT(owner) DO UPDATE SET day=excluded.day,used=CASE WHEN ambassador_report_limits.day=excluded.day THEN ambassador_report_limits.used+1 ELSE 1 END,expires_at=excluded.expires_at`)
  .bind(owner,day,day+2*86400000,id)
 ]);
 if(!result[0].results.length){
  if(!await db.prepare('SELECT id FROM ambassador_reports WHERE reporter=? AND target=? AND created_at>=?').bind(owner,target,day).first())
   throw new AmbassadorError('Today’s report limit was reached or this ambassador is no longer available.',429,'ambassador_report_limit');
 }
 return {reported:true};
}
async function moderateAmbassador(db,body,now){
 if(!exactBody(body,['profileID','suspended'])||typeof body.suspended!=='boolean')throw new AmbassadorError();
 const owner=await targetProfile(db,null,body.profileID,{admin:true});
 if(body.suspended)await db.prepare(`INSERT INTO ambassador_restrictions(owner,expires_at) SELECT ?,? WHERE EXISTS(SELECT 1 FROM ambassador_profiles WHERE owner=? AND profile_id=?)
 ON CONFLICT(owner) DO UPDATE SET expires_at=excluded.expires_at`).bind(owner,now+30*86400000,owner,body.profileID).run();
 else await db.prepare('DELETE FROM ambassador_restrictions WHERE owner=?').bind(owner).run();
 return {moderated:true,participationStatus:body.suspended?'paused':'active'};
}
export async function ambassadorLeaderboard(db,owner,period='week',{now=Date.now()}={}){
 ownerID(owner);if(!['week','all'].includes(period))throw new AmbassadorError();
 const weekStartsAt=ambassadorWeekStart(now),start=period==='week'?weekStartsAt:0,end=period==='week'?weekStartsAt+7*86400000:Number.MAX_SAFE_INTEGER;
 // Window ranking occurs before LIMIT so the caller's place remains correct
 // outside the first fifty. Never return stable owner IDs or contribution data.
 const query=`WITH totals AS (SELECT p.owner,p.profile_id,p.handle,sum(CASE WHEN a.awarded_at>=? AND a.awarded_at<? THEN a.points ELSE 0 END) AS points,sum(a.points) AS all_points
 FROM ambassador_profiles p JOIN ambassador_awards a ON a.owner=p.owner WHERE p.leaderboard_visible=1 AND NOT EXISTS(SELECT 1 FROM ambassador_restrictions r WHERE r.owner=p.owner AND r.expires_at>?) AND NOT EXISTS(SELECT 1 FROM ambassador_blocks b WHERE b.owner=? AND b.target=p.owner) GROUP BY p.owner),
 ranked AS (SELECT owner,profile_id,handle,points,all_points,rank() OVER(ORDER BY points DESC) AS position FROM totals WHERE points>0)`;
 const result=await db.batch([
  db.prepare(query+' SELECT profile_id,handle,points,all_points,position FROM ranked ORDER BY points DESC,handle LIMIT 50').bind(start,end,now,owner),
  db.prepare(query+' SELECT position FROM ranked WHERE owner=?').bind(start,end,now,owner,owner)
 ]);
 return {period,weekStartsAt,entries:result[0].results.map(row=>({rank:row.position,profileID:row.profile_id,handle:row.handle,points:row.points,badge:ambassadorBadge(row.all_points)})),myRank:result[1].results[0]?.position??null};
}

// Canonical public facts deliberately exclude review/observation times, score
// versions, source/provenance, popularity, stores, photos and model confidence.
// Normalize equivalent legacy/structured nutrition into the same representation.
export async function ambassadorFactFingerprint(product){
 const p=catalogueRecordFromPayload({product},product.code,0).product;
 const text=value=>typeof value==='string'?value.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim():null;
 const tags=value=>[...new Set((value||[]).filter(v=>typeof v==='string').map(text))].sort();
 const nutrient=value=>value?.value===null||value?.value===undefined?null:{value:value.value,unit:value.unit,relation:['eq','='].includes(value.relation)||!value.relation?'=':value.relation};
 const facts={barcode:p.barcode,name:text(p.name),brand:text(p.brand),basis:p.basisUnit,preparation:p.nutritionPreparation,
 nutrients:Object.fromEntries(Object.entries(p.nutrients).map(([key,value])=>[key,nutrient(value)])),energyKj:nutrient(p.energyKj),
 ingredients:text(p.ingredients),categories:tags(p.categories),allergens:text(product.allergens),traces:text(product.traces),
 allergensTags:tags(product.allergens_tags),tracesTags:tags(product.traces_tags),labels:tags(product.labels_tags),
 quantity:text(product.quantity),servingSize:text(product.serving_size)};
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stableStringify(facts)))),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function ambassadorPublicationStatements(db,old,published,now){
 const fingerprint=await ambassadorFactFingerprint(JSON.parse(published.providerJSON));
 const priorRows=(await db.prepare('SELECT provider_json FROM reviewed_products WHERE barcode=? UNION ALL SELECT provider_json FROM catalogue_products WHERE barcode=?').bind(old.barcode,old.barcode).all()).results;
 const unchanged=(await Promise.all(priorRows.map(row=>ambassadorFactFingerprint(JSON.parse(row.provider_json))))).includes(fingerprint);
 const guard=`EXISTS(SELECT 1 FROM product_contributions WHERE id=? AND updated_at=? AND status=? AND expires_at>?)
 AND EXISTS(SELECT 1 FROM reviewed_products WHERE barcode=? AND source_fingerprint=? AND reviewed_at=?)`;
 const guardValues=[old.id,old.updated_at,old.status,now,published.barcode,published.fingerprint,now];
 return [
  db.prepare(`INSERT OR IGNORE INTO ambassador_awards(owner,barcode,fact_fingerprint,awarded_at,points)
  SELECT owner,?,?,?,1 FROM ambassador_profiles WHERE owner=? AND joined_at<=? AND ?=0 AND ${guard}
  AND NOT EXISTS(SELECT 1 FROM ambassador_fact_receipts WHERE fact_fingerprint=?)
  AND NOT EXISTS(SELECT 1 FROM ambassador_restrictions r WHERE r.owner=ambassador_profiles.owner AND r.expires_at>?)
  AND NOT EXISTS(SELECT 1 FROM community_deletion_fences f WHERE f.owner=ambassador_profiles.owner AND f.expires_at>?)`)
  .bind(old.barcode,fingerprint,now,old.owner,old.created_at,unchanged?1:0,...guardValues,fingerprint,now,now),
  // Record accepted facts even when no profile was eligible. Rejoining or a
  // different owner cannot earn credit for repeating that same publication.
  db.prepare(`INSERT OR IGNORE INTO ambassador_fact_receipts(fact_fingerprint) SELECT ? WHERE ${guard}`).bind(fingerprint,...guardValues)
 ];
}
async function boundedBody(request){
 if(Number(request.headers.get('content-length'))>1024)throw new AmbassadorError('Ambassador request is too large.',413,'ambassador_too_large');
 const reader=request.body?.getReader();if(!reader)return new Uint8Array();let length=0;const chunks=[];
 try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>1024){await reader.cancel();throw new AmbassadorError('Ambassador request is too large.',413,'ambassador_too_large');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export async function handleAmbassadorStoreRequest(db,request,{now=Date.now()}={}){
 try{
  if(request.headers.get('x-nudge-internal')!=='true')throw new AmbassadorError('Authentication required.',401,'authentication_required');
  const admin=request.headers.get('x-nudge-admin')==='true',owner=admin?null:ownerID(request.headers.get('x-nudge-owner')),url=new URL(request.url),bytes=await boundedBody(request);
  await purgeAmbassadorModeration(db,now);
  const deadline=Number(request.headers.get('x-nudge-request-deadline'));
  if(!admin&&!['GET','DELETE'].includes(request.method)&&(!Number.isSafeInteger(deadline)||deadline<Date.now()||deadline>Date.now()+60_000))throw new AmbassadorError('This request expired. Try again.',409,'ambassador_request_expired');
  let body;
  if(bytes.length){
   if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw new AmbassadorError('JSON is required.',415);
   try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AmbassadorError();}
  }
  if(admin){
   if(url.search)throw new AmbassadorError();
   if(url.pathname==='/ambassadors/reports'&&request.method==='GET'&&!bytes.length){
    const result=await db.prepare('SELECT r.id,p.profile_id,p.handle,r.reason,r.created_at FROM ambassador_reports r LEFT JOIN ambassador_profiles p ON p.owner=r.target ORDER BY r.created_at DESC,r.id LIMIT 50').all();
    return json({reports:result.results.map(row=>({id:row.id,profileID:row.profile_id,handle:row.handle,reason:row.reason,createdAt:row.created_at}))});
   }
   if(url.pathname==='/ambassadors/moderate'&&request.method==='POST')return json(await moderateAmbassador(db,body,now));
   throw new AmbassadorError('Not found.',404,'route_not_found');
  }
  if(!url.search&&url.pathname==='/ambassadors/blocks'&&request.method==='GET'&&!bytes.length){
   const result=await db.prepare('SELECT p.profile_id,CASE WHEN p.leaderboard_visible=1 THEN p.handle ELSE NULL END AS handle FROM ambassador_blocks b JOIN ambassador_profiles p ON p.owner=b.target WHERE b.owner=? ORDER BY p.profile_id LIMIT 200').bind(owner).all();
   return json({entries:result.results.map(row=>({profileID:row.profile_id,handle:row.handle}))});
  }
  if(!url.search&&url.pathname==='/ambassadors/block'&&['POST','DELETE'].includes(request.method))return json(await blockAmbassador(db,owner,body,request.method==='POST',now,deadline));
  if(!url.search&&url.pathname==='/ambassadors/report'&&request.method==='POST')return json(await reportAmbassador(db,owner,body,now,deadline));
  if(url.pathname==='/ambassadors/me'&&!url.search){
   if(request.method==='GET'&&!bytes.length)return json(await ambassadorProfile(db,owner,{now}));
   if(request.method==='DELETE'&&!bytes.length)return json(await deleteAmbassador(db,owner));
   if(request.method==='POST'){
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw new AmbassadorError('JSON is required.',415);
    return json(await updateAmbassador(db,owner,body,{now,deadline}));
   }
  }
  if(url.pathname==='/ambassadors/leaderboard'&&request.method==='GET'&&!bytes.length&&[...url.searchParams.keys()].every(key=>key==='period')&&url.searchParams.getAll('period').length<=1)
   return json(await ambassadorLeaderboard(db,owner,url.searchParams.get('period')??'week',{now}));
  throw new AmbassadorError();
 }catch(error){if(error instanceof AmbassadorError)return json({code:error.code,message:error.message},error.status);throw error;}
}
export async function handleAmbassadorRequest(request,env,{owner,admin=false,deadline}={}){
 try{
  if(!admin)ownerID(owner);
  const url=new URL(request.url);
  const prefix=admin?'/v1/admin':'/v1',path=url.pathname.slice(prefix.length);
  if(!(admin?['/ambassadors/reports','/ambassadors/moderate']:['/ambassadors/me','/ambassadors/leaderboard','/ambassadors/blocks','/ambassadors/block','/ambassadors/report']).includes(path))throw new AmbassadorError('Not found.',404,'route_not_found');
  const bytes=await boundedBody(request);
  if(!env.FOOD_CATALOGUE_INDEX)throw new AmbassadorError('Ambassadors are temporarily unavailable.',503,'ambassador_unavailable');
  const index=env.FOOD_CATALOGUE_INDEX.get(env.FOOD_CATALOGUE_INDEX.idFromName('uk-public-products-v1'),{locationHint:'weur'});
  const response=await index.fetch('https://catalogue-index'+path+url.search,{method:request.method,
   headers:{'x-nudge-internal':'true',...(admin?{'x-nudge-admin':'true'}:{'x-nudge-owner':owner,'x-nudge-request-deadline':String(deadline)}),'content-type':request.headers.get('content-type')||''},...(bytes.length?{body:bytes}:{})});
  return new Response(response.body,{status:response.status,headers:{...headers,'content-type':'application/json'}});
 }catch(error){if(error instanceof AmbassadorError)return json({code:error.code,message:error.message},error.status);throw error;}
}
