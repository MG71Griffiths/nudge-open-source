import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {ScoreCore} from '../src/nutrition-core.js';
import worker, { nutrientKeys, PHOTO_ANALYSIS_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS, VOICE_ANALYSIS_TIMEOUT_MS } from '../src/worker.js';

const token = '91'.repeat(32), empty = () => Object.fromEntries(nutrientKeys.map(key => [key, null]));
const photo = { mimeType: 'image/jpeg', imageBase64: readFileSync(new URL('./fixtures/blank.jpg', import.meta.url)).toString('base64') };
const base = () => ({ type: 'unknown', photoConsistency: 'sameMeal', meal: null, metadata: null,
  productName: null, brand: null, servingSuggestion: null, categoryTag: null, retailer: null,
  labelKind: 'unreadable', ingredients: null, basis: 'unknown', energyKj: null, nutritionPreparation: 'unknown',
  servingSize: null, needsClearerPhoto: true, message: '', nutrients: empty() });
const component = (name = 'carrot', amountGrams = 80, preparation = 'raw') => ({
  name, amountGrams, preparation, evidence: `Visible ${name}`, photoIndex: 1, assumptions: ['One proposed serving.']
});
const meal = (components = [component()]) => ({ ...base(), type: 'meal', needsClearerPhoto: false,
  meal: { name: 'Visible foreground food', basis: 'perPortion', estimated: true, needsReview: true,
    portionMode: 'estimated_serving', subject: { kind: 'plated_meal', description: 'One foreground plate', photoIndex: 1 },
    portionAmbiguity: { requiresSelection: false, reason: 'Editable portion estimate.' },
    ingredients: components.map(c => ({ name: c.name, evidence: c.evidence })), plants: [], components,
    portion: { label: '1 portion', amount: components.reduce((sum, c) => sum + c.amountGrams, 0), unit: 'g', source: 'estimated' },
    nutrients: empty(), message: '' } });
const envelope = value => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
function setup(values, requestBody = { images: [photo] }) {
  const admissions = [], calls = [];
  const env = { OPENAI_API_KEY: 'offline-test-secret-marker', OPENAI_MODEL: 'gpt-4.1-mini',
    PRIVATE_ACCESS_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
    LABEL_QUOTA: { idFromName: name => name, get: () => ({ fetch: async (url, init) => {
      admissions.push({ url, body: JSON.parse(init.body) }); return Response.json({ allowed: true });
    } }) } };
  mock.method(globalThis, 'fetch', async (_url, init) => {
    calls.push(init); const next = values[Math.min(calls.length - 1, values.length - 1)];
    return typeof next === 'function' ? next(init) : next instanceof Response ? next : envelope(next);
  });
  const run = async () => {
    const response = await worker.fetch(new Request('https://nudge.example/v1/nutrition-label/analyse', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody)
    }), env);
    return { status: response.status, ...await response.json() };
  };
  return { run, calls, admissions };
}
afterEach(() => { mock.restoreAll(); mock.timers.reset(); });

describe('bounded automatic food observation recheck', () => {
  it('rechecks unknown screenshot evidence once, with the original pixels and one admitted request', async () => {
    const { run, calls, admissions } = setup([base(), meal()]); const result = await run();
    assert.equal(result.status, 200); assert.equal(result.extraction.type, 'meal');
    assert.equal(result.trace.automaticRecheck, true); assert.equal(result.trace.upstreamCallCount, 2);
    assert.equal(result.trace.transcriptionMs, 0);
    for (const key of ['observationMs', 'recheckMs']) {
      assert.equal(Number.isSafeInteger(result.trace[key]), true);
      assert.ok(result.trace[key] >= 0 && result.trace[key] <= result.trace.elapsedMs);
    }
    assert.equal(result.trace.recheckReason, 'subject_unknown'); assert.equal(result.trace.recheckOutcome, 'recovered');
    assert.equal(result.trace.subjectStatus, 'unidentified'); assert.equal(result.trace.scoreReadiness, 'available');
    assert.equal(calls.length, 2); assert.equal(calls[0].signal, calls[1].signal);
    const first = JSON.parse(calls[0].body), second = JSON.parse(calls[1].body);
    assert.deepEqual(first.input, second.input); assert.equal(second.store, false); assert.equal(second.model, 'gpt-4.1-mini');
    assert.equal(second.text.format.strict, true); assert.match(first.instructions, /photograph inside a screenshot/);
    assert.match(second.instructions, /Never copy those displayed claims or numbers/);
    assert.match(second.instructions, /single automatic second check/);
    assert.equal(admissions.filter(a => a.url.endsWith('/acquire')).length, 1);
    assert.equal(admissions.filter(a => a.url.endsWith('/release')).length, 1);
    assert.doesNotMatch(JSON.stringify(result.trace), /carrot|foreground plate|offline-test-secret-marker|base64,|imageBase64/);
  });
  it('runs offline source recovery and verifies score readiness before spending on another image call', async () => {
    const { run, calls } = setup([meal()]); const result = await run();
    assert.equal(result.status, 200); assert.equal(result.trace.scoreReadiness, 'available');
    assert.equal(result.trace.recheckOutcome, 'not_needed'); assert.equal(calls.length, 1);
    assert.equal(result.extraction.meal.components[0].sourceRecord.basis, 'per100g');
    assert.equal(typeof result.extraction.meal.nutrients.energyKcal.value, 'number');
  });
  it('recovers ordinary unmatched component names from whole source rows without a second paid call', async () => {
    const observed = [component('red onion', 30, 'cooked'), component('parsley', 3, 'raw'),
      component('lime wedge', 10, 'raw'), component('egg', 30, 'scrambled and cooked')];
    const { run, calls } = setup([meal(observed)]); const result = await run();
    assert.equal(result.status, 200); assert.equal(calls.length, 1);
    assert.equal(result.trace.scoreReadiness, 'available'); assert.equal(result.trace.recheckOutcome, 'not_needed');
    const actual = result.extraction.meal.components;
    assert.deepEqual(actual.map(c => c.amountGrams), [30, 3, 10, 30]);
    assert.deepEqual(actual.map(c => c.name), observed.map(c => c.name));
    assert.ok(actual.every(c => c.recordId === c.sourceRecord?.id && c.sourceRecord?.basis === 'per100g'));
    assert.match(actual[3].sourceRecord.name, /cooked, scrambled/);
    assert.doesNotMatch(actual[3].sourceRecord.name, /raw|duck|quail|turkey/i);
    assert.equal(typeof result.extraction.meal.nutrients.energyKcal.value, 'number');
    assert.equal(typeof result.extraction.meal.nutrients.protein.value, 'number');
    assert.equal(typeof result.extraction.meal.nutrients.fibre.value, 'number');
    assert.doesNotMatch(JSON.stringify(result.trace), /parsley|onion|lime|scrambled|usda:/);
  });
  // Synthetic observation contract reproducing the live mixed-meal proportions,
  // not retained provider content or a claim about the actual food's recipe.
  const meatGreensAndEgg = () => meal([
    component('minced meat', 100, 'cooked stir-fried'),
    component('leafy greens', 50, 'cooked stir-fried'),
    component('egg', 30, 'scrambled cooked')
  ]);
  it('keeps a fully sourced meat-predominant mixed meal scoreable without a needless second observation', async () => {
    const { run, calls, admissions } = setup([meatGreensAndEgg()]); const result = await run();
    assert.equal(result.status, 200); assert.equal(calls.length, 1);
    assert.equal(result.trace.calculationStatus, 'composition_matched');
    assert.equal(result.trace.scoreReadiness, 'available'); assert.equal(result.trace.recheckOutcome, 'not_needed');
    assert.equal(result.trace.automaticRecheck, false);
    const actual = result.extraction.meal, score = globalThis.NudgeMealScore.calculate(actual);
    assert.deepEqual(actual.components.map(c => c.amountGrams), [100, 50, 30]);
    assert.deepEqual(actual.components.map(c => c.recordId), ['usda:171799', 'usda:168463', 'usda:172187']);
    assert.equal(actual.portion.amount, 180); assert.equal(score.available, true);
    assert.ok(score.value >= 0 && score.value <= 100);
    assert.equal(score.methodVersion, ScoreCore.SCORE_VERSION);
    for (const key of ['energyKcal', 'protein', 'fibre']) assert.equal(typeof actual.nutrients[key].value, 'number');
    assert.ok(actual.components[0].recovery.assumptions.some(a => /species.*unknown/.test(a)), 'A generic meat source does not identify its species');
    assert.equal(admissions.filter(a => a.url.endsWith('/acquire')).length, 1);
    assert.doesNotMatch(JSON.stringify(result.trace), /minced|leafy|egg|usda:/);
  });
  it('completes unknown-to-mixed-meal recovery with nutrition and an available score after at most two calls', async () => {
    const { run, calls, admissions } = setup([base(), meatGreensAndEgg()]); const result = await run();
    assert.equal(result.status, 200); assert.equal(calls.length, 2);
    assert.equal(result.extraction.type, 'meal'); assert.equal(result.trace.recheckReason, 'subject_unknown');
    assert.equal(result.trace.recheckOutcome, 'recovered'); assert.equal(result.trace.scoreReadiness, 'available');
    assert.equal(result.trace.calculationStatus, 'composition_matched');
    assert.deepEqual(result.extraction.meal.components.map(c => c.amountGrams), [100, 50, 30]);
    assert.equal(admissions.filter(a => a.url.endsWith('/acquire')).length, 1);
    assert.equal(admissions.filter(a => a.url.endsWith('/release')).length, 1);
  });
  it('uses supported food-specific score rules for homogeneous sources without repeated vision calls', async () => {
    for (const observed of [component('minced meat', 100, 'cooked stir-fried'),
      component('cheese', 30, 'raw'), component('olive oil', 10, 'raw')]) {
      const { run, calls } = setup([meal([observed])]); const result = await run();
      assert.equal(result.status, 200); assert.equal(calls.length, 1, observed.name);
      assert.equal(result.trace.scoreReadiness, 'available', observed.name);
      assert.equal(result.trace.recheckOutcome, 'not_needed');
      const score = globalThis.NudgeMealScore.calculate(result.extraction.meal);
      assert.equal(score.available, true); assert.ok(Number.isInteger(score.value));
      if (observed.name === 'minced meat') assert.ok(score.components.positive.find(p => p.id === 'protein').pointsUpper <= 2,
        'A homogeneous red-meat source uses its food-specific protein cap');
      assert.ok(score.band); assert.match(score.grade, /^[A-E]$/); assert.equal(score.finalFrequency,null);
      assert.equal(result.extraction.meal.components[0].amountGrams, observed.amountGrams);
      mock.restoreAll();
    }
  });
  it('allows one fresh valid observation after semantic validation failed without weakening the validator', async () => {
    const invalid = meal(); invalid.meal.components[0].photoIndex = 4;
    const { run, calls } = setup([invalid, meal()]); const result = await run();
    assert.equal(result.status, 200); assert.equal(calls.length, 2);
    assert.equal(result.trace.recheckReason, 'validation_invalid'); assert.equal(result.trace.recheckOutcome, 'recovered');
    assert.equal(result.trace.validationIssue, 'photo_reference');
    assert.equal(result.extraction.meal.components[0].photoIndex, 1);
  });
  it('keeps unresolved evidence unknown after two attempts and never loops', async () => {
    const value = { ...base(), photoConsistency: 'uncertain' };
    const { run, calls } = setup([value]); const result = await run();
    assert.equal(result.status, 200); assert.equal(result.extraction.type, 'unknown'); assert.equal(calls.length, 2);
    assert.equal(result.trace.subjectStatus, 'uncertain'); assert.equal(result.trace.recheckOutcome, 'no_improvement');
    assert.ok(Object.values(result.extraction.nutrients).every(n => n === null));
  });
  it('does not retry authentication, throttling, refusal, invalid envelope or malformed JSON', async () => {
    for (const fixture of [Response.json({}, { status: 401 }), Response.json({}, { status: 429 }),
      Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] }),
      Response.json({ status: 'completed', output: [] }),
      Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{' }] }] })]) {
      const { run, calls } = setup([fixture]); const result = await run();
      assert.ok(result.status >= 400); assert.equal(calls.length, 1); assert.equal(result.trace.automaticRecheck, false);
      mock.restoreAll();
    }
  });
  it('retains a valid first meal when the recheck fails or supplies unrelated product evidence', async () => {
    for (const second of [() => { throw new Error('network'); }, () => Response.json({}, { status: 401 }), base()]) {
      const first = meal([component('unidentified food', 90, 'unknown')]);
      const { run, calls } = setup([first, second]); const result = await run();
      assert.equal(result.status, 200); assert.equal(result.extraction.type, 'meal'); assert.equal(calls.length, 2);
      assert.equal(result.extraction.meal.components[0].name, 'unidentified food');
      assert.equal(result.extraction.meal.components[0].amountGrams, 90);
      assert.equal(result.extraction.meal.nutrients.energyKcal.value, null);
      assert.equal(result.trace.scoreReadiness, 'missing_components');
      mock.restoreAll();
    }
  });
  it('retains a valid first meal on shared-deadline expiry during the recheck', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { run, calls } = setup([meal([component('unidentified food')]), init => {
      mock.timers.tick(PHOTO_ANALYSIS_TIMEOUT_MS+1); init.signal.throwIfAborted();
    }]);
    const result = await run();
    assert.equal(result.status, 200); assert.equal(calls.length, 2);
    assert.equal(result.trace.recheckOutcome, 'failed'); assert.equal(result.extraction.type, 'meal');
  });
  it('does not start a second request without enough deadline remaining', async () => {
    let clock = 1_000; mock.method(performance, 'now', () => clock);
    const { run, calls } = setup([() => { clock += PHOTO_ANALYSIS_TIMEOUT_MS-7000; return envelope(base()); }]); const result = await run();
    assert.equal(result.status, 200); assert.equal(calls.length, 1);
    assert.equal(result.trace.recheckOutcome, 'skipped_deadline'); assert.equal(result.trace.automaticRecheck, false);
  });
  it('allows a photo response past 30 seconds within one bounded 45-second request', async () => {
    assert.equal(PHOTO_ANALYSIS_TIMEOUT_MS,45_000);assert.equal(VOICE_ANALYSIS_TIMEOUT_MS,45_000);assert.equal(UPSTREAM_TIMEOUT_MS,30_000);
    mock.timers.enable({apis:['setTimeout']});
    const {run,calls}=setup([init=>{mock.timers.tick(31_000);init.signal.throwIfAborted();return envelope(meal());}]);
    const result=await run();assert.equal(result.status,200);assert.equal(calls.length,1);assert.equal(result.trace.backendDeadlineMs,45_000);
  });
  it('keeps legacy label-only repair product-only and does not spend on a meal recheck', async () => {
    const { run, calls } = setup([base()], photo); const result = await run();
    assert.equal(result.status, 200); assert.equal(calls.length, 1); assert.equal(result.trace.recheckOutcome, 'skipped_legacy');
  });
  it('does not convert previously identified unreadable packaging into a meal estimate on recheck', async () => {
    const first = { ...base(), type: 'product', photoConsistency: 'sameProduct' };
    const { run, calls } = setup([first, meal()]); const result = await run();
    assert.equal(result.status, 200); assert.equal(result.extraction.type, 'unknown');
    assert.equal(result.extraction.meal, null); assert.equal(calls.length, 2);
    assert.match(JSON.parse(calls[1].body).instructions, /Recheck packaging only/);
    assert.equal(result.trace.recheckOutcome, 'no_improvement');
  });
  it('does not re-observe merely to fill unknown negative nutrients in an exact source row', async () => {
    const { run, calls } = setup([meal([component('Rice, white, long grain, boiled in unsalted water', 150, 'boiled')])]);
    const result = await run(); assert.equal(result.status, 200); assert.equal(calls.length, 1);
    assert.equal(result.trace.scoreReadiness, 'estimated_rough'); assert.equal(result.trace.scoreBasis, 'food_pattern'); assert.equal(result.trace.recheckOutcome, 'not_needed');
    assert.equal(result.extraction.meal.components[0].sourceRecord.nutrients.sugars.value, null);
    const rough = globalThis.NudgeMealScore.calculate(result.extraction.meal);
    assert.equal(rough.label, 'Rough estimate'); assert.equal(rough.confidence, 'low'); assert.ok(rough.missingInputs.includes('sugars'));
    assert.equal(globalThis.NudgeMealScore.calculateDetailed(result.extraction.meal).available, false);
  });
  it('diagnoses missing fat-profile source values as nutrient gaps without another image call', async () => {
    const recover = globalThis.NudgeMealRecovery.recover;
    for (const value of [null, 0]) {
      // Isolate a source-data gap at the recovery boundary. Vision cannot repair
      // missing total fat or a source row reporting zero total fat for oil.
      mock.method(globalThis.NudgeMealRecovery, 'recover', (...args) => {
        const result = structuredClone(recover(...args));
        const nutrient = { value, unit: 'g', status: value === null ? 'unknown' : 'composition_estimate' };
        result.components[0].sourceRecord.nutrients.fat = nutrient;
        result.components[0].nutrients.fat = nutrient;
        result.nutrients = globalThis.NudgeComposition.total(result.components);
        return result;
      });
      const { run, calls } = setup([meal([component('olive oil', 10, 'raw')])]); const result = await run();
      assert.equal(result.status, 200); assert.equal(calls.length, 1);
      assert.equal(result.trace.calculationStatus, 'composition_matched');
      assert.equal(result.trace.scoreReadiness, 'estimated_rough'); assert.equal(result.trace.scoreBasis, 'food_pattern'); assert.equal(result.trace.recheckOutcome, 'not_needed');
      assert.equal(result.extraction.meal.components[0].sourceRecord.nutrients.fat.value, value);
      assert.equal(globalThis.NudgeMealScore.calculateDetailed(result.extraction.meal).available, false);
      assert.equal(globalThis.NudgeMealScore.calculate(result.extraction.meal).status, 'estimated_rough');
      mock.restoreAll();
    }
  });
  it('can resolve an identity on a second observation while preserving all first-pass quantities and selected records', async () => {
    const first = meal([component('spinach', 30), component('unidentified food', 80, 'unknown')]);
    const second = meal([component('cucumber', 30), component('carrot', 80)]);
    assert.equal(globalThis.NudgeMealScore.calculate(first.meal).status, 'estimated_rough');
    assert.equal(globalThis.NudgeMealScore.calculateDetailed(first.meal).available, false);
    const { run, calls } = setup([first, second]); const result = await run();
    assert.equal(calls.length, 2, 'An available rough fallback does not block bounded detailed-source recovery');
    assert.equal(result.trace.recheckOutcome, 'recovered'); assert.equal(result.trace.scoreReadiness, 'available');
    assert.equal(result.extraction.meal.components[0].name, 'spinach');
    assert.equal(result.extraction.meal.components[1].name, 'carrot');
    assert.equal(result.extraction.meal.components[1].recheckOriginal.name, 'unidentified food');
    assert.deepEqual(result.extraction.meal.components.map(c => c.amountGrams), [30, 80]);
    assert.equal(result.extraction.meal.portion.amount, 110);
  });
  it('can recover an empty initial component list for the same foreground subject', async () => {
    const first = meal([]); first.meal.portion.amount = null; first.meal.portion.unit = null;
    const { run } = setup([first, meal()]); const result = await run();
    assert.equal(result.status, 200); assert.equal(result.trace.recheckOutcome, 'recovered');
    assert.equal(result.extraction.meal.components.length, 1); assert.equal(result.trace.scoreReadiness, 'available');
  });
  it('rejects apparent recheck improvement caused by dropping food, changing weights or wrong photo references', async () => {
    for (const second of [meal([component('carrot', 110)]), meal([component('carrot', 31), component('carrot', 80)]),
      meal([component('carrot', 30), { ...component('carrot', 80), photoIndex: 2 }])]) {
      const { run } = setup([meal([component('spinach', 30), component('unidentified food', 80, 'unknown')]), second]);
      const result = await run(); assert.equal(result.status, 200);
      assert.equal(result.extraction.meal.components.length, 2);
      assert.equal(result.extraction.meal.components[1].recordId, null);
      assert.deepEqual(result.extraction.meal.components.map(c => c.amountGrams), [30, 80]);
      mock.restoreAll();
    }
  });
});

describe('explicit fast capture policy',()=>{
  it('requests and expands the compact unknown observation through the existing validated public result',async()=>{
    const compact={version:1,type:'unknown',metadata:null,photoConsistency:'sameMeal',needsClearerPhoto:true,message:'',product:null,meal:null};
    const {run,calls}=setup([compact],{images:[photo],analysisPolicy:{version:1,mode:'fast'}}),result=await run();
    assert.equal(result.status,200);assert.equal(result.extraction.type,'unknown');assert.equal(calls.length,1);
    assert.equal(result.trace.observationSchema,'compact_photo_v3');
    const request=JSON.parse(calls[0].body);assert.equal(request.text.format.strict,true);
    assert.deepEqual(request.text.format.schema.properties.version.enum,[3]);assert.equal(request.text.format.schema.properties.product.anyOf[0].properties.nutrients.required.length,8);
    assert.equal(Object.hasOwn(request.text.format.schema.properties.meal.anyOf[0].properties,'nutrients'),false);
    assert.ok(Object.values(result.extraction.nutrients).every(value=>value===null));
  });
  it('returns a complete labelled v2 Curry estimate and deterministic rating in one worker observation',async()=>{
    const estimate={version:1,basis:'perPortion',portionGrams:350,category:'general',fvlPercent:30,
      nutrients:{energyKcal:450,protein:15,carbohydrate:50,sugars:8,fat:20,saturatedFat:4,fibre:9,salt:1.5},
      assumptions:['Synthetic typical serving with assumed oil and seasoning.','General mixed meal; qualifying plants estimated 30%.']};
    const observed=meal([component('curry',null,'cooked; recipe unknown')]);observed.meal.name='Curry';
    const compact={version:2,type:'meal',metadata:null,photoConsistency:'sameMeal',needsClearerPhoto:false,message:'Estimated one serving.',product:null,
      meal:{...Object.fromEntries(Object.entries(observed.meal).filter(([key])=>!['basis','estimated','needsReview','message','nutrients'].includes(key))),
        portion:{label:'1 portion',amount:null,unit:null,source:'estimated'},recipeEvidence:null,qualityEstimate:null,nutrientEstimate:estimate}};
    const {run,calls,admissions}=setup([compact,meal()],{images:[photo],analysisPolicy:{version:1,mode:'fast'}}),result=await run();
    assert.equal(result.status,200);assert.equal(result.extraction.type,'meal');assert.equal(calls.length,1);
    assert.equal(result.trace.observationSchema,'compact_photo_v3');assert.equal(result.trace.promptVersion,'photo-estimate-2026-10-20-v3');
    assert.equal(result.trace.scoreReadiness,'available');assert.equal(result.trace.scoreBasis,'model_nutrient_estimate');
    assert.equal(result.trace.automaticRecheck,false);assert.equal(result.trace.recheckOutcome,'not_needed');assert.equal(result.trace.upstreamCallCount,1);assert.equal(result.trace.usage.callCount,1);
    assert.equal(admissions.filter(a=>a.url.endsWith('/acquire')).length,1);assert.equal(admissions.filter(a=>a.url.endsWith('/release')).length,1);
    const output=result.extraction.meal;assert.equal(output.components[0].amountGrams,null);assert.equal(output.components[0].recordId,null);assert.equal(output.components[0].sourceRecord,null);
    for(const key of nutrientKeys){assert.equal(output.nutrients[key].value,estimate.nutrients[key]);assert.equal(output.nutrients[key].unit,key==='energyKcal'?'kcal':'g');assert.equal(output.nutrients[key].source,'model_photo_estimate');assert.equal(output.nutrients[key].status,'estimated');}
    // The worker returns evidence, not a model-provided score. Its public result
    // must produce the same deterministic rating in the shared app calculator.
    const scored=globalThis.NudgeMealScore.calculate(output);assert.equal(scored.available,true);assert.equal(scored.scoreBasis,'model_nutrient_estimate');assert.equal(scored.estimated,true);assert.equal(globalThis.NudgeMealScore.validResult(scored),true);
    assert.equal(globalThis.NudgeMealScore.calculate({...output,score:100,grade:'A'}).value,scored.value);
    const payload=JSON.parse(calls[0].body);assert.deepEqual(payload.text.format.schema.properties.version.enum,[3]);assert.ok(payload.instructions.length<5000);
    assert.doesNotMatch(JSON.stringify(result.trace),/Curry|curry|seasoning|offline-test-secret-marker|imageBase64/);
  });
  it('expands a minimal v3 named food estimate and linked ingredient suggestions in one observation',async()=>{
    const compact={version:3,type:'meal',photoConsistency:'sameMeal',product:null,meal:{
      name:'Zhingalov hats',subjectKind:'plated_meal',
      components:[{name:'Zhingalov hats',preparation:'cooked',amountGrams:null,photoIndex:1,evidence:'Visible filled flatbread'}],
      plants:[],recipeEvidence:null,nutrientEstimate:{portionGrams:350,category:'general',fvlPercent:30,
        nutrients:[450,15,50,8,20,4,9,1.5],assumptions:['One serving; estimated oil and seasoning.']}}};
    const {run,calls,admissions}=setup([compact,meal()],{images:[photo],analysisPolicy:{version:1,mode:'fast'}}),result=await run();
    assert.equal(result.status,200);assert.equal(calls.length,1);assert.equal(result.trace.upstreamCallCount,1);
    assert.equal(result.trace.observationSchema,'compact_photo_v3');assert.equal(result.trace.promptVersion,'photo-estimate-2026-10-20-v3');
    assert.equal(result.trace.scoreReadiness,'available');assert.equal(result.trace.scoreBasis,'model_nutrient_estimate');
    assert.equal(admissions.filter(a=>a.url.endsWith('/acquire')).length,1);
    const output=result.extraction.meal;
    assert.equal(output.subject.kind,'plated_meal');assert.equal(output.subject.photoIndex,1);
    assert.equal(output.components[0].recordId,null);assert.equal(output.components[0].amountGrams,null);
    assert.equal(output.ingredients[0].name,'zhingalov hats');assert.deepEqual(output.plants,[]);
    for(const [i,key] of nutrientKeys.entries())assert.equal(output.nutrients[key].value,compact.meal.nutrientEstimate.nutrients[i]);
  });
  for(const [label,first,expectedStatus] of [
    ['unknown subject',base(),200],['unmatched food',meal([component('unidentified food')]),200],
    ['invalid photo evidence',(()=>{const value=meal();value.meal.components[0].photoIndex=4;return value;})(),502]
  ])it(`never automatically rechecks ${label}`,async()=>{
    const {run,calls}=setup([first,meal()],{images:[photo],analysisPolicy:{version:1,mode:'fast'}});
    const result=await run();assert.equal(result.status,expectedStatus);assert.equal(calls.length,1);
    assert.equal(result.trace.automaticRecheck,false);assert.equal(result.trace.recheckOutcome,'skipped_fast_policy');
    assert.equal(result.trace.analysisPolicy,'fast_v1');assert.equal(result.trace.usage.callCount,1);
    assert.equal(result.trace.usage.status,'unavailable');assert.equal(result.trace.usage.totals.totalTokens,null);
    if(expectedStatus===200)assert.equal(result.extraction.type,first.type);
    else assert.equal(result.code,'upstream_invalid_response');
  });
  it('keeps provider usage even when completed JSON fails semantic validation',async()=>{
    const invalid=meal();invalid.meal.components[0].photoIndex=4;
    const payload={status:'completed',model:'gpt-4.1-mini-2025-04-14',
      usage:{input_tokens:1000,input_tokens_details:{cached_tokens:200,cache_write_tokens:0},output_tokens:100,output_tokens_details:{reasoning_tokens:40},total_tokens:1100},
      output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(invalid)}]}]};
    const {run}=setup([Response.json(payload,{headers:{'x-request-id':'req_synthetic_test'}})],{images:[photo],analysisPolicy:{version:1,mode:'fast'}});
    const result=await run();assert.equal(result.status,502);assert.equal(result.trace.usage.status,'reported');
    assert.equal(result.trace.usage.totals.estimatedCostMicrousd,500);assert.equal(result.trace.usage.totals.reasoningTokens,40);
    assert.equal(result.trace.usage.calls[0].providerRequestId,'req_synthetic_test');
    assert.doesNotMatch(JSON.stringify(result.trace),/Visible|foreground|offline-test-secret|imageBase64/);
  });
  it('keeps incomplete response usage and never treats an HTTP200 as a successful analysis',async()=>{
    const {run,calls}=setup([Response.json({status:'incomplete',usage:{input_tokens:10,output_tokens:20,total_tokens:30},output:[]})],
      {images:[photo],analysisPolicy:{version:1,mode:'fast'}});
    const result=await run();assert.equal(result.status,502);assert.equal(result.code,'upstream_incomplete');assert.equal(calls.length,1);
    assert.equal(result.trace.usage.calls[0].outcome,'incomplete');assert.equal(result.trace.usage.totals.totalTokens,30);
  });
});
