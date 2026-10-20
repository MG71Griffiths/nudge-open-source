import {catalogueFetch, CatalogueNotFoundError} from './food-catalogue.js';
import {stableStringify, parseScoreResponse} from './product-score.js';
import {RECOVERY_PROMPT, recoverySchema, buildRecoveryContext} from './food-recovery.js';
import {ENRICHMENT_VERSION, evaluateCatalogueEnrichment} from './catalogue-enrichment-evidence.js';
import {LABEL_EVIDENCE_VERSION, LABEL_EXTRACTION_PROMPT, labelExtractionSchema, publicCatalogueLabelImages} from './catalogue-label-evidence.js';

const DAY=86_400_000,STATE='enrichment-runner-v1',BUDGET='enrichment-budget-v1';
const cap=(value,fallback,max)=>/^[0-9]+$/.test(String(value??''))?Math.min(max,Number(value)):fallback;
const indexFor=env=>env.FOOD_CATALOGUE_INDEX?.get(env.FOOD_CATALOGUE_INDEX.idFromName('uk-public-products-v1'),{locationHint:'weur'});
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stableStringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
async function boundedJSON(response,max=40000){
  const reader=response.body?.getReader();if(!reader)throw new Error('empty_response');
  let length=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>max){await reader.cancel();throw new Error('response_too_large');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const all=new Uint8Array(length);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));
}
export async function extractCatalogueEvidence(raw,evaluation,env,{fetchImpl=fetch,signal}={}){
  const images=publicCatalogueLabelImages(raw),context=evaluation.recoveryContext||buildRecoveryContext(evaluation.product);
  const choiceSchema={...recoverySchema,properties:{...recoverySchema.properties,recordId:{...recoverySchema.properties.recordId,
    enum:[null,...new Set((context.candidates||[]).map(candidate=>candidate.id).filter(id=>typeof id==='string'))]}}};
  const schema={type:'object',additionalProperties:false,properties:{recovery:choiceSchema,label:images.length?{anyOf:[labelExtractionSchema,{type:'null'}]}:{type:'null'}},required:['recovery','label']};
  const content=[{type:'input_text',text:JSON.stringify({context,images:images.map((image,index)=>({index,role:image.role})),task:'Recover category/source choice and, when images are provided, transcribe their printed label. Unknown stays null.'})},
    ...images.map(image=>({type:'input_image',image_url:image.url,detail:'high'}))];
  const response=await fetchImpl('https://api.openai.com/v1/responses',{method:'POST',redirect:'manual',signal:signal||AbortSignal.timeout(35000),
    headers:{authorization:'Bearer '+env.OPENAI_API_KEY,'content-type':'application/json'},
    body:JSON.stringify({model:env.OPENAI_MODEL,store:false,temperature:0,max_output_tokens:3000,
      instructions:'The following recovery instructions apply to the recovery object only:\n'+RECOVERY_PROMPT+'\nThe following instructions apply to the label object only. Literal printed nutrient transcription is permitted here; inferred or invented nutrition is never permitted:\n'+LABEL_EXTRACTION_PROMPT+'\nReturn recovery and label. The recovery evidence must quote supplied facts. No images means label:null.',
      input:[{role:'user',content}],text:{format:{type:'json_schema',name:'catalogue_evidence',strict:true,schema}}})});
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw Object.assign(new Error('enrichment_ai_unavailable'),{retryAfter:response.status===429?600000:60000});}
  const payload=await boundedJSON(response),choice=parseScoreResponse(payload);
  if(!choice||Object.keys(choice).length!==2||!choice.recovery||!Object.hasOwn(choice,'label'))throw new Error('enrichment_ai_invalid');
  const {recordId,reason,...classification}=choice.recovery;
  if(!recoverySchema.properties.reason.enum.includes(reason)||recordId&&reason!=='compatible_generic_estimate')throw new Error('enrichment_ai_invalid');
  const evidence={classification,...(recordId?{compositionRecordId:recordId}:{})};
  if(choice.label!==null)evidence.nutritionEvidence={version:LABEL_EVIDENCE_VERSION,barcode:String(raw.code),sourceRevision:raw.last_modified_t??null,
    sourceURL:`https://world.openfoodfacts.org/product/${raw.code}`,images,extraction:choice.label};
  return {evidence,usage:{inputTokens:cap(payload.usage?.input_tokens,0,1000000),outputTokens:cap(payload.usage?.output_tokens,0,1000000)}};
}

// A separate durable runner never takes the user's scan/photo quota lease and
// never owns the thumbnail alarm. Its own hard daily budget includes failures.
export class CatalogueEnrichmentRunner {
  constructor(ctx,env,{now=Date.now,evaluate=evaluateCatalogueEnrichment,lookup=catalogueFetch,extract=extractCatalogueEvidence}={}){
    this.ctx=ctx;this.env=env;this.now=now;this.evaluate=evaluate;this.lookup=lookup;this.extract=extract;this.running=false;
  }
  async call(action,body){const index=indexFor(this.env);if(!index)throw new Error('enrichment_store_unavailable');
    const response=await index.fetch('https://catalogue-index/enrichment/'+action,{method:'POST',body:JSON.stringify(body)});
    if(!response.ok)throw new Error('enrichment_store_unavailable');return response.json();}
  async status(){const state=await this.ctx.storage.get(STATE)||{},budget=await this.ctx.storage.get(BUDGET)||{};
    return {version:ENRICHMENT_VERSION,...state,nextRunAt:await this.ctx.storage.getAlarm(),budget:{...budget,
      aiDailyLimit:cap(this.env.ENRICHMENT_AI_DAILY_LIMIT,100,1000),sourceDailyLimit:cap(this.env.ENRICHMENT_SOURCE_DAILY_LIMIT,200,2000)}};}
  async fetch(request){
    const url=new URL(request.url);
    if(url.search)return Response.json({code:'enrichment_request_invalid'},{status:400});
    if(request.method==='GET'&&url.pathname==='/status')return Response.json(await this.status());
    if(request.method!=='POST'||!['/start','/ensure','/pause'].includes(url.pathname))return Response.json({code:'route_not_found'},{status:404});
    const input=await request.text();if(input.length>32||!['','{}'].includes(input.trim()))return Response.json({code:'enrichment_request_invalid'},{status:400});
    const state=await this.ctx.storage.get(STATE)||{},now=this.now();
    if(url.pathname==='/pause'){await this.ctx.storage.put(STATE,{...state,paused:true});await this.ctx.storage.deleteAlarm();return Response.json({paused:true});}
    if(this.env.ENRICHMENT_ENABLED!=='true')return Response.json({status:'disabled'},{status:202});
    if(state.paused&&url.pathname==='/ensure')return Response.json({status:'paused'},{status:202});
    if(url.pathname==='/start')await this.ctx.storage.put(STATE,{...state,paused:false});
    const alarm=await this.ctx.storage.getAlarm();
    if(alarm===null||alarm<now-180000||url.pathname==='/start'&&!this.running)await this.ctx.storage.setAlarm(now+1);
    return Response.json({status:'scheduled',version:ENRICHMENT_VERSION},{status:202});
  }
  async reserve(kind){
    const now=this.now(),day=Math.floor(now/DAY),limit=kind==='ai'?cap(this.env.ENRICHMENT_AI_DAILY_LIMIT,100,1000):cap(this.env.ENRICHMENT_SOURCE_DAILY_LIMIT,200,2000);
    return this.ctx.storage.transaction(async tx=>{
      const previous=await tx.get(BUDGET)||{},b=previous.day===day?previous:{day,ai:0,source:0,inputTokens:0,outputTokens:0,nextAIAt:previous.nextAIAt||0,nextSourceAt:previous.nextSourceAt||0};
      if(kind==='ai'&&b.nextAIAt>now)return {allowed:false,retryAt:b.nextAIAt,reason:'provider_cooldown'};
      if((b[kind]||0)>=limit)return {allowed:false,retryAt:(day+1)*DAY+1000};
      if(kind==='source'&&b.nextSourceAt>now)return {allowed:false,retryAt:Math.max(now+60000,b.nextSourceAt),reason:'provider_cooldown'};
      b[kind]=(b[kind]||0)+1;if(kind==='source')b.nextSourceAt=now+6500;
      await tx.put(BUDGET,b);return {allowed:true};
    });
  }
  async usage(value){await this.ctx.storage.transaction(async tx=>{const b=await tx.get(BUDGET)||{};
    for(const key of ['inputTokens','outputTokens'])b[key]=(b[key]||0)+cap(value?.[key],0,1000000);await tx.put(BUDGET,b);});}
  async cooldown(milliseconds,kind='ai'){await this.ctx.storage.transaction(async tx=>{const b=await tx.get(BUDGET)||{},field=kind==='source'?'nextSourceAt':'nextAIAt';
    b[field]=Math.max(b[field]||0,this.now()+Math.min(DAY-1000,Math.max(65000,milliseconds)));await tx.put(BUDGET,b);});}
  async process(job){
    const source=job.sourceRow,raw=JSON.parse(source.provider_json),base={id:job.id,leaseToken:job.leaseToken,sourceFingerprint:job.sourceFingerprint};
    let result=await this.evaluate(raw,{now:this.now()}),evidence={};
    const finish=async(outcome,extra={})=>this.call('complete',{...base,outcome,...extra,...(outcome==='deferred'?{retryAt:Math.min(this.now()+DAY-1000,Math.max(this.now()+65000,extra.retryAt))}:{})});
    if(result.score?.available)return finish('evidence',{evidence});
    if(result.outcome==='unsupported')return finish('evidence',{evidence});
    // A global exact-barcode lookup can repair country/subset or newer label
    // omissions. Only genuinely newer/different source facts enter retention.
    const importedWithoutLabels=!publicCatalogueLabelImages(raw).length&&/^https:\/\/static\.openfoodfacts\.org\/data\//.test(source.import_source_url||'');
    if(source.fetched_at<this.now()-DAY||importedWithoutLabels){
      const permission=await this.reserve('source');
      if(!permission.allowed)return finish('deferred',{errorCode:permission.reason||'enrichment_budget',retryAt:permission.retryAt});
      try{
        const fresh=await this.lookup(job.barcode,{now:this.now()}),updated=fresh.providerPayload.product;
        const sourceFingerprint=await digest(updated);
        if(sourceFingerprint!==job.sourceFingerprint){
          const index=indexFor(this.env),response=await index.fetch('https://catalogue-index/retain',{method:'POST',body:JSON.stringify({product:updated,sourceURL:fresh.product.sourceURL,fetchedAt:fresh.fetchedAt})});
          if(!response.ok)throw new Error('enrichment_store_unavailable');
          await this.call('refresh',{id:job.id,leaseToken:job.leaseToken,sourceFingerprint});
          return finish('unresolved'); // Completion notices superseded snapshot.
        }
      }catch(error){
        if(error.catalogueStatus===429){await this.cooldown(error.retryAfter||600000,'source');return finish('deferred',{errorCode:'provider_cooldown',retryAt:this.now()+(error.retryAfter||600000)});}
        if(!(error instanceof CatalogueNotFoundError))return finish('retryable_error',{errorCode:'source_unavailable'});
      }
    }
    const context=result.recoveryContext||buildRecoveryContext(result.product),images=publicCatalogueLabelImages(raw);
    if(!images.length&&result.classification?.category!=='unknown'&&(context.candidates?.length||0)<=1)return finish('evidence',{evidence});
    if(!this.env.OPENAI_API_KEY||!this.env.OPENAI_MODEL)return finish('retryable_error',{errorCode:'analysis_unavailable'});
    const permission=await this.reserve('ai');
    if(!permission.allowed)return finish('deferred',{errorCode:permission.reason||'enrichment_budget',retryAt:permission.retryAt});
    try{
      const extracted=await this.extract(raw,result,this.env);await this.usage(extracted.usage);evidence=extracted.evidence;
      result=await this.evaluate(raw,{...evidence,now:this.now()});
      return finish('evidence',{evidence});
    }catch(error){
      if(error.retryAfter){await this.cooldown(error.retryAfter);return finish('deferred',{errorCode:'provider_cooldown',retryAt:this.now()+error.retryAfter});}
      const errorCode=error.message==='Invalid public label evidence'?'invalid_evidence'
        :error.message==='Composition source was not needed'?'unneeded_composition'
        :error.message==='Composition source was not offered'?'incompatible_source'
        :['TimeoutError','AbortError'].includes(error.name)?'analysis_timeout'
        :error.code==='upstream_invalid_response'||error.message==='enrichment_ai_invalid'?'analysis_response_invalid':'analysis_unavailable';
      return finish('retryable_error',{errorCode});
    }
  }
  async alarm(){
    if(this.running)return;const previous=await this.ctx.storage.get(STATE)||{};
    if(previous.paused||this.env.ENRICHMENT_ENABLED!=='true')return;
    this.running=true;const began=this.now();let completed=0,lastError=null;
    await this.ctx.storage.put(STATE,{...previous,lastRunAt:began,runningUntil:began+180000});
    await this.ctx.storage.setAlarm(began+180000);
    try{
      // Two bounded 35-second analysis calls plus 6-second source lookups
      // finish comfortably inside the three-minute source/lease guard.
      const response=await this.call('claim',{limit:2});
      for(const job of response.jobs||[]){await this.process(job);completed++;}
    }catch{lastError='enrichment_runner_failed';}
    finally{
      this.running=false;const finishedAt=this.now(),state=await this.ctx.storage.get(STATE)||{};
      await this.ctx.storage.put(STATE,{...state,status:lastError?'retrying':completed?'running':'idle',finishedAt,runningUntil:null,
        processed:(previous.processed||0)+completed,lastError});
      if(!state.paused)await this.ctx.storage.setAlarm(finishedAt+(lastError||!completed?60000:2000));
    }
  }
}
export function catalogueEnrichmentRunnerStub(env){return env.CATALOGUE_ENRICHMENT_RUNNER?.get(env.CATALOGUE_ENRICHMENT_RUNNER.idFromName('catalogue-evidence-v1'),{locationHint:'weur'})||null;}
