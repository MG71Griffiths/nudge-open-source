#!/usr/bin/env node
'use strict';
// Report supplied measurements only. This tool does not invoke inference or
// manufacture scans, timings, reference nutrition, billing or device evidence.
const fs=require('node:fs');
const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const routes=['barcode','label','recipe','meal'];
function assert(condition,message){if(!condition)throw new Error(message);}
function percentile(values,p){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),value=sorted[Math.ceil(p*sorted.length)-1];return Number.isFinite(value)?value:null;}
function report(manifest,runs){
  assert(manifest?.version==='fast-capture-benchmark-v1'&&Array.isArray(manifest.cases),'Invalid benchmark manifest');
  assert(manifest.cases.length>0&&manifest.cases.length<=10_000,'Manifest needs 1–10,000 cases');
  const cases=new Map();
  for(const c of manifest.cases){assert(typeof c.id==='string'&&/^[a-zA-Z0-9._-]{1,100}$/.test(c.id)&&!cases.has(c.id),'Invalid/duplicate case identity');assert(routes.includes(c.route)&&typeof c.supportedClear==='boolean'&&['verified','unverified'].includes(c.referenceStatus),'Invalid case classification');cases.set(c.id,c);}
  if(manifest.cachedCaseIds!=null)assert(Array.isArray(manifest.cachedCaseIds)&&manifest.cachedCaseIds.length<=cases.size&&new Set(manifest.cachedCaseIds).size===manifest.cachedCaseIds.length&&manifest.cachedCaseIds.every(id=>cases.has(id)),'Cached case plan must list unique declared case IDs');
  if(manifest.measurementWindow!=null){const w=manifest.measurementWindow;assert(typeof w.start==='string'&&typeof w.end==='string'&&w.start.length<=40&&w.end.length<=40&&Number.isFinite(Date.parse(w.start))&&Date.parse(w.end)>Date.parse(w.start),'Invalid declared measurement window');}
  assert(Array.isArray(runs)&&runs.length<=100_000,'Invalid measurement list');
  const ids=new Set(),deviceCohorts=new Map(),analysisBindings=new Map();
  for(const r of runs){
    assert(typeof r.runId==='string'&&r.runId.length<=100&&!ids.has(r.runId)&&cases.has(r.caseId),'Invalid/duplicate run identity');ids.add(r.runId);
    assert(['physical_device','simulator','synthetic'].includes(r.measurementKind)&&['wifi','mobile','offline'].includes(r.network)&&['cold','warm'].includes(r.temperature),'Invalid measurement environment');
    assert(typeof r.deviceClass==='string'&&r.deviceClass.length>0&&r.deviceClass.length<=100,'A device class is required, without device identifiers');
    if(r.deviceCohort!=null){assert(['older','newer'].includes(r.deviceCohort),'Device cohort must be older or newer');assert(!deviceCohorts.has(r.deviceClass)||deviceCohorts.get(r.deviceClass)===r.deviceCohort,'A device class cannot change cohort');deviceCohorts.set(r.deviceClass,r.deviceCohort);}
    if(r.ownerPhone!=null)assert(typeof r.ownerPhone==='boolean','Owner-phone role must be boolean');
    for(const [key,prefix] of [['analysisGroup','a'],['userGroup','u']])if(r[key]!=null)assert(typeof r[key]==='string'&&new RegExp('^'+prefix+'_[a-f0-9]{16,64}$').test(r[key]),'Use opaque pseudonymous benchmark groups, not account identifiers');
    if(r.attemptKind!=null)assert(['initial','retry'].includes(r.attemptKind),'Attempt kind must be initial or retry');
    if(r.analysisGroup){const prior=analysisBindings.get(r.analysisGroup);assert(!prior||prior.caseId===r.caseId&&(!prior.userGroup||!r.userGroup||prior.userGroup===r.userGroup),'A logical analysis cannot change case or user group');analysisBindings.set(r.analysisGroup,{caseId:r.caseId,userGroup:r.userGroup||prior?.userGroup});}
    for(const key of ['model','promptVersion'])if(r[key]!=null)assert(typeof r[key]==='string'&&r[key].length>0&&r[key].length<=100,'Invalid model or prompt version');
    assert(['complete','partial','error','timeout','cancelled'].includes(r.outcome)&&typeof r.validated==='boolean'&&typeof r.nutrientsComplete==='boolean'&&typeof r.cached==='boolean','Invalid measurement outcome');
    for(const key of ['captureToResultMs','analyseToResultMs'])assert(r[key]===null||finite(r[key]),'Duration must be a measured nonnegative number or null');
    assert(Number.isInteger(r.cloudCallCount)&&r.cloudCallCount>=0&&r.cloudCallCount<=20,'Invalid model call count');
    if(r.cost!=null)assert(['USD','GBP','EUR'].includes(r.cost.currency)&&finite(r.cost.actualBilled)&&['provider_usage','invoice'].includes(r.cost.billingSource),'Only observed billing with its source is accepted');
    if(r.accuracy!=null)assert(cases.get(r.caseId).referenceStatus==='verified'&&Number.isInteger(r.accuracy.fieldsChecked)&&r.accuracy.fieldsChecked>=0&&Number.isInteger(r.accuracy.fieldsCorrect)&&r.accuracy.fieldsCorrect>=0&&r.accuracy.fieldsCorrect<=r.accuracy.fieldsChecked,'Accuracy needs a verified reference and valid counts');
  }
  const physical=runs.filter(r=>r.measurementKind==='physical_device'),byCase=new Set(physical.map(r=>r.caseId));
  const missedCases=manifest.cases.filter(c=>!byCase.has(c.id));
  const candidate=r=>r.outcome==='complete'&&r.validated&&r.nutrientsComplete;
  // A known reference mismatch is a miss, even if a caller marked JSON valid.
  const usable=r=>candidate(r)&&(!r.accuracy||r.accuracy.fieldsChecked===r.accuracy.fieldsCorrect);
  // Barcodes have no Analyse tap. Their capture anchor is accepted decoding or
  // validated manual entry; never fill a missing duration from the other clock.
  const targetDuration=r=>cases.get(r.caseId).route==='barcode'?r.captureToResultMs:r.analyseToResultMs;
  function summary(rows,unmeasured=0){
    const physicalOnly=rows.every(r=>r.measurementKind==='physical_device');
    const complete=rows.filter(usable),denominator=rows.length+unmeasured;
    const durations=key=>rows.map(r=>usable(r)&&finite(r[key])?r[key]:Infinity).concat(Array(unmeasured).fill(Infinity));
    const targetDurations=rows.map(r=>usable(r)&&finite(targetDuration(r))?targetDuration(r):Infinity).concat(Array(unmeasured).fill(Infinity));
    const within5Seconds=complete.filter(r=>finite(targetDuration(r))&&targetDuration(r)<=5000).length;
    const costs=rows.filter(r=>r.cost!=null),currencies=[...new Set(costs.map(r=>r.cost.currency))];
    const knownCost=currencies.length===1?costs.reduce((sum,r)=>sum+r.cost.actualBilled,0):null;
    const checked=rows.reduce((sum,r)=>sum+(r.accuracy?.fieldsChecked||0),0),correct=rows.reduce((sum,r)=>sum+(r.accuracy?.fieldsCorrect||0),0);
    const allCosts=costs.length===rows.length&&rows.length>0&&currencies.length===1;
    return {attempts:rows.length,unmeasuredCases:unmeasured,denominator,complete:complete.length,partial:rows.filter(r=>r.outcome==='partial').length,
      errors:rows.filter(r=>r.outcome==='error').length,timeouts:rows.filter(r=>r.outcome==='timeout').length,cancelled:rows.filter(r=>r.outcome==='cancelled').length,
      invalidComplete:rows.filter(r=>r.outcome==='complete'&&!usable(r)).length,
      completeWithin5Seconds:within5Seconds,
      completeWithin5SecondsRate:denominator?within5Seconds/denominator:null,
      captureToComplete:{p50Ms:physicalOnly?percentile(durations('captureToResultMs'),.5):null,p95Ms:physicalOnly?percentile(durations('captureToResultMs'),.95):null},
      analyseToComplete:{p50Ms:physicalOnly?percentile(durations('analyseToResultMs'),.5):null,p95Ms:physicalOnly?percentile(durations('analyseToResultMs'),.95):null},
      targetToComplete:{p50Ms:physicalOnly?percentile(targetDurations,.5):null,p95Ms:physicalOnly?percentile(targetDurations,.95):null,
        basis:'Barcode: captureToResultMs from accepted decode or validated manual entry. Label, recipe and meal: analyseToResultMs from Analyse tap. Missing selected duration is a miss; raw clocks remain separate.'},
      percentilePolicy:'All failures, partials, invalid/incomplete results, missing durations and unmeasured cases are infinite misses. Null means rank not reached or no physical-device evidence.',
      cloudCalls:rows.reduce((sum,r)=>sum+r.cloudCallCount,0),cacheHitRate:rows.length?rows.filter(r=>r.cached).length/rows.length:null,
      accuracy:{fieldsChecked:checked,fieldsCorrect:correct,rate:checked?correct/checked:null},
      cost:{currency:currencies.length===1?currencies[0]:null,knownBilledSubtotal:knownCost,attemptsWithoutBilling:rows.length-costs.length,completeBilling:allCosts,
        perSuccessfulUncachedAnalysis:null,perSuccessfulUncachedAttempt:allCosts&&rows.every(r=>!r.cached)&&complete.length?knownCost/complete.length:null}};
  }
  const groups=new Map();
  for(const r of physical){const key=[cases.get(r.caseId).route,r.deviceClass,r.network,r.temperature,r.cached?'cached':'uncached',r.model||'not-recorded',r.promptVersion||'not-recorded'].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  const supported=physical.filter(r=>cases.get(r.caseId).supportedClear),supportedMissing=missedCases.filter(c=>c.supportedClear).length;
  const uncached=physical.filter(r=>!r.cached),cachedRuns=physical.filter(r=>r.cached);
  function qualification(rows,expectedIDs,cachedCohort=false){
    const expected=new Set(expectedIDs),measured=new Set(rows.map(r=>r.caseId)),checks={heldOut:manifest.heldOut===true,...(cachedCohort?{casePlanDeclared:expected.size>0}:{atLeast100Cases:expected.size>=100}),
      everyCaseMeasured:expectedIDs.every(id=>measured.has(id)),verifiedReferences:expectedIDs.every(id=>cases.get(id).referenceStatus==='verified'),
      completeResultAccuracy:rows.filter(candidate).every(r=>r.accuracy?.fieldsChecked>=8),
      modelSettings:rows.filter(r=>r.cloudCallCount>0).every(r=>r.model&&r.promptVersion),
      deviceCohorts:rows.length>0&&rows.every(r=>r.deviceCohort)&&new Set(rows.map(r=>r.deviceClass)).size>=2,
      ownerPhone:routes.every(route=>rows.some(r=>cases.get(r.caseId).route===route&&r.ownerPhone===true)),
      routeConditions:routes.every(route=>{const group=rows.filter(r=>cases.get(r.caseId).route===route);return ['older','newer'].every(v=>group.some(r=>r.deviceCohort===v))&&['cold','warm'].every(v=>group.some(r=>r.temperature===v))&&['wifi','mobile'].every(v=>group.some(r=>r.network===v));})};
    return {qualified:Object.values(checks).every(Boolean),checks,missingRequirements:Object.entries(checks).filter(([,ok])=>!ok).map(([key])=>key),
      expectedCases:expected.size,measuredCases:measured.size,completeResultsWithAccuracy:rows.filter(r=>candidate(r)&&r.accuracy?.fieldsChecked>=8).length,
      policy:'At least 100 held-out first-use cases; cached repeats use explicit cachedCaseIds with no invented minimum. Every planned case is measured; references are verified; complete validated results check at least 8 fields; cloud model/prompt is recorded. Each route includes the owner phone and covers older/newer cohorts, at least 2 device classes overall, cold/warm and Wi-Fi/mobile. Roles, references and representativeness require human review.'};
  }
  const cachedPlan=manifest.cachedCaseIds||[],cachedPlanSet=new Set(cachedPlan),plannedCached=cachedRuns.filter(r=>cachedPlanSet.has(r.caseId)),plannedCachedIDs=new Set(plannedCached.map(r=>r.caseId));
  const uncachedQualification=qualification(uncached,[...cases.keys()]),cachedQualification=qualification(plannedCached,cachedPlan,true),qualifying=uncachedQualification.qualified;
  const uncachedIDs=new Set(uncached.map(r=>r.caseId)),uncachedClear=summary(uncached.filter(r=>cases.get(r.caseId).supportedClear),manifest.cases.filter(c=>c.supportedClear&&!uncachedIDs.has(c.id)).length);
  const total=summary(physical,missedCases.length),clear=summary(supported,supportedMissing),cached=summary(cachedRuns),plannedCachedSummary=summary(plannedCached,cachedPlan.filter(id=>!plannedCachedIDs.has(id)).length);
  const uncachedSummary=summary(uncached,manifest.cases.filter(c=>!uncachedIDs.has(c.id)).length),logical=new Map();
  for(const r of uncached)if(r.analysisGroup){if(!logical.has(r.analysisGroup))logical.set(r.analysisGroup,[]);logical.get(r.analysisGroup).push(r);}
  // A cached retry may recover the completed response after a lost initial
  // acknowledgement. It belongs to that first-use analysis; a separately
  // planned cached initial/repeat does not.
  for(const r of cachedRuns)if(r.attemptKind==='retry'&&logical.has(r.analysisGroup))logical.get(r.analysisGroup).push(r);
  const logicalRows=[...logical.values()].flat(),logicalSummary=summary(logicalRows);
  const groupsComplete=uncached.length>0&&uncached.every(r=>r.analysisGroup&&r.attemptKind)
    &&[...logical.values()].every(rows=>rows.filter(r=>r.attemptKind==='initial'&&!r.cached).length===1);
  const successfulAnalyses=[...logical.values()].filter(rows=>rows.some(usable)).length;
  const measuredLogicalCost=groupsComplete&&logicalSummary.cost.completeBilling;
  const perSuccess=measuredLogicalCost&&successfulAnalyses?logicalSummary.cost.knownBilledSubtotal/successfulAnalyses:null;
  uncachedSummary.cost.perSuccessfulUncachedAnalysis=perSuccess;
  if(physical.every(r=>!r.cached))total.cost.perSuccessfulUncachedAnalysis=perSuccess;
  const users=new Set(physical.filter(r=>r.userGroup).map(r=>r.userGroup)),unknownUsers=physical.filter(r=>!r.userGroup).length;
  const costAccounting={uncachedLogicalAnalyses:{observedGroups:logical.size,successfulGroups:successfulAnalyses,completeAttemptGrouping:groupsComplete,
      attemptsWithoutGroup:uncached.filter(r=>!r.analysisGroup).length,attemptsWithoutRetryClassification:uncached.filter(r=>!r.attemptKind).length,
      includedAttempts:logicalRows.length,cachedRetryAttempts:logicalRows.filter(r=>r.cached).length,
      knownBilledSubtotal:logicalSummary.cost.knownBilledSubtotal,attemptsWithoutBilling:logicalSummary.cost.attemptsWithoutBilling,completeBilling:logicalSummary.cost.completeBilling,
      perSuccessfulAnalysis:perSuccess,perAnalysisIncludingFailures:measuredLogicalCost?logicalSummary.cost.knownBilledSubtotal/logical.size:null,currency:logicalSummary.cost.currency},
    retries:summary(physical.filter(r=>r.attemptKind==='retry')),failedOrPartialAttempts:summary(physical.filter(r=>!usable(r))),
    observedUsers:{pseudonymousGroups:users.size,attemptsWithoutGroup:unknownUsers,measurementWindow:manifest.measurementWindow||null,
      currency:total.cost.currency,billedCostPerObservedUserGroup:users.size&&unknownUsers===0&&total.cost.completeBilling?total.cost.knownBilledSubtotal/users.size:null,
      scope:'Only the supplied benchmark cohort; not production monthly active users or a subscription cost.'}};
  const projection=manifest.projection;
  let projectedMonthlyCost=null;
  if(projection&&Number.isSafeInteger(projection.activeUsers)&&projection.activeUsers>=0&&finite(projection.analysesPerUserMonth)&&measuredLogicalCost)projectedMonthlyCost={currency:logicalSummary.cost.currency,value:logicalSummary.cost.knownBilledSubtotal/logical.size*projection.activeUsers*projection.analysesPerUserMonth,basis:'Observed billed cost per uncached logical analysis, including failed attempts and all retries (including cached recovery); supplied monthly user/analysis assumptions. No inferred retry rate, cache savings, subscription price or missing billing.'};
  return {version:manifest.version,qualifyingHeldOutBenchmark:qualifying,qualification:{uncached:uncachedQualification,cached:cachedQualification},physical:total,uncached:uncachedSummary,supportedClear:clear,uncachedSupportedClear:uncachedClear,cached,plannedCached:plannedCachedSummary,costAccounting,groups:[...groups].map(([key,rows])=>({key,...summary(rows)})),
    nonPhysicalRuns:{synthetic:runs.filter(r=>r.measurementKind==='synthetic').length,simulator:runs.filter(r=>r.measurementKind==='simulator').length,devicePerformanceClaimed:false},
    unmeasuredCaseIds:missedCases.map(c=>c.id),projectedMonthlyCost,
    targets:{cachedP95Under1Second:qualifying&&cachedQualification.qualified?plannedCachedSummary.targetToComplete.p95Ms!==null&&plannedCachedSummary.targetToComplete.p95Ms<1000:null,clearCompleteWithin5Seconds95Percent:qualifying?uncachedClear.completeWithin5SecondsRate!==null&&uncachedClear.completeWithin5SecondsRate>=.95:null},
    limitations:['A manifest declaration is not independent proof of held-out sampling or reference accuracy.','Device breadth and image readability require human review of capture evidence.','No provider prices, unbilled plan usage or missing costs are invented.','Synthetic/simulator runs never establish physical-device latency.']};
}
module.exports={report};
if(require.main===module){
  try{const [manifestPath,runsPath]=process.argv.slice(2);assert(manifestPath&&runsPath,'Usage: node tools/fast-capture-benchmark.cjs MANIFEST.json RUNS.jsonl');const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')),runs=fs.readFileSync(runsPath,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));process.stdout.write(JSON.stringify(report(manifest,runs),null,2)+'\n');}
  catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
