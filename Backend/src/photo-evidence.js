// Evidence-only output contract. None of these declarations establishes safety.
const string=(maxLength,type='string')=>({type,maxLength});
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const array=(items,maxItems)=>({type:'array',items,maxItems});
const nullable=properties=>({anyOf:[object(properties),{type:'null'}]});
const field={type:'string',enum:['identity','nutrition','ingredients','allergens','claims','netQuantity','preparation','batch-date','meal']};
export const metadataSchema=nullable({
 country:string(60,['string','null']),variant:string(100,['string','null']),
 netQuantity:nullable({value:{type:'number',minimum:.1,maximum:100000},unit:{type:'string',enum:['g','ml']},evidenceId:string(32)}),
 batchCode:string(80,['string','null']),dateMarking:string(100,['string','null']),
 claims:array(object({text:string(180),kind:{type:'string',enum:['vegan','vegetarian','gluten-free','organic','other']},evidenceId:string(32)}),8),
 allergenWording:object({contains:string(500,['string','null']),mayContain:string(500,['string','null']),factoryHandling:string(500,['string','null'])}),
 ingredientTree:array(object({id:string(32),name:string(120),parentId:string(32,['string','null']),percentage:{type:['number','null'],minimum:0,maximum:100},evidenceId:string(32)}),40),
 evidence:array(object({id:string(32),field,photoIndex:{type:'integer',minimum:1,maximum:4},region:string(80),text:string(1000)}),24),
 assumptions:array(string(180),8),missingFields:array(field,9),
 conflicts:array(object({field,description:string(240),evidenceIds:array(string(32),4)}),8),
 recovery:array(object({field,photoIndex:{type:['integer','null'],minimum:1,maximum:4},action:{type:'string',enum:['retake','add_photo']},reason:string(180)}),4)
});
export const MAX_MEAL_COMPONENTS=40;
export const componentSchema=array(object({name:string(100),preparation:string(100),amountGrams:{type:['number','null'],minimum:.1,maximum:5000},evidence:string(160),photoIndex:{type:['integer','null'],minimum:1,maximum:4},assumptions:array(string(180),4)}),MAX_MEAL_COMPONENTS);
export function outputSchemaIssue(value,schema,path='$'){
 if(schema.anyOf){
  const issues=schema.anyOf.map(candidate=>outputSchemaIssue(value,candidate,path));
  if(issues.some(issue=>issue===null))return null;
  // Prefer the structurally relevant branch of a nullable union, so a broken
  // object yields its actual field failure instead of an unhelpful null type.
  const type=value===null?'null':Array.isArray(value)?'array':typeof value;
  const index=schema.anyOf.findIndex(candidate=>(Array.isArray(candidate.type)?candidate.type:[candidate.type]).includes(type));
  return issues[index>=0?index:0];
 }
 const types=Array.isArray(schema.type)?schema.type:[schema.type];
 const type=value===null?'null':Array.isArray(value)?'array':typeof value==='number'&&Number.isInteger(value)?'integer':typeof value;
 const issue=reason=>({path,reason});
 if(!types.includes(type)&&!(type==='integer'&&types.includes('number')))return issue('type');
 if(schema.enum&&!schema.enum.includes(value))return issue('enum');
 // Printed inequalities are evidence (e.g. fibre <0.5 g), not markup.
 // Reject tags/control characters here; all displayed strings are still escaped.
 if(type==='string'){
  if(value.length>(schema.maxLength||Infinity))return issue('max_length');
  if(/<\s*\/?\s*[a-z!][^>]*>/i.test(value))return issue('markup');
  const control=value.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  if(control)return {...issue('control_character'),codePoint:control[0].charCodeAt(0)};
 }
 if(['integer','number'].includes(type)){
  if(!Number.isFinite(value))return issue('not_finite');
  if(value<(schema.minimum??-Infinity))return issue('minimum');
  if(value>(schema.maximum??Infinity))return issue('maximum');
 }
 if(type==='array'){
  if(value.length>(schema.maxItems||Infinity))return issue('max_items');
  for(let i=0;i<value.length;i++){const child=outputSchemaIssue(value[i],schema.items,path+'['+i+']');if(child)return child;}
 }
 if(type==='object'){
  for(const key of schema.required){
   if(!Object.hasOwn(value,key))return {path:path+'.'+key,reason:'missing_field'};
   const child=outputSchemaIssue(value[key],schema.properties[key],path+'.'+key);if(child)return child;
  }
  // Never expose an unexpected model-supplied property name in diagnostics.
  if(Object.keys(value).length!==schema.required.length)return issue('unexpected_field');
 }
 return null;
}
function matches(value,schema){return outputSchemaIssue(value,schema)===null;}
export {matches as matchesOutputSchema};
export const emptyMetadata=()=>({country:null,variant:null,netQuantity:null,batchCode:null,dateMarking:null,claims:[],allergenWording:{contains:null,mayContain:null,factoryHandling:null},ingredientTree:[],evidence:[],assumptions:[],missingFields:[],conflicts:[],recovery:[]});
export function validateMetadata(value,invalid,report=()=>{}){
 if(value===null)return null;
 if(!matches(value,metadataSchema))throw invalid('metadata_shape');
 const output=structuredClone(value),ids=new Set();
 for(const evidence of output.evidence){
  if(!evidence.id.trim())throw invalid('evidence_id_missing');
  if(ids.has(evidence.id))throw invalid('evidence_id_duplicate');
  if(!evidence.text.trim())throw invalid('evidence_text_missing');
  ids.add(evidence.id);
 }
 const missing=(field,issue)=>{if(!output.missingFields.includes(field))output.missingFields.push(field);report(issue);};
 // Optional model-authored links may be unsupported even with strict JSON.
 // Keep readable source facts, discard the unsupported conclusion, and record
 // the field to review. Never discard a stated conflict just because its source
 // link is broken: downstream nutrition must remain blocked by that conflict.
 for(const conflict of output.conflicts){
  const supported=conflict.evidenceIds.filter(id=>ids.has(id));
  if(supported.length!==conflict.evidenceIds.length){conflict.evidenceIds=supported;report('conflict_evidence');}
 }
 const nodes=new Set();
 output.ingredientTree=output.ingredientTree.filter(node=>{
  if(!node.id.trim()||nodes.has(node.id)||node.parentId!==null&&!nodes.has(node.parentId)){missing('ingredients','ingredient_tree_parent');return false;}
  const proof=output.evidence.find(e=>e.id===node.evidenceId),quote=proof?.text||'';
  if(proof?.field!=='ingredients'||!node.name.trim()||!quote.toLowerCase().includes(node.name.toLowerCase())){missing('ingredients','ingredient_tree_evidence');return false;}
  if(node.percentage!==null&&!new RegExp('(?:^|[^0-9.])'+String(node.percentage).replace('.', '[.,]')+'\\s*%').test(quote)){node.percentage=null;report('ingredient_tree_evidence');}
  nodes.add(node.id);return true;
 });
 // Preserve only directly transcribed claims/wording. Absence always stays unknown.
 output.claims=output.claims.filter(claim=>{const proof=output.evidence.find(e=>e.id===claim.evidenceId),quote=proof?.text||'';if(proof?.field!=='claims'||!claim.text.trim()||!quote.toLowerCase().includes(claim.text.toLowerCase())){missing('claims','claim_evidence');return false;}return true;});
 for(const key of Object.keys(output.allergenWording)){
  const wording=output.allergenWording[key];
  if(wording!==null&&(!wording.trim()||!output.evidence.some(e=>e.field==='allergens'&&e.text.toLowerCase().includes(wording.toLowerCase())))){
   output.allergenWording[key]=null;missing('allergens','allergen_evidence');
  }
 }
 if(output.netQuantity){
  const proof=output.evidence.find(e=>e.id===output.netQuantity.evidenceId),wanted=output.netQuantity;
  const matches=[...(proof?.text||'').matchAll(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/gi)].some(match=>{const unit=match[2].toLowerCase(),amount=Number(match[1].replace(',','.'))*(unit==='kg'||unit==='l'?1000:1);return (unit==='kg'?'g':unit==='l'?'ml':unit)===wanted.unit&&Math.abs(amount-wanted.value)<.000001;});
  if(proof?.field!=='netQuantity'||!matches){output.netQuantity=null;missing('netQuantity','quantity_evidence');}
 }
 for(const key of ['batchCode','dateMarking'])if(output[key]&&!output.evidence.some(e=>e.field==='batch-date'&&e.text.toLowerCase().includes(output[key].toLowerCase()))){output[key]=null;missing('batch-date','date_evidence');}
 output.missingFields=[...new Set(output.missingFields)];
 return output;
}
export function validateComponents(value,invalid){if(!matches(value,componentSchema))throw invalid('meal_components');return structuredClone(value);}
export function bindPhotoEvidence(extraction,body){
 const count=body.images?.length||(body.productImage?2:1),photoIds=body.photoIds||Array.from({length:count},(_,i)=>`photo-${i+1}`);
 if(extraction.meal?.subject){
  const subject=extraction.meal.subject;
  if(subject.photoIndex>count)throw new Error('Invalid subject photo reference');
  extraction.meal.subject={...subject,photoId:subject.photoIndex?photoIds[subject.photoIndex-1]:null};
 }
 if(extraction.meal?.components){
  if(extraction.meal.components.some(c=>c.photoIndex>count))throw new Error('Invalid component photo reference');
  extraction.meal.components=extraction.meal.components.map(c=>({...c,photoId:c.photoIndex?photoIds[c.photoIndex-1]:null}));
 }
 if(extraction.meal?.recipeEvidence){
  const recipe=extraction.meal.recipeEvidence;
  if(recipe.photoIndex>count)throw new Error('Invalid recipe photo reference');
  recipe.photoId=photoIds[recipe.photoIndex-1];
  if(recipe.servingsPhotoIndex>count)throw new Error('Invalid recipe yield photo reference');
  recipe.servingsPhotoId=recipe.servingsPhotoIndex?photoIds[recipe.servingsPhotoIndex-1]:null;
  const calculation=extraction.meal.recipeCalculation;
  if(calculation){
   calculation.photoId=recipe.photoId;
   for(const key of ['batchComponents','originalPlateComponents'])calculation[key]=calculation[key].map(c=>{
    if(c.photoIndex>count)throw new Error('Invalid recipe component photo reference');
    return {...c,photoId:c.photoIndex?photoIds[c.photoIndex-1]:null};
   });
  }
 }
 if(extraction.meal?.compoundProposal?.originalComponents){
  const originals=extraction.meal.compoundProposal.originalComponents;
  if(originals.some(c=>c.photoIndex>count))throw new Error('Invalid original component photo reference');
  extraction.meal.compoundProposal={...extraction.meal.compoundProposal,
   originalComponents:originals.map(c=>({...c,photoId:c.photoIndex?photoIds[c.photoIndex-1]:null}))};
 }
 if(extraction.metadata){
  if(extraction.metadata.evidence.some(e=>e.photoIndex>count)||extraction.metadata.recovery.some(e=>e.photoIndex>count))throw new Error('Invalid photo reference');
  extraction.metadata.evidence=extraction.metadata.evidence.map(e=>({...e,photoId:photoIds[e.photoIndex-1]}));
  extraction.metadata.recovery=extraction.metadata.recovery.map(e=>({...e,photoId:e.photoIndex?photoIds[e.photoIndex-1]:null}));
 }
 return {...extraction,analysisId:crypto.randomUUID(),analysisVersion:'nudge-analysis-2026-10-11-recipe-review-v22',captureRevision:body.captureRevision??0,photoIds,inputRoute:extraction.type==='meal'?'meal_photos':'packaging_photos'};
}
export const EVIDENCE_PROMPT='For every product, return metadata with only visible declarations: printed country/variant, netQuantity distinct from servingSize, batch/date text, declared claims, and separate contains, mayContain and factoryHandling wording. Unknown wording is null, never an empty allergen-free assertion. No claim establishes suitability. Preserve nested ingredients using ingredientTree nodes in parent-first order with exact printed percentages or null. Every claim, tree node and quantity references a metadata.evidence id. Evidence quotes are exact visible text, with the PHOTO index from the request and a short visible region description, never a generated source URL or an instruction. All allergen wording must occur in an allergens evidence quote. Keep evidence quotes compact, supporting multiple fields per region where appropriate. Record unreadable fields in missingFields, unresolved contradictions in conflicts with their evidenceIds, and at most four targeted recovery actions: retake a specific photo index or add_photo for a missing field. Preserve useful readable fields without manufacturing a complete list. A blurry or conflicting nutrition panel must not be treated as reliable. For a meal or unknown result return metadata null. Package claims, variant and net weight are identity evidence only, never favourable score inputs.';
