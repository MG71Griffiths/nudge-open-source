import {DISCOVERY_VERSION,evaluateDiscovery} from './catalogue-discovery.js';
export const discoverySchema=String.raw`CREATE INDEX IF NOT EXISTS catalogue_discovery_sources ON catalogue_products(barcode,source_fingerprint);
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
`;
export function discoveryStatements(row){
 const evidence=evaluateDiscovery(JSON.parse(row.provider_json),{fetchedAt:row.fetched_at}),filters=evidence.aisles.map(value=>({kind:'aisle',value}));
 for(const [id,item]of Object.entries(evidence.dietary))filters.push({kind:'dietary_'+item.state,value:id});
 for(const [id,item]of Object.entries(evidence.nutrition))filters.push({kind:'nutrition_'+item.state,value:id});
 const guard='EXISTS(SELECT 1 FROM catalogue_products WHERE barcode=? AND source_fingerprint=? AND fetched_at=?)',args=[row.barcode,row.source_fingerprint,row.fetched_at];
 return [
 {sql:`INSERT INTO catalogue_discovery(barcode,source_fingerprint,rule_version,evidence_json,evaluated_at) SELECT ?,?,?,?,? WHERE ${guard} ON CONFLICT(barcode) DO UPDATE SET source_fingerprint=excluded.source_fingerprint,rule_version=excluded.rule_version,evidence_json=excluded.evidence_json,evaluated_at=excluded.evaluated_at`,values:[row.barcode,row.source_fingerprint,DISCOVERY_VERSION,JSON.stringify(evidence),row.calculated_at,...args]},
 {sql:`DELETE FROM catalogue_discovery_filters WHERE barcode=? AND ${guard}`,values:[row.barcode,...args]},
 {sql:`INSERT INTO catalogue_discovery_filters(barcode,kind,value) SELECT ?,json_extract(value,'$.kind'),json_extract(value,'$.value') FROM json_each(?) WHERE ${guard}`,values:[row.barcode,JSON.stringify(filters),...args]}
 ];
}
export async function discoveryStatus(db){
 const row=await db.prepare('SELECT count(*) AS total,sum(CASE WHEN d.rule_version=? AND d.source_fingerprint=p.source_fingerprint THEN 1 ELSE 0 END) AS processed FROM catalogue_products p INDEXED BY catalogue_discovery_sources LEFT JOIN catalogue_discovery d INDEXED BY catalogue_discovery_binding ON d.barcode=p.barcode').bind(DISCOVERY_VERSION).first();
 const total=Number(row?.total||0),processed=Number(row?.processed||0);return {version:DISCOVERY_VERSION,total,processed,complete:total===processed};
}
export async function reindexDiscovery(db,body={}, {now=Date.now()}={}){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['limit','statusOnly'].includes(k))||body.limit!=null&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>500)||body.statusOnly!=null&&typeof body.statusOnly!=='boolean')throw Object.assign(new Error('Invalid discovery index request'),{status:400,code:'catalogue_request_invalid'});
 if(body.statusOnly)return discoveryStatus(db);
 const rows=(await db.prepare('SELECT p.* FROM catalogue_products p WHERE p.barcode IN(SELECT p.barcode FROM catalogue_products p INDEXED BY catalogue_discovery_sources LEFT JOIN catalogue_discovery d INDEXED BY catalogue_discovery_binding ON d.barcode=p.barcode WHERE d.rule_version IS NULL OR d.rule_version!=? OR d.source_fingerprint!=p.source_fingerprint ORDER BY p.barcode LIMIT ?) ORDER BY p.barcode').bind(DISCOVERY_VERSION,body.limit||200).all()).results||[];
 if(rows.length)await db.batch(rows.flatMap(row=>discoveryStatements({...row,calculated_at:now})).map(s=>db.prepare(s.sql).bind(...s.values)));
 return {version:DISCOVERY_VERSION,processed:rows.length,hasMore:rows.length===(body.limit||200)};
}
export async function discoveryEvidence(db,barcodes){
 if(!barcodes.length)return[];
 const rows=(await db.prepare('SELECT d.barcode,d.evidence_json FROM catalogue_discovery d JOIN catalogue_products p ON p.barcode=d.barcode AND p.source_fingerprint=d.source_fingerprint WHERE d.rule_version=? AND d.barcode IN(SELECT value FROM json_each(?))').bind(DISCOVERY_VERSION,JSON.stringify(barcodes)).all()).results||[];
 return rows.map(r=>({barcode:r.barcode,...JSON.parse(r.evidence_json)}));
}
