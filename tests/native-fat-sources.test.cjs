// Actual native projections with synthetic, isolated storage; no owner data or network.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const copy=value=>JSON.parse(JSON.stringify(value));
const files=['streaks.js','recipe-catalogue-data.js','recipe-catalogue.js','core/food-log.js','core/diary.js','core/nutrition-profile.js','core/product-evidence.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','core/analysis-result.js','scan-results.js','today-goals.js','cycle-support.js','search-model.js','diet.js','scan-history.js','repertoire.js','native-review.js','native-session.js','food-catalogue.js'];
const main='wmd-nudge-prototype-v1',day='2026-10-15';
const nutrient=value=>({unit:'g',portion:value,portionStatus:value===null?'unknown':'calculated'});
const entry=(id,extra={})=>({id,name:'Synthetic food',day,slot:'Breakfast',portions:1,plants:[],ferments:[],source:'Label',nutritionSnapshot:{fat:nutrient(5),saturatedFat:nutrient(3)},...extra});
const selection=names=>({version:'meal-ingredients-v1',source:'user',confirmed:true,names});
function boot(entries){
  const values=new Map([[main,JSON.stringify({version:1,foodLog:{entries,savedRecipes:[],plantGoal:30}})]]),io=[];
  const scope={console,Date,Math,JSON,URL,document:{addEventListener(){},getElementById(){return null;}},location:{protocol:'native:'},nativeToday:()=>day,nativeNow:()=>day+'T12:00:00Z',nativeDiagnostic(){},nativeStorage:input=>{
    const request=JSON.parse(input);io.push(request);
    if(request.operation==='get')return JSON.stringify({ok:true,value:values.get(request.key)??null});
    throw Error('Projection unexpectedly attempted a storage mutation');
  }};
  scope.window=scope;vm.createContext(scope);
  for(const file of files)vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),scope,{filename:file});
  const api=scope.NudgeNativeSession;assert.equal(api.init().readFailed,false);io.length=0;
  return {api,scope,io,values,project:(operation='today',p={})=>copy(api.project(operation,p))};
}

test('Today and Diary fat sources share exact daily totals and retain saved evidence without writes',()=>{
  const a=boot([entry('yoghurt',{name:'Plain Greek yoghurt',portions:1.5}),entry('nuts',{name:'Walnuts',portions:.5,nutritionSnapshot:{fat:nutrient(6.4),saturatedFat:nutrient(.6)}}),entry('yesterday',{day:'2026-10-14'}),entry('future',{day:'2026-10-16'})]);
  const beforeBytes=new Map(a.values),before=copy(a.api.snapshot());a.io.length=0;
  const today=a.project(),thin=a.project('today',{presentation:true}),diary=a.project('diary',{day,presentation:true});
  assert.deepEqual(today.fatSources,diary.fatSources);assert.deepEqual(thin.fatSources,today.fatSources);
  assert.deepEqual(today.fatSources.rows.map(r=>r.id),['yoghurt','nuts']);
  for(const field of ['fat','saturatedFat'])assert.equal(today.fatSources.rows.reduce((sum,r)=>sum+r[field],0),today.compactMetrics.find(m=>m.key===field).rawValue);
  assert.equal(today.fatSources.rows[0].fat,7.5);assert.equal(today.fatSources.rows[0].saturatedFat,4.5);
  assert.equal(today.fatSources.rows[0].context,'Fermented dairy · yoghurt');
  assert.deepEqual(a.project('diary',{day:'2026-10-14'}).fatSources.rows.map(r=>r.id),['yesterday']);
  assert.deepEqual(a.project('diary',{day:'2026-10-13'}).fatSources.rows,[]);
  assert.deepEqual(a.io,[]);assert.deepEqual(a.values,beforeBytes);assert.deepEqual(copy(a.api.snapshot()),before);
});

test('mixed meal context never reallocates its measured fat to yoghurt or fabricates unsaturated fat',()=>{
  const a=boot([entry('smoothie',{name:'Berry and nut smoothie',portions:2,sourceMeta:{mealIngredientSelection:selection(['Yoghurt','Walnuts','Blueberries'])},nutritionSnapshot:{fat:nutrient(12.2),saturatedFat:nutrient(2.1)}})]);
  const sources=a.project().fatSources,row=sources.rows[0];
  assert.equal(row.name,'Berry and nut smoothie');assert.equal(row.context,'Contains yoghurt · fermented dairy');
  assert.equal(row.fat,24.4);assert.equal(row.saturatedFat,4.2);
  assert.equal(row.unsaturatedFat,undefined);assert.equal(row.goodFat,undefined);assert.equal(row.yoghurtFat,undefined);
  assert.match(sources.note,/whole logged food/);assert.match(sources.note,/saturated fat is still included/);
  const output=JSON.stringify(sources);assert.doesNotMatch(output,/good fat|healthy fat|beneficial|unsaturated/i);
});

test('null, zero, partial amounts and estimates preserve the existing nutrient reader semantics',()=>{
  const partial={unit:'g',portion:null,portionStatus:'partial',knownPortionSubtotal:2.4,knownContributions:1,unknownContributions:1};
  const a=boot([entry('zero',{nutritionSnapshot:{fat:nutrient(0),saturatedFat:nutrient(0)}}),entry('unknown',{nutritionSnapshot:{fat:nutrient(null),saturatedFat:nutrient(null)}}),entry('partial',{portions:2,nutritionSnapshot:{fat:partial,saturatedFat:nutrient(null)}}),entry('photo',{sourceMeta:{nutritionEstimate:'photo'}})]);
  const [zero,unknown,part,photo]=a.project().fatSources.rows;
  assert.equal(zero.fat,0);assert.equal(zero.saturatedFat,0);assert.equal(zero.fatPartial,false);
  assert.equal(unknown.fat,null);assert.equal(unknown.saturatedFat,null);
  assert.equal(part.fat,4.8);assert.equal(part.fatPartial,true);assert.equal(part.fatEstimated,true);assert.equal(part.saturatedFat,null);
  assert.equal(photo.fatEstimated,true);assert.equal(photo.saturatedFatEstimated,true);
});

test('saved source-bound composition uses the same meal and portion multipliers as the summary',()=>{
  const component={name:'Greek yoghurt',amountGrams:120,recordId:'synthetic-yoghurt',sourceRecord:{id:'synthetic-yoghurt',name:'Plain Greek yogurt',basis:'per100g',foodGroup:'dairy'},nutrients:{fat:{value:8,unit:'g'},saturatedFat:{value:5,unit:'g'}}};
  const a=boot([entry('composition',{name:'Breakfast smoothie',portions:2,nutritionSnapshot:{},sourceMeta:{photoPortions:'0.5',mealComposition:[component]}})]);
  const projection=a.project(),row=projection.fatSources.rows[0];
  assert.equal(row.fat,9.6);assert.equal(row.saturatedFat,6);assert.equal(row.fatEstimated,true);
  assert.equal(row.context,'Contains yoghurt · fermented dairy');
  for(const field of ['fat','saturatedFat'])assert.equal(row[field],projection.compactMetrics.find(m=>m.key===field).rawValue);
});

test('confirmed selections supersede old yoghurt guesses including an explicitly empty choice',()=>{
  const stale={name:'Greek yoghurt',amountGrams:100,recordId:'synthetic',sourceRecord:{id:'synthetic',name:'Greek yoghurt',foodGroup:'dairy',basis:'per100g'}};
  const entries=[[],['Oats'],['Coconut yoghurt']].map((names,i)=>entry('removed-'+i,{name:'Greek yoghurt',ingredients:{text:'Yoghurt, berries',needsReview:false},sourceMeta:{mealComposition:[stale],mealIngredientSelection:selection(names)}}));
  entries.push(entry('mixed',{name:'Greek yoghurt',sourceMeta:{mealIngredientSelection:selection(['Greek yoghurt','Walnuts'])}}));
  const rows=boot(entries).project().fatSources.rows;
  for(const row of rows.slice(0,3))assert.equal(row.context,'');
  assert.equal(rows[3].context,'Contains yoghurt · fermented dairy');
});

test('yoghurt context distinguishes dairy identity and explicit ingredients from alternatives and guesses',()=>{
  const foods=['Fage Total 5% Greek Yoghurt','Natural yogurt 0%','Coconut yoghurt','Dairy-free Greek yoghurt','Soy yogurt','Vegan yogurt','Yogurt-coated raisins','Frozen yogurt','Yogurt-flavoured powder','Smoothie without yogurt'];
  const entries=foods.map((name,i)=>entry('name-'+i,{name}));
  entries.push(entry('ingredients',{name:'Smoothie',ingredients:{text:'Berries, yoghurt (milk), coconut oil',needsReview:false}}));
  entries.push(entry('unreviewed',{name:'Smoothie',ingredients:{text:'Yoghurt, berries',needsReview:true}}));
  entries.push(entry('plant-ingredients',{name:'Smoothie',ingredients:{text:'Berries, coconut yoghurt',needsReview:false}}));
  const rows=boot(entries).project().fatSources.rows;
  for(const row of rows.slice(0,2))assert.equal(row.context,'Fermented dairy · yoghurt',row.name);
  for(const row of rows.slice(2,foods.length))assert.equal(row.context,'',row.name);
  assert.equal(rows[foods.length].context,'Contains yoghurt · fermented dairy');
  assert.equal(rows[foods.length+1].context,'');assert.equal(rows[foods.length+2].context,'');
});
