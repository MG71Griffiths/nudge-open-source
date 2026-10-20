const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const m=require('../Web/search-model.js');
const copy=x=>JSON.parse(JSON.stringify(x));
const sourceURL='https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid';
const fact=(value,unit='mg',more={})=>({value,unit,status:'calculated',complete:true,sourceURL,...more});
const recipe=(id,more={})=>({id,name:'Chickpea lunch bowl',category:'Lunch',mealTypes:['lunch'],ingredients:[[100,'g','chickpeas'],[20,'g','spinach']],nutrition:{basis:'per_serving',perServing:{iron:fact(2.1),calcium:fact(200)}},...more});
const product=(barcode,more={})=>({barcode,name:'Canned chickpeas',brand:'Example',categories:['en:canned-chickpeas'],basisUnit:'g',nutritionPreparation:'as_sold',servingAmount:120,servingUnit:'g',sourceURL:'https://world.openfoodfacts.org/product/'+barcode,micronutrients:{iron:{value:1.75,unit:'mg',status:'supplied'},calcium:{value:170,unit:'mg',status:'supplied'}},...more});
const r=m.normalize(recipe('r'),{kind:'recipe',score:75}),p=m.normalize(product('123456789'),{kind:'product',score:50});
assert.equal(r.score,75);assert.equal(p.score,50);assert.equal(p.nutrients.iron.value,2.1);assert.equal(p.nutrients.calcium.value,204);
assert.equal(m.normalize({id:'unrated',name:'Third-party100',score:100,nutriScoreGrade:'a'}).score,null,'Only an explicit Nudge result can drive score filters');
assert.equal(m.normalize({...recipe('old'),nudgeScore:100},{score:null}).score,null,'Explicit unrated override wins');
for(const score of [{value:100,available:false},{value:100,status:'unrated'},{value:100,status:'historical'}])assert.equal(m.normalize(recipe('not-current'),{score}).score,null,'An unavailable or historical result cannot satisfy current rating filters');
for(const invalid of ['75',Infinity,-1,101,NaN])assert.equal(m.normalize(recipe('invalid'),{score:invalid}).score,null);
for(const minimumScore of m.scoreOptions)assert.equal(m.matches(r,{minimumScore}),minimumScore<=75);
assert(m.matches(m.normalize(recipe('unknown')),{minimumScore:0}));assert(!m.matches(m.normalize(recipe('unknown')),{minimumScore:25}));
assert.equal(m.supportMatch(r,'period').matches,true);assert.equal(m.supportMatch(r,'luteal').matches,true);assert.equal(m.supportMatch(p,'period').matches,true);assert.equal(m.supportMatch(p,'perimenopause').matches,true);assert.equal(m.supportMatch(p,'menopause').matches,true);
assert.equal(m.supportMatch(r,'period').minimum,2.1);assert.equal(m.supportMatch(r,'luteal').minimum,200);assert.match(m.supportMatch(r,'period').detail,/not a treatment/);
for(const support of ['follicular','ovulation']){const general=m.supportMatch(m.normalize(recipe('unknown',{nutrition:null})),support);assert.equal(general.matches,true);assert.match(general.reason,/no phase-specific/);}
assert.equal(m.supportMatch(m.normalize({id:'title',name:'Menopause iron hormone balance calcium cure'}),'luteal').matches,false,'Titles are not nutrient evidence');
for(const extra of [{nutrition:null},{nutrition:{basis:'per_100g',perServing:{iron:fact(90)}}},{nutrition:{basis:'per_serving',perServing:{iron:fact(2.09)}}},{nutrition:{basis:'per_serving',perServing:{iron:fact(null)}}},{nutrition:{basis:'per_serving',perServing:{iron:fact(8,'mg',{complete:false})}}},{nutrition:{basis:'per_serving',perServing:{iron:fact(8,'mg',{status:'estimated'})}}},{nutrition:{basis:'per_serving',perServing:{iron:fact(8,'mg',{sourceURL:null})}}},{nutrition:{basis:'per_serving',perServing:{iron:fact(8,'mg',{sourceURL:'javascript:alert(1)'})}}},{nutrition:{basis:'per_serving',perServing:{iron:fact(8,'mg',{marker:'N'})}}}])assert.equal(m.supportMatch(m.normalize(recipe('missing',extra)),'period').matches,false);
assert.equal(m.supportMatch(m.normalize(recipe('grams',{nutrition:{basis:'per_serving',perServing:{iron:fact(.0021,'g')}}})),'period').matches,true);
assert.equal(m.supportMatch(m.normalize(recipe('micrograms',{nutrition:{basis:'per_serving',perServing:{iron:fact(2100,'µg')}}})),'period').matches,true);
for(const extra of [{servingAmount:null},{servingAmount:0},{servingAmount:'120'},{servingAmount:Infinity},{servingUnit:'ml'},{basisUnit:'unknown'},{nutritionPreparation:'unknown'},{nutritionPreparation:'prepared'},{servingPreparation:'prepared'},{micronutrients:{iron:{value:10,unit:'mg',status:'estimated'}}},{micronutrients:{iron:{value:10,unit:'g',status:'supplied'}}},{sourceURL:''}])assert.equal(m.supportMatch(m.normalize(product('bad',extra)),'period').matches,false,'Unknown/incompatible per-serving evidence must not match');
assert.equal(m.supportMatch(m.normalize(product('prepared',{nutritionPreparation:'prepared',servingPreparation:'prepared'})),'period').matches,true);
assert.equal(m.supportMatch(m.normalize(product('fluid',{basisUnit:'ml',servingUnit:'ml'})),'period').matches,true);
for(const relation of ['<','lt','lte','>','gt','gte','approximately'])assert.equal(m.supportMatch(m.normalize(product('bounded',{micronutrients:{iron:{value:10,unit:'mg',status:'supplied',relation}}})),'period').matches,false,'A bounded nutrient is not an exact threshold match');
for(const relation of [undefined,'=','eq'])assert.equal(m.supportMatch(m.normalize(product('exact',{micronutrients:{iron:{value:1.75,unit:'mg',status:'supplied',relation}}})),'period').matches,true);
assert.equal(m.supportMatch(m.normalize(product('warning',{dataQualityWarnings:['en:nutrition-value-over-100']})),'period').matches,false,'Questionable source nutrition cannot support a nutrient badge');
assert.equal(m.supportMatch(m.normalize(product('unrelated',{dataQualityWarnings:['en:missing-packaging-material']})),'period').matches,true,'An unrelated packaging warning does not discard established nutrient evidence');
assert.equal(m.mealMatch(p,'dinner').matches,true);assert.equal(m.mealMatch(p,'dinner').role,'ingredient');assert.match(m.mealMatch(p,'dinner').basis,/canned-chickpeas/);assert.equal(m.mealMatch(p,'breakfast').matches,false);
assert.equal(m.mealMatch(m.normalize(product('no-category',{categories:[],name:'Dinner miracle beans'})),'dinner').matches,false,'Meal ingredient mapping needs declared category, not guessed title');
assert.equal(m.mealMatch(m.normalize(product('ready',{categories:['en:ready-meals']})),'dinner').role,'meal');assert.equal(m.mealMatch(m.normalize(product('cereal',{categories:['en:breakfast-cereals']})),'breakfast').matches,true);
assert.equal(m.matches(p,{kind:'product',minimumScore:50,meal:'dinner',support:'perimenopause'}),true);
assert.equal(m.matches(p,{kind:'recipe',minimumScore:50,meal:'dinner',support:'perimenopause'}),false);
assert.equal(m.matches(p,{minimumScore:75,meal:'dinner',support:'perimenopause'}),false);
assert.equal(m.matches(p,{query:'garbanzo beans'}),true);assert.equal(m.matches(p,{query:'CHICKPEAS'}),true);assert.equal(m.matches(p,{query:'chick'}),true);assert.equal(m.matches(p,{query:'rice'}),false);
assert.equal(m.matches(m.normalize(recipe('aubergine',{name:'Aubergine & courgette yoghurt bowl'})),{query:'eggplant zucchini yogurt'}),true);
assert.equal(m.matches(m.normalize(recipe('rice',{name:'Liquorice',ingredients:[]})),{query:'rice'}),false,'No midword matches');
assert.equal(m.matches(m.normalize(recipe('peanut',{name:'Peanut bowl',ingredients:[]})),{query:'peas'}),false,'A pea search is not a peanut match');
assert.equal(m.matches(m.normalize(recipe('accent',{name:'Crème fraîche bowl'})),{query:'creme fraiche'}),true);
const unknown=m.normalize(recipe('allergens'));assert.equal(unknown.allergyStatus,'unknown');assert.equal(m.safety(unknown).status,'unknown');assert.equal(m.safety(unknown,{allergies:['milk']}).matches,false);
const declared=m.normalize(recipe('declared',{allergensKnown:true,allergenTags:['en:milk'],traces:['en:soy']}));assert.equal(m.safety(declared,{allergies:['milk']}).status,'conflict');assert.equal(m.safety(declared,{allergies:['soya']}).status,'conflict');assert.equal(m.safety(declared).status,'label_check','No catalogue result is labelled allergy safe');
assert.equal(m.matches(declared,{support:'luteal'},{allergies:['milk']}),false,'Cycle match never overrides allergy conflict');
assert.equal(m.safety(declared,{avoidMilk:true}).status,'conflict');
assert.equal(m.safety(m.normalize(recipe('nuts',{allergenCodes:['walnuts']})),{allergies:['nuts']}).status,'conflict');
assert.equal(m.safety(m.normalize(recipe('gluten',{allergenTags:['en:barley']})),{glutenFreePreference:true}).status,'conflict');
assert.equal(m.safety(m.normalize(recipe('peanuts',{allergenTags:['en:peanuts']})),{allergies:['nuts']}).status,'conflict','Nudge legacy Nuts requirement includes peanuts');
const parsed=m.parseQuery('products with rating75%+ support luteal phase');assert.deepEqual(parsed,{query:'',filters:{query:'',minimumScore:75,meal:'all',support:'luteal',kind:'product'}});
assert.deepEqual(m.parseQuery('products50%+ support perimenopause dinner').filters,{query:'products50%+ dinner',minimumScore:0,meal:'all',support:'perimenopause',kind:'all'},'Terms need word boundaries; malformed joined tokens are not silently accepted');
assert.deepEqual(m.parseQuery('products 50%+ support perimenopause dinner').filters,{query:'dinner',minimumScore:50,meal:'all',support:'perimenopause',kind:'product'});
for(const query of ['which products with rating 75%+ support luteal phase',"I'm looking for products with rating75%+ support luteal phase",'I am looking for products with rating75%+ support luteal phase'])assert.deepEqual(m.parseQuery(query).filters,{query:'',minimumScore:75,meal:'all',support:'luteal',kind:'product'});
assert.equal(m.parseQuery('garbanzo products 50%+ for menopause dinner').query,'garbanzo dinner');assert.equal(m.parseQuery('recipes before my period').filters.support,'luteal');assert.equal(m.parseQuery('recipes after my period').filters.support,'follicular');
assert.equal(m.parseQuery('beans',{support:'period',meal:'lunch',minimumScore:50}).filters.support,'period','Food query edits retain explicit filters');
assert.equal(m.parseQuery('55 year old female').filters.support,'all','No stage inferred from personal details');
assert.equal(m.parseQuery('products rating750').filters.minimumScore,0,'A malformed score cannot become a75%filter');
assert.equal(m.providerQuery('chickpeas products 50%+ support perimenopause dinner'),'chickpeas dinner');assert.equal(m.providerQuery('yoghurt for luteal phase'),'yoghurt');assert.doesNotMatch(m.providerQuery('calcium for PMS cramps and bloating'),/pms|cramp|bloat/i);
// Valid regional names and bounded spelling repairs use the same local/provider
// interpretation. A recovery query is data for one explicit zero-result fallback,
// never a network request or a fuzzy rewrite of arbitrary brand names.
assert.equal(m.providerQuery('Greek yogurt'),'Greek yoghurt');
assert.deepEqual(m.prepareQuery('Greek yogurt').alternatives,['Greek yogurt']);
assert.equal(m.prepareQuery('Greek yogurt').corrections[0].kind,'alias');
assert.match(m.prepareQuery('Greek yogurt').message,/Equivalent food names/);
assert.doesNotMatch(m.prepareQuery('Greek yogurt').message,/spelling corrected/);
for(const [typed,fixed]of [['yogrut','yoghurt'],['yougurt','yoghurt'],['chikpeas','chickpeas'],['chickpaes','chickpeas'],['brocoli','broccoli'],['salomn','salmon']]){
  const prepared=m.prepareQuery(typed);assert.equal(prepared.query,fixed,typed+' has a unique bounded food correction');assert(prepared.corrections.some(x=>x.kind==='spelling'));assert.match(prepared.message,/spelling corrected/);assert(prepared.alternatives.includes(typed),'The exact original query remains available when a word might be a brand');
}
assert.equal(m.prepareQuery('Alpro Greek yogrut').query,'Alpro Greek yoghurt');
assert.equal(m.prepareQuery('organic chikpeas in water').query,'organic chickpeas in water','Meaningful qualifiers and brands are retained');
assert.equal(m.prepareQuery('Garbanzos').query,'chickpeas');
assert.equal(m.prepareQuery('garbanzo beans').query,'chickpeas');
assert.equal(m.prepareQuery('ManiLife peanut butter').query,'ManiLife peanut butter','Arbitrary names are not corrected');
assert.equal(m.prepareQuery('rice oat nut egg').query,'rice oat nut egg','Short ambiguous food terms are not corrected');
assert.equal(m.prepareQuery('ygrt').query,'ygrt','Multiple edits are not guessed');
assert.equal(m.prepareQuery('cheese').query,'cheese','Recognised foods are never changed to a nearby word');
assert.equal(m.prepareQuery('"Yogurt Factory" yogrut').query,'"Yogurt Factory" yoghurt','Quoted brands remain literal');
assert.equal(m.prepareQuery('“Chikpeas Co” Greek yogurt').query,'“Chikpeas Co” Greek yoghurt','Curly quoted names remain literal');
assert.equal(m.prepareQuery("'Yogurt Factory' yogrut").query,"'Yogurt Factory' yoghurt",'Single quoted brands remain literal');
assert.deepEqual(m.parseQuery('"Dinner Products" yogurt 75%+').filters,{query:'"Dinner Products" yogurt',minimumScore:75,meal:'all',support:'all',kind:'all'},'Words inside quoted names do not become filters');
assert.equal(m.prepareQuery('"Dinner Products" yogurt').query,'"Dinner Products" yoghurt');
assert.equal(m.prepareQuery("Sainsbury's yogrut").query,"Sainsbury's yoghurt",'A brand apostrophe is not a quoted phrase');
assert.equal(m.prepareQuery('Salomn Greek yogrut',{preserveTerms:['Salomn']}).query,'Salomn Greek yoghurt','Known brand tokens are retained');
assert.equal(m.prepareQuery('chikpeas',{correctTypos:false}).query,'chikpeas');
assert.equal(m.prepareQuery('yogurt',{correctTypos:false}).query,'yoghurt','Disabling typo edits does not disable equivalent food names');
for(const value of ['yogurt for luteal phase','yogrut products 75%+ for menopause breakfast']){const prepared=m.prepareQuery(value);for(const q of [prepared.query,...prepared.alternatives])assert.doesNotMatch(q,/luteal|menopause|phase|75%/i,'Corrections and fallback queries do not reintroduce private filters');}
const yogurtUK=m.normalize(recipe('yogurtUK',{name:'Greek yoghurt',ingredients:[]})),yogurtUS=m.normalize(product('yogurtUS',{name:'Greek yogurt',categories:[]}));
for(const query of ['Greek yogurt','Greek yoghurt','Greek yogrut'])for(const item of [yogurtUK,yogurtUS])assert(m.matches(item,{query}),'Both valid spellings and the corrected typo match both result spellings');
assert(m.matches(p,{query:'chikpeas'}));assert(m.matches(p,{query:'chickpaes'}));
assert(!m.matches(p,{query:'hormones'}),'A sensitive-only input cannot turn into an empty local query that matches everything');
const exactTypoBrand=m.normalize(product('typo-brand',{name:'Salomn cheese',ingredients:'',categories:[]})),foodSalmon=m.normalize(product('salmon-food',{name:'Salmon fillet',ingredients:'',categories:[]}));
assert.deepEqual(m.filter([foodSalmon,exactTypoBrand],{query:'Salomn'}).map(x=>x.id),['typo-brand','salmon-food'],'An exact food-shaped brand result is retained and ranked ahead of its correction');
assert(!m.matches(foodSalmon,{query:'"Salomn"'}),'Quoted food-shaped brand names are not autocorrected');
for(const [query,label]of [['yogrut','Yoghurt'],['chikpeas','Chickpeas']])assert(m.suggest([],query).some(x=>x.label===label),'Local autocomplete also offers bounded corrections without API calls');
assert(!m.suggest([],'yogrut',{requirements:{avoidMilk:true}}).some(x=>x.label==='Yoghurt'),'Typo suggestions still respect dietary exclusions');
assert.equal(m.suggest([],'hormones').length,0,'A stripped non-food term does not become generic autocomplete for every food');
assert.equal(m.providerQuery('houmous'),'hummus');assert.equal(m.providerQuery('arugula'),'rocket');
assert(m.matches(m.normalize(recipe('onion',{name:'Spring onion salad',ingredients:[]})),{query:'scallions'}));
const records=[r,p,m.normalize(recipe('unknown',{name:'Chickpea ideas'})),m.normalize(recipe('second',{name:'Chickpea lunch bowl'}),{score:50}),p];
const before=JSON.stringify(records);assert.deepEqual(m.filter(records,{query:'chickpea'}).map(x=>x.id),['r','second','unknown','123456789']);assert.equal(m.filter(records,{minimumScore:75}).length,1);assert.equal(JSON.stringify(records),before,'Filtering never mutates input');
assert.equal(m.suggest(records,'c').length,0);const suggestions=m.suggest(records,'chic');assert.equal(suggestions.filter(x=>x.kind!=='query').length,3);assert.equal(unique(suggestions.map(x=>x.value)).length,suggestions.length);assert(suggestions.every(x=>['recipe','product','query'].includes(x.kind)));assert.equal(m.suggest(records,'chic',{filters:{minimumScore:75}}).filter(x=>x.kind!=='query').length,1);assert.equal(m.suggest(records,'chic',{limit:1}).length,1);
for(const [query,label]of [['tof','Tofu'],['len','Lentils'],['eg','Eggs'],['yogurt','Yoghurt'],['garbanzo','Chickpeas'],['porridge','Oats']])assert(m.suggest([],query).some(x=>x.kind==='query'&&x.label===label&&x.scope==='Suggested search'),'New food autocomplete is explicitly a query shortcut');
for(const [query,requirements]of [['yog',{avoidMilk:true}],['yog',{diet:'vegan'}],['tof',{allergies:['soy']}],['wal',{allergies:['nuts']}],['egg',{allergies:['eggs']}],['sal',{diet:'vegetarian'}],['chi',{diet:'pescatarian'}],['oat',{glutenFreePreference:true}]])assert(!m.suggest([],query,{requirements}).some(x=>['Yoghurt','Tofu','Walnuts','Eggs','Salmon','Chicken','Oats'].includes(x.label)),'Generic query shortcuts omit obvious requirement conflicts');
assert(m.suggest([],'chi',{filters:{minimumScore:100,support:'period',kind:'product'}}).every(x=>x.kind==='query'),'Queries do not claim an available result at the chosen rating or support threshold');
function unique(xs){return [...new Set(xs)];}
const browser={URL};browser.globalThis=browser;vm.createContext(browser);vm.runInContext(fs.readFileSync('Web/search-model.js','utf8'),browser);assert.equal(browser.NudgeSearchModel.version,m.version);
// Real imported records use exactly the same per-serving evidence adapter.
if(fs.existsSync('Web/recipe-catalogue-data.js')){const w={console,URL};w.window=w;w.globalThis=w;vm.createContext(w);for(const f of ['recipe-catalogue-data.js','recipe-catalogue.js'])vm.runInContext(fs.readFileSync('Web/'+f,'utf8'),w);for(const raw of w.NudgeRecipeCatalogue.all({includeDrafts:true})){const normalized=m.normalize(copy(raw),{kind:'recipe'});assert(normalized);for(const key of ['iron','calcium']){const original=raw.nutrition?.perServing?.[key];if(original?.value===null||original?.complete!==true)assert.equal(normalized.nutrients[key].known,false);}}
  for(const [id,period,luteal]of [['berry',true,true],['chickpea',false,false],['salmon',false,false],['nudge-crunchy-chickpea-bowl',true,false]]){const item=m.normalize(copy(w.NudgeRecipeCatalogue.byId(id)));assert.equal(m.supportMatch(item,'period').matches,period,id+' uses its actual sourced iron per serving');assert.equal(m.supportMatch(item,'luteal').matches,luteal,id+' uses its actual sourced calcium per serving');}
}
console.log('PASS: pure combined search, Nudge-score thresholds, explicit-stage parsing, food synonyms, local autocomplete, evidence-based support, serving preparation/unit guards, category-based meal ingredients and unknown allergy handling.');

assert.equal(m.safety(declared,{allergies:['milk','soy']}).reason,'Contains milk. May contain soya.');
assert.match(m.safety(unknown,{glutenRequirement:'coeliac'}).reason,/Gluten-free ingredient and preparation evidence is missing/);
assert.match(m.safety(unknown,{allergies:['milk']}).reason,/milk and cross-contact information is incomplete/);
assert.equal(m.safety(m.normalize(recipe('fish',{dietaryTags:['pescatarian']})),{diet:'vegan'}).matches,false);
assert.equal(m.safety(m.normalize(recipe('vegan',{dietaryTags:['vegan']})),{diet:'vegetarian'}).matches,true);
console.log('PASS: exact allergen/cross-contact reasons and consistent recipe dietary exclusions.');

for(const medical of ['coeliac','sensitivity']){
  const glutenRecipe=recipe('gluten-declaration',{allergensKnown:true,allergenCodes:[]});
  assert.equal(m.safety(m.normalize(glutenRecipe),{glutenRequirement:medical}).matches,false,'A known allergen list alone is not gluten-free preparation evidence');
  for(const flag of [false,'true',null])assert.equal(m.safety(m.normalize({...glutenRecipe,dietary:{coeliac_suitable_confirmed:flag}}),{glutenRequirement:medical}).matches,false);
  assert.equal(m.safety(m.normalize({...glutenRecipe,dietary:{coeliac_suitable_confirmed:true}}),{glutenRequirement:medical}).matches,true);
  assert.equal(m.safety(m.normalize({...glutenRecipe,allergenCodes:['wheat'],dietary:{coeliac_suitable_confirmed:true}}),{glutenRequirement:medical}).matches,false,'A claim cannot override a known conflict');
}

assert.equal(m.parseQuery('breakfast cereal').query,'breakfast cereal');
assert.equal(m.prepareQuery('breakfast cereal').query,'breakfast cereal');
assert.equal(m.normalizeFilters({meal:'dinner'}).meal,'all','Old occasion values cannot silently filter food search');
assert.equal(m.matches(p,{meal:'breakfast'}),true,'Removed occasion filter cannot hide a food');
