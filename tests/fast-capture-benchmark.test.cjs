const {test}=require('node:test'),assert=require('node:assert/strict');
const {report}=require('../tools/fast-capture-benchmark.cjs');
const routes=['barcode','label','recipe','meal'];
const manifest=()=>({version:'fast-capture-benchmark-v1',heldOut:true,cases:Array.from({length:100},(_,i)=>({id:'held-'+i,route:routes[i%4],supportedClear:true,referenceStatus:'verified'}))});
// Invented records below exercise reporting logic only; no fixture is a device measurement.
const runs=()=>Array.from({length:100},(_,i)=>{const condition=Math.floor(i/4)%8,deviceCohort=condition&1?'newer':'older';return {runId:'run-'+i,caseId:'held-'+i,measurementKind:'physical_device',deviceClass:'synthetic '+deviceCohort,deviceCohort,ownerPhone:deviceCohort==='older',network:condition&2?'mobile':'wifi',temperature:condition&4?'warm':'cold',cached:false,outcome:'complete',validated:true,nutrientsComplete:true,captureToResultMs:4500,analyseToResultMs:routes[i%4]==='barcode'?null:4000,cloudCallCount:1,model:'synthetic-model',promptVersion:'synthetic-prompt-v1',analysisGroup:'a_'+i.toString(16).padStart(16,'0'),userGroup:'u_'+(i%5).toString(16).padStart(16,'0'),attemptKind:'initial',accuracy:{fieldsChecked:8,fieldsCorrect:8}};});
test('six failures prevent successful-only p95 and remain in complete-result denominator',()=>{const r=runs();for(let i=0;i<6;i++)Object.assign(r[i],{outcome:i%2?'partial':'timeout',captureToResultMs:null,analyseToResultMs:null});const result=report(manifest(),r);assert.equal(result.physical.targetToComplete.p95Ms,null);assert.equal(result.supportedClear.completeWithin5SecondsRate,.94);assert.equal(result.targets.clearCompleteWithin5Seconds95Percent,false);assert.equal(result.physical.cost.knownBilledSubtotal,null);});
test('unmeasured cases are misses and cannot disappear from a claimed held-out benchmark',()=>{const result=report(manifest(),runs().slice(0,90));assert.equal(result.qualifyingHeldOutBenchmark,false);assert.equal(result.physical.denominator,100);assert.equal(result.physical.unmeasuredCases,10);assert.equal(result.physical.targetToComplete.p95Ms,null);});
test('synthetic and simulator timings never produce a physical-device percentile',()=>{const r=runs().map((r,i)=>({...r,measurementKind:i%2?'synthetic':'simulator',analyseToResultMs:r.analyseToResultMs===null?null:1}));const result=report(manifest(),r);assert.equal(result.physical.analyseToComplete.p50Ms,null);assert.equal(result.physical.targetToComplete.p50Ms,null);assert.equal(result.physical.targetToComplete.p95Ms,null);assert.equal(result.qualifyingHeldOutBenchmark,false);assert.equal(result.nonPhysicalRuns.synthetic,50);assert.equal(result.targets.clearCompleteWithin5Seconds95Percent,null);});
test('cost remains unavailable unless billed values exist; failures count in observed cost per success',()=>{const m=manifest();m.projection={activeUsers:10,analysesPerUserMonth:30};const r=runs();for(const x of r)x.cost={currency:'USD',actualBilled:.001,billingSource:'provider_usage'};r[0].outcome='error';const result=report(m,r);assert.ok(Math.abs(result.physical.cost.perSuccessfulUncachedAnalysis-.1/99)<1e-12);assert.ok(Math.abs(result.projectedMonthlyCost.value-.3)<1e-12);delete r[0].cost;assert.equal(report(m,r).projectedMonthlyCost,null);});
test('unverified accuracy, duplicate runs and invalid costs are rejected',()=>{const m=manifest(),r=runs();m.cases[0].referenceStatus='unverified';r[0].accuracy={fieldsChecked:8,fieldsCorrect:8};assert.throws(()=>report(m,r));delete r[0].accuracy;r[1].runId=r[0].runId;assert.throws(()=>report(m,r));r[1].runId='unique';r[0].cost={currency:'USD',actualBilled:0,billingSource:'assumed_subscription_free'};assert.throws(()=>report(m,r));});
test('legacy files remain descriptive but missing reference and condition coverage prevents target claims',()=>{
  for(const [reason,change] of [
    ['verifiedReferences',(m,r)=>{for(const c of m.cases)c.referenceStatus='unverified';for(const x of r)delete x.accuracy;}],
    ['completeResultAccuracy',(_,r)=>{for(const x of r)delete x.accuracy;}],
    ['deviceCohorts',(_,r)=>{for(const x of r)delete x.deviceCohort;}],
    ['ownerPhone',(_,r)=>{for(const x of r)delete x.ownerPhone;}],
    ['routeConditions',(_,r)=>{for(const x of r)x.temperature='cold';}],
    ['routeConditions',(_,r)=>{for(const x of r)x.network='wifi';}],
    ['routeConditions',(_,r)=>{for(const x of r)x.deviceCohort='older';}],
    ['modelSettings',(_,r)=>{for(const x of r)delete x.model;}]
  ]){const m=manifest(),r=runs();change(m,r);const result=report(m,r);assert.equal(result.qualifyingHeldOutBenchmark,false,reason);assert.ok(result.qualification.uncached.missingRequirements.includes(reason));assert.equal(result.targets.clearCompleteWithin5Seconds95Percent,null);assert.equal(result.targets.cachedP95Under1Second,null);assert.equal(result.physical.attempts,100);}
});
test('a cached singleton cannot claim the cached target; every declared repeat case and condition is required',()=>{
  const m=manifest(),r=runs(),cached=r.map(x=>({...x,runId:'cached-'+x.runId,cached:true,captureToResultMs:10,analyseToResultMs:x.analyseToResultMs===null?null:10,cloudCallCount:0}));
  assert.equal(report(m,[...r,...cached]).targets.cachedP95Under1Second,null,'Cached repeats require an explicit case plan');
  m.cachedCaseIds=m.cases.map(c=>c.id);
  const singleton=report(m,[...r,cached[0]]);assert.equal(singleton.qualifyingHeldOutBenchmark,true);assert.equal(singleton.cached.targetToComplete.p95Ms,10);assert.equal(singleton.cached.analyseToComplete.p95Ms,null);assert.equal(singleton.targets.cachedP95Under1Second,null);
  assert.equal(report(m,[...r,...cached.slice(1)]).targets.cachedP95Under1Second,null);
  const complete=report(m,[...r,...cached]);assert.equal(complete.qualification.cached.qualified,true);assert.equal(complete.targets.cachedP95Under1Second,true);
  m.cachedCaseIds=m.cases.slice(0,32).map(c=>c.id);
  assert.equal(report(m,[...r,...cached.slice(0,32)]).targets.cachedP95Under1Second,true,'No invented sample-size floor beyond the explicit plan and condition coverage');
  const failed=cached.slice(0,32).map((x,i)=>i<2?{...x,outcome:'timeout',analyseToResultMs:null}:x);
  const misses=report(m,[...r,...failed]);assert.equal(misses.plannedCached.targetToComplete.p95Ms,null);assert.equal(misses.targets.cachedP95Under1Second,false);
  for(const x of r){x.captureToResultMs=6000;if(x.analyseToResultMs!==null)x.analyseToResultMs=6000;}
  const slowFirst=report(m,[...r,...cached]);assert.equal(slowFirst.uncachedSupportedClear.completeWithin5SecondsRate,0);assert.equal(slowFirst.targets.clearCompleteWithin5Seconds95Percent,false,'Cached repeats cannot mask slow first results');
});
test('barcode target timing uses its recorded start while raw Analyse durations stay null',()=>{
  const m=manifest(),r=runs(),before=structuredClone(r);
  const result=report(m,r);
  assert.equal(result.qualifyingHeldOutBenchmark,true);
  assert.equal(result.targets.clearCompleteWithin5Seconds95Percent,true);
  assert.equal(result.uncachedSupportedClear.completeWithin5SecondsRate,1);
  assert.deepEqual(result.uncached.targetToComplete.p50Ms,4000);
  assert.deepEqual(result.uncached.targetToComplete.p95Ms,4500);
  assert.equal(result.uncached.analyseToComplete.p95Ms,null);
  assert.equal(result.uncached.captureToComplete.p95Ms,4500);
  for(const group of result.groups.filter(g=>g.key.startsWith('barcode|'))){
    assert.equal(group.analyseToComplete.p50Ms,null);
    assert.equal(group.analyseToComplete.p95Ms,null);
    assert.equal(group.targetToComplete.p95Ms,4500);
  }
  assert.deepEqual(r,before,'Reporting must not invent Analyse durations or mutate supplied runs');
});
test('target timing never substitutes a different clock for missing or slow route timing',()=>{
  for(const captureToResultMs of [null,6000]){
    const r=runs();for(let i=0;i<r.length;i+=4)Object.assign(r[i],{captureToResultMs,analyseToResultMs:1});
    const result=report(manifest(),r);
    assert.equal(result.uncachedSupportedClear.completeWithin5SecondsRate,.75);
    assert.equal(result.targets.clearCompleteWithin5Seconds95Percent,false,'Even a legacy barcode Analyse number cannot replace its capture clock');
  }
  const r=runs();for(let i=0;i<r.length;i++)if(i%4!==0)r[i].analyseToResultMs=null;
  const result=report(manifest(),r);
  assert.equal(result.uncachedSupportedClear.completeWithin5SecondsRate,.25);
  assert.equal(result.targets.clearCompleteWithin5Seconds95Percent,false,'Photo capture time cannot replace a missing Analyse clock');
});
test('planned cached barcode repeats use their own latency and keep failures in the target p95',()=>{
  const m=manifest(),r=runs();m.cachedCaseIds=m.cases.map(c=>c.id);
  const cached=r.map(x=>({...x,runId:'cached-'+x.runId,cached:true,captureToResultMs:500,analyseToResultMs:x.analyseToResultMs===null?null:500,cloudCallCount:0}));
  const result=report(m,[...r,...cached]);
  assert.equal(result.qualification.cached.qualified,true);
  assert.equal(result.plannedCached.analyseToComplete.p95Ms,null);
  assert.equal(result.plannedCached.targetToComplete.p95Ms,500);
  assert.equal(result.targets.cachedP95Under1Second,true);
  for(let i=0;i<cached.length;i+=4)cached[i].captureToResultMs=1500;
  const slow=report(m,[...r,...cached]);
  assert.equal(slow.plannedCached.targetToComplete.p95Ms,1500);
  assert.equal(slow.targets.cachedP95Under1Second,false);
  for(let i=0;i<cached.length;i+=4)Object.assign(cached[i],{outcome:'timeout',captureToResultMs:null});
  const failed=report(m,[...r,...cached]);
  assert.equal(failed.plannedCached.targetToComplete.p95Ms,null);
  assert.equal(failed.targets.cachedP95Under1Second,false);
});
test('known reference mismatches are misses even when output shape was marked valid',()=>{
  const r=runs();for(let i=0;i<6;i++)r[i].accuracy.fieldsCorrect=7;
  const result=report(manifest(),r);assert.equal(result.qualifyingHeldOutBenchmark,true);assert.equal(result.physical.invalidComplete,6);assert.equal(result.physical.targetToComplete.p95Ms,null);assert.equal(result.targets.clearCompleteWithin5Seconds95Percent,false);
});
test('observed logical-analysis cost includes failed attempts and retries without counting cached repeats',()=>{
  const m=manifest();m.projection={activeUsers:10,analysesPerUserMonth:30};
  const initial={...runs()[0],outcome:'error',cost:{currency:'USD',actualBilled:.002,billingSource:'invoice'}};
  const retry={...initial,runId:'retry',attemptKind:'retry',outcome:'complete',cost:{currency:'USD',actualBilled:.003,billingSource:'provider_usage'}};
  const cached={...retry,runId:'cached',cached:true,attemptKind:'initial',cloudCallCount:0};delete cached.cost;
  const r=report(m,[initial,retry,cached]);
  assert.equal(r.uncached.cost.perSuccessfulUncachedAnalysis,.005);
  assert.equal(r.costAccounting.uncachedLogicalAnalyses.successfulGroups,1);
  assert.equal(r.costAccounting.uncachedLogicalAnalyses.perAnalysisIncludingFailures,.005);
  assert.equal(r.costAccounting.retries.cost.knownBilledSubtotal,.003);
  assert.equal(r.costAccounting.failedOrPartialAttempts.cost.knownBilledSubtotal,.002);
  assert.equal(r.projectedMonthlyCost.value,1.5);
  assert.equal(r.physical.cost.completeBilling,false);
  assert.equal(r.costAccounting.observedUsers.billedCostPerObservedUserGroup,null);
  assert.equal(r.physical.cacheHitRate,1/3);
});
test('legacy missing or contradictory retry grouping cannot create a logical-analysis cost or projection',()=>{
  const m=manifest();m.projection={activeUsers:10,analysesPerUserMonth:30};
  const a={...runs()[0],cost:{currency:'USD',actualBilled:.001,billingSource:'provider_usage'}};
  for(const change of [r=>delete r.analysisGroup,r=>delete r.attemptKind,r=>r.attemptKind='retry']){
    const r={...a};change(r);const result=report(m,[r]);
    assert.equal(result.uncached.cost.perSuccessfulUncachedAnalysis,null);
    assert.equal(result.uncached.cost.perSuccessfulUncachedAttempt,.001);
    assert.equal(result.projectedMonthlyCost,null);
  }
  assert.equal(report(m,[a,{...a,runId:'duplicate-initial'}]).projectedMonthlyCost,null);
  const retry={...a,runId:'retry-success',attemptKind:'retry'};
  assert.equal(report(m,[a,retry]).costAccounting.uncachedLogicalAnalyses.successfulGroups,1);
  assert.equal(report(m,[a,retry]).uncached.cost.perSuccessfulUncachedAnalysis,.002);
});
test('cached successful retry recovers its uncached logical analysis and requires its own billing evidence',()=>{
  const m=manifest();m.projection={activeUsers:10,analysesPerUserMonth:30};
  const initial={...runs()[0],outcome:'error',cost:{currency:'USD',actualBilled:.002,billingSource:'invoice'}};
  const retry={...initial,runId:'cached-retry',attemptKind:'retry',cached:true,outcome:'complete',cloudCallCount:0,
    cost:{currency:'USD',actualBilled:.001,billingSource:'provider_usage'}};
  const result=report(m,[initial,retry]);
  assert.equal(result.costAccounting.uncachedLogicalAnalyses.successfulGroups,1);
  assert.equal(result.costAccounting.uncachedLogicalAnalyses.cachedRetryAttempts,1);
  assert.equal(result.uncached.cost.perSuccessfulUncachedAnalysis,.003);
  assert.ok(Math.abs(result.projectedMonthlyCost.value-.9)<1e-12);
  delete retry.cost;
  assert.equal(report(m,[initial,retry]).uncached.cost.perSuccessfulUncachedAnalysis,null);
  assert.equal(report(m,[initial,retry]).projectedMonthlyCost,null);
});
test('per-user billing describes only supplied pseudonymous cohort and declared measurement window',()=>{
  const m=manifest();m.measurementWindow={start:'2026-10-01T00:00:00Z',end:'2026-10-20T00:00:00Z'};
  const r=runs().slice(0,2).map(x=>({...x,cost:{currency:'GBP',actualBilled:.02,billingSource:'invoice'}}));
  const result=report(m,r);assert.equal(result.costAccounting.observedUsers.pseudonymousGroups,2);
  assert.equal(result.costAccounting.observedUsers.billedCostPerObservedUserGroup,.02);
  assert.deepEqual(result.costAccounting.observedUsers.measurementWindow,m.measurementWindow);
  delete r[0].userGroup;
  assert.equal(report(m,r).costAccounting.observedUsers.billedCostPerObservedUserGroup,null);
  m.measurementWindow.end=m.measurementWindow.start;assert.throws(()=>report(m,r));
});
test('grouping rejects account identifiers and cross-case or cross-user attribution',()=>{
  const m=manifest(),r=runs();r[0].userGroup='owner@example.test';assert.throws(()=>report(m,r));
  delete r[0].userGroup;r[1].analysisGroup=r[0].analysisGroup;assert.throws(()=>report(m,r));
  r[1].caseId=r[0].caseId;r[0].userGroup='u_0000000000000000';assert.throws(()=>report(m,r));
});
