// Private reusable food snapshots. Saving never means eating; each use is reviewed.
window.createNudgeRepertoire=function({getState,view,todayKey,render,navigate,escapeHtml:esc,showToast,showDialog,history}){
  const key='nudge-my-foods-v1',limit=200,budget=2*1024*1024;
  const clone=v=>JSON.parse(JSON.stringify(v));
  const id=()=>`food-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  let records=[],hiddenLegacyFavourites=[],unreadable=false;
  const legacyKeys=values=>[...new Set((Array.isArray(values)?values:[]).filter(v=>typeof v==='string'&&v.length<=220))].slice(0,5000);
  const image=value=>typeof value==='string'&&value.length<=49152&&/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(value)?value:window.NudgeResults?.imageURL?.(value)||'';
  const productSourceImage=p=>window.NudgeProductEvidence?.publicProductImage?.(p)??([p?.imageURL,p?.imageUrl,p?.imageFrontURL].map(image).find(Boolean)||'');
  function displayImage(food){const source=food.image;const recipe=food.draft.sourceMeta?.recipeSnapshot||window.NudgeRecipeCatalogue?.byId?.(food.draft.recipe);return window.NudgeResults?.productImageURL?.(source)||(/^data:image\/jpeg;base64,/.test(source)?source:'')||(recipe?.image&&/^[a-zA-Z0-9_-]+\.(?:webp|png|jpg)$/.test(recipe.image)?'/assets/'+recipe.image:'');}
  function snapshot(raw){
    if(!raw||typeof raw!=='object')return null;
    const clean=window.WmdFoodLog.clean({entries:[{...clone(raw),id:'template',day:todayKey(),portions:raw.portions??1}]}).entries[0];
    if(!clean)return null;
    delete clean.id;
    // Never carry an old consumption identity into another eating occasion.
    if(clean.sourceMeta)for(const field of ['confirmationId','scanEventId','productScanEventId','consumedAt'])delete clean.sourceMeta[field];
    clean.sourceMeta={...clean.sourceMeta,entryKind:'saved-food'};
    return clean;
  }
  function clean(raw){
    if(!raw||typeof raw.id!=='string'||raw.id.length>120||typeof raw.name!=='string'||!raw.name.trim())return null;
    const draft=snapshot(raw.draft);if(!draft)return null;
    return {id:raw.id,name:raw.name.trim().slice(0,100),draft:{...draft,name:raw.name.trim().slice(0,100)},image:image(raw.image),sourceKey:typeof raw.sourceKey==='string'?raw.sourceKey.slice(0,160):'',updatedAt:typeof raw.updatedAt==='string'?raw.updatedAt.slice(0,40):''};
  }
  try{const raw=(window.NudgeStorage||localStorage).getItem(key);if(raw){if(raw.length>budget)throw Error();const parsed=JSON.parse(raw);if(parsed.version!==1||!Array.isArray(parsed.foods))throw Error();records=parsed.foods.slice(0,limit).map(clean).filter(Boolean);hiddenLegacyFavourites=legacyKeys(parsed.hiddenLegacyFavourites);}}catch{unreadable=true;}
  function persist(next,hidden=hiddenLegacyFavourites){
    try{if(unreadable||next.length>limit)throw Error();const json=JSON.stringify({version:1,foods:next,...(hidden.length?{hiddenLegacyFavourites:hidden}:{})});if(json.length>budget)throw Error();(window.NudgeStorage||localStorage).setItem(key,json);records=next;hiddenLegacyFavourites=hidden;return true;}
    catch{showToast('My foods could not be saved. Your diary is unchanged. Keep this food open and try again.');return false;}
  }
  const matchingSources=(sourceKeys=[],repertoireId='')=>records.filter(r=>r.id===repertoireId||sourceKeys.includes(r.sourceKey)||sourceKeys.includes('saved:'+r.id));
  function saveDraft(raw,{sourceKey='',sourceKeys=[],thumbnail=''}={}){
    const draft=snapshot(raw);if(!draft){showToast('Review the food and its portion before saving it.');return false;}
    const existing=matchingSources([sourceKey,...sourceKeys].filter(Boolean))[0];
    const food=clean({id:existing?.id||id(),name:draft.name,draft,image:thumbnail||existing?.image||'',sourceKey:existing?.sourceKey||sourceKey,updatedAt:new Date().toISOString()});
    const next=existing?records.map(r=>r.id===food.id?food:r):[food,...records];
    if(!persist(next))return false;
    showToast(existing?'Updated in My foods.':'Saved to My foods. Add it to your diary whenever you eat it.');render();return true;
  }
  function entryImage(entry){const meta=entry.sourceMeta||{},source=history?.find(meta.productScanEventId||meta.scanEventId||meta.confirmationId);return image(meta.entryThumbnail)||source?.thumbnail||productSourceImage(source?.product)||image(meta.repertoireImage)||'';}
  function saveEntry(entry){const source=entry.sourceMeta?.productScanEventId||entry.sourceMeta?.scanEventId;return saveDraft(entry,{sourceKey:'entry:'+entry.id,sourceKeys:source?['analysis:'+source]:[],thumbnail:entryImage(entry)});}
  function open(foodID){const food=records.find(r=>r.id===foodID);if(!food)return;view.foodDraft={...clone(food.draft),name:food.name,day:todayKey(),slot:'',diaryIntent:'add'};delete view.foodDraft.id;view.foodDraft.repertoireId=food.id;view.foodDraft.sourceMeta={...view.foodDraft.sourceMeta,repertoireId:food.id,repertoireImage:food.image};view.resultOrigin='repertoire';navigate('food-entry');}
  function matches(food,query){const term=window.NudgeSearchModel?.canonical(query)||String(query||'').toLowerCase();const text=window.NudgeSearchModel?.canonical([food.name,food.draft.ingredients?.text,...food.draft.plants].join(' '))||food.name.toLowerCase();return !term||term.split(' ').every(t=>text.includes(t));}
  function markup(query=''){
    const rows=records.filter(r=>matches(r,query));
    const cards=rows.map(r=>{const d=r.draft,n=d.portions,photo=displayImage(r),amount=d.portionAmount?`${Math.round(d.portionAmount*n*10)/10} ${d.portionUnit}`:`${n} portion${n===1?'':'s'}`,energy=typeof d.energyPerPortion==='number'?`${Math.round(d.energyPerPortion*n)} kcal`:'Energy not yet known';return `<article class="card nr-food"><div class="nr-food-heading">${photo?`<img src="${esc(photo)}" alt="" loading="lazy">`:''}<div><h3>${esc(r.name)}</h3><p class="small muted">${esc(amount)}<br>${energy} · ${d.plants.length} named plants</p></div></div><div class="nc-action-row"><button class="button primary" data-action="repertoire-open" data-value="${esc(r.id)}">Add to diary</button><button class="button secondary" data-action="repertoire-manage" data-value="${esc(r.id)}">Edit saved food</button></div></article>`;}).join('');
    return `<section class="nr-library"><h2>My foods</h2><p>Your usual drinks, meals and snacks. Saved portions and nutrition work offline; check the amount each time you eat them.</p>${unreadable?'<p role="alert">Saved foods could not be read. Existing data has been kept.</p>':''}${cards||`<p class="small muted">${records.length?'No saved foods match this search.':'Save your smoothie or a regular meal once, then reuse it here.'}</p>`}<button class="button secondary" data-action="repertoire-history">Add from my food history</button><button class="text-button" data-action="scan-food">Scan or describe another food</button></section>`;
  }
  function recent(){const entries=[...(getState().foodLog?.entries||[])].reverse(),seen=new Set();return entries.filter(e=>{const fingerprint=JSON.stringify([e.name,e.portionAmount,e.portionUnit,e.plants,e.nutritionSnapshot]);if(seen.has(fingerprint))return false;seen.add(fingerprint);return true;}).slice(0,60);}
  function handleAction(action,value){
    if(action==='repertoire-show'){window.NudgeSearch?.showSaved?.();return true;}
    if(action==='repertoire-save-analysis'){const result=window.NudgeLabel?.repertoireDraft?.();if(result)saveDraft(result.draft,{sourceKey:'analysis:'+window.NudgeLabel._state.confirmationId,thumbnail:result.thumbnail});return true;}
    if(action==='repertoire-save-product'){
      const detail=window.NudgeBarcode?.detail?.();if(!detail?.valid){showToast('Check the portion before saving this food.');return true;}
      const p=detail.product,m=window.NudgeFoodDetailModel,values=detail.nutrients,plants=detail.plants,nutritionSnapshot=Object.fromEntries(['energyKcal','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'].map(k=>[k,{per100:['g','ml'].includes(p.basisUnit)?m.value(p,k):null,portion:values[k]??null,unit:k==='energyKcal'?'kcal':'g',per100Status:['g','ml'].includes(p.basisUnit)&&m.value(p,k)!==null?'supplied':'unknown',portionStatus:values[k]===null||values[k]===undefined?'unknown':'calculated'}]));
      saveDraft({name:p.name,brand:p.brand,barcode:p.barcode,day:todayKey(),slot:detail.meal,portions:1,portionAmount:detail.portion.canonicalAmount,portionUnit:detail.portion.unit,plants:plants.names,ferments:[],ingredients:{text:typeof p.ingredients==='string'?p.ingredients:p.ingredients?.text||'',plants:plants.names.map(name=>({name,evidence:name})),needsReview:true},energyPerPortion:values.energyKcal??null,proteinPerPortion:values.protein??null,fibrePerPortion:values.fibre??null,nutritionSnapshot,source:'Saved product portion',sourceMeta:{entryKind:'product-consumption',provider:p.sourceName,url:p.sourceURL,retrievedAt:p.retrievedAt,scoreMethod:detail.score,portionSelection:m.portionRecord(p,detail.portion),plantKnowledge:plants.known?'known':'unknown',labelBasis:p.basisUnit==='ml'?'per100ml':p.basisUnit==='g'?'per100g':'unknown'}},{sourceKey:'product:'+(p.barcode||p.identityKey||p.name),thumbnail:productSourceImage(p)});return true;
    }
    if(action==='repertoire-save-draft'){const d=view.foodDraft;if(d){d.repertoireSaveKey||='draft:'+id();saveDraft(d,{sourceKey:d.repertoireId?'saved:'+d.repertoireId:d.id?'entry:'+d.id:d.recipe?'recipe:'+d.recipe:d.repertoireSaveKey,thumbnail:d.id?entryImage(d):''});}return true;}
    if(action==='repertoire-history'){showDialog('Add to My foods',`<p>Choose a food you have already logged. Saving it here won’t add another eating entry.</p><div class="nr-history">${recent().map(e=>`<button class="button secondary" data-action="repertoire-save-entry" data-value="${esc(e.id)}">${esc(e.name)}<small>${esc(e.day)}</small></button>`).join('')||'<p>No logged foods yet. Scan or describe a food to start your collection.</p>'}</div>`);return true;}
    if(action==='repertoire-save-entry'){const e=getState().foodLog.entries.find(e=>e.id===value);if(e)saveEntry(e);return true;}
    if(action==='repertoire-open'){open(value);return true;}
    if(action==='repertoire-manage'){const food=records.find(r=>r.id===value);if(food)showDialog('Edit saved food',`<label class="form-label" for="repertoire-name">Name</label><input class="field" id="repertoire-name" maxlength="100" value="${esc(food.name)}"><button class="button primary" data-action="repertoire-rename" data-value="${esc(food.id)}">Save name</button><p class="small muted">To change ingredients or nutrition, review a fresh analysis and save it as a new food. Previous diary entries keep their original values.</p><button class="button secondary" data-action="repertoire-remove" data-value="${esc(food.id)}">Remove from My foods</button>`);return true;}
    if(action==='repertoire-rename'){const name=document.getElementById('repertoire-name')?.value.trim().slice(0,100);if(!name){showToast('Give this food a name.');return true;}if(persist(records.map(r=>r.id===value?{...r,name,draft:{...r.draft,name}}:r))){document.getElementById('app-dialog')?.close();render();showToast('Saved food renamed.');}return true;}
    if(action==='repertoire-remove'){if(persist(records.filter(r=>r.id!==value))){document.getElementById('app-dialog')?.close();render();showToast('Removed from My foods. Your diary is unchanged.');}return true;}
    return false;
  }
  const rename=(id,name)=>typeof name==='string'&&name.trim().length>0&&persist(records.map(r=>r.id===id?{...r,name:name.trim().slice(0,100),draft:{...r.draft,name:name.trim().slice(0,100)}}:r));
  return {markup,handleAction,saveDraft,saveEntry,open,rename,snapshotDraft:snapshot,hiddenLegacyFavourites:()=>clone(hiddenLegacyFavourites),matchingSources:(keys,id)=>clone(matchingSources(keys,id)),remove:id=>persist(records.filter(r=>r.id!==id)),removeMany:(ids,legacy=[])=>persist(records.filter(r=>!ids.includes(r.id)),legacyKeys([...hiddenLegacyFavourites,...legacy])),items:()=>clone(records),clear:()=>{try{(window.NudgeStorage||localStorage).removeItem(key);records=[];hiddenLegacyFavourites=[];unreadable=false;return true;}catch{showToast('My foods could not be cleared. Please close and reopen the app, then try again.');return false;}},_key:key};
};
