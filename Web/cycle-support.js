// Optional, device-local food support. Cycle dates never change intake, scores or targets.
window.NudgeCycle = (() => {
  'use strict';
  const phases = [
    {id:'period',name:'Period',label:'During your period',focus:'Make room for iron-containing foods.',text:'Include an iron-containing meal and a fruit or vegetable rich in vitamin C.',recipes:['chickpea'],why:'Chickpeas and other beans provide iron. Adequate iron matters throughout the month, including when you have periods.'},
    {id:'follicular',name:'Follicular',label:'After your period',focus:'Build on your everyday habits.',text:'Keep meals varied, with protein, plants and calcium-containing foods.',recipes:['berry','chickpea','salmon'],why:'There is no established special menu for this stage. These ideas support varied, balanced meals throughout the month.'},
    {id:'ovulation',name:'Ovulation',label:'Around ovulation',focus:'Keep your meals balanced.',text:'Let hunger and activity guide portions. Include protein, plants and wholegrains.',recipes:['salmon','chickpea'],why:'A special ovulation diet has not been established. These are everyday meal ideas, not a prediction of fertility.'},
    {id:'luteal',name:'Luteal',label:'Before your period',focus:'Make meals more satisfying.',text:'If you feel hungrier, add a satisfying snack or choose a larger meal. Keep calcium-containing foods in the mix.',recipes:['berry','chickpea'],why:'Your own appetite guides these suggestions. Yoghurt provides calcium; meals with protein and fibre can be satisfying.'}
  ];
  const choices = {hunger:['Less than usual','About usual','More than usual'],energy:['Low','Okay','Good'],cramps:['None','Mild','Disruptive'],bloating:['None','Mild','Uncomfortable'],bleeding:['None','Light','Usual','Heavy']};
  const labels = {hunger:'Hunger',energy:'Energy',cramps:'Cramps',bloating:'Bloating',bleeding:'Bleeding'};
  const regularity = [['unknown','Not set'],['regular','Usually regular'],['irregular','Irregular']];
  const contraception = [['unknown','Prefer not to say'],['none','None'],['copper','Copper coil'],['hormonal','Hormonal contraception']];
  const focusOptions=['Hunger','Energy','Cramps','Bloating'];
  const dateNumber = value => {
    if (typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const stamp=Date.parse(value+'T12:00:00Z');
    return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===value?Math.floor(stamp/86400000):null;
  };
  const validDate = value => dateNumber(value)!==null&&value>='1900-01-01';
  const checkValues = raw => Object.fromEntries(Object.entries(choices).filter(([key,options])=>options.includes(raw?.[key])).map(([key])=>[key,raw[key]]));
  function clean(raw) {
    const value=raw&&typeof raw==='object'?raw:{};
    const checks=new Map();
    for(const item of Array.isArray(value.checkins)?value.checkins:[]) if(item&&validDate(item.day)) checks.set(item.day,{day:item.day,...checkValues(item)});
    const start=validDate(value.start)?value.start:null;
    const periodStarts=[...new Set([...(Array.isArray(value.periodStarts)?value.periodStarts.filter(validDate):[]),...(start?[start]:[])])].sort();
    return {version:1,enabled:value.enabled===true,start,length:Number.isInteger(value.length)&&value.length>=21&&value.length<=45?value.length:null,regularity:regularity.some(([id])=>id===value.regularity)?value.regularity:'unknown',contraception:contraception.some(([id])=>id===value.contraception)?value.contraception:'unknown',focus:focusOptions.filter(x=>Array.isArray(value.focus)&&value.focus.includes(x)),periodStarts,checkins:[...checks.values()].sort((a,b)=>a.day.localeCompare(b.day))};
  }
  function phase(raw,day) {
    const c=clean(raw),dayN=dateNumber(day),startN=dateNumber(c.start),cycleDay=dayN!==null&&startN!==null?dayN-startN+1:null;
    const available=c.enabled&&c.regularity==='regular'&&['none','copper'].includes(c.contraception)&&c.length!==null&&cycleDay!==null&&cycleDay>=1&&cycleDay<=c.length;
    if(!available)return {estimated:false,id:null,cycleDay:cycleDay>0?cycleDay:null,remaining:null};
    const ovulation=c.length-14,index=cycleDay<=5?0:cycleDay<ovulation-1?1:cycleDay<=ovulation+1?2:3;
    return {estimated:true,id:phases[index].id,cycleDay,remaining:c.length-cycleDay+1};
  }
  const byId = id => phases.find(p=>p.id===id)||null;
  function context(raw,day) {
    const c=clean(raw),p=phase(c,day),stage=byId(p.id);
    let reason='';
    if(!c.enabled)reason='Cycle support is off.';
    else if(c.regularity==='irregular')reason='Your cycles are marked irregular, so dates do not give a reliable phase estimate.';
    else if(c.contraception==='hormonal')reason='With hormonal contraception, Nudge uses your check-ins instead of estimating a cycle phase.';
    else if(c.regularity!=='regular')reason='Set whether your cycles are usually regular to enable a phase estimate.';
    else if(!['none','copper'].includes(c.contraception))reason='Your contraception setting does not allow a phase estimate.';
    else if(!c.start||!c.length)reason='Add your last period start and usual cycle length to estimate your phase.';
    else if(!p.estimated)reason='Your saved dates do not cover today. Update your last period start when you know it.';
    return {...p,enabled:c.enabled,name:stage?.name||null,label:stage?.label||null,reason};
  }
  const recipeMatches = (recipeId,phaseId) => !byId(phaseId)||byId(phaseId).recipes.includes(recipeId);
  function micronutrients(entries,day) {
    const eaten=(Array.isArray(entries)?entries:[]).filter(e=>e&&e.day===day&&e.confirmedByUser!==false&&!e.deletedAt);
    return Object.fromEntries(['iron','calcium'].map(key=>{
      const known=eaten.filter(e=>typeof e[key+'MgPerPortion']==='number'&&Number.isFinite(e[key+'MgPerPortion'])&&e[key+'MgPerPortion']>=0&&typeof e.portions==='number'&&Number.isFinite(e.portions)&&e.portions>0);
      return [key,{value:known.length?Math.round(known.reduce((sum,e)=>sum+e[key+'MgPerPortion']*e.portions,0)*10)/10:null,known:known.length,unknown:eaten.length-known.length}];
    }));
  }
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function recipeFilters(selected='all') {
    const phaseId=byId(selected)?selected:'all';
    return `<details class="n-cycle-recipe-filter" ${phaseId!=='all'?'open':''}><summary>Cycle food ideas${phaseId!=='all'?' · '+esc(byId(phaseId).name):''}</summary><div class="recipe-filters" role="group" aria-label="Cycle phase">${[{id:'all',name:'Any phase'},...phases].map(p=>`<button type="button" data-action="recipe-phase" data-value="${p.id}" aria-pressed="${p.id===phaseId}">${p.name}</button>`).join('')}</div><p class="small muted">Everyday recipes to explore across your cycle. Your food requirements still apply.</p><button type="button" class="text-button" data-action="cycle-open">Your cycle support</button></details>`;
  }
  return {phases,choices,labels,regularity,contraception,focusOptions,clean,phase,context,byId,recipeMatches,recipeFilters,micronutrients,dateNumber,checkValues};
})();
window.createNudgeCycle = function(ctx) {
  'use strict';
  const {getState,view,save,render,navigate,showToast,escapeHtml:esc,todayKey,recipeBy}=ctx;
  const model=window.NudgeCycle, C=window.NudgeControls;
  const state=()=>model.clean(getState().cycleSupport);
  const B=(label,action,value='',primary=false)=>`<button type="button" class="button ${primary?'primary':'secondary'}" data-action="${action}" data-value="${esc(value)}">${label}</button>`;
  const back=()=>`<button type="button" class="text-button back" data-action="navigate" data-value="you">You</button>`;
  function persist(next,message='Saved on this device.') {
    const previous=getState().cycleSupport;
    getState().cycleSupport=model.clean(next);
    let saved=false;try{saved=save()!==false;}catch{}
    if(!saved){getState().cycleSupport=previous;view.cycleError='Could not save. Your previous choices are unchanged.';showToast(view.cycleError);return false;}
    view.cycleError='';if(message)showToast(message);return true;
  }
  function entryLink() {
    const c=state(),p=model.context(c,todayKey());
    return `<button type="button" class="n-cycle-entry" data-action="cycle-open"><span class="n-cycle-entry-icon">${window.NudgeIcons('calendar-days')}</span><span><strong>${p.estimated?'Estimated '+esc(p.name.toLowerCase())+' phase':'Cycle support'}</strong><small>${c.enabled?(p.estimated?'Day '+p.cycleDay+' · '+esc(p.label)+' · Meal ideas':'Phase not estimated · Food ideas and check-ins'):'Optional food ideas and check-ins'}</small></span><span aria-hidden="true">›</span></button>`;
  }
  function recipeRow(id,reason='') {
    const r=recipeBy(id);if(!r)return '';
    return `<button type="button" class="n-cycle-food" data-action="recipe-open" data-value="${esc(id)}">${r.image?`<img src="/assets/${esc(r.image)}" width="56" height="56" alt="">`:`<span class="n-cycle-entry-icon" aria-hidden="true">${window.NudgeIcons('utensils')}</span>`}<span><strong>${esc(r.name)}</strong><small>${esc(r.category)} · ${r.minutes} min</small>${reason?`<small>${esc(reason)}</small>`:''}</span><span aria-hidden="true">›</span></button>`;
  }
  function mealIdeas(chosen) {
    const search=window.NudgeSearchModel,catalogue=window.NudgeRecipeCatalogue;
    if(!search||!catalogue)return {html:'',count:0,note:'Recipe suggestions will appear when their ingredients can be checked against your saved food requirements.'};
    const requirements={...getState().nutritionProfile,avoidMilk:getState().avoidMilk===true};
    const items=catalogue.all({includeDrafts:true}).map(r=>search.normalize(r,{kind:'recipe'})).filter(Boolean);
    const compatible=items.filter(i=>search.safety(i,requirements).matches);
    const supported=chosen?compatible.filter(i=>search.supportMatch(i,chosen.id).matches):compatible;
    const suggested=(supported.length?supported:compatible).slice(0,3);
    const specific=Boolean(chosen&&supported.length);
    const reasons=[...new Set(items.map(i=>search.safety(i,requirements)).filter(c=>!c.matches).map(c=>c.reason))];
    return {count:suggested.length,html:suggested.map(i=>recipeRow(i.id,specific?search.supportMatch(i,chosen.id).reason:'Everyday meal idea')).join(''),note:!suggested.length?(reasons.length?'No matching recipes yet. '+reasons.join(' '):'No recipes are available yet.'):!specific&&chosen?'Everyday meal ideas shown. No compatible recipe meets this phase filter with a sourced '+(chosen.id==='period'?'iron':'calcium')+' amount per serving.':'Matched to your saved food requirements.'};
  }
  function screen() {
    const c=state(),p=model.context(c,todayKey()),explore=model.byId(view.cyclePhase),chosen=explore||model.byId(p.id),check=c.checkins.find(x=>x.day===todayKey()),hungry=check?.hunger==='More than usual';
    const ideas=mealIdeas(chosen);
    const nutrients=model.micronutrients(getState().foodLog?.entries,todayKey());
    return `<div class="n-cycle">${back()}<div class="n-section-head"><h1>Your cycle</h1><button class="text-button" type="button" data-action="cycle-settings">Edit</button></div><p class="n-subtitle">Food support that follows how you feel.</p>${!c.enabled?`<section class="n-cycle-panel"><h2>Explore food ideas</h2><p>Turn on cycle support for optional check-ins and an estimated stage.</p>${B('Set up cycle support','cycle-settings','',true)}</section>`:`<section class="n-cycle-stage"><p class="n-eyebrow">${explore?'Exploring this stage':p.estimated?'Your estimated phase':'Phase not estimated'}</p><h2>${chosen?esc(chosen.name)+' · '+esc(chosen.label.toLowerCase()):'Food ideas for how you feel'}</h2>${explore&&p.estimated?`<p>Current estimate: ${esc(p.name)} · Day ${p.cycleDay}</p>`:''}${!explore&&p.estimated?`<div class="n-cycle-day"><strong>Day ${p.cycleDay}</strong><span>Next period in about ${p.remaining} ${p.remaining===1?'day':'days'}</span></div>`:''}${!p.estimated&&!explore?`<p>${esc(p.reason)}</p>`:''}${chosen?`<div class="n-cycle-strip" aria-label="${esc(chosen.name)}">${model.phases.map(s=>`<span ${s.id===chosen.id?'class="active"':''}></span>`).join('')}</div>`:''}<p>${esc(chosen?.text||'Use your appetite and symptoms to guide food choices.')}</p></section>`}<div class="n-cycle-phases" role="group" aria-label="Explore cycle phases">${model.phases.map(s=>`<button type="button" class="button secondary" data-action="cycle-phase" data-value="${s.id}" aria-pressed="${chosen?.id===s.id}">${s.name}</button>`).join('')}</div>${explore&&p.estimated?B('Back to your estimated stage','cycle-phase','current'):''}${c.enabled?`<section class="n-cycle-panel"><h2>Your daily check-in</h2><p>${check&&Object.keys(model.checkValues(check)).length?esc(Object.entries(model.checkValues(check)).map(([key,value])=>model.labels[key]+': '+value).join(' · ')):'Hunger, energy, cramps and bloating. A few optional taps.'}</p>${B(check?'Update check-in':'How are you feeling?','cycle-checkin','',true)}</section>`:''}<section><h2>Meal ideas${chosen?' · '+esc(chosen.name):''}</h2><p class="n-caption">${esc(hungry?'You reported more hunger today. A satisfying snack or larger meal may suit you.':chosen?.focus||'Choose balanced meals that fit your appetite.')}</p><p class="n-caption">${esc(ideas.note)}</p>${ideas.html}${chosen?B('See '+esc(chosen.name.toLowerCase())+' recipes','cycle-recipes',chosen.id):B('Explore recipes','navigate','recipes')}</section>${c.enabled?`<section class="n-cycle-panel"><h2>Iron & calcium today</h2><p class="n-caption">From foods with available nutrient information.</p>${['iron','calcium'].map(key=>`<div class="n-cycle-nutrient"><span>${key==='iron'?'Iron':'Calcium'} logged</span><strong>${nutrients[key].value===null?'—':nutrients[key].value+' mg'}</strong></div>`).join('')}<p class="n-caption">${Object.values(nutrients).some(n=>n.value!==null)?'Partial totals · unavailable nutrients are not counted.':'Iron and calcium data are not available for your logged foods yet.'}</p></section>`:''}<details class="n-cycle-panel"><summary>Why these suggestions?</summary><p>${esc(chosen?.why||'Suggestions follow your check-in and everyday nutrition guidance.')}</p><p>Timing food choices to cycle stages is an emerging approach. Dates estimate a stage; they do not confirm ovulation or fertility.</p><p>Your saved targets and food scores stay the same.</p><p><a href="https://www.nhs.uk/conditions/vitamins-and-minerals/iron/" target="_blank" rel="noopener noreferrer">Iron guidance</a> · <a href="https://www.nhs.uk/conditions/vitamins-and-minerals/calcium/" target="_blank" rel="noopener noreferrer">Calcium guidance</a> · <a href="https://www.nhs.uk/conditions/periods/fertility-in-the-menstrual-cycle/" target="_blank" rel="noopener noreferrer">Cycle timing</a></p></details>${c.enabled?patterns(c):''}</div>`;
  }
  function patterns(c) {
    const checks=c.checkins.filter(x=>x.day<=todayKey()&&Object.keys(model.checkValues(x)).length),last=checks.slice(-7).reverse();
    return `<details class="n-cycle-panel"><summary>Your check-ins over time</summary><p>${checks.length?`${checks.length} ${checks.length===1?'day':'days'} recorded. Explore your recent check-ins below.`:'Your check-ins will appear here.'} Patterns can suggest associations; they cannot show that food caused a symptom.</p>${last.length?`<ul class="n-cycle-check-history">${last.map(x=>`<li><strong>${esc(new Date(x.day+'T12:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short'}))}</strong><span>${esc(Object.entries(model.checkValues(x)).map(([key,value])=>model.labels[key]+': '+value).join(' · '))}</span></li>`).join('')}</ul>`:''}</details>`;
  }
  function settingsScreen() {
    const c=state();
    return `<div class="n-cycle">${back()}<h1>Cycle support</h1><p class="n-subtitle">Optional. Valid changes save automatically on this device.</p><form id="cycle-settings-form"><label class="n-cycle-toggle"><span><strong>Enable cycle support</strong><small>Food ideas and optional daily check-ins</small></span><input type="checkbox" id="cycle-enabled" ${c.enabled?'checked':''} role="switch"></label><section class="n-cycle-panel"><label class="form-label" for="cycle-start">First day of your last period · optional</label><input class="field" type="date" id="cycle-start" value="${c.start||''}" min="1900-01-01" max="${todayKey()}"><label class="form-label" for="cycle-length">Usual cycle length · days, optional</label><input class="field" type="number" inputmode="numeric" id="cycle-length" min="21" max="45" step="1" value="${c.length??''}" placeholder="Not set"><p class="n-caption">Leave dates blank if you prefer suggestions based on how you feel.</p></section><section class="n-cycle-panel"><h2>Your cycle</h2>${C.choices({label:'Your cycle',items:model.regularity,value:c.regularity,action:'cycle-regularity'})}</section><section class="n-cycle-panel"><h2>Contraception</h2>${C.choices({label:'Contraception',items:model.contraception,value:c.contraception,action:'cycle-contraception'})}<p class="n-caption">With hormonal contraception or irregular cycles, support follows your check-ins.</p></section><section class="n-cycle-panel"><h2>What would you like support with?</h2><div class="nc-tag-group">${model.focusOptions.map(x=>`<button type="button" class="button secondary" data-action="cycle-focus" data-value="${x}" aria-pressed="${c.focus.includes(x)}">${x}</button>`).join('')}</div></section><p id="cycle-settings-error" class="field-error" role="alert">${esc(view.cycleError||'')}</p><details class="n-cycle-panel"><summary>Your choices and privacy</summary><p>Saved only on this device. Cycle details and check-ins are not sent with food photos or voice memos. Turning support off hides prompts and keeps your entries.</p></details>${B('Done','cycle-open','',true)}</form></div>`;
  }
  function checkinScreen() {
    if(!state().enabled)return screen();
    if(!view.cycleCheckDraft||view.cycleCheckDay!==todayKey()){view.cycleCheckDraft=model.checkValues(state().checkins.find(x=>x.day===todayKey()));view.cycleCheckDay=todayKey();}
    return `<div class="n-cycle"><button class="text-button back" type="button" data-action="cycle-open">Your cycle</button><h1>How are you feeling?</h1><p class="n-subtitle">Today · skip anything you don’t want to answer.</p>${Object.entries(model.choices).sort(([a],[b])=>Number(state().focus.includes(model.labels[b]))-Number(state().focus.includes(model.labels[a]))).map(([key,items])=>`<section class="n-cycle-panel"><h2>${model.labels[key]}</h2>${C.choices({label:model.labels[key],items:items.map(value=>[key+'|'+value,value]),value:key+'|'+(view.cycleCheckDraft[key]||''),action:'cycle-check-choice'})}</section>`).join('')}<div class="n-cycle-actions">${B('Cancel','cycle-open')}${B('Save check-in','cycle-check-save','',true)}</div><p class="field-error" role="alert">${esc(view.cycleError||'')}</p></div>`;
  }
  function handleAction(action,value) {
    if(action==='cycle-open'){view.cycleCheckDraft=null;view.cycleError='';navigate('cycle');return true;}
    if(action==='cycle-settings'){view.cycleError='';navigate('cycle-settings');return true;}
    if(action==='cycle-checkin'){if(state().enabled){view.cycleCheckDraft=model.checkValues(state().checkins.find(x=>x.day===todayKey()));view.cycleCheckDay=todayKey();navigate('cycle-checkin');}return true;}
    if(action==='cycle-phase'){view.cyclePhase=model.byId(value)?value:null;render();return true;}
    if(action==='cycle-recipes'){view.recipePhase=model.byId(value)?value:'all';view.recipeCategory='All';view.recipeTab='discover';navigate('recipes');return true;}
    if(action==='cycle-regularity'||action==='cycle-contraception'){
      const field=action==='cycle-regularity'?'regularity':'contraception';if(model[field].some(([id])=>id===value)){const c=state();c[field]=value;persist(c);render();}return true;
    }
    if(action==='cycle-focus'){if(model.focusOptions.includes(value)){const c=state();c.focus=c.focus.includes(value)?c.focus.filter(x=>x!==value):c.focus.concat(value);persist(c);render();}return true;}
    if(action==='cycle-check-choice'){const [key,choice]=String(value).split('|');if(model.choices[key]?.includes(choice)){view.cycleCheckDraft=view.cycleCheckDraft||{};if(view.cycleCheckDraft[key]===choice)delete view.cycleCheckDraft[key];else view.cycleCheckDraft[key]=choice;render();}return true;}
    if(action==='cycle-check-save'){if(!state().enabled)return true;if(view.cycleCheckDay!==todayKey()){view.cycleCheckDraft=null;showToast('It is a new day. Check today’s answers before saving.');render();return true;}const c=state(),answers=model.checkValues(view.cycleCheckDraft);c.checkins=c.checkins.filter(x=>x.day!==todayKey());if(Object.keys(answers).length)c.checkins.push({day:todayKey(),...answers});if(persist(c,Object.keys(answers).length?'Check-in saved.':'Today’s check-in cleared.')){view.cycleCheckDraft=null;navigate('cycle');}else render();return true;}
    return false;
  }
  function handleChange(target) {
    if(!['cycle-enabled','cycle-start','cycle-length'].includes(target?.id))return false;
    const c=state();let error='';
    if(target.id==='cycle-enabled')c.enabled=target.checked===true;
    if(target.id==='cycle-start'){if(target.value&&(model.dateNumber(target.value)===null||target.value>todayKey()))error='Choose a valid date on or before today.';else c.start=target.value||null;}
    if(target.id==='cycle-length'){const value=String(target.value??'').trim();if(value&&!/^\d+$/.test(value)||value&&(Number(value)<21||Number(value)>45))error='Use a whole number from 21 to 45 days, or leave this blank.';else c.length=value?Number(value):null;}
    if(error){view.cycleError=error;target.setAttribute?.('aria-invalid','true');const output=typeof document!=='undefined'?document.getElementById('cycle-settings-error'):null;if(output)output.textContent=error;return true;}
    target.removeAttribute?.('aria-invalid');if(persist(c))render();return true;
  }
  function handleSubmit(form) {if(form?.id!=='cycle-settings-form')return false;return true;}
  return {screen,settingsScreen,checkinScreen,handleAction,handleChange,handleSubmit,entryLink};
};
