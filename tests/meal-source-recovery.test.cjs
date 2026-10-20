const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const composition=require('../Web/core/food-composition.js'),data=require('../Web/core/meal-recovery-data.js'),recovery=require('../Web/core/meal-recovery.js');
require('../Web/core/nudge-score.js');const scorer=require('../Web/core/meal-score.js');
const component=(name,preparation='raw',amountGrams=100)=>({name,preparation,amountGrams,amountSource:'standard_portion_estimate',evidence:'Visible '+name,photoIndex:1,photoId:'fixture-photo',assumptions:['Observed fixture food']});
const meal=components=>({name:'Food photograph',portionMode:'estimated_serving',basis:'perPortion',portion:{amount:components.reduce((s,c)=>s+c.amountGrams,0),unit:'g'},components,plants:[{name:'observed plant',evidence:'Original evidence'}],ingredients:components.map(c=>({name:c.name,evidence:c.evidence}))});
function recovered(name,prep){return recovery.recover(meal([component(name,prep)]));}
test('presentation words do not hide a plain side or rewrite its observation',()=>{
  for(const [name,prep,expected] of [['cooked cabbage side','cooked, boiled or steamed visible',/^Cabbage, cooked, boiled/],['broccoli side dish','steamed',/^Broccoli, cooked/],['chicken breast side','roasted',/^Chicken.*breast.*roasted/]]){
    const input=meal([component(name,prep)]),before=JSON.stringify(input),result=recovery.recover(input),c=result.components[0];
    assert.equal(JSON.stringify(input),before);assert.match(c.sourceRecord.name,expected);assert.equal(c.name,name);assert.equal(c.preparation,prep);assert.equal(c.amountGrams,100);assert.equal(c.photoId,'fixture-photo');assert.ok(result.nutrients.energyKcal.value>0);assert.ok(result.nutrients.protein.value>0);
  }
  for(const name of ['fish pie filling','fish filling','pastry topping','smoothie base','cabbage side with sauce'])assert.equal(recovered(name,'cooked').components[0].recordId,undefined,name);
});
test('mash uses a whole recipe source only when its local milk and butter additions are identified',()=>{
  const input=meal([component('mashed potato topping','cooked, baked',150),component('fish pie filling','cooked, baked',200),component('cooked cabbage side','cooked, boiled or steamed visible',80)]);
  input.ingredients=[{name:'milk',evidence:'Milk for the fish filling'},{name:'butter',evidence:'Butter for the fish filling'}];
  assert.equal(recovery.recover(input).components[0].recordId,undefined,'Other parts of the recipe do not establish mash additions');
  input.ingredients=[{name:'milk',evidence:'Milk for mashed potato topping'},{name:'butter',evidence:'Butter for mashed potato topping'}];
  const before=JSON.stringify(input),r=recovery.recover(input),c=r.components[0];
  assert.equal(JSON.stringify(input),before);assert.equal(c.recordId,'13-553:91e2fd193325');assert.equal(c.recovery.identity,'generic_proxy');assert.match(c.assumptions.join(' '),/actual topping proportions.*unknown/);
  assert.equal(r.components[1].recordId,undefined,'A filling is never substituted by the whole pie');assert.ok(r.components[2].recordId);assert.equal(r.nutrients.energyKcal.value,null);assert.ok(r.nutrients.energyKcal.knownSubtotal>0);assert.equal(r.recovery.status,'partial');assert.deepEqual(r.components.map(c=>c.amountGrams),[150,200,80]);
  assert.deepEqual(c.nutrients,composition.nutrients({values:JSON.parse(fs.readFileSync('Backend/data/cofid-2021.json','utf8')).foods.find(f=>f.id===c.recordId).values}));
  for(const context of ['Vegan fish pie','Dairy free fish pie','Fish pie without butter']){const x=structuredClone(input);x.name=context;assert.equal(recovery.recover(x).components[0].recordId,undefined,context);}
  const local=meal([{...component('mashed potato topping','cooked'),evidence:'Visible mash; the topping ingredients specify milk and butter.'}]);assert.equal(recovery.recover(local).components[0].recordId,c.recordId);
});
test('raw recipe ingredients use full source records and never substitute light butter or cooked fish',()=>{
  const examples=[['butter','raw','17-661:7c4e65f156d3'],['salted butter','unknown','17-685:5d11e1950606'],['unsalted butter','unknown','17-661:7c4e65f156d3'],['plain flour','dry','11-886:ab04b5c4da43'],['plain white flour','raw','11-886:ab04b5c4da43'],['haddock','raw','16-375:fcf21536084f'],['smoked haddock','raw','16-492:d35747a63193'],['potatoes','raw','usda:170026']];
  for(const [name,prep,id]of examples){const r=recovered(name,prep),c=r.components[0];assert.equal(c.recordId,id,name);assert.ok(r.nutrients.energyKcal.value>0,name);assert.deepEqual(c.nutrients,c.sourceRecord.nutrients);assert.equal(c.amountGrams,100);if(/butter/.test(name))assert.doesNotMatch(c.sourceRecord.name,/light|reduced/i);}
  assert.match(recovered('butter','unknown').components[0].assumptions.join(' '),/added salt is unknown/);
  assert.match(recovered('smoked haddock','raw').components[0].sourceRecord.name,/smoked, raw/);
  for(const prep of ['cooked','unknown','raw and cooked','raw in sauce'])assert.notEqual(recovered('smoked haddock',prep).components[0].recordId,'16-492:d35747a63193',prep);
  for(const [name,prep]of [['plain flour','cooked'],['gluten free plain flour','dry'],['butter mixture','unknown']])assert.equal(recovered(name,prep).components[0].recordId,undefined,name);
  for(const [food,title]of [['butter','Dairy free sauce'],['plain flour','Gluten free sauce']]){const x=meal([component(food,'unknown')]);x.name=title;assert.equal(recovery.recover(x).components[0].recordId,undefined,title);}
});
test('explicitly peeled raw potato weights use edible flesh and preserve the observed preparation',()=>{
  for(const [name,prep]of [['potatoes','raw, peeled'],['peeled potatoes','raw'],['potatoes peeled','raw'],['potatoes','raw, flesh only']]){
    const input=meal([component(name,prep,900)]),before=JSON.stringify(input),result=recovery.recover(input),c=result.components[0];
    assert.equal(JSON.stringify(input),before);assert.equal(c.recordId,'13-489:214c339aadef');assert.match(c.sourceRecord.name,/raw, flesh only/);assert.equal(c.name,name);assert.equal(c.preparation,prep);assert.equal(c.amountGrams,900);
    assert.equal(result.nutrients.energyKcal.value,738);assert.ok(Math.abs(result.nutrients.protein.value-17.1)<1e-9);assert.deepEqual(c.nutrients,c.sourceRecord.nutrients);
  }
  assert.equal(recovered('potatoes','raw').components[0].recordId,'usda:170026','Unspecified skins retain the existing generic raw proxy');
  for(const prep of ['raw, unpeeled','raw, peeled with skin','raw, peeled in sauce','raw, peeled and boiled','boiled, peeled'])assert.notEqual(recovered('potatoes',prep).components[0].recordId,'13-489:214c339aadef',prep);
  assert.equal(recovered('fresh haddock','raw').components[0].recordId,'16-375:fcf21536084f');
  assert.match(recovered('hard-boiled eggs','hard-boiled').components[0].sourceRecord.name,/hard.boiled/i);
  const row={...component('potatoes','raw',900),evidence:'Recipe photo 1: 900g/2lb potatoes, peeled and cut into even-sized pieces'},input=meal([row]),before=JSON.stringify(input);
  const matched=recovery.recover(input).components[0];assert.equal(matched.recordId,'13-489:214c339aadef');assert.equal(matched.preparation,'raw');assert.equal(matched.evidence,row.evidence);assert.equal(JSON.stringify(input),before);
  for(const evidence of ['Recipe photo 1: 900g potatoes','Recipe photo 1: 900g unpeeled potatoes','Recipe photo 1: 900g potatoes, peeled and cooked'])assert.notEqual(recovery.recover(meal([{...row,evidence}])).components[0].recordId,'13-489:214c339aadef',evidence);
  const other=meal([component('potatoes','raw',900)]);other.ingredients.push({name:'carrot',evidence:'Recipe photo 1: peeled carrots'});assert.notEqual(recovery.recover(other).components[0].recordId,'13-489:214c339aadef','Peeling a different ingredient does not establish potato preparation');
});
test('ordinary potatoes cannot select isolated skins merely because the source name is shorter',()=>{
  const skinOnly=record=>record.name.split(',').some(part=>/^skin(?: only)?(?: (?:with|without) salt)?$/i.test(part.trim()));
  for(const [name,prep]of [['potato','cooked; method unknown'],['potatoes','baked'],['potato flesh','baked'],['potatoes','boiled'],['potatoes','microwaved'],['potatoes','boiled, cooked in skin'],['potatoes','baked with skin'],['potatoes','raw']]){
    const input=meal([component(name,prep,120)]),before=JSON.stringify(input),r=recovery.recover(input),c=r.components[0];
    assert.equal(JSON.stringify(input),before);assert.ok(c.recordId,name+' '+prep);assert.equal(skinOnly(c.sourceRecord),false);assert.ok(c.candidates.every(record=>!skinOnly(record)));
    assert.equal(c.name,name);assert.equal(c.preparation,prep);assert.equal(c.amountGrams,120);assert.equal(c.evidence,'Visible '+name);assert.deepEqual(c.nutrients,c.sourceRecord.nutrients);
  }
  const r=recovery.recover(meal([component('potato','cooked; method unknown',120)]));
  assert.equal(r.components[0].recordId,'usda:170033');assert.equal(r.components[0].sourceRecord.nutrients.energyKcal.value,93);
  assert.ok(Math.abs(r.nutrients.energyKcal.value-111.6)<1e-9,'120g flesh estimate must not use the 237.6 kcal skin-only quantity');
  assert.equal(recovered('potatoes','raw').components[0].recordId,'usda:170026');
  assert.equal(recovery.VERSION,'meal-source-recovery-v7');
});
test('explicit potato skins retain their fraction while cooked-in-skin flesh remains eligible',()=>{
  for(const [name,prep,id]of [['potato skins','baked','usda:170034'],['potato skins only','baked','usda:170034'],['potato','baked, skin only','usda:170034'],['potato skins','boiled','usda:170439'],['potato skins','raw','usda:170032']]){
    const input=meal([component(name,prep,120)]),before=JSON.stringify(input),r=recovery.recover(input),c=r.components[0];
    assert.equal(c.recordId,id,name+' '+prep);assert.equal(JSON.stringify(input),before);assert.equal(c.amountGrams,120);assert.deepEqual(c.nutrients,c.sourceRecord.nutrients);
    assert.ok(c.candidates.every(record=>/,(?: skin| skin only)(?:,|$)/i.test(record.name)),'An explicit skin quantity cannot select flesh');
  }
  const boiled=recovered('potatoes','boiled, cooked in skin').components[0];
  assert.equal(boiled.recordId,'usda:170438');assert.match(boiled.sourceRecord.name,/cooked in skin, flesh/);
  const microwaved=recovered('potatoes','microwaved').components[0];
  assert.ok(microwaved.candidates.some(record=>record.id==='usda:170094'),'Flesh-and-skin records remain eligible');
});
test('generic mushrooms need a variety choice rather than silently becoming shiitake or morel',()=>{
  for(const [name,prep]of [['mushrooms','cooked; method unknown'],['mushroom','raw'],['sliced mushrooms','cooked'],['mushrooms','unknown']]){
    const input=meal([component(name,prep,120)]),before=JSON.stringify(input),r=recovery.recover(input),c=r.components[0];
    assert.equal(JSON.stringify(input),before);assert.equal(c.recordId,undefined);assert.equal(c.sourceRecord,undefined);assert.equal(c.recovery,undefined);
    assert.equal(c.matchStatus,'needs_confirmation');assert.ok(c.candidates.length);assert.match(r.recovery.unresolved[0].reason,/mushroom variety/);
    assert.equal(c.name,name);assert.equal(c.preparation,prep);assert.equal(c.amountGrams,120);assert.equal(c.evidence,'Visible '+name);
    assert.equal(r.nutrients.energyKcal.value,null);assert.deepEqual(composition.componentPlants([c]),[]);assert.deepEqual(r.plants,input.plants);
  }
  for(const [name,prep,id]of [['shiitake mushrooms','cooked','usda:168437'],['morel mushrooms','raw','usda:168423'],['white mushrooms','raw','usda:169251'],['portabella mushrooms','grilled','usda:169243']]){
    const c=recovered(name,prep).components[0];assert.equal(c.recordId,id,name);assert.equal(c.name,name);assert.equal(c.recovery.identity,'matched_identity');assert.deepEqual(c.nutrients,c.sourceRecord.nutrients);
  }
});
test('identity guards preserve selected records and leave unknown sauce and garnish unresolved',()=>{
  const selected=meal([{...component('potato','cooked; method unknown',120),recordId:'usda:170034',sourceRecord:recovery.record('usda:170034'),matchStatus:'confirmed',matchMethod:'user_selected'}]);
  const before=JSON.stringify(selected);assert.deepEqual(recovery.recover(selected).components[0],selected.components[0]);assert.equal(JSON.stringify(selected),before);
  for(const options of [{confirmed:true},{userEdited:true}])assert.equal(recovery.recover(selected,options),selected);
  const input=meal([component('potato','cooked; method unknown',120),component('mushrooms','cooked',40),component('unknown sauce','unknown',20),component('unknown garnish','unknown',5)]),original=JSON.stringify(input),r=recovery.recover(input);
  assert.equal(JSON.stringify(input),original);assert.equal(r.recovery.status,'partial');assert.equal(r.components[0].recordId,'usda:170033');
  for(const c of r.components.slice(1))assert.equal(c.recordId,undefined,c.name);
  assert.equal(r.nutrients.energyKcal.value,null);assert.ok(Math.abs(r.nutrients.energyKcal.knownSubtotal-111.6)<1e-9);assert.equal(r.recovery.unresolved.length,3);
});
test('index includes whole official records and pinned source hashes',()=>{
  assert.equal(data.records.length,10680);assert.equal(new Set(data.records.map(r=>r[0])).size,data.records.length);
  const bytes=fs.readFileSync('Backend/data/cofid-2021.json'),cofid=JSON.parse(bytes);
  assert.equal(data.sources.c.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
  for(const source of cofid.foods){const row=data.records.find(r=>r[0]===source.id);assert.deepEqual(row[8],data.keys.map(k=>source.values[k]??null));}
  const rice=data.records.find(r=>r[0]==='usda:168914');assert.equal(rice[3],'Rice noodles, cooked');assert.equal(rice[8][0],'108');
  assert.equal(data.sources.u.sha256,'b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0');
});
test('broad source lookup respects food identity and edible preparation',()=>{
  const rows=[['apple','raw',/Apple/i],['banana','raw',/Banana/i],['blueberries','raw',/Blueberr/i],['carrot','boiled',/Carrot/i],['tomato','raw',/Tomato.*red.*raw/i],['broccoli','steamed',/Broccoli.*cooked/i],['chickpeas','boiled',/Chickpea.*cooked/i],['black beans','boiled',/Beans, black.*cooked/i],['quinoa','cooked',/Quinoa, cooked/],['couscous','cooked',/Couscous, cooked/],['rice','cooked',/Rice, white.*cooked/i],['zucchini','grilled',/zucchini.*cooked/i],['chicken breast','roasted',/Chicken.*breast.*roasted/i],['turkey','roasted',/Turkey.*roasted/i],['salmon','cooked',/salmon.*cooked/i],['red onion','raw',/Onions, raw/],['parsley','fresh',/Parsley, fresh/],['lime wedge','raw',/Limes, raw/]];
  for(const [name,prep,expected]of rows){const r=recovered(name,prep),c=r.components[0];assert.equal(r.recovery.status,'complete',name);assert.match(c.sourceRecord.name,expected,name);assert.equal(c.name,name);assert.equal(c.amountGrams,100);assert.equal(c.photoId,'fixture-photo');assert.equal(c.evidence,'Visible '+name);assert.deepEqual(c.nutrients,c.sourceRecord.nutrients);assert.ok(!/turkey, skin|duck.*raw|quail/i.test(c.sourceRecord.name));}
});
test('generic proxies preserve observed species uncertainty and exclude inferred source plants',()=>{
  for(const [name,prep,id]of [['glass noodles','stir fried','usda:168914'],['leafy greens','cooked','usda:168463'],['minced meat','cooked','usda:171799'],['grated cheese','raw','12-526:344df15a32a6']]){
    const r=recovered(name,prep),c=r.components[0];assert.equal(c.recordId,id);assert.equal(c.recovery.identity,'generic_proxy');assert.equal(c.recovery.original.name,name);assert.equal(c.name,name);assert.match(c.recovery.assumptions.join(' '),/unknown/);assert.deepEqual(composition.componentPlants([c]),[]);assert.deepEqual(r.plants,meal([]).plants);
  }
});
test('actual kinds of noodle and pasta estimates receive calculated nutrition and scores',()=>{
  for(const input of [meal([component('glass noodles','cooked stir fried',120),component('pork','minced cooked stir fried',60),component('leafy greens','cooked',40),component('egg','scrambled',30),component('lime wedge','raw',10)]),meal([component('pasta','cooked',150),component('minced meat','cooked',100),component('red onion','raw',30),component('parsley','raw',5),component('grated cheese','raw',10)])]){
    const before=JSON.stringify(input),r=recovery.recover(input);assert.equal(JSON.stringify(input),before);assert.equal(r.recovery.status,'complete');assert.equal(scorer.calculate(r).available,true);assert.ok(r.nutrients.energyKcal.value>0);assert.ok(r.nutrients.protein.value>0);assert.ok(r.nutrients.fibre.value>0);for(const c of r.components)assert.equal(c.amountGrams,input.components.find(x=>x.name===c.name).amountGrams);
  }
});
test('incompatible species, raw/cooked, coatings, recipes and dietary context are not guessed',()=>{
  for(const [name,prep]of [['minced meat','vegan cooked'],['egg','raw scrambled'],['pork','breaded and cooked'],['egg','battered fried'],['vegan cheese','raw'],['noodles with sauce','cooked'],['unknown component','unknown'],['glass noodles','dry'],['rice noodles','raw cooked']]){const r=recovered(name,prep);assert.equal(r.components[0].recordId,undefined,name+' '+prep);assert.ok(r.recovery.unresolved.length);}
  for(const field of ['name','ingredients','subject']){const input=meal([component('minced meat','cooked')]);if(field==='name')input.name='Vegan noodle bowl';if(field==='ingredients')input.ingredients=[{name:'plant based mince',evidence:'label'}];if(field==='subject')input.subject={description:'Vegetarian food'};assert.equal(recovery.recover(input).components[0].recordId,undefined,field);}
  const pork=meal([component('minced meat','cooked')]);pork.ingredients=[{name:'pork',evidence:'printed ingredient'}];assert.equal(recovery.recover(pork).components[0].recordId,undefined);
  for(const prep of ['scrambled','fried','boiled']){const r=recovered('egg',prep);assert.ok(r.components[0].sourceRecord);assert.doesNotMatch(r.components[0].sourceRecord.name,/duck|quail|turkey|raw/i);}
});
test('source category metadata excludes starchy tubers, drinks and unquantified recipes from FVL',()=>{
  const find=re=>data.records.find(r=>r[1]==='u'&&re.test(r[3]));
  for(const re of [/^Potatoes,.*raw/,/^Sweet potato,.*raw/,/^Yam, raw/,/^Cassava, raw/])assert.equal(find(re)[7],false,re.toString());
  assert.equal(find(/^Peas, green, raw/)[7],true);assert.equal(find(/^Spinach, raw/)[7],true);
  assert.equal(find(/^Apricots, dried/)[7],null);assert.equal(find(/^Orange juice, raw/)[6],'beverage');
  for(const row of data.records.filter(r=>r[1]==='u'&&/fruit.*syrup|peaches.*syrup/i.test(r[3])))assert.notEqual(row[7],true);
});
test('selected sources, manual edits and confirmed score snapshots are preserved',()=>{
  const original=meal([component('egg','scrambled')]);
  for(const options of [{confirmed:true},{userEdited:true}])assert.equal(recovery.recover(original,options),original);
  for(const key of ['userEdited','recordId','sourceRecord','matchStatus','matchMethod','amountSource','selected']){
    const c={...original.components[0],[key]:{userEdited:true,recordId:'user-source',sourceRecord:{id:'user-source'},matchStatus:'confirmed',matchMethod:'user_selected',amountSource:'confirmed',selected:false}[key]},input=meal([c]);assert.deepEqual(recovery.recover(input).components[0],c,key);
  }
  const available={...original,scoreSnapshot:{available:true,value:0,methodVersion:'nudge_meal_v0_1'}};assert.equal(recovery.recover(available),available);
  const unavailable={...original,scoreSnapshot:{available:false,value:null}};assert.equal(recovery.recover(unavailable).scoreSnapshot,undefined);
  const unresolvable={...meal([component('unknown food','unknown')]),scoreSnapshot:{available:false,value:null}};assert.deepEqual(recovery.recover(unresolvable).scoreSnapshot,unresolvable.scoreSnapshot);
});
test('missing or unbound amounts/evidence cannot become a recovered component',()=>{
  for(const change of [{amountGrams:null},{amountGrams:0},{amountGrams:NaN},{amountGrams:5001},{photoIndex:0},{photoIndex:5},{evidence:''}]){const r=recovery.recover(meal([{...component('egg','scrambled'),...change}]));assert.equal(r.components[0].recordId,undefined);}
});
test('existing matched source with an unknown essential nutrient remains preserved and needs recovery',()=>{
  const input=recovered('egg','scrambled');input.components[0].sourceRecord.nutrients.sugars={value:null,status:'unknown',unit:'g'};
  input.components[0].nutrients=input.components[0].sourceRecord.nutrients;
  const before=JSON.stringify(input.components[0]),r=recovery.recover(input);
  assert.equal(JSON.stringify(r.components[0]),before);assert.equal(r.nutrients.sugars.value,null);assert.equal(scorer.calculateDetailed(r).available,false);assert.ok(scorer.calculateDetailed(r).missingInputs.includes('sugars'));
  const fallback=scorer.calculate(r);assert.equal(fallback.status,'estimated_rough');assert.equal(fallback.methodId,'nudge_food_estimate_v3');assert.equal(fallback.grade,null);assert.ok(fallback.missingInputs.includes('sugars'));assert.equal(r.nutrients.sugars.value,null);assert.equal(JSON.stringify(r.components[0]),before);
});
test('whole-record trace and unknown values remain unknown rather than zero',()=>{
  const r=recovered('turkey','roasted');for(const c of r.components){const row=data.records.find(v=>v[0]===c.recordId);for(const [key,i]of data.keys.map((k,i)=>[k,i]))if(['energyKj','sodiumMg'].includes(key))continue;else if(!/^\d+(?:\.\d+)?$/.test(String(row[8][i])))assert.equal(c.sourceRecord.nutrients[key].value,null,key);}
});
test('existing supported compound proposal is retained by general recovery',()=>{
  const input=meal([component('sausage roll','cooked',150)]);input.name='Sausage roll';const r=recovery.recover(input);assert.equal(r.components[0].recordId,'19-468:ec99331e0ea1');assert.equal(r.compoundProposal.originalComponents[0].amountGrams,150);assert.equal(scorer.calculate(r).value,0);
});
const sourceRow=row=>({id:row[0],name:row[3],basis:'per100g'});
test('reviewed special profiles cover source identities, not broad source categories',()=>{
  const examples=[
    ['usda:171799','red_meat'],['usda:169192','red_meat'],['12-526:344df15a32a6','cheese'],['usda:171413','fats_nuts_seeds'],
    ['usda:168463','general'],['usda:168914','general'],['usda:172187','general']
  ];
  for(const[id,profile]of examples){const row=data.records.find(r=>r[0]===id);assert.equal(recovery.scoringMetadata(sourceRow(row)).mealScoringProfile,profile,id);}
  for(const row of data.records.filter(r=>/^(?:salad dressing|creamy dressing|dressing|mayonnaise|sandwich spread)(?:,| |$)/i.test(r[3])))assert.equal(recovery.scoringMetadata(sourceRow(row)).mealScoringProfile,'general',row[3]);
  for(const row of data.records.filter(r=>/^(?:nuts, )?chestnuts?\b/i.test(r[3])))assert.equal(recovery.scoringMetadata(sourceRow(row)).mealScoringProfile,'general',row[3]);
  for(const row of data.records.filter(r=>/^nuts, formulated|^nuts, coconut water/i.test(r[3])))assert.notEqual(recovery.scoringMetadata(sourceRow(row)).mealScoringProfile,'fats_nuts_seeds',row[3]);
});
test('special oil FVL is separate from general meal FVL and retains mixed-oil uncertainty',()=>{
  for(const row of data.records.filter(r=>/^oil, (?:olive|avocado|soybean|soya)(?:,|$)/i.test(r[3])&&!/\band\b|cottonseed|corn|peanut|palm|lecithin/i.test(r[3]))){
    assert.equal(recovery.scoringMetadata(sourceRow(row)).specialOilFvlEligible,true,row[3]);assert.notEqual(row[7],true,row[3]);
  }
  const byName=re=>data.records.find(r=>re.test(r[3]));
  for(const re of [/^Oil, sunflower, high oleic/,/^Oil, grapeseed$/,/^Butter, unsalted$/,/^Nuts, almonds$/])assert.equal(recovery.scoringMetadata(sourceRow(byName(re))).specialOilFvlEligible,false,re.toString());
  for(const re of [/^Oil, corn, peanut, and olive$/,/^Oil, vegetable, average$/,/^Margarine, regular, 80% fat, composite/])assert.equal(recovery.scoringMetadata(sourceRow(byName(re))).specialOilFvlEligible,null,re.toString());
});
test('new records carry profiles and older exact sources resolve without snapshot mutation',()=>{
  const record=recovered('minced meat','cooked').components[0].sourceRecord;assert.equal(record.mealScoringProfile,'red_meat');
  const old={...record};delete old.mealScoringProfile;delete old.specialOilFvlEligible;const before=JSON.stringify(old);
  assert.equal(recovery.scoringMetadata(old).mealScoringProfile,'red_meat');assert.equal(JSON.stringify(old),before);
  for(const override of [{id:'invented',mealScoringProfile:'cheese'},{name:'Unknown meat',mealScoringProfile:'cheese'},{basis:'perPortion'}])assert.equal(recovery.scoringMetadata({...old,...override}).mealScoringProfile,'unknown');
});
test('peanuts have nut/seed treatment rather than FVL legume treatment',()=>{
  const rows=data.records.filter(r=>/^Peanuts,.*raw/i.test(r[3]));assert.ok(rows.length);
  for(const row of rows){assert.equal(row[6],'nuts_seeds');assert.equal(row[7],false);assert.equal(recovery.scoringMetadata(sourceRow(row)).mealScoringProfile,'fats_nuts_seeds');}
});
test('meat cuts intended for stew or sandwiches are still meat, not complete dishes',()=>{
  const rows=data.records.filter(r=>r[6]==='red_meat'&&/for stew|sandwich steaks/i.test(r[3]));assert.ok(rows.length>=12);
  for(const row of rows)assert.equal(recovery.scoringMetadata(sourceRow(row)).mealScoringProfile,'red_meat',row[3]);
});
test('exact legacy CoFID special sources with unknown broad group score without mutation',()=>{
  for(const [id,category]of [['18-470:e0b4205188dc','red_meat'],['12-526:344df15a32a6','cheese'],['17-661:7c4e65f156d3','fats_nuts_seeds']]){
    const row=data.records.find(r=>r[0]===id),record={...sourceRow(row),foodGroup:'unknown',fvlEligible:null,nutrients:composition.nutrients({values:Object.fromEntries(data.keys.map((k,i)=>[k,row[8][i]]))})};
    const input=meal([{...component(row[3],'cooked'),recordId:id,sourceRecord:record,nutrients:record.nutrients}]);
    const before=JSON.stringify(input),rating=scorer.calculate(input);assert.equal(rating.available,true,id);assert.equal(rating.category,category,id);assert.equal(JSON.stringify(input),before,id);
    if(category==='red_meat')assert.ok(rating.components.positive.find(x=>x.id==='protein').pointsUpper<=2);
    if(category==='cheese')assert.equal(rating.countProteins,true);
    if(category!=='fats_nuts_seeds'){assert.equal(rating.inputs.fvlPercent,null);assert.equal(rating.status,'estimated_provisional');}
  }
});
test('plain dairy and singular fruit can supply nutrient estimates without inventing a recipe',()=>{
  for(const [name,prep,id] of [['whole milk','pasteurised','12-596:d379c671eb80'],['whole milk','UHT','12-320:012eba70ce95'],['plain Greek yoghurt','plain','12-555:bf4be7c34952'],['Greek yogurt','plain','12-555:bf4be7c34952'],['fig','raw','usda:173021'],['figs','raw','usda:173021']]){
    const r=recovered(name,prep),c=r.components[0];assert.equal(c.recordId,id,name);assert.ok(r.nutrients.energyKcal.value>0);assert.deepEqual(c.nutrients,c.sourceRecord.nutrients);assert.equal(c.amountGrams,100);
    if(/milk|yogh?urt/i.test(name)){assert.equal(c.sourceRecord.mealScoringProfile,'unknown','Nutrient availability must not fabricate a supported score profile');assert.equal(c.recovery.identity,'generic_proxy');}
  }
  const ambiguous=recovered('Greek yogurt','unknown');assert.equal(ambiguous.components[0].recordId,undefined);assert.equal(ambiguous.components[0].candidates.length,1);assert.match(ambiguous.recovery.unresolved[0].reason,/Confirm/);
  for(const [name,prep] of [['mixed berries','raw'],['seed mix','raw'],['smoothie base','raw'],['whole milk','unpasteurised'],['whole milk','condensed'],['Greek yogurt','low fat'],['Greek yogurt','nonfat'],['strawberry Greek yogurt','plain'],['kefir drink','unknown']])assert.equal(recovered(name,prep).components[0].recordId,undefined,name+' '+prep);
  const vegan=meal([component('whole milk','unknown')]);vegan.name='Dairy free smoothie';assert.equal(recovery.recover(vegan).components[0].recordId,undefined);
  const vegetarian=meal([component('whole milk','unknown')]);vegetarian.name='Vegetarian smoothie';assert.equal(recovery.recover(vegetarian).components[0].recordId,'12-596:d379c671eb80');
  const saved=meal([component('whole milk','unknown')]);const before=JSON.stringify(saved);assert.equal(recovery.recover(saved,{confirmed:true}),saved);assert.equal(JSON.stringify(saved),before);
});
