// Local OCR observations only. No transport, storage, credentials or new scoring.
import { nutrientKeys, validateExtraction } from './photo-analysis-contract.js';
import { emptyMetadata, bindPhotoEvidence } from './photo-evidence.js';
import { prepareRecipeCalculation } from './recipe-evidence.js';
import { RecipeComposition, Composition } from './nutrition-core.js';
import { compositionVersion } from './composition.js';
import { recipeMeasure } from './recipe-measures.js';
import { validateMealHints, reconcileMealHints } from './meal-hints.js';

export const VERSION = 'nudge-fast-capture-v1';
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const known = value => finite(value) && value >= 0;
const normal = value => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const safeText = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Cs}]|<\/?[a-z!][^>]*>/iu.test(value);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(value);
const fail = reason => { throw new Error(reason); };
const boxOK = b => object(b) && ['x','y','width','height'].every(k => finite(b[k]) && b[k] >= 0 && b[k] <= 1) && b.x+b.width <= 1.001 && b.y+b.height <= 1.001;
function validateInput(input) {
  if (!object(input) || Object.keys(input).some(k => !['pages','label','photoIds','captureRevision','mealHints','requestId'].includes(k))
    || !Array.isArray(input.photoIds) || input.photoIds.length < 1 || input.photoIds.length > 4 || input.photoIds.some(id => !identity(id))
    || new Set(input.photoIds).size !== input.photoIds.length || !Number.isSafeInteger(input.captureRevision) || input.captureRevision < 0
    || !identity(input.requestId) || !Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > 4) fail('invalid_local_input');
  const seen = new Set(); let characters = 0;
  const pages = input.pages.map(page => {
    if (!object(page) || !Number.isInteger(page.photoIndex) || page.photoIndex < 1 || page.photoIndex > input.photoIds.length
      || page.photoID !== input.photoIds[page.photoIndex-1] || seen.has(page.photoIndex) || !Array.isArray(page.lines) || page.lines.length > 200) fail('invalid_ocr_page');
    seen.add(page.photoIndex); const ids = new Set();
    const lines = page.lines.map(line => {
      if (!object(line) || !identity(line.id) || ids.has(line.id) || !safeText(line.text, 600) || !finite(line.confidence)
        || line.confidence < 0 || line.confidence > 1 || !boxOK(line.box) || !Array.isArray(line.words) || line.words.length > 100) fail('invalid_ocr_line');
      ids.add(line.id); characters += line.text.length;
      for (const word of line.words) if (!object(word) || !safeText(word.text,600) || !Number.isInteger(word.start) || !Number.isInteger(word.length)
        || word.start < 0 || word.length < 1 || line.text.slice(word.start,word.start+word.length) !== word.text || !boxOK(word.box)) fail('invalid_ocr_word');
      return clone(line);
    });
    return {photoID:page.photoID,photoIndex:page.photoIndex,lines};
  }).sort((a,b)=>a.photoIndex-b.photoIndex);
  if (seen.size !== input.photoIds.length) fail('ocr_page_missing');
  if (characters > 24_000) fail('ocr_too_large');
  return {...input,pages,mealHints:input.mealHints == null ? null : validateMealHints(input.mealHints)};
}
const blank = () => Object.fromEntries(nutrientKeys.map(key => [key,null]));
function envelope() {
  return {type:'product',metadata:null,meal:null,productName:null,brand:null,photoConsistency:'sameProduct',servingSuggestion:null,
    categoryTag:null,retailer:null,labelKind:'nutrition',ingredients:null,basis:'unknown',energyKj:null,nutritionPreparation:'unknown',
    servingSize:null,needsClearerPhoto:false,message:'',nutrients:blank()};
}
function labelExtraction(label, input) {
  if (input.photoIds.length!==1 || !object(label) || label.version !== 'local-food-label-v1' || !['per100g','per100ml'].includes(label.basis)
    || !['as_sold','prepared','unknown'].includes(label.nutritionPreparation) || !Number.isInteger(label.photoIndex)
    || input.photoIds[label.photoIndex-1] !== label.photoID || !object(label.nutrients)
    || Object.keys(label.nutrients).sort().join(',') !== [...nutrientKeys].sort().join(',')
    || !Array.isArray(label.evidence) || label.evidence.length > 32) fail('invalid_local_label');
  const page = input.pages.find(p=>p.photoIndex===label.photoIndex); if (!page) fail('label_photo_missing');
  const sourceLine=(ids,fallback)=>{
    ids=ids??[fallback];if(!Array.isArray(ids)||ids.length<1||ids.length>12||new Set(ids).size!==ids.length)fail('label_evidence_unlinked');
    const lines=ids.map(id=>page.lines.find(l=>l.id===id));
    if(lines.some(l=>!l||l.confidence<.85))fail('label_evidence_unlinked');
    for(let i=1;i<lines.length;i++)if(lines[i].box.x<lines[i-1].box.x+lines[i-1].box.width-.005
      ||Math.abs(lines[i].box.y+lines[i].box.height/2-lines[0].box.y-lines[0].box.height/2)>Math.max(.012,lines[0].box.height*.5))fail('label_evidence_unlinked');
    return lines.map(l=>l.text).join(' ');
  };
  const metadata=emptyMetadata(), evidenceByField=new Map();
  for (const [index,e] of label.evidence.entries()) {
    const line=page.lines.find(l=>l.id===e.lineID);
    if (!object(e) || ![...nutrientKeys,'energyKj'].includes(e.field) || e.photoID!==page.photoID || e.photoIndex!==page.photoIndex
      || !line || !safeText(e.text,600) || e.text!==sourceLine(e.lineIDs,e.lineID) || !safeText(e.basisHeader,600)
      || !(e.basisLineIDs ? sourceLine(e.basisLineIDs,null)===e.basisHeader : page.lines.some(l=>l.confidence>=.85 && l.text===e.basisHeader))) fail('label_evidence_unlinked');
    if (evidenceByField.has(e.field)) fail('label_evidence_conflict'); evidenceByField.set(e.field,e);
    metadata.evidence.push({id:'ocr-'+index,field:'nutrition',text:e.text.slice(0,500),photoIndex:page.photoIndex,region:'Local OCR nutrition table'});
  }
  const raw={...envelope(),basis:label.basis,nutritionPreparation:label.nutritionPreparation,metadata};
  for (const key of nutrientKeys) {
    const n=label.nutrients[key],e=evidenceByField.get(key),unit=key==='energyKcal'?'kcal':'g';
    if (!object(n) || n.unit!==unit || n.value!==null && (!known(n.value)||n.value>1_000_000)) fail('label_nutrient_invalid');
    const relation=n.relation??e?.relation??'=';
    if (!['=','eq','<','<=','>','>=','lt','lte','gt','gte'].includes(relation)) fail('label_relation_invalid');
    // The existing intake snapshot treats numerics as exact. Keep bounds as
    // evidence, never turn a printed inequality into an exact intake quantity.
    if (n.value!==null && (!e || !['=','eq'].includes(relation))) fail('label_bound_not_exact');
    raw.nutrients[key]=n.value===null?null:{value:n.value,unit};
  }
  if(label.energyKj!=null){
    const n=label.energyKj,e=evidenceByField.get('energyKj');
    if(!object(n)||n.unit!=='kJ'||!e||n.value!==null&&(!known(n.value)||!['=','eq'].includes(n.relation??e.relation??'=')))fail('label_energy_invalid');
    raw.energyKj=n.value===null?null:{value:n.value,unit:'kJ'};
  }
  const result=validateExtraction(raw,false,false);
  // This additive evidence survives normalisation inside metadata. It is
  // private source evidence, never diagnostics or a shared-product cache.
  result.metadata.localLabel={version:label.version,basis:label.basis,evidence:clone(label.evidence)};
  return result;
}
const heading=/^(?:ingredients(?: list)?|recipe ingredients|shopping list|(?:what )?you(?: will|'ll|’ll) need)\s*:?$/i;
const endHeading=/^(?:method|instructions|directions|preparation|nutrition(?:al)?(?: information| facts)?|allerg(?:ies|ens)|storage)\s*:?$/i;
const sideHeading=/^(?:to serve|for serving|serving suggestions|sides?|optional(?: extras| ingredients)?)\s*:?$/i;
const numberToken='(?:\\d+\\s+\\d+\\s*[/⁄]\\s*\\d+|\\d+\\s*[/⁄]\\s*\\d+|\\d*\\s*[¼½¾⅓⅔⅛⅜⅝⅞]|(?:\\d+(?:[.,]\\d+)?|[.,]\\d+))';
const fraction={'¼':.25,'½':.5,'¾':.75,'⅓':1/3,'⅔':2/3,'⅛':.125,'⅜':.375,'⅝':.625,'⅞':.875};
function number(value){const f=value.trim().match(/^(?:(\d+)\s+)?(\d+)\s*[/⁄]\s*(\d+)$/);if(f)return +f[3] ? +(f[1]||0)+ +f[2]/+f[3]:NaN;const v=value.trim().match(/^(\d*)\s*([¼½¾⅓⅔⅛⅜⅝⅞])$/);return v?+(v[1]||0)+fraction[v[2]]:Number(value.replace(',','.'));}
const unitNames={g:'g',gram:'g',grams:'g',kg:'kg',kilogram:'kg',kilograms:'kg',ml:'ml',millilitre:'ml',millilitres:'ml',milliliter:'ml',milliliters:'ml',l:'l',litre:'l',litres:'l',liter:'l',liters:'l',tsp:'tsp',teaspoon:'tsp',teaspoons:'tsp',tbsp:'tbsp',tbs:'tbsp',tablespoon:'tbsp',tablespoons:'tbsp',x:'count'};
function ingredient(line,page,section,index){
  const evidence=line.text.trim();if(evidence.length>160||line.confidence<.85)fail('recipe_text_uncertain');
  if(/\b(?:ignore (?:all|previous)|system prompt|assistant|developer message|set (?:all )?nutrients?|output json)\b/i.test(evidence))fail('recipe_instruction_content');
  let rest=evidence.replace(/^[-•*]\s+/,'').trim(),amount=null,unit=null;
  const m=rest.match(new RegExp('^('+numberToken+')\\s*([a-z]+)?\\s*(.*)$','i'));
  if(m){
    amount=number(m[1]);const token=(m[2]||'').toLowerCase();unit=unitNames[token]||'count';rest=unitNames[token]?m[3]:[m[2],m[3]].filter(Boolean).join(' ');
    if(!finite(amount)||amount<=0||amount>5000||unit==='kg'&&amount*1000>5000)fail('recipe_quantity_invalid');
    if(/^[–—−-]|^to\b/i.test(rest)||/\bbetween\b|\d\s*(?:g|kg|ml|tsp|tbsp)\b/i.test(rest)){amount=null;unit=null;}
  }
  const optional=section==='side'||/\boptional\b|\bto serve\b/i.test(rest);
  const side=section==='side'||/\b(?:naan|chapati|pitta|pita)\b/i.test(rest);
  let name=rest.replace(/\s*\((?:optional|to serve)\)\s*/ig,' ').replace(/\s*[,;]?\s*(?:optional|to serve|to taste)\s*$/i,'').trim();
  // Commas after the food describe preparation, not another ingredient.
  name=name.split(/,\s*(?:finely |roughly )?(?:chopped|diced|sliced|peeled|crushed|grated)\b/i)[0].trim();
  if(!name||name.length>100||/[<>]|https?:|\b(?:kcal|calories|protein|carbohydrate|saturated fat|daily goal)\b/i.test(name))fail('recipe_row_unsupported');
  if(/\bor\b|[a-z]\s*\/\s*[a-z]/i.test(name)){amount=null;unit=null;}
  const preparation=/\b(?:cooked|boiled|steamed)\b/i.test(rest)?(/\bboiled\b/i.test(rest)?'boiled':'cooked'):/\broasted\b/i.test(rest)?'roasted':/\b(?:fried|grilled|baked)\b/i.test(rest)?rest.match(/\b(fried|grilled|baked)\b/i)[1].toLowerCase():/\b(?:naan|bread|paste|sachet|kit|powder|salt|oil|milk|sauce)\b/i.test(rest)?'unknown':'raw';
  name=name.replace(/^(?:raw|cooked|boiled|steamed|roasted|fried|grilled|baked)\s+/i,'');
  return {id:'recipe-row-'+index,name,preparation,amount,unit,evidence,photoIndex:page.photoIndex,lineID:line.id,optional:optional||side,side};
}
function parseRecipe(input){
  const rows=[],allText=[],seenPages=new Set(),previousCounts=new Map();let servings=null,servingsEvidence=null,servingsPhotoIndex=null,title='Recipe from text',hasHeading=false,unscopedQuantity=false,unaccountedPage=false;
  for(const page of input.pages){
    const lines=[...page.lines].sort((a,b)=>b.box.y-a.box.y||a.box.x-b.box.x),signature=lines.map(l=>normal(l.text)).join('\n');
    if(seenPages.has(signature))continue;seenPages.add(signature);
    let section=null,subsection='',ended=false,pageHasHeading=false,pageHasYield=false;const pageCounts=new Map();
    for(let i=0;i<lines.length;i++){
      const line=lines[i],text=line.text.trim();if(!text)continue;
      const yieldLine=text.match(/^(?:serves?|servings?|portions?|makes)\s*:?\s*(\d+(?:[.,]\d+)?)\s*(?:people|servings?|portions?)?$/i);
      if(yieldLine){
        const value=Number(yieldLine[1].replace(',','.'));
        if(line.confidence<.85||!RecipeComposition.validServings(value)||servings!==null&&servings!==value)fail('recipe_yield_conflict');
        servings=value;servingsEvidence=text;servingsPhotoIndex=page.photoIndex;pageHasYield=true;allText.push(text);continue;
      }
      if(heading.test(text)){section='main';subsection='';hasHeading=true;pageHasHeading=true;ended=false;allText.push(text);if(i>0){const candidate=lines.slice(0,i).find(l=>l.text.length<=100&&!/^(?:serves?|servings?|shopping)/i.test(l.text)&&!heading.test(l.text))?.text.trim();if(candidate){if(title!=='Recipe from text'&&normal(title)!==normal(candidate))fail('recipe_identity_conflict');title=candidate;}}continue;}
      if(sideHeading.test(text)){section='side';allText.push(text);continue;}
      if(endHeading.test(text)){section=null;ended=true;continue;}
      if(!section){if(!ended&&!pageHasHeading&&/^\s*(?:[-•*]\s+)?\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l|tbsp|tsp|tablespoons?|teaspoons?)\s+\p{L}/iu.test(text))unscopedQuantity=true;continue;}
      // A section heading is not a food. Preserve section separation for repeated
      // butter/flour rows; exact repeated screenshot rows are deduplicated only
      // across pages, using the greatest observed multiplicity rather than a set.
      if(/^(?:for (?:the )?(?:sauce|filling|topping|marinade)|sauce|filling|topping|marinade)\s*:?$/i.test(text)){subsection=normal(text);allText.push(text);continue;}
      const row=ingredient(line,page,section,rows.length),key=normal(section+'|'+subsection+'|'+text),occurrence=(pageCounts.get(key)||0)+1;pageCounts.set(key,occurrence);
      if(occurrence<=(previousCounts.get(key)||0))continue;
      if(rows.length>=40)fail('recipe_too_many_rows');rows.push(row);allText.push(text);
    }
    for(const [key,count] of pageCounts)previousCounts.set(key,Math.max(count,previousCounts.get(key)||0));
    // OCR cannot establish that an unreadable extra image is only marketing.
    // Every nonduplicate submitted photo must be accounted for by recipe text.
    if(!pageHasHeading&&!pageHasYield)unaccountedPage=true;
  }
  if(!hasHeading||rows.length<1||!rows.some(r=>!r.optional)||servings===null&&!rows.some(r=>r.amount!==null))return null;
  if(unscopedQuantity||unaccountedPage)fail('recipe_page_unscoped');
  const text=allText.join('\n');if(text.length>6000)fail('recipe_text_too_large');
  return {title,servings,servingsEvidence,servingsPhotoIndex,rows,text,textChunks:text.match(/[\s\S]{1,1000}/g)||[],photoIds:[...input.photoIds]};
}
function recipeExtraction(recipe,includedOptionIds=[],selectedFraction=1,selectedServings=recipe.servings){
  const optional=recipe.rows.filter(r=>r.optional),ids=new Set(includedOptionIds);
  if(ids.size!==includedOptionIds.length||includedOptionIds.some(id=>!optional.some(r=>r.id===id)))fail('recipe_option_invalid');
  const selected=recipe.rows.filter(r=>!r.optional||ids.has(r.id));
  const photoIndex=selected[0].photoIndex;
  const ingredients=selected.map(({name,preparation,amount,unit,evidence})=>({name,preparation,amount,unit,evidence}));
  const recipeEvidence={photoIndex,text:recipe.text,servings:recipe.servings,servingsEvidence:recipe.servingsEvidence,
    servingsPhotoIndex:recipe.servingsPhotoIndex,componentIndexes:[0],ingredients};
  // An explicit recipe container adapts batch replacement to the existing
  // recipe engine. It is not a photographed meal, contains no weights/source,
  // and disappears from calculated components when the batch is applied.
  let meal={name:recipe.title,inputKind:'recipe_text',compositionVersion,ingredients:selected.map(r=>({name:r.name,evidence:r.evidence})),plants:[],
    components:[{name:recipe.title,preparation:'unknown',amountGrams:null,nutrients:{},recordId:null,sourceRecord:null,evidence:'Printed recipe text',photoIndex}],
    recipeEvidence,portionMode:'estimated_serving',qualityEstimate:null,portion:{label:'Whole recipe',amount:null,unit:null,source:'estimated'},
    basis:'perPortion',estimated:true,needsReview:true,message:'Recipe quantities from text; review sources, missing amounts and the portion.'};
  meal=prepareRecipeCalculation(meal);
  if(!meal.recipeCalculation?.applied)fail('recipe_not_calculable');
  // Restore each row's real page linkage after the legacy single-page batch
  // adapter. The full exact text is retained, not a claim that pages were one.
  const linked=new Set();
  for(const c of meal.recipeCalculation.batchComponents){
    const row=selected.find(r=>!linked.has(r.id)&&r.evidence===c.recipeIngredient?.evidence&&r.name===c.recipeIngredient?.name);
    if(row){linked.add(row.id);c.photoIndex=row.photoIndex;c.recipeIngredient.photoIndex=row.photoIndex;c.recipeIngredient.lineID=row.lineID;}
    if(c.recipeChoice)for(const option of c.recipeChoice.options)if(['tbsp','tsp'].includes(option.unit))option.localMeasureSystem='uk-volume-v1';
    const printed=c.recipeIngredient;
    if(['tbsp','tsp'].includes(printed?.unit)){
      printed.localMeasureSystem='uk-volume-v1';
      const volumeMl=printed.amount*(printed.unit==='tbsp'?15:5),measure=recipeMeasure({...printed,amount:volumeMl,unit:'ml'},recipe.text);
      c.amountGrams=measure?.amountGrams??null;
      c.householdMeasure={...(measure?.conversion||{}),version:'local-uk-volume-v1',status:measure?'household_measure_estimate':'volume_without_density',inputAmount:printed.amount,inputUnit:printed.unit,volumeMl,
        unitSourceURL:'https://www.fhft.nhs.uk/patients-and-visitors/patient-information-library/liquidised-diet'};
      c.assumptions=['Printed UK measuring spoon converted to '+volumeMl+' ml; no ml = g assumption.',...(measure?.assumptions||['No supported ingredient-specific density is available. Weigh this ingredient to include its nutrition.'])];
      if(measure){c.recordId=measure.sourceRecord.id;c.sourceRecord=measure.sourceRecord;c.nutrients=measure.sourceRecord.nutrients;}
    }
  }
  meal.recipeCalculation.batchNutrients=Composition.total(meal.recipeCalculation.batchComponents);
  meal.recipeCalculation.unsupportedAmounts=meal.recipeCalculation.batchComponents.flatMap((c,index)=>c.amountGrams===null?[{index,name:c.name,amount:c.recipeIngredient?.amount??null,unit:c.recipeIngredient?.unit??null}]:[]);
  meal.recipeCalculation.fastCapture={version:VERSION,recipe:clone(recipe),includedOptionIds:[...includedOptionIds]};
  meal.recipeCalculation.recipeOptions=optional.map(r=>({id:r.id,title:r.name,evidence:r.evidence,photoIndex:r.photoIndex,selected:ids.has(r.id),side:r.side}));
  meal=RecipeComposition.apply(meal,selectedServings,{source:'recipe',portionFraction:selectedFraction});
  const plants=Composition.componentPlants(meal.components);meal.plants=plants;
  return {...envelope(),type:'meal',photoConsistency:'sameMeal',labelKind:'both',basis:'unknown',meal,productName:recipe.title};
}
function result(extraction,input,recipe=null){
  extraction=bindPhotoEvidence(extraction,{photoIds:input.photoIds,images:input.photoIds.map(()=>({})),captureRevision:input.captureRevision});
  extraction=reconcileMealHints(extraction,input.mealHints);
  extraction.analysisVersion=VERSION;extraction.requestId=input.requestId;extraction.inputKind=extraction.type==='meal'?'recipe_text':'nutrition_label';
  extraction.inputRoute=extraction.inputKind==='recipe_text'?'local_recipe_ocr':'local_label_ocr';
  const nutrients=extraction.type==='meal'?extraction.meal.nutrients:extraction.nutrients;
  const missing=nutrientKeys.filter(k=>!known(nutrients[k]?.value)||nutrients[k]?.unknownContributions>0),reasonCodes=[];
  const calculation=extraction.meal?.recipeCalculation;
  const recipeIncomplete=calculation&&(calculation.status!=='ready'||calculation.servings===null||calculation.batchComponents.some(c=>!known(c.amountGrams)||!c.recordId||c.recordId!==c.sourceRecord?.id));
  if(missing.length)reasonCodes.push('nutrition_incomplete');
  if(recipe&&(recipe.servings===null||calculation?.servings===null))reasonCodes.push('recipe_yield_unknown');
  if(recipe?.rows.some(r=>r.optional))reasonCodes.push('optional_ingredients_excluded');
  if(extraction.meal?.components.some(c=>c.householdMeasure))reasonCodes.push('household_measure_estimate');
  if(JSON.stringify(extraction).length>240_000)fail('local_result_too_large');
  return {status:missing.length||recipe?.servings===null||recipeIncomplete?'partial':'ready',extraction,reasonCodes,
    cacheDescriptor:{version:VERSION,recipe:recipe?clone(recipe):null,label:input.label?clone(input.label):null,
      mealHints:input.mealHints,compositionVersion:extraction.meal?.compositionVersion??null,
      recipeVersion:RecipeComposition.VERSION,householdVersion:RecipeComposition.HOUSEHOLD_VERSION,
      // Native must add all ordered image hashes and the generated source-manifest
      // hash. Request IDs/revisions are bindings, never reusable cache identity.
      requiresImageAndSourceHashes:true}};
}
export function localCapture(value){
  try{
    const input=validateInput(value),recipe=parseRecipe(input);
    if(recipe&&input.label)return {status:'fallback',extraction:null,reasonCodes:['mixed_recipe_and_label'],cacheDescriptor:null};
    if(recipe)return result(recipeExtraction(recipe),input,recipe);
    if(input.label)return result(labelExtraction(input.label,input),input);
    return {status:'fallback',extraction:null,reasonCodes:['local_input_unsupported'],cacheDescriptor:null};
  }catch(error){return {status:'fallback',extraction:null,reasonCodes:[typeof error.message==='string'&&/^[a-z_]{1,50}$/.test(error.message)?error.message:'local_validation_failed'],cacheDescriptor:null};}
}
export function recalculate({extraction,includedOptionIds}){
  try{
    const current=extraction?.meal?.recipeCalculation,saved=current?.fastCapture;
    if(saved?.version!==VERSION||current.userEdited||extraction.meal.userEdited||!Array.isArray(includedOptionIds)||includedOptionIds.length>40)fail('recipe_edited_or_invalid');
    const recipe=clone(saved.recipe);if(Array.isArray(recipe.textChunks))recipe.text=recipe.textChunks.join('');
    let next=recipeExtraction(recipe,includedOptionIds,current.selectedFraction,current.servings);
    for(const component of current.batchComponents||[]){const choice=component.recipeChoice;if(choice?.selected)next.meal=RecipeComposition.selectChoice(next.meal,choice.id,choice.selected);}
    next={...next,analysisId:extraction.analysisId,analysisVersion:VERSION,captureRevision:extraction.captureRevision,photoIds:extraction.photoIds,requestId:extraction.requestId,inputKind:'recipe_text',inputRoute:'local_recipe_ocr'};
    for(const c of [...next.meal.components,...next.meal.recipeCalculation.batchComponents])c.photoId=recipe.photoIds[c.photoIndex-1]??null;
    const calculation=next.meal.recipeCalculation;
    const incomplete=nutrientKeys.some(k=>!known(next.meal.nutrients[k]?.value)||next.meal.nutrients[k]?.unknownContributions>0)
      ||calculation.status!=='ready'||calculation.servings===null||calculation.batchComponents.some(c=>!known(c.amountGrams)||!c.recordId||c.recordId!==c.sourceRecord?.id);
    return {status:incomplete?'partial':'ready',extraction:next,reasonCodes:incomplete?['nutrition_incomplete']:[],cacheDescriptor:null};
  }catch{return {status:'fallback',extraction:null,reasonCodes:['recipe_edited_or_invalid'],cacheDescriptor:null};}
}
globalThis.NudgeFastCapture=Object.freeze({version:VERSION,localCapture,recalculate});
