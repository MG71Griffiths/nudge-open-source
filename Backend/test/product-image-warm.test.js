import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalProductThumbnail } from '../src/product-images.js';
import { PRODUCT_IMAGE_WARM_KEY, PRODUCT_IMAGE_CHECKPOINT_INTERVAL_MS, readProductImageWarmStatus, warmProductImages } from '../src/product-image-warm.js';

class Bucket {
  constructor() { this.objects = new Map(); this.writes = 0; }
  async get(key) {
    const record = this.objects.get(key);
    return record ? {etag: record.etag, size: record.text.length, json: async () => JSON.parse(record.text)} : null;
  }
  async put(key, text, options = {}) {
    const old = this.objects.get(key), condition = options.onlyIf;
    if (condition?.etagMatches && condition.etagMatches !== old?.etag || condition?.etagDoesNotMatch === '*' && old) return null;
    const record = {text: String(text), etag: `version-${++this.writes}`};
    this.objects.set(key, record); return {etag: record.etag};
  }
  progress() { return JSON.parse(this.objects.get(PRODUCT_IMAGE_WARM_KEY)?.text || 'null'); }
}
function image(number) {
  const barcode = String(5_000_000_000_000 + number);
  const path = `${barcode.slice(0, 3)}/${barcode.slice(3, 6)}/${barcode.slice(6, 9)}/${barcode.slice(9)}`;
  return {...canonicalProductThumbnail(`https://images.openfoodfacts.org/images/products/${path}/front_en.3.400.jpg`), barcode};
}
function indexFor(rows) {
  const calls = [];
  return {calls, async fetch(input) {
    const url = new URL(input), after = url.searchParams.get('after'), limit = Number(url.searchParams.get('limit'));
    calls.push({after, limit});
    const all = rows.filter(row => row.barcode > after), page = all.slice(0, limit), hasMore = all.length > limit;
    return Response.json({images: page.filter(row => !row.noImage), scanned: page.length, hasMore, nextAfter: hasMore ? page.at(-1).barcode : null});
  }};
}
const stored = () => new Response(new Uint8Array(123), {headers: {'content-length': '123', 'x-nudge-image-cache': 'stored'}});
const reused = () => new Response(new Uint8Array(123), {headers: {'content-length': '123', 'x-nudge-image-cache': 'r2'}});
const options = {now: () => 1_000_000, runID: () => 'test-run', sleep: async () => {}};

test('warmer reads multiple pages, preserves attribution source, and records confirmed copies', async () => {
  const bucket = new Bucket(), index = indexFor(Array.from({length: 10}, (_, n) => image(n + 1))), calls = [];
  const result = await warmProductImages({PRODUCT_IMAGES: bucket}, {...options, index, serveThumbnail: async (request, env, ctx, config) => {
    const canonical = canonicalProductThumbnail(new URL(request.url).searchParams.get('source'));
    assert.equal(await config.registeredSource(canonical), true);
    assert.equal(await config.registeredSource({...canonical, sourceURL: image(100).sourceURL}), false);
    assert.equal(config.cache, null); assert.equal(ctx, null); calls.push(canonical.barcode); return stored();
  }});
  assert.equal(result.status, 'complete'); assert.equal(result.scanned, 10); assert.equal(result.available, 10);
  assert.equal(result.copied, 10); assert.equal(result.referencedBytes, 1230); assert.equal(result.writtenBytes, 1230);
  assert.equal(new Set(calls).size, 10); assert.equal(index.calls.length, 3); assert.equal(bucket.progress().lease, null);
  assert.equal(bucket.progress().pendingPage, null);
  const alreadyComplete = await warmProductImages({PRODUCT_IMAGES: bucket}, {...options, index, serveThumbnail: stored});
  assert.equal(alreadyComplete.status, 'complete'); assert.equal(index.calls.length, 3);
});

test('empty catalogue completes, and missing image rows advance without source calls', async () => {
  const bucket = new Bucket();
  assert.equal((await warmProductImages({PRODUCT_IMAGES: bucket}, {...options, index: indexFor([]), serveThumbnail: stored})).status, 'complete');
  assert.equal(bucket.progress().scanned, 0);
  const missingBucket = new Bucket(), rows = Array.from({length: 9}, (_, n) => ({...image(n), noImage: true}));
  const result = await warmProductImages({PRODUCT_IMAGES: missingBucket}, {...options, index: indexFor(rows), serveThumbnail: () => assert.fail('no image to fetch')});
  assert.equal(result.status, 'complete'); assert.equal(result.scanned, 9); assert.equal(result.available, 0);
});

test('record cap resumes from the completed page without skipping or repeating images', async () => {
  const bucket = new Bucket(), index = indexFor(Array.from({length: 9}, (_, n) => image(n + 1))), seen = [];
  const config = {...options, index, maxRecords: 4, serveThumbnail: async request => { seen.push(new URL(request.url).searchParams.get('source')); return reused(); }};
  const first = await warmProductImages({PRODUCT_IMAGES: bucket}, config);
  assert.equal(first.status, 'paused'); assert.equal(first.scanned, 4); assert.equal(first.cursor, image(4).barcode);
  assert.equal((await warmProductImages({PRODUCT_IMAGES: bucket}, config)).scanned, 8);
  const last = await warmProductImages({PRODUCT_IMAGES: bucket}, config);
  assert.equal(last.status, 'complete'); assert.equal(last.scanned, 9); assert.equal(last.reused, 9); assert.equal(last.writtenBytes, 0);
  assert.equal(new Set(seen).size, 9); assert.equal(seen.length, 9);
});

test('retries transient responses at most three times while permanently missing photos do not stall import', async () => {
  const bucket = new Bucket(), index = indexFor([image(1), image(2), image(3)]), counts = new Map();
  const result = await warmProductImages({PRODUCT_IMAGES: bucket}, {...options, index, serveThumbnail: async request => {
    const barcode = canonicalProductThumbnail(new URL(request.url).searchParams.get('source')).barcode;
    counts.set(barcode, (counts.get(barcode) || 0) + 1);
    if (barcode === image(1).barcode) return new Response(null, {status: 404});
    if (barcode === image(2).barcode) return new Response(null, {status: 502});
    return counts.get(barcode) < 3 ? new Response(null, {status: 504}) : stored();
  }});
  assert.equal(result.status, 'complete'); assert.equal(result.skipped, 1); assert.equal(result.failed, 1); assert.equal(result.available, 1);
  assert.equal(counts.get(image(1).barcode), 1); assert.equal(counts.get(image(2).barcode), 3); assert.equal(counts.get(image(3).barcode), 3);
});

test('deadline retains a partial page, retry count and completed records for the next tick', async () => {
  const bucket = new Bucket(), index = indexFor([image(1), image(2)]); let clock = 1_000_000, fail = true;
  const config = {...options, now: () => clock, index, serveThumbnail: async request => {
    const barcode = canonicalProductThumbnail(new URL(request.url).searchParams.get('source')).barcode;
    if (barcode === image(2).barcode && fail) { clock += 20_000; return new Response(null, {status: 504}); }
    return stored();
  }};
  const first = await warmProductImages({PRODUCT_IMAGES: bucket}, config);
  assert.equal(first.status, 'paused'); assert.equal(first.cursor, ''); assert.equal(first.available, 1); assert.equal(first.scanned, 0);
  assert.equal(bucket.progress().pendingPage.images[1].attempts, 1);
  fail = false; clock += 60_000;
  const second = await warmProductImages({PRODUCT_IMAGES: bucket}, config);
  assert.equal(second.status, 'complete'); assert.equal(second.scanned, 2); assert.equal(second.copied, 2);
  assert.equal(index.calls.length, 1); assert.equal(second.referencedBytes, 246);
});

test('overlapping invocations cannot acquire the active lease', async () => {
  const bucket = new Bucket(), index = indexFor([image(1)]); let release, signalStarted;
  const started = new Promise(resolve => {signalStarted = resolve;});
  const blocked = new Promise(resolve => {release = resolve;});
  const first = warmProductImages({PRODUCT_IMAGES: bucket}, {...options, index, serveThumbnail: async () => { signalStarted(); await blocked; return stored(); }});
  await started;
  const overlap = await warmProductImages({PRODUCT_IMAGES: bucket}, {...options, runID: () => 'other', index, serveThumbnail: () => assert.fail('must not copy')});
  assert.equal(overlap.status, 'busy'); release(); assert.equal((await first).status, 'complete'); assert.equal(index.calls.length, 1);
});

test('lost ETag lease does not overwrite another owner checkpoint', async () => {
  const bucket = new Bucket(), index = indexFor([image(1)]);
  const result = await warmProductImages({PRODUCT_IMAGES: bucket}, {...options, index, serveThumbnail: async () => {
    const record = bucket.progress(); record.lease = {id: 'new-owner', expiresAt: 2_000_000}; record.available = 42;
    await bucket.put(PRODUCT_IMAGE_WARM_KEY, JSON.stringify(record)); return stored();
  }});
  assert.equal(result.status, 'busy'); assert.equal(bucket.progress().available, 42); assert.equal(bucket.progress().lease.id, 'new-owner');
});

test('manifest failures preserve cursor and produce retryable diagnostics without private data', async () => {
  const bucket = new Bucket();
  const failed = await warmProductImages({PRODUCT_IMAGES: bucket}, {...options, index: {fetch: async () => new Response(null, {status: 503})}});
  assert.equal(failed.status, 'failed'); assert.equal(failed.cursor, ''); assert.equal(failed.lastError, 'image_warm_manifest_unavailable');
  assert.equal(bucket.progress().lease, null);
  assert.equal((await warmProductImages({PRODUCT_IMAGES: bucket}, {...options, index: indexFor([image(1)]), serveThumbnail: stored})).status, 'complete');
  const status = await readProductImageWarmStatus({PRODUCT_IMAGES: bucket});
  assert.equal(status.pendingPage, undefined); assert.equal(status.lease, undefined); assert.equal(status.available, 1);
});

test('invalid cursor pages are rejected instead of silently skipping catalogue records', async () => {
  const bucket = new Bucket();
  const result = await warmProductImages({PRODUCT_IMAGES: bucket}, {...options, index: {fetch: async () => Response.json({images: [image(2), image(1)], scanned: 2, nextAfter: image(2).barcode, hasMore: true})}});
  assert.equal(result.status, 'failed'); assert.equal(result.lastError, 'image_warm_manifest_invalid'); assert.equal(result.scanned, 0);
});

test('weekly sweep revisits changed revisions without accumulating misleading prior-sweep counters', async () => {
  const bucket = new Bucket(), index = indexFor([image(1)]);
  await warmProductImages({PRODUCT_IMAGES: bucket}, {...options, index, serveThumbnail: stored});
  const laterTime = bucket.progress().nextSweepAt + 1;
  const later = await warmProductImages({PRODUCT_IMAGES: bucket}, {...options, now: () => laterTime, index, serveThumbnail: reused});
  assert.equal(later.status, 'complete'); assert.equal(later.available, 1); assert.equal(later.reused, 1); assert.equal(later.copied, 0);
});

function rateLimitedFixture() {
  let clock = 1_000_123;
  const bucket = new Bucket(), writes = [], sleeps = [];
  const originalGet = bucket.get.bind(bucket), originalPut = bucket.put.bind(bucket);
  bucket.get = async key => {
    const value = await originalGet(key);
    return value ? {...value, uploaded: new Date(writes.at(-1))} : null;
  };
  bucket.put = async (key, value, condition) => {
    if (writes.length) assert.ok(clock - writes.at(-1) >= PRODUCT_IMAGE_CHECKPOINT_INTERVAL_MS, 'R2 key must not be rewritten within 1.1 seconds');
    const result = await originalPut(key, value, condition);
    if (result) writes.push(clock);
    return result;
  };
  return {bucket, writes, sleeps, now: () => clock, advance: ms => {clock += ms;}, sleep: async ms => {sleeps.push(ms); clock += ms;}};
}

test('rapid pages coalesce into two rate-safe writes and final flush retains the complete cursor and counters', async () => {
  const fixture = rateLimitedFixture(), index = indexFor(Array.from({length: 20}, (_, n) => image(n + 1)));
  const result = await warmProductImages({PRODUCT_IMAGES: fixture.bucket}, {...options, ...fixture, index, serveThumbnail: async () => {
    fixture.advance(10); return stored();
  }});
  assert.equal(result.status, 'complete'); assert.equal(result.scanned, 20); assert.equal(result.available, 20);
  assert.equal(result.cursor, image(20).barcode); assert.equal(fixture.bucket.progress().available, 20);
  assert.equal(fixture.bucket.progress().lease, null); assert.equal(fixture.writes.length, 2);
  assert.deepEqual(fixture.sleeps, [900]);
});

test('longer copy runs checkpoint periodically at the R2 key write rate', async () => {
  const fixture = rateLimitedFixture(), index = indexFor(Array.from({length: 40}, (_, n) => image(n + 1)));
  const result = await warmProductImages({PRODUCT_IMAGES: fixture.bucket}, {...options, ...fixture, index, serveThumbnail: async () => {
    fixture.advance(100); return reused();
  }});
  assert.equal(result.status, 'complete'); assert.equal(fixture.bucket.progress().scanned, 40);
  assert.ok(fixture.writes.length >= 4); assert.ok(fixture.writes.length <= 5);
  assert.equal(fixture.bucket.progress().reused, 40); assert.equal(fixture.bucket.progress().lease, null);
});

test('a rapid following run waits from R2 uploaded millisecond precision before acquiring its lease', async () => {
  const fixture = rateLimitedFixture(), index = indexFor(Array.from({length: 8}, (_, n) => image(n + 1)));
  const config = {...options, ...fixture, index, maxRecords: 4, serveThumbnail: stored};
  assert.equal((await warmProductImages({PRODUCT_IMAGES: fixture.bucket}, config)).status, 'paused');
  fixture.advance(75);
  assert.equal((await warmProductImages({PRODUCT_IMAGES: fixture.bucket}, config)).status, 'complete');
  assert.equal(fixture.writes.length, 4); assert.deepEqual(fixture.sleeps, [1100, 1025, 1100]);
});

test('failure diagnostics flush at the same rate without losing the completed page cursor', async () => {
  const fixture = rateLimitedFixture(), successful = indexFor(Array.from({length: 8}, (_, n) => image(n + 1)));
  let pages = 0;
  const index = {fetch: async (...args) => ++pages === 1 ? successful.fetch(...args) : new Response(null, {status: 503})};
  const result = await warmProductImages({PRODUCT_IMAGES: fixture.bucket}, {...options, ...fixture, index, serveThumbnail: stored});
  assert.equal(result.status, 'failed'); assert.equal(fixture.bucket.progress().cursor, image(4).barcode);
  assert.equal(fixture.bucket.progress().scanned, 4); assert.equal(fixture.bucket.progress().available, 4);
  assert.equal(fixture.bucket.progress().lease, null); assert.equal(fixture.writes.length, 2); assert.deepEqual(fixture.sleeps, [1100]);
});

test('copy timeout leaves time for the mandatory checkpoint within the run deadline', async () => {
  const fixture = rateLimitedFixture(), beginning = fixture.now(), index = indexFor(Array.from({length: 20}, (_, n) => image(n + 1)));
  const result = await warmProductImages({PRODUCT_IMAGES: fixture.bucket}, {...options, ...fixture, index, concurrency: 1,
    serveThumbnail: async (_request, _env, _ctx, config) => {
      fixture.advance(config.timeoutMS); return new Response(null, {status: 504});
    }});
  assert.equal(result.status, 'paused'); assert.ok(fixture.now() - beginning <= 25_000);
  assert.equal(fixture.bucket.progress().pendingPage.images[0].attempts, 2);
  assert.equal(fixture.bucket.progress().lease, null);
});

test('manifest network, timeout and JSON failures are diagnosed separately from progress storage', async () => {
  for (const [fetch, expected] of [
    [async () => {throw new DOMException('Synthetic timeout', 'TimeoutError');}, 'image_warm_manifest_timeout'],
    [async () => {throw new TypeError('Synthetic fetch failure');}, 'image_warm_manifest_unavailable'],
    [async () => new Response('invalid JSON'), 'image_warm_manifest_invalid'],
    [async () => ({ok: true, json: async () => {throw new DOMException('Body timeout', 'AbortError');}}), 'image_warm_manifest_timeout']
  ]) {
    const bucket = new Bucket();
    const result = await warmProductImages({PRODUCT_IMAGES: bucket}, {...options, index: {fetch}});
    assert.equal(result.lastError, expected); assert.equal(result.cursor, ''); assert.equal(bucket.progress().lease, null);
  }
});

test('custom public manifest timeout still reserves time for source work and final checkpoint', async () => {
  const fixture = rateLimitedFixture(), start = fixture.now();
  const index = {fetch: async (_url, {signal}) => {
    assert.equal(signal.aborted, false); fixture.advance(7_000);
    return Response.json({images: [image(1)], scanned: 1, nextAfter: null, hasMore: false});
  }};
  const result = await warmProductImages({PRODUCT_IMAGES: fixture.bucket}, {...options, ...fixture, index, manifestTimeoutMS: 8_000,
    serveThumbnail: async (_request, _env, _ctx, config) => {fixture.advance(config.timeoutMS); return stored();}});
  assert.equal(result.status, 'complete'); assert.equal(result.available, 1); assert.ok(fixture.now() - start <= 25_000);
});
