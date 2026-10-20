// Complete public OFF responses are kept separately from compact mobile/index facts.
// The prefix is disjoint from thumbnails and image-warming manifests/leases.
const encoder=new TextEncoder();
export async function archiveOFFSource(bucket,payload,{barcode,fetchedAt,sourceURL}) {
  if(!bucket)return null;
  if(!/^[0-9]{4,18}$/.test(barcode||'')||String(payload?.product?.code)!==barcode
    ||!Number.isSafeInteger(fetchedAt)||fetchedAt<=0||fetchedAt>Date.now()+60000)throw new Error('Invalid OFF archive identity');
  const url=new URL(sourceURL);
  if(url.protocol!=='https:'||url.hostname!=='world.openfoodfacts.org'||url.username||url.password)throw new Error('Invalid OFF archive source');
  const bytes=encoder.encode(JSON.stringify(payload));
  if(bytes.length>2_000_000)throw new Error('OFF archive record exceeds bounded source size');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  const key=`off-source/v1/${barcode}/${hash}.json`;
  await bucket.put(key,bytes,{httpMetadata:{contentType:'application/json'},customMetadata:{barcode,sha256:hash,fetchedAt:String(fetchedAt),sourceURL:url.href}});
  return {key,sha256:hash,bytes:bytes.length,fetchedAt};
}

export async function archiveOFFImport(bucket,body) {
  if(!bucket)return null;
  const text=JSON.stringify(body),bytes=encoder.encode(text);
  if(bytes.length>1_500_000)throw new Error('Import archive exceeds bounded batch size');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  const key=`off-source/imports/v1/${hash}.json`;
  await bucket.put(key,bytes,{httpMetadata:{contentType:'application/json'},customMetadata:{sha256:hash,fetchedAt:String(body.fetchedAt),sourceURL:body.sourceURL}});
  return {key,sha256:hash,bytes:bytes.length};
}
