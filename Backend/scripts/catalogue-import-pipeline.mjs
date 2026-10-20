// Bounded upload window. Completed work behind an earlier pending batch still
// occupies a slot, so a slow request cannot accumulate an unbounded checkpoint gap.
export class CatalogueImportPipeline {
  constructor({concurrency=1,upload,onAcknowledged=()=>{},onCommit=async()=>{},onFailure=async()=>{}}) {
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw new Error('Import concurrency must be 1, 2 or 3.');
    this.concurrency=concurrency;this.upload=upload;this.onAcknowledged=onAcknowledged;
    this.onCommit=onCommit;this.onFailure=onFailure;this.window=[];this.failure=null;this.finalError=null;
  }
  throwIfFailed(){if(this.failure)throw this.failure;}
  async submit(batch){
    this.throwIfFailed();
    while(this.window.length>=this.concurrency){await this.advance();this.throwIfFailed();}
    this.window.push({batch:Object.freeze({...batch,codes:Object.freeze([...batch.codes])}),state:'waiting'});
    this.startReady();
  }
  startReady(){
    if(this.failure)return;
    for(let i=0;i<this.window.length;i++){
      const entry=this.window[i];if(entry.state!=='waiting')continue;
      // Equal-revision source rows are last-write-wins in the database. Never
      // let a later batch containing the same barcode overtake an earlier one.
      const codes=new Set(entry.batch.codes);
      if(this.window.slice(0,i).some(earlier=>['waiting','running'].includes(earlier.state)&&earlier.batch.codes.some(code=>codes.has(code))))continue;
      entry.state='running';
      entry.promise=(async()=>{
        try{entry.result=await this.upload(entry.batch);this.onAcknowledged(entry.batch,entry.result);entry.state='success';}
        catch(error){entry.error=error;entry.state='failed';this.failure ||= error;}
        this.startReady();
      })();
    }
  }
  async commitReady(){
    while(this.window[0]?.state==='success'){
      const entry=this.window[0];await this.onCommit(entry.batch,entry.result);this.window.shift();
    }
    this.startReady();
  }
  async advance(){
    await this.commitReady();
    if(this.failure||this.window.length<this.concurrency)return;
    const running=this.window.filter(entry=>entry.state==='running');
    if(running.length)await Promise.race(running.map(entry=>entry.promise));
    await this.commitReady();
  }
  async finish(){
    if(this.finalError)throw this.finalError;
    while(this.window.length){
      if(this.failure){
        // Do not abort an already sent write: its outcome could be ambiguous.
        // Settle the bounded in-flight set, then retain the earliest failed body.
        await Promise.all(this.window.filter(entry=>entry.state==='running').map(entry=>entry.promise));
        await this.commitReady();
        const failed=this.window.find(entry=>entry.state==='failed');
        this.finalError=failed?.error||this.failure;
        if(failed)await this.onFailure(failed.batch,this.finalError);
        throw this.finalError;
      }
      await this.commitReady();
      const running=this.window.filter(entry=>entry.state==='running');
      if(running.length)await Promise.race(running.map(entry=>entry.promise));
    }
  }
}
