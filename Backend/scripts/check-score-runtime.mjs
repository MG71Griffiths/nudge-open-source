// Synthetic, isolated Cloudflare/SQLite exercise. Every outbound call is mocked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { catalogueRecordFromPayload } from '../src/food-catalogue.js';
import { ScoreCore } from '../src/nutrition-core.js';
const require = createRequire(realpathSync(new URL('../node_modules/wrangler/package.json', import.meta.url)));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const token = '78'.repeat(32);
let calls = 0, error, began, release;
const started = new Promise(resolve => { began = resolve; });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: 'nudge-score-smoke', modules: true,
  scriptPath: fileURLToPath(new URL('../.wrangler/dry-run/index.js', import.meta.url)),
  compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { LABEL_QUOTA: { className: 'LabelQuota', useSQLite: true } },
  bindings: { OPENAI_API_KEY: 'public-runtime-test-placeholder', OPENAI_MODEL: 'gpt-4.1-mini',
    PRIVATE_ACCESS_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
    // Explicitly isolate the synthetic quota from deployed development settings.
    LABEL_GLOBAL_HOURLY_LIMIT: '10', LABEL_GLOBAL_DAILY_LIMIT: '30',
    LABEL_ACCOUNT_HOURLY_LIMIT: '3', LABEL_ACCOUNT_DAILY_LIMIT: '10' },
  outboundService: async request => {
    try {
      assert.equal(request.url, 'https://api.openai.com/v1/responses');
      const body = await request.json();
      assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
      assert.ok(body.input[0].content.every(item => item.type === 'input_text'));
      calls++;
      if (calls === 1) { began(); await new Promise(resolve => { release = resolve; }); }
      assert.equal(body.text.format.name, 'product_score_classification', 'Calculated explanations never call the model');
      const supplied = JSON.parse(body.input[0].content[0].text);
      const evidence = supplied.categoryTag
        ? [{ field: 'categoryTag', quote: supplied.categoryTag }]
        : [{ field: 'name', quote: supplied.name }];
      const output = { category: 'general', evidence, sweeteners: 'unknown', sweetenerEvidence: [] };
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
    } catch (cause) { error = cause; throw cause; }
  }
}] }));
const product = { name: 'Synthetic bread', sourceName: 'Open Food Facts', categoryTag: 'en:breads',
  basisUnit: 'g', nutritionPreparation: 'as_sold', ingredients: 'Wheat flour, water', ingredientsNeedsReview: false,
  energyKj: { value: 500, unit: 'kJ', status: 'supplied' },
  nutrients: Object.fromEntries(Object.entries({ energyKcal: 120, sugars: .5, saturatedFat: .5, salt: .1, fibre: 8, protein: 4, fat: 2 }).map(([key, value]) => [key, { value, unit: key === 'energyKcal' ? 'kcal' : 'g', status: 'supplied' }])) };
// This unfamiliar identity has complete nutrients but needs grounded category
// interpretation, so the AI/quota exercise must use it rather than ordinary bread.
const unresolvedProduct = { ...product, name: 'Khobz', categoryTag: undefined };
const send = (p = product, authorization = `Bearer ${token}`) => mf.dispatchFetch('https://nudge.example/v1/products/score', {
  method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ product: p })
});
try {
  assert.equal((await send(product, 'Bearer invalid')).status, 401); assert.equal(calls, 0);
  const bindings = await mf.getBindings(), quota = bindings.LABEL_QUOTA.get(bindings.LABEL_QUOTA.idFromName('private-owner'));
  const quotaStatus = async () => (await (await quota.fetch('https://quota/status', {
    method: 'POST', body: JSON.stringify({ subject: null })
  })).json());
  const beforeLocal = await quotaStatus();
  const local = await send(); assert.equal(local.status, 200);
  const localResult = await local.json();
  assert.equal(localResult.score.grade, 'A'); assert.equal(localResult.score.value, 100);
  assert.equal(calls, 0, 'Supported facts use the fixed calculator without model calls');
  assert.deepEqual(await quotaStatus(), beforeLocal, 'Local calculation does not consume AI quota');
  const riceFixture=JSON.parse(readFileSync(new URL('../test/fixtures/off-brown-basmati-rice.json',import.meta.url),'utf8'));
  const rice=catalogueRecordFromPayload({product:riceFixture.product},riceFixture.product.code,Date.now()).product;
  const riceResponse=await send(rice);assert.equal(riceResponse.status,200);
  const riceResult=await riceResponse.json();assert.equal(riceResult.score.value,100);assert.equal(riceResult.score.grade,'A');
  assert.equal(riceResult.score.category,'general');assert.equal(riceResult.score.rawScore,-1);
  assert.equal(riceResult.score.classifierVersion,ScoreCore.CLASSIFIER_VERSION);
  assert.equal(calls,0,'Complete rice ingredients resolve locally without an AI call');
  assert.deepEqual(await quotaStatus(),beforeLocal,'Rice scoring does not consume AI quota');
  const first = send(unresolvedProduct);
  await Promise.race([started, first.then(async r => { throw error || new Error(`Failed before upstream: ${r.status}`); })]);
  assert.equal((await send(unresolvedProduct)).status, 429, 'Duplicate in-flight recovery shares admission');
  const duringRecovery = await quotaStatus();
  assert.equal((await send()).status, 200, 'Deterministic scores remain available while AI holds its lease');
  assert.deepEqual(await quotaStatus(), duringRecovery, 'Local scoring cannot alter the active AI lease or quota');
  const admission = await quota.fetch('https://quota/acquire', { method: 'POST', body: JSON.stringify({ lease: 'other-feature' }) });
  assert.equal((await admission.json()).allowed, false, 'Photos and scores share the existing lease');
  release(); const response = await first; assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.score.grade, 'A'); assert.equal(result.score.rawScore, -5);
  assert.equal(result.score.value, 100); assert.equal(result.score.methodId, 'nudge_nutrition_v0_3'); assert.equal(result.score.version, '0.3');
  assert.equal(result.score.baseFrequency, null); assert.equal(result.score.finalFrequency, null); assert.equal(result.score.frequencyStatus, 'not_provided');
  const count = calls; assert.equal(count, 1, 'Recovery uses one category call and no explanation call');
  const cached = await send(unresolvedProduct); assert.equal(cached.status, 200); assert.deepEqual(await cached.json(), result); assert.equal(calls, count);
  assert.equal((await send(unresolvedProduct, 'Bearer invalid')).status, 401); assert.equal(calls, count, 'Cache never bypasses authentication');
  const incomplete = structuredClone(product); incomplete.nutrients.fibre = { value: null, unit: 'g', status: 'unknown' };
  const missing = await send(incomplete); assert.equal(missing.status, 200);
  const unscored = (await missing.json()).score;
  assert.equal(unscored.status, 'unrated'); assert.equal(unscored.value, null); assert.equal(unscored.grade, null); assert.equal(unscored.inputs.fibre, null);
  assert.equal(unscored.baseFrequency, null); assert.equal(unscored.finalFrequency, null);
  assert.ok(unscored.missingInputs.includes('fibre'));
  const noPlantShare = structuredClone(product); noPlantShare.ingredientsNeedsReview = true;
  const beforeProvisional = await quotaStatus(), callsBeforeProvisional = calls;
  const provisional = (await (await send(noPlantShare)).json()).score;
  assert.equal(provisional.status, 'unrated'); assert.equal(provisional.value, null); assert.equal(provisional.grade, null);
  assert.equal(provisional.inputs.fvlPercent, null); assert.ok(provisional.missingInputs.some(value=>/fruit, vegetable and legume percentage/.test(value)));
  assert.equal(calls, callsBeforeProvisional, 'A model cannot invent a missing plant share');
  const repeatedMissing=(await (await send(noPlantShare)).json()).score;
  assert.equal(repeatedMissing.status,'unrated');assert.equal(calls,callsBeforeProvisional,'Repeated incomplete facts do not spend AI quota');
  assert.deepEqual(await quotaStatus(), beforeProvisional);
  const changedCalls = calls;
  assert.equal((await send({ ...product, diary: 'must not pass' })).status, 400); assert.equal(calls, changedCalls);
  const after = await quota.fetch('https://quota/acquire', { method: 'POST', body: JSON.stringify({ lease: 'after-score' }) });
  assert.equal((await after.json()).allowed, true, 'Finished scoring releases its lease');
  await quota.fetch('https://quota/release', { method: 'POST', body: JSON.stringify({ lease: 'after-score' }) });
  if (error) throw error;
  console.log('PASS: Cloudflare score route, zero-AI/quota deterministic scores, strict one-call category recovery, fixed v0.3 grade display, SQLite cache, authenticated cache hit, shared concurrent admission, local scoring during busy AI lease, lease release, missing-essential/FVL blocking without repeated AI, no frequency prescription and rejected private fields. No external API calls.');
} finally { release?.(); await mf.dispose(); }
