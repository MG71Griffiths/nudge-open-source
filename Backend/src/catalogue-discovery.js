import {catalogueRecordFromPayload} from './food-catalogue.js';

// These are browse memberships, not claims about a food's nutrition or safety.
export const DISCOVERY_VERSION='food-discovery-2026-10-09-v4';
export const AISLES=Object.freeze({
 fruit:['fruits','fresh-fruits','dried-fruits'], vegetables:['vegetables','fresh-vegetables'], salad:['salads-without-dressing','salads','fresh-herbs','herbs','lettuces'],
 dairy:['dairies','milks','creams','plant-milks'], eggs:['eggs'], cheese:['cheeses'], yoghurt:['yogurts','yoghurts','plant-based-yogurts'],
 meat:['meats','poultries'],fish:['seafood','fishes','fish','shellfish'],alternatives:['meat-analogues','meat-substitutes','tofu','tempeh','vegetarian-sausages'],
 bakery:['breads','pastries','bakery-products'],ready:['meals','prepared-meals','ready-meals'],pulses:['legumes','pulses','beans','baked-beans','lentils','chickpeas'],
 pasta:['pastas','noodles'],rice:['rices','rice'],cereals:['breakfast-cereals','oat-flakes','porridge','mueslis'],nuts:['nuts','seeds','nuts-and-their-products'],
 frozen:['frozen-foods'],tins:['canned-foods','canned-vegetables','canned-legumes','canned-fishes'],snacks:['salty-snacks','crisps','chips','crackers'],
 desserts:['desserts','puddings'],icecream:['ice-creams','sorbets','frozen-desserts'],chocolate:['chocolates','candies','confectioneries','sweets'],
 sauces:['sauces','condiments','spices','cooking-helpers','oils','vinegars'],spreads:['spreads','jams','nut-butters','honeys'],baking:['flours','baking-ingredients','yeasts','baking-powders','sugars'],
 juice:['fruit-juices','fruit-nectars'],drinks:['beverages']
});
export const DIETARY_IDS=['gluten','lactose','milk','wheat','peanut','soya','vegan','vegetarian'];
export const NUTRITION_IDS=['iron','calcium','vitd','protein','fibre','highfibre','wholegrain'];
export const DISCOVERY_SOURCES={claims:'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32006R1924',references:'https://www.legislation.gov.uk/eur/2011/1169/annex/XIII'};
const strings=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'):[];
const numeric=v=>(typeof v==='number'||typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v))&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null;
const clean=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const tag=v=>String(v).replace(/^[a-z]{2}:/,'').toLowerCase();
// Only explicit source declarations count. A missing claim remains unknown.
function declaredAllergens(tags, text){
 const known=new Set(['gluten','wheat','milk','peanuts','peanut','soybeans','soya','soy']);
 const raw=String(text||'').split(/[,;]+/).map(value=>tag(value.trim()).replace(/^contains\s+/,'').trim());
 return [...strings(tags).map(tag),...raw.filter(value=>known.has(value))];
}
function ingredientParts(raw){
 return String(raw.ingredients_text_en||raw.ingredients_text||'').split(/[,;]+/).map(clean).filter(piece=>piece&&!/^(?:may contain|traces of|free from|free of|without)\b/.test(piece)).map(piece=>piece.replace(/\b(?:milk|dairy|lactose|gluten|wheat|peanut|peanuts|soya|soy|egg|eggs) free\b/g,''));
}
function animalDairy(text){
 // Plant names and cocoa/nut butter are not dairy declarations. Removing only
 // those phrases still catches a contradictory nested ingredient such as milk.
 const source=text.replace(/\b(?:coconut|almond|oat|soya|soy|rice|cashew|hemp|hazelnut|pea|plant) (?:milk|cream|yoghurt|yogurt)\b/g,'')
  .replace(/\b(?:cocoa|cacao|peanut|almond|cashew|nut|shea|coconut) butter\b/g,'')
  .replace(/\b(?:butter beans?|cream of tartar|milk thistle)\b/g,'')
  .replace(/\b(?:vegan|plant based|non dairy|dairy free) (?:milk|butter|cream|cheese|yoghurt|yogurt)\b/g,'');
 return /\b(?:milk|whey|casein|caseinate|buttermilk|butter|cream|cheese|yoghurt|yogurt)\b/.test(source);
}
function animalFlesh(text){
 const source=text.replace(/\b(?:plant based|vegan|vegetarian) (?:beef|veal|pork|bacon|ham|chicken|turkey|lamb|mutton|venison|duck|goose|meat|fish|salmon|tuna|cod|haddock|anchov(?:y|ies)|sardines?|prawns?|shrimp|crab|lobster|gelatin|gelatine|lard)\b/g,'').replace(/\bcoconut meat\b/g,'');
 return /\b(?:beef|veal|pork|bacon|ham|chicken|turkey|lamb|mutton|venison|duck|goose|meat|fish|salmon|tuna|cod|haddock|anchov(?:y|ies)|sardines?|prawns?|shrimp|crab|lobster|gelatin|gelatine|lard)\b/.test(source);
}
function hasWholegrainIngredient(raw){
 return String(raw.ingredients_text_en||raw.ingredients_text||'').split(/[,;]+/).some(piece=>{
  // Wholegrain mustard describes whole mustard seeds, not cereal grains.
  if(/\b(?:no|without|zero)\s+(?:whole\s*grain|wholemeal|whole\s*wheat|brown\s+rice)\b/i.test(piece)||/\b0(?:[.,]0+)?\s*%\s*(?:whole\s*grain|wholemeal|whole\s*wheat|brown\s+rice)\b/i.test(piece))return false;
  const text=clean(piece);
  return /\b(?:wholemeal|wholegrain|whole grain) (?:wheat|oats?|rye|barley|rice|spelt|maize|corn|sorghum|millet|flour|pasta|semolina)\b/.test(text)||/\b(?:whole wheat|brown rice)\b/.test(text);
 });
}
function micronutrient(raw,id,unit){
 const set=raw.nutrition?.aggregated_set;
 if(raw.no_nutrition_data==='on')return null;
 if(set){
  if(!['100g','100ml'].includes(set.per)||!['as_sold','prepared'].includes(set.preparation))return null;
  const n=set.nutrients?.[id];if(!n||!['packaging','manufacturer'].includes(n.source)||!['eq','=',undefined,null].includes(n.modifier))return null;
  const value=numeric(n.value);if(value===null)return null;
  const u=String(n.unit||'').toLowerCase().replace('µ','u').replace('μ','u');
  const factor=unit==='mg'?{g:1000,mg:1,ug:.001}[u]:{g:1e6,mg:1000,ug:1}[u];return factor?value*factor:null;
 }
 if(raw.nutrition_data_prepared==='on'&&raw.nutrition_data!=='on')return null;
 const n=raw.nutriments||{};if(![undefined,null,'=','eq'].includes(n[id+'_modifier']))return null;
 // OFF legacy *_100g mineral/vitamin fields are canonical grams, regardless
 // of the user-facing *_unit entered on the label; no serving conversion.
 const value=numeric(n[id+'_100g']);return value===null?null:value*(unit==='mg'?1000:1e6);
}
export function evaluateDiscovery(raw,{fetchedAt=Date.now()}={}){
 const facts=catalogueRecordFromPayload({product:raw},String(raw.code),fetchedAt).product;
 const categories=strings(raw.categories_tags).map(tag),labels=strings(raw.labels_tags).map(tag),allergens=declaredAllergens(raw.allergens_tags,raw.allergens),traces=declaredAllergens(raw.traces_tags,raw.traces);
 const analysis=strings(raw.ingredients_analysis_tags).map(tag),pieces=ingredientParts(raw);
 const aisles=Object.entries(AISLES).filter(([,tags])=>tags.some(t=>categories.includes(t))).map(([id])=>id);
 const dietary={},nutrition={};
 // OFF canonical free-from IDs use no-*, independently of displayed wording.
 const definitions={gluten:{labels:['no-gluten','gluten-free','certified-gluten-free'],allergens:['gluten'],ingredient:/\b(?:barley|rye|malt)\b/},lactose:{labels:['no-lactose','lactose-free'],allergens:[],ingredient:/\blactose\b/},milk:{labels:['no-milk','milk-free','dairy-free'],allergens:['milk'],ingredient:/\b(?:milk|whey|casein|butter|cream|cheese|yogurt|yoghurt)\b/},wheat:{labels:['no-wheat','wheat-free'],allergens:['wheat'],ingredient:/\bwheat\b/},peanut:{labels:['no-peanuts','peanut-free','peanuts-free'],allergens:['peanuts','peanut'],ingredient:/\b(?:peanuts?|groundnuts?)\b/},soya:{labels:['no-soy','soy-free','soya-free'],allergens:['soybeans','soya','soy'],ingredient:/\b(?:soy|soya|soybeans?)\b/}};
 for(const [id,d]of Object.entries(definitions)){
  const claimed=d.labels.find(l=>labels.includes(l));
  // Explicit lactose-free dairy can contain milk; gluten-free wheat starch
  // can contain wheat. These are separate requirements, never aliases.
  const explicitIngredient=pieces.some(text=>{
   if(id==='milk')return animalDairy(text);
   if(id==='gluten'&&claimed)return /\b(?:barley|rye|gluten)\b/.test(text); // GF wheat starch remains distinct from wheat-free.
   return d.ingredient.test(text)||(id==='gluten'&&/\bwheat\b/.test(text));
  });
  const conflict=d.allergens.find(a=>allergens.includes(a)||traces.includes(a))||(explicitIngredient?'listed ingredient':null);
  dietary[id]={state:conflict?'conflicting':claimed?'supported':'unconfirmed',reason:conflict?`Source declares ${conflict}.`:claimed?`Source label: ${claimed}.`:'No explicit free-from label supplied.',source:'Open Food Facts',claim:claimed||null};
 }
 for(const id of ['vegan','vegetarian']){
  const ingredientConflict=pieces.some(text=>animalFlesh(text)||(id==='vegan'&&(animalDairy(text)||/\b(?:eggs?|egg white|egg yolk|honey)\b/.test(text))));
  const conflict=analysis.includes('non-'+id)||ingredientConflict,claim=labels.includes(id);
  dietary[id]={state:conflict?'conflicting':claim?'supported':'unconfirmed',reason:conflict?(ingredientConflict?'Source lists a conflicting animal ingredient.':`Source ingredient analysis: non-${id}.`):claim?`Source label: ${id}.`:'No explicit preference label supplied.',source:'Open Food Facts'};
 }
 const amount=(id)=>{const n=facts.nutrients[id];return n&&n.value!==null&&['supplied','calculated'].includes(n.status)&&!['lt','gt','lte','gte','<','>','~'].includes(n.relation)?n.value:null;};
 const energy=amount('energyKcal'),protein=amount('protein'),fibre=amount('fibre'),basis=facts.basisUnit,prepared=facts.nutritionPreparation;
 const validBasis=['g','ml'].includes(basis)&&['as_sold','prepared'].includes(prepared);
 const put=(id,value,unit,threshold,qualifies,reason)=>nutrition[id]={state:value===null||!validBasis?'unconfirmed':qualifies?'supported':'conflicting',value,unit,basis:`100${basis||' unknown'}`,preparation:prepared,threshold,reason,source:'Open Food Facts',ruleVersion:DISCOVERY_VERSION};
 put('protein',protein,'g',12,protein!==null&&energy>0&&protein*4/energy*100>=12,'At least 12% of energy from protein; requires source energy.');
 nutrition.protein.energyKcal=energy;nutrition.protein.energyPercent=protein!==null&&energy>0?protein*4/energy*100:null;
 if(energy===null||energy<=0||protein!==null&&energy>0&&protein*4>energy*1.05)nutrition.protein.state='unconfirmed';
 for(const [id,g,perKcal]of [['fibre',3,1.5],['highfibre',6,3]]){
  const qualifies=fibre!==null&&(basis==='g'&&fibre>=g||energy>0&&fibre/energy*100>=perKcal);
  put(id,fibre,'g',{per100g:g,per100kcal:perKcal},qualifies,`At least ${g}g per 100g or ${perKcal}g per 100kcal.`);
  nutrition[id].energyKcal=energy;nutrition[id].gramsPer100Kcal=fibre!==null&&energy>0?fibre/energy*100:null;
  if(fibre!==null&&basis!=='g'&&!(energy>0))nutrition[id].state='unconfirmed';
 }
 const beverage=categories.includes('beverages')||facts.scoringFacts?.isBeverage===true;
 for(const [id,field,nrv,unit]of [['iron','iron',14,'mg'],['calcium','calcium',800,'mg'],['vitd','vitamin-d',5,'µg']]){
  const value=micronutrient(raw,field,unit),threshold=nrv*(beverage&&basis==='ml'?.075:.15);
  put(id,value,unit,threshold,value!==null&&value>=threshold,`${beverage&&basis==='ml'?'7.5':'15'}% of label reference value per 100${basis||'g/ml'}; not a personalised daily target.`);
  if(beverage&&basis!=='ml')nutrition[id].state='unconfirmed';
 }
 const wholegrain=hasWholegrainIngredient(raw);
 nutrition.wholegrain={state:wholegrain?'supported':'unconfirmed',reason:wholegrain?'Wholegrain ingredient explicitly listed.':'No wholegrain ingredient evidence supplied.',source:'Open Food Facts',ruleVersion:DISCOVERY_VERSION};
 return {version:DISCOVERY_VERSION,aisles,dietary,nutrition,sourceURL:facts.sourceURL,retrievedAt:fetchedAt,sources:DISCOVERY_SOURCES};
}
