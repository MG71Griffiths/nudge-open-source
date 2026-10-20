window.WmdStreakMath = (() => {
  'use strict';
  const DAY = 86400000;
  function dayNumber(key) {
    if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    const time = Date.parse(key + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === key ? time / DAY : null;
  }
  const dayKey = number => new Date(number * DAY).toISOString().slice(0,10);
  const monday = number => number - ((new Date(number * DAY).getUTCDay() + 6) % 7);
  function analyse(completions, asOf) {
    const today = dayNumber(asOf);
    if (today === null) throw new Error('A valid current day is required');
    const days = Object.keys(completions || {}).filter(key => completions[key]).map(dayNumber)
      .filter(day => day !== null && day <= today).sort((a,b) => a-b);
    const done = new Set(days), runs = [];
    days.forEach((day,i) => { if (i && day === days[i-1]+1) runs[runs.length-1]++; else runs.push(1); });
    let current = 0, cursor = done.has(today) ? today : today-1;
    while (done.has(cursor)) { current++; cursor--; }
    return { today, done, total:days.length, current, best:Math.max(0,...runs), runs,
      milestones:[2,3,7].map(length => ({length,count:runs.filter(run => run >= length).length})) };
  }
  function week(model, start) {
    return Array.from({length:7},(_,i) => {
      const day = start+i;
      return {key:dayKey(day), day, status:day > model.today ? 'upcoming' : model.done.has(day) ? 'done' : day === model.today ? 'today' : 'missed'};
    });
  }
  return {dayNumber,dayKey,monday,analyse,week};
})();

window.createWmdStreaks = function(ctx) {
  'use strict';
  const {getState,view,button,nudge,todayKey,navigate,render} = ctx;
  const math = window.WmdStreakMath;
  const exampleDate = '2026-09-27';
  const exampleDays = Object.fromEntries(['2026-09-02','2026-09-03','2026-09-08','2026-09-10','2026-09-11','2026-09-16','2026-09-17','2026-09-18','2026-09-21','2026-09-25','2026-09-26','2026-09-27'].map(day => [day,true]));
  const modelFor = example => math.analyse(example ? exampleDays : getState().completions, example ? exampleDate : todayKey());
  const dateText = (day,options={day:'numeric',month:'short'}) => new Date(day * 86400000).toLocaleDateString('en-GB',{...options,timeZone:'UTC'});
  const rangeText = start => `${dateText(start)} – ${dateText(start+6,{day:'numeric',month:'short',year:'numeric'})}`;
  const statusText = {done:'Nudge day completed',missed:'No nudge logged',today:'Today, still time',upcoming:'Upcoming'};
  function weekStrip(model,start) {
    return `<ol class="nudge-week" aria-label="Nudge days, ${rangeText(start)}">${math.week(model,start).map((day,i) => `<li class="nudge-day ${day.status}" aria-label="${dateText(day.day,{weekday:'long',day:'numeric',month:'long'})}: ${statusText[day.status]}"><div class="nudge-day-art" aria-hidden="true">${day.status==='done'?'<img src="/assets/nudge.png" width="60" height="60" alt=""><span class="nudge-tick">✓</span>':day.status==='missed'?'<img src="/assets/burst-berry.webp" width="60" height="60" alt="">':`<span class="nudge-day-empty">${day.status==='today'?'·':'–'}</span>`}</div><span aria-hidden="true">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i]}</span></li>`).join('')}</ol>`;
  }
  function legend() { return '<p class="nudge-legend"><span><i class="legend-dot win"></i>Nudge = completed</span><span><i class="legend-dot berry"></i>Burst berry = no nudge logged</span></p>'; }
  function exampleWeekCard() {
    const model = modelFor(true);
    return `<section class="streak-week-card"><span class="pill purple">EXAMPLE · 21–27 SEP 2026</span><div class="streak-heading"><div><h2>Four days.<br>Four little wins.</h2><p>Life happened on the other three.<br>You still showed up four times.</p></div><span class="streak-total">4<small>NUDGE DAYS</small></span></div>${weekStrip(model,math.monday(model.today))}${legend()}<p class="streak-kind">A missed day never erases a good one.</p>${button('See Nudge streaks & progress','streak-open','primary','example')}</section>`;
  }
  function actualWeekStrip() { const model=modelFor(false); return `${weekStrip(model,math.monday(model.today))}${legend()}`; }
  function actualProgressCard() {
    const model=modelFor(false);
    return `<section class="card streak-preview"><span class="pill purple">YOUR NUDGE DAYS</span><h2>${model.current?`${model.current}-day streak. Keep it kind.`:'One little step starts a streak.'}</h2><p>${model.total} day${model.total===1?'':'s'} logged · best recorded streak: ${model.best}.</p>${button('See my Nudge progress','streak-open','secondary','actual')}</section>`;
  }
  function progressScreen() {
    const example=view.streakMode==='example', model=modelFor(example), start=math.monday(model.today);
    const offset=Number.isInteger(view.streakOffset)?Math.max(0,view.streakOffset):0;
    const weeks=Array.from({length:4},(_,i)=>{const monday=start-(offset+3-i)*7;return {start:monday,count:math.week(model,monday).filter(day=>day.status==='done').length};});
    const selected=weeks.some(w=>w.start===view.streakWeek)?view.streakWeek:weeks[3].start;
    const selectedWeek=math.week(model,selected), completed=selectedWeek.filter(day=>day.status==='done').length;
    const oldest=model.done.size?Math.min(...model.done):model.today;
    const olderAvailable=oldest<weeks[0].start;
    const delta=weeks[3].count-weeks[2].count;
    return `<button class="text-button back" data-action="navigate" data-value="${example?'food-week':'rhythm'}">${example?'Example weekly summary':'Your rhythm'}</button><p class="eyebrow">Little wins add up</p><h1>Your Nudge days.<br><span>Your kind of progress.</span></h1><div class="segmented"><button data-action="streak-mode" data-value="actual" aria-pressed="${!example}">My progress</button><button data-action="streak-mode" data-value="example" aria-pressed="${example}">Example</button></div><p class="small muted">${example?'Fictional example through 27 September 2026. It never changes your actual progress.':'Your recorded habits on this device. Tap “I did it!” on Home to add today’s Nudge day.'}</p><section class="streak-hero"><img src="/assets/nudge.png" width="135" height="135" alt="Nudge celebrating your small steps"><div><span class="eyebrow">CURRENT STREAK</span><strong>${model.current}<small>day${model.current===1?'':'s'}</small></strong><p>${model.current?'You’re finding your rhythm.':'A fresh start is always here.'}</p></div></section><div class="streak-stats"><div><strong>${model.best}</strong><span>Best recorded streak</span></div><div><strong>${model.total}</strong><span>Total Nudge days</span></div></div><section class="card streak-history"><h2>Your weeks, taking shape.</h2><p class="small muted">Nudge days each week · tap a week to explore.</p><div class="streak-chart" aria-label="Nudge days by week">${weeks.map(w=>`<button class="streak-bar-button" data-action="streak-week" data-value="${w.start}" aria-pressed="${selected===w.start}" aria-label="${rangeText(w.start)}: ${w.count} Nudge days"><span class="streak-bar-track"><span class="streak-bar-fill" style="height:${Math.max(5,w.count/7*100)}%"><b>${w.count}</b></span></span><span>${dateText(w.start)}</span></button>`).join('')}</div><div class="streak-history-nav"><button class="text-button" data-action="streak-older" ${olderAvailable?'':'disabled'}>Earlier weeks</button><button class="text-button" data-action="streak-newer" ${offset>0?'':'disabled'}>Recent weeks </button></div>${example&&offset===0?`<p class="streak-kind">${delta} more Nudge day than the week before. Small steps are adding up!</p>`:''}<div class="streak-selected" aria-live="polite"><p class="eyebrow">${rangeText(selected)}</p><h3>${completed} little win${completed===1?'':'s'} this week.</h3>${weekStrip(model,selected)}${legend()}</div></section><section class="card"><h2>Streaks you’ve built.</h2><p class="small muted">Consecutive days, one achievable nudge at a time.</p><div class="streak-milestones">${model.milestones.map(m=>`<div class="streak-milestone ${m.count?'earned':''}"><span class="streak-medal">${m.length}</span><b>${m.length}-day runs</b><span>${m.count} time${m.count===1?'':'s'}</span></div>`).join('')}</div><p class="small muted">Each run counts once at each milestone it reaches, including your current run. A 7-day run also reaches the 2-day and 3-day milestones.</p></section>${nudge('A berry day? It happens.<br><strong>Your next little win is still waiting.</strong>')}<details><summary>What makes a Nudge day?</summary><p>Complete the small habit you chose and tap “I did it!” on Home. Food, movement, sleep or a moment to unwind all count. There is at most one Nudge day per date.</p><p>Streaks count consecutive calendar days. Today stays open until midnight on your device, so an unfinished today does not break yesterday’s streak. Future days are upcoming; a burst berry only means no nudge was recorded on a past day.</p><p>These are habits you logged, not a judgement of your food or health. A scan or demo meal never completes a habit for you.</p><p class="small muted">${example?'This example uses invented records.':'Progress uses records retained in this browser, with up to 400 completion entries restored. It does not sync between devices; clearing local data clears this history.'}</p></details>${button(example?'Try my own Nudge days':'Choose today’s little step',example?'streak-open':'navigate','primary',example?'actual':'today')}`;
  }
  function handleAction(action,value) {
    if(action==='streak-open'||action==='streak-mode') {
      if(!['actual','example'].includes(value))return true;
      view.streakMode=value;view.streakOffset=0;view.streakWeek=null;
      if(action==='streak-open')navigate('nudge-progress');else render();
      return true;
    }
    if(action==='streak-week') {
      const model=modelFor(view.streakMode==='example'), latest=math.monday(model.today)-(view.streakOffset||0)*7, selected=Number(value);
      if(Number.isInteger(selected)&&selected>=latest-21&&selected<=latest&&(latest-selected)%7===0){view.streakWeek=selected;render();}
      return true;
    }
    if(action==='streak-older'||action==='streak-newer') {
      const model=modelFor(view.streakMode==='example'), oldest=model.done.size?Math.min(...model.done):model.today, offset=view.streakOffset||0;
      if(action==='streak-older'&&oldest<math.monday(model.today)-(offset+3)*7)view.streakOffset=offset+4;
      if(action==='streak-newer')view.streakOffset=Math.max(0,offset-4);
      view.streakWeek=null;render();return true;
    }
    return false;
  }
  return {exampleWeekCard,actualWeekStrip,actualProgressCard,progressScreen,handleAction};
};
