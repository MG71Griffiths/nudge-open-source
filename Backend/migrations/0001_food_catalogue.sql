-- Public catalogue tables contain only public product evidence. Private
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

CREATE TABLE IF NOT EXISTS product_contributions (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, barcode TEXT NOT NULL,
 market_country TEXT, store TEXT, consent_version TEXT NOT NULL,
 request_hash TEXT NOT NULL, status TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER, lease_token TEXT, lease_until INTEGER,
 source_lookup TEXT NOT NULL DEFAULT 'not_checked', candidate_json TEXT, error_code TEXT,
 reviewed_at INTEGER, published_at INTEGER
);
CREATE INDEX IF NOT EXISTS contributions_owner ON product_contributions(owner,created_at DESC);
CREATE INDEX IF NOT EXISTS contributions_queue ON product_contributions(status,next_retry_at,lease_until);
CREATE INDEX IF NOT EXISTS contributions_expiry ON product_contributions(expires_at);
CREATE TABLE IF NOT EXISTS product_contribution_photos (
 contribution_id TEXT NOT NULL REFERENCES product_contributions(id) ON DELETE CASCADE,
 role TEXT NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL, image BLOB NOT NULL,
 PRIMARY KEY(contribution_id,role)
);
CREATE TABLE IF NOT EXISTS reviewed_products (
 barcode TEXT PRIMARY KEY, provider_json TEXT NOT NULL, score_json TEXT NOT NULL,
 source_fingerprint TEXT NOT NULL, source_revision INTEGER NOT NULL,
 observed_at INTEGER NOT NULL, reviewed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, calculated_at INTEGER NOT NULL,
 score_method TEXT NOT NULL, score_version TEXT NOT NULL, classifier_version TEXT NOT NULL,
 provenance_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ambassador_profiles (
 owner TEXT PRIMARY KEY, profile_id TEXT NOT NULL UNIQUE, handle TEXT NOT NULL UNIQUE, adjective TEXT NOT NULL, noun TEXT NOT NULL,
 leaderboard_visible INTEGER NOT NULL DEFAULT 0 CHECK(leaderboard_visible IN(0,1)),
 joined_at INTEGER NOT NULL, terms_version TEXT NOT NULL, adult_confirmed INTEGER NOT NULL CHECK(adult_confirmed=1)
);
CREATE TABLE IF NOT EXISTS ambassador_awards (
 owner TEXT NOT NULL REFERENCES ambassador_profiles(owner) ON DELETE CASCADE,
 barcode TEXT NOT NULL, fact_fingerprint TEXT NOT NULL, awarded_at INTEGER NOT NULL,
 points INTEGER NOT NULL CHECK(points=1), PRIMARY KEY(owner,barcode)
);
CREATE INDEX IF NOT EXISTS ambassador_awards_week ON ambassador_awards(awarded_at,owner);
-- No owner, handle, contribution ID, timestamp or joinable award identifier is
-- retained here. These irreversible digests describe public product facts only.
CREATE TABLE IF NOT EXISTS ambassador_fact_receipts (fact_fingerprint TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ambassador_blocks (owner TEXT NOT NULL,target TEXT NOT NULL,PRIMARY KEY(owner,target));
CREATE TABLE IF NOT EXISTS ambassador_reports (id TEXT PRIMARY KEY,reporter TEXT NOT NULL,target TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ambassador_reports_owner ON ambassador_reports(reporter,created_at);
CREATE INDEX IF NOT EXISTS ambassador_reports_expiry ON ambassador_reports(expires_at);
CREATE TABLE IF NOT EXISTS ambassador_restrictions (owner TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS community_deletion_fences (owner TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,recovery_token TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ambassador_report_limits (owner TEXT PRIMARY KEY,day INTEGER NOT NULL,used INTEGER NOT NULL CHECK(used BETWEEN 1 AND 5),expires_at INTEGER NOT NULL);


-- Classification quotations are derived only from the exact stored public OFF
-- snapshot. They never contain an uploaded photo, diary item or user correction.
CREATE TABLE IF NOT EXISTS catalogue_score_evidence (
 barcode TEXT PRIMARY KEY REFERENCES catalogue_products(barcode) ON DELETE CASCADE,
 source_fingerprint TEXT NOT NULL,
 facts_fingerprint TEXT NOT NULL,
 score_method TEXT NOT NULL,
 score_version TEXT NOT NULL,
 classifier_version TEXT NOT NULL,
 evidence_version TEXT NOT NULL,
 classification_json TEXT NOT NULL,
 score_json TEXT NOT NULL,
 rating_value INTEGER NOT NULL CHECK(rating_value BETWEEN 0 AND 100),
 calculated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS catalogue_womens_food_tags (
  barcode TEXT PRIMARY KEY REFERENCES catalogue_products(barcode) ON DELETE CASCADE,
  rule_version TEXT NOT NULL,
  source_revision INTEGER,
  tags_json TEXT NOT NULL,
  tagged_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS catalogue_womens_tag_version ON catalogue_womens_food_tags(rule_version,barcode);
CREATE TABLE IF NOT EXISTS catalogue_womens_food_contexts (
  barcode TEXT NOT NULL REFERENCES catalogue_womens_food_tags(barcode) ON DELETE CASCADE,
  context TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  PRIMARY KEY(barcode,context)
);
CREATE INDEX IF NOT EXISTS catalogue_womens_context_lookup ON catalogue_womens_food_contexts(context,rule_version,barcode);
-- Image enrichment must not invalidate a nutrition/identity projection or
-- compete with it by rewriting the product. A changed food snapshot does.
CREATE TRIGGER IF NOT EXISTS catalogue_womens_facts_changed
AFTER UPDATE OF provider_json,source_revision ON catalogue_products
WHEN OLD.source_revision IS NOT NEW.source_revision OR
  json_remove(OLD.provider_json,'$.image_url','$.image_front_url','$.image_front_small_url','$.selected_images')
  IS NOT json_remove(NEW.provider_json,'$.image_url','$.image_front_url','$.image_front_small_url','$.selected_images')
BEGIN
  DELETE FROM catalogue_womens_food_contexts WHERE barcode=NEW.barcode;
  DELETE FROM catalogue_womens_food_tags WHERE barcode=NEW.barcode;
END;

-- Public product demand only: no user IDs, queries, photos, voice or diary data.
CREATE TABLE IF NOT EXISTS catalogue_enrichment_jobs (
 id TEXT PRIMARY KEY, barcode TEXT NOT NULL REFERENCES catalogue_products(barcode) ON DELETE CASCADE,
 source_fingerprint TEXT NOT NULL, evidence_version TEXT NOT NULL,
 score_method TEXT NOT NULL, score_version TEXT NOT NULL, classifier_version TEXT NOT NULL,
 priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 3), demand_count INTEGER NOT NULL DEFAULT 1,
 pilot_selected INTEGER NOT NULL DEFAULT 0 CHECK(pilot_selected IN(0,1)),
 status TEXT NOT NULL CHECK(status IN('pending','running','retryable','deferred','succeeded','unresolved','exhausted','stale')),
 attempts INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER, lease_token TEXT, lease_until INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_requested_at INTEGER NOT NULL,
 completed_at INTEGER, error_code TEXT,
 UNIQUE(barcode,source_fingerprint,evidence_version,score_method,score_version,classifier_version)
);
CREATE INDEX IF NOT EXISTS catalogue_enrichment_queue ON catalogue_enrichment_jobs(evidence_version,status,priority DESC,demand_count DESC,next_retry_at,created_at);
CREATE INDEX IF NOT EXISTS catalogue_enrichment_leases ON catalogue_enrichment_jobs(status,lease_until);
CREATE INDEX IF NOT EXISTS catalogue_enrichment_pilot_budget ON catalogue_enrichment_jobs(evidence_version,pilot_selected);
-- Additive metadata preserves legacy queue identity and the original pilot cap.
CREATE TABLE IF NOT EXISTS catalogue_enrichment_priority_metadata (
 job_id TEXT PRIMARY KEY REFERENCES catalogue_enrichment_jobs(id) ON DELETE CASCADE,
 off_unique_scans INTEGER NOT NULL DEFAULT 0 CHECK(off_unique_scans BETWEEN 0 AND 2147483647),
 recovery_selected INTEGER NOT NULL DEFAULT 0 CHECK(recovery_selected IN(0,1))
);
CREATE TABLE IF NOT EXISTS catalogue_enrichment_pilots (
 evidence_version TEXT PRIMARY KEY, cursor TEXT NOT NULL DEFAULT '', scanned INTEGER NOT NULL DEFAULT 0,
 finished INTEGER NOT NULL DEFAULT 0 CHECK(finished IN(0,1)), updated_at INTEGER NOT NULL
);
-- Canonical evaluator output survives an unresolved attempt so category/source
-- learnings and missing-data diagnostics are retained without a fabricated score.
CREATE TABLE IF NOT EXISTS catalogue_enrichment_observations (
 job_id TEXT PRIMARY KEY REFERENCES catalogue_enrichment_jobs(id) ON DELETE CASCADE,
 outcome TEXT NOT NULL CHECK(outcome IN('pending','enriched','estimated','unresolved','unsupported','already_rated')),
 evidence_json TEXT, missing_inputs_json TEXT NOT NULL DEFAULT '[]', evaluated_at INTEGER NOT NULL
);
-- Score evidence is a separate, expiring projection of an exact public source.
-- It never replaces OFF facts, nutrition, images, retrieval dates or diary data.
CREATE TABLE IF NOT EXISTS catalogue_enrichment_scores (
 barcode TEXT PRIMARY KEY REFERENCES catalogue_products(barcode) ON DELETE CASCADE,
 source_fingerprint TEXT NOT NULL, source_fetched_at INTEGER NOT NULL,
 evidence_version TEXT NOT NULL, score_method TEXT NOT NULL, score_version TEXT NOT NULL,
 classifier_version TEXT NOT NULL, evidence_json TEXT NOT NULL, score_json TEXT NOT NULL,
 rating_value INTEGER NOT NULL CHECK(rating_value BETWEEN 0 AND 100),
 calculated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS catalogue_enrichment_score_expiry ON catalogue_enrichment_scores(expires_at);
CREATE INDEX IF NOT EXISTS catalogue_discovery_sources ON catalogue_products(barcode,source_fingerprint);
CREATE TABLE IF NOT EXISTS catalogue_discovery (
 barcode TEXT PRIMARY KEY REFERENCES catalogue_products(barcode) ON DELETE CASCADE,
 source_fingerprint TEXT NOT NULL, rule_version TEXT NOT NULL, evidence_json TEXT NOT NULL, evaluated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS catalogue_discovery_binding ON catalogue_discovery(barcode,rule_version,source_fingerprint);
CREATE INDEX IF NOT EXISTS catalogue_discovery_version ON catalogue_discovery(rule_version,barcode);
CREATE TABLE IF NOT EXISTS catalogue_discovery_filters (
 barcode TEXT NOT NULL REFERENCES catalogue_products(barcode) ON DELETE CASCADE,
 kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(barcode,kind,value)
);
CREATE INDEX IF NOT EXISTS catalogue_discovery_filter_lookup ON catalogue_discovery_filters(kind,value,barcode);
CREATE TABLE IF NOT EXISTS catalogue_places (
 barcode TEXT PRIMARY KEY REFERENCES catalogue_products(barcode) ON DELETE CASCADE,
 source_fingerprint TEXT NOT NULL, rule_version TEXT NOT NULL, evidence_json TEXT NOT NULL, evaluated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS catalogue_place_binding ON catalogue_places(barcode,rule_version,source_fingerprint);
CREATE INDEX IF NOT EXISTS catalogue_place_version ON catalogue_places(rule_version,barcode);
CREATE TABLE IF NOT EXISTS catalogue_place_memberships (
 barcode TEXT NOT NULL REFERENCES catalogue_products(barcode) ON DELETE CASCADE,
 place_id TEXT NOT NULL, relation TEXT NOT NULL CHECK(relation IN ('brand','retailer','title_candidate')),
 confidence TEXT NOT NULL CHECK(confidence IN ('source_metadata','candidate')),
 PRIMARY KEY(barcode,place_id,relation)
);
CREATE INDEX IF NOT EXISTS catalogue_place_lookup ON catalogue_place_memberships(place_id,relation,confidence,barcode);

CREATE TABLE IF NOT EXISTS catalogue_scoring_runs (
 id TEXT PRIMARY KEY, score_method TEXT NOT NULL, score_version TEXT NOT NULL, classifier_version TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('running','paused','review','activating','activated','rolling_back','rolled_back')),
 target INTEGER NOT NULL CHECK(target IN(500,10000)), pilot_review_json TEXT, activation_review_json TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active_ms INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT, lease_until INTEGER, selection_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalogue_scoring_run_items (
 run_id TEXT NOT NULL REFERENCES catalogue_scoring_runs(id) ON DELETE CASCADE,
 barcode TEXT NOT NULL, stratum TEXT NOT NULL, cohort INTEGER NOT NULL CHECK(cohort IN(500,10000)),
 selected_fingerprint TEXT NOT NULL, selected_fetched_at INTEGER NOT NULL,
 before_score_json TEXT NOT NULL, before_rating INTEGER, before_method TEXT NOT NULL, before_version TEXT NOT NULL,
 before_classifier TEXT NOT NULL, before_calculated_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','scored','insufficient','error','source_changed')),
 result_json TEXT, result_rating INTEGER, missing_json TEXT NOT NULL DEFAULT '[]', error_code TEXT,
 evaluated_at INTEGER, elapsed_ms REAL NOT NULL DEFAULT 0,
 activation_state TEXT NOT NULL DEFAULT 'pending' CHECK(activation_state IN('pending','applied','source_changed','conflict','rolled_back','rollback_conflict')),
 PRIMARY KEY(run_id,barcode)
);
CREATE INDEX IF NOT EXISTS catalogue_scoring_run_queue ON catalogue_scoring_run_items(run_id,state,cohort,barcode);
CREATE INDEX IF NOT EXISTS catalogue_scoring_run_activation ON catalogue_scoring_run_items(run_id,activation_state,barcode);

CREATE TABLE IF NOT EXISTS catalogue_scoring_run_holds (
 run_id TEXT NOT NULL, barcode TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
 source_fetched_at INTEGER NOT NULL, candidate_json TEXT NOT NULL, hold_json TEXT NOT NULL,
 PRIMARY KEY(run_id,barcode)
);
CREATE TABLE IF NOT EXISTS catalogue_quality_holds (
 barcode TEXT NOT NULL, source_fingerprint TEXT NOT NULL, run_id TEXT NOT NULL,
 hold_json TEXT NOT NULL, score_json TEXT NOT NULL, activated_at INTEGER NOT NULL,
 PRIMARY KEY(barcode,source_fingerprint)
);
CREATE TABLE IF NOT EXISTS catalogue_quality_hold_guards (
 token TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1)
);
