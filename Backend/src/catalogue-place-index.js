import {PLACE_VERSION,PLACES,evaluatePlaces,publicPlace} from './catalogue-places.js';

export const placeSchema=String.raw`CREATE TABLE IF NOT EXISTS catalogue_places (
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
`;
export class PlaceIndexError extends Error {
 constructor(){super('Invalid place index request.');this.status=400;this.code='catalogue_request_invalid';}
}
export function placeStatements(row){
 const evidence=evaluatePlaces(JSON.parse(row.provider_json));
 const guard='EXISTS(SELECT 1 FROM catalogue_products WHERE barcode=? AND source_fingerprint=? AND fetched_at=?)',args=[row.barcode,row.source_fingerprint,row.fetched_at];
 return [
  {sql:`INSERT INTO catalogue_places(barcode,source_fingerprint,rule_version,evidence_json,evaluated_at) SELECT ?,?,?,?,? WHERE ${guard} ON CONFLICT(barcode) DO UPDATE SET source_fingerprint=excluded.source_fingerprint,rule_version=excluded.rule_version,evidence_json=excluded.evidence_json,evaluated_at=excluded.evaluated_at`,values:[row.barcode,row.source_fingerprint,PLACE_VERSION,JSON.stringify(evidence),row.calculated_at,...args]},
  {sql:`DELETE FROM catalogue_place_memberships WHERE barcode=? AND ${guard}`,values:[row.barcode,...args]},
  {sql:`INSERT INTO catalogue_place_memberships(barcode,place_id,relation,confidence) SELECT ?,json_extract(value,'$.placeID'),json_extract(value,'$.relation'),json_extract(value,'$.confidence') FROM json_each(?) WHERE ${guard}`,values:[row.barcode,JSON.stringify(evidence.associations),...args]}
 ];
}
export async function placeIndexStatus(db,{summary=false}={}){
 const row=await db.prepare('SELECT count(*) AS total,sum(CASE WHEN a.rule_version=? AND a.source_fingerprint=p.source_fingerprint THEN 1 ELSE 0 END) AS processed FROM catalogue_products p INDEXED BY catalogue_discovery_sources LEFT JOIN catalogue_places a INDEXED BY catalogue_place_binding ON a.barcode=p.barcode').bind(PLACE_VERSION).first();
 const total=Number(row?.total)||0,processed=Number(row?.processed)||0;
 const result={version:PLACE_VERSION,total,processed,complete:total===processed};
 if(summary){
  const rows=(await db.prepare("SELECT m.place_id,count(DISTINCT CASE WHEN m.confidence='source_metadata' THEN m.barcode ELSE NULL END) AS total,sum(CASE WHEN m.relation='brand' THEN 1 ELSE 0 END) AS brand,sum(CASE WHEN m.relation='retailer' THEN 1 ELSE 0 END) AS retailer,sum(CASE WHEN m.relation='title_candidate' THEN 1 ELSE 0 END) AS title_candidate FROM catalogue_place_memberships m JOIN catalogue_places a ON a.barcode=m.barcode JOIN catalogue_products p ON p.barcode=m.barcode WHERE p.is_uk=1 AND a.rule_version=? AND a.source_fingerprint=p.source_fingerprint GROUP BY m.place_id").bind(PLACE_VERSION).all()).results||[];
  result.places=PLACES.map(place=>{const found=rows.find(row=>row.place_id===place.id)||{};return {...publicPlace(place.id),total:Number(found.total)||0,brand:Number(found.brand)||0,retailer:Number(found.retailer)||0,titleCandidate:Number(found.title_candidate)||0};});
  result.summaryScope='uk_catalogue_products';
 }
 return result;
}
export async function reindexPlaces(db,body={}, {now=Date.now()}={}){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['limit','statusOnly','summary'].includes(key))||body.limit!=null&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>500)||body.statusOnly!=null&&typeof body.statusOnly!=='boolean'||body.summary!=null&&typeof body.summary!=='boolean')throw new PlaceIndexError();
 if(body.statusOnly)return placeIndexStatus(db,{summary:body.summary===true});
 const limit=body.limit||200;
 const rows=(await db.prepare('SELECT p.* FROM catalogue_products p WHERE p.barcode IN(SELECT p.barcode FROM catalogue_products p INDEXED BY catalogue_discovery_sources LEFT JOIN catalogue_places a INDEXED BY catalogue_place_binding ON a.barcode=p.barcode WHERE a.rule_version IS NULL OR a.rule_version!=? OR a.source_fingerprint!=p.source_fingerprint ORDER BY p.barcode LIMIT ?) ORDER BY p.barcode').bind(PLACE_VERSION,limit).all()).results||[];
 if(rows.length)await db.batch(rows.flatMap(row=>placeStatements({...row,calculated_at:now})).map(s=>db.prepare(s.sql).bind(...s.values)));
 return {version:PLACE_VERSION,processed:rows.length,hasMore:rows.length===limit};
}
export async function placeEvidence(db,barcodes){
 if(!barcodes.length)return[];
 const rows=(await db.prepare('SELECT a.barcode,a.source_fingerprint,a.evidence_json,a.evaluated_at FROM catalogue_places a JOIN catalogue_products p ON p.barcode=a.barcode AND p.source_fingerprint=a.source_fingerprint WHERE a.rule_version=? AND a.barcode IN(SELECT value FROM json_each(?))').bind(PLACE_VERSION,JSON.stringify(barcodes)).all()).results||[];
 return rows.map(row=>({barcode:row.barcode,sourceFingerprint:row.source_fingerprint,evaluatedAt:row.evaluated_at,...JSON.parse(row.evidence_json)}));
}
