import {captureSpendStop,captureReservationMicrousd,CAPTURE_PRICE_VERSION} from './capture-policy.js';

// Called only on the private quota binding. One active quota lease bounds this
// ledger to one pending call. Unsettled reservations remain charged when a worker
// dies or its lease expires; a late reply cannot refund a newer call or UTC day.
// Scope: photo analysis (including its explicit voice transcription) and typed
// food analysis, not public
// catalogue/scoring jobs or ChatGPT-plan requests. No monetary amount is enabled
// by default. This price-versioned admission stop is not a provider invoice cap.
export async function captureSpendAction(tx,env,action,body,now) {
  let stop;
  try { stop=captureSpendStop(env); }
  catch { return {allowed:false,code:'capture_spend_configuration'}; }
  if(stop===null)return {allowed:true,enabled:false};
  const validID=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value);
  if(!validID(body?.lease)||!validID(body?.callID))return {allowed:false,code:'capture_spend_unavailable'};
  const day=Math.floor(now/86_400_000),previous=await tx.get('capture-spend');
  const ledger=previous?.day===day?previous:{day,accountedMicrousd:0,pending:null};
  if(!Number.isSafeInteger(ledger.accountedMicrousd)||ledger.accountedMicrousd<0)
    return {allowed:false,code:'capture_spend_unavailable'};
  if(ledger.pending&&(!validID(ledger.pending.callID)||!validID(ledger.pending.lease)
    ||!Number.isSafeInteger(ledger.pending.reservedMicrousd)||ledger.pending.reservedMicrousd<0
    ||ledger.pending.reservedMicrousd>ledger.accountedMicrousd))return {allowed:false,code:'capture_spend_unavailable'};
  if(action==='settle'){
    const pending=ledger.pending;
    if(!pending||pending.callID!==body.callID||pending.lease!==body.lease)return {allowed:true,settled:false};
    if(body.costMicrousd!==null&&(!Number.isSafeInteger(body.costMicrousd)||body.costMicrousd<0||body.costMicrousd>1_000_000_000_000))
      return {allowed:false,code:'capture_spend_unavailable'};
    const actual=body.costMicrousd??pending.reservedMicrousd;
    await tx.put('capture-spend',{...ledger,accountedMicrousd:ledger.accountedMicrousd-pending.reservedMicrousd+actual,
      pending:null,lastSettledCall:body.callID,priceVersion:CAPTURE_PRICE_VERSION});
    return {allowed:true,settled:true,usageStatus:body.costMicrousd===null?'reserved_unknown':'reported'};
  }
  const quota=await tx.get('quota');
  if(quota?.lease!==body.lease||quota.leaseUntil<=now||ledger.lastSettledCall===body.callID)
    return {allowed:false,code:'capture_spend_unavailable'};
  const reservedMicrousd=captureReservationMicrousd(body.model,body.kind,body.maxOutputTokens);
  if(reservedMicrousd===null)return {allowed:false,code:'capture_spend_unpriced'};
  if(ledger.pending?.callID===body.callID&&ledger.pending.lease===body.lease)
    return {allowed:true,reservedMicrousd:ledger.pending.reservedMicrousd,enabled:true};
  if(ledger.pending?.lease===body.lease)return {allowed:false,code:'capture_spend_unavailable'};
  if(ledger.accountedMicrousd+reservedMicrousd>stop)
    return {allowed:false,code:'capture_spend_limit',retryAfter:Math.ceil(((day+1)*86_400_000-now)/1000)};
  await tx.put('capture-spend',{...ledger,accountedMicrousd:ledger.accountedMicrousd+reservedMicrousd,
    pending:{callID:body.callID,lease:body.lease,reservedMicrousd},priceVersion:CAPTURE_PRICE_VERSION});
  return {allowed:true,enabled:true,reservedMicrousd};
}
