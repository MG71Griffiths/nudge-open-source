/* Application adapter for SwiftUI. Existing domain rules and durable journals are
 * reused without a WKWebView. Native callbacks are synchronous, acknowledged IO. */
window.NudgeNativeSession = (() => {
  'use strict';
  const mainKey='wmd-nudge-prototype-v1', historyKey='nudge-scan-history-v1', foodsKey='nudge-my-foods-v1';
  const clone=v=>JSON.parse(JSON.stringify(v)), today=()=>nativeToday();
  let state, history, repertoire, review={}, message='', readFailed=false, changedStores=null, acknowledgedValues=null;
  const view={};
  const storage={native:true,getItem:key=>{const r=JSON.parse(nativeStorage(JSON.stringify({operation:'get',key})));if(!r.ok)throw Error('Saved data could not be read.');return r.value??null;},setItem:(key,value)=>{const r=JSON.parse(typeof nativeStorageWrite==='function'?nativeStorageWrite(key,value):nativeStorage(JSON.stringify({operation:'set',key,value})));if(!r.ok)throw Error('This change could not be saved.');changedStores?.add(key);acknowledgedValues?.set(key,value);},removeItem:key=>{const r=JSON.parse(nativeStorage(JSON.stringify({operation:'remove',key})));if(!r.ok)throw Error('This change could not be saved.');changedStores?.add(key);acknowledgedValues?.set(key,null);}};
  window.NudgeStorage=storage;
  const showToast=text=>{message=text;}, noOp=()=>{};
  const initial=()=>({version:1,nutritionProfile:NudgeNutrition.clean(),cycleSupport:NudgeCycle.clean(),motionEnabled:true,focus:'food',goal:5,easier:false,avoidMilk:false,completions:{},recalls:[],sampleServings:[],profile:{},foodLog:WmdFoodLog.initial()});
  const save=()=>{try{if(readFailed)throw Error();storage.setItem(mainKey,JSON.stringify(state));nativeDiagnostic('storage','saved',JSON.stringify({store:'main',operation:'write',entryCount:state.foodLog?.entries?.length||0,durable:true}));return true;}catch{message='This change could not be saved. Your earlier diary is unchanged.';nativeDiagnostic('storage','save_failed','{}');return false;}};
  const diary=()=>NudgeDiary.create({getState:()=>state,save,cleanEntry:r=>WmdFoodLog.clean({entries:[r]}).entries[0]});
  function repairMissingProfileTargets(){
    if(!state.nutritionProfile?.saved)return;
    // Native startup bypasses the browser's target reconciliation. Repair a
    // saved profile only when it has an eligible missing target we can fill.
    // The same draft migration preserves earlier accepted targets and plants;
    // manual clears, clinical plans and missing inputs never trigger a repair.
    const profile=NudgeNutrition.draft(state.nutritionProfile,state.profile,state.foodLog.plantGoal);
    const suggestions=NudgeNutrition.automaticSuggestions(profile);
    const missing=NudgeNutrition.automaticMetrics.some(metric=>profile[NudgeNutrition.targetFields[metric]]===null&&profile.targetModes?.[metric]!=='manual'&&suggestions[metric].value!==null);
    if(!missing)return;
    const result=NudgeNutrition.reconcileAutomaticTargets(profile,today());
    if(!result.changed)return;
    const previous=state;
    state={...state,nutritionProfile:result.profile};
    const plantGoal=result.profile.weeklyPlantTarget;
    if([10,20,30].includes(plantGoal)&&state.foodLog.plantGoal!==plantGoal)state.foodLog={...state.foodLog,plantGoal};
    if(!save()){
      state=previous;
      message='Automatic targets could not be saved. Your saved details and targets are unchanged; please try again.';
    }
  }
  function init(options={}){
    try { const raw=storage.getItem(mainKey);state=raw?JSON.parse(raw):initial();if(!state||state.version!==1||typeof state!=='object'||Array.isArray(state)||!Array.isArray(state.foodLog?.entries))throw Error(); }
    catch {state=initial();readFailed=true;message='Your saved diary could not be opened. It has been kept unchanged.';return snapshot(null,undefined,options.nativeHistory===true);}
    repairMissingProfileTargets();
    history=createNudgeHistory({getState:()=>state,view,escapeHtml:String,todayKey:today,render:noOp,navigate:noOp,showToast,save,showDialog:noOp,closeDialog:noOp,recipeBy:NudgeRecipeCatalogue.byId});
    repertoire=createNudgeRepertoire({getState:()=>state,view,todayKey:today,render:noOp,navigate:noOp,escapeHtml:String,showToast,showDialog:noOp,history});
    return snapshot(null,undefined,options.nativeHistory===true);
  }
  function nativeHistorySummary(value){
    // Swift owns queue status and invalidation only. Full evidence stays in the
    // existing JS archive and is requested through historyItem when a row opens.
    const fields=['id','captureOwnerKey','processingState','status','message','errorCode','nextAttemptAt','addToEaten','diaryAddState'];
    return {version:value.version,events:(Array.isArray(value.events)?value.events:[]).filter(row=>row&&typeof row==='object'&&typeof row.id==='string').map(row=>Object.fromEntries(fields.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]))),
      deleted:value.deleted||[],generations:value.generations||{},undo:value.undo?{phase:value.undo.phase,name:value.undo.name,ids:value.undo.ids}:null};
  }
  function snapshot(changes=null,previousReview,nativeHistory=false){
    // SwiftUI already owns the last acknowledged records. A draft keystroke
    // needs only its new review, not another multi-megabyte history disk read
    // and JavaScript-to-Swift conversion. Full snapshots remain the default.
    const result={};
    if(!changes||changes.has(mainKey))result.state=state;
    if(!changes||changes.has(historyKey)){
      // Within this synchronous transaction the acknowledged bytes are exactly
      // those on disk. Do not read, decode and bridge the whole file a second time.
      let h={};try{h=JSON.parse((changes&&acknowledgedValues?.has(historyKey)?acknowledgedValues.get(historyKey):storage.getItem(historyKey))||'{"events":[]}');}catch{message='Saved history could not be read. It has been kept unchanged.';}
      result.history=nativeHistory?nativeHistorySummary(h):h;
    }
    // Legacy favourites can depend on both the diary and archived products.
    if(!changes||[mainKey,historyKey,foodsKey].some(key=>changes.has(key)))result.foods={version:1,foods:projectedFoods()};
    return {...result,...(!changes||review!==previousReview?{review}:{}),message,readFailed};
  }
  function commitField(field,value){const previous=state[field];state[field]=value;if(!save()){state[field]=previous;return false;}return true;}
  function dayLabel(day){return new Date(day+'T12:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});}
  function datedRows(day){return (history?.nativeProjection('eaten',{}, {day}).rows||[]).filter(row=>row.entry?.day===day).map(row=>({...row,name:row.entry.name}));}
  function fatSourceContext(entry){
    const normal=value=>typeof value==='string'?value.toLowerCase().replace(/[-–]/g,' ').replace(/\byoghurt\b/g,'yogurt').replace(/\s+/g,' ').trim():'';
    // Food context, never a claim that all of this food's fat is unsaturated.
    // Plant alternatives and yogurt-flavoured/coated foods need their own facts.
    const dairyYogurt=value=>{const name=normal(value);return /\byogurts?\b/.test(name)&&! /\b(?:vegan|plant based|non dairy|dairy free|soy|soya|oat|almond|coconut|cashew|rice|pea|alternative|flavou?r(?:ed|ing)?|coated|powder|frozen|ice cream)\b|\b(?:no|without) yogurt\b|\byogurt free\b/.test(name);};
    const meta=entry.sourceMeta||{},selection=meta.mealIngredientSelection;
    const selected=selection?.source==='user'&&Array.isArray(selection.names)&&(selection.confirmed===true||selection.names.length>0)?selection.names:null;
    // An explicit selection, including an empty one, supersedes older guesses.
    if(selected&&!selected.some(dairyYogurt))return '';
    const name=normal(entry.name),standalone=(!selected||selected.length===1)&&dairyYogurt(name)&&/\byogurts?(?:\s+\d+(?:\.\d+)?\s*%(?:\s+fat)?)?$/.test(name)&&! /\b(?:with|and|smoothie|shake|bowl|parfait|salad|cake|dressing|sauce|dip|dessert)\b|&/.test(name);
    if(standalone)return 'Fermented dairy · yoghurt';
    const ingredients=entry.ingredients&&!entry.ingredients.needsReview?entry.ingredients.text.split(/[,;\n]/):[];
    const components=Array.isArray(meta.mealComposition)?meta.mealComposition:[];
    const sourcedYogurt=components.some(c=>c?.selected!==false&&c.amountGrams!==0&&c.recordId&&c.sourceRecord?.id===c.recordId&&c.sourceRecord.foodGroup==='dairy'&&dairyYogurt(c.sourceRecord.name));
    return (selected?selected.some(dairyYogurt):ingredients.some(dairyYogurt)||sourcedYogurt)?'Contains yoghurt · fermented dairy':'';
  }
  function dailyFatSources(day){
    // Use the same cleaned intake and source-bound arithmetic as the daily
    // totals. No rematching, history migration, or ingredient-level allocation.
    const rows=WmdFoodLog.clean(state.foodLog).entries.filter(entry=>entry.day===day&&day<=today()).map(entry=>{
      const fat=NudgeComposition.intakeNutrient(entry,'fat'),sat=NudgeComposition.intakeNutrient(entry,'saturatedFat');
      const amount=reading=>reading.value===null?null:reading.value*entry.portions;
      const estimated=Boolean(entry.sourceMeta?.nutritionEstimate)||entry.sourceMeta?.mealPortionMode==='estimated_serving'||/estimate/i.test(entry.source||'');
      return {id:entry.id,name:entry.name,context:fatSourceContext(entry),fat:amount(fat),saturatedFat:amount(sat),fatPartial:fat.partial===true,saturatedFatPartial:sat.partial===true,
        fatEstimated:estimated||fat.estimated===true,saturatedFatEstimated:estimated||sat.estimated===true};
    });
    return {rows,note:'Amounts cover each whole logged food. Yoghurt’s saturated fat is still included in your total.'};
  }
  const productSourceKey=product=>'product:'+(product?.barcode||product?.identityKey||product?.name||'');
  function legacyFavouriteProducts(){
    const seen=new Set();return (history?.productCandidates({favouritesOnly:true})||[]).filter(product=>{
      const key=history.favouriteKey(product);if(!product.name||!history.isFavourite(product)||seen.has(key))return false;seen.add(key);return true;
    });
  }
  function legacyFoodID(key){
    let a=2166136261,b=5381;for(let i=0;i<key.length;i++){a=Math.imul(a^key.charCodeAt(i),16777619);b=Math.imul(b,33)^key.charCodeAt(i);}
    return 'legacy-favourite-'+(a>>>0).toString(36)+'-'+(b>>>0).toString(36);
  }
  // Legacy favourites appear as reusable foods without rewriting either store.
  // Explicit removal writes one My Foods override together with any templates,
  // making heart state, Saved search and Camera favourites one atomic choice.
  function projectedFoods(referencesOnly=false){
    if(!repertoire)return [];
    const foods=repertoire.items(),hidden=new Set(repertoire.hiddenLegacyFavourites());
    for(const product of legacyFavouriteProducts()){
      const legacyKey=history.favouriteKey(product),sourceKey=productSourceKey(product);
      if(hidden.has(legacyKey)||foods.some(food=>food.sourceKey===sourceKey||product.barcode&&food.draft?.barcode===product.barcode))continue;
      // Heart membership needs the validated name/barcode, not a nutrition draft.
      // Full reusable foods still resolve nutrition when requested or opened.
      const id=legacyFoodID(legacyKey),record=referencesOnly?null:NudgeNativeReview.record({kind:'product',product,confirmationId:id,day:today(),slot:''},state,{today:today(),now:nativeNow()});
      const draft=repertoire.snapshotDraft(record?.ok?record.record:{name:product.name,brand:product.brand,barcode:product.barcode||'',day:today(),slot:'',portions:1,plants:[],ferments:[],source:'Saved product'});
      if(draft)foods.push({id,name:product.name,draft,image:NudgeProductEvidence.publicProductImage(product),sourceKey,updatedAt:'',legacyKey,legacyProduct:product});
    }
    return foods;
  }
  function removeFoods(ids){
    const selected=projectedFoods().filter(food=>ids.includes(food.id));
    const legacy=legacyFavouriteProducts().filter(product=>selected.some(food=>food.legacyKey===history.favouriteKey(product)||food.sourceKey===productSourceKey(product)||product.barcode&&food.draft?.barcode===product.barcode)).map(product=>history.favouriteKey(product));
    return repertoire.removeMany(ids,legacy);
  }
  // Derive heart state from the effective reusable foods, including older saves.
  function favouriteSources(row){
    const entry=row.entry,meta=entry?.sourceMeta||{},product=row.product||row.repairProduct;
    return [...new Set([
      !row.legacy&&row.id?'analysis:'+row.id:'',entry?.id?'entry:'+entry.id:row.repairEntryId?'entry:'+row.repairEntryId:'',
      meta.repertoireId?'saved:'+meta.repertoireId:'',
      product?'product:'+(product.barcode||product.identityKey||product.name):''
    ].filter(Boolean))];
  }
  function favouriteFoods(row,foods=projectedFoods()){
    const keys=favouriteSources(row),product=row.product||row.repairProduct;
    const legacy=product&&history?.isFavourite(product)&&!repertoire.hiddenLegacyFavourites().includes(history.favouriteKey(product));
    return foods.filter(food=>keys.includes(food.sourceKey)||keys.includes('saved:'+food.id)||legacy&&product.barcode&&food.draft?.barcode===product.barcode);
  }
  function canFavourite(row){return Boolean(row.entry||row.status==='ready'&&(row.product&&Object.keys(row.product).length||row.extraction&&row.extraction.type!=='unknown'));}
  function historyProjection(filter,currentProducts,options={}){
    const result=history?.nativeProjection(filter,currentProducts,options)||{rows:[],storageError:true},foods=projectedFoods(true);
    const sources=new Set(foods.map(food=>food.sourceKey)),ids=new Set(foods.map(food=>'saved:'+food.id)),barcodes=new Set(foods.map(food=>food.draft?.barcode).filter(Boolean)),hidden=new Set(repertoire?.hiddenLegacyFavourites()||[]);
    return {...result,rows:result.rows.map(row=>{
      const product=row.product||row.repairProduct,keys=favouriteSources(row);
      const legacy=product&&history?.isFavourite(product)&&!hidden.has(history.favouriteKey(product));
      return {...row,isFavourite:keys.some(key=>sources.has(key)||ids.has(key))||Boolean(legacy&&product.barcode&&barcodes.has(product.barcode)),canFavourite:canFavourite(row)};
    })};
  }
  function presentationEntry(entry){
    if(!entry)return entry;
    return {presentationOnly:true,...Object.fromEntries(['id','name','day','slot','barcode'].filter(key=>entry[key]!==undefined).map(key=>[key,entry[key]]))};
  }
  function presentationRow(row){
    // Lists need identity, display text and one picture. Full extraction, source
    // facts and immutable intake evidence are resolved only when a row opens.
    const keys=['id','name','kind','origin','status','createdAt','historyDay','note','legacy','entryId','barcode','captureOwnerKey','captureID','processingState','isFavourite','canFavourite','scoreDisplay','scoreDeferred'];
    const barcode=row.barcode||row.entry?.barcode||row.product?.barcode||row.entry?.sourceMeta?.product?.barcode;
    return {presentationOnly:true,canReuse:Boolean(row.entry||row.product||row.extraction),...Object.fromEntries(keys.filter(key=>row[key]!==undefined).map(key=>[key,row[key]])),
      ...(row.name===undefined&&row.product?.name?{name:row.product.name}:{}),
      ...(barcode?{barcode}:{}),imageURL:window.WmdFoodLog.entryImage?.(row.entry)||row.imageURL||row.thumbnail||NudgeProductEvidence.publicProductImage(row.product)||'',
      ...(row.entry?{entry:presentationEntry(row.entry)}:{})};
  }
  function historyItem(p){
    const row=history.items().find(row=>p.id?row.id===p.id:row.entry?.id===p.entryId);
    if(!row)return {row:null};
    const recipe=NudgeRecipeCatalogue.byId(row.entry?.recipe),image=NudgeResults.productImage?.(row.product,row.thumbnail);
    return {row:{...row,imageURL:WmdFoodLog.entryImage?.(row.entry)||WmdFoodLog.photoReferences?.(row.photos)?.[0]||row.thumbnail||image?.src||row.entry?.sourceMeta?.repertoireImage||(recipe?.image?'/assets/'+recipe.image:'')}};
  }
  function nextEvidenceExpiry(values,started){
    let deadline=Infinity;const seen=new Set();
    function visit(value){
      if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);
      // These are the two deadlines enforced by FoodDetailModel.cachedScore.
      for(const expiry of [value.catalogueExpiresAt,value.catalogueEnrichment?.expiresAt])
        if(Number.isFinite(expiry)&&expiry>started)deadline=Math.min(deadline,expiry);
      for(const child of Object.values(value))if(child&&typeof child==='object')visit(child);
    }
    for(const value of values)visit(value);return Number.isFinite(deadline)?deadline:null;
  }
  function project(operation,p={}){
    const started=Date.now(),result=calculateProjection(operation,p),includeExpiry=p.nativeCache===true||operation==='historyScore';
    // Only score envelopes contain expiring evidence. Walking the complete
    // archive here would traverse every duplicate extraction on each cache miss.
    const evidence=includeExpiry?[result.score,...(operation==='historyScore'?(result.row?[result.row]:[]):result.rows||[]).flatMap(row=>[
      row.product?.scoreResult,row.entry?.sourceMeta?.scoreMethod,row.entry?.sourceMeta?.mealScore,
      row.entry?.sourceMeta?.product?.scoreResult,row.extraction?.meal?.scoreSnapshot]),
      ...(operation==='reviewModel'?[review.product?.scoreResult,review.previousProduct?.scoreResult,
        review.entry?.sourceMeta?.scoreMethod,review.entry?.sourceMeta?.mealScore,review.extraction?.meal?.scoreSnapshot]:[])]:[];
    const deadline=includeExpiry?nextEvidenceExpiry(evidence,started):null;
    let value=operation==='historyScore'?{id:result.row?.id||p.id||'',available:Boolean(result.row),scoreDisplay:result.row?.scoreDisplay||null,note:result.row?.note||''}:result;
    if(p.presentation===true&&['history','today','diary'].includes(operation)){
      value={...result,rows:(result.rows||[]).map(presentationRow)};
      if(result.entries)value.entries=result.entries.map(presentationEntry);
      if(result.undo)value.undo={phase:result.undo.phase,name:result.undo.name,ids:result.undo.ids};
    }
    return includeExpiry?{...value,nativeCacheUntil:deadline}:value;
  }
  function toggleHistoryFavourite(id){
    const row=historyItem({id}).row;
    if(!row||!canFavourite(row)){message='Wait for this food to finish analysing before adding it to favourites.';return false;}
    const saved=favouriteFoods(row);
    if(saved.length){const ok=removeFoods(saved.map(food=>food.id));if(ok)message='Removed from favourites. Your diary is unchanged.';return ok;}
    let draft=row.entry;
    if(!draft){
      const input={kind:row.product?'product':'analysis',product:row.product,extraction:row.extraction,eventId:row.id,confirmationId:'favourite:'+row.id,thumbnail:row.thumbnail,photos:row.photos,day:today(),entryId:row.repairEntryId,
        ...(row.repairProduct?{previousProduct:row.repairProduct,previousReview:{product:row.repairProduct,draft:{portion:row.repairPortion}},context:{barcode:row.repairProduct.barcode||''}}:{})};
      const result=NudgeNativeReview.record(input,state,{today:today(),now:nativeNow()});
      if(!result.ok){message='Open this food and check its portion before saving it to favourites. '+(result.error||'');return false;}
      draft={...result.record,source:'Saved food from scan history'};
    }
    const keys=favouriteSources(row),ok=repertoire.saveDraft(draft,{sourceKey:keys[0],sourceKeys:keys,thumbnail:row.thumbnail||row.imageURL||''});
    if(ok)message='Added to favourites. Your diary is unchanged.';
    return ok;
  }
  function toggleProductFavourite(product){
    if(!product||typeof product.name!=='string'||!product.name.trim()||!/^\d{4,18}$/.test(product.barcode||'')){
      message='Open this product and check its details before saving it.';return false;
    }
    const sourceKey=productSourceKey(product),saved=projectedFoods().filter(food=>food.sourceKey===sourceKey||food.draft?.barcode===product.barcode);
    if(saved.length){const ok=removeFoods(saved.map(food=>food.id));if(ok)message='Removed from favourites. Your diary is unchanged.';return ok;}
    const result=NudgeNativeReview.record({kind:'product',product,confirmationId:'favourite:'+sourceKey,day:today(),slot:''},state,{today:today(),now:nativeNow()});
    if(!result.ok){message='Open this product and check its portion before saving it. '+(result.error||'');return false;}
    const ok=repertoire.saveDraft({...result.record,source:'Saved product from Search'},{sourceKey,thumbnail:NudgeProductEvidence.publicProductImage(product)});
    if(ok)message='Added to favourites. Your diary is unchanged.';
    return ok;
  }
  function searchProjection(p={}){
    const model=NudgeSearchModel,filters=model.normalizeFilters(p);
    if(p.parseQuery===true){const parsed=model.parseQuery(p.query,p);return {parsedQuery:parsed.query,filters:parsed.filters};}
    const list=value=>Array.isArray(value)?value:[],text=value=>typeof value==='string'?value.slice(0,500):'';
    const requirements={...state.nutritionProfile,avoidMilk:state.avoidMilk===true};
    // Native Recipes is a local library view. It must not read or rescore the
    // scan archive while a person types, or turn saved portions into recipes.
    const libraryOnly=p.recipeLibraryOnly===true&&filters.kind==='recipe';
    const recipes=NudgeRecipeCatalogue.all({includeDrafts:true}),savedFoods=libraryOnly?[]:projectedFoods();
    const number=value=>Number.isInteger(value)&&value>=0&&value<=100?value:null;
    const candidates=[],excluded=[],seen=new Set(),localProducts=libraryOnly?[]:history?.productCandidates()||[];
    const productID=product=>product?.barcode||product?.identityKey||product?.id||[product?.brand,product?.name].filter(Boolean).join('|');
    const safeProduct=item=>{
      const raw=item.raw,checks=NudgeFoodDetailModel.allergies(raw,requirements,{avoidMilk:requirements.avoidMilk});
      if(checks?.unknown===false)item.allergyStatus='label_check';
      const basic=model.safety(item,requirements);
      if(checks?.conflict)return {matches:false,reason:checks.warning||checks.conflicts?.[0]?.text||'Declared ingredients conflict with your saved requirements.'};
      if(!basic.matches)return basic;
      // Match the existing product discovery policy: an absent declaration
      // cannot establish a dietary or free-from requirement.
      const claims=[...list(raw.labelsTags),...list(raw.ingredientsAnalysisTags),...list(raw.declaredClaims).map(c=>typeof c==='string'?c:c?.text),...list(raw.claims).filter(c=>list(raw.metadata?.evidence).some(e=>e.id===c.evidenceId&&text(e.text).toLowerCase().includes(text(c.text).toLowerCase()))).map(c=>c.kind)]
        .filter(c=>typeof c==='string').map(c=>c.toLowerCase().replace(/^en:/,'').replace(/[_ ]+/g,'-'));
      const has=names=>claims.some(c=>names.includes(c)),diet=requirements.diet;
      const avoids=[...new Set([...list(requirements.avoids),...list(requirements.allergies),...list(requirements.excludedAllergens),...(['coeliac','sensitivity'].includes(requirements.glutenRequirement)||requirements.glutenFreePreference?['gluten']:[]),...(requirements.avoidMilk?['milk']:[])])];
      const restricted=['vegan','vegetarian','pescatarian'].includes(diet)||avoids.length>0;
      if(restricted&&(raw.ingredientsNeedsReview===true||raw.ingredients?.needsReview===true||list(raw.metadata?.conflicts).some(c=>['claims','allergens','ingredients'].includes(c.field))||list(raw.metadata?.missingFields).some(k=>['claims','allergens','ingredients'].includes(k))))return {matches:false,reason:'Ingredient or allergen evidence is incomplete for your saved requirements.'};
      const diets={vegan:['vegan','certified-vegan'],vegetarian:['vegetarian','vegan','certified-vegan'],pescatarian:['pescatarian','vegetarian','vegan','certified-vegan']};
      if(diets[diet]&&(!has(diets[diet])||has(diet==='vegan'?['non-vegan','vegan-status-unknown']:diet==='vegetarian'?['non-vegetarian','vegetarian-status-unknown']:[])))return {matches:false,reason:'This product is not verified as '+diet+'.'};
      const freeFrom={gluten:['gluten-free','no-gluten'],milk:['milk-free','dairy-free','no-milk'],nuts:['nut-free','nuts-free','no-nuts'],fish:['fish-free','no-fish'],eggs:['egg-free','eggs-free','no-eggs'],sesame:['sesame-free','no-sesame'],soy:['soy-free','soya-free','no-soy']};
      const missing=avoids.find(a=>!freeFrom[a]||!has(freeFrom[a]));
      if(missing||avoids.length&&checks?.unknown!==false)return {matches:false,reason:missing==='gluten'?'A gluten-free declaration is missing.':'Verified free-from evidence is missing for '+(missing||avoids.join(', '))+'.'};
      return basic;
    };
    const imageForRecipe=recipe=>typeof recipe.image==='string'&&/^[a-zA-Z0-9_-]+\.(?:webp|png|jpg)$/.test(recipe.image)?'/assets/'+recipe.image:'';
    const reasonFor=item=>[filters.meal!=='all'?model.mealMatch(item,filters.meal).reason:'',filters.support!=='all'?model.supportMatch(item,filters.support).reason:''].filter(Boolean).join(' · ');
    function add(item,row,{remote=false,saved=false,personal=false}={}){
      if(!item||p.savedOnly===true&&!saved)return;
      const liveRecipe=libraryOnly&&p.livePrefixMatch===true&&item.kind==='recipe';
      const selected={...filters,query:remote||liveRecipe?'':filters.query};
      if(!model.matches(item,selected,{}))return;
      if(liveRecipe){
        const words=item.searchText.split(' '),matches=query=>model.tokens(query).every((word,index,all)=>words.some(candidate=>candidate===word||(index===all.length-1&&candidate.startsWith(word))));
        if(!matches(filters.query)&&!matches(model.prepareQuery(filters.query).query))return;
      }
      // A saved personal template is an editable record, not a recommendation;
      // its portion and ingredient checks stay in the existing review flow.
      const check=personal?{matches:true}:item.kind==='product'?safeProduct(item):model.safety(item,requirements);
      const value={...row,score:item.score,reason:reasonFor(item)||row.reason||''};
      if(!check.matches){excluded.push({...value,reason:check.reason||'This food does not meet your saved requirements.'});return;}
      candidates.push({item,row:value,index:candidates.length});return true;
    }
    for(const recipe of recipes){
      const score=NudgeRecipeCatalogue.score(recipe),item=model.normalize(recipe,{kind:'recipe',score});
      add(item,{id:recipe.id,kind:'recipe',name:recipe.name,image:imageForRecipe(recipe),subtitle:['Recipe',recipe.category,recipe.minutes?recipe.minutes+' min':''].filter(Boolean).join(' · '),...(libraryOnly?{status:recipe.status}:{})},{saved:(state.foodLog.savedRecipes||[]).includes(recipe.id)});
    }
    const categoryTags=list(p.categoryTags).filter(tag=>typeof tag==='string');
    const products=(libraryOnly?[]:[...list(p.products).map(raw=>({raw,remote:true})),...localProducts.map(raw=>({raw,remote:false}))]).filter(candidate=>{
      const id=productID(candidate.raw);if(!id||seen.has(id))return false;
      if(!candidate.remote&&categoryTags.length&&!categoryTags.some(tag=>[candidate.raw.categoryTag,...list(candidate.raw.categories),...list(candidate.raw.categoriesTags)].includes(tag)))return false;
      seen.add(id);return true;
    });
    for(const {raw,remote} of products){
      const supplied=p.ratings?.[raw.barcode],resolved=project('productRating',{product:raw}).score||NudgeFoodDetailModel.score(raw);
      const rating=supplied&&Object.hasOwn(supplied,'value')?number(supplied.value):number(resolved?.value);
      const ratingSubtitle=text(supplied?.subtitle)||(rating===null?'Rating unavailable':resolved?.estimated?'Estimated Nudge rating':resolved?.status==='provisional'?'Provisional Nudge rating':'Nudge rating');
      const item=model.normalize(raw,{kind:'product',score:rating});
      const saved=savedFoods.some(food=>food.draft?.barcode&&food.draft.barcode===raw.barcode||food.sourceKey===productSourceKey(raw));
      add(item,{id:item?.id||String(productID(raw)),kind:'product',name:raw.name,image:NudgeProductEvidence.publicProductImage(raw),subtitle:[raw.brand||'Product',ratingSubtitle].filter(Boolean).join(' · '),ratingSubtitle,product:raw},{remote,saved});
    }
    const shownSavedIdentities=new Set();
    if(p.savedOnly===true)for(const food of savedFoods){
      const draft=food.draft||{},recipe=draft.sourceMeta?.recipeSnapshot||NudgeRecipeCatalogue.byId(draft.recipe),score=food.legacyProduct?NudgeFoodDetailModel.score(food.legacyProduct):NudgeNativeReview.model({kind:'entry',entry:draft,confirmationId:'search:'+food.id},state,{today:today()}).score;
      const raw=food.legacyProduct?{...food.legacyProduct,id:food.id}:{...(recipe||{}),...draft,id:food.id,name:food.name,ingredients:draft.ingredients?.text||'',category:'',mealTypes:[]};
      const kind=draft.barcode?'product':'recipe',item=model.normalize(raw,{kind,score});
      if(add(item,{id:food.id,kind:'saved',name:food.name,image:WmdFoodLog.entryImage?.(draft)||food.image||imageForRecipe(recipe||{}),subtitle:'Saved food · Your portion',reason:'Review the saved portion and ingredients before logging.'},{saved:true,personal:true})){
        if(draft.barcode)shownSavedIdentities.add('product:'+draft.barcode);
        else if(draft.recipe)shownSavedIdentities.add('recipe:'+draft.recipe);
      }
    }
    // Prefer the reusable portion when Saved would otherwise show the same food
    // twice. Distinct saved portions remain separate, and a filtered-out template
    // does not hide a matching favourite from the catalogue.
    for(let i=candidates.length-1;i>=0;i--)if(shownSavedIdentities.has(candidates[i].row.kind+':'+candidates[i].row.id))candidates.splice(i,1);
    for(let i=excluded.length-1;i>=0;i--)if(shownSavedIdentities.has(excluded[i].kind+':'+excluded[i].id))excluded.splice(i,1);
    const relevance=item=>{const name=model.canonical(item.name),query=model.canonical(filters.query);return !query?0:name===query?4:name.startsWith(query)?3:name.includes(query)?2:1;};
    candidates.sort((a,b)=>{
      if(p.sort==='nameAscending'||p.sort==='nameDescending')return (p.sort==='nameDescending'?-1:1)*a.row.name.localeCompare(b.row.name)||a.index-b.index;
      if(['ratingHighest','ratingLowest','score'].includes(p.sort))return a.row.score===null&&b.row.score!==null?1:b.row.score===null&&a.row.score!==null?-1:(p.sort==='ratingLowest'?1:-1)*((a.row.score??0)-(b.row.score??0))||a.index-b.index;
      return relevance(b.item)-relevance(a.item)||a.index-b.index;
    });
    const suggestionItems=libraryOnly?[]:[...recipes.map(raw=>model.normalize(raw,{kind:'recipe',score:NudgeRecipeCatalogue.score(raw)})),...products.map(({raw})=>model.normalize(raw,{kind:'product',score:NudgeFoodDetailModel.score(raw)}))].filter(item=>item&&(item.kind==='product'?safeProduct(item):model.safety(item,requirements)).matches);
    const suggestions=model.suggest(suggestionItems,p.typedQuery||filters.query,{filters,requirements,limit:8}).map(item=>item.value);
    return {rows:candidates.map(candidate=>candidate.row),recipeCount:recipes.length,loadedProductCount:products.length,excludedRecipes:excluded.filter(row=>row.kind==='recipe'),excludedReasons:[...new Set(excluded.map(row=>row.reason))],excludedCount:excluded.length,suggestions,cycle:NudgeCycle.context(state.cycleSupport,today()),filters};
  }
  // Private, read-only progress. Never sends scan details or awards public points.
  // Native supplies its authenticated account partition and the server join date.
  function ambassadorActivity(p={}){
    const empty=()=>({captured:0,ready:0,pending:0,needsInput:0,failed:0,products:0,photos:0,readyProducts:0});
    const now=Date.parse(nativeNow()),joined=p.joinedAt;
    if(typeof p.ownerKey!=='string'||!/^[a-f0-9]{64}$/.test(p.ownerKey)||!Number.isSafeInteger(joined)||joined<=0||!Number.isFinite(now)||joined>now||readFailed||!history?.isSaved?.())return {available:false};
    const monday=new Date(now);monday.setUTCHours(0,0,0,0);monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
    const currentWeek=monday.getTime(),all=new Map(),week=new Map();
    const knownStates=new Set(['queued','processing','complete','needsUserInput','retryableFailure']);
    const priority={ready:4,pending:3,needsInput:2,failed:1};
    // items() applies tombstones. Ignore its derived diary rows and all search,
    // anonymous/legacy and pre-join observations; they prove no owned capture.
    for(const row of history.items()){
      const created=Date.parse(row.createdAt);
      if(row.legacy||row.origin==='search'||row.captureOwnerKey!==p.ownerKey||!row.captureID||!knownStates.has(row.processingState)||!Number.isFinite(created)||created<joined||created>now)continue;
      const barcode=typeof row.barcode==='string'&&/^\d{4,18}$/.test(row.barcode)?row.barcode:null;
      const photos=(WmdFoodLog.photoReferences(row.photos)||[]).map(value=>value.toLowerCase()).sort();
      const key=barcode?'barcode:'+barcode:photos.length?'photos:'+photos.join('|'):null;
      if(!key)continue;
      const product=row.product,extraction=row.extraction;
      const evidence=Boolean(product&&typeof product==='object'&&!Array.isArray(product)&&Object.keys(product).length||extraction&&typeof extraction==='object'&&!Array.isArray(extraction)&&(extraction.type==='meal'&&extraction.meal||extraction.type!=='unknown'&&extraction.nutrients));
      const status=row.status==='ready'&&row.processingState==='complete'&&evidence?'ready':['queued','processing'].includes(row.processingState)?'pending':row.processingState==='needsUserInput'?'needsInput':'failed';
      const item={status,product:Boolean(barcode)};
      for(const group of created>=currentWeek?[all,week]:[all]){
        const old=group.get(key);
        if(!old||priority[item.status]>priority[old.status])group.set(key,item);
      }
    }
    const totals=group=>{const value=empty();for(const item of group.values()){value.captured++;value[item.status]++;value[item.product?'products':'photos']++;if(item.product&&item.status==='ready')value.readyProducts++;}return value;};
    return {available:true,weekStartsAt:currentWeek,week:totals(week),all:totals(all)};
  }

  function calculateProjection(operation,p={}){
    // Diagnostics need totals, never every archived scan and its score.
    if(operation==='nutritionTotals')return NudgeToday.model(state,today(),today());
    if(operation==='ambassadorActivity')return ambassadorActivity(p);
    if(operation==='mealIngredientSearch')return NudgeNativeReview.ingredientSearch(p.query);
    if(operation==='pendingEaten'){
      if(typeof p.ownerKey!=='string'||!p.ownerKey)return {rows:[]};
      const claims=state.captureIntakeClaims||{};
      return {rows:history.items().filter(row=>!row.legacy&&row.addToEaten===true&&row.captureOwnerKey===p.ownerKey&&row.loggingDay===p.day&&row.diaryAddState!=='cancelled'&&row.diaryAddState!=='added'&&!row.entry&&!Object.prototype.hasOwnProperty.call(claims,row.id)).map(row=>({id:row.id,name:row.name||'Your food',status:row.diaryAddState==='needsReview'||['unknown','failed'].includes(row.status)?'Check this food in History':'Analysing · will be added to eaten'}))};
    }
    if(operation==='captureState')return {deleted:history.isDeleted(p.id),event:history.find(p.id)||null};
    if(operation==='historyItem')return historyItem(p);
    if(operation==='historyScore')return {row:typeof p.id==='string'&&p.id?history?.nativeProjection('all',p.currentProducts,{id:p.id}).rows[0]||null:null};
    if(operation==='captureCachedProduct')return {product:history.productCandidates().find(product=>product.barcode===p.barcode)||null};
    if(operation==='recoverableCaptures')return {events:history.items().filter(row=>['failed','pending'].includes(row.status)&&row.barcode&&!row.product&&!row.extraction&&!row.captureOwnerKey)};
    if(operation==='today'||operation==='diary') {const day=operation==='diary'&&WmdStreakMath.dayNumber(p.day)!==null&&p.day<=today()?p.day:today(),m=NudgeToday.projection(state,day,today());return {...m,rows:datedRows(day),entries:state.foodLog.entries.filter(e=>e.day===day),fatSources:dailyFatSources(day),rings:NudgeToday.ringItems(m),weekRings:Object.fromEntries(m.days.map(d=>[d.day,NudgeToday.ringItems(m,d.day)])),budget:NudgeNutrition.macroBudget(state.nutritionProfile)};}
    if(operation==='history')return historyProjection(p.filter,p.currentProducts,{deferScores:p.presentation===true&&p.deferScores===true});
    if(operation==='search')return searchProjection(p);
    if(operation==='profile'){const profile=NudgeNutrition.draft(p.profile||state.nutritionProfile,state.profile,state.foodLog.plantGoal);return {profile,suggestions:NudgeNutrition.automaticSuggestions(profile),budget:NudgeNutrition.macroBudget(profile)};}
    if(operation==='cycle'){
      const cycle=NudgeCycle.clean(state.cycleSupport),context=NudgeCycle.context(cycle,today()),chosen=NudgeCycle.byId(p.phase)||NudgeCycle.byId(context.id);
      const search=window.NudgeSearchModel,catalogue=window.NudgeRecipeCatalogue,requirements={...state.nutritionProfile,avoidMilk:state.avoidMilk===true};
      let ideas=[],ideasNote='Meal ideas will appear when recipe information is available.';
      if(search&&catalogue?.all){
        const items=catalogue.all({includeDrafts:true}).map(r=>search.normalize(r,{kind:'recipe'})).filter(Boolean);
        const compatible=items.filter(i=>search.safety(i,requirements).matches),supported=chosen?compatible.filter(i=>search.supportMatch(i,chosen.id).matches):compatible;
        const suggested=(supported.length?supported:compatible).slice(0,3),specific=Boolean(chosen&&supported.length);
        const reasons=[...new Set(items.map(i=>search.safety(i,requirements)).filter(c=>!c.matches).map(c=>c.reason))];
        ideas=suggested.map(i=>({id:i.id,name:i.name,minutes:i.raw.minutes??null,category:i.raw.category||'',image:i.raw.image?'/assets/'+i.raw.image:null,reason:specific?search.supportMatch(i,chosen.id).reason:'Everyday meal idea'}));
        ideasNote=!ideas.length?(reasons.length?'No matching recipes yet. '+reasons.join(' '):'No recipes are available yet.'):!specific&&chosen?'Everyday meal ideas shown. No compatible recipe meets this stage filter with a sourced '+(chosen.id==='period'?'iron':'calcium')+' amount per serving.':'Matched to your saved food requirements.';
      }
      return {cycle,context,nutrients:NudgeCycle.micronutrients(state.foodLog.entries,today()),day:today(),phases:NudgeCycle.phases,choices:NudgeCycle.choices,regularity:NudgeCycle.regularity,contraception:NudgeCycle.contraception,focusOptions:NudgeCycle.focusOptions,ideas,ideasNote};
    }
    if(operation==='reviewModel')return NudgeNativeReview.model(review,state,{today:today()});
    if(operation==='productScanModel'){
      // Read-only review projection; scanning must not replace an open draft or
      // write an intake. Reuse cached recovery evidence without another AI call.
      const product=p.product;if(!product||typeof product!=='object')return {};
      const model=NudgeNativeReview.model({kind:'product',product},state,{today:today()});
      const catalogueScore=NudgeFoodDetailModel.cachedScore(product),calculated=product.scoreResult?.catalogueCalculatedAt;
      const recovered=project('productRating',{product,catalogueScore,catalogueCalculatedAt:calculated});
      return recovered.score?{...model,score:recovered.score}:model;
    }

    if(operation==='recipes')return {recipes:NudgeRecipeCatalogue.all({includeDrafts:true})};
    if(operation==='recipe'){const r=NudgeRecipeCatalogue.byId(p.id),servings=Number.isInteger(p.servings)?Math.max(1,Math.min(12,p.servings)):1;return r?{...r,nutrients:NudgeRecipeCatalogue.nutrition(r),score:NudgeRecipeCatalogue.score(r),servings,steps:NudgeRecipeCatalogue.stepsFor(r,servings),safety:NudgeSearchModel.safety(NudgeSearchModel.normalize(r,{kind:'recipe'}),{...state.nutritionProfile,avoidMilk:state.avoidMilk===true}),favourite:(state.foodLog.savedRecipes||[]).includes(r.id)}:{};}
    if(operation==='productWithCatalogueScore'){
      // Native has validated source freshness, snapshot and classifier version.
      // Bind that detailed catalogue result to the same fingerprint as recovery.
      const product=p.product,m=NudgeFoodDetailModel,result=p.score;
      const held=m.isCatalogueQualityHold(result,product);
      if(!product||result?.catalogueQualityHold&&!held||!held&&(!Number.isFinite(p.expiresAt)||p.expiresAt<=Date.now())||m.catalogueEvidenceExpiry(result)<=Date.now()||!['rated','provisional','estimated','estimated_provisional','unrated'].includes(result?.status)||!m.validScoreResult(result))return {};
      return {product:{...product,scoreResult:{methodId:result.methodId,version:result.version,
        inputFingerprint:m.scoreFingerprint(product),result,checkedAt:nativeNow(),catalogueValidated:true,catalogueExpiresAt:Math.min(p.expiresAt,m.catalogueEvidenceExpiry(result)),catalogueCalculatedAt:Number.isFinite(p.calculatedAt)?p.calculatedAt:null}}};
    }
    if(operation==='productRating'){
      // Search and detail resolve the same evidence cache. This is a read-only
      // projection: no AI, intake edits or copying estimates into label values.
      const product=p.product,m=NudgeFoodDetailModel,catalogue=window.NudgeFoodCatalogue;
      if(!product||typeof product!=='object')return {};
      if(m.isCatalogueQualityHold(p.catalogueScore,product))return {score:p.catalogueScore};
      const cache=catalogue?.get(product);if(!cache||cache.result.status==='unrated'&&!cache.recovery?.estimate?.score?.available)return {};
      const prepared=p.catalogueScore,addsFacts=cache.recovery?.status==='verified'&&cache.recovery?.addedFields?.length>0;
      if(!addsFacts&&['rated','provisional','estimated','estimated_provisional','unrated'].includes(prepared?.status)&&m.validScoreResult(prepared)){
        const checked=Number.isSafeInteger(cache.catalogueCalculatedAt)?cache.catalogueCalculatedAt:Date.parse(cache.checkedAt||'');
        if(cache.result.status==='unrated'||Number.isFinite(p.catalogueCalculatedAt)&&checked<=p.catalogueCalculatedAt)return {};
      }
      let resolved=product;
      if(cache.recovery?.status==='verified'&&cache.recovery.product){
        resolved=catalogue.mergeRecovery(product,cache.recovery);if(!resolved)return {};
      }
      const scoreResult={...cache,inputFingerprint:m.scoreFingerprint(resolved)};
      return {score:m.score({...resolved,scoreResult})};
    }
    if(operation==='productRecovery'){
      const product=review.product,m=NudgeFoodDetailModel,catalogue=window.NudgeFoodCatalogue;
      if(!product||review.entryId||review.confirmed)return {};
      const fingerprint=m.scoreFingerprint(product),embedded=m.cachedScore(product)?product.scoreResult:null,durable=catalogue?.get(product),present=m.score(product);
      if(m.isCatalogueQualityCheck(embedded?.result,product))return {fingerprint,confirmationId:review.confirmationId,facts:m.scoreFacts(product),cache:embedded,canApplyCache:false,needsRecovery:false,blockedByQualityCheck:true};
      if(embedded?.catalogueValidated===true&&m.isCatalogueQualityHold(embedded.result,product))return {fingerprint,confirmationId:review.confirmationId,facts:m.scoreFacts(product),cache:embedded,canApplyCache:false,needsRecovery:false,blockedByQualityHold:true};
      const quality=c=>!c?-1:c.result.status!=='unrated'?2:c.recovery?.estimate?.score?.available?1:0;
      const addsVerifiedFacts=durable?.recovery?.status==='verified'&&durable.recovery.addedFields?.length>0&&Boolean(catalogue?.mergeRecovery(product,durable.recovery));
      const published=c=>Number.isFinite(c?.catalogueCalculatedAt)?c.catalogueCalculatedAt:Date.parse(c?.checkedAt||'');
      const preparedWins=embedded?.catalogueValidated===true&&!addsVerifiedFacts&&Number.isFinite(embedded.catalogueCalculatedAt)&&published(durable)<=embedded.catalogueCalculatedAt;
      const cached=durable&&!preparedWins&&(addsVerifiedFacts||!embedded||quality(durable)>quality(embedded)||quality(durable)===quality(embedded)&&published(durable)>published(embedded))?durable:embedded;
      return {fingerprint,confirmationId:review.confirmationId,facts:m.scoreFacts(product),cache:cached||null,canApplyCache:Boolean(cached&&!(cached===embedded&&embedded.catalogueValidated===true)&&(cached.result.status!=='unrated'||catalogue?.freshIncomplete(cached))),needsRecovery:!(['rated','estimated'].includes(present.status)||present.scoreBasis==='provider_nutriscore_2023')&&!(cached&&(cached.result.status!=='unrated'||catalogue?.freshIncomplete(cached)))&&catalogue?.canRecover(product)!==false};
    }
    return {};
  }
  function equalSavedValue(a,b){
    if(a===b)return true;
    if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a);
    return keys.length===Object.keys(b).length&&keys.every(key=>Object.prototype.hasOwnProperty.call(b,key)&&equalSavedValue(a[key],b[key]));
  }
  function addCaptureToEaten(p){
    if(!history.isSaved())return 'saveFailed';
    const row=history.find(p.eventID),owner=p.ownerKey;
    if(!row||!Number.isSafeInteger(p.generation)||p.generation<0||!history.isCurrent(p.eventID,p.generation)||typeof owner!=='string'||!(owner==='local-guest'||/^[a-f0-9]{64}$/.test(owner))||row.captureOwnerKey!==owner||row.addToEaten!==true||row.diaryAddState==='cancelled')return 'cancelled';
    const claims=state.captureIntakeClaims;
    if(claims!==undefined&&(!claims||typeof claims!=='object'||Array.isArray(claims)))return 'needsReview';
    const claim=claims&&Object.prototype.hasOwnProperty.call(claims,p.eventID)?claims[p.eventID]:null;
    if(claim){
      if(claim.ownerKey!==owner||claim.generation!==p.generation||typeof claim.entryID!=='string')return 'cancelled';
      return state.foodLog.entries.some(entry=>entry.id===claim.entryID)?'alreadyAdded':'cancelled';
    }
    // Old archived links remain provenance after diary removal. They must never
    // let a delayed result recreate food which the user has already deleted.
    if(row.entryId)return state.foodLog.entries.some(entry=>entry.id===row.entryId)?'alreadyAdded':'cancelled';
    const prior=state.foodLog.entries.find(entry=>entry.sourceMeta?.scanEventId===row.id||entry.sourceMeta?.productScanEventId===row.id);
    if(prior)return 'alreadyAdded';
    if(row.diaryAddState==='added')return 'cancelled';
    if(row.status!=='ready'||(!row.product&&!row.extraction))return 'needsReview';
    const repairing=row.repairEntryId&&state.foodLog.entries.find(entry=>entry.id===row.repairEntryId);
    if(row.repairEntryId&&(!repairing||!row.repairEntrySnapshot||!equalSavedValue(repairing,row.repairEntrySnapshot)))return 'needsReview';
    const confirmationId='capture-eaten:'+row.id;
    if(confirmationId.length>100||!row.loggingDay)return 'needsReview';
    const input={kind:row.extraction?'analysis':'product',extraction:row.extraction,product:row.product,eventId:row.id,confirmationId,
      day:row.loggingDay,slot:row.loggingMeal||'',photos:row.photos||[],thumbnail:row.thumbnail||'',
      ...(repairing?{entryId:repairing.id,previousProduct:row.repairProduct,previousReview:{product:row.repairProduct,draft:{portion:row.repairPortion}}}:{} )};
    const prepared=NudgeNativeReview.record(input,state,{today:today(),now:nativeNow()});
    if(!prepared.ok){message=prepared.error||'Check this food before adding it to eaten.';return 'needsReview';}
    // The claim and intake share one durable file acknowledgement. If the app
    // closes before outbox completion, retry can distinguish saved from deleted
    // intake without another History write or a second portion.
    const entryID=prepared.record.id;
    state.captureIntakeClaims={...(claims||{}),[row.id]:{ownerKey:owner,generation:p.generation,entryID}};
    const outcome=repairing?diary().update(repairing.id,prepared.record):diary().add(prepared.record);
    if(!outcome.ok){if(claims===undefined)delete state.captureIntakeClaims;else state.captureIntakeClaims=claims;message='This food could not be added to eaten. Your earlier diary is unchanged.';return 'saveFailed';}
    if(!outcome.changed&&!save()){
      if(claims===undefined)delete state.captureIntakeClaims;else state.captureIntakeClaims=claims;
      return 'saveFailed';
    }
    return 'added';
  }
  function removeCaptureIntakeIfAdded(p){
    const row=history.find(p.eventID);
    if(!row||!Number.isSafeInteger(p.generation)||p.generation<0||!history.isCurrent(p.eventID,p.generation)||typeof p.ownerKey!=='string'||!p.ownerKey||row.captureOwnerKey!==p.ownerKey)return false;
    if(row.repairEntryId)return true;
    const claims=state.captureIntakeClaims,claim=claims&&Object.prototype.hasOwnProperty.call(claims,p.eventID)?claims[p.eventID]:null;
    if(!claim||claim.ownerKey!==p.ownerKey||claim.generation!==p.generation)return true;
    const entry=state.foodLog.entries.find(value=>value.id===claim.entryID);
    // Cancelling a stale pending row means deleting its own newly-added food.
    // Never touch an unrelated replacement or a pre-existing repaired intake.
    if(!entry||entry.sourceMeta?.scanEventId!==row.id)return true;
    return diary().remove(entry.id).ok;
  }
  function perform(operation,p={},incremental=false,nativeHistory=false){
    const previousChanges=changedStores,previousValues=acknowledgedValues,previousReview=review;changedStores=new Set();acknowledgedValues=new Map();
    try {
    message='';if(readFailed)return {ok:false,...snapshot(null,undefined,nativeHistory)};let ok=true;
    if(operation==='profileSave'){
      const raw=p.profile||{},clean=NudgeNutrition.clean(raw),invalid=['age','weight','height','sessions','target','calorieTarget','carbTarget','fatTarget','dailyPlantTarget','fibreTarget','weeklyPlantTarget'].find(k=>raw[k]!=null&&clean[k]===null);
      if(invalid){ok=false;message='Check '+invalid+'. Use the displayed range or leave it unset.';}
      else {const previous=state.nutritionProfile,plantGoal=state.foodLog.plantGoal,next=NudgeNutrition.saveDraft(clean,previous,today());state.nutritionProfile=next;if(next.weeklyPlantTarget!==null)state.foodLog.plantGoal=next.weeklyPlantTarget;ok=save();if(!ok){state.nutritionProfile=previous;state.foodLog.plantGoal=plantGoal;}}
    }
    else if(operation==='cycleSave'){const raw=p.cycle||{};if(raw.start&&(NudgeCycle.dateNumber(raw.start)===null||raw.start>today())||raw.length!=null&&(!Number.isInteger(raw.length)||raw.length<21||raw.length>45)){message='Check the period date and cycle length.';ok=false;}else ok=commitField('cycleSupport',NudgeCycle.clean(raw));}
    else if(operation==='cycleCheckin'){if(p.day!==today()){ok=false;message='It is a new day. Check today’s answers before saving.';}else if(!state.cycleSupport?.enabled){ok=false;message='Turn on cycle support before saving a check-in.';}else{const c=NudgeCycle.clean(state.cycleSupport),answers=NudgeCycle.checkValues(p.answers);c.checkins=c.checkins.filter(x=>x.day!==p.day);if(Object.keys(answers).length)c.checkins.push({day:p.day,...answers});ok=commitField('cycleSupport',NudgeCycle.clean(c));}}
    else if(operation==='settingsSave'){const previous=clone(state);if(typeof p.motionEnabled==='boolean')state.motionEnabled=p.motionEnabled;if(typeof p.avoidMilk==='boolean')state.avoidMilk=p.avoidMilk;if(['food','move','sleep','unwind'].includes(p.focus))state.focus=p.focus;if(Number.isInteger(p.goal)&&p.goal>=1&&p.goal<=7)state.goal=p.goal;ok=save();if(!ok)state=previous;}
    else if(operation==='diaryDelete'||operation==='diaryRemove'){
      // Intake is authoritative in this one atomic store. Archived source links
      // remain provenance; projections join only entries which still exist.
      // No whole-History write, confirmation, Undo or success toast is needed.
      ok=diary().remove(p.entryId).ok;
    }
    else if(operation==='captureRemoveIntake')ok=removeCaptureIntakeIfAdded(p);
    else if(operation==='captureAddToEaten'){
      const status=addCaptureToEaten(p);
      return {ok:status!=='saveFailed',status,...snapshot(incremental===true?changedStores:null,previousReview,nativeHistory)};
    }
    else if(operation==='historyDelete')ok=history.nativeDelete(p.id,p.keepIntake);
    else if(operation==='historyToggleFavourite')ok=toggleHistoryFavourite(p.id);
    else if(operation==='historyInterruptPending')ok=history.interruptPending(p.resumableIDs);
    else if(operation==='historyUndo')ok=history.undoDelete();
    else if(operation==='historyRetry') {history.handleAction('history-save');ok=history.isSaved();}
    else if(operation==='historyDismissUndo'){history.handleAction('history-dismiss-undo');ok=history.isSaved();}
    else if(operation==='foodsRename'){
      const food=projectedFoods().find(food=>food.id===p.id);
      ok=food?.legacyProduct?typeof p.name==='string'&&Boolean(p.name.trim())&&repertoire.saveDraft({...food.draft,name:p.name.trim().slice(0,100)},{sourceKey:food.sourceKey,thumbnail:food.image}):repertoire.rename(p.id,p.name);
    }
    else if(operation==='foodsDelete')ok=removeFoods([p.id]);
    else if(operation==='foodsToggleProduct')ok=toggleProductFavourite(p.product);
    else if(operation==='foodsSaveEntry'){const e=state.foodLog.entries.find(e=>e.id===p.entryId);ok=Boolean(e&&repertoire.saveEntry(e));}
    else if(operation==='setReview'){
      review=NudgeNativeReview.prepare(clone(p),state,{today:today()});
      if(p.previousReview&&review.product&&review.eventId&&!history.isDeleted(review.eventId))history.record({id:review.eventId,kind:'product',status:'ready',name:review.product.name,barcode:review.product.barcode||'',thumbnail:review.thumbnail||review.product.imageURL||'',product:review.product});
    }
    else if(operation==='reviewRecall'){
      if(review.product&&(review.product.barcode||'')===p.barcode&&(review.product.name||'')===p.name&&(review.product.brand||'')===p.brand)review={...review,product:{...review.product,recallAssessment:clone(p.assessment)}};
    }
    else if(operation==='productRecoveryApply'){
      const m=NudgeFoodDetailModel,catalogue=window.NudgeFoodCatalogue,original=review.product;
      const publication=p.calculatedAt??(p.cacheReplay===true?p.catalogueCalculatedAt:null);
      const currentPublication=original&&m.cachedScore(original)?original.scoreResult?.catalogueCalculatedAt:null;
      // An asynchronous result can enrich only the exact unconfirmed product.
      if(!original||m.isCatalogueQualityHold(m.cachedScore(original),original)||m.isCatalogueQualityCheck(m.cachedScore(original),original)||p.result?.catalogueQualityHold||review.entryId||review.confirmed||review.confirmationId!==p.confirmationId||m.scoreFingerprint(original)!==p.fingerprint||!m.validScoreResult(p.result)||m.catalogueEvidenceExpiry(p.result)<=Date.now()||(Number.isSafeInteger(publication)&&Number.isSafeInteger(currentPublication)&&publication<currentPublication)){ok=false;}
      else {
        let product=clone(original),result=p.result,recovery=catalogue?.cleanRecovery(p.recovery)||null;
        if(recovery?.status==='verified'&&recovery.product){const merged=catalogue.mergeRecovery(product,recovery);if(merged)product=merged;else {result=m.calculatedScore(product);recovery=null;}}
        const fingerprint=m.scoreFingerprint(product),cache={inputFingerprint:fingerprint,methodId:result.methodId,version:result.version,result,checkedAt:p.checkedAt||nativeNow(),...(Number.isSafeInteger(publication)&&publication>0&&publication<=Date.now()+60000?{catalogueCalculatedAt:publication}:{}),...(recovery?{recovery}:{})};
        if(!m.validScoreResult(result)){ok=false;}else{
          if(p.cacheReplay!==true){
            catalogue?.put(product,cache);
            if(fingerprint!==p.fingerprint)catalogue?.put(original,{...cache,inputFingerprint:p.fingerprint});
          }
          review={...review,product:{...product,scoreResult:cache}};
          if(review.eventId&&!history.isDeleted(review.eventId))history.record({id:review.eventId,product:review.product});
        }
      }
    }
    else if(operation==='productRecoveryFailed'){
      if(review.product&&!review.entryId&&review.confirmationId===p.confirmationId&&NudgeFoodDetailModel.scoreFingerprint(review.product)===p.fingerprint)window.NudgeFoodCatalogue?.attempted(review.product,{failed:true});
    }
    else if(operation==='reviewUpdate')review=NudgeNativeReview.update(review,p,state,{today:today()});
    else if(operation==='reviewConfirm'||operation==='reviewSaveFood'){
      const result=NudgeNativeReview.record(review,state,{today:today(),now:nativeNow()});
      if(!result.ok){message=result.error||'Check this food and amount before adding it.';ok=false;}
      else if(operation==='reviewSaveFood'){
        const saved=review.savedFoodId&&projectedFoods().find(food=>food.id===review.savedFoodId);
        ok=repertoire.saveDraft(result.record,{sourceKey:saved?.legacyProduct?saved.sourceKey:review.savedFoodId?'saved:'+review.savedFoodId:review.eventId?'analysis:'+review.eventId:'draft:'+review.confirmationId,sourceKeys:result.entryId?['entry:'+result.entryId]:[],thumbnail:review.thumbnail||NudgeProductEvidence.publicProductImage(review.product)});
      }
      else {const existing=result.entryId&&state.foodLog.entries.find(e=>e.id===result.entryId);const outcome=existing?diary().update(result.entryId,result.record):result.entryId?{ok:false,status:'missing'}:diary().add(result.record);ok=outcome.ok;if(ok){if(result.eventId)history.link(result.eventId,outcome.entry.id);review={...review,entryId:outcome.entry.id,confirmed:true,entry:outcome.entry};message=(existing?'Updated food for ':'Added to ')+dayLabel(outcome.entry.day)+'.';}else message='Your diary could not be updated. Please try again.';}
    }
    else if(operation==='recordHistory'){ok=Boolean(history.record(p)&&history.isSaved());}
    else if(operation==='recordScannedProducts'){
      const product=p.product;
      ok=Boolean(product&&typeof product.name==='string'&&product.name.trim()&&typeof product.barcode==='string'&&Array.isArray(p.eventIDs)&&p.eventIDs.length<=500&&p.eventIDs.every(id=>history.find(id)?.barcode===product.barcode)&&
        history.recordMany(p.eventIDs.map(id=>({id,kind:'product',status:'ready',name:product.name,barcode:product.barcode,product,processingState:'complete',errorCode:'',message:'',nextAttemptAt:''}))));
    }
    else if(operation==='openSaved'){const food=projectedFoods().find(f=>f.id===p.id);if(food){
      if(food.legacyProduct)review=NudgeNativeReview.prepare({kind:'product',product:clone(food.legacyProduct),savedFoodId:food.id,thumbnail:food.image,confirmationId:p.confirmationId,day:p.day||today(),slot:p.slot},state,{today:today()});
      else {repertoire.open(p.id);review=NudgeNativeReview.prepare({kind:'entry',entry:clone(view.foodDraft),savedFoodId:food.id,thumbnail:food.image,confirmationId:p.confirmationId,day:p.day||today(),slot:p.slot},state,{today:today()});}
    }else ok=false;}
    else if(operation==='openRecent'){const entry=state.foodLog.entries.find(e=>e.id===p.entryId);if(entry){const row=historyItem({entryId:entry.id}).row;review=NudgeNativeReview.prepare({kind:'entry',entry:clone(entry),confirmationId:p.confirmationId,day:p.day||today(),slot:p.slot,thumbnail:entry.sourceMeta?.entryThumbnail||row?.thumbnail||row?.imageURL||''},state,{today:today()});}else ok=false;}
    else if(operation==='recipeLog'){const r=NudgeRecipeCatalogue.byId(p.id);if(r)review=NudgeNativeReview.prepare({kind:'entry',entry:NudgeRecipeCatalogue.intakeDraft(r,p.day||today()),confirmationId:p.confirmationId,day:p.day||today(),slot:p.slot},state,{today:today()});else ok=false;}
    else if(operation==='recipeFavourite'){const old=clone(state.foodLog),ids=old.savedRecipes||[];state.foodLog={...old,savedRecipes:ids.includes(p.id)?ids.filter(id=>id!==p.id):ids.concat(p.id)};ok=save();if(!ok)state.foodLog=old;}
    else ok=false;
    return {ok,...snapshot(incremental===true?changedStores:null,previousReview,nativeHistory)};
    } finally { changedStores=previousChanges;acknowledgedValues=previousValues; }
  }
  return {init,project,perform,snapshot};
})();
