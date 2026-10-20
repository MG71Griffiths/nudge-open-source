/* Confirmed-intake commands. No DOM, network, clocks or storage globals.
 * The adapter owns the existing schema and durable save acknowledgement.
 * History's persisted delete/undo journal remains responsible for coordinating
 * its separate store; remove/restore are safe to replay after interruption. */
(function(root){
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const validId=id=>typeof id==='string'&&id.length>0&&id.length<=100;
  const confirmation=entry=>typeof entry?.sourceMeta?.confirmationId==='string'&&entry.sourceMeta.confirmationId||null;
  function create({getState,save,cleanEntry}){
    if(typeof getState!=='function'||typeof save!=='function'||typeof cleanEntry!=='function')throw new TypeError('Diary requires state, persistence and entry-validation adapters.');
    let writing=false;
    const result=(ok,status,entry=null,changed=false)=>({ok,status,entry,changed});
    function current(){const log=getState()?.foodLog;return log&&Array.isArray(log.entries)?log:null;}
    function prepare(raw,id=raw?.id){
      if(!validId(id)||!raw||typeof raw!=='object'||Array.isArray(raw)||raw.id!==undefined&&raw.id!==id)return null;
      try{const entry=cleanEntry({...clone(raw),id});return entry&&entry.id===id?entry:null;}catch{return null;}
    }
    const duplicate=(entries,entry,exceptId=null)=>entries.find(other=>other.id!==exceptId&&(other.id===entry.id||confirmation(entry)&&confirmation(other)===confirmation(entry)));
    function commit(log,next,entry){
      if(writing)return result(false,'busy');
      const previous=log.entries;writing=true;log.entries=next;
      try{
        const acknowledgement=save();
        // A Promise is not a durable acknowledgement for this synchronous API.
        if(acknowledgement===false||acknowledgement&&typeof acknowledgement.then==='function')throw new Error('Diary save not acknowledged');
        return result(true,'saved',entry,true);
      }catch{log.entries=previous;return result(false,'save_failed');}
      finally{writing=false;}
    }
    function add(raw){
      const log=current(),entry=prepare(raw);if(!log||!entry)return result(false,'invalid');
      const existing=duplicate(log.entries,entry);if(existing)return result(false,'duplicate',existing);
      return commit(log,log.entries.concat(entry),entry);
    }
    function update(id,raw){
      const log=current();if(!log||!validId(id))return result(false,'invalid');
      const existing=log.entries.find(entry=>entry.id===id);if(!existing)return result(false,'missing');
      const entry=prepare(raw,id);if(!entry)return result(false,'invalid');
      const conflict=duplicate(log.entries,entry,id);if(conflict)return result(false,'duplicate',conflict);
      if(same(existing,entry))return result(true,'unchanged',existing);
      return commit(log,log.entries.map(other=>other.id===id?entry:other),entry);
    }
    function remove(id){
      const log=current();if(!log||!validId(id))return result(false,'invalid');
      const existing=log.entries.find(entry=>entry.id===id);if(!existing)return result(true,'unchanged');
      return commit(log,log.entries.filter(entry=>entry.id!==id),existing);
    }
    function restore(raw){
      const log=current(),entry=prepare(raw);if(!log||!entry)return result(false,'invalid');
      const existing=log.entries.find(other=>other.id===entry.id);
      if(existing)return same(existing,entry)?result(true,'unchanged',existing):result(false,'conflict',existing);
      const conflict=duplicate(log.entries,entry);if(conflict)return result(false,'duplicate',conflict);
      return commit(log,log.entries.concat(entry),entry);
    }
    return Object.freeze({add,update,remove,restore});
  }
  const api=Object.freeze({create});if(root)root.NudgeDiary=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window==='object'?window:null);
