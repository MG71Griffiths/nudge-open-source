export const contributionSchema=`
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
`;
