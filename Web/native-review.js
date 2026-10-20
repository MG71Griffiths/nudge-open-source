/* Native review adapter. Pure projections and draft edits over the established
 * evidence/scoring/portion engines. Persistence and event linking belong to the
 * application's single diary transaction; this file performs no I/O. */
(function(root){
  'use strict';
  const VERSION='native-review-v1';
  const fields=[['energyKcal','Energy','kcal'],['protein','Protein','g'],['carbohydrate','Carbs','g'],['fat','Fat','g'],['fibre','Fibre','g'],['sugars','Sugars','g'],['saturatedFat','Saturated fat','g'],['salt','Salt','g']];
  const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
  const text=(v,max=100)=>typeof v==='string'?v.trim().slice(0,max):'';
  const known=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  const positive=n=>known(n)&&n>0;
  const num=v=>typeof v==='number'?v:typeof v==='string'&&/^\s*(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(v)?Number(v):null;
  const blank=v=>v===null||v===undefined||typeof v==='string'&&!v.trim();
  const profile=state=>state?.nutritionProfile||{};
  const entries=state=>Array.isArray(state?.foodLog?.entries)?state.foodLog.entries:[];
  const detail=()=>root.NudgeFoodDetailModel;
  const names=v=>root.WmdFoodLog.names(v);
  const validDay=(v,today)=>typeof v==='string'&&root.WmdStreakMath.dayNumber(v)!==null&&v<=today;
  // The ingredient catalogue provides choices, never nutritional facts.
  // Only explicit selections become user evidence; no ingredient ratios are inferred.
  const mealCatalogue=Object.freeze([
    ['Fruit','Blueberries|Raspberries|Strawberries|Blackberries|Banana|Apple|Pear|Orange|Mango|Pineapple|Kiwi|Peach|Apricot|Cherries|Grapes|Dates|Lemon|Lime|Avocado|Pomegranate'],
    ['Seeds and nuts','Chia seeds|Flaxseed|Hemp seeds|Pumpkin seeds|Sunflower seeds|Sesame seeds|Almonds|Walnuts|Cashews|Peanuts|Brazil nuts|Pecans|Hazelnuts|Macadamias|Pistachios|Pine nuts|Chestnuts|Coconut|Peanut butter|Almond butter|Tahini'],
    ['Dairy and drinks','Milk|Kefir|Yoghurt|Greek yoghurt|Oat drink|Soya drink|Almond drink|Coconut drink|Fruit juice|Orange juice|Apple juice|Water|Whey protein powder|Pea protein powder|Cocoa powder'],
    ['Vegetables','Spinach|Kale|Broccoli|Carrot|Tomato|Cucumber|Red pepper|Courgette|Aubergine|Mushrooms|Onion|Garlic|Peas|Sweetcorn|Cauliflower|Cabbage|Lettuce|Beetroot|Celery|Sweet potato'],
    ['Grains and pulses','Oats|Brown rice|White rice|Quinoa|Pasta|Wholewheat pasta|Couscous|Potato|Lentils|Chickpeas|Black beans|Kidney beans|Cannellini beans|Edamame|Tofu'],
    ['Protein and extras','Chicken|Turkey|Beef|Pork|Salmon|Tuna|Prawns|Eggs|Cheese|Feta|Cream|Honey|Sugar'],
    ['Kitchen staples','Ginger|Cumin|Turmeric|Coriander|Basil|Oregano|Chilli|Paprika|Black pepper|Soy sauce|Coconut milk|Stock|Mayonnaise|Mustard|Vinegar|Wholemeal bread|Bread|Noodles'],
    ['Oils','Extra virgin olive oil|Olive oil|Rapeseed oil|Sunflower oil|Coconut oil|Sesame oil|Avocado oil|Butter']
  ].flatMap(([category,values])=>values.split('|').map(name=>Object.freeze({name,category}))));
  const tagKey=v=>text(v,80).toLowerCase().replace(/[^\p{L}\p{N} ]/gu,'').replace(/\s+/g,' ').replace(/ies\b/g,'y').replace(/s\b/g,'');
  const tagNames=value=>[...new Map((Array.isArray(value)?value:[]).filter(v=>typeof v==='string').map(v=>text(v,80)).filter(Boolean).map(v=>[tagKey(v),v])).values()].slice(0,40);
  const sameTag=(a,b)=>tagKey(a)===tagKey(b);
  // A rejected recipe can retain an incomplete calculation with no quantities.
  // Keep real recipe amounts/alternatives on their precise editor, but let the
  // user identify ingredients when there is nothing calculable to select.
  function usableRecipe(recipe){
    return Boolean(recipe&&Array.isArray(recipe.batchComponents)&&recipe.batchComponents.some(c=>
      positive(c?.amountGrams)||positive(c?.recipeIngredient?.amount)&&['g','kg','ml','l','tsp','tbsp','count'].includes(c.recipeIngredient?.unit)
      ||Array.isArray(c?.recipeChoice?.options)&&c.recipeChoice.options.length>0));
  }
  function mealBuilderEligible(r){
    return r.extraction?.type==='meal'&&!usableRecipe(r.extraction.meal?.recipeCalculation)||r.kind==='entry'&&!usableRecipe(r.entry?.sourceMeta?.mealRecipeCalculation)&&(r.entry?.sourceMeta?.nutritionEstimate==='photo'||Array.isArray(r.entry?.sourceMeta?.mealComposition));
  }
  // Search all bundled CoFID/USDA identities without copying their nutrients
  // into a user's meal. This small index is built once, only when searching.
  const ingredientName=v=>typeof v==='string'&&v.trim().length>=1&&v.trim().length<=80&&/[\p{L}\p{N}]/u.test(v)&&!/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v)?v.trim():null;
  const ingredientLabel=v=>{const s=String(v||'').trim();return s.length<=80?s:s.slice(0,81).replace(/\s+\S*$/,'').replace(/[,; ]+$/,'');};
  let ingredientIndex=null,ingredientDataset=null;
  function ingredientSearch(query,limit=60){
    const q=text(query,160).toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,''),terms=q.split(/\s+/).filter(Boolean);
    if(!terms.length)return {items:[],total:0};
    const data=root.NudgeMealRecoveryData;
    if(!ingredientIndex||ingredientDataset!==data){
      ingredientDataset=data;const seen=new Map();
      for(const row of [...mealCatalogue.map(c=>({name:c.name,category:c.category})),...(data?.records||[]).map(t=>({name:ingredientLabel(t[3]),searchName:t[3],category:'Food catalogue'}))]){
        if(!ingredientName(row.name))continue;
        const key=tagKey(row.name),search=(row.searchName||row.name).toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
        if(!seen.has(key))seen.set(key,{name:row.name,category:row.category,search});
        else if(!seen.get(key).search.includes(search))seen.get(key).search+=' '+search;
      }
      ingredientIndex=[...seen.values()];
    }
    const matches=ingredientIndex.filter(item=>terms.every(term=>item.search.includes(term)));
    matches.sort((a,b)=>(a.name.toLowerCase()===q?-2:a.name.toLowerCase().startsWith(q)?-1:0)-(b.name.toLowerCase()===q?-2:b.name.toLowerCase().startsWith(q)?-1:0)||a.name.length-b.name.length||a.name.localeCompare(b.name));
    return {items:matches.slice(0,Math.min(100,Math.max(1,limit))).map(({name,category})=>({name,category})),total:matches.length};
  }
  function mealContext(r){
    const name=text(r.draft.name||r.extraction?.meal?.name||r.entry?.name,100),n=name.toLowerCase();
    if(/\b(smoothie|shake)\b/.test(n))return {name,kind:'smoothie',groups:['Fruit','Seeds and nuts','Dairy and drinks'],extras:['Oats','Spinach','Kale','Honey']};
    if(/\b(porridge|oatmeal|overnight oats|granola|muesli|yogh?urt)\b/.test(n))return {name,kind:'breakfast',groups:['Fruit','Seeds and nuts'],extras:['Oats','Milk','Yoghurt','Greek yoghurt','Kefir','Oat drink','Soya drink','Almond drink','Honey','Cocoa powder']};
    if(/\b(soup|broth)\b/.test(n))return {name,kind:'soup',groups:['Vegetables','Oils'],extras:['Potato','Lentils','Chickpeas','Chicken','Cream','Stock','Ginger','Coriander','Black pepper']};
    if(/\b(salad|poke)\b/.test(n))return {name,kind:'salad',groups:['Vegetables','Seeds and nuts','Oils'],extras:['Avocado','Lemon','Quinoa','Chickpeas','Lentils','Chicken','Tuna','Salmon','Feta','Eggs','Vinegar','Mustard','Basil','Coriander']};
    if(/\b(curry|dhal|dal|stew|chilli|chili|tagine)\b/.test(n))return {name,kind:'curry',groups:['Vegetables','Oils'],extras:['Brown rice','White rice','Lentils','Chickpeas','Kidney beans','Tofu','Chicken','Beef','Prawns','Yoghurt','Coconut milk','Ginger','Cumin','Turmeric','Coriander','Chilli','Paprika']};
    if(/\b(pasta|spaghetti|lasagne|lasagna|risotto|pizza)\b/.test(n))return {name,kind:'pasta',groups:['Vegetables','Oils'],extras:['Pasta','Wholewheat pasta','White rice','Chicken','Beef','Prawns','Tuna','Cheese','Feta','Cream','Pine nuts','Basil','Oregano','Black pepper']};
    if(/\b(stir.?fry|noodles?|rice bowl)\b/.test(n))return {name,kind:'stirfry',groups:['Vegetables','Oils'],extras:['Brown rice','White rice','Tofu','Edamame','Chicken','Beef','Prawns','Eggs','Cashews','Peanuts','Sesame seeds','Noodles','Soy sauce','Ginger','Chilli','Coriander']};
    if(/\b(sandwich|wrap|toast|burger)\b/.test(n))return {name,kind:'sandwich',groups:['Vegetables','Oils'],extras:['Avocado','Chicken','Turkey','Beef','Tuna','Eggs','Cheese','Feta','Peanut butter','Bread','Wholemeal bread','Mayonnaise','Mustard']};
    if(/\b(nuts?|seeds?|trail mix|snack|crisps?|popcorn|chocolate|biscuits?|cookies?)\b/.test(n))return {name,kind:'snack',groups:['Seeds and nuts'],extras:['Dates','Grapes','Cocoa powder','Honey']};
    if(detail().isDrink({name})||/\b(milkshake|latte|cappuccino)\b/.test(n))return {name,kind:'drink',groups:['Dairy and drinks'],extras:['Honey','Sugar','Cocoa powder']};
    return {name,kind:'meal',groups:['Vegetables','Grains and pulses','Protein and extras','Oils'],extras:[]};
  }
  function mealPortionOptions(r,context){
    const volume=['smoothie','drink','soup'].includes(context.kind),snack=context.kind==='snack',breakfast=context.kind==='breakfast';
    let options=volume?[{label:'250 ml',amount:250,unit:'ml'},{label:'500 ml',amount:500,unit:'ml'},...(context.kind==='soup'?[]:[{label:'UK pint',amount:detail().HALF_UK_PINT_ML*2,unit:'ml'}])]:
      (snack?[30,50,100]:breakfast?[150,250,350]:[250,400,500]).map(amount=>({label:amount+' g',amount,unit:'g'}));
    const base=r.extraction?.meal?.portion||(r.entry?{amount:r.entry.portionAmount,unit:r.entry.portionUnit}:null);
    if(positive(base?.amount)&&base.amount<=5000&&['g','ml'].includes(base.unit)&&!options.some(o=>o.amount===base.amount&&o.unit===base.unit))options.unshift({label:'Photo estimate · '+Number(base.amount.toFixed(1))+' '+base.unit,amount:base.amount,unit:base.unit});
    return {options,defaultUnit:volume?'ml':'g',step:snack?10:25,portionKind:volume?(context.kind==='soup'?'soup':'drink'):snack?'snack':'meal'};
  }
  function mealBuilder(r){
    if(!mealBuilderEligible(r))return null;
    const meal=r.extraction?.meal,meta=r.entry?.sourceMeta||{},selected=tagNames(r.draft.mealIngredients||meta.mealIngredientSelection?.names),detected=tagNames((meal?.components||meta.mealComposition||[]).filter(c=>!c.userIngredientTag).map(c=>c.name).concat((meal?.ingredients||[]).filter(c=>!c.userIngredientTag).map(c=>c.name))),context=mealContext(r);
    const allIngredients=[...mealCatalogue,...tagNames([...detected,...selected]).filter(name=>!mealCatalogue.some(c=>sameTag(c.name,name))).map(name=>({name,category:'Your ingredients'}))];
    const wanted=new Set([...detected,...selected,...mealCatalogue.filter(c=>context.groups.includes(c.category)||context.extras.includes(c.name)).map(c=>c.name)].map(tagKey));
    const catalogue=allIngredients.filter(c=>wanted.has(tagKey(c.name)));
    const portions=mealPortionOptions(r,context);
    return {selected,confirmed:r.draft.mealIngredientsConfirmed===true||selected.length>0,catalogue,allIngredients,maximum:40,portion:r.draft.mealPortion||meta.mealWholePortion||null,...portions,
      explanation:'Ideas for '+(context.name||'your meal')+'. Tap only what you used; these are editable suggestions.',
      portionExplanation:r.draft.mealPortion?.nutritionScaled===false?'Your whole portion is recorded. Nutrition keeps the photographed ingredient amounts; grams and ml are not interchangeable.':'Choose the amount you ate or drank. These are editable amounts, not a recommended serving.'};
  }
  function applyMealIngredients(r,value){
    if(!mealBuilderEligible(r))return;
    const available=mealBuilder(r).catalogue,requested=tagNames(value);
    if(!Array.isArray(value)||value.length>40||value.some(name=>!ingredientName(name))){r.draft.inputError='Add up to 40 ingredients, using 1–80 characters for each name.';return;}
    if(r.kind==='entry')editSavedCalculation(r);
    const e=r.extraction;if(e?.type!=='meal')return;
    const selected=requested.map(name=>available.find(c=>sameTag(c.name,name))?.name||mealCatalogue.find(c=>sameTag(c.name,name))?.name||name);
    // Preserve quantities and source matches for analysed components. Newly
    // confirmed identities have unknown amounts, never a share of the whole.
    const base=clone(e);
    if(!r.mealIngredientBase)r.mealIngredientBase=clone(e);
    const previousAdded=(e.meal.components||[]).filter(c=>c.userIngredientTag),removed=previousAdded.filter(c=>!selected.some(name=>sameTag(c.name,name)));
    e.meal.components=(e.meal.components||[]).filter(c=>!c.userIngredientTag||selected.some(name=>sameTag(c.name,name)));
    e.meal.ingredients=(e.meal.ingredients||[]).filter(c=>!removed.some(old=>sameTag(old.name,c.name)));
    e.ingredients.plants=(e.ingredients.plants||[]).filter(p=>!removed.some(c=>sameTag(c.name,p.evidence)||sameTag(c.name,p.name)));
    for(const c of e.meal.components){delete c.userConfirmedIngredient;}
    for(const name of selected){
      const component=e.meal.components.find(c=>sameTag(c.name,name));
      if(component)component.userConfirmedIngredient=name;
      else e.meal.components.push({name,amountGrams:null,amountSource:'unknown',recordId:null,sourceRecord:null,nutrients:{},matchStatus:'unmatched',evidence:'User confirmed ingredient: '+name,userIngredientTag:true,userConfirmedIngredient:name});
      if(!e.meal.ingredients.some(c=>sameTag(c.name,name)))e.meal.ingredients.push({name,evidence:'User confirmed ingredient: '+name,userIngredientTag:true});
    }
    if(e.meal.components.length>40){r.draft.inputError='This meal already has many analysed ingredients. Choose fewer additional ingredients.';Object.assign(e,clone(base));return;}
    r.draft.mealIngredients=selected;r.draft.mealIngredientsConfirmed=true;r.draft.mealIngredientScope='complete';r.draft.plantSelectionConfirmed=false;
    if(!e.meal.components.length&&r.mealIngredientBase&&!r.mealIngredientBase.meal?.components?.length){
      e.nutrients=clone(r.mealIngredientBase.nutrients);e.meal.nutrients=clone(r.mealIngredientBase.meal.nutrients);e.meal.portion=clone(r.mealIngredientBase.meal.portion);
      delete e.meal.compositionVersion;
    }
    if(e.meal.components.length){
      e.meal.compositionVersion=e.meal.compositionVersion||'user-ingredient-identities-v1';
      invalidateMeal(e);refreshMeal(r);
    }
    const current=r.extraction;
    current.ingredients={...current.ingredients,text:tagNames([...e.meal.ingredients.map(c=>c.name),...e.meal.components.map(c=>c.name),...selected]).join(', '),needsReview:true};
    // Count explicitly identified whole plants only. Oils, juice, protein
    // powders and mixed drinks do not establish named whole-plant intake.
    for(const name of selected)for(const plant of root.WmdFoodLog.ingredientPlants([name])){
      if(!current.ingredients.plants.some(p=>sameTag(p.name,plant)))current.ingredients.plants.push({name:names([plant])[0]||plant,evidence:name,selected:true,originalName:plant,userEdited:false,source:'user_ingredient_tag'});
    }
    current.meal.userIngredientSelection={version:'meal-ingredients-v1',names:selected,source:'user',confirmed:true};
    // Keep recorded/transcribed speech separate from explicit tag evidence.
    // Choosing identities is not a requirement to weigh every ingredient.
    r.draft.portionConfirmed=true;
  }
  function applyMealPortion(r,value){
    if(!mealBuilderEligible(r))return;
    const amount=num(value?.amount),unit=value?.unit;
    if(!positive(amount)||amount<1||amount>5000||!['g','ml'].includes(unit)){r.draft.inputError='Choose a whole portion greater than zero and up to 5,000 g or ml.';return;}
    const original=r.extraction?.meal?.portion||(r.entry?{amount:r.entry.portionAmount,unit:r.entry.portionUnit}:null);
    const compatible=original?.unit===unit&&positive(original.amount);
    const fraction=compatible?amount/original.amount:r.draft.amount;
    if(compatible&&(fraction<.0001||fraction>8)){r.draft.inputError='Choose an amount up to eight photographed portions.';return;}
    r.draft.mealPortion={amount,unit,source:'user',nutritionScaled:compatible};
    if(compatible){r.draft.amount=fraction;r.draft.measureId='serving';r.draft.quantity=fraction;}
    r.draft.portionConfirmed=true;r.draft.quantityError='';
  }
  function analysis(){return root.NudgeAnalysisResult.create({
    names:(...args)=>root.WmdFoodLog.names(...args),
    suggestion:raw=>raw&&text(raw.label,80)&&typeof raw.amount==='number'&&raw.amount>=.1&&raw.amount<=5000&&['g','ml'].includes(raw.unit)&&['label','estimated'].includes(raw.source)?{label:text(raw.label,80),amount:raw.amount,unit:raw.unit,source:raw.source}:null,
    composition:root.NudgeComposition,mealRecovery:root.NudgeMealRecovery,frequency:root.NudgeFrequency,
    mealScore:root.NudgeMealScore,score:root.NudgeScoreCore,foodDetail:detail(),productEvidence:root.NudgeProductEvidence
  });}
  function stableID(r,o){return text(r.confirmationId||o.confirmationId||o.id||r.id||(r.eventId?'food:'+r.eventId:''),100);}
  function oldEntry(r,state){return r.entryId?entries(state).find(e=>e.id===r.entryId)||null:null;}
  function entryProduct(p,entry){
    if(!entry)return clone(p);
    const d=detail(),result={...clone(p),name:entry.name,brand:entry.brand,ingredients:entry.ingredients?.text||p.ingredients,
      ingredientPlants:entry.ingredients?.plants||p.ingredientPlants,portionSaltConflict:entry.sourceMeta?.portionSaltConflict===true,
      servingNutrients:null,servingNutrientSource:null,
      reviewedPlants:{source:'confirmed-diary',names:entry.plants||[],known:entry.sourceMeta?.plantKnowledge==='known',evidence:entry.ingredients?.plants||[]},
      confirmedPortion:{amount:entry.portionAmount,unit:entry.portionUnit,nutrients:Object.fromEntries(fields.map(([key])=>{const n=root.NudgeComposition.intakeNutrient(entry,key);return [key,n.partial?null:n.value];}))}};
    result.basisUnit=entry.sourceMeta?.labelBasis==='per100ml'?'ml':entry.sourceMeta?.labelBasis==='per100g'?'g':p.basisUnit;
    result.nutrients=Object.fromEntries(fields.map(([key,,unit])=>{const n=entry.nutritionSnapshot?.[key];return [key,{value:known(n?.per100)?n.per100:null,unit,status:n?.per100Status||'unknown'}];}));
    result.nutritionPreparation=entry.sourceMeta?.nutritionPreparation||p.nutritionPreparation;
    if(d.scoreFingerprint(result)!==d.scoreFingerprint(p)){result.nutriScoreGrade=null;result.nutriScore2023=null;result.scoreSource=null;result.energyKj=null;}
    return result;
  }
  function prepare(input,state={},options={}){
    const r=clone(input||{}),old=oldEntry(r,state),today=options.today||new Date().toISOString().slice(0,10);
    if(r._nativeReviewVersion===VERSION)return r;
    const previous=r.previousProduct||r.previousReview?.product;
    if(previous){r.previousProduct=clone(previous);r.context={...r.context,barcode:previous.barcode||''};}
    // The established source comparison, not a blind table merge, decides which
    // current label facts can belong to this scanned product.
    if(!old&&previous&&r.extraction?.type!=='meal'&&r.extraction){
      const extraction=analysis().normalise(r.extraction);
      if(extraction){r.product=root.NudgeProductEvidence.augmentFromLabel(extraction,previous);r.kind='product';r.extraction=extraction;}
    }
    r.kind=['product','analysis','entry'].includes(r.kind)?r.kind:r.product?'product':r.extraction?'analysis':'entry';
    r.confirmationId=old?.sourceMeta?.confirmationId||stableID(r,options);
    const base=old||r.entry||{};
    r.photos=root.WmdFoodLog.photoReferences?.([...(base.sourceMeta?.entryPhotos||[]),...(r.photos||r.previousReview?.photos||[])])||[];
    const destinationDay=old?.day||r.day||r.previousReview?.draft?.day||(r.entryId?base.day:today),destinationSlot=old?.slot??(r.entryId?base.slot:'');
    r.draft={name:text(base.name||r.product?.name||r.extraction?.productName||r.extraction?.meal?.name),brand:text(base.brand||r.product?.brand||r.extraction?.brand,80),day:destinationDay,slot:['Breakfast','Lunch','Dinner','Snack'].includes(destinationSlot)?destinationSlot:'',corrections:{},batchServings:1,batchVolumeMl:null,portionConfirmed:false,quantityError:'',inputError:''};
    if(r.kind==='product'&&old&&old.portionAmount*old.portions>5000){
      // Keep valid legacy multi-portion entries editable within the established
      // product quantity limit by using the existing saved-portion editor.
      r.previousProduct=clone(r.product);delete r.product;r.kind='entry';r.legacyProductMultiple=old.portions;
    }
    if(r.kind==='product'){
      r.product=entryProduct(r.product||{},old);
      if(old)r.savedProductFingerprint=detail().scoreFingerprint(r.product);
      const previousPortion=r.previousReview?.draft?.portion;
      const restore=previousPortion&&r.product.barcode&&r.product.barcode===previous?.barcode&&r.product.basisUnit===previous?.basisUnit?detail().portionRecord(previous,previousPortion):null;
      const savedPortion=old?.sourceMeta?.portionSelection||(positive(old?.portionAmount)?{canonicalAmount:old.portionAmount,unit:old.portionUnit,measureId:old.portionUnit}:null);
      r.draft.portion=detail().createPortion(r.product,savedPortion||restore);
      // Legacy product intake may store multiple copies of its saved portion.
      // Reopen the full eaten amount before normalising it to one intake record.
      if(old&&positive(old.portions))r.draft.portion.canonicalAmount*=old.portions;
      r.draft.quantity=detail().quantity(r.product,r.draft.portion);
    }else if(r.kind==='analysis'){
      r.extraction=analysis().normalise(r.extraction,{confirmedSnapshot:false});
      if(usableRecipe(r.extraction?.meal?.recipeCalculation)&&!r.extraction.meal.recipeCalculation.applied&&!r.extraction.meal.recipeCalculation.deferredReason){
        const recipe=r.extraction.meal.recipeCalculation;
        r.extraction.meal=root.NudgeRecipeComposition?.apply(r.extraction.meal,recipe.servings||null,{portionFraction:1,source:'recipe'})||r.extraction.meal;
        refreshMeal(r);
      }
      if(r.extraction?.type==='meal'){
        r.draft.amount=1;r.draft.measureId='serving';
        r.draft.portionConfirmed=r.extraction.meal?.portionAmbiguity?.requiresSelection!==true&&r.extraction.meal?.subject?.kind!=='serving_dish'||Boolean(r.extraction.meal?.recipeCalculation?.applied);
      }else if(r.extraction){
        const e=r.extraction,s=e.servingSize||e.servingSuggestion;
        r.draft.unit=e.basis==='per100ml'?'ml':e.basis==='perServing'?s?.unit||'g':'g';
        r.draft.amount=s?.unit===r.draft.unit?(s.value||s.amount):100;
        if(old&&positive(old.portionAmount)&&['g','ml'].includes(old.portionUnit)){r.draft.amount=old.portionAmount;r.draft.unit=old.portionUnit;}
        r.draft.portionConfirmed=true;
      }
      r.draft.name=text(old?.name||r.extraction?.productName);r.draft.quantity=r.draft.amount;
    }else{
      r.entry=clone(base);r.draft.amount=positive(base.portions)?base.portions:1;
      r.draft.measureId='serving';r.draft.quantity=r.draft.amount;r.draft.portionConfirmed=true;
      r.draft.batchVolumeMl=base.sourceMeta?.intakePortionSelection?.baseVolumeMl||null;
    }
    r.draft.mealIngredients=tagNames(r.extraction?.meal?.userIngredientSelection?.names||r.previousReview?.draft?.mealIngredients||old?.sourceMeta?.mealIngredientSelection?.names||base.sourceMeta?.mealIngredientSelection?.names);
    r.draft.mealIngredientsConfirmed=r.draft.mealIngredients.length>0||r.extraction?.meal?.userIngredientSelection?.confirmed===true||r.previousReview?.draft?.mealIngredientsConfirmed===true||old?.sourceMeta?.mealIngredientSelection?.confirmed===true||base.sourceMeta?.mealIngredientSelection?.confirmed===true;
    r.draft.mealIngredientScope=(r.extraction?.meal?.userIngredientSelection?.scope||r.previousReview?.draft?.mealIngredientScope||old?.sourceMeta?.mealIngredientSelection?.scope||base.sourceMeta?.mealIngredientSelection?.scope)==='includes'?'includes':'complete';
    r.draft.plantSelectionConfirmed=base.sourceMeta?.plantSelectionConfirmed===true;
    const mealPortion=r.extraction?.meal?.userPortion||r.previousReview?.draft?.mealPortion||old?.sourceMeta?.mealWholePortion||base.sourceMeta?.mealWholePortion;
    r.draft.mealPortion=mealPortion?.source==='user'&&positive(mealPortion.amount)&&mealPortion.amount<=5000&&['g','ml'].includes(mealPortion.unit)?{amount:mealPortion.amount,unit:mealPortion.unit,source:'user',nutritionScaled:mealPortion.nutritionScaled===true}:null;
    if(r.draft.mealPortion)r.draft.portionConfirmed=true;
    r._nativeReviewVersion=VERSION;
    return r;
  }
  function editSavedCalculation(r){
    const entry=r.entry,meta=entry?.sourceMeta,components=meta?.mealComposition;
    if(r.kind!=='entry'||(!Array.isArray(components)&&meta?.nutritionEstimate!=='photo'))return r;
    const scale=Number(meta.photoPortions),baseScale=scale>0&&scale<=8?scale:1,amount=r.draft.amount*baseScale;
    // Meal ingredients were saved as a comma-separated list. Restore that
    // entire confirmed list, not just its botanical subset: choosing a recipe
    // alternative must retain the other ingredient and allergen declarations.
    const ingredientRows=typeof entry.ingredients?.text==='string'&&entry.ingredients.text.trim()?entry.ingredients.text.split(',').map(name=>name.trim()).filter(Boolean).map(name=>({name,evidence:name})):clone(entry.ingredients?.plants)||[];
    const plants=(entry.plants||[]).map(name=>({name,evidence:entry.ingredients?.plants?.find(p=>p.name===name)?.evidence||name}));
    const raw={type:'meal',productName:r.draft.name,nutrients:{},meal:{name:r.draft.name,compositionVersion:meta.compositionVersion||'confirmed-components',components:clone(components)||[],recipeCalculation:clone(meta.mealRecipeCalculation)||null,portionMode:meta.mealPortionMode==='estimated_serving'?'estimated_serving':'photographed_portion',ingredients:ingredientRows,plants,nutrients:{},portion:{amount:positive(entry.portionAmount)?entry.portionAmount/baseScale:null,unit:entry.portionUnit}}};
    const estimate=meta.mealNutrientEstimate?.source==='model_photo_estimate'&&root.NudgeComposition?.validateNutrientEstimate?.(meta.mealNutrientEstimate.estimate);
    if(estimate){
      // Opening the calculation preserves the confirmed intake, including an
      // explicit cleared field. An actual ingredient edit invalidates it below.
      raw.meal.nutrientEstimate=estimate;
      raw.meal.nutrientEstimateContext=root.NudgeComposition.nutrientEstimateContext(raw.meal);
      raw.meal.nutrients=Object.fromEntries(fields.map(([key,,unit])=>{const n=entry.nutritionSnapshot?.[key],value=n?.unit===unit&&known(n.portion)?n.portion/baseScale:null;
        return [key,{value,unit,...(value!==null&&n.estimated===true&&n.source==='model_photo_estimate'?{estimated:true,status:'estimated',source:'model_photo_estimate',relation:'approx'}:{}),
          ...(key==='carbohydrate'&&['available','by_difference_including_fibre','unspecified'].includes(n?.carbohydrateDefinition)?{carbohydrateDefinition:n.carbohydrateDefinition}:{})}];}));
      if(fields.some(([key])=>raw.meal.nutrients[key].value===null))raw.meal.userEdited=true;
      if(analysis().validMealScore(meta.mealScore))raw.meal.scoreSnapshot=clone(meta.mealScore);
    }
    r.kind='analysis';r.extraction=analysis().normalise(raw,{confirmedSnapshot:true});
    r.editingSavedCalculation=true;
    r.extraction.ingredients={text:entry.ingredients?.text||entry.plants?.join(', ')||'',plants:(entry.plants||[]).map(name=>({name,evidence:entry.ingredients?.plants?.find(p=>p.name===name)?.evidence||name,selected:true,originalName:name,userEdited:false})),needsReview:entry.ingredients?.needsReview===true,fromConfirmedSnapshot:true};
    r.draft.amount=amount;r.draft.quantity=amount;r.draft.measureId='serving';r.draft.portionConfirmed=true;
    return r;
  }
  function mealMeasures(r){
    const base=r.kind==='entry'?{amount:r.entry?.portionAmount,unit:r.entry?.portionUnit}:r.extraction?.meal?.portion;
    const measures=detail().mealMeasures(base,{servings:r.draft.batchServings,volumeMl:r.draft.batchVolumeMl});
    if(r.kind==='entry'&&r.legacyProductMultiple)measures.maximum=Math.max(measures.maximum,r.legacyProductMultiple);
    const recipe=r.extraction?.meal?.recipeCalculation;
    if(usableRecipe(recipe)&&recipe.applied&&!recipe.userEdited){
      measures.options=[{id:'serving',label:'selected share',plural:'selected shares',factor:1,step:.25,description:'Your selected recipe share, with any photographed sides kept separate'}];
    }
    return measures;
  }
  function selectedMeasure(r){const info=mealMeasures(r);return info.options.find(m=>m.id===r.draft.measureId)||info.options[0];}
  function invalidateMeal(e){
    e.confirmedSnapshot=false;
    if(e.meal){delete e.meal.scoreSnapshot;delete e.meal.qualityEstimate;delete e.meal.recovery;delete e.meal.compoundProposal;if(e.meal.recipeCalculation)e.meal.recipeCalculation.userEdited=true;}
  }
  function refreshMeal(r){
    if(r.extraction?.type!=='meal')return;
    const calculated=analysis().calculateComposition(r.extraction);
    r.extraction=calculated.extraction;
    if(calculated.portionConfirmed!==undefined)r.draft.portionConfirmed=calculated.portionConfirmed;
  }
  function clearProductScore(p){delete p.confirmedPortion;delete p.scoreResult;delete p.nutriScore2023;delete p.nutriScoreGrade;delete p.scoreSource;delete p.energyKj;delete p.reviewedProductFacts;}
  function invalidateEntry(entry){
    const meta=entry.sourceMeta||{},history=[...(meta.scoreHistory||[])];
    for(const key of ['scoreMethod','mealScore'])if(meta[key]){history.push(clone(meta[key]));delete meta[key];}
    meta.scoreHistory=history.slice(-12);entry.sourceMeta=meta;
  }
  function update(input,patch={},state={},options={}){
    const r=prepare(input,state,options);
    if(patch.editSavedCalculation===true)editSavedCalculation(r);
    r.draft.inputError='';
    if(Object.hasOwn(patch,'mealIngredients'))applyMealIngredients(r,patch.mealIngredients);
    if(Object.hasOwn(patch,'mealPortion')&&!r.draft.inputError)applyMealPortion(r,patch.mealPortion);
    const d=r.draft,e=r.extraction,p=r.product;
    for(const key of ['name','brand','day','slot'])if(Object.hasOwn(patch,key)){
      const value=text(patch[key],key==='brand'?80:100);d[key]=value;
      if(key==='name'&&r.kind==='analysis'&&e?.meal&&value!==e.meal.name){e.meal.name=value;invalidateMeal(e);}
      if(key==='name'&&p&&p.name!==value){p.name=value;clearProductScore(p);}
      if(key==='brand'&&p&&p.brand!==value){p.brand=value;clearProductScore(p);}
    }
    if(Object.hasOwn(patch,'measureId')){
      if(r.kind==='product'){
        d.portion=detail().switchMeasure(p,d.portion,patch.measureId);d.quantity=detail().quantity(p,d.portion);
      }else if(r.kind==='entry'||e?.type==='meal'){
        const measure=mealMeasures(r).options.find(m=>m.id===patch.measureId);
        if(measure){d.measureId=measure.id;d.quantity=d.amount/measure.factor;}
      }
      d.quantityError='';
    }
    if(Object.hasOwn(patch,'quantity')){
      d.quantity=patch.quantity;const value=num(patch.quantity);
      if(r.kind==='product'){
        const portion=detail().setAmount(p,d.portion,patch.quantity);
        if(portion){d.portion=portion;d.quantityError='';}else d.quantityError='Enter a positive amount up to 5,000 g or ml.';
      }else{
        const info=r.kind==='entry'||e?.type==='meal'?mealMeasures(r):null,measure=info?selectedMeasure(r):null,amount=value===null?null:value*(measure?.factor||1);
        if(amount!==null&&amount>=(info?.minimum||.1)&&amount<=(info?.maximum||5000)){d.amount=amount;d.portionConfirmed=true;d.quantityError='';}
        else d.quantityError='Enter a positive amount within the displayed portion range.';
      }
    }
    for(const key of ['batchServings','batchVolumeMl'])if(Object.hasOwn(patch,key)){
      const value=patch[key]===null||patch[key]===''?null:num(patch[key]);
      if(key==='batchServings'&&value!==null&&value>=1&&value<=50||key==='batchVolumeMl'&&(value===null||value>=.1&&value<=5000)){
        d[key]=value;d.measureId='serving';d.quantity=d.amount/selectedMeasure(r).factor;
      }else d.inputError=key==='batchServings'?'Enter 1–50 servings.':'Enter the measured batch volume, up to 5,000 ml.';
    }
    if(patch.fastRecipeOption&&e?.meal?.recipeCalculation&&(!r.entryId||r.editingSavedCalculation===true)){
      const change=patch.fastRecipeOption,options=e.meal.recipeCalculation.recipeOptions||[];
      if(typeof change.included!=='boolean'||!options.some(o=>o.id===change.id))d.inputError='Choose one of the printed optional ingredients.';
      else{
        const included=options.filter(o=>o.id===change.id?change.included:o.selected).map(o=>o.id);
        const result=root.NudgeFastCapture?.recalculate({extraction:e,includedOptionIds:included});
        if(result?.extraction){r.extraction=analysis().normalise(result.extraction,{confirmedSnapshot:false});Object.assign(e,r.extraction);}
        else d.inputError='Ingredient amounts were edited. Keep those changes or reopen the recipe to change optional ingredients.';
      }
    }
    if(patch.recipeChoice&&e?.meal?.recipeCalculation&&(!r.entryId||r.editingSavedCalculation===true)){
      const selected=root.NudgeRecipeComposition?.selectChoice(e.meal,patch.recipeChoice.id,patch.recipeChoice.value);
      if(selected&&selected!==e.meal){
        r.extraction=analysis().normalise({...e,meal:selected},{confirmedSnapshot:false});
        Object.assign(e,r.extraction);d.portionConfirmed=true;
      }else d.inputError='Choose one of the printed recipe options.';
    }
    if((Object.hasOwn(patch,'recipeFraction')||Object.hasOwn(patch,'recipeServings'))&&e?.meal?.recipeCalculation){
      const recipe=e.meal.recipeCalculation,fraction=Object.hasOwn(patch,'recipeFraction')?num(patch.recipeFraction):recipe.selectedFraction||1;
      const servings=Object.hasOwn(patch,'recipeServings')?blank(patch.recipeServings)?null:num(patch.recipeServings):recipe.servings||null;
      if(!root.NudgeRecipeComposition?.validFraction(fraction)||recipe.userEdited)d.inputError='Choose a share greater than zero and up to the whole dish.';
      else if(!blank(patch.recipeServings)&&Object.hasOwn(patch,'recipeServings')&&(!Number.isInteger(servings)||servings<1||servings>50))d.inputError='Enter 1–50 recipe servings, or leave the yield unknown.';
      else{e.meal=root.NudgeRecipeComposition.apply(e.meal,servings,{portionFraction:fraction,source:'user'});r.extraction={...e,...analysis().calculateComposition(e).extraction};if(Object.hasOwn(patch,'recipeFraction')){d.amount=1;d.quantity=1;}d.measureId='serving';d.batchServings=1;d.batchVolumeMl=null;d.portionConfirmed=true;}
    }
    if(patch.component&&e?.meal?.components){
      const change=patch.component,index=change.index,c=e.meal.components[index];
      if(c&&Number.isInteger(index)){
        if(change.remove===true){
          e.meal.components.splice(index,1);invalidateMeal(e);
          e.meal.ingredients=e.meal.components.map(c=>({name:c.name,evidence:c.evidence||''}));
          if(e.ingredients){e.ingredients.fromConfirmedSnapshot=false;e.ingredients.text=e.meal.components.map(c=>c.name).join(', ');e.ingredients.plants=e.ingredients.plants.filter(plant=>analysis().supportedPlant(e,plant));}
        }
        else{
          if(Object.hasOwn(change,'amountGrams')){
            const amount=change.amountGrams===null||change.amountGrams===''?null:num(change.amountGrams);
            if(blank(change.amountGrams)||amount!==null&&amount>=(c.recipeQuantity?.000001:.1)&&amount<=5000){c.amountGrams=amount;c.amountSource='confirmed';invalidateMeal(e);}
            else d.inputError='Ingredient amounts must be positive grams up to 5,000, or left unknown.';
          }
          if(Object.hasOwn(change,'recordId')){
            const record=[c.sourceRecord,...(c.candidates||[])].find(x=>x&&x.id===change.recordId);
            if(change.recordId===''||record){c.recordId=record?.id||null;c.sourceRecord=record||null;c.nutrients=record?.nutrients||{};c.matchStatus=record?'confirmed':'unmatched';c.matchMethod=record?'user_selected':'unmatched';c.preparationProxy=false;delete c.compoundProxy;delete c.recovery;invalidateMeal(e);}
            else d.inputError='Choose one of the sourced ingredient matches.';
          }
        }
        refreshMeal(r);
      }
    }
    if(Object.hasOwn(patch,'ingredients')){
      const ingredientText=text(patch.ingredients,4000);
      if(r.kind==='product'){p.ingredients=ingredientText;p.ingredientsNeedsReview=false;delete p.reviewedPlants;clearProductScore(p);}
      else if(e){e.ingredients={...e.ingredients,text:ingredientText,textEdited:true,plants:(e.ingredients?.plants||[]).map(plant=>({...plant,evidence:''}))};invalidateMeal(e);}
      else{r.entry.ingredients={...r.entry.ingredients,text:ingredientText,needsReview:false};invalidateEntry(r.entry);}
    }
    if(patch.plant&&e?.ingredients?.plants){const plant=e.ingredients.plants[patch.plant.index];if(plant){plant.selected=patch.plant.selected!==false;plant.userEdited=true;r.draft.plantSelectionConfirmed=true;}}
    if(Object.hasOwn(patch,'plants')&&r.kind==='entry'){r.entry.plants=names(patch.plants);r.entry.sourceMeta={...r.entry.sourceMeta,plantSelectionConfirmed:true};r.draft.plantSelectionConfirmed=true;invalidateEntry(r.entry);}
    if(patch.nutrient&&fields.some(([key])=>key===patch.nutrient.key)){
      const {key}=patch.nutrient,unit=key==='energyKcal'?'kcal':'g',raw=patch.nutrient.value,value=raw===null||raw===''?null:num(raw);
      if(!blank(raw)&&value===null||value!==null&&(!known(value)||value>100000))d.inputError='Enter a known nutrient amount or leave it unknown.';
      else if(r.kind==='product'){
        p.nutrients={...p.nutrients,[key]:{value,unit,status:value===null?'unknown':'confirmed'}};clearProductScore(p);
      }else if(e){
        if(e.meal?.components?.length)d.inputError='Edit the ingredient amounts and sources to update this recipe total.';
        else{e.nutrients[key]={value,unit};d.corrections[key]={value,unit};if(e.meal){e.meal.nutrients[key]={value,unit};invalidateMeal(e);}}
      }else{
        const amount=r.entry.portionAmount;
        r.entry.nutritionSnapshot={...r.entry.nutritionSnapshot,[key]:{per100:value!==null&&positive(amount)?value*100/amount:null,portion:value,unit,per100Status:value!==null&&positive(amount)?'calculated':'unknown',portionStatus:value===null?'unknown':'calculated'}};
        const scalar={energyKcal:'energyPerPortion',protein:'proteinPerPortion',fibre:'fibrePerPortion'}[key];if(scalar)r.entry[scalar]=value;
        r.entry.sourceMeta={...r.entry.sourceMeta,retainedNutrients:[r.entry.sourceMeta?.retainedNutrients,key==='carbohydrate'?'Carbohydrate amount edited by user':key+' amount edited by user'].filter(Boolean).join('; ').slice(-150)};
        invalidateEntry(r.entry);
      }
    }
    if(Object.hasOwn(patch,'basis')){
      if(r.kind==='product'&&['g','ml'].includes(patch.basis)){
        p.basisUnit=patch.basis;clearProductScore(p);d.portion=detail().createPortion(p);d.quantity=detail().quantity(p,d.portion);
      }else if(e&&e.type!=='meal'&&['unknown','per100g','per100ml','perServing'].includes(patch.basis)){
        e.basis=patch.basis;d.corrections.basis=patch.basis;d.unit=e.basis==='per100ml'?'ml':e.basis==='perServing'?e.servingSize?.unit||'g':'g';
      }
    }
    if(patch.servingSize&&e&&e.type!=='meal'){
      const amount=num(patch.servingSize.value),unit=patch.servingSize.unit;
      if(amount!==null&&amount>=.1&&amount<=5000&&['g','ml'].includes(unit)){e.servingSize={value:amount,unit};d.corrections.servingSize=e.servingSize;if(e.basis==='perServing')d.unit=unit;}
      else d.inputError='Enter the printed serving weight or volume and its unit.';
    }
    if(Object.hasOwn(patch,'nutritionPreparation')&&['as_sold','prepared','unknown'].includes(patch.nutritionPreparation)){
      if(p){p.nutritionPreparation=patch.nutritionPreparation;clearProductScore(p);}else if(e)e.nutritionPreparation=patch.nutritionPreparation;
    }
    return r;
  }
  function snapshot(r,state){
    if(r.kind==='product'){
      const d=detail(),values=d.portionNutrients(r.product,r.draft.portion);
      return Object.fromEntries(fields.map(([key,,unit])=>[key,{per100:d.value(r.product,key),portion:values[key]??null,unit,per100Status:r.product.nutrients?.[key]?.status==='calculated'?'calculated':'supplied',portionStatus:known(values[key])?'calculated':'unknown'}]));
    }
    if(r.kind==='analysis'&&r.extraction)return analysis().snapshot(r.extraction,{amount:r.draft.amount,unit:r.extraction.type==='meal'?'portion':r.draft.unit,old:oldEntry(r,state),corrections:r.draft.corrections});
    return Object.fromEntries(fields.map(([key,,unit])=>{const n=root.NudgeComposition.intakeNutrient(r.entry||{},key),value=n.value===null?null:n.value*r.draft.amount;return [key,{unit,portion:n.partial?null:value,portionStatus:n.partial?'partial':value===null?'unknown':'calculated',...(n.partial?{knownPortionSubtotal:value,knownContributions:r.entry?.nutritionSnapshot?.[key]?.knownContributions||1,unknownContributions:r.entry?.nutritionSnapshot?.[key]?.unknownContributions||1}: {})}];}));
  }
  function errors(r,state,options){
    const d=r.draft,out=[],today=options.today||new Date().toISOString().slice(0,10);
    if(!d.name)out.push('Add the food name.');
    if(!validDay(d.day,today))out.push('Choose today or a past date.');
    if(!['','Breakfast','Lunch','Dinner','Snack'].includes(d.slot))out.push('The saved meal category is invalid.');
    if(!r.confirmationId)out.push('The review reference is missing. Reopen this food.');
    if(r.entryId&&!oldEntry(r,state))out.push('This saved entry is no longer available. Nothing will be added.');
    if(d.quantityError)out.push(d.quantityError);if(d.inputError)out.push(d.inputError);
    if(r.kind==='product'&&!detail().valid(r.product,d.portion))out.push('Choose a valid portion.');
    if(r.kind==='analysis'){
      const e=r.extraction;
      if(!e)out.push('The analysis did not include readable food evidence.');
      else if(e.type==='meal'){
        const info=mealMeasures(r);if(!positive(d.amount)||d.amount<info.minimum||d.amount>info.maximum)out.push('Check the portion amount.');
        if(!d.portionConfirmed)out.push('Choose the share of the dish that you ate.');
      }else{
        if(!positive(d.amount)||d.amount>5000)out.push('Choose a positive amount up to 5,000 g or ml.');
        if(e.labelKind!=='ingredients'&&(e.basis==='unknown'||e.basis==='perServing'&&!e.servingSize||e.basis==='per100g'&&d.unit!=='g'||e.basis==='per100ml'&&d.unit!=='ml'||e.basis==='perServing'&&e.servingSize?.unit!==d.unit))out.push('Check the printed nutrition basis and serving units.');
        if(e.labelKind!=='ingredients'&&!Object.values(snapshot(r,state)).some(n=>known(n.portion)&&!n.retained))out.push('Add at least one readable nutrition value.');
      }
    }
    if(r.kind==='entry'&&(!positive(d.amount)||d.amount>mealMeasures(r).maximum))out.push('Check the number of saved portions.');
    return [...new Set(out)];
  }
  function currentScore(r,state,snap){
    const p=r.kind==='product'?r.product:r.kind==='analysis'&&r.extraction&&r.extraction.type!=='meal'?root.NudgeProductEvidence.fromExtraction(r.extraction):null;
    const saved=r.kind==='product'&&r.savedProductFingerprint===detail().scoreFingerprint(p)?oldEntry(r,state)?.sourceMeta?.scoreMethod:null;
    // Date, meal and portion edits retain the confirmed nutrition rating even
    // after a catalogue cache expires. Explicit food-fact edits invalidate it.
    let score=saved?clone(saved):p?detail().score(p):r.kind==='analysis'?analysis().mealScore(r.extraction):r.entry?.sourceMeta?.mealScore||r.entry?.sourceMeta?.scoreMethod||{value:null,status:'unrated',reason:'Nutrition quality has not been rated for this saved food.'};
    if(r.kind==='entry'&&root.NudgeFrequency)score=root.NudgeFrequency.savedDisplay(score,{entry:{...r.entry,day:r.draft.day,slot:r.draft.slot,portions:r.draft.amount},profile:profile(state),avoidMilk:state.avoidMilk,entries:entries(state),product:r.product||r.previousProduct||{}});
    else if(root.NudgeFrequency)score=root.NudgeFrequency.apply(score,{product:p||{ingredients:r.extraction?.ingredients,ingredientsNeedsReview:true},profile:profile(state),avoidMilk:state.avoidMilk,entries:entries(state),day:r.draft.day,slot:r.draft.slot,excludeId:r.entryId,salt:r.kind==='product'&&detail().servingConflict(r.product,r.draft.portion)?null:snap.salt?.portion});
    return score;
  }
  function planning(r,score){
    if(r.kind==='product'||r.kind==='analysis'&&r.extraction?.type!=='meal'||r.entry?.sourceMeta?.scoreMethod)return null;
    if(score?.methodId!=='nudge_nutrition_v0_2'||score.status==='estimated_rough')return null;
    const status=score.frequencyStatus,recall=(r.product||r.previousProduct)?.recallAssessment?.status;
    let title=score.finalFrequency||'More information needed',detail='';
    if(status==='unsuitable'){
      title=score.personalSuitability==='matched_recall'?'Recall notice applies':'Does not match your saved requirements';
      detail=score.personalSuitability==='matched_recall'?'Read the product recall notice and pack details below before consuming.':'The ingredient or allergen conflict is shown above. The nutrition rating does not establish suitability.';
    }else if(status==='check_required'){
      title=recall==='checking'?'Checking recall notices':recall==='potential_match'?'Possible recall match':recall==='check_unavailable'?'Recall check unavailable':'Suitability information incomplete';
      detail=recall==='potential_match'?'Compare the pack with the official notice below.':recall==='checking'?'Planning guidance will update when the recall check finishes.':recall==='check_unavailable'?'Current recall notices could not be checked. See the official source below.':'The available product facts do not establish a match with your saved requirements. Add a clear photo of the current ingredients label.';
    }else if(status==='excluded'){title='Personal guidance needed';detail='The general adult planning policy does not apply to the needs in your profile.';}
    else if(status==='recheck_required'){title='Saved planning guidance needs a recheck';detail='Your meal, its salt total or your food requirements have changed since this entry was confirmed.';}
    else if(status==='incomplete'){
      const missingScore=(score.reasonCodes||[]).includes('nutrition_score_unavailable');title=missingScore?'Nutrition information incomplete':'Salt information incomplete';
      detail=missingScore?'Add the readable nutrition label to complete the rating.':'Planning guidance needs salt for this amount and the other foods in the same meal. Known nutrition is still shown above.';
    }else if(status==='pending'){title='Choose a portion';detail='Select the amount and meal to calculate planning guidance.';}
    else if(score.finalFrequency){detail=score.finalFrequency===score.baseFrequency?'Based on this food’s nutrition rating and salt in the selected meal.':'Adjusted for salt in this eating occasion.';}
    return {title,detail,status:status||'pending',frequency:score.finalFrequency||'',baseFrequency:score.baseFrequency||'',day:score.eatingOccasion?.day||r.draft.day,slot:score.eatingOccasion?.slot||r.draft.slot,saltGrams:score.eatingOccasion?.saltGrams??null,otherFoods:score.eatingOccasion?.otherFoods||0,unknownFoods:score.eatingOccasion?.unknownFoods||0,policyVersion:score.planningVersion||root.NudgeFrequency?.VERSION||'',allowancesAvailable:false};
  }
  const householdEvidence=c=>['recipe-household-v3','recipe-household-v3+uk-volume-v1','local-uk-volume-v1'].includes(c.householdMeasure?.version)?c.householdMeasure:null;
  function sourceRows(r,score){
    const sources=[...(score?.sources||[])],p=r.product;
    if(p)sources.unshift({title:p.sourceName||'Product source',url:p.sourceURL,detail:[p.retrievedAt?'Retrieved '+p.retrievedAt:'',p.licenceName].filter(Boolean).join(' · ')},{title:p.licenceName||'Product data licence',url:p.licenceURL});
    for(const c of r.extraction?.meal?.components||r.entry?.sourceMeta?.mealComposition||[]){const s=c.sourceRecord;if(s)sources.push({title:[s.source,s.name].filter(Boolean).join(' · ')||'Ingredient source',url:s.sourceURL,detail:[s.sourceVersion,s.code].filter(Boolean).join(' · ')},{title:'Ingredient data licence',url:s.licenceURL});const measure=householdEvidence(c);if(measure){const detail=(c.assumptions||[]).join(' ');sources.push({title:c.name+' · amount estimate',url:measure.sourceURL,detail});if(measure.version!=='recipe-household-v3')sources.push({title:c.name+' · measuring spoon',url:measure.unitSourceURL,detail:'UK teaspoon: 5 ml; tablespoon: 15 ml. '+detail});}}
    const seen=new Set();return sources.filter(x=>typeof x?.url==='string'&&/^https:\/\//.test(x.url)).filter(x=>{const key=(x.title||'Source')+x.url;if(seen.has(key))return false;seen.add(key);return true;}).map(x=>({title:x.title||'Source',url:x.url,detail:x.detail||''}));
  }
  function reviewPlants(r){
    const log=root.WmdFoodLog,e=r.extraction;
    if(r.product)return log.plantNames(detail().plants(r.product).names);
    if(!e)return log.intakePlants(r.entry);
    const selected=analysis().selectedPlants(e);
    if(e.type!=='meal'||r.draft.plantSelectionConfirmed)return log.plantNames(selected);
    if(r.draft.mealIngredientsConfirmed){
      const tagged=log.ingredientPlants(r.draft.mealIngredients,{plants:selected,components:e.meal?.components});
      return r.draft.mealIngredientScope==='includes'?log.plantNames([...selected,...tagged,...(root.NudgeComposition.namedComponentPlants(e.meal?.components)||[]).map(p=>p.name)]):tagged;
    }
    // Recipe application can replace components after normalisation. Read the
    // resulting source identities without modifying quantities or allergy text.
    const components=e.ingredients?.textEdited||e.ingredients?.fromConfirmedSnapshot?[]:
      [...(root.NudgeComposition.componentPlants(e.meal?.components)||[]),...(root.NudgeComposition.namedComponentPlants(e.meal?.components)||[])].filter(p=>!(e.ingredients?.plants||[]).some(old=>log.plantNames([old.name])[0]===p.name&&old.selected===false));
    return log.plantNames([...selected,...components.map(p=>p.name)]);
  }
  function model(input,state={},options={}){
    const r=prepare(input,state,options),d=r.draft,snap=snapshot(r,state),meal=r.extraction?.type==='meal',entry=r.kind==='entry',p=r.product;
    const info=p?detail().measures(p):entry||meal?mealMeasures(r):{options:[{id:d.unit,label:d.unit==='ml'?'millilitres':'grams',factor:1,step:10}],maximum:5000,minimum:.1};
    const measure=p?detail().selectedMeasure(p,d.portion):entry||meal?selectedMeasure(r):info.options[0];
    const retainedRecipe=r.extraction?.meal?.recipeCalculation,recipe=usableRecipe(retainedRecipe)?retainedRecipe:null,score=currentScore(r,state,snap),issues=errors(r,state,options);
    const recipeNutrients=recipe?.applied?root.NudgeComposition.total(recipe.batchComponents||[]):null;
    const builder=mealBuilder(r);
    // The user's ingredient list owns the visible summary after confirmation.
    // Keep source evidence intact for nutrition and allergy checks; a fresh AI
    // result must not quietly add its guesses back to the confirmed display.
    const ingredientEvidence=p?(typeof p.ingredients==='string'?p.ingredients:p.ingredients?.text||''):r.extraction?.ingredients?.text||r.entry?.ingredients?.text||'';
    const ingredientText=builder?.confirmed&&d.mealIngredientScope!=='includes'?builder.selected.join(', '):ingredientEvidence;
    const plants=reviewPlants(r);
    const amount=d.mealPortion?.amount??(p?d.portion.canonicalAmount:entry?r.entry?.portionAmount&&r.entry.portionAmount*d.amount:meal?r.extraction.meal?.portion?.amount&&r.extraction.meal.portion.amount*d.amount:d.amount);
    return {version:VERSION,kind:r.kind,title:d.name||'Review your food',draft:d,editing:Boolean(r.entryId),image:r.photos?.[0]||root.WmdFoodLog.entryImage?.(oldEntry(r,state)||r.entry)||r.thumbnail||root.NudgeProductEvidence.publicProductImage(p)||r.entry?.sourceMeta?.repertoireImage||'',
      ...(root.NudgeToday?.compactReview?root.NudgeToday.compactReview(state,d.day,snap,plants,r.entryId,options.today||d.day,p?detail().plants(p).known:plants.length>0||d.plantSelectionConfirmed||d.mealIngredientsConfirmed&&d.mealIngredients.length===0||r.entry?.sourceMeta?.plantKnowledge==='known'||Boolean((r.extraction?.ingredients||r.entry?.ingredients)?.text&&!(r.extraction?.ingredients||r.entry?.ingredients)?.needsReview)):{}),
      mealBuilder:builder,
      score,scoreStatus:score?.methodId==='nudge_nutrition_v0_4'&&score?.value!=null?'Nudge score':root.NudgeFrequency?.legacy(score)?'Historical rating':score?.status==='estimated_rough'?'Rough estimate':score?.estimated||/^estimated/.test(score?.status||'')?(/provisional/.test(score?.status||'')?'Estimated · provisional rating':'Estimated rating'):/provisional/.test(score?.status||'')?'Provisional rating':score?.value!=null?'Nudge nutrition rating':'Rating unavailable',
      // Use applied nutrient provenance, not the presence of an unused model
      // proposal or score availability. Saved entries keep their own snapshot.
      nutritionEstimated:fields.some(([key])=>{const value=r.kind==='entry'?r.entry?.nutritionSnapshot?.[key]:snap[key];return known(snap[key]?.portion)&&value?.source==='model_photo_estimate'&&value?.estimated===true;}),
      planning:planning(r,score),
      allergies:detail().allergies(p||{ingredients:ingredientEvidence,ingredientsNeedsReview:r.extraction?.ingredients?.needsReview},profile(state),{avoidMilk:state.avoidMilk}),
      evidenceWarnings:[...(p?.metadata?.conflicts||r.extraction?.metadata?.conflicts||[]).map(x=>x.description||x.reason),...(p?.sourceDifferences||[]).filter(x=>x.status==='unresolved_identity').map(x=>x.reason),...(r.extraction?.needsClearerPhoto?[r.extraction.message||'Some label details could not be read.']:[]),...((r.extraction?.meal?.components||[]).some(householdEvidence)?['Spoon sizes, brands and mixed ingredients are estimated. Review the ingredient amounts before saving.']:[])].filter(Boolean),
      nutrients:fields.map(([key,title,unit])=>({key,title,unit,value:snap[key]?.portion??null,partial:snap[key]?.portionStatus==='partial',knownSubtotal:snap[key]?.knownPortionSubtotal??null,unknownContributions:snap[key]?.unknownContributions||0})),
      nutritionExplanation:d.mealIngredients?.length&&fields.some(([key])=>!known(snap[key]?.portion))?'Ingredient identities are confirmed; their amounts are still unknown. Only known ingredient amounts contribute to the partial nutrition below.':recipe?.deferredReason?'Photo portion estimate. '+recipe.deferredReason:recipe?.applied&&fields.some(([key])=>!known(snap[key]?.portion))?(fields.some(([key])=>known(snap[key]?.portion)||known(snap[key]?.knownPortionSubtotal))?'Partial recipe nutrition: only ingredients with known amounts and matched sources are included. These are not whole-meal totals. Review the missing ingredients and amounts in Edit.':'Nutrition is not available yet. The recipe still needs ingredient choices, amounts or nutrition sources. Review the printed quantities in Edit.'):'',
      editableNutrients:fields.map(([key,title,unit])=>({key,title,unit,value:p?detail().value(p,key):r.extraction?r.extraction.nutrients?.[key]?.value??null:root.NudgeComposition.intakeNutrient(r.entry||{},key).partial?null:root.NudgeComposition.intakeNutrient(r.entry||{},key).value})),
      nutritionEditBasis:p?'per 100 '+(p.basisUnit||'g'):entry?'per saved portion':meal?'per analysed portion':r.extraction?.basis||'unknown',
      basis:p?.basisUnit||r.extraction?.basis||'',nutritionPreparation:p?.nutritionPreparation||r.extraction?.nutritionPreparation||'unknown',servingSize:r.extraction?.servingSize||null,
      measures:info.options,measureId:p?d.portion.measureId:d.measureId||d.unit,quantity:d.quantity,step:measure?.step||1,
      minimum:p ? .1/(measure?.factor||1):(info.minimum||.1)/(measure?.factor||1),maximum:p?5000/(measure?.factor||1):(info.maximum||5000)/(measure?.factor||1),
      amount:amount||null,amountUnit:d.mealPortion?.unit||(p?d.portion.unit:entry?r.entry?.portionUnit:meal?r.extraction.meal?.portion?.unit:d.unit),
      guidance:p?detail().measures(p).guidance:measure?.description||'Nutrition scales from the printed label basis.',
      recipe:recipe?.applied?{selectedFraction:recipe.selectedFraction||1,servings:recipe.servings||null,userEdited:recipe.userEdited===true,nutrients:fields.map(([key,title,unit])=>{const n=recipeNutrients[key];return {key,title,unit,value:n.value,partial:n.value===null&&n.knownContributions>0,knownSubtotal:n.knownContributions>0?n.knownSubtotal:null};})}:null,
      recipeOptions:recipe?.applied&&!recipe.userEdited&&(!r.entryId||r.editingSavedCalculation===true)?(recipe.recipeOptions||[]).map(o=>({id:o.id,title:o.title,evidence:o.evidence,selected:o.selected===true,side:o.side===true})):[],
      recipeChoices:recipe?.applied&&!recipe.userEdited&&(!r.entryId||r.editingSavedCalculation===true)?(recipe.batchComponents||[]).flatMap(c=>c.recipeChoice?[{id:c.recipeChoice.id,title:c.recipeChoice.title,evidence:c.recipeChoice.evidence,selected:c.recipeChoice.selected||'',options:c.recipeChoice.options.map(o=>({id:o.id,title:o.title}))}]:[]):[],
      isMeal:meal||entry,isComposition:meal&&Array.isArray(r.extraction.meal?.components)&&r.extraction.meal.components.length>0,
      canEditSavedCalculation:entry&&Array.isArray(r.entry?.sourceMeta?.mealComposition)&&r.entry.sourceMeta.mealComposition.length>0,
      isDrink:detail().isDrink({name:d.name}),ingredients:ingredientText,plants,
      plantChoices:r.extraction?.ingredients?.plants?.map((plant,index)=>({index,name:plant.name,selected:plant.selected!==false,supported:analysis().supportedPlant(r.extraction,plant)}))||[],
      components:(r.extraction?.meal?.components||[]).map((c,index)=>({index,name:c.name,amountGrams:c.amountGrams??null,recordId:c.recordId||'',source:c.sourceRecord?[c.sourceRecord.source,c.sourceRecord.code,c.sourceRecord.name].filter(Boolean).join(' · '):'',candidates:[c.sourceRecord,...(c.candidates||[])].filter((x,i,all)=>x&&x.id&&all.findIndex(y=>y?.id===x.id)===i).map(x=>({id:x.id,name:x.name})),estimated:c.amountSource!=='confirmed',
        recipeAmountLabel:positive(c.recipeIngredient?.amount)&&c.recipeIngredient.unit?c.recipeIngredient.amount+' '+c.recipeIngredient.unit:'',
        recipeEvidence:typeof c.recipeIngredient?.evidence==='string'&&c.recipeIngredient.evidence!=='Recipe ingredient could not be linked to the printed text.'?c.recipeIngredient.evidence:'',
        missingAmount:!positive(c.amountGrams),missingSource:!c.recordId||!c.sourceRecord})),
      sources:sourceRows(r,score),
      valid:issues.length===0,errors:issues,confirmationId:r.confirmationId,eventId:r.eventId||'',entryId:r.entryId||'',review:r};
  }
  function record(input,state={},options={}){
    const r=prepare(input,state,options),issues=errors(r,state,options);
    if(issues.length)return {ok:false,error:issues[0],errors:issues};
    const old=oldEntry(r,state),d=r.draft,snap=snapshot(r,state),now=options.now||new Date().toISOString(),eventId=r.eventId||r.id||r.confirmationId;
    let result;
    if(r.kind==='product'){
      const p=r.product,m=detail(),plants=m.plants(p),score=currentScore(r,state,snap);
      result={...old,id:old?.id||r.confirmationId,name:d.name,brand:d.brand||null,barcode:p.barcode||'',day:d.day,slot:d.slot,portions:1,
        portionAmount:d.portion.canonicalAmount,portionUnit:d.portion.unit,plants:plants.names,ferments:old?.ferments||[],recipe:'',
        ingredients:p.ingredients?{text:typeof p.ingredients==='string'?p.ingredients:p.ingredients.text||'',plants:plants.names.map(name=>({name,evidence:plants.evidence.find(x=>x.name===name)?.evidence||name})),needsReview:false}:null,
        energyPerPortion:snap.energyKcal.portion,proteinPerPortion:snap.protein.portion,fibrePerPortion:snap.fibre.portion,nutritionSnapshot:snap,
        nutritionStatus:fields.every(([key])=>known(snap[key]?.portion))?'complete':'incomplete',source:'User-confirmed product portion',
        sourceMeta:{...old?.sourceMeta,provider:p.sourceName||'Product source unavailable',url:p.sourceURL||'',retrievedAt:p.retrievedAt||'',licence:p.licenceName||'',licenceURL:p.licenceURL||'',confirmationId:old?.sourceMeta?.confirmationId||r.confirmationId,
          scanEventId:eventId,productScanEventId:old?.sourceMeta?.productScanEventId||eventId,entryKind:'product-consumption',consumedAt:old?.sourceMeta?.consumedAt||now,
          labelBasis:p.basisUnit==='ml'?'per100ml':p.basisUnit==='g'?'per100g':'unknown',nutritionPreparation:p.nutritionPreparation||'unknown',portionSelection:m.portionRecord(p,d.portion),portionSaltConflict:m.servingConflict(p,d.portion),plantKnowledge:plants.known?'known':'unknown',scoreMethod:score,
          ...(old?.sourceMeta?.scoreMethod?{scoreHistory:[...(old.sourceMeta.scoreHistory||[]),old.sourceMeta.scoreMethod].slice(-12)}:{})}};
    }else if(r.kind==='analysis'){
      const e=r.extraction,a=analysis();
      const draft={...d,confirmationId:r.confirmationId,context:r.context||{},mealBatchVolumeMl:d.batchVolumeMl,portionLabel:'portion',portionSource:'estimated',portionBase:d.amount};
      const selection={measureId:d.measureId||'serving',fraction:d.amount,batchServings:d.batchServings,batchVolumeMl:d.batchVolumeMl,baseAmount:e.meal?.portion?.amount??null,baseUnit:e.meal?.portion?.unit??null};
      result=a.buildRecord({extraction:e,old,amount:d.amount,unit:e.type==='meal'?'portion':d.unit,day:d.day,draft,selection,profile:profile(state),avoidMilk:state.avoidMilk,entries:entries(state),retrievedAt:now});
      if(e.metadata?.localLabel?.version==='local-food-label-v1')result.sourceMeta.localLabelEvidence=clone(e.metadata.localLabel);
      result.day=d.day;result.slot=d.slot;result.sourceMeta.scanEventId=eventId;
      result=a.repairProductRecord(result,old,e,{previousProduct:r.previousProduct,corrections:d.corrections,profile:profile(state),avoidMilk:state.avoidMilk,entries:entries(state)});
    }else{
      result={...clone(r.entry),id:old?.id||r.confirmationId,name:d.name,brand:d.brand||null,day:d.day,slot:d.slot,portions:d.amount,
        sourceMeta:{...r.entry.sourceMeta,confirmationId:old?.sourceMeta?.confirmationId||r.confirmationId,scanEventId:old?.sourceMeta?.scanEventId||eventId,intakePortionSelection:{measureId:d.measureId||'serving',baseVolumeMl:d.batchVolumeMl||null}}};
      if(!old){result.sourceMeta.entryKind='saved-food';delete result.sourceMeta.productScanEventId;delete result.sourceMeta.consumedAt;}
      if(old&&['day','slot','portions'].some(key=>old[key]!==result[key])){
        // Keep the historical nutrition score; an old occasion recommendation
        // must not masquerade as a freshly evaluated diary decision.
        for(const key of ['scoreMethod','mealScore'])if(result.sourceMeta[key])result.sourceMeta[key]={...result.sourceMeta[key],finalFrequency:null,frequencyStatus:'pending',eatingOccasion:null,frequencyPolicy:null};
      }
    }
    if(mealBuilderEligible(r)){
      // Legacy records also wrote empty names before the user made a choice.
      // Only an explicit confirmation may keep an empty list closed on reopen.
      result.sourceMeta.mealIngredientSelection={version:'meal-ingredients-v1',names:tagNames(d.mealIngredients),source:'user',...(d.mealIngredientScope==='includes'?{scope:'includes'}:{}),...(d.mealIngredientsConfirmed===true?{confirmed:true}:{})};
      if(d.mealPortion){
        if(r.kind==='entry'){
          result.portions=1;result.nutritionSnapshot=snap;
          result.energyPerPortion=snap.energyKcal.portion;result.proteinPerPortion=snap.protein.portion;result.fibrePerPortion=snap.fibre.portion;
          if(result.sourceMeta.mealComposition)result.sourceMeta.photoPortions=String((Number(r.entry.sourceMeta?.photoPortions)||1)*d.amount);
        }
        result.portionAmount=d.mealPortion.amount;result.portionUnit=d.mealPortion.unit;
        result.sourceMeta.mealWholePortion=clone(d.mealPortion);
      }
    }
    if(r.kind!=='product'){
      result.plants=reviewPlants(r);
      if(d.plantSelectionConfirmed)result.sourceMeta.plantSelectionConfirmed=true;
      else delete result.sourceMeta.plantSelectionConfirmed;
      if(result.ingredients){
        const evidence=result.ingredients.plants||[],components=root.NudgeComposition.componentPlants(r.extraction?.meal?.components||r.entry?.sourceMeta?.mealComposition)||[];
        result.ingredients={...result.ingredients,plants:result.plants.map(name=>({name,evidence:evidence.find(p=>root.WmdFoodLog.plantNames([p.name])[0]===name)?.evidence||components.find(p=>p.name===name)?.evidence||d.mealIngredients.find(item=>root.WmdFoodLog.ingredientPlants([item])[0]===name)||name}))};
      }
    }
    const image=old?.sourceMeta?.entryThumbnail||r.thumbnail||r.entry?.sourceMeta?.entryThumbnail||root.NudgeProductEvidence.publicProductImage(r.product)||r.entry?.sourceMeta?.repertoireImage||'';
    result.sourceMeta={...result.sourceMeta,...(r.photos?.length?{entryPhotos:r.photos}:{}),...(image?{entryThumbnail:image}:{})};
    const clean=root.WmdFoodLog.clean({entries:[result]}).entries[0];
    if(!clean)return {ok:false,error:'This food could not be prepared for saving. Check its name, date and amount.'};
    return {ok:true,record:clean,entryId:old?.id||null,eventId,extraction:r.extraction||null,product:r.product||null,thumbnail:r.thumbnail||'',review:r};
  }
  const api=Object.freeze({version:VERSION,prepare,update,model,record,ingredientSearch});root.NudgeNativeReview=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window==='object'?window:globalThis);
