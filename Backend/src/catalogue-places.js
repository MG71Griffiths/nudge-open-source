import taxonomy from '../../Web/core/places.v1.json' with {type:'json'};

// A public product association is not evidence of today's stock or a menu.
// Only the explicitly curated matching aliases participate in this projection.
export const PLACE_VERSION = taxonomy.version + '-associations-v2';
export const PLACES = Object.freeze(taxonomy.places);
export const PLACE_IDS = Object.freeze(PLACES.map(place=>place.id));
const normal = value => typeof value === 'string' ? value.slice(0,1000).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/^[a-z]{2}:/i,'').toLowerCase().replace(/['’`]/g,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ') : '';
const metadataKey = value => normal(value).replace(/ /g,'');
// Evidence display text crosses native decoders; preserve original OFF fields
// separately while making harmless source whitespace safe for a UI label.
const displayValue = value => value.replace(/[\p{Cc}\p{Cf}]/gu,' ').trim().slice(0,240);
const values = value => (Array.isArray(value)?value:typeof value==='string'?value.split(/[,;]/):[]).slice(0,100).filter(value=>typeof value==='string'&&value.length<=240);
const compiled = PLACES.map(place=>({place,
  brand:new Set(place.matching.brandAliases.map(metadataKey)),retailer:new Set(place.matching.retailerAliases.map(metadataKey)),
  titles:[...new Set(place.matching.titleAliases.map(normal))].filter(Boolean).sort((a,b)=>b.length-a.length)
}));
export function publicPlace(id) {
  const place=PLACES.find(item=>item.id===id);
  return place?{id:place.id,title:place.title,groups:place.groups,menuAvailable:false}:null;
}
export function evaluatePlaces(product) {
  const associations=[];
  const metadata=[['brand','brands'],['brand','brands_tags'],['retailer','stores'],['retailer','stores_tags']];
  const titles=['product_name_en','product_name'].map(field=>({field,value:product?.[field],text:normal(product?.[field])})).filter(item=>item.text);
  for(const {place,brand,retailer,titles:aliases} of compiled){
    const matched=new Set();
    for(const [relation,field] of metadata){
      const found=values(product?.[field]).find(value=>(relation==='brand'?brand:retailer).has(metadataKey(value)));
      if(found&&!matched.has(relation)){
        associations.push({placeID:place.id,relation,confidence:'source_metadata',field,value:displayValue(found)});matched.add(relation);
      }
    }
    // Prefer metadata to title guesses for this entity. An explicit style,
    // comparison or imitation description must never become a chain product.
    if(matched.size||!aliases.length)continue;
    for(const title of titles){
      if(/\b(?:style|inspired|copycat|homemade|home made|imitation|replica|alternative|like|compare|comparison|better than|recipe for)\b/.test(title.text))continue;
      const alias=aliases.find(alias=>(' '+title.text+' ').includes(' '+alias+' '));
      if(alias){associations.push({placeID:place.id,relation:'title_candidate',confidence:'candidate',field:title.field,value:displayValue(title.value),matchedAlias:alias});break;}
    }
  }
  return {version:PLACE_VERSION,taxonomyVersion:taxonomy.version,source:'Open Food Facts',menuAvailable:false,stockConfirmed:false,associations};
}
