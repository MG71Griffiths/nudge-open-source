import { Composition } from './nutrition-core.js';
import dataset from '../data/cofid-2021.json' with {type:'json'};
import usda from '../data/usda-meal-fallbacks.json' with {type:'json'};
import { MAX_MEAL_COMPONENTS } from './photo-evidence.js';
const calc=Composition;
export const compositionVersion=`${dataset.version}+${usda.version}+meal-matches-v6`;
const normal=s=>String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const presentationName=s=>normal(s).replace(/\s+side(?: dish)?$/,'').replace(/^(mashed potato(?:es)?) topping$/,'$1');
const stop=new Set(['and','with','without','the','of','a','in','only','food','cooked']);
const tokens=s=>normal(s).split(' ').filter(t=>t.length>1&&!stop.has(t));
const sameWord=(a,b)=>{const singular=w=>({potatoes:'potato',tomatoes:'tomato'}[w]||w);a=singular(a);b=singular(b);return a===b||a===b+'s'||a+'s'===b;};
const prepWords=['raw','boiled','grilled','fried','roasted','baked','steamed','poached','canned','dried'];
// Only reviewed whole-food records get fruit/vegetable/legume score eligibility.
// Source descriptions and model-authored names must never classify an arbitrary recipe.
const fvlCodes=new Set(['13-512','13-513','13-502','13-503','13-504','13-521','13-550','13-572','13-573','13-496','13-497','13-352','13-523','13-662','13-661','14-226']);
const otherCodes=new Set(['11-862','11-869','11-1129','11-723','18-323','16-356','16-359','16-357','16-358','16-375','16-492','17-038']);
const foodGroup=r=>r.id.startsWith('usda:')?({'168409':'vegetable','168462':'vegetable','168463':'vegetable','169134':'fruit','168910':'grain','168928':'grain','169704':'grain','169757':'grain','170005':'vegetable','170108':'vegetable','170427':'vegetable','171413':'fat_oil','172421':'legume','172475':'legume','172476':'legume','173757':'legume','175168':'fish'}[r.code]||'unknown'):
 calc.compoundRecord(r.id)?'mixed_dish':r.code==='14-226'?'fruit':['13-662','13-661'].includes(r.code)?'legume':fvlCodes.has(r.code)?'vegetable':r.code.startsWith('11-')&&otherCodes.has(r.code)?'grain':r.code==='18-323'?'poultry':r.code.startsWith('16-')&&otherCodes.has(r.code)?'fish':r.code==='17-038'?'fat_oil':'unknown';
function publicRecord(r){
 if(r.id.startsWith('usda:'))return {id:r.id,code:r.code,name:r.name,description:usda.basis,sourceReference:`USDA SR Legacy; NDB ${r.ndbCode}`,nutrients:calc.nutrients(r),source:'USDA SR Legacy',sourceVersion:usda.version,sourceURL:`https://fdc.nal.usda.gov/food-details/${r.code}/nutrients`,licenceURL:usda.licenceURL,basis:'per100g',valueStatus:'composition_estimate',fvlEligible:r.fvlEligible,foodGroup:foodGroup(r),plantIdentity:calc.plantIdentity(r.id),carbohydrateDefinition:'by_difference_including_fibre'};
 return {id:r.id,code:r.code,name:r.name,description:r.description,sourceReference:r.reference,nutrients:calc.nutrients(r),source:'UK CoFID',sourceVersion:dataset.version,sourceURL:dataset.sourceURL,licenceURL:dataset.licenceURL,basis:'per100g',valueStatus:'composition_estimate',fvlEligible:fvlCodes.has(r.code)?true:otherCodes.has(r.code)?false:null,foodGroup:foodGroup(r),plantIdentity:calc.plantIdentity(r.id),carbohydrateDefinition:'available'};
}
export function compositionRecord(id){const r=[...dataset.foods,...usda.foods].find(r=>r.id===id);return r?publicRecord(r):null;}
// Normalise new analyses from their selected component evidence. Existing
// confirmed diary snapshots are never passed through this backend function.
export function reconcileMealPlants(components,ingredients=[],plants=[]){
 const resultIngredients=ingredients.map(item=>({...item})),resultPlants=[],seen=new Set();
 for(const item of plants){const name=calc.canonicalPlantName(item.name);if(!name||seen.has(name)||calc.plantIsOilOnly(item,ingredients))continue;seen.add(name);resultPlants.push({...item,name});}
 for(const plant of [...calc.componentPlants(components),...calc.namedComponentPlants(components)]){
  if(seen.has(plant.name)||resultPlants.length>=40)continue;
  const matching=resultIngredients.find(item=>calc.canonicalPlantName(item.name)===plant.name);
  // Keep a matching visible food name, with the selected component's evidence.
  // A missing redundant ingredients row is filled from explicit source identity.
  if(matching)matching.evidence=plant.evidence;
  else if(resultIngredients.length<40)resultIngredients.push({name:plant.name,evidence:plant.evidence});
  else continue;
  resultPlants.push({name:plant.name,evidence:plant.evidence});seen.add(plant.name);
 }
 return {ingredients:resultIngredients,plants:resultPlants};
}
const byCode=code=>code.startsWith('usda:')?compositionRecord(code):publicRecord(dataset.foods.find(r=>r.code===code));
export function compositionCandidates(name,preparation){
 const identity=presentationName(name),wanted=tokens(identity),prep=normal(preparation),givenPrep=prepWords.filter(p=>prep.split(' ').includes(p));
 if(!wanted.length)return [];
 if(/\b(filling|topping|base)\b/.test(identity))return [];
 // A component mentioned inside a recipe is not the recipe itself.
 return dataset.foods.map(r=>({r,t:normal(r.name)})).filter(({r,t})=>
 tokens(r.name.split(',')[0]).every(w=>wanted.some(v=>sameWord(v,w)))&&
 wanted.every(w=>t.split(' ').some(v=>sameWord(v,w)))&&(!givenPrep.length||givenPrep.some(p=>t.split(' ').includes(p))||/\bmashed\b/.test(identity)&&/\bmashed\b/.test(t)&&givenPrep.some(p=>p!=='raw'&&p!=='dried')))
 .sort((a,b)=>a.t.length-b.t.length||a.r.id.localeCompare(b.r.id)).slice(0,12).map(({r})=>publicRecord(r));
}
// These aliases select an editable generic-food proxy, not a claim about cultivar,
// added salt or cooking fat. Keep narrow complete names; substring matches would
// silently turn cauliflower cheese, battered chicken or mixed sauce into plain food.
const profiles=[
 {names:['cauliflower','cauliflower florets'],raw:'13-512',cooked:'13-513'},
 {names:['spinach','spinach leaves','baby spinach','baby spinach leaves'],raw:'usda:168462',cooked:'usda:168463'},
 {names:['pomegranate','pomegranates','pomegranate seeds','pomegranate arils','pomegranate flesh and pips'],raw:'usda:169134'},
 {names:['broccoli','broccoli florets','broccolini','tenderstem broccoli'],raw:'13-502',cooked:'13-503',steamed:'13-504'},
 {names:['cucumber','cucumber slices'],raw:'usda:168409'},
 {names:['red pepper','red peppers','red bell pepper','red bell peppers','red sweet pointed pepper','sweet red pepper','red capsicum'],raw:'usda:170108'},
 {names:['green pepper','green bell pepper','green capsicum'],raw:'usda:170427'},
 {names:['spring onion','spring onions','scallion','scallions'],raw:'usda:170005'},
 {names:['carrot','carrots','carrot sticks'],raw:'13-496',cooked:'13-497'},
 {names:['white rice','rice'],cooked:'usda:169757'},
 {names:['brown rice','wholegrain rice','whole grain rice'],cooked:'usda:169704'},
 {names:['pasta','white pasta','plain pasta','spaghetti','fusilli','penne'],cooked:'usda:168928'},
 {names:['wholewheat pasta','whole wheat pasta','wholewheat spaghetti'],cooked:'usda:168910'},
 {names:['chickpea','chickpeas','chick peas','garbanzo beans'],cooked:'usda:173757'},
 {names:['lentils','green lentils','brown lentils'],cooked:'usda:172421'},
 {names:['chicken breast','skinless chicken breast','skinless boneless chicken breast'],grilled:'18-323',cooked:'18-323'},
 {names:['salmon','salmon fillet'],raw:'16-356',cooked:'usda:175168'},
 {names:['tofu','regular tofu'],raw:'usda:172476'},
 {names:['firm tofu'],raw:'usda:172475'},
 {names:['olive oil','extra virgin olive oil'],raw:'usda:171413'}
];
function proposedMatch(name,preparation,evidence=''){
 const words=normal(`${name} ${preparation}`),plain=presentationName(name).replace(/\b(raw|fresh|cooked|boiled|steamed|roasted|baked|grilled|fried)\b/g,'').replace(/\s+/g,' ').trim();
 // Recipe input weights need an explicitly raw source. The generic USDA
 // smoked-haddock row does not state raw/cooked preparation.
 if(plain==='smoked haddock'&&/\braw\b/.test(words)&&!(/\b(cooked|boiled|steamed|roasted|baked|grilled|fried|sauteed|poached|battered|breaded|sauce|sauced|dried|canned)\b/).test(words)){
  const record=byCode('16-492');return {record,preparationProxy:false,excludedPreparation:null,assumptions:['Generic raw smoked haddock edible flesh; brand and smoking/salting levels may differ.']};
 }
 if(plain==='haddock'&&/\b(raw|uncooked)\b/.test(words)&&!/\b(cooked|boiled|steamed|roasted|baked|grilled|fried|sauteed|poached|battered|breaded|sauce|sauced|dried|canned|smoked)\b/.test(words)){
  const record=byCode('16-375');return {record,preparationProxy:false,excludedPreparation:null,assumptions:['Generic raw haddock edible flesh; the exact fish may differ.']};
 }
 const potatoWords=words+' '+(/^Recipe photo [1-4]:\s*/i.test(evidence)?normal(evidence):'');
 if(/^(?:peeled )?potato(?:es)?(?: peeled)?$/.test(plain)&&/\braw\b/.test(words)&&/\b(?:peeled|flesh only)\b/.test(potatoWords)&&!/\b(cooked|boiled|steamed|roasted|baked|grilled|fried|sauteed|poached|battered|breaded|sauce|sauced|dried|canned|unpeeled|skin on|with skin)\b/.test(potatoWords)){
  const record=byCode('13-489');return {record,preparationProxy:false,excludedPreparation:null,assumptions:['Generic raw peeled potato flesh; the variety and actual water content may differ.']};
 }
 const profile=profiles.find(p=>p.names.includes(plain));
 if(!profile)return null;
 // Never substitute plain components for visibly breaded/battered/sauced food.
 if(/\b(batter|battered|breaded|coated|sauce|sauced|stuffed|cheese|canned|pickled|dried|smoked)\b/.test(words))return null;
 const raw=/\braw\b/.test(words),cooked=/\b(cooked|boiled|steamed|roasted|baked|grilled|fried|sauteed)\b/.test(words);
 if(raw&&cooked)return null;
 let code=raw?profile.raw:cooked?(prepWords.map(p=>words.includes(p)?profile[p]:null).find(Boolean)||profile.cooked):profile.raw||profile.cooked;
 // A raw reference can be a disclosed tofu proxy, but not cooked fruit/pepper.
 if(!code&&cooked&&plain.includes('tofu'))code=profile.raw;
 if(!code)return null;
 const record=byCode(code),recordWords=normal(record.name);
 const preparationProxy=!raw&&!cooked||cooked&&!prepWords.some(p=>words.includes(p)&&recordWords.includes(p));
 const excludedPreparation=/\b(fried|sauteed|roasted|baked|grilled)\b/.test(words)&&preparationProxy?'Added oil, batter and sauces are not included.':null;
 return {record,preparationProxy,excludedPreparation,assumptions:[`Generic food estimate: ${record.name}.`,...(preparationProxy?[`Preparation proxy; the actual recipe may differ.${excludedPreparation?' '+excludedPreparation:''}`]:[])]};
}
export function resolveMealComponents(input,{estimatedServing=false,mealName='',mealIngredients=[],mealSubject=null}={}){
 if(!Array.isArray(input)||input.length>MAX_MEAL_COMPONENTS)throw new RangeError('Too many meal components');
 const components=input.map(c=>{
  const name=String(c.name||'Unknown component').slice(0,100),preparation=String(c.preparation||'unknown').slice(0,100);
  const candidates=compositionCandidates(name,preparation);
  const exact=candidates.find(r=>normal(r.name)===normal(name+' '+preparation)||normal(r.name)===normal(name));
  const supported=new Set([...tokens(name),...tokens(preparation),'in','unsalted','water']);
  const simple=candidates.length===1&&tokens(candidates[0].name).every(word=>[...supported].some(given=>sameWord(given,word)));
  const curated=estimatedServing?proposedMatch(name,preparation,String(c.evidence||'')):null;
  // Exact source names still win. Curated generic matches are new-mode only;
  // old diary snapshots and legacy photographed-dish semantics are unchanged.
  const match=exact||curated?.record||(preparation!=='unknown'&&simple?candidates[0]:null);
  const proxy=!!curated&&match===curated.record;
  const amountGrams=typeof c.amountGrams==='number'&&Number.isFinite(c.amountGrams)&&c.amountGrams>0&&c.amountGrams<=5000?c.amountGrams:null;
  const choices=[...(proxy?[match]:[]),...candidates].filter((r,i,a)=>a.findIndex(v=>v.id===r.id)===i).slice(0,3);
  return {name,preparation,amountGrams,amountSource:c.amountSource==='confirmed'?'confirmed':estimatedServing?'standard_portion_estimate':'photo_estimate',evidence:String(c.evidence||'').slice(0,160),...(Number.isInteger(c.photoIndex)?{photoIndex:c.photoIndex}:{}),...(typeof c.photoId==='string'?{photoId:c.photoId}:{}),recordId:match?.id||null,nutrients:match?.nutrients||{},sourceRecord:match,candidates:choices,matchStatus:match?'matched':candidates.length?'needs_confirmation':'unmatched',matchMethod:exact?'exact':proxy?'curated_proxy':match?'unambiguous':'none',preparationProxy:proxy&&curated.preparationProxy,excludedPreparation:proxy?curated.excludedPreparation:null,assumptions:[...(estimatedServing?['Proposed edible grams in one portion; adjust before confirming.']:[]),...(proxy?curated.assumptions:[]),'Hidden oil, sauces and ingredients are not quantified.',...(Array.isArray(c.assumptions)?c.assumptions.filter(a=>typeof a==='string'):[])]};
 });
 const composition={components,nutrients:calc.total(components),compositionVersion,sourceURL:dataset.sourceURL,attribution:`${dataset.attribution} ${usda.attribution}`};
 if(!estimatedServing)return composition;
 const proposal=calc.proposeMeal({...composition,name:mealName,ingredients:mealIngredients,subject:mealSubject,portionMode:'estimated_serving'});
 return proposal.compoundProposal?{...composition,components:proposal.components,nutrients:proposal.nutrients,compositionVersion:proposal.compositionVersion,compoundProposal:proposal.compoundProposal}:composition;
}
export {calc as compositionMath};
