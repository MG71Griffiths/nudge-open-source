// Portion guidance is separate from nutrient quality. No diary writes occur here.
(function(root){
root.NudgeFrequency=(()=>{
  'use strict';
  const VERSION='nudge-planning-0.3',finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  const explicitMeal=slot=>['Breakfast','Lunch','Dinner','Snack'].includes(slot);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // No approved production comparable-group/reference-portion registry was supplied.
  // The Pret example is a pinned test fixture, never a barcode identity rule.
  const REGISTRY=Object.freeze({version:'not-configured',items:Object.freeze({})});
  function safety(product={},profile={},avoidMilk=false){
    const checks=root.NudgeFoodDetailModel?.allergies(product,profile,{avoidMilk});
    const restrictions=[...(profile.avoids||[]),...(profile.allergies||[])];
    const gluten=['coeliac','sensitivity'].includes(profile.glutenRequirement)||profile.glutenFreePreference===true;
    const restricted=restrictions.length||gluten||avoidMilk||['vegan','vegetarian','pescatarian'].includes(profile.diet);
    const recall=product.recallAssessment?.status;
    let suitability=recall==='matched'?'matched_recall':checks?.conflict?'confirmed_conflict':['potential_match','checking','check_unavailable'].includes(recall)?'restriction_unresolved':'no_known_conflict';
    const unresolved=(product.metadata?.conflicts||[]).some(c=>['allergens','ingredients','claims'].includes(c.field));
    const unsupportedRestriction=restrictions.some(id=>!['milk','fish','nuts','gluten','eggs','sesame','soy'].includes(id));
    if(suitability==='no_known_conflict'&&restricted&&(!checks||checks.unknown||unresolved||unsupportedRestriction))suitability='restriction_unresolved';
    // Medical gluten needs positive current-pack evidence. An omitted allergen is not clearance.
    const claims=[...(product.labelsTags||[]),...(product.declaredClaims||[]).map(c=>c?.text||c),...(product.claims||[]).filter(c=>(product.metadata?.evidence||[]).some(e=>e.id===c.evidenceId)).map(c=>c.text||c.kind)];
    if(gluten&&suitability==='no_known_conflict'&&!claims.some(c=>/^(?:en:)?(?:certified[- ]?)?gluten[- ]free$/i.test(String(c))))suitability='restriction_unresolved';
    const exclusions=[];
    if(finite(profile.age)&&profile.age<18)exclusions.push('child_or_adolescent');
    if(profile.care==='clinical'||profile.clinicalDiet===true)exclusions.push('clinical_diet');
    if(profile.pregnant===true||profile.pregnancy===true)exclusions.push('pregnancy');
    if(profile.specialistSports===true)exclusions.push('specialist_sports_nutrition');
    return {suitability,exclusions};
  }
  function occasionSalt(entries,{day,slot,excludeId='',salt}){
    // A neutral entry has no shared eating occasion. Preserve explicit legacy
    // groups without treating every new food on one date as the same meal.
    const same=explicitMeal(slot)?(entries||[]).filter(e=>e.id!==excludeId&&e.day===day&&e.slot===slot):[];
    const values=same.map(e=>{const n=e.nutritionSnapshot?.salt;return !e.sourceMeta?.portionSaltConflict&&n?.portionStatus==='calculated'&&finite(n.portion)&&finite(e.portions)?n.portion*e.portions:null;});
    return {value:finite(salt)&&values.every(finite)?salt+values.reduce((a,b)=>a+b,0):null,otherFoods:same.length,unknownFoods:values.filter(v=>!finite(v)).length};
  }
  function apply(score,{product={},profile={},avoidMilk=false,entries=[],day,slot,excludeId='',salt=null}={}){
    if(!score||score.methodId!==root.NudgeScoreCore?.CONFIG.methodId)return score;
    const conflictingSalt=(product.unresolvedFields||[]).includes('nutrition')||(product.metadata?.conflicts||[]).some(c=>['nutrition','salt'].includes(c.field));
    const occasion=occasionSalt(entries,{day,slot,excludeId,salt:conflictingSalt?null:salt});
    return {...root.NudgeScoreCore.withPortion(score,occasion.value,safety(product,profile,avoidMilk)),planningVersion:VERSION,
      eatingOccasion:{day:day||null,slot:explicitMeal(slot)?slot:null,saltGrams:occasion.value,otherFoods:occasion.otherFoods,unknownFoods:occasion.unknownFoods,groupingPolicy:explicitMeal(slot)?'same-local-date-and-explicit-meal-v1':'current-item-only-v1'},
      comparableGroupStatus:'reference_dataset_unavailable'};
  }
  // Display-only guard: the exact confirmation snapshot stays in storage. A
  // changed occasion or unresolved current requirement cannot retain clearance.
  function savedDisplay(score){
    // Retain the saved nutrition evidence, but retire the old unsupported
    // grade-to-frequency prescription in every historical display.
    return score?.methodId==='nudge_nutrition_v0_2'
      ? {...score,baseFrequency:null,finalFrequency:null,frequencyStatus:'historical',frequencyPolicy:null}
      : score;
  }
  // Fractions share an evidenced group across brands. Callers cannot infer membership from names.
  function rolling(entries,{day,groupId,frequency,registry=REGISTRY}={}){
    const days=frequency==='Weekly'?7:frequency==='Monthly'?28:null,math=root.WmdStreakMath,end=math?.dayNumber(day);
    if(!days||end==null||!groupId||registry.version==='not-configured')return {available:false,reason:'reference_dataset_unavailable',policyVersion:VERSION};
    let used=0,unknown=0;const seen=new Set();
    for(const entry of entries||[]){const n=math.dayNumber(entry.day);if(n==null||n>end||n<end-days+1||seen.has(entry.sourceMeta?.confirmationId||entry.id))continue;seen.add(entry.sourceMeta?.confirmationId||entry.id);
      const reference=registry.items[entry.barcode||entry.sourceMeta?.referenceFoodId],score=entry.sourceMeta?.scoreMethod||entry.sourceMeta?.mealScore;
      if(!reference||reference.groupId!==groupId||score?.finalFrequency!==frequency)continue;
      if(!finite(reference.amount)||reference.amount<=0||!reference.source||!reference.version||entry.portionUnit!==reference.unit||!finite(entry.portionAmount)||!finite(entry.portions)){unknown++;continue;}
      used+=entry.portionAmount*entry.portions/reference.amount;
    }
    return {available:true,used,remaining:Math.max(0,2-used),limit:2,days,unknown,groupId,registryVersion:registry.version,policyVersion:VERSION};
  }
  const tone=score=>score?.finalFrequency==='Daily'?'green':score?.finalFrequency==='Weekly'?'amber':score?.finalFrequency==='Monthly'?'red':'unknown';
  const key=()=>'<ul class="nf-frequency-key"><li><strong>Daily</strong><span>Any day, with appropriate portions and variety.</span></li><li><strong>Weekly</strong><span>Up to 2 reference portions in a rolling 7 days, shared across comparable Weekly choices.</span></li><li><strong>Monthly</strong><span>Up to 2 reference portions in a rolling 28 days, shared across comparable Monthly choices.</span></li></ul><p class="nf-policy-note">Proposed Nudge planning policy, not official safe limits or a clinical prescription. Portion allowances are not available for this food.</p>';
  function render(score){
    if(score?.status==='estimated_rough'||score?.methodId===root.NudgeScoreCore?.CONFIG.methodId||['nudge_nutrition_v0_2','nudge_nutrition_v0_3'].includes(score?.methodId))return '';
    const final=score?.finalFrequency,base=score?.baseFrequency,status=score?.frequencyStatus;
    const label=final||({unsuitable:'Check your requirements',excluded:'Personal guidance needed',check_required:'Check suitability',recheck_required:'Needs recheck',incomplete:'Salt check needed',pending:'Choose a portion'}[status]||'More information needed');
    const occasion=score?.eatingOccasion;
    return `<div class="nf-frequency"><span class="nf-frequency-label">Eating frequency</span><strong class="nf-frequency-badge nf-frequency-${final?final.toLowerCase():'unknown'}">${esc(label)}</strong>${base?`<p>Base frequency: ${esc(base)}${final&&final!==base?' · adjusted for salt in this eating occasion':''}.</p>`:''}${occasion?`<p>${finite(occasion.saltGrams)?Number(occasion.saltGrams.toFixed(3))+' g salt':'Salt incomplete'}${occasion.day?' · '+esc(occasion.day):''}${occasion.otherFoods?' · includes '+occasion.otherFoods+' other logged food'+(occasion.otherFoods===1?'':'s'):''}.</p>`:''}${key()}</div>`;
  }
  const legacy=score=>Boolean(score&&score.methodId!==root.NudgeScoreCore?.CONFIG.methodId&&score.methodId!==(root.NudgeMealScore?.ESTIMATE_VERSION||'nudge_food_estimate_v3')&&Number.isInteger(score.value)&&score.value>=0&&score.value<=100&&((['nudge_label_v0_1','nudge_nutrition_v0_2','nudge_nutrition_v0_3'].includes(score.methodId)&&['rated','provisional','estimated','estimated_provisional'].includes(score.status))||root.NudgeMealScore?.validResult?.(score)));
  const historical=score=>legacy(score)?`<p class="nf-historical">Saved historical score: ${score.value}/100 · ${esc(score.methodId||score.methodVersion||'earlier model')}. The current nutrition rating is shown separately; your logged nutrition is unchanged.</p>`:'';
  return Object.freeze({VERSION,REGISTRY,safety,occasionSalt,apply,savedDisplay,rolling,tone,key,render,legacy,historical});
})();
if(typeof module==='object'&&module.exports)module.exports=root.NudgeFrequency;
})(typeof window==='object'?window:globalThis);
