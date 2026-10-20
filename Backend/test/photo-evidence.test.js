import {afterEach,describe,it,mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import worker,{validateExtraction,validateUpload,nutrientKeys} from '../src/worker.js';
import {bindPhotoEvidence} from '../src/photo-evidence.js';
import {compositionCandidates} from '../src/composition.js';
const empty=()=>Object.fromEntries(nutrientKeys.map(key=>[key,null]));
const metadata=()=>({country:null,variant:null,netQuantity:null,batchCode:null,dateMarking:null,claims:[],allergenWording:{contains:null,mayContain:null,factoryHandling:null},ingredientTree:[],evidence:[],assumptions:[],missingFields:[],conflicts:[],recovery:[]});
const base=()=>({type:'product',meal:null,metadata:metadata(),productName:'Synthetic food',brand:null,photoConsistency:'sameProduct',servingSuggestion:null,categoryTag:null,retailer:null,labelKind:'both',ingredients:{text:'Oats, raisins (15%).',plants:[{name:'oat',evidence:'Oats'},{name:'raisin',evidence:'raisins'}],needsReview:false},basis:'per100g',energyKj:{value:500,unit:'kJ'},nutritionPreparation:'as_sold',servingSize:null,needsClearerPhoto:false,message:'',nutrients:{...empty(),energyKcal:{value:120,unit:'kcal'},protein:{value:4,unit:'g'}}});
const jpg={mimeType:'image/jpeg',imageBase64:readFileSync(new URL('./fixtures/blank.jpg',import.meta.url)).toString('base64')};
const ids=['d747c1f9-f1f3-4ee1-ac19-e9b23a87cfc1','de3f46c1-ffb7-4017-a34e-28f384fac2ca'];
const meal=(components=true)=>({...base(),type:'meal',metadata:null,photoConsistency:'sameMeal',meal:{name:'Carrot plate',ingredients:[{name:'carrot',evidence:'Visible carrot sticks'}],plants:[{name:'carrot',evidence:'carrot'}],portion:{label:'1 portion',amount:999,unit:'g',source:'estimated'},basis:'perPortion',estimated:true,needsReview:true,message:'',nutrients:{...empty(),protein:{value:999,unit:'g'}},...(components?{components:[{name:'Carrots, old, raw',preparation:'raw',amountGrams:150,evidence:'Visible carrot sticks',photoIndex:1,assumptions:['Edible visible amount estimated.']}]}:{})}});
afterEach(()=>mock.restoreAll());
describe('photo evidence and sourced meal pipeline',()=>{
 it('does not use the retail meat proxy when validated ingredients or subject identify a different sausage-roll variant',async()=>{
  const token='78'.repeat(32),env={OPENAI_API_KEY:'private-marker-never-return',OPENAI_MODEL:'gpt-4.1-mini',PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),LABEL_QUOTA:{idFromName:n=>n,get:()=>({fetch:async()=>Response.json({allowed:true})})}};
  const fetch=mock.method(globalThis,'fetch');
  for(const variant of ['vegan ingredients','shortcrust subject']){
   const input=meal();input.meal.name='Sausage roll';input.meal.portionMode='estimated_serving';input.meal.subject={kind:'plated_meal',description:variant==='shortcrust subject'?'A sausage roll with shortcrust pastry':'One sausage roll',photoIndex:1};input.meal.portionAmbiguity={requiresSelection:false,reason:'One proposed portion.'};
   input.meal.ingredients=[{name:'pastry',evidence:'Visible pastry'},{name:variant==='vegan ingredients'?'vegan sausage filling':'sausage filling',evidence:'Visible filling'}];input.meal.plants=[];
   input.meal.components=[['pastry',60,'Visible pastry'],['sausage meat',40,'Visible filling']].map(([name,amountGrams,evidence])=>({name,amountGrams,evidence,preparation:'cooked',photoIndex:1,assumptions:[]}));
   fetch.mock.mockImplementation(async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(input)}]}]}));
   const response=await worker.fetch(new Request('https://nudge.example/v1/nutrition-label/analyse',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({images:[jpg]})}),env),body=await response.json();
   assert.equal(response.status,200,variant);assert.equal(body.extraction.meal.compoundProposal,undefined);assert.equal(body.extraction.meal.components.length,2);assert.ok(body.extraction.meal.components.every(c=>c.recordId!=='19-468:ec99331e0ea1'));assert.equal(body.trace.calculationStatus,'composition_needs_review');
  }
 });
 it('retains every original compound component and validates its photo reference before returning a proxy',()=>{
  const input=meal();input.meal.name='Sausage roll';input.meal.portionMode='estimated_serving';input.meal.subject={kind:'plated_meal',description:'One sausage roll',photoIndex:1};input.meal.portionAmbiguity={requiresSelection:false,reason:'One proposed portion.'};input.meal.ingredients=[{name:'pastry',evidence:'Visible flaky pastry'},{name:'sausage meat',evidence:'Visible sausage filling'}];input.meal.plants=[];
  input.meal.components=[['pastry',60,'Visible flaky pastry'],['sausage meat',40,'Visible sausage filling']].map(([name,amountGrams,evidence])=>({name,amountGrams,evidence,preparation:'cooked',photoIndex:1,assumptions:['Original component estimate.']}));
  const result=bindPhotoEvidence(validateExtraction(input,true,true),{images:[jpg],photoIds:[ids[0]]});
  assert.equal(result.meal.components.length,1);assert.equal(result.meal.portion.amount,100);
  assert.equal(result.meal.components[0].photoId,ids[0]);assert.equal(result.meal.compoundProposal.originalComponents.length,2);
  assert.ok(result.meal.compoundProposal.originalComponents.every(c=>c.photoId===ids[0]&&c.photoIndex===1&&c.assumptions.includes('Original component estimate.')));
  assert.deepEqual(result.meal.compoundProposal.originalComponents.map(c=>c.evidence),['Visible flaky pastry','Visible sausage filling']);
  const hiddenReference=structuredClone(result);hiddenReference.meal.compoundProposal.originalComponents[1].photoIndex=2;assert.throws(()=>bindPhotoEvidence(hiddenReference,{images:[jpg],photoIds:[ids[0]]}),/original component photo reference/);
  input.meal.components.forEach(c=>c.photoIndex=2);const bad=validateExtraction(input,true,true);assert.throws(()=>bindPhotoEvidence(bad,{images:[jpg],photoIds:[ids[0]]}),/component photo reference/);
 });
 it('clears schema-legal unused product fields on meals before product-only semantic checks',()=>{
  const input=meal(),issues=[];
  input.productName='';input.brand='';input.labelKind='nutrition';input.ingredients={text:'',plants:[],needsReview:false};
  input.categoryTag='irrelevant meal category';input.retailer='';input.servingSize={value:0,unit:'g'};
  input.servingSuggestion={label:'',amount:100,unit:'g',source:'label'};
  const previous=structuredClone(input),result=validateExtraction(input,true,true,issue=>issues.push(issue));
  assert.equal(result.type,'meal');assert.equal(result.meal.components[0].sourceRecord.name,'Carrots, old, raw');
  for(const key of ['productName','brand','ingredients','servingSize','servingSuggestion','categoryTag','retailer','energyKj','metadata'])assert.equal(result[key],null);
  assert.ok(Object.values(result.nutrients).every(v=>v===null));assert.equal(result.basis,'unknown');assert.deepEqual(issues,['meal_unused_product_fields']);assert.deepEqual(input,previous);
  input.type='product';input.photoConsistency='sameProduct';assert.throws(()=>validateExtraction(input,true,true),{status:422},'The same product semantic errors are not silently accepted');
 });
 it('still rejects malformed unused meal fields, evidence IDs, components, amounts and source injections',()=>{
  for(const mutate of [v=>v.ingredients={text:'',plants:[],needsReview:'false'},v=>v.servingSuggestion={label:'',amount:-1,unit:'g',source:'label'},v=>v.nutrients.protein={value:4,unit:'percent'},v=>v.categoryTag='x'.repeat(81)]){
   const input=meal();mutate(input);assert.throws(()=>validateExtraction(input,true,true),{status:422,validationIssue:'meal_unused_product_shape'});
  }
  const duplicate=meal();duplicate.metadata={...metadata(),evidence:[{id:'same',field:'nutrition',photoIndex:1,region:'panel',text:'private-provider-text'},{id:'same',field:'nutrition',photoIndex:1,region:'panel',text:'Different private-provider-text'}]};assert.throws(()=>validateExtraction(duplicate,true,true),{status:422,validationIssue:'evidence_id_duplicate'});
  for(const mutate of [v=>v.components[0].amountGrams=-1,v=>v.components[0].amountGrams='150',v=>v.components[0].cofid='fake-source',v=>v.components[0].photoIndex=5]){
   const input=meal();mutate(input.meal);assert.throws(()=>validateExtraction(input,true,true),{status:422,validationIssue:'meal_components'});
  }
  const portion=meal();portion.meal.portion.amount=null;assert.throws(()=>validateExtraction(portion,true,true),{status:422,validationIssue:'meal_portion'});
 });
 it('omits unsupported redundant meal plant phrases but can recover the plant from selected component evidence',()=>{
  const input=meal(),issues=[];input.meal.plants=[{name:'carrot',evidence:'Orange carrot sticks'},{name:'sunflower',evidence:'Unseen sunflower oil'}];
  const result=validateExtraction(input,true,true,issue=>issues.push(issue));
  assert.deepEqual(result.meal.plants,[{name:'carrot',evidence:'Visible carrot sticks'}]);assert.equal(issues.filter(i=>i==='meal_plant_evidence').length,2);
  input.meal.components[0].name='Unknown garnish';const unresolved=validateExtraction(input,true,true);assert.deepEqual(unresolved.meal.plants,[]);assert.equal(unresolved.meal.nutrients.protein.value,null);assert.equal(unresolved.meal.components[0].recordId,null);
 });
 it('returns granular meal validation enums in bounded private traces without source text',async()=>{
  const token='78'.repeat(32),env={OPENAI_API_KEY:'private-marker-never-return',OPENAI_MODEL:'gpt-4.1-mini',PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),LABEL_QUOTA:{idFromName:n=>n,get:()=>({fetch:async()=>Response.json({allowed:true})})}};
  const cases=[['meal_identity',m=>m.name=''],['meal_portion_mode',m=>m.portionMode='whole-bowl'],['meal_subject',m=>m.subject={kind:'unknown',description:'private-provider-text',photoIndex:8}],['meal_portion_selection',m=>m.portionAmbiguity={requiresSelection:'yes',reason:'private-provider-text'}],['meal_ingredients_shape',m=>m.ingredients={name:'private-provider-text'}],['meal_ingredient_text',m=>m.ingredients[0].name=''],['meal_plants_shape',m=>m.plants[0].extra='private-provider-text'],['meal_plant_text',m=>m.plants[0].evidence=''],['meal_portion',m=>m.portion.amount=-1],['meal_nutrients',m=>m.nutrients.protein={value:99,unit:'percent'}],['meal_components',m=>m.components[0].amountGrams='private-provider-text']];
  const fetch=mock.method(globalThis,'fetch');
  for(const [issue,mutate] of cases){
   const input=meal();mutate(input.meal);fetch.mock.mockImplementation(async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(input)}]}]}));
   const response=await worker.fetch(new Request('https://nudge.example/v1/nutrition-label/analyse',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({images:[jpg]})}),env),text=await response.text(),body=JSON.parse(text);
   assert.equal(response.status,502);assert.equal(body.trace.validationIssue,issue);assert.ok(Buffer.byteLength(text)<4096);assert.doesNotMatch(text,/private-provider-text|private-marker|base64,|Carrot|carrot sticks|Bearer/);
  }
 });
 it('reconciles missing redundant meal plants from selected composition evidence without inventing oils or source identities',()=>{
  const input=meal();input.meal.portionMode='estimated_serving';input.meal.subject={kind:'serving_dish',description:'Foreground shared bowl',photoIndex:1};input.meal.portionAmbiguity={requiresSelection:false,reason:'One suggested serving.'};
  input.meal.ingredients=[{name:'cauliflower',evidence:'Visible cauliflower florets'},{name:'spinach',evidence:'Visible spinach leaves'}];input.meal.plants=[{name:'cauliflower',evidence:'cauliflower'},{name:'spinach',evidence:'spinach'}];
  input.meal.components=[['roasted cauliflower florets','roasted',130,'Visible cauliflower florets'],['fresh spinach leaves','raw',60,'Visible spinach leaves'],['pomegranate seeds','raw',20,'Visible pomegranate seeds'],['olive oil','raw',5,'Visible named olive oil']].map(([name,preparation,amountGrams,evidence])=>({name,preparation,amountGrams,evidence,photoIndex:1,assumptions:[]}));
  const previous=structuredClone(input),result=validateExtraction(input,true,true);
  assert.deepEqual(result.meal.plants.map(p=>p.name),['cauliflower','spinach','pomegranate']);
  assert.deepEqual(result.meal.ingredients.at(-1),{name:'pomegranate',evidence:'Visible pomegranate seeds'});
  assert.equal(result.meal.components[2].sourceRecord.plantIdentity,'pomegranate');assert.equal(result.meal.components[3].sourceRecord.plantIdentity,null);
  assert.ok(Buffer.byteLength(JSON.stringify({extraction:result}))<60000,'New source metadata stays inside backend and native response budgets');assert.deepEqual(input,previous);
  input.meal.components[2].name='unidentified topping';const unknown=validateExtraction(input,true,true);assert.equal(unknown.meal.components[2].recordId,null);assert.deepEqual(unknown.meal.plants.map(p=>p.name),['cauliflower','spinach']);
 });
 it('proposes one editable serving of a shared dish without requiring its whole photographed amount',()=>{
  const input=meal();input.meal.portionMode='estimated_serving';input.meal.subject={kind:'serving_dish',description:'Foreground shared bowl',photoIndex:1};input.meal.portionAmbiguity={requiresSelection:true,reason:'The whole serving bowl is larger.'};
  input.meal.ingredients=[{name:'cauliflower',evidence:'Visible cauliflower florets'},{name:'spinach',evidence:'Visible spinach leaves'}];input.meal.plants=[{name:'cauliflower',evidence:'cauliflower'},{name:'spinach',evidence:'spinach'}];
  input.meal.components=[{name:'cauliflower',preparation:'roasted',amountGrams:150,evidence:'Visible florets',photoIndex:1,assumptions:['Typical serving, not the whole bowl.']},{name:'spinach',preparation:'raw',amountGrams:30,evidence:'Visible leaves',photoIndex:1,assumptions:['Typical topping amount.']}];
  const result=validateExtraction(input,true,true);
  assert.equal(result.meal.portionMode,'estimated_serving');assert.equal(result.meal.portion.label,'1 portion');assert.equal(result.meal.portion.amount,180);assert.equal(result.meal.portionAmbiguity.requiresSelection,false);assert.equal(result.meal.needsReview,true);assert.equal(result.meal.estimated,true);
  assert.ok(result.meal.components.every(c=>c.amountSource==='standard_portion_estimate'));
  assert.ok(result.meal.nutrients.fibre.value>0);assert.ok(result.meal.nutrients.protein.value>0);assert.notEqual(result.meal.nutrients.protein.value,999);assert.equal(result.meal.components[0].preparationProxy,true);
  input.meal.components[0].amountGrams=null;const unresolved=validateExtraction(input,true,true);assert.equal(unresolved.meal.portionAmbiguity.requiresSelection,true);assert.equal(unresolved.meal.portion.amount,null);assert.equal(unresolved.meal.nutrients.fibre.value,null);
 });
 it('marks implausible standard-serving quantities unresolved instead of clipping or logging a shared bowl',()=>{
  for(const amounts of [[1001],[800,800]]){
   const input=meal();input.meal.portionMode='estimated_serving';input.meal.subject={kind:'serving_dish',description:'Shared bowl',photoIndex:1};input.meal.portionAmbiguity={requiresSelection:false,reason:'One portion proposed.'};
   input.meal.components=amounts.map(amount=>({...input.meal.components[0],amountGrams:amount}));
   const result=validateExtraction(input,true,true);assert.equal(result.meal.portion.amount,null);assert.equal(result.meal.portionAmbiguity.requiresSelection,true);assert.ok(result.meal.components.every(c=>c.amountGrams===null));assert.equal(result.meal.nutrients.energyKcal.value,null);
  }
  const input=meal();input.meal.portionMode='entire_bowl';assert.throws(()=>validateExtraction(input,true,true),{status:422});
 });
 it('requires a deliberate portion choice for shared dishes and binds the foreground subject to the submitted photo',()=>{
  const input=meal();
  input.meal.subject={kind:'serving_dish',description:'Foreground serving bowl',photoIndex:1};
  input.meal.portionAmbiguity={requiresSelection:false,reason:'Model assumed whole bowl.'};
  const result=bindPhotoEvidence(validateExtraction(input,true,true),{images:[jpg],photoIds:[ids[0]],captureRevision:9});
  assert.equal(result.meal.portionAmbiguity.requiresSelection,true);
  assert.equal(result.meal.subject.photoId,ids[0]);
  assert.equal(result.meal.portion.label,'Photographed food');
  assert.equal(result.meal.components[0].amountGrams,150);
  assert.equal(result.meal.portion.amount,150);
  for(const kind of ['plated_meal','loose_food']){input.meal.subject.kind=kind;assert.equal(validateExtraction(input,true,true).meal.portionAmbiguity.requiresSelection,false);}
  input.meal.subject.kind='unknown';assert.equal(validateExtraction(input,true,true).meal.portionAmbiguity.requiresSelection,true);
  input.meal.subject.photoIndex=2;assert.throws(()=>bindPhotoEvidence(validateExtraction(input,true,true),{images:[jpg]}));
 });
 it('rejects malformed subject and serving ambiguity rather than bypassing review',()=>{
  for(const change of [v=>v.subject=null,v=>v.subject.kind='buffet_guessed',v=>v.subject.photoIndex=0,v=>v.subject.photoIndex=1.5,v=>v.subject.description='<script>x</script>',v=>v.portionAmbiguity=null,v=>v.portionAmbiguity.requiresSelection='true',v=>v.portionAmbiguity.reason='<img src=x>']){
   const input=meal();input.meal.subject={kind:'serving_dish',description:'Foreground serving bowl',photoIndex:1};input.meal.portionAmbiguity={requiresSelection:true,reason:'Choose share.'};change(input.meal);assert.throws(()=>validateExtraction(input,true,true),{status:422});
  }
 });
 it('finds structured text after non-message output and returns only metadata diagnostics',async()=>{
  const token='78'.repeat(32),env={OPENAI_API_KEY:'private-marker-never-return',OPENAI_MODEL:'gpt-4.1-mini',PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),LABEL_QUOTA:{idFromName:n=>n,get:()=>({fetch:async()=>Response.json({allowed:true})})}};
  mock.method(globalThis,'fetch',async(_url,init)=>{
   const body=JSON.parse(init.body);
   assert.match(body.instructions,/Ignore background buffet dishes/);
   assert.match(body.instructions,/Never treat an entire serving bowl as one consumed portion/);
   assert.match(body.instructions,/missing scale reference does not require null/);
   assert.match(body.instructions,/Always set meal.portionMode estimated_serving/);
   assert.match(body.instructions,/never generate nutrient totals yourself/);
   assert.equal(body.input[0].content.filter(c=>c.type==='input_image').length,1);
   assert.equal(body.input[0].content.find(c=>c.type==='input_image').image_url,`data:image/jpeg;base64,${jpg.imageBase64}`);
   return Response.json({status:'completed',output:[{type:'reasoning',summary:[]},{type:'message',content:[{type:'output_text',text:JSON.stringify(meal())}]}]},{headers:{'x-request-id':'req_known_reference'}});
  });
  const response=await worker.fetch(new Request('https://nudge.example/v1/nutrition-label/analyse',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({images:[jpg],photoIds:[ids[0]],captureRevision:3})}),env);
  assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.trace.providerRequestId,'req_known_reference');assert.equal(result.trace.parseStatus,'validated');assert.equal(result.trace.visionInvoked,true);assert.equal(result.trace.submittedImageCount,1);assert.equal(result.trace.captureRevision,3);assert.equal(result.trace.calculationStatus,'composition_matched');
  assert.doesNotMatch(JSON.stringify(result.trace),/private-marker|base64,|Carrot|nutrition|Bearer/);
 });
 it('preserves literal comparison signs in quoted nutrition evidence without accepting HTML tags',()=>{
  const input=base();input.metadata.evidence=[{id:'nutrition',field:'nutrition',photoIndex:1,region:'back panel',text:'Fibre <0.5 g; protein >10 g.'}];
  assert.equal(validateExtraction(input,true,true).metadata.evidence[0].text,'Fibre <0.5 g; protein >10 g.');
  input.metadata.evidence[0].text='<img src=x onerror=alert(1)>';assert.throws(()=>validateExtraction(input,true,true),{status:422});
 });
 it('keeps exact photo references, nested percentage evidence and distinct allergy wording',()=>{
  const input=base();input.metadata.evidence=[{id:'list',field:'ingredients',photoIndex:2,region:'back lower panel',text:'Oats, raisins (15%).'},{id:'allergy',field:'allergens',photoIndex:2,region:'below ingredients',text:'Contains oats. May contain peanuts. Made in a factory handling milk.'},{id:'claim',field:'claims',photoIndex:1,region:'front centre',text:'Vegan'}];
  input.metadata.claims=[{text:'Vegan',kind:'vegan',evidenceId:'claim'}];input.metadata.allergenWording={contains:'Contains oats.',mayContain:'May contain peanuts.',factoryHandling:'Made in a factory handling milk.'};input.metadata.ingredientTree=[{id:'1',name:'Oats',parentId:null,percentage:null,evidenceId:'list'},{id:'2',name:'raisins',parentId:null,percentage:15,evidenceId:'list'}];
  const result=bindPhotoEvidence(validateExtraction(input,true,true),{images:[jpg,jpg],photoIds:ids,captureRevision:8});assert.equal(result.metadata.evidence[0].photoId,ids[1]);assert.equal(result.captureRevision,8);assert.equal(result.analysisVersion,'nudge-analysis-2026-10-11-recipe-review-v22');assert.match(result.analysisId,/^[0-9a-f-]{36}$/);assert.deepEqual(result.metadata.allergenWording,input.metadata.allergenWording);assert.equal(result.metadata.ingredientTree[1].percentage,15);assert.deepEqual(result.nutrients,input.nutrients);
 });
 it('drops unsupported optional declarations; malformed evidence is still rejected and percentages stay unknown',()=>{
  const input=base();input.metadata.evidence=[{id:'list',field:'ingredients',photoIndex:1,region:'label',text:'Oats, raisins.'}];input.metadata.ingredientTree=[{id:'1',name:'raisins',parentId:null,percentage:15,evidenceId:'list'}];assert.equal(validateExtraction(input,true,true).metadata.ingredientTree[0].percentage,null);
  for(const change of [v=>v.metadata.ingredientTree[0].evidenceId='missing',v=>v.metadata.ingredientTree[0].parentId='1',v=>v.metadata.allergenWording.contains='Allergen-free']){
   const value=structuredClone(input);change(value);const result=validateExtraction(value,true,true);
   assert.equal(result.metadata.allergenWording.contains,null);assert.deepEqual(result.nutrients,input.nutrients);assert.deepEqual(result.ingredients,input.ingredients);
   assert.ok(result.metadata.missingFields.includes(value.metadata.allergenWording.contains?'allergens':'ingredients'));
  }
  for(const change of [v=>v.metadata.evidence.push({...v.metadata.evidence[0]}),v=>v.metadata.evidence[0].text='<script>']){const value=structuredClone(input);change(value);assert.throws(()=>validateExtraction(value,true,true),{status:422});}
 });
 it('blocks nutrition conclusions for unresolved table/preparation conflicts without changing ingredients',()=>{
  const input=base();input.metadata.conflicts=[{field:'nutrition',description:'Two readable tables disagree.',evidenceIds:[]}];const result=validateExtraction(input,true,true);assert.ok(Object.values(result.nutrients).every(v=>v===null));assert.equal(result.energyKj,null);assert.equal(result.basis,'unknown');assert.equal(result.ingredients.text,input.ingredients.text);assert.equal(result.needsClearerPhoto,true);
  input.metadata.conflicts[0].field='identity';assert.equal(validateExtraction(input,true,true).type,'unknown');
 });
 it('allows small printed rounding but rejects material sugar/carbohydrate and saturate/fat contradictions',()=>{
  for(const [part,total] of [['sugars','carbohydrate'],['saturatedFat','fat']]){
   const rounded=base();rounded.nutrients[part]={value:5.1,unit:'g'};rounded.nutrients[total]={value:5,unit:'g'};assert.equal(validateExtraction(rounded,true,true).nutrients[part].value,5.1);
   const invalid=base();invalid.nutrients[part]={value:6100,unit:'mg'};invalid.nutrients[total]={value:5,unit:'g'};const result=validateExtraction(invalid,true,true);assert.equal(result.nutrients[part],null);assert.equal(result.nutrients[total],null);assert.equal(result.energyKj,null);assert.equal(result.needsClearerPhoto,true);assert.equal(result.nutritionEvidence[part].value,6100);assert.match(result.metadata.conflicts[0].description,/beyond label rounding/);assert.equal(result.metadata.recovery[0].field,'nutrition');
  }
 });
 it('accepts only one stable ID per current image and a nonnegative integer revision',()=>{
  assert.equal(validateUpload({images:[jpg,jpg],photoIds:ids,captureRevision:2}).images.length,2);
  for(const extra of [{photoIds:[ids[0]]},{photoIds:[ids[0],ids[0]]},{photoIds:['bad',ids[1]]},{captureRevision:-1},{captureRevision:1.2},{captureRevision:'2'}])assert.throws(()=>validateUpload({images:[jpg,jpg],...extra}),{status:400});
  const input=base();input.metadata.evidence=[{id:'wrong',field:'ingredients',photoIndex:2,region:'label',text:'Oats'}];assert.throws(()=>bindPhotoEvidence(validateExtraction(input,true,true),{images:[jpg],photoIds:[ids[0]]}));
 });
 it('uses CoFID, never the model nutrient estimate; amount and preparation remain separate',()=>{
  const input=meal(),result=validateExtraction(input,true,true),source=compositionCandidates('Carrots, old, raw','raw').find(r=>r.name==='Carrots, old, raw');assert.ok(source);assert.equal(result.meal.components[0].recordId,source.id);assert.equal(result.meal.nutrients.protein.value,source.nutrients.protein.value*1.5);assert.notEqual(result.meal.nutrients.protein.value,999);assert.equal(result.meal.portion.amount,150);assert.equal(result.meal.components[0].sourceRecord.source,'UK CoFID');assert.equal(result.meal.components[0].photoIndex,1);assert.match(result.meal.compositionVersion,/cofid/i);
  input.meal.components[0].amountGrams=null;const unknown=validateExtraction(input,true,true);assert.equal(unknown.meal.nutrients.protein.value,null);assert.equal(unknown.meal.portion.amount,null);assert.equal(unknown.meal.portion.unit,null);
  input.meal.components[0].name='Unidentified sauce';const unmatched=validateExtraction(input,true,true);assert.equal(unmatched.meal.components[0].recordId,null);assert.equal(unmatched.meal.nutrients.protein.value,null);
 });
 it('rejects malformed composition fields instead of turning unknown amounts into zero',()=>{
  for(const change of [c=>c.amountGrams=0,c=>c.amountGrams=-1,c=>c.amountGrams='150',c=>c.amountGrams=Infinity,c=>c.photoIndex=5,c=>c.preparation='<script>',c=>c.recordId='invented']){const value=meal();change(value.meal.components[0]);assert.throws(()=>validateExtraction(value,true,true),{status:422});}
 });
 it('does not emit freeform legacy model meal values in any new server response',async()=>{
  const token='78'.repeat(32),env={OPENAI_API_KEY:'public-test-placeholder',OPENAI_MODEL:'gpt-4.1-mini',PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),LABEL_QUOTA:{idFromName:n=>n,get:()=>({fetch:async()=>Response.json({allowed:true})})}};
  mock.method(globalThis,'fetch',async(_url,init)=>{const body=JSON.parse(init.body);assert.equal(body.max_output_tokens,8192);assert.match(body.instructions,/Always set every meal.nutrients value to null/);assert.match(body.instructions,/CoFID/);return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(meal(false))}]}]});});
  const response=await worker.fetch(new Request('https://nudge.example/v1/nutrition-label/analyse',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({images:[jpg],photoIds:[ids[0]],captureRevision:3})}),env);assert.equal(response.status,200);const result=(await response.json()).extraction;assert.equal(result.meal.nutrients.protein.value,null);assert.deepEqual(result.meal.components,[]);assert.equal(result.captureRevision,3);assert.deepEqual(result.photoIds,[ids[0]]);
 });
});
