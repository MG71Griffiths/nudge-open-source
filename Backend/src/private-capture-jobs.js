// Private, account-scoped analysis outbox. Inputs never enter the public catalogue.
// Durable alarms keep accepted work independent of a phone's HTTP connection.
import {isFastCapture} from './capture-policy.js';
export const CAPTURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 24_000, MAX_PENDING = 50, MAX_BYTES = 80_000_000;
const LEASE_MS = 120_000, RETENTION_MS = 30 * 86400_000, MAX_ATTEMPTS = 6;
const reply = (body, status = 200, retryAfter) => Response.json(body, {status, headers:{
  'cache-control':'no-store', ...(retryAfter ? {'retry-after':String(retryAfter)} : {})
}});
const metaKey = id => 'job:' + id.toLowerCase();
const chunkKeys = (id, kind, count) => Array.from({length:count}, (_, i) => `${kind}:${id}:${i}`);
const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))), b=>b.toString(16).padStart(2,'0')).join('');
function stable(value) {
  if(Array.isArray(value))return value.map(stable);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
}
export function privateCaptureStub(env, subject) {
  if(!env.PRIVATE_CAPTURE_JOBS)return null;
  const owner=subject || 'private-owner';
  if(owner!=='private-owner'&&!/^[a-f0-9]{64}$/.test(owner))throw new Error('Invalid capture owner');
  return env.PRIVATE_CAPTURE_JOBS.get(env.PRIVATE_CAPTURE_JOBS.idFromName('private-captures-v1:'+owner));
}
export class DurableCaptureQueue {
  constructor(ctx, env) { this.ctx=ctx;this.storage=ctx.storage;this.env=env; }
  now(){return Date.now();}
  async putChunks(tx,id,kind,text) {
    const count=Math.ceil(text.length/CHUNK);
    for(let offset=0;offset<count;offset+=100) {
      const values={};
      for(let i=offset;i<Math.min(count,offset+100);i++)values[`${kind}:${id}:${i}`]=text.slice(i*CHUNK,(i+1)*CHUNK);
      await tx.put(values);
    }
    return count;
  }
  async readChunks(id,kind,count) {
    let text='';
    for(const key of chunkKeys(id,kind,count)) {
      const chunk=await this.storage.get(key);
      if(typeof chunk!=='string')throw new Error('Missing capture input');
      text+=chunk;
    }
    return text;
  }
  async removeChunks(tx,id,kind,count) {
    const keys=chunkKeys(id,kind,count||0);
    for(let offset=0;offset<keys.length;offset+=100)await tx.delete(keys.slice(offset,offset+100));
  }
  retentionAt(m) {
    if(['deleted','expired'].includes(m.status))return Number.isFinite(m.expiresAt)?m.expiresAt:0;
    // Derive legacy deadlines from the original timestamp, never from the next
    // retry or first access after deployment. Missing timestamps fail closed.
    const started=m.status==='complete'?m.completedAt:m.createdAt;
    return Number.isFinite(started)?started+RETENTION_MS:0;
  }
  async expire(tx,m,now=this.now()) {
    if(!m||this.retentionAt(m)>now)return m;
    await this.removeChunks(tx,m.id,'input',m.inputChunks);
    await this.removeChunks(tx,m.id,'result',m.resultChunks);
    if(['deleted','expired'].includes(m.status)){await tx.delete(metaKey(m.id));return undefined;}
    // A small tombstone lets offline clients re-upload their local originals.
    // Dropping the lease also fences a provider response already in flight.
    const expired={id:m.id,status:'expired',expiresAt:now+RETENTION_MS};
    await tx.put(metaKey(m.id),expired);return expired;
  }
  async sweep(tx,now=this.now()) {
    const rows=await tx.list({prefix:'job:'});
    for(const [key,m] of rows){
      const current=await this.expire(tx,m,now);
      if(current)rows.set(key,current);else rows.delete(key);
    }
    return rows;
  }
  async transaction(callback) {
    return this.storage.transaction(async tx=>{
      const result=await callback(tx);
      // Store the alarm atomically with every state transition. A stale
      // schedule cannot cancel a newer upload or outlive account deletion.
      await this.scheduleIn(tx);return result;
    });
  }
  async scheduleIn(tx) {
    if(await tx.get('purged')){await tx.deleteAlarm();return;}
    const rows=await tx.list({prefix:'job:'});
    let next=null;
    for(const m of rows.values()) {
      const workAt=m.status==='queued'?m.nextRetryAt:m.status==='processing'?m.leaseUntil:null;
      const expiry=this.retentionAt(m),at=Number.isFinite(workAt)?Math.min(workAt,expiry):expiry;
      if(Number.isFinite(at))next=next===null?at:Math.min(next,at);
    }
    if(next===null)await tx.deleteAlarm();
    else await tx.setAlarm(Math.max(this.now()+250,next));
  }
  async schedule(){await this.transaction(async()=>{});}
  async response(m) {
    if(!m)return reply({code:'capture_not_found',message:'This analysis has not been uploaded yet.'},404);
    if(m.status==='account_deleted')return reply({code:'capture_account_deleted',message:'This account has been deleted.'},410);
    if(m.status==='complete')return reply(JSON.parse(await this.readChunks(m.id,'result',m.resultChunks)));
    if(m.status==='deleted'||m.status==='expired')return reply({code:m.status==='expired'?'capture_expired':'capture_gone',message:'This server copy has been removed. Your saved capture remains on your device.'},410);
    if(m.status==='needs_input')return reply({code:m.errorCode||'label_unreadable',message:'More food information is needed. Open the saved capture to edit it.',...(m.lastTrace?{trace:m.lastTrace}:{})},422);
    if(m.status==='retryable_failure')return reply({code:m.errorCode||'analysis_retryable',message:'Analysis could not finish. Your capture is saved; try again later.',
      ...(m.fastPolicy?{manualRetryRequired:true}:{}),...(m.lastTrace?{trace:m.lastTrace}:{})},503,
      Math.max(1,Math.ceil((m.nextRetryAt-this.now())/1000)));
    const retryAfter=Math.max(m.fastPolicy?1:2,Math.min(60,Math.ceil(((m.status==='queued'?m.nextRetryAt:this.now()+(m.fastPolicy?1000:3000))-this.now())/1000)));
    return reply({job:{id:m.id,status:m.status,nextRetryAt:m.status==='queued'?m.nextRetryAt:this.now()+retryAfter*1000}},202,retryAfter);
  }
  async fetch(request) {
    const url=new URL(request.url),retry=url.pathname.endsWith('/retry'),id=url.pathname.slice(1).replace(/\/retry$/,'').toLowerCase();
    if(url.pathname==='/expire'){
      if(request.method!=='POST'||request.headers.get('x-nudge-internal')!=='true')return reply({code:'route_not_found'},404);
      let body;try{body=await request.json();}catch{return reply({code:'request_invalid'},400);}
      if(url.search||!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length)return reply({code:'request_invalid'},400);
      const summary=await this.transaction(async tx=>{
        if(await tx.get('purged'))return {expiredJobs:0,removedTombstones:0,remainingJobs:0,purged:true};
        const now=this.now(),before=await tx.list({prefix:'job:'}),after=await this.sweep(tx,now);
        const expiredJobs=[...before.values()].filter(m=>!['deleted','expired'].includes(m.status)&&this.retentionAt(m)<=now).length;
        return {expiredJobs,removedTombstones:before.size-after.size,remainingJobs:after.size,purged:false};
      });
      return reply(summary);
    }
    if(url.pathname==='/purge'&&request.method==='POST') {
      // Deletion fences any in-flight completion; no photos/results can reappear.
      const purgeToken=crypto.randomUUID();
      await this.transaction(async tx=>{
        const rows=await tx.list({prefix:'job:'});
        for(const m of rows.values()){
          await this.removeChunks(tx,m.id,'input',m.inputChunks);await this.removeChunks(tx,m.id,'result',m.resultChunks);await tx.delete(metaKey(m.id));
        }
        await tx.put('purged',true);
        await tx.put('purgeToken',purgeToken);
      });
      return reply({ok:true,purgeToken});
    }
    if(url.pathname==='/reactivate'&&request.method==='POST') {
      // Private Worker recovery only, after a fresh server verification that
      // Auth deletion failed and this exact account is still active. An older
      // failed deletion cannot reopen a newer purge. No old jobs are restored.
      if(request.headers.get('x-nudge-internal')!=='true')return reply({code:'route_not_found'},404);
      let body;try{body=await request.json();}catch{return reply({code:'request_invalid'},400);}
      if(!body||Object.keys(body).length!==1||!CAPTURE_ID.test(body.purgeToken||''))return reply({code:'request_invalid'},400);
      const reactivated=await this.transaction(async tx=>{
        if(await tx.get('purged')!==true||await tx.get('purgeToken')!==body.purgeToken)return false;
        await tx.delete(['purged','purgeToken']);return true;
      });
      return reply({ok:reactivated},reactivated?200:409);
    }
    if(!CAPTURE_ID.test(id))return reply({code:'request_invalid',message:'Invalid capture reference.'},400);
    if(await this.storage.get('purged'))return reply({code:'capture_account_deleted',message:'This account has been deleted.'},410);
    if(retry&&request.method==='POST'){
      const m=await this.transaction(async tx=>{
        if(await tx.get('purged'))return {status:'account_deleted'};
        const current=await this.expire(tx,await tx.get(metaKey(id)));
        if(current?.status==='retryable_failure'&&(current.retryNotBefore||0)<=this.now()){
          current.status='queued';current.attempts=0;current.nextRetryAt=this.now();
          // Only an explicit retry opens a fresh paid attempt. Keep lifetime
          // counts; retries must not hide earlier billed/ambiguous attempts.
          if(current.fastPolicy){current.providerDispatchCount=0;current.providerStages=[];delete current.lastTrace;}
          await tx.put(metaKey(id),current);
        }
        return current;
      });
      return this.response(m);
    }
    if(retry)return reply({code:'route_not_found'},404);
    if(request.method==='GET')return this.response(await this.transaction(async tx=>
      await tx.get('purged')?{status:'account_deleted'}:this.expire(tx,await tx.get(metaKey(id)))));
    if(request.method==='DELETE') {
      const deleted=await this.transaction(async tx=>{
        if(await tx.get('purged'))return false;
        const m=await tx.get(metaKey(id));
        if(m){await this.removeChunks(tx,id,'input',m.inputChunks);await this.removeChunks(tx,id,'result',m.resultChunks);}
        await tx.put(metaKey(id),{id,status:'deleted',expiresAt:this.now()+RETENTION_MS});return true;
      });
      return deleted?reply({ok:true}):this.response({status:'account_deleted'});
    }
    if(request.method!=='POST')return reply({code:'route_not_found'},404);
    // Only the authenticated Worker calls this binding after validating upload size/type.
    const {owner,body}=await request.json();
    if(owner!=='private-owner'&&!/^[a-f0-9]{64}$/.test(owner||''))return reply({code:'authentication_required'},401);
    const text=JSON.stringify(stable(body)),inputHash=await digest(text),inputBytes=new TextEncoder().encode(text).byteLength;
    const legacyInputHash=isFastCapture(body)?await digest(JSON.stringify(stable(Object.fromEntries(Object.entries(body).filter(([key])=>key!=='analysisPolicy'))))):null;
    const {m,failure}=await this.transaction(async tx=>{
      if(await tx.get('purged'))return {failure:410};
      const now=this.now(),rows=await this.sweep(tx,now),previous=rows.get(metaKey(id));
      if(previous){
        if(!['deleted','expired'].includes(previous.status)&&previous.inputHash&&previous.inputHash!==inputHash
          &&!(!previous.fastPolicy&&legacyInputHash===previous.inputHash))return {failure:409};
        // A header-only fast upload may have been accepted by the previous
        // server before its acknowledgement was lost. Preserve that exact job's
        // legacy policy; only a new submission can opt into different behavior.
        return {m:previous};
      }
      const pending=[...rows.values()].filter(v=>v.inputChunks>0);
      if(pending.length>=MAX_PENDING||pending.reduce((sum,v)=>sum+(v.inputBytes||0),0)+inputBytes>MAX_BYTES)return {failure:507};
      const inputChunks=await this.putChunks(tx,id,'input',text);
      const metadata={id,owner,inputHash,inputChunks,inputBytes,createdAt:now,status:'queued',attempts:0,nextRetryAt:now,
        ...(isFastCapture(body)?{fastPolicy:true,providerDispatchCount:0,providerStages:[],paidCallCountTotal:0,totalAttempts:0}:{})};
      await tx.put(metaKey(id),metadata);return {m:metadata};
    });
    if(failure)return reply({code:failure===409?'capture_conflict':failure===507?'capture_queue_full':'capture_account_deleted',
      message:failure===409?'The capture was edited. Use a new analysis reference.':failure===507?'Your capture is saved on your device. The server queue is full; retry later.':'This account has been deleted.'},failure);
    return this.response(m);
  }
  async alarm() {
    const job=await this.transaction(async tx=>{
      if(await tx.get('purged'))return;
      const now=this.now(),rows=await this.sweep(tx,now);
      const due=[...rows.values()].filter(m=>m.status==='queued'&&m.nextRetryAt<=now||m.status==='processing'&&m.leaseUntil<=now)
        .sort((a,b)=>a.createdAt-b.createdAt)[0];
      if(!due)return;
      if(due.fastPolicy&&due.status==='processing'&&due.providerDispatchCount>0){
        // A worker may have died after the provider accepted its request. No
        // lease expiry, restart or poll may silently submit that paid work again.
        await tx.put(metaKey(due.id),{...due,status:'retryable_failure',errorCode:'capture_retry_required',
          nextRetryAt:now,retryNotBefore:now,lease:null,leaseUntil:null});return;
      }
      const claimed={...due,status:'processing',attempts:due.attempts+1,
        ...(due.fastPolicy?{totalAttempts:(due.totalAttempts||0)+1}:{}),lease:crypto.randomUUID(),leaseUntil:now+LEASE_MS};
      await tx.put(metaKey(claimed.id),claimed);return claimed;
    });
    if(!job)return;
    // Recovery and retention were armed in the claim transaction, before work.
    const started=this.now();
    try {
      const body=JSON.parse(await this.readChunks(job.id,'input',job.inputChunks));
      if(this.retentionAt(job)<=this.now()){
        await this.transaction(async tx=>{
          if(!await tx.get('purged'))await this.expire(tx,await tx.get(metaKey(job.id)));
        });return;
      }
      const beforeProviderCall=async kind=>this.transaction(async tx=>{
        if(await tx.get('purged'))throw Object.assign(new Error('Capture removed'),{status:410,code:'capture_gone'});
        const current=await this.expire(tx,await tx.get(metaKey(job.id)));
        if(current?.lease!==job.lease||current.status!=='processing'||current.leaseUntil<=this.now())
          throw Object.assign(new Error('Capture attempt changed'),{status:409,code:'capture_conflict'});
        if(current.fastPolicy){
          const stages=current.providerStages||[];
          if(!['observation','transcription'].includes(kind)||stages.includes(kind))
            throw Object.assign(new Error('Explicit retry required'),{status:503,code:'capture_retry_required'});
          await tx.put(metaKey(job.id),{...current,providerDispatchCount:(current.providerDispatchCount||0)+1,
            paidCallCountTotal:(current.paidCallCountTotal||0)+1,providerStages:[...stages,kind]});
        }
      });
      const result=await this.process(body,AbortSignal.timeout(55_000),{owner:job.owner,captureId:job.id,beforeProviderCall});
      const saved=await this.transaction(async tx=>{
        if(await tx.get('purged'))return false;
        const current=await this.expire(tx,await tx.get(metaKey(job.id)));
        if(current?.lease!==job.lease||current.status!=='processing')return false;
        const resultChunks=await this.putChunks(tx,job.id,'result',JSON.stringify(result));
        await this.removeChunks(tx,job.id,'input',job.inputChunks);
        await tx.put(metaKey(job.id),{...current,status:'complete',completedAt:this.now(),inputChunks:0,inputBytes:0,resultChunks,lease:null,leaseUntil:null});return true;
      });
      if(saved)console.info(JSON.stringify({event:'private_capture_job',outcome:'complete',attempt:job.attempts,durationMs:this.now()-started}));
    } catch(error) {
      const status=Number(error.status)||503,retryable=[408,425,429,500,502,503,504].includes(status);
      const code=/^[a-z0-9_]{1,80}$/.test(error.code||'')?error.code:'analysis_retryable';
      const retryMs=Math.max(Number(error.retryAfter||0)*1000,Math.min(15*60000,5000*2**Math.min(job.attempts,7))*(0.8+Math.random()*0.4));
      const saved=await this.transaction(async tx=>{
        if(await tx.get('purged'))return false;
        const current=await this.expire(tx,await tx.get(metaKey(job.id)));
        if(current?.lease!==job.lease||current.status!=='processing')return false;
        const manual=current.fastPolicy&&current.providerDispatchCount>0;
        const lastTrace=error.trace&&typeof error.trace==='object'&&JSON.stringify(error.trace).length<=24_000?error.trace:null;
        await tx.put(metaKey(job.id),{...current,status:retryable?(manual||job.attempts>=MAX_ATTEMPTS?'retryable_failure':'queued'):'needs_input',
          ...(lastTrace?{lastTrace}:{}),
          errorCode:code,retryNotBefore:this.now()+Math.max(0,Number(error.retryAfter||0)*1000),
          nextRetryAt:this.now()+Math.max(retryMs,job.attempts>=MAX_ATTEMPTS?15*60000:0),lease:null,leaseUntil:null});return true;
      });
      if(saved)console.info(JSON.stringify({event:'private_capture_job',outcome:retryable?'retry':'needs_input',attempt:job.attempts,code,durationMs:this.now()-started}));
    }
  }
}
