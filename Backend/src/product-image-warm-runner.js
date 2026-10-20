import { warmProductImages } from './product-image-warm.js';
import { catalogueIndexStub } from './catalogue-index-object.js';

const STATE_KEY = 'runner-state-v1';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const IMAGE_RUNNER_RECOVERY_MS = 90_000;

export function nextImageWarmAlarm(result, now) {
  if (result?.status === 'complete') {
    const due = Number(result.nextSweepAt);
    return Number.isSafeInteger(due) && due > now ? Math.min(due, now + WEEK_MS) : now + WEEK_MS;
  }
  return now + (['running', 'paused'].includes(result?.status) ? 2_000 : 60_000);
}

// One durable control record drives the existing resumable R2 job. It neither
// owns product facts nor resets the job cursor. Alarms continue without cron
// delivery, the browser, a user session, or a running development laptop.
export class ProductImageWarmRunner {
  constructor(ctx, env, {now = Date.now, run = warmProductImages} = {}) {
    this.ctx = ctx; this.env = env; this.now = now; this.run = run;
  }
  async status() {
    const state = await this.ctx.storage.get(STATE_KEY);
    const nextRunAt = await this.ctx.storage.getAlarm();
    return {status: state?.status || 'not_started', lastRunAt: state?.lastRunAt || null,
      finishedAt: state?.finishedAt || null, nextRunAt, runningUntil: state?.runningUntil || null,
      ...(state?.lastError ? {lastError: state.lastError} : {})};
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.search) return Response.json({code: 'image_runner_request_invalid'}, {status: 400});
    if (request.method === 'GET' && url.pathname === '/status') return Response.json(await this.status());
    if (request.method !== 'POST' || !['/start', '/ensure'].includes(url.pathname)) return Response.json({code: 'route_not_found'}, {status: 404});
    const input = await request.text();
    if (input.length > 32 || !['', '{}'].includes(input.trim())) return Response.json({code: 'image_runner_request_invalid'}, {status: 400});
    if (!this.env.PRODUCT_IMAGES || !this.env.FOOD_CATALOGUE_INDEX) return Response.json({code: 'image_runner_unavailable'}, {status: 503});
    const now = this.now(), state = await this.ctx.storage.get(STATE_KEY), existing = await this.ctx.storage.getAlarm();
    const active = state?.runningUntil > now;
    // Cron repairs absent/stale alarms without pulling a completed sweep's
    // weekly alarm forward every minute. An explicit admin start wakes sooner.
    let scheduledFor = existing;
    if (active) {
      if (existing === null) scheduledFor = state.runningUntil;
    } else if (url.pathname === '/start' || existing === null || existing < now - IMAGE_RUNNER_RECOVERY_MS) scheduledFor = now + 1;
    if (scheduledFor !== existing) await this.ctx.storage.setAlarm(scheduledFor);
    return Response.json({status: active ? 'running' : 'scheduled', scheduledFor,
      lastRunAt: state?.lastRunAt || null, ...(state?.lastError ? {lastError: state.lastError} : {})}, {status: 202});
  }
  async alarm() {
    const began = this.now();
    const previous = await this.ctx.storage.get(STATE_KEY);
    await this.ctx.storage.put(STATE_KEY, {status: 'running', lastRunAt: began, runningUntil: began + IMAGE_RUNNER_RECOVERY_MS,
      ...(previous?.sweepStats ? {sweepStats: previous.sweepStats} : {})});
    // Persist a recovery alarm before external work. Normal completion replaces
    // it; a terminated invocation still has a durable retry scheduled.
    await this.ctx.storage.setAlarm(began + IMAGE_RUNNER_RECOVERY_MS);
    let result;
    try { result = await this.run(this.env, {index: catalogueIndexStub(this.env)}); }
    catch { result = {status: 'failed', lastError: 'image_runner_execution_failed'}; }
    const finishedAt = this.now(), status = ['running', 'paused', 'complete', 'busy', 'failed', 'unavailable'].includes(result?.status) ? result.status : 'failed';
    const lastError = /^image_(?:warm|runner)_[a-z_]{1,80}$/.test(result?.lastError || '') ? result.lastError
      : status === 'failed' ? 'image_runner_execution_failed' : null;
    const sweepStats = typeof result?.startedAt === 'string' && Number.isSafeInteger(result.available) && Number.isSafeInteger(result.failed)
      ? {startedAt: result.startedAt, available: result.available, failed: result.failed} : previous?.sweepStats;
    const baseline = previous?.sweepStats && previous.sweepStats.startedAt === sweepStats?.startedAt ? previous.sweepStats : {available: 0, failed: 0};
    // A fast upstream outage can exhaust image retries while the job still
    // returns paused. Slow the next batch instead of racing through failures.
    const noAvailability = sweepStats && sweepStats.failed > baseline.failed && sweepStats.available <= baseline.available;
    // Persist errors independently of R2: an initial R2 read/write failure can
    // leave no R2 progress object, but must remain visible in diagnostics.
    await this.ctx.storage.put(STATE_KEY, {status, lastRunAt: began, finishedAt, runningUntil: null,
      ...(sweepStats ? {sweepStats} : {}), ...(lastError ? {lastError} : {})});
    await this.ctx.storage.setAlarm(noAvailability && ['running', 'paused'].includes(status)
      ? finishedAt + 60_000 : nextImageWarmAlarm({...result, status}, finishedAt));
  }
}

export function productImageWarmRunnerStub(env) {
  if (!env.PRODUCT_IMAGE_WARM_RUNNER) return null;
  return env.PRODUCT_IMAGE_WARM_RUNNER.get(env.PRODUCT_IMAGE_WARM_RUNNER.idFromName('catalogue-thumbnails-v1'), {locationHint: 'weur'});
}
