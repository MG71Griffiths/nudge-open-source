import gzip
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'Backend/scripts/download-off-uk.py'
spec = importlib.util.spec_from_file_location('off_export', MODULE)
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)

class OFFExportTests(unittest.TestCase):
    def run_export(self, rows, **options):
        source = io.BytesIO(gzip.compress(b''.join((json.dumps(row) + '\n').encode() for row in rows)))
        output = io.BytesIO()
        counts = export.extract(source, output, **options)
        return counts, [json.loads(row) for row in output.getvalue().splitlines()]

    def test_retains_bounds_zero_and_preparation_without_contributor_metadata(self):
        counts, rows = self.run_export([{'code':'01833317', 'countries_tags':['en:united-kingdom'],
            'product_name':'Bananas', 'nutriments':{'salt_100g':0.01,'salt_modifier':'<','fat_100g':0},
            'no_nutrition_data':'on', 'nutrition_data_prepared':'on', 'nutrition_data_prepared_per':'100g',
            'nutrition':{'aggregated_set':{'preparation':'prepared','per':'100g'}},
            'creator':'do not copy', 'photographers_tags':['do not copy'],
            'ingredients':[{'text':'Bananas','percent':100}]}])
        self.assertEqual(counts['ukRows'], 1)
        self.assertEqual(rows[0]['nutriments']['salt_modifier'], '<')
        self.assertEqual(rows[0]['nutriments']['fat_100g'], 0)
        self.assertEqual(rows[0]['nutrition_data_prepared_per'], '100g')
        self.assertEqual(rows[0]['no_nutrition_data'], 'on')
        self.assertEqual(rows[0]['nutrition']['aggregated_set']['preparation'], 'prepared')
        self.assertNotIn('do not copy', json.dumps(rows))

    def test_country_membership_obsolete_and_barcode_are_checked(self):
        counts, rows = self.run_export([
            {'code':'12345678','countries_tags':['en:france'],'product_name':'en:united-kingdom'},
            {'code':'12345679','countries_tags':['en:united-kingdom'],'obsolete':True},
            {'code':'not-a-barcode','countries_tags':['en:united-kingdom']},
            {'code':'00000042','countries_tags':['en:united-kingdom','en:france'],'product_name':'Valid'},
        ])
        self.assertEqual(counts['rowsRead'], 4)
        self.assertEqual(counts['ukRows'], 1)
        self.assertEqual(counts['skippedRows'], 1)
        self.assertEqual(rows[0]['code'], '00000042')

    def test_popular_codes_are_bounded_unique_and_ranked_by_source_scan_count(self):
        popular = export.PopularCodes()
        rows = [{'code':str(10000000 + i), 'countries_tags':[export.COUNTRY],
                 'unique_scans_n':i // 2 + 1} for i in range(500)]
        rows.extend([
            {'code':'99999991','countries_tags':['en:france'],'unique_scans_n':999999},
            {'code':'99999992','countries_tags':[export.COUNTRY],'unique_scans_n':999999,'obsolete':1},
            {'code':'99999993','countries_tags':[export.COUNTRY],'unique_scans_n':True},
            {'code':'99999994','countries_tags':[export.COUNTRY],'unique_scans_n':-1},
            {'code':'99999995','countries_tags':[export.COUNTRY],'unique_scans_n':'999999'},
            {'code':'99999996','countries_tags':export.COUNTRY,'unique_scans_n':999999},
            {'code':'10000000','countries_tags':[export.COUNTRY],'unique_scans_n':1000},
        ])
        self.run_export(rows, popular=popular)
        self.assertEqual(len(popular.codes()), 200)
        counts = {row['code']:row['unique_scans_n'] for row in rows[:500]} | {'10000000':1000}
        expected = sorted(counts, key=lambda code: (-counts[code], code))[:200]
        self.assertEqual(popular.codes(), expected)
        self.assertEqual(len(set(popular.codes())), 200)
        for count in range(1001, 3000):
            popular.offer('10000000', count)
        self.assertLessEqual(len(popular._heap), export.POPULAR_LIMIT * 2)
        self.assertEqual(popular.codes()[0], '10000000')

    def test_progress_reports_long_non_uk_prefix(self):
        updates = []
        counts, _ = self.run_export([{'code':'12345678','countries_tags':['en:france']}] * 25_001,
                                   progress=lambda *args: updates.append(args), clock=lambda: 0)
        self.assertEqual(counts['ukRows'], 0)
        self.assertEqual([value[0] for value in updates], [10_000, 20_000, 25_001])
        self.assertTrue(all(value[1:] == (0, 0) for value in updates))

    def test_progress_reports_slow_prefix_before_row_threshold(self):
        updates = []
        times = iter([0, 16, 17])
        self.run_export([{'code':'12345678','countries_tags':['en:france']}] * 2,
                        progress=lambda *args: updates.append(args), clock=lambda: next(times))
        self.assertEqual([value[0] for value in updates], [1, 2])

    def test_cli_seed_is_public_codes_with_complete_source_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            fixture, output, codes = base/'source.gz', base/'uk.jsonl', base/'seed.json'
            fixture.write_bytes(gzip.compress((json.dumps({'code':'00000042','product_name':'Synthetic public food',
                'countries_tags':[export.COUNTRY],'unique_scans_n':9,'creator':'must not copy'}) + '\n').encode()))
            subprocess.run([sys.executable, str(MODULE), '--input-gzip', str(fixture), '--output', str(output),
                            '--popular-codes-output', str(codes)], check=True, capture_output=True)
            seed = json.loads(codes.read_text())
            manifest = json.loads(output.with_suffix('.jsonl.manifest.json').read_text())
            self.assertEqual(seed['codes'], ['00000042'])
            self.assertTrue(seed['complete'])
            self.assertEqual(seed['rankingField'], 'unique_scans_n')
            self.assertEqual(seed['sourceExtractSHA256'], manifest['sha256'])
            self.assertEqual(seed['startedAt'], manifest['startedAt'])
            self.assertNotIn('Synthetic public food', codes.read_text())
            self.assertNotIn('must not copy', codes.read_text())
            self.assertFalse(output.with_suffix('.jsonl.part').exists())

    def test_failed_extract_does_not_publish_partial_seed(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            fixture, output, codes = base/'source.gz', base/'uk.jsonl', base/'seed.json'
            fixture.write_bytes(gzip.compress(b'{"countries_tags":["en:united-kingdom"],INVALID}\n'))
            result = subprocess.run([sys.executable, str(MODULE), '--input-gzip', str(fixture), '--output', str(output),
                                     '--popular-codes-output', str(codes)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(codes.exists())
            self.assertFalse(output.exists())
            manifest = json.loads(output.with_suffix('.jsonl.manifest.json').read_text())
            self.assertFalse(manifest['complete'])
            self.assertIn('failedAt', manifest)

class OFFImageExportTests(unittest.TestCase):
    def product(self, **extra):
        return {'code':'3168930010883','countries_tags':[export.COUNTRY], **extra}

    def test_legacy_selected_front_builds_documented_display_and_small_urls(self):
        result = export.front_image_urls(self.product(images={'front_fr':{'rev':'4','sizes':{'400':{},'200':{}}}}))
        self.assertEqual(result['image_front_url'], 'https://images.openfoodfacts.org/images/products/316/893/001/0883/front_fr.4.400.jpg')
        self.assertEqual(result['image_front_small_url'], 'https://images.openfoodfacts.org/images/products/316/893/001/0883/front_fr.4.200.jpg')
        self.assertEqual(result['image_url'], result['image_front_url'])

    def test_current_schema_prefers_english_and_retains_other_selected_languages(self):
        result = export.front_image_urls(self.product(lc='fr', images={'selected':{'front':{'fr':{'rev':4},'en':{'rev':9}}}}))
        self.assertTrue(result['image_front_url'].endswith('/front_en.9.400.jpg'))
        self.assertEqual(set(result['selected_images']['front']['display']), {'en','fr'})

    def test_short_and_long_codes_follow_current_server_normalization(self):
        for code, expected in [('01833317','000/000/183/3317'), ('001234567890123','123/456/789/0123'),
                               ('12345678901234','123/456/789/01234')]:
            with self.subTest(code=code):
                result = export.front_image_urls(self.product(code=code,images={'front_en':{'rev':2}}))
                self.assertIn('/'+expected+'/', result['image_front_url'])

    def test_untrusted_revision_language_and_code_cannot_create_urls(self):
        for revision in ['../2', '4/5', -1, 1.5, True, None, '1e3']:
            self.assertEqual(export.front_image_urls(self.product(images={'front_en':{'rev':revision}})), {})
        self.assertEqual(export.front_image_urls(self.product(images={'front_../../en':{'rev':2}})), {})
        self.assertEqual(export.front_image_urls(self.product(code='../1234',images={'front_en':{'rev':2}})), {})
        self.assertEqual(export.front_image_urls(self.product(code='00000001',images={'front_en':{'rev':2}})), {})

    def test_known_urls_remain_authoritative_and_no_raw_upload_metadata_is_copied(self):
        row = self.product(image_front_url='https://images.openfoodfacts.org/images/products/316/893/001/0883/front_en.10.400.jpg',
                           images={'front_en':{'rev':9},'1':{'uploader':'not copied','uploaded_t':123}})
        _, result = OFFExportTests().run_export([row])
        self.assertEqual(result[0]['image_front_url'], row['image_front_url'])
        self.assertNotIn('selected_images', result[0])
        self.assertNotIn('images', result[0]);self.assertNotIn('not copied', json.dumps(result))

    def test_raw_uploads_and_nonfront_images_do_not_become_product_photos(self):
        self.assertEqual(export.front_image_urls(self.product(images={'1':{'rev':2},'nutrition_en':{'rev':3}})), {})
        result = export.front_image_urls(self.product(images={'front_en':{'rev':2,'sizes':{'200':{}}}}))
        self.assertNotIn('image_front_url', result)
        self.assertTrue(result['image_front_small_url'].endswith('.200.jpg'))

    def test_extraction_adds_images_without_changing_nutrition_or_preparation(self):
        row = self.product(nutriments={'salt_100g':0.01,'salt_modifier':'<'},nutrition_data_prepared='on',
                           images={'selected':{'front':{'en':{'rev':7}}}})
        _, result = OFFExportTests().run_export([row])
        self.assertEqual(result[0]['nutriments'], row['nutriments'])
        self.assertEqual(result[0]['nutrition_data_prepared'], 'on')
        self.assertTrue(result[0]['image_front_url'].endswith('/front_en.7.400.jpg'))
        self.assertTrue(result[0]['selected_images']['front']['small']['en'].endswith('/front_en.7.200.jpg'))

if __name__ == '__main__':
    unittest.main()
