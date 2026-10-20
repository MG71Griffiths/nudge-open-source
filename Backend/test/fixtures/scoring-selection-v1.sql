-- Frozen original query: equivalence oracle for the hydration optimization.
WITH aisle AS (
 SELECT f.barcode,min(f.value) AS name FROM catalogue_discovery_filters f
 JOIN catalogue_discovery d ON d.barcode=f.barcode
 JOIN catalogue_products p ON p.barcode=d.barcode AND p.source_fingerprint=d.source_fingerprint
 WHERE f.kind='aisle' GROUP BY f.barcode
), candidates AS (
 SELECT p.barcode,coalesce(a.name,'unclassified') || ':' || CASE
 WHEN p.rating_value IS NOT NULL THEN 'rated'
 WHEN lower(json_extract(p.score_json,'$.missingInputs')) LIKE '%sugar%' OR lower(json_extract(p.score_json,'$.missingInputs')) LIKE '%saturated%' OR lower(json_extract(p.score_json,'$.missingInputs')) LIKE '%salt%' THEN 'missing_adverse_nutrients'
 ELSE 'other_unrated' END AS stratum
 FROM catalogue_products p LEFT JOIN aisle a ON a.barcode=p.barcode
 WHERE p.is_uk=1 AND EXISTS(SELECT 1 FROM catalogue_scoring_runs gate WHERE gate.id=? AND gate.target=500
 AND coalesce((p.score_method=gate.score_method AND p.score_version=gate.score_version AND p.classifier_version=gate.classifier_version
  AND p.calculated_at>=p.fetched_at AND json_valid(p.score_json)
  AND json_extract(p.score_json,'$.methodId')=gate.score_method AND json_extract(p.score_json,'$.version')=gate.score_version
  AND json_extract(p.score_json,'$.classifierVersion')=gate.classifier_version
  AND ((json_extract(p.score_json,'$.available')=1 AND json_type(p.score_json,'$.rawScore')='integer'
    AND json_extract(p.score_json,'$.value')=CASE json_extract(p.score_json,'$.grade') WHEN 'A' THEN 100 WHEN 'B' THEN 75 WHEN 'C' THEN 50 WHEN 'D' THEN 25 WHEN 'E' THEN 0 END)
   OR (json_extract(p.score_json,'$.available')=0 AND json_extract(p.score_json,'$.status')='unrated'
    AND json_type(p.score_json,'$.value')='null' AND json_type(p.score_json,'$.missingInputs')='array'))),0)=0) AND NOT EXISTS(SELECT 1 FROM catalogue_scoring_run_items i WHERE i.run_id=? AND i.barcode=p.barcode)
), ranked AS (SELECT barcode,stratum,row_number() OVER(PARTITION BY stratum ORDER BY barcode) AS rank FROM candidates)
INSERT INTO catalogue_scoring_run_items(run_id,barcode,stratum,cohort,selected_fingerprint,selected_fetched_at,
 before_score_json,before_rating,before_method,before_version,before_classifier,before_calculated_at)
SELECT ?,p.barcode,r.stratum,?,p.source_fingerprint,p.fetched_at,p.score_json,p.rating_value,p.score_method,p.score_version,p.classifier_version,p.calculated_at
FROM ranked r JOIN catalogue_products p ON p.barcode=r.barcode
ORDER BY r.rank,r.stratum,r.barcode LIMIT max(0,?-(SELECT count(*) FROM catalogue_scoring_run_items WHERE run_id=?));
