#!/usr/bin/env node
import {requireAdminOrigin} from './require-admin-origin.mjs';
// Optional bounded accelerator. The scheduled cloud job works independently of
// this process and does not require the laptop to remain powered on.
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PRODUCT_IMAGE_WARM_KEY, warmProductImages } from '../src/product-image-warm.js';

export const PRODUCT_IMAGE_ORIGIN = process.env.NUDGE_ADMIN_ORIGIN || '';

export function parseWarmArguments(args) {
  requireAdminOrigin(PRODUCT_IMAGE_ORIGIN);
  const values = {origin: PRODUCT_IMAGE_ORIGIN, checkpoint: '.local/catalogue-images/thumbnail-warm.json', maxRecords: 1000, minutes: 5, concurrency: 4};
  const numeric = {'--max-records': ['maxRecords', 1, 1_000_000], '--minutes': ['minutes', 1, 60], '--concurrency': ['concurrency', 1, 4]};
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Every option needs a value.');
    if (key === '--token-file') values.tokenFile = value;
    else if (key === '--checkpoint') values.checkpoint = value;
    else if (key === '--origin') values.origin = value;
    else if (numeric[key]) {
      const [name, min, max] = numeric[key], number = Number(value);
      if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid ${key}.`);
      values[name] = number;
    } else throw new Error('Unknown option.');
  }
  // Admin credentials must never be redirected or sent to a caller-supplied host.
  if (values.origin !== PRODUCT_IMAGE_ORIGIN) throw new Error('Use the explicitly configured administrative origin.');
  if (!values.tokenFile) throw new Error('--token-file is required; never pass the token itself.');
  values.checkpoint = resolve(values.checkpoint); values.tokenFile = resolve(values.tokenFile);
  if (values.checkpoint === values.tokenFile) throw new Error('Checkpoint and token paths must be different.');
  return values;
}

export function diskProgressBucket(path) {
  const digest = text => createHash('sha256').update(text).digest('hex');
  const read = async () => {
    try { const text = await readFile(path, 'utf8'); return {text, etag: digest(text)}; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  return {
    async get(key) {
      if (key !== PRODUCT_IMAGE_WARM_KEY) throw new Error('Unexpected progress key.');
      const value = await read();
      return value ? {size: Buffer.byteLength(value.text), etag: value.etag, json: async () => JSON.parse(value.text)} : null;
    },
    async put(key, text, options = {}) {
      if (key !== PRODUCT_IMAGE_WARM_KEY) throw new Error('Unexpected progress key.');
      const old = await read(), condition = options.onlyIf;
      if (condition?.etagMatches && condition.etagMatches !== old?.etag || condition?.etagDoesNotMatch === '*' && old) return null;
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, text, {mode: 0o600}); await rename(temporary, path);
      return {etag: digest(text)};
    }
  };
}

export async function runImageWarmCLI(values, {fetcher = fetch, output = value => process.stdout.write(`${JSON.stringify(value)}\n`)} = {}) {
  if (values.origin !== PRODUCT_IMAGE_ORIGIN) throw new Error('Use the explicitly configured administrative origin.');
  const token = (await readFile(values.tokenFile, 'utf8')).trim();
  if (!/^[A-Za-z0-9._~-]{16,8192}$/.test(token)) throw new Error('The token file is not valid.');
  await mkdir(dirname(values.checkpoint), {recursive: true, mode: 0o700});
  const lockPath = `${values.checkpoint}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('This checkpoint is locked by another run.'); throw error; }
  try {
    await lock.writeFile(JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}));
    const bucket = diskProgressBucket(values.checkpoint), initial = await bucket.get(PRODUCT_IMAGE_WARM_KEY);
    const initialValue = initial ? await initial.json() : null;
    const initialScanned = initialValue?.status === 'complete' && initialValue.nextSweepAt <= Date.now() ? 0 : initialValue?.scanned || 0;
    let last, consecutiveFailures = 0;
    const deadline = Date.now() + values.minutes * 60_000;
    while (Date.now() + 9_000 < deadline) {
      const remaining = values.maxRecords - Math.max(0, (last?.scanned || initialScanned) - initialScanned);
      if (remaining <= 0) break;
      last = await warmProductImages({PRODUCT_IMAGES: bucket}, {
        concurrency: values.concurrency, maxRecords: Math.min(250, remaining), durationMS: Math.min(25_000, deadline - Date.now()),
        // The cloud cron talks directly to a Durable Object. This optional
        // laptop transport needs additional room for the public HTTPS round trip.
        manifestTimeoutMS: 8_000,
        index: {fetch: async (input, options) => {
          const route = new URL('/v1/catalogue/image-manifest', values.origin); route.search = new URL(input).search;
          return fetcher(route, {...options, redirect: 'error', headers: {authorization: `Bearer ${token}`, accept: 'application/json'}});
        }},
        serveThumbnail: async (request, _env, _ctx, options) => {
          const route = new URL('/v1/catalogue/image', values.origin); route.search = new URL(request.url).search;
          return fetcher(route, {redirect: 'error', signal: AbortSignal.timeout(options.timeoutMS), headers: {accept: 'image/jpeg'}});
        }
      });
      output(last);
      if (['complete', 'busy', 'unavailable'].includes(last.status)) break;
      consecutiveFailures = last.status === 'failed' ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= 3) break;
      if (consecutiveFailures) await new Promise(resolve => setTimeout(resolve, 1_000 * consecutiveFailures));
    }
    return last || {status: 'paused'};
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runImageWarmCLI(parseWarmArguments(process.argv.slice(2)));
    if (['failed', 'unavailable'].includes(result.status)) process.exitCode = 1;
  } catch (error) {
    // Network errors may contain headers or paths in third-party runtimes. Print
    // only the deliberate configuration messages, never arbitrary error objects.
    const safe = ['Set NUDGE_ADMIN_ORIGIN to your HTTPS service origin before running an administrative command.', 'Invalid administrative HTTPS origin.', 'Use an HTTPS origin without credentials, path, query or fragment.', 'Every option needs a value.', 'Unknown option.', 'Use the explicitly configured administrative origin.',
      '--token-file is required; never pass the token itself.', 'Checkpoint and token paths must be different.',
      'The token file is not valid.', 'This checkpoint is locked by another run.', 'Invalid --max-records.', 'Invalid --minutes.', 'Invalid --concurrency.'];
    process.stderr.write(`${safe.includes(error.message) ? error.message : 'Thumbnail warm failed; the checkpoint is retained for resume.'}\n`);
    process.exitCode = 1;
  }
}
