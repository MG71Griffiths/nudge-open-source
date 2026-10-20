import { canonicalProductThumbnail, serveProductThumbnail } from './product-images.js';

// This private job record is deliberately outside the public thumbnail prefix.
export const PRODUCT_IMAGE_WARM_KEY = 'jobs/product-image-warm-v1.json';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 32_768;
export const PRODUCT_IMAGE_CHECKPOINT_INTERVAL_MS = 1_100;
const FINAL_FLUSH_RESERVE_MS = PRODUCT_IMAGE_CHECKPOINT_INTERVAL_MS + 500;

function freshProgress(now) {
  return {version: 1, status: 'running', startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    cursor: '', scanned: 0, available: 0, copied: 0, reused: 0, skipped: 0, failed: 0,
    referencedBytes: 0, writtenBytes: 0, pendingPage: null, lease: null};
}

async function readProgress(bucket) {
  const object = await bucket.get(PRODUCT_IMAGE_WARM_KEY);
  if (!object) return {value: null, etag: null, uploadedAt: null};
  if (object.size > MAX_RESPONSE_BYTES) throw new Error('image_warm_progress_invalid');
  const value = await object.json();
  if (value?.version !== 1 || typeof value.cursor !== 'string' || !/^[0-9]{0,18}$/.test(value.cursor)) {
    throw new Error('image_warm_progress_invalid');
  }
  const uploadedAt = typeof object.uploaded?.getTime === 'function' ? object.uploaded.getTime() : Date.parse(object.uploaded || value.updatedAt);
  return {value, etag: object.etag, uploadedAt};
}

function safeResult(progress, extra = {}) {
  const {version, status, startedAt, updatedAt, completedAt, nextSweepAt, cursor, scanned, available, copied,
    reused, skipped, failed, referencedBytes, writtenBytes, lastError} = progress;
  return {version, status, startedAt, updatedAt, completedAt, nextSweepAt, cursor, scanned, available, copied,
    reused, skipped, failed, referencedBytes, writtenBytes, ...(lastError ? {lastError} : {}), ...extra};
}

function validManifest(page, after, limit) {
  if (!page || !Array.isArray(page.images) || !Number.isInteger(page.scanned) || page.scanned < 0 || page.scanned > limit
    || typeof page.hasMore !== 'boolean' || (page.nextAfter !== null && (typeof page.nextAfter !== 'string' || !/^[0-9]{0,18}$/.test(page.nextAfter)))
    || page.images.length > page.scanned || (page.hasMore && (!page.nextAfter || page.nextAfter <= after || page.scanned === 0))) return false;
  let previous = after;
  for (const item of page.images) {
    const canonical = canonicalProductThumbnail(item?.sourceURL);
    if (!canonical || !/^[0-9]{4,18}$/.test(item.barcode || '') || item.barcode <= previous || (page.nextAfter && item.barcode > page.nextAfter)
      || canonical.thumbnailURL !== item.thumbnailURL) return false;
    previous = item.barcode;
  }
  return true;
}

export async function readProductImageWarmStatus(env) {
  if (!env.PRODUCT_IMAGES) return {status: 'unavailable'};
  try {
    const {value} = await readProgress(env.PRODUCT_IMAGES);
    return value ? safeResult(value, {pendingImages: value.pendingPage?.images?.filter(image => !image.done).length || 0}) : {status: 'not_started'};
  } catch { return {status: 'failed', lastError: 'image_warm_progress_unavailable'}; }
}

// An ETag compare-and-swap lease prevents two cron invocations from advancing
// the same cursor. Image writes are revision-addressed and safe to repeat after
// a process crash; referencedBytes counts confirmed records, not bucket usage.
export async function warmProductImages(env, {index, now = Date.now, runID = () => crypto.randomUUID(),
  serveThumbnail = serveProductThumbnail, durationMS = 25_000, maxRecords = 250, concurrency = 4,
  retryLimit = 3, sourceTimeoutMS = 8_000, manifestTimeoutMS = 3_000, sweepIntervalMS = WEEK_MS,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))} = {}) {
  if (!env.PRODUCT_IMAGES || !index) return {status: 'unavailable'};
  const bucket = env.PRODUCT_IMAGES, started = now(), deadline = started + Math.min(25_000, Math.max(1, durationMS));
  const pageLimit = Math.min(4, Math.max(1, concurrency)), leaseID = runID();
  let progress, etag, save, owned = false, attempts = 0, visited = 0, lastWriteAt = -Infinity;
  try {
    const stored = await readProgress(bucket); etag = stored.etag;
    if (stored.value?.lease?.expiresAt > started) return safeResult(stored.value, {status: 'busy'});
    if (stored.value?.status === 'complete' && Number(stored.value.nextSweepAt) > started) return safeResult(stored.value);
    progress = stored.value?.status === 'complete' ? freshProgress(started) : stored.value || freshProgress(started);
    progress.status = 'running'; progress.lease = {id: leaseID, expiresAt: started + 60_000};
    if (Number.isFinite(stored.uploadedAt)) lastWriteAt = Math.min(started, stored.uploadedAt);
    save = async (force = false) => {
      // R2 permits one write per second to an individual key. Coalesce normal
      // progress updates in memory; a mandatory final flush safely commits the
      // latest complete cursor and partial-page state before releasing the lease.
      const wait = Math.max(0, lastWriteAt + PRODUCT_IMAGE_CHECKPOINT_INTERVAL_MS - now());
      if (wait && !force) return false;
      if (wait) await sleep(wait);
      progress.updatedAt = new Date(now()).toISOString();
      let result;
      try {
        result = await bucket.put(PRODUCT_IMAGE_WARM_KEY, JSON.stringify(progress), {
          onlyIf: etag ? {etagMatches: etag} : {etagDoesNotMatch: '*'},
          httpMetadata: {contentType: 'application/json', cacheControl: 'private, no-store'}
        });
      } finally { lastWriteAt = now(); }
      if (!result) { owned = false; throw new Error('image_warm_lease_lost'); }
      etag = result.etag; owned = true; return true;
    };
    await save(true);
    while (attempts < maxRecords && visited < maxRecords && now() + sourceTimeoutMS + FINAL_FLUSH_RESERVE_MS < deadline) {
      if (!progress.pendingPage) {
        const limit = Math.min(pageLimit, maxRecords - visited);
        const url = new URL('https://catalogue-index/image-manifest');
        url.searchParams.set('after', progress.cursor); url.searchParams.set('limit', String(limit));
        const signal = AbortSignal.timeout(Math.min(manifestTimeoutMS, Math.max(1, deadline - now() - FINAL_FLUSH_RESERVE_MS)));
        let response;
        try { response = await index.fetch(url.href, {signal}); }
        catch (error) {
          throw new Error(signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name) ? 'image_warm_manifest_timeout' : 'image_warm_manifest_unavailable');
        }
        if (!response.ok) throw new Error('image_warm_manifest_unavailable');
        let page;
        try { page = await response.json(); }
        catch (error) {
          throw new Error(signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name) ? 'image_warm_manifest_timeout' : 'image_warm_manifest_invalid');
        }
        if (!validManifest(page, progress.cursor, limit)) throw new Error('image_warm_manifest_invalid');
        progress.pendingPage = {...page, images: page.images.map(image => ({...image, attempts: 0, done: false}))};
        await save();
      }
      const page = progress.pendingPage;
      const pending = page.images.filter(image => !image.done).slice(0, Math.min(pageLimit, maxRecords - attempts));
      if (pending.length) {
        attempts += pending.length;
        await Promise.all(pending.map(async image => {
          image.attempts++;
          let response;
          try {
            const url = new URL('https://nudge.invalid/v1/catalogue/image'); url.searchParams.set('source', image.sourceURL);
            response = await serveThumbnail(new Request(url), env, null, {cache: null,
              timeoutMS: Math.min(sourceTimeoutMS, Math.max(1, deadline - now() - FINAL_FLUSH_RESERVE_MS)),
              registeredSource: async candidate => candidate.thumbnailURL === image.thumbnailURL && candidate.sourceURL === image.sourceURL});
            // The response is complete only after the thumbnail helper confirms
            // R2 storage. Do not retain image bodies in the private progress JSON.
            const bytes = Number(response.headers.get('content-length'));
            const cache = response.headers.get('x-nudge-image-cache');
            await response.arrayBuffer();
            if (response.status === 200 && Number.isInteger(bytes) && bytes > 0 && ['stored', 'r2', 'edge'].includes(cache)) {
              image.done = true; progress.available++; progress.referencedBytes += bytes;
              if (cache === 'stored') { progress.copied++; progress.writtenBytes += bytes; } else progress.reused++;
            } else if ([400, 404, 410].includes(response.status)) { image.done = true; progress.skipped++; }
          } catch { /* Transient source or storage errors receive bounded retries. */ }
          if (!image.done && image.attempts >= retryLimit) { image.done = true; progress.failed++; }
        }));
      }
      if (page.images.every(image => image.done)) {
        progress.cursor = page.nextAfter || page.images.at(-1)?.barcode || progress.cursor;
        progress.scanned += page.scanned; visited += page.scanned;
        progress.pendingPage = null; delete progress.lastError;
        if (!page.hasMore) {
          progress.status = 'complete'; progress.completedAt = new Date(now()).toISOString();
          progress.nextSweepAt = now() + sweepIntervalMS;
        }
        if (progress.status === 'complete') break;
      }
      await save();
    }
    if (progress.status !== 'complete') progress.status = 'paused';
    progress.lease = null; await save(true);
    return safeResult(progress);
  } catch (error) {
    const code = /^image_warm_[a-z_]+$/.test(error?.message || '') ? error.message : 'image_warm_storage_unavailable';
    if (progress && owned) {
      progress.status = 'failed'; progress.lastError = code; progress.lease = null;
      try { await save(true); } catch { /* Expiring lease permits the next scheduled retry. */ }
    }
    return progress ? safeResult(progress, {status: code === 'image_warm_lease_lost' ? 'busy' : 'failed', lastError: code}) : {status: 'failed', lastError: code};
  }
}
