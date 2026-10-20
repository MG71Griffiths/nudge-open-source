// A catalogue of public source records, not user observations or diary entries.
// Only the Worker may call writeCatalogue through its internal Durable Object.
// Public requests supply a barcode, never a record to publish or a URL to fetch.
import { ScoreCore } from './nutrition-core.js';
export const CATALOGUE_VERSION = 'public-food-catalogue-v1';
export const CATALOGUE_TTL_MS = 30 * 86_400_000;
export const CATALOGUE_MAX_BYTES = 96_000;
export const CATALOGUE_SOURCE = 'Open Food Facts';
export class CatalogueNotFoundError extends Error {
  constructor(){super('The public source has no product for this barcode.');this.name='CatalogueNotFoundError';}
}
const RECORD_KEY = 'public-food-record';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => structuredClone(v);
const normal = v => String(v || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const text = (v, max = 240) => typeof v === 'string' && v.trim() && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) ? v.trim() : null;
const number = (v, max = 100) => (typeof v === 'number' || typeof v === 'string' && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(v)) && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max ? Number(v) : null;
export const validCatalogueBarcode = value => typeof value === 'string' && /^[0-9]{4,18}$/.test(value);
const fields = ['code','product_name','product_name_en','brands','brands_tags','quantity','product_quantity','product_quantity_unit','ingredients_text','ingredients_text_en','ingredients','ingredients_analysis_tags','allergens','allergens_tags','traces','traces_tags','nutriments','nutrition','nutrition_data_per','nutrition_data','nutrition_data_prepared','nutrition_data_prepared_per','no_nutrition_data','serving_size','serving_quantity','serving_quantity_unit','categories_tags','countries_tags','stores_tags','stores','labels_tags','unique_scans_n','last_modified_t','data_quality_errors_tags','data_quality_warnings_tags','selected_images','lc','image_front_url','image_front_small_url','image_url','image_nutrition_url','image_ingredients_url','nutriscore_grade','nutrition_grades','nutriscore','nova_group','additives_tags'];
const nutrientFields = {energyKcal:['energy-kcal'],protein:['proteins'],carbohydrate:['carbohydrates'],sugars:['sugars'],fat:['fat'],saturatedFat:['saturated-fat'],fibre:['fiber','fibre'],salt:['salt']};
const relations = new Set(['lt','lte','eq','gt','gte','approx','<','<=','≤','=','~','>','>=','≥']);
const relation = value => relations.has(value) ? value : value == null || value === '' ? null : 'approx';
const tags = value => Array.isArray(value) ? [...new Set(value.filter(v => text(v,160)))].slice(0,60) : [];
const imageURL = value => {
  if (!text(value,2048)) return null;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && /^(?:images|static)\.openfoodfacts\.org$/.test(u.hostname) ? u.href : null; } catch { return null; }
};
export const publicCatalogueImageURL = value => imageURL(value);
function cleanValue(value, depth = 0) {
  if (depth > 9) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return text(value,10_000);
  if (Array.isArray(value)) return value.slice(0,160).map(v => cleanValue(v,depth+1));
  if (!object(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([k]) => /^[a-zA-Z0-9_:%.-]{1,100}$/.test(k) && !['__proto__','constructor','prototype'].includes(k)).slice(0,180).map(([k,v]) => [k,cleanValue(v,depth+1)]));
}
function cleanImages(value, depth=0) {
  if(depth>4)return null;
  if (typeof value === 'string') return imageURL(value);
  if (!object(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([k]) => /^[a-zA-Z0-9_-]{1,30}$/.test(k)).slice(0,12).map(([k,v]) => [k,cleanImages(v,depth+1)]));
}
function safeProviderPayload(payload, barcode) {
  if (!object(payload) || payload.status === 0 || ['failure','not found','not_found'].includes(payload.status) || !object(payload.product) || String(payload.product.code || '') !== barcode) throw new Error('Catalogue product identity mismatch');
  const p = Object.fromEntries(fields.filter(k => Object.hasOwn(payload.product,k)).map(k => [k,cleanValue(payload.product[k])]));
  // OFF public popularity is queue metadata, never private scan telemetry or a scoring input.
  if(Object.hasOwn(p,'unique_scans_n')&&(!Number.isSafeInteger(p.unique_scans_n)||p.unique_scans_n<0||p.unique_scans_n>2147483647))delete p.unique_scans_n;
  p.code = barcode;
  for (const key of ['image_front_url','image_front_small_url','image_url','image_nutrition_url','image_ingredients_url']) if (key in p) p[key] = imageURL(p[key]);
  if ('selected_images' in p) p.selected_images = cleanImages(p.selected_images);
  const result = {status:'success',code:barcode,product:p};
  if (new TextEncoder().encode(JSON.stringify(result)).length > 60_000) throw new Error('Catalogue product is too large');
  return result;
}
function nutrient(item, unit, {legacy = false, modifier = null} = {}) {
  const max = unit === 'g' ? 100 : unit === 'kJ' ? 25_000 : 5_000;
  if (legacy) {
    const value = number(item,max);
    return {value,unit,status:value === null ? 'unknown' : 'supplied',...(relation(modifier) ? {relation:relation(modifier)} : {})};
  }
  if (!object(item) || String(item.unit || unit).toLowerCase() !== unit.toLowerCase()) return {value:null,unit,status:'unknown'};
  const value = number(item.value,max), computed = number(item.value_computed,max), estimated = normal(item.source) === 'estimate';
  return {value:value ?? computed,unit,status:value === null && computed === null ? 'unknown' : estimated ? 'estimated' : value === null ? 'calculated' : 'supplied',...(relation(item.modifier) ? {relation:relation(item.modifier)} : {})};
}
function ingredientItems(raw, result = [], depth = 0) {
  if (!Array.isArray(raw) || depth > 7) return result;
  for (const item of raw.slice(0,160)) {
    if (result.length >= 160) break;
    if (!object(item)) continue;
    if (Array.isArray(item.ingredients) && item.ingredients.length) { ingredientItems(item.ingredients,result,depth+1); continue; }
    const id=text(item.id,160), wording=text(item.text,400), percent=number(item.percent);
    if (id || wording) result.push({...(id?{id}:{}),...(wording?{text:wording}:{}),...(percent===null?{}:{percent})});
  }
  return result;
}
// This adapter is called only after an OFF response/export has passed the
// server's barcode and public-field boundary. A source label supplied by an app
// client is not permission to attach this result to its edited nutrition facts.
function providerNutriScore(raw, product) {
  const value=raw.nutriscore?.['2023'], yes=v=>v===true||v===1;
  if(!object(value)||!yes(value.nutriscore_computed)||!yes(value.nutriscore_applicable)
    ||!yes(value.category_available)||!yes(value.nutrients_available)
    ||!Number.isInteger(value.score)||value.score < -30||value.score>60
    ||!['a','b','c','d','e'].includes(String(value.grade).toLowerCase())
    ||!['as_sold','prepared'].includes(value.preparation)||value.preparation!==product.nutritionPreparation
    ||!object(value.data)||!object(value.data.components))return null;
  const data=value.data, flags=['is_water','is_beverage','is_cheese','is_fat_oil_nuts_seeds','is_red_meat_product'];
  if(flags.some(key=>![true,false,0,1].includes(data[key])))return null;
  if(yes(data.is_water)&&!yes(data.is_beverage))return null;
  const specific=['is_cheese','is_fat_oil_nuts_seeds','is_red_meat_product'].filter(key=>yes(data[key]));
  if(specific.length>1||specific.length&&yes(data.is_beverage))return null;
  const category=yes(data.is_water)?'water':yes(data.is_beverage)?'beverage':yes(data.is_cheese)?'cheese':yes(data.is_fat_oil_nuts_seeds)?'fats_nuts_seeds':yes(data.is_red_meat_product)?'red_meat':'general';
  const components={};
  for(const side of ['negative','positive']){
    if(!Array.isArray(data.components[side])||data.components[side].length>12)return null;
    const seen=new Set();components[side]=[];
    for(const part of data.components[side]){
      if(!object(part)||!text(part.id,60)||seen.has(part.id)||!['g','kJ','%','',...(part.id==='non_nutritive_sweeteners'?['number']:[])].includes(part.unit??'')
        ||!Number.isInteger(part.points)||part.points<0||!Number.isInteger(part.points_max)||part.points_max<0||part.points_max>30||part.points>part.points_max
        ||part.value!==null&&(!Number.isFinite(part.value)||part.value<0||part.value>25_000))return null;
      seen.add(part.id);components[side].push({id:part.id,value:part.value,unit:part.unit??'',points:part.points,pointsMax:part.points_max});
    }
  }
  if(![0,1,true,false].includes(value.estimated)||![0,1,true,false].includes(data.count_proteins)
    ||!Number.isInteger(data.negative_points)||!Number.isInteger(data.positive_points))return null;
  const result={version:'2023',grade:String(value.grade).toUpperCase(),rawScore:value.score,category,
    preparation:value.preparation,estimated:yes(value.estimated),source:CATALOGUE_SOURCE,sourceURL:product.sourceURL,
    barcode:product.barcode,computed:true,applicable:true,categoryAvailable:true,nutrientsAvailable:true,
    negativePoints:data.negative_points,positivePoints:data.positive_points,countProteins:yes(data.count_proteins),components,
    factsFingerprint:ScoreCore.providerInputFingerprint(product)};
  // Shared validation also checks points arithmetic, grade boundaries and
  // category conflicts. Corrupt or incompatible provider data stays absent.
  return ScoreCore.providerScore({...product,providerNutriScore:result})?.available?result:null;
}
function sourceFacts(payload, fetchedAt) {
  const p=payload.product, name=text(p.product_name_en)||text(p.product_name);
  if (!name) throw new Error('Catalogue food name missing');
  const set=object(p.nutrition?.aggregated_set)?p.nutrition.aggregated_set:null, per=String(set?.per||'').toLowerCase();
  const structured=['100g','100ml'].includes(per)&&object(set.nutrients)?set.nutrients:{};
  const preparedOnly=!set&&p.nutrition_data_prepared==='on'&&p.nutrition_data!=='on';
  const noNutrition=['on','true','1'].includes(String(p.no_nutrition_data).toLowerCase());
  const legacy=object(p.nutriments)?p.nutriments:{}, useLegacy=!noNutrition&&!preparedOnly&&(!set || set.preparation==='as_sold' && ['100g','100ml'].includes(per));
  const liquid=/^(ml|l|cl|dl)$/.test(String(p.product_quantity_unit||'').toLowerCase()) || /\b\d+(?:\.\d+)?\s*(?:ml|cl|litres?|liters?)\b/i.test(String(p.quantity||''));
  const legacyBasis=String(p.nutrition_data_per||'').toLowerCase().replace(/\s/g,'');
  const basisUnit=per==='100ml'?'ml':per==='100g'?'g':set||preparedOnly||noNutrition?null:legacyBasis==='100ml'?'ml':legacyBasis==='100g'?'g':liquid?'ml':'g';
  const preparation=['as_sold','prepared'].includes(set?.preparation)?set.preparation:!set&&!preparedOnly&&!noNutrition?'as_sold':null;
  const nutrients={},nutrientSources={};
  for (const [key,aliases] of Object.entries(nutrientFields)) {
    const unit=key==='energyKcal'?'kcal':'g';
    let n=aliases.map(a=>nutrient(structured[a],unit)).find(v=>v.value!==null);
    if (n) nutrientSources[key]=n.status==='estimated'?'estimate':'Open Food Facts structured nutrition';
    if (!n && useLegacy) for (const alias of aliases) {
      const candidate=nutrient(legacy[alias+'_100g'],unit,{legacy:true,modifier:legacy[alias+'_modifier']});
      if (candidate.value!==null) { n=candidate;nutrientSources[key]='Open Food Facts legacy nutriments';break; }
    }
    nutrients[key]=n||{value:null,unit,status:'unknown'};
  }
  // Sodium-to-salt is an exact unit conversion, not an estimate. Preserve the
  // raw sodium in providerPayload and identify the derived normalized field.
  // A reported salt value wins; do not mix a prepared profile with as-sold data.
  if(nutrients.salt.value===null){
    const item=structured.sodium,unit=String(item?.unit||'').toLowerCase();
    let value=null,sourceUnit='g',modifier=null;
    if(object(item)&&['g','mg'].includes(unit)&&normal(item.source)!=='estimate'){
      value=number(item.value,unit==='mg'?100_000:100);sourceUnit=unit;modifier=relation(item.modifier);
    }
    if(value===null&&useLegacy){value=number(legacy.sodium_100g);sourceUnit='g';modifier=relation(legacy.sodium_modifier);}
    const salt=value===null?null:value*2.5/(sourceUnit==='mg'?1000:1);
    if(salt!==null&&salt<=100){
      nutrients.salt={value:salt,unit:'g',status:'calculated',...(modifier?{relation:modifier}:{})};
      nutrientSources.salt=sourceUnit==='mg'?'Calculated from source sodium (mg × 2.5 ÷ 1000)':'Calculated from source sodium (g × 2.5)';
    }
  }
  let energyKj=['energy-kj','energy'].map(k=>object(structured[k])&&String(structured[k].unit).toLowerCase()==='kj'?nutrient(structured[k],'kJ'):null).find(v=>v?.value!==null&&v?.value!==undefined)||null;
  if (!energyKj && useLegacy) {
    const key=number(legacy['energy-kj_100g'],25_000)!==null?'energy-kj':String(legacy.energy_unit).toLowerCase()==='kj'?'energy':null;
    if (key) energyKj=nutrient(legacy[key+'_100g'],'kJ',{legacy:true,modifier:legacy[key+'_modifier']});
  }
  if(energyKj)nutrientSources.energyKj=energyKj.status==='estimated'?'estimate':'Open Food Facts nutrient energy';
  if (nutrients.energyKcal.value===null && energyKj?.value!==null && energyKj?.value!==undefined && energyKj.status!=='estimated') {
    nutrients.energyKcal={...energyKj,value:energyKj.value/4.184,unit:'kcal',status:'calculated'};
    nutrientSources.energyKcal='Calculated from source kilojoules (kJ ÷ 4.184)';
  }
  const categories=tags(p.categories_tags), flag=v=>v===true||v===1?true:v===false||v===0?false:null;
  const ns=p.nutriscore?.['2023'], scoringFacts={source:'Open Food Facts: supplied 2023 category flags and declared ingredient percentage'};
  if (flag(ns?.category_available)===true) for (const [key,source] of Object.entries({isBeverage:'is_beverage',isCheese:'is_cheese',isWater:'is_water',isFatOilNutsSeeds:'is_fat_oil_nuts_seeds',isRedMeatProduct:'is_red_meat_product'})) {
    const value=flag(ns?.data?.[source]);if(value!==null)scoringFacts[key]=value;
  }
  const fvl=structured['fruits-vegetables-legumes'];
  if (object(fvl)&&['packaging','manufacturer'].includes(fvl.source)&&fvl.unit==='%'&&number(fvl.value)!==null&&[null,'eq','='].includes(relation(fvl.modifier))) scoringFacts.fvlPercent={value:number(fvl.value),source:'declared',evidence:`Open Food Facts ${fvl.source}: fruits-vegetables-legumes ${number(fvl.value)}%`};
  const product={name,brand:text(p.brands,160),barcode:p.code,sourceName:CATALOGUE_SOURCE,sourceURL:`https://world.openfoodfacts.org/product/${p.code}`,retrievedAt:new Date(fetchedAt).toISOString(),basisUnit,nutritionPreparation:preparation,categories,categoriesTags:categories,countriesTags:tags(p.countries_tags),ingredients:text(p.ingredients_text_en,8000)||text(p.ingredients_text,8000),ingredientItems:ingredientItems(p.ingredients),nutrients,nutrientSources,...(energyKj?{energyKj}:{}),...(Object.keys(scoringFacts).length>1?{scoringFacts}:{})};
  const provider=providerNutriScore(p,product);if(provider)product.providerNutriScore=provider;
  return product;
}
function constructRecord(payload, barcode, now) {
  if (!validCatalogueBarcode(barcode)||!Number.isSafeInteger(now)||now<0) throw new Error('Invalid catalogue request');
  const providerPayload=safeProviderPayload(payload,barcode), product=sourceFacts(providerPayload,now);
  const record={version:CATALOGUE_VERSION,barcode,fetchedAt:now,expiresAt:now+CATALOGUE_TTL_MS,source:CATALOGUE_SOURCE,verification:'server_retrieved_public_source',sourceUpdatedAt:number(providerPayload.product.last_modified_t,1e12),licenceURL:'https://opendatacommons.org/licenses/odbl/1-0/',product,providerPayload};
  if (new TextEncoder().encode(JSON.stringify(record)).length>CATALOGUE_MAX_BYTES) throw new Error('Catalogue record is too large');
  return record;
}
// Trusted bulk-import boundary. The same public-field and image-host allowlists
// apply to official exports and direct source lookups; no observation is stored.
export function catalogueRecordFromPayload(payload, barcode, fetchedAt) {
  return constructRecord(payload, barcode, fetchedAt);
}
async function boundedJSON(response,maximum=512_000) {
  if (Number(response.headers.get('content-length'))>maximum) throw new Error('Catalogue response is too large');
  const reader=response.body?.getReader();if(!reader)throw new Error('Catalogue response is empty');
  const chunks=[];let length=0;
  try { for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>maximum){await reader.cancel();throw new Error('Catalogue response is too large');}chunks.push(value);} }
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function catalogueFetch(barcode,{signal,fetchImpl=globalThis.fetch,now=Date.now(),archive}={}) {
  if(!validCatalogueBarcode(barcode))throw new Error('Invalid catalogue barcode');
  const url=`https://world.openfoodfacts.org/api/v3.6/product/${barcode}.json?fields=${archive?'all,attribute_groups_en,attribute_groups_data,knowledge_panels&lc=en&cc=uk':fields.join(',')}`;
  const boundedSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(6_000)]):AbortSignal.timeout(6_000);
  // Workers supports manual/follow only. Manual plus an explicit 200 check
  // rejects redirects without following an untrusted Location header.
  const response=await fetchImpl(url,{method:'GET',headers:{accept:'application/json','user-agent':'Nudge/0.1 (food catalogue; https://example.invalid/nudge)'},redirect:'manual',signal:boundedSignal});
  if(response.status!==200&&response.status!==404){
    const delay=response.headers.get('retry-after'),seconds=/^[0-9]{1,6}$/.test(delay||'')?Number(delay):600;
    void response.body?.cancel().catch(()=>{});
    throw Object.assign(new Error(`Catalogue source unavailable (${response.status})`),{
      catalogueStatus:response.status,...(response.status===429?{retryAfter:Math.min(86400000,Math.max(65000,seconds*1000))}:{})});
  }
  const payload=await boundedJSON(response,archive?2_000_000:512_000);
  const absent=payload?.status===0||payload?.status==='failure'&&Array.isArray(payload.errors)&&payload.errors.some(error=>
    error?.message?.id==='product_not_found'||error?.message==='Product not found'||error?.code==='product_not_found');
  if(absent&&(!payload.code||String(payload.code)===barcode)&&!payload.product)throw new CatalogueNotFoundError();
  if(response.status!==200)throw new Error('Catalogue source returned an unverified missing-product response');
  const record=constructRecord(payload,barcode,now);
  if(archive)try{await archive(payload,{barcode,fetchedAt:now,sourceURL:url});}
  catch{console.warn(JSON.stringify({event:'off_source_archive',outcome:'write_failed'}));}
  return record;
}
export async function readCatalogue(storage,barcode,{now=Date.now()}={}) {
  if(!validCatalogueBarcode(barcode))return null;
  const record=await storage.get(RECORD_KEY);
  if(!record||record.version!==CATALOGUE_VERSION||record.barcode!==barcode||record.source!==CATALOGUE_SOURCE||record.verification!=='server_retrieved_public_source'||!Number.isSafeInteger(record.fetchedAt)||record.fetchedAt>now+60_000||record.expiresAt!==record.fetchedAt+CATALOGUE_TTL_MS||record.expiresAt<=now)return null;
  try{return constructRecord(record.providerPayload,barcode,record.fetchedAt);}catch{return null;}
}
export async function writeCatalogue(storage,record,{now=Date.now()}={}) {
  // DO-only contract: this function must never receive an external user's body.
  if(!record||record.version!==CATALOGUE_VERSION||record.source!==CATALOGUE_SOURCE||record.verification!=='server_retrieved_public_source'||!Number.isSafeInteger(record.fetchedAt)||record.fetchedAt>now+60_000||record.fetchedAt+CATALOGUE_TTL_MS<=now)throw new Error('Invalid catalogue record');
  const clean=constructRecord(record.providerPayload,record.barcode,record.fetchedAt);
  const old=await readCatalogue(storage,record.barcode,{now});
  if(old&&(old.fetchedAt>clean.fetchedAt||old.sourceUpdatedAt!==null&&clean.sourceUpdatedAt!==null&&old.sourceUpdatedAt>clean.sourceUpdatedAt))return old;
  await storage.put(RECORD_KEY,clean);return clean;
}
const prepState=p=>normal([p.name,p.ingredients,p.nutritionPreparation].filter(Boolean).join(' ')).match(/\b(drained|undrained|prepared|reconstituted|dried|dry|raw|cooked)\b/g)||[];
const variantTerms='sweetened unsweetened salted unsalted reduced low light full skimmed semi whole flavoured vanilla chocolate roasted crunchy smooth raw drained undrained'.split(' ');
export function supplementProduct(input,record) {
  const product=clone(input),source=record?.product,addedFields=[],conflicts=[];
  const fail=reason=>({product,status:'conflict',addedFields,conflicts:[reason],provenance:[]});
  if(!source||record.version!==CATALOGUE_VERSION||record.verification!=='server_retrieved_public_source'||!validCatalogueBarcode(input.barcode)||input.barcode!==record.barcode||source.barcode!==input.barcode)return fail('barcode_identity');
  const a=normal(input.brand),b=normal(source.brand);
  if(a&&(!b||!a.split(' ').every(t=>b.split(' ').includes(t))))return fail('brand_identity');
  const nameA=normal(input.name),nameB=normal(source.name);
  const significant=s=>s.split(' ').filter(w=>!['organic','the','and','a','of','in','with',...normal(input.brand).split(' ')].includes(w));
  const wa=significant(nameA),wb=significant(nameB), overlap=wa.filter(t=>wb.includes(t)).length;
  if(!overlap||overlap/Math.min(wa.length||1,wb.length||1)<.5)return fail('food_identity');
  for(const term of variantTerms)if(nameA.split(' ').includes(term)!==nameB.split(' ').includes(term))return fail('product_variant');
  if(!['g','ml'].includes(input.basisUnit)||!['g','ml'].includes(source.basisUnit)||input.basisUnit!==source.basisUnit)return fail('nutrition_basis');
  if(!['as_sold','prepared'].includes(input.nutritionPreparation)||input.nutritionPreparation!==source.nutritionPreparation)return fail('nutrition_preparation');
  const pa=prepState(input),pb=prepState(source);
  for(const term of ['drained','undrained','reconstituted','dried','dry','raw','cooked'])if(pa.includes(term)!==pb.includes(term))return fail('preparation_identity');
  product.nutrients=clone(input.nutrients||{});product.nutrientSources=clone(input.nutrientSources||{});
  const isKnown=n=>typeof n?.value==='number'&&Number.isFinite(n.value)&&n.value>=0;
  for(const key of [...Object.keys(nutrientFields),'energyKj']) {
    const old=key==='energyKj'?input.energyKj:input.nutrients?.[key],fresh=key==='energyKj'?source.energyKj:source.nutrients?.[key];
    if(isKnown(old)&&isKnown(fresh)&&fresh.status!=='estimated'&&(old.unit!==fresh.unit||Math.abs(old.value-fresh.value)>Math.max(.001,Math.abs(old.value)*.01)))conflicts.push(key);
  }
  // A source update can describe a changed recipe. Do not construct a hybrid
  // nutrition panel from contradictory old and new facts.
  if(conflicts.length)return {product:clone(input),status:'conflicting_values',addedFields:[],conflicts,provenance:[{provider:CATALOGUE_SOURCE,url:source.sourceURL,retrievedAt:source.retrievedAt,version:CATALOGUE_VERSION,fields:[]}]};
  for(const key of [...Object.keys(nutrientFields),'energyKj']) {
    const old=key==='energyKj'?input.energyKj:input.nutrients?.[key],fresh=key==='energyKj'?source.energyKj:source.nutrients?.[key];
    if(!isKnown(fresh)||fresh.status==='estimated'||!['supplied','calculated'].includes(fresh.status))continue;
    if(isKnown(old))continue;
    if(key==='energyKj')product.energyKj=clone(fresh);else product.nutrients[key]=clone(fresh);
    product.nutrientSources[key]=`Open Food Facts server lookup ${source.retrievedAt}`;addedFields.push(key);
  }
  // Existing observed ingredient wording/percentages and flags are protected.
  if(!text(input.ingredients,8000)&&source.ingredients){
    product.ingredients=source.ingredients;product.ingredientItems=clone(source.ingredientItems||[]);addedFields.push('ingredients');
    // The full wording came from the checked public source, so the shared
    // calculator may interpret its printed percentages just as on a lookup.
    // Preserve an explicit outstanding review rather than silently clearing it.
    if(input.ingredientsNeedsReview!==true)product.ingredientsNeedsReview=false;
  }
  const existingTags=[...(input.categories||[]),...(input.categoriesTags||[])],combined=[...new Set([...existingTags,...(source.categories||[])])].slice(0,60);
  if(combined.some(t=>!existingTags.includes(t))){product.categories=combined;product.categoriesTags=combined;addedFields.push('categories');}
  if(!input.scoringFacts&&source.scoringFacts){product.scoringFacts=clone(source.scoringFacts);addedFields.push('scoringFacts');}
  // Never rebind a published grade onto changed facts. The trusted result may
  // supplement only the exact same normalized public scoring snapshot.
  if(source.providerNutriScore&&ScoreCore.providerInputFingerprint(product)===source.providerNutriScore.factsFingerprint){
    product.providerNutriScore=clone(source.providerNutriScore);addedFields.push('providerNutriScore');
  }
  return {product,status:conflicts.length?'conflicting_values':addedFields.length?'supplemented':'unchanged',addedFields,conflicts,provenance:[{provider:CATALOGUE_SOURCE,url:source.sourceURL,retrievedAt:source.retrievedAt,version:CATALOGUE_VERSION,verification:'server_retrieved_public_source',licenceURL:record.licenceURL,fields:addedFields}]};
}
