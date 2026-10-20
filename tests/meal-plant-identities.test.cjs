// Synthetic food identities only; never owner entries or inferred mix species.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {test}=require('node:test');
const s={Date,console};s.window=s;vm.createContext(s);
for(const file of ['streaks.js','core/food-log.js','core/nutrition-profile.js','core/nudge-score.js','core/food-composition.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/product-evidence.js','core/frequency-policy.js','core/analysis-result.js','today-goals.js','native-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),s,{filename:file});
const copy=v=>JSON.parse(JSON.stringify(v)),R=s.NudgeNativeReview,C=s.NudgeComposition,L=s.WmdFoodLog;
const day='2026-10-20',options={today:day},state={foodLog:{entries:[]}};
const component=name=>({name,preparation:'unknown',amountGrams:null,recordId:null,sourceRecord:null,nutrients:{},evidence:'Visible '+name,photoIndex:1});
const meal=names=>({type:'meal',nutrients:{},meal:{name:'Synthetic meal',compositionVersion:'test',components:names.map(component),
  ingredients:names.map(name=>({name,evidence:'Visible '+name})),plants:[],nutrients:{},portion:{amount:null,unit:null},
  subject:{kind:'plated_meal',description:'Synthetic foreground food',photoIndex:1},portionAmbiguity:{requiresSelection:false}}});
const sorted=v=>copy(v).sort();
test('explicit ingredient names identify plants in catalogue wording without inventing anonymous mixes or grain species',()=>{
  assert.deepEqual(sorted(C.namedIngredientPlants(['Chutney, apple, homemade','Wheat and rye sourdough bread','Basil, fresh']).map(p=>p.name)),['apple','basil','rye','wheat']);
  assert.deepEqual(copy(C.namedIngredientPlants(['Sourdough bread','Bread, french or vienna (includes sourdough)','Chutney','3 seed mix','5 nut mix','mixed berries'])),[]);
  for(const name of ['Olive oil','Sunflower oil','Oil, coconut','Apple juice','Juice, apple','Pea protein powder','Protein powder, pea','Whey protein powder','Coconut milk','No almonds','May contain peanuts','Almond extract','without almonds and walnuts','peanut-free','free from almonds and walnuts'])
    assert.deepEqual(copy(C.namedIngredientPlants([name])),[],name);
  assert.deepEqual(sorted(L.ingredientPlants(['Peanut butter','Peanuts','Basil','Chutney, apple, homemade','Wheat sourdough'])),['apple','basil','peanut','wheat']);
  assert.deepEqual(copy(L.ingredientPlants(['Edamame','Tofu','Soybean'])),['soybean']);
  assert.deepEqual(copy(L.ingredientPlants(['Sweetcorn','maize','corn'])),['maize']);
  assert.deepEqual(copy(L.ingredientPlants(['chick peas','chickpeas','garbanzo beans'])),['chickpea']);
  assert.deepEqual(copy(L.ingredientPlants(['black eyed peas','black-eyed peas','cowpeas'])),['cowpea']);
  assert.deepEqual(copy(L.ingredientPlants(['Peas','green peas'])),['pea']);
  assert.deepEqual(copy(L.ingredientPlants(['Oat','Oats','Rolled oats'],{plants:['oat','oats']})),['oats']);
  assert.deepEqual(copy(L.ingredientPlants(['paprika','chilli','red pepper'],{plants:['paprika','chilli','capsicum']})),['capsicum']);
  assert.deepEqual(copy(C.namedIngredientPlants(['peanut-free almond butter']).map(p=>p.name)),['almond']);
  assert.deepEqual(copy(C.namedIngredientPlants(['Basil without almonds and walnuts']).map(p=>p.name)),['basil']);
});
test('additive ingredient hints retain observed sides through confirmation, cleaning, reopening and diary totals',()=>{
  const raw=meal(['Wheat sourdough bread','Cheese','Chutney, apple, homemade','Celery','Tomato']);
  raw.meal.userIngredientSelection={version:'meal-ingredients-v1',source:'user',scope:'includes',names:['Wheat sourdough bread','Cheese','Chutney, apple, homemade']};
  const before=JSON.stringify(raw),review=R.prepare({kind:'analysis',extraction:raw,confirmationId:'synthetic-sandwich'},state,options),expected=['apple','celery','tomato','wheat'];
  assert.deepEqual(sorted(R.model(review,state,options).plants),expected);
  assert.match(R.model(review,state,options).ingredients,/celery/i);
  const result=R.record(review,state,options);assert.equal(result.ok,true);
  assert.equal(result.record.sourceMeta.mealIngredientSelection.scope,'includes');
  assert.deepEqual(sorted(result.record.plants),expected);
  const saved=L.clean({entries:[result.record]}).entries[0];assert.deepEqual(sorted(L.intakePlants(saved)),expected);
  assert.deepEqual(sorted(R.model({kind:'entry',entry:saved,confirmationId:'synthetic-reopen'},state,options).plants),expected);
  assert.equal(s.NudgeToday.projection({foodLog:{entries:[saved,{...copy(saved),id:'synthetic-repeat',portions:2}]}},day).dayPlants,4);
  assert.ok(Object.values(saved.nutritionSnapshot).every(n=>n.portion===null),'Plant identity never fills missing nutrients');
  assert.equal(JSON.stringify(raw),before);
  const exclusive=R.update(review,{mealIngredients:['Cheese']},state,options),removed=R.record(exclusive,state,options);
  assert.equal(removed.ok,true);assert.deepEqual(copy(removed.record.plants),[]);
  assert.notEqual(removed.record.sourceMeta.mealIngredientSelection.scope,'includes');
  assert.deepEqual(copy(L.intakePlants(removed.record)),[],'An explicit complete edit still removes unselected plants');
});
test('sixteen explicitly named plants survive tags, save, reopen and diary deduplication',()=>{
  const names=['Blueberries','Raspberries','Strawberries','Blackberries','Banana','Chia seeds','Flaxseed','Hemp seeds',
    'Pumpkin seeds','Sunflower seeds','Almonds','Walnuts','Cashews','Pecans','Basil','Mint'];
  const input={kind:'analysis',extraction:meal([]),confirmationId:'synthetic-sixteen'};
  let review=R.update(input,{mealIngredients:names},state,options),model=R.model(review,state,options);
  assert.equal(model.plants.length,16);assert.equal(model.mealBuilder.selected.length,16);
  const saved=R.record(review,state,options);assert.equal(saved.ok,true);
  assert.equal(saved.record.plants.length,16);assert.equal(L.intakePlants(L.clean({entries:[saved.record]}).entries[0]).length,16);
  const reopened=R.model({kind:'entry',entry:saved.record,confirmationId:'synthetic-sixteen-reopen'},state,options);
  assert.equal(reopened.plants.length,16);assert.equal(reopened.mealBuilder.selected.length,16);
  assert.equal(s.NudgeToday.projection({foodLog:{entries:[saved.record]}},day).dayPlants,16);
  review=R.update(review,{mealIngredients:['3 seed mix','5 nut mix','Mixed berries']},state,options);
  const anonymous=R.record(review,state,options);assert.equal(anonymous.ok,true);assert.deepEqual(copy(anonymous.record.plants),[]);
});
test('new diary entries have no meal category while saved categories and explicit plant exclusions remain intact',()=>{
  const original={id:'synthetic-legacy',name:'Legacy apple chutney',day,slot:'Lunch',portions:1,plants:[],
    ingredients:{text:'Chutney, apple, homemade',plants:[],needsReview:true},
    sourceMeta:{confirmationId:'synthetic-legacy-confirmation',mealIngredientSelection:{source:'user',confirmed:true,names:['Chutney, apple, homemade']},mealComposition:[component('Chutney, apple, homemade')]}};
  const before=JSON.stringify(original),oldState={foodLog:{entries:[original]}};
  assert.deepEqual(copy(L.intakePlants(original)),['apple'],'Previously unsupported named selected plants can now be identified');
  const edited=R.record({kind:'entry',entryId:original.id},oldState,options);
  assert.equal(edited.ok,true,edited.error);assert.equal(edited.record.slot,'Lunch');
  const reused=R.record({kind:'entry',entry:original,slot:'Dinner',confirmationId:'synthetic-new'},state,options);
  assert.equal(reused.ok,true);assert.equal(reused.record.slot,'');
  assert.equal(L.clean({entries:[{...copy(original),slot:''}]}).entries[0].slot,'');
  const excluded={...copy(original),sourceMeta:{...original.sourceMeta,plantSelectionConfirmed:true}};
  assert.deepEqual(copy(L.intakePlants(excluded)),[]);
  assert.equal(JSON.stringify(original),before);
});
