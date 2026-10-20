
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
