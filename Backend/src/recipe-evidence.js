import { RecipeComposition, MealRecovery, Composition } from './nutrition-core.js';
import { outputSchemaIssue } from './photo-evidence.js';
import { resolveMealComponents } from './composition.js';
import { recipeMeasure } from './recipe-measures.js';

const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const text=(maxLength,description)=>({type:'string',maxLength,...(description?{description}:{})});
const quantity={type:['number','null'],minimum:0.1,maximum:5000};
export const recipeEvidenceSchema={anyOf:[object({
  photoIndex:{type:'integer',minimum:1,maximum:4,description:'PHOTO index of the visible recipe ingredient page, which can differ from the foreground plate photo.'},text:text(6000,'Verbatim transcription of the visible ingredient lines and any printed yield, retaining quantities, units, preparation wording and section headings. NEVER a summary, page description or attribution. Every ingredient evidence quote and servingsEvidence must be an exact substring of this text. Do not infer missing text.'),
  servings:{type:['number','null'],minimum:1,maximum:50},servingsEvidence:{type:['string','null'],maxLength:160},
  servingsPhotoIndex:{type:['integer','null'],minimum:1,maximum:4,description:'PHOTO containing the exact printed recipe yield; may differ from the shopping-list photoIndex. Null when yield is absent. Copy that yield line verbatim into text as well.'},
  componentIndexes:{type:'array',minItems:1,maxItems:40,description:'Zero-based indexes into the VISUAL components array returned alongside this recipe (meal.components in a full extraction). Never indexes into recipe ingredients. For visual components [pie, cabbage side], a pie recipe covers [0] only. Every index must be smaller than the visual component count; separate sides remain outside this list.',items:{type:'integer',minimum:0,maximum:39}},
  ingredients:{type:'array',minItems:1,maxItems:40,items:object({name:text(100,'Simple food name supported by the quoted ingredient line. Omit section labels such as topping, filling or sauce: use butter for both butter rows, not butter topping. Preserve distinct repeated rows. A named blend with one amount (flaxseed and goji mix, mixed seeds, mixed nuts) is ONE ingredient; never assign its full quantity to each subingredient. Preserve branded blend identity.'),preparation:text(100,'State when the printed quantity is measured, not the final baked dish. Fresh uncooked fish is raw; peeled or chopped vegetables remain raw unless cooking is explicitly stated. Hard-boiled eggs are hard-boiled. Unknown only when genuinely unclear.'),amount:quantity,
    unit:{type:['string','null'],enum:['g','kg','ml','l','tsp','tbsp','count',null]},evidence:text(160,'Exact verbatim ingredient-line quote copied from text, including the printed quantity and unit where present. It must be an exact substring of text, never a paraphrase or a section description. Do not add Photo, Recipe photo or other attribution prefixes; photoIndex identifies its source.')})}
}),{type:'null'}]};
const normal=s=>String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
const numberPattern=n=>String(n).replace('.','[.,]');
const units={g:'(?:g|grams?)',kg:'(?:kg|kilograms?)',ml:'(?:ml|millilitres?|milliliters?)',l:'(?:l|litres?|liters?)',tsp:'(?:tsp|teaspoons?)',tbsp:'(?:tbsp|tbs|tablespoons?)'};
const identityWords=s=>normal(s).replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(Boolean);
function identityQuoted(row){
  const quote=identityWords(row.evidence);
  return identityWords(row.name).filter(word=>word!=='and').every(word=>quote.includes(word)||quote.includes(word+'s')||word.endsWith('s')&&quote.includes(word.slice(0,-1)));
}
const vulgarFractions={'¼':1/4,'½':1/2,'¾':3/4,'⅐':1/7,'⅑':1/9,'⅒':1/10,'⅓':1/3,'⅔':2/3,'⅕':1/5,'⅖':2/5,'⅗':3/5,'⅘':4/5,'⅙':1/6,'⅚':5/6,'⅛':1/8,'⅜':3/8,'⅝':5/8,'⅞':7/8};
const fractionChars=Object.keys(vulgarFractions).join('');
function printedNumber(token){
  const fraction=token.match(/^(?:(\d+)\s+)?(\d+)\s*[\/⁄]\s*(\d+)$/);
  if(fraction)return Number(fraction[3])===0?NaN:Number(fraction[1]||0)+Number(fraction[2])/Number(fraction[3]);
  const vulgar=token.match(new RegExp('^(\\d*)\\s*(['+fractionChars+'])$'));
  if(vulgar)return Number(vulgar[1]||0)+vulgarFractions[vulgar[2]];
  return Number(token.replace(',','.'));
}
function amountQuoted(row){
  // A shopping-list choice is not evidence that every offered ingredient was
  // used. Do not allocate one printed quantity to several alternatives.
  if(/\bor\b|[a-z]\s*\/\s*[a-z]/i.test(row.evidence))return false;
  // A whitespace-separated Markdown list marker is not the amount's sign.
  // Keep the original quote untouched; adjacent and Unicode negative signs
  // still reach the scalar guard below, as do ranges within the line.
  const evidence=row.evidence.replace(/^\s*[-•*]\s+/, '');
  // Parse an explicit scalar exactly where the printed unit occurs. A mixed
  // fraction is one number, never a second count or an invented gram amount.
  const pattern=new RegExp('\\d+\\s+\\d+\\s*[\/⁄]\\s*\\d+|\\d+\\s*[\/⁄]\\s*\\d+|\\d*\\s*['+fractionChars+']|(?:\\d+(?:[.,]\\d+)?|[.,]\\d+)','g');
  for(const match of evidence.matchAll(pattern)){
    const token=match[0],before=evidence.slice(0,match.index),after=evidence.slice(match.index+token.length);
    if(/[\d.,\/⁄]$/.test(before)||/^[\d.,\/⁄]/.test(after))continue;
    if(Math.abs(printedNumber(token.trim())-row.amount)>1e-8||!Number.isFinite(printedNumber(token.trim())))continue;
    const unit=row.unit==='count'?['']:after.match(new RegExp('^\\s*'+units[row.unit]+'\\b','i'));
    if(!unit)continue;
    // Neither endpoint of a range, nor a negative number, is an exact amount.
    const rangeEnd=after.slice(unit[0].length);
    if(/[-–—−]\s*$/.test(before)||/\bto\s*$/i.test(before)
      ||/\bbetween\b[^;\n]*\band\s*$/i.test(before)
      ||/\bbetween\s*$/i.test(before)&&/^\s*and\s*[\d¼½¾⅓⅔⅛⅜⅝⅞]/i.test(after)
      ||new RegExp('^\\s*(?:[-–—]|to\\b)\\s*(?:\\d|[.,]\\d|['+fractionChars+'])','i').test(rangeEnd))continue;
    return true;
  }
  return false;
}
// OCR can represent a printed line/page break as vertical tab or form feed.
// Normalize these two whitespace characters consistently in both transcription
// and exact quotes. Other controls, markup and invalid shapes stay rejected.
export function normalizeRecipeWhitespace(value,report=()=>{}){
  if(value===null||typeof value!=='object'||Array.isArray(value))return value;
  const normalize=text=>{
    if(typeof text!=='string')return text;
    if(text.includes('\u000B'))report('vertical_tab');
    if(text.includes('\u000C'))report('form_feed');
    return text.replace(/[\u000B\u000C]/g,'\n');
  };
  return {...value,...(Object.hasOwn(value,'text')?{text:normalize(value.text)}:{}),
    ...(Object.hasOwn(value,'servingsEvidence')?{servingsEvidence:normalize(value.servingsEvidence)}:{}),
    ...(Array.isArray(value.ingredients)?{ingredients:value.ingredients.map(row=>{
      if(row===null||typeof row!=='object'||Array.isArray(row))return row;
      return {...row,...(Object.hasOwn(row,'evidence')?{evidence:normalize(row.evidence)}:{})};
    })}:{})};
}
// Malformed optional recipe evidence must not discard a valid photographed meal.
// Keep neither unlinked quantities nor a guessed yield as calculable evidence.
export function validateRecipeEvidence(value,components,report=()=>{},diagnostic=()=>{}){
  if(value==null)return null;
  value=normalizeRecipeWhitespace(value);
  // Retained analyses predate separate cross-page yield provenance.
  if(value&&typeof value==='object'&&!Object.hasOwn(value,'servingsPhotoIndex'))value={...value,servingsPhotoIndex:value.servings===null?null:value.photoIndex};
  const schemaIssue=outputSchemaIssue(value,recipeEvidenceSchema,'$.recipeEvidence');
  if(schemaIssue){diagnostic(schemaIssue);report('meal_recipe_evidence');return null;}
  if(!value.text.trim()||!value.ingredients.length||!value.componentIndexes.length
    ||new Set(value.componentIndexes).size!==value.componentIndexes.length||value.componentIndexes.some(i=>i>=components.length)){
    diagnostic({path:'$.recipeEvidence',reason:'empty_or_invalid_mapping'});
    report('meal_recipe_evidence');return null;
  }
  const result=structuredClone(value),contains=quote=>typeof quote==='string'&&quote.trim()&&normal(result.text).includes(normal(quote));
  // Old results can retain the exact printed line after a rejected quote lost
  // its quantity. Repair only explicit missing/sentinel rows with the shared
  // unique-line rule; contradictory quotes and supplied quantities stay rejected.
  result.ingredients=RecipeComposition.recoverIngredientRows(result.ingredients,result.text);
  result.ingredients=result.ingredients.map((row,index)=>{
    const next={...row};
    // The photo attribution belongs in photoIndex, not in a verbatim quote.
    // Remove it only when the index agrees and the remaining quote is actually
    // present. A different photo, paraphrase or voice claim cannot supply facts.
    const attributed=next.evidence.match(/^(?:recipe\s+)?photo\s+([1-4])\s*:\s*([\s\S]+)$/i);
    if(!contains(next.evidence)&&attributed&&Number(attributed[1])===result.photoIndex&&contains(attributed[2])){
      const candidates=result.ingredients.map((candidate,i)=>i===index?{...next,amount:null,unit:null,evidence:''}:candidate);
      const linked=RecipeComposition.recoverIngredientRows(candidates,result.text)[index];
      if(normal(linked.evidence)===normal(attributed[2])&&linked.amount===next.amount&&linked.unit===next.unit&&linked.amount!==null)next.evidence=linked.evidence;
    }
    if(!contains(next.evidence)||!next.name.trim()||!identityQuoted(next)){
      diagnostic({path:'$.recipeEvidence.ingredients['+index+'].evidence',reason:!contains(next.evidence)?'quote_not_in_text':!next.name.trim()?'empty_ingredient_identity':'ingredient_identity_not_quoted'});
      next.amount=null;next.unit=null;next.evidence='Recipe ingredient could not be linked to the printed text.';report('meal_recipe_evidence');
    }else if(next.amount===null||next.unit===null||!amountQuoted(next)||next.unit==='kg'&&next.amount*1000>5000){
      next.amount=null;next.unit=null;
      // Unquantified salt/seasoning is legitimate missing evidence, not a
      // malformed quantity worth spending another vision request on.
      if(row.amount!==null||row.unit!==null)report('meal_recipe_quantity');
    }
    return next;
  });
  // The validator above already accepts tbs. Legacy client recovery must not
  // reintroduce a quantity rejected for contradicting the supplied observation.
  result.ingredients=RecipeComposition.normaliseRows(result.ingredients,{recoverQuantities:false});
  if(!RecipeComposition.validServings(result.servings)||!contains(result.servingsEvidence)
    ||!/(?:serves?|servings?|portions?|people)\b/i.test(result.servingsEvidence)
    ||/\d\s*(?:[-–—]|to)\s*\d/i.test(result.servingsEvidence)
    ||!new RegExp('(?:^|[^0-9.,])'+numberPattern(result.servings)+'(?![0-9.,])').test(result.servingsEvidence)){
    if(result.servings!==null)report('meal_recipe_servings');
    result.servings=null;result.servingsEvidence=null;result.servingsPhotoIndex=null;
  }
  return result;
}
export function prepareRecipeCalculation(meal,report=()=>{},diagnostic=()=>{}){
  const issues=new Set(),recipe=validateRecipeEvidence(meal.recipeEvidence,meal.components||[],issue=>{issues.add(issue);report(issue);},diagnostic);
  if(!recipe)return {...meal,recipeEvidence:null,...(issues.size?{recipeEvidenceIssues:[...issues]}:{})};
  const calculationRows=RecipeComposition.planRows(recipe.ingredients,recipe.text);
  const measures=calculationRows.map(row=>recipeMeasure(row,recipe.text));
  const components=calculationRows.map((row,index)=>({name:row.name,preparation:row.preparation,
    amountGrams:row.unit==='g'?row.amount:row.unit==='kg'&&row.amount!==null?row.amount*1000:measures[index]?.amountGrams??null,
    evidence:('Recipe photo '+recipe.photoIndex+': '+row.evidence).slice(0,160),photoIndex:recipe.photoIndex,
    assumptions:['Ingredient quantity belongs to the complete recipe batch, not the photographed portion.',
      ...(measures[index]?.assumptions||(!['g','kg'].includes(row.unit)?['A supported edible gram equivalent is needed for this ingredient quantity.']:[]))]}));
  const resolved=resolveMealComponents(components,{estimatedServing:true,mealName:meal.name,mealIngredients:calculationRows});
  resolved.components=resolved.components.map((component,index)=>{
    const measure=measures[index];if(!measure)return component;
    return {...component,recordId:measure.sourceRecord.id,sourceRecord:measure.sourceRecord,nutrients:measure.sourceRecord.nutrients,
      candidates:[measure.sourceRecord],matchStatus:'matched',matchMethod:'recipe_household_measure',amountSource:'household_measure_estimate',
      householdMeasure:measure.conversion,assumptions:[...component.assumptions,...measure.assumptions],
      ...(component.recordId&&component.recordId!==measure.sourceRecord.id?{recipeSourceRecovery:{reason:'Whole-source recipe estimate after printed quantity recovery',original:{recordId:component.recordId,sourceRecord:component.sourceRecord,nutrients:component.nutrients}}}:{})};
  });
  const batch=MealRecovery?.recover({...resolved,name:meal.name,ingredients:calculationRows,portionMode:'estimated_serving'},{confirmed:false,userEdited:false})||resolved;
  // Retain the printed unit even when it cannot safely be converted to grams.
  batch.components=batch.components.map((c,i)=>({...c,
    // A matched source is already retained in sourceRecord. Repeating it in
    // candidates in both batch and selected portion adds no evidence.
    ...(c.recordId&&c.sourceRecord?.id===c.recordId?{candidates:[]}:{}),
    recipeIngredient:{...calculationRows[i],photoIndex:recipe.photoIndex},
    ...(calculationRows[i].recipeChoice?{recipeChoice:calculationRows[i].recipeChoice}:{}),
    ...(calculationRows[i].recipeGroup?{recipeGroup:calculationRows[i].recipeGroup}:{})}));
  const candidate={...meal,recipeEvidence:recipe,recipeCalculation:{version:RecipeComposition.VERSION,status:'needs_servings',applied:false,
    servings:recipe.servings,servingsSource:recipe.servings===null?null:'recipe',componentIndexes:[...recipe.componentIndexes],photoIndex:recipe.photoIndex,validationIssues:[...issues],
    batchComponents:batch.components,batchNutrients:Composition.total(batch.components),originalPlateComponents:structuredClone(meal.components),
    unsupportedAmounts:calculationRows.flatMap((row,index)=>batch.components[index].amountGrams===null?[{index,name:row.name,amount:row.amount,unit:row.unit}]:[])}};
  const covered=recipe.componentIndexes.map(i=>meal.components[i]);
  const visual=Composition.total(covered),batchTotal=candidate.recipeCalculation.batchNutrients;
  if(visual.energyKcal.value!==null&&batchTotal.energyKcal.knownContributions===0
    &&covered.every(c=>c.recordId&&c.sourceRecord?.id===c.recordId&&!/recipe photo|marketing|illustration|stock image|website/i.test(c.evidence||''))){
    candidate.recipeCalculation.deferredReason='The recipe has no usable ingredient quantities and sources. The separate photo portion estimate is retained.';
    return candidate;
  }
  // The complete recipe is useful independently of a serving count. This is a
  // reviewable calculation only; the existing diary flow still asks the user to
  // select how much was eaten and explicitly confirm it.
  return RecipeComposition.apply(candidate,recipe.servings,{source:'recipe',portionFraction:1});
}
export function needsRecipeEvidenceRecheck(extraction){
  if(extraction?.type!=='meal')return false;
  return [...(extraction.meal.recipeEvidenceIssues||[]),...(extraction.meal.recipeCalculation?.validationIssues||[])]
    .some(issue=>['meal_recipe_evidence','meal_recipe_quantity'].includes(issue));
}
// Compare quantities and source-backed contributions, not whether a score or
// every nutrient happens to be complete. Unquantified salt must stay unknown.
export function recipeCoverage(meal){
  const recipe=meal?.recipeEvidence,components=meal?.recipeCalculation?.batchComponents||[];
  return {quantities:(recipe?.ingredients||[]).filter(row=>row.amount!==null&&row.unit!==null).length,
    contributions:components.reduce((sum,c)=>sum+(typeof c.amountGrams==='number'&&c.amountGrams>0&&c.recordId===c.sourceRecord?.id
      ?Object.values(c.sourceRecord?.nutrients||{}).filter(n=>typeof n?.value==='number'&&Number.isFinite(n.value)).length:0),0)};
}
const ingredientKey=name=>identityWords(name).filter(word=>!['for','the','topping','filling','sauce','hot','cold','fresh','raw','peeled','chopped','hard','boiled','cooked','baked','freshly','ground','large','medium','small','roughly','finely','diced'].includes(word)).map(word=>word.endsWith('s')?word.slice(0,-1):word).join(' ');
const sameIngredient=(first,next)=>{
  const a=ingredientKey(first.name),b=ingredientKey(next.name);
  return a===b||(first.amount===null&&first.unit===null&&a&&a.split(' ').every(word=>b.split(' ').includes(word)));
};
export function mergeRecipeRecheck(first,second,report=()=>{}){
  const retain=reason=>{report(reason);return first;};
  const a=first?.meal,b=second?.meal,ra=a?.recipeEvidence,rb=b?.recipeEvidence,ca=a?.recipeCalculation,cb=b?.recipeCalculation;
  if(first?.type!=='meal'||second?.type!=='meal'||!rb||!cb||a.subject?.photoIndex!==b.subject?.photoIndex
    ||ra&&ra.photoIndex!==rb.photoIndex||ca?.userEdited)return retain('evidence_or_mapping_invalid');
  if(!ca||!ra){
    // Invalid optional recipe mappings may have been discarded entirely. In
    // that case the second observation rebuilds the VISUAL plate, not a list
    // of copied recipe rows. Do not retain those rows as extra meal components.
    const before=recipeCoverage(a),after=recipeCoverage(b);
    if(after.quantities<=before.quantities&&after.contributions<=before.contributions)return retain('coverage_unchanged');
    const original=structuredClone(cb.originalPlateComponents),covered=new Set(cb.componentIndexes);
    for(const old of a.components||[]){
      if(/^Recipe photo\s*\d+\s*:/i.test(old.evidence||'')||typeof old.amountGrams!=='number')continue;
      const index=original.findIndex((next,i)=>!covered.has(i)&&ingredientKey(next.name)===ingredientKey(old.name)&&next.photoIndex===old.photoIndex);
      if(index>=0)original[index]=structuredClone(old);
      // An explicitly observed separate side cannot disappear into the recipe.
      else if(/\bside\b/i.test(old.name||'')&&!original.some((next,i)=>!covered.has(i)&&ingredientKey(next.name).includes(ingredientKey(old.name).replace(/\bside\b/g,'').trim())))return retain('side_not_preserved');
    }
    const meal=RecipeComposition.apply({...b,recipeCalculation:{...cb,originalPlateComponents:original,applied:true}},rb.servings,{source:'recipe',portionFraction:1});
    report('recovered');return {...second,meal};
  }
  // A repair may split the observed pie differently. Its batch can replace the
  // original covered components while the first observed sides stay unchanged.
  // Do not improve apparent coverage by omitting a difficult recipe ingredient.
  const used=new Set(),retained=new Map(),usedBatch=new Set();
  const samePrintedRow=(a,b)=>a&&b&&normal(a.name)===normal(b.name)&&normal(a.preparation)===normal(b.preparation)
    &&a.amount===b.amount&&a.unit===b.unit&&normal(a.evidence)===normal(b.evidence);
  for(const row of ra.ingredients){
    const i=rb.ingredients.findIndex((next,index)=>!used.has(index)&&sameIngredient(row,next)
      &&(row.amount===null||row.unit===null||next.amount===row.amount&&next.unit===row.unit&&normal(next.evidence)===normal(row.evidence)));
    if(i<0)return retain('ingredient_or_quantity_not_preserved');used.add(i);
    // Choice and kit rows collapse several printed ingredients into one batch
    // component. Raw ingredient indexes no longer identify batch components.
    const oldIndex=ca.batchComponents.findIndex((c,index)=>!usedBatch.has(index)&&samePrintedRow(c.recipeIngredient,row));
    const component=ca.batchComponents[oldIndex];if(oldIndex>=0)usedBatch.add(oldIndex);
    if(row.amount!==null&&row.unit!==null&&component?.recordId&&component.sourceRecord?.id===component.recordId
      &&typeof component.amountGrams==='number'){
      const target=cb.batchComponents.findIndex((c,index)=>!retained.has(index)&&samePrintedRow(c.recipeIngredient,rb.ingredients[i]));
      if(target<0)return retain('ingredient_or_quantity_not_preserved');
      retained.set(target,component);
    }
  }
  if(ra.servings!==null&&(rb.servings!==ra.servings||normal(rb.servingsEvidence)!==normal(ra.servingsEvidence)))return retain('yield_not_preserved');
  const batchComponents=cb.batchComponents.map((component,index)=>retained.has(index)?structuredClone(retained.get(index)):component);
  const candidate={...b,recipeEvidence:{...rb,componentIndexes:[...ca.componentIndexes]},recipeCalculation:{...cb,batchComponents,
    batchNutrients:Composition.total(batchComponents),componentIndexes:[...ca.componentIndexes],
    originalPlateComponents:structuredClone(ca.originalPlateComponents),applied:true}};
  const oldCoverage=recipeCoverage(a),newCoverage=recipeCoverage(candidate);
  if(newCoverage.quantities<oldCoverage.quantities||newCoverage.contributions<oldCoverage.contributions
    ||newCoverage.quantities===oldCoverage.quantities&&newCoverage.contributions===oldCoverage.contributions)return retain('coverage_unchanged');
  const meal=RecipeComposition.apply(candidate,rb.servings,{source:'recipe',portionFraction:1});
  report('recovered');return {...second,meal};
}
export function correctRecipeAttribution(extraction,hasVoice){
  if(hasVoice||extraction?.type!=='meal')return extraction;
  const meal=extraction.meal,recipe=meal.recipeEvidence;
  for(const row of [...(meal.ingredients||[]),...(meal.components||[])]){
    if(!/^User described\s*:/i.test(row.evidence||''))continue;
    const quote=row.evidence.replace(/^User described\s*:\s*/i,'');
    row.evidence=((recipe&&normal(recipe.text).includes(normal(quote))?'Recipe photo '+recipe.photoIndex+': ':'Image interpretation (unverified): ')+quote).slice(0,160);
  }
  return extraction;
}
