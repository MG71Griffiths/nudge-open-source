import {AISLES,DIETARY_IDS,NUTRITION_IDS,DISCOVERY_VERSION} from './catalogue-discovery.js';
import {discoveryStatements,discoveryStatus,discoveryEvidence} from './catalogue-discovery-index.js';
import {PLACE_IDS,PLACE_VERSION,publicPlace} from './catalogue-places.js';
import {placeStatements,placeIndexStatus,placeEvidence} from './catalogue-place-index.js';
import { productThumbnailCandidates } from './product-images.js';
import { catalogueRecordFromPayload, validCatalogueBarcode, publicCatalogueImageURL } from './food-catalogue.js';
import { ScoreCore } from './nutrition-core.js';
import { stableStringify, scorePackagedProduct } from './product-score.js';
import { reviewedCatalogueBatch, refreshReviewedProducts, compatibleReviewedReplacement } from './reviewed-catalogue.js';
import { CATALOGUE_SCORE_EVIDENCE_VERSION } from './catalogue-score-evidence.js';
import { WOMENS_FOOD_TAG_VERSION, WOMENS_FOOD_CONTEXTS } from './womens-food-tags.js';
import { womensFoodTagStatements, womensFoodTagStatus, catalogueWomensFoodTags } from './womens-food-tag-index.js';
import { ENRICHMENT_VERSION, currentEnrichmentScore, hasEnrichedScore } from './catalogue-enrichment-store.js';
import { activeQualityHoldSQL, applyActiveQualityHoldStatement, publicCatalogueQualityHoldMatches } from './catalogue-quality-hold.js';

export const INDEX_VERSION = 'nudge-catalogue-index-v1';
export const INDEX_MAX_IMPORT_BYTES = 1_500_000;
export const INDEX_MAX_IMPORT_PRODUCTS = 200;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const allowed = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const stores = {
  tesco:['tesco'],sainsburys:['sainsburys','sainsbury'],asda:['asda'],morrisons:['morrisons','morrison'],
  aldi:['aldi'],lidl:['lidl'],waitrose:['waitrose'],marksAndSpencer:['marksandspencer','marksspencer','mands','ms'],
  coOp:['coop','cooperative','thecooperative'],ocado:['ocado'],iceland:['iceland'],
  farmfoods:['farmfoods'],heronFoods:['heronfoods'],booths:['booths','boothssupermarkets'],
  budgens:['budgens'],spar:['spar'],boots:['boots','bootsuk']
};
const storeKey = value => String(value || '').replace(/^en:/i,'').toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]/g,'');
const synonyms = {yogurt:'yoghurt',yogurts:'yoghurt',yoghurts:'yoghurt',bean:'beans',garbanzo:'chickpeas',garbanzos:'chickpeas',chickpea:'chickpeas',houmous:'hummus',zucchini:'courgette',eggplant:'aubergine',soy:'soya'};
export class CatalogueIndexError extends Error {
  constructor(message = 'Invalid catalogue request.', status = 400, code = 'catalogue_request_invalid') {
    super(message); this.status=status; this.code=code;
  }
}
export function normalizeCatalogueText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).map(word=>synonyms[word]||word).join(' ');
}
function sourceURL(value) {
  try {
    const url = new URL(value);
    if(url.protocol!=='https:'||url.username||url.password)throw new Error();
    if(!['static.openfoodfacts.org','world.openfoodfacts.org','mirabelle.openfoodfacts.org','huggingface.co'].includes(url.hostname))throw new Error();
    if(url.hostname==='huggingface.co'&&!url.pathname.startsWith('/datasets/openfoodfacts/'))throw new Error();
    return url.href;
  } catch { throw new CatalogueIndexError('An official Open Food Facts export source is required.'); }
}
function timestamp(value, now) {
  if(!Number.isSafeInteger(value)||value<=0||value>now+60_000||value<now-30*86_400_000)throw new CatalogueIndexError('A recent export retrieval date is required.');
  return value;
}
export async function buildCatalogueRow(raw, {fetchedAt, source, now=Date.now(), allowBarcodeOnly=false}={}) {
  timestamp(fetchedAt,now); const importSource=sourceURL(source);
  const p=object(raw?.product)?raw.product:raw;
  if(!object(p)||!validCatalogueBarcode(p.code))throw new CatalogueIndexError('Invalid public product barcode.');
  if(p.last_modified_t!=null&&(!Number.isSafeInteger(p.last_modified_t)||p.last_modified_t<0||p.last_modified_t>Math.floor(now/1000)))throw new CatalogueIndexError('Invalid source modification date.');
  const record=catalogueRecordFromPayload({status:'success',product:{...p,code:String(p.code)}},String(p.code),fetchedAt);
  const isUK=record.product.countriesTags.includes('en:united-kingdom');
  if(!isUK&&!allowBarcodeOnly)throw new CatalogueIndexError('Only explicitly UK-listed products are imported.',422,'catalogue_not_uk');
  const product=record.providerPayload.product;
  const score=scorePackagedProduct(record.product);
  const sourceFingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stableStringify(product)))),byte=>byte.toString(16).padStart(2,'0')).join('');
  const retailerValues=[...(Array.isArray(product.stores_tags)?product.stores_tags:[]),...(Array.isArray(product.stores)?product.stores:String(product.stores||'').split(','))].map(storeKey);
  const filters=[...Object.entries(stores).filter(([,names])=>names.some(name=>retailerValues.includes(name))).map(([value])=>({kind:'store',value})),
    ...(record.product.categoriesTags||[]).filter(value=>/^en:[a-z0-9-]{1,100}$/.test(value)).map(value=>({kind:'category',value}))];
  const name=record.product.name, brand=record.product.brand||'';
  const searchText=normalizeCatalogueText([name,brand,...record.product.categoriesTags.map(tag=>tag.replace(/^en:/,''))].join(' '));
  const ratingValue=score.available&&Number.isInteger(score.value)?score.value:null;
  return {barcode:record.barcode,name,brand,name_sort:normalizeCatalogueText(name),search_text:searchText,is_uk:isUK?1:0,
    provider_json:JSON.stringify(product),source_revision:record.sourceUpdatedAt,source_fingerprint:sourceFingerprint,
    fetched_at:fetchedAt,expires_at:record.expiresAt,source_url:record.product.sourceURL,licence_url:record.licenceURL,
    import_source_url:importSource,score_json:JSON.stringify(score),rating_value:ratingValue,score_method:ScoreCore.SCORE_METHOD,
    score_version:ScoreCore.SCORE_VERSION,classifier_version:ScoreCore.CLASSIFIER_VERSION,calculated_at:now,filters};
}
const columns=['barcode','name','brand','name_sort','search_text','is_uk','provider_json','source_revision','source_fingerprint',
  'fetched_at','expires_at','source_url','licence_url','import_source_url','score_json','rating_value','score_method','score_version','classifier_version','calculated_at'];
export function catalogueWriteStatements(row) {
  const values=columns.map(key=>row[key]);
  const ownership='EXISTS(SELECT 1 FROM catalogue_products p WHERE p.barcode=? AND p.source_fingerprint=? AND p.fetched_at=?)';
  const identity=[row.barcode,row.source_fingerprint,row.fetched_at];
  return [
    {sql:`INSERT INTO catalogue_products (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')}) ON CONFLICT(barcode) DO UPDATE SET ${columns.filter(key=>key!=='barcode').map(key=>`${key}=excluded.${key}`).join(',')} WHERE excluded.fetched_at >= catalogue_products.fetched_at AND (catalogue_products.source_revision IS NULL OR excluded.source_revision >= catalogue_products.source_revision)`,values},
    {sql:`DELETE FROM catalogue_filters WHERE barcode=? AND ${ownership}`,values:[row.barcode,...identity]},
    {sql:`INSERT OR IGNORE INTO catalogue_filters(barcode,kind,value) SELECT ?,json_extract(value,'$.kind'),json_extract(value,'$.value') FROM json_each(?) WHERE ${ownership}`,values:[row.barcode,JSON.stringify(row.filters),...identity]},
    {sql:`DELETE FROM catalogue_enrichment_scores WHERE barcode=? AND (source_fingerprint!=? OR evidence_version!=? OR score_method!=? OR score_version!=? OR classifier_version!=? OR expires_at<=?) AND ${ownership}`,values:[row.barcode,row.source_fingerprint,ENRICHMENT_VERSION,row.score_method,row.score_version,row.classifier_version,row.calculated_at,...identity]},
    // Exact unchanged public facts can retain a validated category quotation
    // across source refresh. Changed facts or engine revisions invalidate it.
    {sql:`UPDATE catalogue_products SET (score_json,rating_value,score_method,score_version,classifier_version,calculated_at)=(SELECT score_json,rating_value,score_method,score_version,classifier_version,max(calculated_at,?) FROM catalogue_score_evidence WHERE barcode=? AND source_fingerprint=? AND score_method=? AND score_version=? AND classifier_version=? AND evidence_version=?) WHERE barcode=? AND source_fingerprint=? AND fetched_at=? AND EXISTS(SELECT 1 FROM catalogue_score_evidence WHERE barcode=? AND source_fingerprint=? AND score_method=? AND score_version=? AND classifier_version=? AND evidence_version=?)`,values:[row.fetched_at,row.barcode,row.source_fingerprint,row.score_method,row.score_version,row.classifier_version,CATALOGUE_SCORE_EVIDENCE_VERSION,...identity,row.barcode,row.source_fingerprint,row.score_method,row.score_version,row.classifier_version,CATALOGUE_SCORE_EVIDENCE_VERSION]}
    ,{sql:`UPDATE catalogue_products SET (score_json,rating_value,score_method,score_version,classifier_version,calculated_at)=(SELECT score_json,rating_value,score_method,score_version,classifier_version,max(calculated_at,?) FROM catalogue_enrichment_scores WHERE barcode=? AND source_fingerprint=? AND evidence_version=? AND score_method=? AND score_version=? AND classifier_version=? AND expires_at>?) WHERE barcode=? AND source_fingerprint=? AND fetched_at=? AND EXISTS(SELECT 1 FROM catalogue_enrichment_scores WHERE barcode=? AND source_fingerprint=? AND evidence_version=? AND score_method=? AND score_version=? AND classifier_version=? AND expires_at>?)`,
      values:[row.calculated_at,row.barcode,row.source_fingerprint,ENRICHMENT_VERSION,row.score_method,row.score_version,row.classifier_version,row.calculated_at,...identity,row.barcode,row.source_fingerprint,ENRICHMENT_VERSION,row.score_method,row.score_version,row.classifier_version,row.calculated_at]}
  ].concat(womensFoodTagStatements(row,{now:row.calculated_at}),discoveryStatements(row),placeStatements(row),
    activeQualityHoldSQL({barcode:row.barcode,sourceFingerprint:row.source_fingerprint,fetchedAt:row.fetched_at}));
}
export async function importCatalogue(db, body, {now=Date.now()}={}) {
  if(!allowed(body,['products','sourceURL','fetchedAt','importID'])||!Array.isArray(body.products)||!body.products.length||body.products.length>INDEX_MAX_IMPORT_PRODUCTS)throw new CatalogueIndexError();
  timestamp(body.fetchedAt,now); const source=sourceURL(body.sourceURL),rows=[];
  let skipped=0;
  for(const product of body.products) {
    try { rows.push(await buildCatalogueRow(product,{fetchedAt:body.fetchedAt,source,now})); }
    catch(error) { if(error.code==='catalogue_not_uk')skipped++;else throw error; }
  }
  const statements=rows.flatMap(catalogueWriteStatements).map(({sql,values})=>db.prepare(sql).bind(...values));
  const id=typeof body.importID==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(body.importID)?body.importID:crypto.randomUUID();
  statements.push(db.prepare('INSERT OR REPLACE INTO catalogue_imports(id,source_url,fetched_at,imported_at,product_count,status) VALUES (?,?,?,?,?,?)').bind(id,source,body.fetchedAt,now,rows.length,'complete'));
  await db.batch(statements);
  return {version:INDEX_VERSION,importID:id,accepted:rows.length,skipped,calculatedAt:now};
}
// Internal service-binding route only. An authenticated barcode lookup fetches
// the public record itself; clients cannot publish arbitrary facts here. Missing
// or foreign country tags affect discovery, never retention of an exact scan.
export async function retainCatalogueProduct(db,body,{now=Date.now()}={}) {
  if(!allowed(body,['product','sourceURL','fetchedAt'])||!object(body.product))throw new CatalogueIndexError();
  const p=object(body.product.product)?body.product.product:body.product;
  if(!validCatalogueBarcode(p.code)||body.sourceURL!==`https://world.openfoodfacts.org/product/${p.code}`)throw new CatalogueIndexError('An exact public product source is required.');
  const row=await buildCatalogueRow(body.product,{fetchedAt:body.fetchedAt,source:body.sourceURL,now,allowBarcodeOnly:true});
  await db.batch(catalogueWriteStatements(row).map(({sql,values})=>db.prepare(sql).bind(...values)));
  return {version:INDEX_VERSION,barcode:row.barcode,retained:true};
}
export async function patchCatalogueImages(db,body,{now=Date.now()}={}) {
  if(!allowed(body,['records','sourceURL','retrievedAt'])||!Array.isArray(body.records)||!body.records.length||body.records.length>1000)throw new CatalogueIndexError();
  timestamp(body.retrievedAt,now);const source=sourceURL(body.sourceURL);
  const fields={imageURL:'image_url',imageFrontURL:'image_front_url',imageFrontSmallURL:'image_front_small_url'},seen=new Set();
  const records=body.records.map(record=>{
    if(!allowed(record,['barcode','sourceRevision',...Object.keys(fields)])||!validCatalogueBarcode(record.barcode)||seen.has(record.barcode)
      ||!Number.isSafeInteger(record.sourceRevision)||record.sourceRevision<0||record.sourceRevision>Math.floor(now/1000))throw new CatalogueIndexError('Invalid image patch identity.');
    seen.add(record.barcode);const images={};
    for(const [input,field] of Object.entries(fields))if(record[input]!=null){const url=publicCatalogueImageURL(record[input]);if(!url)throw new CatalogueIndexError('Only public Open Food Facts image URLs are accepted.');images[field]=url;}
    if(!Object.keys(images).length)throw new CatalogueIndexError('A public image URL is required.');
    return {barcode:record.barcode,revision:record.sourceRevision,images};
  });
  const result={received:records.length,updated:0,unchanged:0,missing:0,revisionMismatch:0,conflicts:0,oversized:0};
  // Bound hydrated evidence and update statements, even for the 1,000-row feed.
  for(let offset=0;offset<records.length;offset+=50){
    const chunk=records.slice(offset,offset+50);
    const found=await db.prepare('SELECT barcode,provider_json,source_revision,source_fingerprint,score_json,fetched_at FROM catalogue_products WHERE barcode IN (SELECT value FROM json_each(?))').bind(JSON.stringify(chunk.map(r=>r.barcode))).all();
    const rows=new Map((found.results||[]).map(row=>[row.barcode,row])),statements=[],updates=[];
    for(const record of chunk){
      const old=rows.get(record.barcode);if(!old){result.missing++;continue;}
      if(old.source_revision!==record.revision){result.revisionMismatch++;continue;}
      // An image-only update cannot repair reviewed nutrition or identity.
      // Keep the held raw snapshot intact until a source-facts refresh; other
      // image records continue normally through the bounded import.
      if(publicCatalogueQualityHoldMatches(JSON.parse(old.score_json),{barcode:old.barcode,sourceFingerprint:old.source_fingerprint})){
        result.unchanged++;continue;
      }
      const product=JSON.parse(old.provider_json),added={};
      for(const [field,url] of Object.entries(record.images))if(!publicCatalogueImageURL(product[field])){product[field]=url;added[field]=url;}
      if(!Object.keys(added).length){result.unchanged++;continue;}
      const providerJSON=JSON.stringify(product);
      if(new TextEncoder().encode(JSON.stringify({status:'success',code:record.barcode,product})).length>60_000){result.oversized++;continue;}
      const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stableStringify(product)))),byte=>byte.toString(16).padStart(2,'0')).join('');
      updates.push(statements.length);
      // Image-only additions do not change discovery claims; carry their binding
      // forward atomically, avoiding a full nutrition reindex during image warming.
      statements.push(db.prepare('UPDATE catalogue_products SET provider_json=?,source_fingerprint=? WHERE barcode=? AND source_revision=? AND source_fingerprint=? AND NOT EXISTS(SELECT 1 FROM catalogue_quality_holds h WHERE h.barcode=catalogue_products.barcode AND h.source_fingerprint=catalogue_products.source_fingerprint) RETURNING barcode').bind(providerJSON,fingerprint,record.barcode,record.revision,old.source_fingerprint));
      statements.push(db.prepare('UPDATE catalogue_discovery SET source_fingerprint=? WHERE barcode=? AND source_fingerprint=? AND EXISTS(SELECT 1 FROM catalogue_products WHERE barcode=? AND source_fingerprint=?)').bind(fingerprint,record.barcode,old.source_fingerprint,record.barcode,fingerprint));
      statements.push(db.prepare('UPDATE catalogue_places SET source_fingerprint=? WHERE barcode=? AND source_fingerprint=? AND EXISTS(SELECT 1 FROM catalogue_products WHERE barcode=? AND source_fingerprint=?)').bind(fingerprint,record.barcode,old.source_fingerprint,record.barcode,fingerprint));
      if(hasEnrichedScore(old)){
        const facts=catalogueRecordFromPayload({product},record.barcode,old.fetched_at).product,score=scorePackagedProduct(facts);
        statements.push(db.prepare('UPDATE catalogue_products SET score_json=?,rating_value=?,score_method=?,score_version=?,classifier_version=?,calculated_at=? WHERE barcode=? AND source_fingerprint=?').bind(JSON.stringify(score),score.available?score.value:null,ScoreCore.SCORE_METHOD,ScoreCore.SCORE_VERSION,ScoreCore.CLASSIFIER_VERSION,now,record.barcode,fingerprint));
        statements.push(db.prepare('DELETE FROM catalogue_enrichment_scores WHERE barcode=? AND source_fingerprint=? AND EXISTS(SELECT 1 FROM catalogue_products WHERE barcode=? AND source_fingerprint=?)').bind(record.barcode,old.source_fingerprint,record.barcode,fingerprint));
      }
      for(const [field,url] of Object.entries(added))statements.push(db.prepare(`INSERT INTO catalogue_image_sources(barcode,field,source_revision,source_url,retrieved_at,image_url) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM catalogue_products WHERE barcode=? AND source_revision=? AND source_fingerprint=?) ON CONFLICT(barcode,field) DO UPDATE SET source_revision=excluded.source_revision,source_url=excluded.source_url,retrieved_at=excluded.retrieved_at,image_url=excluded.image_url`).bind(record.barcode,field,record.revision,source,body.retrievedAt,url,record.barcode,record.revision,fingerprint));
    }
    if(statements.length){const completed=await db.batch(statements);for(const index of updates)if(completed[index]?.results?.length)result.updated++;else result.conflicts++;}
  }
  return result;
}
export function validateCatalogueSearch(body) {
  if(!allowed(body,['query','prefixMatch','includeCoverage','categoryTags','market','store','placeID','page','pageSize','sort','minimumRating','supportContext','aisle','dietary','nutrition','nutritionMode']))throw new CatalogueIndexError();
  const query=body.query??'',tags=body.categoryTags??[],market=body.market??'unitedKingdom',store=body.store??null;
  const page=body.page??1,pageSize=body.pageSize??20,sort=body.sort??'relevance';
  if(typeof query!=='string'||query.length>80||/[\x00-\x1f]/.test(query)||!Array.isArray(tags)||tags.length>4||tags.some(tag=>typeof tag!=='string'||!/^en:[a-z0-9-]{1,100}$/.test(tag))
    ||!['unitedKingdom','allCountries'].includes(market)||store!==null&&!Object.hasOwn(stores,store)||market==='allCountries'&&store!==null
    ||body.placeID!=null&&!PLACE_IDS.includes(body.placeID)
    ||Object.hasOwn(body,'prefixMatch')&&typeof body.prefixMatch!=='boolean'
    ||Object.hasOwn(body,'includeCoverage')&&typeof body.includeCoverage!=='boolean'
    ||!Number.isInteger(page)||page<1||page>500||!Number.isInteger(pageSize)||pageSize<1||pageSize>20
    ||!['relevance','ratingHighest','ratingLowest','nameAscending','nameDescending'].includes(sort)
    ||body.minimumRating!=null&&(!Number.isInteger(body.minimumRating)||body.minimumRating<0||body.minimumRating>100))throw new CatalogueIndexError();
  if(body.aisle!=null&&!Object.hasOwn(AISLES,body.aisle)||body.dietary!=null&&(!Array.isArray(body.dietary)||body.dietary.length>8||body.dietary.some(v=>!DIETARY_IDS.includes(v)))||body.nutrition!=null&&(!Array.isArray(body.nutrition)||body.nutrition.length>7||body.nutrition.some(v=>!NUTRITION_IDS.includes(v)))||body.nutritionMode!=null&&!['any','all'].includes(body.nutritionMode))throw new CatalogueIndexError();
  const words=normalizeCatalogueText(query).split(' ').filter(Boolean);
  if(words.length>12||query.trim()&&words.join('').length<2||body.supportContext!=null&&!WOMENS_FOOD_CONTEXTS.includes(body.supportContext))throw new CatalogueIndexError();
  return {placeID:body.placeID??null,aisle:body.aisle??null,dietary:[...new Set(body.dietary||[])],nutrition:[...new Set(body.nutrition||[])],nutritionMode:body.nutritionMode||'any',query,words,prefixMatch:body.prefixMatch===true,includeCoverage:body.includeCoverage!==false,categoryTags:[...new Set(tags)],market,store,page,pageSize,sort,minimumRating:body.minimumRating??null,supportContext:body.supportContext??null};
}
export function catalogueSearchSQL(body, now=Date.now()) {
  // This discovery index is a UK subset in both market modes. Exact barcode
  // fallback records without UK evidence remain reusable via batch/lookup only.
  const q=validateCatalogueSearch(body),where=['p.is_uk=1'],values=[];
  const filtered=Boolean(q.placeID||q.aisle||q.dietary.length||q.nutrition.length||q.categoryTags.length||q.store||q.supportContext);
  let from='catalogue_products p'+(filtered&&!q.words.length?' INDEXED BY catalogue_search_candidates':'');
  if(q.words.length) {
    // Start with the text matches. An ordinary JOIN lets SQLite run FTS once
    // per rating-qualified product, turning a selective search into thousands
    // of repeated text queries when a minimum rating is selected.
    from='catalogue_fts CROSS JOIN catalogue_products p ON catalogue_fts.rowid=p.rowid';
    // Live typing may leave the final word incomplete. Only normalized,
    // quoted tokens enter MATCH; punctuation cannot inject FTS operators.
    where.push('catalogue_fts MATCH ?'); values.push(q.words.map((word,index)=>`"${word}"${q.prefixMatch&&index===q.words.length-1?'*':''}`).join(' AND '));
  }
  if(q.store){where.push("p.barcode IN(SELECT barcode FROM catalogue_filters WHERE kind='store' AND value=?)");values.push(q.store);}
  if(q.placeID){
    where.push("p.barcode IN(SELECT barcode FROM catalogue_place_memberships WHERE place_id=? AND confidence='source_metadata' AND relation IN('brand','retailer'))");values.push(q.placeID);
    where.push('EXISTS(SELECT 1 FROM catalogue_places a INDEXED BY catalogue_place_binding WHERE a.barcode=p.barcode AND a.source_fingerprint=p.source_fingerprint AND a.rule_version=?)');values.push(PLACE_VERSION);
  }
  if(q.categoryTags.length){where.push(`p.barcode IN(SELECT barcode FROM catalogue_filters WHERE kind='category' AND value IN (${q.categoryTags.map(()=>'?').join(',')}))`);values.push(...q.categoryTags);}
  const discoveryFilters=q.aisle||q.dietary.length||q.nutrition.length;
  if(discoveryFilters){where.push('EXISTS(SELECT 1 FROM catalogue_discovery d INDEXED BY catalogue_discovery_binding WHERE d.barcode=p.barcode AND d.source_fingerprint=p.source_fingerprint AND d.rule_version=?)');values.push(DISCOVERY_VERSION);}
  const member=(kind,items,all=false)=>{if(!items.length)return;where.push(all
    ? 'p.barcode IN(SELECT barcode FROM catalogue_discovery_filters WHERE kind=? AND value IN(SELECT value FROM json_each(?)) GROUP BY barcode HAVING count(*)=?)'
    : 'p.barcode IN(SELECT barcode FROM catalogue_discovery_filters WHERE kind=? AND value IN(SELECT value FROM json_each(?)))');values.push(kind,JSON.stringify(items),...(all?[items.length]:[]));};
  member('aisle',q.aisle?[q.aisle]:[]);member('dietary_supported',q.dietary,true);member('nutrition_supported',q.nutrition,q.nutritionMode==='all');
  if(q.supportContext){where.push('p.barcode IN(SELECT barcode FROM catalogue_womens_food_contexts WHERE context=? AND rule_version=?)');values.push(q.supportContext,WOMENS_FOOD_TAG_VERSION);}
  // Stale scoring versions can remain as facts until cron recalculates them,
  // but they must not influence rating filters/order or become numeric zeroes.
  // Publishing a new direct calculation preserves the earlier factual overlay
  // for audit/replay. Its old revision must not hide that independent score.
  // Only dependency-bearing live publications remain constrained by the old
  // overlay. Inspect JSON for this small overlay set, not the full catalogue,
  // so rating selection still uses its covering index before wide hydration.
  const current=`p.score_method=? AND p.score_version=? AND p.classifier_version=? AND p.barcode NOT IN(
    SELECT e.barcode FROM catalogue_enrichment_scores e CROSS JOIN catalogue_products ep ON ep.barcode=e.barcode
    WHERE (e.evidence_version!=? OR e.score_method!=? OR e.score_version!=? OR e.classifier_version!=? OR e.expires_at<=?)
    AND (json_type(ep.score_json,'$.catalogueEnrichment') IS NOT NULL OR json_extract(ep.score_json,'$.catalogueEvidenceReplay.reused')=1))`;
  const versions=[ScoreCore.SCORE_METHOD,ScoreCore.SCORE_VERSION,ScoreCore.CLASSIFIER_VERSION,ENRICHMENT_VERSION,ScoreCore.SCORE_METHOD,ScoreCore.SCORE_VERSION,ScoreCore.CLASSIFIER_VERSION,now];
  if(q.minimumRating!==null){where.push(current+' AND p.rating_value>=?');values.push(...versions,q.minimumRating);}
  let order;
  if(q.sort.startsWith('rating')) {
    order=`CASE WHEN ${current} THEN p.rating_value ELSE NULL END IS NULL, CASE WHEN ${current} THEN p.rating_value ELSE NULL END ${q.sort==='ratingHighest'?'DESC':'ASC'}, p.name_sort,p.barcode`;
  } else if(q.sort==='nameDescending')order='p.name_sort DESC,p.barcode';
  else if(q.sort==='nameAscending')order='p.name_sort,p.barcode';
  else order=q.words.length?'bm25(catalogue_fts),p.name_sort,p.barcode':'p.name_sort,p.barcode';
  const base=`FROM ${from} WHERE ${where.join(' AND ')}`;
  const sortValues=q.sort.startsWith('rating')?[...versions,...versions]:[];
  let rows={sql:`SELECT p.* ${base} ORDER BY ${order} LIMIT ? OFFSET ?`,values:[...values,...sortValues,q.pageSize,(q.page-1)*q.pageSize]};
  if(q.sort.startsWith('rating')||filtered&&!q.words.length) {
    // Global rating order, version checks and pagination operate on a covering
    // index. Otherwise SQLite visits large evidence JSON in every matching row
    // just to discover the best twenty, which exceeds the app's read deadline.
    // IN + LIMIT prevents flattening the candidate page into the wide fetch.
    const candidateBase=q.words.length||filtered?base:`FROM catalogue_products p INDEXED BY catalogue_rating_candidates WHERE ${where.join(' AND ')}`;
    rows={sql:`SELECT p.* FROM catalogue_products p WHERE p.rowid IN (SELECT p.rowid ${candidateBase} ORDER BY ${order} LIMIT ? OFFSET ?) ORDER BY ${order}`,
      values:[...values,...sortValues,q.pageSize,(q.page-1)*q.pageSize,...sortValues]};
  }
  if(q.sort==='relevance'&&!q.words.length) {
    // Browsing has no text relevance signal. Lead with the current Nudge score
    // across the entire matching category, not alphabetical first-page rows.
    // Spread identical normalized names only within an equal-score tier. Pack
    // sizes/brands remain discoverable and no lower score jumps a higher one.
    // Window ranking uses narrow indexed candidates; hydrate only this page.
    const browseBase=filtered?base:`FROM catalogue_products p INDEXED BY catalogue_rating_candidates WHERE ${where.join(' AND ')}`;
    const browseOrder='browse_rating IS NULL,browse_rating DESC,variant_rank,name_sort,barcode';
    const offset=(q.page-1)*q.pageSize,prefix=offset+q.pageSize;
    // If the highest score has enough distinct names for this page, its first
    // variants are exactly the prefix of the full ranking. Walk the existing
    // ordered rating index only until that prefix is full. Resolve source
    // binding through its existing narrow index, never wide product payloads.
    // Sparse categories, later variants and score-tier boundaries retain the
    // complete window ranking below; no candidates are truncated or omitted.
    const rankedBase=browseBase.replace(/INDEXED BY catalogue_(?:search|rating)_candidates/,'INDEXED BY catalogue_rating_candidates')
      .replaceAll('p.source_fingerprint','(SELECT binding.source_fingerprint FROM catalogue_products binding INDEXED BY catalogue_discovery_sources WHERE binding.barcode=p.barcode)');
    rows={sql:`WITH best_rating AS MATERIALIZED (
      SELECT p.rating_value ${rankedBase} AND ${current} AND p.rating_value IS NOT NULL ORDER BY p.rating_value DESC LIMIT 1
    ), first_names AS MATERIALIZED (
      SELECT min(p.barcode) AS barcode,p.name_sort ${rankedBase} AND ${current} AND p.rating_value=(SELECT rating_value FROM best_rating)
      GROUP BY p.name_sort ORDER BY p.name_sort LIMIT ?
    ), fast_page AS (
      SELECT p.rowid AS product_rowid,(SELECT rating_value FROM best_rating) AS browse_rating,1 AS variant_rank,n.name_sort,n.barcode
      FROM first_names n CROSS JOIN catalogue_products p ON p.barcode=n.barcode
      WHERE (SELECT count(*) FROM first_names)=? ORDER BY n.name_sort,n.barcode LIMIT ? OFFSET ?
    ), score_candidates AS (
      SELECT p.rowid AS product_rowid,p.name_sort,p.barcode,CASE WHEN ${current} THEN p.rating_value ELSE NULL END AS browse_rating ${browseBase}
      AND (SELECT count(*) FROM first_names)<?
    ), varied_candidates AS (
      SELECT *,row_number() OVER(PARTITION BY browse_rating,name_sort ORDER BY barcode) AS variant_rank FROM score_candidates
    ), slow_page AS (
      SELECT product_rowid,browse_rating,variant_rank,name_sort,barcode FROM varied_candidates ORDER BY ${browseOrder} LIMIT ? OFFSET ?
    ), page_candidates AS (
      SELECT * FROM fast_page UNION ALL SELECT * FROM slow_page
    ) SELECT p.* FROM page_candidates c CROSS JOIN catalogue_products p ON p.rowid=c.product_rowid
      ORDER BY c.browse_rating IS NULL,c.browse_rating DESC,c.variant_rank,c.name_sort,c.barcode`,
      values:[...values,...versions,...values,...versions,prefix,prefix,q.pageSize,offset,
        ...versions,...values,prefix,q.pageSize,offset]};
  }
  return {query:q,rows,count:{sql:`SELECT count(*) AS total ${base}`,values}};
}
function currentRatingRow(row,now) {
  const stored=JSON.parse(row.score_json);
  if(publicCatalogueQualityHoldMatches(stored,{barcode:row.barcode,sourceFingerprint:row.source_fingerprint}))return row;
  if(row.score_method===ScoreCore.SCORE_METHOD&&row.score_version===ScoreCore.SCORE_VERSION&&row.classifier_version===ScoreCore.CLASSIFIER_VERSION
    &&(!hasEnrichedScore(row)||currentEnrichmentScore(row,{now})))return row;
  // Only this bounded result page is calculated during reads. Global sorting
  // and rating filters continue excluding stale indexed values until the
  // dedicated retained-facts backfill has persisted their new values.
  const product=catalogueRecordFromPayload({product:JSON.parse(row.provider_json)},row.barcode,row.fetched_at).product;
  const score=scorePackagedProduct(product);
  return {...row,score_json:JSON.stringify(score),rating_value:score.available?score.value:null,
    score_method:ScoreCore.SCORE_METHOD,score_version:ScoreCore.SCORE_VERSION,classifier_version:ScoreCore.CLASSIFIER_VERSION,calculated_at:now};
}
function envelope(rows, {now=Date.now(),page=1,total=rows.length,pageSize=20}={}) {
  rows=rows.map(row=>currentRatingRow(row,now));
  return {version:INDEX_VERSION,products:rows.map(row=>JSON.parse(row.provider_json)),ratings:rows.map(row=>({barcode:row.barcode,
    method:row.score_method,version:row.score_version,classifierVersion:row.classifier_version,sourceRevision:row.source_revision,
    sourceFingerprint:row.source_fingerprint,fetchedAt:row.fetched_at,expiresAt:row.expires_at,calculatedAt:row.calculated_at,freshness:row.expires_at<=now?'stale':'current',discoveryScope:row.is_uk===1?'uk_discovery':'barcode_only',
    score:JSON.parse(row.score_json)})),page,total,hasMore:page*pageSize<total,
    catalogue:{source:'Nudge catalogue',coverage:'imported_uk_subset',complete:false,generatedAt:now,freshness:rows.some(row=>row.expires_at<=now)?'stale':'current',
      attribution:'Contains information from Open Food Facts, made available under the Open Database License (ODbL).',
      sourceURL:'https://world.openfoodfacts.org',licenceURL:'https://opendatacommons.org/licenses/odbl/1-0/',exportPath:'/v1/catalogue/export'}};
}
export async function searchCatalogue(db,body,{now=Date.now(),coverage=null}={}) {
  const plan=catalogueSearchSQL(body,now);
  const queries=[db.prepare(plan.count.sql).bind(...plan.count.values),db.prepare(plan.rows.sql).bind(...plan.rows.values)];
  if(plan.query.dietary.length){
    const base=catalogueSearchSQL({...body,dietary:[]},now).count,chosen=JSON.stringify(plan.query.dietary);
    const current='EXISTS(SELECT 1 FROM catalogue_discovery d INDEXED BY catalogue_discovery_binding WHERE d.barcode=p.barcode AND d.source_fingerprint=p.source_fingerprint AND d.rule_version=?)';
    const conflict=current+" AND p.barcode IN(SELECT barcode FROM catalogue_discovery_filters WHERE kind='dietary_conflicting' AND value IN(SELECT value FROM json_each(?)))";
    queries.push(db.prepare(base.sql+' AND ('+conflict+')').bind(...base.values,DISCOVERY_VERSION,chosen));
    // For selected dietary requirements, every product is either fully
    // supported, explicitly conflicting, or unconfirmed. These states cannot
    // overlap, so subtraction avoids another expensive per-product join.
    queries.push(db.prepare(base.sql).bind(...base.values));
  }
  // Aggregate coverage is independent of the selected page. Start it alongside
  // the atomic count/page read, then hydrate the page's independent evidence
  // together. Keep all source binding and exclusion checks in their queries.
  const readPage=async()=>{
    const [count,result,conflicting,unfiltered]=await db.batch(queries),rows=result.results||[],codes=rows.map(row=>row.barcode);
    const [places,discovery,supportTags]=await Promise.all([placeEvidence(db,codes),discoveryEvidence(db,codes),catalogueWomensFoodTags(db,codes)]);
    return {count,rows,conflicting,unfiltered,places,discovery,supportTags};
  };
  const readCoverage=async()=>{
    // Coverage is a catalogue-wide census, not evidence for the selected page.
    // Interactive callers can omit these optional totals without skipping any
    // source-bound filter or per-product evidence check. Unknown stays null.
    if(!plan.query.includeCoverage)return {places:null,discovery:null,support:null};
    const cached=typeof coverage==='function'?await coverage():coverage;
    const [places,discovery,support]=await Promise.all([cached?.places??placeIndexStatus(db),cached?.discovery??discoveryStatus(db),cached?.support??womensFoodTagStatus(db)]);
    return {places,discovery,support};
  };
  const [page,status]=await Promise.all([readPage(),readCoverage()]);
  const {count,rows,conflicting,unfiltered}=page,excludedDietary=plan.query.dietary.length?{conflicting:Number(conflicting?.results?.[0]?.total)||0,unconfirmed:Math.max(0,(Number(unfiltered?.results?.[0]?.total)||0)-(Number(count.results?.[0]?.total)||0)-(Number(conflicting?.results?.[0]?.total)||0))}:null;
  // Older native decoders serialize present coverage values as JSON objects.
  // Omit an unrequested census rather than sending null; missing still means
  // unknown, while page evidence and exclusion counts retain their contract.
  const includesCoverage=plan.query.includeCoverage;
  return {...envelope(rows,{now,page:plan.query.page,pageSize:plan.query.pageSize,total:Number(count.results?.[0]?.total)||0}),
    places:{selected:publicPlace(plan.query.placeID),...(includesCoverage?{coverage:status.places}:{}),evidence:page.places},
    discovery:{excludedDietary,...(includesCoverage?{coverage:status.discovery}:{}),evidence:page.discovery},...(includesCoverage?{support:status.support}:{}),supportTags:page.supportTags};
}
export async function batchCatalogue(db,body,{now=Date.now(),includeReviewed=true}={}) {
  if(!allowed(body,['codes'])||!Array.isArray(body.codes)||!body.codes.length||body.codes.length>20||body.codes.some(code=>!validCatalogueBarcode(code)))throw new CatalogueIndexError();
  const codes=[...new Set(body.codes)];
  const result=await db.prepare(`SELECT * FROM catalogue_products WHERE barcode IN (${codes.map(()=>'?').join(',')})`).bind(...codes).all();
  const rows=(result.results||[]).sort((a,b)=>codes.indexOf(a.barcode)-codes.indexOf(b.barcode));
  const reviewed=includeReviewed===false?{products:[],ratings:[]}:await reviewedCatalogueBatch(db,codes,{now});
  const community={products:[],ratings:[]};
  for(const product of reviewed.products){
    const meta=reviewed.ratings.find(r=>r.barcode===product.code),off=rows.find(row=>row.barcode===product.code);
    if(!off||compatibleReviewedReplacement(off,product,meta,{now})){community.products.push(product);community.ratings.push(meta);}
  }
  const selectedRows=rows.filter(row=>!community.products.some(p=>p.code===row.barcode));
  const response=envelope(selectedRows,{now}),products=[...response.products,...community.products],ratings=[...response.ratings,...community.ratings];
  products.sort((a,b)=>codes.indexOf(a.code)-codes.indexOf(b.code));ratings.sort((a,b)=>codes.indexOf(a.barcode)-codes.indexOf(b.barcode));
  const catalogue={...response.catalogue,freshness:ratings.some(row=>row.freshness==='stale')?'stale':'current'};
  if(community.products.length){
    catalogue.additionalSource={sourceKind:'nudge_community',attribution:'Nudge community product facts reviewed against packaging photos.',licenceURL:null};
    if(!selectedRows.length)Object.assign(catalogue,{coverage:'reviewed_product_subset',attribution:catalogue.additionalSource.attribution,licenceURL:null,sourceURL:community.ratings[0].sourceURL,exportPath:'/v1/catalogue/reviewed-export'});
  }
  return {...response,products,ratings,total:products.length,hasMore:false,catalogue,missing:codes.filter(code=>!products.some(row=>row.code===code)),
    supportTags:await catalogueWomensFoodTags(db,selectedRows.map(row=>row.barcode))};
}
export async function exportCatalogue(db,url,{now=Date.now()}={}) {
  if([...url.searchParams.keys()].some(key=>!['after','limit'].includes(key)))throw new CatalogueIndexError();
  const after=url.searchParams.get('after')||'',limit=Number(url.searchParams.get('limit')||50);
  if(after&&!validCatalogueBarcode(after)||!Number.isInteger(limit)||limit<1||limit>100)throw new CatalogueIndexError();
  const result=await db.prepare('SELECT * FROM catalogue_products WHERE barcode>? ORDER BY barcode LIMIT ?').bind(after,limit+1).all();
  const rows=(result.results||[]).slice(0,limit),more=(result.results||[]).length>limit;
  const imageSources=rows.length?(await db.prepare('SELECT * FROM catalogue_image_sources WHERE barcode IN (SELECT value FROM json_each(?))').bind(JSON.stringify(rows.map(row=>row.barcode))).all()).results||[]:[];
  return {...envelope(rows,{now,pageSize:limit}),hasMore:more,nextAfter:more?rows.at(-1).barcode:null,
    supportTags:await catalogueWomensFoodTags(db,rows.map(row=>row.barcode)),
    sources:rows.map(row=>({barcode:row.barcode,sourceURL:row.source_url,importSourceURL:row.import_source_url,fetchedAt:row.fetched_at,licenceURL:row.licence_url,
      imageSources:imageSources.filter(image=>image.barcode===row.barcode&&image.source_revision===row.source_revision&&JSON.parse(row.provider_json)[image.field]===image.image_url).map(image=>({field:image.field,sourceURL:image.source_url,sourceRevision:image.source_revision,retrievedAt:image.retrieved_at,imageURL:image.image_url}))}))};
}
// Project only image fields: prewarming 179k thumbnails must not hydrate or
// recompute nutrition, scores, search filters or contribution records.
const imageProjection = `barcode,json_extract(provider_json,'$.lc') AS lc,
  json_extract(provider_json,'$.selected_images.front') AS selected_front_json,
  json_extract(provider_json,'$.image_front_small_url') AS image_front_small_url,
  json_extract(provider_json,'$.image_front_url') AS image_front_url,
  json_extract(provider_json,'$.image_url') AS image_url`;
function rowThumbnails(row) {
  let front = null;
  try { front = JSON.parse(row.selected_front_json || 'null'); } catch { /* A missing image never blocks manifest pagination. */ }
  return productThumbnailCandidates({...row, selected_images: {front}}).filter(image => image.barcode === row.barcode);
}
export async function catalogueImageSource(db, url) {
  if ([...url.searchParams.keys()].some(key => key !== 'barcode') || url.searchParams.getAll('barcode').length !== 1
    || !validCatalogueBarcode(url.searchParams.get('barcode'))) throw new CatalogueIndexError();
  const row = await db.prepare(`SELECT ${imageProjection} FROM catalogue_products WHERE barcode=?`).bind(url.searchParams.get('barcode')).first();
  return {images: row ? rowThumbnails(row) : []};
}
export async function catalogueImageManifest(db, url) {
  if ([...url.searchParams.keys()].some(key => !['after', 'limit'].includes(key))
    || url.searchParams.getAll('after').length > 1 || url.searchParams.getAll('limit').length > 1) throw new CatalogueIndexError();
  const after = url.searchParams.get('after') || '', limit = Number(url.searchParams.get('limit') || 500);
  if (after && !validCatalogueBarcode(after) || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new CatalogueIndexError();
  const result = await db.prepare(`SELECT ${imageProjection} FROM catalogue_products WHERE barcode>? ORDER BY barcode LIMIT ?`).bind(after, limit + 1).all();
  const rows = (result.results || []).slice(0, limit), hasMore = (result.results || []).length > limit;
  return {images: rows.map(row => rowThumbnails(row)[0]).filter(Boolean), scanned: rows.length,
    hasMore, nextAfter: hasMore ? rows.at(-1).barcode : null};
}
export async function queueCatalogueImport(db,body,{now=Date.now()}={}) {
  if(!allowed(body,['objectKey','sourceURL','fetchedAt'])||typeof body.objectKey!=='string'||!/^off-exports\/[a-zA-Z0-9_/-]{1,160}\.json$/.test(body.objectKey)||body.objectKey.includes('..'))throw new CatalogueIndexError();
  const source=sourceURL(body.sourceURL);timestamp(body.fetchedAt,now);
  await db.prepare("INSERT INTO catalogue_import_queue(object_key,source_url,fetched_at,queued_at,status) VALUES (?,?,?,?,'pending') ON CONFLICT(object_key) DO NOTHING").bind(body.objectKey,source,body.fetchedAt,now).run();
  return {queued:true};
}
export async function refreshCatalogue(env,{now=Date.now()}={}) {
  const db=env.FOOD_CATALOGUE_DB;if(!db)return;
  if(env.SCORING_AUTO_REFRESH!=='false')await recalculateCatalogue(db,{}, {now});
  if(!env.FOOD_CATALOGUE_EXPORTS)return;
  const job=await db.prepare("SELECT * FROM catalogue_import_queue WHERE status='pending' OR (status='running' AND queued_at<?) ORDER BY queued_at LIMIT 1").bind(now-3_600_000).first();
  if(!job)return;
  await db.prepare("UPDATE catalogue_import_queue SET status='running',queued_at=? WHERE object_key=?").bind(now,job.object_key).run();
  try {
    const item=await env.FOOD_CATALOGUE_EXPORTS.get(job.object_key);
    if(!item||item.size>INDEX_MAX_IMPORT_BYTES)throw new Error('Missing or oversized import chunk');
    const body=JSON.parse(await item.text());
    await importCatalogue(db,{products:body.products,sourceURL:job.source_url,fetchedAt:job.fetched_at},{now});
    await db.prepare("UPDATE catalogue_import_queue SET status='complete',processed_at=? WHERE object_key=?").bind(now,job.object_key).run();
  } catch {
    await db.prepare("UPDATE catalogue_import_queue SET status='failed',processed_at=? WHERE object_key=?").bind(now,job.object_key).run();
  }
}
export async function recalculateCatalogue(db,body={}, {now=Date.now()}={}) {
  if(!allowed(body,['statusOnly'])||body.statusOnly!=null&&typeof body.statusOnly!=='boolean')throw new CatalogueIndexError();
  const reviewedUpdated=body.statusOnly?0:await refreshReviewedProducts(db,{now});
  // Recompute old algorithm revisions from retained public facts. Never extend
  // source freshness, relabel a stale source, or replace source photos/facts.
  const outdated='score_method!=? OR score_version!=? OR classifier_version!=?',revision=[ScoreCore.SCORE_METHOD,ScoreCore.SCORE_VERSION,ScoreCore.CLASSIFIER_VERSION];
  const result=body.statusOnly?{results:[]}:await db.prepare(`SELECT barcode,provider_json,fetched_at,source_fingerprint FROM catalogue_products WHERE rowid IN(SELECT rowid FROM catalogue_products INDEXED BY catalogue_rating_candidates WHERE ${outdated} LIMIT 500)`).bind(...revision).all();
  const statements=[];
  for(const old of result.results||[]) {
    const record=catalogueRecordFromPayload({product:JSON.parse(old.provider_json)},old.barcode,old.fetched_at),score=scorePackagedProduct(record.product);
    const ratingValue=score.available&&Number.isInteger(score.value)?score.value:null;
    statements.push(db.prepare('UPDATE catalogue_products SET score_json=?,rating_value=?,score_method=?,score_version=?,classifier_version=?,calculated_at=? WHERE barcode=? AND source_fingerprint=? AND fetched_at=? RETURNING barcode').bind(JSON.stringify(score),ratingValue,...revision,now,old.barcode,old.source_fingerprint,old.fetched_at));
    statements.push(db.prepare('DELETE FROM catalogue_enrichment_scores WHERE barcode=? AND EXISTS(SELECT 1 FROM catalogue_products WHERE barcode=? AND source_fingerprint=? AND fetched_at=? AND score_method=? AND score_version=? AND classifier_version=?)').bind(old.barcode,old.barcode,old.source_fingerprint,old.fetched_at,...revision));
    statements.push(applyActiveQualityHoldStatement(db,{barcode:old.barcode,sourceFingerprint:old.source_fingerprint,fetchedAt:old.fetched_at}));
  }
  const writes=statements.length?await db.batch(statements):[];
  const remaining=await db.prepare(`SELECT (SELECT count(*) FROM catalogue_products WHERE ${outdated})+(SELECT count(*) FROM reviewed_products WHERE ${outdated}) AS n`).bind(...revision,...revision).first();
  const total=await db.prepare('SELECT (SELECT count(*) FROM catalogue_products)+(SELECT count(*) FROM reviewed_products) AS n').first();
  let scoreCoverage;
  if(body.statusOnly){
    const coverage=await db.prepare(`WITH scores AS (SELECT rating_value,score_method,score_version,classifier_version FROM catalogue_products UNION ALL SELECT CASE WHEN json_extract(score_json,'$.available')=1 THEN json_extract(score_json,'$.value') ELSE NULL END,score_method,score_version,classifier_version FROM reviewed_products), revisions AS (SELECT rating_value,(score_method=? AND score_version=? AND classifier_version=?) AS is_current FROM scores) SELECT sum(is_current=1 AND rating_value IS NOT NULL) AS rated,sum(is_current=1 AND rating_value IS NULL) AS unrated,sum(is_current=0) AS outdated,count(*) AS total FROM revisions`).bind(...revision).first();
    scoreCoverage={currentRated:Number(coverage?.rated||0),currentUnrated:Number(coverage?.unrated||0),outdated:Number(coverage?.outdated||0),total:Number(coverage?.total||0)};
  }
  return {updated:writes.reduce((n,r)=>n+(r.results?.length||0),0)+(reviewedUpdated||0),remaining:Number(remaining?.n||0),
    total:Number(total?.n||0),complete:Number(remaining?.n||0)===0,method:ScoreCore.SCORE_METHOD,version:ScoreCore.SCORE_VERSION,classifierVersion:ScoreCore.CLASSIFIER_VERSION,...(scoreCoverage?{scoreCoverage}:{})};
}
