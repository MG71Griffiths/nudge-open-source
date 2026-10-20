#!/usr/bin/env python3
"""Summarise bounded Nudge search diagnostics without printing queries or food data."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
from statistics import median

STAGES={'search_request','search_http','search_response','search_delivery','search_ui'}
OUTCOMES={'started','invoked','received','cached','stale','matched','no_matches','rendered','filtered_empty','invalidQuery','invalidResponse','offline','timeout','rateLimited','providerBusy','unavailable','cancelled','delivered','delivery_failed'}
RATING_OUTCOMES={'queued','started','completed','failed','deferred','cancelled','cache_hit'}
LEGACY_RATING_OUTCOMES={'started','calculated','incomplete','cancelled','invalidResponse','rateLimited','offline','timeout','notFound','incompleteProduct','invalidBarcode','unavailable','server'}
RATING_COUNTS={'queueWaitMs':600000,'lookupMs':600000,'networkMs':600000,'calculationMs':600000,'elapsedMs':600000,
               'batchSize':100,'resolvedCount':100,'missingCount':100,'queueDepth':400,'activeCount':20,
               'retryAfterSeconds':3600,'httpStatus':599}
RATING_ENUMS={'ratingPath':{'batch','full_record','cache','catalogue'},
             'sourceRoute':{'discovery','facts_batch','alternatives','catalogue_search','catalogue_batch'},
             'gateReason':{'local_budget','provider_pause','route_outage'},
             'waitReason':{'pacing','provider_cooldown','read_budget'},
             'cancelReason':{'query_changed','screen_left','task_cancelled'}}

def integer(value, maximum=10000):
    return value if type(value) is int and 0 <= value <= maximum else None

def timestamp(value):
    return value if type(value) in (int,float) and math.isfinite(value) and 0<=value<=4102444800 else None

def distribution(values):
    return {'count':len(values),'minimum':min(values),'median':median(values),'maximum':max(values)} if values else None

def rating_summary(events):
    """Correlate legacy jobs internally; never return hashes or food identities.

    Legacy elapsed time is lookup plus calculation, not measured queue delay.
    New batches report queue, complete lookup and local calculation separately.
    Lookup includes public-cache reads, network, parsing and cache writes. Start intervals are
    intentionally not treated as waiting: they may include scrolling or idle time.
    """
    legacy=[]; batches=[]
    for event in events:
        if not isinstance(event,dict) or not isinstance(event.get('metadata'),dict): continue
        stage,outcome=event.get('stage'),event.get('outcome')
        if type(outcome) is not str: continue
        if stage=='rating_batch' and outcome in RATING_OUTCOMES: batches.append(event)
        elif stage=='catalogue' and outcome in LEGACY_RATING_OUTCOMES and event['metadata'].get('route')=='product_score': legacy.append(event)
    pending={}; paired=[]; unpaired=0
    for event in legacy:
        identity=event['metadata'].get('requestHash');time=timestamp(event.get('time'))
        if type(identity) is not str or not re.fullmatch(r'[a-f0-9]{24}',identity) or time is None:
            if event['outcome']!='started': unpaired+=1
            continue
        if event['outcome']=='started': pending[identity]=time
        else:
            start=pending.pop(identity,None)
            if start is None or not 0<=time-start<=600: unpaired+=1;continue
            paired.append({'outcome':event['outcome'],'lookupAndCalculationMs':round((time-start)*1000)})
    recent=[]
    for event in batches[-20:]:
        raw=event['metadata'];item={'outcome':event['outcome']}
        item.update({key:raw[key] for key,maximum in RATING_COUNTS.items() if integer(raw.get(key),maximum) is not None})
        item.update({key:raw[key] for key,choices in RATING_ENUMS.items() if type(raw.get(key)) is str and raw[key] in choices})
        if type(raw.get('requestSent')) is bool: item['requestSent']=raw['requestSent']
        recent.append(item)
    completed=[e for e in batches if e['outcome'] in {'completed','failed','cancelled','cache_hit'}]
    timings={key:distribution([e['metadata'][key] for e in completed if integer(e['metadata'].get(key),600000) is not None])
             for key in ['queueWaitMs','lookupMs','calculationMs']}
    notes=[]
    if not legacy and not batches:
        notes.append('No rating retrieval events were recorded; this file cannot establish rating latency.')
    if legacy:
        notes.append('Legacy rating durations combine lookup and calculation. Queue waiting was not recorded, and gaps between starts can include pacing, scrolling or idle time.')
    if batches:
        if timings['queueWaitMs'] and timings['lookupMs'] and timings['queueWaitMs']['median']>timings['lookupMs']['median']:
            notes.append('Reported batch queue waiting exceeds lookup time at the median. Check recorded pacing, read-budget or provider-cooldown reasons before changing source calls.')
        if any(e['outcome']=='deferred' for e in batches):
            notes.append('Some rating batches were deferred. Their fixed wait reasons distinguish local pacing/read budgets from provider cooldown.')
    return {'coverage':'rating_batch_v1' if batches else 'legacy_rating_events' if legacy else 'rating_events_absent',
            'legacy_outcomes':dict(Counter(e['outcome'] for e in legacy if e['outcome']!='started')),
            'legacy_correlated_pairs':len(paired),'legacy_unpaired_completions':unpaired,'legacy_unfinished_starts':len(pending),
            'legacy_lookup_and_calculation_ms':distribution([e['lookupAndCalculationMs'] for e in paired]),
            'legacy_recent_attempts':paired[-20:],
            'batch_outcomes':dict(Counter(e['outcome'] for e in batches)),
            'batch_timings_ms':timings,'recent_batches':recent,'findings':notes}

def analyse(document):
    if not isinstance(document,dict) or type(document.get('version')) is not int or document['version'] != 1 or not isinstance(document.get('events'),list) or len(document['events'])>200:
        raise ValueError('Unexpected diagnostic format')
    events=[e for e in document['events'] if isinstance(e,dict) and type(e.get('stage')) is str and e['stage'] in STAGES and type(e.get('outcome')) is str and e['outcome'] in OUTCOMES and isinstance(e.get('metadata'),dict)]
    responses=[e for e in events if e['stage']=='search_response']
    http=[e for e in events if e['stage']=='search_http']
    ui=[e for e in events if e['stage']=='search_ui']
    statuses=Counter(str(e['metadata']['httpStatus']) for e in http if integer(e['metadata'].get('httpStatus'),599) is not None and e['outcome']=='received' and e['metadata'].get('requestSent') is not False)
    outcomes=Counter(e['outcome'] for e in responses)
    counts=[integer(e['metadata'].get('recipeCount')) for e in ui]
    result={
        'coverage':'search_v1' if events else 'search_events_absent',
        'events_in_file':len(document['events']), 'search_events':len(events),
        'requested_searches':sum(e['stage']=='search_request' and e['outcome'] in {'started','invoked'} for e in events),
        'provider_http_statuses':dict(statuses), 'response_outcomes':dict(outcomes),
        'blocked_before_network':sum(e['metadata'].get('requestSent') is False for e in http),
        'source_routes':dict(Counter(e['metadata']['sourceRoute'] for e in http if type(e['metadata'].get('sourceRoute')) is str and e['metadata']['sourceRoute'] in RATING_ENUMS['sourceRoute'])),
        'empty_visible_result_events':sum(e['outcome']=='filtered_empty' for e in ui),
        'requirements_excluded_result_events':sum((integer(e['metadata'].get('requirementsExcludedCount')) or 0)>0 for e in ui),
        'spelling_correction_events':sum(e['metadata'].get('spellingCorrected') is True for e in ui),
        'equivalent_spelling_events':sum(e['metadata'].get('aliasMatched') is True for e in ui),
        'recipe_library_count':next((n for n in reversed(counts) if n is not None),None),
        'delivery_failures':sum(e['stage']=='search_delivery' and e['outcome']=='delivery_failed' for e in events),
        'findings':[], 'recent_attempts':[], 'rating':rating_summary(document['events'])}
    notes=result['findings']
    if not events: notes.append('This file has no search diagnostics. Earlier queries and their failures cannot be reconstructed retrospectively.')
    if '503' in statuses: notes.append('The food provider returned HTTP 503. This can mean provider load or global throttling; it does not establish an OpenAI quota problem.')
    if '429' in statuses or outcomes['rateLimited']: notes.append('Search throttling occurred. Check actual HTTP status versus the local request guard; respect the recorded retry interval.')
    if outcomes['offline'] or outcomes['timeout']: notes.append('Connection or response-time failures occurred; check cached fallback and network conditions.')
    if outcomes['no_matches']: notes.append('The source returned no products for at least one request. Review equivalent spelling recovery; this differs from local filtering.')
    if result['requirements_excluded_result_events']: notes.append('Saved food requirements excluded some loaded foods. This is not evidence that the recipe import failed.')
    if outcomes['stale']: notes.append('Previously loaded public products were used during source failure; those facts need a later refresh.')
    if result['delivery_failures']: notes.append('At least one native response did not reach the Search controller.')
    for event in responses[-20:]:
        meta=event['metadata'];entry={'outcome':event['outcome']}
        time=event.get('time')
        if timestamp(time) is not None: entry['time_utc']=datetime.fromtimestamp(time,timezone.utc).isoformat()
        for key,maximum in [('page',20),('httpStatus',599),('resultCount',10000),('elapsedMs',600000),('retryAfterSeconds',3600)]:
            value=integer(meta.get(key),maximum)
            if value is not None: entry[key]=value
        for key in ['sourceRoute','gateReason']:
            if type(meta.get(key)) is str and meta[key] in RATING_ENUMS[key]: entry[key]=meta[key]
        if type(meta.get('requestSent')) is bool: entry['requestSent']=meta['requestSent']
        result['recent_attempts'].append(entry)
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file',nargs='?',type=Path,help='Diagnostic events.json; defaults to latest private download')
    args=parser.parse_args()
    path=args.file
    if path is None:
        files=list((Path(__file__).resolve().parent.parent/'.local/diagnostics').glob('*/events.json'))
        if not files: parser.error('Download diagnostics first with tools/download-diagnostics.py')
        path=max(files,key=lambda p:p.stat().st_mtime)
    try:
        if path.stat().st_size>262144: raise ValueError('Diagnostic file exceeds the size bound')
        document=json.loads(path.read_text())
        if not isinstance(document,dict): raise ValueError('Unexpected diagnostic document')
        print(json.dumps(analyse(document),indent=2))
    except (OSError,ValueError,TypeError) as error:
        parser.exit(1,'Cannot analyse diagnostics: '+str(error)+'\n')

if __name__=='__main__':main()
