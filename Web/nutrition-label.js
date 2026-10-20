window.createNudgeLabel = function(ctx) {
  'use strict';
  const {getState,view,escapeHtml:esc,todayKey,save,render,navigate,showToast}=ctx;
  const diary=window.NudgeDiary.create({getState,save,cleanEntry:raw=>window.WmdFoodLog.clean({entries:[raw]}).entries[0]});
  const fields=[['energyKcal','Energy'],['protein','Protein'],['carbohydrate','Carbohydrate'],['sugars','Sugars'],['fat','Fat'],['saturatedFat','Saturated fat'],['fibre','Fibre'],['salt','Salt']];
  const bases={unknown:'Choose the printed basis',per100g:'Per 100 g',per100ml:'Per 100 ml',perServing:'Per serving',perPortion:'Per photographed portion (estimated)'};
  const photoNames={product:'Product front',label:'Nutrition or ingredients label'};
  const state={phase:'idle',requestId:null,photos:{product:'',label:''},captureKind:null,previousPhase:'idle',error:'',extraction:null,repairId:'',context:null,amount:100,unit:'g',day:todayKey(),slot:'',name:'',brand:'',confirmationId:null,saving:false,nameEdited:false,brandEdited:false,amountEdited:false,corrections:{},ingredientCorrections:null,lastLabelKind:null,photoCount:0,portionBase:100,portionLabel:'portion',portionSource:'estimated',detailsOpen:false,amountDetailsOpen:false,pendingExtraction:null,thumbnail:'',analysisType:'product',mealPortions:1,returnScreen:'today',canRetryPhotos:false,photoPreview:'',mealEditing:false,portionConfirmed:false,historyGeneration:0,mealRecoveryOriginal:null,mealMeasure:'serving',mealBatchServings:1,mealBatchVolumeMl:null};
  let sequence=0;
  const unique=()=>`label-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2,9)}`;
  const round=(n,places=1)=>Math.round(n*10**places)/10**places;
  const known=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  const entry=()=>state.repairId?getState().foodLog.entries.find(e=>e.id===state.repairId):null;
  const read=(id,fallback)=>{const input=document.getElementById(id);return input&&typeof input.value==='string'?input.value:fallback;};
  const ready=()=>Boolean(state.photos.label&&(state.repairId||state.photos.product));
  const selectPhase=()=>ready()?'selected':state.photos.product||state.photos.label?'photos':'idle';

  // The screen supplies input and handles navigation; the core owns evidence rules.
  const analysis=window.NudgeAnalysisResult.create({
    names:(...args)=>window.WmdFoodLog.names(...args),
    suggestion:value=>window.NudgeScanUI.suggestion(value),
    get composition(){return window.NudgeComposition;},
    get mealRecovery(){return window.NudgeMealRecovery;},
    get frequency(){return window.NudgeFrequency;},
    get mealScore(){return window.NudgeMealScore;},
    get score(){return window.NudgeScoreCore;},
    get foodDetail(){return window.NudgeFoodDetailModel;},
    get productEvidence(){return window.NudgeProductEvidence;}
  });
  const {ingredientMode,hasIngredients,canonical,mealPlantKey,supportedPlant,selectedPlants,recoverMeal,validMealScore,mealScore}=analysis;

  function native(action,extra={}) {
    const handler=window.webkit?.messageHandlers?.nudgeBarcode;
    if(!handler){state.phase='error';state.error='Product photography requires the Nudge iPhone app.';render();return false;}
    handler.postMessage({action,draftId:state.confirmationId,requestId:state.requestId,...extra});return true;
  }
  function clearRequest(cancelNative=true){
    window.NudgeBarcode?.suspendCamera?.({requestId:state.requestId,draftId:state.confirmationId});
    if(cancelNative&&state.requestId&&state.confirmationId)native('cancel-label');
    state.requestId=null;state.confirmationId=null;state.photos={product:'',label:''};state.captureKind=null;state.extraction=null;state.phase='idle';
    state.repairId='';state.context=null;state.name='';state.brand='';state.corrections={};state.nameEdited=false;state.brandEdited=false;state.amountEdited=false;state.ingredientCorrections=null;state.lastLabelKind=null;state.amount=100;state.unit='g';state.photoCount=0;state.portionBase=100;state.portionLabel='portion';state.portionSource='estimated';state.detailsOpen=false;state.amountDetailsOpen=false;state.pendingExtraction=null;state.thumbnail='';state.analysisType='product';state.mealPortions=1;state.canRetryPhotos=false;state.photoPreview='';state.mealEditing=false;state.portionConfirmed=false;state.historyGeneration=0;state.mealRecoveryOriginal=null;state.mealMeasure='serving';state.mealBatchServings=1;state.mealBatchVolumeMl=null;alternatives.reset();state.day=todayKey();state.slot='';
  }
  function capture(kind,retainPhotos=false,extra={}){
    if(state.phase==='capturing')return;
    if(!state.confirmationId)state.confirmationId=unique();
    if(state.phase==='review'&&!collect()){showToast('Check the numbers in Edit details.');return;}
    state.historyGeneration=window.NudgeHistory?.generation?.(state.confirmationId)||0;state.requestId=unique();state.previousPhase=state.phase;state.phase='capturing';state.captureKind=kind;if(!retainPhotos)state.photoCount=0;state.error='';
    render();native('smart-scan',{repair:Boolean(state.repairId),...extra});
  }
  function begin(repairId='') {
    const old=repairId?getState().foodLog.entries.find(e=>e.id===repairId):null;
    if(repairId&&!old){showToast('This saved entry is no longer available.');return;}
    const product=view.screen==='barcode'&&window.NudgeBarcode?._scan?.phase==='product'?window.NudgeBarcode._scan.product:null;
    const returnScreen=view.screen==='history'?'history':'today';clearRequest();state.returnScreen=returnScreen;state.repairId=repairId||'';state.context=old||product||null;
    state.amount=old?(['g','ml'].includes(old.portionUnit)?old.portionAmount??null:null):100;state.unit=old?.portionUnit||'g';state.day=old?.day||todayKey();state.slot=old?.slot??'';
    state.name=old?.name||product?.name||'';state.brand=old?.brand||product?.brand||'';
    state.nameEdited=false;state.brandEdited=false;state.amountEdited=false;state.corrections={};
    state.confirmationId=unique();state.historyGeneration=window.NudgeHistory?.generation?.(state.confirmationId)||0;state.saving=false;state.error='';
    view.resultOrigin='camera';navigate('label-photo');capture(old?'label':'product');
  }
  const estimatedServing=e=>e?.meal?.portionMode==='estimated_serving';
  function mealMeasures(){return window.NudgeFoodDetailModel.mealMeasures(state.extraction?.meal?.portion,{servings:state.mealBatchServings,volumeMl:state.mealBatchVolumeMl});}
  function mealMeasure(){const info=mealMeasures();return info.options.find(m=>m.id===state.mealMeasure)||info.options[0];}
  function mealSelection(){return {measureId:mealMeasure().id,fraction:state.amount,batchServings:state.mealBatchServings,batchVolumeMl:state.mealBatchVolumeMl,baseAmount:state.extraction?.meal?.portion?.amount??null,baseUnit:state.extraction?.meal?.portion?.unit??null};}
  function applyMealAmount(quantity){const info=mealMeasures(),amount=quantity*mealMeasure().factor;if(!Number.isFinite(amount)||amount<info.minimum||amount>info.maximum)return false;state.amount=amount;state.amountEdited=true;state.portionConfirmed=!estimatedServing(state.extraction)||!requiresPortionChoice(state.extraction);return true;}
  function recipeFraction(){const n=state.extraction?.meal?.recipeCalculation?.selectedFraction;return typeof n==='number'&&n>0&&n<=1?n:1;}
  function recipeFractionLabel(){const n=recipeFraction();return n===1?'Whole dish':n===.5?'½ dish':n===.25?'¼ dish':round(n*100,1)+'% of dish';}
  function recipeSelectionLabel(){return state.amount===1?recipeFractionLabel():round(state.amount,3)+' × '+recipeFractionLabel().toLowerCase();}
  function mealMeasureForm(){
    const recipe=state.extraction?.meal?.recipeCalculation;
    if(recipe?.applied&&!recipe.userEdited){
      const fraction=recipeFraction(),servings=recipe.servings,items=[[1,'Whole dish'],[.5,'½ dish'],[.25,'¼ dish']];
      if(servings>1&&![1,.5,.25].includes(1/servings))items.push([1/servings,'1 serving']);
      return `<section class="scan-portion n-meal-portion"><input type="hidden" id="label-amount" value="${state.amount}">${window.NudgeControls.choices({label:'Amount of recipe eaten',items,value:fraction,action:'label-recipe-fraction'})}<button class="text-button" data-action="label-recipe-exact">Other amount</button><p class="n-caption">${esc(recipeSelectionLabel())}${servings?' · recipe makes '+servings+' servings':''}. Any photographed side is included separately${state.amount===1?'':' for each portion'}.</p></section>`;
    }
    const info=mealMeasures(),measure=mealMeasure(),count=state.amount/measure.factor,drink=window.NudgeFoodDetailModel.isDrink({name:state.name}),batch=state.mealBatchServings>1;
    return `<section class="scan-portion n-meal-portion"><input type="hidden" id="label-amount" value="${state.amount}">${window.NudgeControls.choices({label:'Measure your portion',items:info.options.map(m=>[m.id,m.label]),value:measure.id,action:'label-measure'})}${window.NudgeControls.stepper({label:'Amount eaten',value:Math.round(count*1000)/1000,unit:Math.abs(count-1)<1e-9?measure.label:measure.plural,step:measure.step,minimum:info.minimum/measure.factor,maximum:info.maximum/measure.factor,action:'label-measure-step',increment:measure.step===.25?'¼':String(measure.step),className:'n-meal-stepper'})}<p class="n-caption">${esc(measure.description)}${info.volumeMl&&state.extraction?.meal?.portion?.unit!=='ml'?' · batch volume entered by you':''}.</p>${window.NudgeControls.choices({label:'Quick portions',items:[[.5/state.mealBatchServings,batch?'½ serving':'½ portion'],[1/state.mealBatchServings,batch?'1 serving':'1 portion'],[2/state.mealBatchServings,batch?'2 servings':'2 portions'],...(batch?[[1,'Whole batch']]:[])].map(([n,label])=>[n,label,n>info.maximum]),value:state.amount,action:'label-portion'})}<button class="text-button" data-action="label-exact">Edit exact amount</button>${state.extraction?.meal?.recipeCalculation?.applied?'':`<button class="text-button" data-action="label-batch-servings">${batch?'Batch makes '+state.mealBatchServings+' servings':'Set servings in this batch'}</button>`}${drink&&state.extraction?.meal?.portion?.unit!=='ml'?`<button class="text-button" data-action="label-batch-volume">${info.volumeMl?'Batch volume · '+round(info.volumeMl,1)+' ml':'Set measured batch volume for cups or ml'}</button>${!info.volumeMl?'<p class="n-caption">To use cups or ml, measure the full analysed batch first. Grams are not treated as ml.</p>':''}`:''}</section>`;
  }

  const requiresPortionChoice=e=>e?.meal?.portionAmbiguity?.requiresSelection===true||(!estimatedServing(e)&&e?.meal?.subject?.kind==='serving_dish');
  const compositionMeal=e=>e?.type==='meal'&&e.meal?.compositionVersion&&Array.isArray(e.meal.components);
  const sourceLabel=record=>[record?.source,record?.code,record?.name].filter(Boolean).join(' · ');
  function calculateComposition(e){
    const result=analysis.calculateComposition(e,{recipeLabel:recipeFractionLabel()});
    Object.assign(e,result.extraction);
    if(e===state.extraction&&result.portionConfirmed!==undefined)state.portionConfirmed=result.portionConfirmed;
  }
  function componentReview(){
    const e=state.extraction;if(!compositionMeal(e))return '';
    return `<section class="n-box n-components"><h2>Check your plate</h2><p class="n-caption">${e.meal.recipeCalculation?.applied?'Recipe ingredients are scaled to your selected share, using their listed preparation before cooking. Side amounts stay separate. Edit to match what you ate.':estimatedServing(e)?'Suggested foods and grams for 1 portion. Adjust them to match your food.':'Choose the food and grams you can confirm. Leave uncertain amounts blank.'}${!estimatedServing(e)&&e.meal?.subject?.kind==='serving_dish'?' Grams describe the photographed dish; your selected share is applied below.':''}</p>${e.meal.components.length?e.meal.components.map((c,i)=>{
      const candidates=[...(c.sourceRecord?[c.sourceRecord]:[]),...(c.candidates||[])].filter((r,index,all)=>r?.id&&all.findIndex(x=>x?.id===r.id)===index);
      return `<div class="n-component"><label class="form-label" for="label-component-record-${i}">${esc(c.name)}</label><details class="nc-choice-sheet"><summary>${esc(c.sourceRecord?.name||(candidates.length?'Choose the matching food':'No composition match'))}</summary>${window.NudgeControls.formChoice({id:'label-component-record-'+i,name:'component-'+i,label:'Nutrition source',items:[['','No composition match'],...candidates.map(r=>[r.id,r.name])],value:c.recordId||''})}</details><label class="form-label" for="label-component-grams-${i}">Grams${c.recipeQuantity?' of recipe ingredient for selected share':estimatedServing(e)?' for 1 portion':e.meal?.subject?.kind==='serving_dish'?' in photographed dish':''}${c.amountSource==='confirmed'?'':' · estimated'}</label><input class="field" id="label-component-grams-${i}" type="number" inputmode="decimal" min="${c.recipeQuantity?.000001:.1}" max="5000" step="any" placeholder="Unknown" value="${c.amountGrams??''}">${c.sourceRecord?`<p class="n-caption">${esc(sourceLabel(c.sourceRecord))}</p>`:''}<button class="text-button" data-action="label-component-remove" data-value="${i}" aria-label="Remove ${esc(c.name)}">Remove</button></div>`;
    }).join(''):'<p class="n-caption">The foods could not be matched yet. Try a clearer photo.</p>'}<p class="n-caption">Typical composition, not a measurement. Hidden oil, sauces and allergens remain unknown.</p></section>`;
  }
  function normalise(raw,options={}){
    return analysis.normalise(raw,{...options,userEdited:Boolean(state.ingredientCorrections||state.amountEdited||state.nameEdited),recipeLabel:recipeFractionLabel()});
  }
  function applyCorrections(e){
    // Corrections from a nutrition table must never supply nutrition for an ingredients-only photo.
    if(state.lastLabelKind&&state.lastLabelKind!==e.labelKind){state.corrections={};state.ingredientCorrections=null;}
    if(hasIngredients(e)&&state.ingredientCorrections){
      const corrections=state.ingredientCorrections,used=new Set();
      if(corrections.textEdited){e.ingredients.text=corrections.text;e.ingredients.textEdited=true;}
      e.ingredients.plants=e.ingredients.plants.map(plant=>{
        const edit=corrections.plants.find(p=>p.userEdited&&(e.type==='meal'?mealPlantKey(p.originalName)===mealPlantKey(plant.originalName):p.originalName===plant.originalName));
        if(edit){used.add(edit);return {...edit,evidence:corrections.textEdited?'':edit.evidence};}
        return {...plant,evidence:corrections.textEdited?'':plant.evidence};
      });
      for(const edit of corrections.plants){if(edit.userEdited&&!used.has(edit)&&e.ingredients.plants.length<40)e.ingredients.plants.push({...edit});}
      state.ingredientCorrections=JSON.parse(JSON.stringify(e.ingredients));
    }
    state.lastLabelKind=e.labelKind;
    if(ingredientMode(e))return;
    fields.forEach(([key])=>{if(state.corrections[key])e.nutrients[key]={...state.corrections[key]};});
    if(Object.hasOwn(state.corrections,'basis'))e.basis=state.corrections.basis;
    if(Object.hasOwn(state.corrections,'servingSize'))e.servingSize=state.corrections.servingSize;
  }
  function alignUnit(){if(state.amountEdited||['g','ml'].includes(entry()?.portionUnit))return;const e=state.extraction;if(e.basis==='per100g')state.unit='g';if(e.basis==='per100ml')state.unit='ml';if(e.basis==='perServing'&&e.servingSize)state.unit=e.servingSize.unit;}
  function usePortion(e){
    if(state.repairId)return;
    const suggestion=e.servingSuggestion;
    const base=e.servingSize&&e.servingSize.unit===state.unit?{amount:e.servingSize.value,unit:state.unit,label:suggestion?.source==='label'&&suggestion.amount===e.servingSize.value&&suggestion.unit===e.servingSize.unit?suggestion.label:'portion',source:'label'}:suggestion?.unit===state.unit?suggestion:null;
    state.portionBase=base?.amount||100;state.portionLabel=base?.label||'portion';state.portionSource=base?.source||'estimated';
    if(!state.amountEdited)state.amount=state.portionBase;
  }
  function receive(event,{confirmedSnapshot=false,stored=false}={}) {
    if(event?.type==='alternatives'||event?.type==='alternatives-error'){if(view.screen==='label-photo'&&state.phase==='review')alternatives.receive(event);return;}
    if(!event||!state.confirmationId||event.draftId!==state.confirmationId||!state.requestId||event.requestId!==state.requestId)return;
    if(window.NudgeHistory?.isDeleted?.(state.confirmationId)||window.NudgeHistory?.isEntryDeleted?.(state.repairId)||window.NudgeHistory?.isCurrent&&!window.NudgeHistory.isCurrent(state.confirmationId,state.historyGeneration)){clearRequest();return;}
    const isResultSurface=['label-photo','barcode'].includes(view.screen);
    if(['loading','cancelled','camera-history'].includes(event.type))window.NudgeBarcode?.suspendCamera?.(event);
    if(event.thumbnail&&/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(event.thumbnail)&&event.thumbnail.length<=49152)state.thumbnail=event.thumbnail;
    if(typeof event.photoPreview==='string'&&event.photoPreview.length<=250000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(event.photoPreview))state.photoPreview=event.photoPreview;
    if(event.photoCount)state.photoCount=Math.min(4,Number(event.photoCount)||0);
    if(event.type==='camera-history'){clearRequest(false);navigate('history');return;}
    if(['barcode-loading','barcode-product','barcode-error'].includes(event.type)&&!state.repairId){
      state.phase=event.type==='barcode-product'?'product':event.type==='barcode-error'?'error':'loading';view.resultOrigin=view.resultOrigin||'camera';
      if(event.product)state.context=event.product;window.NudgeBarcode.receive({...event,type:{'barcode-loading':'loading','barcode-product':'product','barcode-error':'error'}[event.type],eventId:state.confirmationId});if(isResultSurface&&!event.cameraSummary)navigate('barcode');return;
    }
    if(event.type==='authentication-changed'||event.type==='configured'){
      if(state.phase==='review')collect();state.phase='idle';state.requestId=unique();state.error='';render();showToast('Ready. Scan again.');return;
    }
    if(event.type==='cancelled'&&window.NudgeHistory?.find(state.confirmationId)?.status==='pending')window.NudgeHistory.record({id:state.confirmationId,status:'failed',errorCode:'cancelled',message:'Scan canceled. Continue with a new capture.'});
    if(event.type==='cancelled'&&state.phase==='product'){const destination=state.returnScreen||'today';clearRequest(false);if(isResultSurface)navigate(destination);return;}
    if(event.type==='cancelled'&&['capturing','loading','error'].includes(state.phase)){
      state.phase=state.previousPhase==='review'&&state.extraction?'review':'idle';state.captureKind=null;if(state.phase==='idle'&&window.NudgeHistory&&isResultSurface){navigate(state.returnScreen||'today');return;}render();return;
    }
    if(event.type==='capture-status'&&state.phase==='capturing'){state.photoCount=Math.max(0,Math.min(4,Number(event.photoCount)||0));render();return;}
    if(event.type==='loading'&&(['capturing','loading','error'].includes(state.phase)||event.photoRecovery===true)){state.phase='loading';window.NudgeHistory?.record({id:state.confirmationId,kind:window.NudgeHistory?.find(state.confirmationId)?.kind||(state.analysisType==='meal'?'meal':'unknown'),status:'pending',thumbnail:state.thumbnail,photoCount:state.photoCount,...(state.repairId?{entryId:state.repairId}:{})});render();return;}
    if(event.type==='result'&&state.phase==='loading'){
      const raw=event.result?.extraction||event.result;
      if(raw&&(raw.type==='product'||!raw.type)&&!state.repairId){const product=window.NudgeResults.augmentFromLabel(raw,state.context,event.result?.source);state.phase='product';state.analysisType='product';window.NudgeBarcode.receive({...event,type:'product',product,eventId:state.confirmationId,thumbnail:state.thumbnail,extraction:raw});if(isResultSurface&&!event.cameraSummary)navigate('barcode');return;}
      if(raw?.type==='unknown'&&!state.repairId){state.phase='error';state.error=raw.message||'Food could not be identified. Try another photo.';window.NudgeHistory?.record({id:state.confirmationId,kind:'unknown',status:'unknown',thumbnail:state.thumbnail,photoCount:state.photoCount,extraction:raw,message:state.error});render();return;}
      const extraction=normalise(raw,{confirmedSnapshot});
      if(!extraction){state.phase='error';state.error='Could not read this. Try another photo.';window.NudgeHistory?.record({id:state.confirmationId,kind:window.NudgeHistory?.find(state.confirmationId)?.kind||'unknown',status:'failed',message:state.error,thumbnail:state.thumbnail});render();return;}
      const editedNutrition=fields.some(([key])=>Object.hasOwn(state.corrections,key))||Object.hasOwn(state.corrections,'basis')||Object.hasOwn(state.corrections,'servingSize');
      if(state.extraction&&state.extraction.labelKind===extraction.labelKind&&editedNutrition&&(state.extraction.basis!==extraction.basis||JSON.stringify(state.extraction.servingSize)!==JSON.stringify(extraction.servingSize))){
        state.pendingExtraction=extraction;state.phase='review';render();return;
      }
      state.pendingExtraction=null;applyCorrections(extraction);state.phase='review';state.mealEditing=false;if(extraction.type==='meal')state.portionConfirmed=(!estimatedServing(extraction)&&Boolean(state.repairId))||!requiresPortionChoice(extraction);state.extraction=extraction;alignUnit();
      if(ingredientMode(extraction)&&extraction.servingSuggestion&&!state.repairId&&!state.amountEdited)state.unit=extraction.servingSuggestion.unit;
      if(!state.repairId){
        if(!state.nameEdited)state.name=extraction.productName||state.context?.name||state.name||'';
        if(!state.brandEdited)state.brand=extraction.brand||state.context?.brand||state.brand||'';
        usePortion(extraction);
      }
      const priorAnalysisType=state.analysisType;state.analysisType=extraction.type==='meal'?'meal':'product';if(extraction.type==='meal'){if(priorAnalysisType!=='meal'){const savedCount=Number(entry()?.sourceMeta?.photoPortions);state.amount=Number.isFinite(savedCount)&&savedCount>=.0001&&savedCount<=8?savedCount*(entry()?.portions||1):1;}else if(!state.amountEdited&&!state.repairId)state.amount=1;state.unit='portion';state.portionBase=1;state.portionLabel=estimatedServing(extraction)?'suggested portion':'photographed portion';state.portionSource='estimated';}
      // Opening a saved analysis may offer a supported estimate for review, but
      // must not replace its original evidence or create a new analysis version.
      if(!stored){
        const historyExtraction=estimatedServing(extraction)?{...raw,meal:{...extraction.meal,scoreSnapshot:JSON.parse(JSON.stringify(mealScore(extraction)))}}:raw;
        window.NudgeHistory?.record({id:state.confirmationId,kind:extraction.type==='meal'?'meal':'unknown',status:'ready',name:state.name,extraction:historyExtraction,thumbnail:state.thumbnail,photoCount:state.photoCount,...(state.repairId?{entryId:state.repairId}:{})});
      }
      state.detailsOpen=!state.name;render();if(extraction.type!=='meal')alternatives.auto();return;
    }
    if(event.type==='error'&&['capturing','loading','selected','photos'].includes(state.phase)){
      state.canRetryPhotos=event.canRetryPhotos===true;state.phase='error';state.error=String(event.message||'Could not read this. Try again.');window.NudgeHistory?.record({id:state.confirmationId,kind:window.NudgeHistory?.find(state.confirmationId)?.kind||'unknown',status:'failed',errorCode:event.code,message:state.error,thumbnail:state.thumbnail,photoCount:state.photoCount});render();
    }
  }
  const configure=()=>'<button class="text-button" data-action="account-open">My Nudge account</button>'+(window.NudgeAccount?.canConfigurePrivateConnection()?'<button class="text-button" data-action="configure-label-backend">Private development connection</button>':'');
  function header(){return window.NudgeResults&&window.NudgeHistory?.find(state.confirmationId)?window.NudgeResults.saved():'';}
  function screen(){
    if(state.phase==='review')return state.extraction?.type==='meal'?mealReview():header()+review();
    if(state.phase==='loading')return analysingScreen();
    if(state.phase==='error')return header()+`<section class="card"><h1>Let’s try again</h1><p class="notice" role="alert">${esc(state.error)}</p>${state.canRetryPhotos&&view.resultOrigin!=='history'?'<button class="button primary" data-action="label-retry">Try analysis again</button>':''}<button class="button secondary" data-action="label-retake">Take another photo</button>${configure()}</section>`;
    return header()+`<section class="scan-wait"><h1>Point at your food</h1><p>${state.phase==='capturing'?'Hold still. Add another angle if needed.':'Barcode, pack or label.'}</p>${state.photoCount?`<p>${state.photoCount} photo${state.photoCount===1?'':'s'} ready</p>`:''}${state.phase==='capturing'?'':'<button class="button primary" data-action="label-retake">Scan food</button>'}</section>`;
  }
  function identityForm(){return `<label class="form-label" for="label-name">Food name</label><input class="field" id="label-name" type="text" maxlength="100" value="${esc(state.name)}" placeholder="Name from the pack"><label class="form-label" for="label-brand">Brand</label><input class="field" id="label-brand" type="text" maxlength="80" value="${esc(state.brand)}" placeholder="Unknown">`;}
  function ingredientForm(){const e=state.extraction,ingredients=e.ingredients;if(!hasIngredients(e))return '';
    return `<h3>Ingredients</h3><label class="form-label" for="label-ingredients-text">Label text</label><textarea class="field" id="label-ingredients-text" rows="4" maxlength="4000">${esc(ingredients.text)}</textarea><p class="small muted">Count specific named plants only. Exclude traces and generic blends.</p>${ingredients.plants.map((plant,index)=>`<div class="scan-plant-edit"><label class="sr-only" for="label-plant-name-${index}">Plant ${index+1}</label><input class="field" type="text" id="label-plant-name-${index}" maxlength="40" value="${esc(plant.name)}"><button class="button secondary" data-action="label-toggle-plant" data-value="${index}" aria-label="${plant.selected===false?'Restore':'Remove'} ${esc(plant.name||'plant')}">${plant.selected===false?'Undo':'Remove'}</button></div>${plant.selected!==false&&!supportedPlant(e,plant)?'<p class="small muted">Not counted: name a specific plant in the ingredients.</p>':''}`).join('')}${ingredients.plants.length<40?'<button class="button secondary" data-action="label-add-plant">Add plant</button>':''}`;
  }
  function nutritionForm(){const e=state.extraction;if(ingredientMode(e))return '';
    if(compositionMeal(e))return `<h3>Nutrition sources</h3><p class="n-caption">Calculated from the selected food-composition records and amounts. Change the foods or grams above to update it.</p>`;
    return `<h3>Nutrition</h3><p class="small muted">${e.type==='meal'?'Estimated for one photographed portion. Check and edit these values.':'Printed values only. Leave unknowns blank.'}</p>${hasIngredients(e)&&e.type!=='meal'?'<button class="button secondary" data-action="label-ingredients-only">Use ingredients only</button>':''}${window.NudgeControls.formChoice({id:'label-basis',name:'basis',label:e.type==='meal'?'Estimate basis':'Printed basis',items:Object.entries(bases).filter(([key])=>e.type==='meal'?key==='perPortion':key!=='perPortion'),value:e.basis})}${e.basis==='perServing'?`<label class="form-label" for="label-serving-size">Printed serving size</label><input class="field" id="label-serving-size" type="number" inputmode="decimal" min="0.1" max="5000" step="any" value="${e.servingSize?.value??''}" placeholder="Unknown"><label class="form-label" for="label-serving-unit">Unit</label>${window.NudgeControls.formChoice({id:'label-serving-unit',name:'servingUnit',label:'Printed unit',items:['g','ml'],value:e.servingSize?.unit||state.unit})}`:''}<div class="scan-nutrient-edit">${fields.map(([key,label])=>{const item=e.nutrients[key],units=key==='energyKcal'?['kcal','kJ']:['g','mg'];return `<label for="label-${key}">${label}</label><input class="field" id="label-${key}" inputmode="decimal" type="number" min="0" step="any" value="${item.value??''}" placeholder="Unknown">${window.NudgeControls.formChoice({id:'label-unit-'+key,name:'unit-'+key,label:label+' unit',items:units,value:item.unit})}`;}).join('')}</div>`;
  }
  function analysingScreen(){
    const photo=state.photoPreview||state.thumbnail;
    return `${header()}<section class="n-photo-analysing">${photo?`<img class="n-analysis-photo" src="${esc(photo)}" alt="Your submitted food photo">`:''}<div class="n-analysis-scrim"></div><div class="n-photo-analysis-panel">${window.NudgeAnalysisCrew?.({kind:'food'})||'<span class="spinner" aria-hidden="true"></span><p role="status">Reading your food photos…</p>'}<button class="button secondary" data-action="label-close">Cancel</button></div></section>`;
  }
  function mealPortionLabel(){
    const e=state.extraction,dish=e?.meal?.subject?.kind==='serving_dish';
    if(e?.meal?.recipeCalculation?.applied)return e.meal.recipeCalculation.userEdited?'Edited recipe portion':recipeSelectionLabel()+' · recipe estimate';
    if(!state.portionConfirmed&&requiresPortionChoice(e))return estimatedServing(e)?'Add the missing ingredient amounts in Edit.':'Choose the amount you will eat';
    const fraction=({.25:'¼',.5:'½',.75:'¾',1:'All',1.5:'1½',2:'2'})[state.amount]||String(round(state.amount,2));
    const amount=e?.meal?.portion?.amount,unit=e?.meal?.portion?.unit,physical=known(amount)&&['g','ml'].includes(unit)?` · ${e.meal.portion.source==='confirmed'?'':'about '}${round(amount*state.amount,1)} ${unit}`:'';
    return (estimatedServing(e)?`${round(state.amount,2)} portion${state.amount===1?'':'s'}`:dish?`${fraction} of the foreground dish`:state.amount===1?'1 photographed portion':`${fraction} photographed portions`)+physical;
  }
  function recipeReview(){
    const calculation=state.extraction?.meal?.recipeCalculation;
    if(!calculation)return '';
    if(calculation.userEdited)return '<p class="n-caption">Nutrition reflects your ingredient edits. Adjust the portion below.</p>';
    const total=calculation.batchComponents?.length&&window.NudgeComposition?window.NudgeComposition.total(calculation.batchComponents):calculation.batchNutrients||{},format=key=>{const n=total[key],partial=!known(n?.value)&&known(n?.knownSubtotal)&&n.knownContributions>0;return known(n?.value)?round(n.value,key==='energyKcal'?0:1):partial?'≥ '+round(n.knownSubtotal,key==='energyKcal'?0:1):'—';};
    const facts=[['energyKcal','kcal'],['protein','g protein'],['carbohydrate','g carbs'],['fat','g fat'],['fibre','g fibre']].map(([key,label])=>`${format(key)} ${label}`).join(' · ');
    return `<section class="n-box n-recipe-calculation" aria-label="Whole recipe nutrition"><h2>Whole dish nutrition</h2><p class="n-caption">${esc(facts)}</p><p class="n-caption">Estimated from the recipe ingredients. Choose how much you ate below. Side dishes are additional.</p>${Object.values(total).some(n=>!known(n?.value))?'<p class="n-caption">Partial totals: some ingredient quantities or nutrition values are unknown.</p>':''}${!calculation.userEdited?`<button class="button secondary" data-action="label-recipe-servings">${calculation.servings?'Recipe makes '+calculation.servings+' servings':'Set recipe servings (optional)'}</button>`:'<p class="n-caption">Your ingredient edits are kept. Adjust individual amounts in Edit.</p>'}</section>`;
  }
  function mealNutritionNotice(snap){
    if(state.extraction?.meal?.recipeCalculation&&!state.extraction.meal.recipeCalculation.applied)return '';
    const hasNutrition=fields.some(([key])=>snap[key].portion!==null||snap[key].portionStatus==='partial'&&known(snap[key].knownPortionSubtotal));
    if(hasNutrition)return '';
    return '<p class="n-meal-preparation-note" role="status">Nutrition has not been calculated for this meal. Its rough food score does not provide calories or protein. Add a recipe photo with ingredient quantities, or edit the ingredients.</p><button class="button secondary" data-action="label-retake">Add recipe photo</button>';
  }
  function mealReview(){
    const e=state.extraction,old=entry(),snap=snapshot(state.amount,state.unit),photo=state.photoPreview||state.thumbnail,needsChoice=requiresPortionChoice(e)&&!state.portionConfirmed,standard=estimatedServing(e),score=window.NudgeFrequency?.apply(mealScore(e),{product:{ingredients:e.ingredients,ingredientsNeedsReview:true},profile:getState().nutritionProfile||{},avoidMilk:getState().avoidMilk,entries:getState().foodLog?.entries||[],day:old?.day||state.day,slot:old?.slot??state.slot,excludeId:old?.id,salt:snap.salt.portion})||mealScore(e);
    const components=(e.meal?.components?.length?e.meal.components:e.meal?.ingredients||[]).map(c=>c.name).filter(Boolean);
    const uniqueComponents=[...new Set(components)],summary=uniqueComponents.slice(0,8).join(', ')+(uniqueComponents.length>8?' + '+(uniqueComponents.length-8)+' more':'')||'Components need checking';
    const plants=selectedPlants(e),metric=(key)=>{const value=snap[key].portion,partial=snap[key].knownPortionSubtotal;if(needsChoice)return '—';if(value!==null)return round(value,key==='energyKcal'?0:1)+(key==='energyKcal'?'':' g');return snap[key].portionStatus==='partial'&&known(partial)?'≥ '+round(partial,key==='energyKcal'?0:1)+(key==='energyKcal'?'':' g')+' · partial':'—';};
    const metrics=[['Plants',plants.length?String(plants.length):'—'],['Fibre',metric('fibre')],['Protein',metric('protein')],['Calories',metric('energyKcal')]],scoreKnown=validMealScore(score);
    const rough=scoreKnown&&score.status==='estimated_rough',provisional=scoreKnown&&score.status==='estimated_provisional',range=provisional?`${score.displayLower}–${score.displayUpper}`:'',genericRecipe=e.meal?.compoundProposal||e.meal?.components?.some(c=>c.compoundProxy||c.matchMethod==='curated_compound_proxy'),recoveredFoods=e.meal?.components?.some(c=>c.recovery),canRecheck=old&&(!scoreKnown||rough)&&standard&&Boolean(window.NudgeMealRecovery)&&!e.recoveryPreview&&!e.recoveryChecked;
    const directional=score.methodId==='nudge_nutrition_v0_4',scoreTitle=directional?'Nudge score':'Nudge nutrition score';
    const scoreDisplay=`<section class="nf-compact-score ${scoreKnown?'n-meal-score':'n-meal-score-status'}" aria-label="${scoreTitle}">${window.NudgeScoreCore?.renderDial?.(scoreKnown?score.value:null)||''}<div class="nf-score-name">${scoreTitle}</div><p class="nf-score-provisional">${scoreKnown&&!directional?(rough?'Rough estimate · limited nutrition data':(provisional?'Provisional · ':'')+'Estimated composition · model v'+esc(score.version||score.methodVersion||window.NudgeScoreCore?.CONFIG.version||'0.3')):''}</p>${scoreKnown?'':`<p class="nf-score-needed">${esc(score.reason||'Choose sourced foods and quantities in Edit.')}</p>`}${window.NudgeFrequency?.render(score)||''}${window.NudgeFrequency?.historical(old?.sourceMeta?.mealScore||e.meal?.scoreSnapshot)||''}</section>`;

    const assumptions=[...new Set((e.meal?.components||[]).flatMap(c=>[...(Array.isArray(c.assumptions)?c.assumptions:[]),...(Array.isArray(c.recovery?.assumptions)?c.recovery.assumptions:[])]).concat(e.meal?.recovery?.assumptions||[]))].slice(0,20),preparationNotes=[...new Set((e.meal?.components||[]).filter(c=>c.preparationProxy).map(c=>c.excludedPreparation).filter(Boolean))];
    return `${window.NudgeResults.saved()}<section class="scan-result n-meal-result n-photo-review">
      <div class="n-meal-product-head">${photo?`<img class="n-meal-product-photo" src="${esc(photo)}" alt="Your photographed meal">`:`<span class="n-meal-product-photo n-meal-photo-placeholder" aria-hidden="true">${window.NudgeIcons?.('utensils')||'·'}</span>`}<div><p class="n-meal-estimate">${old?'Logged meal · ':''}Estimated${e.meal?.recipeCalculation?.applied?' · '+esc(e.meal.recipeCalculation.userEdited?'Edited recipe portion':recipeSelectionLabel()):standard?' · '+round(state.amount,2)+' portion'+(state.amount===1?'':'s'):''}</p><h1>${esc(state.name||'Your meal')}</h1></div></div>
      <p class="n-meal-components">${esc(summary)}</p>${e.meal?.voiceIngredientReview?.needsReview?`<p class="n-meal-preparation-note" role="status">${esc(e.meal.voiceIngredientReview.reason||'Check the ingredients described in your voice note. Only individually identified plants are counted.')}</p>`:''}${scoreDisplay}${recipeReview()}${mealNutritionNotice(snap)}${genericRecipe?'<p class="n-meal-preparation-note">Generic recipe estimate. Check the food and amount in Edit.</p>':''}${recoveredFoods?'<p class="n-meal-preparation-note">Generic food estimates. Edit to check matches.</p>':''}${canRecheck?'<button class="n-wide-button" data-action="label-recheck-meal">Recheck estimate</button>':''}${e.recoveryPreview?'<p class="n-meal-preparation-note">Updated estimate for review. Save changes to update Today.</p><button class="text-button" data-action="label-keep-saved-meal">Keep saved estimate</button>':''}
      ${preparationNotes.length?`<p class="n-meal-preparation-note">${preparationNotes.map(esc).join(' ')}</p>`:''}
      <section class="n-meal-intake" aria-labelledby="meal-portion-heading"><h2 id="meal-portion-heading">Your portion</h2><div class="n-meal-metrics" aria-label="Nutrition for selected portion">${metrics.map(([label,value])=>`<div><span>${label}</span><strong ${label==='Plants'&&plants.length?'aria-describedby="meal-counted-plants" ':''}aria-label="${label}: ${value==='—'?'unknown':esc(value)}">${esc(value)}</strong></div>`).join('')}</div>${plants.length?`<p class="n-meal-counted-plants" id="meal-counted-plants"><span>Counted plants:</span> ${plants.map(esc).join(', ')}</p>`:''}
      <p class="n-meal-selection" aria-live="polite">${esc(mealPortionLabel())}${needsChoice?'':' · estimated nutrition'}</p>
      ${standard||!needsChoice?portionForm(true):needsChoice?`<div class="n-meal-portion-required"><p>${esc(e.meal?.portionAmbiguity?.reason||'Choose your share before confirming.')}</p>${portionForm(!state.mealEditing)}</div>`:''}
      <div class="n-meal-review-actions nc-action-row"><button class="n-wide-button" data-action="label-meal-edit" aria-expanded="${state.mealEditing}">${state.mealEditing?'Done':'Edit'}</button><button class="n-wide-button n-primary scan-save" data-action="label-save" ${state.pendingExtraction||needsChoice?'disabled':''}>${old?'Save changes':'Add to today'}</button></div>${old?'<p class="n-caption">Already included in your daily totals.</p>':''}</section>
      ${state.mealEditing?`<section class="n-meal-editor">${componentReview()}<p class="n-caption">Use the portion controls above to scale every ingredient together.</p><details class="n-details scan-details" id="label-details" ${state.detailsOpen?'open':''}><summary><span>Food name and ingredients</span></summary><div class="n-detail-content">${identityForm()}${nutritionForm()}${ingredientForm()}</div></details><button class="button secondary" data-action="label-retake">Edit photos</button></section>`:''}
      <details class="n-details n-meal-sources"><summary><span>Sources &amp; estimates</span></summary><p class="n-caption">${compositionMeal(e)?`${esc(e.meal.compositionVersion)}. Typical food composition and ${standard?'a suggested single serving':'selected amounts'}.`:'Existing saved photo estimate.'} Unknown values stay unknown. Hidden oils, sauces and allergens cannot be established from a photo.</p>${(e.meal?.components||[]).filter(c=>c.sourceRecord).map(c=>`<p class="n-caption">${esc(c.name)} · ${esc(sourceLabel(c.sourceRecord))}</p>`).join('')}${assumptions.map(text=>`<p class="n-caption">${esc(text)}</p>`).join('')}${scoreKnown?`<p class="n-caption"><strong>Nudge nutrition score · ${esc(score.methodVersion)}</strong><br>${esc(score.explanation||'Calculated consistently from the selected foods and their estimated composition.')} This beta score is not a personalised health assessment.</p>`:''}</details>
      ${e.voiceNote?.text?`<details class="n-details n-meal-voice"><summary><span>Your voice note</span></summary><p class="n-caption">${esc(e.voiceNote.text)}</p></details>`:''}<button class="button secondary" data-action="repertoire-save-analysis">Save to my foods</button>${old?'<button class="text-button" data-action="label-remove">Delete logged meal</button>':''}<button class="text-button" data-action="result-close">${view.resultOrigin==='history'?'Back to history':'Scan next'}</button></section>`;
  }
  function review(){const e=state.extraction,snap=snapshot(state.amount,state.unit),old=entry(),multiplier=e.type==='meal'?1:old?.portions||1;
    const facts=[['energyKcal','kcal'],['protein','g protein'],['fibre','g fibre']].filter(([key])=>snap[key].portion!==null).map(([key,unit])=>`<span><b>${round(snap[key].portion*multiplier)}</b> ${unit}</span>`);
    if(hasIngredients(e))facts.push(`<span><b>${selectedPlants(e).length}</b> plants</span>`);
    const issue=ingredientMode(e)?hasIngredients(e)?'Nutrition unknown.':e.message||'Ingredients could not be read.':e.needsClearerPhoto?e.message||'Some details need checking.':fields.some(([key])=>snap[key].portion===null)?'Some nutrition is unknown.':'';
    return `<section class="scan-result ${e.type==='meal'?'n-meal-result':''}">${e.type==='meal'?`<div class="n-eyebrow">Meal analysis · ${state.photoCount||1} photo${state.photoCount>1?'s':''}</div>`:''}<h1 class="n-title">${esc(state.name||'Your food')}</h1>${state.brand?`<p class="scan-brand">${esc(state.brand)}</p>`:''}${hasIngredients(e)?`<p class="scan-plants">${selectedPlants(e).map(esc).join(', ')||'No named plants identified.'}${e.ingredients.needsReview?' · Check unclear ingredients':''}</p>`:''}${issue?`<p class="scan-note" role="status">${esc(issue)}</p>`:''}${state.pendingExtraction?'<p class="notice">The new label uses a different nutrition basis. Your edits are kept.</p><button class="button secondary" data-action="label-keep-edits">Keep my edits</button><button class="button secondary" data-action="label-use-new-result">Use new label values</button>':''}${e.type==='meal'?`${state.thumbnail?`<div class="n-meal-hero"><img src="${esc(state.thumbnail)}" alt="Your photographed meal"></div>`:''}<section class="n-rating">${window.NudgeResults?.mascot()||''}<div><div class="n-rating-text">A little more nourishment.</div><div class="n-caption">Estimated nutrition. ${old?'Included in your daily totals.':'Ready when you are. Log the amount you ate.'}</div></div></section>`:''}${portionForm()}<div class="scan-facts" aria-live="polite">${facts.join('')}</div>${e.labelKind==='unreadable'||ingredientMode(e)&&!hasIngredients(e)?'<button class="button primary" data-action="label-retake">Add label photo</button>':`<button class="button primary scan-save" data-action="label-save" ${state.pendingExtraction?'disabled':''}>${old?'Save changes':e.type==='meal'?'Add to today':'Add to diary'}</button>`}<details class="scan-details" id="label-details" ${state.detailsOpen?'open':''}><summary>Edit details</summary>${identityForm()}${nutritionForm()}${ingredientForm()}<p class="small muted">${e.type==='meal'?'Photo estimates need your review. Hidden ingredients and allergens cannot be established from a photo.':'AI extraction. Check allergens on the pack.'}</p>${old?'<p class="small muted">Missing replacements keep the existing diary value.</p>':''}<button class="button secondary" data-action="label-retake">Scan again</button></details><button class="button secondary" data-action="repertoire-save-analysis">Save to my foods</button>${alternatives.screen()}</section>`;
  }
  function portionForm(compact=false){const old=entry(),photographed=state.extraction?.meal?.portion;
    const physicalAmount=Number.isFinite(photographed?.amount)&&photographed.amount>0&&photographed.amount<=5000&&['g','ml'].includes(photographed.unit)?`<p class="n-caption">${photographed.source==='confirmed'?'':'About '}${round(photographed.amount*state.amount,1)} ${esc(photographed.unit)} · ${photographed.source==='confirmed'?'amount confirmed':'estimated from your photo'}</p>`:'';
    if(state.extraction?.type==='meal'){
      if(window.NudgeFoodDetailModel?.mealMeasures&&(estimatedServing(state.extraction)||state.portionConfirmed||!requiresPortionChoice(state.extraction)))return mealMeasureForm();
      if(estimatedServing(state.extraction))return `<section class="scan-portion n-meal-portion"><input type="hidden" id="label-amount" value="${state.amount}">${window.NudgeControls.stepper({label:'Suggested portions',value:state.amount,unit:'portions',step:.25,minimum:.25,maximum:known(photographed?.amount)?Math.min(8,5000/photographed.amount):8,action:'label-step',increment:'¼',className:'n-meal-stepper'})}${window.NudgeControls.choices({label:'Quick portions',items:[.5,1,1.25,2].map(n=>[n,n===1?'1 portion':n+' portions',known(photographed?.amount)&&n*photographed.amount>5000]),value:state.amount,action:'label-portion',className:'nc-presets'})}<button class="text-button" data-action="label-exact">Edit exact amount</button></section>`;
      const dish=state.extraction.meal?.subject?.kind==='serving_dish',choice=requiresPortionChoice(state.extraction),presets=dish?[[.25,'¼ bowl'],[.5,'½ bowl'],[.75,'¾ bowl'],[1,'Whole bowl']]:[[.5,'Half'],[1,'This plate'],[1.5,'One & a half']];
      return `<section class="scan-portion">${compact?'':'<h2 class="n-meal-heading">How much will you eat?</h2>'}${state.portionConfirmed?physicalAmount:''}<div class="n-segments n-meal-portion-options" aria-label="Meal portion">${presets.map(([n,label])=>`<button data-action="label-portion" data-value="${n}" aria-pressed="${(!choice||state.portionConfirmed)&&state.amount===n}">${label}</button>`).join('')}</div>${compact?'':`<input type="hidden" id="label-amount" value="${choice&&!state.portionConfirmed?'':state.amount}"><button class="button secondary" data-action="label-exact">Edit exact amount</button>`}</section>`;
    }
    if(old&&old.portionAmount&&['g','ml'].includes(old.portionUnit))return `<p class="scan-amount">${round(state.amount*(old.portions||1),3)} ${esc(state.unit)}</p>`;
    const controls=old?`<label class="form-label" for="label-amount">Amount in one saved portion · ${esc(state.unit)}</label><input class="field" id="label-amount" type="number" min="0.1" max="5000" step="any" value="${state.amount??''}" placeholder="Enter amount">`:window.NudgeScanUI.portion({prefix:'label',amount:state.amount,base:state.portionBase,label:state.portionLabel,source:state.portionSource,unit:state.unit,esc});
    return `<section class="scan-portion">${controls}${!old?`<input type="hidden" id="label-amount" value="${state.amount}"><input type="hidden" id="label-amount-unit" value="${state.unit}">`:""}<button class="button secondary" data-action="label-exact">Edit amount · ${esc(state.unit)}</button><details id="label-amount-details" ${state.amountDetailsOpen?'open':''}><summary>Change date</summary>${old?'':`<label class="form-label" for="label-day">Date</label><input class="field" id="label-day" type="date" max="${todayKey()}" value="${state.day}">`}<p class="small muted">Amount in ${esc(state.unit)}. The printed basis determines supported units.</p></details></section>`;
  }
  function collect(){
    const e=state.extraction;if(!e)return false;let valid=true;
    state.detailsOpen=document.getElementById('label-details')?.open??state.detailsOpen;state.amountDetailsOpen=document.getElementById('label-amount-details')?.open??state.amountDetailsOpen;
    if(compositionMeal(e)){
      for(const [i,c] of e.meal.components.entries()){
        const choice=read('label-component-record-'+i,c.recordId||''),candidates=[...(c.sourceRecord?[c.sourceRecord]:[]),...(c.candidates||[])];
        if(choice!==(c.recordId||'')){if(e.meal.recipeCalculation)e.meal.recipeCalculation.userEdited=true;const record=candidates.find(r=>r.id===choice);c.recordId=record?.id||null;c.sourceRecord=record||null;c.nutrients=record?.nutrients||{};c.matchStatus=record?'confirmed':'unmatched';c.matchMethod=record?'user_selected':'unmatched';c.preparationProxy=false;c.excludedPreparation=null;c.assumptions=record?['Food-composition record selected by you. Hidden ingredients remain unknown.']:[];delete c.compoundProxy;delete c.recovery;delete e.meal.compoundProposal;delete e.meal.recovery;delete e.meal.scoreSnapshot;delete e.meal.qualityEstimate;e.confirmedSnapshot=false;}
        const raw=read('label-component-grams-'+i,c.amountGrams===null?'':String(c.amountGrams)).trim(),amount=raw===''?null:Number(raw);
        if(amount!==null&&(!known(amount)||amount<(c.recipeQuantity?.000001:.1)||amount>5000))valid=false;
        else if(amount!==c.amountGrams){if(e.meal.recipeCalculation)e.meal.recipeCalculation.userEdited=true;c.amountGrams=amount;c.amountSource='confirmed';delete e.meal.scoreSnapshot;delete e.meal.qualityEstimate;e.confirmedSnapshot=false;}
      }
      calculateComposition(e);
    }
    if(!ingredientMode(e)&&!compositionMeal(e)){fields.forEach(([key])=>{
      const previous=e.nutrients[key],input=document.getElementById('label-'+key),raw=read('label-'+key,previous.value===null?'':String(previous.value)).trim(),value=raw===''?null:Number(raw),unit=read('label-unit-'+key,previous.unit);
      if(input?.validity?.badInput||(value!==null&&!known(value)))valid=false;
      if(value!==previous.value||unit!==previous.unit)state.corrections[key]={value,unit};
      e.nutrients[key]={value,unit,...(value===previous.value&&unit===previous.unit&&previous.relation?{relation:previous.relation}:{})};
    });
    const basis=read('label-basis',e.basis),chosenBasis=Object.hasOwn(bases,basis)?basis:'unknown';
    if(chosenBasis!==e.basis)state.corrections.basis=chosenBasis;e.basis=chosenBasis;
    if(e.basis==='perServing'){
      const raw=read('label-serving-size',e.servingSize?.value===undefined?'':String(e.servingSize.value)).trim(),value=raw===''?null:Number(raw),unit=read('label-serving-unit',e.servingSize?.unit||state.unit);
      const size=value!==null&&Number.isFinite(value)&&value>0&&value<=5000&&['g','ml'].includes(unit)?{value,unit}:null;
      if(JSON.stringify(size)!==JSON.stringify(e.servingSize))state.corrections.servingSize=size;e.servingSize=size;
    }
    }
    if(hasIngredients(e)){
      const before=JSON.stringify(e.ingredients),text=read('label-ingredients-text',e.ingredients.text).trim().slice(0,4000),textChanged=text!==e.ingredients.text;
      e.ingredients.text=text;e.ingredients.textEdited=e.ingredients.textEdited===true||textChanged;
      e.ingredients.plants=e.ingredients.plants.map((plant,index)=>{
        const name=read('label-plant-name-'+index,plant.name).trim().slice(0,40),checkbox=document.getElementById('label-plant-selected-'+index);
        return {...plant,name,selected:checkbox?checkbox.checked:plant.selected,evidence:textChanged||name!==plant.name?'':plant.evidence,userEdited:plant.userEdited===true||name!==plant.name||(checkbox&&checkbox.checked!==plant.selected)};
      });
      if(JSON.stringify(e.ingredients)!==before)state.ingredientCorrections=JSON.parse(JSON.stringify(e.ingredients));
    }
    if(e.type!=='meal'&&!['g','ml'].includes(entry()?.portionUnit)){const unit=read('label-amount-unit',state.unit);if(['g','ml'].includes(unit)&&unit!==state.unit){state.unit=unit;state.amountEdited=true;usePortion(e);}}
    if(e.type==='meal'||!entry()?.portionAmount||!['g','ml'].includes(entry()?.portionUnit)){
      const rawAmount=read('label-amount',state.amount===null?'':String(state.amount)).trim();if(rawAmount!==''){const amount=Number(rawAmount);if(amount!==state.amount)state.amountEdited=true;state.amount=amount;}
    }
    const name=read('label-name',state.name).trim(),brand=read('label-brand',state.brand).trim();
    if(name!==state.name){state.nameEdited=true;if(e.meal){e.meal.name=name;delete e.meal.scoreSnapshot;delete e.meal.qualityEstimate;e.confirmedSnapshot=false;}}if(brand!==state.brand)state.brandEdited=true;
    state.name=name;state.brand=brand;if(!state.repairId)state.day=read('label-day',state.day);
    return valid;
  }
  const snapshot=(amount,unit)=>analysis.snapshot(state.extraction,{amount,unit,old:entry(),corrections:state.corrections});
  function buildRecord(old,amount,unit,day){
    return analysis.buildRecord({extraction:state.extraction,old,amount,unit,day,
      draft:{confirmationId:state.confirmationId,context:state.context,slot:state.slot,name:state.name,brand:state.brand,
        mealBatchVolumeMl:state.mealBatchVolumeMl,portionLabel:state.portionLabel,portionSource:state.portionSource,
        portionBase:state.portionBase,corrections:state.corrections},
      selection:state.extraction.type==='meal'?mealSelection():null,
      profile:getState().nutritionProfile||{},avoidMilk:getState().avoidMilk,entries:getState().foodLog?.entries||[],retrievedAt:new Date().toISOString()});
  }
  function repertoireDraft(){
    if(state.phase!=='review'||!state.extraction||state.pendingExtraction||state.saving||!collect()){showToast('Check the food and amounts before saving it to My foods.');return null;}
    const e=state.extraction,old=entry(),amount=e.type==='meal'?state.amount:old&&['g','ml'].includes(old.portionUnit)?old.portionAmount??state.amount:state.amount,unit=e.type==='meal'?'portion':old?.portionUnit||state.unit;
    if(state.repairId&&!old||!state.name||!Number.isFinite(amount)||amount<(e.type==='meal'?.0001:.1)||amount>(e.type==='meal'?8:5000)||e.type==='meal'&&requiresPortionChoice(e)&&!state.portionConfirmed||e.type==='meal'&&known(e.meal?.portion?.amount)&&e.meal.portion.amount*amount>5000||e.type==='meal'&&state.mealBatchVolumeMl&&state.mealBatchVolumeMl*amount>5000){showToast('Check the food name and portion before saving it to My foods.');return null;}
    if(!ingredientMode(e)&&(e.basis==='unknown'||e.basis==='perServing'&&!e.servingSize||e.basis==='per100g'&&unit!=='g'||e.basis==='per100ml'&&unit!=='ml'||e.basis==='perServing'&&e.servingSize.unit!==unit)){showToast('Check the nutrition basis and measured units before saving.');return null;}
    if(!hasIngredients(e)&&!fields.some(([key])=>snapshot(amount,unit)[key].portion!==null)){showToast('Add readable ingredients or nutrition before saving this food.');return null;}
    const record=buildRecord(old,amount,unit,todayKey());record.id=unique();record.day=todayKey();
    for(const key of ['confirmationId','scanEventId','productScanEventId','consumedAt'])delete record.sourceMeta[key];
    const draft=window.WmdFoodLog.clean({entries:[record]}).entries[0];if(!draft)return null;
    return {draft:{...draft,diaryIntent:'add'},extraction:JSON.parse(JSON.stringify(e)),thumbnail:state.thumbnail||state.photoPreview||''};
  }
  function persist(){
    if(state.phase!=='review'||!state.extraction||state.saving||!state.confirmationId||state.pendingExtraction)return;
    if(window.NudgeHistory?.isDeleted?.(state.confirmationId)||window.NudgeHistory?.isEntryDeleted?.(state.repairId||state.confirmationId)){showToast('This entry was deleted. Undo in History to restore it.');return;}
    if(!collect()){state.detailsOpen=true;render();showToast('Check the numbers in Edit details.');return;}
    const log=getState().foodLog,old=entry();
    if(state.repairId&&!old){showToast('This saved entry is no longer available. Nothing was added.');return;}
    const e=state.extraction;if(e.type==='meal'&&requiresPortionChoice(e)&&!state.portionConfirmed){render();showToast(estimatedServing(e)?'Add the missing ingredient amounts in Edit before confirming.':'Choose your share of the food before confirming.');return;}
    const amount=e.type==='meal'?state.amount:old&&['g','ml'].includes(old.portionUnit)?old.portionAmount??state.amount:state.amount,unit=e.type==='meal'?'portion':old?.portionUnit||state.unit,day=old?.day||state.day;
    if(!Number.isFinite(amount)||amount<(e.type==='meal'?.0001:.1)||amount>(e.type==='meal'?8:5000)||!['g','ml','portion'].includes(unit)){showToast(e.type==='meal'?'Choose a positive portion up to 8 analysed portions.':'Enter an amount between 0.1 and 5,000 g or ml.');return;}
    if(window.WmdStreakMath.dayNumber(day)===null||day>todayKey()){showToast('Choose today or a past date.');return;}
    if(!state.name){state.detailsOpen=true;render();showToast('Add the food name in Edit details.');return;}
    if(!ingredientMode(e)&&(e.basis==='unknown'||(e.basis==='perServing'&&!e.servingSize))){state.detailsOpen=true;render();showToast('Check the printed basis in Edit details.');return;}
    if(!ingredientMode(e)&&((e.basis==='per100g'&&unit!=='g')||(e.basis==='per100ml'&&unit!=='ml')||(e.basis==='perServing'&&e.servingSize.unit!==unit))){showToast('The label and saved amount use different units. Check the printed basis; grams and ml cannot be interchanged.');return;}
    if(e.type==='meal'&&known(e.meal?.portion?.amount)&&e.meal.portion.amount*amount>5000||e.type==='meal'&&state.mealBatchVolumeMl&&state.mealBatchVolumeMl*amount>5000){showToast('This adds up to more than 5,000 g or ml. Reduce the portions or edit the ingredient amounts.');return;}
    const snap=snapshot(amount,unit),complete=fields.every(([key])=>snap[key].portion!==null);
    if(ingredientMode(e)&&!e.ingredients?.text){showToast('No readable ingredients yet. Check the label or retake it.');return;}
    if(e.type!=='meal'&&!ingredientMode(e)&&!fields.some(([key])=>snap[key].portion!==null&&!snap[key].retained)){showToast('No readable nutrition values yet. Check the label or retake it.');return;}
    if(!old&&log.entries.some(x=>x.sourceMeta?.confirmationId===state.confirmationId)){showToast('This confirmation is already in your diary.');return;}
    const record=analysis.repairProductRecord(buildRecord(old,amount,unit,day),old,e,{
      previousProduct:window.NudgeHistory?.find?.(old?.sourceMeta?.productScanEventId||old?.sourceMeta?.scanEventId)?.product,
      corrections:state.corrections,profile:getState().nutritionProfile||{},avoidMilk:getState().avoidMilk,entries:getState().foodLog?.entries||[]});
    state.saving=true;
    const result=old?diary.update(old.id,record):diary.add(record);
    if(!result.ok){state.saving=false;showToast(result.status==='duplicate'?'This confirmation is already in your diary.':result.status==='missing'?'This saved entry is no longer available. Nothing was added.':result.status==='invalid'?'The product record could not be saved.':'The diary could not be saved on this device. Keep this result open and try saving again. Earlier saved entries are unchanged.');return;}
    const cleaned=result.entry;
    window.NudgeHistory?.link(state.confirmationId,cleaned.id);clearRequest();state.saving=false;view.foodDraft=null;view.foodMode='actual';view.foodDay=cleaned.day;navigate(window.NudgeHistory?'history':'food-patterns');showToast(old?'Diary entry repaired after your confirmation.':ingredientMode(e)?'Ingredients saved · nutrition remains unknown.':e.type==='meal'?complete?'Meal added to your daily totals.':'Meal saved · known nutrition added; some values are missing.':complete?'Product and nutrition saved to your diary.':'Food saved · nutrition incomplete.');
  }
  function continueProduct(scan,options={}){
    if(!scan)return;state.confirmationId=scan.confirmationId||unique();state.context=scan.product||(scan.error?.barcode?{barcode:scan.error.barcode}:null);state.name=scan.product?.name||'';state.brand=scan.product?.brand||'';state.phase='idle';state.analysisType='product';view.resultOrigin='camera';navigate('label-photo');capture('label',true,{requestedPanel:options.panel||'both'});
  }
  function invalidate(id){
    if(id!==state.confirmationId&&id!=='diary:'+state.repairId)return;
    clearRequest();if(view.screen==='label-photo')navigate('history');
  }
  function returnToCapture(){if(state.phase!=='loading'||state.photoCount<1||view.resultOrigin==='history')return false;window.NudgeHistory?.record({id:state.confirmationId,status:'failed',message:'Analysis canceled. Continue with your retained photos.'});capture('label',true);if(view.screen!=='label-photo')navigate('label-photo');return true;}
  function handleAction(action,value){
    if(alternatives.handleAction(action,value))return true;
    if(action==='result-next'||action==='result-close'){if(action==='result-close'&&returnToCapture())return true;if(action==='result-close'&&view.resultOrigin==='history'){clearRequest();navigate('history');return true;}if(state.phase==='capturing'&&action==='result-close'){clearRequest();navigate('today');return true;}clearRequest(false);state.confirmationId=unique();state.requestId=unique();state.phase='capturing';state.returnScreen=view.resultOrigin==='history'?'history':'today';view.resultOrigin='camera';navigate('label-photo');native('camera-resume');return true;}
    if(action==='product-retry'){const scan=window.NudgeBarcode?._scan;if(!scan)return true;state.confirmationId=scan.confirmationId;state.requestId=unique();state.phase='loading';native('barcode-retry',{barcode:scan.product?.barcode||scan.error?.barcode||''});return true;}
    if(action==='product-label'){continueProduct(window.NudgeBarcode?._scan);return true;}
    if(action==='scan-food'||action==='label-photo'){begin(value);return true;}
    if(action==='label-capture'||action==='label-retake'){capture(Object.hasOwn(photoNames,value)?value:'label');return true;}
    if(action==='configure-label-backend'){if(!state.confirmationId)state.confirmationId=unique();if(!state.requestId)state.requestId=unique();native(action);return true;}
    if(action==='label-retry'){if(state.canRetryPhotos&&view.resultOrigin!=='history'){state.phase='loading';state.canRetryPhotos=false;native('analyse-label');render();}else capture('label');return true;}
    if(action==='label-analyse'){return true;} // The native camera owns upload permission and analysis.
    if(action==='label-measure'){if(state.extraction?.type==='meal'&&mealMeasures().options.some(m=>m.id===value)){collect();state.mealMeasure=value;render();}return true;}
    if(action==='label-measure-step'){if(state.extraction?.type==='meal'&&collect()){const measure=mealMeasure();if(applyMealAmount(state.amount/measure.factor+Number(value)))render();}return true;}
    if(action==='label-recipe-servings'||action==='label-recipe-fraction'||action==='label-recipe-exact'){
      const e=state.extraction,calculation=e?.meal?.recipeCalculation;
      if(state.phase!=='review'||!calculation||calculation.userEdited||!window.NudgeRecipeComposition)return true;
      const apply=(servings,fraction,source)=>{
        if(!collect())return false;
        const updated=window.NudgeRecipeComposition.apply(e.meal,servings,{source,portionFraction:fraction});
        if(updated===e.meal||!updated.recipeCalculation?.applied)return false;
        e.meal=updated;e.confirmedSnapshot=false;delete e.meal.scoreSnapshot;
        if(action!=='label-recipe-servings')state.amount=1;
        state.amountEdited=true;state.mealMeasure='serving';state.mealBatchServings=1;state.mealBatchVolumeMl=null;
        calculateComposition(e);render();return true;
      };
      if(action==='label-recipe-fraction'){apply(calculation.servings,Number(value),'user');return true;}
      if(action==='label-recipe-exact'){window.NudgeControls.exact({label:'Percentage of the whole dish eaten',value:recipeFraction()*100,unit:'%',minimum:1,maximum:100,onApply:percent=>apply(calculation.servings,percent/100,'user')});return true;}
      window.NudgeControls.exact({label:'Servings in the whole recipe',value:calculation.servings||null,unit:'servings',minimum:1,maximum:50,onApply:count=>Number.isInteger(count)&&apply(count,recipeFraction(),'user')});return true;
    }
    if(action==='label-batch-servings'){if(state.extraction?.type==='meal')window.NudgeControls.exact({label:'Servings in the full analysed batch',value:state.mealBatchServings,unit:'servings',minimum:1,maximum:50,onApply:count=>{state.mealBatchServings=count;state.mealMeasure='serving';applyMealAmount(1);render();}});return true;}
    if(action==='label-batch-volume'){if(state.extraction?.type==='meal')window.NudgeControls.exact({label:'Measured volume of the full analysed batch',value:mealMeasures().volumeMl||null,unit:'ml',minimum:.1,maximum:5000,onApply:volume=>{state.mealBatchVolumeMl=volume;state.mealMeasure='cup';applyMealAmount(1);render();}});return true;}
    if(action==='label-exact'){
      if(state.extraction?.type==='meal'&&window.NudgeFoodDetailModel?.mealMeasures){const info=mealMeasures(),measure=mealMeasure();window.NudgeControls.exact({label:'Amount eaten',value:state.amount/measure.factor,unit:measure.label,minimum:info.minimum/measure.factor,maximum:info.maximum/measure.factor,onApply:amount=>{if(applyMealAmount(amount))render();}});return true;}
      const meal=state.extraction?.type==='meal',physical=state.extraction?.meal?.portion?.amount;
      window.NudgeControls.exact({label:meal?'Portions':'Amount',value:state.amount,unit:meal?'portions':state.unit,minimum:meal?.25:.1,maximum:meal?(known(physical)?Math.min(8,5000/physical):8):5000,onApply:amount=>{state.amount=amount;state.amountEdited=true;if(meal)state.portionConfirmed=!estimatedServing(state.extraction)||!requiresPortionChoice(state.extraction);render();}});return true;
    }
    if(action==='label-portion'||action==='label-step'){
      if(state.phase!=='review'||(state.repairId&&state.extraction?.type!=='meal')||!collect())return true;
      const amount=state.extraction?.type==='meal'&&action==='label-portion'?Number(value):window.NudgeScanUI.adjust(state.amount,state.portionBase,action==='label-step',value);
      if(amount!==null&&Number.isFinite(amount)&&amount>0&&(state.extraction?.type!=='meal'||amount>=.0001&&amount<=mealMeasures().maximum&&(!known(state.extraction.meal?.portion?.amount)||state.extraction.meal.portion.amount*amount<=5000))){state.amount=amount;state.amountEdited=true;if(state.extraction?.type==='meal')state.portionConfirmed=!estimatedServing(state.extraction)||!requiresPortionChoice(state.extraction);render();}return true;
    }
    if(action==='label-recheck-meal'){
      const e=state.extraction;if(state.phase!=='review'||!entry()||!compositionMeal(e)||!estimatedServing(e)||(validMealScore(mealScore(e))&&mealScore(e).status!=='estimated_rough')||e.recoveryPreview)return true;
      // This is a review draft only. Keep the saved diary snapshot and its plant
      // choices authoritative until the user explicitly saves these changes.
      const recovered=recoverMeal(e.meal,{confirmed:false,userEdited:false});
      const checkedScore=window.NudgeMealScore?.calculate(recovered);
      if(JSON.stringify(recovered)===JSON.stringify(e.meal)&&!validMealScore(checkedScore)){e.recoveryChecked=true;render();showToast('No additional supported matches yet. Check the foods in Edit.');return true;}
      state.mealRecoveryOriginal=JSON.parse(JSON.stringify({extraction:e,amount:state.amount,portionConfirmed:state.portionConfirmed,name:state.name,brand:state.brand,amountEdited:state.amountEdited,nameEdited:state.nameEdited,brandEdited:state.brandEdited,corrections:state.corrections,ingredientCorrections:state.ingredientCorrections,detailsOpen:state.detailsOpen,mealEditing:state.mealEditing}));
      e.meal=JSON.parse(JSON.stringify(recovered));e.confirmedSnapshot=false;e.recoveryPreview=true;delete e.meal.scoreSnapshot;calculateComposition(e);render();return true;
    }
    if(action==='label-keep-saved-meal'){
      if(state.mealRecoveryOriginal){Object.assign(state,state.mealRecoveryOriginal);state.mealRecoveryOriginal=null;render();}return true;
    }
    if(action==='label-meal-edit'){if(state.phase==='review'&&state.extraction?.type==='meal'){if(!collect()){showToast('Check the amounts before continuing.');return true;}state.mealEditing=!state.mealEditing;render();}return true;}
    if(action==='label-component-remove'){
      const e=state.extraction,index=Number(value);if(state.phase==='review'&&compositionMeal(e)&&Number.isInteger(index)&&e.meal.components[index]&&collect()){
        e.meal.components.splice(index,1);if(e.meal.recipeCalculation)e.meal.recipeCalculation.userEdited=true;delete e.meal.scoreSnapshot;delete e.meal.qualityEstimate;e.confirmedSnapshot=false;const visible=e.meal.components.map(c=>c.name).join(', ');e.ingredients.fromConfirmedSnapshot=false;e.ingredients.text=visible;e.meal.ingredients=e.meal.components.map(c=>({name:c.name,evidence:c.evidence||''}));e.ingredients.plants=e.ingredients.plants.filter(p=>supportedPlant(e,p));calculateComposition(e);render();
      }return true;
    }
    if(action==='label-toggle-plant'){
      if(state.phase==='review'&&hasIngredients(state.extraction)&&collect()){
        const plant=state.extraction.ingredients.plants[Number(value)];if(plant){plant.selected=plant.selected===false;plant.userEdited=true;state.ingredientCorrections=JSON.parse(JSON.stringify(state.extraction.ingredients));render();}
      }return true;
    }
    if(action==='label-ingredients-only'){if(state.phase==='review'&&hasIngredients(state.extraction)){collect();state.corrections={};state.lastLabelKind='ingredients';state.extraction.labelKind='ingredients';state.extraction.needsClearerPhoto=state.extraction.ingredients.needsReview;state.extraction.message='';state.extraction.basis='unknown';state.extraction.servingSize=null;fields.forEach(([key])=>{state.extraction.nutrients[key].value=null;});render();}return true;}
    if(action==='label-add-plant'){if(state.phase==='review'&&hasIngredients(state.extraction)&&state.extraction.ingredients.plants.length<40){if(!collect())return true;state.extraction.ingredients.plants.push({name:'',evidence:'',selected:true,originalName:'',userEdited:true});state.ingredientCorrections=JSON.parse(JSON.stringify(state.extraction.ingredients));render();}return true;}
    if(action==='label-keep-edits'){if(state.pendingExtraction){state.pendingExtraction=null;render();}return true;}
    if(action==='label-use-new-result'){if(state.pendingExtraction){const extraction=state.pendingExtraction;state.pendingExtraction=null;state.corrections={};state.extraction=null;state.phase='loading';receive({type:'result',draftId:state.confirmationId,requestId:state.requestId,result:{extraction}});}return true;}
    if(action==='label-remove'){const old=entry();if(old&&window.NudgeHistory){const row=window.NudgeHistory.items().find(r=>r.entry?.id===old.id);if(row)window.NudgeHistory.handleAction('history-delete',row.id);}return true;}
    if(action==='label-save'){persist();return true;}
    if(action==='label-close'){if(returnToCapture())return true;clearRequest();navigate(window.NudgeHistory?'history':'food-patterns');return true;}
    return false;
  }
  const alternatives=window.createNudgeAlternatives({render,esc,beforeRender:collect,getDraftId:()=>state.confirmationId,getProduct:()=>{const e=state.extraction;if(!e)return null;const snap=snapshot(state.amount,state.unit);return {name:state.name,barcode:state.context?.barcode||'',categoryTag:e.categoryTag,retailer:e.retailer,basisUnit:state.unit,nutrients:Object.fromEntries(fields.map(([key])=>[key,snap[key].per100===null?null:{value:snap[key].per100}]))};},prefix:'label'});
  function handleChange(target){
    if(state.phase!=='review'||!target.id?.startsWith('label-'))return false;
    state.detailsOpen=document.getElementById('label-details')?.open===true||state.detailsOpen;
    if(target.id==='label-name')state.nameEdited=true;if(target.id==='label-brand')state.brandEdited=true;if(target.id==='label-amount'){state.amountEdited=true;if(state.extraction?.type==='meal'&&target.value.trim()!==''&&Number(target.value)>=mealMeasures().minimum&&Number(target.value)<=mealMeasures().maximum)state.portionConfirmed=true;}
    if(!collect()){showToast('Use non-negative numbers, or leave unknown values blank.');return true;}
    alignUnit();if(state.extraction?.type==='meal'||['label-basis','label-serving-unit','label-amount-unit'].includes(target.id)||!window.NudgeScanUI.refresh(review()))render();return true;
  }
  function openStored(item){clearRequest();state.confirmationId=item.id;state.historyGeneration=window.NudgeHistory?.generation?.(item.id)||0;state.requestId=unique();state.thumbnail=item.thumbnail||'';state.photoCount=item.photoCount||0;view.resultOrigin='history';state.phase='loading';navigate('label-photo');if(item.extraction&&item.status==='ready'){const linked=window.NudgeHistory?.linked(item);receive({type:'result',draftId:state.confirmationId,requestId:state.requestId,result:{extraction:item.extraction}},{confirmedSnapshot:Boolean(linked),stored:true});if(linked){state.repairId=linked.id;state.name=linked.name;state.day=linked.day;state.slot=linked.slot;if(state.extraction?.type==='meal'){
        // Confirmed evidence wins over later/raw analysis, including renamed food.
        state.extraction.meal.name=linked.name;
        if(linked.sourceMeta?.mealRecipeCalculation)state.extraction.meal.recipeCalculation=JSON.parse(JSON.stringify(linked.sourceMeta.mealRecipeCalculation));else delete state.extraction.meal.recipeCalculation;
        delete state.extraction.meal.scoreSnapshot;delete state.extraction.meal.qualityEstimate;
        state.extraction.meal.ingredients=JSON.parse(JSON.stringify(linked.ingredients?.plants||[]));
        if(!Array.isArray(linked.sourceMeta?.mealComposition))state.extraction.meal.components=[];
        if(validMealScore(linked.sourceMeta?.mealScore))state.extraction.meal.scoreSnapshot=JSON.parse(JSON.stringify(linked.sourceMeta.mealScore));
        // The snapshot stores the eaten total. Preserve the original photographed-portion
        // scale so reopening or choosing “This plate” never compounds a prior portion.
        const savedPhotoPortions=Number(linked.sourceMeta?.photoPortions),basePortions=Number.isFinite(savedPhotoPortions)&&savedPhotoPortions>=.0001&&savedPhotoPortions<=8?savedPhotoPortions:1;
        state.amount=basePortions*linked.portions;state.portionConfirmed=true;const selection=linked.sourceMeta?.mealPortionSelection;state.mealMeasure=selection?.measureId||'serving';state.mealBatchServings=selection?.batchServings||1;state.mealBatchVolumeMl=selection?.batchVolumeMl||linked.sourceMeta?.mealBatchVolumeMl||null;
        if(compositionMeal(state.extraction)&&Array.isArray(linked.sourceMeta?.mealComposition)){state.extraction.meal.components=linked.sourceMeta.mealComposition.map((c,i)=>({...JSON.parse(JSON.stringify(c)),candidates:state.extraction.meal.components[i]?.name===c.name?state.extraction.meal.components[i].candidates:[]}));if(linked.sourceMeta.compositionVersion)state.extraction.meal.compositionVersion=linked.sourceMeta.compositionVersion;if(linked.sourceMeta.mealPortionMode==='estimated_serving')state.extraction.meal.portionMode='estimated_serving';else if(linked.sourceMeta.mealPortionMode==='photographed_portion')delete state.extraction.meal.portionMode;calculateComposition(state.extraction);if(linked.sourceMeta.mealScore)state.extraction.meal.scoreSnapshot=JSON.parse(JSON.stringify(linked.sourceMeta.mealScore));}
        state.extraction.ingredients={text:linked.ingredients?.text||linked.plants.join(', '),plants:linked.plants.map(name=>({name,evidence:linked.ingredients?.plants?.find(p=>canonical(p.name)===canonical(name))?.evidence||'',selected:true,originalName:name,userEdited:false})),needsReview:linked.ingredients?.needsReview||false,fromConfirmedSnapshot:true};
        for(const [key] of fields){const n=linked.nutritionSnapshot?.[key],fallback={energyKcal:'energyPerPortion',protein:'proteinPerPortion',fibre:'fibrePerPortion'}[key],portion=n&&Object.hasOwn(n,'portion')?n.portion:fallback?linked[fallback]:null;state.extraction.nutrients[key].value=known(portion)?portion/basePortions:null;}
}render();}}else{state.phase='error';state.error=item.message||'Analysis is incomplete. Take another photo to try again.';render();}}
  return {screen,begin,receive,repertoireDraft,openStored,continueProduct,invalidate,handleAction,handleChange,cancel:clearRequest,_state:state};
};
