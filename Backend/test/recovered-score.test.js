import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker, { LabelQuota } from '../src/worker.js';
import { recoveredEstimateScore } from '../src/recovered-score.js';
import { applyRecoveryChoice, buildRecoveryContext } from '../src/food-recovery.js';
import { calculateScore, validateClassification } from '../src/product-score.js';
import { ScoreCore } from '../src/nutrition-core.js';
import {buildCatalogueRow} from '../src/catalogue-index.js';

const token = '71'.repeat(32);
const n = (value, unit = 'g') => ({ value, unit, status: value === null ? 'unknown' : 'supplied' });
const salmon = () => ({ name: 'Raw salmon', basisUnit: 'g', nutritionPreparation: 'as_sold', nutrients: { protein: n(20), salt: n(1.8) } });
const eggs = () => ({name:'British Free Range Mixed Size Eggs',sourceName:'Open Food Facts',basisUnit:'g',nutritionPreparation:'as_sold',
  categories:['en:eggs','en:chicken-eggs'],ingredients:'just eggs',nutrients:{energyKcal:n(131,'kcal'),protein:n(12.5),fat:n(9),saturatedFat:n(2.5),salt:n(.3725),carbohydrate:n(0)}});
const aiClass = product => ({ category: 'general', evidence: [{ field: 'name', quote: product.name }], sweeteners: 'unknown', sweetenerEvidence: [] });
const choiceFor = (product, context) => ({ ...aiClass(product), recordId: context.candidates[0]?.id ?? null,
  reason: context.candidates.length ? 'compatible_generic_estimate' : 'no_compatible_source' });
const envelope = value => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
function projection(product = salmon(), core = ScoreCore) {
  const context = buildRecoveryContext(product,{},core);
  assert.ok(context.candidates.length, 'fixture must exercise an actual approved source record');
  const recovered = applyRecoveryChoice(product, context, choiceFor(product, context),core);
  const classification = core.validateClassification(product, recovered.classification);
  return { recovered, classification, score: recoveredEstimateScore(product, recovered, classification, core.calculateScore(product, classification).missingInputs,core) };
}
function fixture() {
  const objects = new Map();
  const env = { OPENAI_API_KEY: 'public-synthetic-test-key', OPENAI_MODEL: 'gpt-4.1-mini',
    PRIVATE_ACCESS_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
    LABEL_QUOTA: { idFromName: name => name, get: name => {
      if (!objects.has(name)) {
        const values = new Map();
        const tx = { get: async key => structuredClone(values.get(key)), put: async (key, value) => values.set(key, structuredClone(value)),
          delete: async keys => (Array.isArray(keys) ? keys : [keys]).forEach(key => values.delete(key)) };
        let queue = Promise.resolve();
        const quota = new LabelQuota({ storage: { ...tx, setAlarm: async () => {}, deleteAlarm: async () => {}, transaction: callback => {
          const pending = queue.then(() => callback(tx)); queue = pending.catch(() => {}); return pending;
        } } });
        objects.set(name, { values, fetch: (url, init) => quota.fetch(new Request(url, init)) });
      }
      return objects.get(name);
    } }
  };
  return { env, objects };
}
const request = (product, extra = {}, authorization = `Bearer ${token}`) => new Request('https://nudge.example/v1/products/score', {
  method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ product, ...extra })
});
const barcode = '5060178075250';
const chickpeas = () => ({ name: 'Organic chickpeas', brand: 'Synthetic foods', barcode, basisUnit: 'g', nutritionPreparation: 'as_sold',
  nutrients: { protein: n(6.7), salt: n(.53) } });
const provider = () => ({ status: 'success', product: { code: barcode, product_name: 'Organic chickpeas', brands: 'Synthetic foods',
  ingredients_text: 'Chickpeas (60%), water', categories_tags: ['en:chickpeas'], nutrition: { aggregated_set: { per: '100g', preparation: 'as_sold',
    nutrients: { 'energy-kcal': { value: 100, unit: 'kcal', source: 'packaging' }, proteins: { value: 6.7, unit: 'g' }, fiber: { value: 5.7, unit: 'g' },
      salt: { value: .53, unit: 'g' }, sugars: { value: 1, unit: 'g' }, 'saturated-fat': { value: .3, unit: 'g' } } } } } });

async function retainProviderInIndex(env){
  const now=Date.now(),row=await buildCatalogueRow(provider().product,{fetchedAt:now,now,source:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',allowBarcodeOnly:true});
  env.FOOD_CATALOGUE_INDEX={idFromName:value=>value,get:()=>({fetch:async()=>Response.json({products:[JSON.parse(row.provider_json)],ratings:[{
    barcode:row.barcode,fetchedAt:row.fetched_at,expiresAt:row.expires_at,calculatedAt:row.calculated_at,sourceFingerprint:row.source_fingerprint,
    method:row.score_method,version:row.score_version,classifierVersion:row.classifier_version,score:JSON.parse(row.score_json)
  }]})})};
}

afterEach(() => mock.restoreAll());

describe('separate sourced score projection', () => {
  it('fills missing calculation inputs without modifying known label facts or the input object', () => {
    const product = salmon(), original = structuredClone(product), { score, recovered } = projection(product);
    assert.deepEqual(product, original);
    assert.equal(score.estimated, true);
    assert.equal(score.scoreBasis, 'sourced_composition');
    assert.ok(['estimated', 'estimated_provisional'].includes(score.status));
    assert.equal(score.inputs.salt, 1.8);
    assert.equal(score.inputs.protein, 20);
    assert.equal(product.nutrients.fibre, undefined);
    assert.equal(score.inputs.fibre, recovered.estimate.nutrients.fibre.value);
    assert.ok(score.originalMissingInputs.includes('sugars'));
    assert.equal(score.sourceData.compositionRecordId, recovered.estimate.sourceRecord.id);
    assert.ok(score.sources.some(source => source.url === recovered.estimate.sourceRecord.sourceURL));
  });
  it('retains known salt and sugar penalties rather than replacing them with generic healthy values', () => {
    const low = salmon(); low.nutrients.salt = n(.1); low.nutrients.sugars = n(0);
    const high = salmon(); high.nutrients.salt = n(4); high.nutrients.sugars = n(35);
    high.nutrients.carbohydrate = n(40); high.nutrients.energyKcal = n(500, 'kcal');
    const a = projection(low).score, b = projection(high).score;
    assert.equal(b.inputs.salt, 4); assert.equal(b.inputs.sugars, 35);
    assert.ok(b.negativePoints > a.negativePoints);
    assert.ok(b.value < a.value);
  });
  it('gives declared kcal precedence over generic source kJ', () => {
    const product = salmon(); product.nutrients.energyKcal = n(400, 'kcal');
    const { score } = projection(product);
    assert.equal(score.inputs.energyKj, 400 * 4.184);
    assert.equal(score.inputs.energySource, 'derived-kcal-times-4.184');
  });
  it('retains measured zero and point-invariant bounds without exact generic replacements', () => {
    const zero = salmon(); zero.nutrients.salt = n(0);
    assert.equal(projection(zero).score.inputs.salt, 0);
    const bounded = salmon(); bounded.nutrients.salt = { ...n(.1), relation: 'lt' };
    const score=projection(bounded).score;
    assert.equal(score.inputs.salt,null);assert.equal(score.inputs.nutrientBounds.salt.value,.1);
    assert.equal(score.components.negative.find(c=>c.id==='salt').points,0);
    const unresolved=salmon();unresolved.nutrients.salt={...n(.3),relation:'lt'};
    assert.equal(projection(unresolved).score,null,'A bound crossing score bins cannot be replaced with a generic salt quantity');
  });
  it('refuses mismatched basis or unresolved identity, nutrition and preparation', () => {
    const product = salmon(), { recovered, classification } = projection(product);
    for (const extra of [{ basisUnit: 'ml' }, { nutritionPreparation: null }, ...['identity', 'nutrition', 'preparation'].map(key => ({ unresolvedFields: [key] }))]) {
      assert.equal(recoveredEstimateScore({ ...product, ...extra }, recovered, classification), null);
    }
    assert.equal(recoveredEstimateScore(product, {}, classification), null);
  });
  it('does not replace a conflicting classification with a generic source category', () => {
    const product={...eggs(),scoringFacts:{isCheese:true}}, context=buildRecoveryContext(product);
    const recovered=applyRecoveryChoice(product,context,choiceFor(product,context));
    const classification=validateClassification(product,recovered.classification);
    assert.equal(classification.category,'unknown');
    assert.ok(classification.conflicts.length);
    assert.equal(recoveredEstimateScore(product,recovered,classification),null);
  });
  it('preserves the legacy egg composition projection and its stricter completeness contract',()=>{
    const legacyProjection=p=>projection(p,ScoreCore.Legacy);
    const product=eggs(),before=structuredClone(product),{recovered,score}=legacyProjection(product);
    assert.equal(recovered.estimate.sourceRecord.name,'Eggs, chicken, whole, raw');
    assert.equal(recovered.estimate.nutrients.sugars.value,null,'A source trace is not zero');
    assert.equal(score?.value,100);assert.equal(score.status,'estimated');
    assert.equal(score.inputs.fvlPercent,0);assert.match(score.inputs.fvlSource,/composition/);
    assert.equal(score.inputs.fibre,0);assert.equal(score.inputs.sugars,0);
    assert.ok(score.assumptions.some(v=>/carbohydrate/i.test(v)));
    assert.deepEqual(product,before);assert.equal(product.nutrients.fibre,undefined);assert.equal(product.nutrients.sugars,undefined);
    for(const carbohydrate of [n(null),n(1),{...n(0),relation:'lt'},{...n(0),status:'estimated'}]){
      assert.equal(legacyProjection({...product,nutrients:{...product.nutrients,carbohydrate}}).score,null,'Unknown/nonzero/bounded/estimated carbohydrate cannot manufacture a sugar zero');
    }
    const conflict={...product,nutrients:{...product.nutrients,sugars:n(.5)}};
    const conflictContext=buildRecoveryContext(conflict,{},ScoreCore.Legacy);
    if(conflictContext.candidates.length)assert.equal(legacyProjection(conflict).score,null,'A contrary supplied sugar value must remain a conflict');
    else assert.equal(ScoreCore.Legacy.calculateScore(conflict).available,false,'Contradictory facts cannot be repaired by selecting a generic source');
  });
  it('recovers missing banana nutrients while preserving supplied sugar and salt bounds',()=>{
    const product={name:'Fairtrade bananas',sourceName:'Open Food Facts',categories:['en:bananas'],ingredients:'Bananas.',basisUnit:'g',nutritionPreparation:'as_sold',
      nutrients:{energyKcal:n(103,'kcal'),sugars:n(20.9),carbohydrate:n(23.2),protein:n(1.2),fibre:n(1.1),saturatedFat:{...n(.1),relation:'<'}}};
    const before=structuredClone(product),{score,recovered}=projection(product);
    assert.equal(recovered.estimate.sourceRecord.id,'usda:173944');
    assert.equal(score.value,75);assert.equal(score.status,'estimated');assert.equal(score.inputs.sugars,20.9);
    assert.equal(score.inputs.salt,.0025);assert.equal(score.inputs.saturatedFat,null);
    assert.deepEqual(product,before);assert.equal(product.nutrients.salt,undefined);
  });
  it('combines explicit provider estimates with approved generic missing fields only in an estimated projection',()=>{
    const product={name:'Organic bananas',sourceName:'Open Food Facts',categories:['en:bananas'],ingredients:'Bananas',basisUnit:'g',nutritionPreparation:'as_sold',
      nutrientSources:{sugars:'estimate'},nutrients:{energyKcal:n(90.5,'kcal'),sugars:{...n(15.6),status:'estimated',relation:'~'},carbohydrate:n(23.2)}};
    const before=structuredClone(product),{score}=projection(product);
    assert.equal(score.status,'estimated');assert.equal(score.value,100);assert.equal(score.inputs.sugars,15.6);
    assert.equal(score.inputs.estimatedInputs.sugars.relation,'~');assert.equal(score.scoreBasis,'sourced_composition');
    assert.deepEqual(product,before);assert.equal(product.nutrients.fibre,undefined);
    const invalid={...product,nutrientSources:{}};assert.equal(projection(invalid).score,null,'Unattributed estimates cannot be silently made exact');
  });
});

describe('product recovery route and cache', () => {
  it('scores eggs from a proven carbohydrate bound or compatible legacy source without AI admission', async () => {
    const { env, objects } = fixture(), product = eggs(), before = structuredClone(product);
    const context = buildRecoveryContext(product);
    const upstream = mock.method(globalThis, 'fetch', async () => { throw new Error('AI and external sources unavailable'); });
    const first = await worker.fetch(request(product), env);
    assert.equal(first.status, 200);
    const result = await first.json();
    if(ScoreCore.ACTIVE_DIRECTIONAL){
      assert.equal(context.candidates.length,0,'The source carbohydrate bound already supplies invariant sugar points');
      assert.equal(result.score.status,'rated');assert.equal(result.score.value,100);
      assert.equal(result.score.inputs.sugars,null);assert.equal(result.score.inputs.nutrientBounds.sugars.value,0);
      assert.equal(result.recovery,undefined);assert.equal(objects.get('private-owner')?.values.get('quota'),undefined,'A deterministic bound consumes no admission');
      const repeated=await (await worker.fetch(request(product),env)).json();
      assert.deepEqual(repeated.score,result.score);assert.deepEqual(product,before);assert.equal(upstream.mock.callCount(),0);
      return;
    }
    assert.equal(context.candidates.length, 1, 'the legacy recovery must have exactly one compatible candidate');
    assert.equal(result.score.status, 'unrated', 'unknown label facts remain unknown');
    assert.equal(result.recovery.status, 'estimated');
    assert.equal(result.recovery.product, undefined);
    const estimate = result.recovery.estimate;
    assert.equal(estimate.sourceRecord.id, context.candidates[0].id);
    assert.equal(estimate.sourceRecord.name, 'Eggs, chicken, whole, raw');
    assert.match(estimate.sourceRecord.source, /CoFID/i);
    assert.equal(estimate.score.value, 100);
    assert.equal(estimate.score.estimated, true);
    assert.equal(estimate.score.inputs.protein, 12.5);
    assert.equal(estimate.score.inputs.salt, .3725);
    assert.equal(estimate.score.inputs.saturatedFat, 2.5);
    assert.equal(estimate.score.inputs.energyKj, 131 * 4.184);
    assert.deepEqual(product, before);
    assert.equal(product.nutrients.fibre, undefined);
    assert.equal(product.nutrients.sugars, undefined);
    assert.equal(upstream.mock.callCount(), 0, 'a unique source must be resolved before any optional AI call');
    const owner = objects.get('private-owner'), saved = structuredClone([...owner.values]);
    const second = await worker.fetch(request(product), env);
    assert.equal(second.status, 200);
    const repeated=await second.json();
    assert.deepEqual(repeated.score,result.score);
    assert.deepEqual(repeated.recovery.estimate,result.recovery.estimate);
    assert.deepEqual([...owner.values], saved, 'cached recovery must not consume another admission');
    assert.equal(upstream.mock.callCount(), 0);
  });
  it('returns separate generic evidence and reuses the complete result without more AI calls or quota admissions', async () => {
    const { env, objects } = fixture(), product = { ...salmon(), name: 'Raw chicken' }, before = structuredClone(product), calls = [];
    assert.ok(buildRecoveryContext(product).candidates.length > 1, 'multiple compatible sources still exercise bounded AI selection');
    mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(init.redirect, 'manual');
      const body = JSON.parse(init.body), input = JSON.parse(body.input[0].content[0].text);
      assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
      calls.push(body.text.format.name);
      if (body.text.format.name === 'product_score_classification') return envelope(aiClass(input));
      assert.equal(body.text.format.name, 'food_evidence_recovery');
      return envelope(choiceFor(input.product, input));
    });
    const first = await worker.fetch(request(product), env); assert.equal(first.status, 200);
    const result = await first.json();
    assert.equal(result.score.status, 'unrated'); assert.equal(result.recovery.status, 'estimated');
    assert.equal(result.recovery.product, undefined, 'generic source must stay out of verified product facts');
    assert.equal(result.recovery.estimate.score.inputs.salt, 1.8);
    assert.equal(result.recovery.estimate.score.estimated, true);
    assert.ok(result.recovery.provenance[0].url.startsWith('https://'));
    assert.deepEqual(calls, ['product_score_classification', 'food_evidence_recovery']);
    const owner = objects.get('private-owner'), stored = structuredClone([...owner.values]);
    const second = await worker.fetch(request(product), env); assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), result);
    assert.deepEqual([...owner.values], stored, 'cache hit must not charge another quota admission');
    assert.equal(calls.length, 2); assert.deepEqual(product, before);
    assert.equal(owner.values.get('public-product-score-cache').length, 1);
  });
  it('supplements only matching indexed public facts and preserves exact recovery provenance without OFF', async () => {
    const { env, objects } = fixture(), product = chickpeas(), before = structuredClone(product), calls = [];
    await retainProviderInIndex(env);
    mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push(url);
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(init.body), input = JSON.parse(body.input[0].content[0].text);
      return envelope(body.text.format.name === 'product_score_classification' ? aiClass(input) : { emphasize: ['fibre', 'protein'] });
    });
    const response = await worker.fetch(request(product), env); assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(['rated', 'provisional'].includes(result.score.status));
    assert.equal(result.recovery.status, 'verified');
    assert.equal(result.recovery.product.nutrients.salt.value, .53);
    assert.equal(result.recovery.product.nutrients.fibre.value, 5.7);
    assert.ok(result.recovery.addedFields.includes('fibre'));
    assert.equal(result.recovery.estimate, undefined);
    assert.deepEqual(product, before);
    const count = calls.length;
    const repeated=await (await worker.fetch(request(product), env)).json();
    assert.deepEqual(repeated.score,result.score);assert.deepEqual(repeated.recovery,result.recovery);
    assert.ok(repeated.calculatedAt>=result.calculatedAt,'A fresh local calculation from cached source facts has its own timestamp');
    assert.equal(calls.length, count);
    assert.equal(objects.has('food-catalogue:' + barcode),false,'Foreground must not instantiate a live source lookup');
  });
  it('recovers a packaged egg estimate through the real route without changing its label nutrient facts',async()=>{
    const {env}=fixture(),product=eggs();delete product.nutrients.energyKcal;
    const before=structuredClone(product),stages=[];
    mock.method(globalThis,'fetch',async(url,init)=>{
      assert.equal(url,'https://api.openai.com/v1/responses');
      const body=JSON.parse(init.body),input=JSON.parse(body.input[0].content[0].text);stages.push(body.text.format.name);
      return envelope(body.text.format.name==='product_score_classification'?aiClass(input):choiceFor(input.product,input));
    });
    const response=await worker.fetch(request(product),env);assert.equal(response.status,200);const result=await response.json();
    assert.equal(result.score.status,'unrated');assert.equal(result.recovery.status,'estimated');assert.equal(result.recovery.estimate.score.value,100);
    assert.equal(result.recovery.estimate.sourceRecord.name,'Eggs, chicken, whole, raw');
    assert.equal(result.recovery.product,undefined);assert.deepEqual(product,before);
    assert.deepEqual(stages,[],'the unique compatible source does not need an AI choice');
  });
  it('keeps useful exact recovery if AI classification is unavailable', async () => {
    const { env } = fixture(); let aiCalls = 0;
    await retainProviderInIndex(env);
    mock.method(globalThis, 'fetch', async url => {
      assert.equal(url,'https://api.openai.com/v1/responses');
      aiCalls++; return Response.json({ error: { type: 'server_error' } }, { status: 502 });
    });
    const response = await worker.fetch(request(chickpeas()), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(['rated', 'provisional'].includes(result.score.status));
    assert.equal(result.recovery.status, 'verified');
    assert.equal(result.recovery.product.nutrients.fibre.value, 5.7);
    assert.equal(aiCalls, 0, 'verified deterministic evidence must not depend on AI availability');
  });
  it('preserves conflicting known product facts and skips generic replacement', async () => {
    const { env } = fixture(), product = chickpeas(); product.nutrients.salt = n(2.5);
    await retainProviderInIndex(env);
    const stages = [];
    mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url,'https://api.openai.com/v1/responses');
      const body = JSON.parse(init.body), input = JSON.parse(body.input[0].content[0].text);
      stages.push(body.text.format.name); return envelope(aiClass(input));
    });
    const response = await worker.fetch(request(product), env); assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.recovery.status, 'conflict'); assert.ok(result.recovery.conflicts.includes('salt'));
    assert.equal(result.recovery.product.nutrients.salt.value, 2.5);
    assert.equal(result.recovery.product.nutrients.fibre, undefined);
    assert.equal(result.recovery.estimate, undefined);
    assert.deepEqual(stages, [], 'A model cannot resolve conflicting supplied nutrient quantities');
  });
  it('rejects model-supplied score/nutrients/URLs and retains the valid first result', async () => {
    const { env } = fixture(), product = { ...salmon(), name: 'Raw chicken' };
    assert.ok(buildRecoveryContext(product).candidates.length > 1, 'an ambiguous source must reach the AI validation boundary');
    mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body), input = JSON.parse(body.input[0].content[0].text);
      if (body.text.format.name === 'product_score_classification') return envelope(aiClass(input));
      return envelope({ ...choiceFor(input.product, input), score: 100, nutrients: { salt: 0 }, url: 'https://attacker.invalid' });
    });
    const response = await worker.fetch(request(product), env); assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.score.status, 'unrated'); assert.equal(result.recovery, undefined);
  });
  it('rejects private payload extras before any source or AI call', async () => {
    const { env } = fixture(), upstream = mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
    for (const extra of [{ diary: [] }, { image: 'private-photo' }, { voiceMemo: 'private-recording' }]) {
      assert.equal((await worker.fetch(request(salmon(), extra), env)).status, 400);
    }
    assert.equal((await worker.fetch(request(salmon(), {}, 'Bearer wrong'), env)).status, 401);
    assert.equal(upstream.mock.callCount(), 0);
  });
});
