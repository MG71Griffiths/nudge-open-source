import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker, { extractionSchema, nutrientKeys, validateExtraction } from '../src/worker.js';

const nutrients = () => Object.fromEntries(nutrientKeys.map(key => [key,
  key === 'energyKcal' ? { value: 80, unit: 'kcal' } : key === 'protein' ? { value: 2, unit: 'g' } : null]));
const legacy = () => ({ type: 'product', meal: null, productName: null, brand: null, photoConsistency: 'sameProduct',
  servingSuggestion: null, categoryTag: null, retailer: null, labelKind: 'nutrition', ingredients: null,
  basis: 'per100g', servingSize: null, needsClearerPhoto: false, message: '', nutrients: nutrients() });
const printed = () => ({ ...legacy(), energyKj: { value: 335.1, unit: 'kJ' }, nutritionPreparation: 'as_sold' });
afterEach(() => mock.restoreAll());

describe('additive printed scoring evidence', () => {
  it('retains independently printed kJ without changing the eight intake nutrients', () => {
    const input = printed(), before = structuredClone(input);
    const result = validateExtraction(input);
    assert.deepEqual(result.energyKj, { value: 335.1, unit: 'kJ' });
    assert.equal(result.nutritionPreparation, 'as_sold');
    assert.deepEqual(result.nutrients, before.nutrients);
    assert.deepEqual(input, before);
    assert.equal(result.nutrients.energyKcal.value, 80, 'No kJ/kcal conversion or replacement');
    assert.deepEqual(Object.keys(extractionSchema.properties.nutrients.properties), nutrientKeys);
    assert.ok(extractionSchema.required.includes('energyKj'));
    assert.ok(extractionSchema.required.includes('nutritionPreparation'));
    assert.equal(extractionSchema.properties.energyKj.anyOf[1].type, 'null');
  });

  it('keeps legacy absence unknown and never derives kJ from existing kcal', () => {
    for (const input of [legacy(), { ...legacy(), energyKj: null }, { ...legacy(), nutritionPreparation: 'prepared' }]) {
      const before = structuredClone(input), result = validateExtraction(input);
      assert.equal(result.energyKj, null);
      assert.equal(result.nutritionPreparation, input.nutritionPreparation ?? 'unknown');
      assert.deepEqual(result.nutrients, before.nutrients);
    }
    const oldKj = legacy(); oldKj.nutrients.energyKcal = { value: 335.1, unit: 'kJ' };
    const result = validateExtraction(oldKj);
    assert.equal(result.energyKj, null, 'Legacy printed energy stays in its original slot');
    assert.deepEqual(result.nutrients.energyKcal, oldKj.nutrients.energyKcal);
  });

  it('keeps the same printed basis and preparation without scaling or equating grams and ml', () => {
    for (const basis of ['per100g', 'per100ml', 'perServing']) {
      for (const preparation of ['as_sold', 'prepared', 'unknown']) {
        const input = { ...printed(), basis, nutritionPreparation: preparation, servingSize: { value: 30, unit: 'g' } };
        const result = validateExtraction(input);
        assert.deepEqual(result.energyKj, input.energyKj);
        assert.equal(result.basis, basis);
        assert.equal(result.nutritionPreparation, preparation);
        assert.deepEqual(result.nutrients, input.nutrients);
      }
    }
  });

  it('rejects malformed, bounded or invented scoring metadata', () => {
    for (const energyKj of [undefined, {}, [], 335, '335', { value: '335', unit: 'kJ' },
      { value: true, unit: 'kJ' }, { value: -1, unit: 'kJ' }, { value: Infinity, unit: 'kJ' },
      { value: NaN, unit: 'kJ' }, { value: 1_000_001, unit: 'kJ' }, { value: 80, unit: 'kcal' },
      { value: 335, unit: 'J' }, { value: 335, unit: 'kj' }, { value: 335, unit: 'kJ', relation: '<' },
      { value: 335, unit: 'kJ', source: 'calculated' }]) {
      assert.throws(() => validateExtraction({ ...printed(), energyKj }), { status: 422, code: 'label_unreadable' });
    }
    for (const nutritionPreparation of [undefined, null, false, 1, '', 'cooked', 'probably_as_sold', {}]) {
      assert.throws(() => validateExtraction({ ...printed(), nutritionPreparation }), { status: 422, code: 'label_unreadable' });
    }
  });

  it('clears scoring evidence for unknown basis, ingredients only, mixed photos and meals', () => {
    for (const input of [
      { ...printed(), basis: 'unknown' },
      { ...printed(), labelKind: 'ingredients', ingredients: { text: 'Oats.', plants: [], needsReview: false } },
      { ...printed(), labelKind: 'unreadable', productName: 'Front only' },
      { ...printed(), photoConsistency: 'uncertain' },
      { ...printed(), type: 'unknown' },
      { ...printed(), type: 'meal', photoConsistency: 'sameMeal', meal: {
        name: 'Meal', ingredients: [], plants: [], portion: { label: '1 portion', amount: null, unit: null, source: 'estimated' },
        basis: 'perPortion', estimated: true, needsReview: true, message: '',
        nutrients: Object.fromEntries(nutrientKeys.map(key => [key, null]))
      } }
    ]) {
      const result = validateExtraction(input, true, true);
      assert.equal(result.energyKj, null);
      assert.equal(result.nutritionPreparation, 'unknown');
    }
  });

  it('requests both printed energy units with fixed no-derivation and preparation rules in the existing photo call', async () => {
    const token = '34'.repeat(32), photo = readFileSync(new URL('./fixtures/blank.jpg', import.meta.url));
    const upstream = mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const payload = JSON.parse(init.body);
      assert.equal(payload.store, false);
      assert.equal(payload.text.format.strict, true);
      assert.deepEqual(payload.text.format.schema, extractionSchema);
      assert.match(payload.instructions, /same product across all photos/);
      assert.match(payload.instructions, /Never derive energyKj from kcal or other nutrients/);
      assert.match(payload.instructions, /including when kcal is also printed/);
      assert.match(payload.instructions, /Never treat an ambiguous cooking or reconstitution table as as_sold/);
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(printed()) }] }] });
    });
    const env = { OPENAI_API_KEY: 'public-test-placeholder', OPENAI_MODEL: 'gpt-4.1-mini',
      PRIVATE_ACCESS_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
      LABEL_QUOTA: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ allowed: true }) }) } };
    const response = await worker.fetch(new Request('https://nudge.example/v1/nutrition-label/analyse', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ images: [{ mimeType: 'image/jpeg', imageBase64: photo.toString('base64') }] })
    }), env);
    assert.equal(response.status, 200);
    const { extraction } = await response.json();
    assert.deepEqual(extraction.energyKj, printed().energyKj);
    assert.equal(extraction.nutritionPreparation, 'as_sold');
    assert.equal(upstream.mock.callCount(), 1);
  });
});
