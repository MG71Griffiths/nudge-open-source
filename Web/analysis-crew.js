// Original Nudge artwork, articulated for the waiting state. Animation never reports analysis progress.
window.NudgeAnalysisCrew = ({kind='product',stage='reading',states={}}={}) => {
  const route=kind==='barcode'?'barcode':kind==='meal'?'meal':kind==='food'?'food':'product';
  const labels={barcode:['Finding the product','Checking available facts','Calculating supported nutrition and frequency'],product:['Reading the label and ingredients','Checking source information','Calculating supported nutrition and frequency'],meal:['Identifying meal components','Estimating amounts and matching composition','Calculating supported nutrition and frequency'],food:['Reading your food photos','Checking available source information','Calculating supported nutrition and frequency']}[route];
  const steps=['reading','checking','calculating'];
  const allowed=['pending','running','complete','needs-input','failed','unavailable'];
  // A later stage alone never fabricates completion for an earlier operation.
  const statuses=steps.map(key=>allowed.includes(states[key])?states[key]:key===stage?'running':'pending');
  const words={'pending':'Waiting','running':'In progress','complete':'Complete','needs-input':'Needs input','failed':'Could not finish','unavailable':'Unavailable'};
  const active=labels[steps.includes(stage)?steps.indexOf(stage):0];
  const rows=labels.map((label,i)=>`<li data-crew-state="${statuses[i]}"><span class="nc-status-mark" aria-hidden="true">${statuses[i]==='complete'?'✓':statuses[i]==='running'?'…':statuses[i]==='needs-input'||statuses[i]==='failed'?'!':'○'}</span><span>${label}<small>${words[statuses[i]]}</small></span></li>`).join('');
  const face=`<g class="nc-blink"><ellipse cx="520" cy="585" rx="108" ry="122" fill="#aa70ef"/><ellipse cx="798" cy="512" rx="91" ry="106" fill="#b27cf3"/></g>`;
  const character=(role,card)=>`<g class="nc-actor nc-${role}"><g class="nc-pose"><svg width="84" height="84" viewBox="0 0 1280 1280"><g class="nc-foot nc-foot-left"><use href="#nc-original" clip-path="url(#nc-shoe-left)"/></g><g class="nc-foot nc-foot-right"><use href="#nc-original" clip-path="url(#nc-shoe-right)"/></g><use href="#nc-original" clip-path="url(#nc-body)"/><g class="nc-arm nc-arm-left"><use href="#nc-original" clip-path="url(#nc-hand-left)"/></g><g class="nc-arm nc-arm-right"><use href="#nc-original" clip-path="url(#nc-hand-right)"/></g>${face}</svg>${card?`<g class="nc-card"><rect x="45" y="46" width="29" height="22" rx="3"/><path d="M50 52h19m-19 5h13m-13 5h16"/></g>`:''}<g class="nc-surprise"><path d="M34 4v-7m9 9 4-6m-22 6-4-6"/></g></g></g>`;
  return `<div class="n-analysis-crew" data-crew-paused="${window.NudgeAnalysisMotion?.paused===true}"><svg class="nc-stage" viewBox="0 0 360 210" aria-hidden="true" focusable="false"><defs><image id="nc-original" href="/assets/nudge.png" width="1280" height="1280"/><clipPath id="nc-body"><path d="M270 605 254 413 397 276 365 78 691 61 712 274 912 310 949 463 976 672 939 981 833 1043 594 1050 444 1039 354 945 354 667Z"/></clipPath><clipPath id="nc-hand-left"><path d="M267 601 359 667 371 914 319 1006 189 1001 132 940 131 796Z"/></clipPath><clipPath id="nc-hand-right"><path d="M941 304 1211 302 1220 642 968 750 952 634 942 467Z"/></clipPath><clipPath id="nc-shoe-left"><rect x="330" y="1022" width="300" height="186"/></clipPath><clipPath id="nc-shoe-right"><rect x="635" y="1003" width="375" height="205"/></clipPath></defs><ellipse class="nc-floor nc-far-floor" cx="188" cy="133" rx="150" ry="8"/>${character('runner',true)}<ellipse class="nc-floor" cx="181" cy="178" rx="172" ry="10"/>${character('lead',true)}${character('friend',false)}${character('helper',true)}</svg><p class="nc-status" role="status" aria-live="polite">${active}…</p><button type="button" class="button secondary nc-pause" data-crew-toggle aria-pressed="${window.NudgeAnalysisMotion?.paused===true}">${window.NudgeAnalysisMotion?.paused?'Resume animation':'Pause animation'}</button><ol class="nc-status-rows" aria-label="Analysis steps">${rows}</ol></div>`;
};
// Decorative motion has no timer or request callback. Pause never changes analysis.
(()=>{
  const motion=window.NudgeAnalysisMotion={paused:false};
  const sync=()=>document.documentElement?.classList.toggle('n-analysis-hidden',Boolean(document.hidden));
  document.addEventListener?.('click',event=>{
    const button=event.target?.closest?.('[data-crew-toggle]');if(!button)return;
    motion.paused=!motion.paused;
    document.querySelectorAll('.n-analysis-crew').forEach(crew=>{
      crew.dataset.crewPaused=String(motion.paused);
      const control=crew.querySelector('[data-crew-toggle]');if(control){control.textContent=motion.paused?'Resume animation':'Pause animation';control.setAttribute('aria-pressed',String(motion.paused));}
    });
  });
  document.addEventListener?.('visibilitychange',sync);window.addEventListener?.('pagehide',()=>document.documentElement?.classList.add('n-analysis-hidden'));window.addEventListener?.('pageshow',sync);sync();
})();
