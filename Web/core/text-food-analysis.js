/* Typed food evidence. No photos, network, storage, diary writes or model nutrients.
 * The backend and native JavaScriptCore use the same source/quantity calculator. */
(function(root){
'use strict';
const VERSION='nudge-text-food-v1',MAX_DESCRIPTION=2000,MAX_COMPONENTS=20;
const copy=v=>JSON.parse(JSON.stringify(v)),object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const safe=(s,n)=>typeof s==='string'&&s.trim().length>0&&s.length<=n&&!/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(s);
const normal=s=>String(s||'').toLowerCase().normalize('NFKC').replace(/yoghurt/g,'yogurt').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
function validateRequest(body){
 if(!object(body)||Object.keys(body).sort().join(',')!=='description,requestId'||!safe(body.description,MAX_DESCRIPTION)||body.description.trim().length<2||typeof body.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId))fail('request_invalid');
 const description=body.description.trim();
 if(/\b(?:ignore (?:all |previous |your )?instructions|system prompt|developer message|api key|give (?:me )?(?:a )?(?:score|rating)|rate (?:this|it) (?:100|zero)|did(?:n.t| not) eat|haven.t eaten|not food|pet food|dog food|cat food|bleach|detergent|shampoo|soap|medicine|supplement|protein powder|baby formula)\b/i.test(description))fail('food_description_unsupported');
 return {description,requestId:body.requestId.toLowerCase()};
}
function context(description){
 const excluded=[];let active=description.toLowerCase().replace(/yoghurt/g,'yogurt');
 active=active.replace(/\b(?:without|no|not|hold(?: the)?)\s+([^,;.]+?)(?=\s+(?:with|but|plus)\b|[,;.]|$)/g,(_,s)=>{excluded.push(...s.split(/\s+and\s+/).map(x=>normal(x).replace(/^(?:(?:any|the|a|an|some|extra|added)\s+)+/,'' )).filter(Boolean));return ' ';});
 active=active.replace(/\b(?:i (?:have |just )?(?:had|ate)|i.m eating|for (?:breakfast|lunch|dinner)|a meal of)\b/g,' ').replace(/\s+/g,' ').trim();
 return {active,excluded,vegan:/\bvegan|plant[- ]based|dairy[- ]free\b/i.test(description),glutenFree:/\bgluten[- ]free\b/i.test(description)};
}
// Explicit generic-food proxies. Amounts are transparent editable assumptions,
// never official serving sizes or exact branded-product facts.
const foods=[
 ['sourdough','usda:172675',40,['sourdough','sourdough bread'],'French/Vienna bread source includes sourdough; the actual loaf may differ.'],
 ['white bread','11-980:d3b50c7664c5',40,['white bread','bread'],'Generic sliced white bread; 40 g per slice when not weighed.'],
 ['wholemeal bread','11-981:747472757c25',40,['wholemeal bread','whole wheat bread','wholewheat bread'],'Generic wholemeal bread; 40 g per slice when not weighed.'],
 ['cheddar cheese','12-346:9077a1c24b1d',30,['cheddar','cheddar cheese','cheese'],'Generic English Cheddar is proposed; other cheese types differ.'],
 ['tomato chutney','17-345:3281604a170a',20,['tomato chutney','chutney'],'Tomato chutney is a generic proxy; check the actual chutney.'],
 ['mango chutney','17-343:e8c5b8c3d2b9',20,['mango chutney'],'Generic sweet mango chutney; brand and recipe may differ.'],
 ['plain yogurt','12-184:b118074cf49f',150,['plain yogurt','yogurt'],'Whole-milk plain yogurt is proposed; check type and quantity.'],
 ['Greek yogurt','12-555:bf4be7c34952',150,['greek yogurt','plain greek yogurt'],'Generic plain Greek-style yogurt; check fat content.'],
 ['dry oats','11-788:21478772498f',40,['oats','dry oats','porridge oats'],'Dry unfortified oats; this is not the weight of cooked porridge.'],
 ['banana','usda:173944',120,['banana','bananas'],'120 g edible banana per fruit when not weighed.'],
 ['boiled egg','usda:173424',50,['boiled egg','boiled eggs','hard boiled egg','hard boiled eggs'],'50 g edible hard-boiled egg per egg when not weighed.'],
 ['cooked white rice','usda:168878',150,['cooked white rice','white rice','cooked rice','rice'],'Generic cooked white rice; not dry rice weight.'],
 ['cooked brown rice','11-869:d96b18563943',150,['cooked brown rice','brown rice'],'Generic cooked brown rice; not dry rice weight.'],
 ['grilled chicken breast','18-323:37afb0053057',150,['grilled chicken breast','cooked chicken breast','chicken breast','grilled chicken','cooked chicken','chicken'],'Skinless grilled chicken breast is proposed; sauces and cooking fats are separate.'],
 ['olive oil','usda:171413',5,['olive oil','extra virgin olive oil'],'Generic olive oil; 5 g per teaspoon when not weighed.'],
 ['butter','17-685:5d11e1950606',5,['butter','salted butter'],'Generic salted butter; 5 g when no amount is given.'],
 ['apple','usda:171688',150,['apple','apples'],'150 g edible apple with skin per fruit when not weighed.'],
 ['black coffee','17-833:c04a2de33acf',250,['black coffee'],'Coffee infusion; milk and sugar are not included.'],
 ['black tea','17-165:285fb47bea7e',250,['black tea'],'Tea infusion; milk and sugar are not included.'],
 ['semi-skimmed milk','12-313:af4666ba4d03',200,['semi skimmed milk'],'Generic semi-skimmed milk; volume is approximated as equal grams.'],
 ['whole milk','12-596:d379c671eb80',200,['whole milk'],'Generic whole milk; volume is approximated as equal grams.'],
 ['skimmed milk','12-307:58a5783b7139',200,['skimmed milk'],'Generic skimmed milk; volume is approximated as equal grams.']
];
// Preferred plain references keep normal food clauses represented in the bounded
// provider menu. These are candidate choices, not automatic portion assumptions.
const preferredReferences=[
 ['13-439:027ed8ef67b8',['peas','cooked peas','boiled peas']],
 ['13-490:93154005e8d5',['potato','potatoes','boiled potatoes']],
 ['16-357:fb24566459cc',['salmon','grilled salmon','cooked salmon']],
 ['11-936:773a7e0c6539',['cheese pizza']],
 ['17-808:e4e061e9c5d4',['lentil soup']]
];
const foodFor=name=>foods.find(f=>f[3].includes(normal(name)));
const escapeRE=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const has=(text,word)=>new RegExp('(?:^| )'+escapeRE(word)+'(?:s)?(?: |$)').test(normal(text));
const family=f=>/bread|sourdough/.test(f[0])?'bread':/chutney/.test(f[0])?'chutney':/yogurt/i.test(f[0])?'yogurt':/rice/.test(f[0])?'rice':/milk/.test(f[0])?'milk':f[0]==='cheddar cheese'?'cheese':f[0]==='boiled egg'?'egg':f[0]==='grilled chicken breast'?'chicken':f[0]==='dry oats'?'oats':f[0];
function families(text){const result=new Set(foods.filter(f=>f[3].some(a=>has(text,a))).map(family));if(has(text,'sandwich')||has(text,'toast'))result.add('bread');return result;}
function sourceFamilies(record){const known=foods.find(f=>f[1]===record.id);return known?new Set([family(known)]):families(record.name);}
const semanticStop=new Set(('a an the i had ate have just eating with and on in of for my some slice slices bowl plate sandwich without no not food meal to this that please after before work lunch breakfast dinner snack today yesterday at home around about roughly approximately roughly large small medium handful portion portions serving servings pieces piece g kg grams gram ml litre litres millilitre millilitres tsp tbsp teaspoon teaspoons tablespoon tablespoons one two three four half fresh plain generic cooked uncooked raw dry dried dehydrated boiled hard grilled fried roasted baked toasted sliced chopped diced skinless salted unfortified whole fat').split(' '));
const singular=w=>({potatoes:'potato',tomatoes:'tomato'}[w]||(w.endsWith('s')?w.slice(0,-1):w));
const words=text=>normal(text).split(' ').filter(w=>w.length>2&&!semanticStop.has(w)&&!/^\d+$/.test(w)).map(singular);
function sameIdentity(text,record){
 const required=families(text),actual=sourceFamilies(record);if([...required].some(f=>actual.has(f)))return true;
 const tokens=words(record.name);return words(text).some(w=>tokens.includes(w));
}
function preparationMatches(text,record){
 const source=normal(record.name),input=normal(text),rice=has(source,'rice'),pasta=/\bpasta|spaghetti|macaroni\b/.test(source);
 const requested=families(text),actual=sourceFamilies(record);
 if([...actual].some(f=>!requested.has(f)))return false;
 // Shared words do not make banana bread, banana pepper or banana chips a
 // banana. Require the distinguishing food/processing words to be stated.
 if(!foods.some(f=>f[1]===record.id))for(const word of ['pepper','chips','crisps','pudding','cake','flour','powder','juice','smoothie','sauce','soup','salad','bar','cereal','pizza','pie','pastry','biscuit','cookie','ice cream','sweetened','sugared','syrup'])if(has(source,word)&&!has(input,word))return false;
 // Nearby catalogue matches are different foods, not interchangeable plain
 // proxies: sweet potato, nuggets, ham/bacon and added carrots must be stated.
 const sourceNouns=normal(source).split(' ').map(singular).join(' '),inputNouns=normal(input).split(' ').map(singular).join(' ');
 for(const variant of ['sweet potato','nugget','ham','bacon','carrot'])if(has(sourceNouns,variant)&&!has(inputNouns,variant))return false;
 if(/\b(?:dried|dehydrated|powder|concentrate)\b/.test(source)&&!/\b(?:dried|dehydrated|powder|concentrate)\b/.test(input))return false;
 if(/\b(?:raw|uncooked|dry)\b/.test(input)&&/\b(?:cooked|boiled|grilled|fried|roasted|baked)\b/.test(source))return false;
 if(/\b(?:cooked|boiled|grilled|fried|roasted|baked)\b/.test(input)&&/\b(?:uncooked|raw|dry)\b/.test(source))return false;
 if((rice||pasta)&&/\b(?:raw|uncooked|dry)\b/.test(input)&&!/\b(?:raw|uncooked|dry)\b/.test(source))return false;
 if(/\b(?:toast|toasted)\b/.test(input)&&has(source,'bread')&&!/\b(?:toast|toasted)\b/.test(source))return false;
 return true;
}
// Evidence strings are not trusted to carry a quantity or to prove coverage.
// Re-check the complete original clauses against the selected reference foods.
function validateMeaning(request,selection,available){
 const ctx=context(request.description),clauses=ctx.active.split(/\s+(?:with|and|plus)\s+|[,;]+/).map(s=>s.trim()).filter(Boolean);
 const records=selection.components.map(item=>available.get(item.sourceId));
 for(let index=0;index<selection.components.length;index++){
  const item=selection.components[index],record=records[index];
  if(!sameIdentity(item.name,record)||!sameIdentity(item.evidence,record))fail('text_result_invalid');
  const matching=clauses.filter(c=>sameIdentity(c,record));if(!matching.length)fail('text_result_invalid');
  if(!matching.some(c=>preparationMatches(c,record)))fail('text_result_invalid');
  const quantities=matching.flatMap(c=>[...c.matchAll(/(\d+(?:\.\d+)?)\s*(kg|g|grams?|ml)\b/gi)].map(m=>({grams:Number(m[1])*(m[2].toLowerCase()==='kg'?1000:1),unit:m[2].toLowerCase(),clause:c})));
  if(quantities.length){
   // A weighed mixture cannot be assigned wholly to each ingredient. Such a
   // description needs clearer individual amounts before a model result passes.
   if(quantities.length!==1||selection.components.filter((_,i)=>sameIdentity(quantities[0].clause,records[i])).length!==1||Math.abs(quantities[0].grams-item.amountGrams)>.001||quantities[0].unit==='ml'&&!/milk|coffee|tea/.test(normal(record.name)))fail('text_result_invalid');
  }else{
   for(const clause of matching){
    const counted=normal(clause).replace(/\b(one|two|three|four|half)\b/g,w=>({one:'1',two:'2',three:'3',four:'4',half:'0.5'}[w])).match(/^(\d+(?:\.\d+)?)\s+(?:(slices?|pieces?|teaspoons?|tsp|tablespoons?|tbsp)\s+(?:of\s+)?)?(.+)$/);
    if(counted&&!has(clause,'sandwich')){
     const f=foods.find(f=>f[1]===item.sourceId),unit=counted[2]||'';if(!f)fail('text_result_invalid');
     if(/\b(?:bowl|plate|cup|packet|bag|handful|serving)\b/.test(counted[3]))fail('text_result_invalid');
     let per=f[2];if(/^(tsp|teaspoon)/.test(unit)){if(!/oil|butter|chutney/.test(f[0]))fail('text_result_invalid');per=5;}else if(/^(tbsp|tablespoon)/.test(unit)){if(!/oil|butter|chutney/.test(f[0]))fail('text_result_invalid');per=15;}else if(/^slice/.test(unit)&&!/bread|sourdough/.test(f[0]))fail('text_result_invalid');else if(/^piece/.test(unit)&&!['banana','apple','boiled egg'].includes(f[0]))fail('text_result_invalid');
     if(Math.abs(Number(counted[1])*per-item.amountGrams)>.001)fail('text_result_invalid');
    }
   }
  }
 }
 const actualFamilies=new Set(records.flatMap(r=>[...sourceFamilies(r)]));
 if([...families(ctx.active)].some(f=>!actualFamilies.has(f)))fail('text_result_invalid');
 const availableWords=new Set([...available.values()].flatMap(r=>words(r.name))),actualWords=new Set(records.flatMap(r=>words(r.name)));
 for(const word of words(ctx.active))if(availableWords.has(word)&&!actualWords.has(word)&&!foods.some(f=>f[3].some(a=>words(a).includes(word))&&actualFamilies.has(family(f))))fail('text_result_invalid');
 if(clauses.some(c=>!records.some(r=>sameIdentity(c,r))))fail('text_result_invalid');
}
function allowed(record,ctx){
 const n=normal(record.name),words=n.split(' ');
 if(['alcohol','supplement','infant_food','medical_food','sports_nutrition'].includes(record.foodGroup)||/\b(?:alcoholic|babyfood|infant|formula|protein powder|pet food)\b/.test(n))return false;
 if(ctx.excluded.some(e=>e.split(' ').filter(w=>w.length>2).every(w=>words.includes(w))))return false;
 if(ctx.vegan&&(/\b(?:milk|cheese|yogurt|butter|cream|egg|eggs|chicken|beef|pork|lamb|fish|salmon|tuna|honey)\b/.test(n)||['red_meat','poultry','fish','egg','dairy','cheese'].includes(record.foodGroup)))return false;
 if(ctx.glutenFree&&/\b(?:wheat|bread|pasta|barley|rye|flour|couscous)\b/.test(n)&&!/gluten free/.test(n))return false;
 return true;
}
// Each stated food gets candidate capacity. Cooking words can rank an already
// matching food, but cannot admit unrelated grilled fish or boiled vegetables.
function candidates(description){
 const ctx=context(description),clauses=ctx.active.split(/\s+(?:with|and|plus)\s+|[,;]+/).map(s=>s.trim()).filter(Boolean);
 const buckets=clauses.map(clause=>{
  const terms=[...new Set(words(clause))],additions=new Set(foods.filter(f=>f[3].some(a=>has(clause,a))).map(f=>f[1]));
  if(has(clause,'sandwich'))additions.add(foodFor(has(clause,'sourdough')?'sourdough':has(clause,'wholemeal')?'wholemeal bread':'white bread')[1]);
  for(const [id,aliases] of preferredReferences)if(aliases.some(a=>has(clause,a)))additions.add(id);
  const preparation=normal(clause).split(' ').filter(w=>/^(?:raw|uncooked|dry|dried|cooked|boiled|grilled|fried|roasted|baked|toasted)$/.test(w));
  return {clause,terms,additions,preparation,ranked:[]};
 });
 for(const row of root.NudgeMealRecoveryData?.records||[]){
  const tokens=words(row[3]),source=normal(row[3]);let record;
  for(const bucket of buckets){
   const hits=bucket.terms.filter(t=>tokens.includes(t)).length,boost=bucket.additions.has(row[0]);
   if(!hits&&!boost)continue;
   record=record||root.NudgeMealRecovery?.record(row[0]);
   if(!record||!allowed(record,ctx)||!preparationMatches(bucket.clause,record))continue;
   const preparationHits=bucket.preparation.filter(p=>has(source,p)).length;
   bucket.ranked.push({id:row[0],name:row[3],record,rank:(boost?100:0)+hits*10+preparationHits*2-tokens.length/10});
  }
 }
 for(const bucket of buckets)bucket.ranked.sort((a,b)=>b.rank-a.rank||a.id.localeCompare(b.id));
 const result=[],seen=new Set();let rank=0,remaining=true;
 while(result.length<60&&remaining){
  remaining=false;
  for(const bucket of buckets){
   const candidate=bucket.ranked[rank];if(!candidate)continue;remaining=true;
   if(!seen.has(candidate.id)){seen.add(candidate.id);result.push(candidate);if(result.length===60)break;}
  }
  rank++;
 }
 return result.map(({id,name,record})=>({id,name,record}));
}
function finish(raw,selection,method='model'){
 const request=validateRequest(raw),ctx=context(request.description),available=new Map(candidates(request.description).map(c=>[c.id,c.record]));
 if(!object(selection)||selection.isFood!==true||!safe(selection.name,100)||!Array.isArray(selection.components)||!selection.components.length||selection.components.length>MAX_COMPONENTS)fail('food_description_unsupported');
 const components=[],proof=[];let grams=0;
 for(const item of selection.components){
  if(!object(item)||Object.keys(item).sort().join(',')!=='amountGrams,assumption,evidence,name,sourceId'||!safe(item.name,100)||!safe(item.evidence,300)||!request.description.toLowerCase().includes(item.evidence.toLowerCase())||!safe(item.assumption,240)||typeof item.amountGrams!=='number'||!Number.isFinite(item.amountGrams)||item.amountGrams<.1||item.amountGrams>1500||!available.has(item.sourceId))fail('text_result_invalid');
  const sourceRecord=available.get(item.sourceId);
  if(ctx.excluded.some(e=>normal(item.name).includes(e)))fail('text_result_invalid');
  grams+=item.amountGrams;
  const canonicalName=sourceRecord.name.slice(0,100);
  components.push({name:canonicalName,amountGrams:item.amountGrams,amountSource:'estimated',recordId:item.sourceId,sourceRecord:copy(sourceRecord),nutrients:copy(sourceRecord.nutrients),assumptions:[item.assumption],evidence:item.evidence});proof.push({...copy(item),name:canonicalName});
 }
 if(grams>3000)fail('food_amount_too_large');
 validateMeaning(request,selection,available);
 const displayName=request.description.replace(/^i (?:had|ate)\s+/i,'').slice(0,100);
 const total=root.NudgeComposition.total(components),meal={name:displayName,basis:'perPortion',components,ingredients:components.map(c=>({name:c.name,evidence:c.evidence})),portion:{amount:grams,unit:'g',source:'estimated'}};
 const score=root.NudgeMealScore.calculate(meal);
 if(!root.NudgeMealScore.validResult(score)||!score.available)fail('food_description_unsupported');
 // A component's generic source is not proof of hidden whole plants in a dish.
 const plantRows=root.NudgeComposition.namedComponentPlants(components)||[],plants=[...new Set(plantRows.map(p=>p.name))];
 const snapshot=Object.fromEntries(root.NudgeComposition.keys.map(key=>{const n=total[key],known=typeof n.value==='number';return [key,{per100:known?n.value*100/grams:null,portion:known?n.value:null,unit:key==='energyKcal'?'kcal':'g',per100Status:known?'calculated':'unknown',portionStatus:known?'calculated':n.knownContributions>0?'partial':'unknown',estimated:true,source:'typed_food_estimate',relation:'approx',...(n.unknownContributions>0&&n.knownContributions>0?{knownPortionSubtotal:n.knownSubtotal,knownContributions:n.knownContributions,unknownContributions:n.unknownContributions}:{}),...(n.carbohydrateDefinition?{carbohydrateDefinition:n.carbohydrateDefinition}:{})}];}));
 const assumptions=[...new Set(['Estimated from your description and generic food-composition records. Check ingredients and amounts before adding.',...components.flatMap(c=>c.assumptions)])];
 const typedFood={version:1,analysisVersion:VERSION,description:request.description,method,name:displayName,components:proof,assumptions,excluded:ctx.excluded};
 const entry={name:displayName,day:'',slot:'',portions:1,portionAmount:grams,portionUnit:'g',plants,ferments:[],recipe:'',ingredients:{text:components.map(c=>c.name).join(', '),plants:plantRows.map(p=>({name:p.name,evidence:p.evidence||p.name})),needsReview:true},nutritionSnapshot:snapshot,energyPerPortion:snapshot.energyKcal.portion,proteinPerPortion:snapshot.protein.portion,fibrePerPortion:snapshot.fibre.portion,nutritionStatus:Object.values(snapshot).every(n=>n.portion!==null)?'complete':'incomplete',source:'Estimated from your food description',sourceMeta:{typedFood,confirmationId:request.requestId,provider:'Official food-composition references; estimated food selection and amount',mealComposition:components,compositionVersion:VERSION,nutritionEstimate:'text',mealScore:score}};
 return {version:1,analysisVersion:VERSION,requestId:request.requestId,estimated:true,entry,warnings:assumptions};
}
function localTextFood(raw){
 const request=validateRequest(raw),ctx=context(request.description);if(ctx.vegan||ctx.glutenFree||/\b(?:or|either|maybe|might|possibly|raw|uncooked|dry rice|sugar free|low fat|reduced fat|skimmed yogurt|fried|vegan|dairy free|gluten free)\b/.test(ctx.active))return null;
 const parts=[];let active=ctx.active.replace(/\b(one|two|three|four|half)\b/g,w=>({one:'1',two:'2',three:'3',four:'4',half:'0.5'}[w])).replace(/[.!]$/,'').trim();
 const sandwich=active.match(/^(?:(\d+(?:\.\d+)?)\s+)?(?:a\s+)?(?:(sourdough|white|wholemeal)\s+)?(?:cheddar\s+)?cheese sandwich(?:\s+(?:with|and)\s+(.+))?$/);
 if(sandwich){const count=Number(sandwich[1]||1);if(count<=0||count>6)fail('food_amount_too_large');
  for(const [name,g] of [[sandwich[2]==='sourdough'?'sourdough':sandwich[2]==='wholemeal'?'wholemeal bread':'white bread',80],['cheese',30]]){const f=foodFor(name);parts.push({name:f[0],sourceId:f[1],amountGrams:g*count,evidence:request.description,assumption:`Estimated ${g*count} g ${f[0]}. ${f[4]}`});}
  active=sandwich[3]||'';
 }
 if(active)for(let clause of active.split(/\s+(?:with|and|plus)\s+|[,;+]/).map(s=>s.trim()).filter(Boolean)){
  clause=clause.replace(/^(?:a|an|some)\s+/,'');
  const m=clause.match(/^(?:(\d+(?:\.\d+)?)\s*(kg|g|grams?|ml|slices?|pieces?|eggs?|teaspoons?|tsp|tablespoons?|tbsp)?\s*(?:of\s+)?)?(.+)$/);
  if(!m)return null;const f=foodFor(m[3]);if(!f)return null;
  let amount=Number(m[1]||1),unit=m[2]||'',g=f[2]*amount;
  if(unit==='kg')g=amount*1000;else if(/^(g|gram|grams)$/.test(unit))g=amount;else if(unit==='ml'){if(!/milk|coffee|tea/.test(f[0]))return null;g=amount;}else if(/^(tbsp|tablespoon|tablespoons)$/.test(unit)){if(!/oil|butter|chutney/.test(f[0]))return null;g=amount*15;}else if(/^(tsp|teaspoon|teaspoons)$/.test(unit)){if(!/oil|butter|chutney/.test(f[0]))return null;g=amount*5;}else if(/^slice/.test(unit)&&!/bread|sourdough/.test(f[0]))return null;else if(/^egg/.test(unit)&&f[0]!=='boiled egg')return null;else if(/^piece/.test(unit)&&!['banana','apple','boiled egg'].includes(f[0]))return null;
  if(!Number.isFinite(g)||g<.1||g>1500)fail('food_amount_too_large');
  const evidence=request.description.toLowerCase().includes(clause)?request.description.slice(request.description.toLowerCase().indexOf(clause),request.description.toLowerCase().indexOf(clause)+clause.length):request.description;
  parts.push({name:f[0],sourceId:f[1],amountGrams:g,evidence,assumption:`${unit==='g'||unit==='kg'||/^gram/.test(unit)?'Entered':'Estimated'} ${g} g ${f[0]}. ${f[4]}`});
 }
 if(!parts.length)return null;
 try{return finish(request,{isFood:true,name:request.description.replace(/^i (?:had|ate)\s+/i,'').slice(0,100),components:parts},'local');}catch(e){if(e.code==='text_result_invalid'||e.code==='food_description_unsupported')return null;throw e;}
}
function validateResponse(body,raw){
 const request=validateRequest(raw),typed=body?.entry?.sourceMeta?.typedFood;
 if(!object(body)||body.version!==1||body.analysisVersion!==VERSION||body.requestId!==request.requestId||body.estimated!==true||!object(typed)||typed.version!==1||typed.analysisVersion!==VERSION||typed.description!==request.description||!['local','model'].includes(typed.method))fail('text_result_invalid');
 return finish(request,{isFood:true,name:typed.name,components:typed.components},typed.method);
}
const api=Object.freeze({VERSION,MAX_DESCRIPTION,validateRequest,candidates,finish,localTextFood,validateResponse});root.NudgeTextFood=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window==='object'?window:globalThis);
