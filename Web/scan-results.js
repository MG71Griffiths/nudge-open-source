// Display source facts without manufacturing an AI health score or product test evidence.
window.NudgeResults=(()=>{
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon=name=>window.NudgeIcons?.(name)||'';
  const {fromExtraction,sourceComparison,augmentFromLabel,ingredientDetail,imageURL,publicProductImage}=window.NudgeProductEvidence;
  // The native app deliberately blocks remote WebKit requests. Load catalogue
  // photos through its bounded, allowlisted image cache instead; keep source
  // URLs unchanged in saved product evidence and the native camera summary.
  const productImageURL=value=>{
    if(typeof value!=='string'||value.length>2000||!/^https:\/\/images\.openfoodfacts\.(?:org|net)\/[^?#\\\s]+\.(?:jpe?g|png|webp)$/i.test(value)||/\/(?:\.|%2e){1,2}(?:\/|%2f)/i.test(value))return '';
    return window.location?.protocol==='nudge-local:'?'/catalogue-image?url='+encodeURIComponent(value):value;
  };
  const capturedImage=v=>typeof v==='string'&&v.length<=250000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v)?v:'';
  // A catalogue image already belongs to this identified product. Never use a
  // merely similar product or an alternative to illustrate a photographed label.
  const productImage=(p,thumbnail)=>{const library=productImageURL(publicProductImage(p)),photo=capturedImage(thumbnail);return {src:library||photo,fallback:library&&photo?photo:''};};
  const imageFailed=target=>{
    if(target?.tagName!=='IMG'||!target.matches?.('.nf-product-photo,.n-history-photo,.n-meal-product-photo'))return;
    const fallback=capturedImage(target.dataset?.nudgeFallback);
    if(target.dataset)delete target.dataset.nudgeFallback;
    if(fallback&&target.getAttribute('src')!==fallback)target.setAttribute('src',fallback);
    else {target.removeAttribute('src');if(target.style)target.style.visibility='hidden';}
  };
  if(typeof document!=='undefined')document.addEventListener?.('error',event=>imageFailed(event.target),true);
  const grade=p=>window.NudgeFoodDetailModel?.score?window.NudgeFoodDetailModel.score(p).grade:(p?.sourceName==='Open Food Facts'||p?.scoreSource?.provider==='Open Food Facts')&&/^[a-e]$/i.test(p.nutriScoreGrade||'')?p.nutriScoreGrade.toUpperCase():null;
  const preparation=p=>p?.nutritionPreparation==='prepared'?'as prepared':p?.nutritionPreparation==='as_sold'?'as sold':'preparation basis unknown';
  const finding=p=>{if(!p)return '';const s=window.NudgeFoodDetailModel?.score?.(p);return s&&['rated','provisional','estimated','estimated_provisional'].includes(s.status)?s.methodId==='nudge_nutrition_v0_4'?`Nudge score ${s.value}/100 · ${preparation(p)}`:`Nudge ${s.value}/100${s.estimated||s.status.startsWith('estimated')?' · estimated':''}${s.status.includes('provisional')?' · provisional':''} · ${preparation(p)}`:p.ingredients?'Ingredients available · more label data needed':'Nutrition information incomplete';};
  const mascot=()=>'<span class="n-mascot n-small"><img src="/assets/nudge.png" width="78" height="80" alt="Nudge"></span>';
  const saved=()=>`<div class="n-saved">${icon('circle-check')}${window.NudgeHistory?.isSaved()===false?'History not saved · try again':'Saved to history'}</div>`;
  function product(p,options={}){return window.NudgeFoodDetailScreen(p,options);}

  return {product,grade,finding,imageURL,productImageURL,productImage,imageFailed,mascot,saved,fromExtraction,sourceComparison,augmentFromLabel,ingredientDetail,preparation};
})();
