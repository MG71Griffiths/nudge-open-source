// Real search -> product detail -> History/intake controllers, synthetic records only.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {boot,product}=require('./food-detail.test.cjs');
const copy=v=>JSON.parse(JSON.stringify(v));
const imageURL='https://images.openfoodfacts.org/images/products/12345678/front_en.1.400.jpg';
const complete={...product,imageURL,energyKj:{value:2590,unit:'kJ',status:'supplied'},categoryTag:'en:peanut-butters',ingredients:'Peanuts (99.1%), sea salt',ingredientsNeedsReview:false,ingredientItems:[{text:'Peanuts',percent:99.1}],scoringFacts:{isFatOilNutsSeeds:true,source:'Open Food Facts 2023 metadata'}};
const filter=(app,name)=>{app.history.handleAction('history-filter',name);return Array.from(app.history.items());};
const app=boot(),before=JSON.stringify(app.data),historyBefore=Array.from(app.history.items());
app.controller.openSearchProduct(copy(complete));
const searchID=app.controller._scan.confirmationId;
assert.match(searchID,/^search-product:/);
assert.equal(app.view.resultOrigin,'search');
for(let i=0;i<4;i++)app.controller.screen();
assert.equal(app.controller.detail().score.status,'rated');
assert.ok(app.controller._scan.product.scoreResult,'Local score caching is exercised');
assert.equal(JSON.stringify(app.data),before,'Opening or scoring search results cannot log intake');
assert.deepEqual(Array.from(app.history.items()),historyBefore,'Opening or scoring cannot create a scan/history event');
assert.equal(app.writes(),0);
app.action('product-favourite');
assert.equal(app.history.isFavourite(complete),true);
assert.equal(app.history.items().length,0,'Saving for later is not a scan or a consumption');
assert.equal(app.data.foodLog.entries.length,0);
app.action('detail-log');app.action('detail-log');
assert.equal(app.data.foodLog.entries.length,1);
const first=copy(app.data.foodLog.entries[0]);
assert.equal(first.sourceMeta.productScanEventId,searchID);
assert.equal(app.history.find(searchID).origin,'search');
assert.equal(app.history.find(searchID).product.imageURL,imageURL);
assert.equal(filter(app,'all').length,1);
assert.equal(filter(app,'eaten').length,1);
assert.equal(filter(app,'scanned').length,0,'Searched products were never scanned');
assert.equal(filter(app,'photos').length,0,'Searched products were never photographed');
app.action('detail-another');app.action('detail-log');app.action('detail-log');
assert.equal(app.data.foodLog.entries.length,2);
assert.notEqual(app.data.foodLog.entries[0].id,app.data.foodLog.entries[1].id);
assert.equal(filter(app,'all').length,2,'Each distinct consumed portion appears once');
assert.equal(filter(app,'eaten').length,2);
assert.equal(filter(app,'scanned').length,0,'A second portion cannot turn a search into a scan');
const reloaded=boot({storage:app.storage,reload:true});
reloaded.history.reopen('diary:'+first.id);
assert.equal(reloaded.controller.detail().entryId,first.id);
assert.equal(reloaded.controller.detail().product.imageURL,imageURL);
assert.equal(reloaded.controller.detail().portion.canonicalAmount,first.portionAmount);
assert.equal(reloaded.writes(),0,'Reopening exact intake after restart is read-only');
reloaded.action('detail-edit');reloaded.input('detail-quantity','2');reloaded.action('detail-log');
assert.equal(reloaded.data.foodLog.entries.length,2);
assert.equal(reloaded.data.foodLog.entries[0].id,first.id);
assert.equal(reloaded.data.foodLog.entries[0].sourceMeta.productScanEventId,searchID);
assert.equal(reloaded.history.find(searchID).product.imageURL,imageURL);
assert.equal(filter(reloaded,'scanned').length,0);
reloaded.controller.openSearchProduct(copy(complete));
assert.equal(reloaded.controller.detail().status,'draft','A new search open cannot silently select earlier intake');
assert.equal(reloaded.data.foodLog.entries.length,2);
assert.equal(filter(reloaded,'all').length,2,'New browsing does not duplicate the earlier entry');

const failed=boot();failed.controller.openSearchProduct(copy(complete));failed.controller.screen();failed.canSave(false);failed.action('detail-log');
assert.equal(failed.data.foodLog.entries.length,0);assert.equal(failed.history.items().length,0);
failed.canSave(true);failed.action('detail-log');failed.action('detail-log');
assert.equal(failed.data.foodLog.entries.length,1);assert.equal(failed.history.items().length,1);

const incomplete=boot();incomplete.controller.openSearchProduct({name:'Unknown product',barcode:'99998888',sourceName:'Open Food Facts',sourceURL:'https://world.openfoodfacts.org/product/99998888',imageURL,basisUnit:'g',servingAmount:100,servingUnit:'g',nutritionPreparation:'as_sold',nutriScoreGrade:'A',nutrients:{protein:{value:0,status:'supplied'}}});
incomplete.controller.screen();assert.equal(incomplete.controller.detail().score.value,null,'A provider A grade cannot invent a Nudge rating');
assert.equal(incomplete.history.items().length,0);
incomplete.action('detail-log');
assert.equal(incomplete.data.foodLog.entries[0].proteinPerPortion,0);
assert.equal(incomplete.data.foodLog.entries[0].energyPerPortion,null);
assert.equal(incomplete.data.foodLog.entries[0].sourceMeta.scoreMethod.value,null);
assert.equal(filter(incomplete,'scanned').length,0);

// Exercise the asynchronous score callback before confirmation: it remains view/cache-only.
const asyncApp=boot();asyncApp.controller.openSearchProduct({...copy(product),nutrients:{...copy(product.nutrients),sugars:{value:null,status:'unknown'}}});asyncApp.controller.screen();
const request=asyncApp.messages.filter(m=>m.action==='product-score').at(-1);assert.ok(request);
asyncApp.controller.receive({type:'product-score',requestId:request.requestId,draftId:request.draftId,result:{score:{status:'unrated',methodId:'nudge_nutrition_v0_2',version:'0.2',grade:null,rawScore:null,reason:'Exact energy is unavailable.',missingInputs:['energyKj']}}});
assert.equal(asyncApp.history.items().length,0);
assert.equal(asyncApp.data.foodLog.entries.length,0);
console.log('PASS: search opening/scoring/saving is read-only for History and intake; explicit confirmation, retry, second portions, exact reopen/edit, image persistence, search origin and unknown scores are preserved.');

// Saved search products retain public identity and imagery without a fictitious scan.
const savedOnly=boot();savedOnly.controller.openSearchProduct(copy(complete));savedOnly.controller.screen();savedOnly.action('product-favourite');
const savedReload=boot({storage:savedOnly.storage});
assert.equal(savedReload.data.foodLog.entries.length,0);assert.equal(savedReload.history.items().length,0);
assert.equal(savedReload.history.isFavourite(complete),true);
const savedCandidate=savedReload.history.productCandidates().find(p=>p.barcode===complete.barcode);
assert.equal(savedCandidate.imageURL,imageURL);assert.equal(savedCandidate.name,complete.name);
savedReload.controller.openSearchProduct(copy(savedCandidate));savedReload.action('product-favourite');
assert.equal(savedReload.history.isFavourite(complete),false);assert.equal(savedReload.history.productCandidates().length,0);
assert.equal(savedReload.history.items().length,0);assert.equal(savedReload.data.foodLog.entries.length,0);
const failedFavourite=boot();failedFavourite.controller.openSearchProduct(copy(complete));failedFavourite.canHistory(false);failedFavourite.action('product-favourite');
assert.equal(failedFavourite.history.isFavourite(complete),false);assert.equal(failedFavourite.history.productCandidates().length,0);

// Browser input/suggestions/filter changes do not contact the provider. Explicit
// submitted requests carry food text only, and late responses cannot replace it.
function searchBoot(options={}){
  const app=boot(options),documentListeners={},windowListeners={},posted=[],timers=new Map();let timer=0;
  app.sandbox.document.addEventListener=(name,fn)=>documentListeners[name]=fn;
  app.sandbox.document.querySelector=()=>null;app.sandbox.document.querySelectorAll=()=>[];
  app.sandbox.addEventListener=(name,fn)=>windowListeners[name]=fn;
  app.sandbox.setTimeout=fn=>{timers.set(++timer,fn);return timer;};app.sandbox.clearTimeout=id=>timers.delete(id);
  app.sandbox.webkit.messageHandlers.nudgeBarcode.postMessage=message=>posted.push(message);
  app.sandbox.NudgeRecipeCatalogue={all:()=>[],drafts:()=>[],score:()=>({value:null})};
  for(const file of ['search-model.js','search.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),app.sandbox,{filename:file});
  app.view.screen='search';
  const search=app.sandbox.createNudgeSearch({getState:()=>app.data,view:app.view,render(){},navigate:s=>app.view.screen=s,escapeHtml:v=>String(v??''),todayKey:()=>options.today||'2026-10-04',foodPatterns:{recipeCard:r=>'<article data-recipe="'+r.id+'">'+r.name+'</article>'},barcode:app.controller,history:app.history});
  return {app,search,get posted(){return posted.filter(m=>m.action!=='search-diagnostic');},get diagnostics(){return posted.filter(m=>m.action==='search-diagnostic');},input:value=>documentListeners.input({target:{id:'food-search-input',value}}),receive:detail=>windowListeners['nudge:product-search']({detail})};
}
const refreshed=boot();
refreshed.receive({...copy(complete),name:'Older scan',imageURL:''},'older-scan');
refreshed.controller.openSearchProduct({...copy(complete),name:'Saved current product'});refreshed.action('product-favourite');
const savedWithScan=searchBoot({storage:refreshed.storage});savedWithScan.search.handleAction('search-saved');
const savedResult=savedWithScan.search.results().find(item=>item.raw.barcode===complete.barcode);
assert.equal(savedResult.name,'Saved current product');assert.equal(savedResult.raw.imageURL,imageURL);
assert.equal(savedWithScan.app.history.find('older-scan').product.name,'Older scan');
assert.equal(savedWithScan.app.history.find('older-scan').product.imageURL,'','Catalogue freshness cannot rewrite the original scan');
assert.equal(savedWithScan.app.data.foodLog.entries.length,0);
const live=searchBoot();
live.input('milk');assert.equal(live.posted.length,0);
live.search.handleChange({id:'search-support',value:'luteal'});live.search.handleChange({id:'search-minimumScore',value:'75'});assert.equal(live.posted.length,0);
live.input('PMS milk');live.search.handleSubmit({id:'food-search-form'});
let firstRequest=live.posted.at(-1);assert.equal(firstRequest.action,'product-search');assert.equal(firstRequest.query,'milk');assert.equal(firstRequest.page,1);
assert.deepEqual(Object.keys(firstRequest).sort(),['action','page','query','requestID']);
live.input('chickpeas');live.search.handleSubmit({id:'food-search-form'});const nextRequest=live.posted.at(-1);
assert.notEqual(nextRequest.requestID,firstRequest.requestID);
live.receive({type:'results',requestID:firstRequest.requestID,query:'milk',page:1,hasMore:true,products:[complete]});
assert.equal(live.search._state.products.length,0,'Late source results must not replace the current query');
live.receive({type:'results',requestID:nextRequest.requestID,query:'chickpeas',page:1,hasMore:true,products:[complete]});
assert.equal(live.search._state.products.length,1);
assert.equal(live.app.history.items().length,0);assert.equal(live.app.data.foodLog.entries.length,0);
const queryWrites=live.posted.length;live.search.handleChange({id:'search-minimumScore',value:'50'});assert.equal(live.posted.length,queryWrites);
live.search.handleAction('search-more');const more=live.posted.at(-1);assert.equal(more.page,2);assert.equal(more.query,'chickpeas');
live.search.handleAction('search-clear');live.receive({type:'results',requestID:more.requestID,page:2,products:[complete],hasMore:false});
assert.equal(live.search._state.products.length,0,'Clearing search invalidates the pending response');
assert.ok(live.posted.some(message=>message.action==='cancel-product-search'&&message.requestID===more.requestID),'Clearing search cancels its native request');
const foodRequests=live.posted.filter(message=>message.action==='product-search').length;
live.input('hormones');live.search.handleSubmit({id:'food-search-form'});assert.equal(live.posted.filter(message=>message.action==='product-search').length,foodRequests,'A sensitive-only query cannot reach a food provider');
assert.equal(live.app.history.items().length,0);assert.equal(live.app.data.foodLog.entries.length,0);
console.log('PASS: saved searched products survive restart independently of History, failed favourite persistence rolls back, suggestions/filters stay local, provider requests omit sensitive terms, and stale responses never change current results or intake.');

// Equivalent spelling recovery is bounded and only follows an empty source response.
const spelling=searchBoot();spelling.input('yogurt');spelling.search.handleSubmit({id:'food-search-form'});
const uk=spelling.posted.filter(m=>m.action==='product-search').at(-1);assert.equal(uk.query,'yoghurt');
spelling.receive({type:'results',requestID:uk.requestID,page:1,products:[],hasMore:false,cached:false});
const us=spelling.posted.filter(m=>m.action==='product-search').at(-1);assert.equal(us.query,'yogurt');assert.notEqual(us.requestID,uk.requestID);
spelling.receive({type:'results',requestID:us.requestID,page:1,products:[],hasMore:false});
assert.equal(spelling.posted.filter(m=>m.action==='product-search').length,2,'Equivalent spelling is tried once, not a request loop');
assert.ok(spelling.diagnostics.some(m=>m.metadata.aliasMatched===true));
for(const message of spelling.diagnostics){assert.equal(message.metadata.query,undefined);assert.equal(message.metadata.support,undefined);assert.equal(message.metadata.profile,undefined);}
const outage=searchBoot();outage.input('yogurt');outage.search.handleSubmit({id:'food-search-form'});const blocked=outage.posted.filter(m=>m.action==='product-search').at(-1);
outage.receive({type:'error',requestID:blocked.requestID,page:1,code:'providerBusy',message:'Source busy',retryAfterSeconds:30});
assert.equal(outage.posted.filter(m=>m.action==='product-search').length,1,'An outage must never trigger an alternate-spelling request');
outage.search.handleAction('search-retry');assert.equal(outage.posted.filter(m=>m.action==='product-search').length,1,'Retry respects the source cooldown');assert.match(outage.search.screen(),/data-search-retry disabled/);
outage.search.handleAction('search-kind','recipe');assert.doesNotMatch(outage.search.screen(),/Source busy|Retry product search/,'Recipes do not inherit a product API error');
// Stale data is labelled, and refreshing a page replaces it instead of accumulating copies.
const cached=searchBoot();cached.input('peanuts');cached.search.handleSubmit({id:'food-search-form'});let cacheRequest=cached.posted.filter(m=>m.action==='product-search').at(-1);
cached.receive({type:'results',requestID:cacheRequest.requestID,page:1,products:[complete],hasMore:false,cached:true,stale:true,fallbackCode:'providerBusy',retryAfterSeconds:20});
assert.equal(cached.search._state.products.length,1);assert.equal(cached.search._state.stale,true);assert.match(cached.search.screen(),/previously loaded product data/);
cached.search._state.retryAt=0;cached.search.handleAction('search-retry');cacheRequest=cached.posted.filter(m=>m.action==='product-search').at(-1);assert.equal(cacheRequest.page,1);
cached.receive({type:'results',requestID:cacheRequest.requestID,page:1,products:[complete],hasMore:false,cached:false,stale:false});assert.equal(cached.search._state.products.length,1);assert.equal(cached.search._state.stale,false);
// An import is not missing when the saved requirements exclude unverified recipes.
const library=searchBoot();for(const file of ['recipe-catalogue-data.js','recipe-catalogue.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),library.app.sandbox,{filename:file});
library.app.data.nutritionProfile={...library.app.data.nutritionProfile,glutenRequirement:'coeliac'};
library.input('milk');library.search.handleSubmit({id:'food-search-form'});library.search.handleAction('search-browse-recipes');
assert.equal(library.search.results().filter(item=>item.kind==='recipe').length,0,'Browsing cannot silently relax medical requirements');
assert.match(library.search.screen(),/4 recipes in your library/);assert.match(library.search.screen(),/4 results are hidden from recommendations/);assert.match(library.search.screen(),/1 · Contains gluten/);assert.match(library.search.screen(),/3 · Gluten-free ingredient and preparation evidence is missing/);assert.doesNotMatch(library.search.screen(),/data-recipe=|review food requirements|requirements check/);
assert.equal(library.app.data.nutritionProfile.glutenRequirement,'coeliac');assert.equal(library.app.data.foodLog.entries.length,0);
assert.ok(library.diagnostics.some(m=>m.metadata.recipeCount===4&&m.metadata.requirementsExcludedCount===4));
console.log('PASS: bounded spelling fallback, provider cooldown, stale-page replacement, recipe library visibility and private search diagnostics.');

const typo=searchBoot();typo.input('yogrut');typo.search.handleSubmit({id:'food-search-form'});const typoRequest=typo.posted.filter(m=>m.action==='product-search').at(-1);assert.equal(typoRequest.query,'yoghurt');typo.receive({type:'results',requestID:typoRequest.requestID,page:1,products:[],hasMore:false});assert.equal(typo.posted.filter(m=>m.action==='product-search').at(-1).query,'yogurt','The bounded fallback uses a valid equivalent spelling, not the original typo');

const excludedSource=searchBoot();excludedSource.input('yogurt');excludedSource.search.handleSubmit({id:'food-search-form'});const excludedRequest=excludedSource.posted.filter(m=>m.action==='product-search').at(-1);excludedSource.search.handleChange({id:'search-minimumScore',value:'100'});excludedSource.receive({type:'results',requestID:excludedRequest.requestID,page:1,products:[complete],hasMore:false});assert.equal(excludedSource.posted.filter(m=>m.action==='product-search').length,1,'Loaded products excluded by filters do not trigger spelling recovery');

// Native full-text results can use synonyms or brand matches; do not discard them
// a second time through a literal substring test. Safety/rating filters still apply.
const semantic=searchBoot();semantic.input('yoghurt');semantic.search.handleSubmit({id:'food-search-form'});
const semanticRequest=semantic.posted.at(-1);semantic.receive({type:'results',requestID:semanticRequest.requestID,page:1,products:[{...complete,name:'Skyr natural',ingredients:'milk',allergens:['milk']}],hasMore:false});
assert.equal(semantic.search.results().length,1,'Provider full-text match survives a different product name');
semantic.app.data.nutritionProfile.allergies=['milk'];
assert.equal(semantic.search.results().length,0,'Provider match does not bypass allergies');
assert.match(semantic.search.screen(),/Contains milk/);assert.doesNotMatch(semantic.search.screen(),/Skyr natural|data-action="search-product"|requirements check/);
assert.doesNotMatch(semantic.search.screen(),/No matching foods yet/);
const offlineSaved=searchBoot();offlineSaved.app.sandbox.NudgeRepertoire={markup:()=>'<h2>My foods</h2><p>My usual smoothie</p>'};
offlineSaved.search.showSaved();offlineSaved.input('smoothie');offlineSaved.search.handleSubmit({id:'food-search-form'});
assert.equal(offlineSaved.posted.filter(m=>m.action==='product-search').length,0,'My foods search works offline without source calls');
assert.match(offlineSaved.search.screen(),/My usual smoothie/);assert.doesNotMatch(offlineSaved.search.screen(),/No matching foods yet/);
const errorEmpty=searchBoot();errorEmpty.input('beans');errorEmpty.search.handleSubmit({id:'food-search-form'});errorEmpty.receive({type:'error',requestID:errorEmpty.posted.at(-1).requestID,page:1,code:'providerBusy',message:'Source busy',retryAfterSeconds:30});
assert.match(errorEmpty.search.screen(),/Live product results are unavailable/);
console.log('PASS: provider synonym matches, specific automatic exclusions, offline My foods and truthful source failure state.');

// Opted-in cycle dates select a transparent, device-local food filter. Manual
// exploration wins until the user explicitly returns to the current phase.
function cycleSearch(cycle={}){
  const a=searchBoot();vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web/cycle-support.js'),'utf8'),a.app.sandbox,{filename:'cycle-support.js'});
  a.app.data.cycleSupport={enabled:true,start:'2026-09-12',length:28,regularity:'regular',contraception:'none',...cycle};
  return a;
}
const cycleAuto=cycleSearch(),protectedCycle=JSON.stringify(cycleAuto.app.data);
assert.match(cycleAuto.search.screen(),/Estimated luteal phase/);assert.match(cycleAuto.search.screen(),/Day 23 · Before your period/);
assert.equal(cycleAuto.search._state.support,'luteal');assert.equal(cycleAuto.posted.length,0,'Opening cycle suggestions makes no provider call');
cycleAuto.search.handleChange({id:'search-support',value:'period'});assert.equal(cycleAuto.search._state.support,'period');assert.match(cycleAuto.search.screen(),/Exploring Period/);
cycleAuto.search.handleAction('search-remove-filter','support');assert.equal(cycleAuto.search._state.support,'all');assert.match(cycleAuto.search.screen(),/Showing foods for any stage/);
cycleAuto.search.handleAction('search-cycle-current');assert.equal(cycleAuto.search._state.support,'luteal');assert.equal(cycleAuto.search._state.kind,'recipe');assert.equal(cycleAuto.posted.length,0);
cycleAuto.search.handleAction('search-saved');assert.equal(cycleAuto.search._state.support,'all');assert.doesNotMatch(cycleAuto.search.screen(),/Your cycle phase/);
cycleAuto.search.handleAction('search-saved');assert.match(cycleAuto.search.screen(),/Estimated luteal phase/);assert.equal(cycleAuto.search._state.support,'luteal');
cycleAuto.search.handleAction('search-kind','product');cycleAuto.input('tofu');cycleAuto.search.handleSubmit({id:'food-search-form'});
assert.equal(cycleAuto.posted.filter(m=>m.action==='product-search').at(-1).query,'tofu');
for(const m of cycleAuto.diagnostics){assert.doesNotMatch(JSON.stringify(m.metadata),/luteal|2026-09-12|contraception|cycleSupport|tofu/);}
assert.equal(JSON.stringify(cycleAuto.app.data),protectedCycle,'Cycle search does not mutate the profile, cycle dates or intake');
for(const c of [{regularity:'irregular'},{contraception:'hormonal'},{start:null},{start:'2026-08-01'},{regularity:'unknown'}]){
  const a=cycleSearch(c);assert.match(a.search.screen(),/Phase not estimated/);assert.equal(a.search._state.support,'all');assert.doesNotMatch(a.search.screen(),/Estimated luteal phase/);
}
const cycleOff=cycleSearch({enabled:false});assert.doesNotMatch(cycleOff.search.screen(),/Your cycle phase/);assert.equal(cycleOff.search._state.support,'all');
const cycleTyped=cycleSearch();cycleTyped.search.screen();cycleTyped.input('tofu for menopause');cycleTyped.search.handleSubmit({id:'food-search-form'});assert.equal(cycleTyped.search._state.support,'menopause');assert.equal(cycleTyped.search._state.supportMode,'manual');assert.equal(cycleTyped.posted.filter(m=>m.action==='product-search').at(-1).query,'tofu');
console.log('PASS: visible estimated cycle phase, automatic opt-in filter, explicit overrides, unknown-cycle handling and private food-only requests.');

assert.doesNotMatch(semantic.search.screen(),/id="search-meal"|aria-label="Meal"/,'Search has no meal category filter');
