// Native builds store private records outside the small browser quota. A write
// returns only after native atomic persistence. Browser previews keep localStorage.
window.NudgeStorage = (() => {
  'use strict';
  const stores={'wmd-nudge-prototype-v1':'main','nudge-scan-history-v1':'history','nudge-my-foods-v1':'repertoire','nudge-food-catalogue-v1':'catalogue'};
  const native=window.__nudgePrivateStorage===true;
  const loaded=new Set(),blocked=new Set();
  const classify=e=>e?.name==='QuotaExceededError'||e?.code==='storage_limit'?'quota':e?.name==='SecurityError'?'security':e?.name==='SyntaxError'||['invalid_json','corrupt_store'].includes(e?.code)?'invalid_json':e?.code==='native_write'?'native_write':'unknown';
  function event(key,outcome,operation,value,error){
    // Diagnostics must never turn an acknowledged write into a reported failure.
    try{window.NudgeDiagnostics?.record('storage',outcome,{store:stores[key]||'unknown',operation,durable:native,...(typeof value==='string'&&typeof TextEncoder!=='undefined'?{payloadBytes:new TextEncoder().encode(value).length}:{}),...(error?{errorClass:classify(error)}:{})});}catch{}
  }
  function call(operation,key,value){
    const raw=window.prompt('__NUDGE_PRIVATE_STORAGE_V1__',JSON.stringify({operation,key,...(value===undefined?{}:{value})}));
    let reply;try{reply=JSON.parse(raw);}catch{}
    if(!reply||reply.ok!==true){const error=new Error('Private storage operation failed');error.code=reply?.error||'native_write';throw error;}
    return reply;
  }
  function getItem(key){
    try{
      let value;
      if(native&&stores[key]){
        const current=call('get',key);
        if(current.exists)value=current.value;
        else{
          // Import only once and keep the old browser copy as a recovery source.
          // A tombstone prevents reset data from being imported again.
          const legacy=window.localStorage.getItem(key);
          if(legacy!==null){JSON.parse(legacy);const imported=call('import',key,legacy);value=imported.value;event(key,'recovered','import',value);}
          else value=null;
        }
      }else value=window.localStorage.getItem(key);
      if(value!==null)JSON.parse(value);
      loaded.add(key);blocked.delete(key);return value;
    }catch(error){blocked.add(key);event(key,classify(error)==='invalid_json'?'parse_failed':'storage_unavailable','read',null,error);throw error;}
  }
  function setItem(key,value){
    try{
      if(blocked.has(key))throw Object.assign(new Error('Existing data could not be read'),{code:'corrupt_store'});
      if(native&&stores[key]&&!loaded.has(key))getItem(key);
      JSON.parse(value);
      if(native&&stores[key])call('set',key,value);else window.localStorage.setItem(key,value);
      event(key,'saved','write',value);
    }catch(error){event(key,classify(error)==='quota'?'quota_exceeded':'save_failed','write',value,error);throw error;}
  }
  function removeItem(key){
    try{if(native&&stores[key])call('remove',key);else window.localStorage.removeItem(key);blocked.delete(key);loaded.add(key);event(key,'saved','remove');}
    catch(error){event(key,'save_failed','remove',null,error);throw error;}
  }
  return {getItem,setItem,removeItem,native,classify};
})();
