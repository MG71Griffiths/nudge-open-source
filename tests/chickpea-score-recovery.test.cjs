// Real product model, controller and History; isolated synthetic food and storage.
// No barcode, user records, network requests or production credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { boot } = require('./food-detail.test.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const mainKey = 'wmd-nudge-prototype-v1';
function setup(options) {
  const app = boot(options);
  for (const file of ['core/meal-score.js', 'diet.js', 'core/product-evidence.js','scan-results.js', 'food-detail-screen.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Web', file), 'utf8'), app.sandbox, { filename: file });
  }
  return app;
}
const values = { energyKcal: 100, protein: 6.7, fibre: 5.7, salt: 0.53, saturatedFat: 0.3, fat: 2, carbohydrate: 13.9, sugars: 1 };
const chickpeas = {
  name: 'Organic Chickpeas', categories: [], sourceName: 'Open Food Facts', ingredients:'Chickpeas',
  basisUnit: 'g', nutritionPreparation: 'as_sold', servingAmount: 100, servingUnit: 'g',
  nutrients: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
    value, unit: key === 'energyKcal' ? 'kcal' : 'g', status: 'supplied',
  }])),
};
const scoreRequests = app => app.messages.filter(message => message.action === 'product-score');
function checkDetailed(score) {
  assert.equal(score.methodId, fresh.sandbox.NudgeScoreCore.SCORE_METHOD);
  assert.equal(score.status, 'rated');
  assert.equal(score.category, 'general');
  assert.equal(score.grade, 'A');
  assert.equal(score.value, 100);
  assert.equal(score.inputs.fvlPercent, 100, 'A complete single-ingredient source list establishes the qualifying share');
  assert.equal(score.missingInputs.length,0);
  assert.equal(score.components.find(component => component.id === 'fvl').points, 5);
}

// Complete numeric evidence must reach the detailed calculator even when OFF has
// no category tags and the food name starts with a production claim.
const fresh = setup(), before = JSON.stringify(fresh.data);
fresh.receive(chickpeas, 'synthetic-pulse-scan');
checkDetailed(fresh.controller.detail().score);
assert.equal(scoreRequests(fresh).length, 0, 'Available detailed facts need no paid classification call');
assert.match(fresh.controller.screen(), /nf-dial-marker/);
assert.match(fresh.history.screen(), /class="n-score n-score-green"[^>]*aria-label="Nudge (?:nutrition )?score 100 out of 100/);
assert.equal(fresh.controller.detail().projection.energy.logged, 0);
assert.equal(fresh.controller.detail().projection.protein.logged, 0);
assert.equal(fresh.data.foodLog.entries.length, 0);
assert.equal(fresh.writes(), 0);
assert.equal(JSON.stringify(fresh.data), before, 'Scanning and showing the score must never add intake');

// An old, structurally valid same-facts "category unavailable" result is the
// regression: it previously left this scan displaying the rough pulse score.
const old = setup();
const unavailable = old.model.calculatedScore({ ...chickpeas, name: 'Unknown food' });
assert.equal(unavailable.status, 'unrated');
assert.ok(old.model.validScoreResult(unavailable));
const oldProduct = { ...copy(chickpeas), scoreResult: {
  methodId: unavailable.methodId, version: unavailable.version,
  inputFingerprint: old.model.scoreFingerprint(chickpeas), result: copy(unavailable),
} };
assert.equal(old.model.cachedScore(oldProduct).status, 'unrated', 'Fixture must exercise a valid cache, not an ignored malformed one');
old.history.record({ id: 'saved-pulse-scan', kind: 'product', status: 'ready', product: oldProduct });
old.storage.set(mainKey, JSON.stringify(old.data));
const restored = setup({ storage: old.storage, reload: true });
const restoredBefore = JSON.stringify(restored.data);
assert.match(restored.history.screen(), /class="n-score n-score-green"[^>]*aria-label="Nudge (?:nutrition )?score 100 out of 100/);
restored.history.reopen('saved-pulse-scan');
checkDetailed(restored.controller.detail().score);
assert.match(restored.controller.screen(), /nf-dial-marker/);
for (let index = 0; index < 3; index++) {
  restored.history.reopen('saved-pulse-scan');
  restored.controller.screen();
  restored.history.screen();
}
assert.equal(scoreRequests(restored).length, 0);
assert.equal(restored.history.items().length, 1, 'Rechecking the saved scan must not duplicate its All row');
assert.equal(restored.writes(), 0);
assert.equal(JSON.stringify(restored.data), restoredBefore);
restored.history.handleAction('history-filter', 'eaten');
assert.equal(restored.history.items().length, 0, 'A recovered score alone is not food eaten');
restored.history.handleAction('history-filter', 'all');

// Confirmation remains a separate, idempotent action; one source and its eaten
// food form one All row and keep the original exact numeric nutrition.
restored.action('detail-log');
restored.action('detail-log');
assert.equal(restored.data.foodLog.entries.length, 1);
assert.equal(restored.history.items().length, 1);
const entry = restored.data.foodLog.entries[0];
assert.equal(entry.sourceMeta.scoreMethod.value, 100);
assert.equal(entry.sourceMeta.scoreMethod.inputs.fvlPercent, 100);
assert.equal(entry.energyPerPortion, 100);
assert.equal(entry.proteinPerPortion, 6.7);
assert.equal(entry.fibrePerPortion, 5.7);
assert.equal(entry.nutritionSnapshot.carbohydrate.portion, 13.9);
assert.match(restored.history.screen(), /✓ Eaten/);

// Existing consumed snapshots are historical evidence, not a migration target.
// Seed the previous valid 60-point rough result into this synthetic diary only.
const historical = {available:true,status:'estimated_rough',estimated:true,methodId:'nudge_food_estimate_v2',methodVersion:'nudge_food_estimate_v2',version:'2',model_version:'2',sourceVersion:'nudge_food_estimate_v2',value:60,grade:null,rawScore:null,baseFrequency:null,finalFrequency:null,scoreBasis:'food_pattern',confidence:'low',reason:'Saved food-pattern estimate before nutrient-aware recovery.',inputs:{identifiedFood:'organic chickpeas'},missingInputs:copy(unavailable.missingInputs)};
assert.equal(historical.value, 60);
assert.equal(restored.sandbox.NudgeMealScore.validResult(historical), true);
entry.sourceMeta.scoreMethod = copy(historical);
restored.storage.set(mainKey, JSON.stringify(restored.data));
const confirmed = setup({ storage: restored.storage, reload: true });
const confirmedBefore = JSON.stringify(confirmed.data);
const historyBefore = confirmed.history.screen();
assert.match(historyBefore, /class="n-score n-score-green"[^>]*aria-label="Historical Nudge score 60 out of 100/);
confirmed.history.reopen('saved-pulse-scan');
checkDetailed(confirmed.controller.detail().score);
assert.equal(confirmed.controller.detail().historicalScore.value, 60);
confirmed.controller.screen();
confirmed.action('detail-log');
assert.equal(confirmed.data.foodLog.entries.length, 1);
assert.equal(confirmed.history.items().length, 1);
assert.equal(confirmed.writes(), 0);
assert.equal(JSON.stringify(confirmed.data), confirmedBefore, 'Viewing improved scoring must preserve a previously confirmed snapshot byte-for-byte');

console.log('Passed: organic chickpeas use detailed100 from complete source ingredients; old unavailable cache recovers, dial/green History render, scans never add intake, confirmation deduplicates, and historical consumed scores stay unchanged.');
