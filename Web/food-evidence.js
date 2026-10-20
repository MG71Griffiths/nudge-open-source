(function(root){
'use strict';
const registry=Object.freeze([
 {id:'adult-fibre',version:'2026-10-03',status:'source_reviewed_not_clinically_signed_off',source:'NHS',url:'https://www.nhs.uk/live-well/eat-well/digestive-health/how-to-get-more-fibre-into-your-diet/',reviewedAt:'2026-10-03',population:'Adults',units:'g AOAC fibre/day',reference:30,claim:'UK adult guidance is 30 g of fibre a day from varied foods.',exceptions:'Children have different guidance. A saved personal target or clinical advice is separate; this reference does not replace it.'},
 {id:'aspartame',version:'2026-10-03',status:'source_reviewed_not_clinically_signed_off',source:'EFSA',url:'https://www.efsa.europa.eu/en/topics/topic/aspartame',reviewedAt:'2026-10-03',population:'General population; PKU excluded',units:'mg/kg body weight/day',reference:40,claim:'Ingredient presence does not establish the dose. Without a product-specific concentration, Nudge cannot calculate aspartame exposure.',exceptions:'People with phenylketonuria (PKU) need to avoid phenylalanine; the general acceptable daily intake does not apply to them.'}
]);
const norm=s=>String(s||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
const iso=(d,m,y)=>{const month=months.indexOf(m.toLowerCase())+1,n=Number(d),year=Number(y);if(month<1||n<1||n>31||year<2000||year>2100)return null;const s=`${year}-${String(month).padStart(2,'0')}-${String(n).padStart(2,'0')}`;return new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s?s:null;};
function range(text){
 // Parse the whole condition. Unrecognised suffixes may narrow applicability and must remain pending.
 const clean=String(text||'').trim().replace(/[.,;]\s*$/,'').trim();
 const m=clean.match(/^(?:all dates\s+)?(?:between\s+|from\s+)?(\d{1,2})\s+([a-z]+)(?:\s+(20\d{2}))?\s*(?:and|to|–|-)\s*(\d{1,2})\s+([a-z]+)\s+(20\d{2})$/i);
 if(m){const a=iso(m[1],m[2],m[3]||m[6]),b=iso(m[4],m[5],m[6]);return a&&b&&a<=b?[a,b]:null;}
 const single=clean.match(/^(\d{1,2})\s+([a-z]+)\s+(20\d{2})$/i);if(single){const d=iso(single[1],single[2],single[3]);return d?[d,d]:null;}return null;
}
function pack(s){
 const m=String(s||'').trim().toLowerCase().match(/^(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kilograms?|kg|grams?|g|millilitres?|milliliters?|ml|centilitres?|cl|litres?|liters?|ltr|l)\s*(?:℮|e)?$/i);
 if(!m)return null;const count=m[1]?Number(m[1]):1,amount=Number(m[2].replace(',','.')),u=m[3].toLowerCase();
 if(!Number.isSafeInteger(count)||count<1||!Number.isFinite(amount)||amount<=0)return null;
 const mass=/^(?:kg|kilogram|g|gram)/.test(u),factor=/^(?:kg|kilogram|l$|ltr$|litre|liter)/.test(u)?1000:/^(?:cl|centilitre)/.test(u)?10:1;
 return {count,amount:amount*factor,dimension:mass?'mass':'volume'};
}
function packMatch(required,actual){
 const a=pack(required),b=pack(actual);if(!a||!b||a.dimension!==b.dimension||a.count!==b.count)return null;
 return Math.abs(a.amount-b.amount)<.000001;
}
function activeNotice(value){
 const label=typeof value==='object'&&value?value.label:value;
 const raw=typeof label==='string'?label.trim().toLowerCase():'';
 if(['published','updated','active'].includes(raw))return true;
 // An explicit inactive/unknown label must not be overridden by a stale status URI.
 if(raw)return /^https?:\/\/data\.food\.gov\.uk\/codes\/alerts\/def\/status\/(?:published|updated|active)\/?$/.test(raw);
 const uri=typeof value?.['@id']==='string'?value['@id'].trim().toLowerCase():'';
 return /^https?:\/\/data\.food\.gov\.uk\/codes\/alerts\/def\/status\/(?:published|updated|active)\/?$/.test(uri);
}
function batchConditions(batch,product){
 const pending=[],conditions=[];let mismatch=false;
 function date(label,description,actual){if(!description)return;const r=range(description);if(!r){pending.push(`Check ${label}: ${description}`);return;}conditions.push(label);if(!/^\d{4}-\d{2}-\d{2}$/.test(actual||'')||!Number.isFinite(Date.parse(actual+'T12:00:00Z'))||new Date(actual+'T12:00:00Z').toISOString().slice(0,10)!==actual)pending.push(`Check ${label}: ${description}`);else if(actual<r[0]||actual>r[1])mismatch=true;}
 const best=String(batch.bestBeforeDescription||'');
 const split=best.split(/\b(?:purchased?|bought)\s+(?:between|from|on)\s+/i);
 date('best-before date',split[0].trim().replace(/(?:[,;]|\band)\s*$/i,'').trim(),product.bestBefore);
 if(split.length>1)date('purchase date',split.slice(1).join(' '),product.purchaseDate);
 date('use-by date',batch.useByDescription,product.useBy);
 for(const [key,label] of [['batchCode','batch code'],['lotNumber','lot number']])if(batch[key]){conditions.push(label);if(!product[key])pending.push(`Check ${label}: ${batch[key]}`);else if(norm(product[key])!==norm(batch[key]))mismatch=true;}
 const known=new Set(['@id','bestBeforeDescription','useByDescription','batchCode','lotNumber']);
 if(Object.keys(batch).some(k=>!known.has(k)))pending.push('Check the full notice’s additional batch conditions');
 if(!conditions.length)pending.push('Check the full notice’s batch/date conditions');
 return {mismatch,pending};
}
function assessRecalls(product,response){
 const checkedAt=response?.checkedAt||null,scope=response?.scope||'Latest 100 full FSA notices; not a complete historical or independent FSS search';
 if(response?.status!=='available'||!Array.isArray(response.notices))return {status:'check_unavailable',checkedAt,scope,matches:[],message:'Recall check unavailable. Check the current official notices.'};
 const dedup=new Map();for(const n of response.notices){const id=String(n.notation||'').replace(/-update-\d+$/,'');if(!id)continue;const prior=dedup.get(id);if(!prior||String(n.modified||n.created)>String(prior.modified||prior.created))dedup.set(id,n);}
 const matches=[],name=norm(product.name),brand=norm(product.brand||product.retailer);
 for(const n of dedup.values()){
  if(!/^https:\/\/alerts\.food\.gov\.uk\//.test(n.alertURL||''))continue;
  if(!activeNotice(n.status))continue;
  for(const detail of n.productDetails||[]){
   const target=norm(detail.productName),targetWords=target.split(' ').filter(w=>w.length>2),hay=norm(`${brand} ${name}`);
   const overlap=targetWords.filter(w=>hay.split(' ').includes(w)).length;
   if(!targetWords.length||overlap/targetWords.length<.65)continue;
   const exact=target===name||target===hay||target===norm(`${name} ${brand}`);
   const requiredPack=detail.packSizeDescription;
   const packComparison=requiredPack&&product.packSize?packMatch(requiredPack,product.packSize):null;
   if(packComparison===false)continue;
   const batches=(detail.batchDescription||[]).map(b=>batchConditions(b,product));
   const eligible=batches.filter(b=>!b.mismatch);if(batches.length&&!eligible.length)continue;
   const pending=[...(!exact?['Confirm product name and variant']:[]),...(requiredPack&&packComparison!==true?[`Check pack size: ${requiredPack}`]:[]),...(!batches.length?['Check the full notice’s product conditions']:eligible.flatMap(b=>b.pending))];
   // Free-text conditions beyond the structured batch data cannot be cleared automatically.
   if(/purchased|bought|batch|best.before|use.by/i.test(n.description||''))pending.push('Check any additional conditions in the full notice');
   matches.push({id:n.notation,status:pending.length?'potential_match':'matched',title:n.title,url:n.alertURL,advice:n.consumerAdvice||'Read the official notice before consuming.',risk:(n.problem||[]).map(x=>x.riskStatement||'').join(' '),pending:[...new Set(pending)],modified:n.modified||n.created,product:detail});
  }
 }
 const status=matches.some(m=>m.status==='matched')?'matched':matches.length?'potential_match':'no_matching_notice_found';
 return {status,checkedAt,scope,matches,message:status==='matched'?'Product recall — follow the official advice':status==='potential_match'?'Possible recall — check your pack':'No matching notice found in the checked notices.'};
}
const api={registry,assessRecalls,batchConditions};root.NudgeFoodEvidence=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window==='object'?window:globalThis);
