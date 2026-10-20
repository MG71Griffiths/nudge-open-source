#!/usr/bin/env python3
"""Stream the official full OFF export into a bounded-field UK JSONL extract.

Unlike the compact Parquet projection, the full export retains nutrient
qualifiers and preparation evidence. No product API crawling is performed.
An interrupted download leaves a .part file and an incomplete manifest.
"""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import heapq
import json
from pathlib import Path
import re
import time
import urllib.request

SOURCE = 'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz'
FIELDS = set('code product_name product_name_en brands brands_tags quantity product_quantity product_quantity_unit ingredients_text ingredients_text_en ingredients ingredients_analysis_tags allergens allergens_tags traces traces_tags nutriments nutrition nutrition_data_per nutrition_data nutrition_data_prepared nutrition_data_prepared_per serving_size serving_quantity serving_quantity_unit categories_tags countries_tags stores_tags stores labels_tags last_modified_t data_quality_errors_tags data_quality_warnings_tags selected_images lc image_front_url image_front_small_url image_url image_nutrition_url image_ingredients_url nutriscore_grade nutrition_grades nutriscore nova_group additives_tags popularity_key unique_scans_n scans_n obsolete'.split())
FIELDS.add('no_nutrition_data')
COUNTRY = 'en:united-kingdom'
POPULAR_LIMIT = 200

def front_image_urls(product):
    """Derive selected front URLs from OFF's old or current dump schema.

    Mirrors ProductOpener::Products::split_code and Images::get_image_url:
    strip leading zeroes, pad to 13, split 3/3/3/rest; front_LANG.REV.SIZE.jpg.
    Source: github.com/openfoodfacts/openfoodfacts-server/blob/main/lib/ProductOpener/{Products,Images}.pm
    Contributor names/raw uploads are deliberately not retained in the extract.
    """
    code = str(product.get('code') or '')
    digits = code.lstrip('0')
    if not code.isascii() or not code.isdigit() or not 4 <= len(digits) <= 18:
        return {}
    padded = digits.zfill(13)
    path = '/'.join([padded[:3], padded[3:6], padded[6:9], padded[9:]])
    images = product.get('images')
    if not isinstance(images, dict):
        return {}
    selections = {key[6:]: value for key, value in images.items() if key.startswith('front_')}
    selected = images.get('selected')
    if isinstance(selected, dict) and isinstance(selected.get('front'), dict):
        selections.update(selected['front'])
    front = {'display': {}, 'small': {}}
    for language, record in sorted(selections.items()):
        if not re.fullmatch(r'[a-z]{2,3}(?:-[a-z0-9]{2,8})?', language) or not isinstance(record, dict):
            continue
        revision = record.get('rev')
        if isinstance(revision, bool) or not isinstance(revision, (str, int)):
            continue
        revision = str(revision)
        if not re.fullmatch(r'[0-9]{1,10}', revision):
            continue
        revision = str(int(revision))
        for size, resolution in [('display', 400), ('small', 200)]:
            sizes = record.get('sizes')
            # Existing selected crops use these standard resolutions. When
            # explicit sizes are supplied, do not invent an unavailable size.
            if isinstance(sizes, dict) and str(resolution) not in sizes:
                continue
            front[size][language] = f'https://images.openfoodfacts.org/images/products/{path}/front_{language}.{revision}.{resolution}.jpg'
    if not any(front.values()):
        return {}
    preferred = ['en', product.get('lang'), product.get('lc')]
    result = {'selected_images': {'front': front}}
    for size, field in [('display', 'image_front_url'), ('small', 'image_front_small_url')]:
        available = front[size]
        language = next((key for key in preferred if isinstance(key, str) and key in available), None)
        language = language or next(iter(available), None)
        if language:
            result[field] = available[language]
    if result.get('image_front_url'):
        result['image_url'] = result['image_front_url']
    return result

class _PopularityItem:
    __slots__ = ('code', 'count')

    def __init__(self, code, count):
        self.code, self.count = code, count

    def __lt__(self, other):
        # Heap head is the least popular, then lexically largest barcode.
        return self.count < other.count or self.count == other.count and self.code > other.code

class PopularCodes:
    """Bounded top-200 public identities; never retains product or user data."""
    def __init__(self):
        self._counts = {}
        self._heap = []

    def offer(self, code, count):
        if isinstance(count, bool) or not isinstance(count, int) or not 0 < count <= 2**53 - 1:
            return
        if code in self._counts and count <= self._counts[code]:
            return
        while self._heap and self._counts.get(self._heap[0].code) != self._heap[0].count:
            heapq.heappop(self._heap)
        item = _PopularityItem(code, count)
        if code not in self._counts and len(self._counts) >= POPULAR_LIMIT:
            if not self._heap[0] < item:
                return
            del self._counts[heapq.heappop(self._heap).code]
        self._counts[code] = count
        heapq.heappush(self._heap, item)
        # Repeated source identities cannot grow the lazy heap without bound.
        if len(self._heap) > POPULAR_LIMIT * 2:
            self._heap = [_PopularityItem(code, count) for code, count in self._counts.items()]
            heapq.heapify(self._heap)

    def codes(self):
        return sorted(self._counts, key=lambda code: (-self._counts[code], code))

def extract(stream, output, progress=None, popular=None, clock=time.monotonic):
    seen = selected = skipped = 0
    digest = hashlib.sha256()
    last_progress = clock()
    with gzip.GzipFile(fileobj=stream) as source:
        while True:
            line = source.readline(32 * 1024 * 1024 + 1)
            if not line:
                break
            if len(line) > 32 * 1024 * 1024:
                raise ValueError('Source product exceeds 32 MiB safety bound')
            seen += 1
            # UK products may occur late in the global dump. Report source
            # progress independently of successful UK selections.
            now = clock()
            if seen % 10_000 == 0 or now - last_progress >= 15:
                output.flush()
                if progress:
                    progress(seen, selected, skipped)
                last_progress = now
            # Cheap prefilter; country membership is validated after decoding.
            if b'en:united-kingdom' not in line:
                continue
            product = json.loads(line)
            countries = product.get('countries_tags')
            if not isinstance(countries, list) or COUNTRY not in countries or product.get('obsolete') in (True, 1, '1'):
                continue
            code = str(product.get('code') or '')
            if not code.isascii() or not code.isdigit() or not 4 <= len(code) <= 18:
                skipped += 1
                continue
            public = {key: value for key, value in product.items() if key in FIELDS}
            public['code'] = code
            selected_front = public.get('selected_images')
            selected_front = selected_front.get('front') if isinstance(selected_front, dict) else None
            # API-derived URLs already choose a selection revision. Do not add
            # conflicting derived candidates that a client might prefer to it.
            if not selected_front and not any(public.get(key) for key in ['image_front_url','image_front_small_url','image_url']):
                public.update(front_image_urls(product))
            encoded = (json.dumps(public, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()
            # Preserve original evidence. Oversize records are counted, not
            # silently truncated into apparently complete products.
            if len(encoded) > 512_000:
                skipped += 1
                continue
            output.write(encoded)
            digest.update(encoded)
            selected += 1
            if popular is not None:
                popular.offer(code, product.get('unique_scans_n'))
            if selected % 1000 == 0:
                output.flush()
                if progress:
                    progress(seen, selected, skipped)
                last_progress = clock()
    if progress:
        progress(seen, selected, skipped)
    return {'rowsRead': seen, 'ukRows': selected, 'skippedRows': skipped, 'sha256': digest.hexdigest()}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--input-gzip', type=Path, help='Use an already downloaded official export, or a test fixture')
    parser.add_argument('--popular-codes-output', type=Path, help='Write up to 200 UK product barcodes ranked by positive unique_scans_n after a complete extract')
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    partial = args.output.with_suffix(args.output.suffix + '.part')
    manifest_path = args.output.with_suffix(args.output.suffix + '.manifest.json')
    popular = PopularCodes() if args.popular_codes_output else None
    manifest = {'sourceURL': SOURCE, 'licenceURL': 'https://opendatacommons.org/licenses/odbl/1-0/',
                'attribution': 'Open Food Facts contributors', 'country': COUNTRY,
                'startedAt': datetime.now(timezone.utc).isoformat(), 'complete': False}
    def checkpoint(seen, selected, skipped):
        manifest.update(rowsRead=seen, ukRows=selected, skippedRows=skipped)
        manifest_path.write_text(json.dumps(manifest, indent=2))
        print(json.dumps({'rowsRead': seen, 'ukRows': selected, 'skippedRows': skipped}), flush=True)
    manifest_path.write_text(json.dumps(manifest, indent=2))
    request = urllib.request.Request(SOURCE, headers={'User-Agent': 'Nudge/0.1 (UK catalogue bulk import; https://example.invalid/nudge)'})
    stream = args.input_gzip.open('rb') if args.input_gzip else urllib.request.urlopen(request, timeout=60)
    with stream, partial.open('wb') as output:
        if hasattr(stream, 'headers'):
            manifest['sourceLastModified'] = stream.headers.get('Last-Modified')
            manifest['sourceETag'] = stream.headers.get('ETag')
        try:
            result = extract(stream, output, checkpoint, popular)
        except Exception:
            manifest['failedAt'] = datetime.now(timezone.utc).isoformat()
            manifest_path.write_text(json.dumps(manifest, indent=2))
            raise
    manifest.update(result, complete=True, completedAt=datetime.now(timezone.utc).isoformat())
    partial.replace(args.output)
    if args.popular_codes_output:
        args.popular_codes_output.parent.mkdir(parents=True, exist_ok=True)
        codes = popular.codes()
        seed = {key: manifest[key] for key in ['sourceURL', 'licenceURL', 'attribution', 'country', 'startedAt', 'completedAt']}
        seed.update(complete=True, rankingField='unique_scans_n', maximumCodes=POPULAR_LIMIT,
                    codes=codes, count=len(codes), sourceExtractSHA256=result['sha256'])
        seed_partial = args.popular_codes_output.with_suffix(args.popular_codes_output.suffix + '.part')
        seed_partial.write_text(json.dumps(seed, indent=2) + '\n')
        seed_partial.replace(args.popular_codes_output)
        manifest['popularCodeCount'] = len(codes)
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest), flush=True)

if __name__ == '__main__':
    main()
