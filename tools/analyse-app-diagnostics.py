#!/usr/bin/env python3
"""Summarise Nudge failures and completeness without printing private content."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re

STAGES = {'capture_performance', 'app', 'product_contribution', 'catalogue', 'rating_batch', 'barcode_lookup', 'barcode_scan', 'image_submission', 'authentication', 'permission',
          'configuration', 'quota', 'upload', 'response', 'visual_evidence',
          'connection', 'transport', 'structured_response', 'http_response',
          'native_parse', 'photo_library', 'ui_delivery', 'search_request',
          'search_http', 'search_response', 'search_delivery', 'search_ui',
          'storage', 'nutrition', 'navigation', 'lifecycle', 'ui_error'}
FAILURES = {'chatgpt_account', 'chatgpt_limit', 'chatgpt_model', 'chatgpt_result', 'chatgpt_interrupted', 'failed', 'delivery_failed', 'invalid_json', 'missing_extraction', 'body_too_large',
            'partial_import', 'import_failed', 'offline', 'timeout', 'rateLimited',
            'server', 'invalidResponse', 'notConfigured', 'unauthenticated',
            'signInRequired', 'photoPermissionRequired', 'permission_required',
            'account_storage', 'upstream_auth', 'upstream_access', 'upstream_model',
            'upstream_billing', 'server_not_configured', 'route_not_found',
            'request_invalid', 'upstream_request', 'upstream_redirect', 'quota_busy',
            'quota_exceeded', 'upstream_rate_limit', 'upload_invalid', 'upload_too_large',
            'invalid_image', 'upstream_image', 'upstream_refusal', 'upstream_incomplete',
            'result_too_large', 'response_invalid', 'upstream_invalid_response',
            'label_unreadable', 'upstream_timeout', 'analysis_timeout',
            'analysis_connection', 'upstream_network', 'upstream_unavailable',
            'server_unavailable', 'analysis', 'voice_invalid', 'voice_too_large',
            'voice_transcription_failed', 'voice_transcription_empty',
            'voice_transcription_timeout', 'invalidQuery', 'unavailable',
            'providerBusy', 'save_failed', 'storage_unavailable', 'parse_failed',
            'unhandled_error', 'promise_rejection', 'render_failed'}
OUTCOMES = FAILURES | {'prepared', 'usage_received', 'result_ready', 'card_visible', 'still_analysing', 'local_result', 'local_fallback', 'inference_finished', 'queued', 'completed', 'deferred', 'cache_hit', 'delivered', 'started', 'invoked', 'matched', 'parsed',
                       'received', 'cancelled', 'imported', 'cached', 'stale',
                       'no_matches', 'rendered', 'filtered_empty', 'saved',
                       'recovered', 'calculated', 'incomplete', 'opened',
                       'foregrounded', 'backgrounded'}
COUNTS = {'streamEventCount':100000, 'streamTerminalCount':100000, 'streamTextDeltaCount':100000, 'streamOutputItemDoneCount':100000, 'completedItemTextCount':100000, 'finalOutputTextCount':100000, 'timingVersion':2, 'analyseToResultMs':600000, 'captureToResultMs':600000, 'cropMs':600000, 'cropOriginalBytes':6000000, 'cropPreparedBytes':6000000, 'croppedCount':4, 'captureMs':600000, 'preparationMs':600000, 'timedImageCount':4, 'ocrMs':600000, 'inferenceMs':600000, 'bridgeMs':600000, 'inputTokens':10000000, 'cachedInputTokens':10000000, 'cacheWriteTokens':10000000, 'reasoningTokens':10000000, 'processingMs':600000, 'outputTokens':10000000, 'totalTokens':20000000, 'estimatedCostMicrousd':100000000, 'httpStatus': 599, 'status': 599, 'elapsedMs': 600000,
          'queueWaitMs':600000,'lookupMs':600000,'networkMs':600000,'calculationMs':600000,
          'batchSize':100,'resolvedCount':100,'missingCount':100,'queueDepth':400,'activeCount':20,
          'nativeElapsedMs': 600000, 'authorizationMs': 600000, 'responseHeadersMs': 600000, 'downloadMs': 600000, 'transcriptionMs': 600000, 'observationMs': 600000, 'recheckMs': 600000, 'requestTimeoutMs': 180000,
          'resourceTimeoutMs': 180000, 'backendDeadlineMs': 180000,
          'payloadBytes': 20000000, 'storedBytes': 50000000,
          'responseBytes': 10000000, 'entryCount': 10000,
          'knownNutrientCount': 8, 'missingNutrientCount': 8, 'partialNutrientCount': 8, 'zeroNutrientCount': 8,
          'componentCount': 40, 'matchedComponentCount': 40,
          'missingAmountCount': 40, 'plantCount': 200,
          'recipeIngredientCount': 40, 'recipeMissingAmountCount': 40,
          'upstreamCallCount': 2, 'transcriptionCallCount': 1}
ENUMS = {'finalOutputSource':{'response','output_item','none'}, 'responseFormat':{'sse','json','other','missing'}, 'parseFailure':{'none','invalid_encoding','response_too_large','malformed_event','event_name_mismatch','missing_terminal','terminal_mismatch','multiple_terminal','event_after_terminal','missing_final_output','multiple_final_output','empty_output','output_too_large','refused','provider_error','unexpected_response_format'}, 'providerErrorCode':{'subscription_sharing_usage_limit_exceeded','rate_limit_exceeded','subscription_sharing_usage_unavailable','unsupported_capability','subscription_sharing_unsupported_capability','invalid_token','invalid_grant','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused','server_error'}, 'captureBasis':{'photo_acquisition','barcode_decode','barcode_entry'}, 'providerOutcome':{'completed','incomplete','failed','received','unknown','http_error'},
         'observationSchema':{'compact_photo_v1','compact_photo_v2','compact_photo_v3','photo_v1'}, 'promptVersion':{'photo-instructions-2026-10-20-v1','photo-estimate-2026-10-20-v2','photo-estimate-2026-10-20-v3'},
         'priceVersion':{'openai-standard-2026-10-20'},
         'recheckOutcome':{'not_needed','recovered','no_improvement','failed','skipped_deadline','skipped_legacy','skipped_fast_policy'}, 'billingScope':{'nudge_api','chatgpt_plan'}, 'usageStatus':{'reported','partial','unavailable'}, 'analysisPolicy':{'fast_v1','legacy'}, 'cacheState':{'miss','fresh','stale'}, 'store': {'main', 'history', 'catalogue', 'repertoire', 'preferences', 'unknown'},
         'ratingPath': {'batch', 'full_record', 'cache', 'catalogue'},
         'sourceRoute': {'discovery', 'facts_batch', 'alternatives', 'catalogue_search', 'catalogue_batch', 'phone_cache', 'catalogue_fallback', 'off_product'},
         'gateReason': {'local_budget', 'provider_pause', 'route_outage'},
         'waitReason': {'pacing', 'provider_cooldown', 'read_budget'},
         'cancelReason': {'query_changed', 'screen_left', 'task_cancelled'},
         'operation': {'read', 'write', 'remove', 'import', 'restore', 'render', 'calculate'},
         'errorClass': {'quota', 'security', 'serialization', 'invalid_json', 'invalid_shape', 'native_write', 'unknown'},
         'route': {'local_text', 'chatgpt_photo_analysis', 'photo_analysis', 'product_search', 'product_score', 'product_lookup', 'contribution_submit', 'contribution_status', 'contribution_list', 'contribution_retry', 'contribution_delete'},
         'failureOrigin': {'native_transport', 'backend', 'provider', 'web_storage', 'web_runtime'},
         'timeoutSource': {'native_transport', 'backend_deadline', 'voice_transcription'},
         'voiceStatus': {'not_supplied', 'transcribing', 'transcribed', 'failed'},
         'resultType': {'meal', 'product', 'unknown'},
         'recipeStatus': {'ready', 'needs_servings', 'incomplete'},
         'recipeRecheckDetail': {'invalid_output', 'recipe_unreadable', 'evidence_or_mapping_invalid', 'coverage_unchanged', 'side_not_preserved', 'ingredient_or_quantity_not_preserved', 'yield_not_preserved', 'result_size', 'recovered'},
         'scoreReadiness': {'not_applicable', 'available', 'estimated_rough', 'missing_components', 'missing_amounts', 'missing_nutrients', 'unsupported_profile'},
         'scoreBasis': {'none', 'composition', 'food_pattern', 'model_nutrient_estimate'}}
RECIPE_SCHEMA_REASONS = {'type', 'enum', 'max_length', 'markup', 'control_character',
                         'not_finite', 'minimum', 'maximum', 'max_items', 'missing_field',
                         'unexpected_field', 'empty_or_invalid_mapping'}
RECIPE_SCHEMA_PATHS = [
    re.compile(r'\$(?:\.recipeEvidence)?(?:\.(?:photoIndex|text|servings|servingsEvidence)|\.componentIndexes(?:\[(?:[0-9]|[1-3][0-9])\])?|\.ingredients(?:\[(?:[0-9]|[1-3][0-9])\](?:\.(?:name|preparation|amount|unit|evidence))?)?)?'),
    re.compile(r'\$\.components(?:\[(?:[0-9]|[1-3][0-9])\](?:\.(?:name|preparation|amountGrams|evidence|photoIndex)|\.assumptions(?:\[[0-3]\])?)?)?')]

def recipe_schema_issue(value):
    if not isinstance(value, dict):
        return None
    path, reason = value.get('path'), value.get('reason')
    if (type(path) is not str or len(path) > 128 or type(reason) is not str
            or reason not in RECIPE_SCHEMA_REASONS
            or not any(pattern.fullmatch(path) for pattern in RECIPE_SCHEMA_PATHS)):
        return None
    result = {'path': path, 'reason': reason}
    code_point = value.get('codePoint')
    if reason == 'control_character' and type(code_point) is int and 0 <= code_point <= 31:
        result['codePoint'] = code_point
    return result

def integer(value, maximum):
    return value if type(value) is int and 0 <= value <= maximum else None

def metadata(raw):
    safe = {key: raw[key] for key, maximum in COUNTS.items()
            if integer(raw.get(key), maximum) is not None}
    safe.update({key: raw[key] for key, choices in ENUMS.items()
                 if type(raw.get(key)) is str and raw[key] in choices})
    for key in ['model', 'reportedModel']:
        value = raw.get(key)
        if type(value) is str and re.fullmatch(r'(?:gpt-[a-zA-Z0-9.-]{1,60}|o[1-9](?:-[a-zA-Z0-9.-]{1,40})?)', value):
            safe[key] = value
    for key in ['recipeValidationIssue', 'recipeRecheckValidationIssue']:
        issue = recipe_schema_issue(raw.get(key))
        if issue is not None:
            safe[key] = issue
    issues = raw.get('normalizationIssues')
    if isinstance(issues, list) and any(type(code) is str and code in {'meal_recipe_evidence', 'meal_recipe_quantity'} for code in issues[:12]):
        safe['recipeEvidenceRejected'] = True
    for key in ['cropTimedOut', 'completeNutrition', 'durable', 'includesVoiceMemo', 'online', 'requestSent', 'hasCatalogueRating', 'ratingAssigned']:
        if type(raw.get(key)) is bool:
            safe[key] = raw[key]
    if type(raw.get('outcome')) is str and raw['outcome'] in FAILURES:
        safe['reportedFailure'] = raw['outcome']
    return safe

def utc(value):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 4102444800:
        return None
    return datetime.fromtimestamp(value, timezone.utc).isoformat()

def attempt_id(event):
    # Native capture stages use requestId; transport and nutrition use attemptId.
    # They identify the same request. Reject malformed or conflicting aliases
    # rather than joining unrelated results or borrowing nearby nutrition.
    values = [event['metadata'][key] for key in ('attemptId', 'requestId')
              if key in event['metadata']]
    if not values or any(not isinstance(value, str) or not re.fullmatch(
            r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', value) for value in values):
        return None
    identities = {value.lower() for value in values}
    return identities.pop() if len(identities) == 1 else None

def latest_photo(events):
    """Correlate internally; never expose attempt identifiers or private text.

    The latest *started* attempt wins, even if an older response arrives late.
    A dashboard render cannot replace that attempt's nutrient completeness.
    Uncorrelated legacy events are reported alone, not joined by proximity.
    """
    anchors = [(i, e) for i, e in enumerate(events)
               if e['metadata'].get('route') in ('photo_analysis', 'chatgpt_photo_analysis')
               or (e['metadata'].get('route') is None
                   and e['stage'] in {'image_submission', 'http_response', 'native_parse', 'structured_response'})]
    if not anchors:
        return None, None
    identities = {attempt_id(e) for _, e in anchors} - {None}
    groups = {}
    for i, e in enumerate(events):
        identity = attempt_id(e)
        route = e['metadata'].get('route')
        if identity in identities and (route is None or route in ('photo_analysis', 'chatgpt_photo_analysis')):
            groups.setdefault(identity, []).append((i, e))
    choices = [(items[0][0], True, items) for items in groups.values()]
    choices.extend((i, False, [(i, e)]) for i, e in anchors if attempt_id(e) is None)
    _, correlated, items = max(choices, key=lambda item: item[0])
    photo = [e for _, e in items]
    safe = {}
    for e in photo:
        if e['stage'] != 'nutrition':
            safe.update(metadata(e['metadata']))
    summary = {'time_utc': utc(photo[0].get('time')), 'last_event_time_utc': utc(photo[-1].get('time')),
               'correlated': correlated, 'stage': photo[-1]['stage'], 'outcome': photo[-1]['outcome'], **safe}
    nutrition = [e for e in photo if e['stage'] == 'nutrition']
    latest = nutrition[-1] if nutrition else None
    counts = {'time_utc': utc(latest.get('time')), 'outcome': latest['outcome'], **metadata(latest['metadata'])} if latest else None
    if counts:
        if safe.get('recipeEvidenceRejected') and counts.get('recipeIngredientCount', 0) > 0 and counts.get('recipeMissingAmountCount') == counts.get('recipeIngredientCount'):
            counts['reason'] = 'recipe_evidence_rejected'
        elif counts.get('recipeStatus') == 'needs_servings':
            counts['reason'] = 'recipe_servings_missing'
        elif counts.get('componentCount', 0) > 0 and counts.get('matchedComponentCount') == 0:
            counts['reason'] = 'no_source_matches'
        elif counts.get('missingAmountCount', 0) > 0 or counts.get('recipeMissingAmountCount', 0) > 0:
            counts['reason'] = 'missing_amounts'
        elif counts.get('missingNutrientCount', 0) > 0:
            counts['reason'] = 'incomplete_nutrients'
    return summary, counts

def analyse(document):
    if not isinstance(document, dict) or type(document.get('version')) is not int or document['version'] != 1 or not isinstance(document.get('events'), list) or len(document['events']) > 200:
        raise ValueError('Unexpected diagnostic format')
    events = [e for e in document['events'] if isinstance(e, dict)
              and type(e.get('stage')) is str and e['stage'] in STAGES
              and type(e.get('outcome')) is str and e['outcome'] in OUTCOMES
              and isinstance(e.get('metadata'), dict)]
    storage = [e for e in events if e['stage'] == 'storage']
    nutrition = [e for e in events if e['stage'] == 'nutrition']
    http = [e for e in events if e['stage'] == 'http_response' and e['outcome'] == 'received']
    photo_attempt, photo_nutrition = latest_photo(events)
    timeout_attempts = set()
    for index, e in enumerate(events):
        m = e['metadata']
        if e['outcome'] in {'upstream_timeout', 'analysis_timeout', 'voice_transcription_timeout'} or (e['stage'] == 'http_response' and m.get('httpStatus') == 504):
            identity = attempt_id(e) or index
            timeout_attempts.add(identity)
    result = {'events_in_file': len(document['events']), 'known_events': len(events),
              'coverage': {stage: any(e['stage'] == stage for e in events)
                           for stage in ['transport', 'storage', 'nutrition', 'navigation', 'lifecycle', 'ui_error', 'rating_batch', 'barcode_lookup', 'barcode_scan', 'product_contribution']},
              'contribution_outcomes': dict(Counter(e['outcome'] for e in events if e['stage']=='product_contribution')),
              'recent_contribution_requests': [{'time_utc':utc(e.get('time')), 'outcome':e['outcome'], **metadata(e['metadata'])} for e in events if e['stage']=='product_contribution'][-10:],
              'barcode_lookup_outcomes': dict(Counter(e['outcome'] for e in events if e['stage']=='barcode_lookup')),
              'barcode_routes': dict(Counter(metadata(e['metadata'])['sourceRoute'] for e in events if e['stage']=='barcode_lookup' and 'sourceRoute' in metadata(e['metadata']))),
              'recent_barcode_scans': [{'time_utc':utc(e.get('time')), 'outcome':e['outcome'], **metadata(e['metadata'])} for e in events if e['stage']=='barcode_scan'][-10:],
              'rating_batch_outcomes': dict(Counter(e['outcome'] for e in events if e['stage']=='rating_batch')),
              'photo_http_statuses': dict(Counter(str(e['metadata']['httpStatus']) for e in http
                                                 if integer(e['metadata'].get('httpStatus'), 599) is not None)),
              'photo_timeout_attempts': len(timeout_attempts),
              'storage_outcomes': dict(Counter(e['outcome'] for e in storage)),
              'runtime_failures': dict(Counter(e['outcome'] for e in events if e['stage'] == 'ui_error')),
              'nutrition_incomplete_events': sum(e['outcome'] == 'incomplete' for e in nutrition),
              'latest_nutrition_counts': metadata(nutrition[-1]['metadata']) if nutrition else None,
              'latest_photo_attempt': photo_attempt,
              'latest_photo_nutrition': photo_nutrition,
              'findings': [], 'recent_failures': []}
    findings = result['findings']
    if not storage:
        findings.append('No storage diagnostic events were recorded. This file cannot establish whether browser or device storage failed.')
    if any(e['outcome'] == 'quota_exceeded' for e in storage):
        findings.append('A storage quota failure was recorded. This is separate from an AI usage quota.')
    if any(e['outcome'] in {'save_failed', 'storage_unavailable', 'parse_failed'} for e in storage):
        findings.append('A local save, access or decoding failure was recorded; inspect its store and error class before changing existing data.')
    if any(e['metadata'].get('httpStatus') == 504 for e in http):
        findings.append('The backend returned HTTP 504 for photo analysis. This confirms a server-side timeout, not a local storage failure or evidence of an OpenAI account limit.')
        if photo_attempt and photo_attempt.get('httpStatus') == 200:
            findings.append('That timeout belongs to an earlier attempt. The latest photo analysis returned HTTP 200; inspect its own nutrition counts below.')
    if any(e['outcome'] == 'analysis_timeout' for e in events):
        findings.append('Nudge timed out waiting for an analysis response. Without a backend response this does not establish which upstream step timed out.')
    if not nutrition:
        findings.append('No nutrient-completeness diagnostics were recorded. Missing nutrient values cannot be reconstructed from this file.')
    elif result['nutrition_incomplete_events']:
        findings.append('Some results contain missing nutrients. Explicit zero counts and missing counts are recorded separately.')
    if photo_attempt and photo_attempt.get('route') == 'chatgpt_photo_analysis':
        issue = photo_attempt.get('parseFailure')
        if issue == 'missing_terminal':
            findings.append('The latest ChatGPT stream ended without a completed response. No food result reached nutrition calculation; HTTP 200 alone does not establish successful analysis.')
        elif issue == 'missing_final_output':
            findings.append('The latest ChatGPT stream reported completion, but Nudge could not validate a final answer. Food calculation did not run; text-delta counts alone cannot establish a usable answer or a rating.')
        elif issue == 'unexpected_response_format':
            if photo_attempt.get('responseFormat') == 'missing':
                findings.append('The latest ChatGPT response lacked a Content-Type header and was rejected before stream validation. This does not establish whether its body contained a completed response.')
            else:
                findings.append('The latest ChatGPT response declared an unsupported response format. Its body was not admitted as food evidence.')
        elif issue == 'provider_error':
            findings.append('The latest ChatGPT stream reported a provider error. Inspect the fixed provider error code when available; raw error text is not retained.')
        elif issue and issue != 'none':
            findings.append('The latest ChatGPT stream failed response validation before food calculation. Inspect its fixed parseFailure code; this is not evidence that the photo was unreadable.')
    if photo_nutrition:
        reason = photo_nutrition.get('reason')
        if reason == 'no_source_matches':
            findings.append('The latest photo result has no matched nutrition sources for its meal components. Recognising the dish did not produce calculated nutrients.')
        elif reason == 'recipe_evidence_rejected':
            findings.append('The latest photo succeeded, but all recipe quantities were rejected because their printed evidence was incomplete or inconsistent. This is recipe extraction validation, not phone storage or an upload timeout.')
        elif reason == 'recipe_servings_missing':
            findings.append('The latest photo contains recipe quantities, but a serving count or explicit portion share is missing. Batch nutrition cannot yet be converted to the eaten portion.')
        elif reason == 'missing_amounts':
            findings.append('The latest photo result has ingredient or component amounts that cannot be calculated. Available partial nutrients remain separate from a complete portion total.')
        elif reason == 'incomplete_nutrients':
            findings.append('The latest photo result has incomplete nutrients. Any reported partial counts describe known contributions, not a complete meal total.')
    if result['runtime_failures']:
        findings.append('The web interface recorded runtime errors. Messages and stack traces are intentionally excluded.')
    for e in events:
        if e['outcome'] in FAILURES or (e['stage'] == 'http_response' and integer(e['metadata'].get('httpStatus'), 599) is not None and e['metadata']['httpStatus'] >= 400):
            result['recent_failures'].append({'time_utc': utc(e.get('time')), 'stage': e['stage'], 'outcome': e['outcome'], **metadata(e['metadata'])})
    result['recent_capture_stages'] = [
        {'time_utc':utc(e.get('time')), 'outcome':e['outcome'], **metadata(e['metadata'])}
        for e in events if e['stage'] == 'capture_performance'][-60:]
    result['recent_failures'] = result['recent_failures'][-30:]
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', nargs='?', type=Path)
    args = parser.parse_args()
    path = args.file
    if path is None:
        files = list((Path(__file__).resolve().parent.parent / '.local/diagnostics').glob('*/events.json'))
        if not files:
            parser.error('Download diagnostics first with tools/download-diagnostics.py')
        path = max(files, key=lambda p: p.stat().st_mtime)
    try:
        if path.stat().st_size > 262144:
            raise ValueError('Diagnostic file exceeds the size bound')
        print(json.dumps(analyse(json.loads(path.read_text())), indent=2))
    except (OSError, ValueError, TypeError):
        parser.exit(1, 'Cannot analyse diagnostics: file is unavailable or has an unexpected format.\n')

if __name__ == '__main__':
    main()
