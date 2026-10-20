// Independent shadow results. Neither a run nor its report changes live scores.
export const catalogueScoringRunSchema = String.raw`
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
`;
