// Scan events are deliberately separate from consumed meals and recipe favourites.
window.createNudgeHistory=function({getState,view,escapeHtml:esc,todayKey,render,navigate,showToast,save=()=>false,showDialog=()=>{},closeDialog=()=>{},recipeBy=()=>null}){
  const key='nudge-scan-history-v1',thumbnailLimit=49152,thumbnailBudget=1048576;
  const diaryStore=window.NudgeDiary.create({getState,save,cleanEntry:raw=>window.WmdFoodLog.clean({entries:[raw]}).entries[0]});
  const text=(v,n=160)=>typeof v==='string'?v.slice(0,n):'';
  const thumbnail=v=>typeof v==='string'&&v.length<=thumbnailLimit&&/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(v)?v:'';
  const privateSnapshotKeys=['__proto__','constructor','prototype','photos','images','imageBase64','base64','imageData','photo','thumbnail'];
  // Swift's Data encoding is base64. Keep this one bounded, validated JSON
  // payload intact; applying the generic string limit silently corrupts it.
  // JavaScriptCore has no browser atob/TextDecoder, so decode without either.
  function catalogueRating(value){
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const encoded=value.scoreData,alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    if(typeof encoded!=='string'||!encoded.length||encoded.length>43692||encoded.length%4!==0
      ||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))return null;
    const byteLength=encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
    if(byteLength>32768)return null;
    let escaped='';
    for(let i=0;i<encoded.length;i+=4){
      const a=alphabet.indexOf(encoded[i]),b=alphabet.indexOf(encoded[i+1]),c=alphabet.indexOf(encoded[i+2]),d=alphabet.indexOf(encoded[i+3]);
      if(c<0&&(b&15)!==0||d<0&&c>=0&&(c&3)!==0)return null;
      const bytes=[(a<<2)|(b>>4),...(c>=0?[((b&15)<<4)|(c>>2)]:[]),...(d>=0?[((c&3)<<6)|d]:[])];
      escaped+=bytes.map(n=>'%'+n.toString(16).padStart(2,'0')).join('');
    }
    let result;try{result=JSON.parse(decodeURIComponent(escaped));}catch{return null;}
    const safeResult=(v,depth=0)=>{
      if(depth>16)return false;
      if(v===null||typeof v==='boolean')return true;
      if(typeof v==='number')return Number.isFinite(v);
      if(typeof v==='string')return v.length<=6000&&!/^data:|^[A-Za-z0-9+/]{10000}/.test(v);
      if(Array.isArray(v))return v.length<=100&&v.every(x=>safeResult(x,depth+1));
      return Boolean(v&&typeof v==='object'&&Object.keys(v).length<=100&&Object.entries(v).every(([k,x])=>!privateSnapshotKeys.includes(k)&&safeResult(x,depth+1)));
    };
    if(!safeResult(result)||!(window.NudgeScoreCore?.validResult(result)||window.NudgeMealScore?.validResult(result)||window.NudgeFoodDetailModel?.validScoreResult(result)))return null;
    if(!['method','version','classifierVersion'].every(k=>typeof value[k]==='string'&&value[k].length>0&&value[k].length<=100)
      ||!['fetchedAt','expiresAt','calculatedAt'].every(k=>typeof value[k]==='number'&&Number.isFinite(value[k])&&value[k]>=0)
      ||value.expiresAt<=value.fetchedAt||value.calculatedAt<value.fetchedAt
      ||typeof value.snapshotFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.snapshotFingerprint)
      ||value.sourceRevision!=null&&(!Number.isSafeInteger(value.sourceRevision)||value.sourceRevision<0))return null;
    return Object.fromEntries(['method','version','classifierVersion','sourceRevision','fetchedAt','expiresAt','calculatedAt','snapshotFingerprint','scoreData','qualityHoldOrigin'].filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
  }
  // Explicitly omit upload bodies and full-resolution photo fields from snapshots.
  function safe(value,depth=0){
    if(depth>9)return null;
    if(value===null||typeof value==='boolean')return value;
    if(typeof value==='number')return Number.isFinite(value)?value:null;
    if(typeof value==='string')return /^data:|^[A-Za-z0-9+/]{10000}/.test(value)?'':value.slice(0,6000);
    if(Array.isArray(value))return value.slice(0,100).map(x=>safe(x,depth+1));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!privateSnapshotKeys.includes(k)).slice(0,100).flatMap(([k,v])=>{
      if(k==='catalogueRating'){const rating=catalogueRating(v);return rating?[[k,rating]]:[];}
      return [[k,safe(v,depth+1)]];
    }));
    return null;
  }
  let records=[],favourites=[],favouriteProducts=[],deleted=new Set(),generations={},undo=null,storageError=false,readError=false,operationError=false,filter='all',confirming='',openActions=null;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const isDeleted=id=>typeof id==='string'&&deleted.has(id);
  const isEntryDeleted=id=>Boolean(id)&&isDeleted('diary:'+id);
  const generation=id=>Number.isSafeInteger(generations[id])?generations[id]:0;
  const isCurrent=(id,value)=>!isDeleted(id)&&generation(id)===value;
  function closeActions(except=null){if(openActions&&openActions!==except){openActions.scrollLeft=0;openActions=null;}}
  // Keep browser scrolling native. Only coordinate revealed rows; a full swipe
  // never mutates data and an open row tap only dismisses its actions.
  document.addEventListener?.('scroll',event=>{const row=event.target;if(row?.classList?.contains('n-history-swipe')){if(row.scrollLeft>4){closeActions(row);openActions=row;}else if(openActions===row)openActions=null;}else closeActions();},true);
  document.addEventListener?.('pointerdown',event=>{if(openActions&&!openActions.contains(event.target))closeActions();},true);
  document.addEventListener?.('click',event=>{const button=event.target.closest?.('[data-action="history-open"]'),row=button?.closest('.n-history-swipe');if(row?.scrollLeft>4){event.preventDefault();event.stopImmediatePropagation();row.scrollLeft=0;openActions=null;}else if(openActions&&!openActions.contains(event.target))closeActions();},true);
  function repairContext(item){
    const entryId=text(item.repairEntryId,120),product=item.repairProduct&&typeof item.repairProduct==='object'&&!Array.isArray(item.repairProduct)?safe(item.repairProduct):null;
    const raw=item.repairPortion,model=window.NudgeFoodDetailModel;
    let portion=null;
    if(product&&model&&raw&&typeof raw==='object'&&typeof raw.canonicalAmount==='number'&&Number.isFinite(raw.canonicalAmount)&&raw.canonicalAmount>0&&raw.canonicalAmount<=5000&&['g','ml'].includes(raw.unit)){
      portion=model.portionRecord(product,model.createPortion(product,safe(raw)));
    }
    return {...(entryId?{repairEntryId:entryId}:{}),...(item.repairEntrySnapshot&&typeof item.repairEntrySnapshot==='object'?{repairEntrySnapshot:clone(item.repairEntrySnapshot)}:{}),...(product?{repairProduct:product}:{}),...(portion?{repairPortion:portion}:{})};
  }
  function loggingDestination(item){
    const day=typeof item.loggingDay==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(item.loggingDay)&&window.WmdStreakMath.dayNumber(item.loggingDay)!==null?item.loggingDay:'';
    const meal=['Breakfast','Lunch','Dinner','Snack'].includes(item.loggingMeal)?item.loggingMeal:'';
    return {...(day?{loggingDay:day}:{}),...(meal?{loggingMeal:meal}:{})};
  }
  function clean(item){if(!item||typeof item.id!=='string'||!item.id||!Number.isFinite(Date.parse(item.createdAt)))return null;const ready=item.status==='ready'&&Boolean(item.product&&typeof item.product==='object'&&!Array.isArray(item.product)&&Object.keys(item.product).length||item.extraction&&typeof item.extraction==='object'&&(item.extraction.type==='meal'&&item.extraction.meal||item.extraction.type!=='unknown'&&item.extraction.nutrients));return {id:text(item.id,120),...loggingDestination(item),...repairContext(item),...(item.origin==='search'?{origin:'search'}:{}),kind:['product','meal','unknown'].includes(item.kind)?item.kind:'unknown',status:['pending','ready','unknown','failed'].includes(item.status)?item.status:'unknown',...(item.captureOwnerKey!==undefined?{captureOwnerKey:text(item.captureOwnerKey,80)}:{}),...(item.captureID!==undefined?{captureID:text(item.captureID,40)}:{}),...(typeof item.addToEaten==='boolean'?{addToEaten:item.addToEaten}:{}),...(['pending','added','needsReview','cancelled'].includes(item.diaryAddState)?{diaryAddState:item.diaryAddState}:{}),...(item.processingState!==undefined?{processingState:text(item.processingState,30)}:{}),...(item.nextAttemptAt!==undefined?{nextAttemptAt:text(item.nextAttemptAt,40)}:{}),createdAt:item.createdAt,updatedAt:text(item.updatedAt,40)||item.createdAt,barcode:text(item.barcode,30),name:text(item.name),message:ready?'':text(item.message,500),errorCode:!ready&&typeof item.errorCode==='string'&&/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(item.errorCode)?item.errorCode:'',thumbnail:thumbnail(item.thumbnail),...((window.WmdFoodLog?.photoReferences?.(item.photos)||[]).length?{photos:(window.WmdFoodLog?.photoReferences?.(item.photos)||[])}:{}),photoCount:Math.max(0,Math.min(4,Number(item.photoCount)||0)),product:item.product?safe(item.product):null,extraction:item.extraction?safe(item.extraction):null,entryId:text(item.entryId,120),analysisVersions:Array.isArray(item.analysisVersions)?item.analysisVersions.filter(v=>v&&typeof v==='object').map(v=>({analysisId:text(v.analysisId,160),savedAt:text(v.savedAt,40),product:v.product?safe(v.product):null,extraction:v.extraction?safe(v.extraction):null})):[]};}
  try{const raw=JSON.parse((window.NudgeStorage||localStorage).getItem(key)||'null');if(raw){if(!Array.isArray(raw.events))throw Error('Invalid history');records=raw.events.map(clean).filter(Boolean);favourites=Array.isArray(raw.favourites)?raw.favourites.filter(x=>typeof x==='string').slice(0,5000):[];favouriteProducts=Array.isArray(raw.favouriteProducts)?raw.favouriteProducts.filter(x=>x&&favourites.includes(x.key)&&x.product&&typeof x.product==='object').slice(0,5000).map(x=>({key:text(x.key,220),product:safe(x.product)})):[];deleted=new Set(Array.isArray(raw.deleted)?raw.deleted.filter(x=>typeof x==='string'&&x.length<=126):[]);generations=Object.fromEntries(Object.entries(raw.generations||{}).filter(([id,value])=>id.length<=126&&!['__proto__','constructor','prototype'].includes(id)&&Number.isSafeInteger(value)&&value>=0));if(raw.undo&&['deleted','remove','restore'].includes(raw.undo.phase)&&Array.isArray(raw.undo.ids)&&Array.isArray(raw.undo.events)){const entry=raw.undo.entry?window.WmdFoodLog.clean({entries:[raw.undo.entry]}).entries[0]:null;undo={phase:raw.undo.phase,name:text(raw.undo.name),ids:raw.undo.ids.filter(x=>typeof x==='string'&&deleted.has(x)),events:raw.undo.events.map(clean).filter(Boolean),entry:entry||null,links:Array.isArray(raw.undo.links)?raw.undo.links.filter(x=>x&&typeof x.id==='string'&&typeof x.entryId==='string'):[]};}}}catch{readError=true;storageError=true;}
  const find=id=>isDeleted(id)?undefined:records.find(x=>x.id===id);
  function persist(){
    // Bound images while preserving every event and its source result.
    let budget=0;for(const row of [...records].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))){budget+=row.thumbnail.length;if(budget>thumbnailBudget)row.thumbnail='';}
    try{if(readError)throw Error('Unreadable stored history');const serial=JSON.stringify({version:3,events:records,favourites,...(favouriteProducts.length?{favouriteProducts}:{}),deleted:[...deleted],generations,undo});if(serial.length>(window.NudgeStorage?.native?24:4)*1024*1024)throw Error('History storage full');(window.NudgeStorage||localStorage).setItem(key,serial);storageError=false;return true;}catch{storageError=true;showToast('History could not be saved. Keep this result open and try saving again. Your earlier saved history is unchanged.');return false;}
  }
  function record(input){
    if(!input?.id||isDeleted(text(input.id,120))||input.generation!==undefined&&!isCurrent(input.id,input.generation))return null;
    const previous=find(input.id),next=updatedRecord(input,previous,new Date().toISOString());
    if(!next)return null;if(previous)records[records.indexOf(previous)]=next;else records.push(next);persist();return next;
  }
  // JSON object member order is not evidence. Swift dictionary bridging may
  // reorder nested keys on every callback; arrays and all actual values remain
  // significant, including unknown/null versus a reported zero.
  function sameEvidence(a,b){
    if(a===b)return true;
    if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
    if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>sameEvidence(value,b[index]));
    const keys=Object.keys(a);
    return keys.length===Object.keys(b).length&&keys.every(key=>Object.prototype.hasOwnProperty.call(b,key)&&sameEvidence(a[key],b[key]));
  }
  function updatedRecord(input,previous,now){
    const model=window.NudgeFoodDetailModel;
    // A repeated catalogue callback must not discard a same-evidence cached result.
    if(previous?.product?.scoreResult&&input.product&&!input.product.scoreResult&&model?.scoreFingerprint(previous.product)===model?.scoreFingerprint(input.product))input={...input,product:{...input.product,scoreResult:previous.product.scoreResult}};
    const evidenceChanged=Boolean(previous?.extraction&&input.extraction&&!sameEvidence(previous.extraction,safe(input.extraction)));
    const productChanged=Boolean(previous?.product&&input.product&&!sameEvidence(previous.product,safe(input.product)));
    const versions=previous?.analysisVersions||[];
    const analysisVersions=evidenceChanged||productChanged?[...versions,{analysisId:previous.extraction?.analysisId||previous.product?.analysisId||'',savedAt:previous.updatedAt,product:previous.product,extraction:previous.extraction}]:versions;
    return clean({...previous,...input,analysisVersions,createdAt:previous?.createdAt||input.createdAt||now,updatedAt:now});
  }
  // Repeated queued scans can share a lookup, but retain every observation.
  // Validate all identities before one atomic write; failure restores all rows.
  function recordMany(inputs){
    if(!Array.isArray(inputs)||!inputs.length||inputs.length>500)return false;
    const ids=new Set(),updates=new Map(),now=new Date().toISOString(),byID=new Map();
    for(const row of records)byID.set(row.id,byID.has(row.id)?null:row);
    for(const input of inputs){
      if(typeof input?.id!=='string'||!input.id||input.id.length>120||ids.has(input.id)||isDeleted(input.id)||input.generation!==undefined&&!isCurrent(input.id,input.generation))return false;
      const previous=byID.get(input.id);if(!previous)return false;
      const next=updatedRecord(input,previous,now);if(!next)return false;
      ids.add(input.id);updates.set(input.id,next);
    }
    const before=records;
    // persist bounds thumbnail bytes in place, so its rollback copy must own
    // each row. The full source objects remain immutable and need no deep copy.
    records=records.map(row=>updates.get(row.id)||{...row});
    if(persist())return true;
    records=before;return false;
  }
  function interruptedRow(row){return clean({...row,status:'failed',updatedAt:new Date().toISOString(),errorCode:'analysis_interrupted',message:row.photos?.length?'Analysis was interrupted when Nudge closed or this scan was removed. Open this item to retry using the saved photos.':'Analysis was interrupted. Scan or photograph the food again to retry.'});}
  function interruptPending(resumableIDs=[]){
    const durable=new Set(Array.isArray(resumableIDs)?resumableIDs:[]);
    if(!records.some(row=>row.status==='pending'&&!durable.has(row.id)&&!isDeleted(row.id)))return true;
    const previous=records;
    records=records.map(row=>row.status==='pending'&&!durable.has(row.id)&&!isDeleted(row.id)?interruptedRow(row):row);
    if(persist())return true;
    records=previous;return false;
  }
  function link(id,entryId){if(isEntryDeleted(entryId))return;const item=find(id);if(item){item.entryId=entryId;persist();}}
  function unlink(id,entryId){const item=find(id);if(item&&item.entryId===entryId){item.entryId='';persist();}}
  const favouriteKey=p=>p?.barcode?'barcode:'+p.barcode:p?.identityKey?'identity:'+p.identityKey:'product:'+text(p?.brand,80)+'|'+text(p?.name);
  const isFavourite=p=>favourites.includes(favouriteKey(p));
  function toggleFavourite(p){const id=favouriteKey(p),before=favourites,beforeProducts=favouriteProducts,removing=isFavourite(p);favourites=removing?favourites.filter(x=>x!==id):favourites.concat(id);favouriteProducts=favouriteProducts.filter(x=>x.key!==id);if(!removing)favouriteProducts.push({key:id,product:safe(p)});if(!persist()){favourites=before;favouriteProducts=beforeProducts;}render();}
  const diary=()=>getState().foodLog?.entries||[];
  const linked=row=>diary().find(e=>e.id===row.entryId)||diary().find(e=>(e.sourceMeta?.productScanEventId||e.sourceMeta?.scanEventId||e.sourceMeta?.confirmationId)===row.id);
  const sourceForEntry=e=>find(e.sourceMeta?.productScanEventId||e.sourceMeta?.scanEventId||e.sourceMeta?.confirmationId)||records.find(row=>!isDeleted(row.id)&&row.entryId===e.id);
  const diet=window.createNudgeDiet?.({getEntries:diary,getState,productForEntry:entry=>sourceForEntry(entry)?.product||{},mealForEntry:entry=>sourceForEntry(entry)?.extraction?.meal||{},todayKey,escapeHtml:esc,render,
    imageFor(entry){const source=sourceForEntry(entry),image=window.NudgeResults?.productImage?.(source?.product,source?.thumbnail)||{src:source?.thumbnail||'',fallback:''},recipe=recipeBy(entry.recipe);return image.src?image:{src:thumbnail(entry.sourceMeta?.repertoireImage)||window.NudgeResults?.productImageURL?.(entry.sourceMeta?.repertoireImage)||(recipe?.image?'/assets/'+recipe.image:''),fallback:''};},
    openEntry(entry){const source=sourceForEntry(entry);view.resultOrigin='history';
      if(entry.sourceMeta?.entryKind==='product-consumption'&&source?.product){window.NudgeBarcode?.openStored(source,{entryId:entry.id});return;}
      if(source?.extraction?.type==='meal'){window.NudgeLabel?.openStored(source);return;}
      // A History-only deletion can retain intake. It remains accessible in Diet,
      // while its deleted scan stays tombstoned and cannot be resurrected.
      view.foodDraft=clone(entry);view.historyReturn=true;navigate('food-entry');
    }});
  // Category and consumption are independent: the same confirmed food can be
  // Scanned/Photos and Eaten, but its scan and intake must not make two All rows.
  function category(row){
    const e=row.entry,meta=e?.sourceMeta;
    if(meta?.entryKind==='saved-food')return '';
    if(row.origin==='search'||String(row.id||meta?.productScanEventId||meta?.scanEventId||'').startsWith('search-product:')||String(meta?.productScanEventId||meta?.scanEventId||'').startsWith('search-product:'))return '';
    if(row.kind==='product'||row.barcode||row.extraction?.type==='product'||meta?.entryKind==='product-consumption'||['nutrition','ingredients','both'].includes(meta?.labelKind)&&meta?.nutritionEstimate!=='photo')return 'scanned';
    if(!row.legacy||meta?.nutritionEstimate==='photo'||/meal photo/i.test(meta?.provider||e?.source||''))return 'photos';
    return '';
  }
  function historyEntryVisible(entry){
    if(!isEntryDeleted(entry.id))return true;
    // Older history-only deletions also tombstoned the linked diary ID. Project
    // retained intake in Eaten/All without restoring the deleted source event.
    const sourceID=entry.sourceMeta?.productScanEventId||entry.sourceMeta?.scanEventId||entry.sourceMeta?.confirmationId;
    return Boolean(sourceID&&isDeleted(sourceID)&&!(undo?.entry?.id===entry.id&&undo.phase!=='restore'));
  }
  function entryObservationTime(entry){
    const meta=entry.sourceMeta||{},candidates=meta.entryKind==='product-consumption'?[meta.consumedAt]:meta.nutritionEstimate==='photo'||/meal photo/i.test(meta.provider||entry.source||'')?[meta.retrievedAt,meta.consumedAt]:[meta.consumedAt];
    return candidates.find(value=>typeof value==='string'&&Number.isFinite(Date.parse(value)))||entry.day+'T12:00:00';
  }
  function rowDay(row){
    if(row.intakeDay)return row.entry.day;
    const date=new Date(row.createdAt);
    return window.WmdStreakMath.localDayKey?window.WmdStreakMath.localDayKey(date):`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }
  function items(day=null){
    const seen=new Set(),confirmations=new Set(),entries=diary().filter(entry=>{
      if(!historyEntryVisible(entry)||seen.has(entry.id))return false;
      const confirmation=entry.sourceMeta?.confirmationId;
      if(confirmation&&confirmations.has(confirmation))return false;
      seen.add(entry.id);if(confirmation)confirmations.add(confirmation);return true;
    });
    seen.clear();
    // Rebuild local indices for each projection so edits, Undo and tombstones
    // cannot leave stale links. Retain the first-record semantics of find().
    const byID=new Map(),byEntryID=new Map();
    for(const row of records){
      if(isDeleted(row.id))continue;
      if(!byID.has(row.id))byID.set(row.id,row);
      if(!byEntryID.has(row.entryId))byEntryID.set(row.entryId,row);
    }
    const sources=new Map(),candidatesByID=new Map();
    for(const entry of entries){
      const meta=entry.sourceMeta,source=byID.get(meta?.productScanEventId||meta?.scanEventId||meta?.confirmationId)||byEntryID.get(entry.id);
      sources.set(entry,source);
      if(source){if(!candidatesByID.has(source.id))candidatesByID.set(source.id,[]);candidatesByID.get(source.id).push(entry);}
    }
    const events=Array.from(byID.values(),row=>{
      const candidates=candidatesByID.get(row.id)||[],entry=candidates.find(entry=>entry.id===row.entryId)||candidates[0];
      if(entry)seen.add(entry.id);
      return {...row,entryId:entry?.id||'',entry,category:category({...row,entry})};
    });
    for(const e of entries){
      if(seen.has(e.id))continue;
      const source=sources.get(e);
      const row={...(source?{product:source.product,extraction:source.extraction,thumbnail:source.thumbnail}:{}),id:'diary:'+e.id,kind:'meal',status:'ready',name:e.name,createdAt:entryObservationTime(e),entry:e,legacy:true};
      row.category=category(row);events.push(row);
    }
    return events.filter(row=>(filter==='all'||filter==='diet'||filter==='eaten'&&row.entry||row.category===filter)&&(filter!=='eaten'||!day||row.entry?.day===day)).map(row=>filter==='eaten'?{...row,intakeDay:true,createdAt:Number.isFinite(Date.parse(row.entry.sourceMeta?.consumedAt))?row.entry.sourceMeta.consumedAt:row.entry.day+'T12:00:00'}:row).sort((a,b)=>filter==='eaten'&&a.entry.day!==b.entry.day?b.entry.day.localeCompare(a.entry.day):Date.parse(b.createdAt)-Date.parse(a.createdAt));
  }
  function reopen(id){
    if(isDeleted(id)&&!id.startsWith('diary:'))return;
    if(id.startsWith('diary:')){const e=diary().find(x=>x.id===id.slice(6));if(e&&historyEntryVisible(e)){const event=e.sourceMeta?.entryKind==='product-consumption'?find(e.sourceMeta.productScanEventId||e.sourceMeta.scanEventId):null;if(event?.product){view.resultOrigin='history';window.NudgeBarcode?.openStored(event,{entryId:e.id});return;}view.foodDraft=JSON.parse(JSON.stringify(e));view.historyReturn=true;navigate('food-entry');}return;}
    const item=find(id);if(!item)return;view.resultOrigin='history';
    if(item.kind==='product'||item.barcode){const entry=items().find(row=>row.id===id)?.entry;window.NudgeBarcode?.openStored(item,entry?.sourceMeta?.entryKind==='product-consumption'?{entryId:entry.id}:undefined);return;}
    window.NudgeLabel?.openStored(item);
  }
  // A small persisted journal bridges the independent History and intake stores. A
  // crash or full disk between writes can be retried without losing or doubling food.
  function finishOperation(){
    if(!undo||undo.phase==='deleted'){operationError=false;return true;}
    const op=undo;
    if(op.entry){
      const result=op.phase==='remove'?diaryStore.remove(op.entry.id):diaryStore.restore(op.entry);
      if(!result.ok){operationError=true;showToast(['conflict','duplicate'].includes(result.status)?'This meal has changed. Undo will not overwrite it.':'Intake could not be updated. Try again or Undo.');return false;}
    }
    if(op.phase==='remove'){
      op.phase='deleted';operationError=false;return persist();
    }
    const oldRecords=records,oldDeleted=deleted;
    // Delete revoked the in-flight generation. Undo keeps the source photos,
    // but cannot revive a network task which may already have finished.
    records=records.concat(op.events.filter(e=>!records.some(row=>row.id===e.id)).map(row=>row.status==='pending'?interruptedRow(row):row));
    for(const link of op.links){const row=records.find(e=>e.id===link.id);if(row&&!row.entryId)row.entryId=link.entryId;}
    deleted=new Set([...deleted].filter(id=>!op.ids.includes(id)));undo=null;
    if(!persist()){records=oldRecords;deleted=oldDeleted;undo=op;operationError=true;return false;}
    operationError=false;return true;
  }
  function requestDelete(id){
    if(undo&&undo.phase!=='deleted'){showToast('Finish or undo the previous deletion first.');return;}
    const row=items().find(x=>x.id===id);if(!row)return;
    closeActions();confirming=id;const name=row.entry?.name||row.name||row.product?.name||'this item',logged=row.entry;
    const onDay=logged?new Date(logged.day+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'long'}):'';
    const otherIntake=diary().some(e=>(e.sourceMeta?.productScanEventId||e.sourceMeta?.scanEventId)===id);
    const joined=Boolean(logged&&!row.legacy);
    const title=logged?'Delete this logged meal?':'Delete this scan?';
    const detail=logged?joined?`<p>${esc(name)} is logged on ${esc(onDay)}. Choose whether to keep its intake. If kept, its eaten entry stays in History and your totals.</p>`:`<p>This removes ${esc(name)} from intake on ${esc(onDay)}.${row.product?' The original product scan stays in History.':''}</p>`:`<p>${esc(name)} will be removed from History.${otherIntake?' Its logged portions will stay in your intake.':' Your intake will not change.'}</p>`;
    showDialog(title,detail+`${joined?'<button class="button secondary" data-action="history-delete-only">Delete history only</button>':''}<button class="button history-destructive" data-action="history-delete-confirm">${joined?'Delete history and intake':logged?'Delete meal':'Delete scan'}</button>`,{closeLabel:'Cancel',focusClose:true});
  }
  function deleteConfirmed(keepIntake=false){
    const row=items().find(x=>x.id===confirming);if(!row)return false;
    const before={records,deleted,generations,undo},entry=row.entry;
    const ids=[row.id];if(entry&&!row.legacy)ids.push('diary:'+entry.id);
    const events=row.legacy?[]:records.filter(x=>x.id===row.id);
    const links=entry&&!keepIntake?records.filter(x=>x.entryId===entry.id&&!events.includes(x)).map(x=>({id:x.id,entryId:x.entryId})):[];
    undo={phase:entry&&!keepIntake?'remove':'deleted',name:entry?.name||row.name||row.product?.name||'Item',ids,events:clone(events).map(e=>e.status==='pending'?interruptedRow(e):e),entry:entry&&!keepIntake?clone(entry):null,links};
    records=records.filter(x=>!events.includes(x)).map(x=>links.some(link=>link.id===x.id)?{...x,entryId:''}:x);
    deleted=new Set([...deleted,...ids]);
    generations={...generations,...Object.fromEntries(ids.map(id=>[id,generation(id)+1]))};
    if(!persist()){records=before.records;deleted=before.deleted;generations=before.generations;undo=before.undo;render();return false;}
    for(const id of ids){window.NudgeLabel?.invalidate?.(id);window.NudgeBarcode?.invalidate?.(id);}
    confirming='';closeDialog();const completed=finishOperation();render();
    if(completed)showToast(keepIntake?'Scan deleted. Eaten food kept. Undo is available in History.':'Deleted. Undo is available in History.');
    document.getElementById('history-undo')?.focus?.();return completed;
  }
  function undoDelete(){
    if(!undo)return false;
    const oldPhase=undo.phase;undo.phase='restore';
    if(!persist()){undo.phase=oldPhase;render();return false;}
    const completed=finishOperation();render();if(completed)showToast('Restored to History.');return completed;
  }
  function deletionNotice(){return undo?`<div class="n-history-undo" role="status" aria-live="polite"><span>${operationError?'Deletion needs another try.':undo.phase==='restore'?'Restoring your item…':undo.phase==='remove'?'Finishing deletion…':`Deleted ${esc(undo.name)}.`}</span><button id="history-undo" data-action="history-undo">Undo</button>${operationError||undo.phase!=='deleted'?'<button data-action="history-save">Try again</button>':'<button class="n-history-dismiss" data-action="history-dismiss-undo" aria-label="Dismiss Undo">×</button>'}</div>`:'';}
  function reviewMeal(row){
    const meal=row.extraction?.meal;
    if(row.entry||row.status!=='ready')return meal;
    const originalScore=meal?.scoreSnapshot,input=window.NudgeFrequency?.legacy(originalScore)?{...meal,scoreSnapshot:null}:meal;
    const recovered=window.NudgeMealRecovery?.recover?.(input)||window.NudgeComposition?.proposeMeal?.(input)||input;
    return originalScore?{...recovered,scoreSnapshot:originalScore}:recovered;
  }
  function rowScore(row,meal=reviewMeal(row)){
    if(!row.entry&&(row.status!=='ready'||row.kind==='unknown'))return null;
    const meta=row.entry?.sourceMeta,model=window.NudgeFoodDetailModel;
    const valid=score=>Boolean(window.NudgeScoreCore?.validResult(score)||window.NudgeMealScore?.validResult(score)||window.NudgeFrequency?.legacy(score));
    let score,kind,saved=false;
    if(row.entry){
      const context={entries:diary(),profile:getState().nutritionProfile||{},avoidMilk:getState().avoidMilk,productForEntry:entry=>sourceForEntry(entry)?.product||{},mealForEntry:entry=>sourceForEntry(entry)?.extraction?.meal||{}};
      const resolved=window.NudgeDiet?.scoreResultForEntry(row.entry,context),stored=[meta?.scoreMethod,meta?.mealScore].find(valid);
      score=window.NudgeDiet?.scoreResultForEntry?resolved?.score:stored||(meta?.scoreHistory?.length?window.NudgeMealScore?.estimate({name:row.entry.name,ingredients:row.entry.ingredients}):window.NudgeMealScore?.calculate({name:row.entry.name,ingredients:row.entry.ingredients,components:meta?.mealComposition||[],recipeCalculation:meta?.mealRecipeCalculation}));saved=resolved?.saved??Boolean(stored);kind=meta?.scoreMethod?'product':'meal';
      if(saved)score=window.NudgeFrequency?.savedDisplay(score,{...context,entry:row.entry,product:context.productForEntry(row.entry)})||score;
    }
    else if(row.product){score=model?.score(row.product);kind='product';const portion=model?.createPortion(row.product);score=window.NudgeFrequency?.apply(score,{product:row.product,profile:getState().nutritionProfile||{},avoidMilk:getState().avoidMilk,salt:model?.servingConflict(row.product,portion)?null:model?.portionNutrients(row.product,portion).salt})||score;}
    else if(meal){saved=valid(meal.scoreSnapshot);score=saved?meal.scoreSnapshot:window.NudgeMealScore?.calculate(meal);kind='meal';if(!saved)score=window.NudgeFrequency?.apply(score,{product:{ingredientsNeedsReview:true},profile:getState().nutritionProfile||{},avoidMilk:getState().avoidMilk,salt:meal.nutrients?.salt?.value})||score;}
    else if(row.extraction){score=model?.score(window.NudgeProductEvidence?.fromExtraction(row.extraction)||{});kind='product';}
    const value=score?.value,legacy=saved&&(window.NudgeFrequency?.legacy(score)||kind==='product'&&score?.status==='estimated_rough'),rough=!legacy&&score?.status==='estimated_rough';
    if(!Number.isInteger(value)||value<0||value>100||!valid(score))return null;
    if(!legacy&&score.methodId==='nudge_nutrition_v0_4')return {value,qualifier:'Nudge score',tone:window.NudgeScoreCore?.displayTone(value)||'unknown',range:'',frequency:'',label:`Nudge score ${value} out of 100`};
    const version='v'+(score.version||window.NudgeScoreCore?.CONFIG.version||'0.3'),provisional=['provisional','estimated_provisional'].includes(score.status),qualifier=(legacy?'Historical · '+(score.methodId||score.methodVersion):rough?'Rough estimate':provisional?(score.estimated?'estimated · provisional · ':'provisional · ')+version:kind==='meal'||score.estimated?'estimated · '+version:version)+(score.displayRecheckRequired?' · frequency needs recheck':'');
    return {value,qualifier,tone:window.NudgeScoreCore?.displayTone(value)||'unknown',range:'',frequency:legacy?'Historical':rough?'Rough':score.grade?'Grade '+score.grade:'',
      label:`${legacy?'Historical Nudge score':'Nudge nutrition score'} ${value} out of 100, ${qualifier}${score.grade?', grade '+score.grade:''}`};
  }

  function screen(){
    const header=`<h1 class="n-title">Your history</h1><p class="n-subtitle">Every product scan. Every meal.</p><div class="n-segments n-history-tabs" aria-label="History items">${[['all','All'],['scanned','Scanned'],['photos','Photos'],['eaten','Eaten']].map(([value,label])=>`<button data-action="history-filter" data-value="${value}" aria-pressed="${filter===value}">${label}</button>`).join('')}</div>${deletionNotice()}${storageError?'<p class="notice" role="alert">Recent history changes could not be saved. Keep Nudge open and try saving again.</p><button class="button secondary" data-action="history-save">Try saving history</button>':''}`;
    if(filter==='diet')return header+(diet?.screen()||'');
    let group='';const rows=items();return header+`${rows.length?rows.map(row=>{
      const date=new Date(row.createdAt),day=rowDay(row);
      const yesterday=window.WmdStreakMath.dayKey(window.WmdStreakMath.dayNumber(todayKey())-1),title=day===todayKey()?'Today':day===yesterday?'Yesterday':new Date(day+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
      const head=group===day?'':`<div class="n-group-label"><span>${esc(title)}</span><span>${esc(new Date(day+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'long'}))}</span></div>`;group=day;
      const proposed=reviewMeal(row),meal=row.entry||proposed,p=row.product,kind=row.origin==='search'?'Product from search':row.kind==='product'?'Product scan':row.kind==='meal'?'Meal analysis':'Photo analysis',time=(row.legacy||row.intakeDay)&&!row.entry?.sourceMeta?.consumedAt?'Saved meal':date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}),status=row.status==='pending'?'Pending':row.status==='failed'?'Lookup failed · retry available':row.status==='unknown'?'Not identified':row.entry?'Logged':row.kind==='meal'?'Ready to log':'Saved';
      const energy=row.entry?row.entry.energyPerPortion===null?null:row.entry.energyPerPortion*row.entry.portions:meal?.nutrients?.energyKcal?.value;
      const photographedPortion=proposed?.portion,photoCount=row.entry?Number(row.entry.sourceMeta?.photoPortions)*row.entry.portions:1;
      const estimatedAmount=Number.isFinite(photographedPortion?.amount)&&photographedPortion.amount>0&&['g','ml'].includes(photographedPortion.unit)&&Number.isFinite(photoCount)&&photoCount>0?`${Math.round(photographedPortion.amount*photoCount*10)/10} ${photographedPortion.unit} · `:'';
      const quantity=row.entry?.portionAmount&&['g','ml'].includes(row.entry.portionUnit)?`${Math.round(row.entry.portionAmount*row.entry.portions*1000)/1000} ${row.entry.portionUnit} · `:estimatedAmount;const estimate=row.entry?.sourceMeta?.nutritionEstimate==='photo'||row.extraction?.type==='meal'?'estimated · ':'';
      const rating=rowScore(row,proposed),qualifier=rating?.qualifier&&!(rating.qualifier==='estimated'&&estimate)?rating.qualifier+(row.kind==='meal'&&rating.range?' '+rating.range:'')+' · ':'';
      const finding=window.NudgeResults?.finding(p);
      const note=row.kind==='product'?(row.entry?`${quantity}${qualifier}${status}`:finding?`${rating?.qualifier==='Rough estimate'?qualifier:''}${finding}`:`${qualifier}${status}`):`${quantity}${typeof energy==='number'?Math.round(energy)+' kcal · ':''}${rating?.qualifier?.startsWith('estimated')?'':estimate}${qualifier}${status.toLowerCase()}`;
      const recipeImage=recipeBy(row.entry?.recipe)?.image,image=window.NudgeResults?.productImage?.(p,row.thumbnail)||{src:row.thumbnail||window.NudgeResults?.imageURL?.(p?.imageURL||p?.imageUrl||p?.imageFrontURL),fallback:''},url=image.src||thumbnail(row.entry?.sourceMeta?.repertoireImage)||window.NudgeResults?.productImageURL?.(row.entry?.sourceMeta?.repertoireImage)||(recipeImage?'/assets/'+recipeImage:'');
      const thumb=url?`<img class="n-history-photo" src="${esc(url)}"${image.fallback?` data-nudge-fallback="${esc(image.fallback)}"`:''} alt="" loading="lazy">`:`<span class="n-meal-thumb">${window.NudgeIcons?.(row.kind==='product'?'scan-barcode':'utensils')||'·'}</span>`;
      const badge=`<span class="n-score n-score-${rating?.tone||'unknown'}" aria-label="${rating?esc(rating.label):'Score unavailable'}">${rating?rating.value+'<small>/100</small><small>'+esc(rating.frequency)+'</small>':'—'}</span>`;
      return `${head}<div class="n-history-swipe" role="group" aria-label="${esc(row.entry?.name||row.name||p?.name||'History item')}"><button class="n-history-item" data-action="history-open" data-value="${esc(row.id)}">${thumb}<span><span class="n-type">${window.NudgeIcons?.(row.kind==='product'?'scan-barcode':'camera')||''}${esc(kind)} · ${esc(time)}</span><span class="n-item-title">${esc(row.entry?.name||row.name||p?.name||meal?.name||(row.barcode?'Barcode '+row.barcode:'Your food'))}${row.entry?'<span class="n-eaten-badge">✓ Eaten</span>':''}</span><span class="n-item-note">${esc(note)}</span></span>${badge}</button><button class="n-history-delete" data-action="history-delete" data-value="${esc(row.id)}" aria-label="Delete ${esc(row.entry?.name||row.name||p?.name||'this history item')}">Delete</button></div>`;
    }).join(''):filter==='eaten'?'<div class="food-empty"><h2>No food added yet.</h2><p>Confirm what you eat to add it here and to your daily totals.</p><button class="button primary" data-action="scan-food">Add food</button></div>':'<div class="food-empty"><h2>Your history starts here.</h2><p>Scans and photos appear here. Add food to today when you eat it.</p><button class="button primary" data-action="scan-food">Scan food</button></div>'}`;
  }
  function handleAction(action,value){
    if(diet?.handleAction(action,value))return true;
    if(action==='history-open'){reopen(value);return true;}
    if(action==='history-filter'){const next=({product:'scanned',meal:'photos'})[value]||value;if(['all','scanned','photos','eaten','diet'].includes(next)){closeActions();filter=next;render();}return true;}
    if(action==='history-delete'){requestDelete(value);return true;}
    if(action==='history-delete-confirm'||action==='history-delete-only'){deleteConfirmed(action==='history-delete-only');return true;}
    if(action==='history-undo'){undoDelete();return true;}
    if(action==='history-dismiss-undo'){if(undo?.phase==='deleted'){const old=undo;undo=null;if(!persist())undo=old;render();}return true;}
    if(action==='history-save'){if(persist())finishOperation();render();return true;}
    return false;
  }
  function clear(){try{(window.NudgeStorage||localStorage).removeItem(key);records=[];favourites=[];favouriteProducts=[];deleted=new Set();generations={};undo=null;confirming='';closeActions();operationError=false;storageError=false;readError=false;filter='all';diet?.reset();return true;}catch{showToast('History could not be cleared on this device. Please try again.');return false;}}
  if(undo&&undo.phase!=='deleted')finishOperation();
  // Search uses the saved catalogue snapshot first, then the latest scan. Keep
  // each historical event untouched when de-duplicating catalogue candidates.
  function productCandidates(options={}){
    // A heart lookup needs only retained favourites, not clones of the archive.
    const include=product=>!options.favouritesOnly||isFavourite(product);
    return [...favouriteProducts.filter(r=>include(r.product)).map(r=>clone(r.product)),...records.filter(r=>r.product&&!isDeleted(r.id)&&include(r.product)).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).map(r=>clone(r.product))];
  }
  // Native presentation consumes the same joined records and deletion journal.
  // No HTML or browser event is needed for these operations.
  function nativeProjection(selected='all',currentProducts={},options={}){
    const previousFilter=filter;
    if(['all','scanned','photos','eaten'].includes(selected))filter=selected;
    const projection={rows:items(options.day).filter(row=>options.id===undefined||row.id===options.id).map(stored=>{
      // Public catalogue refresh is display-only. Logged food retains its exact
      // nutrition and score evidence, and the archived event remains unchanged.
      const current=!stored.entry&&stored.product?.barcode?currentProducts?.[stored.product.barcode]:null;
      const product=current&&current.barcode===stored.product.barcode?{...current,
        retainedPublicImageURL:window.NudgeProductEvidence?.publicProductImage(current)||window.NudgeProductEvidence?.publicProductImage(stored.product)||current.retainedPublicImageURL}:stored.product;
      const row=product===stored.product?stored:{...stored,product};
      const image=window.NudgeResults?.productImage?.(row.product,row.thumbnail),entry=row.entry;
      const recipe=recipeBy(entry?.recipe),imageURL=window.WmdFoodLog?.entryImage?.(entry)||window.WmdFoodLog?.photoReferences?.(row.photos)?.[0]||row.thumbnail||image?.src||entry?.sourceMeta?.repertoireImage||(recipe?.image?'/assets/'+recipe.image:'');
      const quantity=entry?.portionAmount?`${Math.round(entry.portionAmount*entry.portions*10)/10} ${entry.portionUnit}`:'';
      const scoreDisplay=options.deferScores===true?null:rowScore(row);
      const extraction=row.extraction,recovery=Array.isArray(extraction?.metadata?.recovery)?extraction.metadata.recovery:[];
      const needsLabels=options.deferScores!==true&&!scoreDisplay&&extraction?.type==='product'
        &&(extraction.needsClearerPhoto===true||recovery.some(item=>['nutrition','ingredients'].includes(item?.field)));
      const readyNote=needsLabels?text(extraction.message,500)||'Add nutrition and ingredient labels.':'Ready to log';
      const note=[quantity,scoreDisplay?.qualifier,entry?'Logged':row.status==='ready'?readyNote:row.message||row.status].filter(Boolean).join(' · ');
      return {...row,historyDay:rowDay(row),scoreDisplay,...(options.deferScores===true?{scoreDeferred:true}:{}),imageURL,note};
    }),undo:clone(undo),storageError,operationError};
    filter=previousFilter;return projection;
  }
  function nativeDelete(id,keepIntake){confirming=id;return deleteConfirmed(keepIntake===true);}
  return {screen,handleAction,record,recordMany,interruptPending,find,link,unlink,linked,reopen,isDeleted,isEntryDeleted,generation,isCurrent,favouriteKey,isFavourite,toggleFavourite,clear,isSaved:()=>!storageError,items,productCandidates,nativeProjection,nativeDelete,undoDelete,_key:key};
};
