(() => {
  'use strict';
  const app = document.getElementById('app');
  const dialog = document.getElementById('app-dialog');
  const dialogContent = document.getElementById('dialog-content');
  const toastElement = document.getElementById('toast');
  const key = 'wmd-nudge-prototype-v1';
  const screens = ['today', 'history', 'food', 'rhythm', 'together', 'you', 'ai', 'meal', 'review', 'camera', 'profile', 'meal-scan', 'meal-prompt', 'meal-result', 'food-week', 'chocolate', 'nudge-progress', 'food-patterns', 'food-entry', 'barcode', 'label-photo', 'recipes', 'search', 'recipe-detail','cacao','rewards','food-context','food-fit','meal-capture','connections','settings','account','cycle','cycle-settings','cycle-checkin'];
  const focusOptions = {
    food: { name: 'Food', emoji: '🥦', task: 'Add a plant to lunch.', easy: 'Add a little colour.', description: 'Beans, veg or fruit. Pick something you already like.', small: 'A spoonful of beans or a few slices of tomato is a place to start.' },
    move: { name: 'Move', emoji: '👟', task: 'Make room for a little movement.', easy: 'Take a tiny movement break.', description: 'A short walk, a stretch or a dance in the kitchen. Choose what works for you.', small: 'A moment to move in a way that feels comfortable. Keep it manageable.' },
    sleep: { name: 'Sleep', emoji: '🌙', task: 'Choose a wind-down cue.', easy: 'Make one small bedtime change.', description: 'A quiet song, a book or dimmer lights. Try a cue you can repeat.', small: 'Pick one cue for winding down tonight. That is enough to start.' },
    unwind: { name: 'Unwind', emoji: '🌿', task: 'Make a little space to pause.', easy: 'Pause for one moment.', description: 'Put the phone down for a moment. Notice your surroundings and take your time.', small: 'Notice one thing around you. No need to do it perfectly.' }
  };
  const initial = () => ({ version: 1, nutritionProfile: window.NudgeNutrition.clean(), cycleSupport: window.NudgeCycle.clean(), motionEnabled: true, focus: 'food', goal: 5, easier: false, avoidMilk: false, completions: {}, recalls: [], sampleServings: [], challenge: false, suggestion: '', nextFocus: '', lastSample: '', mealConfirmed: false, pendingNudge: '', adoptedNudge: '', journeySeen: false, profile: window.WmdProfile.initial(), mealDemo: window.WmdMealDemo.initial(), foodLog: window.WmdFoodLog.initial() });
  let storageAvailable = true;
  let storageReadError = false;
  let state = initial();
  const isoDay = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayKey = () => isoDay(new Date());
  const validDay = s => window.WmdStreakMath.dayNumber(s) !== null;
  try {
    const saved = JSON.parse((window.NudgeStorage||localStorage).getItem(key) || 'null');
    if(saved && (typeof saved!=='object'||Array.isArray(saved)||saved.version!==1))throw Error('Unreadable diary');
    if (saved && saved.version === 1) {
      if (Object.hasOwn(focusOptions, saved.focus)) state.focus = saved.focus;
      if (Number.isInteger(saved.goal) && saved.goal >= 1 && saved.goal <= 7) state.goal = saved.goal;
      for (const prop of ['easier','avoidMilk','challenge']) state[prop] = saved[prop] === true;
      for (const field of ['lastSample','pendingNudge','adoptedNudge']) if(['oats','salmon','drink','yogurt','wine','meal','ketchup'].includes(saved[field])) state[field]=saved[field];
      state.motionEnabled=saved.motionEnabled!==false;
      state.mealConfirmed=saved.mealConfirmed===true;
      state.journeySeen=saved.journeySeen===true;
      state.profile=window.WmdProfile.clean(saved.profile);
      state.nutritionProfile=window.NudgeNutrition.clean(saved.nutritionProfile);
      state.cycleSupport=window.NudgeCycle.clean(saved.cycleSupport);
      state.mealDemo=window.WmdMealDemo.clean(saved.mealDemo);
      state.foodLog=window.WmdFoodLog.clean(saved.foodLog);
      // Private replay claims belong to the same atomic diary document. Keep
      // them opaque, including malformed data which native handles fail-closed.
      // A fallback web save must not undo the native anti-duplication journal.
      if(Object.hasOwn(saved,'captureIntakeClaims'))state.captureIntakeClaims=saved.captureIntakeClaims;
      if (typeof saved.suggestion === 'string') state.suggestion = saved.suggestion.slice(0,500);
      if (Object.hasOwn(focusOptions,saved.nextFocus)) state.nextFocus=saved.nextFocus;
      if (saved.completions && typeof saved.completions === 'object') {
        Object.entries(saved.completions).slice(-400).forEach(([day,value])=>{
          if(validDay(day) && day<=todayKey() && value && Object.hasOwn(focusOptions,value.focus) && typeof value.label==='string') state.completions[day]={focus:value.focus,label:value.label.slice(0,150)};
        });
      }
      if(Array.isArray(saved.recalls)) state.recalls=saved.recalls.filter(x=>x&&validDay(x.day)&&typeof x.text==='string').slice(-100).map(x=>({day:x.day,text:x.text.slice(0,1000)}));
      if(Array.isArray(saved.sampleServings)) state.sampleServings=saved.sampleServings.filter(x=>x&&typeof x.product==='string'&&validDay(x.day)).slice(-100).map(x=>({product:x.product.slice(0,30),day:x.day}));
    }
  } catch { storageAvailable = false; storageReadError = true; window.NudgeDiagnostics?.record('storage','parse_failed',{store:'main',operation:'read'}); }
  const view = { screen: screens.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'today', product: null, period: 'week', checkin: false, share: false, suggestionOpen: false, scanMode: 'barcode', streakMode:'actual', streakOffset:0, streakWeek:null, foodMode:'actual', foodDay:null, foodDraft:null, recipeTab:'discover', recipeCategory:'All', recipeId:'berry', recipeServings:1 };
  let toastTimer;
  let lastRenderedDay = todayKey();
  if(window.MutationObserver){
    const updateTextLayout=()=>document.documentElement.classList.toggle('n-large-text',parseFloat(document.documentElement.style.getPropertyValue('--n-text-scale'))>1.35);
    new MutationObserver(updateTextLayout).observe(document.documentElement,{attributes:true,attributeFilter:['style']});
    updateTextLayout();
  }
  const escapeHtml = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const button = (text, action, style='primary', value='') => `<button class="button ${style}" data-action="${action}" data-value="${escapeHtml(value)}">${text}</button>`;
  const notice = text => `<div class="notice">${text}</div>`;
  const nudge = (message, party=false) => `<div class="nudge-intro"><img src="/assets/${party?'nudge-celebrate.png':'nudge.png'}" width="135" height="135" alt="Nudge, your cheerful purple companion" class="nudge ${party?'party':''}"><div class="speech">${message}</div></div>`;
  const footnote = text => `<p class="footer-note">${text}</p>`;
  function showToast(message) {
    clearTimeout(toastTimer); toastElement.textContent=!storageAvailable&&!/could not|cannot|not saved|unchanged|failed/i.test(message)&&/saved|added|removed|cleared/i.test(message)?'The latest change could not be saved. Keep Nudge open and try again.':message; toastElement.classList.add('visible');
    toastTimer=setTimeout(()=>toastElement.classList.remove('visible'),3200);
  }
  function save() {
    try { if(storageReadError)throw Error('Unreadable diary'); (window.NudgeStorage||localStorage).setItem(key,JSON.stringify(state)); window.NudgeDiagnostics?.record('storage','saved',{store:'main',operation:'write',entryCount:state.foodLog?.entries?.length||0,durable:window.NudgeStorage?.native===true}); storageAvailable=true; return true; }
    catch { storageAvailable=false; showToast(storageReadError?'Your saved diary could not be opened. It has been kept unchanged.':'This change could not be saved. Keep the result open and try again.'); return false; }
  }
  function weekDates() {
    const start=new Date(); start.setHours(12,0,0,0); start.setDate(start.getDate()-((start.getDay()+6)%7));
    return Array.from({length:7},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return {key:isoDay(d),label:['M','T','W','T','F','S','S'][i],long:d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})};});
  }
  const weekWins=()=>weekDates().filter(d=>state.completions[d.key]).length;
  const isDone=()=>Boolean(state.completions[todayKey()]);
  function weekDots(){return streaks.actualWeekStrip();}
  const currentHabit=()=>journey.habitFor(state.adoptedNudge)||focusOptions[state.focus];
  function todayScreen(){
    const today=todayKey(),day=view.trackingDay&&view.trackingDay<=today?view.trackingDay:today;
    return (state.cycleSupport.enabled?cycle.entryLink():'')+window.NudgeToday.screen(state,day,escapeHtml,{today,calendarOpen:Boolean(view.trackingCalendarOpen),calendarMonth:view.trackingCalendarMonth||day.slice(0,7)})+button('Add from My foods','repertoire-show','secondary');
  }
  // Browsing intake is view state only. It never changes saved entries or targets.
  function handleTrackingAction(action,value){
    if(!action.startsWith('tracking-'))return false;
    const today=todayKey(),math=window.WmdStreakMath,current=view.trackingDay||today;
    if(action==='tracking-day'){
      if(!validDay(value)||value>today)return true;
      view.trackingDay=value===today?null:value;
      view.trackingCalendarMonth=value.slice(0,7);
      view.trackingCalendarOpen=false;
    }else if(action==='tracking-week'){
      if(!['-1','1','+1'].includes(value))return true;
      const next=math.dayKey(math.dayNumber(current)+Number(value)*7);
      view.trackingDay=next>=today?null:next;
      view.trackingCalendarMonth=(view.trackingDay||today).slice(0,7);
    }else if(action==='tracking-calendar'){
      view.trackingCalendarOpen=!view.trackingCalendarOpen;
      view.trackingCalendarMonth=current.slice(0,7);
    }else if(action==='tracking-month'){
      if(!['-1','1','+1'].includes(value))return true;
      const month=view.trackingCalendarMonth||current.slice(0,7),date=new Date(month+'-01T12:00:00');
      date.setMonth(date.getMonth()+Number(value));
      const next=isoDay(date).slice(0,7);
      if(next>today.slice(0,7))return true;
      view.trackingCalendarMonth=next;
    }else return false;
    render();
    const next=Array.from(app.querySelectorAll('[data-action]')).find(button=>button.dataset.action===action&&button.dataset.value===value&&!button.disabled);
    (next||app.querySelector('[data-action="tracking-calendar"]'))?.focus({preventScroll:true});
    return true;
  }

  function recallForm(){return fit.captureScreen();}
  const products={
    ketchup:{name:'Tomato ketchup',emoji:'🍅',meta:'Added sugar · contains celery',letter:'–',rhythm:'Portion-aware',portion:'Example condiment serving: 15 g',context:'Added sugar and salt count, but so does a small condiment portion. There is no evidence-based once-a-month limit for ketchup.',source:'https://heinztohome.co.uk/p/tomato-ketchup-910g/14019193/',sourceName:'Heinz label'},
    oats:{name:'Plain rolled oats',emoji:'🥣',meta:'Wholegrain · sample label',letter:'D',rhythm:'A daily foundation',portion:'Example serving: 40 g dry',context:'A useful regular option, with room for variety.',why:'Daily means an option that can fit regularly, not a food you must eat every day. Think about the whole meal and what you add to it.',next:'Add fruit you enjoy.',source:'https://www.nhs.uk/live-well/eat-well/food-guidelines-and-food-labels/the-eatwell-guide/',sourceName:'NHS Eatwell Guide'},
    salmon:{name:'Salmon fillet',emoji:'🐟',meta:'Oily fish · contains fish',letter:'W',rhythm:'A weekly rotation',portion:'Example serving: 140 g cooked',context:'If you eat fish, oily fish can be part of your weekly variety.',why:'NHS food-group guidance includes two portions of fish a week, one oily. Specific limits apply to some groups, including during pregnancy. This is not a rule to buy this product.',next:'Consider the rest of the meal, too.',source:'https://www.nhs.uk/live-well/eat-well/food-types/fish-and-shellfish-nutrition/',sourceName:'NHS fish and shellfish guidance'},
    drink:{name:'Sugary fizzy drink',emoji:'🥤',meta:'330 ml · sample drink',letter:'M',rhythm:'Your occasional choice',portion:'Example personal goal: one occasion this month',context:'If this is a daily habit, start with one fewer occasion this week.',why:'Monthly is an example personal reduction target. It does not establish a medically safe allowance. Portion size, frequency and your overall pattern still matter.',next:'Try an unsweetened drink you like.',source:'https://www.nhs.uk/live-well/eat-well/food-types/how-does-sugar-in-our-diet-affect-our-health/',sourceName:'NHS sugar guidance'},
    yogurt:{name:'Full-fat Greek yoghurt',emoji:'🥛',meta:'Plain · 5% fat · contains milk',letter:'D',rhythm:'Can fit regularly',portion:'Example small addition: 2–3 tablespoons, roughly 30–45 g',context:'Plain yoghurt provides protein and calcium. Daily is an illustrative Nudge category; saturated fat, portion and dietary needs still matter.',milk:true,source:'https://uk.fage/yoghurts/fage-total-5',sourceName:'FAGE Total 5% label'},
    wine:{name:'Wine · 12% ABV',emoji:'🍷',meta:'125 ml · alcohol included',letter:'–',rhythm:'Less is better',portion:'125 ml at 12% = 1.5 UK units',context:'Amount and frequency belong together. A monthly label is not a safety badge.',why:'An alcohol scan does not mean you drank it. Record the amount only when you choose to log consumption. Drinking less reduces exposure; a particular occasion is not risk-free.',next:'An alcohol-free option is one possible swap.',source:'https://www.nhs.uk/live-well/alcohol-advice/calculating-alcohol-units/',sourceName:'NHS alcohol units'}
  };
  const account=window.createNudgeAccount({view,escapeHtml,render,navigate});
  window.NudgeAccount=account;
  const foodPatterns=window.createWmdFoodPatterns({getState:()=>state,view,button,nudge,escapeHtml,save,render,navigate,showToast,showDialog,todayKey});
  const cycle=window.createNudgeCycle({getState:()=>state,view,save,render,navigate,showToast,escapeHtml,todayKey,recipeBy:foodPatterns.recipeBy});
  const fit=window.createNudgeFit({getState:()=>state,view,button,escapeHtml,todayKey,save,render,navigate,showToast,showDialog,foodPatterns});
  const streaks=window.createWmdStreaks({getState:()=>state,view,button,nudge,todayKey,navigate,render});
  const loop=window.createWmdMealLoop({nudgeWeek:streaks.exampleWeekCard,getState:()=>state,view,button,nudge,escapeHtml,save,render,navigate,showToast,showDialog});
  const demo=window.createWmdScanDemo({getState:()=>state,view,button,nudge,escapeHtml,save,render,navigate,showToast,products,todayKey});
  const journey=window.createWmdJourney({mealIntro:loop.mealCard,demoIntro:demo.homeCard,scanIntro:demo.scanStart,getState:()=>state,view,button,nudge,escapeHtml,save,render,navigate,showDialog,showToast,products});
  const play=window.createNudgePlay({fit,getState:()=>state,view,button,escapeHtml,todayKey,currentHabit,recallForm,journey,save,render,navigate,showDialog,showToast});
  const ui=window.createNudgeUI({play,getState:()=>state,view,button,escapeHtml,todayKey,currentHabit,weekDots,weekWins,recallForm,journey,foodPatterns,navigate,render,showDialog});
  const scanHistory=window.createNudgeHistory({getState:()=>state,view,escapeHtml,todayKey,render,navigate,showToast,save,showDialog,closeDialog:()=>dialog.close(),recipeBy:foodPatterns.recipeBy});
  window.NudgeHistory=scanHistory;
  const barcode=window.createNudgeBarcode({getState:()=>state,view,escapeHtml,todayKey,save,render,navigate,showToast});
  window.NudgeBarcode=barcode;
  const search=window.createNudgeSearch({todayKey,getState:()=>state,view,render,navigate,escapeHtml,foodPatterns,barcode,history:scanHistory});
  window.NudgeSearch=search;
  const label=window.createNudgeLabel({getState:()=>state,view,escapeHtml,todayKey,save,render,navigate,showToast});
  window.NudgeLabel=label;
  const repertoire=window.createNudgeRepertoire({getState:()=>state,view,todayKey,render,navigate,escapeHtml,showToast,showDialog,history:scanHistory});
  window.NudgeRepertoire=repertoire;
  window.NudgeNativeSearch=window.createNudgeNativeSearch?.({navigate,barcode,search,
    camera:()=>document.querySelector('.bottom-nav [data-action="add-menu"]')?.click()});
  function foodScreen(){
    if(!view.product)return button(window.NudgeIcons('user-round')+'How does this food fit me?','navigate','secondary','food-fit')+ui.foodStart();
    if(view.product==='unknown')return `<button class="text-button back" data-action="food-back">Back to food</button><h1>A little<br><span>more info?</span></h1>${nudge('I’d rather say <strong>“I don’t know”</strong> than make it up.')}<section class="card"><span class="pill peach">NOT ASSESSED</span><h2 style="margin-top:16px">We don’t have enough label detail.</h2><p>In the full app, you could add label photos for review.</p><p class="small muted">Missing ingredients and allergy information will never be guessed.</p>${button('Choose another sample','food-back','secondary')}</section>`;
    if(demo.isFeatured(view.product))return demo.resultScreen(view.product)+(view.product==='yogurt'?fit.layers('yogurt',[45,150,250].includes(view.yogurtGrams)?view.yogurtGrams:45,state.nutritionProfile):'');
    const p=products[view.product],conflict=p.milk&&state.avoidMilk,logged=state.sampleServings.some(x=>x.day===todayKey()&&x.product===view.product);
    return `<button class="text-button back" data-action="food-back">Back to food</button><div class="food-hero"><span class="emoji" aria-hidden="true">${window.NudgeIcons({oats:'wheat',salmon:'fish',drink:'coffee',wine:'wine',yogurt:'milk',ketchup:'apple'}[view.product])}</span><h1 style="font-size:1.85rem;margin-bottom:8px">${p.name}</h1><p class="small muted">${p.portion}</p><span class="pill purple">SAMPLE PRODUCT</span></div>${conflict?notice('<strong>Contains milk.</strong><br>This conflicts with your saved preference. Check the packaging; this prototype does not verify allergy safety.'):`<section class="card guidance"><div class="row" style="justify-content:flex-start"><div class="rhythm-badge">${p.letter}</div><h2 style="margin:0">${p.rhythm}</h2></div><p>${p.context}</p></section>`}<section class="card"><p class="eyebrow">A little nudge</p><h2>${p.next}</h2><details><summary>Why this guidance?</summary><p>${p.why}</p><p><a href="${p.source}" target="_blank" rel="noopener noreferrer">${p.sourceName} </a></p><p class="small muted">Illustrative Nudge wording, pending professional review. The live app will show the rule’s reviewer and review date.</p></details></section>${button(logged?'✓ Sample serving logged · undo':'Try logging this sample serving','log-sample',logged?'secondary':'primary')}<p class="small muted">${logged?'Added to the separate demo log. It is not included in your actual food notes.':'A scan never counts as consumption. This button only changes the demo log.'}</p>`;
  }
  function rhythmScreen(){
    const month=todayKey().slice(0,7),monthWins=Object.keys(state.completions).filter(d=>d.startsWith(month)).length;
    const dates=new Set(weekDates().map(d=>d.key)),weekRecalls=state.recalls.filter(x=>dates.has(x.day));
    const recent=state.recalls.slice(-3).reverse();
    return `<p class="eyebrow">Patterns, not perfection</p><h1>Find your<br><span>kind of rhythm.</span></h1><div class="segmented"><button data-action="period" data-value="week" aria-pressed="${view.period==='week'}">This week</button><button data-action="period" data-value="month" aria-pressed="${view.period==='month'}">This month</button></div>${streaks.actualProgressCard()}${button('Explore my food patterns','food-open','secondary','actual')}${loop.rhythmCard()}${view.period==='week'?`<section class="card"><div class="row"><h2>Your little wins</h2><span class="pill purple">${weekWins()} / ${state.goal} DAYS</span></div>${weekDots()}<p class="small muted">This counts the days you recorded a habit, not a health score.</p></section>`:`<section class="mission"><span class="pill">${new Date().toLocaleDateString('en-GB',{month:'long'}).toUpperCase()}</span><h2>${monthWins} day${monthWins===1?'':'s'} you made room.</h2><p>What is getting easier? Keep the useful bits and adjust the rest.</p></section>`}${nudge(weekWins()>0?'You’re building something.<br><strong>One small step at a time.</strong>':'Your rhythm starts with <strong>one small step.</strong> No catching up needed.')}<section class="card"><h2>Your food notes</h2><p>${weekRecalls.length} note${weekRecalls.length===1?'':'s'} saved for this week.</p><p class="small muted">This is a partial picture. Missing days are unknown.</p>${recent.length?recent.map(x=>`<details><summary>${new Date(x.day+'T12:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})}</summary><p style="white-space:pre-wrap">${escapeHtml(x.text)}</p></details>`).join(''):'<div class="empty">Your first check-in will appear here.</div>'}${button('Add a food check-in','open-recall','secondary')}<p class="small muted">Separate demo log: ${state.sampleServings.length} sample serving${state.sampleServings.length===1?'':'s'}.</p></section>${state.challenge?'<section class="card community-card"><span class="pill">YOUR DEMO CHALLENGE</span><h2 style="margin-top:12px">One new plant this week.</h2><p class="small">Saved on this device. No circle members are connected yet.</p></section>':''}<section class="card"><h2>Room for the rest of you.</h2><p class="small muted">Choose an idea to try next.</p><div class="focus-grid">${Object.entries(focusOptions).map(([id,f])=>`<button class="focus-button" data-action="next-focus" data-value="${id}" aria-pressed="${state.nextFocus===id}"><span aria-hidden="true">${window.NudgeIcons({food:'leaf',move:'footprints',sleep:'moon',unwind:'flower-2'}[id])}</span>${f.name}</button>`).join('')}</div>${state.nextFocus?`<p class="status-line">Saved idea: ${focusOptions[state.nextFocus].task}</p>`:''}</section>`;
  }
  function togetherScreen(){return `<p class="eyebrow">A little company helps</p><h1>Good habits.<br><span>Better together.</span></h1>${nudge('Small circles.<br><strong>Big “you’ve got this” energy.</strong>')}<section class="card community-card"><span class="pill">EXAMPLE CIRCLE CHALLENGE</span><h2 style="font-size:1.6rem;margin-top:15px">One new plant<br>this week.</h2><p>Something new, something easy, something you might actually like.</p>${button(state.challenge?'✓ Added · remove from my plan':'Give this a go','challenge',state.challenge?'secondary':'primary')}<p class="small">This is a demo circle. Nothing is shared with other people.</p></section><div class="row"><h2>The swap notebook</h2><span class="pill peach">EXAMPLE</span></div><div class="note-paper"><p>“I add lentils to the tomato sauce I already make.”</p><span class="small muted">A practical idea, ready for an ambassador to review.</span></div><p class="small muted">The full app will show who checked a contribution and the evidence behind it.</p>${button(state.suggestion?'Edit my private draft':'Try writing a swap idea','toggle-suggestion','secondary')}${view.suggestionOpen?`<section class="card"><label for="suggestion" class="form-label">What worked for you?</label><textarea id="suggestion" class="field" rows="3" maxlength="500" placeholder="My little swap…">${escapeHtml(state.suggestion)}</textarea>${button('Save on this device','save-suggestion')}<p class="small muted">Private draft only. It will not be submitted or published.</p><div id="suggestion-error" class="status-line" role="status"></div></section>`:''}${footnote('Encouragement, not competition. Your diary stays yours.')}`;}
  function youScreen(){return fit.profileScreen()+cycle.entryLink();}
  function settingsScreen(){return `<button class="text-button back" data-action="navigate" data-value="you">My profile</button><h1>App settings</h1>${button('My Nudge account','account-show','secondary')}${button('Food AI settings','photo-permission-settings','secondary')}${button(window.NudgeIcons('medal')+'My milestones','navigate','secondary','rewards')}${button(window.NudgeIcons(state.motionEnabled===false?'play':'pause')+(state.motionEnabled===false?'Enable character animations':'Pause character animations'),'motion-toggle','secondary')}${button('My rhythm & habit history','navigate','secondary','rhythm')}${button('Together · circles & swap ideas','navigate','secondary','together')}<section class="card"><h2>Your next little step</h2><div class="focus-grid">${Object.entries(focusOptions).map(([id,f])=>`<button class="focus-button" data-action="focus" data-value="${id}" aria-pressed="${state.focus===id}"><span aria-hidden="true">${window.NudgeIcons({food:'leaf',move:'footprints',sleep:'moon',unwind:'flower-2'}[id])}</span>${f.name}</button>`).join('')}</div>${window.NudgeControls.formChoice({id:'goal',name:'goal',label:'Days to aim for each week',items:Array.from({length:7},(_,i)=>[i+1,(i+1)+' day'+(i?'s':'')]),value:state.goal})}<p class="small muted">Room for life. You can change this whenever you like.</p></section><section class="card"><h2>Additional food preference</h2><label class="setting">Avoid milk products<input id="avoid-milk" type="checkbox" ${state.avoidMilk?'checked':''}></label><p class="small muted">Try the yogurt sample to see the difference. This setting is a preference, not an allergy safety check.</p></section><section class="card connection-card"><span class="pill purple">BRING YOUR OWN AI</span><h2 style="margin-top:14px">A conversation with context.</h2><p>Explore Nudge’s food guidance in ChatGPT, with the information you choose to share.</p><span class="connection-status">NOT CONNECTED IN THIS PROTOTYPE</span>${button('Connect your AI','connect-ai','secondary')}</section><section class="card"><h2>Keep Nudge close.</h2><p class="small muted">Open from your phone’s Home Screen.</p>${button('Add to my Home Screen','install','secondary')}<button class="text-button" data-action="reminders-info">What about daily reminders? </button></section><section class="card"><h2>Your data, on this device.</h2><p class="small muted">${window.NudgeStorage?.native?'Your diary, history, saved foods and preferences are saved in private iPhone app storage. They do not sync to another device or to ChatGPT. Deleting Nudge removes its local records.':'This browser preview saves records on this device. Clearing browser data removes those records.'}</p>${button('Clear my local prototype data','confirm-reset','secondary')}</section>${window.NudgeStorage?.native?'<section class="card"><h2>App diagnostics</h2><p class="small muted">Nudge records recent saving, analysis and screen errors on this device. The support report contains technical events, not your meals, photos, voice notes or cycle details.</p>'+button('Share support report','share-diagnostics','secondary')+'</section>':''}${footnote('Nudge · development build.')}`;}
  function sharingPreview(){return `<details open><summary>You choose the connection</summary><p><strong>First:</strong> public food facts and Nudge evidence.</p><p><strong>Later, where permitted:</strong> a limited summary you explicitly authorise. Medication, clinical records and test results are outside the proposed first connection.</p><p><strong>Your control:</strong> ChatGPT can suggest a plan. You review it in Nudge before anything becomes active.</p><p class="small muted">A live connection still needs a hosted Nudge service, account linking and platform review. This screen does not share anything.</p></details><div class="note-paper"><p style="font-size:1rem">“Suggest three affordable lunches using beans, vegetables and wholegrains.”</p><span class="small muted">A starter question you can use now. It does not send Nudge records.</span></div>${button('Copy the starter question','copy-question','secondary')}`;}
  function render(){
    try{return renderScreen();}catch(error){window.NudgeDiagnostics?.record('ui_error','render_failed',{screen:view.screen,operation:'render'});throw error;}
  }
  function renderScreen(){
    const focusKey=window.NudgeControls?.focusKey(document.activeElement);
    lastRenderedDay=todayKey();
    const screenContent={today:todayScreen,history:scanHistory.screen,food:foodScreen,rhythm:rhythmScreen,together:togetherScreen,you:youScreen,ai:fit.connectionScreen,meal:journey.mealScreen,review:journey.reviewScreen,camera:demo.cameraScreen,profile:demo.profileScreen,'meal-scan':loop.scanScreen,'meal-prompt':loop.promptScreen,'meal-result':loop.resultScreen,'food-week':loop.weeklyScreen,chocolate:loop.chocolateScreen,'nudge-progress':streaks.progressScreen,'food-patterns':foodPatterns.dashboard,'food-entry':fit.reviewScreen,barcode:barcode.screen,'label-photo':label.screen,recipes:search.screen,search:search.screen,'recipe-detail':foodPatterns.recipeDetail,cacao:ui.cacaoScreen,rewards:play.rewardsScreen,'food-context':fit.setupScreen,'food-fit':fit.fitScreen,'meal-capture':fit.captureScreen,connections:fit.connectionScreen,settings:settingsScreen,account:account.screen,cycle:cycle.screen,'cycle-settings':cycle.settingsScreen,'cycle-checkin':cycle.checkinScreen};
    app.innerHTML=`${storageAvailable?'':'<div class="storage-warning">The latest changes could not be saved. Keep Nudge open and try again.</div>'}<section class="screen screen-${view.screen} ${['today','history','barcode','label-photo','cycle','cycle-settings','cycle-checkin'].includes(view.screen)?'approved-screen':''} ${state.motionEnabled===false?'motion-paused':''}">${screenContent[view.screen]()}${view.screen==='food'&&Object.hasOwn(products,view.product)?journey.productFooter():''}</section>`;
    const resultScreen=['barcode','label-photo'].includes(view.screen);
    const profileShortcut=document.querySelector('.app-header .avatar');if(profileShortcut)profileShortcut.hidden=true;
    document.querySelector('.app-header .result-close').hidden=!resultScreen;
    const productResult=view.screen==='barcode'&&app.querySelector('.nf-detail');
    if(productResult){const host=app.querySelector('.screen');host?.insertAdjacentHTML('beforeend',button('Save this portion to My foods','repertoire-save-product','secondary'));}
    const favourite=document.querySelector('.result-favourite');
    if(favourite){favourite.hidden=!productResult;const chosen=productResult&&window.NudgeHistory?.isFavourite(barcode._scan?.product);favourite.setAttribute('aria-pressed',Boolean(chosen));favourite.setAttribute('aria-label',chosen?'Remove favourite':'Save favourite');}
    document.body.classList.toggle('showing-result',resultScreen);
    document.querySelector('.bottom-nav').hidden=resultScreen;
    if(state.motionEnabled===false)dialog.classList.add('motion-paused');else dialog.classList.remove('motion-paused');
    document.querySelectorAll('.bottom-nav button').forEach(b=>{const active=view.screen==='barcode'&&view.resultOrigin==='search'?'search':({cycle:'you','cycle-settings':'you','cycle-checkin':'you','food-context':'you','food-fit':'food-patterns','meal-capture':'food-patterns',connections:'you',account:'you',settings:'you',rewards:'you',food:'food-patterns',ai:'you',meal:'food-patterns',review:'today',camera:'food-patterns',profile:'you','meal-scan':'food-patterns','meal-prompt':'food-patterns','meal-result':'food-patterns','food-week':'food-patterns',chocolate:'food-patterns',cacao:'food-patterns',rhythm:'today','nudge-progress':'today','food-entry':'food-patterns',barcode:'food-patterns','label-photo':'food-patterns','recipe-detail':'search',recipes:'search',together:'you'}[view.screen]||view.screen);if(b.dataset.value===(active==='food-patterns'?'history':active))b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    document.title=`${({today:'Today',history:'History','food-patterns':'Your food',food:'Food examples',barcode:'Scan',you:'You',recipes:'Search',search:'Search',cacao:'Cacao'}[view.screen]||'Your rhythm')} · Nudge`;
    window.NudgeControls?.restoreFocus(focusKey);
    window.NudgeNativeSearch?.sync(view.screen);
  }
  function navigate(screen){window.NudgeDiagnostics?.record('navigation','opened',{fromScreen:view.screen,toScreen:screen});if(!screens.includes(screen))throw new Error('Unknown Nudge screen');fit.leaveProfileEdit?.(screen);if(screen!=='barcode')window.NudgeBarcode?.cancelScore?.();view.screen=screen;view.product=null;if(location.hash!==`#${screen}`)history.replaceState(null,'',`#${screen}`);render();window.scrollTo({top:0,behavior:'auto'});}
  function showDialog(title,content,{closeLabel='Got it',focusClose=false}={}){const close=dialog.querySelector('[data-action="close-dialog"]');if(close)close.textContent=closeLabel;dialogContent.innerHTML=`<h2 id="dialog-title">${title}</h2>${content}`;dialog.showModal();if(focusClose)close?.focus();}
  function celebrate(){if(state.motionEnabled===false)return;if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;const layer=document.createElement('div');layer.className='celebration';layer.setAttribute('aria-hidden','true');layer.innerHTML=Array.from({length:18},(_,i)=>`<span class="confetti" style="left:${8+Math.random()*84}%;background:${['var(--n-accent)','var(--n-plant-accent)','var(--n-primary-fill)','var(--n-progress-fill)'][i%4]};animation-delay:${Math.random()*.2}s"></span>`).join('');document.body.appendChild(layer);setTimeout(()=>layer.remove(),1500);}
  function completeHabit(){if(isDone())return {completed:true,day:todayKey()};const before=play.model(),f=currentHabit();state.completions[todayKey()]={focus:state.focus,label:state.easier?f.easy:f.task};save();render();celebrate();play.afterComplete(before);showToast('A little win. Nicely done!');return {completed:true,day:todayKey()};}
  document.addEventListener('click',async event=>{
    if(window.NudgeControls?.handleClick(event.target))return;
    const control=event.target.closest('[data-action]');if(!control)return;
    const action=control.dataset.action,value=control.dataset.value;
    if(handleTrackingAction(action,value))return;
    if(repertoire.handleAction(action,value))return;
    if(search.handleAction(action,value))return;
    if(cycle.handleAction(action,value))return;
    if(account.handleAction(action,value))return;
    if(['result-next','result-close','product-label'].includes(action))barcode.cancelScore?.();
    if(label.handleAction(action,value))return;
    if(barcode.handleAction(action,value))return;
    if(scanHistory.handleAction(action,value))return;
    if(fit.handleAction(action,value))return;
    if(play.handleAction(action,value))return;
    if(ui.handleAction(action,value))return;
    if(foodPatterns.handleAction(action,value))return;
    if(streaks.handleAction(action,value))return;
    if(await loop.handleAction(action,value))return;
    if(await demo.handleAction(action,value))return;
    if(await journey.handleAction(action,value))return;
    if(action==='navigate'){window.NudgeNativeSearch?.prepareNavigation(value);navigate(value);return;}
    if(action==='complete'){completeHabit();return;}
    if(action==='undo-complete'){delete state.completions[todayKey()];save();render();showToast('Today’s entry undone.');return;}
    if(action==='easier'){state.easier=!state.easier;save();render();return;}
    if(action==='toggle-checkin'){view.checkin=!view.checkin;render();return;}
    if(action==='open-recall'){view.checkin=true;navigate('today');document.getElementById('recall-text').focus();return;}
    if(action==='save-recall'){const text=document.getElementById('recall-text').value.trim(),day=document.getElementById('recall-day').value;if(!text){document.getElementById('recall-error').textContent='Add a note, or choose Skip for now.';return;}state.recalls=state.recalls.filter(x=>x.day!==day);state.recalls.push({day,text:text.slice(0,1000)});state.recalls=state.recalls.slice(-100);save();view.checkin=false;render();showToast('Food note saved on this device.');return;}
    if(action==='product'){if(value!=='unknown'&&!Object.hasOwn(products,value))return;view.product=value;if(value!=='unknown'){state.lastSample=value;save();}render();window.scrollTo({top:0,behavior:'auto'});return;}
    if(action==='food-back'){view.product=null;render();window.scrollTo({top:0,behavior:'auto'});return;}
    if(action==='log-sample'){const i=state.sampleServings.findIndex(x=>x.product===view.product&&x.day===todayKey());if(i>=0)state.sampleServings.splice(i,1);else state.sampleServings.push({product:view.product,day:todayKey()});state.sampleServings=state.sampleServings.slice(-100);save();render();showToast(i>=0?'Sample entry removed.':'Added to the demo log only.');return;}
    if(action==='period'){if(!['week','month'].includes(value))return;view.period=value;render();return;}
    if(action==='next-focus'||action==='focus'){if(!Object.hasOwn(focusOptions,value))return;if(action==='focus'){state.focus=value;state.easier=false;state.adoptedNudge='';}else state.nextFocus=value;save();render();showToast(action==='focus'?'Focus saved for your next little step.':'Idea saved for later.');return;}
    if(action==='challenge'){state.challenge=!state.challenge;save();render();showToast(state.challenge?'Demo challenge added to your Rhythm.':'Demo challenge removed.');return;}
    if(action==='toggle-suggestion'){view.suggestionOpen=!view.suggestionOpen;render();return;}
    if(action==='save-suggestion'){const text=document.getElementById('suggestion').value.trim();if(!text){document.getElementById('suggestion-error').textContent='Write a little idea first.';return;}state.suggestion=text.slice(0,500);save();view.suggestionOpen=false;render();showToast('Private draft saved. Nothing was published.');return;}
    if(action==='toggle-share'){view.share=!view.share;render();return;}
    if(action==='copy-question'){const text='Suggest three affordable lunches using beans, vegetables and wholegrains.';try{await navigator.clipboard.writeText(text);showToast('Question copied. Paste it into ChatGPT.');}catch{showDialog('Your starter question',`<p>Select and copy this text:</p><textarea class="field" readonly>${text}</textarea>`);}return;}
    if(action==='install'){showDialog('Nudge is installed.',`<p>This iPhone prototype runs from files inside the app. Its diary and habits work offline.</p><p class="small muted">Barcode scanning and product-label photography work in the iPhone app. Apple Health and ChatGPT linking are planned separately.</p>`);return;}
    if(action==='reminders-info'){showDialog('A gentle reminder, later.',`<p>The native app will let you choose a reminder time and pause it whenever you like.</p><p class="small muted">This web prototype does not send notifications or schedule background nudges.</p>`);return;}
    if(action==='confirm-reset'){showDialog('Start fresh on this device?',`<p>This removes your habit entries, meal diary, saved recipes, food notes, sample log, preferences and private draft from this app.</p>${button('Yes, clear my local data','reset','primary')}`);return;}
    if(action==='share-diagnostics'){window.webkit?.messageHandlers?.nudgeBarcode?.postMessage({action:'share-diagnostics'});return;}
    if(action==='reset'){if(!repertoire.clear()||!scanHistory.clear())return;try{(window.NudgeStorage||localStorage).removeItem(key);storageAvailable=true;storageReadError=false;}catch{showToast('Could not clear saved data. Please close and reopen the app, then try again.');return;}state=initial();dialog.close();navigate('today');showToast('Your local prototype data has been cleared.');return;}
    if(action==='close-dialog'){dialog.close();return;}
  });
  document.addEventListener('submit',event=>{if(search.handleSubmit(event.target)){event.preventDefault();return;}if(cycle.handleSubmit(event.target)){event.preventDefault();return;}if(event.target.id==='nutrition-profile-form'){event.preventDefault();fit.saveProfile(event.target);return;}if(event.target.id==='food-log-form'){event.preventDefault();foodPatterns.saveForm(event.target);return;}if(event.target.id==='profile-form'){event.preventDefault();demo.saveProfile(event.target);}});
  document.addEventListener('input',event=>{barcode.handleInput?.(event.target);});
  document.addEventListener('change',event=>{if(search.handleChange(event.target))return;if(cycle.handleChange(event.target))return;if(label.handleChange(event.target))return;if(barcode.handleChange(event.target))return;if(fit.handleChange(event.target))return;if(foodPatterns.handleChange(event.target))return;if(loop.handleChange(event.target))return;if(event.target.id==='meal-confirmed'){state.mealConfirmed=event.target.checked;save();render();}if(event.target.id==='avoid-milk'){state.avoidMilk=event.target.checked;save();render();showToast('Food preference saved.');}if(event.target.id==='goal'){const goal=Number(event.target.value);if(Number.isInteger(goal)&&goal>=1&&goal<=7){state.goal=goal;save();showToast('Your weekly goal is saved.');}}});
  window.addEventListener('hashchange',()=>{if(screens.includes(location.hash.slice(1)))navigate(location.hash.slice(1));});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&todayKey()!==lastRenderedDay){reconcileProfileTargets();render();}});
  function reconcileProfileTargets(){
    // Only target fields are updated here; diary records never pass through
    // normalization or get rewritten merely because the app was reopened.
    try {
      const saved=JSON.parse((window.NudgeStorage||localStorage).getItem(key)||'null');
      if(!saved||saved.version!==1)return;
      let profile=state.nutritionProfile;
      if(!(profile.schemaVersion>=2)&&profile.weeklyPlantTarget===null&&[10,20,30].includes(saved.foodLog?.plantGoal)){
        profile={...profile,weeklyPlantTarget:saved.foodLog.plantGoal,targetSources:{...profile.targetSources,plants:'preserved legacy target'}};
      }
      const result=window.NudgeNutrition.reconcileAutomaticTargets(profile,todayKey());
      const plantGoal=result.profile?.weeklyPlantTarget;
      const syncPlants=[10,20,30].includes(plantGoal)&&saved.foodLog?.plantGoal!==plantGoal;
      if(!result.changed&&!syncPlants)return;
      const next={...saved,nutritionProfile:result.profile};
      if(syncPlants)next.foodLog={...saved.foodLog,plantGoal};
      (window.NudgeStorage||localStorage).setItem(key,JSON.stringify(next));
      state.nutritionProfile=result.profile;
      if(syncPlants)state.foodLog.plantGoal=plantGoal;
      storageAvailable=true;
    } catch {
      storageAvailable=false;
      showToast('Automatic targets could not be saved. Your saved targets are unchanged; please try again.');
    }
  }
  reconcileProfileTargets();
  render();
  account.refresh();
  // Browser-local tools are separate from the planned remote ChatGPT MCP connection.
  if(document.modelContext?.registerTool){
    const lifecycle=new AbortController();
    const tools=[
      {name:'get_wmd_prototype_state',title:'Read Nudge prototype progress',description:'Read only the device-local habit focus, weekly goal and completed day count. Does not return food notes or drafts.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute(input){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('Expected an empty object');return {screen:view.screen,focus:state.focus,weeklyGoal:state.goal,completedDaysThisWeek:weekWins(),todayCompleted:isDone(),remoteChatGPTConnected:false};}},
      {name:'navigate_wmd_prototype',title:'Open a Nudge screen',description:'Navigate the prototype without completing habits, logging food or sharing data.',inputSchema:{type:'object',properties:{screen:{type:'string',enum:screens}},required:['screen'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!input||typeof input!=='object'||Object.keys(input).some(k=>k!=='screen')||!screens.includes(input.screen))throw new Error('Choose a valid Nudge screen');navigate(input.screen);return {screen:view.screen};}}
    ];
    tools.forEach(tool=>{try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}});
    window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
  }
})();
