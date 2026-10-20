import { Composition } from './nutrition-core.js';
// Conservative recovery of explicit ingredient lists from the user's transcript.
// This is evidence preservation, not an AI instruction interpreter or nutrition source.
import { resolveMealComponents, reconcileMealPlants } from './composition.js';
import { MAX_TRANSCRIPT_CHARACTERS } from './voice-memo.js';

const normal = value => String(value || '').toLowerCase().replace(/[’']/g, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
const plantForms = {
  banana: ['bananas'], apple: ['apples'], pear: ['pears'], orange: ['oranges'], lemon: ['lemons'], lime: ['limes'],
  strawberry: ['strawberries'], blueberry: ['blueberries'], raspberry: ['raspberries'], blackberry: ['blackberries'],
  cranberry: ['cranberries'], cherry: ['cherries'], grape: ['grapes', 'raisins', 'sultanas'], apricot: ['apricots'],
  peach: ['peaches'], plum: ['plums', 'prunes'], mango: ['mangoes', 'mangos'], pineapple: [], kiwi: ['kiwifruit'],
  date: ['dates'], fig: ['figs'], pomegranate: ['pomegranate seeds', 'pomegranate arils'], avocado: ['avocados'],
  spinach: ['baby spinach', 'spinach leaves'], kale: [], broccoli: [], carrot: ['carrots'], cucumber: ['cucumbers'],
  beetroot: ['beet'], tomato: ['tomatoes'], celery: [], courgette: ['zucchini'], pumpkin: ['pumpkin seeds'],
  sunflower: ['sunflower seeds'], sesame: ['sesame seeds', 'tahini'], chia: ['chia seeds'], flax: ['flaxseed', 'flaxseeds', 'flax seeds', 'linseed', 'linseeds'],
  hemp: ['hemp seeds', 'hemp hearts'], oat: ['oats', 'rolled oats', 'porridge oats'], quinoa: [], buckwheat: [],
  almond: ['almonds', 'almond butter'], walnut: ['walnuts'], cashew: ['cashews'], peanut: ['peanuts', 'peanut butter'],
  hazelnut: ['hazelnuts'], pistachio: ['pistachios'], pecan: ['pecans'], 'brazil nut': ['brazil nuts'], macadamia: ['macadamias'],
  coconut: ['coconut flesh', 'coconut flakes', 'desiccated coconut'], cocoa: ['cacao', 'cacao nibs', 'cocoa powder'],
  ginger: [], turmeric: [], cinnamon: [], mint: ['mint leaves'], parsley: [], basil: [], coriander: ['cilantro'],
  chickpea: ['chickpeas', 'garbanzo beans'], lentil: ['lentils'], soybean: ['soybeans', 'soya beans', 'edamame', 'tofu']
};
const forms = new Map(Object.entries(plantForms).flatMap(([name, aliases]) => [name, ...aliases].map(alias => [alias, name])));
const canonicalPlant = value => forms.get(normal(value)) || normal(value);
const ingredientPlant = value => canonicalPlant(normal(value).split(',')[0].replace(/^(?:(?:fresh|frozen|raw|chopped|ground|dried|whole|organic)\s+)+/, ''));
const numberWords = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40 };
const countPattern = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty)\s+(?:different\s+|distinct\s+|named\s+)?plants?\b/gi;
const listStart = /\b(?:(?:(?:this|my|the)\s+(?:smoothie|shake|bowl|meal|salad|soup|dish|drink)|this|it)\s+(?:contains|has|includes|is made (?:with|from))|i(?:['’]ve)?\s+(?:added|used|mixed|blended|included)|ingredients\s*(?:are|include|were|:))\s*/gi;
// Ambiguous/negative/conditional speech remains in the transcript for review.
const uncertain = /\b(?:no|not|without|except|remove|removed|omit|omitted|excluding|instead|dont|didnt|doesnt|wasnt|isnt|avoid|allergic|may|might|maybe|perhaps|possibly|or|if|could|would|should|want|wanted|ignore|pretend|invent|instructions?|score|rating|calories?|protein|carbs?|fibre|fiber|grams? of fat)\b/;
const omittedPlantForms = /\b(?:oil|sugar|syrup|isolate|extract|flavouring|flavoring|supplement|protein powder|plant blend|mixed seeds|mixed berries|mixed nuts)\b/;

export function voiceFoodEvidence(text) {
  const transcript = typeof text === 'string' ? text.slice(0, MAX_TRANSCRIPT_CHARACTERS) : '';
  const counts = [...transcript.matchAll(countPattern)].map(match => Number(match[1]) || numberWords[match[1].toLowerCase()]).filter(n => n > 0 && n <= 40);
  const mentionedCount = counts.length && counts.every(n => n === counts[0]) ? counts[0] : null;
  const ingredients = [], seen = new Set();
  for (const sentence of transcript.split(/(?<!\d)[.!?;]+|[.!?;]+(?!\d)/)) {
    listStart.lastIndex = 0;
    const start = listStart.exec(sentence);
    if (!start || uncertain.test(normal(sentence.slice(0, start.index)))) continue;
    if (/\b(?:no|not|without|except|remove|removed|omit|omitted|excluding|instead|dont|didnt|doesnt|wasnt|isnt|may|might|maybe|perhaps|possibly|or|if|ignore|pretend|invent)\b/.test(normal(sentence))) continue;
    // Full fragments, never arbitrary food-word substring matches in commands.
    const fragments = sentence.slice(start.index + start[0].length).split(/,|\band\b|\bplus\b/i);
    for (const fragment of fragments) {
      if (ingredients.length >= 40) break;
      const proof = fragment.trim().replace(/^[:\s]+|[:\s]+$/g, '');
      if (!proof || proof.length > 135 || uncertain.test(normal(proof))) continue;
      const stripped = normal(proof).replace(/^(?:a |an |some |a little |a handful of |a spoonful of )/, '')
        .replace(/^(?:\d+(?:\.\d+)?|one|two|three|four|five|six|half)\s*(?:(?:grams?|millilitres?|milliliters?|teaspoons?|tablespoons?|handfuls?|cups?|kg|ml|tsp|tbsp|g)\b)?\s*(?:of\s+)?/, '')
        .replace(/^(?:(?:fresh|frozen|raw|chopped|ground|dried|whole|organic)\s+)+/, '').trim();
      // Only explicit recognisable whole plant foods are deterministically recovered.
      // Other foods and unrecognised names remain available to vision in the full transcript.
      const plant = omittedPlantForms.test(stripped) ? null : forms.get(stripped);
      if (!plant || seen.has(plant)) continue;
      seen.add(plant); ingredients.push({ name: stripped, plant, evidence: `User described: ${proof}` });
      if (ingredients.length === 40) break;
    }
  }
  return { mentionedCount, ingredients };
}

export function reconcileVoiceFood(extraction, voiceNote) {
  if (extraction?.type !== 'meal' || !extraction.meal || !voiceNote?.text) return extraction;
  const evidence = voiceFoodEvidence(voiceNote.text), meal = extraction.meal;
  const ingredients = (meal.ingredients || []).map(item => ({ ...item }));
  const plants = (meal.plants || []).map(item => ({ ...item, name: canonicalPlant(item.name) }));
  let components = (meal.components || []).map(item => ({ ...item }));
  let recovered = 0;
  for (const item of evidence.ingredients) {
    if (!ingredients.some(row => ingredientPlant(row.name) === item.plant) && ingredients.length < 40) ingredients.push({ name: item.name, evidence: item.evidence });
    if (!plants.some(row => canonicalPlant(row.name) === item.plant) && plants.length < 40) plants.push({ name: item.plant, evidence: item.evidence });
    if (components.some(row => ingredientPlant(row.name) === item.plant) || components.length >= 40) continue;
    // Do not invent how much went into a whole batch or into the eaten serving.
    // A missed named ingredient blocks a falsely complete eight-component total.
    const addition = resolveMealComponents([{ name: item.name, preparation: 'unknown', amountGrams: null, evidence: item.evidence, photoIndex: null,
      assumptions: ['User-described ingredient; not visually verified.', 'Quantity and serving basis need review; the transcript is retained.'] }], { estimatedServing: true }).components[0];
    addition.photoIndex = null;
    components.push(addition); recovered++;
  }
  const named = [...new Set(plants.map(item => canonicalPlant(item.name)))];
  const claimedExtra = evidence.mentionedCount !== null && evidence.mentionedCount > named.length;
  // A count does not identify plants or establish any nutrient. Preserve one
  // unresolved material component instead of scoring an incomplete recipe as complete.
  if (claimedExtra && !components.some(c => c.voiceUnidentified === true) && components.length < 40) {
    components.push({ name: 'Unidentified ingredients from voice note', preparation: 'unknown', amountGrams: null, amountSource: 'standard_portion_estimate',
      evidence: 'User-mentioned plant count exceeds identified named plants.', photoIndex: null, voiceUnidentified: true,
      recordId: null, sourceRecord: null, nutrients: {}, candidates: [], matchStatus: 'unmatched', matchMethod: 'none',
      assumptions: ['Additional plant identities and amounts have not been supplied.'] });
    recovered++;
  }
  const review = { mentionedCount: evidence.mentionedCount, identifiedPlantNames: named, needsReview: true,
    reason: claimedExtra ? `${named.length} named plants identified; ${evidence.mentionedCount} mentioned. Name the remaining ingredients and check amounts.`
      : evidence.ingredients.length ? 'Named ingredients from your voice note are included. Check the transcript, quantities and serving size.'
      : 'Review the transcript and identified foods. A plant count alone cannot establish ingredient identities or nutrition.' };
  const plantEvidence = reconcileMealPlants(components, ingredients, plants);
  return { ...extraction, meal: { ...meal, ...plantEvidence, components, voiceIngredientReview: review,
    ...(recovered ? { nutrients: Composition.total(components), portion: { label: '1 portion', amount: null, unit: null, source: 'estimated' },
      portionAmbiguity: { requiresSelection: true, reason: 'Check the amounts of ingredients described in your voice note.' } } : {}) } };
}
