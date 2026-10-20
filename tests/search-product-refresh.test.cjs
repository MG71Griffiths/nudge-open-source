// Real product controller, native event dispatch and persistence with synthetic
// public food facts. No device data, network calls or wall-clock waits.
const assert=require('node:assert/strict'),vm=require('node:vm');
const {boot,product}=require('./food-detail.test.cjs');
const copy=v=>JSON.parse(JSON.stringify(v));
const complete={...product,energyKj:{value:2590,unit:'kJ',status:'supplied'},categoryTag:'en:peanut-butters',ingredients:'Peanuts (99.1%), sea salt',ingredientsNeedsReview:false,ingredientItems:[{text:'Peanuts',percent:99.1}],scoringFacts:{isFatOilNutsSeeds:true,source:'Open Food Facts 2023 metadata'}};
const snapshot={...complete,name:'Indexed product',searchProvider:'open_food_facts_search',searchIndexedAt:'2024-11-01T00:00:00Z'};
const current={...complete,name:'Current product',nutrients:{...complete.nutrients,protein:{value:30,status:'supplied'}}};
function refreshBoot(){
  const app=boot(),timers=new Map();let nextTimer=0;
  app.sandbox.setTimeout=fn=>{timers.set(++nextTimer,fn);return nextTimer;};
  app.sandbox.clearTimeout=id=>timers.delete(id);
  const request=()=>app.messages.filter(m=>m.action==='search-product-refresh').at(-1);
  // Native sendEvent evaluates this same direct call, without an event whitelist.
  function dispatch(event){vm.runInContext('window.NudgeBarcode && window.NudgeBarcode.receive('+JSON.stringify(event)+');',app.sandbox);}
  return {...app,timers,request,dispatch,respond:(p=current,r=request())=>dispatch({type:'search-product-refreshed',requestId:r.requestId,draftId:r.draftId,...(p?{product:copy(p)}:{unavailable:true})}),expire(){const pending=[...timers.values()];for(const fn of pending)fn();}};
}
const pending=refreshBoot();pending.controller.openSearchProduct(copy(snapshot));const request=pending.request();
assert.ok(request);assert.equal(request.barcode,snapshot.barcode);
assert.equal(pending.controller.detail().score.value,null,'The old index score is hidden while exact facts refresh');
assert.equal(pending.controller.detail().scoreLoading,true);assert.equal(pending.controller.detail().valid,false);
pending.controller.screen();pending.action('detail-score-retry');pending.action('detail-log');
assert.equal(pending.messages.filter(m=>m.action==='product-score').length,0,'No AI score request races the exact lookup');
assert.equal(pending.data.foodLog.entries.length,0);assert.equal(pending.history.items().length,0);
assert.match(pending.controller.detail().error,/current product check/);
pending.input('detail-measure','g');pending.input('detail-quantity','42');pending.respond();
assert.equal(pending.controller.detail().product.name,current.name);assert.equal(pending.controller.detail().portion.canonicalAmount,42);
assert.equal(pending.controller.detail().nutrients.protein,12.6);assert.equal(pending.controller.detail().valid,true);
assert.equal(pending.controller.detail().scoreLoading,false);assert.equal(pending.controller.detail().error,'');
assert.equal(pending.timers.size,0);assert.equal(pending.controller._scan.searchRefreshID,null);
pending.controller.screen();assert.equal(pending.controller.detail().score.status,'rated');
assert.equal(pending.history.items().length,0);assert.equal(pending.writes(),0,'Successful discovery refresh is view-only');
pending.action('detail-log');const saved=JSON.stringify(pending.data),history=JSON.stringify(pending.history.items());
pending.respond({...current,name:'Duplicate callback',nutrients:{}},request);
assert.equal(JSON.stringify(pending.data),saved);assert.equal(JSON.stringify(pending.history.items()),history);
assert.equal(pending.controller.detail().product.name,current.name);

const switching=refreshBoot();switching.receive(copy(complete),'earlier-scan');switching.action('detail-log');
const entry=copy(switching.data.foodLog.entries[0]);switching.controller.openSearchProduct(copy(snapshot));const retired=switching.request();
switching.history.reopen('diary:'+entry.id);
assert.equal(switching.controller._scan.searchRefreshing,false);assert.equal(switching.timers.size,0);
assert.equal(switching.controller.detail().entryId,entry.id);assert.equal(switching.controller.detail().valid,true);
assert.ok(switching.messages.some(m=>m.action==='cancel-search-product-refresh'&&m.requestId===retired.requestId&&m.draftId===retired.draftId));
const historical=JSON.stringify(switching.data);switching.respond(current,retired);assert.equal(JSON.stringify(switching.data),historical);
assert.equal(switching.controller.detail().product.name,complete.name,'A stale search response cannot replace an open diary item');
switching.controller.openSearchProduct(copy(snapshot));const beforeScan=switching.request();switching.receive({...complete,name:'New scan'},'new-scan');
assert.equal(switching.controller._scan.searchRefreshing,false);assert.equal(switching.controller._scan.searchRefreshUnavailable,false);
switching.respond(current,beforeScan);assert.equal(switching.controller.detail().product.name,'New scan');
assert.equal(switching.view.resultOrigin,'camera');

const timedOut=refreshBoot();timedOut.controller.openSearchProduct(copy(snapshot));const late=timedOut.request();timedOut.action('detail-log');timedOut.expire();
assert.equal(timedOut.controller._scan.searchRefreshing,false);assert.equal(timedOut.controller._scan.searchRefreshUnavailable,true);
assert.equal(timedOut.controller.detail().error,'','The wait message ends with the bounded refresh');
assert.equal(timedOut.controller.detail().valid,true);assert.match(timedOut.controller.screen(),/search catalogue snapshot/);
timedOut.action('detail-log');const confirmed=JSON.stringify(timedOut.data),confirmedHistory=JSON.stringify(timedOut.history.items());
timedOut.respond(current,late);assert.equal(JSON.stringify(timedOut.data),confirmed);assert.equal(JSON.stringify(timedOut.history.items()),confirmedHistory);
assert.equal(timedOut.controller.detail().product.name,snapshot.name,'Late refresh preserves the explicitly confirmed snapshot');

for(const close of ['result-close','barcode-reset','invalidate','offscreen']){
  const app=refreshBoot();app.controller.openSearchProduct(copy(snapshot));const r=app.request();
  if(close==='invalidate')app.controller.invalidate(r.draftId);
  else if(close==='offscreen')app.view.screen='today';else app.action(close);
  app.respond(current,r);assert.notEqual(app.controller._scan.product?.name,current.name,close);
  assert.equal(app.controller._scan.searchRefreshing,false,close);assert.equal(app.data.foodLog.entries.length,0,close);assert.equal(app.history.items().length,0,close);
}
const superseded=refreshBoot();superseded.controller.openSearchProduct(copy(snapshot));const previous=superseded.request();
superseded.controller.openSearchProduct({...copy(snapshot),barcode:'87654321',name:'Other product'});const latest=superseded.request();
superseded.respond(current,previous);assert.equal(superseded.controller._scan.searchRefreshing,true);
assert.equal(superseded.controller.detail().product.name,'Other product');
superseded.respond(current,latest);assert.equal(superseded.controller._scan.searchRefreshUnavailable,true,'A mismatched barcode does not pass as a successful refresh');
assert.equal(superseded.controller.detail().product.name,'Other product');

const invalidAmount=refreshBoot();invalidAmount.controller.openSearchProduct(copy(snapshot));invalidAmount.input('detail-quantity','nonsense');invalidAmount.respond();
assert.equal(invalidAmount.controller.detail().inputValue,'nonsense');assert.equal(invalidAmount.controller.detail().valid,false);invalidAmount.action('detail-log');assert.equal(invalidAmount.data.foodLog.entries.length,0);
const unavailable=refreshBoot();delete unavailable.sandbox.webkit;unavailable.controller.openSearchProduct(copy(snapshot));
assert.equal(unavailable.controller._scan.searchRefreshUnavailable,true);assert.equal(unavailable.controller.detail().valid,true);
assert.match(unavailable.controller.screen(),/search catalogue snapshot/);
const immediate=refreshBoot();immediate.sandbox.webkit.messageHandlers.nudgeBarcode.postMessage=m=>{
  if(m.action==='search-product-refresh')immediate.respond(current,m);
};immediate.controller.openSearchProduct(copy(snapshot));
assert.equal(immediate.controller.detail().product.name,current.name);assert.equal(immediate.timers.size,0,'Immediate callbacks cannot leave a timeout behind');
console.log('PASS: exact search refresh dispatch, pending score/log guard, amount preservation, cancellation, timeout, history/scan reset, stale/duplicate/mismatched events and confirmed-intake isolation.');
