// Bounded importer transport. Responses can identify a server condition, never
// supply arbitrary text for a CI log or expose the administration credential.
const safeCodes=new Set(['catalogue_storage_limit','catalogue_unavailable','catalogue_request_invalid','catalogue_record_invalid','catalogue_not_uk','catalogue_admin_not_configured','authentication_required','upload_invalid','upload_too_large','server_unavailable']);
export class CatalogueUploadError extends Error {
  constructor(status=null,code='catalogue_upload_network'){
    super(status===null?'Catalogue upload network failure; validated batches remain on disk for resume.':`Catalogue upload failed: HTTP ${status} (${code}).`);
    this.status=status;this.code=code;
  }
}
async function responseValue(response){
 const reader=response.body?.getReader();if(!reader)return null;
 const chunks=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>8192){await reader.cancel();return null;}chunks.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{return null;}
}
export async function uploadCatalogueBatch(url,token,body,{fetchImpl=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 let failure=new CatalogueUploadError();
 for(let attempt=0;attempt<4;attempt++){
  let response;
  try{response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json','user-agent':'Nudge/0.1 (official food catalogue import)',authorization:'Bearer '+token},body,redirect:'error',signal:AbortSignal.timeout(60_000)});}
  catch{failure=new CatalogueUploadError();}
  if(response){
   const value=await responseValue(response);
   if(response.ok){
    if(!value||!Number.isSafeInteger(value.accepted)||value.accepted<0)throw new CatalogueUploadError(response.status,'catalogue_upload_response_invalid');
    return value;
   }
   const code=safeCodes.has(value?.code)?value.code:'catalogue_upload_unavailable';
   failure=new CatalogueUploadError(response.status,code);
   // A confirmed capacity limit needs operational action, not four immediate
   // writes. Do not mislabel the source record as malformed or skip it.
   if(code==='catalogue_storage_limit'||![429,500,502,503,504].includes(response.status))throw failure;
  }
  if(attempt===3)throw failure;
  await sleep(1000*2**attempt);
 }
}
