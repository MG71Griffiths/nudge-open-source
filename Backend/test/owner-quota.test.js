import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker, { LabelQuota, nutrientKeys } from '../src/worker.js';

// Synthetic identities only; all provider calls are intercepted.
const project = 'https://abcdefghijklmnopqrst.supabase.co';
const ownerID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const sessionID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const subject = id => createHash('sha256').update(`${project}\n${id}`).digest('hex');
const privateToken = '12'.repeat(32);
const ownerConfig = { LABEL_OWNER_UNLIMITED_SUBJECT_SHA256: subject(ownerID) };
const now = Date.UTC(2026, 9, 4, 12, 15), hour = Math.floor(now / 3_600_000), day = Math.floor(now / 86_400_000);
const image = readFileSync(new URL('./fixtures/blank.jpg', import.meta.url)).toString('base64');
const token = (id = ownerID) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({
  iss: `${project}/auth/v1`, sub: id, session_id: sessionID, aud: 'authenticated', role: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 3600, is_anonymous: false
})).toString('base64url')}.offline_signature`;
const profile = id => ({ id, aud: 'authenticated', role: 'authenticated', is_anonymous: false,
  email: 'synthetic@example.invalid', email_confirmed_at: '2026-01-01T00:00:00Z' });

function fixture(settings = {}) {
  const values = new Map(); let mutations = 0, queue = Promise.resolve();
  const tx = { get: async key => structuredClone(values.get(key)),
    put: async (key, value) => { mutations++; values.set(key, structuredClone(value)); },
    delete: async keys => { mutations++; for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); } };
  const storage = { setAlarm: async () => { mutations++; }, deleteAlarm: async () => { mutations++; },
    transaction: callback => { const result = queue.then(() => callback(tx)); queue = result.catch(() => {}); return result; } };
  let quota = new LabelQuota({ storage }, settings);
  const stub = { fetch: (url, init) => quota.fetch(new Request(url, init)) };
  return { values, get mutations() { return mutations; },
    reinstantiate: env => { quota = new LabelQuota({ storage }, env); },
    action: async (path, body) => stub.fetch(`https://quota/${path}`, { method: 'POST', body: JSON.stringify(body) }),
    binding: { idFromName: name => { assert.equal(name, 'private-owner'); return name; }, get: () => stub } };
}
function exhaust(q) {
  q.values.set('quota', { hour, day, hourly: 10, daily: 30, lease: null, leaseUntil: 0 });
  q.values.set(`user:${subject(ownerID)}`, { hour, day, hourly: 3, daily: 10 });
}
const acquire = async (q, account = subject(ownerID), lease = 'synthetic-lease', extra = {}) =>
  (await q.action('acquire', { lease, subject: account, ...extra })).json();
const status = async (q, account = subject(ownerID)) => (await q.action('status', { subject: account })).json();
const environment = (q, settings = {}) => ({ LABEL_QUOTA: q.binding, SUPABASE_URL: project,
  SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'p'.repeat(32)}`,
  PRIVATE_ACCESS_TOKEN_SHA256: createHash('sha256').update(privateToken).digest('hex'), ...settings });
function request(jwt = token(), suffix = '', headers = {}) {
  return new Request(`https://nudge.example/v1/account/analysis-usage${suffix}`, {
    headers: { authorization: `Bearer ${jwt}`, ...headers }
  });
}
afterEach(() => mock.restoreAll());

describe('server-owned quota exemption', () => {
  it('exempts only the configured owner from exhausted global and account ceilings while retaining counts', async () => {
    mock.method(Date, 'now', () => now);
    const q = fixture(); exhaust(q); const saved = structuredClone([...q.values]);
    assert.equal((await acquire(q)).allowed, false);
    q.reinstantiate(ownerConfig);
    assert.deepEqual([...q.values], saved, 'Enabling the owner does not erase usage');
    assert.equal((await acquire(q)).allowed, true);
    assert.equal(q.values.get('quota').daily, 31);
    assert.equal(q.values.get('quota').hourly, 11);
    assert.equal(q.values.get(`user:${subject(ownerID)}`).daily, 11);
    assert.equal(q.values.get(`user:${subject(ownerID)}`).hourly, 4);
    const owner = await status(q);
    assert.deepEqual(owner.usage, { hourly: 4, daily: 11 });
    assert.deepEqual(owner.limits, { hourly: null, daily: null });
    assert.equal(owner.unlimited, true); assert.equal(owner.busy, true);
    assert.equal((await acquire(q, subject(otherID))).scope, 'global');
    await q.action('release', { lease: 'synthetic-lease' });
    assert.equal((await status(q)).allowed, true);
    assert.equal((await acquire(q, subject(otherID))).allowed, false);
  });

  it('retains one in-flight request and lease ownership even for exempt accounts', async () => {
    mock.method(Date, 'now', () => now);
    const q = fixture(ownerConfig); exhaust(q);
    const parallel = await Promise.all(['one', 'two', 'three'].map(lease => acquire(q, subject(ownerID), lease)));
    assert.equal(parallel.filter(value => value.allowed).length, 1);
    assert.equal(parallel.filter(value => value.busy && value.retryAfter === 60).length, 2);
    await q.action('release', { lease: 'wrong-lease' });
    assert.equal((await status(q)).busy, true);
    assert.equal(q.values.get('quota').daily, 31);
  });

  it('requires explicit private-owner opt-in and reports shared counts separately', async () => {
    mock.method(Date, 'now', () => now);
    for (const value of [undefined, false, true, 'TRUE', '1', 'false', '', ' true ']) {
      const q = fixture({ LABEL_PRIVATE_OWNER_UNLIMITED: value }); exhaust(q);
      assert.equal((await acquire(q, null)).allowed, false, String(value));
    }
    const q = fixture({ LABEL_PRIVATE_OWNER_UNLIMITED: 'true' }); exhaust(q);
    const before = await status(q, null);
    assert.deepEqual(before.usage, { hourly: null, daily: null });
    assert.deepEqual(before.sharedUsage, { hourly: 10, daily: 30 });
    assert.deepEqual(before.sharedLimits, { hourly: 10, daily: 30 });
    assert.equal(before.unlimited, true); assert.equal(before.allowed, true);
    assert.equal((await acquire(q, null)).allowed, true);
    assert.equal(q.values.get('quota').daily, 31);
    assert.equal(q.values.has('user:null'), false);
  });

  it('fails closed for malformed owner configuration and request bypass flags', async () => {
    mock.method(Date, 'now', () => now);
    for (const value of [undefined, null, '', ' ', subject(ownerID).toUpperCase(), 'x'.repeat(64), subject(ownerID).slice(1), `${subject(ownerID)} `]) {
      const q = fixture({ LABEL_OWNER_UNLIMITED_SUBJECT_SHA256: value }); exhaust(q);
      assert.equal((await acquire(q, subject(ownerID), 'test', { unlimited: true, bypass: true })).allowed, false);
      assert.equal((await status(q)).unlimited, false);
    }
    const q = fixture(ownerConfig);
    q.values.set(`user:${subject(otherID)}`, { hour, day, hourly: 3, daily: 10 });
    assert.equal((await acquire(q, subject(otherID), 'other', { unlimited: true })).scope, 'account');
  });

  it('inspects status without writes, alarms, cleanup or revealing another account', async () => {
    mock.method(Date, 'now', () => now);
    const q = fixture(ownerConfig); exhaust(q);
    q.values.set('quota-users', { day: day - 1, subjects: [subject(otherID)] });
    q.values.set(`user:${subject(otherID)}`, { hour: hour - 24, day: day - 1, hourly: 999, daily: 999 });
    const saved = structuredClone([...q.values]), writes = q.mutations;
    const other = await status(q, subject(otherID));
    assert.deepEqual(other.usage, { hourly: 0, daily: 0 });
    assert.equal(other.unlimited, false); assert.equal(other.blockingScope, 'global');
    assert.equal(other.blockingPeriod, 'day'); assert.equal(other.retryAfter, 11 * 3600 + 45 * 60);
    assert.deepEqual(other.resetsAt, { hour: '2026-10-04T13:00:00.000Z', day: '2026-10-05T00:00:00.000Z' });
    assert.equal(Object.hasOwn(other, 'sharedUsage'), false);
    assert.equal(Object.hasOwn(other, 'sharedLimits'), false);
    assert.doesNotMatch(JSON.stringify(other), /999|lease|subject|aaaa|cccc/);
    assert.deepEqual([...q.values], saved); assert.equal(q.mutations, writes);
    for (const body of [{}, { subject: 'bad' }, { subject: null, unlimited: true }, { subject: subject(ownerID), lease: 'x' }]) {
      assert.equal((await q.action('status', body)).status, 400);
    }
    assert.deepEqual([...q.values], saved); assert.equal(q.mutations, writes);
  });
});

describe('authenticated analysis usage', () => {
  it('works without OpenAI configuration and never performs paid calls or mutations', async () => {
    mock.method(Date, 'now', () => now);
    const q = fixture(ownerConfig); exhaust(q);
    const upstream = mock.method(globalThis, 'fetch', async url => {
      assert.equal(url, `${project}/auth/v1/user`); return Response.json(profile(ownerID));
    });
    const saved = structuredClone([...q.values]);
    for (let index = 0; index < 2; index++) {
      const response = await worker.fetch(request(), environment(q));
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json(); assert.equal(body.unlimited, true);
      assert.deepEqual(body.usage, { hourly: 3, daily: 10 });
      for (const secret of [ownerID, sessionID, subject(ownerID), token(), 'synthetic@example.invalid'])
        assert.equal(JSON.stringify(body).includes(secret), false);
    }
    assert.equal(upstream.mock.callCount(), 2); assert.deepEqual([...q.values], saved); assert.equal(q.mutations, 0);
  });

  it('rejects forged owner identities and ignores forged owner headers', async () => {
    mock.method(Date, 'now', () => now);
    const q = fixture(ownerConfig); exhaust(q);
    mock.method(globalThis, 'fetch', async url => {
      assert.equal(url, `${project}/auth/v1/user`); return Response.json(profile(otherID));
    });
    assert.equal((await worker.fetch(request(token(ownerID)), environment(q))).status, 401);
    const response = await worker.fetch(request(token(otherID), '', { 'x-subject': subject(ownerID), 'x-unlimited': 'true' }), environment(q));
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.unlimited, false); assert.deepEqual(body.usage, { hourly: 0, daily: 0 });
    assert.equal(body.allowed, false); assert.equal(Object.hasOwn(body, 'sharedUsage'), false);
    assert.equal(q.mutations, 0);
  });

  it('requires authentication, rejects caller-selected targets and hides internal routes', async () => {
    const q = fixture({ LABEL_PRIVATE_OWNER_UNLIMITED: 'true' });
    const upstream = mock.method(globalThis, 'fetch', () => { throw new Error('No network call expected'); });
    assert.equal((await worker.fetch(new Request('https://nudge.example/v1/account/analysis-usage'), environment(q))).status, 401);
    assert.equal((await worker.fetch(request('34'.repeat(32)), environment(q))).status, 401);
    assert.equal((await worker.fetch(request(privateToken, `?subject=${subject(ownerID)}`), environment(q))).status, 400);
    const privateResponse = await worker.fetch(request(privateToken), environment(q));
    assert.equal(privateResponse.status, 200); assert.equal((await privateResponse.json()).unlimited, true);
    for (const path of ['/status', '/quota/status', '/v1/account/analysis-usage']) {
      const response = await worker.fetch(new Request(`https://nudge.example${path}`, { method: 'POST',
        headers: { authorization: `Bearer ${privateToken}` }, body: JSON.stringify({ subject: subject(ownerID) }) }), environment(q));
      assert.equal(response.status, 404);
    }
    assert.equal(upstream.mock.callCount(), 0); assert.equal(q.mutations, 0);
  });

  it('reports a real admitted mocked analysis once and does not refund it on inspection', async () => {
    const q = fixture(ownerConfig);
    let paid = 0;
    mock.method(globalThis, 'fetch', async url => {
      if (url === `${project}/auth/v1/user`) return Response.json(profile(ownerID));
      assert.equal(url, 'https://api.openai.com/v1/responses'); paid++;
      const extraction = { type: 'product', meal: null, productName: null, brand: null, photoConsistency: 'sameProduct', servingSuggestion: null,
        categoryTag: null, retailer: null, labelKind: 'nutrition', ingredients: null, basis: 'per100g', servingSize: null,
        needsClearerPhoto: false, message: '', nutrients: Object.fromEntries(nutrientKeys.map(key => [key,
          key === 'energyKcal' ? { value: 100, unit: 'kcal' } : key === 'protein' ? { value: 2, unit: 'g' } : null])) };
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(extraction) }] }] });
    });
    const env = environment(q, { OPENAI_API_KEY: 'offline-placeholder', OPENAI_MODEL: 'gpt-4.1-mini' });
    const scan = new Request('https://nudge.example/v1/nutrition-label/analyse', { method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ mimeType: 'image/jpeg', imageBase64: image }) });
    assert.equal((await worker.fetch(scan, env)).status, 200);
    const saved = structuredClone([...q.values]), writes = q.mutations;
    const response = await worker.fetch(request(), env), body = await response.json();
    assert.equal(response.status, 200); assert.deepEqual(body.usage, { hourly: 1, daily: 1 });
    assert.equal(body.allowed, true); assert.equal(body.busy, false); assert.equal(paid, 1);
    assert.deepEqual([...q.values], saved); assert.equal(q.mutations, writes);
  });
});
