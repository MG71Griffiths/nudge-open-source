// Local adapter for direct ChatGPT photo observations. No transport, credentials,
// file access, diary writes or independent nutrition/scoring implementation.
import { PublicError, extractionSchema, nutrientKeys, validateExtraction, extractionInstructions, recoverSourceMeal } from './photo-analysis-contract.js';
import { bindPhotoEvidence } from './photo-evidence.js';
import { prepareRecipeCalculation, correctRecipeAttribution } from './recipe-evidence.js';
import { validateMealHints, reconcileMealHints } from './meal-hints.js';
import {isFastCapture,validCapturePolicy} from './capture-policy.js';
import {compactExtractionSchema,expandCompactObservation,fastExtractionInstructions} from './compact-photo-contract.js';

export const VERSION = 'nudge-chatgpt-analysis-v1';
const MAX_TEXT_BYTES = 240_000, MAX_PRODUCT_BYTES = 60_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (issue = 'extraction_shape', code = 'analysis_invalid') => {
  const error = new PublicError('ChatGPT could not return a complete food observation. Your photos and selections are kept; try again.', 422, code);
  error.validationIssue = issue;
  return error;
};
// JavaScriptCore has no TextEncoder. Count UTF-8 without depending on browser IO
// or accepting a large JSON string before the bounded parse.
function bytes(text) {
  let length = 0;
  for (const char of text) { const code = char.codePointAt(0); length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4; }
  return length;
}
function context(input, finishing = false) {
  const allowed = ['photoIds', 'captureRevision', 'mealHints','analysisPolicy', ...(finishing ? ['text'] : [])];
  if (!object(input) || Object.keys(input).some(key => !allowed.includes(key))
    || !Array.isArray(input.photoIds) || input.photoIds.length < 1 || input.photoIds.length > 4
    || input.photoIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(id))
    || new Set(input.photoIds).size !== input.photoIds.length
    || !Number.isSafeInteger(input.captureRevision) || input.captureRevision < 0) throw fail('capture_context', 'upload_invalid');
  if(Object.hasOwn(input,'analysisPolicy')&&!validCapturePolicy(input.analysisPolicy))throw fail('capture_context','upload_invalid');
  const mealHints = input.mealHints == null ? null : validateMealHints(input.mealHints);
  return { photoIds: [...input.photoIds], captureRevision: input.captureRevision,
    // Only image count is needed by the shared contract; pixels never enter JS.
    images: input.photoIds.map(() => ({})), ...(mealHints ? { mealHints } : {}),
    ...(input.analysisPolicy?{analysisPolicy:{version:1,mode:'fast'}}:{}) };
}
export function request(input) {
  const body = context(input);
  return { instructions: isFastCapture(body)?fastExtractionInstructions(body):extractionInstructions(body),
    schema: structuredClone(isFastCapture(body)?compactExtractionSchema:extractionSchema),
    inputText: body.mealHints ? JSON.stringify({ untrustedMealHints: body.mealHints }) : '' };
}
function currentShape(value) {
  // Shared validation accepts historical analyses without additive fields. A new
  // model observation must include current components, otherwise old provider
  // totals could bypass source-backed calculation. Optional recipe evidence is
  // still validated separately so a bad recipe cannot erase a readable plate.
  if (!object(value) || extractionSchema.required.some(key => !Object.hasOwn(value, key))) throw fail();
  if (value.type === 'meal') {
    const schema = extractionSchema.properties.meal.anyOf[0];
    if (!object(value.meal) || schema.required.some(key => !Object.hasOwn(value.meal, key))) throw fail('meal_shape');
  }
}
export function finish(input) {
  const body = context(input, true);
  if (typeof input.text !== 'string' || bytes(input.text) > MAX_TEXT_BYTES) throw fail('output_size', 'result_too_large');
  let observation;
  try { observation = JSON.parse(input.text); } catch { throw fail('output_json'); }
  if(isFastCapture(body))observation=expandCompactObservation(observation);
  currentShape(observation);
  // Bounded technical evidence survives normalization without retaining the
  // provider's text, food names, images or discarded nutrient values.
  const proposed = observation.type === 'meal'
    ? observation.meal?.nutrientEstimate?.nutrients : observation.nutrients;
  const observationDiagnostics = {
    observedType: ['meal','product','unknown'].includes(observation.type) ? observation.type : 'unknown',
    observedConsistency: ['sameMeal','sameProduct','uncertain'].includes(observation.photoConsistency)
      ? observation.photoConsistency : 'uncertain',
    proposedNutrientCount: nutrientKeys.filter(key => {
      const candidate = proposed?.[key], value = typeof candidate === 'number' ? candidate : candidate?.value;
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    }).length
  };
  const issues = new Set(), report = issue => issues.add(issue);
  let extraction = validateExtraction(observation, true, true, report);
  extraction = recoverSourceMeal(extraction);
  if (extraction.type === 'meal') extraction = { ...extraction, meal: prepareRecipeCalculation(extraction.meal, report) };
  extraction = correctRecipeAttribution(extraction, false);
  try { extraction = bindPhotoEvidence(extraction, body); }
  catch { throw fail('photo_reference'); }
  extraction = reconcileMealHints(extraction, body.mealHints);
  extraction.analysisVersion = VERSION;
  if (bytes(JSON.stringify(extraction)) > (extraction.type === 'meal' ? MAX_TEXT_BYTES : MAX_PRODUCT_BYTES)) throw fail('result_size', 'result_too_large');
  const recoveryReason = extraction.type !== 'unknown' ? null
    : observation.photoConsistency === 'uncertain' ? 'subject_uncertain'
    : issues.has('subject_uncertain') ? 'identity_conflict'
    : issues.has('subject_type_mismatch') ? 'subject_type_mismatch' : 'subject_unidentified';
  return { extraction, diagnosticEnums: [...issues], observationDiagnostics,
    ...(recoveryReason ? { recoveryReason } : {}) };
}

globalThis.NudgeChatGPTAnalysis = Object.freeze({ version: VERSION, request, finish });
