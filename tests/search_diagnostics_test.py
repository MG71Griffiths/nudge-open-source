import importlib.util
from pathlib import Path
import json
import unittest
p=Path(__file__).resolve().parents[1]/'tools/analyse-search-diagnostics.py'
spec=importlib.util.spec_from_file_location('search_diagnostics',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class SearchDiagnosticsTests(unittest.TestCase):
 def test_absence_is_not_success(self):
  result=m.analyse({'version':1,'events':[{'stage':'app','outcome':'started','metadata':{}}]})
  self.assertEqual(result['coverage'],'search_events_absent');self.assertIn('cannot be reconstructed',result['findings'][0])
 def test_failure_vs_filter_vs_cache(self):
  def event(stage,outcome,**metadata):return {'time':1791189000,'stage':stage,'outcome':outcome,'metadata':metadata}
  data={'version':1,'events':[event('search_request','invoked'),event('search_http','received',httpStatus=503),event('search_response','stale',httpStatus=503,resultCount=20,retryAfterSeconds=30),event('search_ui','filtered_empty',recipeCount=4,requirementsExcludedCount=4,spellingCorrected=True,query='private phrase',support='private phase'),event('search_delivery','delivered')]}
  result=m.analyse(data);self.assertEqual(result['provider_http_statuses'],{'503':1});self.assertEqual(result['recipe_library_count'],4);self.assertEqual(result['requirements_excluded_result_events'],1);self.assertEqual(result['response_outcomes'],{'stale':1});self.assertNotIn('private',json.dumps(result));self.assertEqual(result['recent_attempts'][0]['retryAfterSeconds'],30)
 def test_unknown_text_and_invalid_counters_are_not_echoed(self):
  result=m.analyse({'version':1,'events':[{'stage':'search_response','outcome':'private text','metadata':{}},{'stage':'search_ui','outcome':'rendered','metadata':{'recipeCount':True,'requirementsExcludedCount':-1,'query':'secret'}},{'stage':'search_http','outcome':'received','metadata':{'httpStatus':'private'}}]})
  self.assertIsNone(result['recipe_library_count']);self.assertEqual(result['provider_http_statuses'],{});self.assertNotIn('private',json.dumps(result));self.assertNotIn('secret',json.dumps(result))
 def test_bounds(self):
  for data in [{'version':2,'events':[]},{'version':1,'events':[{}]*201},{'version':1,'events':{}}]:
   with self.assertRaises(ValueError):m.analyse(data)
 def test_route_outage_is_distinguished_from_a_sent_provider_request(self):
  events=[{'stage':'search_http','outcome':'providerBusy','metadata':{'httpStatus':503,'requestSent':False,'sourceRoute':'facts_batch','gateReason':'route_outage'}},
          {'stage':'search_http','outcome':'received','metadata':{'httpStatus':200,'requestSent':True,'sourceRoute':'catalogue_search'}},
          {'stage':'search_response','outcome':'providerBusy','metadata':{'requestSent':False,'sourceRoute':'facts_batch','gateReason':'route_outage','query':'private food'}}]
  result=m.analyse({'version':1,'events':events})
  self.assertEqual(result['provider_http_statuses'],{'200':1})
  self.assertEqual(result['blocked_before_network'],1)
  self.assertEqual(result['source_routes'],{'facts_batch':1,'catalogue_search':1})
  self.assertEqual(result['recent_attempts'][0]['gateReason'],'route_outage')
  self.assertIs(result['recent_attempts'][0]['requestSent'],False)
  self.assertNotIn('private',json.dumps(result))

class RatingDiagnosticsTests(unittest.TestCase):
 def event(self,stage,outcome,time=1,**metadata):
  return {'time':time,'stage':stage,'outcome':outcome,'metadata':metadata}
 def test_legacy_timings_pair_by_hash_not_event_adjacency(self):
  first='a'*24;second='b'*24
  events=[self.event('catalogue','started',1,route='product_score',requestHash=first),
          self.event('catalogue','started',2,route='product_score',requestHash=second),
          self.event('catalogue','calculated',2.1,route='product_score',requestHash=second),
          self.event('catalogue','cancelled',4,route='product_score',requestHash=first),
          self.event('catalogue','calculated',5,route='product_score',name='private food'),
          self.event('search_request','started',6)]
  result=m.analyse({'version':1,'events':events});rating=result['rating']
  self.assertEqual(result['requested_searches'],1)
  self.assertEqual(rating['legacy_correlated_pairs'],2)
  self.assertEqual(rating['legacy_unpaired_completions'],1)
  self.assertEqual(rating['legacy_lookup_and_calculation_ms'],{'count':2,'minimum':100,'median':1550,'maximum':3000})
  self.assertIsNone(rating['batch_timings_ms']['queueWaitMs'])
  self.assertNotIn(first,json.dumps(result));self.assertNotIn('private food',json.dumps(result))
 def test_batch_queue_lookup_calculation_and_counts_are_separate(self):
  events=[self.event('rating_batch','queued',queueDepth=40,batchSize=20),
          self.event('rating_batch','deferred',waitReason='read_budget',retryAfterSeconds=5),
          self.event('rating_batch','completed',queueWaitMs=4100,lookupMs=123,calculationMs=4,
                     batchSize=20,resolvedCount=17,missingCount=3,ratingPath='batch',query='private query')]
  result=m.analyse({'version':1,'events':events})['rating']
  self.assertEqual(result['coverage'],'rating_batch_v1')
  self.assertEqual(result['batch_timings_ms']['queueWaitMs']['median'],4100)
  self.assertEqual(result['batch_timings_ms']['lookupMs']['median'],123)
  self.assertEqual(result['batch_timings_ms']['calculationMs']['median'],4)
  self.assertEqual(result['recent_batches'][-1]['missingCount'],3)
  self.assertIn('queue waiting exceeds lookup time',result['findings'][0])
  self.assertNotIn('private',json.dumps(result))
 def test_untrusted_batch_payload_and_invalid_times_never_escape(self):
  events=[self.event('rating_batch','failed',queueWaitMs=True,lookupMs=-1,calculationMs=600001,
                     batchSize=101,resolvedCount='20',missingCount=-1,queueDepth=401,activeCount=21,
                     ratingPath='secret',waitReason=['private'],cancelReason={'private':'x'},name='secret'),
          self.event('rating_batch','private outcome'),
          self.event('catalogue','started',float('nan'),route='product_score',requestHash='c'*24),
          self.event('catalogue','calculated',float('inf'),route='product_score',requestHash='c'*24),
          self.event('catalogue','calculated',1,route='product_score',requestHash='private'),
          {'stage':[],'outcome':{},'metadata':{}}]
  result=m.analyse({'version':1,'events':events})['rating']
  self.assertEqual(result['recent_batches'],[{'outcome':'failed'}])
  self.assertEqual(result['legacy_correlated_pairs'],0)
  self.assertNotIn('private',json.dumps(result));self.assertNotIn('secret',json.dumps(result))
  for bad in [None,[],{'version':True,'events':[]}]:
   with self.assertRaises(ValueError):m.analyse(bad)
 def test_absent_rating_timings_are_not_reported_as_zero(self):
  result=m.analyse({'version':1,'events':[]})['rating']
  self.assertEqual(result['coverage'],'rating_events_absent')
  self.assertIsNone(result['legacy_lookup_and_calculation_ms'])
  self.assertTrue(all(value is None for value in result['batch_timings_ms'].values()))

if __name__=='__main__':unittest.main()
