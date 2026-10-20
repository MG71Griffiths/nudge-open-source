import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker, { LabelQuota, quotaLimits } from '../src/worker.js';

// Isolated counters only: no real account, credential, photo or external call.
const defaults = { globalHourly: 10, globalDaily: 30, accountHourly: 3, accountDaily: 10 };
const development = { LABEL_GLOBAL_HOURLY_LIMIT: '30', LABEL_GLOBAL_DAILY_LIMIT: '150',
  LABEL_ACCOUNT_HOURLY_LIMIT: '20', LABEL_ACCOUNT_DAILY_LIMIT: '100' };
const configured = { globalHourly: 30, globalDaily: 150, accountHourly: 20, accountDaily: 100 };
const subject = index => createHash('sha256').update(`synthetic-quota-user-${index}`).digest('hex');
const hourLength = 3_600_000, dayLength = 86_400_000;

function fixture(env = development) {
  const values = new Map(), deletedBatches = [];
  let alarmTime = null, queue = Promise.resolve();
  const transaction = { get: async key => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async keys => {
      const batch = Array.isArray(keys) ? keys : [keys];
      assert.ok(batch.length <= 128, 'Durable Object delete accepts at most 128 keys per call');
      deletedBatches.push([...batch]);
      for (const key of batch) values.delete(key);
    } };
  const storage = { setAlarm: async time => { alarmTime = time; }, deleteAlarm: async () => { alarmTime = null; },
    transaction: callback => {
      const operation = queue.then(() => callback(transaction)); queue = operation.catch(() => {}); return operation;
    } };
  let quota = new LabelQuota({ storage }, env);
  return { values, deletedBatches,
    get alarmTime() { return alarmTime; },
    reinstantiate: nextEnv => { quota = new LabelQuota({ storage }, nextEnv); },
    alarm: () => quota.alarm(),
    action: async (action, lease, account = subject(1)) => (await quota.fetch(new Request(`https://quota/${action}`, {
      method: 'POST', body: JSON.stringify({ lease, subject: account })
    }))).json() };
}

async function admitAndRelease(quota, count, account = subject(1)) {
  for (let index = 0; index < count; index++) {
    assert.equal((await quota.action('acquire', `synthetic-${index}`, account)).allowed, true);
    await quota.action('release', `synthetic-${index}`, account);
  }
}

afterEach(() => mock.restoreAll());

describe('configurable analysis allowance', () => {
  it('retains conservative defaults and accepts bounded integer bindings', () => {
    assert.deepEqual(quotaLimits(), defaults);
    assert.deepEqual(quotaLimits({}), defaults);
    assert.deepEqual(quotaLimits(development), configured);
    assert.deepEqual(quotaLimits({ LABEL_GLOBAL_HOURLY_LIMIT: 100, LABEL_GLOBAL_DAILY_LIMIT: 500,
      LABEL_ACCOUNT_HOURLY_LIMIT: '1', LABEL_ACCOUNT_DAILY_LIMIT: '1' }),
    { globalHourly: 100, globalDaily: 500, accountHourly: 1, accountDaily: 1 });
  });

  it('falls back for malformed or out-of-range fields without weakening other limits', () => {
    const bindings = [['LABEL_GLOBAL_HOURLY_LIMIT', 'globalHourly', 101], ['LABEL_GLOBAL_DAILY_LIMIT', 'globalDaily', 501],
      ['LABEL_ACCOUNT_HOURLY_LIMIT', 'accountHourly', 101], ['LABEL_ACCOUNT_DAILY_LIMIT', 'accountDaily', 501]];
    for (const [binding, field, overflow] of bindings) {
      for (const invalid of [undefined, null, '', ' ', '3.5', '1e2', 'Infinity', 'garbage', false, [], {}, -1, 0, 3.5, Infinity, NaN, overflow, String(overflow)]) {
        assert.deepEqual(quotaLimits({ ...development, [binding]: invalid }), { ...configured, [field]: defaults[field] },
          `${binding} must reject ${String(invalid)}`);
      }
    }
  });

  it('admits 20 per hour and 100 per UTC day, then resets only the elapsed windows', async () => {
    const quota = fixture(); let now = Date.UTC(2026, 9, 3, 8, 15); mock.method(Date, 'now', () => now);
    for (let window = 0; window < 5; window++) {
      await admitAndRelease(quota, 20);
      const rejected = await quota.action('acquire', 'one-too-many');
      assert.equal(rejected.allowed, false); assert.equal(rejected.scope, 'account');
      assert.equal(rejected.period, window === 4 ? 'day' : 'hour');
      assert.equal(rejected.retryAfter, window === 4 ? 11 * 3600 + 45 * 60 : 45 * 60);
      now += hourLength;
    }
    assert.equal(quota.values.get(`user:${subject(1)}`).daily, 100);
    assert.equal(quota.values.get('quota').daily, 100);
    assert.equal((await quota.action('acquire', 'still-today')).period, 'day');
    await admitAndRelease(quota, 1, subject(2));
    now = Date.UTC(2026, 9, 4, 0, 1);
    await admitAndRelease(quota, 1);
    assert.equal(quota.values.get(`user:${subject(1)}`).daily, 1);
    assert.equal(quota.values.get('quota').daily, 1);
    assert.equal(quota.values.has(`user:${subject(2)}`), false);
  });

  it('enforces the shared 30 per hour and 150 per day independently of accounts', async () => {
    const quota = fixture(); let now = Date.UTC(2026, 9, 3, 8, 15); mock.method(Date, 'now', () => now);
    for (let window = 0; window < 5; window++) {
      await admitAndRelease(quota, 20, subject(window * 2));
      await admitAndRelease(quota, 10, subject(window * 2 + 1));
      const rejected = await quota.action('acquire', 'over-shared', null);
      assert.equal(rejected.allowed, false); assert.equal(rejected.scope, 'global');
      assert.equal(rejected.period, window === 4 ? 'day' : 'hour');
      now += hourLength;
    }
    assert.equal(quota.values.get('quota').daily, 150);
    assert.equal(quota.values.get('quota-users').subjects.length, 10);
  });

  it('raises allowance without erasing existing counters or an active lease', async () => {
    const quota = fixture({}); const now = Date.UTC(2026, 9, 3, 8, 15); mock.method(Date, 'now', () => now);
    await admitAndRelease(quota, 3);
    assert.equal((await quota.action('acquire', 'legacy-limit')).allowed, false);
    const previous = structuredClone([...quota.values]);
    quota.reinstantiate(development);
    assert.deepEqual([...quota.values], previous);
    assert.equal((await quota.action('acquire', 'new-in-flight')).allowed, true);
    assert.equal(quota.values.get('quota').daily, 4);
    assert.equal(quota.values.get(`user:${subject(1)}`).daily, 4);
    quota.reinstantiate(development);
    const blocked = await quota.action('acquire', 'concurrent');
    assert.equal(blocked.allowed, false); assert.equal(blocked.busy, true); assert.equal(blocked.retryAfter, 60);
    await quota.action('release', 'wrong-lease');
    assert.equal(quota.values.get('quota').lease, 'new-in-flight');
    await quota.action('release', 'new-in-flight');
    await admitAndRelease(quota, 16);
    assert.equal((await quota.action('acquire', 'configured-limit')).period, 'hour');
    assert.equal(quota.values.get('quota').daily, 20, 'Release does not refund a consumed analysis');
  });

  it('reports the longer daily block when hourly caps and active leases overlap', async () => {
    const quota = fixture(), now = Date.UTC(2026, 9, 3, 21, 31), hour = Math.floor(now / hourLength), day = Math.floor(now / dayLength);
    mock.method(Date, 'now', () => now);
    quota.values.set('quota', { hour, day, hourly: 30, daily: 149, lease: 'busy', leaseUntil: now + 45_000 });
    quota.values.set(`user:${subject(1)}`, { hour, day, hourly: 20, daily: 100 });
    const before = structuredClone([...quota.values]);
    const accountDaily = await quota.action('acquire', 'rejected');
    assert.equal(accountDaily.scope, 'account'); assert.equal(accountDaily.period, 'day');
    assert.equal(accountDaily.retryAfter, (2 * 60 + 29) * 60); assert.notEqual(accountDaily.busy, true);
    assert.deepEqual([...quota.values], before, 'Rejected attempts leave usage and lease untouched');
    quota.values.get('quota').daily = 150;
    const globalDaily = await quota.action('acquire', 'also-rejected', null);
    assert.equal(globalDaily.scope, 'global'); assert.equal(globalDaily.period, 'day');
    assert.equal(globalDaily.retryAfter, accountDaily.retryAfter);
  });

  it('retains a 60-second single-flight lease with the higher allowance', async () => {
    const quota = fixture(); let now = Date.UTC(2026, 9, 3, 8, 15); mock.method(Date, 'now', () => now);
    const parallel = await Promise.all(Array.from({ length: 8 }, (_, index) => quota.action('acquire', `lease-${index}`, subject(index))));
    assert.equal(parallel.filter(decision => decision.allowed).length, 1);
    assert.equal(parallel.filter(decision => decision.busy && decision.retryAfter === 60).length, 7);
    assert.equal(quota.values.get('quota').daily, 1);
    now += 60_000;
    assert.equal((await quota.action('acquire', 'replacement', subject(7))).allowed, true);
    await quota.action('release', 'lease-0', subject(0));
    assert.equal(quota.values.get('quota').lease, 'replacement');
    assert.equal(quota.values.get('quota').daily, 2);
  });

  it('cleans more than 128 account counters safely and preserves global usage and cached scores', async () => {
    const quota = fixture({ ...development, LABEL_GLOBAL_HOURLY_LIMIT: '100', LABEL_GLOBAL_DAILY_LIMIT: '500' });
    let now = Date.UTC(2026, 9, 3, 8, 15); mock.method(Date, 'now', () => now);
    for (let index = 0; index < 160; index++) {
      if (index === 100) now += hourLength;
      await admitAndRelease(quota, 1, subject(index));
    }
    assert.equal(quota.values.get('quota-users').subjects.length, 160);
    assert.equal(quota.values.get('quota').daily, 160);
    quota.values.set('public-product-score-cache', [{ key: 'synthetic-cached-score' }]);
    const global = structuredClone(quota.values.get('quota'));
    await quota.alarm();
    assert.equal(quota.values.get('quota-users').subjects.length, 160, 'Early alarm preserves current-day users');
    now = Date.UTC(2026, 9, 4);
    await quota.alarm();
    assert.deepEqual(quota.deletedBatches.filter(batch => batch[0]?.startsWith('user:')).map(batch => batch.length), [128, 32]);
    assert.equal([...quota.values.keys()].some(key => key.startsWith('user:')), false);
    assert.equal(quota.values.has('quota-users'), false); assert.equal(quota.alarmTime, null);
    assert.deepEqual(quota.values.get('quota'), global);
    assert.deepEqual(quota.values.get('public-product-score-cache'), [{ key: 'synthetic-cached-score' }]);
  });

  it('publishes effective non-secret allowances without contacting providers', async () => {
    const upstream = mock.method(globalThis, 'fetch', () => { throw new Error('No provider request expected'); });
    const response = await worker.fetch(new Request('https://nudge.example/v1/account/config'), {
      ...development, SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'p'.repeat(32)}`
    });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await response.json()).analysisLimits, configured); assert.equal(upstream.mock.callCount(), 0);
  });
});
