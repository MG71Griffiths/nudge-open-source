// Offline integration checks: real web controllers with isolated diary/DOM/native fixtures.
// No camera, network, credentials, simulator data, or production localStorage is used.
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const keys=['energyKcal','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'];
const today='2026-10-01';
const decode=s=>s.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function extraction(values={},basis='per100g',servingSize=null,identity={}){return {type:'legacy',productName:identity.productName??null,brand:identity.brand??null,basis,servingSize,needsClearerPhoto:false,message:'',nutrients:Object.fromEntries(keys.map(key=>[key,values[key]===undefined?null:typeof values[key]==='object'?values[key]:{value:values[key],unit:key==='energyKcal'?'kcal':'g'}]))};}
function boot(entries=[],overrides={}){
  const elements=new Map(),messages=[],toasts=[];
  const sandbox={console,Date,Math,window:null,document:{getElementById:id=>elements.get(id)||null},scrollTo(){}};
  sandbox.window=sandbox;sandbox.webkit={messageHandlers:{nudgeBarcode:{postMessage:message=>messages.push(message)}}};
  vm.createContext(sandbox);
  for(const file of ['shared-controls.js','streaks.js','core/diary.js','core/food-log.js','food-patterns.js','core/nutrition-profile.js','nudge-fit.js','core/product-evidence.js','scan-results.js','core/nudge-score.js','food-detail-model.js','core/frequency-policy.js','food-detail-screen.js','barcode.js','core/analysis-result.js','nutrition-label.js'])vm.runInContext(overrides[file]||fs.readFileSync(path.join(root,'Web',file),'utf8'),sandbox,{filename:file});
  const data={foodLog:sandbox.WmdFoodLog.clean({entries}),nutritionProfile:{},completions:{}};
  const view={screen:'food-patterns',foodMode:'actual',foodDay:today};let controller,html='',writes=0,persisted=null,canSave=true;
  const render=()=>{
    if(!controller||view.screen!=='label-photo')return;
    html=controller.screen();elements.clear();
    for(const match of html.matchAll(/<input\b([^>]+)>/g)){
      const id=match[1].match(/\bid="([^"]+)"/)?.[1];if(id)elements.set(id,{id,value:decode(match[1].match(/\bvalue="([^"]*)"/)?.[1]||''),checked:/\bchecked\b/.test(match[1])});
    }
    for(const match of html.matchAll(/<textarea\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g))elements.set(match[1],{id:match[1],value:decode(match[2])});
    for(const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
      const options=Array.from(match[2].matchAll(/<option\b([^>]*)>/g)),selected=options.find(x=>/selected/.test(x[1]))||options[0];
      elements.set(match[1],{id:match[1],value:selected?.[1].match(/value="([^"]*)"/)?.[1]||''});
    }
  };
  const ctx={getState:()=>data,view,escapeHtml:escape,todayKey:()=>today,save:()=>{writes++;if(!canSave)return false;persisted=JSON.parse(JSON.stringify(data));return true;},render,navigate:screen=>{view.screen=screen;render();},showToast:message=>toasts.push(message),button:(text,action,_style,value='')=>`<button data-action="${action}" data-value="${value}">${text}</button>`,nudge:()=>'',showDialog(){}};
  sandbox.NudgeIcons=()=>'';sandbox.NudgeDesign={rhythmGuide:()=>''};sandbox.NudgeGame={plantIcon:()=>''};
  controller=sandbox.createNudgeLabel(ctx);sandbox.NudgeLabel=controller;
  sandbox.NudgeBarcode=sandbox.createNudgeBarcode(ctx);
  const patterns=sandbox.createWmdFoodPatterns(ctx),fit=sandbox.createNudgeFit({...ctx,foodPatterns:patterns});
  const action=(action,value='')=>controller.handleAction(action,value);
  const input=(id,value,{change=false,badInput=false}={})=>{const el=elements.get(id);assert.ok(el,`Missing rendered input ${id}`);el.value=String(value);el.validity={badInput};if(change)controller.handleChange(el);};
  const receive=(type,rest={},requestId=controller._state.requestId)=>controller.receive({type,draftId:controller._state.confirmationId,requestId,photoKind:controller._state.captureKind,...rest});
  const selected=(id='')=>{controller.begin(id);receive('capture-status',{photoCount:1});};
  const analyse=()=>{receive('loading');};
  const review=(result,id='')=>{selected(id);analyse();receive('result',{result:{extraction:result}});};
  return {ctx,sandbox,data,view,controller,patterns,fit,messages,toasts,action,input,receive,selected,analyse,review,html:()=>html,writes:()=>writes,persisted:()=>persisted,canSave:value=>canSave=value,element:id=>elements.get(id)};
}

// One camera entrypoint accepts native capture state; no web upload-consent or mode screen.
const roles=boot();roles.controller.begin();const draft=roles.controller._state.confirmationId,frontRequest=roles.controller._state.requestId;
assert.equal(roles.messages.at(-1).action,'smart-scan');assert.equal(roles.messages.at(-1).repair,false);
roles.receive('capture-status',{draftId:'other-draft',photoCount:3});assert.equal(roles.controller._state.photoCount,0);
roles.receive('capture-status',{photoCount:2});assert.equal(roles.controller._state.photoCount,2);
assert.equal(roles.messages.filter(x=>x.action==='smart-scan').length,1,'Extra native photos do not reopen the camera');
assert.equal(roles.element('label-upload-consent'),undefined);assert.doesNotMatch(roles.html(),/checkbox|Before uploading/);
roles.receive('result',{result:{extraction:extraction({energyKcal:999})}});assert.equal(roles.controller._state.phase,'capturing','Native analysis must start before results');
roles.analyse();roles.receive('result',{result:{extraction:extraction({energyKcal:200})}},'old-request');assert.equal(roles.controller._state.phase,'loading');
roles.action('label-retake');const next=roles.controller._state.requestId;assert.notEqual(next,frontRequest);
roles.receive('result',{result:{extraction:extraction({energyKcal:999})}},frontRequest);assert.equal(roles.controller._state.phase,'capturing');
roles.action('label-close');assert.equal(roles.controller._state.confirmationId,null);assert.equal(roles.messages.at(-1).action,'cancel-label');assert.equal(roles.messages.at(-1).draftId,draft);

// Cancelling an in-flight photo analysis returns to the retained camera draft.
for(const backAction of ['label-close','result-close']){
  const returning=boot();returning.selected();returning.receive('capture-status',{photoCount:3});returning.analyse();const originalDraft=returning.controller._state.confirmationId,originalRequest=returning.controller._state.requestId;
  returning.action(backAction);assert.equal(returning.controller._state.confirmationId,originalDraft);assert.notEqual(returning.controller._state.requestId,originalRequest);assert.equal(returning.controller._state.photoCount,3);assert.equal(returning.controller._state.phase,'capturing');assert.equal(returning.messages.at(-1).action,'smart-scan');assert.equal(returning.messages.at(-1).draftId,originalDraft);
  returning.receive('result',{result:{extraction:extraction({energyKcal:999})}},originalRequest);assert.equal(returning.controller._state.extraction,null);assert.equal(returning.controller._state.phase,'capturing');assert.equal(returning.writes(),0);
}

// Account changes invalidate outstanding analysis without granting AI permission from JavaScript.
const accountChange=boot();accountChange.selected();accountChange.analyse();const oldAccountRequest=accountChange.controller._state.requestId;
accountChange.receive('authentication-changed');assert.equal(accountChange.controller._state.phase,'idle');
accountChange.receive('result',{result:{extraction:extraction({energyKcal:999})}},oldAccountRequest);assert.equal(accountChange.controller._state.phase,'idle');assert.equal(accountChange.writes(),0);
accountChange.action('label-analyse');assert.equal(accountChange.messages.filter(x=>x.action==='analyse-label').length,0);
accountChange.action('label-retake');assert.notEqual(accountChange.controller._state.requestId,oldAccountRequest);

// Explicit diary confirmation, persisted unknowns, truthful Today rounding and double-submit.
const app=boot();app.selected();assert.equal(app.messages.at(-1).action,'smart-scan');app.analyse();
app.receive('result',{result:{extraction:extraction({energyKcal:619,protein:26.3,salt:0},'per100g',null,{productName:'ManiLife peanut butter',brand:'ManiLife'})}});
assert.equal(app.data.foodLog.entries.length,0,'An extraction is never automatically logged');assert.match(app.html(),/placeholder="Unknown"/);
assert.equal(app.element('label-name').value,'ManiLife peanut butter');assert.equal(app.element('label-brand').value,'ManiLife');app.input('label-amount',30,{change:true});assert.match(app.html(),/185.7<\/b> kcal/);assert.match(app.html(),/7.9<\/b> g/);
app.action('label-save');app.action('label-save');assert.equal(app.data.foodLog.entries.length,1);assert.equal(app.writes(),1);
const food=app.data.foodLog.entries[0];assert.equal(food.name,'ManiLife peanut butter');assert.equal(food.brand,'ManiLife');assert.equal(food.portionAmount,30);assert.equal(food.energyPerPortion,185.7);assert.equal(food.proteinPerPortion,7.89);assert.equal(food.fibrePerPortion,null);assert.equal(food.nutritionSnapshot.salt.portion,0);assert.equal(food.nutritionStatus,'incomplete');
const reloaded=boot(app.persisted().foodLog.entries);const sum=reloaded.sandbox.NudgeNutrition.summary(reloaded.data.foodLog.entries,today);
assert.equal(reloaded.data.foodLog.entries[0].brand,'ManiLife');assert.equal(sum.calories,186);assert.equal(sum.grams,7.9);assert.equal(reloaded.data.foodLog.entries[0].fibrePerPortion,null);assert.doesNotMatch(JSON.stringify(app.persisted()),/image\/jpeg|preview|imageBase64/);
assert.match(reloaded.patterns.dashboard(),/<small>30 g/);assert.match(reloaded.patterns.dashboard(),/nutrition incomplete/);
reloaded.fit.handleAction('food-edit',food.id);assert.match(reloaded.fit.reviewScreen(),/Photograph label to update this entry/);reloaded.fit.handleAction('fit-portions','2');assert.match(reloaded.fit.reviewScreen(),/Amount eaten · 60 g/);reloaded.fit.handleAction('fit-confirm');assert.match(reloaded.patterns.dashboard(),/<small>60 g/);

// Identity suggestions are escaped, optional brand stays null, and unreadable names require review.
const identity=boot();identity.review(extraction({energyKcal:100},'per100g',null,{productName:'<Pack & food>',brand:'Brand \"name\"'}));assert.equal(identity.element('label-name').value,'<Pack & food>');assert.match(identity.html(),/&lt;Pack &amp; food&gt;/);assert.doesNotMatch(identity.html(),/value=\"<Pack/);identity.action('label-save');assert.equal(identity.data.foodLog.entries[0].brand,'Brand \"name\"');
const unknownIdentity=boot();unknownIdentity.review(extraction({energyKcal:100}));assert.equal(unknownIdentity.element('label-name').value,'');assert.equal(unknownIdentity.element('label-brand').value,'');unknownIdentity.action('label-save');assert.equal(unknownIdentity.data.foodLog.entries.length,0);unknownIdentity.input('label-name','Name checked manually');unknownIdentity.action('label-save');assert.equal(unknownIdentity.data.foodLog.entries[0].brand,null);

// Manual identity, nutrition and amount corrections survive retake, cancellation and reanalysis.
const corrections=boot();corrections.review(extraction({energyKcal:100,protein:10},'per100g',null,{productName:'AI name',brand:'AI brand'}));
corrections.input('label-name','My checked name');corrections.input('label-brand','');corrections.input('label-protein','12');corrections.input('label-amount','30');corrections.action('label-capture','product');
assert.equal(corrections.messages.at(-1).action,'smart-scan');corrections.receive('cancelled');assert.equal(corrections.controller._state.phase,'review');assert.equal(corrections.element('label-name').value,'My checked name');assert.equal(corrections.element('label-protein').value,'12');
corrections.action('label-capture','product');corrections.receive('capture-status',{photoCount:1});corrections.analyse();corrections.receive('result',{result:{extraction:extraction({energyKcal:120,protein:99},'per100g',null,{productName:'Replacement AI name',brand:'Replacement brand'})}});
assert.equal(corrections.element('label-name').value,'My checked name');assert.equal(corrections.element('label-brand').value,'');assert.equal(corrections.element('label-protein').value,'12');assert.equal(corrections.element('label-amount').value,'30');corrections.action('label-save');assert.equal(corrections.data.foodLog.entries[0].name,'My checked name');assert.equal(corrections.data.foodLog.entries[0].brand,null);assert.equal(corrections.data.foodLog.entries[0].proteinPerPortion,3.6);assert.equal(corrections.data.foodLog.entries[0].energyPerPortion,36);

// Printed serving weights and units control arithmetic, including kJ and mg conversion.
const serving=boot();serving.review(extraction({energyKcal:{value:418.4,unit:'kJ'},protein:{value:1000,unit:'mg'},salt:{value:500,unit:'mg'}},'perServing',{value:50,unit:'g'}));
serving.input('label-name','Serving food');serving.input('label-amount',25,{change:true});assert.match(serving.html(),/50<\/b> kcal/);serving.action('label-save');
assert.ok(Math.abs(serving.data.foodLog.entries[0].energyPerPortion-50)<1e-10);assert.equal(serving.data.foodLog.entries[0].proteinPerPortion,0.5);assert.equal(serving.data.foodLog.entries[0].nutritionSnapshot.salt.portion,0.25);assert.equal(serving.data.foodLog.entries[0].portionUnit,'g');
const drink=boot();drink.review(extraction({energyKcal:40,protein:3},'per100ml'));drink.input('label-name','Milk');drink.input('label-amount',250);drink.action('label-save');assert.equal(drink.data.foodLog.entries[0].energyPerPortion,100);assert.match(drink.patterns.dashboard(),/250 ml/);
const noServing=boot();noServing.review(extraction({energyKcal:100},'perServing',{value:1,unit:'serving'}));noServing.input('label-name','Food');noServing.action('label-save');assert.equal(noServing.data.foodLog.entries.length,0);noServing.input('label-serving-size',50,{change:true});noServing.action('label-save');assert.equal(noServing.data.foodLog.entries.length,1,'User can correct a missing printed serving size');

// Review edits survive date/basis changes; removed category actions are inert. Invalid and unknown numbers cannot turn into zero.
const edit=boot();edit.review(extraction({protein:10},'unknown'));edit.input('label-name','A <safe> name');edit.input('label-protein','');edit.input('label-energyKcal','150');edit.input('label-day',today,{change:true});edit.action('label-slot','Lunch');assert.equal(edit.controller._state.slot,'');assert.match(edit.html(),/A &lt;safe&gt; name/);edit.action('label-save');assert.equal(edit.data.foodLog.entries.length,0);edit.input('label-basis','per100g',{change:true});
edit.input('label-energyKcal','-3');edit.action('label-save');assert.equal(edit.data.foodLog.entries.length,0);edit.input('label-energyKcal','150');edit.input('label-day','2026-10-02');edit.action('label-save');assert.equal(edit.data.foodLog.entries.length,0);edit.input('label-day',today);edit.input('label-amount','5001');edit.action('label-save');assert.equal(edit.data.foodLog.entries.length,0);edit.input('label-amount','30');edit.action('label-save');assert.equal(edit.data.foodLog.entries[0].proteinPerPortion,null);assert.equal(edit.data.foodLog.entries[0].slot,'');
const malformed=boot();malformed.review(extraction({energyKcal:{value:'100',unit:'kcal'},protein:{value:null,unit:'g'},fat:{value:Infinity,unit:'g'}}));malformed.input('label-name','Unreadable');malformed.action('label-save');assert.equal(malformed.data.foodLog.entries.length,0);

// A repair preserves identity, position, source, dates, quantities and previous known nutrients.
const original={...food,id:'existing',day:'2026-09-30',slot:'Lunch',portions:2,source:'Open Food Facts original',energyPerPortion:null,proteinPerPortion:7.9,nutritionSnapshot:{protein:{per100:26.3,portion:7.9,unit:'g',per100Status:'supplied',portionStatus:'calculated'}},sourceMeta:{provider:'Open Food Facts',url:'https://world.openfoodfacts.org/product/12345678',confirmationId:'original-confirmation'}};
const repair=boot([original,{...food,id:'other',sourceMeta:{confirmationId:'other-confirmation'}}]);repair.review(extraction({energyKcal:619},'per100g',null,{productName:'Unrelated identity',brand:'Wrong brand'}),'existing');assert.match(repair.html(),/existing diary value/);repair.action('label-save');repair.action('label-save');
assert.equal(repair.data.foodLog.entries.length,2);const repaired=repair.data.foodLog.entries[0];assert.equal(repaired.name,original.name);assert.equal(repaired.brand,original.brand);assert.equal(repaired.id,'existing');assert.equal(repaired.day,original.day);assert.equal(repaired.slot,'Lunch');assert.equal(repaired.portionAmount,30);assert.equal(repaired.portions,2);assert.equal(repaired.proteinPerPortion,7.9);assert.equal(repaired.energyPerPortion,185.7);assert.equal(repaired.fibrePerPortion,null);assert.equal(repaired.sourceMeta.confirmationId,'original-confirmation');assert.equal(repaired.sourceMeta.priorSource,'Open Food Facts original');assert.equal(repaired.sourceMeta.retainedNutrients,'protein');assert.equal(repaired.sourceMeta.url,original.sourceMeta.url);
const missing=boot([original]);missing.review(extraction({energyKcal:619}),'existing');missing.data.foodLog.entries=[];missing.action('label-save');assert.equal(missing.data.foodLog.entries.length,0,'Deleted repair target cannot become a duplicate');
const changedIdentity=boot([original]);changedIdentity.review(extraction({fibre:9}),'existing');assert.equal(changedIdentity.messages.filter(x=>x.action==='smart-scan').length,1,'Repair opens the same camera');assert.equal(changedIdentity.messages[0].repair,true);changedIdentity.input('label-name','Explicitly corrected product');changedIdentity.input('label-brand','Correct brand');changedIdentity.action('label-save');assert.equal(changedIdentity.data.foodLog.entries[0].id,original.id);assert.equal(changedIdentity.data.foodLog.entries[0].name,'Explicitly corrected product');assert.equal(changedIdentity.data.foodLog.entries[0].brand,'Correct brand');const identityReload=boot(changedIdentity.persisted().foodLog.entries);assert.equal(identityReload.data.foodLog.entries[0].brand,'Correct brand');identityReload.fit.handleAction('food-edit',original.id);identityReload.fit.handleAction('fit-portions','1');identityReload.fit.handleAction('fit-confirm');assert.equal(identityReload.data.foodLog.entries[0].brand,'Correct brand');
const mismatch=boot([original]);mismatch.review(extraction({energyKcal:100},'per100ml'),'existing');mismatch.action('label-save');assert.equal(mismatch.writes(),0,'Grams and ml cannot be converted without density');

// Late native messages cannot resurrect closed/retaken photos or overwrite a reviewed result.
const stale=boot();stale.selected();stale.analyse();const first=stale.controller._state.requestId;stale.action('label-retake');const second=stale.controller._state.requestId;assert.notEqual(first,second);stale.receive('result',{result:{extraction:extraction({energyKcal:100})}},first);assert.equal(stale.controller._state.phase,'capturing');stale.receive('capture-status',{photoCount:1});stale.analyse();stale.receive('result',{result:{extraction:extraction({energyKcal:200})}});stale.receive('result',{result:{extraction:extraction({energyKcal:999})}});assert.equal(stale.controller._state.extraction.nutrients.energyKcal.value,200);stale.action('label-close');stale.receive('result',{result:{extraction:extraction({energyKcal:999})}},second);assert.equal(stale.controller._state.extraction,null);assert.equal(stale.controller._state.requestId,null);assert.equal(stale.messages.at(-1).action,'cancel-label');
const retry=boot();retry.selected();retry.analyse();retry.receive('error',{message:'Connection missing',code:'notConfigured'});assert.match(retry.html(),/My Nudge account/);assert.doesNotMatch(retry.html(),/Private development connection/);retry.sandbox.NudgeAccount={canConfigurePrivateConnection:()=>true};assert.match(retry.controller.screen(),/Private development connection/);retry.action('configure-label-backend');assert.equal(retry.messages.at(-1).action,'configure-label-backend');retry.receive('configured');assert.equal(retry.controller._state.phase,'idle');assert.equal(retry.element('label-upload-consent'),undefined);

// A storage failure leaves review intact and rolls back the attempted diary mutation.
const storage=boot();storage.review(extraction({energyKcal:100}));storage.input('label-name','Storage test');storage.canSave(false);storage.action('label-save');assert.equal(storage.data.foodLog.entries.length,0);assert.equal(storage.controller._state.phase,'review');storage.canSave(true);storage.action('label-save');storage.action('label-save');assert.equal(storage.data.foodLog.entries.length,1);

// Cleaner never invents values/completeness or truncates existing records.
const clean=app.sandbox.WmdFoodLog.clean({entries:[{...original,nutritionSnapshot:{},barcode:'12345678'}]}).entries[0];assert.equal(clean.nutritionStatus,'incomplete');
const zero=app.sandbox.WmdFoodLog.clean({entries:[{...original,nutritionSnapshot:{protein:{per100:null,portion:null,per100Status:'supplied',portionStatus:'calculated'}}}]}).entries[0];assert.equal(zero.nutritionSnapshot.protein.per100,null);assert.equal(zero.nutritionSnapshot.protein.per100Status,'unknown');
const many=boot(Array.from({length:350},(_,i)=>({...food,id:'entry-'+i,sourceMeta:{confirmationId:'confirmation-'+i}})));assert.equal(many.data.foodLog.entries.length,350);many.review(extraction({energyKcal:100}));many.input('label-name','Entry 351');many.action('label-save');assert.equal(many.data.foodLog.entries.length,351);assert.equal(many.data.foodLog.entries[0].id,'entry-0');
const unknown=app.sandbox.NudgeNutrition.summary([{day:today,portions:1,energyPerPortion:null,proteinPerPortion:null}],today);assert.equal(unknown.calorieKnown,0);assert.equal(unknown.calorieUnknown,1);assert.equal(unknown.unknown,1);
const noKnown=boot([{...food,energyPerPortion:null,proteinPerPortion:null}]);assert.match(noKnown.fit.homeCard(),/No known values logged/);assert.match(noKnown.fit.homeCard(),/total incomplete/);assert.doesNotMatch(noKnown.fit.homeCard(),/>0 kcal logged|>0 g logged/);
// Live barcode records keep the same source-backed arithmetic and never auto-save or truncate.
const bar=boot();const product={name:'ManiLife',barcode:'5060561660012',basisUnit:'g',servingAmount:30,retrievedAt:'2026-10-01T12:00:00Z',sourceName:'Open Food Facts',sourceURL:'https://world.openfoodfacts.org/product/5060561660012',licenceName:'ODbL',licenceURL:'https://opendatacommons.org/licenses/odbl/',nutrients:{energyKcal:{value:619,status:'supplied'},protein:{value:26.3,status:'supplied'},fibre:null}};
bar.sandbox.NudgeBarcode.receive({type:'product',product});assert.equal(bar.data.foodLog.entries.length,0);assert.doesNotMatch(bar.sandbox.NudgeBarcode.screen(),/Confirm the identity|This matches my product|Add to diary|barcode-amount/);bar.sandbox.NudgeBarcode.handleAction('barcode-ate');bar.sandbox.NudgeBarcode.handleAction('barcode-ate');assert.equal(bar.data.foodLog.entries.length,0,'Shopping results never log intake');
const fromBarcode=boot();fromBarcode.sandbox.NudgeBarcode.receive({type:'product',product});fromBarcode.view.screen='barcode';fromBarcode.review(extraction({energyKcal:619}));assert.equal(fromBarcode.controller._state.name,'ManiLife');fromBarcode.action('label-save');assert.equal(fromBarcode.data.foodLog.entries[0].barcode,product.barcode);assert.equal(fromBarcode.data.foodLog.entries[0].proteinPerPortion,null,'Unsaved OFF facts cannot silently fill unknown label values');
const unsized=boot([{...original,portionAmount:1,portionUnit:null}]);unsized.review(extraction({energyKcal:619}),'existing');unsized.action('label-save');assert.equal(unsized.writes(),0,'A legacy serving without physical units cannot silently become one gram');unsized.input('label-amount',30);unsized.action('label-save');assert.equal(unsized.data.foodLog.entries[0].portionAmount,30);assert.equal(unsized.data.foodLog.entries[0].energyPerPortion,185.7);
// New confirmations keep precision; reading/retaining older rounded records never migrates them.
const exactRepair=boot([original]);const untouched=JSON.stringify(exactRepair.data.foodLog);exactRepair.controller.screen();assert.equal(JSON.stringify(exactRepair.data.foodLog),untouched);exactRepair.review(extraction({fibre:9.1,salt:.9}),'existing');exactRepair.action('label-save');assert.equal(exactRepair.data.foodLog.entries[0].fibrePerPortion,2.73);assert.equal(exactRepair.data.foodLog.entries[0].nutritionSnapshot.salt.portion,.27);assert.equal(exactRepair.data.foodLog.entries[0].proteinPerPortion,7.9);assert.equal(exactRepair.data.foodLog.entries[0].portions,2);assert.equal(exactRepair.data.foodLog.entries[0].id,original.id);
const exactServing=boot();exactServing.review(extraction({protein:1},'perServing',{value:7,unit:'g'},{productName:'Checked serving'}));exactServing.input('label-amount',3);exactServing.action('label-save');assert.equal(exactServing.data.foodLog.entries[0].nutritionSnapshot.protein.per100,100/7);assert.ok(Math.abs(exactServing.data.foodLog.entries[0].proteinPerPortion-3/7)<1e-12);assert.notEqual(exactServing.data.foodLog.entries[0].proteinPerPortion,.4);
// A label repair must replace its old score/frequency as well as intake values.
const repairValues={energyKcal:50,protein:2,fat:1,saturatedFat:.1,carbohydrate:6,sugars:1,fibre:2,salt:.1};
const repairProduct={name:'Soup',barcode:'12345678',sourceName:'Open Food Facts',basisUnit:'g',nutritionPreparation:'as_sold',categoryTag:'soups',servingAmount:100,servingUnit:'g',ingredients:'Water, salt',ingredientsNeedsReview:false,nutrients:Object.fromEntries(Object.entries(repairValues).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:'supplied'}]))};
const scoredRepair=()=>{const b=boot();b.sandbox.NudgeBarcode.receive({type:'product',product:JSON.parse(JSON.stringify(repairProduct))});b.sandbox.NudgeBarcode.handleAction('detail-log');return b;};
const repairExtraction=(values,extra={})=>({...extraction(values),type:'product',categoryTag:'soups',nutritionPreparation:'as_sold',...extra});
const changedScore=scoredRepair(),beforeScore=JSON.parse(JSON.stringify(changedScore.data.foodLog.entries[0])),repairID=beforeScore.id;
assert.equal(beforeScore.sourceMeta.scoreMethod.value,100);assert.equal(beforeScore.sourceMeta.scoreMethod.finalFrequency,null);
changedScore.review(repairExtraction({salt:5}),repairID);changedScore.action('label-save');changedScore.action('label-save');
const repairedScore=changedScore.data.foodLog.entries[0];
assert.equal(changedScore.data.foodLog.entries.length,1);assert.equal(repairedScore.id,repairID);assert.equal(repairedScore.day,beforeScore.day);assert.equal(repairedScore.portionAmount,100);
assert.equal(repairedScore.nutritionSnapshot.salt.portion,5);assert.equal(repairedScore.sourceMeta.scoreMethod.inputs.salt,5);assert.equal(repairedScore.sourceMeta.scoreMethod.value,0);assert.equal(repairedScore.sourceMeta.scoreMethod.finalFrequency,null);
assert.equal(repairedScore.sourceMeta.scoreMethod.frequencyPolicy,null);
assert.equal(repairedScore.proteinPerPortion,beforeScore.proteinPerPortion);assert.equal(repairedScore.energyPerPortion,beforeScore.energyPerPortion);
assert.deepEqual(JSON.parse(JSON.stringify(repairedScore.sourceMeta.scoreHistory)),[beforeScore.sourceMeta.scoreMethod]);
assert.equal(repairedScore.sourceMeta.scoreMethod.sourceData.source,'User-confirmed label repair');
assert.match(repairedScore.sourceMeta.scoreMethod.sourceData.nutrientSources.protein,/Retained confirmed/);
const repairedReload=boot(changedScore.persisted().foodLog.entries);assert.equal(repairedReload.data.foodLog.entries[0].sourceMeta.scoreMethod.finalFrequency,null);

for(const [label,extra,values] of [
  ['unknown preparation',{nutritionPreparation:'unknown'},{salt:5}],
  ['prepared table',{nutritionPreparation:'prepared'},{salt:5}],
  ['conflicting nutrition',{metadata:{conflicts:[{field:'nutrition'}]}},{...repairValues,salt:5}],
  ['unclear table',{needsClearerPhoto:true},{...repairValues,salt:5}],
  ['bounded salt',{}, {...repairValues,salt:{value:1,unit:'g',relation:'lt'}}]
]){
  const b=scoredRepair(),id=b.data.foodLog.entries[0].id;b.review(repairExtraction(values,extra),id);b.action('label-save');
  const next=b.data.foodLog.entries[0];assert.equal(next.id,id,label);assert.equal(next.sourceMeta.scoreMethod.value,null,label);assert.equal(next.sourceMeta.scoreMethod.finalFrequency,null,label);assert.equal(next.sourceMeta.scoreHistory.length,1,label);
  b.sandbox.NudgeBarcode.openStored({id:next.sourceMeta.productScanEventId,status:'ready',product:repairProduct},{entryId:next.id});assert.equal(b.sandbox.NudgeBarcode.detail().score.value,null,label+' stays unavailable when reopened');
  b.sandbox.NudgeBarcode.handleAction('detail-edit');b.sandbox.NudgeBarcode.handleAction('detail-step','.25');b.sandbox.NudgeBarcode.handleAction('detail-log');b.sandbox.NudgeBarcode.openStored({id:next.sourceMeta.productScanEventId,status:'ready',product:repairProduct},{entryId:next.id});assert.equal(b.sandbox.NudgeBarcode.detail().score.value,null,label+' stays unavailable after a saved portion edit');
}
const incompleteRepair=scoredRepair(),missingRecord=incompleteRepair.data.foodLog.entries[0];
missingRecord.proteinPerPortion=null;missingRecord.nutritionSnapshot.protein={per100:null,portion:null,unit:'g',per100Status:'unknown',portionStatus:'unknown'};
incompleteRepair.review(repairExtraction({salt:5}),missingRecord.id);incompleteRepair.action('label-save');
assert.equal(incompleteRepair.data.foodLog.entries[0].sourceMeta.scoreMethod.value,incompleteRepair.sandbox.NudgeScoreCore.ACTIVE_DIRECTIONAL?0:null);assert.equal(incompleteRepair.data.foodLog.entries[0].proteinPerPortion,null);

const multipleRepair=scoredRepair(),multipleEntry=multipleRepair.data.foodLog.entries[0];multipleEntry.portions=2;
multipleRepair.review(repairExtraction({salt:1.01}),multipleEntry.id);multipleRepair.action('label-save');
const multipleSaved=multipleRepair.data.foodLog.entries[0];assert.equal(multipleSaved.portions,2);assert.equal(multipleSaved.nutritionSnapshot.salt.portion,1.01);assert.equal(multipleSaved.sourceMeta.scoreMethod.frequencyPolicy,null);assert.equal(multipleSaved.sourceMeta.scoreMethod.finalFrequency,null);

const servingRepair=scoredRepair(),servingRecord=servingRepair.data.foodLog.entries[0];
servingRepair.review(repairExtraction({protein:1,salt:.1},{basis:'perServing',servingSize:{value:7,unit:'g'}}),servingRecord.id);servingRepair.action('label-save');
const servingSaved=servingRepair.data.foodLog.entries[0];assert.equal(servingSaved.proteinPerPortion,100/7);assert.equal(servingSaved.sourceMeta.scoreMethod.inputs.protein,100/7);assert.equal(servingSaved.sourceMeta.scoreMethod.inputs.salt,.1*100/7);assert.equal(servingSaved.sourceMeta.scoreMethod.available,true);

for(const b of [changedScore,servingRepair]){
  const saved=b.data.foodLog.entries[0],beforeOpen=JSON.stringify(b.data);
  b.sandbox.NudgeBarcode.openStored({id:saved.sourceMeta.productScanEventId,status:'ready',product:repairProduct},{entryId:saved.id});
  const detail=b.sandbox.NudgeBarcode.detail();assert.equal(detail.score.value,saved.sourceMeta.scoreMethod.value,'Reopen keeps repaired rating');
  assert.equal(detail.score.inputs.protein,saved.sourceMeta.scoreMethod.inputs.protein,'Exact confirmed conversion stays eligible');
  assert.equal(detail.score.inputs.salt,saved.sourceMeta.scoreMethod.inputs.salt);assert.equal(JSON.stringify(b.data),beforeOpen,'Reopen is read-only');
}

console.log('Passed: unified camera/native lifecycle, identity and null preservation, exact portion arithmetic, Today persistence, repair idempotency and refreshed v0.2 score/frequency provenance, source conflicts and preparation guards, storage rollback, and all-record retention.');

module.exports={boot,extraction,keys,today};
