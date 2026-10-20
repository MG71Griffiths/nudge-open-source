import data from '../data/usda-recipe-measures.json' with {type:'json'};
import {compositionRecord} from './composition.js';
import {RecipeComposition} from './nutrition-core.js';

const normal=s=>String(s||'').toLowerCase().replace(/[’']/g,'').replace(/[-_]/g,' ').replace(/\s+/g,' ').trim();
const portions=new Map(data.portions.map(r=>[r.id,r]));
// Household weight and nutrient composition are separate evidence. Keep USDA
// edible gram conversions, but select one compatible whole UK nutrient record
// for each narrowly identified food/preparation. Never splice individual
// nutrients or subtract fibre from a US total-carbohydrate value.
const nutrientSources={
  'usda:170000':'13-499:d5aa37187733', // raw onion
  'usda:167747':'14-277:d57cfcbea0f8', // fresh lemon juice
  'usda:172217':'12-596:d379c671eb80', // whole cow's milk
  'usda:173424':'12-940:dbad4525e00a', // whole chicken egg, boiled
  'usda:171287':'12-937:bf53bb737a77' // whole chicken egg, raw
};
function sourceRecord(id,context){
  const nutrientId=id==='usda:172217'&&/\buht\b/.test(context)?'12-320:012eba70ce95':nutrientSources[id];
  return nutrientId?compositionRecord(nutrientId):null;
}
// Household measures are explicit generic estimates. They do not change the
// transcribed recipe quantities or claim the actual egg, onion or milk was weighed.
export function recipeMeasure(row,recipeText=''){
  const household=RecipeComposition.householdMeasure(row,recipeText);if(household)return household;
  if(typeof row.amount!=='number'||!Number.isFinite(row.amount)||row.amount<=0||!['ml','l','tbsp','tsp','count'].includes(row.unit))return null;
  const context=normal([row.name,row.preparation,row.evidence].join(' '));
  const name=normal(row.name).replace(/\b(?:hot|cold|fresh|raw|chopped|diced|roughly|large|medium|small|whole|hard boiled|free range)\b/g,'').replace(/\s+/g,' ').trim();
  let id=null,factor=null,assumption='';
  if(['milk','cows milk'].includes(name)&&['ml','l','tbsp','tsp'].includes(row.unit)
    &&!/(?:skim|semi skim|low fat|fat free|reduced fat|nonfat|powder|dried|evaporated|condensed|flavou?red|sweetened|plant|almond|oat|soy|coconut|cream|raw milk|unpasteuri[sz]ed)/.test(context)
    &&!/(?:dairy free|plant based|vegan)/.test(normal(recipeText))){
    id=['tbsp','tsp'].includes(row.unit)?'90102':'90103';
    factor=row.unit==='tbsp'?1:row.unit==='tsp'?1/3:(row.unit==='l'?1000:1)/29.573;
    assumption='Generic whole cow’s milk estimate; milk type and actual density were not specified. USDA household weight is used, not ml = g; UK whole milk supplies the nutrient composition.';
  }else if(['egg','eggs'].includes(name)&&row.unit==='count'
    &&!/(?:white only|whites|yolk|replacement|substitute|powder|dried|fried|scrambled|poached|omelette|duck|quail|goose)/.test(context)){
    const hard=/\bhard boiled\b/.test(context),cooked=/\b(cooked|boiled|baked|grilled)\b/.test(context);
    if(cooked&&!hard)return null;
    const size=/\bextra large\b/.test(context)?'extra large':/\bjumbo\b/.test(context)?'jumbo':/\bmedium\b/.test(context)?'medium':/\bsmall\b/.test(context)?'small':'large';
    if(hard&&size!=='large')return null;
    id=hard?'92500':({'large':'88374','extra large':'88375',jumbo:'88376',medium:'88378',small:'88379'})[size];factor=1;
    assumption='USDA '+size+' '+(hard?'hard-boiled':'raw whole')+' egg edible-weight estimate; shell is excluded. '+(!/\b(extra large|jumbo|large|medium|small)\b/.test(context)?'Egg size was unspecified, so a large 50 g edible egg is proposed.':'Actual egg weights may differ.');
  }else if(['onion','onions'].includes(name)&&row.unit==='count'&&!/\b(cooked|boiled|fried|baked|roasted|caramelised|caramelized|pickled|powder|dried)\b/.test(context)){
    const size=/\blarge\b/.test(context)?'large':/\bsmall\b/.test(context)?'small':'medium';id={large:'85858',medium:'85860',small:'85862'}[size];factor=1;
    assumption='USDA '+size+' raw onion edible-weight estimate. '+(!/\b(large|medium|small)\b/.test(context)?'Onion size was unspecified, so a medium onion is proposed.':'Actual onion weights may differ.');
  }else if(name==='lemon juice'&&['tbsp','tsp','ml','l'].includes(row.unit)&&!/(?:concentrat|bottled|sweetened|syrup)/.test(context)){
    id='81888';factor=row.unit==='tbsp'?.5:row.unit==='tsp'?1/6:(row.unit==='l'?1000:1)/29.573;
    assumption='Generic raw lemon-juice household measure estimate from USDA; tablespoon is half a US fluid ounce. Actual spoon size and juice density may differ.';
  }
  if(!id)return null;
  const measure=portions.get(id),amountGrams=row.amount*factor*measure.gramWeight/measure.amount;
  if(!Number.isFinite(amountGrams)||amountGrams<=0||amountGrams>5000)return null;
  const nutrition=sourceRecord(measure.foodId,context);if(!nutrition)return null;
  return {amountGrams,sourceRecord:nutrition,assumptions:[assumption,'Nutrients use the complete UK CoFID record: '+nutrition.name+'. USDA supplies only the edible household weight; trace or unavailable UK nutrient values stay unknown.'],conversion:{version:data.version+'+cofid-nutrients-v1',status:'household_measure_estimate',
    inputAmount:row.amount,inputUnit:row.unit,amountGrams,sourcePortionId:measure.id,sourceFoodId:measure.foodId,sourceMeasure:measure.measure,
    nutrientSourceId:nutrition.id,nutrientSourceVersion:nutrition.sourceVersion,nutrientSourceURL:nutrition.sourceURL,
    sourceMeasureAmount:measure.amount,sourceGramWeight:measure.gramWeight,multiplier:factor,sourceURL:data.sourceURL,sourceSHA256:data.sourceSHA256,unitSourceURL:data.unitSourceURL,
    formula:'Recipe amount × '+factor+' × '+measure.gramWeight+' g / '+measure.amount+' USDA measure'}};
}
