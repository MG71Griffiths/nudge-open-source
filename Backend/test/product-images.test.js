import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {canonicalProductThumbnail, productThumbnailCandidates, productThumbnailKey, serveProductThumbnail, PRODUCT_IMAGE_MAX_BYTES} from '../src/product-images.js';
import {catalogueImageManifest, catalogueImageSource, importCatalogue} from '../src/catalogue-index.js';
import {catalogueSQLAdapter} from '../src/catalogue-index-object.js';
import {catalogueSchema} from '../src/catalogue-schema.js';
import worker from '../src/worker.js';

const barcode = '5000000000001';
const source = `https://images.openfoodfacts.org/images/products/500/000/000/0001/front_en.7.400.jpg`;
const thumb = source.replace('.400.jpg', '.200.jpg');
const request = (url=source, options={}) => new Request('https://nudge.example/v1/catalogue/image?source=' + encodeURIComponent(url), options);
const jpeg = (width=200, height=150) => Uint8Array.from([0xff,0xd8,0xff,0xc0,0,17,8,height>>8,height&255,width>>8,width&255,3,1,0x11,0,2,0x11,0,3,0x11,0,0xff,0xd9]);
function fixtures() {
  const objects = new Map(), edge = new Map();
  let puts=0, reads=0, upstream=0, validated=0;
  const env = {PRODUCT_IMAGES: {
    get: async key => { reads++; const object = objects.get(key); return object ? {size: object.bytes.length, httpEtag: '"retained"', arrayBuffer: async () => object.bytes.buffer.slice(0)} : null; },
    put: async (key, bytes, metadata) => {puts++; objects.set(key, {bytes: new Uint8Array(bytes), metadata}); return {httpEtag: '"retained"'};}
  }};
  const waits=[], ctx={waitUntil: work=>waits.push(work)};
  const options = {cache: {match: async key => edge.get(key.url)?.clone(), put: async (key,response) => {edge.set(key.url,response);}},
    registeredSource: async image=>{validated++; return image.thumbnailURL===thumb;},
    fetcher: async (url,init)=>{upstream++; assert.equal(url,thumb); assert.equal(init.redirect,'manual'); return new Response(jpeg(),{headers:{'content-type':'image/jpeg'}});}};
  return {env,ctx,options,objects,waits,edge,stats:()=>({puts,reads,upstream,validated})};
}
function database() {
  const sql=new DatabaseSync(':memory:');sql.exec(catalogueSchema);
  const storage={sql:{exec:(query,...values)=>({toArray:()=>sql.prepare(query).all(...values)})},transactionSync:callback=>{sql.exec('BEGIN');try{const result=callback();sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  return {sql,db:catalogueSQLAdapter(storage)};
}

describe('compact, catalogue-owned product photos',()=>{
  it('canonicalizes only official revision-addressed front/photos, never another photo or host',()=>{
    assert.equal(canonicalProductThumbnail(source).thumbnailURL,thumb);
    assert.equal(canonicalProductThumbnail(source.replace('.org','.net')).thumbnailURL,thumb);
    assert.equal(canonicalProductThumbnail(source.replace('.400.jpg','.full.jpg')).thumbnailURL,thumb);
    assert.equal(canonicalProductThumbnail(source.replace('front_en.7.400.jpg','42.jpg')).thumbnailURL,source.replace('front_en.7.400.jpg','42.100.jpg'));
    assert.equal(canonicalProductThumbnail(source.replace('front_en.7.400.jpg','42.400.jpg')).thumbnailURL,source.replace('front_en.7.400.jpg','42.100.jpg'));
    for(const invalid of ['http://images.openfoodfacts.org/images/products/1234/1.jpg',source+'?x=1',source+'#test',source.replace('images.','static.'),source.replace('.org','.org.evil.test'),source.replace('front_en.7','nutrition_en.7'),source.replace('front_en.7.400.jpg','front_en.jpg'),source.replace('/500/','/%35%30%30/'),source.replace('/500/','/../500/'),source.replace('https://','https://user@'),source.replace('.org/','.org:444/'),source.replace('/500/','/abcdefgh/')]) assert.equal(canonicalProductThumbnail(invalid),null,invalid);
  });
  it('deduplicates variants while preferring small front photos in a predictable language order',()=>{
    const other=thumb.replace('front_en.7','front_fr.9');
    const candidates=productThumbnailCandidates({lc:'fr',selected_images:{front:{small:{fr:other,en:thumb},display:{en:source}}},image_front_url:source});
    assert.deepEqual(candidates.map(p=>p.thumbnailURL),[thumb,other]);
    assert.equal(candidates[0].sourceURL,thumb);
    const thumbnailSource=thumb.replace('front_en.7','front_en.8').replace('.200.jpg','.100.jpg');
    const withoutSmall=productThumbnailCandidates({selected_images:{front:{display:{en:source},thumb:{en:thumbnailSource}}}});
    assert.equal(withoutSmall[0].sourceURL,thumbnailSource,'Native and manifest both prefer the smaller available source before display');
  });
  it('persists valid small bytes and provenance once, then reads R2 and edge without OFF or catalogue',async()=>{
    const f=fixtures(), first=await serveProductThumbnail(request(),f.env,f.ctx,f.options);
    assert.equal(first.status,200);assert.equal(first.headers.get('x-nudge-image-cache'),'stored');
    assert.equal(first.headers.get('content-length'),String(jpeg().length));assert.match(first.headers.get('cache-control'),/immutable/);
    assert.match(first.headers.get('link'),/creativecommons.org.*license/);
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()),jpeg());
    const key=await productThumbnailKey(thumb), retained=f.objects.get(key);
    assert.match(key,/^thumbnail-v1\/[a-f0-9]{64}\.jpg$/);
    assert.equal(retained.metadata.customMetadata.sourceURL,source);assert.equal(retained.metadata.customMetadata.thumbnailURL,thumb);
    assert.equal(retained.metadata.customMetadata.barcode,barcode);assert.match(retained.metadata.customMetadata.licenceURL,/by-sa\/3.0/);
    await Promise.all(f.waits);
    const cached=await serveProductThumbnail(request(thumb),f.env,f.ctx,f.options);
    assert.equal(cached.headers.get('x-nudge-image-cache'),'edge');assert.deepEqual(f.stats(),{puts:1,reads:1,upstream:1,validated:1});
    f.edge.clear();
    const r2=await serveProductThumbnail(request(),f.env,null,{...f.options,cache:null,registeredSource:()=>assert.fail('No catalogue read on R2 hit')});
    assert.equal(r2.headers.get('x-nudge-image-cache'),'r2');assert.deepEqual(f.stats(),{puts:1,reads:2,upstream:1,validated:1});
  });
  it('handles HEAD and conditional responses with the same thumbnail object',async()=>{
    const f=fixtures();const head=await serveProductThumbnail(request(source,{method:'HEAD'}),f.env,f.ctx,f.options);
    assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('content-length'),String(jpeg().length));
    await Promise.all(f.waits);
    const conditional=await serveProductThumbnail(request(source,{headers:{'if-none-match':'"retained"'}}),f.env,f.ctx,f.options);
    assert.equal(conditional.status,304);assert.equal(await conditional.text(),'');assert.equal(f.stats().upstream,1);
  });
  it('coalesces simultaneous renditions of a single product into one validated upstream request/write',async()=>{
    const f=fixtures();let release;
    const barrier=new Promise(resolve=>{release=resolve;});const original=f.options.fetcher;
    f.options.fetcher=async(...args)=>{await barrier;return original(...args);};
    const one=serveProductThumbnail(request(),f.env,null,f.options),two=serveProductThumbnail(request(thumb),f.env,null,f.options);
    await new Promise(resolve=>setTimeout(resolve,5));release();
    assert.deepEqual((await Promise.all([one,two])).map(response=>response.status),[200,200]);assert.deepEqual(f.stats(),{puts:1,reads:1,upstream:1,validated:1});
  });
  it('rejects unregistered official images before fetching or creating storage',async()=>{
    const f=fixtures();const result=await serveProductThumbnail(request(),f.env,null,{...f.options,registeredSource:async()=>false});
    assert.equal(result.status,404);assert.equal((await result.json()).code,'product_image_not_in_catalogue');assert.equal(result.headers.get('cache-control'),'no-store');
    assert.equal(f.stats().upstream,0);assert.equal(f.stats().puts,0);
  });
  it('never stores missing, redirected, oversized, falsely typed, or full-sized photos',async()=>{
    for(const response of [new Response('missing',{status:404}),new Response(null,{status:302,headers:{location:'https://evil.test/p'}}),new Response('x',{headers:{'content-type':'image/jpeg','content-length':String(PRODUCT_IMAGE_MAX_BYTES+1)}}),new Response(jpeg(),{headers:{'content-type':'text/html'}}),new Response('<html>',{headers:{'content-type':'image/jpeg'}}),new Response(jpeg(400,300),{headers:{'content-type':'image/jpeg'}}),new Response(new Uint8Array(PRODUCT_IMAGE_MAX_BYTES+1),{headers:{'content-type':'image/jpeg'}})]) {
      const f=fixtures();const result=await serveProductThumbnail(request(),f.env,f.ctx,{...f.options,fetcher:async()=>response});
      assert.ok(result.status>=400);assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(f.stats().puts,0);assert.equal(f.edge.size,0);
    }
  });
  it('bounds a stalled upstream and retries a failure rather than caching it',async()=>{
    const f=fixtures();const result=await serveProductThumbnail(request(),f.env,f.ctx,{...f.options,timeoutMS:10,fetcher:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
    assert.equal(result.status,504);assert.equal(f.stats().puts,0);assert.equal(f.edge.size,0);
    assert.equal((await serveProductThumbnail(request(),f.env,f.ctx,f.options)).status,200);
  });
  it('does not claim success when persistent storage fails',async()=>{
    const f=fixtures();f.env.PRODUCT_IMAGES.put=async()=>{throw new Error('unavailable');};
    const result=await serveProductThumbnail(request(),f.env,f.ctx,f.options);assert.equal(result.status,502);assert.equal(f.edge.size,0);
  });
  it('rejects duplicate or additional query parameters without upstream work',async()=>{
    const f=fixtures();for(const extra of ['&source='+encodeURIComponent(thumb),'&other=yes'])assert.equal((await serveProductThumbnail(new Request(request().url+extra),f.env,null,f.options)).status,400);
    assert.deepEqual(f.stats(),{puts:0,reads:0,upstream:0,validated:0});
  });
});

describe('thumbnail manifest and admission use only existing public product photos',()=>{
  it('projects image fields, advances across absent images, and never mutates facts/fingerprints/ratings',async()=>{
    const {db,sql}=database(),now=Date.now();
    const products=[{code:barcode,product_name:'Example',countries_tags:['en:united-kingdom'],image_front_url:source},
      {code:'5000000000002',product_name:'Without image',countries_tags:['en:united-kingdom']},
      {code:'5000000000003',product_name:'Wrong image identity',countries_tags:['en:united-kingdom'],image_front_url:source}];
    await importCatalogue(db,{products,sourceURL:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',fetchedAt:now});
    const before=sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all();
    const first=await catalogueImageManifest(db,new URL('https://internal/image-manifest?limit=2'));
    assert.equal(first.scanned,2);assert.equal(first.hasMore,true);assert.equal(first.nextAfter,'5000000000002');assert.equal(first.images.length,1);assert.equal(first.images[0].thumbnailURL,thumb);
    const second=await catalogueImageManifest(db,new URL('https://internal/image-manifest?after='+first.nextAfter));
    assert.equal(second.scanned,1);assert.equal(second.images.length,0);assert.equal(second.nextAfter,null);assert.equal(second.hasMore,false);
    assert.equal((await catalogueImageSource(db,new URL('https://internal/image-source?barcode='+barcode))).images[0].thumbnailURL,thumb);
    assert.equal((await catalogueImageSource(db,new URL('https://internal/image-source?barcode=5000000000003'))).images.length,0);
    assert.deepEqual(sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all(),before);
    for(const query of ['?limit=501','?after=bad','?limit=1&limit=2','?private=1'])await assert.rejects(()=>catalogueImageManifest(db,new URL('https://internal/image-manifest'+query)));
  });
  it('keeps manifest administrative while image reads need neither account nor AI configuration',async()=>{
    const f=fixtures(),admin='89'.repeat(32),env={...f.env,CATALOGUE_ADMIN_TOKEN_SHA256:createHash('sha256').update(admin).digest('hex')};
    let calls=0;
    env.FOOD_CATALOGUE_INDEX={idFromName:name=>name,get:()=>({fetch:async value=>{calls++;return Response.json({images:[],nextAfter:null,hasMore:false});}})};
    const manifest=new Request('https://nudge.example/v1/catalogue/image-manifest');
    assert.equal((await worker.fetch(manifest,env)).status,401);assert.equal(calls,0);
    assert.equal((await worker.fetch(new Request(manifest,{headers:{authorization:'Bearer '+admin}}),env)).status,200);assert.equal(calls,1);
    assert.equal((await worker.fetch(new Request('https://nudge.example/v1/catalogue/image-status'),env)).status,401);
    const status=await worker.fetch(new Request('https://nudge.example/v1/catalogue/image-status',{headers:{authorization:'Bearer '+admin}}),env);
    assert.equal(status.status,200);assert.equal((await status.json()).status,'not_started');
    assert.equal((await worker.fetch(request(),env)).status,404);assert.equal(calls,2);
    assert.equal((await worker.fetch(new Request('https://nudge.example/image-source?barcode='+barcode),env)).status,404);
  });
  it('does not run nutrition maintenance on every thumbnail cron tick',async()=>{
    let calls=0;const waits=[];
    const env={FOOD_CATALOGUE_INDEX:{idFromName:name=>name,get:()=>({fetch:async()=>{calls++;return Response.json({refreshed:true});}})}};
    const ctx={waitUntil:work=>waits.push(work)};
    worker.scheduled({cron:'* * * * *'},env,ctx);await Promise.all(waits);assert.equal(calls,0);
    worker.scheduled({cron:'*/15 * * * *'},env,ctx);await Promise.all(waits);assert.equal(calls,1);
  });
});
