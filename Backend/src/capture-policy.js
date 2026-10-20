// Explicit opt-in keeps already accepted/historical jobs compatible. The
// policy is part of the immutable private upload, never a caller-supplied budget.
export const FAST_CAPTURE_POLICY = Object.freeze({version:1,mode:'fast'});
export function isFastCapture(body) {
  return body?.analysisPolicy?.version === 1 && body.analysisPolicy.mode === 'fast';
}
export function validCapturePolicy(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'mode,version'
    && value.version === 1 && value.mode === 'fast';
}

// Only counts and bounded operational identifiers cross this diagnostic boundary.
// No provider text, input, images, transcript, account ID or credentials belong here.
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;
export function responseUsage(value) {
  if (!value || !integer(value.input_tokens) || !integer(value.output_tokens)
    || !integer(value.total_tokens) || value.total_tokens !== value.input_tokens + value.output_tokens) return null;
  const cached = value.input_tokens_details?.cached_tokens ?? null;
  const written = value.input_tokens_details?.cache_write_tokens ?? null;
  const reasoning = value.output_tokens_details?.reasoning_tokens ?? null;
  if (![cached,written,reasoning].every(value=>value===null||integer(value))
    || (cached||0) + (written||0) > value.input_tokens || reasoning > value.output_tokens) return null;
  return {inputTokens:value.input_tokens,cachedInputTokens:cached,cacheWriteTokens:written,
    outputTokens:value.output_tokens,reasoningTokens:reasoning,totalTokens:value.total_tokens};
}

// USD per million tokens, represented as integer microdollars. These are
// versioned estimates, not an invoice. Reverify before changing the model.
// https://developers.openai.com/api/docs/models/gpt-4.1-mini
// https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe
export const CAPTURE_PRICE_VERSION = 'openai-standard-2026-10-20';
const prices = {
  'gpt-4.1-mini': {input:400_000,cached:100_000,output:1_600_000,context:1_047_576,maxOutput:32_768},
  'gpt-4o-mini-transcribe': {input:1_250_000,cached:null,output:5_000_000,context:16_000,maxOutput:2_000}
};
const price = model => prices[model] || (model === 'gpt-4.1-mini-2025-04-14' ? prices['gpt-4.1-mini'] : null);
export function usageCostMicrousd(model, usage) {
  const rates = price(model);
  if (!rates || !usage || usage.cachedInputTokens===null || usage.cacheWriteTokens===null
    || usage.cacheWriteTokens || usage.cachedInputTokens && rates.cached === null) return null;
  return Math.ceil(((usage.inputTokens - usage.cachedInputTokens) * rates.input
    + usage.cachedInputTokens * (rates.cached || 0) + usage.outputTokens * rates.output) / 1_000_000);
}
export function captureReservationMicrousd(model, kind, maximumOutput) {
  const rates = price(model);
  if (!rates || (kind === 'transcription') !== (model === 'gpt-4o-mini-transcribe')
    || !['observation','recheck','transcription'].includes(kind)
    || !Number.isSafeInteger(maximumOutput) || maximumOutput < 1 || maximumOutput > rates.maxOutput) return null;
  // Reserve a full context at uncached rates, plus output separately (deliberately
  // conservative). This does not depend on a guessed image-token conversion.
  return Math.ceil((rates.context * rates.input + maximumOutput * rates.output) / 1_000_000);
}
export function captureSpendStop(env) {
  const raw = env.CAPTURE_DAILY_SPEND_STOP_MICROUSD;
  if (raw === undefined || raw === null || raw === '') return null;
  const number = typeof raw === 'number' || typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(number) || number < 0 || number > 1_000_000_000_000) throw new Error('Invalid capture spend stop');
  return number;
}
export function captureUsage(calls) {
  const measured = calls.filter(call => call.usageStatus === 'reported');
  const totals = Object.fromEntries(['inputTokens','cachedInputTokens','cacheWriteTokens','outputTokens','reasoningTokens','totalTokens']
    .map(key => [key,measured.length&&measured.every(call=>Number.isSafeInteger(call[key])) ? measured.reduce((sum,call) => sum + call[key],0) : null]));
  return {version:1,billingScope:'nudge_api',priceVersion:CAPTURE_PRICE_VERSION,
    status:measured.length === calls.length && calls.length && Object.values(totals).every(Number.isSafeInteger) ? 'reported' : measured.length ? 'partial' : 'unavailable',
    callCount:calls.length,reportedCallCount:measured.length,calls,
    totals:{...totals,estimatedCostMicrousd:calls.length && calls.every(call => Number.isSafeInteger(call.estimatedCostMicrousd))
      ? calls.reduce((sum,call) => sum + call.estimatedCostMicrousd,0) : null}};
}
