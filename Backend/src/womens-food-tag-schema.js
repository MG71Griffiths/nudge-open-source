// Public, versioned food hypotheses. No personal stage, symptoms or outcomes.
export const womensFoodTagSchema = String.raw`
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
`;
