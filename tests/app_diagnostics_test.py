import importlib.util
import json
from pathlib import Path
import unittest

p = Path(__file__).resolve().parents[1] / 'tools/analyse-app-diagnostics.py'
spec = importlib.util.spec_from_file_location('app_diagnostics', p)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def event(stage, event_outcome, **metadata):
    return {'time': 1791189000, 'stage': stage, 'outcome': event_outcome, 'metadata': metadata}

class AppDiagnosticsTests(unittest.TestCase):
    def test_backend_subject_status_survives_without_raw_provider_content(self):
        attempt = 'a5835241-7290-49b8-babe-e1af5ead82df'
        for status in ['uncertain', 'unidentified', 'type_mismatch']:
            report = m.analyse({'version': 1, 'events': [
                event('capture_performance', 'started', requestId=attempt, route='photo_analysis'),
                event('http_response', 'received', attemptId=attempt, captureOperation='retrieve',
                      route='photo_analysis', httpStatus=200, subjectStatus=status, rawReason='private food description'),
                event('native_parse', 'parsed', attemptId=attempt, captureOperation='retrieve', resultType='unknown'),
                event('nutrition', 'incomplete', attemptId=attempt, captureOperation='retrieve',
                      route='photo_analysis', resultType='unknown', knownNutrientCount=0, missingNutrientCount=8, partialNutrientCount=0)]})
            self.assertEqual(report['latest_photo_attempt']['subjectStatus'], status)
            self.assertEqual(report['latest_photo_nutrition']['reason'], 'subject_' + status)
            self.assertTrue(any('one consistent food subject' in f for f in report['findings']))
            self.assertNotIn('private food description', json.dumps(report))
        for invalid in ['private food description', 'uncertain\n', ['uncertain'], {'value': 'uncertain'}, True, None]:
            self.assertEqual(m.metadata({'subjectStatus': invalid}), {})

    def test_requested_reasoning_effort_is_bounded_and_never_inferred(self):
        for effort in ['none', 'low']:
            self.assertEqual(m.metadata({'requestedReasoningEffort': effort}), {'requestedReasoningEffort': effort})
        for invalid in ['medium', 'private text', 'none\n', ['none'], {'effort': 'none'}, True, None]:
            self.assertEqual(m.metadata({'requestedReasoningEffort': invalid}), {})
        self.assertNotIn('requestedReasoningEffort', m.metadata({'reasoningTokens': 0}))

    def test_capture_operation_metadata_keeps_only_fixed_values(self):
        for operation in ['analyse', 'retrieve', 'retry', 'delete']:
            self.assertEqual(m.metadata({'captureOperation': operation}), {'captureOperation': operation})
        for invalid in ['private capture', 'delete\n', ['delete'], {'delete': 'private'}, True, None]:
            self.assertEqual(m.metadata({'captureOperation': invalid}), {})

    def test_failed_maintenance_cannot_replace_latest_completed_scan(self):
        analysis = 'a5835241-7290-49b8-babe-e1af5ead82df'
        other = 'd7a53a6b-49cb-410a-b900-fc6b82e294d6'
        for operation in ['delete', 'retrieve']:
            for identity in [analysis, other]:
                report = m.analyse({'version': 1, 'events': [
                    event('transport', 'started', route='photo_analysis', captureOperation='analyse', attemptId=analysis),
                    event('http_response', 'received', route='photo_analysis', captureOperation='analyse', attemptId=analysis, httpStatus=200),
                    event('nutrition', 'calculated', route='photo_analysis', attemptId=analysis, knownNutrientCount=8, missingNutrientCount=0),
                    event('capture_performance', 'result_ready', route='photo_analysis', requestId=analysis, completeNutrition=True, analyseToResultMs=9000),
                    event('transport', 'started', route='photo_analysis', captureOperation=operation, attemptId=identity, payloadBytes=0),
                    event('http_response', 'received', route='photo_analysis', captureOperation=operation, attemptId=identity, httpStatus=504, outcome='upstream_timeout', body='private error'),
                    event('transport', 'analysis_timeout', route='photo_analysis', captureOperation=operation, attemptId=identity, name='private food')]})
                self.assertEqual(report['latest_photo_attempt']['outcome'], 'result_ready')
                self.assertEqual(report['latest_photo_attempt']['httpStatus'], 200)
                self.assertEqual(report['latest_photo_attempt']['analyseToResultMs'], 9000)
                self.assertFalse(report['latest_photo_attempt']['operationAmbiguous'])
                self.assertEqual(report['latest_photo_nutrition']['knownNutrientCount'], 8)
                self.assertEqual(report['photo_http_statuses'], {'200': 1})
                self.assertEqual(report['photo_timeout_attempts'], 0)
                self.assertEqual(len(report['recent_capture_maintenance']), 3)
                self.assertEqual(report['recent_capture_maintenance'][-1]['captureOperation'], operation)
                self.assertFalse(any('server-side timeout' in f or 'Nudge timed out' in f for f in report['findings']))
                for private in [analysis, other, 'private']:
                    self.assertNotIn(private, json.dumps(report))

    def test_maintenance_alone_does_not_invent_an_analysis(self):
        report = m.analyse({'version': 1, 'events': [
            event('http_response', 'received', route='photo_analysis', captureOperation='delete', httpStatus=400),
            event('http_response', 'received', route='photo_analysis', captureOperation='retrieve', httpStatus=200),
            event('native_parse', 'parsed', captureOperation='retrieve', resultType='meal'),
            event('nutrition', 'calculated', route='photo_analysis', captureOperation='retrieve', knownNutrientCount=8)]})
        self.assertIsNone(report['latest_photo_attempt'])
        self.assertIsNone(report['latest_photo_nutrition'])
        self.assertEqual(report['photo_http_statuses'], {})
        self.assertEqual(len(report['recent_capture_maintenance']), 4)

    def test_user_retry_is_a_new_analysis_not_maintenance(self):
        first = 'a5835241-7290-49b8-babe-e1af5ead82df'
        retry = 'd7a53a6b-49cb-410a-b900-fc6b82e294d6'
        report = m.analyse({'version': 1, 'events': [
            event('image_submission', 'started', route='chatgpt_photo_analysis', attemptId=first),
            event('nutrition', 'calculated', route='photo_analysis', attemptId=first, knownNutrientCount=8),
            event('transport', 'started', route='photo_analysis', captureOperation='retry', attemptId=retry)]})
        self.assertEqual(report['latest_photo_attempt']['captureOperation'], 'retry')
        self.assertEqual(report['latest_photo_attempt']['outcome'], 'started')
        self.assertFalse(report['latest_photo_attempt']['operationAmbiguous'])
        self.assertIsNone(report['latest_photo_nutrition'])
        self.assertEqual(report['recent_capture_maintenance'], [])

    def test_async_analysis_poll_result_joins_its_submission_and_ready_timing(self):
        attempt = 'a5835241-7290-49b8-babe-e1af5ead82df'
        report = m.analyse({'version': 1, 'events': [
            event('capture_performance', 'started', requestId=attempt),
            event('transport', 'started', route='photo_analysis', captureOperation='analyse', attemptId=attempt),
            event('http_response', 'received', route='photo_analysis', captureOperation='analyse', attemptId=attempt, httpStatus=202),
            event('transport', 'started', route='photo_analysis', captureOperation='retrieve', attemptId=attempt),
            event('http_response', 'received', route='photo_analysis', captureOperation='retrieve', attemptId=attempt, httpStatus=200),
            event('native_parse', 'parsed', captureOperation='retrieve', attemptId=attempt, resultType='meal'),
            event('nutrition', 'calculated', route='photo_analysis', captureOperation='retrieve', attemptId=attempt, knownNutrientCount=8, missingNutrientCount=0),
            event('capture_performance', 'result_ready', requestId=attempt, analyseToResultMs=8200, completeNutrition=True),
            event('http_response', 'received', route='photo_analysis', captureOperation='retrieve', attemptId=attempt, httpStatus=500),
            event('native_parse', 'invalid_json', captureOperation='retrieve', attemptId=attempt),
            event('http_response', 'received', route='photo_analysis', captureOperation='delete', attemptId=attempt, httpStatus=400)]})
        latest = report['latest_photo_attempt']
        self.assertEqual(latest['outcome'], 'result_ready')
        self.assertEqual(latest['httpStatus'], 200)
        self.assertEqual(latest['analyseToResultMs'], 8200)
        self.assertFalse(latest['operationAmbiguous'])
        self.assertEqual(report['latest_photo_nutrition']['knownNutrientCount'], 8)
        self.assertEqual(report['latest_photo_nutrition']['missingNutrientCount'], 0)
        self.assertEqual(len(report['recent_capture_maintenance']), 7)
        self.assertNotIn(attempt, json.dumps(report))

    def test_retry_with_same_capture_identity_cannot_borrow_prior_nutrition(self):
        attempt = 'a5835241-7290-49b8-babe-e1af5ead82df'
        report = m.analyse({'version': 1, 'events': [
            event('transport', 'started', route='photo_analysis', captureOperation='analyse', attemptId=attempt),
            event('nutrition', 'calculated', route='photo_analysis', attemptId=attempt, knownNutrientCount=8),
            event('capture_performance', 'result_ready', requestId=attempt, completeNutrition=True),
            event('transport', 'started', route='photo_analysis', captureOperation='retry', attemptId=attempt),
            event('http_response', 'received', route='photo_analysis', captureOperation='retry', attemptId=attempt, httpStatus=202)]})
        self.assertEqual(report['latest_photo_attempt']['captureOperation'], 'retry')
        self.assertEqual(report['latest_photo_attempt']['httpStatus'], 202)
        self.assertIsNone(report['latest_photo_nutrition'])
        self.assertNotIn('completeNutrition', report['latest_photo_attempt'])

    def test_direct_chatgpt_retry_of_older_capture_is_latest_without_stale_results(self):
        first = 'a5835241-7290-49b8-babe-e1af5ead82df'
        newer = 'd7a53a6b-49cb-410a-b900-fc6b82e294d6'
        report = m.analyse({'version': 1, 'events': [
            event('capture_performance', 'started', requestId=first, analyseToResultMs=100),
            event('image_submission', 'started', route='chatgpt_photo_analysis', attemptId=first),
            event('capture_performance', 'usage_received', route='chatgpt_photo_analysis', attemptId=first, outputTokens=400, httpStatus=200),
            event('nutrition', 'calculated', route='photo_analysis', attemptId=first, knownNutrientCount=8),
            event('capture_performance', 'result_ready', requestId=first, completeNutrition=True),
            event('capture_performance', 'started', requestId=newer),
            event('image_submission', 'started', route='chatgpt_photo_analysis', attemptId=newer),
            event('nutrition', 'calculated', route='photo_analysis', attemptId=newer, knownNutrientCount=8),
            event('capture_performance', 'result_ready', requestId=newer, completeNutrition=True),
            event('capture_performance', 'started', requestId=first, analyseToResultMs=300, preparationMs=220),
            event('image_submission', 'started', route='chatgpt_photo_analysis', attemptId=first),
            event('response', 'chatgpt_limit', route='chatgpt_photo_analysis', attemptId=first)]})
        latest = report['latest_photo_attempt']
        self.assertEqual(latest['outcome'], 'chatgpt_limit')
        self.assertEqual(latest['analyseToResultMs'], 300)
        self.assertEqual(latest['preparationMs'], 220)
        for stale in ['outputTokens', 'httpStatus', 'completeNutrition']:
            self.assertNotIn(stale, latest)
        self.assertIsNone(report['latest_photo_nutrition'])
        self.assertFalse(latest['operationAmbiguous'])
        for private in [first, newer]:
            self.assertNotIn(private, json.dumps(report))

    def test_legacy_transport_operation_is_ambiguous_not_guessed_from_payload(self):
        scan = 'a5835241-7290-49b8-babe-e1af5ead82df'
        legacy = 'd7a53a6b-49cb-410a-b900-fc6b82e294d6'
        report = m.analyse({'version': 1, 'events': [
            event('image_submission', 'started', route='chatgpt_photo_analysis', attemptId=scan),
            event('nutrition', 'calculated', route='photo_analysis', attemptId=scan, knownNutrientCount=8),
            event('transport', 'started', route='photo_analysis', attemptId=legacy, payloadBytes=0),
            event('http_response', 'received', route='photo_analysis', attemptId=legacy, payloadBytes=0, httpStatus=400)]})
        self.assertTrue(report['latest_photo_attempt']['operationAmbiguous'])
        self.assertNotIn('captureOperation', report['latest_photo_attempt'])
        self.assertIsNone(report['latest_photo_nutrition'])
        self.assertEqual(report['recent_capture_maintenance'], [])
        self.assertTrue(any('does not establish a failed new scan' in f for f in report['findings']))

    def test_legacy_timeout_does_not_claim_that_a_new_analysis_failed(self):
        report = m.analyse({'version': 1, 'events': [
            event('http_response', 'received', route='photo_analysis', httpStatus=504, payloadBytes=0),
            event('transport', 'analysis_timeout', route='photo_analysis')]})
        self.assertTrue(report['latest_photo_attempt']['operationAmbiguous'])
        self.assertTrue(any('does not establish a failed new scan' in f for f in report['findings']))
        self.assertFalse(any('HTTP 504 for photo analysis' in f or 'waiting for an analysis response' in f for f in report['findings']))

    def test_native_request_stages_join_their_own_transport_and_nutrition(self):
        attempt = 'a5835241-7290-49b8-babe-e1af5ead82df'
        report = m.analyse({'version': 1, 'events': [
            event('capture_performance', 'started', route='photo_analysis', requestId=attempt),
            event('image_submission', 'started', route='chatgpt_photo_analysis', attemptId=attempt),
            event('capture_performance', 'usage_received', route='chatgpt_photo_analysis',
                  attemptId=attempt, requestId=attempt.upper(), parseFailure='none', finalOutputSource='output_item'),
            event('nutrition', 'incomplete', route='photo_analysis', attemptId=attempt,
                  componentCount=5, matchedComponentCount=3, missingNutrientCount=8, partialNutrientCount=8),
            event('capture_performance', 'result_ready', route='photo_analysis', requestId=attempt,
                  analyseToResultMs=33128, completeNutrition=False)]})
        self.assertTrue(report['latest_photo_attempt']['correlated'])
        self.assertEqual(report['latest_photo_attempt']['outcome'], 'result_ready')
        self.assertEqual(report['latest_photo_attempt']['analyseToResultMs'], 33128)
        self.assertEqual(report['latest_photo_attempt']['finalOutputSource'], 'output_item')
        self.assertEqual(report['latest_photo_nutrition']['matchedComponentCount'], 3)
        self.assertEqual(report['latest_photo_nutrition']['reason'], 'incomplete_nutrients')
        self.assertNotIn(attempt, json.dumps(report).lower())

    def test_request_alias_conflicts_and_invalid_identifiers_never_join(self):
        attempt = 'a5835241-7290-49b8-babe-e1af5ead82df'
        other = 'd7a53a6b-49cb-410a-b900-fc6b82e294d6'
        for aliases in [dict(attemptId=attempt, requestId=other),
                        dict(attemptId=attempt, requestId='private-invalid'),
                        dict(attemptId=None, requestId=attempt), dict(requestId=['private'])]:
            report = m.analyse({'version': 1, 'events': [
                event('image_submission', 'started', route='chatgpt_photo_analysis', attemptId=attempt),
                event('nutrition', 'calculated', route='photo_analysis', attemptId=attempt, knownNutrientCount=8),
                event('capture_performance', 'result_ready', route='photo_analysis', **aliases)]})
            self.assertFalse(report['latest_photo_attempt']['correlated'])
            self.assertIsNone(report['latest_photo_nutrition'])
            for private in (attempt, other, 'private-invalid'):
                self.assertNotIn(private, json.dumps(report))

    def test_completed_stream_without_final_answer_does_not_claim_food_success(self):
        report=m.analyse({'version':1,'events':[
            event('capture_performance','usage_received',route='chatgpt_photo_analysis',
                  providerOutcome='completed',parseFailure='missing_final_output',
                  streamTextDeltaCount=1022,finalOutputTextCount=0)]})
        self.assertIn('could not validate a final answer', report['findings'][-1])
        self.assertIn('cannot establish', report['findings'][-1])
        self.assertIsNone(report['latest_photo_nutrition'])

    def test_missing_header_failure_does_not_claim_the_body_was_invalid(self):
        report=m.analyse({'version':1,'events':[
            event('capture_performance','usage_received',route='chatgpt_photo_analysis',
                  responseFormat='missing',parseFailure='unexpected_response_format',
                  responseBytes=407375,httpStatus=200)]})
        self.assertIn('rejected before stream validation', report['findings'][-1])
        self.assertIn('does not establish', report['findings'][-1])

    def test_stream_failure_keeps_fixed_categories_not_provider_content(self):
        safe = dict(responseFormat='sse', parseFailure='missing_terminal', streamEventCount=120,
                    streamTerminalCount=0, streamTextDeltaCount=90, finalOutputTextCount=0,
                    streamOutputItemDoneCount=2, completedItemTextCount=1, finalOutputSource="none",
                    responseBytes=6000, authorizationMs=200, responseHeadersMs=500,
                    downloadMs=36000, networkMs=36500, nativeElapsedMs=36700)
        self.assertEqual(m.metadata(safe), safe)
        invalid = {key: 'private response' for key in safe}
        invalid.update(streamEventCount=True, streamTerminalCount=-1, streamTextDeltaCount=100001,
                       finalOutputTextCount=float('inf'), providerErrorCode='private error')
        self.assertEqual(m.metadata(invalid), {})
        attempt='11111111-1111-1111-1111-111111111111'
        report=m.analyse({'version':1,'events':[
            event('image_submission','started',route='chatgpt_photo_analysis',attemptId=attempt),
            event('capture_performance','usage_received',route='chatgpt_photo_analysis',attemptId=attempt,
                  **safe, text='private food', message='private error', headers='private token'),
            event('response','chatgpt_result',route='chatgpt_photo_analysis',attemptId=attempt)]})
        self.assertEqual(report['latest_photo_attempt']['parseFailure'], 'missing_terminal')
        self.assertIsNone(report['latest_photo_nutrition'])
        self.assertIn('ended without a completed response', report['findings'][-1])
        self.assertNotIn('private', json.dumps(report))

    def test_terminal_usage_and_versions_retain_only_bounded_scalars(self):
        values = dict(model='gpt-4.1-mini', reportedModel='gpt-4.1-mini-2025-04-14',
            providerOutcome='incomplete', billingScope='chatgpt_plan', usageStatus='partial',
            inputTokens=100, outputTokens=20, totalTokens=120, cacheWriteTokens=0,
            reasoningTokens=7, processingMs=38, observationSchema='compact_photo_v1',
            promptVersion='photo-instructions-2026-10-20-v1', priceVersion='openai-standard-2026-10-20',
            recheckOutcome='skipped_fast_policy', timingVersion=2, captureBasis='photo_acquisition',
            analyseToResultMs=500, captureToResultMs=2000, cropMs=300, cropOriginalBytes=1000,
            cropPreparedBytes=600, croppedCount=1, cropTimedOut=False)
        self.assertEqual(m.metadata(values), values)
        estimated = dict(values, observationSchema='compact_photo_v2',
                         promptVersion='photo-estimate-2026-10-20-v2')
        self.assertEqual(m.metadata(estimated), estimated)
        compact = dict(values, observationSchema='compact_photo_v3',
                       promptVersion='photo-estimate-2026-10-20-v3')
        self.assertEqual(m.metadata(compact), compact)
        self.assertEqual(m.metadata({'captureBasis':'barcode_entry'}), {'captureBasis':'barcode_entry'})
        result = m.analyse({'version': 1, 'events': [event('capture_performance', 'usage_received', **values,
            text='private content', calls=[{'inputTokens':100,'private':'food'}], account='private account')]})
        retained = result['recent_capture_stages'][0]
        for key, value in values.items(): self.assertEqual(retained[key], value)
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(m.metadata(dict(model='gpt-4.1-mini\n', reportedModel='private model',
            providerOutcome='private error', observationSchema='private schema', promptVersion='private prompt',
            priceVersion='unknown-price', processingMs=600001, cacheWriteTokens=True, reasoningTokens=-1,
            calls=[{'private':'food'}])), {})
        self.assertEqual(m.metadata(dict(usageStatus='unavailable', inputTokens=None, outputTokens=None,
            cacheWriteTokens=None, reasoningTokens=None)), {'usageStatus':'unavailable'})

    def test_capture_timing_separates_ready_from_visible_and_discards_content(self):
        report=m.analyse({'version':1,'events':[
            event('capture_performance','local_result',route='local_text',ocrMs=350,calculationMs=90,cacheState='miss',text='private recipe'),
            event('capture_performance','result_ready',elapsedMs=520,completeNutrition=False,photos='private photos'),
            event('capture_performance','card_visible',elapsedMs=1800,completeNutrition=False),
            event('capture_performance','usage_received',billingScope='chatgpt_plan',usageStatus='unavailable',inputTokens=None)]})
        self.assertEqual(len(report['recent_capture_stages']),4)
        self.assertEqual(report['recent_capture_stages'][1]['outcome'],'result_ready')
        self.assertEqual(report['recent_capture_stages'][2]['elapsedMs'],1800)
        self.assertNotIn('inputTokens',report['recent_capture_stages'][3])
        self.assertNotIn('private',json.dumps(report))
        self.assertEqual(m.metadata({'ocrMs':float('inf'),'inputTokens':True,'billingScope':'private'}),{})

    def test_subject_rejection_retains_bounded_evidence_without_claiming_accepted_nutrition(self):
        values = dict(observedType='meal', observedConsistency='uncertain', proposedNutrientCount=8,
                      recoveryReason='subject_uncertain', promptVersion='photo-estimate-2026-10-21-v4')
        self.assertEqual(m.metadata(values), values)
        for invalid in [-1, True, 0.5, 9, float('inf'), 'private text']:
            self.assertEqual(m.metadata({'proposedNutrientCount': invalid}), {})
        self.assertEqual(m.metadata(dict(observedType='private food', observedConsistency='private note',
                                         recoveryReason='private response', responseText='private')), {})
        attempt = '0e375eaa-bc89-4f10-ab91-75add2faf68e'
        report = m.analyse({'version':1,'events':[
            event('image_submission','started',route='chatgpt_photo_analysis',attemptId=attempt),
            event('structured_response','parsed',route='chatgpt_photo_analysis',attemptId=attempt,resultType='unknown',**values),
            event('nutrition','incomplete',route='chatgpt_photo_analysis',attemptId=attempt,knownNutrientCount=0,missingNutrientCount=8),
            event('capture_performance','label_unreadable',attemptId=attempt,analyseToResultMs=10656)]})
        self.assertEqual(report['latest_photo_attempt']['proposedNutrientCount'], 8)
        self.assertEqual(report['latest_photo_attempt']['recoveryReason'], 'subject_uncertain')
        self.assertEqual(report['latest_photo_attempt']['resultType'], 'unknown')
        self.assertEqual(report['latest_photo_nutrition']['knownNutrientCount'], 0)
        self.assertEqual(report['latest_photo_nutrition']['missingNutrientCount'], 8)
        self.assertNotIn('private', json.dumps(report))

    def test_direct_chatgpt_failure_is_correlated_without_account_content(self):
        attempt='11111111-1111-1111-1111-111111111111'
        result=m.analyse({'version':1,'events':[
            event('image_submission','started',route='chatgpt_photo_analysis',attemptId=attempt),
            event('response','chatgpt_limit',route='chatgpt_photo_analysis',attemptId=attempt,
                  subject='private subject',model='private model',email='private email',text='private food')]})
        self.assertEqual(result['latest_photo_attempt']['route'],'chatgpt_photo_analysis')
        self.assertEqual(result['latest_photo_attempt']['outcome'],'chatgpt_limit')
        self.assertTrue(result['latest_photo_attempt']['correlated'])
        self.assertNotIn('private',json.dumps(result))

    def test_contribution_requests_keep_only_bounded_operational_metadata(self):
        result = m.analyse({'version': 1, 'events': [
            event('product_contribution', 'failed', route='contribution_submit', httpStatus=503,
                  elapsedMs=230, requestSent=True, id='private id', barcode='private barcode',
                  country='private country', store='private store', photos='private photos', name='private product')]})
        self.assertEqual(result['contribution_outcomes'], {'failed': 1})
        self.assertTrue(result['coverage']['product_contribution'])
        self.assertEqual(result['recent_contribution_requests'][0]['route'], 'contribution_submit')
        self.assertEqual(result['recent_contribution_requests'][0]['httpStatus'], 503)
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(m.metadata({'route': 'contribution/private-id', 'elapsedMs': 600001,
                                     'httpStatus': True, 'requestSent': 'yes'}), {})

    def test_barcode_diagnostics_report_routes_without_product_data(self):
        result = m.analyse({'version': 1, 'events': [
            event('barcode_lookup', 'cache_hit', route='product_lookup', sourceRoute='phone_cache', elapsedMs=2,
                  barcode='private barcode', name='private product', requestSent=False),
            event('barcode_scan', 'delivered', route='product_lookup', elapsedMs=18,
                  ratingAssigned=True, hasCatalogueRating=False, name='private product')]})
        self.assertEqual(result['barcode_routes'], {'phone_cache': 1})
        self.assertEqual(result['barcode_lookup_outcomes'], {'cache_hit': 1})
        self.assertTrue(result['recent_barcode_scans'][0]['ratingAssigned'])
        self.assertFalse(result['recent_barcode_scans'][0]['hasCatalogueRating'])
        self.assertTrue(result['coverage']['barcode_scan'])
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(m.metadata({'ratingAssigned':1, 'hasCatalogueRating':'yes', 'sourceRoute':'private'}), {})

    def test_recipe_schema_diagnostics_only_keep_fixed_paths_and_reasons(self):
        for key in ['recipeValidationIssue', 'recipeRecheckValidationIssue']:
            for code_point in [0, 11, 12, 31]:
                self.assertEqual(m.metadata({key: {'path': '$.recipeEvidence.text', 'reason': 'control_character',
                                                  'codePoint': code_point, 'value': 'private recipe'}}),
                                 {key: {'path': '$.recipeEvidence.text', 'reason': 'control_character', 'codePoint': code_point}})
            for code_point in [-1, 32, 0.5, True, '31', float('inf')]:
                self.assertEqual(m.metadata({key: {'path': '$', 'reason': 'control_character', 'codePoint': code_point}}),
                                 {key: {'path': '$', 'reason': 'control_character'}})
            self.assertEqual(m.metadata({key: {'path': '$', 'reason': 'type', 'codePoint': 31}}),
                             {key: {'path': '$', 'reason': 'type'}})
            for path in ['$', '$.recipeEvidence', '$.recipeEvidence.ingredients[39].amount',
                         '$.ingredients[0].evidence', '$.recipeEvidence.componentIndexes[39]',
                         '$.components[39].photoIndex', '$.components[0].assumptions[3]']:
                self.assertEqual(m.metadata({key: {'path': path, 'reason': 'max_length',
                                                  'value': 'private recipe', 'private food': 123}}),
                                 {key: {'path': path, 'reason': 'max_length'}})
            for path in ['$.recipeEvidence.ingredients[40].name', '$.components[-1].name',
                         '$.components[00].name', '$.components[0].assumptions[4]',
                         '$.recipeEvidence.ingredients[0].value', '$.components[0].privateFood',
                         '$.recipeEvidence.text.private', '$.recipeEvidence.text\n', 'private recipe']:
                self.assertEqual(m.metadata({key: {'path': path, 'reason': 'type'}}), {})
            for value in ['private recipe', {'path': '$', 'reason': 'private text'},
                          {'path': True, 'reason': 'type'}, {'path': '$', 'reason': True}]:
                self.assertEqual(m.metadata({key: value}), {})
        result = m.analyse({'version': 1, 'events': [
            event('http_response', 'received', route='photo_analysis', httpStatus=200,
                  recipeValidationIssue={'path': '$.recipeEvidence.text', 'reason': 'max_length', 'value': 'private recipe'},
                  recipeRecheckValidationIssue={'path': '$.recipeEvidence.privateFood', 'reason': 'type'})]})
        self.assertEqual(result['latest_photo_attempt']['recipeValidationIssue'],
                         {'path': '$.recipeEvidence.text', 'reason': 'max_length'})
        self.assertNotIn('recipeRecheckValidationIssue', result['latest_photo_attempt'])
        self.assertNotIn('private', json.dumps(result))

    def test_recipe_retry_detail_only_retains_known_technical_codes(self):
        self.assertEqual(m.metadata({'recipeRecheckDetail': 'evidence_or_mapping_invalid'}),
                         {'recipeRecheckDetail': 'evidence_or_mapping_invalid'})
        self.assertEqual(m.metadata({'recipeRecheckDetail': 'private recipe text'}), {})

    def test_absence_is_not_success_or_zero(self):
        result = m.analyse({'version': 1, 'events': [event('app', 'started')]})
        self.assertFalse(result['coverage']['storage'])
        self.assertIsNone(result['latest_nutrition_counts'])
        self.assertIsNone(result['latest_photo_attempt'])
        self.assertIsNone(result['latest_photo_nutrition'])
        self.assertIn('cannot establish', result['findings'][0])

    def test_backend_timeout_deduplication_and_native_timeout_distinction(self):
        attempt = 'd7a53a6b-49cb-410a-b900-fc6b82e294d6'
        result = m.analyse({'version': 1, 'events': [
            event('http_response', 'received', attemptId=attempt, httpStatus=504, elapsedMs=30000, outcome='upstream_timeout'),
            event('connection', 'upstream_timeout', attemptId=attempt, elapsedMs=34346),
            event('transport', 'analysis_timeout', requestTimeoutMs=55000, resourceTimeoutMs=60000, nativeElapsedMs=55050, timeoutSource='native_transport')]})
        self.assertEqual(result['photo_timeout_attempts'], 2)
        self.assertEqual(result['photo_http_statuses'], {'504': 1})
        self.assertTrue(any('server-side timeout' in f for f in result['findings']))
        self.assertTrue(any('does not establish which' in f for f in result['findings']))
        self.assertNotIn(attempt, json.dumps(result))

    def test_latest_photo_missing_sources_is_separate_from_older_timeout_and_dashboard(self):
        old = 'd7a53a6b-49cb-410a-b900-fc6b82e294d6'
        recent = 'a5835241-7290-49b8-babe-e1af5ead82df'
        result = m.analyse({'version': 1, 'events': [
            event('transport', 'started', route='photo_analysis', attemptId=old),
            event('http_response', 'received', attemptId=old, httpStatus=504, elapsedMs=30000),
            event('transport', 'started', route='photo_analysis', attemptId=recent, requestTimeoutMs=55000),
            event('http_response', 'received', attemptId=recent, httpStatus=200, elapsedMs=18900, nativeElapsedMs=19450),
            event('nutrition', 'incomplete', route='photo_analysis', attemptId=recent, componentCount=3,
                  matchedComponentCount=0, missingAmountCount=0, knownNutrientCount=0,
                  partialNutrientCount=0, missingNutrientCount=8, name='private dish'),
            event('ui_delivery', 'delivered', attemptId=recent),
            event('nutrition', 'incomplete', knownNutrientCount=0, partialNutrientCount=4, missingNutrientCount=8)]})
        self.assertEqual(result['latest_photo_attempt']['httpStatus'], 200)
        self.assertEqual(result['latest_photo_attempt']['elapsedMs'], 18900)
        self.assertEqual(result['latest_photo_attempt']['nativeElapsedMs'], 19450)
        self.assertEqual(result['latest_photo_attempt']['outcome'], 'delivered')
        self.assertTrue(result['latest_photo_attempt']['correlated'])
        self.assertEqual(result['latest_photo_nutrition']['matchedComponentCount'], 0)
        self.assertEqual(result['latest_photo_nutrition']['componentCount'], 3)
        self.assertEqual(result['latest_photo_nutrition']['reason'], 'no_source_matches')
        self.assertEqual(result['latest_photo_nutrition']['partialNutrientCount'], 0)
        self.assertEqual(result['latest_nutrition_counts']['partialNutrientCount'], 4)
        self.assertTrue(any('earlier request' in f for f in result['findings']))
        self.assertTrue(any('no matched nutrition sources' in f for f in result['findings']))
        for private in [old, recent, 'private dish']:
            self.assertNotIn(private, json.dumps(result))

    def test_complete_estimate_is_not_reported_as_missing_source_nutrition(self):
        attempt = 'a5835241-7290-49b8-babe-e1af5ead82df'
        for extras in [dict(componentCount=2, matchedComponentCount=0, missingAmountCount=2),
                       dict(recipeStatus='needs_servings', recipeIngredientCount=5, recipeMissingAmountCount=2)]:
            result = m.analyse({'version':1, 'events':[
                event('image_submission','started',route='chatgpt_photo_analysis',attemptId=attempt),
                event('nutrition','calculated',route='photo_analysis',attemptId=attempt,
                      knownNutrientCount=8,missingNutrientCount=0,partialNutrientCount=0,**extras),
                event('capture_performance','result_ready',requestId=attempt,completeNutrition=True,analyseToResultMs=10157)]})
            self.assertEqual(result['latest_photo_nutrition']['reason'], 'complete_nutrients')
            self.assertEqual(result['latest_photo_attempt']['analyseToResultMs'],10157)
            self.assertFalse(any('no matched nutrition sources' in f or 'cannot yet be converted' in f for f in result['findings']))

    def test_new_attempt_does_not_borrow_previous_nutrients_even_if_previous_finishes_late(self):
        old = 'd7a53a6b-49cb-410a-b900-fc6b82e294d6'
        recent = 'a5835241-7290-49b8-babe-e1af5ead82df'
        result = m.analyse({'version': 1, 'events': [
            event('transport', 'started', route='photo_analysis', attemptId=old),
            event('nutrition', 'calculated', route='photo_analysis', attemptId=old, knownNutrientCount=8),
            event('transport', 'started', route='photo_analysis', attemptId=recent),
            event('http_response', 'received', attemptId=old, httpStatus=200),
            event('ui_delivery', 'delivered', attemptId=old)]})
        self.assertEqual(result['latest_photo_attempt']['outcome'], 'started')
        self.assertNotIn('httpStatus', result['latest_photo_attempt'])
        self.assertIsNone(result['latest_photo_nutrition'])

    def test_recipe_nutrition_summary_reports_missing_servings_and_bounded_counts(self):
        result = m.analyse({'version': 1, 'events': [
            event('nutrition', 'incomplete', route='photo_analysis',
                  attemptId='a5835241-7290-49b8-babe-e1af5ead82df', recipeStatus='needs_servings',
                  recipeIngredientCount=9, recipeMissingAmountCount=2, knownNutrientCount=0, missingNutrientCount=8)]})
        self.assertEqual(result['latest_photo_nutrition']['reason'], 'recipe_servings_missing')
        self.assertEqual(result['latest_photo_nutrition']['recipeIngredientCount'], 9)
        self.assertEqual(result['latest_photo_nutrition']['recipeMissingAmountCount'], 2)
        self.assertTrue(any('portion share' in f for f in result['findings']))

    def test_rejected_recipe_text_is_distinct_from_database_or_storage_failure(self):
        attempt = 'a5835241-7290-49b8-babe-e1af5ead82df'
        result = m.analyse({'version': 1, 'events': [
            event('http_response', 'received', route='photo_analysis', attemptId=attempt, httpStatus=200,
                  normalizationIssues=['meal_recipe_evidence', 'private recipe text', {'private': 'data'}]),
            event('nutrition', 'incomplete', route='photo_analysis', attemptId=attempt,
                  recipeStatus='incomplete', recipeIngredientCount=12, recipeMissingAmountCount=12,
                  componentCount=13, matchedComponentCount=0, knownNutrientCount=0, missingNutrientCount=8)]})
        self.assertEqual(result['latest_photo_nutrition']['reason'], 'recipe_evidence_rejected')
        self.assertTrue(any('all recipe quantities were rejected' in f for f in result['findings']))
        self.assertNotIn('private', json.dumps(result))

    def test_unlinked_photo_events_never_borrow_nearby_dashboard_counts(self):
        result = m.analyse({'version': 1, 'events': [
            event('http_response', 'received', attemptId='private-invalid-id', httpStatus=200),
            event('nutrition', 'incomplete', knownNutrientCount=0, partialNutrientCount=4)]})
        self.assertFalse(result['latest_photo_attempt']['correlated'])
        self.assertIsNone(result['latest_photo_nutrition'])
        self.assertNotIn('private', json.dumps(result))

    def test_invalid_route_and_recipe_metadata_do_not_join_or_leak(self):
        attempt = 'a5835241-7290-49b8-babe-e1af5ead82df'
        result = m.analyse({'version': 1, 'events': [
            event('transport', 'started', route='photo_analysis', attemptId=attempt),
            event('nutrition', 'incomplete', route=['private'], attemptId=attempt,
                  recipeStatus='private', recipeIngredientCount=41, recipeMissingAmountCount=True)]})
        self.assertEqual(result['latest_photo_attempt']['outcome'], 'started')
        self.assertIsNone(result['latest_photo_nutrition'])
        self.assertNotIn('private', json.dumps(result))

    def test_storage_failures_and_zero_nutrients_remain_separate(self):
        result = m.analyse({'version': 1, 'events': [
            event('storage', 'quota_exceeded', store='history', operation='write', payloadBytes=5000000, durable=False, errorClass='quota'),
            event('nutrition', 'incomplete', knownNutrientCount=3, missingNutrientCount=5, zeroNutrientCount=1, componentCount=20),
            event('ui_error', 'promise_rejection', message='private words', stack='private stack')]})
        self.assertEqual(result['latest_nutrition_counts']['zeroNutrientCount'], 1)
        self.assertEqual(result['latest_nutrition_counts']['missingNutrientCount'], 5)
        self.assertEqual(result['storage_outcomes'], {'quota_exceeded': 1})
        self.assertTrue(any('separate from an AI' in f for f in result['findings']))
        self.assertEqual(result['runtime_failures'], {'promise_rejection': 1})
        self.assertNotIn('private', json.dumps(result))

    def test_rating_batch_failures_keep_only_technical_metadata(self):
        result = m.analyse({'version': 1, 'events': [
            event('rating_batch', 'queued', batchSize=20, queueDepth=40),
            event('rating_batch', 'failed', ratingPath='batch', queueWaitMs=4100,
                  lookupMs=123, calculationMs=0, resolvedCount=0, missingCount=20,
                  waitReason='provider_cooldown', name='private food', query='private query'),
            event('rating_batch', 'cancelled', cancelReason='query_changed', batchSize=20)]})
        self.assertTrue(result['coverage']['rating_batch'])
        self.assertEqual(result['rating_batch_outcomes'], {'queued': 1, 'failed': 1, 'cancelled': 1})
        self.assertEqual(result['recent_failures'][0]['queueWaitMs'], 4100)
        self.assertEqual(result['recent_failures'][0]['waitReason'], 'provider_cooldown')
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(m.metadata({'batchSize': True, 'resolvedCount': 101, 'missingCount': -1,
            'queueDepth': 401, 'activeCount': 21, 'lookupMs': 600001, 'ratingPath': 'private',
            'waitReason': ['private'], 'cancelReason': {'private': 'text'}}), {})

    def test_untrusted_types_text_and_bounds(self):
        for basis in ['none', 'composition', 'food_pattern', 'model_nutrient_estimate']:
            self.assertEqual(m.metadata({'scoreBasis': basis}), {'scoreBasis': basis})
        for basis in ['private curry', ['model_nutrient_estimate'], {'source': 'private'}, True]:
            self.assertEqual(m.metadata({'scoreBasis': basis}), {})
        events = [event('nutrition', 'incomplete', knownNutrientCount=True, zeroNutrientCount=-1,
                        missingNutrientCount=9, store='private-food', operation=['private'],
                        outcome={'private': 'text'}, nutrients={'protein': 12}),
                  {'stage': ['private'], 'outcome': 'saved', 'metadata': {}},
                  event('private-stage', 'private-outcome', secret='private')]
        result = m.analyse({'version': 1, 'events': events})
        self.assertEqual(result['latest_nutrition_counts'], {})
        self.assertNotIn('private', json.dumps(result))
        for document in [None, {}, {'version': True, 'events': []}, {'version': 1, 'events': [{}]*201}]:
            with self.assertRaises(ValueError):
                m.analyse(document)

if __name__ == '__main__':
    unittest.main()
