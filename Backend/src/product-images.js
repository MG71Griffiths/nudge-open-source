// Public, revision-addressed product thumbnails. This module never accepts
// personal uploads and never changes the catalogue's original evidence URLs.
export const PRODUCT_IMAGE_VERSION = 'thumbnail-v1';
export const PRODUCT_IMAGE_MAX_BYTES = 262_144;
export const PRODUCT_IMAGE_TIMEOUT_MS = 8_000;
export const PRODUCT_IMAGE_LICENCE = 'https://creativecommons.org/licenses/by-sa/3.0/';
const immutable = 'public, max-age=31536000, immutable';
const pending = new Map();
const encoder = new TextEncoder();

export function canonicalProductThumbnail(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !['images.openfoodfacts.org', 'images.openfoodfacts.net'].includes(url.hostname)) return null;
    // Reject encoded and normalised path tricks before resolving the source.
    if (value.includes('%') || /(?:\/|\\)\.\.(?:\/|\\)/.test(value) || value.includes('\\')) return null;
    const path = /^\/images\/products\/((?:[0-9]+\/){1,6})([^/]+)$/.exec(url.pathname);
    if (!path) return null;
    const barcode = path[1].replaceAll('/', '');
    if (!/^[0-9]{4,18}$/.test(barcode)) return null;
    let filename = path[2];
    if (/^front(?:_[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?)?\.[0-9]+\.(?:100|200|400|full)\.jpg$/.test(filename)) {
      filename = filename.replace(/\.(?:100|200|400|full)\.jpg$/, '.200.jpg');
    } else if (/^[0-9]+(?:\.(?:100|200|400|full))?\.jpg$/.test(filename)) filename = filename.replace(/(?:\.(?:100|200|400|full))?\.jpg$/, '.100.jpg');
    else return null;
    return {barcode, sourceURL: value, thumbnailURL: `https://images.openfoodfacts.org/images/products/${path[1]}${filename}`,
      sourcePageURL: `https://world.openfoodfacts.org/product/${barcode}`, licenceURL: PRODUCT_IMAGE_LICENCE};
  } catch { return null; }
}

// The order matches native product selection: English/local front first, with
// the small rendition preferred. All retained candidates can validate a miss.
export function productThumbnailCandidates(product) {
  const candidates = [], front = product?.selected_images?.front;
  if (front && typeof front === 'object') for (const size of ['small', 'thumb', 'display']) {
    const languages = front[size];
    if (!languages || typeof languages !== 'object' || Array.isArray(languages)) continue;
    for (const language of ['en', product.lc, ...Object.keys(languages).sort()]) if (language) candidates.push(languages[language]);
  }
  candidates.push(product?.image_front_small_url, product?.image_front_url, product?.image_url);
  const seen = new Set();
  return candidates.map(canonicalProductThumbnail).filter(value => value && !seen.has(value.thumbnailURL) && seen.add(value.thumbnailURL));
}

export async function productThumbnailKey(thumbnailURL) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(thumbnailURL));
  return `${PRODUCT_IMAGE_VERSION}/${Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')}.jpg`;
}

class ImageError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new ImageError(status, code); };

// Check the JPEG frame rather than trusting a .200 filename or Content-Type.
export function thumbnailJPEGDimensions(bytes) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) return null;
      return {height: bytes[offset + 3] * 256 + bytes[offset + 4], width: bytes[offset + 5] * 256 + bytes[offset + 6]};
    }
    offset += length;
  }
  return null;
}

async function boundedImage(response, signal) {
  const reject = async (status, code) => { try { await response.body?.cancel(); } catch { /* Already closed. */ } fail(status, code); };
  if (!response.ok) return reject(response.status === 404 ? 404 : 502, 'product_image_source_unavailable');
  if (!/^image\/jpeg(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) return reject(502, 'product_image_invalid');
  const declared = Number(response.headers.get('content-length'));
  if (declared > PRODUCT_IMAGE_MAX_BYTES || !response.body) return reject(502, 'product_image_invalid');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, {once: true});
  try {
    while (true) {
      if (signal.aborted) fail(504, 'product_image_timeout');
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PRODUCT_IMAGE_MAX_BYTES) { await reader.cancel(); fail(502, 'product_image_invalid'); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  if (signal.aborted) fail(504, 'product_image_timeout');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const dimensions = thumbnailJPEGDimensions(bytes);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || Math.max(dimensions.width, dimensions.height) > 200) fail(502, 'product_image_invalid');
  return bytes;
}

function imageResponse(bytes, image, cache, etag) {
  return new Response(bytes, {headers: {'content-type': 'image/jpeg', 'content-length': String(bytes.byteLength),
    'cache-control': immutable, 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin', 'x-nudge-image-cache': cache,
    'x-nudge-image-source': 'Open Food Facts', etag,
    link: `<${image.sourcePageURL}>; rel="describedby", <${image.licenceURL}>; rel="license"`}});
}
function selectedResponse(response, request, cache) {
  const headers = new Headers(response.headers);
  if (cache) headers.set('x-nudge-image-cache', cache);
  if (request.headers.get('if-none-match') === headers.get('etag')) return new Response(null, {status: 304, headers});
  return new Response(request.method === 'HEAD' ? null : response.body, {status: response.status, headers});
}

export async function serveProductThumbnail(request, env, ctx, {registeredSource, fetcher = fetch, cache = globalThis.caches?.default,
  timeoutMS = PRODUCT_IMAGE_TIMEOUT_MS} = {}) {
  const url = new URL(request.url), source = url.searchParams.get('source');
  const image = canonicalProductThumbnail(source);
  if (!['GET', 'HEAD'].includes(request.method) || !image || [...url.searchParams.keys()].some(key => key !== 'source') || url.searchParams.getAll('source').length !== 1) {
    return Response.json({code: 'product_image_request_invalid'}, {status: 400, headers: {'cache-control': 'no-store'}});
  }
  if (!env.PRODUCT_IMAGES) return Response.json({code: 'product_image_storage_unavailable'}, {status: 503, headers: {'cache-control': 'no-store'}});
  const key = await productThumbnailKey(image.thumbnailURL), cacheURL = new URL('/v1/catalogue/image', url.origin);
  cacheURL.searchParams.set('source', image.thumbnailURL);
  const cacheRequest = new Request(cacheURL, {method: 'GET'});
  try {
    try { const cached = await cache?.match(cacheRequest); if (cached?.ok) return selectedResponse(cached, request, 'edge'); } catch { /* R2 remains available if edge cache fails. */ }
    let work = pending.get(key);
    if (!work) {
      work = (async () => {
        const controller = new AbortController();
        let timer;
        const timedOut = new Promise((_, reject) => { timer = setTimeout(() => {controller.abort(); reject(new ImageError(504, 'product_image_timeout'));}, timeoutMS); });
        try {
          return await Promise.race([timedOut, (async () => {
            const stored = await env.PRODUCT_IMAGES.get(key);
            if (stored) {
              if (stored.size > PRODUCT_IMAGE_MAX_BYTES) fail(502, 'product_image_invalid');
              return {bytes: new Uint8Array(await stored.arrayBuffer()), cache: 'r2', etag: stored.httpEtag || `"${key}"`};
            }
            // Only catalogue-owned front photos may create storage objects.
            // A syntactically official URL is insufficient authorization.
            if (typeof registeredSource !== 'function') fail(503, 'product_image_catalogue_unavailable');
            if (!await registeredSource(image, controller.signal)) fail(404, 'product_image_not_in_catalogue');
            if (controller.signal.aborted) fail(504, 'product_image_timeout');
            // Workers supports manual/follow (not redirect:error). Manual plus
            // the non-2xx check below prevents redirecting to another host.
            const response = await fetcher(image.thumbnailURL, {redirect: 'manual', signal: controller.signal,
              headers: {accept: 'image/jpeg', 'user-agent': 'Nudge/1.0 (product catalogue thumbnails; https://configure-nudge-backend.invalid)'}});
            const bytes = await boundedImage(response, controller.signal);
            const saved = await env.PRODUCT_IMAGES.put(key, bytes, {httpMetadata: {contentType: 'image/jpeg', cacheControl: immutable},
              customMetadata: {sourceURL: image.sourceURL, thumbnailURL: image.thumbnailURL, barcode: image.barcode,
                sourcePageURL: image.sourcePageURL, licenceURL: image.licenceURL, attribution: 'Open Food Facts contributors',
                retrievedAt: new Date().toISOString(), version: PRODUCT_IMAGE_VERSION}});
            return {bytes, cache: 'stored', etag: saved?.httpEtag || `"${key}"`};
          })()]);
        } finally { clearTimeout(timer); }
      })();
      pending.set(key, work);
      work.finally(() => { if (pending.get(key) === work) pending.delete(key); }).catch(() => {});
    }
    const result = await work, response = imageResponse(result.bytes, image, result.cache, result.etag);
    if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(cacheRequest, response.clone()).catch(() => {}));
    return selectedResponse(response, request);
  } catch (error) {
    if (!(error instanceof ImageError)) console.warn(JSON.stringify({event: 'product_image_failure',
      name: String(error?.name || 'Error').slice(0, 60), message: String(error?.message || '').slice(0, 160)}));
    return Response.json({code: error instanceof ImageError ? error.code : 'product_image_unavailable'}, {
      status: error instanceof ImageError ? error.status : 502, headers: {'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}});
  }
}
