export const catalogueEnrichmentSchema=`
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
`;
