import rulebook from '../data/womens-food-tagging.v1.json' with {type:'json'};

// Public food evidence only. This pure classifier does not read a profile, infer
// a cycle, call a model, or alter a nutrition score. Bump after matching changes.
export const WOMENS_FOOD_TAG_VERSION = 'womens-food-candidates-v1-2026-10-08';
export const WOMENS_FOOD_CONTEXTS = Object.freeze(['period','follicular','ovulation','luteal','perimenopause','postmenopause']);
const rules = new Map(rulebook.rules.map(rule => [rule.id,rule]));
const sources = new Map(rulebook.sources.map(source => [source.id,source]));
const families = new Map(rulebook.food_family_candidates.map(family => [family.id,family]));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normal = value => typeof value === 'string' ? value.slice(0,10000).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\byogurt(s)?\b/g,'yoghurt$1').replace(/[^a-z0-9]+/g,' ').trim() : '';
const numeric = value => (typeof value === 'number' || typeof value === 'string' && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const unique = values => [...new Set(values)];
const list = value => Array.isArray(value) ? value.slice(0,160) : [];
const unsupported = /\b(supplements?|capsules?|tablets?|infant|formula|alcoholic|beer|wine|spirits|liqueurs?|medical foods?|meal replacement powders?)\b|\b(?:baby|toddler)(?: [a-z]+){0,3} (?:foods?|formula|purees?|cereals?|meals?|milks?)\b/;
const composite = /\b(cakes?|biscuits?|cookies?|desserts?|puddings?|muffins?|pastr(?:y|ies)|ice cream|confectionery|chocolate|coated|filled|bars?|bites?|crackers?|granola|smoothies?|sweets?|cand(?:y|ies)|gummies|jams?|marmalades?|flavou?red|flavou?rings?|extracts?|concentrates?|protein powders?)\b/;
const dryPulse = /\b(dried|dry|uncooked|flour|powder|crisps?|chips?)\b/;
const simpleModifiers = /\b(?:organic|fresh|frozen|plain|natural|whole|raw|cooked|steamed|boiled|baked|canned|tinned|drained|peeled|chopped|sliced|diced|pitted|unsalted|salted|roasted|unroasted|lightly|smooth|crunchy|ground|milled|blanched|shelled|ready|to|eat|and|or|in|water|brine|spring|sunflower|olive|oil|tomato|sauce|juice|with|salt|no|added|sugar|unsweetened|fortified|calcium|set|live|active|cultures?|reduced|fat|low|full|semi|skimmed|free|range|british|scottish|atlantic|wild|fillets?|skinless|boneless|skin|on|off|bones|edible|red|green|black|white|yellow|brown|mixed|jumbo|porridge|rolled|steel|cut|quick|instant|flakes?|seeds?|nuts?|portions?|pack|of|g|kg|ml|l|percent)\b/g;

// Match whole food identity/category, or an explicitly declared majority of a
// mixed food. Never count nested ingredient percentages, estimates, or traces.
function topLevelIngredients(product) {
  const structured = list(product.ingredients).filter(object).map(item => ({
    text: normal(item.text || String(item.id || '').replace(/^[a-z]{2}:/,'')),
    percent: numeric(item.percent)
  })).filter(item => item.text);
  const raw = String(product.ingredients_text_en || product.ingredients_text || '').slice(0,10000);
  const parts = []; let depth = 0, start = 0;
  for (let i=0;i<raw.length;i++) {
    if ('(['.includes(raw[i])) depth++;
    else if (')]'.includes(raw[i])) depth=Math.max(0,depth-1);
    else if (',;'.includes(raw[i]) && depth===0) { parts.push(raw.slice(start,i)); start=i+1; }
  }
  parts.push(raw.slice(start));
  const parsed = parts.slice(0,160).map(part => {
    // A parenthetical sub-recipe is not the percentage of the parent ingredient.
    const match = part.trim().match(/^([^()[\]]+?)\s*(?:\(\s*)?(\d+(?:\.\d+)?)\s*%\s*\)?(?:\s*$|\s*\()/);
    return {text:normal(match ? match[1] : part.replace(/\([^)]*\)/g,'')),percent:match?numeric(match[2]):null};
  }).filter(item => item.text && !/\b(may contain|traces? of|allergen advice)\b/.test(item.text));
  return [...structured,...parsed];
}

function identity(product) {
  // "Baby spinach" describes an ordinary vegetable, not infant food.
  const name = normal(product.product_name_en || product.product_name).replace(/\bbaby spinach\b/g,'spinach');
  const categories = list(product.categories_tags).filter(value => typeof value === 'string' && /^en:/.test(value)).map(value=>normal(value.slice(3)));
  const ingredients = topLevelIngredients(product);
  return {name,categories,ingredients,all:normal([name,...categories].join(' ')),ingredientText:normal(product.ingredients_text_en || product.ingredients_text),
    labels:list(product.labels_tags).map(normal).join(' ')};
}

function familyMatches(info, pattern, {allowComposite=false,allowDry=true,ingredientPattern=pattern,minimumPercent=50}={}) {
  const adverse = (!allowComposite && composite.test(info.all)) || (!allowDry && dryPulse.test(info.all));
  if (adverse) return false;
  const percent = info.ingredients.filter(item=>pattern.test(item.text) && !composite.test(item.text))
    .some(item=>item.percent!==null && item.percent>=50 && item.percent<=100);
  if (percent) return true;
  // A category is corroboration, not permission to ignore a conflicting recipe.
  const simple = value => pattern.test(value) && !value.replace(pattern,' ').replace(simpleModifiers,' ').replace(/\b\d+\b/g,' ').trim();
  if (!simple(info.name) && !info.categories.some(simple)) return false;
  if (!simple(info.name) && /\b(with|filled|coated|spread|salad|soup|sauce|curry|bar|bite|bites|smoothie|drink|juice|bread|pasta|cereal|granola|milk|yoghurt)\b/.test(info.name)) return false;
  // Known first ingredient contradicting an otherwise simple name/category.
  const first = info.ingredients[0];
  if (first && !ingredientPattern.test(first.text) && !/^(?:water|spring water|(?:(?:pasteuri[sz]ed|homogenised|whole|skimmed|semi skimmed) )*milk)$/.test(first.text)) return false;
  // A declared small amount cannot be overridden by a marketing title/category.
  if (info.ingredients.some(item=>ingredientPattern.test(item.text) && item.percent!==null && item.percent<minimumPercent)) return false;
  return true;
}

const MATCHERS = [
  ['pumpkin_seeds',/\bpumpkin seeds?\b/],
  ['almonds_cashews',/\b(?:almonds?|cashews?)(?: and (?:almonds?|cashews?))?\b/],
  ['walnuts',/\bwalnuts?\b/],
  ['cooked_chickpeas',/\b(?:chickpeas?|garbanzo beans?)\b/,{allowDry:false}],
  ['cooked_lentils',/\blentils?\b/,{allowDry:false}],
  ['cooked_beans_peas',/\b(?:(?:kidney|cannellini|butter|haricot|black|borlotti|pinto|baked|garden|split|green|white|red|navy|broad) )?(?:beans?|peas?)\b/,{allowDry:false}],
  ['banana',/\bbananas?\b/],
  ['potato',/\bpotatoes\b|\bpotato\b/],
  ['chicken',/\bchicken(?: breasts?| thighs?| meat)?\b/],
  ['salmon',/\bsalmon\b/],
  ['mackerel',/\bmackerel\b/],
  ['eggs',/\b(?:hens? )?eggs?\b/],
  ['plain_yoghurt',/\b(?:(?:greek|greek style|natural|plain|strained) )?yoghurts?\b/],
  ['milk',/\b(?:cows? )?milk\b/],
  ['edamame',/\b(?:edamame|soybeans?|soya beans?)\b/,{allowDry:false}],
  ['oats',/\b(?:oats?|oatmeal)\b/],
  ['wholemeal_bread',/\b(?:wholemeal|wholegrain|whole grain|whole wheat) (?:bread|loaf|rolls?|pitta|pita)\b/,{ingredientPattern:/\b(?:wholemeal|wholegrain|whole grain|whole wheat) (?:wheat )?(?:flour|bread)\b/}],
  ['brown_rice',/\b(?:brown|wholegrain|whole grain) (?:basmati )?rice\b/],
  ['wholegrain_pasta',/\b(?:wholemeal|wholegrain|whole grain|whole wheat) (?:pasta|spaghetti|penne|fusilli)\b/,{ingredientPattern:/\b(?:wholemeal|wholegrain|whole grain|whole wheat)(?: durum)? (?:wheat|semolina|flour|pasta)\b/}],
  ['ground_linseed',/\b(?:ground|milled) (?:flaxseeds?|flax seeds?|linseeds?)\b/,{ingredientPattern:/\b(?:flaxseeds?|flax seeds?|linseeds?)\b/}],
  ['ginger_food',/\bginger\b/],
  ['dark_chocolate',/\b(?:dark|plain|[789]\d percent) chocolate\b/,{allowComposite:true,ingredientPattern:/\b(?:cocoa|cacao|dark chocolate)\b/}],
  ['green_kiwi',/\bgreen (?:kiwi(?:fruit)?s?)\b/],
  ['prunes',/\b(?:prunes?|dried plums?)\b/],
  ['tart_cherry_juice',/\b(?:tart|sour|montmorency) cherr(?:y|ies) juice\b/],
  ['blueberries',/\bblueberries\b|\bblueberry\b/],
  ['mixed_berries',/\b(?:strawberries|raspberries|blackberries|mixed berries|summer berries)\b/],
  ['leafy_greens',/\b(?:spinach|kale|spring greens|chard|cabbage|rocket|lettuce)\b/],
  ['broccoli',/\bbroccoli\b/],
  ['peppers_citrus',/\b(?:bell peppers?|sweet peppers?|oranges?|satsumas?|mandarins?|clementines?|lemons?|limes?|grapefruits?)\b/],
  ['unsaturated_oils',/\b(?:(?:extra virgin|virgin) )?(?:olive|rapeseed|canola) oil\b/],
  ['water',/\b(?:still |mineral |spring |drinking )?water\b/]
];
const PLANT_FAMILIES = new Set(['pumpkin_seeds','almonds_cashews','walnuts','cooked_chickpeas','cooked_lentils','cooked_beans_peas','banana','potato','edamame','oats','wholemeal_bread','brown_rice','wholegrain_pasta','ground_linseed','green_kiwi','prunes','blueberries','mixed_berries','leafy_greens','broccoli','peppers_citrus','calcium_set_tofu','tofu','kiwi']);

function matchingFamilies(info) {
  const found = new Map();
  const add = (id,label,tagIDs,caution) => found.set(id,families.get(id) || {id,label,candidate_tag_ids:tagIDs,caution});
  for (const [id,pattern,options] of MATCHERS) if (familyMatches(info,pattern,options)) add(id);
  // Beans means edible pulses, not cocoa, coffee, vanilla or jelly beans.
  if (/\b(?:coffee|cocoa|cacao|vanilla|jelly|chocolate|french|runner|green) beans?\b/.test(info.all)) found.delete('cooked_beans_peas');
  if (/\b(sweet potato|crisps?|chips?|fries|starch|flour)\b/.test(info.all)) found.delete('potato');
  if (/\b(?:coconut|almond|oat|soya?|rice|plant|goats?|sheep|evaporated|condensed|powdered|dried)\b/.test(info.all)) {found.delete('milk');found.delete('plain_yoghurt');}
  if (/\b(?:milk chocolate|white chocolate|cake|biscuit|cookie|dessert|pudding|coated|filled|spread|drink)\b/.test(info.all)) found.delete('dark_chocolate');
  if (/\b(?:sparkling|fizzy|sweetened|flavou?red|tonic|coconut)\b/.test(info.all)) found.delete('water');
  // Culture evidence is separate from the ordinary yoghurt identity.
  if (found.has('plain_yoghurt') && /\b(?:live|active) (?:cultures?|bacteria)\b/.test(info.ingredientText+' '+info.name)) add('live_yoghurt');
  if (familyMatches(info,/\b(?:milk )?kefir\b/) && !/\b(water|coconut|oat|soya?|raw|unpasteuri[sz]ed)\b/.test(info.name)
    && (/\bmilk\b/.test(info.ingredientText+' '+info.name) || info.categories.includes('milk kefirs'))) add('milk_kefir');
  if (familyMatches(info,/\bsardines?\b/)) {
    add('sardines','Sardines',['protein_contribution','vitamin_d_contribution','b12_food_adequacy_candidate','period_omega3_research'],'Calcium from edible bones is a separate qualification.');
    if (/\b(?:with|including|edible) bones\b/.test(info.name+' '+info.ingredientText) && !/\bboneless\b/.test(info.name)) {found.delete('sardines');add('sardines_bones');}
  }
  if (familyMatches(info,/\b(?:tofu|tempeh)\b/,{ingredientPattern:/\b(?:soya?|soybeans?|soya beans?|tofu|tempeh)\b/,minimumPercent:5})) {
    add('tofu','Tofu and tempeh',['soy_hot_flush_research','protein_contribution','plant_food_option'],'Whole-soy identity does not establish a calcium amount or hot-flush benefit.');
    if (/\b(?:calcium sulphate|calcium sulfate|calcium chloride|e516|e509|calcium set)\b/.test(info.ingredientText+' '+info.name)) {found.delete('tofu');add('calcium_set_tofu');}
  }
  // A soya drink is a food-family candidate even when its fortificants are unknown.
  if (familyMatches(info,/\b(?:soya?|soybean) (?:drink|milk|beverage)s?\b/,{ingredientPattern:/\b(?:soya?|soybeans?|soya beans?)\b/,minimumPercent:5}) && !/\b(?:flavou?red|chocolate|vanilla|dessert)\b/.test(info.name)) {
    add('soya_drink','Soya drink',['soy_hot_flush_research','protein_contribution'],'Fortification is product-specific; no calcium, vitamin D or B12 amount is presumed.');
    if (/\b(?:fortified|added calcium|calcium carbonate|calcium phosphate)\b/.test(info.name+' '+info.ingredientText+' '+info.labels)) add('fortified_soya_drink');
  }
  if (!found.has('green_kiwi') && familyMatches(info,/\bkiwi(?:fruit)?s?\b/)) add('kiwi','Kiwifruit',['kiwifruit_sleep_candidate','plant_food_option'],'Green-kiwifruit bowel evidence requires the green variety; sleep evidence is preliminary.');
  // Actual ginger must be a substantial component of a named infusion. Ginger
  // flavouring, ginger biscuits and unspecified ginger beer do not qualify.
  if (!composite.test(info.all) && /\b(?:ginger (?:tea|infusion)|(?:tea|infusion) with ginger)\b/.test(info.name)
    && info.ingredients.some(item=>/^(?:dried |ground )?ginger(?: root)?$/.test(item.text) && item.percent>=50)) add('ginger_food');
  if (!composite.test(info.all) && /\b(?:caffeine free|decaffeinated|decaf)\b/.test(info.name+' '+info.labels)
    && /\b(?:tea|coffee|infusion)\b/.test(info.name+' '+info.categories.join(' '))) add('lower_caffeine_drink');
  return found;
}

const nutrientAliases = {iron:['iron'],calcium:['calcium'],vitamin_c:['vitamin-c'],vitamin_d:['vitamin-d'],protein:['proteins'],fibre:['fiber','fibre']};
const toGrams = {g:1,mg:0.001,ug:0.000001,mcg:0.000001,'µg':0.000001,'μg':0.000001};
const maxPer100Grams = {iron:0.03,calcium:2,vitamin_c:1,vitamin_d:0.0001,protein:100,fibre:100};
function serving(product) {
  const size = String(product.serving_size || '').slice(0,240), match = size.match(/(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(g|ml)\b/i);
  const amount = numeric(product.serving_quantity) ?? (match ? numeric(match[1]) : null);
  const unit = normal(product.serving_quantity_unit) || (match ? match[2].toLowerCase() : '');
  if (amount===null || amount<=0 || amount>(unit==='ml'?600:500) || !['g','ml'].includes(unit)) return null;
  if (match && (Math.abs(Number(match[1])-amount)>0.1 || match[2].toLowerCase()!==unit)) return null;
  return {amount,unit};
}
function nutrientGrams(product,key,portion) {
  if (['on','true','1'].includes(String(product.no_nutrition_data).toLowerCase()) || list(product.data_quality_errors_tags).some(tag=>/nutrition|nutriment/.test(String(tag)))) return null;
  const set = object(product.nutrition?.aggregated_set) ? product.nutrition.aggregated_set : null;
  if (set) {
    if (set.preparation!=='as_sold' || set.per!==`100${portion.unit}`) return null;
    for (const alias of nutrientAliases[key]) {
      const item = set.nutrients?.[alias];
      if (!object(item) || !['packaging','manufacturer'].includes(item.source) || ![undefined,null,'','eq','='].includes(item.modifier)) continue;
      const factor = toGrams[String(item.unit || '').toLowerCase()], value = numeric(item.value) ?? numeric(item.value_computed);
      if (factor!==undefined && value!==null && value*factor<=maxPer100Grams[key]) return value*factor*portion.amount/100;
    }
    return null; // Never borrow legacy values across preparation/measurement sets.
  }
  if (product.nutrition_data_prepared==='on' && product.nutrition_data!=='on') return null;
  const unit = normal(product.product_quantity_unit);
  const liquid = /^(ml|l|cl|dl)$/.test(unit) || /\b\d+(?:\.\d+)?\s*(?:ml|cl|litres?|liters?)\b/i.test(String(product.quantity||''));
  if ((liquid?'ml':'g')!==portion.unit) return null; // No assumed g↔ml density.
  for (const alias of nutrientAliases[key]) {
    const nutrients = product.nutriments;
    if (!object(nutrients) || ![undefined,null,'','eq','='].includes(nutrients[alias+'_modifier'])) continue;
    const value = numeric(nutrients[alias+'_100g']);
    // OFF *_100g mass nutrients are normalized GRAMS, irrespective of *_unit.
    // https://openfoodfacts.github.io/documentation/docs/Product-Opener/schemas/schemas/product/
    if (value!==null && value<=maxPer100Grams[key]) return value*portion.amount/100;
  }
  return null;
}

function contextsFor(rule) {
  if (rule.contexts.includes('all_stages')) return [...WOMENS_FOOD_CONTEXTS];
  const contexts = new Set(rule.contexts.filter(context=>WOMENS_FOOD_CONTEXTS.includes(context)));
  if (rule.contexts.includes('menstruating')) ['period','follicular','ovulation','luteal'].forEach(context=>contexts.add(context));
  if (rule.contexts.includes('perimenopause_with_periods')) contexts.add('perimenopause');
  if (rule.contexts.includes('reported_cramps')) contexts.add('period');
  if (rule.contexts.some(context=>['reported_premenstrual_symptoms','reported_increased_hunger'].includes(context))) contexts.add('luteal');
  if (rule.contexts.includes('reported_hot_flushes')) ['perimenopause','postmenopause'].forEach(context=>contexts.add(context));
  // Symptom-only ordinary nutrition applies across stages; the wording retains
  // its condition. A phase selection is not evidence that the symptom exists.
  if (!contexts.size) WOMENS_FOOD_CONTEXTS.forEach(context=>contexts.add(context));
  return WOMENS_FOOD_CONTEXTS.filter(context=>contexts.has(context));
}

/** Return bounded, deterministic public food tags, with no personal data. */
export function classifyWomensFoodTags(providerProduct) {
  if (!object(providerProduct)) return [];
  const info = identity(providerProduct);
  if (!info.name || unsupported.test(info.all)) return [];
  const matched = matchingFamilies(info), eligible = new Map(), portion = serving(providerProduct);
  const add = (id,familyID) => {if(!eligible.has(id))eligible.set(id,new Set());if(familyID)eligible.get(id).add(familyID);};
  for (const family of matched.values()) {
    for (const id of family.candidate_tag_ids) {
      const rule = rules.get(id);
      if (rule && !rule.qualification.threshold && !rule.qualification.requires) add(id,family.id);
    }
    if (PLANT_FAMILIES.has(family.id)) add('plant_food_option',family.id);
  }
  // B12 fortification needs the specific fortificant, not the word "fortified".
  if (eligible.has('b12_food_adequacy_candidate') && ![...matched.keys()].some(id=>['salmon','sardines','sardines_bones','mackerel','eggs','plain_yoghurt','milk'].includes(id))
    && !/\b(?:vitamin b12|vitamin b 12|cobalamin|cyanocobalamin|methylcobalamin)\b/.test(info.ingredientText)) eligible.delete('b12_food_adequacy_candidate');
  if (portion) for (const [key,threshold] of Object.entries(rulebook.thresholds)) {
    if (!object(threshold) || !nutrientAliases[key]) continue;
    const value = nutrientGrams(providerProduct,key,portion), thresholdGrams = threshold.minimum*toGrams[threshold.unit];
    if (value===null || value<thresholdGrams) continue;
    if (key==='calcium' && /\bspinach\b/.test(info.all)) continue;
    if (key==='calcium' && matched.has('tofu') && !matched.has('calcium_set_tofu')) continue;
    if (['calcium','vitamin_d'].includes(key) && matched.has('soya_drink') && !matched.has('fortified_soya_drink')) continue;
    if (key==='vitamin_d' && (matched.has('milk') || matched.has('plain_yoghurt'))
      && !/\b(?:vitamin d|vitamin d2|vitamin d3|cholecalciferol|ergocalciferol)\b/.test(info.ingredientText)) continue;
    const id = key==='vitamin_c'?'vitamin_c_iron_pairing':key+'_contribution';
    add(id);
    for (const family of matched.values()) if (family.candidate_tag_ids.includes(id)) add(id,family.id);
  }
  if (eligible.has('calcium_contribution')) {
    add('premenstrual_calcium_candidate');
    for (const familyID of eligible.get('calcium_contribution')) add('premenstrual_calcium_candidate',familyID);
  }
  return rulebook.rules.filter(rule=>eligible.has(rule.id) && rule.assignment_granularity!=='dietary_pattern' && rule.assignment_granularity!=='meal').map(rule=>{
    const foodFamilies = [...eligible.get(rule.id)].sort(), measured = Boolean(rule.qualification.threshold || rule.qualification.requires?.includes('calcium_contribution'));
    const contexts = contextsFor(rule);
    const qualification = measured
      ? `Qualifies from source-reported nutrition for the declared ${portion.amount} ${portion.unit} serving; this is not independently verified label data.`
      : 'Identified food-family candidate; nutrient amounts and symptom benefit are not verified for this product.';
    const limitations = unique([qualification,...(rule.limits||[]),...foodFamilies.map(id=>matched.get(id)?.caution).filter(Boolean),
      ...(contexts.includes('follicular') || contexts.includes('ovulation') ? ['General nutrition relevance only; no special follicular or ovulatory effect is established.'] : []),
      ...(rule.id==='iron_contribution'?['Menstrual relevance depends on having periods; life stage alone does not establish iron need.']:[]),
      ...(rule.id==='soluble_fibre_option'?['Constipation must be reported or explicitly searched for; bloating or a cycle phase does not establish it.']:[]),
      ...(rule.id==='soy_hot_flush_research'?['Perimenopause application is indirect; most studied participants were postmenopausal.']:[])]).slice(0,8);
    return {id:rule.id,label:rule.label,contexts,evidence:rule.evidence,evidenceDirection:rule.evidence_direction || (rule.evidence==='established_nutrition'?'general_nutrition':'uncertain'),
      wording:rule.wording,foodDataConfidence:measured?'source_reported_nutrients':'source_reported_identity',foodFamilies,
      sources:rule.sources.slice(0,3).map(id=>sources.get(id)).filter(Boolean).map(({id,title,url})=>({id,title,url})),limitations};
  });
}
