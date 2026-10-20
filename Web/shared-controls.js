// Shared interaction controls for the existing WKWebView screens. Domain models
// own allowed values, conversions and persistence; these controls only edit drafts.
window.NudgeControls = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const format = value => finite(value) ? String(Number(value.toFixed(6))) : 'Not set';
  function parseDecimal(raw, {minimum=0, maximum=Infinity, integer=false, optional=false}={}) {
    const text=String(raw ?? '').trim();
    if (!text) return optional ? {value:null,error:''} : {value:null,error:'Enter an amount.'};
    if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(text)) return {value:null,error:'Use a number, with a decimal point or comma if needed.'};
    const value=Number(text.replace(',','.'));
    if (!Number.isFinite(value)) return {value:null,error:'Enter a finite amount.'};
    if (integer && !Number.isInteger(value)) return {value:null,error:'Enter a whole number.'};
    if (value<minimum || value>maximum) return {value:null,error:minimum>0&&minimum<.000001?`Enter an amount greater than zero and no more than ${format(maximum)}.`:`Choose ${format(minimum)} to ${format(maximum)}.`};
    return {value,error:''};
  }
  function choices({label, items, value, action, field, meal=false, className=''}) {
    return `<div class="nc-choice-group ${meal?'nc-meals ':''}${esc(className)}" role="group" aria-label="${esc(label)}">${items.map(item=>{const [id,title,disabled]=Array.isArray(item)?item:[item,item];return `<button type="button" class="nc-choice" ${field?`data-nc-field="${esc(field)}"`:`data-action="${esc(action)}"`} data-value="${esc(id)}" ${disabled?'disabled':''} aria-pressed="${String(value)===String(id)}"><span class="nc-check" aria-hidden="true">✓</span><span>${esc(title)}</span></button>`;}).join('')}</div>`;
  }
  function formChoice({id,name,label,items,value,meal=false}) {return `<fieldset class="nc-choice-field"><legend class="form-label">${esc(label)}</legend><input type="hidden" id="${esc(id)}" name="${esc(name)}" value="${esc(value)}">${choices({label,items,value,field:id,meal})}</fieldset>`;}
  function tags({label,items,name,selected=[]}) {return `<fieldset class="nc-tag-field"><legend class="form-label">${esc(label)}</legend><div class="nc-tag-group">${items.map(item=>{const [id,title]=Array.isArray(item)?item:[item,item];return `<label class="nc-tag"><input type="checkbox" name="${esc(typeof name==='function'?name(id):name)}" value="${esc(id)}" ${selected.includes(id)?'checked':''}><span class="nc-check" aria-hidden="true">✓</span><span>${esc(title)}</span></label>`;}).join('')}</div></fieldset>`;}
  function stepper({label,value,unit='',step,minimum,maximum,action,field,className='',decreaseValue=-step,increaseValue=step,increment,disabled=false}) {
    const delta=increment||`${format(step)}${unit?' '+unit:''}`;
    return `<div class="nc-stepper ${esc(className)}" role="group" aria-label="${esc(label)}"><button type="button" class="nc-choice" ${field?`data-nc-step-field="${esc(field)}"`:`data-action="${esc(action)}"`} data-value="${esc(decreaseValue)}" aria-label="${esc('Decrease '+label+' by '+delta)}" ${disabled||!finite(value)||value-step<minimum-1e-9||minimum>0&&value-step<=0?'disabled':''}>− ${esc(delta)}</button><span class="nc-stepper-value" aria-live="polite" aria-label="${esc(format(value)+' '+unit)}"><strong>${esc(format(value))}</strong><span>${esc(unit)}</span></span><button type="button" class="nc-choice" ${field?`data-nc-step-field="${esc(field)}"`:`data-action="${esc(action)}"`} data-value="${esc(increaseValue)}" aria-label="${esc('Increase '+label+' by '+delta)}" ${disabled||!finite(value)||value+step>maximum+1e-9?'disabled':''}>+ ${esc(delta)}</button></div>`;
  }
  function numberField({id,name,label,value,unit='',minimum,maximum,step=1,optional=true,integer=false,stepperControl=false}) {return `<div class="nc-number-field"><span class="form-label" id="${esc(id)}-label">${esc(label)}</span><input id="${esc(id)}" name="${esc(name)}" type="hidden" value="${value??''}" data-nc-min="${minimum}" data-nc-max="${maximum}" data-nc-step="${step}" data-nc-integer="${integer}" data-nc-optional="${optional}" data-nc-label="${esc(label)}" data-nc-unit="${esc(unit)}">${stepperControl?stepper({label,value,unit,step,minimum,maximum,field:id}):''}<div class="nc-number-display"><output data-nc-output="${esc(id)}" ${stepperControl?'hidden':''} aria-labelledby="${esc(id)}-label">${esc(format(value))}${finite(value)&&unit?' '+esc(unit):''}</output><button type="button" class="button secondary" data-nc-number="${esc(id)}">Edit</button></div></div>`;}
  function focusKey(element) {
    if(!element?.matches?.('.nc-choice,.nc-stepper button,.nc-action-row button,[data-nc-number],[data-action$="-exact"]'))return null;
    if(element.dataset.ncNumber)return {kind:'ncNumber',value:element.dataset.ncNumber};
    if(element.dataset.ncField)return {kind:'ncField',value:element.dataset.ncField,choice:element.dataset.value};
    if(element.dataset.action)return {kind:'action',value:element.dataset.action,choice:element.dataset.value};
    return null;
  }
  function restoreFocus(key) {
    if(!key)return;
    const attribute={ncNumber:'data-nc-number',ncField:'data-nc-field',action:'data-action'}[key.kind];
    const next=Array.from(document.querySelectorAll('['+attribute+']')).find(element=>element.dataset[key.kind]===key.value&&(key.choice===undefined||element.dataset.value===key.choice));
    if(!next)return;
    if(!next.disabled){next.focus({preventScroll:true});return;}
    const group=next.closest('.nc-stepper,.nc-choice-group');if(group){group.setAttribute('tabindex','-1');group.focus({preventScroll:true});}
  }
  function exact({label,value,unit='',minimum,maximum,integer=false,optional=false,onApply,rangeStep=null}) {
    const focusBefore=document.activeElement, opener=focusKey(focusBefore), dialog=document.createElement('dialog');dialog.className='nc-exact';
    dialog.setAttribute('aria-labelledby','nc-exact-title');
    dialog.innerHTML=`<h2 id="nc-exact-title">${esc(label)}</h2><p>${esc(unit)}${optional?(unit?' · ':'')+'Leave blank when unknown':''}</p>${rangeStep?`<label for="nc-range">Choose an amount</label><input id="nc-range" type="range" min="${minimum}" max="${maximum}" step="${rangeStep}" value="${finite(value)?value:minimum}"><output id="nc-range-value">${esc(format(value))}</output><button type="button" class="button secondary" id="nc-type">Type exact amount</button>`:''}<div id="nc-exact-input-wrap" ${rangeStep?'hidden':''}><label for="nc-exact-value">Exact amount${unit?' · '+esc(unit):''}</label><input class="field" type="text" inputmode="decimal" autocomplete="off" id="nc-exact-value" value="${finite(value)?String(value):''}" aria-describedby="nc-exact-error"></div><p id="nc-exact-error" role="alert"></p><div class="nc-action-row"><button type="button" class="button secondary" id="nc-exact-cancel">Cancel</button><button type="button" class="button primary" id="nc-exact-apply">Apply</button></div>${optional?'<button type="button" class="text-button" id="nc-exact-clear">Leave not set</button>':''}`;
    const close=()=>{dialog.close();dialog.remove();if(focusBefore?.isConnected)focusBefore.focus?.({preventScroll:true});else restoreFocus(opener);};
    document.body.append(dialog);dialog.showModal();
    const input=dialog.querySelector('#nc-exact-value'),error=dialog.querySelector('#nc-exact-error');
    dialog.querySelector('#nc-exact-cancel').onclick=close;
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    const apply=()=>{const parsed=parseDecimal(input.value,{minimum,maximum,integer,optional});error.textContent=parsed.error;input.setAttribute('aria-invalid',Boolean(parsed.error));if(parsed.error)return;const result=onApply(parsed.value);if(typeof result==='string'&&result){error.textContent=result;return;}close();};
    dialog.querySelector('#nc-exact-apply').onclick=apply;
    input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();apply();}});
    if(optional)dialog.querySelector('#nc-exact-clear').onclick=()=>{input.value='';apply();};
    if(rangeStep){const range=dialog.querySelector('#nc-range');range.oninput=()=>{input.value=range.value;dialog.querySelector('#nc-range-value').textContent=range.value+' '+unit;};dialog.querySelector('#nc-type').onclick=()=>{dialog.querySelector('#nc-exact-input-wrap').hidden=false;input.focus();};range.focus();}
    else input.focus();
  }
  function updateNumberField(input,value) {
    input.value=value??'';const field=input.closest('.nc-number-field'),output=field.querySelector('[data-nc-output]');
    if(output)output.textContent=format(value)+(finite(value)&&input.dataset.ncUnit?' '+input.dataset.ncUnit:'');
    const stepperValue=field.querySelector('.nc-stepper-value');if(stepperValue){stepperValue.querySelector('strong').textContent=format(value);stepperValue.setAttribute('aria-label',format(value)+' '+input.dataset.ncUnit);}
    field.querySelectorAll('[data-nc-step-field]').forEach(button=>{const next=value+Number(button.dataset.value);button.disabled=!finite(value)||next<Number(input.dataset.ncMin)-1e-9||next>Number(input.dataset.ncMax)+1e-9;});
    input.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function handleClick(target) {
    const step=target.closest?.('[data-nc-step-field]');if(step?.dataset?.ncStepField){const input=document.getElementById(step.dataset.ncStepField);if(!input||step.disabled||input.value==='')return true;const next=Number((Number(input.value)+Number(step.dataset.value)).toFixed(6));if(Number.isFinite(next)&&next>=Number(input.dataset.ncMin)&&next<=Number(input.dataset.ncMax))updateNumberField(input,next);if(step.disabled){const group=step.closest('.nc-stepper');group.setAttribute('tabindex','-1');group.focus({preventScroll:true});}return true;}
    const choice=target.closest?.('[data-nc-field]');
    if(choice?.dataset?.ncField){const input=document.getElementById(choice.dataset.ncField);if(!input)return true;input.value=choice.dataset.value;choice.parentElement.querySelectorAll('[data-nc-field]').forEach(button=>button.setAttribute('aria-pressed',button===choice));input.dispatchEvent(new Event('change',{bubbles:true}));if(!choice.isConnected)document.querySelectorAll('[data-nc-field]').forEach(button=>{if(button.dataset.ncField===choice.dataset.ncField&&button.dataset.value===choice.dataset.value)button.focus({preventScroll:true});});return true;}
    const number=target.closest?.('[data-nc-number]');if(!number?.dataset?.ncNumber)return false;
    const input=document.getElementById(number.dataset.ncNumber);if(!input)return true;
    exact({label:input.dataset.ncLabel,value:input.value===''?null:Number(input.value),unit:input.dataset.ncUnit,minimum:Number(input.dataset.ncMin),maximum:Number(input.dataset.ncMax),integer:input.dataset.ncInteger==='true',optional:input.dataset.ncOptional==='true',rangeStep:Number(input.dataset.ncStep),onApply:value=>updateNumberField(input,value)});return true;
  }
  return {choices,formChoice,tags,stepper,numberField,exact,parseDecimal,format,handleClick,focusKey,restoreFocus};
})();
