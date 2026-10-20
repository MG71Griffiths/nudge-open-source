// Shared scan controls keep physical quantities explicit; a serving never implies g = ml.
window.NudgeScanUI = {
  suggestion(raw) {
    if(!raw||typeof raw.label!=='string'||!raw.label.trim()||typeof raw.amount!=='number'||!Number.isFinite(raw.amount)||raw.amount<0.1||raw.amount>5000||!['g','ml'].includes(raw.unit)||!['label','estimated'].includes(raw.source))return null;
    return {label:raw.label.trim().slice(0,80),amount:raw.amount,unit:raw.unit,source:raw.source};
  },
  adjust(amount,base,isStep,value){
    const n=Number(value);if(!Number.isFinite(n)||!Number.isFinite(base)||base<=0)return null;
    const portions=isStep?Math.round((amount/base+n)*1000)/1000:n;
    const next=Math.round(portions*base*1000)/1000;
    return portions>=0.25&&next>=0.1&&next<=5000?next:null;
  },
  refresh(html){
    const current=document.querySelector?.('.scan-result');if(!current||!document.createElement)return false;
    const next=document.createElement('div');next.innerHTML=html;
    // Keep input/summary/button nodes mounted across blur, so the next tap still lands.
    for(const selector of ['h1','.scan-brand','.scan-plants','.scan-note','.scan-facts','.scan-serving-label','.scan-selected-amount','.scan-alternative-results','.scan-alternatives','.scan-alternative-status']){
      const before=current.querySelector(selector),after=next.querySelector(selector);
      if(before&&after)before.innerHTML=after.innerHTML;
      else if(before&&!after)before.remove();
      else if(after){if(selector.startsWith('.scan-altern'))current.append(after);else current.querySelector('.scan-portion')?.before(after);}
    }
    for(const selector of ['.scan-stepper strong','.scan-stepper .nc-stepper-value>span']){
      const before=current.querySelector(selector),after=next.querySelector(selector);if(before&&after)before.textContent=after.textContent;
    }
    const currentValue=current.querySelector('.scan-stepper .nc-stepper-value'),nextValue=next.querySelector('.scan-stepper .nc-stepper-value');
    if(currentValue&&nextValue)currentValue.setAttribute('aria-label',nextValue.getAttribute('aria-label'));
    for(const before of current.querySelectorAll('.scan-stepper button,.scan-presets button')){
      const after=next.querySelector(`[data-action="${before.dataset.action}"][data-value="${before.dataset.value}"]`);
      if(after){before.disabled=after.disabled;if(after.hasAttribute('aria-pressed'))before.setAttribute('aria-pressed',after.getAttribute('aria-pressed'));}
    }
    return true;
  },
  portion({prefix,amount,base,label,source,unit,esc}){
    const count=Math.round(amount/base*1000)/1000;
    // Label wording (e.g. "2 tablespoons") describes one printed serving.
    return `<p class="scan-serving-label">${source==='label'?'Label serving':'Suggested portion'} · ${esc(/^(?:1 )?(?:portion|serving)$/.test(label)?'':label+' · ')}${base} ${esc(unit)}</p>${window.NudgeControls.stepper({label:'Portions',value:count,unit:'portions',step:.25,minimum:Math.max(.25,.1/base),maximum:5000/base,action:prefix+'-step',increment:'¼',className:'scan-stepper'})}<p class="scan-selected-amount">${amount} ${esc(unit)}</p>${window.NudgeControls.choices({label:'Choose portions',items:[.5,1,1.25,2].map(n=>[n,n===1?'1 portion':n+' portions',n*base>5000||n*base<.1]),value:count,action:prefix+'-portion',className:'scan-presets'})}`;
  }
};
// A catalogue candidate is useful only when its evidence supports the same score and the user's requirements.
window.NudgeAlternatives = (()=>{
  const text=v=>typeof v==='string'?v.trim():'', list=v=>Array.isArray(v)?v:[], known=v=>typeof v==='number'&&Number.isFinite(v);
  const aliases={sainsburys:'Sainsbury’s',sainsbury:'Sainsbury’s',tesco:'Tesco',asda:'Asda',morrisons:'Morrisons',waitrose:'Waitrose',aldi:'Aldi',lidl:'Lidl',coop:'Co-op',cooperative:'Co-op',ms:'M&S',msfood:'M&S',marksandspencer:'M&S',marksspencer:'M&S',marksandspencerfood:'M&S',ocado:'Ocado',iceland:'Iceland',spar:'SPAR',farmfoods:'Farmfoods',heronfoods:'Heron Foods',heron:'Heron Foods',booths:'Booths',budgens:'Budgens',boots:'Boots',wholefoodsmarket:'Whole Foods Market'};
  const canonicalRetailer=v=>aliases[text(v).toLowerCase().replace(/^en:/,'').replace(/[^a-z0-9]/g,'')]||null;
  function retailer(p={}){
    const explicit=canonicalRetailer(p.retailerId)||canonicalRetailer(p.retailer);if(explicit)return explicit;
    const brands=[...new Set(text(p.brand).split(',').map(canonicalRetailer).filter(Boolean))];if(brands.length===1)return brands[0];
    const stores=[...new Set(list(p.stores).map(canonicalRetailer).filter(Boolean))];return stores.length===1?stores[0]:null;
  }
  const identity=p=>text(p?.barcode)?'barcode:'+text(p.barcode):text(p?.identityKey)||text(p?.productId);
  const broad=new Set(['en:foods','en:beverages','en:plant-based-foods-and-beverages','en:plant-based-foods','en:snacks','en:groceries','en:dairies','en:meats']);
  const category=p=>[p?.categoryTag,...list(p?.categories).slice().reverse()].find(t=>typeof t==='string'&&/^en:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t)&&!broad.has(t))||null;
  function supportedScore(score,{complete=false}={}){
    if(!window.NudgeScoreCore?.validResult(score)||!score||score.methodId!==window.NudgeScoreCore?.CONFIG.methodId||!text(score.version)||!['rated','provisional','estimated','estimated_provisional'].includes(score.status)||(complete&&score.status!=='rated'))return null;
    const lower=score.displayLower??score.value,upper=score.displayUpper??score.value;
    if(!known(lower)||!known(upper)||!Number.isInteger(lower)||!Number.isInteger(upper)||lower<0||upper>100||lower!==upper||![0,25,50,75,100].includes(lower))return null;
    const b=score.calculationBasis;if(b?.unit!=='g'||b.per!==100||b.preparation!=='as_sold')return null;
    return {lower,upper,method:score.methodId,version:score.version,basis:JSON.stringify([b.per,b.unit,b.preparation])};
  }
  const canOffer=score=>{const s=supportedScore(score);return Boolean(s&&s.upper<100);};
  function dietary(p,profile={},options={}){
    const claims=[...list(p.labelsTags),...list(p.ingredientsAnalysisTags),...list(p.declaredClaims).map(c=>typeof c==='string'?c:c?.text),...list(p.claims).filter(c=>list(p.metadata?.evidence).some(e=>e.id===c.evidenceId&&text(e.text).toLowerCase().includes(text(c.text).toLowerCase()))).map(c=>c.kind)].map(x=>text(x).toLowerCase().replace(/^en:/,'').replace(/[_ ]+/g,'-'));
    const has=words=>claims.some(c=>words.includes(c));
    if((profile.diet==='vegan'&&has(['non-vegan','vegan-status-unknown']))||(profile.diet==='vegetarian'&&has(['non-vegetarian','vegetarian-status-unknown'])))return false;
    const restricted=Boolean(profile.diet!=='any'&&profile.diet!=='mixed'&&profile.diet||list(profile.avoids).length||list(profile.allergies).length||['coeliac','sensitivity'].includes(profile.glutenRequirement)||profile.glutenFreePreference||options.avoidMilk);
    const unresolved=['claims','allergens','ingredients'];
    if(restricted&&(p.ingredientsNeedsReview===true||p.ingredients?.needsReview===true
      ||list(p.metadata?.conflicts).some(c=>unresolved.includes(c.field))
      ||list(p.metadata?.missingFields).some(field=>unresolved.includes(field))))return false;
    if(profile.diet==='vegan'&&!has(['vegan','certified-vegan']))return false;
    if(profile.diet==='vegetarian'&&!has(['vegetarian','vegan','certified-vegan']))return false;
    if(profile.diet==='pescatarian'&&!has(['pescatarian','vegetarian','vegan','certified-vegan']))return false;
    const avoids=[...new Set([...list(profile.avoids),...list(profile.allergies),...(['coeliac','sensitivity'].includes(profile.glutenRequirement)||profile.glutenFreePreference?['gluten']:[]),...(options.avoidMilk?['milk']:[])])];
    // An empty catalogue allergen field is unknown. Positive free-from evidence is required for restrictions.
    const freeFrom={gluten:['gluten-free','no-gluten'],milk:['milk-free','dairy-free','no-milk'],nuts:['nut-free','nuts-free','no-nuts'],fish:['fish-free','no-fish'],eggs:['egg-free','eggs-free','no-eggs'],sesame:['sesame-free','no-sesame'],soy:['soy-free','soya-free','no-soy']};
    if(avoids.some(a=>!freeFrom[a]||!has(freeFrom[a])))return false;
    const checks=window.NudgeFoodDetailModel?.allergies(p,profile,options);if(checks?.conflict)return false;
    if(avoids.length&&(!checks||checks.unknown))return false;
    return true;
  }
  function select(current,candidates,{profile={},avoidMilk=false,preferredRetailer=null,score=window.NudgeFoodDetailModel?.score}={}){
    if(typeof score!=='function')return [];
    const original=score(current),base=supportedScore(original),purpose=category(current),id=identity(current),selectedShop=canonicalRetailer(preferredRetailer),shop=selectedShop||retailer(current);
    if(!base||base.upper>=100||!purpose)return [];
    const seen=new Set(id?[id]:[]),out=[];
    for(const p of list(candidates)){
      const pid=identity(p);if(!pid||seen.has(pid))continue;
      if(![p.categoryTag,...list(p.categories)].includes(purpose)||p.basisUnit!=='g'||p.nutritionPreparation!=='as_sold')continue;
      if(!text(p.sourceURL).startsWith('https://')||!text(p.retrievedAt)||!dietary(p,profile,{avoidMilk}))continue;
      const computed=score(p),s=supportedScore(computed,{complete:true});
      if(!s||s.lower<=base.upper||s.method!==base.method||s.version!==base.version||s.basis!==base.basis)continue;
      seen.add(pid);out.push({product:p,score:computed,value:s.lower,retailer:retailer(p),identity:pid});
    }
    // An explicit shopping context outranks the scanned product's own brand.
    // Only actual source store listings can establish that selected-shop match.
    const atShop=row=>selectedShop?list(row.product.stores).some(store=>canonicalRetailer(store)===selectedShop):row.retailer===shop;
    return out.sort((a,b)=>(shop?Number(atShop(b))-Number(atShop(a)):0)||b.value-a.value||a.identity.localeCompare(b.identity)).slice(0,12);
  }
  return {canonicalRetailer,retailer,identity,category,supportedScore,canOffer,dietary,select};
})();
window.createNudgeAlternatives = function({render,esc,getProduct,getDraftId=()=>'',getProfile=()=>({}),getAvoidMilk=()=>false,beforeRender=()=>true,prefix}){
  const rules=window.NudgeAlternatives,model=()=>window.NudgeFoodDetailModel;
  const state={phase:'idle',requestId:null,products:[],reference:null};
  const reset=()=>Object.assign(state,{phase:'idle',requestId:null,products:[],reference:null});
  const nutrients=p=>Object.fromEntries(Object.entries(p?.nutrients||{}).filter(([,n])=>typeof n?.value==='number'&&Number.isFinite(n.value)&&n.value>=0).sort(([a],[b])=>a.localeCompare(b)).map(([key,n])=>[key,n.value]));
  const reference=p=>JSON.stringify({draft:getDraftId(),identity:rules.identity(p),analysisVersion:p?.analysisVersion||'',captureRevision:p?.captureRevision??null,fingerprint:model()?.scoreFingerprint(p),category:rules.category(p),retailer:rules.retailer(p),score:model()?.score(p),diet:getProfile().diet||'',avoids:[...(getProfile().avoids||[])].sort(),safety:window.NudgeNutrition?.safetyProfile?.(getProfile())||getProfile(),avoidMilk:getAvoidMilk()});
  const available=()=>!window.NudgeHistory?.isDeleted?.(getDraftId());
  function currentRows(){const p=getProduct();return available()&&state.phase==='ready'&&state.reference===reference(p)?rules.select(p,state.products,{profile:getProfile(),avoidMilk:getAvoidMilk()}):[];}
  function diagnostics(){const p=getProduct(),rows=currentRows();if(!available())return {status:'ineligible',reason:'deleted',count:0};if(!p||!rules.canOffer(model()?.score(p)))return {status:'ineligible',reason:'current_score',count:0};if(!rules.category(p))return {status:'ineligible',reason:'category_unknown',count:0};return {status:rows.length?'visible':state.phase==='error'?'retrieval_failure':state.phase==='ready'?'no_qualifying_candidates':state.phase==='loading'?'loading':'not_requested',count:rows.length};}
  function receive(event){if(!state.requestId||event.requestId!==state.requestId)return;
    if(beforeRender()===false||!available()){reset();return;}
    if(state.reference!==reference(getProduct())){reset();render();return;}
    state.phase=event.type==='alternatives'?'ready':'error';state.products=Array.isArray(event.products)?event.products.slice(0,40):[];state.requestId=null;render();
  }
  function screen(){const p=getProduct();if(state.reference&&state.reference!==reference(p))reset();auto(false);
    const rows=currentRows();if(!rows.length)return '';
    return `<section class="nf-alternatives" aria-labelledby="nf-alternatives-heading"><h2 id="nf-alternatives-heading">Better alternatives</h2><div class="nf-alternative-track" role="list" aria-label="Better alternatives">${rows.map((item,i)=>{const p=item.product,img=window.NudgeResults?.productImage?.(p)?.src,tone=item.value>=50?'daily':item.value>=25?'weekly':'monthly';return `<a class="nf-alternative-card nf-band-${tone}" role="listitem" href="${esc(p.sourceURL)}" target="_blank" rel="noopener noreferrer" aria-label="${esc([item.retailer||p.brand,p.name,`${item.value} out of 100`,`${i+1} of ${rows.length}`].filter(Boolean).join(', '))}">${img?`<img src="${esc(img)}" alt="" loading="lazy">`:'<span class="nf-alternative-image" aria-hidden="true">'+(window.NudgeIcons?.('shopping-bag')||'')+'</span>'}<span class="nf-alternative-copy"><span class="nf-alternative-brand">${esc(item.retailer||p.brand||'Product')}</span><strong>${esc(p.name||'Product')}</strong></span><span class="nf-alternative-value">${item.value}<small>/100</small></span></a>`;}).join('')}</div></section>`;
  }
  function sources(){return currentRows().map(({product:p})=>`<span>Alternative: <a href="${esc(p.sourceURL)}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a> · ${esc(p.sourceName||'Product catalogue')} · retrieved ${esc(p.retrievedAt)}${p.licenceName?' · '+esc(p.licenceName):''}</span>`).join('');}
  function request(notify=true,collectFields=true){
    const handler=window.webkit?.messageHandlers?.nudgeBarcode;if(!available()||(collectFields&&beforeRender()===false))return;
    const p=getProduct();if(!p||!rules.canOffer(model()?.score(p))||!rules.category(p))return;
    const currentReference=reference(p);if(state.reference&&state.reference!==currentReference)reset();if(state.phase!=='idle')return;
    if(!handler){state.phase='error';state.reference=currentReference;return;}
    state.requestId=`alternatives-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;state.phase='loading';state.products=[];state.reference=currentReference;
    try{handler.postMessage({action:'product-alternatives',requestId:state.requestId,target:prefix,draftId:getDraftId(),barcode:p.barcode||'',categoryTag:rules.category(p),retailer:rules.retailer(p)||'',basisUnit:p.basisUnit,nutritionPreparation:p.nutritionPreparation,nutrients:nutrients(p)});}catch{state.phase='error';state.requestId=null;}
    if(notify)render();
  }
  function handleAction(action){if(action!==prefix+'-alternatives')return false;request();return true;}
  function auto(notify=true){if(state.reference&&state.reference!==reference(getProduct()))reset();if(state.phase==='idle')request(notify,false);}
  return {screen,sources,receive,handleAction,reset,auto,rows:currentRows,diagnostics};
};
// Native camera renders this bounded presentation model. All scoring/safety/filtering stays shared with full detail.
window.NudgeQuickSummary = (()=>{
  const text=(v,max=180)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
  const image=v=>{if(typeof v!=='string'||v.length>49152)return '';const s=text(v,49152);if(/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(s))return s;return window.NudgeResults?.imageURL(s)||'';};
  function recovery(product,error){
    if(error){const code=text(error.code,60);if(code==='not_found')return {status:'needs_label',message:'Photograph the nutrition and ingredients panels to identify this product.',panel:'both',primaryAction:'label',primaryTitle:'Photograph the label',errorCategory:'catalogue_miss'};
      const category=/timeout|offline|network|connect/i.test(code)?'catalogue_connection':/decod|invalid|incomplete|parse/i.test(code)?'catalogue_response':/rate/i.test(code)?'catalogue_rate_limit':'catalogue_service';
      return {status:'error',message:category==='catalogue_connection'?"Product lookup couldn't connect. You can photograph the label.":category==='catalogue_response'?"Product details couldn't be read. Photograph the label to continue.":"Product lookup is unavailable. You can photograph the label.",panel:'both',primaryAction:'label',primaryTitle:'Photograph the label',errorCategory:category};}
    const p=product||{},score=window.NudgeFoodDetailModel?.score(p),rated=['rated','provisional'].includes(score?.status),nutrition=!['g','ml'].includes(p.basisUnit)||['energyKcal','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'].some(k=>!Number.isFinite(p.nutrients?.[k]?.value)),ingredients=!(typeof p.ingredients==='string'?p.ingredients.trim():p.ingredients?.text?.trim()),conflicts=Array.isArray(p.metadata?.conflicts)&&p.metadata.conflicts.length>0;
    if(nutrition||ingredients||conflicts){const panel=conflicts?'both':nutrition&&ingredients?'both':nutrition?'nutrition':'ingredients';return {status:['rated','provisional'].includes(score?.status)?'ready':'needs_label',message:panel==='nutrition'?'Photograph the nutrition panel to finish this product.':panel==='ingredients'?'Photograph the ingredients panel to complete its label.':conflicts?'Photograph the current pack to resolve conflicting details.':'Photograph the nutrition and ingredients panels.',panel,primaryAction:'label',primaryTitle:panel==='nutrition'?'Add nutrition photo':panel==='ingredients'?'Add ingredients photo':'Photograph the label'};}
    return {status:rated?'ready':'needs_label',message:rated?'':'More label context is needed for a score. Open the product to review its details.',panel:null,primaryAction:'expand',primaryTitle:'View product'};
  }
  function build({phase,product,thumbnail,error,profile={},avoidMilk=false,alternatives=[],diagnostics={status:'not_requested',count:0}}){
    if(phase==='loading')return {status:'loading',name:'Finding your product…',brand:'',scoreText:'',bandText:'',methodText:'',message:'',primaryAction:'label',primaryTitle:'Photograph the label',panel:'both',alternatives:[],diagnostics:{status:'ineligible',reason:'loading',count:0}};
    const p=product||{},m=window.NudgeFoodDetailModel,score=p&&m?.score(p),rough=score?.status==='estimated_rough'&&window.NudgeMealScore?.validResult?.(score)===true,supported=(rough||window.NudgeScoreCore?.validResult?.(score))&&Number.isFinite(score?.value),status=recovery(product,error),allergies=m?.allergies(p,profile,{avoidMilk}),recall=p.recallAssessment,warning=[allergies?.conflict?allergies.warning:'',['matched','potential_match'].includes(recall?.status)?recall.status==='matched'?'Recall notice applies. Check the full advice before consuming.':'Possible recall match. Check the pack details before consuming.':''].filter(Boolean).join(' ');
    return {...status,name:text(p.name)||'Your product',brand:text(p.brand,100),imageURL:image(p.imageURL||p.imageUrl||p.imageFrontURL),thumbnail:image(thumbnail),scoreText:supported?(String(score.value))+' / 100':'Needs label',score:supported?score.value:null,grade:supported?score.grade:null,scoreLabel:rough?'Rough estimate':'Nudge nutrition score',scoreStatus:score?.status||'unrated',scoreConfidence:rough?'low':null,baseFrequency:score?.baseFrequency||null,finalFrequency:null,frequencyStatus:warning?'check_required':'pending',scoreVersion:score?.version||window.NudgeScoreCore?.CONFIG.version,scoreMethod:score?.methodId||window.NudgeScoreCore?.CONFIG.methodId,bandText:warning?'Safety notice':supported?'Nutrition quality':'',methodText:supported?'Nutri-Score 2023 · Nudge scale':'',provisionalText:rough?'Rough estimate · low confidence':score?.estimated===true?'Estimated nutrition data':score?.status==='provisional'?'Provisional':'',warningText:text(warning,420),alternatives:alternatives.slice(0,12).map(row=>({id:text(row.identity,180),name:text(row.product?.name),brand:text(row.retailer||row.product?.brand,100),imageURL:image(row.product?.imageURL||row.product?.imageUrl||row.product?.imageFrontURL),scoreText:String(row.value)+' / 100',score:row.value,sourceURL:text(row.product?.sourceURL,500)})),diagnostics};
  }
  return {build,recovery};
})();
window.createNudgeBarcode = function(ctx) {
  'use strict';
  const {getState,view,escapeHtml:esc,todayKey,save,render:renderPage,navigate,showToast} = ctx;
  const diaryStore=window.NudgeDiary.create({getState,save,cleanEntry:raw=>window.WmdFoodLog.clean({entries:[raw]}).entries[0]});
  const camera={active:false,requestId:null,draftId:null,captureRevision:0,analysisVersion:'',lastPayload:null};
  const visible=()=>camera.active||['barcode','product'].includes(view.screen);
  function render(){if(camera.active)publishSummary();else renderPage();}
  const keys=['energyKcal','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'];
  const scan={phase:'idle',product:null,error:null,confirmationId:null,thumbnail:'',amount:100,unit:'g',day:todayKey(),slot:'',portion:null,entryId:'',consumptionId:'',editing:false,invalidQuantity:false,detailError:'',saving:false,lastQuantityRaw:null,draftProduct:null};
  function clearSearchRefresh({unavailable=false,cancel=true}={}){
    if(scan.searchRefreshID&&cancel)try{window.webkit?.messageHandlers?.nudgeBarcode?.postMessage({action:'cancel-search-product-refresh',requestId:scan.searchRefreshID,draftId:scan.confirmationId});}catch{}
    if(scan.searchRefreshTimer!=null)clearTimeout(scan.searchRefreshTimer);scan.searchRefreshTimer=null;scan.searchRefreshID=null;scan.searchRefreshing=false;scan.searchRefreshUnavailable=unavailable;
    if(scan.detailError==='Wait for the current product check to finish before adding this food.')scan.detailError='';
  }
  const invalidatedIDs=new Set(),retiredRequests=new Set(),expandedRequests=new Set();
  function closeCamera(){camera.active=false;camera.lastPayload=null;}
  function suspendCamera({requestId,draftId}={}){if((!requestId||requestId===camera.requestId)&&(!draftId||draftId===camera.draftId))closeCamera();}
  function activateCamera(event){
    if(!event.cameraSummary)return true;
    if(!event.requestId||!(event.draftId||event.eventId)||retiredRequests.has(event.requestId))return false;
    if(camera.active&&(camera.requestId!==event.requestId||camera.draftId!==(event.draftId||event.eventId)))return false;
    if(expandedRequests.has(event.requestId))return event.requestId===camera.requestId&&camera.draftId===(event.draftId||event.eventId);
    if(camera.active&&Number.isInteger(event.captureRevision)&&event.captureRevision<camera.captureRevision)return false;
    Object.assign(camera,{active:true,requestId:event.requestId,draftId:event.draftId||event.eventId,captureRevision:Number.isInteger(event.captureRevision)?event.captureRevision:0,analysisVersion:typeof event.analysisVersion==='string'?event.analysisVersion:'',lastPayload:null});return true;
  }
  function publishSummary(){
    if(!camera.active||camera.draftId!==scan.confirmationId||window.NudgeHistory?.isDeleted?.(camera.draftId))return;
    if(scan.phase==='product'){ensureRecalls();alternatives.auto(false);}
    const p=calculationProduct(),summary=window.NudgeQuickSummary.build({phase:scan.phase,product:p,thumbnail:scan.thumbnail,error:scan.phase==='error'?scan.error:null,profile:getState().nutritionProfile||{},avoidMilk:getState().avoidMilk===true,alternatives:alternatives.rows(),diagnostics:alternatives.diagnostics()});
    const message={action:'camera-summary-update',requestId:camera.requestId,draftId:camera.draftId,captureRevision:camera.captureRevision,analysisVersion:camera.analysisVersion,summary},encoded=JSON.stringify(message);if(encoded===camera.lastPayload)return;
    camera.lastPayload=encoded;
    // Bounded metadata-only diagnostics distinguish an intentional hidden carousel from unavailable retrieval.
    window.NudgeQuickSummaryDiagnostics={requestId:camera.requestId,draftId:camera.draftId,captureRevision:camera.captureRevision,phase:summary.status,alternatives:summary.diagnostics,errorCategory:summary.errorCategory||null};
    try{scoreHandler()?.postMessage(message);}catch{camera.lastPayload=null;}
  }
  function cameraAction(event){
    if(!camera.active||event.requestId!==camera.requestId||event.draftId!==camera.draftId||event.captureRevision!==camera.captureRevision||String(event.analysisVersion||'')!==camera.analysisVersion||window.NudgeHistory?.isDeleted?.(camera.draftId))return;
    const action=event.action;if(!['expand','next','label','retry','alternative'].includes(action))return;
    const row=action==='alternative'?alternatives.rows().find(r=>r.identity===event.alternativeId):null;if(action==='alternative'&&!row)return;
    closeCamera();
    if(action==='expand'){expandedRequests.add(camera.requestId);navigate('barcode');ensureScore();render();return;}
    if(action==='alternative'){
      retiredRequests.add(camera.requestId);cancelScore();const id=unique();navigate('barcode');receive({type:'product',eventId:id,product:JSON.parse(JSON.stringify(row.product))});return;
    }
    retiredRequests.add(camera.requestId);cancelScore();
    if(action==='label'&&window.NudgeLabel?.continueProduct){window.NudgeLabel.continueProduct(scan,{panel:window.NudgeQuickSummary.recovery(scan.product,scan.phase==='error'?scan.error:null).panel||'both'});return;}
    window.NudgeLabel?.handleAction(action==='next'?'result-next':action==='retry'?'product-retry':'product-label');
  }
  function invalidate(id){
    if(id!==scan.confirmationId&&id!==scan.entryId&&id!=='diary:'+scan.entryId)return;
    invalidatedIDs.add(scan.confirmationId);if(camera.requestId)retiredRequests.add(camera.requestId);closeCamera();clearSearchRefresh();cancelScore();alternatives.reset();recallState.requestId=null;recallState.reference=null;
  }
  const model=()=>window.NudgeFoodDetailModel;
  const entries=()=>getState().foodLog?.entries||[];
  const ownEntries=()=>entries().filter(e=>e.sourceMeta?.entryKind==='product-consumption'&&(e.sourceMeta?.productScanEventId||e.sourceMeta?.scanEventId)===scan.confirmationId);
  const linked=()=>entries().find(e=>e.id===scan.entryId&&e.sourceMeta?.entryKind==='product-consumption');
  function calculationProduct(entry=linked()){
    const original=scan.draftProduct||scan.product;if(!entry||!original)return original;
    const repaired=entry.sourceMeta?.scoreMethod?.sourceData?.source==='User-confirmed label repair'&&['nudge_nutrition_v0_4','nudge_nutrition_v0_3','nudge_nutrition_v0_2','nudge_food_estimate_v2','nudge_food_estimate_v3'].includes(entry.sourceMeta.scoreMethod.methodId)?entry.sourceMeta.scoreMethod.reviewedProductFacts:null;
    const p=repaired?{...original,...repaired,metadata:{...original.metadata,conflicts:(repaired.unresolvedFields||[]).map(field=>({field}))},scoreResult:null}:original;
    const basis=entry.sourceMeta?.labelBasis==='per100ml'?'ml':entry.sourceMeta?.labelBasis==='per100g'?'g':p.basisUnit;
    const primary={energyKcal:'energyPerPortion',protein:'proteinPerPortion',fibre:'fibrePerPortion'},nutrients={};
    for(const key of keys){const snapshot=entry.nutritionSnapshot?.[key],amount=primary[key]?entry[primary[key]]:snapshot?.portion;
      const value=typeof amount==='number'&&Number.isFinite(amount)&&entry.portionAmount>0&&basis===entry.portionUnit?typeof snapshot?.per100==='number'&&snapshot.portion===amount?snapshot.per100:amount*100/entry.portionAmount:null;
      if(value!==null){
        const reviewed=repaired?.nutrients?.[key];
        // Calculated per-serving conversions are eligible only when the exact
        // same value was explicitly confirmed in this repair's source facts.
        const status=repaired?(reviewed?.value===value&&['supplied','confirmed'].includes(reviewed?.status)?'confirmed':'unknown'):snapshot?.per100Status||'supplied';
        nutrients[key]={value,status,...(reviewed?.relation?{relation:reviewed.relation}:{})};
      }
    }
    const result={...p,...(repaired?{reviewedProductFacts:repaired}:{}),name:entry.name||p.name,brand:entry.brand??p.brand,portionSaltConflict:entry.sourceMeta?.portionSaltConflict===true,servingNutrients:null,servingNutrientSource:null,confirmedPortion:{amount:entry.portionAmount,unit:entry.portionUnit,nutrients:Object.fromEntries(keys.map(key=>[key,primary[key]?entry[primary[key]]:entry.nutritionSnapshot?.[key]?.portion??null]))},reviewedPlants:{source:'confirmed-diary',names:entry.plants||[],known:entry.sourceMeta?.plantKnowledge==='known',evidence:entry.ingredients?.plants||[]},basisUnit:basis,nutrients,ingredients:entry.ingredients?.text||p.ingredients,ingredientPlants:entry.ingredients?.plants||p.ingredientPlants,nutritionPreparation:entry.sourceMeta?.nutritionPreparation||p.nutritionPreparation,sourceName:entry.sourceMeta?.provider&&entry.sourceMeta.provider!==p.sourceName?p.sourceName+' + confirmed diary values':p.sourceName,scoreSource:p.scoreSource||(p.sourceName==='Open Food Facts'?{provider:p.sourceName,url:p.sourceURL,retrievedAt:p.retrievedAt}:null)};
    if(model()?.scoreFingerprint(result)!==model()?.scoreFingerprint(p)){
      result.nutriScoreGrade=null;result.nutriScore2023=null;result.scoreSource=null;
      if(model()?.value(result,'energyKcal')!==model()?.value(p,'energyKcal'))result.energyKj=null;
    }
    return result;
  }
  const scoreState={request:null,error:null,fingerprint:null},scoreAttempts=new Map(),scoreResults=new Map();
  const scoreCache=(map,key,value)=>{map.delete(key);map.set(key,value);while(map.size>100)map.delete(map.keys().next().value);};
  const scoreHandler=()=>window.webkit?.messageHandlers?.nudgeBarcode;
  function cancelScore(){
    const request=scoreState.request;
    if(request){try{scoreHandler()?.postMessage({action:'cancel-product-score',requestId:request.id,draftId:request.draftId});}catch{}scoreAttempts.delete(request.fingerprint);}
    scoreState.request=null;scoreState.error=null;scoreState.fingerprint=null;
  }
  function rememberScore(result,fingerprint,{recovery=null,checkedAt=new Date().toISOString()}={}){
    const catalogue=window.NudgeFoodCatalogue,original=calculationProduct(),originalFingerprint=fingerprint;
    recovery=catalogue?.cleanRecovery(recovery)||null;
    // A later lookup enriches an unconsumed analysis only. Confirmed intake and
    // its original amount/nutrient/score snapshot remain untouched.
    if(recovery?.status==='verified'&&recovery.product&&!linked()){
      const merged=catalogue?.mergeRecovery(scan.product,recovery);
      if(merged){scan.product=merged;if(scan.draftProduct)scan.draftProduct=catalogue.mergeRecovery(scan.draftProduct,recovery)||scan.draftProduct;fingerprint=model().scoreFingerprint(calculationProduct());}
      else {result=model().calculatedScore(calculationProduct());recovery=null;}
    }
    const cached={inputFingerprint:fingerprint,methodId:result.methodId,version:result.version,result,checkedAt,...(recovery?{recovery}:{})};
    scoreCache(scoreResults,fingerprint,cached);scan.product={...scan.product,scoreResult:cached};
    if(scan.draftProduct)scan.draftProduct={...scan.draftProduct,scoreResult:cached};
    catalogue?.put(calculationProduct(),cached);
    if(originalFingerprint!==fingerprint){const previous={...cached,inputFingerprint:originalFingerprint};scoreCache(scoreResults,originalFingerprint,previous);catalogue?.put(original,previous);}
    const {recallAssessment,...storedProduct}=scan.product;
    const recordedRecall=window.NudgeHistory?.find?.(scan.confirmationId)?.product?.recallAssessment;
    if(recordedRecall)storedProduct.recallAssessment=recordedRecall;
    if(!scan.confirmationId?.startsWith('search-product:')||window.NudgeHistory?.find?.(scan.confirmationId))window.NudgeHistory?.record({id:scan.confirmationId,product:storedProduct});
  }
  function ensureScore({retry=false}={}){
    const m=model(),p=calculationProduct();if(!m?.scoreFingerprint||!p||scan.phase!=='product'||!visible()||scan.searchRefreshing)return;
    const fingerprint=m.scoreFingerprint(p),draftId=scan.confirmationId;
    if(scoreState.request&&(scoreState.request.fingerprint!==fingerprint||scoreState.request.draftId!==draftId))cancelScore();
    scoreState.fingerprint=fingerprint;scoreState.error=null;
    const present=m.score(p),catalogue=window.NudgeFoodCatalogue;
    if(m.isCatalogueQualityHold(m.cachedScore(p),p)||m.isCatalogueQualityCheck(m.cachedScore(p),p)){if(scoreState.request)cancelScore();return;}
    if(['rated','estimated'].includes(present.status)||present.scoreBasis==='provider_nutriscore_2023'){if(!m.cachedScore(p)&&m.calculatedScore){const result=m.calculatedScore(p);if(m.validScoreResult(result))rememberScore(result,fingerprint);}if(scoreState.request)cancelScore();return;}
    // Old unavailable results must not suppress recovery forever. Current
    // incomplete results use a bounded cooldown, shared across app launches.
    const cached=m.cachedScore(p)?p.scoreResult:scoreResults.get(fingerprint)||catalogue?.get(p);
    const recentIncomplete=catalogue?.freshIncomplete(cached)||(['unrated','provisional','estimated_provisional'].includes(cached?.result?.status)&&Number.isFinite(Date.parse(cached.checkedAt||''))&&Date.now()-Date.parse(cached.checkedAt)<6*3600000);
    if(cached&&!retry&&(['rated','estimated'].includes(cached.result.status)||recentIncomplete)){if(cached!==p.scoreResult)rememberScore(cached.result,fingerprint,{recovery:cached.recovery,checkedAt:cached.checkedAt});return;}
    if(scoreState.request)return;
    if(!retry&&scoreAttempts.has(fingerprint)){scoreState.error=scoreAttempts.get(fingerprint).error||null;return;}
    if(!retry&&catalogue?.canRecover(p)===false)return;
    const handler=scoreHandler();if(!handler){scoreState.error={code:'unavailable',message:'Rating is unavailable here. Try again in the iPhone app.'};scoreCache(scoreAttempts,fingerprint,{error:scoreState.error});return;}
    const request={id:'score-'+Date.now()+'-'+Math.random().toString(36).slice(2,12),draftId,fingerprint};scoreState.request=request;scoreCache(scoreAttempts,fingerprint,{pending:true});
    try{handler.postMessage({action:'product-score',product:m.scoreFacts(p),requestId:request.id,draftId});}
    catch{scoreState.request=null;scoreState.error={code:'unavailable',message:'Could not request a rating. Try again.'};scoreCache(scoreAttempts,fingerprint,{error:scoreState.error});}
  }
  function receiveScore(event){
    const request=scoreState.request,m=model();
    if(m?.isCatalogueQualityHold(m.cachedScore(calculationProduct()),calculationProduct())){cancelScore();return;}
    if(!request||event.requestId!==request.id||event.draftId!==request.draftId)return;
    if(scan.confirmationId!==request.draftId||scan.phase!=='product'||!visible()||m.scoreFingerprint(calculationProduct())!==request.fingerprint){cancelScore();return;}
    scoreState.request=null;
    if(event.type==='product-score'&&m.validScoreResult(event.result?.score)){
      rememberScore(event.result.score,request.fingerprint,{recovery:event.result.recovery});scoreCache(scoreAttempts,request.fingerprint,{complete:true});scoreState.error=null;
    }else{
      const code=typeof event.code==='string'?event.code:'invalid_response';
      const message=code==='permission_required'?'Enable product analysis in Settings, then try again.':code==='signInRequired'?'Sign in to get a rating.':typeof event.error==='string'?event.error.slice(0,240):typeof event.error?.message==='string'?event.error.message.slice(0,240):'Could not get a rating. Try again.';
      scoreState.error={code,message};scoreCache(scoreAttempts,request.fingerprint,{error:scoreState.error});window.NudgeFoodCatalogue?.attempted(calculationProduct(),{failed:true});
    }
    const active=document.activeElement;
    if(active?.id==='detail-quantity'&&active.closest?.('.nf-detail'))liveRender(active);else render();
  }
  const recallState={reference:null,requestId:null,draftId:null};
  const recallProduct=()=>{const p=calculationProduct()||{},facts=Object.fromEntries(['name','brand','barcode','packSize','packAmount','packUnit','batchCode','lotNumber','bestBefore','useBy','purchaseDate'].filter(k=>p[k]!=null).map(k=>[k,p[k]]));if(!facts.packSize)facts.packSize=p.quantity||(Number.isFinite(p.packAmount)&&['g','ml'].includes(p.packUnit)?p.packAmount+' '+p.packUnit:'');if(!facts.batchCode&&p.metadata?.batchCode)facts.batchCode=p.metadata.batchCode;return facts;};
  const recallReference=()=>JSON.stringify([scan.confirmationId,scan.product?.captureRevision??null,scan.product?.analysisVersion||'',recallProduct()]);
  function ensureRecalls(){
    if(!window.NudgeFoodEvidence||!scan.product||scan.phase!=='product'||window.NudgeHistory?.isDeleted?.(scan.confirmationId))return;
    const ref=recallReference();if(recallState.reference===ref){const checked=Date.parse(scan.product.recallAssessment?.checkedAt||'');if(!Number.isFinite(checked)||Date.now()-checked<3600000)return;}
    recallState.reference=ref;recallState.requestId='recall-'+Date.now()+'-'+Math.random().toString(36).slice(2,9);recallState.draftId=scan.confirmationId;
    const product=recallProduct(),handler=scoreHandler();
    const unavailable=()=>{const assessment=window.NudgeFoodEvidence.assessRecalls(product,{status:'check_unavailable'});scan.product={...scan.product,recallAssessment:assessment};if(scan.draftProduct)scan.draftProduct={...scan.draftProduct,recallAssessment:assessment};recallState.requestId=null;};
    scan.product={...scan.product,recallAssessment:{status:'checking',matches:[],message:'Checking current recall notices…'}};
    if(scan.draftProduct)scan.draftProduct={...scan.draftProduct,recallAssessment:scan.product.recallAssessment};
    if(!handler){unavailable();return;}
    try{handler.postMessage({action:'product-recalls',requestId:recallState.requestId,draftId:recallState.draftId,product});}catch{unavailable();}
  }
  function receiveRecalls(event){
    if(!recallState.requestId||event.requestId!==recallState.requestId||event.draftId!==recallState.draftId)return;
    if(scan.confirmationId!==recallState.draftId||recallReference()!==recallState.reference||!visible()||scan.phase!=='product'||window.NudgeHistory?.isDeleted?.(scan.confirmationId)){recallState.reference=null;recallState.requestId=null;return;}
    recallState.requestId=null;const assessment=window.NudgeFoodEvidence.assessRecalls(recallProduct(),event.response);
    // Refresh safety information in the open view; do not silently replace historical evidence or consumed nutrition.
    scan.product={...scan.product,recallAssessment:assessment};if(scan.draftProduct)scan.draftProduct={...scan.draftProduct,recallAssessment:assessment};
    const active=document.activeElement;if(active?.id==='detail-quantity'&&active.closest?.('.nf-detail'))liveRender(active);else render();
  }
  const unique=()=>`portion-${Date.now()}-${Math.random().toString(36).slice(2,12)}`;
  const firstID=()=>{const id=`food:${scan.confirmationId}`.slice(0,100);return window.NudgeHistory?.isEntryDeleted?.(id)?`${id.slice(0,65)}:${Date.now()}-${Math.random().toString(36).slice(2,8)}`:id;};
  const valid=()=>Boolean(scan.product&&scan.portion&&!scan.searchRefreshing&&!scan.invalidQuantity&&Number.isFinite(scan.portion.canonicalAmount)&&scan.portion.canonicalAmount>0&&scan.portion.canonicalAmount<=5000&&['g','ml'].includes(scan.portion.unit));
  function syncAmount(){scan.lastQuantityRaw=null;if(scan.portion){scan.amount=scan.portion.canonicalAmount;scan.unit=scan.portion.unit;}}
  function restoreSelection(entry){
    const saved=entry?.sourceMeta?.portionSelection;scan.entryId=entry?.id||'';scan.draftProduct=null;
    scan.portion=model()?.createPortion(calculationProduct(entry),saved);
    if(entry&&scan.portion&&entry.portionAmount&&entry.portionUnit===scan.portion.unit)scan.portion={...scan.portion,canonicalAmount:entry.portionAmount*entry.portions};
    scan.entryId=entry?.id||'';scan.consumptionId=entry?.sourceMeta?.confirmationId||firstID();scan.editing=false;scan.invalidQuantity=false;scan.detailError='';scan.day=entry?.day||todayKey();scan.slot=entry?.slot??'';syncAmount();
  }
  function detail(){
    const m=model();if(!m||!scan.product)return null;if(!scan.portion)restoreSelection(ownEntries().at(-1));
    const entry=linked(),p=calculationProduct(entry),status=entry?(scan.editing?'editing':'saved'):'draft',measures=m.measures(p),measure=m.selectedMeasure(p,scan.portion),quantity=m.quantity(p,scan.portion);
    return {product:p,portion:scan.portion,measures,quantity,inputValue:scan.lastQuantityRaw,nutrients:m.portionNutrients(p,scan.portion),plants:m.plants(p),projection:m.projection(getState(),scan.day,p,scan.portion,{entryId:entry?.id,asOfDay:todayKey()}),score:scan.searchRefreshing?{status:'unrated',value:null,grade:null,reason:'Checking current product details before calculating the score.'}:window.NudgeFrequency?.apply(m.score(p),{product:p,profile:getState().nutritionProfile||{},avoidMilk:getState().avoidMilk,entries:entries(),day:scan.day,slot:scan.slot,excludeId:entry?.id,salt:m.servingConflict(p,scan.portion)?null:m.portionNutrients(p,scan.portion).salt})||m.score(p),historicalScore:entry?.sourceMeta?.scoreMethod,scoreLoading:Boolean(scan.searchRefreshing||scoreState.request&&scoreState.request.fingerprint===m.scoreFingerprint(p)),scoreError:scoreState.fingerprint===m.scoreFingerprint(p)?scoreState.error:null,allergies:m.allergies(p,getState().nutritionProfile||{},{avoidMilk:getState().avoidMilk}),risks:m.risks(p,scan.portion),meal:scan.slot,day:scan.day,status,entryId:entry?.id||'',error:scan.detailError,valid:valid(),selectionLabel:`${Number.isFinite(quantity)?Number(quantity.toFixed(3)):'—'} ${quantity===1?measure?.label:measure?.plural||measure?.label}`,origin:view.resultOrigin||'camera'};
  }
  function productScreen(){if(!scan.searchRefreshing){ensureScore();ensureRecalls();}return (scan.searchRefreshing?'<p class="small muted" role="status">Checking current product details…</p>':scan.searchRefreshUnavailable?'<p class="small muted" role="status">Current product details could not be checked. This is a search catalogue snapshot; check the current pack.</p>':'')+window.NudgeResults.product(scan.product,{profile:getState().nutritionProfile,avoidMilk:getState().avoidMilk,thumbnail:scan.thumbnail,alternatives:scan.searchRefreshing?'':alternatives.screen(),alternativeSources:scan.searchRefreshing?'':alternatives.sources(),detail:detail()});}
  function errorScreen(){const recovery=window.NudgeQuickSummary.recovery(null,scan.error||{});return `<div class="n-saved">${window.NudgeHistory?.isSaved()===false?'History not saved':'Saved to history'}</div><section class="n-rating"><div><h1 class="n-title">${recovery.status==='needs_label'?'Add the label':'Lookup interrupted'}</h1><p>${esc(recovery.message)}</p></div></section><button class="n-wide-button n-primary" data-action="product-label">Photograph the label</button>${scan.error?.code!=='not_found'?'<button class="n-wide-button" data-action="product-retry">Retry lookup</button>':''}<button class="n-wide-button" data-action="result-next">Scan next</button>`;}
  function screen(){
    if(scan.phase==='loading')return '<div class="n-saved">'+(window.NudgeHistory?.isSaved()===false?'History not saved':'Saved to history')+'</div><section class="scan-wait">'+(window.NudgeAnalysisCrew?.({kind:'barcode'})||'<span class="spinner" aria-hidden="true"></span><h1>Finding your product…</h1>')+'</section>';
    if(scan.phase==='error')return errorScreen();
    if(scan.phase==='product'&&scan.product)return productScreen();
    return '<h1>Point at your food</h1><p>Barcode, pack or label.</p><button class="button primary" data-action="scan-food">Open camera</button>';
  }
  const alternatives=window.createNudgeAlternatives({render:()=>{const active=document.activeElement;if(active?.id==='detail-quantity'&&active.closest?.('.nf-detail'))liveRender(active);else render();},esc,getProduct:()=>calculationProduct(),getProfile:()=>getState().nutritionProfile||{},getAvoidMilk:()=>getState().avoidMilk===true,getDraftId:()=>scan.confirmationId,prefix:'barcode'});
  function receive(event){
    if(!event||typeof event!=='object')return;
    if(event.type==='search-product-refreshed'){
      if(!scan.searchRefreshing||!scan.searchRefreshID||event.requestId!==scan.searchRefreshID||event.draftId!==scan.confirmationId)return;
      const current=scan.phase==='product'&&visible()&&view.resultOrigin==='search'&&!linked()&&!scan.editing&&!scan.saving&&!invalidatedIDs.has(scan.confirmationId)&&!window.NudgeHistory?.isDeleted?.(scan.confirmationId);
      const product=event.product&&event.product.barcode===scan.product?.barcode?event.product:null;
      clearSearchRefresh({unavailable:!product||!current,cancel:false});
      if(!current)return;
      if(product){const previous=scan.portion,raw=scan.lastQuantityRaw;cancelScore();alternatives.reset();recallState.requestId=null;recallState.reference=null;scan.product=product;scan.draftProduct=null;scan.portion=model().createPortion(product,previous?.unit===product.basisUnit?previous:null);syncAmount();if(scan.invalidQuantity)scan.lastQuantityRaw=raw;scan.detailError=scan.invalidQuantity?'Enter an amount greater than zero.':'';}
      if(view.screen==='barcode')render();return;
    }
    if(event.type==='camera-summary-action'){cameraAction(event);return;}
    if(retiredRequests.has(event.requestId))return;
    if(invalidatedIDs.has(event.eventId||event.draftId||scan.confirmationId)){if(event.type==='loading'&&event.requestId)invalidatedIDs.delete(event.eventId||event.draftId);else return;}
    if(window.NudgeHistory?.isDeleted?.(event.eventId||event.draftId||scan.confirmationId)){cancelScore();return;}
    if(event.type==='product-recalls'){receiveRecalls(event);return;}
    if(event.type==='product-score'||event.type==='product-score-error'){receiveScore(event);return;}
    if(event.type==='alternatives'||event.type==='alternatives-error'){if(visible()&&scan.phase==='product')alternatives.receive(event);return;}
    if(event.type==='cancelled'){clearSearchRefresh();cancelScore();closeCamera();scan.phase='idle';scan.error=null;render();return;}
    if(['loading','error','product'].includes(event.type)&&!activateCamera(event))return;
    if(['loading','error','product'].includes(event.type)){clearSearchRefresh();if(view.resultOrigin==='search'&&!String(event.eventId||event.draftId||'').startsWith('search-product:'))view.resultOrigin='camera';}
    if(event.type==='loading'){cancelScore();alternatives.reset();const id=event.eventId||event.draftId||scan.confirmationId;if(id!==scan.confirmationId){scan.portion=null;scan.entryId='';scan.draftProduct=null;scan.thumbnail='';}scan.confirmationId=id;scan.phase='loading';scan.product=null;scan.error={barcode:String(event.barcode||'')};window.NudgeHistory?.record({id,kind:'product',status:'pending',barcode:scan.error.barcode});render();return;}
    if(event.type==='error'){cancelScore();scan.confirmationId=event.eventId||event.draftId||scan.confirmationId;scan.phase='error';scan.error={code:String(event.code||'lookup_failed'),message:String(event.message||'Lookup failed.'),barcode:event.barcode?String(event.barcode):''};window.NudgeHistory?.record({id:scan.confirmationId,kind:'product',status:event.code==='not_found'?'unknown':'failed',barcode:scan.error.barcode,message:scan.error.message,errorCode:scan.error.code});render();return;}
    if(event.type==='product'&&event.product){
      const id=event.eventId||`scan-${Date.now()}-${Math.random().toString(36).slice(2,10)}`,same=scan.confirmationId===id&&scan.portion;
      scan.confirmationId=id;scan.phase='product';scan.product={...event.product,...(Number.isInteger(event.captureRevision)?{captureRevision:event.captureRevision}:{}),...(event.analysisVersion?{analysisVersion:event.analysisVersion}:{})};scan.error=null;scan.thumbnail=event.thumbnail||(same?scan.thumbnail:'')||'';alternatives.reset();
      const previous=window.NudgeHistory?.find?.(id)?.product;
      if(!scan.product.scoreResult&&previous?.scoreResult&&model()?.scoreFingerprint(previous)===model()?.scoreFingerprint(scan.product))scan.product.scoreResult=previous.scoreResult;
      if(!scan.product.barcode&&!scan.product.identityKey)scan.product.identityKey='photo:'+id;
      window.NudgeHistory?.record({id,kind:'product',status:'ready',barcode:event.product.barcode||'',name:event.product.name,product:event.product,thumbnail:scan.thumbnail,...(event.extraction?{extraction:event.extraction}:{})});
      if(!same)restoreSelection(ownEntries().at(-1));
      ensureScore();render();alternatives.auto();if(!camera.active)window.scrollTo({top:0,behavior:'auto'});
    }
  }
  function commit(){
    if(scan.saving||!scan.product)return;
    if(scan.searchRefreshing){scan.detailError='Wait for the current product check to finish before adding this food.';render();return;}
    if(window.NudgeHistory?.isDeleted?.(scan.confirmationId)||window.NudgeHistory?.isEntryDeleted?.(scan.entryId||scan.consumptionId)){scan.detailError='This entry was deleted. Undo in History to restore it.';render();return;}
    const old=linked();if(old&&!scan.editing)return;
    if(!valid()){scan.detailError='Enter a valid amount before adding this food.';render();return;}
    if(window.WmdStreakMath.dayNumber(scan.day)===null||scan.day>todayKey()){scan.detailError='Choose a valid date on or before today.';render();return;}
    // The diary is authoritative if History could not persist its link, or a callback was retried.
    const duplicate=entries().find(e=>e.sourceMeta?.confirmationId===scan.consumptionId);
    if(!old&&duplicate){restoreSelection(duplicate);render();return;}
    const m=model(),p=calculationProduct(),values=m.portionNutrients(p,scan.portion),plants=m.plants(p),portion=m.portionRecord(p,scan.portion);
    const snapshot=Object.fromEntries(keys.map(key=>[key,{per100:['g','ml'].includes(p.basisUnit)?m.value(p,key):null,portion:values[key]??null,unit:key==='energyKcal'?'kcal':'g',per100Status:p.nutrients?.[key]?.status==='calculated'?'calculated':'supplied',portionStatus:values[key]===null||values[key]===undefined?'unknown':'calculated'}]));
    const score=detail().score;
    if(p.reviewedProductFacts){score.reviewedProductFacts=p.reviewedProductFacts;score.sourceData={...score.sourceData,...old?.sourceMeta?.scoreMethod?.sourceData,source:'User-confirmed label repair'};}
    const record={...old,id:old?.id||scan.consumptionId,name:p.name||'Your product',brand:p.brand||null,barcode:p.barcode||'',day:scan.day,slot:scan.slot,portions:1,portionAmount:scan.portion.canonicalAmount,portionUnit:scan.portion.unit,plants:plants.names,ferments:old?.ferments||[],recipe:'',ingredients:p.ingredients?{text:typeof p.ingredients==='string'?p.ingredients:p.ingredients.text||'',plants:plants.names.map(name=>({name,evidence:plants.evidence.find(item=>item.name===name)?.evidence||name})),needsReview:false}:null,energyPerPortion:values.energyKcal??null,proteinPerPortion:values.protein??null,fibrePerPortion:values.fibre??null,nutritionSnapshot:snapshot,nutritionStatus:keys.every(key=>values[key]!==null&&values[key]!==undefined)?'complete':'incomplete',source:'User-confirmed product portion',sourceMeta:{...old?.sourceMeta,provider:p.sourceName||'Product source unavailable',url:p.sourceURL||'',retrievedAt:p.retrievedAt||'',licence:p.licenceName||'',licenceURL:p.licenceURL||'',confirmationId:old?.sourceMeta?.confirmationId||scan.consumptionId,scanEventId:scan.confirmationId,productScanEventId:old?.sourceMeta?.productScanEventId||scan.confirmationId,entryKind:'product-consumption',consumedAt:old?.sourceMeta?.consumedAt||new Date().toISOString(),labelBasis:p.basisUnit==='ml'?'per100ml':p.basisUnit==='g'?'per100g':'unknown',nutritionPreparation:p.nutritionPreparation||'unknown',portionSelection:portion,portionSaltConflict:m.servingConflict(p,scan.portion),plantKnowledge:plants.known?'known':'unknown',scoreMethod:score,...(old?.sourceMeta?.scoreMethod?{scoreHistory:[...(old.sourceMeta.scoreHistory||[]),old.sourceMeta.scoreMethod].slice(-12)}:{})}};
    const clean=window.WmdFoodLog.clean({entries:[record]}).entries[0];if(!clean){scan.detailError='This portion could not be saved. Check the amount and try again.';render();return;}
    scan.saving=true;const saved=old?diaryStore.update(old.id,clean):diaryStore.add(clean);
    if(!saved.ok){scan.saving=false;scan.detailError='Could not save on this device. Your diary is unchanged. Try again.';render();return;}
    if(scan.confirmationId?.startsWith('search-product:'))window.NudgeHistory?.record({id:scan.confirmationId,kind:'product',origin:'search',status:'ready',name:p.name,barcode:p.barcode||'',product:scan.product,entryId:clean.id});
    scan.saving=false;scan.entryId=clean.id;scan.editing=false;scan.detailError='';window.NudgeHistory?.link(scan.confirmationId,clean.id);render();showToast(old?'Portion updated.':'Added to '+scan.slot.toLowerCase()+'.');
  }
  function undo(){
    const entry=linked();if(!entry||scan.saving)return;
    if(!diaryStore.remove(entry.id).ok){scan.detailError='Could not undo this entry. Try again.';render();return;}
    scan.entryId='';scan.editing=false;scan.detailError='';window.NudgeHistory?.unlink?.(scan.confirmationId,entry.id);render();showToast(scan.confirmationId?.startsWith('search-product:')?'Portion removed. Your product is still in History.':'Portion removed. Your scan is still in History.');
  }
  function startEditing(){if(linked())scan.editing=true;}
  function handleAction(action,value){
    if(action==='detail-recall-retry'){recallState.reference=null;ensureRecalls();render();return true;}
    if(action==='detail-score-retry'){ensureScore({retry:true});render();return true;}
    if(['result-next','result-close','product-label'].includes(action)){clearSearchRefresh();cancelScore();}
    if(alternatives.handleAction(action,value))return true;
    if(['barcode-scan','open-camera','start-scan'].includes(action)){clearSearchRefresh();cancelScore();window.NudgeLabel.begin();return true;}
    if(action==='barcode-reset'){clearSearchRefresh();cancelScore();scan.phase='idle';scan.product=null;scan.portion=null;scan.error=null;render();return true;}
    if(action==='food-edit'){const entry=entries().find(e=>e.id===value),event=entry?.sourceMeta?.entryKind==='product-consumption'?window.NudgeHistory?.find(entry.sourceMeta.productScanEventId||entry.sourceMeta.scanEventId):null;if(event?.product){view.resultOrigin='history';openStored(event,{entryId:entry.id});return true;}return false;}
    if(action==='product-favourite'){if(scan.product)window.NudgeHistory?.toggleFavourite(scan.product);return true;}
    if(action==='detail-log'){commit();return true;}
    if(action==='detail-undo'){undo();return true;}
    if(action==='detail-edit'){startEditing();render();return true;}
    if(action==='detail-another'){scan.draftProduct=calculationProduct();scan.entryId='';scan.consumptionId=unique();scan.editing=false;scan.invalidQuantity=false;scan.detailError='';scan.day=todayKey();scan.slot='';scan.portion=model().createPortion(calculationProduct());syncAmount();render();return true;}
    if(action==='detail-reset'){scan.portion=model().createPortion(calculationProduct());scan.invalidQuantity=false;scan.detailError='';startEditing();syncAmount();render();return true;}
    if(action==='detail-exact'){
      const p=calculationProduct(),m=model().selectedMeasure(p,scan.portion);if(!m)return true;
      window.NudgeControls.exact({label:'Amount',value:model().quantity(p,scan.portion),unit:m.label,minimum:Number.MIN_VALUE,maximum:Math.min(5000,5000/m.factor),onApply:amount=>{const next=model().setAmount(p,scan.portion,amount);if(!next)return 'Choose a supported amount.';scan.portion=next;scan.invalidQuantity=false;scan.detailError='';startEditing();syncAmount();render();}});return true;
    }
    if(action==='detail-step'){
      const current=model().quantity(calculationProduct(),scan.portion),delta=Number(value),next=model().setAmount(calculationProduct(),scan.portion,current+delta);
      if(Number.isFinite(delta)&&next){scan.portion=next;scan.invalidQuantity=false;scan.detailError='';startEditing();syncAmount();render();}return true;
    }
    if(action==='barcode-ate'||action==='barcode-confirm-product')return true;
    return false;
  }
  function liveRender(target){
    const focused=document.activeElement===target;let selection=null;
    if(focused)try{if(Number.isInteger(target.selectionStart)&&Number.isInteger(target.selectionEnd))selection=[target.selectionStart,target.selectionEnd,target.selectionDirection];}catch{}
    render();
    const replacement=document.getElementById(target.id);
    if(replacement&&replacement!==target&&typeof replacement.replaceWith==='function'){
      target.setAttribute?.('aria-invalid',scan.invalidQuantity?'true':'false');replacement.replaceWith(target);
      if(focused){target.focus?.({preventScroll:true});if(selection)try{target.setSelectionRange?.(...selection);}catch{}}
    }
  }
  function handleChange(target){
    if(target.id==='detail-quantity'){
      const raw=String(target.value);if(scan.lastQuantityRaw===raw)return true;
      const next=model().setAmount(calculationProduct(),scan.portion,target.value);
      scan.invalidQuantity=!next||target.validity?.badInput===true;scan.detailError=scan.invalidQuantity?'Enter an amount greater than zero.':'';
      if(!scan.invalidQuantity){scan.portion=next;startEditing();syncAmount();}scan.lastQuantityRaw=raw;liveRender(target);return true;
    }
    if(target.id==='detail-measure'){const next=model().switchMeasure(calculationProduct(),scan.portion,target.value);if(next){scan.portion=next;scan.invalidQuantity=false;scan.detailError='';syncAmount();}render();return true;}
    return false;
  }
  function openSearchProduct(product){
    if(!product||typeof product!=='object')return;
    closeCamera();clearSearchRefresh();cancelScore();scan.confirmationId='search-product:'+Date.now()+'-'+Math.random().toString(36).slice(2,10);scan.product=product;scan.phase='product';scan.error=null;scan.thumbnail='';scan.portion=null;scan.draftProduct=null;alternatives.reset();restoreSelection();view.resultOrigin='search';
    const needsRefresh=product.searchProvider==='open_food_facts_search'&&product.barcode,handler=window.webkit?.messageHandlers?.nudgeBarcode;
    if(needsRefresh){scan.searchRefreshUnavailable=!handler;if(handler){
      const request=scan.searchRefreshID=unique(),draft=scan.confirmationId;scan.searchRefreshing=true;
      scan.searchRefreshTimer=setTimeout(()=>{if(scan.searchRefreshID!==request||!scan.searchRefreshing)return;clearSearchRefresh({unavailable:true});if(view.screen==='barcode')render();},15000);
      navigate('barcode');
      try{handler.postMessage({action:'search-product-refresh',requestId:request,draftId:draft,barcode:product.barcode});}catch{clearSearchRefresh({unavailable:true,cancel:false});render();}
      return;
    }}
    navigate('barcode');
  }
  function openStored(item,{entryId}={}){closeCamera();clearSearchRefresh();invalidatedIDs.delete(item.id);cancelScore();scan.confirmationId=item.id;scan.thumbnail=item.thumbnail||'';scan.product=item.product||null;scan.error={code:item.errorCode||'lookup_failed',barcode:item.barcode,message:item.message||'Lookup incomplete. Try again when connected.'};scan.phase=item.status==='ready'&&item.product?'product':'error';alternatives.reset();if(scan.product)restoreSelection(entryId?ownEntries().find(e=>e.id===entryId):ownEntries().at(-1));navigate('barcode');ensureScore();render();}
  const portionValue=(product,key,amount=scan.amount)=>{const value=model()?.value(product,key)??null;return typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.round(value*amount/100*10)/10:null;};
  return {screen,receive,openStored,openSearchProduct,handleAction,handleChange,handleInput:handleChange,portionValue,detail,cancelScore,invalidate,publishSummary,suspendCamera,_scan:scan,_camera:camera};
};
