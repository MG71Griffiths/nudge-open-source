// Restored native discovery uses the existing pure search and review rules.
// Synthetic fixtures only; no network or owner data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const copy=value=>JSON.parse(JSON.stringify(value));
const files=['streaks.js','recipe-catalogue-data.js','recipe-catalogue.js','core/food-log.js','core/diary.js','core/nutrition-profile.js','core/product-evidence.js','core/nudge-score.js','core/food-composition.js','core/meal-recovery-data.js','core/meal-recovery.js','core/recipe-composition.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','core/analysis-result.js','scan-results.js','today-goals.js','cycle-support.js','search-model.js','diet.js','scan-history.js','repertoire.js','native-review.js','native-session.js','food-catalogue.js'];
function boot(values=new Map()){
  let failedKey='';const writes=[],reads=[];
  const s={console,Date,Math,JSON,URL,document:{addEventListener(){},getElementById(){return null;}},location:{protocol:'native:'},nativeToday:()=> '2026-10-11',nativeNow:()=> '2026-10-11T12:00:00Z',nativeDiagnostic(){},nativeStorage:input=>{
    const r=JSON.parse(input);
    if(r.operation==='get'){reads.push(r.key);return JSON.stringify({ok:true,value:values.get(r.key)??null});}
    if(r.key===failedKey)return '{"ok":false}';
    writes.push(r);if(r.operation==='set')values.set(r.key,r.value);else if(r.operation==='remove')values.delete(r.key);else throw Error('Unexpected operation');return '{"ok":true}';
  }};
  s.window=s;vm.createContext(s);for(const file of files)vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),s,{filename:file});
  const api=s.NudgeNativeSession;assert.equal(api.init().readFailed,false);
  return {api,values,writes,reads,fail:key=>failedKey=key,perform:(op,p={})=>copy(api.perform(op,p)),project:(op,p={})=>copy(api.project(op,p)),snapshot:()=>copy(api.snapshot()),restart:()=>boot(values)};
}
const values={energyKcal:100,protein:6,fibre:5,salt:.3,sugars:1,fat:2,saturatedFat:.3,carbohydrate:14};
const nutrients=Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{value,unit:k==='energyKcal'?'kcal':'g',status:'supplied'}]));
const product={name:'Fixture chickpeas',brand:'Test',barcode:'12345678',basisUnit:'g',servingAmount:100,servingUnit:'g',nutritionPreparation:'as_sold',categories:['en:legumes'],ingredients:'Chickpeas, water',nutrients};
const photo='nudge-photo:12345678-1234-1234-1234-123456789abc.jpg';
const meal={type:'meal',productName:'Fixture lunch',nutrients:{},meal:{name:'Fixture lunch',portion:{amount:250,unit:'g'},plants:[],ingredients:[],nutrients}};
const historyRow=(a,id)=>a.project('history').rows.find(r=>r.id===id);
function scan(a,id,extra={}){assert.equal(a.perform('recordHistory',{id,kind:'product',status:'ready',name:product.name,product,createdAt:'2026-10-11T10:00:00Z',...extra}).ok,true);}

test('All and Recipes restore the local library with shared query aliases and parsed filters',()=>{
  const a=boot(),all=a.project('search');assert.ok(all.rows.some(row=>row.kind==='recipe'&&row.id==='berry'));assert.ok(all.recipeCount>=3);
  const recipes=a.project('search',{kind:'recipe',query:'garbanzo'});assert.ok(recipes.rows.length>0);assert.ok(recipes.rows.every(row=>row.kind==='recipe'&&/chickpea/i.test(row.name)));
  assert.deepEqual(a.project('search',{parseQuery:true,query:'chickpeas products 50%+ for menopause dinner'}),{parsedQuery:'chickpeas dinner',filters:{query:'chickpeas dinner',minimumScore:50,meal:'all',support:'menopause',kind:'product'}});
  const hints=a.project('search',{typedQuery:'chikpea'}).suggestions;assert.ok(hints.some(value=>/chickpea/i.test(value)));
});

test('loaded product order and literal query policy preserve provider results while filtering local history',()=>{
  const a=boot();scan(a,'local-rice',{product:{...product,barcode:'22222222',name:'Local rice',ingredients:'Rice, water',categories:['en:rice']}});
  const remote={...product,name:'Provider full-text result',categories:['en:canned-chickpeas']};
  const rows=a.project('search',{kind:'product',query:'garbanzo',products:[remote]}).rows;
  assert.deepEqual(rows.map(row=>row.id),[product.barcode]);assert.equal(rows[0].product.name,'Provider full-text result');
  const category=a.project('search',{kind:'product',products:[remote],categoryTags:['en:canned-chickpeas']});assert.equal(category.rows.length,1);assert.equal(category.loadedProductCount,1);
  scan(a,'duplicate',{product:{...product,name:'Older local version'}});
  assert.equal(a.project('search',{kind:'product',products:[remote]}).rows.filter(row=>row.id===product.barcode).length,1);
});

test('rating filters and both numeric sorts preserve zero and put unknown ratings last',()=>{
  const a=boot(),products=[{...product,barcode:'10000001',name:'Zero'},{...product,barcode:'10000002',name:'High'},{...product,barcode:'10000003',name:'Unknown'}];
  const ratings={'10000001':{value:0},'10000002':{value:75,subtitle:'Verified fixture rating'},'10000003':{value:null}};
  const filtered=a.project('search',{kind:'product',products,ratings,minimumScore:50});assert.deepEqual(filtered.rows.map(row=>row.score),[75]);
  assert.equal(filtered.rows[0].ratingSubtitle,'Verified fixture rating');
  assert.equal(a.project('search',{kind:'product',products,ratings}).rows.find(row=>row.score===null).ratingSubtitle,'Rating unavailable');
  assert.deepEqual(a.project('search',{kind:'product',products,ratings,sort:'ratingLowest'}).rows.map(row=>row.score),[0,75,null]);
  assert.deepEqual(a.project('search',{kind:'product',products,ratings,sort:'ratingHighest'}).rows.map(row=>row.score),[75,0,null]);
  assert.deepEqual(a.project('search',{kind:'product',products,ratings,sort:'nameAscending'}).rows.map(row=>row.name),['High','Unknown','Zero']);
});

test('saved profile requirements hide incompatible or unverified recommendations with reasons',()=>{
  const a=boot();a.api.snapshot().state.nutritionProfile={diet:'vegan',allergies:[],avoids:[]};
  const unverified={...product,ingredientsNeedsReview:false,labelsTags:[]};
  const vegan={...product,barcode:'87654321',labelsTags:['en:vegan']};
  const result=a.project('search',{products:[unverified,vegan]});
  assert.equal(result.rows.some(row=>row.id===product.barcode),false);assert.equal(result.rows.some(row=>row.id===vegan.barcode),true);
  assert.ok(result.excludedRecipes.some(row=>row.id==='berry'));assert.ok(result.excludedReasons.some(reason=>/vegan/i.test(reason)));
  a.api.snapshot().state.nutritionProfile={allergies:['milk'],avoids:[],diet:'any'};
  const milk=a.project('search',{kind:'recipe'});assert.equal(milk.rows.some(row=>row.id==='berry'),false);assert.ok(milk.excludedRecipes.some(row=>row.id==='berry'&&/milk/i.test(row.reason)));
});

test('removed meal filters are inert and stage filters still require source evidence',()=>{
  const a=boot();const serving={...product,categories:['en:canned-chickpeas'],sourceURL:'https://world.openfoodfacts.org/product/12345678',micronutrients:{iron:{value:2.1,unit:'mg',status:'supplied'},calcium:{value:200,unit:'mg',status:'supplied'}}};
  assert.equal(a.project('search',{kind:'product',products:[serving],meal:'dinner',support:'period'}).rows.length,1);
  assert.equal(a.project('search',{kind:'product',products:[serving],meal:'breakfast'}).rows.length,1);
  const guessed={...serving,name:'Period iron dinner miracle',categories:[],micronutrients:{}};
  assert.equal(a.project('search',{kind:'product',products:[guessed],meal:'dinner',support:'period'}).rows.length,0);
});

test('Saved prefers reusable portions without duplicate catalogue rows or new eating records',()=>{
  const a=boot();scan(a,'scan');assert.equal(a.perform('historyToggleFavourite',{id:'scan'}).ok,true);assert.equal(a.perform('recipeFavourite',{id:'berry'}).ok,true);
  const saved=a.project('search',{savedOnly:true});assert.ok(saved.rows.some(row=>row.kind==='recipe'&&row.id==='berry'));assert.equal(saved.rows.some(row=>row.kind==='product'&&row.id===product.barcode),false);assert.equal(saved.rows.filter(row=>row.kind==='saved').length,1);
  const products=a.project('search',{savedOnly:true,kind:'product',query:'chickpeas'});assert.ok(products.rows.some(row=>row.kind==='saved'));assert.ok(products.rows.every(row=>row.kind!=='recipe'));
  const before=a.snapshot(),stored=[...a.values],writes=a.writes.length;
  for(let n=0;n<3;n++)for(const kind of ['all','recipe','product'])a.project('search',{kind,savedOnly:n%2===0,typedQuery:'chick'});
  assert.deepEqual(a.snapshot(),before);assert.deepEqual([...a.values],stored);assert.equal(a.writes.length,writes);assert.equal(a.snapshot().state.foodLog.entries.length,0);
});

test('Saved keeps distinct portions and filters each one before replacing a favourite recipe or product',()=>{
  const a=boot();scan(a,'small');assert.equal(a.perform('historyToggleFavourite',{id:'small'}).ok,true);
  scan(a,'large',{product:{...product,servingAmount:200}});assert.equal(a.perform('historyToggleFavourite',{id:'large'}).ok,true);
  assert.equal(a.project('search',{savedOnly:true,kind:'product'}).rows.filter(row=>row.kind==='saved').length,2);
  assert.equal(a.project('search',{savedOnly:true,kind:'product'}).rows.filter(row=>row.kind==='product').length,0);
  assert.equal(a.perform('recipeFavourite',{id:'berry'}).ok,true);
  assert.equal(a.perform('recipeLog',{id:'berry',slot:'Dinner',confirmationId:'saved-berry'}).ok,true);
  assert.equal(a.perform('reviewSaveFood').ok,true);
  const all=a.project('search',{savedOnly:true,kind:'recipe',query:'berry'}).rows;
  assert.equal(all.some(row=>row.id==='berry'),false);assert.equal(all.filter(row=>row.kind==='saved').length,1);
  const breakfast=a.project('search',{savedOnly:true,kind:'recipe',query:'berry',meal:'breakfast'}).rows;
  assert.deepEqual(breakfast,all,'Removed meal filters cannot replace or hide saved portions');
  assert.equal(a.project('search',{savedOnly:true,kind:'product',meal:'dinner'}).rows.every(row=>row.kind==='saved'),true);
  assert.equal(a.snapshot().state.foodLog.entries.length,0);
});

test('product requirements reject conflicting and missing declarations while allowing verified free-from evidence',()=>{
  const a=boot();a.api.snapshot().state.nutritionProfile={diet:'any',allergies:['milk'],avoids:[]};
  const free={...product,labelsTags:['en:milk-free'],ingredients:'Chickpeas, water'};
  assert.equal(a.project('search',{kind:'product',products:[free]}).rows.length,1);
  for(const invalid of [
    {...free,labelsTags:[]},
    {...free,ingredients:'Chickpeas, milk'},
    {...free,ingredientsNeedsReview:true},
    {...free,metadata:{conflicts:[{field:'allergens'}]}},
    {...free,metadata:{missingFields:['ingredients']}}
  ]){
    const result=a.project('search',{kind:'product',products:[invalid]});assert.equal(result.rows.length,0);assert.equal(result.excludedCount,1);assert.ok(result.excludedReasons[0]);
  }
  a.api.snapshot().state.nutritionProfile={diet:'vegan',allergies:[],avoids:[]};
  const contradictory={...product,labelsTags:['en:vegan','en:non-vegan']};
  assert.equal(a.project('search',{kind:'product',products:[contradictory]}).rows.length,0);
  assert.equal(a.project('search',{kind:'product',products:[{...product,labelsTags:['en:vegan'],ingredients:'Chickpeas, whey'}]}).rows.length,0);
});


test('native Recipes tab searches local prefixes and ingredients without reading products or writing records',()=>{
  const a=boot();scan(a,'archive-product');
  const before=[...a.values],writes=a.writes.length;
  a.reads.length=0;
  const project=query=>a.project('search',{kind:'recipe',recipeLibraryOnly:true,livePrefixMatch:true,query});
  const all=project('');assert.equal(all.recipeCount,4);assert.equal(all.rows.length,4);
  assert.equal(all.loadedProductCount,0);assert.ok(all.rows.some(r=>r.status==='draft'));
  for(const query of ['b','be','ber','yog','wal','garbanzo','chick']){
    const result=project(query);assert.ok(result.rows.length>0,query+' should immediately find a recipe');
    assert.ok(result.rows.every(r=>r.kind==='recipe'));
  }
  assert.deepEqual(project('wal').rows.map(r=>r.id),['berry'],'Ingredient prefixes use the shared recipe search text');
  assert.deepEqual(project('salmon ric').rows.map(r=>r.id),['salmon']);
  assert.equal(project('salm ric').rows.length,0,'Only the final token is a prefix');
  assert.equal(project('unmatched food').rows.length,0);
  assert.deepEqual(a.reads,[],'Recipe-only browsing must not reopen History or saved product storage');
  assert.deepEqual([...a.values],before);assert.equal(a.writes.length,writes);
});

test('native Recipes preserves profile exclusions, saved recipe identity and explicit intake confirmation',()=>{
  const a=boot(),p={kind:'recipe',recipeLibraryOnly:true,livePrefixMatch:true};
  a.api.snapshot().state.nutritionProfile={allergies:['milk'],avoids:[],diet:'any'};
  const hidden=a.project('search',{...p,query:'ber'});
  assert.equal(hidden.rows.length,0);assert.ok(hidden.excludedRecipes.some(r=>r.id==='berry'));
  assert.ok(hidden.excludedReasons.some(r=>/milk/i.test(r)));
  a.api.snapshot().state.nutritionProfile={allergies:[],avoids:[],diet:'any'};
  assert.equal(a.perform('recipeFavourite',{id:'berry'}).ok,true);
  assert.deepEqual(a.project('search',{...p,savedOnly:true}).rows.map(r=>r.id),['berry']);
  const before=a.snapshot().state.foodLog.entries;
  assert.equal(a.project('recipe',{id:'berry'}).id,'berry');
  assert.deepEqual(a.snapshot().state.foodLog.entries,before,'Opening full recipe detail never logs intake');
  assert.equal(a.perform('recipeLog',{id:'berry',day:'2026-10-11',slot:'Lunch',confirmationId:'recipe-tab-test'}).ok,true);
  assert.deepEqual(a.snapshot().state.foodLog.entries,before,'Choosing an amount opens the existing review before logging');
  assert.equal(a.perform('reviewUpdate',{name:'My berry breakfast',portions:0.5}).ok,true);
  const review=a.project('reviewModel');assert.equal(review.draft.name,'My berry breakfast');
  assert.equal(a.perform('reviewConfirm').ok,true);
  assert.equal(a.snapshot().state.foodLog.entries.length,before.length+1);
  assert.equal(a.snapshot().state.foodLog.entries.at(-1).name,'My berry breakfast');
  assert.deepEqual(a.project('search',{...p,savedOnly:true}).rows.map(r=>r.id),['berry'],'Edited intake does not replace the favourite library identity');
});
