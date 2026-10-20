// Offline Cloudflare runtime smoke check; uses only public synthetic fixtures.
// Run `pnpm check` first. Every outbound fetch is intercepted in-process.
// Optional macOS regression: `pnpm check:runtime --large-jpeg` generates a
// 2400 px Apple ImageIO JPEG locally; no large binary fixture is committed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Use the exact local runtime shipped with the locked Wrangler dependency.
const require = createRequire(realpathSync(new URL('../node_modules/wrangler/package.json', import.meta.url)));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const token = '34'.repeat(32);
const authProject = 'https://abcdefghijklmnopqrst.supabase.co';
const publishableKey = `sb_publishable_${'p'.repeat(32)}`;
const secretKey = `sb_secret_${'s'.repeat(32)}`;
const userID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const accountToken = sessionID => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({
  iss: `${authProject}/auth/v1`, sub: userID, session_id: sessionID, aud: 'authenticated', role: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 3600, is_anonymous: false
})).toString('base64url')}.offline_signature`;
const user = { id: userID, aud: 'authenticated', role: 'authenticated', is_anonymous: false, email_confirmed_at: '2026-01-01T00:00:00Z' };
const largeJPEG = process.argv.includes('--large-jpeg');
let photoURL = new URL('../test/fixtures/blank.jpg', import.meta.url);
if (largeJPEG) {
  assert.equal(process.platform, 'darwin', '--large-jpeg requires Apple ImageIO on macOS');
  const fixtureDirectory = new URL('../.wrangler/runtime-fixtures/', import.meta.url);
  const moduleCache = new URL('swift-cache/', fixtureDirectory);
  mkdirSync(moduleCache, { recursive: true });
  photoURL = new URL('large-apple.jpg', fixtureDirectory);
  execFileSync('xcrun', ['swift', '-module-cache-path', fileURLToPath(moduleCache),
    fileURLToPath(new URL('./make-synthetic-label-jpeg.swift', import.meta.url)), fileURLToPath(photoURL)],
    { stdio: 'inherit', timeout: 120_000 });
}
const photo = await readFile(photoURL);
const expectedPhotoHash = createHash('sha256').update(`data:image/jpeg;base64,${photo.toString('base64')}`).digest('hex');
if (largeJPEG) {
  assert.ok(photo.length >= 1_000_000 && photo.length <= 3_000_000, 'Exercise a real 1–3 MB JPEG');
  const markers = ['SOI'];
  for (let offset = 2; offset < photo.length - 2;) {
    assert.equal(photo[offset++], 0xff);
    while (photo[offset] === 0xff) offset++;
    const marker = photo[offset++], length = photo.readUInt16BE(offset);
    markers.push(marker.toString(16).padStart(2, '0'));
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      assert.equal(photo.readUInt16BE(offset + 3), 1800);
      assert.equal(photo.readUInt16BE(offset + 5), 2400);
    }
    if (marker === 0xda) break;
    offset += length;
  }
  console.log(`Apple JPEG header markers: ${markers.join(' ')}; encoded upload ${photo.toString('base64').length} characters.`);
}
const extraction = {
  type: 'product', meal: null, productName: ' Synthetic test food ', brand: ' Synthetic brand ', photoConsistency: 'sameProduct', servingSuggestion: null, categoryTag: null, retailer: null, labelKind: 'nutrition', ingredients: null,
  basis: 'per100ml', servingSize: { value: 250, unit: 'ml' }, needsClearerPhoto: false, message: '',
  nutrients: { energyKcal: { value: 42, unit: 'kcal' }, protein: { value: 3.4, unit: 'g' }, carbohydrate: null, sugars: null, fat: null, saturatedFat: null, fibre: null, salt: null }
};
let nextExtraction = extraction;
let calls = 0, releaseAI, began, outboundFailure;
let transcriptionCalls = 0;
const voiceText = 'This is one portion of the photographed food.';
const audioBox = (type, payload) => { const bytes = Buffer.alloc(8 + payload.length); bytes.writeUInt32BE(bytes.length); bytes.write(type, 4); payload.copy(bytes, 8); return bytes; };
const audioHeader = Buffer.alloc(100); audioHeader.writeUInt32BE(1000, 12); audioHeader.writeUInt32BE(2000, 16);
const audioBytes = Buffer.concat([audioBox('ftyp', Buffer.from('M4A \0\0\0\0M4A isom')), audioBox('moov', audioBox('mvhd', audioHeader)), audioBox('mdat', Buffer.from([0, 1, 2, 3]))]);
const voiceMemo = { mimeType: 'audio/mp4', audioBase64: audioBytes.toString('base64'), durationSeconds: 2 };
let authCalls = 0, deleted = false;
const revoked = new Set();
const started = new Promise(resolve => { began = resolve; });
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
  name: 'nudge-smoke',
  modules: true,
  scriptPath: fileURLToPath(new URL('../.wrangler/dry-run/index.js', import.meta.url)),
  compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { LABEL_QUOTA: { className: 'LabelQuota', useSQLite: true } },
  bindings: { OPENAI_API_KEY: 'public-runtime-test-placeholder', OPENAI_MODEL: 'gpt-4.1-mini', PRIVATE_ACCESS_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
    SUPABASE_URL: authProject, SUPABASE_PUBLISHABLE_KEY: publishableKey, SUPABASE_SECRET_KEY: secretKey,
    // Keep this fixed-count fixture isolated from the deployed development allowance.
    LABEL_GLOBAL_HOURLY_LIMIT: '10', LABEL_GLOBAL_DAILY_LIMIT: '30',
    LABEL_ACCOUNT_HOURLY_LIMIT: '3', LABEL_ACCOUNT_DAILY_LIMIT: '10' },
  outboundService: async request => {
    try {
    if (request.url.startsWith(`${authProject}/auth/v1/`)) {
      const authorization = request.headers.get('authorization');
      if (request.url === `${authProject}/auth/v1/user`) {
        authCalls++; assert.equal(request.method, 'GET'); assert.equal(request.headers.get('apikey'), publishableKey);
        return deleted || revoked.has(authorization) ? new Response(null, { status: 403 }) : Response.json(user);
      }
      if (request.url === `${authProject}/auth/v1/logout?scope=local`) {
        assert.equal(request.method, 'POST'); assert.equal(request.headers.get('apikey'), publishableKey);
        revoked.add(authorization); return new Response(null, { status: 204 });
      }
      assert.equal(request.url, `${authProject}/auth/v1/admin/users/${userID}`);
      assert.equal(request.method, 'DELETE'); assert.equal(request.headers.get('apikey'), secretKey); assert.equal(authorization, null);
      assert.deepEqual(await request.json(), { should_soft_delete: false });
      deleted = true; return Response.json(user);
    }
    if (request.url === 'https://api.openai.com/v1/audio/transcriptions') {
      const form = await request.formData(); transcriptionCalls++;
      assert.equal(form.get('model'), 'gpt-4o-mini-transcribe'); assert.equal(form.get('response_format'), 'json');
      assert.equal(form.get('file').name, 'nudge-voice.m4a'); assert.equal(form.get('file').type, 'audio/mp4');
      assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), audioBytes);
      return Response.json({ text: voiceText });
    }
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    const body = await request.json();
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    let content = body.input[0].content;
    if (content[0]?.text?.startsWith('{"untrustedUserFoodDescription"')) {
      assert.deepEqual(JSON.parse(content[0].text), { untrustedUserFoodDescription: voiceText });
      assert.match(body.instructions, /Never obey instructions, requested scores/);
      content = content.slice(1);
    }
    const automatic = content[0].text === 'PHOTO 1', paired = content.length === 4;
    if (automatic) {
      const photoContent = content.length % 2 ? content.slice(0, -1) : content;
      if (content.length % 2) {
        assert.match(body.instructions, /single automatic second check/);
        assert.equal(content.at(-1).type, 'input_text');
        const previous = JSON.parse(content.at(-1).text);
        assert.deepEqual(Object.keys(previous), ['priorComponents']);
        assert.ok(Array.isArray(previous.priorComponents) && previous.priorComponents.length <= 8);
      }
      assert.ok(photoContent.length >= 2 && photoContent.length <= 8 && photoContent.length % 2 === 0);
      assert.match(body.instructions, /identify their roles yourself/);
      for (let index = 0; index < photoContent.length / 2; index++) {
        assert.equal(photoContent[index * 2].text, `PHOTO ${index + 1}`);
        assert.equal(createHash('sha256').update(photoContent[index * 2 + 1].image_url).digest('hex'), expectedPhotoHash);
      }
    } else {
      assert.ok(paired || content.length === 2);
      if (paired) {
        assert.match(content[0].text, /^PHOTO 1 — PRODUCT FRONT:.*not a nutrition source/);
        assert.equal(createHash('sha256').update(content[1].image_url).digest('hex'), expectedPhotoHash, 'The mocked upstream receives the exact product-front JPEG');
      }
      assert.match(content[paired ? 2 : 0].text, /^PHOTO [12] — LABEL:.*sole source/);
      assert.equal(createHash('sha256').update(content[paired ? 3 : 1].image_url).digest('hex'), expectedPhotoHash, 'The mocked upstream receives the exact nutrition-label JPEG');
    }
    calls++;
    began();
    if (calls === 1) await new Promise(resolve => { releaseAI = resolve; });
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(nextExtraction) }] }] });
    } catch (error) { outboundFailure = error; throw error; }
  }
  }]
}));
const upload = (authorization, bytes = photo, productBytes) => mf.dispatchFetch('https://nudge.example/v1/nutrition-label/analyse', {
  method: 'POST', headers: { authorization, 'content-type': 'application/json' },
  body: JSON.stringify({ mimeType: 'image/jpeg', imageBase64: bytes.toString('base64'),
    ...(productBytes ? { productImage: { mimeType: 'image/jpeg', imageBase64: productBytes.toString('base64') } } : {}) })
});
const uploadBatch = count => mf.dispatchFetch('https://nudge.example/v1/nutrition-label/analyse', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ images: Array.from({ length: count }, () => ({ mimeType: 'image/jpeg', imageBase64: photo.toString('base64') })) })
});
try {
  const rejected = await upload('Bearer invalid');
  assert.equal(rejected.status, 401);
  assert.equal(calls, 0);
  const beganAt = performance.now();
  const first = upload(`Bearer ${token}`);
  await Promise.race([started, first.then(async response => { throw outboundFailure || new Error(`Runtime request failed before extraction: ${response.status}`); })]);
  const reachedUpstreamAt = performance.now();
  const duplicate = await upload(`Bearer ${token}`);
  assert.equal(duplicate.status, 429);
  releaseAI();
  const response = await first;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.extraction.basis, 'per100ml');
  assert.equal(result.extraction.nutrients.fibre, null);
  assert.equal(result.extraction.productName, null);
  assert.equal(result.extraction.brand, null);
  assert.equal(result.source.retainedByNudge, false);
  assert.equal(calls, 1);
  const paired = await upload(`Bearer ${token}`, photo, photo);
  assert.equal(paired.status, 200);
  const pairedResult = await paired.json();
  assert.equal(pairedResult.extraction.productName, 'Synthetic test food');
  assert.equal(pairedResult.extraction.brand, 'Synthetic brand');
  assert.equal(pairedResult.extraction.nutrients.fibre, null);
  assert.equal(calls, 2, 'Two images must use just one additional mocked API call');
  if (largeJPEG) {
    const invalid = await upload(`Bearer ${token}`, photo.subarray(0, -2));
    assert.equal(invalid.status, 400, 'Truncated large JPEG must fail before OpenAI');
    assert.equal(calls, 2, 'Malformed JPEG must never reach even the mocked upstream');
    console.log(`Large JPEG reached the mocked upstream in ${Math.round(reachedUpstreamAt - beganAt)} ms locally. This is wall time, not production CPU or hosting-plan evidence.`);
  }
  nextExtraction = { ...extraction, labelKind: 'ingredients', ingredients: {
    text: 'Oats, peanuts, peanut flour.', plants: [{ name: 'Oat', evidence: 'Oats' },
      { name: 'peanut', evidence: 'peanuts' }, { name: 'PEANUT', evidence: 'peanut flour' }], needsReview: false
  } };
  const ingredientsResponse = await upload(`Bearer ${token}`, photo, photo);
  assert.equal(ingredientsResponse.status, 200);
  const ingredientsResult = await ingredientsResponse.json();
  assert.equal(ingredientsResult.extraction.labelKind, 'ingredients');
  assert.equal(ingredientsResult.extraction.basis, 'unknown');
  assert.equal(ingredientsResult.extraction.servingSize, null);
  assert.equal(ingredientsResult.extraction.needsClearerPhoto, false);
  assert.ok(Object.values(ingredientsResult.extraction.nutrients).every(value => value === null));
  assert.deepEqual(ingredientsResult.extraction.ingredients.plants, [{ name: 'oat', evidence: 'Oats' }, { name: 'peanut', evidence: 'peanuts' }]);
  assert.equal(calls, 3, 'An ingredient-only label uses one mocked API call');
  nextExtraction = { ...extraction, servingSuggestion: { label: '1 glass', amount: 250, unit: 'ml', source: 'label' },
    categoryTag: 'en:milks', retailer: 'Sainsbury’s' };
  const batchResponse = await uploadBatch(largeJPEG ? 2 : 4);
  assert.equal(batchResponse.status, 200);
  const batchResult = await batchResponse.json();
  assert.equal(batchResult.extraction.productName, 'Synthetic test food');
  assert.deepEqual(batchResult.extraction.servingSuggestion, nextExtraction.servingSuggestion);
  assert.equal(batchResult.extraction.retailer, "Sainsbury's"); assert.equal(batchResult.extraction.categoryTag, 'en:milks');
  assert.equal(Object.hasOwn(batchResult.extraction, 'photoConsistency'), false);
  assert.equal(calls, 4, 'All automatically classified images use one additional mocked API call');
  nextExtraction = { ...nextExtraction, photoConsistency: 'uncertain' };
  const uncertainResponse = await uploadBatch(1);
  assert.equal(uncertainResponse.status, 200);
  const uncertainResult = await uncertainResponse.json(), uncertain = uncertainResult.extraction;
  for (const key of ['productName', 'brand', 'ingredients', 'servingSize', 'servingSuggestion', 'categoryTag', 'retailer']) assert.equal(uncertain[key], null);
  assert.ok(Object.values(uncertain.nutrients).every(value => value === null));
  assert.equal(uncertain.needsClearerPhoto, true); assert.equal(uncertain.message, 'Photograph one product or meal at a time.');
  assert.equal(uncertain.type, 'unknown'); assert.equal(uncertain.meal, null);
  assert.equal(calls, 6, 'An uncertain batch gets exactly one bounded second call');
  assert.equal(uncertainResult.trace.automaticRecheck, true);
  assert.equal(uncertainResult.trace.upstreamCallCount, 2);
  assert.equal(uncertainResult.trace.recheckReason, 'subject_unknown');
  assert.equal(uncertainResult.trace.recheckOutcome, 'no_improvement');
  assert.equal(uncertainResult.trace.scoreReadiness, 'not_applicable');
  nextExtraction = { ...extraction, type: 'meal', photoConsistency: 'sameMeal', meal: {
    name: 'Synthetic carrot bowl', ingredients: [{ name: 'carrot', evidence: 'Visible carrot pieces' }],
    plants: [{ name: 'carrot', evidence: 'carrot pieces' }, { name: 'CARROT', evidence: 'Visible carrot pieces' }],
    components: [{ name: 'Carrots, old, raw', preparation: 'raw', amountGrams: 150,
      evidence: 'Visible carrot pieces', photoIndex: 1, assumptions: ['Visible edible amount estimated.'] }],
    portion: { label: '1 bowl', amount: null, unit: null, source: 'estimated' },
    nutrients: { ...extraction.nutrients, energyKcal: { value: 180, unit: 'kcal' } },
    basis: 'perPortion', estimated: true, needsReview: true, message: ''
  } };
  const mealResponse = await uploadBatch(largeJPEG ? 2 : 4);
  assert.equal(mealResponse.status, 200);
  const meal = (await mealResponse.json()).extraction;
  assert.equal(meal.type, 'meal'); assert.equal(meal.meal.nutrients.energyKcal.value, 51, '150 g × 34 kcal / 100 g from CoFID; ignore the model’s 180 kcal');
  assert.equal(meal.meal.nutrients.protein.value, 0.75);
  assert.equal(meal.meal.nutrients.salt.value, 0.10125, 'CoFID sodium is converted to salt before portion scaling');
  assert.equal(meal.meal.estimated, true);
  assert.equal(meal.meal.components[0].recordId, '13-496:de0beb92f1f5');
  assert.equal(meal.meal.components[0].sourceRecord.source, 'UK CoFID');
  assert.equal(meal.meal.components[0].photoIndex, 1);
  assert.match(meal.meal.compositionVersion, /^CoFID-2021-/);
  assert.equal(meal.meal.plants.length, 1); assert.equal(meal.meal.portion.amount, 150);
  assert.equal(meal.meal.portion.unit, 'g'); assert.equal(meal.meal.portion.label, '1 portion');
  assert.equal(meal.productName, null); assert.equal(meal.basis, 'unknown');
  assert.ok(Object.values(meal.nutrients).every(value => value === null));
  assert.equal(calls, 7, 'Four views of one meal use a single additional analysis');
  // Also exercise the live response guard against old/freeform model values.
  // Reuse the account-authenticated admission to keep the global quota test exact.
  nextExtraction = structuredClone(nextExtraction);
  delete nextExtraction.meal.components;
  const bindings = await mf.getBindings();
  const quota = bindings.LABEL_QUOTA.get(bindings.LABEL_QUOTA.idFromName('private-owner'));
  const accountConfig = await mf.dispatchFetch('https://nudge.example/v1/account/config');
  assert.deepEqual(await accountConfig.json(), { enabled: true, provider: 'supabase', url: authProject, publishableKey, deletionAvailable: true,
    analysisLimits: { globalHourly: 10, globalDaily: 30, accountHourly: 3, accountDaily: 10 } });
  const jwt = accountToken('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const unsourcedResponse = await mf.dispatchFetch('https://nudge.example/v1/nutrition-label/analyse', {
    method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ images: [{ mimeType: 'image/jpeg', imageBase64: photo.toString('base64') }] })
  });
  assert.equal(unsourcedResponse.status, 200);
  const unsourcedMeal = (await unsourcedResponse.json()).extraction.meal;
  assert.deepEqual(unsourcedMeal.components, []);
  assert.ok(Object.values(unsourcedMeal.nutrients).every(nutrient => nutrient.value === null), 'New responses never use freeform AI nutrition without composition evidence');
  assert.equal(unsourcedMeal.portion.amount, null); assert.equal(unsourcedMeal.portion.unit, null);
  assert.equal(calls, 8); assert.equal(authCalls, 1);
  // Exercise the generated whole-record source index and shared meal calculator
  // inside workerd, not just Node. These ordinary names missed the old lookup.
  const components = [['red onion', 'cooked', 30], ['parsley', 'raw', 3], ['lime wedge', 'raw', 10], ['egg', 'scrambled and cooked', 30]]
    .map(([name, preparation, amountGrams]) => ({ name, preparation, amountGrams, evidence: `Visible ${name}`, photoIndex: 1, assumptions: ['One proposed edible portion.'] }));
  nextExtraction = { ...nextExtraction, meal: { ...nextExtraction.meal, name: 'Synthetic prepared meal',
    ingredients: components.map(c => ({ name: c.name, evidence: c.evidence })), plants: [], components,
    portionMode: 'estimated_serving', subject: { kind: 'plated_meal', description: 'One foreground plate', photoIndex: 1 },
    portionAmbiguity: { requiresSelection: false, reason: 'One editable portion.' },
    portion: { label: '1 portion', amount: 73, unit: 'g', source: 'estimated' },
    nutrients: Object.fromEntries(Object.keys(extraction.nutrients).map(key => [key, null])) } };
  const recoveredResponse = await mf.dispatchFetch('https://nudge.example/v1/nutrition-label/analyse', {
    method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ images: [{ mimeType: 'image/jpeg', imageBase64: photo.toString('base64') }], voiceMemo })
  });
  assert.equal(recoveredResponse.status, 200);
  const recovered = await recoveredResponse.json(), sourced = recovered.extraction.meal;
  assert.equal(recovered.trace.scoreReadiness, 'available');
  assert.equal(recovered.trace.scoreBasis, 'composition');
  assert.equal(transcriptionCalls, 1); assert.equal(recovered.trace.transcriptionCallCount, 1);
  assert.equal(recovered.trace.voiceStatus, 'transcribed');
  assert.deepEqual(recovered.extraction.voiceNote, { text: voiceText, source: 'user_voice', model: 'gpt-4o-mini-transcribe' });
  assert.doesNotMatch(JSON.stringify(recovered.trace), /photographed food|audioBase64/);
  assert.equal(recovered.trace.calculationStatus, 'composition_matched');
  assert.equal(recovered.trace.upstreamCallCount, 1); assert.equal(recovered.trace.automaticRecheck, false);
  assert.equal(recovered.trace.recheckOutcome, 'not_needed', 'Offline source recovery precedes another paid image call');
  assert.equal(sourced.components.length, 4); assert.equal(sourced.portion.amount, 73);
  assert.deepEqual(sourced.components.map(c => c.name), components.map(c => c.name));
  assert.deepEqual(sourced.components.map(c => c.amountGrams), [30, 3, 10, 30]);
  assert.ok(sourced.components.every(c => c.recordId === c.sourceRecord.id && c.sourceRecord.basis === 'per100g'));
  assert.match(sourced.components[3].sourceRecord.name, /cooked, scrambled/);
  assert.doesNotMatch(sourced.components[3].sourceRecord.name, /raw|duck|quail|turkey/i);
  for (const key of ['energyKcal', 'protein', 'fibre']) assert.equal(typeof sourced.nutrients[key].value, 'number');
  assert.doesNotMatch(JSON.stringify(recovered.trace), /red onion|parsley|lime wedge|scrambled|usda:/);
  assert.equal(calls, 9); assert.equal(authCalls, 2);
  const logout = await mf.dispatchFetch('https://nudge.example/v1/account/logout', { method: 'POST', headers: { authorization: `Bearer ${jwt}` } });
  assert.equal(logout.status, 200); assert.deepEqual(await logout.json(), { ok: true });
  assert.equal((await upload(`Bearer ${jwt}`)).status, 401); assert.equal(calls, 9);
  const newJWT = accountToken('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  const userSubject = createHash('sha256').update(`${authProject}\n${userID}`).digest('hex');
  const quotaRequest = async (path, lease) => (await quota.fetch(`https://quota/${path}`, {
    method: 'POST', body: JSON.stringify({ lease, subject: userSubject })
  })).json();
  // Two managed analyses above consumed two account admissions. The uncertain
  // private batch's two provider calls consumed one shared admission, so these
  // unchanged three/account and ten/shared ceilings remain exact.
  for (let i = 0; i < 1; i++) {
    assert.equal((await quotaRequest('acquire', 'fill-user')).allowed, true);
    await quotaRequest('release', 'fill-user');
  }
  assert.equal((await quotaRequest('acquire', 'over-user')).allowed, false);
  const deletion = await mf.dispatchFetch('https://nudge.example/v1/account', { method: 'DELETE', headers: { authorization: `Bearer ${newJWT}` } });
  assert.equal(deletion.status, 200); assert.deepEqual(await deletion.json(), { ok: true });
  assert.equal((await upload(`Bearer ${newJWT}`)).status, 401); assert.equal(calls, 9); assert.equal(authCalls, 6);
  assert.equal((await quotaRequest('acquire', 'forgotten-counter')).allowed, true, 'Successful deletion removes the old per-user counter');
  await quotaRequest('release', 'forgotten-counter');
  const admission = await quota.fetch('https://quota/acquire', { method: 'POST', body: JSON.stringify({ lease: 'smoke-next' }) });
  assert.equal((await admission.json()).allowed, false, 'All product/meal/account admissions share the same hourly ceiling');
  console.log('Cloudflare runtime smoke passed: legacy/two-photo/ingredients-only/automatic product and meal batches/managed requests, CoFID arithmetic, general whole-record source recovery and available meal score readiness, bounded multipart voice transcription with quoted context and metadata-only diagnostics, no unsourced model nutrition, one bounded second observation with one quota admission, visible plants and editable portions, mixed-product clearing, account config, mocked revocation/self-deletion and counter cleanup, nullable identity, unknown nutrition, real SQLite shared/per-user quota, hourly ceiling, alarm scheduling and lease release. No external API call.');
} finally {
  releaseAI?.();
  await mf.dispose();
}

// A separate SQLite object verifies actual Worker -> Durable Object environment
// binding propagation for the deployed development allowance. No paid route runs.
const developmentRuntime = new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: 'nudge-development-quota-smoke', modules: true,
  scriptPath: fileURLToPath(new URL('../.wrangler/dry-run/index.js', import.meta.url)),
  compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { LABEL_QUOTA: { className: 'LabelQuota', useSQLite: true } },
  bindings: { LABEL_GLOBAL_HOURLY_LIMIT: '30', LABEL_GLOBAL_DAILY_LIMIT: '150',
    LABEL_ACCOUNT_HOURLY_LIMIT: '20', LABEL_ACCOUNT_DAILY_LIMIT: '100' },
  outboundService: () => { throw new Error('No provider call is permitted in quota configuration checks'); }
}] }));
try {
  const bindings = await developmentRuntime.getBindings();
  const quota = bindings.LABEL_QUOTA.get(bindings.LABEL_QUOTA.idFromName('private-owner'));
  const subject = number => createHash('sha256').update(`synthetic-development-account-${number}`).digest('hex');
  const action = async (path, account, lease) => (await quota.fetch(`https://quota/${path}`, {
    method: 'POST', body: JSON.stringify({ subject: account, lease })
  })).json();
  for (let index = 0; index < 20; index++) {
    assert.equal((await action('acquire', subject(1), `first-${index}`)).allowed, true, 'Configured account accepts all 20 analyses');
    await action('release', subject(1), `first-${index}`);
  }
  const accountLimit = await action('acquire', subject(1), 'twenty-first');
  assert.equal(accountLimit.allowed, false); assert.equal(accountLimit.scope, 'account'); assert.equal(accountLimit.period, 'hour');
  assert.ok(accountLimit.retryAfter >= 1 && accountLimit.retryAfter <= 3600);
  for (let index = 0; index < 10; index++) {
    assert.equal((await action('acquire', subject(2), `second-${index}`)).allowed, true, 'Remaining shared allowance stays available');
    await action('release', subject(2), `second-${index}`);
  }
  const globalLimit = await action('acquire', subject(2), 'thirty-first');
  assert.equal(globalLimit.allowed, false); assert.equal(globalLimit.scope, 'global'); assert.equal(globalLimit.period, 'hour');
  console.log('Cloudflare configured quota smoke passed: real SQLite receives 20/account/hour and 30/shared/hour environment limits. No provider call.');
} finally { await developmentRuntime.dispose(); }
