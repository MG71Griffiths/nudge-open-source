// Technical events only. Never attach messages, stacks, food names, photos,
// transcripts, cycle dates, profile details or URLs to a support record.
window.NudgeDiagnostics = (() => {
  'use strict';
  const stages={storage:['saved','save_failed','quota_exceeded','storage_unavailable','parse_failed','recovered'],nutrition:['calculated','incomplete'],navigation:['opened'],lifecycle:['started','foregrounded','backgrounded'],ui_error:['unhandled_error','promise_rejection','render_failed']};
  const screens=new Set('today history food rhythm together you ai meal review camera profile meal-scan meal-prompt meal-result food-week chocolate nudge-progress food-patterns food-entry barcode label-photo recipes search recipe-detail cacao rewards food-context food-fit meal-capture connections settings account cycle cycle-settings cycle-checkin unknown'.split(' '));
  const enums={store:['main','history','catalogue','repertoire','preferences','unknown'],operation:['read','write','remove','import','restore','render','calculate'],errorClass:['quota','security','serialization','invalid_json','invalid_shape','native_write','unknown']};
  const numbers=new Set('payloadBytes storedBytes entryCount imageBytes componentCount matchedComponentCount missingAmountCount plantCount knownNutrientCount missingNutrientCount partialNutrientCount zeroNutrientCount'.split(' '));
  const recent=new Map();
  function record(stage,outcome,metadata={}){
    if(!stages[stage]?.includes(outcome))return false;
    const safe={};
    for(const [key,value] of Object.entries(metadata)){
      if(enums[key]?.includes(value)||(['screen','fromScreen','toScreen'].includes(key)&&screens.has(value)))safe[key]=value;
      else if(numbers.has(key)&&Number.isSafeInteger(value)&&value>=0&&value<=50000000)safe[key]=value;
      else if(['durable','online','includesVoiceMemo'].includes(key)&&typeof value==='boolean')safe[key]=value;
    }
    const fingerprint=JSON.stringify([stage,outcome,safe]),now=Date.now();
    // Rerenders may recalculate the same diary repeatedly. Keep the first event,
    // not hundreds of identical events that evict the actual failure.
    if(now-(recent.get(fingerprint)||0)<10000)return false;
    if(recent.size>=100)recent.delete(recent.keys().next().value);
    recent.set(fingerprint,now);
    try{window.webkit?.messageHandlers?.nudgeBarcode?.postMessage({action:'app-diagnostic',stage,outcome,metadata:safe});return true;}catch{return false;}
  }
  window.addEventListener('error',()=>record('ui_error','unhandled_error'));
  window.addEventListener('unhandledrejection',()=>record('ui_error','promise_rejection'));
  document.addEventListener('visibilitychange',()=>record('lifecycle',document.hidden?'backgrounded':'foregrounded',{online:navigator.onLine===true}));
  record('lifecycle','started',{online:navigator.onLine===true});
  return {record};
})();
