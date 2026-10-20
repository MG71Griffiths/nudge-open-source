export const catalogueScoreEvidenceSchema=`
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
`;
