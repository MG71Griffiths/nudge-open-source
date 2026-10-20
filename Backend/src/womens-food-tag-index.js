import { classifyWomensFoodTags, WOMENS_FOOD_TAG_VERSION } from './womens-food-tags.js';

// The guard makes every write conditional on the exact public snapshot read.
// This is separate from image bytes/URLs, food facts, score and source freshness.
export function womensFoodTagStatements(row, {now=Date.now()}={}) {
  const tags = classifyWomensFoodTags(JSON.parse(row.provider_json));
  const contexts = [...new Set(tags.flatMap(tag=>tag.contexts))];
  const owns = 'EXISTS(SELECT 1 FROM catalogue_products WHERE barcode=? AND source_fingerprint=?)';
  const identity = [row.barcode,row.source_fingerprint];
  return [
    {sql:`DELETE FROM catalogue_womens_food_contexts WHERE barcode=? AND ${owns}`,values:[row.barcode,...identity]},
    {sql:`INSERT INTO catalogue_womens_food_tags(barcode,rule_version,source_revision,tags_json,tagged_at) SELECT ?,?,?,?,? WHERE ${owns} ON CONFLICT(barcode) DO UPDATE SET rule_version=excluded.rule_version,source_revision=excluded.source_revision,tags_json=excluded.tags_json,tagged_at=excluded.tagged_at`,values:[row.barcode,WOMENS_FOOD_TAG_VERSION,row.source_revision,JSON.stringify(tags),now,...identity]},
    {sql:`INSERT INTO catalogue_womens_food_contexts(barcode,context,rule_version) SELECT ?,value,? FROM json_each(?) WHERE ${owns}`,values:[row.barcode,WOMENS_FOOD_TAG_VERSION,JSON.stringify(contexts),...identity]}
  ];
}

export async function womensFoodTagStatus(db,{details=false}={}) {
  const counts=await db.prepare('SELECT (SELECT count(*) FROM catalogue_products) AS total,(SELECT count(*) FROM catalogue_womens_food_tags WHERE rule_version=?) AS processed').bind(WOMENS_FOOD_TAG_VERSION).first();
  const total=Number(counts?.total||0),processed=Number(counts?.processed||0);
  const result={version:WOMENS_FOOD_TAG_VERSION,total,processed,complete:processed===total};
  if(details){
    result.tagged=Number((await db.prepare("SELECT count(*) AS n FROM catalogue_womens_food_tags WHERE rule_version=? AND tags_json!='[]'").bind(WOMENS_FOOD_TAG_VERSION).first())?.n||0);
    result.contexts=(await db.prepare('SELECT context,count(*) AS products FROM catalogue_womens_food_contexts WHERE rule_version=? GROUP BY context ORDER BY context').bind(WOMENS_FOOD_TAG_VERSION).all()).results||[];
  }
  return result;
}

export async function catalogueWomensFoodTags(db,codes) {
  if(!codes.length)return [];
  const rows=(await db.prepare('SELECT barcode,tags_json FROM catalogue_womens_food_tags WHERE rule_version=? AND barcode IN(SELECT value FROM json_each(?))').bind(WOMENS_FOOD_TAG_VERSION,JSON.stringify(codes)).all()).results||[];
  return rows.map(row=>({barcode:row.barcode,tags:JSON.parse(row.tags_json)}));
}

// A caller-owned, resumable cursor, bounded to at most 250 product reads. This
// does not use or move the contribution/image runner's alarm, or call OFF/AI.
export async function backfillWomensFoodTags(db,{after='',limit=100,statusOnly=false}={}, {now=Date.now()}={}) {
  if(statusOnly)return womensFoodTagStatus(db,{details:true});
  const rows=(await db.prepare(`SELECT p.barcode,p.provider_json,p.source_revision,p.source_fingerprint FROM catalogue_products p LEFT JOIN catalogue_womens_food_tags t ON t.barcode=p.barcode AND t.rule_version=? WHERE p.barcode>? AND t.barcode IS NULL ORDER BY p.barcode LIMIT ?`).bind(WOMENS_FOOD_TAG_VERSION,after,limit+1).all()).results||[];
  const batch=rows.slice(0,limit),statements=batch.flatMap(row=>womensFoodTagStatements(row,{now}));
  if(statements.length)await db.batch(statements.map(({sql,values})=>db.prepare(sql).bind(...values)));
  const updated=batch.length?(await catalogueWomensFoodTags(db,batch.map(row=>row.barcode))).length:0;
  return {version:WOMENS_FOOD_TAG_VERSION,updated,hasMore:rows.length>limit,nextAfter:batch.at(-1)?.barcode||after};
}
