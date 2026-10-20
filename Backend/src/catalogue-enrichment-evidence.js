import {catalogueRecordFromPayload} from './food-catalogue.js';
import {ScoreCore} from './nutrition-core.js';
import {scorePackagedProduct} from './product-score.js';
import {buildRecoveryContext,applyRecoveryChoice} from './food-recovery.js';
import {recoveredEstimateScore} from './recovered-score.js';
import {applyCatalogueLabelEvidence} from './catalogue-label-evidence.js';

export const ENRICHMENT_VERSION='catalogue-enrichment-v1';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const unknownChoice=()=>({category:'unknown',evidence:[],sweeteners:'unknown',sweetenerEvidence:[]});
const normalize=v=>String(v||'').toLowerCase().replace(/^en:/,'').replace(/[-_]/g,' ').replace(/\s+/g,' ').trim();
const instruction=/\b(?:ignore|instructions?|prompt|system|assistant|return|output|classify|assign|score|rating)\b/;
const compound=/\b(?:sauce|soup|salad|sandwich|pizza|curry|dish|cake|pie|recipe|mix|mixture|bar|biscuit|cookie|flavou?red|stuffed|breaded|battered|sweetened|syrup|powder|juice|smoothie|drink|replacement|supplement)\b/;
const simpleNut=/^(?:(?:organic|raw|whole|blanched) )*(?:almonds?|walnuts?|peanuts?|hazelnuts?|cashews?|pistachios?|pecans?|brazil nuts?|macadamia nuts?|chia seeds?|flax seeds?|linseeds?|sesame seeds?|sunflower seeds?|pumpkin seeds?)$/;
const simpleVegetable=/^(?:(?:organic|fresh|frozen|raw|cooked|boiled|steamed|baby|chopped|peeled) )*(?:carrots?|spinach|broccoli|cauliflower|potatoes?|tomato(?:es)?|onions?)$/;
const simpleGrainPulse=/^(?:(?:organic|raw|dry|dried|uncooked|cooked|boiled|steamed|white|brown|red|green|yellow|split|whole|wholegrain|basmati|long grain|rolled|steel cut|plain|unsalted) )*(?:rice|oats?|wheat|barley|quinoa|bulgur|lentils?|chickpeas?|kidney beans?|black beans?|cannellini beans?|butter beans?|haricot beans?|peas?)$/;
const simpleAnimal=/^(?:(?:organic|fresh|frozen|raw|uncooked|cooked|boiled|steamed|grilled|poached|lean|ground|minced|chicken|hen|duck|quail|whole|white|yolk|british|free range|cage free|barn laid|mixed size|class a|large|medium|small) )*(?:salmon|tuna|cod|haddock|chicken|turkey|beef|pork|lamb|eggs?|egg whites?|egg yolks?)$/;
const state=s=>/\b(?:raw|uncooked|dry|dried)\b/.test(s)?'raw':/\b(?:cooked|boiled|steamed|grilled|poached|roasted|baked|fried)\b/.test(s)?'cooked':null;

// The full food name and, when supplied, the full ingredient statement must
// both describe one simple food. A keyword in a branded recipe is insufficient.
// Existing recovery matching rechecks species, preparation, variants and basis.
function simpleCompositionContext(product,context,core) {
  let name=normalize(product.name),brand=normalize(product.brand);
  if(brand&&name.startsWith(brand+' '))name=name.slice(brand.length+1);
  const fruit=core.wholeFruitIdentity(product,{requireSource:false});
  const kind=fruit?'fruit':simpleNut.test(name)?'nut':simpleVegetable.test(name)?'vegetable':simpleGrainPulse.test(name)?'grain_pulse':simpleAnimal.test(name)?'animal':null;
  const empty=()=>({...context,candidates:[]});
  if(!kind||instruction.test(name)||compound.test(name)||product.basisUnit!=='g'||product.nutritionPreparation!=='as_sold'
    ||context.conflicts.length||product.ingredientsNeedsReview===true)return empty();
  const ingredient=normalize(product.ingredients).replace(/^ingredients\s*:\s*/,'').replace(/^just\s+/,'')
    .replace(/\(\s*100\s*%\s*\)|\b100\s*%/g,'').replace(/\.$/,'').trim();
  if(ingredient){
    if(/[,;()\d%]/.test(ingredient)||instruction.test(ingredient)||compound.test(ingredient))return empty();
    // Reusing the candidate selector with the ingredient identity prevents a
    // plain title concealing a different food or additional component.
    const ingredientContext=buildRecoveryContext({...product,name:ingredient,brand:''},{includeOptional:true},core);
    const ids=new Set(ingredientContext.candidates.map(c=>c.id));
    context={...context,candidates:context.candidates.filter(c=>ids.has(c.id))};
  }
  const tags=[product.categoryTag,...(product.categories||[]),...(product.categoriesTags||[])].map(normalize);
  if(tags.some(t=>compound.test(t)&&!/^plant based foods and beverages$/.test(t)))return empty();
  let wantedState=state(name)||state(ingredient);
  const tagStates=[...new Set(tags.map(state).filter(Boolean))];
  if(tagStates.length>1||wantedState&&tagStates.some(s=>s!==wantedState))return empty();
  wantedState||=tagStates[0]||null;
  // Do not infer whether a bag of rice/lentils is raw or cooked from nutrient
  // values. Plain oats and nuts are the narrow as-sold exceptions here.
  if(kind==='grain_pulse'&&!wantedState&&!/^(?:(?:organic|rolled|steel cut|plain) )*oats?$/.test(name))return empty();
  const candidates=context.candidates.filter(candidate=>{
    const title=normalize(candidate.name),withoutAside=title.replace(/\([^)]*\)/g,'');
    if(instruction.test(withoutAside)||compound.test(withoutAside)||/\b(?:uncle ben|chobani|mcdonald|kellogg|nestle|branded)\b/.test(title))return false;
    if(wantedState&&state(title)!==wantedState)return false;
    return true;
  });
  return {...context,candidates};
}

function projectedScore(product,classification,labelFields=[],core=ScoreCore,sourceProduct=product) {
  const projected=structuredClone(product),estimatedInputs={};
  for(const key of [...Object.keys(projected.nutrients||{}),'energyKj']){
    const original=key==='energyKj'?projected.energyKj:projected.nutrients[key];
    if(original?.status!=='estimated'||!Number.isFinite(original.value)||original.value<0
      ||!['eq','=','~','approx',undefined,null].includes(original.relation)
      ||!labelFields.includes(key)&&projected.nutrientSources?.[key]!=='estimate')continue;
    estimatedInputs[key]=structuredClone(original);
    const admitted={...original,status:'supplied',relation:'eq'};
    if(key==='energyKj')projected.energyKj=admitted;else projected.nutrients[key]=admitted;
  }
  // Supplied kcal still takes precedence over an approximate provider kJ.
  if(estimatedInputs.energyKj&&['supplied','confirmed'].includes(product.nutrients?.energyKcal?.status))projected.energyKj=product.energyKj;
  const exact=core.calculateScore(projected,classification,sourceProduct);
  const result=exact.available?exact:core.CONFIG.status==='nudge_directional'?(core.calculateSourceEstimate(projected,classification,sourceProduct)||exact):exact;
  return {score:result,estimatedInputs,projection:projected};
}

export function evaluateCatalogueEnrichment(rawProduct,options={},core=ScoreCore) {
  if(!object(options)||Object.keys(options).some(k=>!['classification','compositionRecordId','nutritionEvidence','now'].includes(k)))throw new Error('Invalid catalogue enrichment options');
  const {classification:choice,compositionRecordId,nutritionEvidence,now=Date.now()}=options;
  if(!Number.isSafeInteger(now)||now<=0||compositionRecordId!=null&&(typeof compositionRecordId!=='string'||!compositionRecordId||compositionRecordId.length>100))throw new Error('Invalid catalogue enrichment options');
  if(Object.hasOwn(options,'classification')&&!object(choice))throw new Error('Invalid catalogue classification');
  const record=catalogueRecordFromPayload({product:rawProduct},String(rawProduct?.code||''),now);
  if(!record)throw new Error('Invalid public catalogue product');
  const product=record.product,sourceFingerprint=core.providerInputFingerprint(product),evidence=[];
  let projection=product,label=null,classification=core.validateClassification(product,choice??unknownChoice());
  const provenance={version:ENRICHMENT_VERSION,sourceFingerprint,evaluatedAt:now,sourceRevision:rawProduct.last_modified_t??null,
    sourceURL:product.sourceURL,methodId:core.SCORE_METHOD,methodVersion:core.SCORE_VERSION,classifierVersion:core.CLASSIFIER_VERSION};
  const finish=(score,outcome,recoveryContext=null)=>({version:ENRICHMENT_VERSION,outcome,product,score,classification,evidence,provenance,recoveryContext});
  // Caller-supplied choices are validated even if no recovery is required.
  const original=scorePackagedProduct(product,undefined,core);
  const classified=core.CONFIG.status==='nudge_directional'?scorePackagedProduct(product,classification,core):original;
  if(original.available&&classified.available&&compositionRecordId==null&&!nutritionEvidence)
    return finish(classified,classified.category!==original.category?'enriched':'already_rated');
  if(nutritionEvidence){
    label=applyCatalogueLabelEvidence(rawProduct,product,nutritionEvidence);projection=label.projection;
    classification=core.validateClassification(projection,choice??unknownChoice());
    provenance.publicLabel=label.provenance;evidence.push({kind:'public_label',...label.provenance,extraction:label.evidence.extraction});
  }
  if(original.available&&core.CONFIG.status!=='nudge_directional'){
    if(compositionRecordId!=null)throw new Error('Composition source was not needed');
    return finish(original,'already_rated');
  }
  evidence.push(...classification.evidence.map(item=>({kind:'classification',...item})));
  const scored=projectedScore(projection,classification,label?.provenance.addedFields||[],core,product);
  let score=scored.score;
  if(score.available&&!(core.CONFIG.status==='nudge_directional'&&compositionRecordId!=null)){
    const estimated=Boolean(label)||Object.keys(scored.estimatedInputs).length>0||score.estimated;
    if(estimated)score={...score,estimated:true,status:score.status==='provisional'||score.status==='estimated_provisional'?'estimated_provisional':'estimated',
      scoreBasis:label?'public_label_estimate':score.scoreBasis||'provider_nutrient_estimate',
      label:core.CONFIG.status==='nudge_directional'?'Nudge score':'Estimated nutrition score',confidence:'estimated',inputs:{...score.inputs,estimatedInputs:scored.estimatedInputs},
      sourceData:{...score.sourceData,estimatedInputs:scored.estimatedInputs},
      assumptions:[...score.assumptions,'This separate estimate retains supplied product facts; extracted or approximate values do not replace label nutrition.'],
      sources:[...score.sources,...(label?[{title:'Public product packaging transcription (unverified)',url:product.sourceURL}]:[])]};
    // A supplied composition ID is never silently accepted if it was not needed.
    if(compositionRecordId!=null)throw new Error('Composition source was not needed');
    return finish(score,estimated?'estimated':'enriched');
  }
  const context=simpleCompositionContext(projection,buildRecoveryContext(projection,{conflicts:classification.conflicts,includeOptional:core.CONFIG.status==='nudge_directional'&&compositionRecordId!=null},core),core);
  if(compositionRecordId!=null&&!context.candidates.some(c=>c.id===compositionRecordId))throw new Error('Composition source was not offered');
  const selected=compositionRecordId??(context.candidates.length===1?context.candidates[0].id:null);
  if(selected&&classification.category!=='unsupported'){
    // Unknown is a permitted choice: source category and deterministic identity
    // still govern the calculation. It grants no model authority over nutrients.
    const decision={...(choice??unknownChoice()),recordId:selected,reason:'compatible_generic_estimate'};
    const recovered=applyRecoveryChoice(projection,context,decision,core);
    let estimateProjection=scored.projection;
    const wholeFruit=core.wholeFruitIdentity(projection,{requireSource:false}),source=recovered.estimate?.sourceRecord;
    // A selected generic raw whole-fruit row describes entirely qualifying
    // fruit. This estimate-only fact must not be confused with a verified
    // ingredient percentage on the branded record, which remains unchanged.
    const compositionFruit=wholeFruit&&source?.foodGroup==='fruit'&&source.fvlEligible===true&&state(normalize(source.name))==='raw'
      &&core.scoringInputs(estimateProjection,classification).fvlPercent===null;
    if(compositionFruit)estimateProjection={...estimateProjection,scoringFacts:{...estimateProjection.scoringFacts,
      fvlPercent:{value:100,source:'composition',evidence:source.source+' '+source.id+' identifies raw whole '+wholeFruit.name+'.'}}};
    const estimate=recoveredEstimateScore(estimateProjection,recovered,classification,original.missingInputs||[],core,product);
    if(estimate?.available){
      score=estimate;provenance.composition=recovered.provenance;
      evidence.push({kind:'sourced_composition',recordId:selected,source:recovered.estimate.sourceRecord.source,
        sourceURL:recovered.estimate.sourceRecord.sourceURL,sourceVersion:recovered.estimate.sourceRecord.sourceVersion});
      if(compositionFruit)score={...score,assumptions:[...score.assumptions,'The selected raw whole-fruit composition record supplies a 100% qualifying fruit share for this generic estimate only.']};
      if(label)score={...score,assumptions:[...score.assumptions,'Some scoring evidence comes from unverified public packaging transcription.'],
        sources:[...score.sources,{title:'Public product packaging transcription (unverified)',url:product.sourceURL}]};
      return finish(score,'estimated',context);
    }
  }
  return finish(score,classification.category==='unsupported'?'unsupported':'unresolved',context);
}
