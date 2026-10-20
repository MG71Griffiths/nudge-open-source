/* Pure search projections. Search/filtering never saves, logs intake or calls a service. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.NudgeSearchModel=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const version='nudge_search_v2';
  const scoreOptions=[0,25,50,75,100];
  const mealOptions={all:'Any meal',breakfast:'Breakfast',lunch:'Lunch',dinner:'Dinner',snack:'Snack',side:'Side'};
  const supportOptions={all:'No support filter',period:'Period',follicular:'Follicular',ovulation:'Ovulation',luteal:'Luteal',perimenopause:'Perimenopause',menopause:'Menopause'};
  const evidence={
    iron:'https://www.nhs.uk/conditions/vitamins-and-minerals/iron/',
    calcium:'https://www.nhs.uk/conditions/vitamins-and-minerals/calcium/',
    menopause:'https://www.nhs.uk/conditions/menopause-and-perimenopause/things-you-can-do/',
    general:'https://www.nhs.uk/live-well/eat-well/food-guidelines-and-food-labels/the-eatwell-guide/'
  };
  const text=(value,limit=500)=>typeof value==='string'?value.trim().slice(0,limit):'';
  const list=value=>Array.isArray(value)?value:[];
  const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  const own=(value,key)=>Object.prototype.hasOwnProperty.call(value||{},key);
  const plain=value=>text(value,4000).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  const unique=value=>[...new Set(value)];
  const aliases={garbanzo:'chickpea',chickpeas:'chickpea',chickpea:'chickpea',yogurt:'yoghurt',yogurts:'yoghurt',yoghurts:'yoghurt',eggplant:'aubergine',eggplants:'aubergine',aubergines:'aubergine',zucchini:'courgette',zucchinis:'courgette',courgettes:'courgette',cilantro:'coriander',soy:'soya',soybeans:'soya',soybean:'soya',chili:'chilli',chilies:'chilli',chillies:'chilli',houmous:'hummus',arugula:'rocket',scallion:'spring onion',scallions:'spring onion',dhal:'dal',dahl:'dal',oatmeal:'porridge',wholewheat:'wholemeal',onions:'onion',tomatoes:'tomato',lentils:'lentil',beans:'bean',oats:'oat',nuts:'nut',seeds:'seed',eggs:'egg',berries:'berry',peas:'pea',potatoes:'potato',carrots:'carrot',peppers:'pepper',fats:'fat',carbohydrates:'carbs',carbohydrate:'carbs'};
  function tokens(value){return plain(value).replace(/garbanzo beans?/g,'chickpea').replace(/bell peppers?/g,'pepper').split(' ').filter(Boolean).flatMap(word=>(aliases[word]||word).split(' '));}
  const canonical=value=>tokens(value).join(' ');
  const sourceURL=value=>{const url=text(value,2000);try{return /^https?:$/.test(new URL(url).protocol)?url:null;}catch{return null;}};
  const occasion=value=>{const key=plain(value);return ({snacks:'snack',sides:'side',supper:'dinner',evening:'dinner',brunch:'breakfast'})[key]||(own(mealOptions,key)&&key!=='all'?key:null);};
  const stage=value=>({menstrual:'period',menstruation:'period',ovulatory:'ovulation',peri:'perimenopause'})[plain(value)]||(own(supportOptions,plain(value))?plain(value):'all');
  function normalizeFilters(raw={}){
    raw=raw&&typeof raw==='object'?raw:{};
    const score=typeof raw.minimumScore==='string'&&/^\d{1,3}$/.test(raw.minimumScore)?Number(raw.minimumScore):raw.minimumScore;
    return {query:text(raw.query,160),minimumScore:scoreOptions.includes(score)?score:0,meal:'all',support:stage(raw.support),kind:['recipe','product'].includes(raw.kind)?raw.kind:'all'};
  }
  const quotedPattern=/"[^"]*"|“[^”]*”|‘[^’]*’|(?:^|\s)'[^']*'(?=\s|$)/g;
  function parseQuery(value,currentFilters={}){
    let query=text(value,300),filters=normalizeFilters(currentFilters),changed=false;
    // Quoted names may legitimately contain words such as Dinner or Products.
    // Preserve them before extracting only the user's unquoted filter request.
    const literals=[];let literalPrefix='NudgeQuotedLiteral';while(query.includes(literalPrefix))literalPrefix+='Q';
    query=query.replace(quotedPattern,part=>' '+literalPrefix+(literals.push(part.trim())-1)+' ');
    const take=(pattern,apply)=>{query=query.replace(pattern,(match,...groups)=>{changed=true;apply?.(match,groups);return ' ';});};
    // Explicit requests only: no age, sex, cycle dates or symptoms infer a stage.
    const stages=[['luteal',/\b(?:luteal(?:\s+phase)?|before\s+(?:(?:my|your|the)\s+)?period)\b/gi],['follicular',/\b(?:follicular(?:\s+phase)?|after\s+(?:(?:my|your|the)\s+)?period)\b/gi],['ovulation',/\b(?:ovulation|ovulatory)(?:\s+phase)?\b/gi],['perimenopause',/\b(?:perimenopause|perimenopausal|peri[ -]menopause)\b/gi],['menopause',/\b(?:menopause|menopausal)\b/gi],['period',/\b(?:period|menstrual(?:\s+phase)?)\b/gi]];
    let pickedStage=null;
    for(const [name,pattern]of stages)take(pattern,()=>{if(!pickedStage)pickedStage=name;});
    if(pickedStage)filters.support=pickedStage;
    const kinds=[];take(/\b(recipes?|products?)\b/gi,match=>kinds.push(/^recipe/i.test(match)?'recipe':'product'));
    if(kinds.length)filters.kind=unique(kinds).length===1?kinds[0]:'all';
    take(/\b(?:nudge\s+)?(?:rating|score|minimum|at\s+least)\s*(100|75|50|25|0)(?!\d)\s*%?\s*\+?/gi,(_,groups)=>{filters.minimumScore=Number(groups[0]);});
    take(/\b(100|75|50|25|0)\s*%\s*\+?/g,(_,groups)=>{filters.minimumScore=Number(groups[0]);});
    // Meal names are ordinary food search terms, never hidden occasion filters.
    if(changed)query=query.replace(/\b(?:i\s+am|i['’]m)\s+looking\s+for\b/gi,' ').replace(/\b(?:which|show|find|me|please|with|a|an|the|that|are|for|my|your|support|supports|supporting|phase|stage|cycle|rating|score|nudge|and|or|more|above|at|least)\b/gi,' ');
    query=query.replace(new RegExp(literalPrefix+'([0-9]+)','g'),(_,index)=>literals[Number(index)]||'').replace(/\s+/g,' ').trim();filters={...filters,query};
    return {query,filters};
  }
  function foodQuery(value){
    // Only the food query goes to catalogue providers; selected support filters stay local.
    return parseQuery(value).query.replace(/\b(?:pms|pmdd|menstrual|menstruation|periods?|follicular|ovulat\w*|luteal|peri[ -]?menopaus\w*|menopaus\w*|hormon\w*|cramps?|bloating|pregnan\w*|breastfeed\w*|postpartum)\b/gi,' ').replace(/\s+/g,' ').trim().slice(0,120);
  }
  // Whole-word food equivalents, not edits to arbitrary product/brand names. British
  // and American spellings are equally valid. An alternative is a bounded fallback
  // for a provider's zero-result response, never a second request while typing.
  const providerAliases={yogurt:'yoghurt',yogurts:'yoghurt',yoghurts:'yoghurt',garbanzo:'chickpeas',garbanzos:'chickpeas',eggplant:'aubergine',eggplants:'aubergines',zucchini:'courgette',zucchinis:'courgettes',cilantro:'coriander',soy:'soya',chili:'chilli',chilies:'chillies',dhal:'dal',dahl:'dal',wholewheat:'wholemeal',houmous:'hummus',arugula:'rocket'};
  const providerAlternatives={yoghurt:'yogurt',chickpeas:'garbanzo',aubergine:'eggplant',aubergines:'eggplants',courgette:'zucchini',courgettes:'zucchinis',coriander:'cilantro',soya:'soy',chilli:'chili',chillies:'chilies',dal:'dhal',wholemeal:'wholewheat',hummus:'houmous',rocket:'arugula'};
  const foodSpellings=unique(('yoghurt yogurt yoghurts yogurts chickpea chickpeas garbanzo garbanzos aubergine aubergines eggplant eggplants courgette courgettes zucchini zucchinis coriander cilantro cauliflower broccoli spinach lentil lentils chicken salmon sardine sardines mackerel turkey potato potatoes tomato tomatoes carrot carrots pepper peppers cucumber courgette cabbage cabbage lettuce asparagus avocado avocados beetroot mushroom mushrooms quinoa porridge oatmeal cereal cereals granola almond almonds walnut walnuts hazelnut hazelnuts peanut peanuts pistachio pistachios cashew cashews butter cheese cheddar mozzarella parmesan ricotta cottage milk soya soybean soybeans tofu tempeh hummus houmous tahini coconut banana bananas apple apples orange oranges berries blueberry blueberries strawberry strawberries raspberry raspberries blackberry blackberries peach peaches apricot apricots pineapple watermelon chocolate chickpea chickpeas couscous spaghetti macaroni pasta noodles wholemeal wholewheat flour bread sourdough sesame pumpkin sunflower lentils beans lentil raisin raisins').split(' '));
  function oneEdit(a,b){
    if(a===b)return 0;
    if(Math.abs(a.length-b.length)>1)return 2;
    if(a.length===b.length){const different=[];for(let i=0;i<a.length;i++)if(a[i]!==b[i])different.push(i);return different.length===1||different.length===2&&different[1]===different[0]+1&&a[different[0]]===b[different[1]]&&a[different[1]]===b[different[0]]?1:2;}
    const short=a.length<b.length?a:b,long=a.length<b.length?b:a;let i=0;while(i<short.length&&short[i]===long[i])i++;return short.slice(i)===long.slice(i+1)?1:2;
  }
  function correctedFood(word){
    // Short words are too ambiguous (rice/rye, nut/oat, brands); exact recognised
    // words are never rewritten. Only one edit or adjacent transposition is allowed.
    if(word.length<6||foodSpellings.includes(word)||own(aliases,word))return null;
    const candidates=foodSpellings.filter(candidate=>oneEdit(word,candidate)===1);
    if(unique(candidates.map(canonical)).length!==1)return null;
    return candidates.sort((a,b)=>Math.abs(a.length-word.length)-Math.abs(b.length-word.length)||a.localeCompare(b))[0]||null;
  }
  function mapUnquoted(value,replace){
    return value.replace(/"[^"]*"|“[^”]*”|‘[^’]*’|(?:^|\s)'[^']*'(?=\s|$)|\b[A-Za-z]+\b/g,part=>/^["“‘']/.test(part.trim())?part:replace(part));
  }
  function prepareQuery(value,options={}){
    const original=foodQuery(value),preserved=new Set(list(options.preserveTerms).flatMap(value=>plain(value).split(' '))),corrections=[];
    const query=mapUnquoted(original,part=>{
      const word=part.toLowerCase();if(preserved.has(word))return part;
      const spelling=options.correctTypos===false?null:correctedFood(word),known=spelling||word,replacement=providerAliases[known]||known;
      if(replacement===word)return part;
      corrections.push({from:part,to:replacement,kind:spelling?'spelling':'alias'});return replacement;
    }).replace(/\bgarbanzo\s+beans?\b/gi,'chickpeas').replace(/\bchickpeas\s+beans?\b/gi,'chickpeas');
    const alternate=mapUnquoted(query,part=>preserved.has(part.toLowerCase())?part:providerAlternatives[part.toLowerCase()]||part);
    const alternatives=unique([...(corrections.some(x=>x.kind==='spelling')?[original]:[]),alternate]).filter(q=>q&&q.toLowerCase()!==query.toLowerCase()).slice(0,2);
    const changed=query!==original,spelling=corrections.some(x=>x.kind==='spelling');
    const message=spelling?'Showing matches for “'+query+'” (spelling corrected).':corrections.length?'Equivalent food names are included: “'+original+'” and “'+query+'”.':'';
    return {query,providerQuery:query,original,alternatives,corrections,changed,message};
  }
  function providerQuery(value){return prepareQuery(value).providerQuery;}
  const mealCategoryRules=[
    {tags:['breakfast-cereals','porridges','porridge','oat-flakes','mueslis','granolas','rolled-oats'],meals:['breakfast'],role:'ingredient'},
    {tags:['breakfasts','prepared-breakfasts'],meals:['breakfast'],role:'meal'},
    {tags:['prepared-meals','ready-meals','meals','pizzas','soups','sandwiches','wraps','salads'],meals:['lunch','dinner'],role:'meal'},
    {tags:['legumes','pulses','chickpeas','canned-chickpeas','lentils','beans','canned-beans','canned-legumes','tofu','tempeh','vegetables','canned-vegetables','frozen-vegetables','rice','rices','pastas','pasta','quinoa','potatoes'],meals:['lunch','dinner','side'],role:'ingredient'},
    {tags:['fish','fishes','salmon','tuna','meat','meats','poultry','chicken','eggs','cheeses','cheese'],meals:['lunch','dinner'],role:'ingredient'},
    {tags:['yogurts','yoghurts','milk','milks','plant-milks','plant-based-milk-substitutes','fruits','fresh-fruits','nuts','seeds'],meals:['breakfast','snack'],role:'ingredient'},
    {tags:['snacks','fruit-snacks','yogurt-snacks'],meals:['snack'],role:'occasion'}
  ];
  function categoryMeals(raw){
    const tags=unique([raw.categoryTag,...list(raw.categories)].map(x=>text(x).toLowerCase().replace(/^en:/,'')).filter(Boolean));
    return mealCategoryRules.flatMap(rule=>{const matched=rule.tags.filter(tag=>tags.includes(tag));return matched.length?rule.meals.map(meal=>({meal,role:rule.role,basis:'category:'+matched[0]})):[];});
  }
  function productServing(raw){
    const amount=raw.servingAmount,unit=raw.servingUnit,preparation=raw.nutritionPreparation;
    const compatible=finite(amount)&&amount>0&&amount<=5000&&['g','ml'].includes(unit)&&unit===raw.basisUnit&&['as_sold','prepared'].includes(preparation)&&(raw.servingPreparation?raw.servingPreparation===preparation:preparation==='as_sold');
    return {known:compatible,amount:compatible?amount:null,unit:compatible?unit:null,description:compatible?text(raw.servingDescription||raw.servingLabel)||amount+' '+unit:null,preparation:compatible?preparation:null};
  }
  function nutrient(raw,key,kind,serving){
    const empty={value:null,unit:'mg',known:false,sourceURL:null,evidence:'unknown',basis:'per_serving'};
    const exact=item=>!item?.relation||['=','eq'].includes(item.relation);
    if(kind==='recipe'){
      const item=raw.nutrition?.perServing?.[key];
      if(raw.nutrition?.basis!=='per_serving'||!item||item.complete!==true||!['calculated','supplied','verified'].includes(item.status)||!finite(item.value)||!exact(item)||['N','Tr'].includes(item.marker))return empty;
      const url=sourceURL(item.sourceURL),unit=item.unit;
      if(!url||!['mg','g','µg','ug','mcg'].includes(unit))return empty;
      return {value:item.value*(unit==='g'?1000:['µg','ug','mcg'].includes(unit)?.001:1),unit:'mg',known:true,sourceURL:url,evidence:item.status==='calculated'?'ingredient_calculation':'source_reported',basis:'per_serving'};
    }
    const item=raw.micronutrients?.[key],url=sourceURL(item?.sourceURL||raw.sourceURL);
    const nutritionWarning=list(raw.dataQualityWarnings).some(warning=>/nutrition|nutrient|iron|calcium|energy|salt|sodium|sugar|fat|protein|carbohydrate|fibre|fiber|serving|quantity/i.test(text(warning)));
    if(!serving.known||!item||nutritionWarning||!['supplied','verified'].includes(item.status)||!finite(item.value)||!exact(item)||item.unit!=='mg'||!url||item.complete===false||['N','Tr'].includes(item.marker))return empty;
    return {value:item.value*serving.amount/100,unit:'mg',known:true,sourceURL:url,evidence:'source_reported',basis:'per_serving'};
  }
  function normalize(raw,options={}){
    if(!raw||typeof raw!=='object')return null;
    if(raw.searchVersion===version&&raw.raw&&Object.keys(options).length===0)return raw;
    const kind=options.kind||raw.kind||(raw.barcode?'product':'recipe'),name=text(raw.name||raw.title,160);
    if(!['recipe','product'].includes(kind)||!name)return null;
    const brand=text(raw.brand,100),id=text(kind==='product'?raw.barcode||raw.id||raw.productId:raw.id,120)||canonical([name,brand,raw.packSize].filter(Boolean).join(' '));
    // A supplied override must be the caller's existing Nudge engine result. Never convert third-party grades.
    const result=own(options,'score')?options.score:raw.nudgeScore,scoreValue=typeof result==='number'?result:result?.available===false||['unrated','unavailable','historical'].includes(result?.status)?null:result?.value;
    const score=finite(scoreValue)&&scoreValue<=100?scoreValue:null;
    const declared=unique(list(options.mealTypes||raw.mealTypes||[raw.category]).map(occasion).filter(Boolean));
    const inferred=kind==='product'?categoryMeals(raw):[];
    const meals=[...declared.map(meal=>({meal,role:kind==='recipe'?'meal':'occasion',basis:'declared'})),...inferred];
    const ingredients=typeof raw.ingredients==='string'?raw.ingredients:list(raw.ingredients).map(item=>Array.isArray(item)?item[2]:item?.name||item?.label).filter(Boolean).join(' ');
    const keywords=[name,brand,ingredients,...list(raw.keywords),...list(raw.plants),...list(raw.categories).map(x=>text(x).replace(/^en:/,'').replace(/-/g,' '))].filter(Boolean).join(' ');
    const serving=kind==='product'?productServing(raw):{known:raw.nutrition?.basis==='per_serving',amount:1,unit:'serving',description:'1 standard serving',preparation:null};
    const contains=unique([...list(raw.allergenTags),...list(raw.allergenCodes),...list(Array.isArray(raw.allergens)?raw.allergens:raw.allergens?.contains)].map(x=>plain(x).replace(/^en /,'')));
    const traces=unique(list(raw.traces||raw.allergens?.mayContain).map(x=>plain(x).replace(/^en /,'')));
    const allergyStatus=raw.allergensKnown===true||raw.allergens?.status==='known'?'label_check':'unknown';
    return {searchVersion:version,id,key:kind+':'+id,kind,name,brand,score,mealTypes:unique(meals.map(x=>x.meal)),meals,serving,nutrients:{iron:nutrient(raw,'iron',kind,serving),calcium:nutrient(raw,'calcium',kind,serving)},allergyStatus,allergens:contains,traces,searchText:canonical(keywords),raw};
  }
  function mealMatch(record,value='all'){
    const item=normalize(record),meal=occasion(value);
    if(!item)return {matches:false,role:null,reason:'No food record',basis:null};
    if(!meal)return {matches:true,role:null,reason:null,basis:null};
    const match=item.meals.find(x=>x.meal===meal);
    return match?{matches:true,...match,reason:mealOptions[meal]+(match.role==='ingredient'?' ingredient':match.role==='meal'?' meal':' option')}:{matches:false,role:null,reason:'Meal occasion not established',basis:null};
  }
  function supportMatch(record,value='all'){
    const item=normalize(record),support=stage(value);
    if(!item)return {matches:false,reason:'No food record',rule:null,evidenceURL:null};
    if(support==='all')return {matches:true,reason:null,rule:null,evidenceURL:null};
    if(['follicular','ovulation'].includes(support))return {matches:true,reason:'Every-stage food option; no phase-specific nutrient requirement.',rule:'nudge_general_food_v1',evidenceURL:evidence.general};
    const key=support==='period'?'iron':'calcium',minimum=key==='iron'?2.1:200,fact=item.nutrients[key];
    const rule='nudge_editorial_'+key+'_'+String(minimum).replace('.','_')+'_mg_per_serving_v1';
    const matches=fact.known&&fact.value>=minimum;
    return {matches,reason:fact.known?Number(fact.value.toFixed(2))+' mg '+key+' per '+(item.kind==='product'?item.serving.description:'standard serving')+'.':key[0].toUpperCase()+key.slice(1)+' per serving is not established.',rule,nutrient:key,amount:fact.value,unit:'mg',minimum,basis:fact.basis,sourceURL:fact.sourceURL,evidenceLevel:fact.evidence,evidenceURL:support==='period'?evidence.iron:['perimenopause','menopause'].includes(support)?evidence.menopause:evidence.calcium,detail:'Nudge editorial food selection, not a treatment dose or evidence of a phase-specific effect.'};
  }
  const allergyAliases={dairy:'milk',soya:'soy',soybeans:'soy',egg:'eggs',peanut:'peanuts',tree_nuts:'nuts',almond:'nuts',almonds:'nuts',walnut:'nuts',walnuts:'nuts',hazelnut:'nuts',hazelnuts:'nuts',cashew:'nuts',cashews:'nuts',pecan:'nuts',pecans:'nuts',pistachio:'nuts',pistachios:'nuts',macadamia:'nuts',macadamias:'nuts',brazil_nuts:'nuts',wheat:'gluten',barley:'gluten',rye:'gluten',spelt:'gluten',salmon:'fish',tuna:'fish',cod:'fish',haddock:'fish'};
  const allergen=value=>{const name=plain(value).replace(/^en /,'').replace(/ /g,'_');return allergyAliases[name]||name;};
  const allergenName=value=>({soy:'soya',nuts:'nuts (including peanuts)',eggs:'egg'}[value]||value.replace(/_/g,' '));
  function safety(record,requirements={}){
    const item=normalize(record);if(!item)return {matches:false,status:'unknown',reason:'No food record'};
    const avoids=unique([...list(requirements.excludedAllergens),...list(requirements.allergies),...list(requirements.avoids),...(['coeliac','sensitivity'].includes(requirements.glutenRequirement)||requirements.glutenFreePreference?['gluten']:[]),...(requirements.avoidMilk?['milk']:[])].map(allergen));
    const declared=[...item.allergens,...item.traces].map(allergen),conflicts=avoids.filter(x=>declared.includes(x)||(x==='nuts'&&declared.includes('peanuts')));
    if(conflicts.length){const contains=item.allergens.map(allergen),direct=conflicts.filter(x=>contains.includes(x)||x==='nuts'&&contains.includes('peanuts')),possible=conflicts.filter(x=>!direct.includes(x));return {matches:false,status:'conflict',conflicts,reason:[direct.length?'Contains '+direct.map(allergenName).join(', ')+'.':'',possible.length?'May contain '+possible.map(allergenName).join(', ')+'.':''].filter(Boolean).join(' ')};}
    if(item.kind==='recipe'){
      const glutenPreparationVerified=item.raw.dietary?.coeliac_suitable_confirmed===true||item.raw.importedRecord?.dietary?.coeliac_suitable_confirmed===true;
      if(['coeliac','sensitivity'].includes(requirements.glutenRequirement)&&!glutenPreparationVerified)return {matches:false,status:'unknown',conflicts:[],reason:'Gluten-free ingredient and preparation evidence is missing.'};
      const diet=requirements.diet,tags=list(item.raw.dietaryTags),dietKnown=!['vegan','vegetarian','pescatarian'].includes(diet)||tags.includes(diet)||tags.includes('vegan')||diet==='pescatarian'&&tags.includes('vegetarian');
      const dietConflicts=item.allergens.map(allergen).filter(a=>(diet==='vegan'?['milk','eggs','fish','crustaceans','molluscs']:diet==='vegetarian'?['fish','crustaceans','molluscs']:[]).includes(a));
      if(dietConflicts.length)return {matches:false,status:'conflict',conflicts:dietConflicts,reason:'Contains '+dietConflicts.map(allergenName).join(', ')+'; does not match your '+diet+' setting.'};
      if(!dietKnown)return {matches:false,status:'unknown',conflicts:[],reason:'This recipe is not verified as '+diet+'.'};
    }
    // An absent declaration never establishes allergy safety. Existing product checks may narrow further.
    if(avoids.length||requirements.requireKnownAllergens)return {matches:item.allergyStatus!=='unknown',status:item.allergyStatus,conflicts:[],reason:item.allergyStatus==='unknown'?(['coeliac','sensitivity'].includes(requirements.glutenRequirement)?(item.kind==='recipe'?'Gluten-free ingredient and preparation evidence is missing.':'Gluten and cross-contact information is incomplete.'):(avoids.length?avoids.map(allergenName).join(', ')+' and cross-contact information is incomplete.':'Allergen and cross-contact information is incomplete.')):'Check the current label and preparation'};
    return {matches:true,status:item.allergyStatus,conflicts:[],reason:'Check the current label and preparation'};
  }
  function queryMatch(item,query){
    const haystack=item.searchText.split(' '),test=needle=>needle.every((word,index)=>haystack.some(candidate=>candidate===word||(index===needle.length-1&&word.length>=4&&candidate.startsWith(word))));
    // Keep exact brand/product matches even when a food-shaped typo has a useful
    // correction. Corrections broaden matching; they do not replace exact results.
    const corrected=prepareQuery(query).query;return test(tokens(query))||Boolean(corrected)&&test(tokens(corrected));
  }
  function matches(record,rawFilters={},requirements={}){
    const item=normalize(record),f=normalizeFilters(rawFilters);
    return Boolean(item&&(f.kind==='all'||item.kind===f.kind)&&(f.minimumScore===0||item.score!==null&&item.score>=f.minimumScore)&&mealMatch(item,f.meal).matches&&supportMatch(item,f.support).matches&&safety(item,requirements).matches&&queryMatch(item,f.query));
  }
  function relevance(item,query){const name=canonical(item.name),q=canonical(query);return !q?0:name===q?4:name.startsWith(q)?3:name.includes(q)?2:1;}
  function filter(records,rawFilters={},requirements={}){
    const f=normalizeFilters(rawFilters),seen=new Set();
    return list(records).map(x=>normalize(x)).filter(item=>item&&!seen.has(item.key)&&matches(item,f,requirements)&&seen.add(item.key)).map((item,index)=>({item,index,rank:relevance(item,f.query)})).sort((a,b)=>b.rank-a.rank||(b.item.score??-1)-(a.item.score??-1)||a.index-b.index).map(x=>x.item);
  }
  // Editorial food names are query shortcuts, never claims that matching products exist,
  // meet a nutrient threshold or are safe for a person's dietary requirements.
  const commonQueries=[
    {name:'Chickpeas',keywords:'garbanzo beans',diet:'vegan'},
    {name:'Lentils',diet:'vegan'},
    {name:'Eggs',allergens:['eggs'],diet:'vegetarian'},
    {name:'Yoghurt',keywords:'yogurt',allergens:['milk'],diet:'vegetarian'},
    {name:'Oats',keywords:'oatmeal porridge',allergens:['gluten'],diet:'vegan'},
    {name:'Tofu',keywords:'soya soy bean curd',allergens:['soy'],diet:'vegan'},
    {name:'Brown rice',diet:'vegan'},
    {name:'Wholemeal pasta',keywords:'wholewheat pasta',allergens:['gluten'],diet:'vegan'},
    {name:'Broccoli',diet:'vegan'},
    {name:'Spinach',diet:'vegan'},
    {name:'Salmon',allergens:['fish'],diet:'pescatarian'},
    {name:'Chicken',diet:'mixed'},
    {name:'Walnuts',allergens:['nuts'],diet:'vegan'},
    {name:'Apples',diet:'vegan'}
  ];
  function queryAllowed(item,requirements={}){
    const avoids=unique([...list(requirements.excludedAllergens),...list(requirements.allergies),...list(requirements.avoids),...(['coeliac','sensitivity'].includes(requirements.glutenRequirement)||requirements.glutenFreePreference?['gluten']:[]),...(requirements.avoidMilk?['milk']:[])].map(allergen));
    if(list(item.allergens).some(key=>avoids.includes(key)))return false;
    const diet=requirements.diet;
    return diet==='vegan'?item.diet==='vegan':diet==='vegetarian'?['vegan','vegetarian'].includes(item.diet):diet==='pescatarian'?item.diet!=='mixed':true;
  }
  function suggest(records,query,options={}){
    const q=text(query,160),limit=Math.max(0,Math.min(8,Number.isInteger(options.limit)?options.limit:6));
    if(tokens(q).join('').length<2||!limit)return [];
    const seen=new Set();
    const found=filter(records,{...normalizeFilters(options.filters),query:q},options.requirements).flatMap(item=>{
      const key=canonical(item.name);if(seen.has(key))return [];seen.add(key);
      return [{value:item.name,label:item.name,kind:item.kind,id:item.id,scope:item.kind==='recipe'?'Recipe':'Product'}];
    });
    const queryTokens=tokens(prepareQuery(q).query);
    const generic=commonQueries.filter(item=>queryTokens.length&&queryAllowed(item,options.requirements)&&queryTokens.every(word=>tokens(item.name+' '+(item.keywords||'')).some(token=>token===word||word.length>=2&&token.startsWith(word)))).flatMap(item=>{
      const key=canonical(item.name);if(seen.has(key))return [];seen.add(key);
      return [{value:item.name,label:item.name,kind:'query',id:'query:'+key,scope:'Suggested search'}];
    });
    return found.concat(generic).slice(0,limit);
  }
  return {version,scoreOptions,mealOptions,supportOptions,evidence,normalize,normalizeFilters,parseQuery,providerQuery,prepareQuery,canonical,tokens,matches,filter,suggest,mealMatch,supportMatch,safety};
});
