import { ambassadorSchema } from './ambassadors.js';
import { catalogueScoringRunSchema } from './catalogue-scoring-run-schema.js';
import { catalogueQualityHoldSchema } from './catalogue-quality-hold.js';
import { discoverySchema } from './catalogue-discovery-index.js';
import { placeSchema } from './catalogue-place-index.js';
import { contributionSchema } from './product-contribution-schema.js';
import { catalogueScoreEvidenceSchema } from './catalogue-score-evidence-schema.js';
import { womensFoodTagSchema } from './womens-food-tag-schema.js';
import { catalogueEnrichmentSchema } from './catalogue-enrichment-schema.js';
// Shared schema for the SQLite Durable Object. Kept equal to migrations/0001_food_catalogue.sql by tests.
export const catalogueSchema = String.raw`-- Public catalogue tables contain only public product evidence. Private
-- contribution photos live in separately permissioned, expiring tables below.
-- Account credentials, voice transcripts and diary data are never stored here.
-- Optional ambassador profiles and private contribution ownership use opaque account subjects.
CREATE TABLE IF NOT EXISTS catalogue_products (
  barcode TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT NOT NULL DEFAULT '',
  name_sort TEXT NOT NULL,
  search_text TEXT NOT NULL,
  is_uk INTEGER NOT NULL CHECK (is_uk IN (0,1)),
  provider_json TEXT NOT NULL,
  source_revision INTEGER,
  source_fingerprint TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  licence_url TEXT NOT NULL,
  import_source_url TEXT NOT NULL,
  score_json TEXT NOT NULL,
  rating_value INTEGER CHECK (rating_value BETWEEN 0 AND 100),
  score_method TEXT NOT NULL,
  score_version TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  calculated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS catalogue_rating ON catalogue_products(is_uk, rating_value DESC, barcode);
-- Cover rating candidates without fetching large nutrition/source JSON for
-- every match. The selected page alone hydrates those product payloads.
CREATE INDEX IF NOT EXISTS catalogue_rating_candidates ON catalogue_products(is_uk, score_method, score_version, classifier_version, rating_value DESC, name_sort, barcode);
-- Narrow, source-bound discovery candidates hydrate full product JSON only after pagination.
CREATE INDEX IF NOT EXISTS catalogue_search_candidates ON catalogue_products(barcode,is_uk,source_fingerprint,name_sort,score_method,score_version,classifier_version,rating_value);
CREATE INDEX IF NOT EXISTS catalogue_name ON catalogue_products(is_uk, name_sort, barcode);
CREATE INDEX IF NOT EXISTS catalogue_expiry ON catalogue_products(expires_at);
CREATE VIRTUAL TABLE IF NOT EXISTS catalogue_fts USING fts5(search_text, content='catalogue_products', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS catalogue_ai AFTER INSERT ON catalogue_products BEGIN
  INSERT INTO catalogue_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS catalogue_ad AFTER DELETE ON catalogue_products BEGIN
  INSERT INTO catalogue_fts(catalogue_fts,rowid,search_text) VALUES ('delete',old.rowid,old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS catalogue_au AFTER UPDATE OF search_text ON catalogue_products BEGIN
  INSERT INTO catalogue_fts(catalogue_fts,rowid,search_text) VALUES ('delete',old.rowid,old.search_text);
  INSERT INTO catalogue_fts(rowid,search_text) VALUES (new.rowid,new.search_text);
END;
CREATE TABLE IF NOT EXISTS catalogue_filters (
  barcode TEXT NOT NULL REFERENCES catalogue_products(barcode) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('store','category')),
  value TEXT NOT NULL,
  PRIMARY KEY(barcode,kind,value)
);
CREATE INDEX IF NOT EXISTS catalogue_filter_lookup ON catalogue_filters(kind,value,barcode);
-- Image-only source enrichment has its own retrieval date. It cannot freshen
-- nutrition facts, change a rating, or create a new product.
CREATE TABLE IF NOT EXISTS catalogue_image_sources (
  barcode TEXT NOT NULL REFERENCES catalogue_products(barcode) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK(field IN ('image_url','image_front_url','image_front_small_url')),
  source_revision INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  retrieved_at INTEGER NOT NULL,
  image_url TEXT NOT NULL,
  PRIMARY KEY(barcode,field)
);
-- Enrichment evidence has its own lifecycle/version. No cycle or menopause
-- benefit tags are populated or inferred in this release.
CREATE TABLE IF NOT EXISTS catalogue_enrichments (
  id TEXT PRIMARY KEY,
  barcode TEXT NOT NULL REFERENCES catalogue_products(barcode) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  tag TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  evidence_version TEXT NOT NULL,
  source_revision INTEGER,
  review_state TEXT NOT NULL CHECK(review_state IN ('pending','verified','rejected')),
  reviewed_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS catalogue_enrichment_lookup ON catalogue_enrichments(barcode,review_state,expires_at);
CREATE TABLE IF NOT EXISTS catalogue_imports (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  imported_at INTEGER NOT NULL,
  product_count INTEGER NOT NULL,
  status TEXT NOT NULL
);
-- Optional trusted R2 export chunks. Cron consumes at most one bounded chunk
-- per tick; it never crawls OFF product APIs or downloads a whole export in RAM.
CREATE TABLE IF NOT EXISTS catalogue_import_queue (
  object_key TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  queued_at INTEGER NOT NULL,
  processed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','complete','failed'))
);
`+contributionSchema+ambassadorSchema+catalogueScoreEvidenceSchema+womensFoodTagSchema+catalogueEnrichmentSchema+discoverySchema+placeSchema+catalogueScoringRunSchema+catalogueQualityHoldSchema;
