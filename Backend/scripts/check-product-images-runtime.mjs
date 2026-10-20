// Workers runtime integration: real R2 and SQLite, synthetic OFF images only.
// Run wrangler deploy --dry-run --outdir .wrangler/dry-run first.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const directory=mkdtempSync(join(tmpdir(),'nudge-product-images-'));
const token='49'.repeat(32),hash=createHash('sha256').update(token).digest('hex');
const source='https://images.openfoodfacts.org/images/products/500/000/000/0001/front_en.7.400.jpg',thumb=source.replace('.400.jpg','.200.jpg');
const secondSource=source.replace('/0001/','/0002/'),secondThumb=secondSource.replace('.400.jpg','.200.jpg');
const bytes=Uint8Array.from([255,216,255,192,0,17,8,0,150,0,200,3,1,17,0,2,17,0,3,17,0,255,217]);
let sourceCalls=0;
const options=()=>convertV4MiniflareOptions({resourcePersistencePath:directory,workers:[{
  name:'product-images-runtime',modules:true,scriptPath:fileURLToPath(new URL('../.wrangler/dry-run/index.js',import.meta.url)),
  compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],
  durableObjects:{FOOD_CATALOGUE_INDEX:{className:'FoodCatalogueIndex',useSQLite:true},LABEL_QUOTA:{className:'LabelQuota',useSQLite:true},PRODUCT_IMAGE_WARM_RUNNER:{className:'ProductImageWarmRunner',useSQLite:true}},
  r2Buckets:['PRODUCT_IMAGES'],bindings:{PRIVATE_ACCESS_TOKEN_SHA256:hash,CATALOGUE_ADMIN_TOKEN_SHA256:hash},
  outboundService:async request=>{
    assert.ok([thumb,secondThumb].includes(request.url),'Only a canonical thumbnail may leave the worker');sourceCalls++;
    return new Response(bytes,{headers:{'content-type':'image/jpeg'}});
  }
}]});
let mf=new Miniflare(options());
const imageURL='https://nudge.example/v1/catalogue/image?source='+encodeURIComponent(source);
try {
  let response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/import',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({
    products:[{code:'5000000000001',product_name:'Synthetic front image',countries_tags:['en:united-kingdom'],image_front_url:source},
      {code:'5000000000002',product_name:'Synthetic uncopied front image',countries_tags:['en:united-kingdom'],image_front_url:secondSource}],
    sourceURL:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',fetchedAt:Date.now()})});
  assert.equal(response.status,200);await response.arrayBuffer();
  response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/image-manifest');assert.equal(response.status,401);await response.arrayBuffer();
  response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/image-manifest',{headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,200);const manifest=await response.json();assert.equal(manifest.images.length,2);assert.equal(manifest.images[0].thumbnailURL,thumb);
  response=await mf.dispatchFetch(imageURL);assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('x-nudge-image-cache'),'stored');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);assert.equal(sourceCalls,1);assert.match(response.headers.get('cache-control'),/immutable/);
  const etag=response.headers.get('etag');assert.ok(etag);
  response=await mf.dispatchFetch(imageURL,{method:'HEAD'});assert.equal(response.status,200);assert.equal(await response.text(),'');assert.equal(response.headers.get('content-length'),String(bytes.length));assert.equal(sourceCalls,1);
  response=await mf.dispatchFetch(imageURL,{headers:{'if-none-match':etag}});assert.equal(response.status,304);assert.equal(await response.text(),'');
  response=await mf.dispatchFetch(imageURL.replace(encodeURIComponent(source),encodeURIComponent(source.replace('.7.','.99.'))));assert.equal(response.status,404);await response.arrayBuffer();assert.equal(sourceCalls,1,'Unretained photo revisions must not be fetched');
  const r2=await mf.getR2Bucket('PRODUCT_IMAGES');const listed=await r2.list({prefix:'thumbnail-v1/'});assert.equal(listed.objects.length,1);assert.equal(listed.objects[0].size,bytes.length);
  const stored=await r2.get(listed.objects[0].key);assert.equal(stored.customMetadata.sourceURL,source);assert.equal(stored.customMetadata.thumbnailURL,thumb);
  response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/image-status');assert.equal(response.status,401);await response.arrayBuffer();
  response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/image-status',{headers:{authorization:'Bearer '+token}});assert.equal((await response.json()).status,'not_started');
  response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/image-warm',{method:'POST'});assert.equal(response.status,401);await response.arrayBuffer();
  response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/image-warm',{method:'POST',headers:{authorization:'Bearer '+token},body:'{"reset":true}'});assert.equal(response.status,400);await response.arrayBuffer();
  response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/image-warm',{method:'POST',headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,202);const accepted=await response.json();assert.equal(accepted.status,'scheduled');assert.ok(accepted.scheduledFor);
  // The runtime itself must dispatch the persisted alarm: no direct Node call
  // to warmProductImages or the Durable Object alarm method is used here.
  let warmStatus;const deadline=Date.now()+20_000;
  do {
    response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/image-status',{headers:{authorization:'Bearer '+token}});
    warmStatus=await response.json();
    if(warmStatus.status==='complete'&&warmStatus.runner?.status==='complete')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  } while(Date.now()<deadline);
  assert.equal(warmStatus.status,'complete',JSON.stringify(warmStatus));assert.equal(warmStatus.runner.status,'complete');
  assert.equal(warmStatus.available,2);assert.equal(warmStatus.copied,1);assert.equal(warmStatus.reused,1);assert.equal(warmStatus.referencedBytes,bytes.length*2);
  assert.ok(warmStatus.runner.lastRunAt);assert.ok(warmStatus.runner.nextRunAt>Date.now()+6*86400000);assert.equal(warmStatus.runner.runningUntil,null);
  assert.equal(sourceCalls,2,'The actual durable alarm copies the missing image and reuses the retained one');
  const runtimeWorker=await mf.getWorker('product-images-runtime');
  const scheduled=await runtimeWorker.scheduled({cron:'* * * * *',scheduledTime:Date.now()});
  assert.equal(scheduled.outcome,'ok','The minute cron must ensure the durable runner remains scheduled');
  response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/image-status',{headers:{authorization:'Bearer '+token}});assert.equal(response.status,200);
  const ensured=await response.json();assert.equal(ensured.available,2);assert.equal(ensured.runner.nextRunAt,warmStatus.runner.nextRunAt,'Minute cron must preserve the completed weekly alarm and cursor');
  const maintenance=await runtimeWorker.scheduled({cron:'*/15 * * * *',scheduledTime:Date.now()});
  assert.equal(maintenance.outcome,'ok','Established maintenance trigger must also ensure the durable runner');
  response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/image-status',{headers:{authorization:'Bearer '+token}});
  const fallbackStatus=await response.json();
  assert.equal(fallbackStatus.status,'complete');assert.equal(fallbackStatus.available,2);assert.equal(fallbackStatus.runner.nextRunAt,warmStatus.runner.nextRunAt);
  assert.equal(sourceCalls,2,'Neither cron resets the completed image sweep');
  await mf.dispose();mf=new Miniflare(options());
  response=await mf.dispatchFetch(imageURL);assert.equal(response.status,200);assert.ok(['edge','r2'].includes(response.headers.get('x-nudge-image-cache')));await response.arrayBuffer();assert.equal(sourceCalls,2,'Persisted copy survives worker restart without upstream work');
  response=await mf.dispatchFetch('https://nudge.example/v1/catalogue/image-status',{headers:{authorization:'Bearer '+token}});assert.equal((await response.json()).runner.nextRunAt,warmStatus.runner.nextRunAt,'Durable runner schedule survives worker restart');
  console.log('PASS: real Workers SQLite admission, admin-only immediate start, actual automatically dispatched Durable Object alarm copying a missing image, persisted diagnostics/weekly alarm, minute AND maintenance cron repair, R2/CAS cache progress, protected status, ETags and restart reuse; no external network or AI calls.');
} finally {await mf.dispose();rmSync(directory,{recursive:true,force:true});}
