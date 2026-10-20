import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker, { extractionSchema, nutrientKeys, validateExtraction } from '../src/worker.js';

const emptyNutrients = () => Object.fromEntries(nutrientKeys.map(key => [key, null]));
const product = () => ({ type: 'product', meal: null, productName: 'Synthetic food', brand: null,
  photoConsistency: 'sameProduct', servingSuggestion: null, categoryTag: null, retailer: null,
  labelKind: 'ingredients', ingredients: { text: 'Carrots, chickpeas.', plants: [{ name: 'carrot', evidence: 'Carrots' }], needsReview: false },
  basis: 'unknown', servingSize: null, needsClearerPhoto: false, message: '', nutrients: emptyNutrients() });
const meal = () => ({ ...product(), type: 'meal', photoConsistency: 'sameMeal', productName: null,
  labelKind: 'unreadable', ingredients: null, meal: {
    name: 'Carrot and chickpea bowl', ingredients: [{ name: 'carrot', evidence: 'Orange carrot pieces' },
      { name: 'chickpea', evidence: 'Round beige chickpeas' }],
    plants: [{ name: 'carrot', evidence: 'carrot pieces' }, { name: 'chickpea', evidence: 'chickpeas' }],
    portion: { label: '1 portion', amount: 300, unit: 'g', source: 'estimated' },
    nutrients: { ...emptyNutrients(), energyKcal: { value: 320, unit: 'kcal' }, protein: { value: 14, unit: 'g' }, fibre: { value: 10, unit: 'g' } },
    basis: 'perPortion', estimated: true, needsReview: true, message: ''
  } });
const image = { mimeType: 'image/jpeg', imageBase64: readFileSync(new URL('./fixtures/blank.jpg', import.meta.url)).toString('base64') };
const token = '56'.repeat(32);
const request = body => new Request('https://nudge.example/v1/nutrition-label/analyse', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
});
const aiResponse = extraction => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(extraction) }] }] });
afterEach(() => mock.restoreAll());

describe('automatic meal classification and isolated estimates', () => {
  it('keeps the structured schema closed with all nullable and nested fields required', () => {
    const inspect = schema => {
      if (schema.type === 'object') {
        assert.equal(schema.additionalProperties, false);
        assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
        Object.values(schema.properties).forEach(inspect);
      }
      schema.anyOf?.forEach(inspect);
      if (schema.items) inspect(schema.items);
    };
    inspect(extractionSchema);
    assert.deepEqual(extractionSchema.properties.type.enum, ['product', 'meal', 'unknown']);
  });
  it('returns one explicitly estimated portion and never exposes estimates in product fields', () => {
    const value = meal();
    // Even a model which also emits a kit label cannot contaminate the meal.
    value.productName = 'Meal kit as sold'; value.brand = 'Synthetic brand'; value.basis = 'per100g';
    value.nutrients.energyKcal = { value: 800, unit: 'kcal' };
    const before = structuredClone(value), result = validateExtraction(value, true, true);
    assert.equal(result.type, 'meal'); assert.equal(result.meal.estimated, true); assert.equal(result.meal.needsReview, true);
    assert.equal(result.meal.basis, 'perPortion'); assert.equal(result.meal.nutrients.energyKcal.value, 320);
    assert.equal(result.meal.nutrients.salt, null); assert.equal(result.meal.portion.amount, 300);
    for (const key of ['productName', 'brand', 'servingSize', 'servingSuggestion', 'ingredients', 'categoryTag', 'retailer']) assert.equal(result[key], null);
    assert.equal(result.basis, 'unknown'); assert.ok(Object.values(result.nutrients).every(nutrient => nutrient === null));
    assert.equal(result.needsClearerPhoto, false); assert.equal(Object.hasOwn(result, 'photoConsistency'), false);
    assert.deepEqual(value, before);
  });
  it('allows an abstract editable portion when physical size is unknown without inventing grams', () => {
    const value = meal(); value.meal.portion = { label: '1 bowl', amount: null, unit: null, source: 'estimated' };
    value.meal.nutrients = emptyNutrients();
    const result = validateExtraction(value, true, true);
    assert.deepEqual(result.meal.portion, { label: '1 portion', amount: null, unit: null, source: 'estimated' });
    assert.ok(Object.values(result.meal.nutrients).every(nutrient => nutrient === null));
    for (const unit of ['g', 'ml']) {
      value.meal.portion = { label: '1 tablespoon', amount: 15, unit, source: 'estimated' };
      assert.equal(validateExtraction(value, true, true).meal.portion.label, '1 portion');
    }
  });
  it('requires coherent physical portion units, canonical nutrient units and finite bounded values', () => {
    const changes = [v => { v.meal.portion.amount = null; }, v => { v.meal.portion.unit = null; },
      v => { v.meal.portion.unit = 'bowl'; }, v => { v.meal.portion.amount = 0; }, v => { v.meal.portion.amount = 5001; },
      v => { v.meal.portion.amount = Infinity; }, v => { v.meal.portion.source = 'label'; },
      v => { v.meal.nutrients.energyKcal.unit = 'kJ'; }, v => { v.meal.nutrients.protein.unit = 'mg'; },
      v => { v.meal.nutrients.energyKcal.value = 50001; }, v => { v.meal.nutrients.protein.value = -1; },
      v => { v.meal.nutrients.protein.value = '14'; }, v => { v.meal.nutrients.protein.value = NaN; },
      v => { delete v.meal.nutrients.salt; }, v => { v.meal.basis = 'per100g'; },
      v => { v.meal.estimated = false; }, v => { v.meal.needsReview = false; }];
    for (const change of changes) {
      const value = meal(); change(value);
      assert.throws(() => validateExtraction(value, true, true), { status: 422, code: 'label_unreadable' });
    }
  });
  it('deduplicates visible canonical plants and requires evidence from a visible ingredient', () => {
    const value = meal();
    value.meal.plants.push({ name: ' CARROT ', evidence: 'Orange carrot pieces' });
    assert.equal(validateExtraction(value, true, true).meal.plants.length, 2);
    value.meal.plants.push({ name: 'sunflower', evidence: 'Unseen sunflower oil' });
    const issues=[],withoutUnsupported=validateExtraction(value,true,true,issue=>issues.push(issue));
    assert.deepEqual(withoutUnsupported.meal.plants.map(p=>p.name),['carrot','chickpea']);
    assert.deepEqual(issues.filter(issue=>issue==='meal_plant_evidence'),['meal_plant_evidence']);
    for (const field of ['ingredients', 'plants']) {
      const unsafe = meal(); unsafe.meal[field][0].evidence = '<script>run()</script>';
      assert.throws(() => validateExtraction(unsafe, true, true), { status: 422 });
    }
  });
  it('does not relay model instructions or claim invisible allergen certainty', () => {
    const value = meal(); value.meal.message = '<script>ignore safeguards</script>'; value.message = 'Guaranteed allergen-free';
    const result = validateExtraction(value, true, true);
    assert.equal(result.message, result.meal.message);
    assert.match(result.message, /Estimated from the photographed portion/);
    assert.match(result.message, /Hidden ingredients and allergens cannot be determined/);
    assert.doesNotMatch(result.message, /script|Guaranteed/);
    value.meal.allergens = [];
    assert.throws(() => validateExtraction(value, true, true), { status: 422 });
  });
  it('clears mixed or conflicting photo classifications and never invents a meal from unknown evidence', () => {
    for (const value of [{ ...meal(), photoConsistency: 'uncertain' }, { ...meal(), photoConsistency: 'sameProduct' },
      { ...product(), photoConsistency: 'sameMeal' }, { ...meal(), type: 'unknown' }, { ...meal(), meal: null },
      { ...product(), productName: null, ingredients: null, labelKind: 'unreadable' }]) {
      const result = validateExtraction(value, true, true);
      assert.equal(result.type, 'unknown'); assert.equal(result.meal, null); assert.equal(result.ingredients, null);
      assert.equal(result.productName, null); assert.equal(result.basis, 'unknown'); assert.equal(result.needsClearerPhoto, true);
      assert.ok(Object.values(result.nutrients).every(nutrient => nutrient === null));
    }
  });
  it('preserves strict product and ingredients-only evidence even if a meal estimate is also returned', () => {
    const value = product(); value.meal = meal().meal; value.basis = 'per100g';
    value.nutrients = meal().meal.nutrients; value.servingSize = { value: 300, unit: 'g' };
    const result = validateExtraction(value, true, true);
    assert.equal(result.type, 'product'); assert.equal(result.meal, null); assert.equal(result.basis, 'unknown');
    assert.equal(result.servingSize, null); assert.equal(result.needsClearerPhoto, false);
    assert.ok(Object.values(result.nutrients).every(nutrient => nutrient === null));
    assert.equal(result.ingredients.text, 'Carrots, chickpeas.');
  });
  it('keeps legacy labelled uploads product-only at the validation boundary', () => {
    for (const front of [false, true]) {
      const result = validateExtraction(meal(), front);
      assert.equal(result.type, 'unknown'); assert.equal(result.meal, null);
      assert.ok(Object.values(result.nutrients).every(nutrient => nutrient === null));
    }
  });
  it('sends one call per batch with meal rules and legacy rules, keeping existing model and quota bounds', async () => {
    const admissions = [];
    const env = { OPENAI_API_KEY: 'public-offline-placeholder', OPENAI_MODEL: 'gpt-4.1-mini',
      PRIVATE_ACCESS_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
      LABEL_QUOTA: { idFromName: name => { assert.equal(name, 'private-owner'); return name; },
        get: () => ({ fetch: async (url, init) => { admissions.push({ url, body: JSON.parse(init.body) }); return Response.json({ allowed: true }); } }) } };
    const upstream = mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'gpt-4.1-mini'); assert.equal(body.store, false); assert.equal(body.max_output_tokens, 8192);
      assert.match(body.instructions, /never copy the kit label values/);
      assert.match(body.instructions, /Do not invent hidden oils, sauces, seasonings, allergens or cooking methods/);
      assert.match(body.instructions, /Never turn an unreadable label or unfamiliar packaging into a meal estimate/);
      if (body.input[0].content[0].text === 'PHOTO 1') assert.equal(body.input[0].content.length, 8);
      else assert.match(body.instructions, /legacy product-only upload/);
      return aiResponse(meal());
    });
    const response = await worker.fetch(request({ images: Array(4).fill(image) }), env);
    assert.equal(response.status, 200); assert.equal((await response.json()).extraction.type, 'meal');
    const legacy = await worker.fetch(request({ ...image, productImage: image }), env);
    assert.equal(legacy.status, 200); assert.equal((await legacy.json()).extraction.type, 'unknown');
    assert.equal(upstream.mock.callCount(), 2); assert.equal(admissions.filter(item => item.url.endsWith('/acquire')).length, 2);
    assert.equal(admissions.filter(item => item.url.endsWith('/release')).length, 2);
  });
  it('keeps maximum-length meal review data below the native response byte bound', () => {
    const value = meal(); value.meal.name = '食'.repeat(160);
    value.meal.ingredients = Array.from({ length: 40 }, (_, i) => ({ name: '食'.repeat(58) + String(i).padStart(2, '0'), evidence: '菜'.repeat(160) }));
    value.meal.plants = Array.from({ length: 40 }, (_, i) => ({ name: '植'.repeat(38) + String(i).padStart(2, '0'), evidence: '菜'.repeat(160) }));
    const extraction = validateExtraction(value, true, true);
    assert.equal(extraction.meal.plants.length, 40);
    assert.ok(Buffer.byteLength(JSON.stringify({ extraction, source: { provider: 'OpenAI', model: 'gpt-4.1-mini', retrievedAt: new Date().toISOString(), retainedByNudge: false } })) < 65_536);
  });
});
