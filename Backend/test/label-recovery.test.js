import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker, { nutrientKeys, validateExtraction } from '../src/worker.js';
import { emptyMetadata } from '../src/photo-evidence.js';

const token = '78'.repeat(32);
const env = () => ({ OPENAI_API_KEY: 'private-key-marker', OPENAI_MODEL: 'gpt-4.1-mini',
  PRIVATE_ACCESS_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
  LABEL_QUOTA: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ allowed: true }) }) } });
const jpg = { mimeType: 'image/jpeg', imageBase64: readFileSync(new URL('./fixtures/blank.jpg', import.meta.url)).toString('base64') };
const request = () => new Request('https://nudge.example/v1/nutrition-label/analyse', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ images: [jpg], photoIds: ['d747c1f9-f1f3-4ee1-ac19-e9b23a87cfc1'], captureRevision: 2 })
});
const envelope = extraction => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(extraction) }] }] });
// A controlled fixture based on text visible in IMG_5951; this is not a retained
// provider response or a claim to reproduce its specific unknown failing field.
const cereal = () => ({ type: 'product', meal: null, metadata: { ...emptyMetadata(),
  evidence: [{ id: 'ingredients', field: 'ingredients', photoIndex: 1, region: 'back',
    text: 'Maize (61%), sugar (37%), barley malt extract, salt, niacin, iron, vitamin B6, riboflavin, thiamin, folic acid, vitamin D, vitamin B12.' },
  { id: 'allergens', field: 'allergens', photoIndex: 1, region: 'below ingredients',
    text: 'For allergens see ingredients highlighted in bold. May contain gluten from other cereals, peanuts.' }],
  ingredientTree: [{ id: 'maize', name: 'Maize', parentId: null, percentage: 61, evidenceId: 'ingredients' }],
  allergenWording: { contains: null, mayContain: 'May contain gluten from other cereals, peanuts.', factoryHandling: null } },
  productName: null, brand: null, photoConsistency: 'sameProduct', servingSuggestion: null,
  categoryTag: 'en:breakfast-cereals', retailer: null, labelKind: 'ingredients',
  ingredients: { text: 'Maize (61%), sugar (37%), barley malt extract, salt, niacin, iron, vitamin B6, riboflavin, thiamin, folic acid, vitamin D, vitamin B12.',
    plants: [{ name: 'maize', evidence: 'Maize' }], needsReview: false },
  basis: 'unknown', energyKj: null, nutritionPreparation: 'unknown', servingSize: null,
  needsClearerPhoto: false, message: '', nutrients: Object.fromEntries(nutrientKeys.map(key => [key, null])) });

afterEach(() => mock.restoreAll());
describe('readable label recovery and diagnostic privacy', () => {
  it('keeps the cereal ingredients when optional model wording paraphrases bold allergens or plant names', async () => {
    const input = cereal();
    input.metadata.allergenWording.contains = 'Contains barley.'; // Not printed as this sentence.
    input.metadata.ingredientTree[0].name = 'Corn'; // Canonical synonym is not the quote.
    mock.method(globalThis, 'fetch', async () => Response.json(envelope(input), { headers: { 'x-request-id': 'req_label_fixture' } }));
    const response = await worker.fetch(request(), env()), body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.extraction.ingredients.text, input.ingredients.text);
    assert.equal(body.extraction.labelKind, 'ingredients');
    assert.deepEqual(body.extraction.ingredients.plants, input.ingredients.plants);
    assert.equal(body.extraction.metadata.allergenWording.contains, null);
    assert.equal(body.extraction.metadata.allergenWording.mayContain, input.metadata.allergenWording.mayContain);
    assert.deepEqual(body.extraction.metadata.ingredientTree, []);
    assert.deepEqual(new Set(body.extraction.metadata.missingFields), new Set(['allergens', 'ingredients']));
    assert.ok(Object.values(body.extraction.nutrients).every(value => value === null));
    assert.equal(body.extraction.basis, 'unknown');
    assert.deepEqual(body.trace.normalizationIssues, ['ingredient_tree_evidence', 'allergen_evidence']);
    assert.equal(body.trace.parseStatus, 'validated');
    assert.equal(body.trace.providerRequestId, 'req_label_fixture');
    assert.match(body.trace.requestId, /^[a-f0-9-]{36}$/);
    assert.doesNotMatch(JSON.stringify(body.trace), /private-key-marker|Contains|Maize|barley|ingredients highlighted|Bearer|base64,/);
  });

  it('preserves valid nutrition while omitting unsupported claims, dates, quantity and orphan tree nodes', () => {
    const input = cereal(), issues = [];
    input.labelKind = 'both'; input.basis = 'per100g'; input.nutritionPreparation = 'as_sold';
    input.nutrients.energyKcal = { value: 375, unit: 'kcal' };
    input.nutrients.protein = { value: 5, unit: 'g' };
    input.metadata.claims = [{ text: 'Organic', kind: 'organic', evidenceId: 'missing' }];
    input.metadata.netQuantity = { value: 925, unit: 'g', evidenceId: 'missing' };
    input.metadata.batchCode = 'Not printed';
    input.metadata.dateMarking = 'Not printed';
    input.metadata.ingredientTree.push({ id: 'child', name: 'sugar', parentId: 'missing', percentage: null, evidenceId: 'ingredients' });
    const result = validateExtraction(input, true, true, issue => issues.push(issue));
    assert.deepEqual(result.nutrients, input.nutrients);
    assert.equal(result.metadata.netQuantity, null); assert.equal(result.metadata.batchCode, null); assert.equal(result.metadata.dateMarking, null);
    assert.deepEqual(result.metadata.claims, []);
    assert.equal(result.metadata.ingredientTree.length, 1);
    assert.deepEqual(new Set(issues), new Set(['ingredient_tree_parent', 'claim_evidence', 'quantity_evidence', 'date_evidence']));
  });

  it('retains nutrition conflicts when their evidence link is unsupported', () => {
    const input = cereal(); input.labelKind = 'both'; input.basis = 'per100g';
    input.nutrients.energyKcal = { value: 375, unit: 'kcal' };
    input.metadata.conflicts = [{ field: 'nutrition', description: 'Panels disagree', evidenceIds: ['missing'] }];
    const result = validateExtraction(input, true, true);
    assert.equal(result.basis, 'unknown'); assert.equal(result.nutrients.energyKcal, null);
    assert.equal(result.metadata.conflicts.length, 1); assert.deepEqual(result.metadata.conflicts[0].evidenceIds, []);
  });

  it('returns only fixed validation stages for bad responses, under the native error-body cap', async () => {
    const fetch = mock.method(globalThis, 'fetch');
    const cases = [
      ['not-json private-provider-text', 'output_envelope'],
      ['null', 'output_envelope'],
      [JSON.stringify({ status: 'completed', output: {} }), 'output_shape'],
      [JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [null] }] }), 'output_shape'],
      [JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{private-provider-text' }] }] }), 'output_json'],
      [JSON.stringify(envelope({ ...cereal(), privateProperty: 'private-provider-text' })), 'extraction_shape'],
      [JSON.stringify(envelope({ ...cereal(), metadata: { ...emptyMetadata(), country: '<script>private-provider-text</script>' } })), 'metadata_shape'],
    ];
    const duplicate = cereal(); duplicate.metadata.evidence.push({ ...duplicate.metadata.evidence[0] });
    cases.push([JSON.stringify(envelope(duplicate)), 'evidence_id_duplicate']);
    const missingID=cereal();missingID.metadata.evidence[0].id=' ';cases.push([JSON.stringify(envelope(missingID)),'evidence_id_missing']);
    const missingText=cereal();missingText.metadata.evidence[0].text=' ';cases.push([JSON.stringify(envelope(missingText)),'evidence_text_missing']);
    const reference = cereal(); reference.metadata.evidence[0].photoIndex = 2;
    cases.push([JSON.stringify(envelope(reference)), 'photo_reference']);
    for (const [payload, issue] of cases) {
      fetch.mock.mockImplementation(async () => new Response(payload, { headers: { 'x-request-id': 'private-provider-text' } }));
      const response = await worker.fetch(request(), env()), text = await response.text(), body = JSON.parse(text);
      assert.equal(response.status, 502); assert.equal(body.code, 'upstream_invalid_response');
      assert.equal(body.trace.validationIssue, issue); assert.equal(body.trace.outcome, 'upstream_invalid_response');
      assert.equal(body.trace.providerRequestId, undefined);
      assert.ok(Buffer.byteLength(text) <= 4096);
      assert.doesNotMatch(text, /private-key-marker|private-provider-text|<script|Bearer|base64,/);
    }
  });
});
