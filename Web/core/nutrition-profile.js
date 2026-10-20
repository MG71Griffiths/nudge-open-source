/* Nutrition profile contract: pure target rules and saved-profile compatibility.
 * No DOM, storage, network or application state dependencies. The existing policy,
 * overrides and target-history schema are shared by browser and CommonJS callers.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.NudgeNutrition=api;
})(typeof window!=='undefined'?window:globalThis,() => {
  const goals={balance:'Eat well, simply',muscle:'Build muscle',preserve:'Protect muscle while losing weight'};
  const diets={any:'No preference set',mixed:'A bit of everything',vegetarian:'Vegetarian',vegan:'Vegan',pescatarian:'Pescatarian'};
  const care={unknown:'Choose an answer',none:'No special nutrition needs',glp1:'Weight-loss medication',clinical:'Clinician-guided nutrition'};
  const activity={unknown:'Choose my activity level',light:'Light · mostly sitting, some walking',moderate:'Moderate · regular walking and training',high:'High · lots of movement and training'};
  const sexes={unknown:'Not set',male:'Male',female:'Female'};
  const number=(n,min,max)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max?n:null;
  const choiceVersion='nudge_profile_v3_3';
  const goalChoices={...goals,muscle:'Gain muscle',stay_active:'Stay active',more_plants:'Eat more plants',less_sugar:'Cut back on added sugar',steady_routine:'Build a steady routine',movement:'Make time for movement',sleep:'Improve my sleep'};
  const trainingChoices={weight_training:'Weight training'};
  const habitChoices={protein:'More protein',fibre:'More fibre',vegetables:'More vegetables'};
  const trackingChoices={protein:'Protein',calories:'Energy',carbs:'Carbs',fat:'Fat',fibre:'Fibre',plants:'Weekly plants'};
  const glutenChoices={unknown:'Not specified',coeliac:'Coeliac disease',sensitivity:'Gluten sensitivity/intolerance'};
  const allergyChoices={milk:'Milk',fish:'Fish',nuts:'Nuts',gluten:'Cereals containing gluten',eggs:'Eggs',sesame:'Sesame',soy:'Soya'};
  const onboardingGoals={'Eat more plants':'more_plants','Cut back on added sugar':'less_sugar','Build a steady routine':'steady_routine','Make time for movement':'movement','Improve my sleep':'sleep'};
  const list=raw=>Array.isArray(raw)?[...new Set(raw.filter(x=>typeof x==='string'&&x.length>0&&x.length<=160))]:[];
  const tracking=(raw,version)=>{if(!Array.isArray(raw))return Object.keys(trackingChoices);const values=list(raw),previousDefault=values.length===5&&['protein','calories','carbs','fibre','plants'].every(key=>values.includes(key)),legacyDefault=version!=='nudge_profile_v3_2'&&values.length===4&&['protein','calories','plants','fibre'].every(key=>values.includes(key));return version!==choiceVersion&&(previousDefault||legacyDefault)?Object.keys(trackingChoices):values;};
  const dayValid=day=>typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T12:00:00Z'))&&new Date(day+'T12:00:00Z').toISOString().slice(0,10)===day;
  function clean(raw={}) {
    raw=raw&&typeof raw==='object'?raw:{};
    // Keep fields we do not yet understand, including retired choice identifiers.
    // Reading a legacy profile never writes or changes its target calculation.
    return {...raw,saved:raw.saved===true,goal:Object.hasOwn(goals,raw.goal)?raw.goal:'balance',age:Number.isInteger(raw.age)?number(raw.age,18,110):null,weight:number(raw.weight,35,250),height:number(raw.height,100,230),sex:Object.hasOwn(sexes,raw.sex)?raw.sex:'unknown',activity:Object.hasOwn(activity,raw.activity)?raw.activity:'unknown',sessions:Number.isInteger(raw.sessions)?number(raw.sessions,1,7):null,diet:Object.hasOwn(diets,raw.diet)?raw.diet:'any',care:Object.hasOwn(care,raw.care)?raw.care:'unknown',target:number(raw.target,20,250),calorieTarget:number(raw.calorieTarget,1200,6000),carbTarget:number(raw.carbTarget,0,1000),fatTarget:number(raw.fatTarget,0,300),dailyPlantTarget:Number.isInteger(raw.dailyPlantTarget)?number(raw.dailyPlantTarget,1,40):null,fibreTarget:number(raw.fibreTarget,1,100),avoids:list(raw.avoids),
      goals:Array.isArray(raw.goals)?list(raw.goals):raw.saved&&Object.hasOwn(goals,raw.goal)?[raw.goal]:[],trainingTypes:list(raw.trainingTypes),habits:list(raw.habits),tracking:tracking(raw.tracking,raw.choiceVersion),
      glutenRequirement:Object.hasOwn(glutenChoices,raw.glutenRequirement)?raw.glutenRequirement:'unknown',glutenFreePreference:raw.glutenFreePreference===true,allergies:list(raw.allergies),allergiesAnswered:raw.allergiesAnswered===true,
      foodPreferences:{...(raw.foodPreferences&&typeof raw.foodPreferences==='object'?raw.foodPreferences:{}),dislikes:list(raw.foodPreferences?.dislikes),cuisines:list(raw.foodPreferences?.cuisines)},
      weeklyPlantTarget:[10,20,30].includes(raw.weeklyPlantTarget)?raw.weeklyPlantTarget:null,
      targetHistory:Array.isArray(raw.targetHistory)?raw.targetHistory.filter(x=>x&&dayValid(x.effectiveFrom)).map(x=>({...x,targets:{...x.targets}})):[],
      legacyChoices:{...(raw.legacyChoices||{}),...Object.fromEntries(Object.entries({goal:goals,sex:sexes,activity,diet:diets,care,glutenRequirement:glutenChoices}).filter(([key,values])=>typeof raw[key]==='string'&&!Object.hasOwn(values,raw[key])).map(([key])=>[key,raw[key]]))}
    };
  }
  function safetyProfile(raw){
    // Safety does not depend on dated nutrition targets. Keep the same field
    // validation as clean(), without rebuilding a profile for every food row.
    const p=raw&&typeof raw==='object'?raw:{};
    return {glutenRequirement:Object.hasOwn(glutenChoices,p.glutenRequirement)?p.glutenRequirement:'unknown',glutenFreePreference:p.glutenFreePreference===true,
      allergies:list(p.allergies),allergiesAnswered:p.allergiesAnswered===true,avoids:list(p.avoids),diet:Object.hasOwn(diets,p.diet)?p.diet:'any'};
  }
  function draft(raw,legacy={},plantGoal=null){const p=clean(raw);if(p.schemaVersion>=2)return JSON.parse(JSON.stringify({...p,choiceVersion}));const t=target(p),e=calories(p);return {...p,schemaVersion:2,choiceVersion,target:p.target??t.grams,calorieTarget:p.calorieTarget??e.kcal,weeklyPlantTarget:p.weeklyPlantTarget??(p.saved&&[10,20,30].includes(plantGoal)?plantGoal:null),targetSources:{...(p.targetSources||{}),...(p.target===null&&t.grams!==null?{protein:'preserved legacy target'}:{}),...(p.calorieTarget===null&&e.kcal!==null?{calories:'preserved legacy target'}:{})},goals:[...new Set([...p.goals,...(legacy.edited?list(legacy.goals).map(x=>onboardingGoals[x]||x):[])])],foodPreferences:{...p.foodPreferences,...(legacy.edited?{mealPlanning:legacy.cooking}:{}),legacyOnboarding:legacy.edited?{...legacy}:null}};}
  const targetValues=p=>({protein:p.target,calories:p.calorieTarget,carbs:p.carbTarget,fat:p.fatTarget,fibre:p.fibreTarget,plants:p.weeklyPlantTarget,dailyPlants:p.dailyPlantTarget});
  const automaticTargetVersion='nudge_profile_targets_v2';
  const targetFields={protein:'target',calories:'calorieTarget',carbs:'carbTarget',fat:'fatTarget',fibre:'fibreTarget',plants:'weeklyPlantTarget',dailyPlants:'dailyPlantTarget'};
  const automaticMetrics=['protein','calories','carbs','fat','fibre','plants'];
  const targetReferences={protein:'https://link.springer.com/article/10.1186/s12970-017-0177-8',adultProtein:'https://www.merseycare.nhs.uk/protein-packing',fibre:'https://www.nhs.uk/live-well/eat-well/digestive-health/how-to-get-more-fibre-into-your-diet/',calories:'https://pubmed.ncbi.nlm.nih.gov/2305711/',carbs:'https://www.gov.uk/government/publications/sacn-statement-on-expressing-fat-and-carbohydrate-recommendations/sacn-statement-on-expressing-energy-fat-and-carbohydrate-intakes-and-recommendations'};
  function automaticSuggestions(raw){
    const p=clean(raw),reason=!p.saved?'Save your personal details':!p.age?'Add your age':['glp1','clinical'].includes(p.care)?'Use your agreed nutrition plan':null;
    const unavailable=why=>({value:null,reason:why,method:null,inputs:{},sourceURL:null});
    const out=Object.fromEntries(automaticMetrics.map(metric=>[metric,unavailable(reason)]));
    if(reason)return out;
    out.plants={value:30,reason:'Nudge weekly variety goal',method:'Optional Nudge variety goal: 30 different plants per week',inputs:{goal:'food variety'},sourceURL:null};
    const resistance=p.trainingTypes.includes('weight_training')||p.goals.includes('muscle')||p.goals.includes('preserve')||p.goal==='muscle'||p.goal==='preserve';
    const factor=resistance?1.6:.75;
    out.protein=p.weight?{value:number(Math.round(p.weight*factor),20,250),reason:'Starting target',method:resistance?'Exercising-adult protein: body weight × 1.6 g/kg':'Adult protein: body weight × 0.75 g/kg',inputs:{weightKg:p.weight,gramsPerKg:factor,trainingTypes:p.trainingTypes.filter(value=>value==='weight_training'),goals:p.goals.filter(value=>['muscle','preserve'].includes(value)),goal:['muscle','preserve'].includes(p.goal)?p.goal:'balance'},sourceURL:resistance?targetReferences.protein:targetReferences.adultProtein}:unavailable('Add your weight');
    if(out.protein.value===null&&p.weight)out.protein=unavailable('Use a personalised protein plan');
    out.fibre={value:30,reason:'UK adult daily target',method:'UK adult fibre reference: 30 g/day',inputs:{ageYears:p.age,reference:'UK adults'},sourceURL:targetReferences.fibre};
    // An unanswered optional nutrition context does not block general adult estimates.
    // Explicit clinical and medication contexts have already been excluded above.
    const e=calories({...p,schemaVersion:1,care:'none'});
    out.calories=e.kcal!==null?{value:e.kcal,reason:'Estimated maintenance energy',method:'Mifflin–St Jeor resting energy × selected activity factor, rounded to 50 kcal',inputs:{weightKg:p.weight,heightCm:p.height,ageYears:p.age,sex:p.sex,activity:p.activity,activityFactor:e.factor,restingKcal:e.resting,goalPolicy:'maintenance; no automatic surplus or deficit'},sourceURL:targetReferences.calories}:unavailable(e.reason);
    // Automatic macro targets share the active energy budget. Explicit overrides remain authoritative.
    const active=(metric,estimate)=>p.targetModes?.[metric]==='manual'||p[targetFields[metric]]!==null&&p.targetModes?.[metric]!=='automatic'?p[targetFields[metric]]:estimate;
    const energy=active('calories',out.calories.value),protein=active('protein',out.protein.value);
    out.fat=energy===null?unavailable('Complete your energy profile or set an energy target'):{value:Math.round(energy*.3/9),reason:'30% of daily energy',method:'Nudge starting guide: 30% of daily energy ÷ 9 kcal/g; within EFSA’s 20–35% adult reference range',inputs:{energyKcal:energy,energyFraction:.3,kcalPerGram:9},sourceURL:'https://www.efsa.europa.eu/en/press/news/nda100326'};
    const fat=active('fat',out.fat.value),remaining=energy===null||protein===null||fat===null?null:energy-protein*4-fat*9;
    out.carbs=energy===null?unavailable('Complete your energy profile or set an energy target'):protein===null||fat===null?unavailable('Complete your protein and fat targets'):remaining<0?unavailable('Protein and fat targets exceed your energy target'):{value:Math.round(remaining/4),reason:'Remaining daily energy after protein and fat',method:'Nudge macro-budget guide: (daily energy − protein × 4 kcal/g − fat × 9 kcal/g) ÷ 4 kcal/g',inputs:{energyKcal:energy,proteinGrams:protein,fatGrams:fat,remainingEnergyKcal:remaining,kcalPerGram:4},sourceURL:'https://www.efsa.europa.eu/en/press/news/nda100326'};
    if(out.carbs.value!==null&&number(out.carbs.value,0,1000)===null)out.carbs=unavailable('Use a personalised carbohydrate plan');
    return out;
  }
  function applyAutomaticTargets(raw){
    let p=clean(raw);if(!p.saved)return p;
    p={...p,schemaVersion:2,targetModes:{...p.targetModes},targetSources:{...p.targetSources},targetSourceDetails:{...p.targetSourceDetails}};
    const suggestions=automaticSuggestions(p);
    for(const metric of automaticMetrics){
      const field=targetFields[metric],mode=p.targetModes[metric];
      if(mode==='manual'||mode!=='automatic'&&p[field]!==null){p.targetModes[metric]='manual';continue;}
      const estimate=suggestions[metric];p[field]=estimate.value;p.targetModes[metric]='automatic';
      p.targetSources[metric]=estimate.value===null?'Automatic target awaiting profile details':'Automatic profile-based target';
      p.targetSourceDetails[metric]={policyVersion:automaticTargetVersion,status:estimate.value===null?'pending':'automatic',method:estimate.method,inputs:estimate.inputs,sourceURL:estimate.sourceURL,reason:estimate.reason};
    }
    return p;
  }
  function recordTargets(p,previous,day,source){
    const history=clean(previous).targetHistory.map(x=>({...x,targets:{...x.targets}})),values=targetValues(p),last=history.at(-1);
    const valueChanged=!last||Object.keys(values).some(k=>last.targets[k]!==values[k]);
    const old=clean(previous),provenanceChanged=automaticMetrics.some(metric=>JSON.stringify(old.targetSourceDetails?.[metric])!==JSON.stringify(p.targetSourceDetails?.[metric])||old.targetModes?.[metric]!==p.targetModes?.[metric]);
    if(valueChanged||provenanceChanged)history.push({id:'targets-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),effectiveFrom:day,targets:values,targetModes:{...p.targetModes},targetSources:{...p.targetSources},targetSourceDetails:JSON.parse(JSON.stringify(p.targetSourceDetails||{})),source,policy:'local_calendar_day_v1'});
    return {...p,targetHistory:history};
  }
  function reconcileAutomaticTargets(raw,day){
    if(!dayValid(day))throw new Error('Choose a valid local save date.');
    if(!raw?.saved)return {profile:raw,changed:false};
    const next=applyAutomaticTargets(raw),changed=JSON.stringify(next)!==JSON.stringify(raw);
    return {profile:changed?recordTargets(next,raw,day,'automatic profile targets'):raw,changed};
  }
  function saveDraft(raw,previous,day){
    if(!dayValid(day))throw new Error('Choose a valid local save date.');
    let p=clean({...raw,saved:true,schemaVersion:2,choiceVersion}),before=clean(previous);
    p={...p,targetModes:{...p.targetModes},targetSources:{...p.targetSources},targetSourceDetails:{...p.targetSourceDetails}};
    for(const [metric,field] of Object.entries(targetFields))if(p[field]!==before[field]&&p.targetModes[metric]===before.targetModes?.[metric]){
      p.targetModes[metric]='manual';p.targetSources[metric]='User-entered target';delete p.targetSourceDetails[metric];
    }
    p=applyAutomaticTargets(p);
    return recordTargets(p,before,day,'profile target update');
  }
  function targetRecord(history,day){
    let record;
    // Equal dates deliberately keep the last saved row, matching stable sort.
    for(const row of history)if(row.effectiveFrom<=day&&(!record||row.effectiveFrom>=record.effectiveFrom))record=row;
    return record;
  }
  function targetFromRecord(record,metric){
    if(!record)return {value:null,known:false,reason:'Historical target not recorded'};
    const value=record.targets[metric];return {value:typeof value==='number'&&Number.isFinite(value)?value:null,known:Object.hasOwn(record.targets,metric),effectiveFrom:record.effectiveFrom,source:record.source};
  }
  function targetAt(raw,day,metric){return targetFromRecord(targetRecord(clean(raw).targetHistory,day),metric);}
  function targetReader(raw){
    // An isolated projection snapshot, never a cache shared across profile edits.
    const history=clean(raw).targetHistory,records=new Map();
    return (day,metric)=>{if(!records.has(day))records.set(day,targetRecord(history,day));return targetFromRecord(records.get(day),metric);};
  }
  // One dated source for compact Today and food-review comparisons. Keep the
  // established prospective history policy: current targets never backfill days.
  function effectiveTargets(raw,day,today,plantGoal=null){
    const p=clean(raw),current={...targetValues(p),protein:target(p).grams,calories:calories(p).kcal,
      plants:p.schemaVersion>=2?p.weeklyPlantTarget:p.saved&&[10,20,30].includes(plantGoal)?plantGoal:null};
    const record=targetRecord(p.targetHistory,day);
    const modes=record?record.targetModes||{}:p.targetModes||{};
    const out={};
    for(const metric of [...automaticMetrics,'dailyPlants']){
      const dated=p.targetHistory.length?targetFromRecord(record,metric):{value:day===today?current[metric]??null:null,known:day===today};
      const value=typeof dated.value==='number'&&Number.isFinite(dated.value)&&dated.value>0?dated.value:null;
      out[metric]={...dated,value,mode:modes[metric]||(value!==null?'manual':null),targetRole:['calories','carbs','fat'].includes(metric)?'reference':'goal',targetLabel:['calories','carbs','fat'].includes(metric)?'Reference':'Target'};
    }
    // A daily pacing guide uses only a weekly goal recorded for this date.
    // It is a display comparison, never a new saved target or a weekly sum.
    if(out.dailyPlants.value===null&&out.plants.known&&out.plants.value!==null){
      out.dailyPlants={value:Math.ceil(out.plants.value/7),known:true,mode:'pacing',targetRole:'guide',targetLabel:'Daily variety guide',guideWeeklyTarget:out.plants.value,
        referenceNote:`Daily pacing guide: ${Math.ceil(out.plants.value/7)} types from your ${out.plants.value}-plant weekly goal. Repeated plants count once today and once across the week; daily counts are not added together.`};
    }
    // Population food-label references are distinct from personal dated targets.
    // Total sugars must never be compared with the 30 g FREE-sugars limit.
    out.salt={value:6,known:true,mode:'reference',targetRole:'limit',targetLabel:'Daily limit',source:'Existing adult salt policy'};
    for(const [metric,reference] of [['sugars',90],['saturatedFat',20]]){
      let dated=p.targetHistory.length?targetFromRecord(record,metric):{value:null,known:false};
      if(!dated.known&&day===today&&p.saved)dated={value:p[metric+'Target'],known:true,source:'Current saved reference'};
      const custom=typeof dated.value==='number'&&Number.isFinite(dated.value)&&dated.value>0;
      out[metric]={...(custom?dated:{}),value:custom?dated.value:reference,known:true,mode:'reference',targetRole:'reference',targetLabel:custom?'Saved reference':'Adult label reference',referenceKind:custom?'saved_reference':'adult_label',
        source:custom?(dated.effectiveFrom?'Saved dated reference':'Current saved reference'):'UK adult food-label reference intake',sourceURL:custom?null:'https://www.nhsinform.scot/healthy-living/food-and-nutrition/food-packaging/food-labelling/',
        referenceNote:metric==='sugars'?'Total sugars include natural sugars in milk and fruit. This reference is not a goal to reach and is not the 30 g free-sugars limit.':'Saturated fat uses a reference amount, not a goal to reach. A fuller ring means more consumed, not a healthier result.'};
    }
    const active=new Set(automaticMetrics.map(k=>out[k].mode).filter(mode=>['automatic','manual'].includes(mode)));
    const pending=automaticMetrics.some(k=>out[k].mode==='automatic'&&out[k].value===null);
    const modeLabel=day<today&&!record?'Historical targets not recorded':active.size>1?'Automatic + custom targets':active.has('automatic')?pending?'Automatic targets · profile details needed':'Targets from your profile & goals · Automatic':active.has('manual')?'Custom targets':pending?'Automatic targets · profile details needed':'Targets unavailable';
    return {targets:out,modeLabel};
  }
  function suggested(raw){const p=clean({...raw,schemaVersion:1,saved:true,goal:list(raw.goals).includes('muscle')?'muscle':raw.goal});return {protein:target(p),calories:calories(p)};}
  function healthStatus(raw,available=false){if(!available)return {state:'unavailable',label:'Not connected',detail:'Apple Health is not connected in this version. No fitness data has been imported.'};const state=['connected','partial','denied','disconnected','no_data'].includes(raw?.state)?raw.state:'disconnected';return {state,label:{connected:'Connected',partial:'Partial access',denied:'Access denied',disconnected:'Not connected',no_data:'Connected · no data'}[state],detail:{connected:'Only authorised data can be imported.',partial:'Some requested data are not available.',denied:'Access is not enabled.',disconnected:'No fitness data imported.',no_data:'No authorised measurements are available yet.'}[state],updatedAt:typeof raw?.updatedAt==='string'?raw.updatedAt:null};}
  const inventory={version:choiceVersion,source:'v3.1 confirmed examples plus existing app choices',completePrototypeParity:false,groups:[
    {id:'stats',label:'Personal details',selection:'optional numbers; exclusive sex',choices:sexes,source:'existing age, kg, cm and energy calculation inputs'},
    {id:'goals',label:'Goals',selection:'multiple',choices:goalChoices,source:'v3.1 + existing nutrition goals + WmdProfile goals'},
    {id:'activity',label:'Activity',selection:'separate groups',choices:trainingChoices,everyday:activity,sessions:{min:1,max:7,step:1},source:'v3.1 weight training + existing activity and bounds'},
    {id:'requirements',label:'Food requirements',selection:'exclusive gluten condition; independent allergies',choices:glutenChoices,allergies:allergyChoices,source:'v3.1 requirements + existing supported allergen matcher'},
    {id:'habits',label:'Healthy habits',selection:'multiple',choices:habitChoices,source:'v3.1'},
    {id:'tracking',label:'Tracking & targets',selection:'multiple',choices:trackingChoices,source:'v3.1; existing numeric bounds; weekly plant choices 10/20/30'},
    {id:'preferences',label:'Food preferences',selection:'exclusive eating style; independent other preferences',choices:diets,source:'existing diet/avoid/onboarding cooking choices',missing:['reviewed dislikes choices','reviewed cuisines choices','complete meal-planning choices']},
    {id:'fitness',label:'Fitness data',selection:'actual connection state',source:'existing Apple Health unavailable state'}
  ]};
  function target(raw){const p=clean(raw);if(p.schemaVersion>=2)return {grams:p.saved?p.target:null,kind:p.targetModes?.protein==='automatic'?'automatic':['glp1','clinical'].includes(p.care)?'agreed':'saved',reason:p.target!==null?p.targetModes?.protein==='automatic'?'Automatic profile target':'Your saved target':p.targetSourceDetails?.protein?.reason||'Set a target',source:p.targetSources?.protein||'User-entered target'};if(!p.saved||!p.age)return {grams:null,reason:'Add your details'};if(p.care==='glp1'||p.care==='clinical')return {grams:p.target,kind:'agreed',reason:p.target?'Your agreed target':'Add your agreed protein target'};if(p.goal==='muscle'&&p.care==='none'&&p.weight)return {grams:Math.round(p.weight*1.6),low:Math.round(p.weight*1.4),high:Math.round(p.weight*2),kind:'guide',reason:'Daily protein target'};return {grams:null,reason:p.goal==='muscle'?'Finish your profile':'Choose a protein plan'};}
  function calories(raw){const p=clean(raw);if(p.schemaVersion>=2)return {kcal:p.saved?p.calorieTarget:null,kind:p.targetModes?.calories==='automatic'?'automatic':['glp1','clinical'].includes(p.care)?'agreed':'saved',reason:p.calorieTarget!==null?p.targetModes?.calories==='automatic'?'Estimated maintenance energy':'Your saved target':p.targetSourceDetails?.calories?.reason||'Set a target',source:p.targetSources?.calories||'User-entered target',resting:p.targetSourceDetails?.calories?.inputs?.restingKcal,factor:p.targetSourceDetails?.calories?.inputs?.activityFactor};if(!p.saved||!p.age)return {kcal:null,reason:'Add your details'};if(p.care==='glp1'||p.care==='clinical')return {kcal:p.calorieTarget,kind:'agreed',reason:p.calorieTarget?'Your agreed target':'Add your agreed calorie target'};if(p.care!=='none')return {kcal:null,reason:'Confirm your nutrition needs'};const missing=[!p.weight&&'weight',!p.height&&'height',p.sex==='unknown'&&'sex',p.activity==='unknown'&&'activity'].filter(Boolean);if(missing.length)return {kcal:null,reason:'Add '+missing.join(', ')};const resting=9.99*p.weight+6.25*p.height-4.92*p.age+(p.sex==='male'?5:-161),factor={light:1.4,moderate:1.6,high:1.8}[p.activity],kcal=Math.round(resting*factor/50)*50;return kcal<1200||kcal>6000?{kcal:null,reason:'Use a personalised nutrition plan'}:{kcal,resting:Math.round(resting),factor,kind:'estimate',reason:'Estimated daily energy'};}
  function carbs(raw){const p=clean(raw);return {grams:p.saved?p.carbTarget:null,kind:p.targetModes?.carbs==='automatic'?'automatic':'saved',reason:p.carbTarget!==null?p.targetModes?.carbs==='automatic'?'Automatic starting guide':'Your saved target':p.targetSourceDetails?.carbs?.reason||'Set a target',source:p.targetSources?.carbs||'User-entered target'};}
  function fat(raw){const p=clean(raw);return {grams:p.saved?p.fatTarget:null,kind:p.targetModes?.fat==='automatic'?'automatic':'saved',reason:p.fatTarget!==null?p.targetModes?.fat==='automatic'?'Automatic starting guide':'Your saved target':p.targetSourceDetails?.fat?.reason||'Set a target',source:p.targetSources?.fat||'User-entered target'};}
  function macroBudget(raw){
    const p=clean(raw),energy=p.calorieTarget,values=[p.target===null?null:p.target*4,p.carbTarget===null?null:p.carbTarget*4,p.fatTarget===null?null:p.fatTarget*9],known=values.filter(value=>value!==null),total=known.reduce((sum,value)=>sum+value,0),complete=known.length===values.length,difference=energy===null?null:Math.round(total-energy);
    return {energyKcal:energy,macroKcal:Math.round(total),complete,known:known.length,differenceKcal:difference,state:energy===null?'incomplete':difference>10?'over':!complete?'incomplete':difference< -10?'under':'balanced'};
  }
  function summary(entries,day){const list=entries.filter(e=>e.day===day),known=list.filter(e=>typeof e.proteinPerPortion==='number'&&Number.isFinite(e.proteinPerPortion)),energy=list.filter(e=>typeof e.energyPerPortion==='number'&&Number.isFinite(e.energyPerPortion)),carbohydrates=list.filter(e=>e.nutritionSnapshot?.carbohydrate?.portionStatus==='calculated'&&typeof e.nutritionSnapshot?.carbohydrate?.portion==='number'&&Number.isFinite(e.nutritionSnapshot.carbohydrate.portion)&&e.nutritionSnapshot.carbohydrate.portion>=0);return {grams:Math.round(known.reduce((n,e)=>n+e.proteinPerPortion*e.portions,0)*10)/10,known:known.length,unknown:list.length-known.length,meals:list.length,calories:Math.round(energy.reduce((n,e)=>n+e.energyPerPortion*e.portions,0)),calorieKnown:energy.length,calorieUnknown:list.length-energy.length,carbs:Math.round(carbohydrates.reduce((n,e)=>n+e.nutritionSnapshot.carbohydrate.portion*e.portions,0)*10)/10,carbKnown:carbohydrates.length,carbUnknown:list.length-carbohydrates.length};}
  // A reviewable draft from the details shared in this conversation; never saved on page load.
  const preview=()=>clean({saved:true,goal:'muscle',age:55,weight:78,height:186,sex:'male',activity:'moderate',diet:'mixed',care:'none'});
  return {clean,target,calories,carbs,fat,macroBudget,summary,goals,diets,care,activity,sexes,preview,choiceVersion,goalChoices,trainingChoices,habitChoices,trackingChoices,glutenChoices,allergyChoices,inventory,safetyProfile,draft,saveDraft,targetAt,targetReader,targetValues,effectiveTargets,suggested,healthStatus,automaticSuggestions,reconcileAutomaticTargets,automaticMetrics,targetFields,automaticTargetVersion,example:preview,glpExample:()=>clean({saved:true,goal:'preserve',age:55,weight:78,diet:'mixed',care:'glp1'})};
});
