// Real SwiftUI domain adapter, storage, history, catalogue and scoring modules.
// Synthetic product fixtures only; no provider requests or owner data.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const copy=value=>JSON.parse(JSON.stringify(value));
const web=path.resolve(__dirname,'../Web');
const historyKey='nudge-scan-history-v1';
const initialTime=Date.parse('2026-10-07T12:00:00Z');
const files=['streaks.js','recipe-catalogue-data.js','recipe-catalogue.js','core/food-log.js','core/diary.js','core/nutrition-profile.js','core/product-evidence.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','core/analysis-result.js','scan-results.js','today-goals.js','cycle-support.js','search-model.js','diet.js','scan-history.js','repertoire.js','native-review.js','native-session.js','food-catalogue.js'];
function boot(values=new Map(),clock=initialTime){
  let now=clock;const writes=[],diagnostics=[];
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const s={console,Date:Clock,Math,JSON,URL,document:{addEventListener(){},getElementById(){return null;}},location:{protocol:'native:'},
    nativeToday:()=>new Clock().toISOString().slice(0,10),nativeNow:()=>new Clock().toISOString(),
    nativeDiagnostic:(...args)=>diagnostics.push(args),nativeStorage:request=>{
      const r=JSON.parse(request);
      if(r.operation==='get')return JSON.stringify({ok:true,value:values.get(r.key)??null});
      if(r.operation==='set'){writes.push(r);values.set(r.key,r.value);return '{"ok":true}';}
      if(r.operation==='remove'){values.delete(r.key);return '{"ok":true}';}
      throw Error('Unexpected native storage operation');
    }};
  s.window=s;vm.createContext(s);
  for(const file of files)vm.runInContext(fs.readFileSync(path.join(web,file),'utf8'),s,{filename:file});
  const api=s.NudgeNativeSession;assert.equal(api.init().readFailed,false);
  const session={s,values,writes,diagnostics,api,model:s.NudgeFoodDetailModel,
    project:(op,p={})=>copy(api.project(op,p)),perform:(op,p={})=>copy(api.perform(op,p)),
    snapshot:()=>copy(api.snapshot()),advance:ms=>now+=ms,restart:()=>boot(values,now)};
  session.open=(product=complete,confirmationId='confirmation-1',eventId='scan-1')=>{
    assert.equal(session.perform('recordHistory',{id:eventId,kind:'product',status:'ready',name:product.name,barcode:product.barcode,product}).ok,true);
    assert.equal(session.perform('setReview',{kind:'product',product,confirmationId,eventId}).ok,true);
    return session.project('productRecovery');
  };
  return session;
}
const nutrients=values=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:value===null?'unknown':'supplied'}]));
const complete={name:'Chickpeas',brand:'Fixture Foods',barcode:'12345678',sourceName:'Open Food Facts',sourceURL:'https://world.openfoodfacts.org/product/12345678',basisUnit:'g',servingAmount:100,servingUnit:'g',nutritionPreparation:'as_sold',categoriesTags:['en:legumes'],nutrients:nutrients({energyKcal:100,protein:6.7,fibre:5.7,salt:.53,sugars:1,fat:2,saturatedFat:.3,carbohydrate:13.9})};

const metric=(model,key)=>model.compactMetrics.find(x=>x.key===key);
const photoA='nudge-photo:12345678-1234-1234-1234-123456789abc.jpg';
const photoB='nudge-photo:abcdef01-1234-1234-1234-123456789abc.jpg';
const thumbA='data:image/jpeg;base64,YWJj',thumbB='data:image/jpeg;base64,ZGVm';
const profile={age:55,weight:75,height:180,sex:'male',activity:'moderate',care:'none',trainingTypes:['weight_training'],goals:['balance'],tracking:[]};
const entry=(name,day,plants=[],portions=1)=>({name,day,slot:'Lunch',portions,plants,ferments:[],energyPerPortion:400,proteinPerPortion:20,fibrePerPortion:10,nutritionSnapshot:Object.fromEntries(Object.entries({energyKcal:400,protein:20,fibre:10,carbohydrate:50,fat:10,sugars:8,saturatedFat:2,salt:1}).map(([key,value])=>[key,{portion:value,portionStatus:'calculated',unit:key==='energyKcal'?'kcal':'g'}])),sourceMeta:{plantKnowledge:'known'}});
function add(a,id,day,plants=[],portions=1,extra={}){
  assert.equal(a.perform('setReview',{kind:'entry',entry:entry(id,day,plants,portions),confirmationId:id,day,...extra}).ok,true);
  const result=a.perform('reviewConfirm');assert.equal(result.ok,true);return result.state.foodLog.entries.find(e=>e.id===id);
}
function saveProfile(a,p=profile){const result=a.perform('profileSave',{profile:p});assert.equal(result.ok,true);return result.state.nutritionProfile;}

test('compact Today includes all nine complete-log totals, portions and >100% with profile history policy',()=>{
  const a=boot();saveProfile(a);
  for(let i=0;i<11;i++)add(a,'food-'+i,'2026-10-07',['oats','blueberries'],i===0?2:1);
  add(a,'yesterday','2026-10-06',['almond']);
  const model=a.project('today',{day:'2026-10-06'});
  assert.equal(model.selectedDay,'2026-10-07','Today cannot follow a browsed diary date');
  assert.equal(model.compactMetrics.length,9,'Tracking choices do not hide this compact summary');
  for(const [key,total] of Object.entries({energy:4800,protein:240,fibre:120,carbs:600,fat:120,sugars:96,saturatedFat:24,salt:12}))assert.equal(metric(model,key).rawValue,total,key);
  assert.equal(metric(model,'protein').percent,200);assert.equal(metric(model,'protein').ratio,1);
  assert.equal(metric(model,'plants').period,'day');assert.equal(metric(model,'plants').title,'Plants today');assert.equal(metric(model,'plants').value,2);assert.equal(model.dayPlants,2);
  assert.equal(metric(model,'plants').target,5,'The saved weekly goal supplies a separate labelled daily pacing guide');
  assert.equal(metric(model,'plants').targetRole,'guide');assert.equal(metric(model,'plants').percent,40);
  assert.equal(model.weekPlantProgress.value,3);assert.equal(model.weekTarget,30);
  assert.deepEqual(model.weeklyMetrics.map(x=>x.key),model.compactMetrics.map(x=>x.key),'All nine weekly categories match the daily summary even with tracking choices hidden');
  assert.equal(model.weekSugars.value,104);assert.equal(model.weekSaturatedFat.value,26);assert.equal(model.weekSalt.value,13);
  assert.deepEqual(model.weekSalt.comparison,{intake:13,target:12,days:2});
  assert.equal(model.weeklyMetrics.find(x=>x.key==='salt').targetRole,'limit');
  assert.ok(model.weekSalt.days.every(x=>x.targetRole==='limit'),'Daily mini-rings retain the salt upper-limit role for their accessible description');
  assert.ok(model.weekEnergy.days.every(x=>x.targetRole==='reference'));assert.ok(model.weekProtein.days.every(x=>x.targetRole==='goal'));
  assert.deepEqual(model.weekSugars.comparison,{intake:104,target:180,days:2});
  assert.deepEqual(model.weekSaturatedFat.comparison,{intake:26,target:40,days:2});
  assert.equal(metric(model,'salt').targetRole,'limit');assert.equal(metric(model,'salt').percent,200);
  assert.equal(metric(model,'sugars').target,90);assert.equal(metric(model,'sugars').percent,107);
  assert.equal(metric(model,'saturatedFat').target,20);assert.equal(metric(model,'saturatedFat').percent,120);
  for(const key of ['sugars','saturatedFat']){assert.equal(metric(model,key).targetRole,'reference');assert.equal(metric(model,key).referenceKind,'adult_label');}
  const yesterday=a.project('diary',{day:'2026-10-06'});assert.equal(yesterday.rows.length,1);assert.equal(metric(yesterday,'protein').percent,null,'No backfilled personal targets');
  assert.equal(a.project('history',{filter:'photos'}).rows.length,0,'Unrelated archive filtering stays independent');
});

test('daily plants preserve saved daily targets, never carry over yesterday, and distinguish unknown from recorded zero',()=>{
  const a=boot();saveProfile(a,{...profile,dailyPlantTarget:5});add(a,'yesterday','2026-10-06',['rice','almond']);
  let model=a.project('today');assert.equal(metric(model,'plants').value,0);assert.equal(metric(model,'plants').recorded,false);assert.equal(metric(model,'plants').percent,null);assert.equal(model.weekPlants,2);
  add(a,'today','2026-10-07',['oats','oat','blueberry'],3);model=a.project('today');assert.equal(metric(model,'plants').value,2);assert.equal(metric(model,'plants').target,5);assert.equal(metric(model,'plants').percent,40);assert.equal(model.weekPlants,4);
  const yesterday=a.project('diary',{day:'2026-10-06'});assert.equal(metric(yesterday,'plants').value,2);assert.equal(metric(yesterday,'plants').title,'Plants that day');assert.equal(metric(yesterday,'plants').target,null,'No backfilled daily target');
  a.advance(86400000);model=a.project('today');assert.equal(metric(model,'plants').recorded,false);assert.equal(metric(model,'plants').value,0);assert.equal(model.weekPlants,4);
  const state=a.api.snapshot().state;
  state.foodLog.entries.push({...entry('unknown','2026-10-08'),id:'unknown',sourceMeta:{}});model=a.project('today');assert.equal(metric(model,'plants').value,null);assert.equal(metric(model,'plants').unknown,1);
  state.foodLog.entries.push({...entry('zero','2026-10-08'),id:'zero',sourceMeta:{entryKind:'product-consumption',plantKnowledge:'known'}});model=a.project('today');assert.equal(metric(model,'plants').value,0);assert.equal(metric(model,'plants').unknown,1);assert.equal(metric(model,'plants').percent,0);
  state.foodLog.entries=state.foodLog.entries.filter(x=>x.id!=='unknown');model=a.project('today');assert.equal(metric(model,'plants').value,0);assert.equal(metric(model,'plants').unknown,0);assert.equal(metric(model,'plants').recorded,true);
});

test('all weekly nutrients preserve partial, missing, zero, fractional and future data without writing records',()=>{
  const a=boot();saveProfile(a);
  const state=a.api.snapshot().state,keys=['sugars','saturatedFat','salt'];
  const nutrientRow=(id,day,portion,status='calculated',portions=1)=>({...entry(id,day,[],portions),id,nutritionSnapshot:Object.fromEntries(keys.map(key=>[key,{unit:'g',portion:status==='calculated'?portion:null,portionStatus:status,knownPortionSubtotal:status==='partial'?portion:null,knownContributions:status==='partial'?1:0,unknownContributions:status==='partial'?1:0}]))});
  state.foodLog.entries=[nutrientRow('known','2026-10-05',4,'calculated',.5),nutrientRow('zero','2026-10-06',0),nutrientRow('partial','2026-10-07',2,'partial',2),nutrientRow('unknown','2026-10-07',null,'unknown'),nutrientRow('future','2026-10-08',999)];
  const before=JSON.stringify(state),writeCount=a.writes.length,model=a.project('today');
  for(const key of ['weekSugars','weekSaturatedFat','weekSalt']){
    const week=model[key];assert.equal(week.value,6);assert.equal(week.unknown,2);assert.equal(week.estimated,true);assert.equal(week.days[0].value,2);assert.equal(week.days[1].value,0);assert.equal(week.days[2].value,4);assert.equal(week.days[2].unknown,2);assert.equal(week.days[3].value,null);assert.equal(week.days[3].future,true);
  }
  assert.deepEqual(model.weekSalt.comparison,{intake:6,target:18,days:3});assert.deepEqual(model.weekSugars.comparison,{intake:6,target:270,days:3});assert.deepEqual(model.weekSaturatedFat.comparison,{intake:6,target:60,days:3});
  assert.equal(JSON.stringify(state),before);assert.equal(a.writes.length,writeCount);
  state.foodLog.entries=[];const empty=a.project('today');for(const key of ['weekSugars','weekSaturatedFat','weekSalt']){assert.equal(empty[key].value,null);assert.equal(empty[key].loggedDays,0);}
});

test('weekly plant contribution excludes its existing entry, deduplicates names and moves across Monday',()=>{
  const a=boot();saveProfile(a);add(a,'other','2026-10-07',['oats','blueberry']);
  const old=add(a,'edit-me','2026-10-07',['oat','blueberries','almonds'],4);
  a.perform('setReview',{kind:'entry',entryId:old.id,confirmationId:'ignored'});
  let model=a.project('reviewModel');assert.equal(model.plantSummary.total,3);assert.equal(model.plantSummary.newCount,1);assert.equal(model.plantSummary.percent,3);
  a.perform('reviewUpdate',{quantity:8});assert.equal(a.project('reviewModel').plantSummary.newCount,1,'Larger portions do not create new types');
  a.perform('reviewUpdate',{day:'2026-10-04',slot:'Dinner'});model=a.project('reviewModel');assert.equal(model.plantSummary.weekStart,'2026-09-28');assert.equal(model.plantSummary.newCount,3);
  const moved=a.perform('reviewConfirm');assert.equal(moved.ok,true);assert.equal(moved.state.foodLog.entries.length,2);assert.equal(moved.review.entryId,old.id);
  assert.equal(a.project('today').compactMetrics.at(-1).value,2);assert.equal(a.project('diary',{day:'2026-10-04'}).compactMetrics.at(-1).value,3);
  assert.equal(a.perform('diaryDelete',{entryId:old.id}).ok,true);assert.equal(a.project('diary',{day:'2026-10-04'}).rows.length,0);
});

test('dates pass through new product and photo reviews without meal categories or intake writes',()=>{
  const a=boot();a.perform('recordHistory',{id:'scan',kind:'product',status:'ready',product:complete,name:complete.name});
  a.perform('setReview',{kind:'product',product:complete,eventId:'scan',confirmationId:'product',day:'2026-10-02',slot:'Breakfast'});
  assert.equal(a.project('reviewModel').draft.day,'2026-10-02');assert.equal(a.project('reviewModel').draft.slot,'');
  assert.equal(a.project('today').entryCount,0);assert.equal(a.snapshot().state.foodLog.entries.length,0);
  const raw={type:'meal',productName:'Photo meal',nutrients:{},meal:{name:'Photo meal',portion:{amount:200,unit:'g'},plants:[],ingredients:[],nutrients:nutrients({energyKcal:300,protein:10,salt:1})}};
  a.perform('setReview',{kind:'analysis',extraction:raw,confirmationId:'photo',day:'2026-10-03',slot:'Dinner',photos:[photoA,photoB],thumbnail:thumbA});
  assert.equal(a.project('reviewModel').draft.day,'2026-10-03');assert.equal(a.project('reviewModel').draft.slot,'');assert.equal(a.project('reviewModel').image,photoA);
  assert.equal(a.snapshot().state.foodLog.entries.length,0);
});

test('recent and saved foods create new destination entries retaining the exact score, nutrients and own photographs',()=>{
  const a=boot();a.open(complete);const score=a.project('reviewModel').score;
  a.perform('reviewUpdate',{day:'2026-10-06',slot:'Lunch'});const original=a.perform('reviewConfirm').review.entry;
  const photoEntry={...original,sourceMeta:{...original.sourceMeta,entryPhotos:[photoA,photoB],entryThumbnail:thumbA}};
  a.api.snapshot().state.foodLog.entries[0]=copy(photoEntry);
  a.perform('openRecent',{entryId:original.id,confirmationId:'recent-new',day:'2026-10-04',slot:'Dinner'});
  let model=a.project('reviewModel');assert.equal(model.editing,false);assert.equal(model.draft.day,'2026-10-04');assert.equal(model.draft.slot,'');assert.equal(model.image,photoA);assert.equal(model.score.value,score.value);
  const fresh=a.perform('reviewConfirm').review.entry;assert.equal(fresh.id,'recent-new');assert.deepEqual(fresh.nutritionSnapshot,original.nutritionSnapshot);assert.deepEqual(fresh.sourceMeta.entryPhotos,[photoA,photoB]);assert.equal(fresh.sourceMeta.scoreMethod.value,score.value);
  assert.equal(a.perform('foodsSaveEntry',{entryId:fresh.id}).ok,true);const saved=a.snapshot().foods.foods[0];
  a.perform('openSaved',{id:saved.id,confirmationId:'favourite-new',day:'2026-10-02',slot:'Breakfast'});
  assert.equal(a.project('reviewModel').image,photoA);assert.equal(a.project('reviewModel').draft.day,'2026-10-02');assert.equal(a.project('reviewModel').draft.slot,'');
  assert.equal(a.perform('reviewConfirm').ok,true);
  assert.equal(a.snapshot().state.foodLog.entries[0].slot,original.slot,'Reusing a food leaves the original category unchanged');
  const b=a.restart();assert.equal(b.snapshot().state.foodLog.entries.length,3);assert.deepEqual(b.snapshot().state.foodLog.entries[2].sourceMeta.entryPhotos,[photoA,photoB]);
  add(b,'same-food-other-photo','2026-10-07',[],1,{photos:[photoB],thumbnail:thumbB});
  const rows=b.project('history',{filter:'eaten'}).rows;assert.equal(rows.find(r=>r.entry.id===fresh.id).imageURL,photoA);assert.equal(rows.find(r=>r.entry.id==='same-food-other-photo').imageURL,photoB);
});

test('deleting consumption preserves its original archive event and capture timestamp',()=>{
  const a=boot();a.open(complete);const original=a.snapshot().history.events[0];const intake=a.perform('reviewConfirm').review.entry;
  a.perform('setReview',{kind:'entry',entryId:intake.id});a.perform('reviewUpdate',{day:'2026-10-01'});a.perform('reviewConfirm');
  assert.equal(a.snapshot().history.events[0].createdAt,original.createdAt);
  assert.equal(a.perform('diaryDelete',{entryId:intake.id}).ok,true);assert.equal(a.snapshot().state.foodLog.entries.length,0);
  const archive=a.project('history');assert.equal(archive.rows.length,1);assert.equal(archive.rows[0].entry,undefined);assert.equal(archive.rows[0].status,'ready');assert.equal(archive.rows[0].createdAt,original.createdAt);
});

test('profile saves recalculate automatic values synchronously, retain manual overrides and restore Automatic after restart',()=>{
  const a=boot(),first=saveProfile(a);assert.equal(first.target,120);assert.match(a.project('today').targetModeLabel,/Automatic/);
  const changed=saveProfile(a,{...first,weight:80});assert.equal(changed.target,128);
  const manual=saveProfile(a,{...changed,target:135});assert.equal(manual.targetModes.protein,'manual');assert.match(a.project('today').targetModeLabel,/Automatic \+ custom/);
  const retained=saveProfile(a,{...manual,weight:90,goals:['sleep','steady_routine']});assert.equal(retained.target,135);
  const b=a.restart();assert.equal(metric(b.project('today'),'protein').target,135);
  const restored=saveProfile(b,{...retained,targetModes:{...retained.targetModes,protein:'automatic'}});assert.equal(restored.target,144);
  assert.equal(metric(b.project('reviewModel'),'protein')?.target,144);
});

test('logged protein carbs and fat keep their known progress through incomplete food, portions and restart',()=>{
  const a=boot();saveProfile(a);
  add(a,'known','2026-10-07',[],.5);
  const partial=entry('partial','2026-10-07',[],2);
  partial.energyPerPortion=null;partial.proteinPerPortion=null;partial.fibrePerPortion=null;
  partial.nutritionSnapshot=Object.fromEntries(['protein','carbohydrate','fat'].map(key=>[key,{unit:'g',portion:null,portionStatus:'partial',knownPortionSubtotal:3,knownContributions:1,unknownContributions:1}]));
  assert.equal(a.perform('setReview',{kind:'entry',entry:partial,confirmationId:'partial',day:'2026-10-07'}).ok,true);
  assert.equal(a.perform('reviewConfirm').ok,true);
  const unknown={...entry('unknown','2026-10-07'),energyPerPortion:null,proteinPerPortion:null,fibrePerPortion:null,nutritionSnapshot:{}};
  assert.equal(a.perform('setReview',{kind:'entry',entry:unknown,confirmationId:'unknown',day:'2026-10-07'}).ok,true);
  assert.equal(a.perform('reviewConfirm').ok,true);
  for(const session of [a,a.restart()]){
    const before=JSON.stringify(session.snapshot().state),writes=session.writes.length;
    for(const view of ['today','diary']){
      const m=session.project(view,{day:'2026-10-07',presentation:true});
      for(const [key,total] of [['protein',16],['carbs',31],['fat',11]]){
        const item=metric(m,key);
        assert.equal(item.rawValue,total,key+' retains its known subtotal');
        assert.equal(item.recorded,true);assert.equal(item.unknown,2);assert.equal(item.estimated,true);
        assert.ok(item.target>0);assert.ok(item.ratio>0,key+' has a visible proportional arc');
        assert.equal(item.ratio,Math.min(1,total/item.target));
        assert.equal(item.percent,Math.round(total/item.target*100));
      }
    }
    assert.equal(JSON.stringify(session.snapshot().state),before,'Displaying progress does not alter saved food');
    assert.equal(session.writes.length,writes,'Displaying progress does not write storage');
  }
});

test('personal details without activity explain missing energy and macro targets on Today, weekly rows and food review',()=>{
  const a=boot(),first=saveProfile(a,{...profile,activity:'unknown'});
  add(a,'logged-food','2026-10-07');
  const today=a.project('today');
  assert.equal(metric(today,'protein').target,120);assert.equal(metric(today,'fibre').target,30);
  assert.equal(metric(today,'energy').target,null);assert.equal(metric(today,'energy').targetReason,'Add activity');
  for(const key of ['carbs','fat'])assert.equal(metric(today,key).targetReason,'Add activity to estimate energy');
  assert.equal(today.weekEnergy.days.find(x=>x.day==='2026-10-07').targetReason,'Add activity');
  a.perform('setReview',{kind:'product',product:complete,confirmationId:'review-targets'});
  assert.equal(metric(a.project('reviewModel'),'energy').targetReason,'Add activity');
  a.advance(86400000);saveProfile(a,{...first,activity:'moderate'});
  assert.equal(metric(a.project('today'),'energy').target,2550);
  assert.equal(metric(a.project('today'),'energy').targetReason,null);
  assert.equal(metric(a.project('diary',{day:'2026-10-07'}),'energy').targetReason,'Add activity');
  assert.equal(metric(a.project('diary',{day:'2026-10-06'}),'energy').targetReason,'Historical target not recorded');
});

test('photo reference cleaning rejects arbitrary paths and blobs while retaining only four valid private refs',()=>{
  const a=boot();a.perform('recordHistory',{id:'photo-history',kind:'product',status:'ready',product:complete,photos:[photoA,photoB,'file:///private/secret','nudge-photo:../../secret.jpg','data:image/jpeg;base64,YWJj']});
  assert.deepEqual(a.snapshot().history.events[0].photos,[photoA,photoB]);assert.equal(a.project('history').rows[0].imageURL,photoA);
  assert.deepEqual(a.restart().snapshot().history.events[0].photos,[photoA,photoB]);
});

test('unknown nutrition, recorded zero and invalid target remain distinct in compact totals and review',()=>{
  const a=boot(),saved=saveProfile(a);
  a.perform('setReview',{kind:'product',product:{...complete,nutrients:nutrients({energyKcal:0,protein:null,fat:0,salt:0})},confirmationId:'unknowns'});
  const review=a.project('reviewModel');assert.equal(metric(review,'protein').value,null);assert.equal(metric(review,'protein').percent,null);assert.equal(metric(review,'salt').percent,0);
  assert.equal(metric(review,'plants').value,null,'No ingredients cannot establish zero plant types');
  assert.equal(a.perform('reviewConfirm').ok,true);
  const total=a.project('today');assert.equal(metric(total,'protein').value,null);assert.equal(metric(total,'protein').percent,null);assert.equal(metric(total,'energy').value,0);assert.equal(metric(total,'energy').percent,0);
  saveProfile(a,{...saved,carbTarget:0});assert.equal(metric(a.project('today'),'carbs').target,null);assert.equal(metric(a.project('today'),'carbs').percent,null,'A zero target cannot divide nutrition');
  a.perform('setReview',{kind:'entry',entry:entry('date-error','2026-10-07'),confirmationId:'bad-date'});a.perform('reviewUpdate',{day:'2026-02-30'});assert.equal(a.project('reviewModel').valid,false,'An invalid date remains a review error without breaking the projection');
});

test('linked product edits preserve historical scores and the full legacy multiplier until food facts change',()=>{
  const a=boot();a.open(complete);const original=a.perform('reviewConfirm').review.entry;
  const legacy=copy(original);legacy.portions=2;legacy.sourceMeta.entryPhotos=[photoA,photoB];legacy.sourceMeta.entryThumbnail=thumbA;
  // A previously confirmed catalogue rating can differ from today's model.
  legacy.sourceMeta.scoreMethod={...legacy.sourceMeta.scoreMethod,value:87,grade:'A'};
  a.api.snapshot().state.foodLog.entries[0]=legacy;
  a.perform('setReview',{kind:'product',product:complete,entryId:legacy.id,eventId:'scan-1'});
  let model=a.project('reviewModel');assert.equal(model.amount,200);assert.equal(metric(model,'energy').value,200);assert.equal(model.score.value,87);
  a.perform('reviewUpdate',{day:'2026-10-04',slot:'Dinner'});model=a.project('reviewModel');assert.equal(model.score.value,87);assert.equal(metric(model,'protein').value,13.4);
  a.perform('reviewUpdate',{measureId:'g',quantity:300});assert.equal(a.project('reviewModel').score.value,87);assert.equal(metric(a.project('reviewModel'),'energy').value,300);
  const updated=a.perform('reviewConfirm').review.entry;assert.equal(updated.id,legacy.id);assert.equal(updated.portions,1);assert.equal(updated.portionAmount,300);assert.equal(updated.energyPerPortion,300);assert.equal(updated.sourceMeta.scoreMethod.value,87);assert.deepEqual(updated.sourceMeta.entryPhotos,[photoA,photoB]);
  assert.equal(a.snapshot().history.events[0].createdAt,'2026-10-07T12:00:00.000Z');
  a.perform('setReview',{kind:'product',product:complete,entryId:legacy.id,eventId:'scan-1'});a.perform('reviewUpdate',{nutrient:{key:'salt',value:'8'}});
  assert.notEqual(a.project('reviewModel').score.value,87,'An explicit nutrition edit uses current evidence and rating');
});

test('large valid legacy product multiples retain saved portions beyond the single-product amount limit',()=>{
  const a=boot();a.open(complete);const original=a.perform('reviewConfirm').review.entry;
  const legacy={...copy(original),portionAmount:1000,portions:8};a.api.snapshot().state.foodLog.entries[0]=legacy;
  a.perform('setReview',{kind:'product',product:complete,entryId:legacy.id,eventId:'scan-1'});
  assert.equal(a.project('reviewModel').kind,'entry');assert.equal(a.project('reviewModel').valid,true);assert.equal(a.project('reviewModel').amount,8000);
  a.perform('reviewUpdate',{day:'2026-10-04'});const saved=a.perform('reviewConfirm').review.entry;
  assert.equal(saved.portions,8);assert.equal(saved.portionAmount,1000);assert.deepEqual(saved.nutritionSnapshot,original.nutritionSnapshot);
});
