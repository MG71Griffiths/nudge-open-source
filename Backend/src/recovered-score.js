import { MealScore, ScoreCore } from './nutrition-core.js';

// A separate scoring projection: never write composition values into the label
// facts or intake. Supplied numbers, including salt/sugar, always take priority.
export function recoveredEstimateScore(product, recovered, classification, missingInputs=[], core=ScoreCore, sourceProduct=product) {
  const estimate=recovered?.estimate;
  if(!estimate||classification?.conflicts?.length||product.basisUnit!=='g'||!['as_sold','prepared'].includes(product.nutritionPreparation)
    ||product.unresolvedFields?.some(k=>['identity','preparation','nutrition'].includes(k)))return null;
  const nutrients=structuredClone(product.nutrients||{}), filled=[], constraints=[];
  // Sugars are a subset of carbohydrate. A declared exact zero can bound a
  // missing sugar value in this estimate; it never changes the stored label.
  const carbohydrate=product.nutrients?.carbohydrate;
  if(typeof nutrients.sugars?.value!=='number'&&carbohydrate?.value===0&&carbohydrate.unit==='g'&&carbohydrate.status==='supplied'
    &&['eq','=',undefined,null].includes(carbohydrate.relation)) {
    nutrients.sugars={value:0,unit:'g',status:'supplied'};
    constraints.push('For this estimate, sugars use the declared 0 g carbohydrate bound; label rounding may conceal trace amounts.');
  }
  const observed=n=>typeof n?.value==='number'&&Number.isFinite(n.value)&&n.status!=='unknown';
  for(const [key,value] of Object.entries(estimate.nutrients||{})) {
    if(observed(nutrients[key]))continue;
    if(typeof value?.value==='number'&&Number.isFinite(value.value)&&value.value>=0&&['eq','=',undefined,null].includes(value.relation)) {
      nutrients[key]={value:value.value,unit:value.unit,status:'supplied'};filled.push(key);
    }
  }
  let energyKj=product.energyKj;
  // Do not prefer generic kJ over energy already declared in kcal.
  if(!observed(energyKj)&&!observed(product.nutrients?.energyKcal)&&typeof estimate.energyKj?.value==='number') {
    energyKj={value:estimate.energyKj.value,unit:'kJ',status:'supplied'};filled.push('energyKj');
  }
  if(!filled.length&&!constraints.length)return null;
  const projection={...product,nutrients,energyKj,sourceKind:'composition',
    nutritionPreparation:product.nutritionPreparation==='prepared'?'as_consumed':'as_sold'};
  // Eligibility belongs to the selected, server-validated composition record.
  // Keep this generic assumption in the separate estimate, never in label data.
  // Do not replace an ingredient-derived share or apply an animal component's
  // zero to an ingredient list that may describe a composite product.
  const source=estimate.sourceRecord, ingredient=String(product.ingredients||'').toLowerCase().trim();
  const simpleAnimal=/^(?:ingredients\s*:\s*)?(?:just\s+)?(?:(?:raw|fresh|whole|chicken|hen|organic)\s+)*(?:eggs?|salmon|tuna|chicken|beef|pork|lamb)\.?$/;
  if(source?.fvlEligible===false&&['egg','fish','poultry','red_meat'].includes(source.foodGroup)
    &&(!ingredient||simpleAnimal.test(ingredient))
    &&core.scoringInputs(projection,classification).fvlPercent===null) {
    projection.scoringFacts={...projection.scoringFacts,fvlPercent:{value:0,source:'composition',
      evidence:source.source+' record '+source.id+' explicitly identifies a non-FVL '+source.foodGroup+' food.'}};
    constraints.push('For this separate estimate, the selected '+source.source+' '+source.foodGroup+' record supplies a 0% qualifying fruit, vegetable and legume share.');
  }
  const resolved={...classification,category:classification.category==='unknown'?estimate.category:classification.category};
  const exact=core.calculateScore(projection,resolved,sourceProduct);
  // A retained OFF approximate nutrient is still an estimate, rather than a
  // missing field or verified label fact. The shared adapter can combine it
  // with the approved generic projection; unsupported/conflicting values fail.
  const score=exact.available?exact:core.CONFIG.status==='nudge_directional'?core.calculateSourceEstimate(projection,resolved,sourceProduct):MealScore.calculateProductEstimate(projection,core);
  if(!score?.available)return null;
  return {...score,estimated:true,status:['rated','estimated'].includes(score.status)?'estimated':'estimated_provisional',scoreBasis:'sourced_composition',
    originalMissingInputs:missingInputs,missingInputs:[...new Set([...missingInputs,...score.missingInputs])],
    assumptions:[...score.assumptions,...constraints,...(filled.length?['Generic food composition supplies '+filled.join(', ')+'. Label values are unchanged.']:[])],
    sources:[...score.sources,{title:estimate.sourceRecord.source+' · '+estimate.sourceRecord.name,url:estimate.sourceRecord.sourceURL}],
    sourceData:{...score.sourceData,compositionRecordId:estimate.sourceRecord.id,compositionVersion:estimate.sourceRecord.sourceVersion},
    recoveryVersion:recovered.provenance.version};
}
