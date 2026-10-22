// Read-only projections of confirmed intake. Unlogged/unknown days are never zero.
window.NudgeToday = (() => {
  'use strict';
  const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  const rounded=n=>Math.round(n*10)/10;
  const estimated=entries=>entries.some(e=>Boolean(e.sourceMeta?.nutritionEstimate)||e.sourceMeta?.mealPortionMode==='estimated_serving'||/estimate/i.test(e.source||''));
  const METRICS=[['protein','protein','Protein','g','dumbbell'],['calories','energy','Energy','kcal','flame'],['carbs','carbs','Carbs','g','wheat'],['fat','fat','Fat','g','droplet'],['fibre','fibre','Fibre','g','leaf']];
  const ALL_METRICS=[...METRICS,['plants','plants','Plants','types','sprout']];
  let lastNutritionReport='';
  function nutrientReading(entry,field){
    const key={energyPerPortion:'energyKcal',proteinPerPortion:'protein',fibrePerPortion:'fibre'}[field]||field;
    if(window.NudgeComposition?.intakeNutrient)return window.NudgeComposition.intakeNutrient(entry,key);
    if(['carbohydrate','fat','sugars','saturatedFat','salt'].includes(field)){
      const item=entry.nutritionSnapshot?.[field];
      return {value:item?.portionStatus==='calculated'&&finite(item.portion)?item.portion:null,partial:false};
    }
    return {value:finite(entry[field])?entry[field]:null,partial:false};
  }
  const nutrientValue=(entry,field)=>nutrientReading(entry,field).value;
  const plantsKnown=(e,plants)=>plants.length>0||e.sourceMeta?.plantSelectionConfirmed===true||e.sourceMeta?.mealIngredientSelection?.source==='user'&&e.sourceMeta.mealIngredientSelection.confirmed===true&&e.sourceMeta.mealIngredientSelection.names.length===0||e.sourceMeta?.plantKnowledge==='known'||Boolean(e.ingredients&&!e.ingredients.needsReview);
  function readContext(state){
    const log=window.WmdFoodLog.clean(state.foodLog),readings=new Map(),plantReadings=new Map();
    const plantReading=entry=>{if(!plantReadings.has(entry)){const names=window.WmdFoodLog.intakePlants(entry);plantReadings.set(entry,{names,known:plantsKnown(entry,names)});}return plantReadings.get(entry);};
    return {log,plants:entry=>plantReading(entry).names,plantsKnown:entry=>plantReading(entry).known,reading(entry,field){let row=readings.get(entry);if(!row){row={};readings.set(entry,row);}return row[field]||(row[field]=nutrientReading(entry,field));}};
  }
  function model(state,day,today=day,context=readContext(state)){
    const math=window.WmdStreakMath,log=window.WmdFoodLog,nutrition=window.NudgeNutrition;
    const entries=context.log.entries,current=day<=today?entries.filter(e=>e.day===day):[],start=math.monday(math.dayNumber(day));
    const reading=context.reading,plantsKnown=context.plantsKnown;
    const days=Array.from({length:7},(_,i)=>({day:math.dayKey(start+i),label:['M','T','W','T','F','S','S'][i]}));
    const week=entries.filter(e=>e.day>=days[0].day&&e.day<=today&&e.day<=days[6].day),plants=list=>[...new Set(list.flatMap(context.plants))],profile=nutrition.clean(state.nutritionProfile);
    const currentTargets={protein:nutrition.target(profile).grams,calories:nutrition.calories(profile).kcal,carbs:profile.carbTarget,fibre:profile.fibreTarget,fat:nutrition.fat(profile).grams,dailyPlants:profile.dailyPlantTarget,plants:profile.schemaVersion>=2?profile.weeklyPlantTarget:profile.saved?context.log.plantGoal:null};
    const enabledTargetModes=new Set(ALL_METRICS.filter(([key])=>profile.tracking.includes(key)).map(([key])=>profile.targetModes?.[key]||(currentTargets[key]!==null&&currentTargets[key]!==undefined?'manual':null)).filter(Boolean));
    const targetModeLabel=enabledTargetModes.size>1?'Automatic + custom targets':enabledTargetModes.has('automatic')?'Automatic targets':enabledTargetModes.has('manual')?'Custom targets':'';
    // Existing targets can describe today; never backfill them into earlier days.
    const readTarget=profile.targetHistory.length?nutrition.targetReader(profile):null;
    const referenceDays=new Map(),referencesOn=date=>{if(!referenceDays.has(date))referenceDays.set(date,nutrition.effectiveTargets(profile,date,today,context.log.plantGoal).targets);return referenceDays.get(date);};
    const references=referencesOn(day);
    const datedTarget=(date,metric)=>['sugars','saturatedFat','salt','dailyPlants'].includes(metric)?referencesOn(date)[metric]:{...(readTarget?readTarget(date,metric):{value:date===today?currentTargets[metric]??null:null,known:date===today}),reason:referencesOn(date)[metric]?.reason||null};
    const dayTarget=metric=>datedTarget(day,metric);
    const nutrient=(field,target)=>{
      const known=current.filter(e=>reading(e,field).value!==null),total=known.reduce((sum,e)=>sum+reading(e,field).value*e.portions,0);
      return {value:current.length&&!known.length?null:field==='energyPerPortion'?total:rounded(total),rawValue:current.length&&!known.length?null:total,target:target.value,targetKnown:target.known,targetReason:target.reason||null,recorded:current.length>0,future:day>today,unknown:current.filter(e=>reading(e,field).value===null||reading(e,field).partial).length,estimated:estimated(known)||known.some(e=>reading(e,field).estimated)};
    };
    const weekly=(field,metric)=>{
      const rows=days.map(d=>{
        const list=d.day<=today?week.filter(e=>e.day===d.day):[],known=list.filter(e=>field==='plants'?plantsKnown(e):reading(e,field).value!==null),target=datedTarget(d.day,metric);
        const toDate=field==='plants'?week.filter(e=>e.day<=d.day):[],weekPlantTarget=field==='plants'?datedTarget(d.day,'plants'):null;
        return {...d,future:d.day>today,recorded:list.length>0,value:known.length?(field==='plants'?plants(known).length:known.reduce((sum,e)=>sum+reading(e,field).value*e.portions,0)):null,unknown:field==='plants'?list.length-known.length:list.filter(e=>reading(e,field).value===null||reading(e,field).partial).length,target:target.value,targetKnown:target.known,targetReason:target.reason||null,targetRole:target.targetRole||references[metric]?.targetRole||'goal',targetLabel:target.targetLabel,referenceKind:target.referenceKind,referenceNote:target.referenceNote,estimated:estimated(known)||(field!=='plants'&&known.some(e=>reading(e,field).estimated)),...(field==='plants'?{cumulative:{value:toDate.some(plantsKnown)?plants(toDate).length:null,target:weekPlantTarget.value,targetKnown:weekPlantTarget.known,targetReason:weekPlantTarget.reason||null,recorded:toDate.length>0,unknown:toDate.filter(e=>!plantsKnown(e)).length,future:d.day>today}}:{})};
      });
      const known=rows.filter(d=>!d.future&&d.value!==null),applicable=known.filter(d=>d.targetKnown&&d.target!==null);
      return {days:rows,value:known.length?(field==='plants'?plants(week).length:known.reduce((sum,d)=>sum+d.value,0)):null,unknown:rows.reduce((sum,d)=>sum+d.unknown,0),loggedDays:rows.filter(d=>d.recorded).length,knownDays:known.length,estimated:known.some(d=>d.estimated),comparison:{intake:applicable.reduce((sum,d)=>sum+d.value,0),target:applicable.reduce((sum,d)=>sum+d.target,0),days:applicable.length},historicalTargetsMissing:rows.filter(d=>!d.future&&!d.targetKnown).length};
    };
    const plantUnknown=current.filter(e=>!plantsKnown(e)).length,plantTarget=dayTarget('dailyPlants'),weekThrough=days[6].day<today?days[6].day:today;
    const weekPlantTarget=weekThrough>=days[0].day?datedTarget(weekThrough,'plants').value:null;
    const result={
      protein:nutrient('proteinPerPortion',dayTarget('protein')),energy:nutrient('energyPerPortion',dayTarget('calories')),
      carbs:nutrient('carbohydrate',dayTarget('carbs')),fibre:nutrient('fibrePerPortion',dayTarget('fibre')),fat:nutrient('fat',dayTarget('fat')),
      plants:{value:current.length&&plantUnknown===current.length?null:plants(current).length,target:plantTarget.value,targetKnown:plantTarget.known,targetReason:plantTarget.reason||null,targetRole:plantTarget.targetRole,targetLabel:plantTarget.targetLabel,referenceNote:plantTarget.referenceNote,recorded:current.length>0,future:day>today,unknown:plantUnknown},
      weekPlants:plants(week).length,weekTarget:weekPlantTarget,
      days:days.map(d=>({...d,future:d.day>today,recorded:week.some(e=>e.day===d.day)})),weekProtein:weekly('proteinPerPortion','protein'),weekEnergy:weekly('energyPerPortion','calories'),
      weekCarbs:weekly('carbohydrate','carbs'),weekFibre:weekly('fibrePerPortion','fibre'),weekFat:weekly('fat','fat'),
      weekSugars:weekly('sugars','sugars'),weekSaturatedFat:weekly('saturatedFat','saturatedFat'),weekSalt:weekly('salt','salt'),weekPlantProgress:weekly('plants','dailyPlants'),entryCount:current.length,targetModeLabel,tracking:profile.tracking,dateRange:{start:days[0].day,end:days[6].day,through:today},selectedDay:day,today
    };
    // The full native daily summary and its weekly cards share the same order.
    // Tracking preferences for the older six-ring calendar must not hide these.
    result.weeklyMetrics=[...compactFields.map(([key,metric,,title,unit])=>({key,title,unit,targetRole:references[metric].targetRole,referenceKind:references[metric].referenceKind})),{key:'plants',title:'Plants',unit:'types',targetRole:'goal'}];
    return result;
  }
  const exactValue=item=>item.rawValue===undefined?item.value:item.rawValue;
  function progressRatio(item){
    const value=exactValue(item);
    if(item.future||!item.recorded||value===null||!finite(value)||!finite(item.target)||item.target===0||item.targetKnown===false)return null;
    return value/item.target;
  }
  function progress(item){
    const ratio=progressRatio(item);
    // Keep clean integer labels without announcing completion before the target.
    return ratio===null?null:ratio<1?Math.min(99,Math.round(ratio*100)):Math.round(ratio*100);
  }
  function status(item){
    if(item.future)return 'upcoming';if(!item.recorded)return 'unlogged';if(exactValue(item)===null)return 'unknown';
    const ratio=progressRatio(item);
    if(ratio!==null&&ratio>=1&&['reference','limit'].includes(item.targetRole))return ratio>1?'above_reference':'at_reference';
    return item.unknown?'partial':ratio!==null&&ratio>=1?'reached':'recorded';
  }
  function ringItems(m,day=m.selectedDay){
    const index=m.days.findIndex(d=>d.day===day);
    return ALL_METRICS.filter(([tracking])=>m.tracking.includes(tracking)).map(([,key,title,unit,glyph])=>{
      let item=day===m.selectedDay?m[key]:m['week'+(key==='plants'?'PlantProgress':key[0].toUpperCase()+key.slice(1))].days[index];
      let period='day';
      if(key==='plants'&&item.target===null){item=m.weekPlantProgress.days[index].cumulative;period='week';}
      return {...item,key,title,unit,glyph,period};
    });
  }
  function rings(items,mini=false){
    // Keep the innermost ring open when all six metrics are shown.
    const center=140,step=96/(Math.max(5,items.length)-1),stroke=Math.min(mini?18:16,step-5);
    return `<svg class="n-fitness-rings${mini?' n-fitness-mini-rings':''}" viewBox="0 0 280 280" aria-hidden="true" focusable="false">${items.map((item,index)=>{
      const radius=122-index*step,length=2*Math.PI*radius,p=progress(item),ratio=Math.min(1,progressRatio(item)??0),end=-Math.PI/2+ratio*2*Math.PI;
      return `<g style="color:var(--n-metric-${item.key})" class="n-fitness-ring n-day-${status(item)}" data-metric="${item.key}" data-progress-state="${status(item)}" data-progress-percent="${p===null?'':p}" data-progress-value="${item.recorded&&exactValue(item)!==null?exactValue(item):''}"><circle class="n-fitness-ring-track" cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="currentColor" stroke-opacity=".15" stroke-width="${stroke}"${item.value===null&&item.recorded?' stroke-dasharray="3 7"':''}/>${ratio>0?`<circle class="n-fitness-ring-fill" cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${ratio*length} ${length}" transform="rotate(-90 ${center} ${center})"/>${!mini?`<circle class="n-fitness-ring-tip" cx="${center+radius*Math.cos(end)}" cy="${center+radius*Math.sin(end)}" r="${stroke/2}" fill="currentColor"/>`:''}`:''}</g>`;
    }).join('')}</svg>`;
  }
  function calendarDays(month){
    const math=window.WmdStreakMath,first=math.dayNumber(month+'-01');
    if(first===null)return [];
    const start=math.monday(first),date=new Date(first*86400000),end=math.dayNumber(new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).toISOString().slice(0,10));
    return Array.from({length:Math.ceil((end-start+1)/7)*7},(_,i)=>({day:math.dayKey(start+i),inMonth:math.dayKey(start+i).slice(0,7)===month}));
  }
  const compactFields=[['energy','calories','energyKcal','Energy','kcal'],['protein','protein','protein','Protein','g'],['fibre','fibre','fibre','Fibre','g'],['carbs','carbs','carbohydrate','Carbs','g'],['fat','fat','fat','Fat','g'],['sugars','sugars','sugars','Total sugars','g'],['saturatedFat','saturatedFat','saturatedFat','Saturated fat','g'],['salt','salt','salt','Salt','g']];
  function compactItem(key,title,unit,reading,target,extra={}){
    const value=finite(reading.value)?reading.value:null,item={key,title,unit,value:value===null?null:unit==='kcal'?Math.round(value):rounded(value),rawValue:value,
      target:target.value,targetKnown:target.known,targetReason:target.reason||null,recorded:reading.recorded,unknown:reading.unknown||0,estimated:reading.estimated===true,
      targetRole:target.targetRole,targetLabel:target.targetLabel,targetMode:target.mode,referenceKind:target.referenceKind,referenceNote:target.referenceNote,guideWeeklyTarget:target.guideWeeklyTarget,period:'day',...extra};
    const ratio=progressRatio(item);return {...item,percent:progress(item),ratio:ratio===null?null:Math.min(1,ratio)};
  }
  function plantContribution(state,day,plants,excludeId=null,today=day,context=readContext(state),effective=null){
    const math=window.WmdStreakMath,start=math.monday(math.dayNumber(day)??math.dayNumber(today)),weekStart=math.dayKey(start),weekEnd=math.dayKey(start+6);
    const week=context.log.entries.filter(e=>e.id!==excludeId&&e.day>=weekStart&&e.day<=weekEnd&&e.day<=today);
    const existing=new Set(week.flatMap(context.plants)),selected=window.WmdFoodLog.plantNames(plants),newPlants=selected.filter(p=>!existing.has(p));
    const target=(effective||window.NudgeNutrition.effectiveTargets(state.nutritionProfile,day,today,state.foodLog?.plantGoal)).targets.plants;
    return {total:selected.length,newCount:newPlants.length,newPlants,weekStart,weekEnd,target:target.value,targetKnown:target.known,
      percent:target.value===null?null:Math.round(newPlants.length/target.value*100),unknown:week.filter(e=>!context.plantsKnown(e)).length};
  }
  function compactSummary(state,day,today=day,context=readContext(state)){
    const log=context.log,current=log.entries.filter(e=>e.day===day&&e.day<=today),effective=window.NudgeNutrition.effectiveTargets(state.nutritionProfile,day,today,log.plantGoal);
    const metrics=compactFields.map(([key,metric,field,title,unit])=>{
      const values=current.map(entry=>({entry,reading:context.reading(entry,{energyKcal:'energyPerPortion',protein:'proteinPerPortion',fibre:'fibrePerPortion'}[field]||field)})),known=values.filter(x=>x.reading.value!==null);
      return compactItem(key,title,unit,{value:current.length&&!known.length?null:known.reduce((sum,x)=>sum+x.reading.value*x.entry.portions,0),recorded:current.length>0,
        unknown:values.filter(x=>x.reading.value===null||x.reading.partial).length,estimated:estimated(current)||known.some(x=>x.reading.estimated)},effective.targets[metric]);
    });
    const known=current.filter(context.plantsKnown),dayPlants=current.length&&!known.length?null:new Set(current.flatMap(context.plants)).size;
    metrics.push(compactItem('plants',day===today?'Plants today':'Plants that day','types',{value:dayPlants,recorded:current.length>0,unknown:current.length-known.length},effective.targets.dailyPlants));
    return {compactMetrics:metrics,targetModeLabel:effective.modeLabel,dayPlants};
  }
  function projection(state,day,today=day){const context=readContext(state);return {...model(state,day,today,context),...compactSummary(state,day,today,context)};}
  function compactReview(state,day,nutrients,plants,excludeId=null,today=day,plantKnowledge=true){
    const effective=window.NudgeNutrition.effectiveTargets(state.nutritionProfile,day,today,state.foodLog?.plantGoal);
    const metrics=compactFields.map(([key,metric,field,title,unit])=>{const n=nutrients[field]||{};return compactItem(key,title,unit,{value:n.portion??n.knownPortionSubtotal??null,recorded:true,unknown:n.portionStatus==='partial'?n.unknownContributions||1:!finite(n.portion)?1:0},effective.targets[metric]);});
    const plantSummary=plantContribution(state,day,plants,excludeId,today,readContext(state),effective);
    if(!plantKnowledge){plantSummary.total=null;plantSummary.newCount=null;plantSummary.percent=null;plantSummary.unknown+=1;}
    metrics.push(compactItem('plants','New plants','types',{value:plantSummary.newCount,recorded:true,unknown:plantSummary.unknown},effective.targets.plants,{period:'week',totalPlants:plantSummary.total,contribution:true}));
    return {compactMetrics:metrics,plantSummary,targetModeLabel:effective.modeLabel};
  }
  function screen(state,day,esc,options={}){
    const today=options.today||day,m=model(state,day,today),icon=window.NudgeIcons,number=(n,digits=1)=>Number(n).toLocaleString('en-GB',{maximumFractionDigits:digits}),date=key=>new Date(key+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'});
    if(m.entryCount&&window.NudgeDiagnostics?.record){
      const metrics=METRICS.map(([,key])=>m[key]),detail={entryCount:m.entryCount,knownNutrientCount:metrics.filter(x=>x.value!==null).length,missingNutrientCount:metrics.filter(x=>x.value===null).length,partialNutrientCount:metrics.filter(x=>x.value!==null&&x.unknown).length},signature=day+JSON.stringify(detail);
      if(signature!==lastNutritionReport){lastNutritionReport=signature;window.NudgeDiagnostics.record('nutrition',detail.missingNutrientCount||detail.partialNutrientCount?'incomplete':'calculated',detail);}
    }
    const describe=(item,includeTitle=true)=>`${includeTitle?item.title+': ':''}${item.future?'Upcoming':!item.recorded?'No food logged':item.value===null?'Unknown':number(item.value,item.unit==='kcal'?0:1)+' '+item.unit}${item.targetKnown===false?', historical target not recorded':item.target!==null?', target '+number(item.target,item.unit==='kcal'?0:1)+' '+item.unit+(item.period==='week'?' this week':''): ', target not set'}${item.unknown?', partial total':''}`;
    const targetButton=`<button class="n-target-link" data-action="profile-edit" data-value="tracking">${[m.protein,m.energy,m.carbs,m.fibre,m.fat].some(x=>x.target!==null)?'Review targets':'Set a target'}</button>`;
    const budget=day===today&&state.nutritionProfile?.saved?window.NudgeNutrition.macroBudget(state.nutritionProfile):null;
    const targetWarning=budget&&['over','under'].includes(budget.state)?`<p class="notice small n-target-budget-warning" role="status"><strong>Targets don’t match.</strong> Your ${budget.complete?'':'known '}macro targets total ${budget.complete?'':'at least '}${number(budget.macroKcal,0)} kcal against ${number(budget.energyKcal,0)} kcal. Review targets to make them consistent.</p>`:'';
    const completion=item=>{const p=progress(item);return p===null?'—':(item.unknown?'≥ ':'')+p+'%';};
    const overviewItems=ringItems(m);
    let calendar='';
    if(options.calendarOpen){
      const month=/^\d{4}-\d{2}$/.test(options.calendarMonth||'')?options.calendarMonth:day.slice(0,7),models=new Map(),monthLabel=new Date(month+'-01T12:00:00').toLocaleDateString('en-GB',{month:'long',year:'numeric'});
      const cells=calendarDays(month).map(d=>{
        if(!d.inMonth)return '<span class="n-fitness-calendar-empty" aria-hidden="true"></span>';
        const start=window.WmdStreakMath.monday(window.WmdStreakMath.dayNumber(d.day));
        if(!models.has(start))models.set(start,model(state,d.day,today));
        const items=ringItems(models.get(start),d.day),future=d.day>today,label=date(d.day)+'. '+items.map(x=>describe(x)).join('. ');
        return `<button type="button" class="n-fitness-calendar-day${d.day===day?' is-selected':''}${future?' is-future':''}" data-action="tracking-day" data-value="${d.day}" aria-label="${esc(label)}"${d.day===day?' aria-current="date"':''}${future?' disabled':''}><span>${Number(d.day.slice(-2))}</span>${rings(items,true)}</button>`;
      }).join('');
      calendar=`<section class="n-fitness-calendar" aria-label="Progress calendar"><div class="n-fitness-calendar-head"><button type="button" data-action="tracking-month" data-value="-1" aria-label="Previous month"><span aria-hidden="true">‹</span></button><h2>${esc(monthLabel)}</h2><button type="button" data-action="tracking-month" data-value="1" aria-label="Next month"${month>=today.slice(0,7)?' disabled':''}><span aria-hidden="true">›</span></button></div><div class="n-fitness-calendar-weekdays" aria-hidden="true">${['M','T','W','T','F','S','S'].map(x=>'<span>'+x+'</span>').join('')}</div><div class="n-fitness-calendar-grid">${cells}</div><p class="n-caption">Choose a day to see its logged totals and targets.</p></section>`;
    }
    const overview=overviewItems.length?`<section class="n-fitness-overview" aria-label="Nutrition progress against targets"><div class="n-fitness-week-nav"><button type="button" data-action="tracking-week" data-value="-1" aria-label="Previous week"><span aria-hidden="true">‹</span></button><button type="button" data-action="tracking-calendar" aria-expanded="${Boolean(options.calendarOpen)}" aria-label="${options.calendarOpen?'Close':'Open'} progress calendar">${esc(date(m.dateRange.start)+'–'+date(m.dateRange.end))}${icon('calendar-days')}</button><button type="button" data-action="tracking-week" data-value="1" aria-label="Next week"${m.dateRange.end>=today?' disabled':''}><span aria-hidden="true">›</span></button></div><div class="n-fitness-days">${m.days.map(d=>{
      const items=ringItems(m,d.day),description=date(d.day)+'. '+items.map(x=>describe(x)).join('. ');
      return `<button type="button" class="n-fitness-day${d.day===day?' is-selected':''}${d.future?' is-future':''}" data-action="tracking-day" data-value="${d.day}" aria-label="${esc(description)}"${d.day===day?' aria-current="date"':''}${d.future?' disabled':''}><span>${d.label}</span>${rings(items,true)}<span class="n-fitness-day-date">${Number(d.day.slice(-2))}</span></button>`;
    }).join('')}</div>${calendar}<div class="n-fitness-summary">${rings(overviewItems)}<div class="n-fitness-legend">${overviewItems.map(item=>`<div class="n-fitness-legend-item" style="--n-metric:var(--n-metric-${item.key})"><span class="n-fitness-legend-label">${item.title}${item.period==='week'?' · week':''}</span><strong class="n-fitness-percent">${completion(item)}</strong><span class="n-fitness-legend-total">${!item.recorded||item.future||item.value===null?'—':number(item.value,item.unit==='kcal'?0:1)}${item.target!==null?' / '+number(item.target,item.unit==='kcal'?0:1):''} ${item.unit}</span>${item.unknown?item.value===null?'<small>Nutrition unknown</small>':'<small>Known total · partial</small>':!item.recorded?'<small>No food logged</small>':item.targetKnown===false?'<small>Target not recorded</small>':item.target===null?'<small>Target not set</small>':exactValue(item)>item.target?'<small>Over target</small>':''}</div>`).join('')}</div></div><p class="n-caption n-fitness-note">Rings show confirmed food against your saved targets.${overviewItems.some(x=>x.unknown)?' Partial totals show only known nutrition.':''}${overviewItems.some(x=>x.period==='week')?' Plants count different types so far this week.':''}</p></section>`:'';
    const target=(key,name,unit,glyph)=>{
      const item=m[key],digits=key==='energy'?0:1,p=progress(item),bar=Math.min(1,progressRatio(item)??0)*100;
      const label=describe({...item,title:name,unit});
      return `<article class="n-target n-metric-${key} ${key==='plants'?'n-plant-target':''}" aria-label="${esc(label)}"><div class="n-target-head">${icon(glyph)}<span>${name}</span><span class="n-fitness-percent">${completion(item)}</span></div><div class="n-target-number">${!item.recorded||item.value===null?'—':number(item.value,digits)}<small>${unit}</small></div><div class="n-target-goal">${item.target!==null?'of '+number(item.target,digits)+' '+unit+(day===today?' today':' on this day'):item.targetKnown===false?'Target not recorded':'Target not set'}${item.unknown?'<span class="n-incomplete">'+(item.value===null?'Unknown':'Known values · partial')+'</span>':''}${!item.recorded?'<span class="n-incomplete">No food logged</span>':''}${item.estimated?'<span class="n-incomplete">Includes estimates</span>':''}${!item.unknown&&item.target!==null&&item.recorded&&exactValue(item)>item.target?'<span class="n-incomplete">'+number(exactValue(item)-item.target,digits)+' '+unit+' over target</span>':''}</div><div class="n-track" aria-hidden="true"><span style="width:${bar}%"></span></div></article>`;
    };
    const dayMarks=(w,unit,metric)=>`<div class="n-days n-progress-days">${w.days.map(d=>{
      const label=describe({...d,title:date(d.day),unit}),s=status(d),p=progress(d);
      return `<button type="button" class="n-day n-fitness-metric-day" data-action="tracking-day" data-value="${d.day}" aria-label="${esc(label)}" title="${esc(label)}"${d.future?' disabled':''}><span class="n-day-mark n-day-${s}" aria-hidden="true">${rings([{...d,key:metric}],true)}<span class="n-fitness-day-status">${s==='unknown'?'?':s==='partial'?'~':s==='unlogged'||s==='upcoming'?'—':d.value===0?'0':p===null?'•':p>=100?'✓':''}</span></span><span aria-hidden="true">${d.label}</span></button>`;
    }).join('')}</div>`;
    const weekly=(key,title,unit)=>{
      const w=m[key],metric={weekProtein:'protein',weekEnergy:'energy',weekCarbs:'carbs',weekFibre:'fibre',weekFat:'fat'}[key],digits=unit==='kcal'?0:1,c=w.comparison,item={key:metric,value:c.intake,target:c.target,recorded:c.days>0,unknown:w.unknown},p=progress(item);
      return `<section class="n-week n-week-graphic n-metric-${metric}" aria-label="Weekly ${title.toLowerCase()} progress"><div class="n-week-head"><h3>${title}</h3><span>${unit}</span></div><div class="n-week-body"><div class="n-week-ring n-fitness-week-ring" role="img" aria-label="${c.days?esc(number(c.intake,digits)+' of '+number(c.target,digits)+' '+unit+' across '+c.days+' logged days with saved targets'):'No recorded target comparison'}">${rings([item])}<span class="n-week-ring-inner n-fitness-week-center">${completion(item)}</span></div><div class="n-week-value"><div class="n-week-number">${w.value===null?'—':number(w.value,digits)}<small> ${unit}</small></div><div class="n-week-note">${w.value===null?'No known intake':w.unknown?'Known total · partial':'Logged this week'}</div>${c.days?`<div class="n-week-note">${number(c.intake,digits)} / ${number(c.target,digits)} ${unit}<br>on ${c.days} logged day${c.days===1?'':'s'} with targets</div>`:'<div class="n-week-note">No saved target comparison</div>'}${w.estimated?'<div class="n-week-note">Includes estimates</div>':''}${!w.unknown&&c.days&&c.intake>c.target?'<div class="n-week-note">Over target on recorded days</div>':''}</div></div>${dayMarks(w,unit,metric)}</section>`;
    };
    const p=m.weekPlantProgress,remaining=m.weekTarget===null||p.value===null?null:Math.max(0,m.weekTarget-m.weekPlants),message=remaining===null?'A little variety, each week':remaining===0?'Look at your variety grow!':`${remaining} new plant${remaining===1?'':'s'} to go!`,plantRing={key:'plants',value:p.value,target:m.weekTarget,recorded:p.loggedDays>0,unknown:p.unknown};
    const plantPanel=`<section class="n-week n-week-graphic n-metric-plants n-week-plants" aria-label="Nudge weekly plant progress"><div class="n-week-head"><h3>Plants</h3><span>Different types</span></div><div class="n-week-body"><div class="n-week-ring n-fitness-week-ring" role="img" aria-label="${p.value===null?'No known plant records':m.weekPlants+(m.weekTarget===null?'':' of '+m.weekTarget)+' different plants this week'}">${rings([plantRing])}<span class="n-mascot n-fitness-week-center"><img src="/assets/nudge.png" width="134" height="134" alt=""></span></div><div class="n-week-value"><div class="n-week-message">${message}</div><div class="n-week-number">${p.value===null?'—':m.weekPlants}${m.weekTarget===null?'':`<small> / ${m.weekTarget}</small>`}</div><div class="n-week-note">different plants this week${p.unknown?' · partial':''}</div><div class="n-week-note">${completion(plantRing)} of weekly target</div></div></div>${dayMarks(p,'plants','plants')}</section>`;
    const visible=m.tracking,targets=METRICS.filter(([tracking])=>visible.includes(tracking)).map(([,key,title,unit,glyph])=>target(key,title,unit,glyph)).join('');
    const panels=METRICS.filter(([tracking])=>visible.includes(tracking)).map(([,key,title,unit])=>weekly('week'+key[0].toUpperCase()+key.slice(1),title,unit)).join('');
    return `<p class="n-eyebrow">${esc(new Date(day+'T12:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'}))}</p><h1 class="n-title">Your daily goals</h1><p class="n-subtitle">Little steps. A healthier you.</p>${overview}${targets?`<div class="n-targets">${targets}</div>`:''}${visible.includes('plants')?`<div class="n-plants-below">${target('plants','Plants','types','sprout')}</div>`:''}<div class="n-section-head"><p class="n-caption n-logged-caption">From your logged meals${day===today&&m.targetModeLabel?'<br>'+m.targetModeLabel:''}</p>${targetButton}</div>${targetWarning}<h2 class="n-week-title">Your week with Nudge</h2><p class="n-caption">${esc(date(m.dateRange.start)+'–'+date(m.dateRange.end))} · Mon–Sun</p><div class="n-week-graphics">${panels}${visible.includes('plants')?plantPanel:''}</div><p class="n-caption n-progress-key">✓ Target reached · • Logged · ~ Partial · ? Unknown · — Not logged / upcoming</p><details class="n-week-about"><summary>About your progress</summary><p>Rings fill as food is logged. Percentages can exceed 100%; the number shows the full amount. Energy and fat are comparisons, not goals to exceed. Unlogged days stay blank and zero means a recorded zero. Partial totals include only known values. Weekly target comparisons use logged days with saved targets. Historical target not recorded means we cannot compare that day. Plant variety counts each named plant once per week.</p></details>`;
  }
  return {model,projection,screen,nutrientValue,progress,progressRatio,status,ringItems,calendarDays,compactSummary,compactReview,plantContribution};
})();
