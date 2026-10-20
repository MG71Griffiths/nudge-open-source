import {afterEach,describe,it,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import worker,{nutrientKeys} from '../src/worker.js';
const token='81'.repeat(32),empty=()=>Object.fromEntries(nutrientKeys.map(k=>[k,null]));
const photo={mimeType:'image/jpeg',imageBase64:readFileSync(new URL('./fixtures/blank.jpg',import.meta.url)).toString('base64')};
const component=(name,amountGrams,preparation='raw')=>({name,amountGrams,preparation,evidence:`Visible ${name}`,photoIndex:1,assumptions:['Editable serving estimate.']});
const observation=()=>({type:'meal',photoConsistency:'sameMeal',metadata:null,productName:null,brand:null,servingSuggestion:null,categoryTag:null,retailer:null,labelKind:'unreadable',ingredients:null,basis:'unknown',energyKj:null,nutritionPreparation:'unknown',servingSize:null,needsClearerPhoto:false,message:'',nutrients:empty(),meal:{name:'Salmon and carrots',basis:'perPortion',estimated:true,needsReview:true,portionMode:'estimated_serving',subject:{kind:'plated_meal',description:'One foreground plate',photoIndex:1},portionAmbiguity:{requiresSelection:false,reason:'Editable serving estimate.'},ingredients:[{name:'Organic salmon',evidence:'Visible Organic salmon'},{name:'carrot',evidence:'Visible carrot'}],plants:[],components:[component('Organic salmon',120),component('carrot',80)],portion:{label:'1 portion',amount:200,unit:'g',source:'estimated'},nutrients:empty(),message:''}});
const envelope=value=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
function setup(rewrite=reply=>reply){
  const calls=[];
  const env={OPENAI_API_KEY:'private-test-key',OPENAI_MODEL:'gpt-4.1-mini',PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),LABEL_QUOTA:{idFromName:v=>v,get:()=>({fetch:async()=>Response.json({allowed:true})})}};
  mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');calls.push(init);
    const request=JSON.parse(init.body);
    if(calls.length===1)return envelope(observation());
    assert.equal(request.text.format.name,'meal_source_recovery');
    const input=JSON.parse(request.input[0].content[0].text);
    const reply={choices:input.components.map(c=>({index:c.index,choice:{category:'general',evidence:[{field:'name',quote:c.product.name}],sweeteners:'unknown',sweetenerEvidence:[],recordId:c.candidates[0].id,reason:'compatible_generic_estimate'}}))};
    return envelope(rewrite(reply,input));
  });
  const run=async()=>{const response=await worker.fetch(new Request('https://nudge.example/v1/nutrition-label/analyse',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({images:[photo]})}),env);return {status:response.status,...await response.json()};};
  return {calls,run};
}
afterEach(()=>mock.restoreAll());
describe('photo analysis uses bounded text-only source recovery',()=>{
  it('fills an unmatched source while retaining observed foods, grams and selected sources',async()=>{
    const {run,calls}=setup(),result=await run();assert.equal(result.status,200);assert.equal(calls.length,2);assert.equal(result.trace.recheckReason,'composition_unmatched');assert.equal(result.trace.recheckOutcome,'recovered');
    const components=result.extraction.meal.components;assert.deepEqual(components.map(c=>c.name),['Organic salmon','carrot']);assert.deepEqual(components.map(c=>c.amountGrams),[120,80]);assert.equal(components[0].evidence,'Visible Organic salmon');assert.equal(components[0].photoIndex,1);assert.equal(components[0].matchMethod,'ai_source_selection');assert.match(components[0].sourceRecord.name,/salmon.*raw/i);assert.notEqual(components[1].matchMethod,'ai_source_selection');assert.equal(result.extraction.meal.portion.amount,200);
    assert.equal(typeof result.extraction.meal.nutrients.energyKcal.value,'number');assert.ok(globalThis.NudgeMealScore.calculate(result.extraction.meal).available);
    const second=JSON.parse(calls[1].body);assert.equal(second.store,false);assert.equal(second.text.format.strict,true);assert.equal(second.input[0].content.length,1);assert.equal(second.input[0].content[0].type,'input_text');assert.doesNotMatch(calls[1].body,/base64|image_url|input_image|private-test-key/);assert.equal(calls[0].signal,calls[1].signal);
    assert.doesNotMatch(JSON.stringify(result.trace),/salmon|carrot|CoFID|private-test-key|base64,/i);
  });
  it('retains the first valid meal when the candidate response invents data or repeats an index',async()=>{
    for(const rewrite of [reply=>{reply.choices[0].choice.recordId='usda:invented';return reply;},reply=>{reply.choices[0].choice.nutrients={salt:0};return reply;},reply=>{reply.choices.push(reply.choices[0]);return reply;}]){
      const {run,calls}=setup(rewrite),result=await run();assert.equal(result.status,200);assert.equal(calls.length,2);assert.equal(result.trace.recheckOutcome,'failed');assert.equal(result.extraction.meal.components[0].recordId,null);assert.equal(result.extraction.meal.components[1].name,'carrot');assert.deepEqual(result.extraction.meal.components.map(c=>c.amountGrams),[120,80]);mock.restoreAll();
    }
  });
  it('retains uncertainty when the model cannot select a compatible source',async()=>{
    const {run,calls}=setup(reply=>{reply.choices[0].choice.recordId=null;reply.choices[0].choice.reason='no_compatible_source';return reply;}),result=await run();assert.equal(result.status,200);assert.equal(calls.length,2);assert.equal(result.trace.recheckOutcome,'no_improvement');assert.equal(result.extraction.meal.components[0].recordId,null);assert.equal(result.extraction.meal.nutrients.energyKcal.value,null);
  });
});
