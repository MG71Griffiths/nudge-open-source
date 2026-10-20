/* Shared deterministic nutrient calculation. Loaded by WKWebView and the Worker.
 * Source: Santé publique France updated algorithm FAQ V11. Nudge transform is a
 * user-approved proposed-beta calibration, not an official Nutri-Score result.
 */
(function(root) {
'use strict';
// Promotion is explicit: shadow catalogue jobs use Directional before this
// switch changes the production/app contract. Both engines share the tables.
const ACTIVE_DIRECTIONAL=true;
function createScoreCore(DIRECTIONAL) {
const SCORE_METHOD=DIRECTIONAL?'nudge_nutrition_v0_4':'nudge_nutrition_v0_3', SCORE_VERSION=DIRECTIONAL?'0.4':'0.3', SCORE_PROMPT_VERSION=DIRECTIONAL?'nudge-label-evidence-7':'nudge-label-evidence-5', CLASSIFIER_VERSION=DIRECTIONAL?'food-evidence-2026-10-11-v16':'food-evidence-2026-10-09-v10';
const SCORE_SOURCE='https://www.santepubliquefrance.fr/sites/default/files/rdd/document/FAQ-updatedAlgo-V11.pdf';
const GRADE_SCORES=Object.freeze({A:100,B:75,C:50,D:25,E:0});
const CONFIG=Object.freeze({methodId:SCORE_METHOD,version:SCORE_VERSION,classifierVersion:CLASSIFIER_VERSION,status:DIRECTIONAL?'nudge_directional':'nutriscore_2023_with_nudge_display_conversion',baseAlgorithmVersion:'2023',gradeToScore:GRADE_SCORES,saltWeeklyGrams:2,saltMonthlyGrams:4});
const categories=['general','cheese','red_meat','fats_nuts_seeds','beverage','water','unsupported','unknown'];
const fields=['name','categoryTag','categories','categoriesTags','ingredients'];
const flagNames=['isBeverage','isCheese','isWater','isFatOilNutsSeeds','isRedMeatProduct','hasNonNutritiveSweeteners'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
class ScoreError extends Error { constructor(message='Unsupported product facts.',status=400,code='score_input_invalid'){super(message);this.status=status;this.code=code;} }
function exactValue(value,unit=null) {
  return value && (!unit || value.unit===unit) && ['supplied', 'confirmed'].includes(value.status) && (value.relation == null || ['eq', '='].includes(value.relation))
    && typeof value.value === 'number' && Number.isFinite(value.value) && value.value >= 0 ? value.value : null;
}
function fieldValues(product, field) { return Array.isArray(product[field]) ? product[field] : typeof product[field] === 'string' ? [product[field]] : []; }
const normalized = value => value.toLowerCase().replace(/^en:/, '').replace(/[-_]/g, ' ').trim();
// Dietary claims can qualify a known general food; they cannot establish a
// special profile (for example, vegan cheese is not evidence of dairy cheese).
// Organic alone is a neutral modifier on any supported whole-food identity.
// The remaining complete general-food name must still match. Organic is an
// identity modifier only: it never changes nutrients, points or plant percentage.
const categoryName = value => normalized(value).replace(/\s+/g,' ').replace(/^(?:(?:organic|gluten free|wheat free|dairy free|vegan|vegetarian)(?:\s+(?:&|and))?\s+)+/,'');
const categoryPatterns = {
  water: /^(?:(?:natural|still|sparkling|carbonated|mineral|spring|drinking) )*waters?$/,
  beverage: /^(?:(?:non alcoholic|carbonated|soft|energy|sports|dairy|fermented|milk based|milk|plant based|plant|soya|soy|almond|oat|rice|fruit|vegetable|apple|orange|coconut|skimmed|semi skimmed|whole|low fat|fat free|lactose free|flavoured|flavored|sweetened|unsweetened|plain|natural|protein|yogurt|yoghurt|sparkling|still) )*(?:beverages?|drinks?|milks?|juices?|sodas?|lemonades?|smoothies?|drinking yoghurts?|drinking yogurts?)$/,
  cheese: /^(?:(?:hard|soft|fresh|processed|cream|cottage|grated|cheddar|goat|sheep|blue|ripened|unripened) )*cheeses?$/,
  red_meat: /^(?:(?:fresh|frozen|raw|cooked|ground|minced|lean|unprocessed) )*(?:beef|pork|lamb|mutton|veal|venison|red meats?)$/,
  fats_nuts_seeds: /^(?:(?:roasted|salted|unsalted|raw|ground|pure|vegetable|olive|rapeseed|sunflower|coconut|sesame|peanut|groundnut|avocado|soybean|cooking|extra virgin|whipping|double|single|sour|dairy|plant) )*(?:oils?|fats?|creams?|butters?|margarines?|nuts?|seeds?|peanuts?|groundnuts?|almonds?|cashews?|hazelnuts?|walnuts?|pistachios?|pecans?)$/,
  general: /^(?:(?:organic|wholemeal|wholegrain|whole grain|white|brown|fresh|frozen|raw|cooked|dried|canned|plain|unsweetened|sweetened|frosted|sugar frosted|breakfast|sliced|natural|greek|strained|fruit|vegetable) )*(?:breads?|pasta|rice|cereals?|cornflakes?|(?:corn|maize|rice|wheat|bran) flakes?|flakes? of (?:corn|maize|rice|wheat|bran)|oats?|porridge|biscuits?|cookies?|cakes?|flapjacks?|cereal bars?|snack bars?|fruit bars?|oat bars?|yeast extracts?|yeast extract spreads?|chocolates?|confectionery|yoghurts?|yogurts?|soups?|sauces?|sandwiches?|wraps?|ready meals?|mixed dishes?|fish|chicken|poultry|eggs?|tofu|fruits?|vegetables?|legumes?|pulses?|lentils?|beans?|peas?|chickpeas?)$/
};
// Ordinary standalone pulses remain general foods when a provider omits its
// taxonomy. Match the whole identity, including only these preparation terms;
// "chickpea crisps", drinks, protein powders and compound dishes cannot enter
// through a loose ingredient substring. Water/brine does not imply a salt value.
const simplePulseName = /^(?:(?:organic|fresh|frozen|raw|cooked|dried|canned|tinned|plain|natural|unsalted|drained|boiled) )*(?:chickpeas?|garbanzo beans?|(?:(?:red|green|brown|yellow|puy|beluga) )?(?:split )?lentils?|(?:(?:black|black eyed|kidney|red kidney|white kidney|cannellini|butter|lima|pinto|haricot|navy|adzuki|aduki|mung|borlotti|flageolet|soya|soy|broad|fava) )?beans?|split peas?|green peas?|peas?)(?: in (?:water|brine))?$/;
// Exclusions identify the product, not a word inside a permitted food's ingredients.
// Baby spinach and wine vinegar must not be mistaken for infant food/alcohol.
const unsupportedPattern = /\b(?:infant(?: foods?| formula)?|baby (?:foods?|formula|milk)|supplements?|medical foods?|meal replacements?|sports nutrition|protein powders?)\b/;
const alcoholIdentity = /^(?:(?:organic|red|white|rose|sparkling|fortified|dry|sweet|fruit|orange|apple|craft|strong|light|alcoholic) )*(?:alcohol|alcoholic (?:drinks?|beverages?)|beers?|wines?|spirits|ciders?|liqueurs?|vodka|gin|rum|whisk(?:y|ey))$/;
const instructionText = /\b(?:ignore|instructions?|prompts?|system|assistant|return|output|classify|assign|score|rating|label this|rate as)\b/;
const simpleGrain = /^(?:(?:organic|white|brown|wholegrain|whole grain|raw|cooked|boiled|steamed|long grain|short grain|medium grain|basmati|jasmine|arborio|wild|rolled|steel cut|porridge) )*(?:rices?|oats?|wheat|barley|quinoa|bulgur|cereal grains?)$/;
const simpleGeneral = /^(?:(?:organic|fresh|frozen|raw|cooked|boiled|steamed|baby|young|roasted|plain|natural|unsweetened|low fat|fat free|greek|sourdough|wholemeal|wholegrain|white|brown|tomato|vegetable|chicken|lentil) )*(?:spinach|potatoes?|carrots?|broccoli|cauliflower|salmon|tuna|cod|haddock|duck|apples?|bananas?|pears?|oranges?|yoghurts?|yogurts?|breads?|soups?|broths?)$/;
const specialName = value => normalized(value).replace(/^organic\s+/, '');
// These specific oilseeds sometimes inherit OFF's broad cereal-grains parent.
// A real cereal identity still conflicts; only that botanical ancestry is ignored.
const simpleOilseed = /^(?:(?:organic|golden|brown|whole|raw|ground|milled|roasted|salted|unsalted) )*(?:(?:chia|flax|linseed|hemp|sesame|sunflower|pumpkin|poppy) seeds?|chia|linseed|flax)$/;
const flavouredWater = value => /\bwaters?$/.test(value)&&/\b(?:flavou?red|tonic|apple|rasp?berry|strawberry|lemon|lime|orange|peach|elderflower|cucumber)\b/.test(value);
const specificDairyDrink = /^(?:(?:fermented|dairy|milk|yogurt|yoghurt) )+drinks?$|^kefirs?$/;
// Baked beans are an ordinary prepared solid food, even without a provider
// taxonomy. Remove only the explicitly supplied brand prefix, then require the
// complete food identity. A bean ingredient, flavour, snack or recipe title is
// insufficient. This admits a scoring category, never a plant percentage,
// nutrient value or claim that the food has no added sugar/salt.
function bakedBeanIdentity(source, brand='') {
  let name=normalized(source).replace(/\s+/g,' ');
  const prefix=typeof brand==='string'?normalized(brand).replace(/\s+/g,' '):'';
  if(prefix&&name.startsWith(prefix+' '))name=name.slice(prefix.length+1);
  return /^(?:(?:organic|low salt|reduced salt|reduced sugar|no added sugar) )*baked beans?(?: in tomato sauce)?$/.test(name);
}
// Directional admission recognises complete special food identities, not an
// ingredient substring. Unresolved special profiles must not inherit the general
// fallback merely because the source reports grams. No nutrients are inferred.
function directionalIdentityName(source,brand='') {
  let name=normalized(source).replace(/\s+/g,' ');
  const brands=typeof brand==='string'?brand.split(',').map(v=>normalized(v).replace(/\s+/g,' ')).filter(Boolean).sort((a,b)=>b.length-a.length):[];
  for(const value of brands){
    if(name.startsWith(value+' '))name=name.slice(value.length+1);
    for(const suffix of [' by '+value,' '+value])if(name.endsWith(suffix))name=name.slice(0,-suffix.length);
  }
  return name.trim();
}
const directionalOrdinaryDish=/\b(?:bars?|pancakes?|puddings?|crisps?|cookies?|biscuits?|cakes?|pies?|pizzas?|quiches?|tarts?|risotto|lasagn[ae]|curr(?:y|ies)|chocolates?|pastr(?:y|ies)|breads?|sandwich(?:es)?|wraps?|noodles?|pasta|macaroni|casseroles?|stews?|soups?|sauces?|bolognese|bourguignon|crispbakes?|ice cream|ice pops?|lollies|milk chocolate|dark chocolate|white chocolate|beans?|protein pot|chunks?|tofu|vinegar|crackers?|granola|muesli|cereals?|porridge|rice|oats?|batter(?:ed)?|fish|cod|chicken)\b/;
const directionalCheeseName=/^(?:(?:fresh|mature|extra mature|hard|soft|grated|reduced fat|low fat|full fat) )*(?:mozzarella|feta|halloumi|paneer|gouda|edam|brie|camembert|parmesan|parmigiano reggiano|gruyere|gorgonzola|stilton|red leicester|wensleydale)(?: cheese)?$/;
const directionalCheeseIdentity=name=>directionalCheeseName.test(name)||/^(?:(?:protein|high protein|half fat|reduced fat|low fat|mature|extra mature|hard|soft|fresh|grated) )*(?:cheddar(?: cheese)?|cheeses?)$/.test(name);
// Style wording is a substitute form only when substitute evidence is present.
// Reuse complete cheese aliases; a dish or drink containing cheese cannot match.
function directionalCheeseSubstituteIdentity(name) {
  if(directionalCheeseIdentity(name))return true;
  const styled=name.match(/^(?:(?:deliciously )?free from )?(.+) style cheese$/);
  return Boolean(styled&&directionalCheeseIdentity(styled[1]));
}
const directionalAlcoholName=/^(?:(?:organic|red|white|rose|sparkling|dry|sweet|pale|strong|craft|light) )*(?:lagers?|ales?|ipa|stouts?|porters?|prosecco|champagne|tequila|brandy|cognac|sake|schnapps)$/;
const directionalWheyIdentity=/^(?:(?:organic|pure|natural|clear|isolated|isolate|hydrolysed|hydrolyzed|unflavou?red|salted caramel) )*(?:whey(?: protein)?(?: isolate| concentrate)?|(?:pea|soy|soya|rice|casein) protein(?: isolate)?)(?: (?:vanilla|strawberry|strawbery|chocolate|summer fruits|cloudy lemonade|cookies (?:and|&) cream))?$/;
// Only admission matching folds accents. Retained source text and fingerprints
// remain untouched, and a suffix such as the 'ale' in provençale is not a token.
const directionalText=value=>normalized(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'');
function directionalSourceContext(p) {
  const tags=['categoryTag','categories','categoriesTags'].flatMap(field=>fieldValues(p,field)).map(directionalText);
  const compoundTag=value=>!/\b(?:drinks?|beverages?|milks?)$/.test(value)&&(/\b(?:meals|dishes?|desserts?|puddings?|mousses?|salads?|confectioner(?:y|ies)|candies|chocolates?|biscuits?|cookies?|cakes?|pastries|breads?|pizzas?|pastas?|noodles?|sandwiches|wraps?|bars?|crisps?|chips|dips?|sauces?|chutneys|gratins?|yogh?urts?|ice creams?|seafood|fishes|olives|salts|spices)\b/.test(value)||categoryPatterns.general.test(value));
  const cheeseSubstitute=tags.some(value=>/\bcheese (?:alternatives?|substitutes?|analogues?)\b|\bvegan cheeses?\b/.test(value));
  const namedCheeseSubstitute=directionalNamedCheeseSubstitute(p.name||'',p.brand);
  const meatSubstitute=tags.some(value=>/\bmeat (?:alternatives?|substitutes?|analogues?)\b/.test(value));
  const beverage=tags.some(value=>identityCategories(value).includes('beverage'))&&p.scoringFacts?.isBeverage===true;
  const name=directionalText(p.name||'');
  const redMeatBurger=!meatSubstitute&&/\b(?:beef|pork|lamb|mutton|veal|venison)\b/.test(name)&&/\b(?:burgers?|patties)\b/.test(name)
    &&tags.some(value=>/^(?:beef|pork|lamb|mutton|veal|venison) (?:hamburgers?|burgers?|patties)$/.test(value));
  const compoundIngredientForm=/^(?:(?:milk|dark|white) )?chocolate\b|\bbar\b/i.test(typeof p.ingredients==='string'?p.ingredients.slice(0,120):'');
  return {tags,compound:tags.some(compoundTag),compoundTag,cheeseSubstitute,namedCheeseSubstitute,meatSubstitute,beverage,redMeatBurger,compoundIngredientForm};
}
function directionalNamedCheeseSubstitute(source,brand='') {
  const original=directionalText(source),name=directionalText(directionalIdentityName(source,brand)).replace(/^(?:(?:vegan|dairy free|plant based|plant) )+/,'');
  return /\b(?:cheese|dairy) (?:alternatives?|substitutes?)\b/.test(original)
    ||/\b(?:vegan|dairy free|plant based|plant)\b/.test(original)
      &&name.split(' ').some((_,index,words)=>directionalCheeseIdentity(words.slice(index).join(' ')));
}
function directionalSpecialIdentity(source,brand='') {
  const name=directionalIdentityName(source,brand),plain=name.replace(/^(?:(?:british|scottish|italian|organic) )+/,'');
  if(instructionText.test(name))return [];
  const result=[];
  if(categoryPatterns.water.test(plain)||/^(?:(?:pure|bottled|natural|still|mineral|spring|drinking) )*waters?$/.test(plain))result.push('water');
  if(categoryPatterns.fats_nuts_seeds.test(plain.replace(/^pure /,''))||nutName.test(plain)||/^mixed nuts?$/.test(plain))result.push('fats_nuts_seeds');
  if(directionalCheeseIdentity(plain)&&!directionalNamedCheeseSubstitute(source,brand))result.push('cheese');
  if(categoryPatterns.beverage.test(plain)||/^(?:(?:strawberry|strawbery|vanilla|chocolate|fudge brownie|fruit|natural|plain|protein|low fat|original|fat free|fermented|milk|dairy|yogurt|yoghurt|kefir) )*(?:drinks?|protein shakes?|milkshakes?|lemonades?)(?: with live cultures)?$/.test(plain))result.push('beverage');
  if(/^(?:(?:extra virgin|virgin|cold pressed|pure) )*(?:olive oils?|double creams?|single creams?|whipping creams?|beef dripping)(?: cold pressed)?$/.test(plain)
    ||/^(?:(?:crunchy|smooth|pure|roasted|deep roast|unsalted|salted) )*(?:peanut|groundnut|almond|cashew|hazelnut|pistachio|nut) butters?$/.test(plain))result.push('fats_nuts_seeds');
  if(/^(?:(?:fresh|frozen|raw|cooked|roast|roasted|lean|minced|ground) )*(?:beef|pork|lamb|mutton|veal|venison)(?: (?:mince|fillet steaks?|steaks?|fillets?|chops?|rack|joint))?(?: lean)?$/.test(plain)||/^rack of (?:lamb|pork)$/.test(plain))result.push('red_meat');
  return result;
}
function directionalAdmissionIssue(p,category) {
  const name=directionalText(directionalIdentityName(p.name||'',p.brand)),texts=['name','categoryTag','categories','categoriesTags'].flatMap(field=>fieldValues(p,field)).map(directionalText);
  if(texts.some(v=>/\bbarcode (?:clash|collision|conflict)\b|\b(?:wrong|incorrect|mismatched|reused) barcode\b/.test(v)))return {category:'unknown',reason:'ambiguous_source_identity'};
  if(instructionText.test(name))return null;
  const context=directionalSourceContext(p);
  const ordinaryName=/\b(?:protein|whey)\b/.test(name)?name.replace(/\bcookies (?:and|&) cream\b/g,''):name;
  const primaryName=ordinaryName.split(/\s+(?:in|with|by)\s+/)[0].trim();
  // A bar containing isolate is a food; an isolate with biscuit pieces remains
  // a concentrate. Additive phrases cannot change the primary product form.
  const proteinForm=/\bprotein (?:isolates?|concentrates?|powders?)\b|\bisolated (?:(?:rice|pea|soy|soya|whey|casein|hemp) )?protein\b/.test(primaryName);
  const ordinaryHead=/\b(?:bars?|pancakes?|puddings?|crisps?|cookies?|biscuits?|cakes?|breads?|crackers?|cereals?|granola|porridge|pastas?|noodles?|soups?|sauces?|yogh?urts?)\b/.test(primaryName);
  if(proteinForm&&!ordinaryHead||directionalWheyIdentity.test(primaryName))return {category:'unsupported',reason:'unsupported_protein_concentrate_identity'};
  if(alcoholIdentity.test(primaryName)||directionalAlcoholName.test(primaryName))return {category:'unsupported',reason:'unsupported_alcohol_identity'};
  if(category==='cheese'&&(context.cheeseSubstitute||context.namedCheeseSubstitute))return {category:'unknown',reason:'dairy_profile_conflicts_with_substitute'};
  if(!['unknown','general'].includes(category))return null;
  // Corn nuts are a cereal preparation; do not undo the resolver's established
  // cereal/seed hierarchy because the complete food name contains 'nuts'.
  if(category==='general'&&context.tags.includes('corn')&&context.tags.some(value=>simpleGrain.test(categoryName(value)))
    &&/^(?:(?:roasted|salted|and) )*corn nuts$/.test(name))return null;
  // These specialize source taxonomy rather than claiming an animal ingredient.
  // The full resolver still rejects contradictory explicit provider flags.
  if(context.redMeatBurger)return {category:'unknown',reason:'special_category_identity_unresolved'};
  const ordinary=directionalOrdinaryDish.test(primaryName)||/\bice creams?\b|\bmac(?:aroni)?(?: and| &)? cheese\b/.test(ordinaryName)
    ||/\bwith\b.*\b(?:noodles|pasta|rice|potatoes)\b/.test(ordinaryName)&&!/\b(?:seasoning|crumbs?|pieces|flavou?r(?:ing)?)\b/.test(ordinaryName)
      &&!directionalSpecialIdentity(primaryName).some(category=>['water','beverage','fats_nuts_seeds','cheese'].includes(category))
      &&!/\b(?:drinks?|shakes?|milks?|waters?|oils?)$/.test(primaryName)
    ||/\byogh?urts?\b/.test(name)&&!/\b(?:drinks?|shakes?)\b/.test(name)||/^(?:vegan )?salad cream$/.test(name);
  const compoundNutFlavour=context.compound&&context.compoundIngredientForm&&/\b(?:peanut|groundnut|almond|cashew|hazelnut|pistachio|nut) butter\b/.test(name);
  const fullSpecial=!compoundNutFlavour&&directionalSpecialIdentity(p.name||'',p.brand).length>0;
  const primarySpecial=!compoundNutFlavour&&directionalSpecialIdentity(primaryName).length>0;
  const meatCut=/\b(?:beef|pork|lamb|mutton|veal|venison)\b/.test(primaryName)&&/\b(?:mince|steaks?|fillets?|chops?|rack|joints?)$/.test(primaryName);
  const strongBeverageForm=/\b(?:drinks?|shakes?|milkshakes?|lemonades?)$/.test(primaryName)||/^(?:(?:diet|zero|sugar free|no added sugar) )*sparkling\b/.test(primaryName);
  const literalMilk=categoryPatterns.beverage.test(name.replace(/\bfresh /g,''))&&/\bmilk$/.test(name);
  const beverageHead=/\b(?:drinks?|shakes?|milkshakes?|lemonades?|milks?|waters?)$/.test(primaryName)||/^(?:(?:diet|zero|sugar free|no added sugar) )*sparkling\b/.test(primaryName);
  const matchingSubstitute=!beverageHead&&((context.namedCheeseSubstitute||context.cheeseSubstitute&&directionalCheeseSubstituteIdentity(primaryName))
    ||context.meatSubstitute&&/\b(?:beef|pork|lamb|mutton|veal|venison)\b/.test(name)
    ||/^(?:vegan|vegetarian|plant based|dairy free) (?:beef|pork|lamb|mutton|veal|venison|butter)$/.test(name));
  if(matchingSubstitute)return null;
  // A source already expressed per100ml keeps the existing beverage fallback.
  // Conflicting classifications are not repaired here, and a g/ml conversion is
  // never inferred. In particular, concentrates were rejected above.
  if(category==='unknown'&&p.basisUnit==='ml'&&beverageHead&&!fullSpecial&&!meatCut)return null;
  // Explicit compound taxonomy disambiguates abbreviated ingredient/flavour
  // titles. It does not repair a literal steak/milk/oil identity that contradicts
  // that taxonomy. A complete supplied ingredient list also supports named
  // desserts whose titles reuse a dairy brand ('Dairy Milk with Flake').
  const ingredientContext=typeof p.ingredients==='string'&&p.ingredients.trim()&&!p.ingredientsNeedsReview;
  const suppliedChocolateDessert=ingredientContext&&context.tags.some(value=>/\b(?:desserts?|puddings?)$/.test(value))
    &&/\b(?:milk|dark|white) chocolate\b/i.test(p.ingredients);
  const suppliedNutConfectionery=ingredientContext&&nutName.test(primaryName)
    &&context.tags.some(value=>/\b(?:confectioner(?:y|ies)|candies|bars?)$/.test(value));
  const establishedCompound=context.compound&&!meatCut&&!literalMilk&&!strongBeverageForm&&!fullSpecial
    &&(!primarySpecial||(suppliedChocolateDessert||suppliedNutConfectionery)&&!/\boil$/.test(primaryName));
  if(ordinary||establishedCompound)return null;
  const specialHead=/\b(?:drinks?|shakes?|milkshakes?|lemonades?|milks?|whey|qhey|isolates?|protein|oils?|creams?|dripping|butters?|cheeses?|cheddar|beef|pork|lamb|mutton|veal|venison|waters?|nuts?|peanuts?|groundnuts?|almonds?|cashews?|hazelnuts?|walnuts?|pistachios?|pecans?|mozzarella|feta|halloumi|paneer|gouda|edam|brie|camembert|parmesan|stilton|beers?|wines?|spirits|ciders?|lagers?|ales?|ipa|stouts?|prosecco|champagne|tequila|brandy|cognac|vodka|gin|rum|whisk(?:y|ey))$/.test(primaryName);
  const flavouredProtein=/\b(?:whey|qhey|protein)(?: (?:vanilla|strawberry|strawbery|chocolate|summer fruits|cloudy lemonade))$/.test(primaryName);
  if(fullSpecial||primarySpecial||specialHead||flavouredProtein||beverageHead||meatCut)return {category:'unknown',reason:'special_category_identity_unresolved'};
  return null;
}

function identityCategories(source, brand='') {
  const n=normalized(source),g=categoryName(source),special=specialName(source);
  if(instructionText.test(n))return [];
  return [...new Set([...Object.entries(categoryPatterns).filter(([name,pattern])=>name==='general'
    ?pattern.test(g)||simplePulseName.test(g)||simpleGrain.test(g)||simpleGeneral.test(g)||freshFruitName(source)!==null||bakedBeanIdentity(source,brand)
    :pattern.test(special)||name==='fats_nuts_seeds'&&simpleOilseed.test(special)
      ||name==='beverage'&&(flavouredWater(special)||specificDairyDrink.test(special))).map(([name])=>name),...(DIRECTIONAL?directionalSpecialIdentity(source,brand):[])])];
}
const sweetenerPattern = /\b(?:acesulfame(?: k| potassium)?|aspartame|cyclamates?|saccharin|sucralose|thaumatin|neohesperidin|steviol glycosides?|stevia|neotame|advantame|aspartame acesulfame salt|e\s*(?:950|951|952|954|955|957|959|960|961|962|969))\b/i;
// Preserve the full declared share of a whole nut with its common compound
// spelling. Exact anchoring excludes nut flour, oils, flavours and mixtures.
const nutName = DIRECTIONAL
  ? /^(?:(?:roasted|salted|unsalted|blanched|ground|whole|raw|organic|hi oleic|high oleic) )*(?:peanuts?|groundnuts?|almonds?|cashews?|cashew nuts?|hazelnuts?|walnuts?|pistachios?|pecans?|brazil nuts?|macadamia nuts?)$/
  : /^(?:(?:roasted|salted|unsalted|blanched|ground|whole|raw|organic|hi oleic|high oleic) )*(?:peanuts?|groundnuts?|almonds?|cashews?|hazelnuts?|walnuts?|pistachios?|pecans?|brazil nuts?|macadamia nuts?)$/;
const redMeatName = /^(?:(?:fresh|frozen|raw|cooked|ground|minced|lean) )*(?:beef|pork|lamb|mutton|veal|venison)$/;
function declaredIngredientPercent(p, pattern) {
  if (p.ingredientsNeedsReview === true) return null;
  const declared = (p.ingredientItems || []).filter(item => pattern.test(normalized(item.text || item.id || '')) && typeof item.percent === 'number');
  if (declared.length) {
    const sum = declared.reduce((value, item) => value + item.percent, 0);
    return sum <= 100 ? sum : null;
  }
  if (typeof p.ingredients !== 'string') return null;
  const parts = p.ingredients.replace(/^ingredients\s*:\s*/i, '').split(/[,;]/);
  const percentages = parts.map(part => part.trim().match(/^(.+?)\s*\(?\s*(\d+(?:\.\d+)?)\s*%\s*\)?$/))
    .filter(match => match && pattern.test(normalized(match[1]))).map(match => Number(match[2]));
  if (!percentages.length) return null;
  const sum = percentages.reduce((value, item) => value + item, 0);
  return sum <= 100 ? sum : null;
}
function validQuotes(p, value, max) {
  return Array.isArray(value) && value.length <= max && value.every(item => exact(item, ['field', 'quote'])
    && fields.includes(item.field) && text(item.quote, 400) && fieldValues(p, item.field).some(source => source.includes(item.quote)));
}
function validateClassification(p, value) {
  if (!exact(value, ['category', 'evidence', 'sweeteners', 'sweetenerEvidence']) || !categories.includes(value.category)
    || !['present', 'absent', 'unknown'].includes(value.sweeteners) || !validQuotes(p, value.evidence, 4) || !validQuotes(p, value.sweetenerEvidence, 2)) {
    throw new ScoreError('The product analysis returned invalid evidence.', 502, 'upstream_invalid_response');
  }
  const sourceFields = ['name', 'categoryTag', 'categories', 'categoriesTags'];
  const sourceTexts = sourceFields.flatMap(field => fieldValues(p, field));
  const flags = p.scoringFacts || {}, conflicts=[], resolutions=[];
  const nutPercent=declaredIngredientPercent(p,nutName),redMeatPercent=declaredIngredientPercent(p,redMeatName);
  const oilseedIdentity=sourceTexts.some(source=>simpleOilseed.test(specialName(source)));
  const grainIdentity=sourceTexts.some(source=>simpleGrain.test(categoryName(source))&&!(oilseedIdentity&&/^cereal grains?$/.test(normalized(source))));
  const pulseIdentity=sourceTexts.some(source=>simplePulseName.test(categoryName(source)));
  const nutIdentity=nutName.test(specialName(p.name||''))||nutPercent>50;
  const beverageIdentity=identityCategories(p.name||'').includes('beverage')||sourceTexts.some(source=>specificDairyDrink.test(normalized(source)));
  // Taxonomy parents describe ancestry rather than the scoring profile. Drop
  // only documented, compatible ancestors; unrelated specific tags still conflict.
  const context=DIRECTIONAL?directionalSourceContext(p):null;
  const categoryRecords=sourceTexts.flatMap(source=>identityCategories(source,source===p.name?p.brand:'').map(category=>({source,category})));
  if(context){
    // Retained specific identities outrank compatible broad taxonomy parents.
    // Absence of a provider flag is not a contrary flag. Actual mixed forms and
    // competing specific categories still contribute their conflicts below.
    const primaryName=directionalText(directionalIdentityName(p.name||'',p.brand)).split(/\s+(?:in|with|by)\s+/)[0];
    const hasCategory=category=>categoryRecords.some(record=>record.source!==p.name&&record.category===category);
    const cheeseDessertAncestor=flags.isCheese!==false&&hasCategory('cheese')
      &&!directionalOrdinaryDish.test(primaryName)&&!context.cheeseSubstitute&&!context.namedCheeseSubstitute;
    const creamDessertAncestor=flags.isFatOilNutsSeeds!==false&&context.tags.includes('creams')
      &&directionalSpecialIdentity(p.name||'',p.brand).includes('fats_nuts_seeds');
    const beveragePreparation=context.beverage&&context.tags.some(value=>/\b(?:cocoa|chocolate) powders$|^dehydrated beverages$|^instant beverages$/.test(value));
    const meatPreparation=flags.isRedMeatProduct===true&&!context.meatSubstitute&&!directionalOrdinaryDish.test(primaryName)
      &&context.tags.some(value=>/^(?:corned beef|smoked sausages?|beef pastrami|swedish style pork and beef meat balls)$/.test(value))
      &&typeof p.ingredients==='string'&&/\b(?:beef|pork|lamb|mutton|veal|venison)\b/i.test(p.ingredients);
    // Preserve the existing exact under-20% eligibility resolution when a new
    // compound alias is the only added category. No translation or share guess.
    const knownIneligibleMeat=flags.isRedMeatProduct===true&&redMeatPercent!==null&&redMeatPercent<20&&!categoryRecords.length;
    for(const source of context.tags.filter(context.compoundTag)){
      if(knownIneligibleMeat){resolutions.push('declared_red_meat_share_under_threshold');continue;}
      if(cheeseDessertAncestor&&/\bdesserts?(?: with fruits)?$/.test(source)&&!/^frozen /.test(source)){resolutions.push('cheese_identity_over_dessert_ancestor');continue;}
      if(creamDessertAncestor&&/^(?:dairy )?desserts?$/.test(source)){resolutions.push('cream_identity_over_dessert_ancestor');continue;}
      if(context.beverage&&(/^(?:(?:plain|fermented|non dairy|dairy) )*desserts?$/.test(source)
        ||/\b(?:milks?|drinks?|beverages?|yogh?urts?)$|\bmilk with sugar\b|\byogh?urts? with cereals$/.test(source))){resolutions.push('drink_identity_over_compatible_ancestor');continue;}
      if(beveragePreparation&&/\b(?:chocolates?|cocoa|confectioner(?:y|ies))\b/.test(source)){resolutions.push('beverage_preparation_over_chocolate_ancestor');continue;}
      if(meatPreparation&&/^(?:meals(?: with meat)?|(?:beef|pork|lamb|mutton|veal|venison) dishes)$/.test(source)){resolutions.push('meat_preparation_over_meal_ancestor');continue;}
      categoryRecords.push({source,category:'general'});
    }
    // A meat substitute can itself be cheese; a substitute tag only removes
    // the profile it contradicts, never a compatible independent special food.
    if((context.cheeseSubstitute||context.meatSubstitute)&&!categoryRecords.some(record=>record.category!=='general'
      &&!(context.cheeseSubstitute&&record.category==='cheese')&&!(context.meatSubstitute&&record.category==='red_meat')))categoryRecords.push({source:context.cheeseSubstitute?'cheese substitutes':'meat substitutes',category:'general'});
  }
  const filtered=categoryRecords.filter(({source,category})=>{
    const n=normalized(source);
    if((context?.cheeseSubstitute||context?.namedCheeseSubstitute)&&category==='cheese'){resolutions.push('cheese_substitute_over_dairy_name');return false;}
    if(context?.meatSubstitute&&category==='red_meat'){resolutions.push('meat_substitute_over_meat_name');return false;}
    // Brand removal supplies a weak alias, not permission to contradict a known
    // drink or compound food. Keep the complete original identity available.
    if(context&&source===p.name&&!identityCategories(source).includes(category)
      &&(context.beverage&&category!=='beverage'||context.compound&&context.compoundIngredientForm&&category!=='general')){
      resolutions.push(context.beverage?'beverage_source_over_brand_alias':'compound_source_over_brand_alias');return false;
    }
    if(context?.compound&&source===p.name&&category==='fats_nuts_seeds'
      &&context.compoundIngredientForm){resolutions.push('compound_ingredient_form_over_nut_butter_name');return false;}
    if(oilseedIdentity&&category==='general'&&/^(?:cereals?|cereal grains?)$/.test(n)){resolutions.push('oilseed_identity_over_cereal_ancestor');return false;}
    if(beverageIdentity&&source!==p.name&&category==='water'&&categoryPatterns.water.test(n)){resolutions.push('flavoured_drink_over_water_ancestor');return false;}
    if(beverageIdentity&&source!==p.name&&category==='general'&&/^yogh?urts?$/.test(n)){resolutions.push('dairy_drink_over_yogurt_ancestor');return false;}
    if(grainIdentity&&category==='fats_nuts_seeds'&&/^seeds?$/.test(n)){resolutions.push('cereal_identity_over_seed_ancestor');return false;}
    if(pulseIdentity&&category==='fats_nuts_seeds'&&/^seeds?$/.test(n)){resolutions.push('pulse_identity_over_seed_ancestor');return false;}
    if(nutIdentity&&category==='general'&&/^(?:legumes?|pulses?|beans?)$/.test(n)){resolutions.push('nut_identity_over_legume_ancestor');return false;}
    if(beverageIdentity&&category==='general'&&/^(?:cereals?|oats?|rice|rices?|legumes?|pulses?)$/.test(n)){resolutions.push('drink_identity_over_ingredient_ancestor');return false;}
    return true;
  });
  const candidates=[...new Set(filtered.map(record=>record.category))];
  const specific=candidates.filter(name=>name!=='beverage'||!candidates.includes('water'));
  let category=specific.length===1?specific[0]:'unknown';
  if(specific.length>1)conflicts.push('incompatible_source_categories');
  if(sourceTexts.some(source=>unsupportedPattern.test(normalized(source))||alcoholIdentity.test(normalized(source))))category='unsupported';
  const trueCategories = [['isWater','water'],['isBeverage','beverage'],['isCheese','cheese'],['isFatOilNutsSeeds','fats_nuts_seeds'],['isRedMeatProduct','red_meat']]
    .filter(([key])=>flags[key]===true).map(([,name])=>name);
  let meaningful=trueCategories.filter(name=>name!=='beverage'||!trueCategories.includes('water'));
  if(context&&((context.cheeseSubstitute||context.namedCheeseSubstitute)&&flags.isCheese===true||context.meatSubstitute&&flags.isRedMeatProduct===true))conflicts.push('provider_flag_conflicts_with_substitute');
  // A botanical seed flag on a named cereal/pulse is a provider inconsistency,
  // not evidence for the oilseed profile. Preserve that resolution.
  if((grainIdentity||pulseIdentity)&&category==='general'&&meaningful.length===1&&meaningful[0]==='fats_nuts_seeds'
    &&!filtered.some(r=>r.category==='fats_nuts_seeds')){
    meaningful=[];resolutions.push(grainIdentity?'cereal_identity_over_provider_oilseed_flag':'pulse_identity_over_provider_oilseed_flag');
  }
  if(category!=='unsupported'){
    if(meaningful.length>1){category='unknown';conflicts.push('incompatible_provider_flags');}
    else if(meaningful.length===1){
      const sourceCategory=meaningful[0];
      if(specific.some(name=>name!==sourceCategory&&!(sourceCategory==='water'&&name==='beverage'))){category='unknown';conflicts.push('provider_flag_conflicts_with_identity');}
      else category=sourceCategory;
    }else if(flagNames.slice(0,5).every(key=>flags[key]===false)){
      if(category==='unknown'&&specific.every(name=>name==='general'))category='general';
      else if(category!=='general'){category='unknown';conflicts.push('negative_provider_flags_conflict_with_identity');}
    }
    // The model may resolve an unfamiliar identity only when it quotes a whole
    // supplied identity/category, no deterministic conflict exists, and no text
    // looks like an instruction. Numeric/model score claims are never accepted.
    const grounded=value.evidence.some(item=>sourceFields.includes(item.field)
      &&fieldValues(p,item.field).some(source=>source.trim()===item.quote.trim())
      &&!instructionText.test(normalized(item.quote))
      &&! /^(?:(?:unknown|unidentified|mystery|fixture|synthetic|your) )*(?:food|item|product|meal|dish)?$/.test(normalized(item.quote)));
    const specialContradiction=value.category==='beverage'&&sourceTexts.some(source=>/\b(?:chocolate|powder|cheese|bread|cake)\b/.test(normalized(source)))
      ||value.category==='cheese'&&sourceTexts.some(source=>/\b(?:cheesecakes?|vegan|dairy free|plant based)\b/.test(normalized(source)))
      ||value.category==='fats_nuts_seeds'&&sourceTexts.some(source=>/\b(?:cakes?|cookies?|biscuits?|chocolate|confectioner(?:y|ies)|soups?|sauces?|sandwiches?|wraps?)\b/.test(normalized(source)))
      ||value.category==='red_meat'&&sourceTexts.some(source=>/\b(?:soups?|sauces?|sandwiches?|wraps?|casseroles?|ready meals?|complete meals?|pizza|pasta)\b/.test(normalized(source)))
      ||value.category==='water'; // plain water always needs positive local evidence
    if(category==='unknown'&&!conflicts.length&&!specific.length&&!meaningful.length&&grounded&&!specialContradiction
      &&categories.slice(0,5).includes(value.category))category=value.category;
    const key={beverage:'isBeverage',water:'isWater',cheese:'isCheese',fats_nuts_seeds:'isFatOilNutsSeeds',red_meat:'isRedMeatProduct'}[category];
    if(key&&flags[key]===false){category='unknown';conflicts.push('negative_provider_flag_conflicts_with_category');}
  }
  if(category==='fats_nuts_seeds'&&sourceTexts.some(source=>/\b(?:peanut|groundnut|almond|cashew|hazelnut|pistachio|nut) butters?\b/.test(normalized(source)))
    &&(nutPercent!==null&&nutPercent<=50||flags.isFatOilNutsSeeds!==true&&!(nutPercent>50)))category='unknown';
  if(category==='red_meat'&&(redMeatPercent!==null&&redMeatPercent<20
    ||flags.isRedMeatProduct!==true&&typeof p.ingredients==='string'&&!redMeatName.test(normalized(p.ingredients))&&!(redMeatPercent>=20)))category='unknown';
  let sweeteners = typeof flags.hasNonNutritiveSweeteners === 'boolean' ? flags.hasNonNutritiveSweeteners : null;
  if (typeof p.ingredients === 'string' && sweetenerPattern.test(p.ingredients)) {
    sweeteners = sweeteners === false ? null : true;
  }
  // Absence is supported only by a source flag or the complete narrow simple
  // ingredient grammar below. An AI assertion of absence cannot manufacture 0 points.
  if (sweeteners === null && completeSimpleIngredients(p)) sweeteners = false;
  if(DIRECTIONAL){
    const issue=directionalAdmissionIssue(p,category);
    if(issue){category=issue.category;conflicts.push(issue.reason);}
  }
  return { category, sweeteners, evidence: value.evidence, classifierVersion:CLASSIFIER_VERSION, resolutions:[...new Set(resolutions)], conflicts:[...new Set(conflicts)] };
}

// Deliberately narrow complete-list grammar. Every comma/semicolon-separated
// item must resolve exactly; compound brackets, unknown qualifiers or omitted
// ingredients disable deduction. Peanuts/nuts/seeds are not FVL in 2023.
const excludedIngredient = /^(?:(?:dry roasted|roasted|blanched|ground|whole|raw|organic|pasteurised|pasteurized|skimmed|semi skimmed|wholegrain|whole grain|jumbo|rolled|steel cut|flaked|crushed|malted|cooked|boiled|steamed|long grain|short grain|basmati) )*(?:peanuts?|groundnuts?|almonds?|cashews?|hazelnuts?|walnuts?|pistachios?|pecans?|brazil nuts?|macadamia nuts?|sesame seeds?|sunflower seeds?|pumpkin seeds?|sea salt|salt|sugar|cane sugar|water|milk|cream|butter|(?:wheat|rice|rye|barley|oat|corn|maize|buckwheat) flour|oats?|oat flakes|wheat flakes|barley flakes|rye flakes|maize|corn|(?:brown |white )?rice|wheat|barley|rye|quinoa|buckwheat|barley malt extract|niacin|iron|calcium|calcium carbonate|riboflavin|thiamin|thiamine|folic acid|cocoa butter|cocoa powder)$/;
// Reuse the complete grain grammar so preparation, colour and variety may
// appear together (for example "Cooked Brown Basmati Rice"). A grain word
// inside a composite ingredient still cannot establish an absent FVL amount.
const nonFvlIngredient = name => excludedIngredient.test(name) || simpleGrain.test(name);
function simpleExcludedIngredients(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  let source = raw.toLowerCase().trim().replace(/^ingredients\s*:\s*/, '').replace(/[.]$/, '');
  // Parentheses are permitted solely around a printed percentage.
  source = source.replace(/\(\s*\d+(?:\.\d+)?\s*%\s*\)/g, '').replace(/\b\d+(?:\.\d+)?\s*%/g, '');
  return source.split(/[,;]/).every(item => nonFvlIngredient(item.trim().replace(/\bgluten[- ]free\s+/g,'').replace(/\s+/g, ' ')));
}
const completeSimpleIngredients = p => p.ingredientsNeedsReview !== true
  && (p.ingredientsNeedsReview === false || p.sourceName === 'Open Food Facts') && simpleExcludedIngredients(p.ingredients);
// A complete narrow ingredient list can establish a qualifying percentage.
// These are ingredient facts, not a guess from a product's marketing name.
// Composite brackets and unknown ingredients deliberately prevent admission.
function declaredFvlIngredients(p) {
  if(p.ingredientsNeedsReview===true||(p.unresolvedFields||[]).some(k=>['ingredients','identity','preparation'].includes(k))
    ||!(p.ingredientsNeedsReview===false||p.sourceName==='Open Food Facts')||typeof p.ingredients!=='string')return null;
  const eligible=/^(?:(?:organic|fresh|frozen|raw|cooked|boiled|dried|dry|split|red|green|brown|yellow|whole|pitted|chopped|finely chopped|peeled|medjool|deglet nour|californian|california) )*(?:tomato(?:es)?|tomato pulp|lentils?|chickpeas?|garbanzo beans?|(?:kidney|black|white|cannellini|haricot|butter|navy|pinto|borlotti) beans?|beans?|peas?|dates?|carrots?|spinach|broccoli)$/;
  const vegetableAlias=/^(?:(?:organic|fresh|frozen|raw|cooked|boiled|red|green|yellow|whole|chopped|finely chopped|peeled) )*(?:bell peppers?|cucumbers?|beetroot)$/;
  const source=p.ingredients.replace(/^ingredients\s*:\s*/i,'').replace(/[.]$/,'').trim();
  if(!source)return null;
  const chunks=source.split(/[,;]/);let eligibleTotal=0,total=0,eligibleCount=0,undeclaredEligible=0,hasDriedEligible=false;
  for(const chunk of chunks){
    const percent=chunk.match(/\(?\s*(\d+(?:\.\d+)?)\s*%\s*\)?/);
    const name=normalized(chunk.replace(/\(?\s*\d+(?:\.\d+)?\s*%\s*\)?/,'').trim()).replace(/\s+/g,' ');
    if(/[()%]/.test(name)||!name)return null;
    const qualifies=eligible.test(name)||(DIRECTIONAL&&vegetableAlias.test(name));
    if(!qualifies&&!nonFvlIngredient(name))return null;
    const amount=percent?Number(percent[1]):null;
    if(amount!==null){if(amount>100)return null;total+=amount;if(qualifies)eligibleTotal+=amount;}
    if(qualifies){eligibleCount++;if(amount===null)undeclaredEligible++;if(/\b(?:dried|dry|dates?)\b/.test(name))hasDriedEligible=true;}
  }
  if(total>100||!eligibleCount)return null;
  if(chunks.length===1&&eligibleCount===1){if(undeclaredEligible===1||total===100)eligibleTotal=100;else return null;}
  else if(undeclaredEligible||hasDriedEligible)return null;
  return {lower:eligibleTotal,upper:eligibleTotal,source:'complete-declared-qualifying-ingredients',evidence:[{field:'ingredients',quote:p.ingredients}]};
}
// Whole fruit is eligible fruit, without requiring an artificial printed "100%"
// ingredient percentage. Admission needs an exact, narrow identity and supporting
// complete ingredients or taxonomy. A fruit word inside a processed food is not
// enough. This deduction changes scoring evidence only, never source nutrition.
const fruitNames=/^(?:apples?|bananas?|pears?|oranges?|mandarins?|clementines?|satsumas?|tangerines?|grapefruits?|lemons?|limes?|peach(?:es)?|nectarines?|apricots?|plums?|cherries|cherry|strawberries|strawberry|raspberries|raspberry|blueberries|blueberry|blackberries|blackberry|cranberries|cranberry|grapes?|kiwis?|kiwifruits?|mangoes?|mangos?|pineapples?|papayas?|melons?|watermelons?|pomegranates?|avocados?)$/;
const processedFruit=/\b(?:dried|dry|dehydrated|powder(?:ed|s)?|cooked|baked|fried|roasted|candied|sweetened|syrups?|juices?|smoothies?|drinks?|beverages?|milks?|chips|crisps|flours?|cakes?|breads?|biscuits?|cookies?|confectionery|chocolates?|jams?|purees?|purées?|sauces?|desserts?|flavou?red|extracts?|concentrates?|canned|tinned)\b/;
function freshFruitName(raw) {
  if(typeof raw!=='string')return null;
  let name=normalized(raw).replace(/\s+/g,' ').replace(/^(?:\d+\s+)?(?:(?:organic|fairtrade|fair trade|rainforest alliance|certified|fresh|raw|whole|loose|ripe|unripe|small|medium|large)\s+)*/,'');
  if(DIRECTIONAL){
    // These finite produce modifiers/varieties occur on retained single-fruit
    // labels. Never strip arbitrary branding or text after the fruit: the
    // exact remainder and independent ingredient/taxonomy guards still apply.
    name=name.replace(/[®™]/g,'').replace(/^(?:(?:british|scottish|mini|frozen|organic|fairtrade|fair trade|rainforest alliance|certified|fresh|raw|whole|loose|ripe|unripe|small|medium|large)\s+)*/,'');
    name=name.replace(/^(?:golden delicious|royal gala|pink lady|braeburn|cox(?:['’]s)?|gala|granny smith|jazz|envy|red|green) (?=apples?$)/,'');
    name=name.replace(/^(?:(?:red|green|black|white|seedless) ){1,2}(?=grapes?$)/,'');
    name=name.replace(/^(?:dark sweet|sweet|red|black) (?=cherr(?:y|ies)$)/,'');
    if(/^kiwi fruits?$/.test(name)||/^kiwifruits?$/.test(name))name='kiwi';
  }
  if(!fruitNames.test(name))return null;
  return name.replace(/ies$/,'y').replace(/mangoes$/,'mango').replace(/peaches$/,'peach').replace(/s$/,'');
}
function wholeFruitIdentity(p,{requireSource=true}={}) {
  if(p.ingredientsNeedsReview===true||(p.unresolvedFields||[]).some(key=>['identity','ingredients','preparation'].includes(key)))return null;
  if(requireSource&&p.sourceName!=='Open Food Facts'&&p.ingredientsNeedsReview!==false)return null;
  let name=String(p.name||'').trim();
  const brand=String(p.brand||'').trim();
  if(brand&&name.toLowerCase().startsWith(brand.toLowerCase()+' '))name=name.slice(brand.length+1);
  const fruit=freshFruitName(name);if(!fruit)return null;
  const tags=['categoryTag','categories','categoriesTags'].flatMap(key=>fieldValues(p,key));
  // OFF's broad ancestors include "foods and beverages" for ordinary fruit;
  // that parent is not a declaration that the particular product is a drink.
  const fruitAncestor=/^(?:(?:plant|fruit|vegetable) based foods(?: and beverages)?|fruits and vegetables based foods)$/;
  if(tags.some(tag=>!fruitAncestor.test(normalized(tag))&&(processedFruit.test(normalized(tag))
    ||DIRECTIONAL&&/\b(?:oils?|supplements?)\b/.test(normalized(tag)))))return null;
  const source=typeof p.ingredients==='string'?p.ingredients.trim():'';
  const evidence=[{field:'name',quote:p.name}];
  if(source){
    const ingredient=source.replace(/^ingredients\s*:\s*/i,'').replace(/[.]$/,'').replace(/\(\s*100\s*%\s*\)|\b100\s*%/g,'').trim();
    if(freshFruitName(ingredient)!==fruit)return null;
    evidence.push({field:'ingredients',quote:source});
  }else{
    const tag=tags.find(tag=>freshFruitName(tag)===fruit||/^(?:fresh |raw |whole )?fruits?$/.test(normalized(tag)));
    if(!tag&&requireSource)return null;
    if(tag)evidence.push({field:'categories',quote:tag});
  }
  if((p.ingredientItems||[]).some(item=>freshFruitName(item.text||item.id)!==fruit
    ||typeof item.percent==='number'&&item.percent!==100))return null;
  // A contradictory specific fruit or special scoring profile is not an
  // ancestor. Do not silently resolve it from the title alone.
  if(tags.some(tag=>{const other=freshFruitName(tag);return other!==null&&other!==fruit
      &&!(DIRECTIONAL&&((fruit==='nectarine'&&other==='peach')||(fruit==='watermelon'&&other==='melon')));})
    ||['isBeverage','isWater','isCheese','isFatOilNutsSeeds','isRedMeatProduct'].some(key=>p.scoringFacts?.[key]===true))return null;
  return {name:fruit,source:'supported-single-whole-fruit-identity',evidence};
}
// Derive a conservative bound only from a complete, fully recognised list.
// Each top-level mixture's entire declared weight is treated as eligible and
// doubled as though dried. No ingredient grams or exact FVL value are invented.
function ingredientFvlBounds(p,category='general') {
  if (completeSimpleIngredients(p)) return {lower:0,upper:0,source:'complete-simple-ingredient-list-excludes-fvl'};
  const wholeFruit=category==='general'?wholeFruitIdentity(p):null;
  if(wholeFruit)return {lower:100,upper:100,source:wholeFruit.source,evidence:wholeFruit.evidence};
  const declared=category==='general'?declaredFvlIngredients(p):null;
  if(declared)return declared;
  if ((p.ingredientsNeedsReview !== false && p.sourceName !== 'Open Food Facts') || p.ingredientsNeedsReview === true || typeof p.ingredients!=='string') return null;
  if(category==='fats_nuts_seeds') {
    // Whole-fruit/legume oils qualify only in this category. Unspecified
    // vegetable oil is not evidence of zero eligible oils.
    const pure=normalized(p.ingredients.replace(/\(\s*100\s*%\s*\)/g,'').replace(/\b100\s*%/g,'').replace(/[.]$/,'')).replace(/\s+/g,' ');
    if(/^(?:(?:extra virgin|virgin|pure|refined|organic) )*(?:olive|avocado|soybean|soya bean) oil$/.test(pure))return {lower:100,upper:100,source:'complete-single-eligible-whole-fruit-or-legume-oil'};
    if(/^(?:(?:pure|refined|organic|cold pressed) )*(?:rapeseed|sunflower|grapeseed|coconut|peanut|sesame) oil$/.test(pure))return {lower:0,upper:0,source:'complete-single-non-fvl-oil'};
    return null;
  }
  const split=raw=>{const parts=[];let level=0,start=0;for(let i=0;i<raw.length;i++){
    if(raw[i]==='(')level++;else if(raw[i]===')'){level--;if(level<0)return null;}
    else if((raw[i]===','||raw[i]===';')&&level===0){parts.push(raw.slice(start,i));start=i+1;}}
    if(level!==0)return null;parts.push(raw.slice(start));return parts.map(v=>v.trim()).filter(Boolean);};
  const excluded=/^(?:(?:gluten free|chopped|whole|ground|refined|roasted|organic|vegetable|demerara|invert|golden) )*(?:oats?|syrup|sugar syrup|sugar|margarine|oil|palm|rapeseed|sunflower oil|water|emulsifier|mono and diglycerides of fatty acids|mono and di glycerides of fatty acids|pumpkin seeds?|chia seeds?|sunflower seeds?|salt|sea salt)$/;
  const fruit=/^(?:(?:chopped|dried|whole|ground|pureed|puréed) )*(?:apricots?|cranberries|sultanas?|raisins?|grapes?|dates?|figs?|prunes?|currants?|apples?|pears?|bananas?|strawberries|raspberries|blueberries|blackberries|cherries)$/;
  const analyse=(raw,parent=null)=>{
    const clean=raw.replace(/\(\s*\d+(?:[.,]\d+)?\s*%\s*\)/g,'').replace(/\d+(?:[.,]\d+)?\s*%/g,'').trim();
    const index=clean.indexOf('('),head=(index<0?clean:clean.slice(0,index)).trim();
    const name=normalized(head).replace(/\bgluten free\s+/g,'').replace(/\s+/g,' ').replace(/\band\s+di\s*$/,'and di');
    // Abbreviated oil sources are admitted only inside an explicitly declared
    // vegetable-oil mixture. Unknown children still invalidate the whole list.
    const namedOilSource=parent==='vegetable oil'&&/^(?:sunflower|rapeseed)(?: oil)?$/.test(name);
    let known=excluded.test(name)||nonFvlIngredient(name)||fruit.test(name)||namedOilSource,hasFruit=fruit.test(name);
    if(index>=0){if(!clean.endsWith(')'))return null;const children=split(clean.slice(index+1,-1));if(!children)return null;
      for(const child of children){const v=analyse(child,name);if(!v)return null;known=known&&v.known;hasFruit=hasFruit||v.hasFruit;}}
    return known?{known,hasFruit}:null;
  };
  const groups=split(p.ingredients.replace(/^ingredients\s*:\s*/i,'').replace(/[.]$/,''));if(!groups?.length)return null;
  let upper=0;
  for(const group of groups){const v=analyse(group);if(!v)return null;if(!v.hasFruit)continue;
    // Only a percentage before the compound's ingredient parentheses can bound its entire weight.
    const head=group.match(/^[^(]*(?:\(\s*\d+(?:[.,]\d+)?\s*%\s*\))?/)[0];
    const declared=head.match(/(\d+(?:[.,]\d+)?)\s*%/);if(!declared)return null;
    upper+=Number(declared[1].replace(',','.'));
  }
  if(upper>100)return null;
  return {lower:0,upper:upper===0?0:200*upper/(100+upper),source:'complete-ingredient-mixture-upper-bound-with-dried-fruit-factor',evidence:p.ingredients};
}
function scoringInputs(p, classification) {
  if(p.unresolvedFields?.includes('ingredients'))p={...p,ingredientsNeedsReview:true,scoringFacts:{...p.scoringFacts,fvlPercent:null}};
  const fvl = p.scoringFacts?.fvlPercent, declaredKj=exactValue(p.energyKj,'kJ'), kcal=exactValue(p.nutrients?.energyKcal,'kcal');
  const bounds=fvl?{lower:fvl.value,upper:fvl.value,source:fvl.source}:ingredientFvlBounds(p,classification.category);
  const sourceNutrient=key=>DIRECTIONAL&&key==='salt'&&p.nutrients?.salt?.status==='calculated'
    &&/^Calculated from source sodium \((?:g × 2\.5|mg × 2\.5 ÷ 1000)\)$/.test(p.nutrientSources?.salt||'')
    ?{...p.nutrients.salt,status:'supplied'}:p.nutrients?.[key];
  const input = { basisUnit:p.basisUnit??null,nutritionPreparation:p.nutritionPreparation??null,
    energyKj:declaredKj??(kcal===null?null:kcal*4.184),energySource:declaredKj!==null?'declared-kJ':kcal!==null?'derived-kcal-times-4.184':null,
    ...Object.fromEntries(['sugars','fat','saturatedFat','salt','fibre','protein'].map(key=>[key,exactValue(sourceNutrient(key),'g')])),
    carbohydrate:exactValue(p.nutrients?.carbohydrate,'g'),nutrientBounds:Object.fromEntries(['sugars','fat','saturatedFat','salt','fibre','protein','carbohydrate'].map(key=>[key,nutrientBound(sourceNutrient(key))])),
    positiveBounds:Object.fromEntries(['fibre','protein'].map(key=>[key,nutrientBound(p.nutrients?.[key])])),
    fvlPercent:fvl?.value??(bounds&&bounds.lower===bounds.upper?bounds.lower:null),fvlBounds:bounds,
    fvlSource:bounds?.source??null,hasNonNutritiveSweeteners:p.unresolvedFields?.includes('ingredients')?null:classification.sweeteners };
  // Saturated fat cannot exceed total fat. This may resolve the component's
  // points when its entire possible range sits below the first threshold; it
  // does not fill the missing saturated-fat quantity with zero.
  if(input.saturatedFat===null&&!input.nutrientBounds.saturatedFat&&input.fat!==null)
    input.nutrientBounds.saturatedFat={value:input.fat,relation:'lte',source:'supplied-total-fat-upper-bound'};
  // Sugars are part of carbohydrate. The upper bound may establish invariant
  // sugar points, but the unreported sugar quantity remains unknown.
  if(DIRECTIONAL&&input.sugars===null&&!input.nutrientBounds.sugars&&input.carbohydrate!==null)
    input.nutrientBounds.sugars={value:input.carbohydrate,relation:'lte',source:'supplied-carbohydrate-upper-bound'};
  return input;
}
function resolveClassification(p) {
  if(p.unresolvedFields?.includes('ingredients'))p={...p,ingredientsNeedsReview:true,ingredients:null,ingredientItems:[]};
  return validateClassification(p,{category:'unknown',evidence:[],sweeteners:'unknown',sweetenerEvidence:[]});
}
// Snapshot binding, not authentication. Only trusted source adapters create
// provider envelopes; the server must never trust a client-authored envelope.
// Normalise native, browser and backend fact shapes before binding, and omit
// images, retrieval times and human-readable provenance descriptions.
function providerFactsFingerprint(p={}) {
  const str=v=>typeof v==='string'?v.trim():'';
  const list=v=>Array.isArray(v)?v.filter(x=>typeof x==='string').map(str).filter(Boolean):[];
  const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const nutrient=(n,unit)=>{
    const value=finite(n?.value)&&n.status!=='unknown'?n.value:null;
    const relation=({eq:'=',approx:'~',lt:'<',lte:'<=',gt:'>',gte:'>=','≤':'<=','≥':'>='})[n?.relation]||str(n?.relation)||'=';
    return {value,unit:str(n?.unit)||unit,status:value===null?'unknown':str(n?.status)||'supplied',relation:value===null?'=':relation};
  };
  const keys=['energyKcal','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'];
  const flags={};for(const key of flagNames)flags[key]=typeof p.scoringFacts?.[key]==='boolean'?p.scoringFacts[key]:null;
  const fvl=p.scoringFacts?.fvlPercent;
  flags.fvlPercent=finite(fvl?.value)?{value:fvl.value,source:str(fvl.source),evidence:str(fvl.evidence)}:null;
  const ingredients=typeof p.ingredients==='string'?p.ingredients:p.ingredients?.text;
  const review=typeof p.ingredientsNeedsReview==='boolean'?p.ingredientsNeedsReview:typeof p.ingredients?.needsReview==='boolean'?p.ingredients.needsReview:null;
  const facts={name:str(p.name),brand:str(p.brand),barcode:str(p.barcode),basisUnit:str(p.basisUnit),nutritionPreparation:str(p.nutritionPreparation),
    ingredients:str(ingredients),ingredientsNeedsReview:review,
    ingredientItems:(Array.isArray(p.ingredientItems)?p.ingredientItems:[]).map(i=>({id:str(i?.id),text:str(i?.text),percent:finite(i?.percent)?i.percent:null})),
    categories:[...new Set([...list(p.categories),...list(p.categoriesTags),...(str(p.categoryTag)?[str(p.categoryTag)]:[])])].sort(),
    nutrients:Object.fromEntries(keys.map(k=>[k,nutrient(p.nutrients?.[k],k==='energyKcal'?'kcal':'g')])),energyKj:nutrient(p.energyKj,'kJ'),scoringFacts:flags,
    estimatedSources:keys.concat('energyKj').filter(k=>str(p.nutrientSources?.[k]).toLowerCase()==='estimate'),
    unresolvedFields:[...new Set(list(p.unresolvedFields))].sort()};
  const stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
  const s=stable(facts);let a=2166136261,b=2246822519;
  for(let i=0;i<s.length;i++){a=Math.imul(a^s.charCodeAt(i),16777619);b=Math.imul(b^s.charCodeAt(i),3266489917);}
  return 'off2023-facts-v1:'+s.length+':'+(a>>>0).toString(16)+':'+(b>>>0).toString(16);
}
// Cache identity contains the validated food facts, never capture time, pictures,
// selected portion or user/account state. Official provider grades are separate.
function inputFingerprint(product) {
  const sodiumNormalized=/^Calculated from source sodium \((?:g × 2\.5|mg × 2\.5 ÷ 1000)\)$/.test(product?.nutrientSources?.salt||'');
  const provider=DIRECTIONAL?providerScore(product):null;
  const context={sodiumNormalized,...(DIRECTIONAL?{providerInputs:directionalProviderEvidence(provider),sourceEstimateKeys:sourceEstimateKeys(product)}:{}),providerEstimates:product?.sourceName==='Open Food Facts',sourceKind:['composition','meal'].includes(product?.sourceKind)?product.sourceKind:null,type:product?.type==='meal'?'meal':null};
  return SCORE_METHOD+':'+CLASSIFIER_VERSION+':'+providerFactsFingerprint(product)+':'+JSON.stringify(context);
}
function providerScore(product) {
  const p=product||{},provider=p.providerNutriScore;
  if(!object(provider)||provider.source!=='Open Food Facts'||p.sourceName!=='Open Food Facts'||provider.version!=='2023'
    ||provider.computed!==true||provider.applicable!==true||provider.categoryAvailable!==true||provider.nutrientsAvailable!==true
    ||typeof provider.estimated!=='boolean'||!/^\d{4,18}$/.test(p.barcode||'')||provider.barcode!==p.barcode
    ||provider.sourceURL!==`https://world.openfoodfacts.org/product/${p.barcode}`||p.sourceURL!==provider.sourceURL
    ||!['g','ml'].includes(p.basisUnit)||!['as_sold','prepared'].includes(provider.preparation)||provider.preparation!==p.nutritionPreparation
    ||provider.factsFingerprint!==providerFactsFingerprint(p)||(p.unresolvedFields||[]).length)return null;
  const category=provider.category,grade=String(provider.grade||'').toUpperCase(),raw=provider.rawScore;
  if(!categories.slice(0,6).includes(category)||!Number.isInteger(raw)||gradeFor(raw,category)!==grade)return null;
  const classification=resolveClassification(p);
  if(classification.conflicts.length||classification.category==='unsupported'
    ||classification.category!=='unknown'&&classification.category!==category)return null;
  const integer=v=>Number.isInteger(v)&&v>=0;
  if(!integer(provider.negativePoints)||!integer(provider.positivePoints)||typeof provider.countProteins!=='boolean'
    ||provider.negativePoints-provider.positivePoints!==raw)return null;
  const expectedProtein=category==='water'?false:category==='beverage'||category==='cheese'||provider.negativePoints<(category==='fats_nuts_seeds'?7:11);
  if(provider.countProteins!==expectedProtein)return null;
  if(category==='water'){
    const input=scoringInputs(p,classification);
    if(['energyKj','sugars','fat','saturatedFat','protein'].some(key=>input[key]>0||input.nutrientBounds?.[key]?.value>0)||input.hasNonNutritiveSweeteners===true
      ||/\b(?:flavou?r(?:ed|ing|s)?|sweetened|sugar|juice|syrup|honey|aspartame|sucralose)\b/i.test([p.name,p.ingredients].filter(Boolean).join(' ')))return null;
  }
  const descriptions={energy:['energy','Energy','kJ',10],sugars:['sugars','Sugars','g',category==='beverage'?10:15],
    saturated_fat:['saturatedFat','Saturated fat','g',10],salt:['salt','Salt','g',20],
    energy_from_saturated_fat:['energyFromSaturates','Energy from saturated fat','kJ',10],saturated_fat_ratio:['saturateRatio','Saturated fat / total fat','%',10],
    non_nutritive_sweeteners:['sweeteners','Non-nutritive sweeteners','number',4],
    proteins:['protein','Protein','g',7],fiber:['fibre','Fibre','g',5],
    fruits_vegetables_legumes:['fvl','Fruit, vegetables and legumes','%',category==='beverage'?6:5]};
  const negativeIds=category==='water'?[]:category==='fats_nuts_seeds'?['energy_from_saturated_fat','saturated_fat_ratio','sugars','salt']:
    ['energy','saturated_fat','sugars','salt',...(category==='beverage'?['non_nutritive_sweeteners']:[])];
  const positiveIds=category==='water'?[]:['fiber','fruits_vegetables_legumes',...(provider.countProteins?['proteins']:[])];
  const parse=(rows,expected,positive)=>{
    if(!Array.isArray(rows)||rows.length>20)return null;
    const ids=new Set(),out=[];
    for(const part of rows){
      const info=descriptions[part?.id];
      // OFF reports the generic protein scale maximum (7) even when red-meat
      // protein points are capped at 2. Sweetener quantities are counts, with
      // "number" as the OFF unit; also accept legacy unitless envelopes.
      if(!info||ids.has(part.id)||!expected.includes(part.id)&&!(positive&&!provider.countProteins&&part.id==='proteins')
        ||!integer(part.points)||!integer(part.pointsMax)||part.points>part.pointsMax||part.pointsMax>info[3]
        ||category==='red_meat'&&part.id==='proteins'&&part.points>2
        ||part.unit!==info[2]&&!(part.id==='non_nutritive_sweeteners'&&part.unit==='')
        ||part.value!==null&&(typeof part.value!=='number'||!Number.isFinite(part.value)||part.value<0||part.value>100000))return null;
      ids.add(part.id);out.push({id:info[0],label:info[1],value:part.value,unit:part.unit,points:part.points,pointsLower:part.points,pointsUpper:part.points,
        pointsMax:part.pointsMax,counted:!positive||part.id!=='proteins'||provider.countProteins,missing:part.value===null,
        ...(positive&&part.id==='proteins'&&!provider.countProteins?{reason:'Protein points are excluded by the source Nutri-Score calculation.'}:{})});
    }
    return expected.every(id=>ids.has(id))?out:null;
  };
  const negative=parse(provider.components?.negative,negativeIds,false),positive=parse(provider.components?.positive,positiveIds,true);
  if(!negative||!positive||negative.reduce((sum,x)=>sum+x.points,0)!==provider.negativePoints
    ||positive.filter(x=>x.counted).reduce((sum,x)=>sum+x.points,0)!==provider.positivePoints)return null;
  const value=GRADE_SCORES[grade],missing=[...negative,...positive].filter(x=>x.missing).map(x=>x.label+' quantity not reported by the source');
  const result={...unratedScore('',missing,category,scoringInputs(p,classification)),available:true,status:provider.estimated?'estimated':'rated',estimated:provider.estimated,
    scoreBasis:'provider_nutriscore_2023',completeness:provider.estimated?'provider_estimate':missing.length?'provider_calculated_with_unreported_quantities':'provider_calculated',
    grade,rawScore:raw,rawLower:raw,rawUpper:raw,value,displayLower:value,displayUpper:value,band:bandFor(value),baseFrequency:null,finalFrequency:null,frequencyStatus:'not_provided',
    negativePoints:provider.negativePoints,positivePoints:provider.positivePoints,positivePointsUpper:provider.positivePoints,countProteins:provider.countProteins,
    components:{negative,positive},providerGrade:grade,provider:{source:provider.source,version:'2023',sourceURL:provider.sourceURL,barcode:p.barcode,preparation:provider.preparation,estimated:provider.estimated,factsFingerprint:provider.factsFingerprint},
    assumptions:provider.estimated?['Open Food Facts marks this Nutri-Score as estimated.']:[],reasonCodes:['provider_nutriscore_2023','nudge_grade_display_conversion',...(provider.estimated?['provider_estimate']:[])],
    calculationBasis:{per:100,unit:p.basisUnit,preparation:provider.preparation},sources:[{title:'Open Food Facts · Nutri-Score 2023',url:provider.sourceURL},{title:'Santé publique France · updated Nutri-Score 2023',url:SCORE_SOURCE}],
    reason:'Open Food Facts Nutri-Score 2023, shown using Nudge’s grade conversion.'};
  result.explanation=`Open Food Facts Nutri-Score 2023: grade ${grade}, raw score ${raw}. Nudge displays this as ${value}/100 using A100/B75/C50/D25/E0. This is a display conversion, not an official percentage or an eating-frequency recommendation.`+(provider.estimated?' Open Food Facts marks the source result as estimated.':'');
  return result;
}

// Admit only component quantities from a complete, source-bound provider
// envelope. Final grade/raw totals never become Nudge calculation inputs.
function directionalProviderEvidence(provider) {
  if(!provider)return {};
  const fvl=provider.components.positive.find(part=>part.id==='fvl')?.value;
  const sweeteners=provider.components.negative.find(part=>part.id==='sweeteners')?.value;
  return {...(Number.isFinite(fvl)&&fvl>=0&&fvl<=100?{fvlPercent:fvl}:{}),
    ...(Number.isInteger(sweeteners)&&sweeteners>=0?{sweeteners:sweeteners>0}:{})};
}
function sourceEstimateKeys(food) {
  if(food?.sourceName!=='Open Food Facts')return [];
  return Object.entries({...food.nutrients,energyKj:food.energyKj}).filter(([key,n])=>{
    const unit=key==='energyKj'?'kJ':key==='energyKcal'?'kcal':'g',source=food.nutrientSources?.[key];
    return ['energyKcal','energyKj','protein','carbohydrate','fat','saturatedFat','sugars','fibre','salt'].includes(key)&&n&&n.unit===unit&&Number.isFinite(n.value)&&n.value>=0
      &&(n.status==='estimated'&&source==='estimate'&&(n.relation==null||['~','approx','=','eq'].includes(n.relation))
        ||['supplied','confirmed'].includes(n.status)&&['~','approx'].includes(n.relation)
          &&/^Open Food Facts (?:structured nutrition|legacy nutriments|nutrient energy)$/.test(source||''));
  }).map(([key])=>key).sort();
}
function calculateSourceEstimate(food,classification=resolveClassification(food),sourceProduct=food) {
  if(!DIRECTIONAL||!food||!['g','ml'].includes(food.basisUnit)||!['as_sold','prepared'].includes(food.nutritionPreparation)
    ||(food.unresolvedFields||[]).some(k=>['identity','nutrition','preparation'].includes(k)))return null;
  const keys=sourceEstimateKeys(food);if(!keys.length)return null;
  const estimatedInputs={},adapt=(n,key)=>{
    if(!keys.includes(key))return n;
    estimatedInputs[key]={...n,source:food.nutrientSources[key]};return {...n,status:'supplied',relation:'eq'};
  };
  const projection={...food,nutrients:Object.fromEntries(Object.entries(food.nutrients||{}).map(([key,n])=>[key,adapt(n,key)])),energyKj:adapt(food.energyKj,'energyKj')};
  // Supplied exact kcal beats an estimated kJ calculation from the same table.
  if(estimatedInputs.energyKj&&exactValue(food.nutrients?.energyKcal,'kcal')!==null){projection.energyKj=food.energyKj;delete estimatedInputs.energyKj;}
  if(!Object.keys(estimatedInputs).length)return null;
  const result=calculatePreparedScore(projection,classification,sourceProduct);if(!result.available)return null;
  return {...result,estimated:true,status:result.status==='provisional'?'estimated_provisional':'estimated',scoreBasis:'provider_nutrient_estimate',
    label:'Nudge score',confidence:'estimated',inputFingerprint:inputFingerprint(food),
    inferredInputs:{...result.inferredInputs,nutrients:estimatedInputs},inputs:{...result.inputs,estimatedInputs},sourceData:{...result.sourceData,estimatedInputs},
    reasonCodes:[...result.reasonCodes,'provider_nutrients_estimated'],
    assumptions:[...result.assumptions,'Numeric source estimates are used only in this calculation; source values and qualifiers remain unchanged.'],
    explanation:result.explanation+' Numeric source estimates are approximate; verified source values take precedence.'};
}

function displayFor(raw,category='general') {return GRADE_SCORES[gradeFor(raw,category)]??null;}
function bandFor(value) {
  if(!Object.values(GRADE_SCORES).includes(value))return null;
  return {id:value>=75?'green':value===50?'amber':'red',label:value>=75?'Green':value===50?'Amber':'Red',interpretation:DIRECTIONAL?'Nudge directional nutrition score':'Nudge display conversion of the Nutri-Score grade'};
}
// This proposed adult planning policy is separate from the nutrition algorithm.
// Callers must pass actual selected-occasion salt, never the product's per100g salt.
function frequency(baseFrequency,servingSaltGrams,{suitability='no_known_conflict',exclusions=[]}={}) {
  const result={frequency:null,finalFrequency:null,status:'pending',frequencyStatus:'pending',reasonCodes:[],personalSuitability:suitability,
    policyVersion:'nudge-frequency-0.2',portionSaltGrams:typeof servingSaltGrams==='number'&&Number.isFinite(servingSaltGrams)&&servingSaltGrams>=0?servingSaltGrams:null};
  const finish=(status,reason,final=null)=>({...result,status,frequencyStatus:status,reasonCodes:reason?[reason]:[],frequency:final,finalFrequency:final});
  if(['confirmed_conflict','matched_recall'].includes(suitability))return finish('unsuitable',suitability);
  if(suitability!=='no_known_conflict')return finish('check_required',suitability==='restriction_unresolved'?suitability:'suitability_unresolved');
  if(Array.isArray(exclusions)&&exclusions.length)return {...finish('excluded','generic_adult_guidance_excluded'),exclusions:[...exclusions]};
  const order=['Daily','Weekly','Monthly'];
  if(!order.includes(baseFrequency))return finish('incomplete','nutrition_score_unavailable');
  if(result.portionSaltGrams===null)return finish('incomplete','portion_salt_unknown');
  const floor=compare(servingSaltGrams,4)>=0?'Monthly':compare(servingSaltGrams,2)>=0?'Weekly':'Daily';
  const final=order[Math.max(order.indexOf(baseFrequency),order.indexOf(floor))];
  return {...finish('prototype_guidance',final!==baseFrequency?'portion_salt_frequency_floor':'base_frequency_retained',final),
    portionFloor:floor,saltSharePercent:servingSaltGrams/6*100};
}
function withPortion(score,servingSaltGrams,options={}) {
  if(score?.methodId===SCORE_METHOD)return {...score,baseFrequency:null,finalFrequency:null,frequencyStatus:'not_provided',frequencyPolicy:null,personalSuitability:options.suitability||score.personalSuitability||'unchecked'};
  const result=frequency(score?.baseFrequency,servingSaltGrams,options);
  return {...score,finalFrequency:result.finalFrequency,frequencyStatus:result.status,frequencyPolicy:result,
    personalSuitability:result.personalSuitability,reasonCodes:[...new Set([...(score?.reasonCodes||[]),...result.reasonCodes])]};
}
function validResult(score) {
  if(!score||score.methodId!==SCORE_METHOD||(score.methodVersion||score.version)!==SCORE_VERSION
    ||score.version!=null&&score.version!==SCORE_VERSION
    ||!['rated','provisional','estimated','estimated_provisional'].includes(score.status)
    ||!Number.isInteger(score.rawScore)||!['general','cheese','red_meat','fats_nuts_seeds','beverage','water'].includes(score.category))return false;
  const grade=gradeFor(score.rawScore,score.category),band=bandFor(score.value);
  return grade!==null&&score.grade===grade&&score.value===GRADE_SCORES[grade]&&band!==null
    &&score.baseFrequency===null&&score.finalFrequency===null
    &&(!score.band||score.band.id===band.id&&score.band.label===band.label);
}

const TABLES = Object.freeze({
  energy: [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350],
  sugars: [3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51],
  saturatedFat: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  salt: [.2, .4, .6, .8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.4, 3.6, 3.8, 4],
  fibre: [3, 4.1, 5.2, 6.3, 7.4], protein: [2.4, 4.8, 7.2, 9.6, 12, 14, 17], fvl: [40, 60, 80, 80, 80],
  energyFromSaturates: [120, 240, 360, 480, 600, 720, 840, 960, 1080, 1200],
  saturateRatio: [10, 16, 22, 28, 34, 40, 46, 52, 58, 64],
  beverageEnergy: [30, 90, 150, 210, 240, 270, 300, 330, 360, 390],
  beverageSugars: [.5, 2, 3.5, 5, 6, 7, 8, 9, 10, 11],
  beverageProtein: [1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3], beverageFvl: [40, 40, 60, 60, 80, 80]
});
// Treat only machine-representation noise as equality; source decimals are not rounded.
const compare=(a,b)=>Math.abs(a-b)<=Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b))*8?0:Math.sign(a-b);
const pointsFor=(value,table,inclusive=false)=>table.filter(threshold=>inclusive?compare(value,threshold)>=0:compare(value,threshold)>0).length;
function nutrientBound(n) {
  if(!n||n.unit!=='g'||!['supplied','confirmed'].includes(n.status)||typeof n.value!=='number'||!Number.isFinite(n.value)||n.value<0||n.value>100)return null;
  const relation={lt:'lt','<':'lt',lte:'lte','<=':'lte','≤':'lte',gt:'gt','>':'gt',gte:'gte','>=':'gte','≥':'gte'}[n.relation];
  return relation?{value:n.value,relation,source:'declared-nutrient-bound'}:null;
}
// Bounds describe quantities, not replacement quantities. Only admit a bound
// when every permitted quantity gives the same component points. Open endpoints
// are handled analytically, without epsilon-adjusted invented label values.
function boundPoints(bound,table,inclusive=false) {
  if(!bound||!['lt','lte','gt','gte'].includes(bound.relation)||typeof bound.value!=='number'||!Number.isFinite(bound.value)||bound.value<0||bound.value>100
    ||bound.relation==='lt'&&bound.value===0||bound.relation==='gt'&&bound.value===100)return null;
  const below=table.filter(t=>compare(t,bound.value)<0).length;
  const atOrBelow=table.filter(t=>compare(t,bound.value)<=0).length;
  const lower=['lt','lte'].includes(bound.relation)?pointsFor(0,table,inclusive):
    bound.relation==='gt'||inclusive?atOrBelow:below;
  const upper=['gt','gte'].includes(bound.relation)?pointsFor(100,table,inclusive):
    bound.relation==='lt'||!inclusive?below:atOrBelow;
  return {lower,upper,resolved:lower===upper};
}
function resolvedNutrientPoints(input,key,category) {
  // The fats profile derives a ratio and saturated-fat energy; keep requiring
  // exact fat/saturates there until their joint interval can be established.
  if(key==='fat'||category==='fats_nuts_seeds'&&key==='saturatedFat')return null;
  const table=key==='sugars'&&category==='beverage'?TABLES.beverageSugars:
    key==='protein'&&category==='beverage'?TABLES.beverageProtein:TABLES[key];
  const points=table?boundPoints(input.nutrientBounds?.[key],table):null;
  return points?.resolved?points.lower:null;
}
function missingScoringInputs(input,category,sourceKind=null) {
  const missing=[];
  if(!categories.slice(0,6).includes(category))missing.push('category');
  if(!['g','ml'].includes(input.basisUnit))missing.push('basisUnit');
  if(!(DIRECTIONAL?['as_sold','prepared'].includes(input.nutritionPreparation):input.nutritionPreparation==='as_sold')&&!(sourceKind==='composition'&&input.nutritionPreparation==='as_consumed'))missing.push('nutritionPreparation');
  if(category!=='water'){
    const required=['sugars','saturatedFat','salt',...(!DIRECTIONAL?['fibre','protein']:[]),category==='fats_nuts_seeds'?'fat':'energyKj'];
    if(category==='beverage'&&!DIRECTIONAL)required.push('hasNonNutritiveSweeteners');
    for(const key of required)if(input[key]===null&&resolvedNutrientPoints(input,key,category)===null)missing.push(key);
    if(!DIRECTIONAL&&input.fvlPercent===null&&sourceKind!=='composition'){
      const range=input.fvlBounds,table=category==='beverage'?TABLES.beverageFvl:TABLES.fvl;
      if(!range||pointsFor(range.lower,table)!==pointsFor(range.upper,table))missing.push('fvlPercent');
    }
  }
  return missing;
}

function gradeFor(raw, category='general') {
  if(!Number.isInteger(raw)||raw < -17||raw > 59||!categories.slice(0,6).includes(category))return null;
  if (category === 'water') return raw===0?'A':null;
  if(category!=='beverage'&&raw>55)return null;
  if (category === 'beverage') return raw <= 2 ? 'B' : raw <= 6 ? 'C' : raw <= 9 ? 'D' : 'E';
  return raw <= (category === 'fats_nuts_seeds' ? -6 : 0) ? 'A' : raw <= 2 ? 'B' : raw <= 10 ? 'C' : raw <= 18 ? 'D' : 'E';
}
const labels = { energy: 'Energy', sugars: 'Sugars', saturatedFat: 'Saturated fat', salt: 'Salt', fibre: 'Fibre', protein: 'Protein',
  fvl: 'Fruit, vegetables and legumes', sweeteners: 'Non-nutritive sweeteners', energyFromSaturates: 'Energy from saturated fat', saturateRatio: 'Saturated fat / total fat' };
const neededLabels = { category: 'supported food category', basisUnit: 'per-100-g or per-100-ml basis', nutritionPreparation: 'supported nutrition preparation',
  energyKj: 'declared energy in kJ', sugars: 'sugars', fat: 'total fat', saturatedFat: 'saturated fat', salt: 'salt', fibre: 'fibre', protein: 'protein',
  fvlPercent: 'fruit, vegetable and legume percentage', hasNonNutritiveSweeteners: 'whether non-nutritive sweeteners are present' };
function unratedScore(reason, missingInputs = [], category = 'unknown', inputs = null) {
  return {status:'unrated',methodStatus:DIRECTIONAL?'directional':'proposed_beta',grade:null,rawScore:null,rawLower:null,rawUpper:null,
    value:null,displayLower:null,displayUpper:null,band:null,methodId:SCORE_METHOD,version:SCORE_VERSION,methodVersion:SCORE_VERSION,model_version:SCORE_VERSION,classifierVersion:CLASSIFIER_VERSION,sourceVersion:'SPF-FAQ-2025-03-17/2023',baseAlgorithmVersion:'2023',category,
    available:false,label:DIRECTIONAL?'Nudge score':'Nudge nutrition score',completeness:'incomplete',assumptions:[],baseFrequency:null,finalFrequency:null,frequencyStatus:'not_provided',reasonCodes:['essential_inputs_missing'],personalSuitability:'unchecked',
    components:{negative:[],positive:[]},negativePoints:null,positivePoints:null,countProteins:null,
    missingInputs,missingFields:missingInputs,reason,explanation:reason,inputs,
    sources:[{title:'Santé publique France · updated Nutri-Score 2023 nutrient model',url:SCORE_SOURCE}],
    promptVersion:SCORE_PROMPT_VERSION,calculationBasis:inputs?.basisUnit?{unit:inputs.basisUnit,per:100,preparation:inputs.nutritionPreparation}:null};
}
function calculateScore(product, classification=resolveClassification(product), sourceProduct=product) {
  return calculatePreparedScore(product,classification,sourceProduct);
}
function directionalEnergyConflict(product) {
  const estimates=sourceEstimateKeys(product);
  const quantity=(key,n,unit)=>exactValue(n,unit)??(estimates.includes(key)?n.value:null);
  const kcal=quantity('energyKcal',product.nutrients?.energyKcal,'kcal'),kj=quantity('energyKj',product.energyKj,'kJ');
  if(kcal===null||kj===null)return false;
  // A gross disagreement is a quality guard, never permission to select the
  // more favourable value. Allow rounding and modest computed-energy variation.
  return Math.abs(kcal*4.184-kj)>Math.max(100,Math.max(kcal*4.184,kj)*.25);
}
function calculatePreparedScore(product, classification, sourceProduct) {
  // Retain OFF's validated result as source metadata; it never supplies Nudge's
  // number or fills an unknown adverse nutrient.
  const provider=providerScore(DIRECTIONAL?sourceProduct:product);
  if(provider&&!DIRECTIONAL)return provider;
  const identity=typeof product.name==='string'?product.name.trim():'';
  const identified=identity.length>=2&&!instructionText.test(normalized(identity))
    &&!/^(?:(?:unknown|unidentified|unreadable|mystery|fixture|synthetic|your)\s+)*(?:food|item|product|meal|dish)?$/i.test(identity);
  // Recheck admission for caller-supplied classifications and source-estimate
  // projections as well as resolveClassification; a quoted general label cannot
  // repair an explicit clash or bypass an unsupported product form.
  if(DIRECTIONAL){
    const issue=directionalAdmissionIssue(product,classification.category);
    if(issue)return {...unratedScore('The source product identity or special category needs checking.',['consistent supported product identity'],issue.category,scoringInputs(product,classification)),reasonCodes:[issue.reason],classificationEvidence:{version:CLASSIFIER_VERSION,evidence:classification.evidence||[],resolutions:classification.resolutions||[],conflicts:[...new Set([...(classification.conflicts||[]),issue.reason])]}};
  }
  const generalFallback=DIRECTIONAL&&classification.category==='unknown'&&!classification.conflicts?.length&&identified;
  const fallbackCategory=product.basisUnit==='ml'?'beverage':'general';
  if(generalFallback)classification={...classification,category:fallbackCategory,resolutions:[...(classification.resolutions||[]),'directional_'+fallbackCategory+'_fallback']};
  const category=classification.category,input=scoringInputs(product,classification);
  const providerInputs=DIRECTIONAL&&provider?.category===category?directionalProviderEvidence(provider):{},inferredProvider={};
  if(input.fvlPercent===null&&providerInputs.fvlPercent!=null
    &&(!input.fvlBounds||providerInputs.fvlPercent>=input.fvlBounds.lower&&providerInputs.fvlPercent<=input.fvlBounds.upper)){
    inferredProvider.fvlPercent={value:providerInputs.fvlPercent,unit:'%',status:'estimated',method:'off_2023_component',sourceURL:sourceProduct.sourceURL};
    input.fvlPercent=providerInputs.fvlPercent;input.fvlBounds={lower:input.fvlPercent,upper:input.fvlPercent,source:'off_2023_component_estimate'};input.fvlSource='off_2023_component_estimate';
  }
  if(input.hasNonNutritiveSweeteners===null&&providerInputs.sweeteners!=null){
    inferredProvider.hasNonNutritiveSweeteners={value:providerInputs.sweeteners,method:'off_2023_component',sourceURL:sourceProduct.sourceURL};
    input.hasNonNutritiveSweeteners=providerInputs.sweeteners;
  }
  const conflicts=(product.unresolvedFields||[]).filter(v=>['nutrition','preparation','identity'].includes(v));
  if(conflicts.length)return unratedScore('Conflicting '+conflicts.join(', ')+' evidence; check the current pack or retake that photo.',conflicts.map(v=>'consistent '+v),category,input);
  if(category==='unsupported'||product.sourceKind==='meal'||product.type==='meal')return unratedScore('This category is outside the supported packaged-product score.',['supported food category'],category,input);
  if(DIRECTIONAL&&directionalEnergyConflict(product))return {...unratedScore('The source energy values disagree; check the nutrition panel.',['consistent energy values'],category,input),reasonCodes:['conflicting_source_energy']};
  if(DIRECTIONAL&&category!=='water'&&input.energyKj===0&&['sugars','fat','saturatedFat','salt','fibre','protein','carbohydrate'].every(key=>input[key]===null||input[key]===0))
    return {...unratedScore('The all-zero nutrition panel needs checking before this food can be scored.',['verified non-zero nutrition or plain-water identity'],category,input),reasonCodes:['all_zero_non_water_nutrition']};
  if(category==='water'&&(['energyKj','sugars','fat','saturatedFat','protein'].some(key=>input[key]>0||input.nutrientBounds?.[key]?.value>0)||input.hasNonNutritiveSweeteners===true||/\b(?:flavou?r(?:ed|ing|s)?|sweetened|sugar|juice|syrup|honey|aspartame|sucralose)\b/i.test([product.name,product.ingredients].filter(Boolean).join(' '))))return unratedScore('The supplied facts conflict with plain water.',['consistent plain-water identity and nutrition'],category,input);
  const missing=missingScoringInputs(input,category,product.sourceKind);
  if(DIRECTIONAL&&!identified&&category!=='water'&&product.sourceKind!=='composition')missing.unshift('identity');
  if(['sugars','fat','saturatedFat','salt','fibre','protein'].some(key=>input[key]!==null&&(!Number.isFinite(input[key])||input[key]<0||input[key]>100))||input.energyKj!==null&&input.energyKj>4184||input.fvlPercent!==null&&(!Number.isFinite(input.fvlPercent)||input.fvlPercent<0||input.fvlPercent>100))return unratedScore('Check the source nutrition values.',['valid per-100-unit nutrition'],category,input);
  if(missing.length)return unratedScore(`Needed: ${missing.map(key=>neededLabels[key]||'identifiable food').join(', ')}.`,missing.map(key=>neededLabels[key]||'identifiable food'),category,input);
  const minimum=key=>input[key]??(['gt','gte'].includes(input.nutrientBounds?.[key]?.relation)?input.nutrientBounds[key].value:0);
  const maximum=key=>input[key]??(['lt','lte'].includes(input.nutrientBounds?.[key]?.relation)?input.nutrientBounds[key].value:100);
  if(Object.values(input.nutrientBounds||{}).some(b=>b&&(b.relation==='lt'&&b.value===0||b.relation==='gt'&&b.value===100))
    ||minimum('saturatedFat')>maximum('fat')+.05||category==='fats_nuts_seeds'&&input.fat===0
    ||minimum('sugars')>maximum('carbohydrate')+.05)return unratedScore('The label values conflict; check the nutrition panel.',['consistent nutrition values'],category,input);
  const negative=[],positive=[];
  const add=(list,id,value,unit,table,inclusive=false,bounds=null)=>{
    let lower=value===null?(bounds?pointsFor(bounds.lower,table,inclusive):0):pointsFor(value,table,inclusive);
    let upper=value===null?(bounds?pointsFor(bounds.upper,table,inclusive):table.length):lower;
    const bound=value===null?input.nutrientBounds?.[id]:null,interval=boundPoints(bound,table,inclusive);
    if(interval){lower=interval.lower;upper=interval.upper;}
    const part={id,label:labels[id],value,unit,points:lower,pointsLower:lower,pointsUpper:upper,pointsMax:table.length,counted:true,missing:value===null&&!interval?.resolved,
      ...(bound?{bound,quantityIsExact:false,assumption:'Every quantity within the supplied bound has the same nutrient points; the exact amount remains unknown.'}:{})};
    list.push(part);return part;
  };
  const beverage=category==='beverage',fats=category==='fats_nuts_seeds';
  if(category!=='water') {
    if(fats){add(negative,'energyFromSaturates',input.saturatedFat*37,'kJ',TABLES.energyFromSaturates);add(negative,'saturateRatio',input.saturatedFat/input.fat*100,'%',TABLES.saturateRatio,true);}
    else{add(negative,'energy',input.energyKj,'kJ',beverage?TABLES.beverageEnergy:TABLES.energy);add(negative,'saturatedFat',input.saturatedFat,'g',TABLES.saturatedFat);}
    add(negative,'sugars',input.sugars,'g',beverage?TABLES.beverageSugars:TABLES.sugars);add(negative,'salt',input.salt,'g',TABLES.salt);
    if(beverage){const unknown=input.hasNonNutritiveSweeteners===null,points=unknown||input.hasNonNutritiveSweeteners?4:0;
      negative.push({id:'sweeteners',label:labels.sweeteners,value:unknown?null:input.hasNonNutritiveSweeteners?1:0,unit:'presence',points,pointsLower:points,pointsUpper:points,pointsMax:4,counted:true,...(unknown?{assumption:'Sweetener status is unknown; the directional score applies the conservative four-point deduction.'}:{})});}
    const fvl=add(positive,'fvl',input.fvlPercent,'%',beverage?TABLES.beverageFvl:TABLES.fvl,false,input.fvlBounds);
    if(input.fvlPercent===null&&input.fvlBounds&&fvl.pointsLower===fvl.pointsUpper){fvl.missing=false;fvl.quantityIsExact=false;fvl.assumption='Every percentage within the supported ingredient bounds gives the same component points.';}
    add(positive,'fibre',input.fibre,'g',TABLES.fibre);
    const protein=add(positive,'protein',input.protein,'g',beverage?TABLES.beverageProtein:TABLES.protein);
    if(DIRECTIONAL)for(const part of positive.filter(p=>['fibre','protein'].includes(p.id)))
      if(input[part.id]===null&&resolvedNutrientPoints(input,part.id,category)===null){
        part.points=0;part.pointsLower=0;part.assumption='No positive bonus is used when the exact component points are unknown.';
      }
    if(category==='red_meat'){for(const key of ['points','pointsLower','pointsUpper'])protein[key]=Math.min(protein[key],2);protein.pointsMax=2;protein.reason='Red-meat protein points are capped at 2.';}
  }
  const negativePoints=negative.reduce((sum,part)=>sum+part.points,0);
  const countProteins=category==='water'?false:beverage||category==='cheese'||negativePoints<(fats?7:11);
  const protein=positive.find(part=>part.id==='protein');
  if(protein&&!countProteins){protein.counted=false;protein.reason=`Protein points are excluded when negative points reach ${fats?7:11} for this category.`;}
  const positivePoints=positive.filter(part=>part.counted).reduce((sum,part)=>sum+part.points,0);
  const rawScore=category==='water'?0:negativePoints-positivePoints,grade=gradeFor(rawScore,category),value=GRADE_SCORES[grade];
  const unknownFvl=category!=='water'&&input.fvlPercent===null&&(!input.fvlBounds||pointsFor(input.fvlBounds.lower,beverage?TABLES.beverageFvl:TABLES.fvl)!==pointsFor(input.fvlBounds.upper,beverage?TABLES.beverageFvl:TABLES.fvl));
  const unknownPositive=['fibre','protein'].filter(key=>input[key]===null&&resolvedNutrientPoints(input,key,category)===null);
  const unknownSweeteners=beverage&&input.hasNonNutritiveSweeteners===null;
  // Composition meals retain their existing internal estimate status. Ordinary
  // product fallbacks use the same points and keep uncertainty in metadata.
  const provisional=(!DIRECTIONAL||product.sourceKind==='composition')&&unknownFvl;
  const missingInputs=[...(unknownFvl?['qualifying fruit, vegetable and legume percentage']:[]),...unknownPositive];
  const bounded=[...negative,...positive].some(part=>part.bound);
  const score={...unratedScore('',missingInputs,category,input),classificationEvidence:{version:CLASSIFIER_VERSION,evidence:classification.evidence||[],resolutions:classification.resolutions||[],conflicts:classification.conflicts||[]},available:true,status:provisional?'provisional':'rated',
    completeness:DIRECTIONAL?(generalFallback||unknownFvl||unknownPositive.length||unknownSweeteners?'nutrition_only':'complete'):provisional?'provisional_no_unverified_plant_bonus':'complete',...(DIRECTIONAL?{scoreBasis:'nudge_directional',inputFingerprint:inputFingerprint(sourceProduct)+(sourceProduct===product?'':':projection:'+providerFactsFingerprint(product)),sourceInputs:scoringInputs(sourceProduct,classification)}:{}),grade,rawScore,rawLower:rawScore,rawUpper:rawScore,
    value,displayLower:value,displayUpper:value,band:bandFor(value),baseFrequency:null,finalFrequency:null,frequencyStatus:'not_provided',
    negativePoints,positivePoints,positivePointsUpper:positivePoints,countProteins,components:{negative,positive},
    assumptions:[...(inferredProvider.fvlPercent?['Qualifying plant share uses the retained OFF 2023 component estimate; it is not a declared recipe percentage.']:[]),...(inferredProvider.hasNonNutritiveSweeteners?['Sweetener status uses the retained OFF 2023 component quantity.']:[]),...(generalFallback?[fallbackCategory==='general'?'General-food nutrient rules used because no specific category is established.':'Beverage nutrient rules used for a volume-based food with no established category.']:[]),...(unknownSweeteners?['Sweetener status is unknown; the directional score applies the conservative four-point deduction.']:[]),...(unknownFvl?['No unverified plant bonus; the qualifying plant percentage remains unknown.']:[]),...unknownPositive.map(key=>`No unverified ${key} bonus; the source amount remains unknown.`),...(bounded?['Supplied nutrient bounds determine exact component points, not exact nutrient quantities.']:[])],
    ...(DIRECTIONAL?{inferredInputs:{...inferredProvider,...(generalFallback?{category:{value:fallbackCategory,method:'directional_'+fallbackCategory+'_fallback'}}:{}),...(unknownSweeteners?{sweetenerPoints:{value:4,method:'unknown_conservative_deduction'}}:{}),...(unknownFvl?{fvlPoints:{value:positive.find(p=>p.id==='fvl')?.points||0,method:'no_unverified_bonus'}}:{}),...Object.fromEntries(unknownPositive.map(key=>[key+'Points',{value:0,method:'no_unverified_bonus'}]))}}:{}),
    reasonCodes:['supported_nutrition_calculation',DIRECTIONAL?'nudge_directional':'nudge_grade_display_conversion',...(generalFallback?['directional_'+fallbackCategory+'_fallback']:[]),...(DIRECTIONAL&&unknownFvl?['no_unverified_plant_bonus']:[]),...(bounded?['point_invariant_nutrient_bounds']:[]),...((!DIRECTIONAL||!unknownFvl)&&input.fvlPercent===null&&category!=='water'?['point_invariant_ingredient_bounds']:[])],
    ...(provider?{providerReference:{source:'Open Food Facts',version:'2023',grade:provider.grade,rawScore:provider.rawScore,estimated:provider.estimated,sourceURL:sourceProduct.sourceURL}}:{}),
    sourceData:{source:product.sourceName??null,url:product.sourceURL??null,retrievedAt:product.retrievedAt??null,version:product.sourceVersion??null,
      nutrientSources:product.nutrientSources??null},
    quality:{extraction:product.extractionQuality??null,match:product.matchQuality??null,portion:product.portionUncertainty??null,evidence:product.evidenceStrength??null},
    reason:DIRECTIONAL?directionalReason(input,category):provisional?'Provisional: qualifying plant percentage is unknown; no unverified plant bonus awarded.':'Calculated from supported source nutrition using the updated category rules.'};
  score.explanation=explainScore(score,[]);return score;
}
function explainScore(score,emphasize=[]) {
  if(score.status==='unrated')return score.reason;
  const parts=[...score.components.negative,...score.components.positive];
  const selected=emphasize.map(id=>parts.find(part=>part.id===id)).filter(Boolean);
  const facts=selected.map(part=>part.counted===false?part.reason:`${part.label}: ${part.points} ${score.components.positive.includes(part)?'positive':'negative'} points.`);
  const protein=score.components.positive.find(part=>part.id==='protein');
  if(protein&&!score.countProteins&&!selected.some(part=>part.id==='protein'))facts.push(protein.reason);
  if(!DIRECTIONAL)return `Nudge nutrition score ${score.value}/100, grade ${score.grade}: raw ${score.rawScore} from ${score.negativePoints} negative minus ${score.positivePoints} eligible positive points. `+
    facts.join(' ')+(score.status==='provisional'?' Qualifying plant percentage is unknown; no unverified plant bonus awarded.':'')+
    ` Updated Nutri-Score 2023 category: ${score.category}. The fixed A100/B75/C50/D25/E0 mapping is Nudge’s display conversion, not an official percentage or an eating-frequency recommendation.`;
  return `${score.reason} A practical guide based on available nutrition and food information. Our scoring improves over time. `+
    facts.join(' ')+(score.assumptions?.length?' '+score.assumptions.join(' '):'');
}
function directionalReason(input,category) {
  if(category==='water')return 'Plain water, with no sugar or energy.';
  const factor=category==='beverage'?.5:1;
  const higher=[['sugars','sugar',22.5],['saturatedFat','saturated fat',5],['salt','salt',1.5]]
    .filter(([key,,threshold])=>input[key]!==null&&input[key]>=threshold*factor).map(([,name])=>name);
  const join=values=>values.length<3?values.join(' and '):values.slice(0,-1).join(', ')+' and '+values.at(-1);
  if(higher.length)return 'Higher in '+join(higher)+(input.fibre!==null&&input.fibre<3?'; lower in fibre.':'.');
  if(input.fibre!==null&&input.fibre>=6)return 'Provides fibre, with the score also considering sugar, saturated fat and salt.';
  return 'Based on energy, sugars, saturated fat and salt per 100 '+input.basisUnit+'.';
}

// Shared presentation only: products and meals retain their own calculations.
const displayTone=value=>Number.isFinite(value)&&value>=0&&value<=100?(value<25?'red':value<50?'amber':'green'):'unknown';
function renderDial(value) {
  // Callers validate the score method. Presentation also supports qualified
  // rough estimates and preserved historical scores, independently of frequency.
  const rating=Number.isFinite(value)&&value>=0&&value<=100?value:null;
  const point=q=>{const a=Math.PI*(1-q/100);return [120+106*Math.cos(a),120-106*Math.sin(a)];};
  const arc=(lo,hi,tone)=>{const [x,y]=point(lo),[xx,yy]=point(hi);return `<path class="nf-arc-${tone}" d="M ${x.toFixed(3)} ${y.toFixed(3)} A 106 106 0 0 1 ${xx.toFixed(3)} ${yy.toFixed(3)}"/>`;};
  const marker=rating===null?'':(()=>{const [x,y]=point(rating);return `<circle class="nf-dial-marker" cx="${x.toFixed(3)}" cy="${y.toFixed(3)}" r="8"/>`;})();
  return `<div class="nf-score-dial" role="img" aria-label="${DIRECTIONAL?'Nudge score':'Nudge nutrition score'} ${rating===null?'unavailable':rating+' out of 100'}"><svg viewBox="0 0 240 132" aria-hidden="true" focusable="false">${arc(.8,24.2,'low')}${arc(25.8,49.2,'medium')}${arc(50.8,99.2,'high')}${marker}</svg><div class="nf-dial-value"><strong>${rating===null?'—':rating}</strong>${rating===null?'':'<span>/100</span>'}</div></div>`;
}

return Object.freeze({ScoreError,CONFIG,SCORE_METHOD,SCORE_VERSION,SCORE_PROMPT_VERSION,CLASSIFIER_VERSION,SCORE_SOURCE,TABLES,pointsFor,boundPoints,missingScoringInputs,gradeFor,validateClassification,calculateScore,calculateSourceEstimate,scoringInputs,unratedScore,explainScore,simpleExcludedIngredients,resolveClassification,providerFactsFingerprint,providerInputFingerprint:providerFactsFingerprint,inputFingerprint,providerScore,declaredFvlIngredients,displayFor,bandFor,ingredientFvlBounds,wholeFruitIdentity,renderDial,displayTone,GRADE_SCORES,frequency,withPortion,validResult});
}
const Legacy=createScoreCore(false),Directional=createScoreCore(true);
root.NudgeScoreCore=Object.freeze({...(ACTIVE_DIRECTIONAL?Directional:Legacy),Legacy,Directional,ACTIVE_DIRECTIONAL});
if(typeof module==='object'&&module.exports)module.exports=root.NudgeScoreCore;
})(typeof window==='object'?window:globalThis);
