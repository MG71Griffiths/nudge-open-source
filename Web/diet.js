// Diet projects confirmed intake and scores without changing saved records.
// Missing scores may be estimated; missing nutrient amounts remain unknown.
window.NudgeDiet=(()=>{
  'use strict';
  const keys=['energyKcal','protein','fibre','fat','carbohydrate','sugars','saturatedFat','salt'];
  const primary={energyKcal:'energyPerPortion',protein:'proteinPerPortion',fibre:'fibrePerPortion'};
  const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  function entries(value){
    const ids=new Set(),confirmations=new Set();
    return (Array.isArray(value)?value:[]).filter(e=>{
      if(!e||typeof e.id!=='string'||!e.id||window.WmdStreakMath.dayNumber(e.day)===null||!finite(e.portions)||e.portions<=0||e.portions>8)return false;
      const confirmation=e.sourceMeta?.confirmationId;
      if(ids.has(e.id)||confirmation&&confirmations.has(confirmation))return false;
      ids.add(e.id);if(confirmation)confirmations.add(confirmation);return true;
    });
  }
  function nutrientReading(entry,key){
    const item=entry.nutritionSnapshot?.[key];
    const fallback=primary[key]?entry[primary[key]]:item?.portionStatus==='calculated'?item.portion:null;
    const reading=window.NudgeComposition?.intakeNutrient?.(entry,key)||{value:fallback,partial:false};
    return {...reading,value:finite(reading.value)?reading.value*entry.portions:null};
  }
  const nutrient=(entry,key)=>nutrientReading(entry,key).value;
  const validScore=score=>Boolean(window.NudgeScoreCore?.validResult(score)||window.NudgeMealScore?.validResult(score)||window.NudgeFrequency?.legacy(score));
  function scoreResultForEntry(entry,context={}){
    const meta=entry.sourceMeta||{},saved=[meta.scoreMethod,meta.mealScore].find(validScore);
    if(saved)return {score:saved,saved:true,legacy:window.NudgeFrequency?.legacy(saved)===true||Boolean(meta.scoreMethod&&saved.status==='estimated_rough')};
    // An explicit edit invalidates the active result and archives its provenance.
    // Old scan/composition evidence must not silently become current again.
    if(Array.isArray(meta.scoreHistory)&&meta.scoreHistory.length){
      const score=window.NudgeMealScore?.estimate({name:entry.name,ingredients:entry.ingredients});
      return validScore(score)?{score,saved:false,legacy:false}:null;
    }
    const product=context.productForEntry?.(entry)||{},sourceMeal=context.mealForEntry?.(entry)||{};
    let score=Object.keys(product).length?window.NudgeFoodDetailModel?.score(product):null;
    if(Object.keys(product).length)return validScore(score)?{score,saved:false,legacy:false}:null;
    if(!validScore(score)){
      const meal={...sourceMeal,name:entry.name||sourceMeal.name||product.name,ingredients:entry.ingredients||sourceMeal.ingredients||product.ingredients,
        components:meta.mealComposition||sourceMeal.components||[],basis:'perPortion',portion:{amount:entry.portionAmount,unit:entry.portionUnit||'g'},
        recipeCalculation:meta.mealRecipeCalculation||sourceMeal.recipeCalculation,
        categoryTag:sourceMeal.categoryTag||product.categoryTag,categories:sourceMeal.categories||product.categories,
        qualityEstimate:sourceMeal.qualityEstimate||product.qualityEstimate};
      score=window.NudgeMealScore?.calculate(meal);
      if(!validScore(score))score=window.NudgeMealScore?.estimate(meal,score);
    }
    return validScore(score)?{score,saved:false,legacy:false}:null;
  }
  function scoreForEntry(entry,context){
    const resolved=scoreResultForEntry(entry,context);if(!resolved)return null;
    const original=resolved.score,score=resolved.saved&&context?window.NudgeFrequency?.savedDisplay(original,{...context,entry,product:context.productForEntry?.(entry)||{}})||original:original,legacy=resolved.legacy,rough=!legacy&&score.status==='estimated_rough';
    return {value:score.value,lower:score.value,upper:score.value,qualifier:legacy?'Historical · '+(score.methodId||score.methodVersion):rough?'Rough estimate':(score.status.includes('provisional')?'Provisional · ':'')+(resolved.saved&&!score.estimated?'':'Estimated · ')+'v0.2'+(score.displayRecheckRequired?' · frequency needs recheck':''),rough,method:score.methodId,saved:resolved.saved,legacy,needsRecheck:score.displayRecheckRequired===true,frequency:legacy||rough?null:score.finalFrequency,tone:window.NudgeScoreCore?.displayTone(score.value)||'unknown'};
  }

  function summary(raw,context){
    const foods=entries(raw),totals=Object.fromEntries(keys.map(key=>{
      const readings=foods.map(e=>nutrientReading(e,key)),known=readings.filter(n=>finite(n.value)),partialFoods=known.filter(n=>n.partial).length;
      return [key,{value:known.length?known.reduce((sum,n)=>sum+n.value,0):null,known:known.length,unknown:foods.length-known.length,partial:known.length>0&&(known.length<foods.length||partialFoods>0),partialFoods}];
    }));
    const ratingContext=context?{...context,entries:context.entries||foods}:undefined,ratings=foods.map(entry=>scoreForEntry(entry,ratingContext)).filter(Boolean),scoredFoods=ratings.length;
    const frequencies=Object.fromEntries(['Daily','Weekly','Monthly'].map(f=>[f,ratings.filter(s=>s.frequency===f).length]));
    // v0.2 defines product/recipe nutrient quality, not a validated diet-score average.
    const value=null,high=null,basis=null,coverage=null,scoredEnergy=0,weightedFoods=0,roughFoods=ratings.filter(r=>r.rough).length;

    return {entries:foods,count:foods.length,totals,plants:window.WmdFoodLog.names(foods.flatMap(e=>e.plants||[]),Infinity),ferments:window.WmdFoodLog.names(foods.flatMap(e=>e.ferments||[]),Infinity),
      plantsPartial:foods.some(e=>e.sourceMeta?.plantKnowledge==='unknown'||e.ingredients?.needsReview===true),
      score:{value,upper:high,basis,coverage,scoredEnergy,scoredFoods,savedFoods:ratings.filter(r=>r.saved).length,weightedFoods,roughFoods,frequencies,recheckFoods:ratings.filter(r=>r.needsRecheck).length,historicalFoods:ratings.filter(r=>r.legacy).length,unknownEnergy:totals.energyKcal.unknown}};
  }
  function day(raw,key,context){return {...summary(entries(raw).filter(e=>e.day===key),context?{...context,entries:context.entries||entries(raw)}:undefined),day:key};}
  function period(raw,end,count=7,context){
    count=count===28?28:7;const last=window.WmdStreakMath.dayNumber(end);
    if(last===null)return null;
    const first=last-count+1,all=entries(raw),fullContext=context?{...context,entries:context.entries||all}:undefined,days=Array.from({length:count},(_,i)=>day(all,window.WmdStreakMath.dayKey(first+i),fullContext));
    return {...summary(all.filter(e=>{const n=window.WmdStreakMath.dayNumber(e.day);return n>=first&&n<=last;}),fullContext),days,start:days[0].day,end,windowDays:count,loggedDays:days.filter(d=>d.count>0).length,scoredDays:days.filter(d=>d.score.scoredFoods>0).length};
  }
  function portion(entry){
    return finite(entry.portionAmount)&&entry.portionAmount>0&&['g','ml'].includes(entry.portionUnit)?`${Math.round(entry.portionAmount*entry.portions*1000)/1000} ${entry.portionUnit}`:`${entry.portions} portion${entry.portions===1?'':'s'}`;
  }
  return Object.freeze({entries,nutrient,nutrientReading,scoreResultForEntry,scoreForEntry,summary,day,period,portion});
})();

window.createNudgeDiet=function({getEntries,getState=()=>({}),productForEntry=()=>({}),mealForEntry=()=>({}),todayKey,escapeHtml:esc,render,imageFor,openEntry}){
  const model=window.NudgeDiet,math=window.WmdStreakMath;
  let selectedDay='',periodDays=7;
  const currentDay=()=>selectedDay&&math.dayNumber(selectedDay)<=math.dayNumber(todayKey())?selectedDay:todayKey();
  const icon=name=>window.NudgeIcons?.(name)||'';
  const number=(value,digits=1)=>Number(value.toFixed(digits)).toLocaleString('en-GB');
  const date=(day,options={day:'numeric',month:'short'})=>new Date(day+'T12:00:00').toLocaleDateString('en-GB',options);
  const tone=value=>value===null?'unknown':value<25?'red':value<50?'amber':'green';
  function coverage(s){return s.count?`${s.score.scoredFoods} of ${s.count} foods have ${s.score.savedFoods===s.score.scoredFoods?'saved ':''}scores${s.score.roughFoods?' · '+s.score.roughFoods+' rough estimates':''}${s.score.historicalFoods?' · '+s.score.historicalFoods+' use earlier models':''}${s.score.recheckFoods?' · '+s.score.recheckFoods+' need a frequency recheck':''}.`:'Confirm a food to start this day.';}
  function distribution(s){return ['Daily','Weekly','Monthly'].map(f=>`<span class="nf-frequency-badge nf-frequency-${f.toLowerCase()}">${f}: ${s.score.frequencies[f]}</span>`).join(' ');}

  function metric(key,label,summary){
    const total=summary.totals[key],unit=key==='energyKcal'?'kcal':'g',value=total.value===null?'—':`${total.partial?'≥ ':''}${number(total.value,key==='energyKcal'?0:1)} <small>${unit}</small>`;
    const gaps=[total.partialFoods?`${total.partialFoods} food${total.partialFoods===1?'':'s'} incomplete`:'',total.unknown?`${total.unknown} food${total.unknown===1?'':'s'} unknown`:''].filter(Boolean).join(' · ');
    return `<div class="n-diet-metric" data-diet-nutrient="${key}"><span>${label}${gaps?`<small>${total.partial?'Partial · ':''}${gaps}</small>`:''}</span><strong>${value}</strong></div>`;
  }
  function foodCard(entry,context){
    const score=model.scoreForEntry(entry,context),image=imageFor(entry),energy=model.nutrientReading(entry,'energyKcal'),name=entry.name||'Logged food';
    return `<button class="n-diet-food" data-action="diet-open" data-value="${esc(entry.id)}" aria-label="Open ${esc(name)}, ${esc(model.portion(entry))}"><span class="n-diet-food-image">${image?.src?`<img src="${esc(image.src)}"${image.fallback?` data-nudge-fallback="${esc(image.fallback)}"`:''} alt="" loading="lazy">`:icon('utensils')}<span class="n-diet-logged" aria-label="Logged">${icon('circle-check')}</span><span class="n-score n-score-${score?.tone||'unknown'}" aria-label="${score?`${score.legacy?'Historical Nudge score':score.rough?'Rough Nudge score':score.saved?'Saved Nudge nutrition score':'Estimated Nudge nutrition score'} ${score.value} out of 100`:'Score unavailable'}">${score?`${score.value}<small>/100</small><small>${esc(score.frequency||(score.legacy?'Historical':score.rough?'Rough':'Check'))}</small>`:'—'}</span></span><span class="n-diet-food-copy"><small>${esc(model.portion(entry))}</small><strong>${esc(name)}</strong><small>${energy.value===null?'Calories unknown':(energy.partial?'≥ ':'')+number(energy.value,0)+' kcal'+(energy.partial?' · partial':'')}${score?' · '+esc(score.qualifier):''}${score&&score.upper!==score.value?` ${score.value}–${score.upper}`:''}</small></span></button>`;
  }
  function chart(trend){
    return `<div class="n-diet-daily-scores">${trend.days.map(d=>`<button data-action="diet-day" data-value="${d.day}"><span>${esc(date(d.day))}<small>${d.count?d.count+' foods logged':'No food logged'}</small></span><strong>${d.score.scoredFoods} scored</strong></button>`).join('')}</div>`;
  }

  function screen(){
    const all=getEntries(),state=getState(),context={entries:all,profile:state.nutritionProfile||{},avoidMilk:state.avoidMilk,productForEntry,mealForEntry},day=currentDay(),daily=model.day(all,day,context),trend=model.period(all,day,periodDays,context),score=daily.score.value;
    const yesterday=math.dayKey(math.dayNumber(todayKey())-1),heading=day===todayKey()?'Today':day===yesterday?'Yesterday':date(day,{weekday:'long'});
    const summary=daily.count?`${daily.count} food${daily.count===1?'':'s'} logged${daily.plants.length?` · ${daily.plants.length} plant type${daily.plants.length===1?'':'s'} recorded`:''}.`:'Your day starts with one food.';
    return `<div class="n-diet" data-diet-day="${day}"><div class="n-diet-heading"><h2>Diet quality</h2><div class="n-diet-day"><div><strong>${esc(heading)}</strong><small>${esc(date(day,{day:'numeric',month:'long',year:'numeric'}))}</small></div><div class="n-diet-day-buttons"><button data-action="diet-day-step" data-value="-1" aria-label="Previous day">‹</button><button data-action="diet-day-step" data-value="1" aria-label="Next day"${day===todayKey()?' disabled':''}>›</button></div></div>${day===todayKey()?'':'<button class="n-link" data-action="diet-today">Back to today</button>'}</div>
      <section class="n-diet-score" aria-label="Saved eating frequencies"><h3>Your recorded food</h3><p>${esc(coverage(daily))}</p>${distribution(daily)}<p>Frequencies are shown only while the saved eating occasion and current requirements still pass checks. Counts are foods, not reference-portion allowances.</p>${window.NudgeFrequency?.key()||''}</section>
      <div class="n-diet-note"><span aria-hidden="true">${icon('sprout')}</span><p>${esc(summary)} ${daily.count?'Your confirmed portions are shown below.':'Scan a product or meal, then add what you eat.'}</p></div>
      <section class="n-diet-section" aria-labelledby="diet-foods-title"><h3 id="diet-foods-title">Logged food</h3>${daily.count?`<div class="n-diet-foods">${daily.entries.map(entry=>foodCard(entry,context)).join('')}</div>`:'<div class="n-diet-empty"><p>No food logged for this day.</p><button class="button primary" data-action="scan-food">Open camera</button></div>'}</section>
      <section class="n-diet-section" aria-labelledby="diet-quality-title"><h3 id="diet-quality-title">Food quality</h3><div class="n-diet-quality-row"><span class="n-diet-quality-icon">${icon('sprout')}</span><span>Plants<small>Types recorded${daily.plantsPartial?' · some foods unchecked':''}</small></span><strong>${daily.count?daily.plants.length:'—'}</strong></div><div class="n-diet-quality-row"><span class="n-diet-quality-icon">${icon('utensils')}</span><span>Fermented foods<small>Types recorded</small></span><strong>${daily.count?daily.ferments.length:'—'}</strong></div>${daily.plants.length||daily.ferments.length?`<details class="n-diet-details"><summary>What counts today</summary>${daily.plants.length?`<p><strong>Plants:</strong> ${esc(daily.plants.join(', '))}.</p>`:''}${daily.ferments.length?`<p><strong>Fermented:</strong> ${esc(daily.ferments.join(', '))}.</p>`:''}<p>Counts use the types saved with your food.</p></details>`:''}</section>
      <section class="n-diet-section" aria-labelledby="diet-trend-title"><div class="n-diet-trend-heading"><h3 id="diet-trend-title">History &amp; trends</h3><div class="n-diet-period" aria-label="Trend period">${[7,28].map(n=>`<button data-action="diet-period" data-value="${n}" aria-pressed="${periodDays===n}">${n} days</button>`).join('')}</div></div><div class="n-diet-trend"><span class="n-diet-trend-label">${periodDays}-day food record</span><p>${trend.loggedDays} of ${periodDays} days logged · ${trend.scoredDays} days with scores</p>${distribution(trend)}<p>${esc(coverage(trend))}</p></div><details class="n-diet-details"><summary>Daily records</summary>${chart(trend)}</details></section>
      <section class="n-diet-section" aria-labelledby="diet-recipes-title"><h3 id="diet-recipes-title">Tips &amp; recipes</h3><div class="n-diet-recipes"><button data-action="recipe-open" data-value="chickpea"><span><small>More plant variety</small><strong>Try a chickpea bowl</strong></span><img src="/assets/chickpea-bowl.webp" alt="" loading="lazy"></button><button data-action="recipe-open" data-value="berry"><span><small>A recipe idea</small><strong>Oats, berries &amp; yoghurt</strong></span><img src="/assets/berry-bowl.webp" alt="" loading="lazy"></button></div></section>
      <section class="n-diet-section" aria-labelledby="diet-nutrition-title"><h3 id="diet-nutrition-title">Nutrition</h3><p class="n-diet-caption">For your logged portions${daily.entries.some(e=>e.sourceMeta?.nutritionEstimate==='photo')?' · includes estimates':''}.</p>${[['energyKcal','Calories'],['protein','Protein'],['fibre','Fibre'],['fat','Fat'],['carbohydrate','Carbs']].map(([key,label])=>metric(key,label,daily)).join('')}<details class="n-diet-details"><summary>More nutrients</summary>${[['sugars','Sugars'],['saturatedFat','Saturated fat'],['salt','Salt']].map(([key,label])=>metric(key,label,daily)).join('')}</details></section>
      <details class="n-diet-details n-diet-method"><summary>About these records</summary><p>Only confirmed intake appears here. Nutrition totals preserve unknown values and identify partial totals. Saved scores keep their original method. Missing scores use available food evidence and show Rough estimate when nutrition is incomplete. Estimated scores do not fill missing nutrients. Model v0.2 scores individual foods and sourced recipes; it does not average different food scores into a diet score.</p><p>The original frequency at confirmation stays saved. Changed portions, eating occasions or requirements show Check until reviewed again; these display checks never change your records.</p></details></div>`;

  }
  function handleAction(action,value){
    if(action==='diet-open'){const entry=model.entries(getEntries()).find(e=>e.id===value);if(entry)openEntry(entry);return true;}
    if(action==='diet-day-step'){const step=Number(value);if(step!==-1&&step!==1)return true;const next=math.dayNumber(currentDay())+step;if(next>=0&&next<=math.dayNumber(todayKey())){selectedDay=math.dayKey(next);render();}return true;}
    if(action==='diet-day'){const next=math.dayNumber(value);if(next!==null&&next>=0&&next<=math.dayNumber(todayKey())){selectedDay=value;render();}return true;}
    if(action==='diet-today'){selectedDay='';render();return true;}
    if(action==='diet-period'){if(['7','28'].includes(String(value))){periodDays=Number(value);render();}return true;}
    return false;
  }
  return {screen,handleAction,reset(){selectedDay='';periodDays=7;}};
};
