// Isolated real Cloudflare/SQLite test. All network requests are intercepted;
// only synthetic public product facts enter this temporary catalogue.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const directory=mkdtempSync(join(tmpdir(),'nudge-catalogue-runtime-'));
const token='49'.repeat(32),firstBarcode='1234567890001',secondBarcode='1234567890002',missingBarcode='1234567890003',hugeBarcode='1234567890004',wrongBarcode='1234567890005',redirectBarcode='1234567890006';
const calls=new Map();let outboundFailure;
const payload=barcode=>({status:'success',product:{code:barcode,product_name:barcode===firstBarcode?'Synthetic chickpeas':'Synthetic lentils',brands:'Runtime fixture',
  ingredients_text:barcode===firstBarcode?'Chickpeas, water':'Lentils, water',categories_tags:barcode===firstBarcode?['en:chickpeas']:['en:lentils'],
  nutrition:{aggregated_set:{per:'100g',preparation:'as_sold',nutrients:{'energy-kcal':{value:100,unit:'kcal',source:'packaging'},proteins:{value:6,unit:'g',source:'packaging'},fiber:{value:5,unit:'g',source:'packaging'},salt:{value:.5,unit:'g',source:'packaging'}}}},
  image_front_url:'https://images.openfoodfacts.org/images/products/123/front.jpg',last_modified_t:1700000000,
  // Unexpected provider fields cannot leak into the shared record.
  apiKey:'do-not-store-marker',diary:'do-not-store-marker',voiceMemo:'do-not-store-marker'}});
const options=()=>convertV4MiniflareOptions({resourcePersistencePath:directory,workers:[{
  name:'nudge-catalogue-smoke',modules:true,scriptPath:fileURLToPath(new URL('../.wrangler/dry-run/index.js',import.meta.url)),compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],
  durableObjects:{LABEL_QUOTA:{className:'LabelQuota',useSQLite:true}},
  bindings:{OPENAI_API_KEY:'public-runtime-test-placeholder',OPENAI_MODEL:'gpt-4.1-mini',PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),LABEL_GLOBAL_HOURLY_LIMIT:'1',LABEL_GLOBAL_DAILY_LIMIT:'1',LABEL_ACCOUNT_HOURLY_LIMIT:'1',LABEL_ACCOUNT_DAILY_LIMIT:'1'},
  outboundService:async request=>{
    try {
      const url=new URL(request.url);assert.equal(url.origin,'https://world.openfoodfacts.org','No OpenAI or arbitrary network request is permitted');assert.equal(request.method,'GET');
      const barcode=url.pathname.match(/^\/api\/v3\.6\/product\/(\d{4,18})\.json$/)?.[1];assert.ok(barcode);assert.ok(url.searchParams.get('fields').includes('nutrition'));assert.equal(request.headers.get('authorization'),null);
      calls.set(barcode,(calls.get(barcode)||0)+1);
      if(barcode===missingBarcode)return Response.json({status:0},{status:404});
      if(barcode===hugeBarcode)return new Response('x'.repeat(512_001),{headers:{'content-type':'application/json'}});
      if(barcode===wrongBarcode)return Response.json(payload(firstBarcode));
      if(barcode===redirectBarcode)return Response.redirect('https://untrusted.example/redirect');
      assert.ok([firstBarcode,secondBarcode].includes(barcode));return Response.json(payload(barcode));
    } catch(error){outboundFailure=error;throw error;}
  }
}]});
let mf=new Miniflare(options());
const send=(body={barcode:firstBarcode},authorization=`Bearer ${token}`)=>mf.dispatchFetch('https://nudge.example/v1/products/lookup',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(body)});
try {
  assert.equal((await send(undefined,'Bearer invalid')).status,401);assert.equal(calls.size,0);
  assert.equal((await send({barcode:firstBarcode,record:{verified:true,nutrients:{salt:0}}})).status,400);assert.equal(calls.size,0);
  assert.equal((await send({barcode:'https://untrusted.example/private'})).status,400);assert.equal(calls.size,0);
  assert.equal((await mf.dispatchFetch('https://nudge.example/catalogue-lookup',{method:'POST',body:JSON.stringify({barcode:firstBarcode})})).status,404,'Internal DO route is not public');
  const firstResponse=await send();assert.equal(firstResponse.status,200,`Catalogue lookup failed; mocked source calls: ${JSON.stringify([...calls])}; outbound assertion: ${outboundFailure?.message||'none'}`);const first=await firstResponse.json();
  assert.equal(first.providerPayload.product.code,firstBarcode);assert.equal(first.providerPayload.product.nutrition.aggregated_set.nutrients.fiber.value,5);assert.ok(first.expiresAt>first.fetchedAt);assert.doesNotMatch(JSON.stringify(first),/do-not-store-marker|private-runtime|apiKey|voiceMemo|diary/);
  assert.equal(calls.get(firstBarcode),1);
  const cached=await send();assert.equal(cached.status,200);assert.deepEqual(await cached.json(),first);assert.equal(calls.get(firstBarcode),1,'Sequential scan reuses durable public facts');
  const second=await send({barcode:secondBarcode});assert.equal(second.status,200);assert.equal((await second.json()).providerPayload.product.code,secondBarcode);assert.equal(calls.get(secondBarcode),1,'Each barcode has an independent durable record');
  assert.deepEqual(await (await send()).json(),first);assert.equal(calls.get(firstBarcode),1);
  for(const barcode of [missingBarcode,hugeBarcode,wrongBarcode,redirectBarcode]){
    assert.equal((await send({barcode})).status,404);assert.equal((await send({barcode})).status,404);assert.equal(calls.get(barcode),1,'A failure has a bounded cooldown, not a repeated source fetch');
  }
  if(outboundFailure)throw outboundFailure;
  await mf.dispose();mf=new Miniflare(options());
  const restarted=await send();assert.equal(restarted.status,200);assert.deepEqual(await restarted.json(),first);assert.equal(calls.get(firstBarcode),1,'Fresh Worker process reloads the same SQLite catalogue');
  assert.equal((await send({barcode:missingBarcode})).status,404);assert.equal(calls.get(missingBarcode),1,'Negative-source cooldown survives restart');
  assert.equal((await send(undefined,'Bearer invalid')).status,401);assert.equal(calls.get(firstBarcode),1,'Cache hit still requires authentication');
  const bindings=await mf.getBindings(),quota=bindings.LABEL_QUOTA.get(bindings.LABEL_QUOTA.idFromName('private-owner'));
  const admission=await quota.fetch('https://quota/acquire',{method:'POST',body:JSON.stringify({lease:'only-ai-slot'})});
  assert.equal((await admission.json()).allowed,true,'Catalogue lookups consume no AI quota even with a one-request budget');
  await quota.fetch('https://quota/release',{method:'POST',body:JSON.stringify({lease:'only-ai-slot'})});
  assert.equal((await send()).status,200,'Exhausted AI budget does not block cached public product lookup');
  const blocked=await quota.fetch('https://quota/acquire',{method:'POST',body:JSON.stringify({lease:'second-ai-slot'})});assert.equal((await blocked.json()).allowed,false,'The one-request guard is effective');
  if(outboundFailure)throw outboundFailure;
  console.log('PASS: Cloudflare authenticated catalogue, isolated per-barcode SQLite records, persistent reuse after Worker restart, no AI calls/quota use, source bounds, wrong identity/redirect rejection, durable negative cooldown and rejected untrusted/private fields. No external API calls.');
} finally {await mf.dispose();rmSync(directory,{recursive:true,force:true});}
