// Deterministic product facts and quantities. Display rounding never changes stored intake.
window.NudgeFoodDetailModel = (() => {
  'use strict';
  const version = '1.0.0';
  const keys = ['energyKcal', 'protein', 'fibre', 'fat', 'saturatedFat', 'carbohydrate', 'sugars', 'salt'];
  const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const positive = n => finite(n) && n > 0 && n <= 5000;
  const text = v => typeof v === 'string' ? v.trim() : '';
  const url = v => /^https:\/\//.test(text(v)) ? text(v) : '';
  const sources = Object.freeze({
    peanutPortion: {title:'CUH NHS · peanut butter spoon estimate', url:'https://www.cuh.nhs.uk/patient-information/low-carbohydrate-snack-list/', basis:'Smooth peanut butter: approximately 15 g per tablespoon. Applied as an estimate to identified peanut butter; spoonfuls vary.', checked:'2026-10-02'},
    marmitePortion: {title:'Cambridge MRC · Marmite spoon estimate', url:'https://www.mrc-epid.cam.ac.uk/wp-content/uploads/2023/03/FFQ_portion_sizes.pdf', basis:'UK household-portion reference, line 77: Marmite teaspoon, 9 g. A food-specific estimate, not a manufacturer spoon weight.', version:'FFQ database mapping January 2021', checked:'2026-10-02'},
    marmiteServing: {title:'Marmite UK · original spread serving', url:'https://www.marmite.co.uk/nutrition-information.html', basis:'Original Marmite: manufacturer serving 8 g. The manufacturer does not specify a teaspoon equivalent.', checked:'2026-10-02'},
    ukLabels: {title:'UK front-of-pack nutrient thresholds', url:'https://www.gov.uk/government/publications/front-of-pack-nutrition-labelling-guidance', version:'2016-11-08', checked:'2026-10-02'},
    ukTables: {title:'Scottish Government · food and drink threshold tables', url:'https://www.gov.scot/publications/supporting-healthy-choices-framework-voluntary-action/pages/13/', version:'2014-06-26', checked:'2026-10-02'},
    nhsLabels: {title:'NHS · food labels', url:'https://www.nhs.uk/live-well/eat-well/food-guidelines-and-food-labels/how-to-read-food-labels/', checked:'2026-10-02'}
  });
  const HALF_UK_PINT_ML=284.130625;
  const isDrink=p=>!/(?:powder|flavou?r|oil|sauce|dressing)/i.test(text(p?.name))&&/\b(?:drink|beverage|smoothie|juice|milk|kefir|water|coffee|tea)s?\b/i.test([p?.name,p?.categoryTag,...(Array.isArray(p?.categories)?p.categories:[])].join(' ').replace(/[-_:]/g,' '));
  const volumeSource={title:'Defined volume measures',url:'https://www.legislation.gov.uk/ukpga/1985/72/schedules',basis:'Nudge cup = 250 ml; half UK pint = 284.130625 ml. No mass-to-volume conversion is assumed.'};
  // Factors are fractions of the original analysed portion/batch. A user-measured
  // batch volume allows volume portions without assuming that grams equal ml.
  function mealMeasures(base={},settings={}){
    const amount=positive(base.amount)?base.amount:null,unit=['g','ml'].includes(base.unit)?base.unit:null,servings=positive(settings.servings)&&settings.servings>=1&&settings.servings<=50?settings.servings:1;
    const volume=unit==='ml'?amount:positive(settings.volumeMl)?settings.volumeMl:null;
    const options=[{id:'serving',label:servings===1?'portion':'serving',plural:servings===1?'portions':'servings',factor:1/servings,step:.25,description:servings===1?'One analysed portion':'One of '+servings+' servings in the full batch'}];
    if(servings!==1)options.push({id:'batch',label:'batch',plural:'batches',factor:1,step:.25,description:'The full analysed batch'});
    if(amount&&unit==='g')options.push({id:'g',label:'grams',plural:'grams',factor:1/amount,step:10,description:'Weighed amount from the analysed '+amount+' g portion'});
    if(volume)options.push({id:'ml',label:'millilitres',plural:'millilitres',factor:1/volume,step:25,description:'Measured volume from the '+volume+' ml batch'},{id:'cup',label:'cup (250 ml)',plural:'cups (250 ml each)',factor:250/volume,step:.25,description:'A defined 250 ml cup'},{id:'half-pint',label:'half UK pint (284 ml)',plural:'half UK pints (284 ml each)',factor:HALF_UK_PINT_ML/volume,step:.5,description:'Half UK pint = 284.130625 ml'});
    return {options,servings,volumeMl:volume,maximum:Math.min(8,amount?5000/amount:8,volume?5000/volume:8),minimum:Math.max(.0001,amount ? .1/amount : 0,volume ? .1/volume : 0)};
  }
  const source = p => ({title:text(p.sourceName)||'Product label', url:url(p.sourceURL), retrievedAt:text(p.retrievedAt), basis:'Product/package declaration'});
  const basis = p => ['g','ml'].includes(p?.basisUnit) ? p.basisUnit : null;
  const ingredientText = p => text(p?.ingredients?.text || p?.ingredients);
  const declaredIngredients = p => ingredientText(p).split(/\b(?:may contain|traces? of|made in (?:a |an )?(?:factory|facility|site)|manufactured in|allergy advice|allergen advice)\b/i)[0];
  const exact = n => !n?.relation || ['=','eq'].includes(n.relation);
  const value = (p,key) => finite(p?.nutrients?.[key]?.value) && exact(p.nutrients[key]) && p.nutrients[key].status!=='unknown' ? p.nutrients[key].value : null;
  const peanutButter = p => [p.categoryTag,...(Array.isArray(p.categories)?p.categories:[]),...(Array.isArray(p.categoriesTags)?p.categoriesTags:[])].some(tag=>/(?:^|:)peanut-butters?$/.test(text(tag))) || (!/\b(?:with|filled|bars?|cookies?|biscuits?|bread|cereal|sandwich|flavou?red?)\b/i.test(text(p.name))&&/\bpeanut butter(?:\s+(?:smooth|crunchy|jar|spread|\d+\s*g))*$/i.test(text(p.name)));
  function originalUKMarmite(p) {
    const name=text(p.name).toLowerCase(),brand=text(p.brand).toLowerCase(),categories=[p.categoryTag,...(Array.isArray(p.categories)?p.categories:[])].filter(Boolean).join(' ').toLowerCase();
    const identity=`${name} ${brand} ${categories}`;
    if(!name||!/\bmarmite\b/.test(`${name} ${brand}`)||/\b(?:reduced|low[- ]salt|less[- ]salt|peanut|truffle|xo|extra[- ](?:old|strong)|squeez(?:y|e|able)|crisps?|snacks?|nuts?|cheese|crackers?|biscuits?|popcorn|ale|beer|chocolate|butter|sandwich|with|flavou?red?)\b/.test(identity))return false;
    if(/\b(?:sanitarium|new zealand|south africa|nz marmite)\b/.test(identity))return false;
    const countries=(Array.isArray(p.countriesTags)?p.countriesTags:[]).map(x=>text(x).toLowerCase());
    if(countries.length&&!countries.some(c=>['en:united-kingdom','en:ireland','united kingdom','ireland','gb','uk'].includes(c)))return false;
    // A bare brand name or a specific original yeast-spread name is enough; "Marmite recipe" is not.
    const description=name.replace(/\bmarmite\b/g,'').replace(/\b\d+(?:\.\d+)?\s*(?:kg|g)\b/g,'').replace(/\b(?:original|classic|british|uk|yeast|extract|spread|rich|in|b|vitamins?|jar)\b/g,'').replace(/[\s,./()®™-]/g,'');
    return description==='';
  }
  const units = {
    tablespoon:{label:'tablespoon',plural:'tablespoons',step:.5}, teaspoon:{label:'teaspoon',plural:'teaspoons',step:.5},
    slice:{label:'slice',plural:'slices',step:.5}, square:{label:'square',plural:'squares',step:.5},
    piece:{label:'piece',plural:'pieces',step:.5}, chunk:{label:'chunk',plural:'chunks',step:.5},
    cup:{label:'cup (250 ml)',plural:'cups (250 ml each)',step:.25}, 'half-pint':{label:'half UK pint (284 ml)',plural:'half UK pints (284 ml each)',step:.5},
    pack:{label:'pack',plural:'packs',step:.25}, serving:{label:'serving',plural:'servings',step:.25}
  };
  function household(description) {
    const s=text(description).toLowerCase().replace(/½/g,'0.5').replace(/¼/g,'0.25');
    const m=s.match(/(?:^|\b)(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?\s*(?:(?:level|heaped|small|medium|large|thick|thin|bite[- ]size)\s+)?(tablespoons?|tbsp|teaspoons?|tsp|slices?|squares?|pieces?|chunks?|packs?)\b/);
    if(!m)return null;
    const count=Number(m[1])/(m[2]?Number(m[2]):1);
    const id=/^(?:tbsp|tablespoon)/.test(m[3])?'table'+'spoon':/^(?:tsp|teaspoon)/.test(m[3])?'teaspoon':m[3].replace(/s$/,'');
    return count>0&&Number.isFinite(count)?{id,count,description:text(description)}:null;
  }
  function measures(p={}) {
    const unit=basis(p)||(positive(p.packAmount)&&['g','ml'].includes(p.packUnit)&&p.nutritionPreparation!=='prepared'?p.packUnit:null), options=[];
    // An ingredients-only record can still log an explicitly weighed amount and known plants.
    // This fallback supplies no nutrition denominator and cannot turn unknown nutrients into numbers.
    if(!unit)return {unit:'g',options:[{id:'g',label:'grams',plural:'grams',factor:1,unit:'g',step:1,estimated:false,source:{title:'Weighed amount',url:'',basis:'Direct g entry; nutrition basis unavailable'},guidance:'Enter the amount you weighed. Nutrition remains unavailable.'}],defaultMeasure:'g',defaultAmount:100,startingCanonical:100,startingSource:{title:'Editable starting amount',basis:'100 g fallback; not a known serving'},guidance:'Start at 100 g and adjust the weighed amount. Nutrition is unavailable; named ingredients can still count toward plant variety.'};
    const add=(id,factor,extra={})=>{if(positive(factor)&&!options.some(m=>m.id===id))options.push({id,label:units[id]?.label||unit,plural:units[id]?.plural||unit,factor,unit,step:units[id]?.step||1,estimated:false,source:source(p),guidance:'',...extra});};
    const compatibleServing=p.nutritionPreparation!=='prepared'||p.servingPreparation==='prepared';
    const declaredServing=compatibleServing&&positive(p.servingAmount)&&(!p.servingUnit||p.servingUnit===unit)?p.servingAmount:null;
    const marmite=unit==='g'&&p.nutritionPreparation!=='prepared'&&originalUKMarmite(p);
    const serving=declaredServing||(marmite?8:null),servingSource=declaredServing?source(p):marmite?sources.marmiteServing:source(p);
    const description=text(p.servingDescription)||text(p.servingLabel);
    const h=household(description);
    if(declaredServing&&h)add(h.id,declaredServing/h.count,{guidance:description});
    const suggested=p.servingSuggestion;
    if(compatibleServing&&!declaredServing&&suggested?.source==='label'&&suggested.unit===unit&&positive(suggested.amount)) {
      const sh=household(suggested.label);
      if(sh)add(sh.id,suggested.amount/sh.count,{guidance:text(suggested.label)});
    }
    const deriveSpoon=()=>{
      const spoon=options.find(m=>['tablespoon','teaspoon'].includes(m.id));
      if(!spoon||/\b(?:heaped|heaping|rounded|dessert)\b/i.test(spoon.guidance))return;
      const id=spoon.id==='tablespoon'?'teaspoon':'tablespoon',factor=spoon.factor*(id==='teaspoon'?1/3:3);
      add(id,factor,{estimated:true,source:{...spoon.source,basis:spoon.source.basis+'; counterpart estimated at three teaspoons per tablespoon for this same food'},guidance:'Three level teaspoons per level tablespoon of this food. Spoonfuls vary; weigh for a closer amount.'});
    };
    // Derive from the actual product's spoon weight before consulting fallback references.
    deriveSpoon();
    // Food-specific references never replace a product's own household conversion.
    if(unit==='g'&&peanutButter(p)&&p.nutritionPreparation!=='prepared') {
      if(!options.some(m=>['tablespoon','teaspoon'].includes(m.id)))add('tablespoon',15,{estimated:true,source:sources.peanutPortion,guidance:'Use a level spoon. Spoonfuls vary; weigh it for a closer amount.'});
    }
    if(marmite&&!options.some(m=>['tablespoon','teaspoon'].includes(m.id)))add('teaspoon',9,{estimated:true,source:sources.marmitePortion,guidance:'Approximate household teaspoon of original UK Marmite. Spoonfuls vary; weigh for a closer amount.'});
    deriveSpoon();
    if(unit==='ml'){add('cup',250,{source:volumeSource,guidance:'Nudge uses a 250 ml cup. Measure your own cup if it differs.'});add('half-pint',HALF_UK_PINT_ML,{source:volumeSource,guidance:'Half a UK pint is about 284 ml.'});}
    if(serving)add('serving',serving,{source:servingSource,guidance:declaredServing?description||'The serving stated on the product label.':'The original Marmite UK serving is 8 g; this is separate from the spoon estimate.'});
    const pack=positive(p.packAmount)&&p.packUnit===unit&&(p.nutritionPreparation!=='prepared'||p.packPreparation==='prepared')?p.packAmount:null;
    if(pack)add('pack',pack,{guidance:`A full pack is ${pack} ${unit}; fractions are supported.`});
    add(unit,1,{label:unit==='g'?'grams':'millilitres',plural:unit==='g'?'grams':'millilitres',source:{title:'Weighed or measured amount',url:'',basis:`Direct ${unit} entry`},guidance:unit==='g'?'Enter the amount you weighed.':'Enter the volume you measured.'});
    const halfFlapjack=unit==='g'&&p.nutritionPreparation==='as_sold'&&pack===60&&(/\bflapjack\b/i.test(text(p.name))||p.categoryTag==='en:flapjacks')&&!declaredServing&&!(compatibleServing&&suggested?.source==='label'&&suggested.unit===unit&&positive(suggested.amount));
    const defaultOption=halfFlapjack?options.find(m=>m.id==='pack'):h&&declaredServing?options.find(m=>m.id===h.id):options.find(m=>!['serving','pack','g','ml','cup','half-pint'].includes(m.id))||options.find(m=>m.id==='serving');
    const labelSuggestionAmount=compatibleServing&&suggested?.source==='label'&&suggested.unit===unit&&positive(suggested.amount)?suggested.amount:null;
    const estimatedSuggestion=compatibleServing&&suggested?.source==='estimated'&&suggested.unit===unit&&positive(suggested.amount)?suggested.amount:null;
    const startingCanonical=declaredServing||labelSuggestionAmount||serving||(halfFlapjack?pack/2:defaultOption?.factor)||estimatedSuggestion||(unit==='ml'&&isDrink(p)?250:100);
    const fractionalSpoon=serving&&defaultOption&&['tablespoon','teaspoon'].includes(defaultOption.id)&&Math.abs(startingCanonical/defaultOption.factor-Math.round(startingCanonical/defaultOption.factor))>1e-9;
    const defaultMeasure=fractionalSpoon&&!(h&&declaredServing)?'serving':defaultOption?.id||(!declaredServing&&!labelSuggestionAmount&&!serving&&!estimatedSuggestion&&unit==='ml'&&isDrink(p)?'cup':unit);
    const option=options.find(m=>m.id===defaultMeasure);
    return {unit,options,defaultMeasure,defaultAmount:startingCanonical===null?null:startingCanonical/option.factor,startingCanonical,
      startingSource:halfFlapjack?{...source(p),basis:'Nudge starting option: half of the declared 60 g pack; not a manufacturer serving or medical limit'}:declaredServing?{...servingSource,basis:'Manufacturer serving in the source record'}:labelSuggestionAmount?{...source(p),basis:'Label serving in the source record'}:serving?servingSource:defaultOption?option.source:estimatedSuggestion?{...source(p),basis:'Editable estimate from the food source; not a label serving'}:{title:'Editable starting amount',url:'',basis:startingCanonical+' '+unit+' fallback; not a known serving'},
      guidance:halfFlapjack?'Start with half a pack; adjust to what you eat. This is a starting option, not a label serving.':startingCanonical?serving?'Starting amount from the product’s stated serving; adjust to what you eat.':estimatedSuggestion?'Suggested starting amount; adjust to what you eat.':defaultOption?'A food-specific starting estimate; adjust to what you eat.':'Editable starting amount, not a known serving; adjust to what you eat.':'No supported serving weight. Enter weighed grams or measured ml.'};
  }
  function createPortion(p,saved) {
    const m=measures(p);
    if(saved&&positive(saved.canonicalAmount)&&saved.unit===m.unit) {
      const id=m.options.some(x=>x.id===saved.measureId)?saved.measureId:m.unit;
      // Persist the historical conversion when its source and unit are available.
      const historical=saved.conversion&&positive(saved.conversion.factor)&&saved.conversion.unit===m.unit&&text(saved.conversion.id)===id&&text(saved.conversion.source?.title)?JSON.parse(JSON.stringify(saved.conversion)):null;
      return {measureId:id,canonicalAmount:saved.canonicalAmount,unit:m.unit,...(historical?{conversion:historical}:{})};
    }
    return {measureId:m.defaultMeasure,canonicalAmount:m.startingCanonical,unit:m.unit};
  }
  const selectedMeasure=(p,s)=>s?.conversion&&s.conversion.id===s.measureId?s.conversion:measures(p).options.find(m=>m.id===s?.measureId)||null;
  function valid(p,s) {return positive(s?.canonicalAmount)&&s.unit===measures(p).unit&&Boolean(selectedMeasure(p,s));}
  function quantity(p,s) {const m=selectedMeasure(p,s);return m&&positive(s?.canonicalAmount)?s.canonicalAmount/m.factor:null;}
  function switchMeasure(p,s,id) {return measures(p).options.some(m=>m.id===id)?{measureId:id,canonicalAmount:s.canonicalAmount,unit:s.unit}:s;}
  function setAmount(p,s,input) {
    if(typeof input==='string'&&!/^\s*(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(input))return null;
    const amount=typeof input==='number'?input:Number(input),m=selectedMeasure(p,s),canonical=m?amount*m.factor:null;
    return positive(amount)&&positive(canonical)?{...s,canonicalAmount:canonical}:null;
  }
  function servingConflict(p,s) {
    if(p.portionSaltConflict===true)return true;
    if(p.confirmedPortion||!valid(p,s)||!positive(p.servingAmount)||p.servingUnit!==s.unit||basis(p)!==s.unit)return false;
    const n=p.servingNutrients?.salt,per100=value(p,'salt');
    if(!finite(n?.value)||n.status!=='supplied'||!exact(n)||per100===null)return false;
    // Allow only the possible rounding interval implied by each displayed decimal.
    const halfUnit=x=>{const [base,exponent='0']=String(x).toLowerCase().split('e'),decimals=(base.split('.')[1]||'').length;return .5*10**(Number(exponent)-decimals);};
    const scaled=per100*p.servingAmount/100,tolerance=halfUnit(per100)*p.servingAmount/100+halfUnit(n.value)+Number.EPSILON*Math.max(1,scaled,n.value)*16;
    return Math.abs(scaled-n.value)>tolerance;
  }
  function portionNutrients(p,s) {
    const declared=p.servingNutrients,source=p.servingNutrientSource,confirmed=p.confirmedPortion;
    if(confirmed&&valid(p,s)&&positive(confirmed.amount)&&confirmed.unit===s.unit)return Object.fromEntries(keys.map(key=>[key,finite(confirmed.nutrients?.[key])?confirmed.nutrients[key]*s.canonicalAmount/confirmed.amount:null]));
    const compatible=valid(p,s)&&positive(p.servingAmount)&&p.servingUnit===s.unit&&source?.title&&(/^https:\/\//.test(source.url||'')||source.kind==='printed_per_serving')&&(p.nutritionPreparation!=='prepared'||p.servingPreparation==='prepared');
    return Object.fromEntries(keys.map(key=>{const n=declared?.[key];const explicit=compatible&&finite(n?.value)&&n.status==='supplied'&&exact(n)&&n.unit===(key==='energyKcal'?'kcal':'g');
      return [key,explicit?n.value*s.canonicalAmount/p.servingAmount:valid(p,s)&&basis(p)===s.unit&&value(p,key)!==null?value(p,key)*s.canonicalAmount/100:null];}));
  }
  function portionRecord(p,s) {
    if(!valid(p,s))return null;
    return {version:1,canonicalAmount:s.canonicalAmount,unit:s.unit,measureId:s.measureId,quantity:quantity(p,s),conversion:JSON.parse(JSON.stringify(selectedMeasure(p,s)))};
  }
  const plantWords={peanut:'peanuts?',almond:'almonds?',cashew:'cashews?',hazelnut:'hazelnuts?',walnut:'walnuts?',pecan:'pecans?',pistachio:'pistachios?',brazilnut:'brazil nuts?',macadamia:'macadamias?',oats:'oats?',wheat:'wheat',rice:'rice',barley:'barley',rye:'rye',quinoa:'quinoa',buckwheat:'buckwheat',maize:'maize|corn',chickpea:'chickpeas?',lentil:'lentils?',soybean:'soybeans?|soya|soy',pea:'peas?',bean:'(?:kidney|black|white|cannellini|haricot) beans?',tomato:'tomatoes?|tomato',carrot:'carrots?',potato:'potatoes?|potato',onion:'onions?',garlic:'garlic',spinach:'spinach',broccoli:'broccoli',cucumber:'cucumbers?',courgette:'courgettes?',aubergine:'aubergines?',pepper:'bell peppers?|red peppers?|green peppers?|yellow peppers?',avocado:'avocados?',apple:'apples?',pear:'pears?',banana:'bananas?',orange:'oranges?',lemon:'lemons?',lime:'limes?',strawberry:'strawberr(?:y|ies)',blueberry:'blueberr(?:y|ies)',raspberry:'raspberr(?:y|ies)',blackberry:'blackberr(?:y|ies)',grape:'grapes?|sultanas?|raisins?',apricot:'apricots?',cranberry:'cranberr(?:y|ies)',date:'dates?',fig:'figs?',coconut:'coconuts?',cocoa:'cocoa|cacao',sesame:'sesame',sunflower:'sunflower seeds?',pumpkin:'pumpkin seeds?',chia:'chia',flax:'flaxseeds?|linseeds?',parsley:'parsley',basil:'basil',coriander:'coriander',mint:'mint',rosemary:'rosemary',thyme:'thyme',ginger:'ginger',turmeric:'turmeric',cinnamon:'cinnamon'};
  const canonical=list=>window.WmdFoodLog?.names?window.WmdFoodLog.names(list,Infinity):[...new Set(list.map(s=>text(s).toLowerCase()))];
  function plants(p={}) {
    // Only the controller constructs this override from a confirmed diary record.
    // Reopening/editing must retain the user's reviewed set, including exclusions.
    if(p.reviewedPlants?.source==='confirmed-diary'&&Array.isArray(p.reviewedPlants.names)) {
      const names=canonical(p.reviewedPlants.names.filter(n=>typeof n==='string').slice(0,40));
      const recorded=Array.isArray(p.reviewedPlants.evidence)?p.reviewedPlants.evidence:[];
      const evidence=names.map(name=>({name,evidence:text(recorded.find(e=>canonical([e?.name])[0]===name)?.evidence).slice(0,160)||'User-confirmed diary plant'}));
      return {names,known:p.reviewedPlants.known===true,evidence,policy:'nudge-named-plants-v1',note:'Your confirmed named plants. Each type counts once per week.'};
    }
    const declared=declaredIngredients(p),evidence=[];
    const input=declared||(Array.isArray(p.ingredientItems)?p.ingredientItems.map(i=>text(i?.text)).filter(Boolean).join(', '):'');
    // Label/extraction plant objects must include supporting ingredient text.
    const reviewed=Array.isArray(p.ingredients?.plants)?p.ingredients.plants:Array.isArray(p.ingredientPlants)?p.ingredientPlants:[];
    for(const item of reviewed)if(text(item.name)&&text(item.evidence)&&declared.toLowerCase().includes(text(item.evidence).toLowerCase()))evidence.push({name:item.name,evidence:item.evidence});
    for(const segment of input.split(/[,;()]/)) {
      // Refined oils, sugars, starches and advisory traces are not counted as named plant foods.
      if(/\b(?:oil|sugar|syrup|starch|lecithin|flavouring|flavoring|extract)\b/i.test(segment))continue;
      for(const [name,pattern] of Object.entries(plantWords)) {
        const match=segment.match(new RegExp('\\b(?:'+pattern+')\\b','i'));
        if(match)evidence.push({name,evidence:match[0]});
      }
    }
    const names=canonical(evidence.map(e=>e.name));
    const assessed=input.split(/[,;()]/).every(segment=>!/[a-z]/i.test(segment)||evidence.some(e=>segment.toLowerCase().includes(text(e.evidence).toLowerCase()))||/\b(?:water|salt|milk|whey|cream|butter|cheese|yogh?urt|eggs?|fish|salmon|cod|tuna|chicken|beef|pork|lamb|sugar|syrup|oil|starch|lecithin|gelatine|gelatin|raising agent|emulsifier|preservative|antioxidant|acidity regulator|e\d{3,4})\b/i.test(segment));
    const known=Boolean(declared)&&assessed&&p.ingredientsNeedsReview!==true&&p.ingredients?.needsReview!==true&&!/\b(?:mixed (?:nuts|seeds|vegetables|berries|fruit)|vegetable blend|herb blend|spice blend|ingredients? (?:unavailable|unknown))\b/i.test(declared);
    return {names,known,evidence:evidence.filter((e,i,a)=>a.findIndex(x=>canonical([x.name])[0]===canonical([e.name])[0])===i),policy:'nudge-named-plants-v1',note:'Distinct named plant foods; repeats count once per week. Refined oils, sugars and starches do not add a plant type.'};
  }
  function projection(state,day,p,s,options={}) {
    const log=window.WmdFoodLog?.clean?window.WmdFoodLog.clean(state.foodLog):{entries:[],plantGoal:null};
    const entries=log.entries.filter(e=>e.id!==(options.entryId||options.excludeEntryId));
    const current=entries.filter(e=>e.day===day), nutrients=portionNutrients(p,s),profile=state.nutritionProfile||{};
    const metric=(field,key,target)=>{
      const known=current.filter(e=>finite(e[field]));
      const logged=current.length&&!known.length?null:known.reduce((sum,e)=>sum+e[field]*e.portions,0);
      return {logged,portion:nutrients[key],total:logged!==null&&nutrients[key]!==null?logged+nutrients[key]:null,target:finite(target)&&target>0?target:null,unknownEntries:current.length-known.length};
    };
    const math=window.WmdStreakMath,dayNumber=math?.dayNumber(day),weekday=new Date(day+'T12:00:00Z').getUTCDay();
    const firstNumber=dayNumber!==null&&dayNumber!==undefined?dayNumber-(weekday+6)%7:null;
    const first=firstNumber!==null?math.dayKey(firstNumber):day,last=firstNumber!==null?math.dayKey(firstNumber+6):day;
    const asOfDay=typeof options.asOfDay==='string'&&math?.dayNumber(options.asOfDay)!==null?options.asOfDay:day;
    const week=entries.filter(e=>e.day>=first&&e.day<=last&&e.day<=asOfDay),before=canonical(week.flatMap(e=>e.plants||[])),inFood=plants(p),newNames=inFood.names.filter(n=>!before.includes(n));
    const unknownWeekEntries=week.filter(e=>e.sourceMeta?.plantKnowledge==='unknown'||e.ingredients?.needsReview===true).length;
    return {protein:metric('proteinPerPortion','protein',window.NudgeNutrition?.target(profile).grams),energy:metric('energyPerPortion','energyKcal',window.NudgeNutrition?.calories(profile).kcal),fibre:metric('fibrePerPortion','fibre',window.NudgeNutrition?.clean(profile).fibreTarget),
      weekly:{logged:before.length,portion:inFood.names.length,newNames,total:canonical([...before,...inFood.names]).length,target:log.plantGoal,known:inFood.known&&!unknownWeekEntries,portionKnown:inFood.known,unknownEntries:unknownWeekEntries,plants:inFood.names,weekStart:first,weekEnd:last}};
  }
  const scoreMethod=window.NudgeScoreCore?.CONFIG.methodId||'nudge_nutrition_v0_3',scoreVersion=window.NudgeScoreCore?.CONFIG.version||'0.3';
  const scoreGrade=v=>/^[a-e]$/i.test(text(v))?text(v).toUpperCase():null;
  // A deliberately small public-product allowlist: no photos, account data, diary or portion selections.
  function scoreFacts(p={}) {
    p=p||{};
    const bounded=(v,n=8000)=>text(v).slice(0,n),strings=v=>Array.isArray(v)?v.filter(x=>typeof x==='string').slice(0,100).map(x=>bounded(x,160)):[];
    // Label adapters retain "extracted" for review/persistence. The calculator
    // accepts supplied facts: translate only declared photo-label quantities,
    // keeping their source and inequality and leaving estimates ineligible.
    const labelSource=/^Photo label extraction(?: \+ stored Open Food Facts)?$/.test(text(p.sourceName));
    const declaredPhotoNutrient=(key)=>{
      const source=text(p.nutrientSources?.[key]),unit=basis(p);
      const printed=key==='energyKcal'?'(?:kcal|kJ)':key==='energyKj'?'kJ':'(?:g|mg)';
      return labelSource&&['g','ml'].includes(unit)&&new RegExp('^Photo label extraction: printed '+printed+' (?:per 100 '+unit+'|per labelled serving, normalised to 100 '+unit+')$').test(source);
    };
    const nutrient=(n,unit,key)=>{const known=finite(n?.value)&&n.status!=='unknown'&&(!text(n.unit)||n.unit===unit);const status=n?.status==='extracted'&&declaredPhotoNutrient(key)?'supplied':bounded(n?.status,32)||'supplied';return {value:known?n.value:null,unit,status:known?status:'unknown',...(text(n?.relation)?{relation:bounded(n.relation,8)}:{})};};
    const f={};
    for(const key of ['name','brand','barcode','categoryTag','sourceName','sourceURL','nutritionDataSource'])f[key]=bounded(p[key],key==='sourceURL'?1000:key==='name'?240:key==='brand'?160:200);
    f.unresolvedFields=[...new Set([...(Array.isArray(p.unresolvedFields)?p.unresolvedFields:[]),...(Array.isArray(p.metadata?.conflicts)?p.metadata.conflicts.map(c=>c?.field):[])].filter(v=>['identity','nutrition','preparation','ingredients','claims','allergens','other'].includes(v)))].sort();
    f.basisUnit=basis(p);f.nutritionPreparation=['as_sold','prepared'].includes(p.nutritionPreparation)?p.nutritionPreparation:'unknown';
    f.categories=[...new Set([...strings(p.categories),...strings(p.categoriesTags)])].sort().slice(0,60);f.countriesTags=strings(p.countriesTags).sort().slice(0,60);f.ingredients=bounded(ingredientText(p));f.ingredientsNeedsReview=typeof p.ingredientsNeedsReview==='boolean'?p.ingredientsNeedsReview:typeof p.ingredients?.needsReview==='boolean'?p.ingredients.needsReview:null;
    f.ingredientItems=Array.isArray(p.ingredientItems)?p.ingredientItems.slice(0,160).map(i=>({id:bounded(i?.id,160),text:bounded(i?.text,500),percent:finite(i?.percent)&&i.percent<=100?i.percent:null})):[];
    f.nutrients=Object.fromEntries(keys.map(k=>[k,nutrient(p.nutrients?.[k],k==='energyKcal'?'kcal':'g',k)]));f.energyKj=nutrient(p.energyKj,'kJ','energyKj');
    const facts=p.scoringFacts||{},percent=facts.fvlPercent;
    f.scoringFacts={fvlPercent:finite(percent?.value)&&percent.value<=100&&['declared','provider-2023'].includes(percent.source)&&text(percent.evidence)?{value:percent.value,source:percent.source,evidence:bounded(percent.evidence,1000)}:null};
    for(const key of ['isBeverage','isCheese','isWater','isFatOilNutsSeeds','isRedMeatProduct','hasNonNutritiveSweeteners'])f.scoringFacts[key]=typeof facts[key]==='boolean'?facts[key]:null;
    f.scoringFacts.source=bounded(facts.source,400);
    f.nutrientSources=Object.fromEntries([...keys,'energyKj'].flatMap(k=>text(p.nutrientSources?.[k])?[[k,bounded(p.nutrientSources[k],400)]]:[]));
    // This is a source-bound result, not a bare provider letter. The shared
    // core checks its version, calculation and original facts fingerprint.
    // Never rebind it here: editing label facts must invalidate the old result.
    if(p.providerNutriScore&&typeof p.providerNutriScore==='object')f.providerNutriScore=p.providerNutriScore;
    return f;
  }
  function fingerprintFacts(facts) {
    if(window.NudgeScoreCore?.CONFIG.status==='nudge_directional')return window.NudgeScoreCore.inputFingerprint(facts);
    // Cache identity only, not an authentication or security hash. Two lanes plus length avoid accidental collisions.
    const s=JSON.stringify(facts);let a=2166136261,b=2246822519;
    for(let i=0;i<s.length;i++){a=Math.imul(a^s.charCodeAt(i),16777619);b=Math.imul(b^s.charCodeAt(i),3266489917);}
    return scoreMethod+':'+scoreVersion+':'+(window.NudgeScoreCore?.CLASSIFIER_VERSION||'category-legacy')+':'+s.length+':'+(a>>>0).toString(16)+(b>>>0).toString(16);
  }
  function scoreFingerprint(p){return fingerprintFacts(scoreFacts(p));}
  function validScoreResult(result) {
    if(!result||result.methodId!==scoreMethod||result.version!==scoreVersion||!['rated','provisional','estimated','estimated_provisional','unrated'].includes(result.status))return false;
    if(result.status==='unrated')return result.value==null&&result.grade==null&&result.rawScore==null&&result.rawLower==null&&result.rawUpper==null&&result.displayLower==null&&result.displayUpper==null;
    return Boolean(window.NudgeScoreCore?.validResult(result));
  }
  function cachedScoreFromFacts(p,facts) {
    const c=p.scoreResult;
    const held=c?.catalogueValidated===true&&isCatalogueQualityHold(c.result,p);
    if(c?.result?.catalogueQualityHold&&!held)return null;
    if(c?.catalogueValidated===true&&!held&&(!Number.isFinite(c.catalogueExpiresAt)||c.catalogueExpiresAt<=Date.now()))return null;
    if(catalogueEvidenceExpiry(c?.result)<=Date.now())return null;
    return c?.methodId===scoreMethod&&c.version===scoreVersion&&c.inputFingerprint===fingerprintFacts(facts||scoreFacts(p))&&validScoreResult(c.result)?c.result:null;
  }
  function cachedScore(p={}){return cachedScoreFromFacts(p);}
  // Accepted only inside a native-validated catalogue cache. A raw request or
  // ordinary recovery result cannot grant itself authority over source facts.
  function isCatalogueQualityHold(result,p={}) {
    const h=result?.catalogueQualityHold,hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(v);
    return Boolean(h&&h.version==='catalogue-quality-hold-v1'&&h.barcode===p.barcode&&/^[0-9]{4,18}$/.test(h.barcode)
      &&hash(h.sourceFingerprint)&&h.sourceFingerprint===p.catalogueSourceFingerprint&&hash(h.candidateSHA256)&&id(h.runID)&&id(h.reviewID)
      &&Number.isSafeInteger(h.sourceFetchedAt)&&h.sourceFetchedAt>0&&Number.isSafeInteger(h.reviewedAt)&&h.reviewedAt>=h.sourceFetchedAt&&h.reviewedAt<=Date.now()+60000
      &&['source_salt_sodium_conflict','source_alcohol_not_represented','source_identity_conflict'].includes(h.reasonCode)
      &&result.status==='unrated'&&result.available===false&&result.scoreBasis==='catalogue_quality_hold'
      &&result.reasonCodes?.includes('catalogue_quality_hold')&&result.classifierVersion===window.NudgeScoreCore?.CLASSIFIER_VERSION&&validScoreResult(result));
  }
  function isCatalogueQualityCheck(result,p={}) {
    return Boolean(result?.catalogueCheckRequired===true&&result.catalogueCheckBarcode===p.barcode
      &&result.scoreBasis==='catalogue_quality_check'&&result.status==='unrated'&&result.available===false&&validScoreResult(result));
  }
  function catalogueEvidenceExpiry(score) {
    if(!score||!Object.hasOwn(score,'catalogueEnrichment'))return Infinity;
    const e=score.catalogueEnrichment;
    return e&&e.version==='catalogue-enrichment-v1'&&typeof e.sourceFingerprint==='string'&&/^[a-f0-9]{64}$/.test(e.sourceFingerprint)
      &&Number.isSafeInteger(e.expiresAt)&&e.expiresAt>0?e.expiresAt:0;
  }
  function calculatedScoreFromFacts(p,facts){return window.NudgeScoreCore?.calculateScore({...facts,sourceKind:p.sourceKind,type:p.type,retrievedAt:p.retrievedAt,sourceVersion:p.sourceVersion})||null;}
  function calculatedScore(p={}) {p=p||{};return calculatedScoreFromFacts(p,scoreFacts(p));}
  function score(p={}) {
    p=p||{};
    const facts=scoreFacts(p),core=window.NudgeScoreCore;
    const base={status:'unrated',value:null,grade:null,rawScore:null,rawLower:null,rawUpper:null,displayLower:null,displayUpper:null,band:null,label:'More label data needed',reason:'A score needs enough verified product information.',explanation:'The proposed Nudge beta method uses the updated 2023 nutrient model.',methodId:scoreMethod,version:scoreVersion,methodStatus:'proposed_beta',baseAlgorithmVersion:'2023',calculationBasis:{unit:basis(p),per:100,preparation:text(p.nutritionPreparation)||'unknown'},components:[],weights:null,deductions:[],caps:[],providerGrade:null,breakdownAvailable:false,inputs:facts,sources:[source(p)],missingInputs:[],limits:['Proposed beta; not clinically validated.','Portion and allergy needs remain separate.','The fixed grade mapping is a proposed Nudge display.']};
    if(!core)return base;
    const cached=cachedScoreFromFacts(p,facts);
    if(p.scoreResult?.catalogueValidated===true&&isCatalogueQualityHold(cached,p))return {...base,...cached,components:[],breakdownAvailable:false};
    if(isCatalogueQualityCheck(cached,p))return {...base,...cached,components:[],breakdownAvailable:false};
    // A validated OFF calculation takes priority; a bare letter is insufficient.
    // Every screen uses this same versioned result and standard calculation.
    const local=calculatedScoreFromFacts(p,facts);
    const detailed=cached&&(local.status==='unrated'||p.scoreResult?.catalogueValidated===true)?cached:local;
    const recovery=cached?p.scoreResult?.recovery:null;
    const recoverySources=[...(Array.isArray(recovery?.provenance)?recovery.provenance:[]),...(recovery?.estimate?.sourceRecord?[recovery.estimate.sourceRecord]:[])].filter(s=>url(s?.url||s?.sourceURL)).map(s=>({title:text(s.title||s.source||s.provider||s.name)||'Recovered product evidence',url:url(s.url||s.sourceURL),retrievedAt:text(s.retrievedAt)}));
    const recovered=recovery?.estimate?.score;
    const sourcedEstimate=recovered?.estimated===true&&core.validResult(recovered)?recovered:null;
    const fallback=detailed.status==='unrated'?(sourcedEstimate||window.NudgeMealScore?.calculateProductEstimate?.({...p,...facts})):null;
    if(fallback?.available&&core.validResult(fallback)){
      const hasCalculation=core.validResult(fallback),parts=fallback.components||{};
      const components=hasCalculation?['negative','positive'].flatMap(kind=>(parts[kind]||[]).map(c=>({...c,kind,rawPoints:c.points,points:c.counted===false?0:c.points}))):[];
      return {...base,...fallback,components,breakdownAvailable:hasCalculation,providerGrade:null,sources:[source(p),...(fallback.sources||[]),...recoverySources],inputs:fallback.inputs||facts};
    }
    const result=detailed;
    const lists=result.components||{negative:[],positive:[]};
    const components=['negative','positive'].flatMap(kind=>(lists[kind]||[]).map(c=>({...c,kind,rawPoints:c.points,points:c.counted===false?0:c.points})));
    const scoreSources=Array.isArray(result.sources)?result.sources.filter(s=>url(s?.url)).map(s=>({title:text(s.title),url:url(s.url)})):[];
    return {...base,...result,label:result.status==='unrated'?'More label data needed':core.CONFIG.status==='nudge_directional'?'Nudge score':'Nudge nutrition score',components,breakdownAvailable:result.status!=='unrated',sources:[source(p),...scoreSources,...recoverySources],providerGrade:null};
  }
  const array=v=>Array.isArray(v)?v.filter(x=>typeof x==='string').map(text).filter(Boolean):[];
  const unique=a=>[...new Set(a.filter(Boolean))];
  function allergies(p={},profile={},options={}) {
    const allText=[ingredientText(p),text(p.allergensText),text(p.tracesText),text(p.manufacturingAdvice)].filter(Boolean).join('. ');
    const factory=/[^.!?]*(?:\b(?:factory|facility|site|equipment)\b[^.!?]*\b(?:handles?|processes?|nuts?|allergens?|milk|wheat|gluten|peanuts?|soya|soy|sesame)\b)[^.!?]*/gi;
    const manufacturing=unique((allText.match(factory)||[]).map(text));
    const mayText=allText.replace(factory,'').match(/\b(?:may contain|traces? of)\b[^.!?;]*/gi)||[];
    const traces=unique([...array(p.traces).filter(s=>{
      if(/(?:factory|facility|site|equipment)/i.test(s))return false;
      const tag=s.replace(/^[a-z]{2}:/i,'').replace(/-/g,' ').toLowerCase();
      // OFF cross-contact tags can originate from factory advice; keep that exact category.
      return !manufacturing.some(advice=>advice.toLowerCase().includes(tag))||mayText.some(advice=>advice.toLowerCase().includes(tag));
    }),...mayText.map(text)]);
    const contains=unique([...array(p.allergens),...text(p.allergensText).split(/[;,]/)].filter(s=>text(s)&&!/(?:may contain|traces? of|factory|facility|site|equipment)/i.test(s)).map(text));
    const declared=declaredIngredients(p);
    const allergens={milk:/\b(?:milk|dairy(?![- ]free)|whey|casein|cream|butter|cheese|yogh?urt)\b/i,fish:/\b(?:fish|salmon|tuna|cod|haddock|anchov(?:y|ies)|sardines?)\b/i,nuts:/\b(?:peanuts?|nuts?|almonds?|cashews?|hazelnuts?|walnuts?|pecans?|pistachios?|macadamias?)\b/i,gluten:/\b(?:gluten|wheat|barley|rye|spelt)\b/i,eggs:/\beggs?\b/i,sesame:/\bsesame\b/i,soy:/\b(?:soy|soya|soybeans?)\b/i};
    // "Peanut butter" is not evidence of milk; ingredient names are considered as phrases.
    const containsText=[...contains,declared.replace(/\bgluten[- ]free\b/gi,'').replace(/\b(?:peanut|almond|cashew|cocoa|cacao|nut|shea) butter\b/gi,m=>m.replace(/butter/i,'')).replace(/\b(?:almond|coconut|cashew|oat|soy|soya|rice|hazelnut|hemp) milk\b/gi,m=>m.replace(/milk/i,''))].join('; ');
    // Keep identified allergens visible even when a provider omitted its dedicated allergen array.
    const identified=Object.entries(allergens).flatMap(([name,pattern])=>{const match=containsText.match(pattern);return match&&!contains.some(s=>pattern.test(s))?[match[0]]:[];});
    const requirement=window.NudgeNutrition?.safetyProfile?.(profile)||profile;
    const avoids=unique([...array(requirement.avoids),...array(requirement.allergies),...(['coeliac','sensitivity'].includes(requirement.glutenRequirement)||requirement.glutenFreePreference?['gluten']:[]),...(options.avoidMilk?['milk']:[])]);
    const conflicts=[];
    for(const preference of avoids) {
      const pattern=allergens[preference];if(!pattern)continue;
      if(pattern.test(containsText))conflicts.push({preference,type:'contains',text:`Contains ${preference} · conflicts with your saved requirements.`});
      if(traces.some(s=>pattern.test(s)))conflicts.push({preference,type:'mayContain',text:`May contain ${preference} · check your saved requirements and the current pack.`});
      if(manufacturing.some(s=>pattern.test(s)))conflicts.push({preference,type:'manufacturing',text:`Manufacturing advice mentions ${preference} · check the current pack.`});
    }
    const diet=profile.diet;
    if(diet==='pescatarian'&&/\b(?:chicken|beef|pork|lamb|bacon|turkey|duck|venison|gelatine|gelatin)\b/i.test(containsText))conflicts.push({preference:diet,type:'diet',text:'Ingredients conflict with your saved pescatarian requirement.'});
    if(['vegan','vegetarian'].includes(diet)&&/\b(?:fish|salmon|tuna|cod|chicken|beef|pork|lamb|bacon|gelatine|gelatin)\b/i.test(containsText))conflicts.push({preference:diet,type:'diet',text:'Ingredients conflict with your saved dietary requirements.'});
    if(diet==='vegan'&&/\b(?:milk|whey|casein|cream|cheese|yogh?urt|eggs?|honey)\b/i.test(containsText))conflicts.push({preference:'vegan',type:'diet',text:'Ingredients conflict with your saved vegan preference.'});
    const incomplete=p.ingredientsNeedsReview===true||p.ingredients?.needsReview===true
      ||array(p.metadata?.missingFields).some(field=>['allergens','ingredients'].includes(field));
    return {contains:unique([...contains,...identified]),traces,manufacturing,containsText:text(p.allergensText).replace(factory,'').replace(/\b(?:may contain|traces? of)\b[^.!?;]*/gi,'').trim(),mayContainText:mayText.join('; '),conflicts,conflict:conflicts.length>0,warning:conflicts[0]?.text||'',unknown:incomplete||!contains.length&&!declared,advice:'Check the current pack; a barcode cannot establish allergy safety.'};
  }
  // UK 2016 traffic-light thresholds: LOW <= first, HIGH > second. Energy is not colour-coded.
  const thresholds={food:{fat:[3,17.5,21],saturatedFat:[1.5,5,6],sugars:[5,22.5,27],salt:[.3,1.5,1.8]},drink:{fat:[1.5,8.75,10.5],saturatedFat:[.75,2.5,3],sugars:[2.5,11.25,13.5],salt:[.3,.75,.9]}};
  function classificationContext(p) {
    const unit=basis(p),categories=[p.categoryTag,...array(p.categoriesTags),...array(p.categories)].filter(Boolean).join(' ').toLowerCase();
    const isDrink=/\b(?:beverages|drinks|juices|waters|sodas|soft-drinks|milk-drinks|plant-based-drinks)\b/.test(categories)||p.foodCategory==='drink';
    const preparation=text(p.nutritionPreparation)||'unknown';
    if(!['as_sold','prepared'].includes(preparation))return {kind:null,reason:'Preparation basis is unknown; nutrient flags are not assigned.'};
    if(/\b(?:infant|baby-foods|supplements|meal-replacements)\b/.test(categories))return {kind:null,reason:'These general UK thresholds are not applied to this specialist product category.'};
    if(isDrink&&unit==='ml')return {kind:'drink',unit:'ml',preparation,reason:''};
    if(!isDrink&&unit==='g')return {kind:'food',unit:'g',preparation,reason:''};
    return {kind:null,reason:isDrink?'The drink needs a per-100-ml basis; density conversion is unavailable.':'A liquid is not necessarily a drink. Food category or supported density conversion is missing.'};
  }
  function risks(p={},s) {
    const context=classificationContext(p),portion=portionNutrients(p,s),fields={fat:'Total fat',saturatedFat:'Saturated fat',sugars:'Total sugars',salt:'Salt'};
    const flags=Object.entries(fields).map(([key,label])=>{
      const per100=value(p,key),levels=context.kind?thresholds[context.kind][key]:null;
      const classification=per100===null||!levels?null:per100<=levels[0]?'low':per100>levels[1]?'high':'medium';
      // The selected amount is shown separately; changing a portion never changes per-100 classification.
      const portionHigh=levels&&valid(p,s)&&s.canonicalAmount>(context.kind==='drink'?150:100)&&portion[key]!==null?portion[key]>levels[2]:null;
      return {key,label,per100,portion:portion[key],classification,portionHigh,basis:`per 100 ${basis(p)||'unknown'}`,preparation:context.preparation||text(p.nutritionPreparation)||'unknown',method:'uk-fop-2016',thresholds:levels?{low:levels[0],high:levels[1],portionHigh:levels[2]}:null,source:sources.ukLabels,reason:per100===null?'Source amount unavailable':context.reason};
    });
    return {flags,context,energy:{per100:value(p,'energyKcal'),portion:portion.energyKcal,basis:`per 100 ${basis(p)||'unknown'}`,classification:null,note:'Energy has no red/amber/green threshold in the UK front-of-pack scheme; compare the amount with your portion and targets.'},
      testing:{status:'unknown',label:'No product test data',note:'No applicable product or batch test results are supplied for pesticides, heavy metals or microplastics.'},
      source:sources.ukLabels,market:'UK reference thresholds',note:'Per-100 nutrient classifications describe the declared product basis. They are not a whole-food score or personalised dietary advice.'};
  }
  return {version,keys,sources,mealMeasures,isDrink,HALF_UK_PINT_ML,measures,createPortion,selectedMeasure,valid,quantity,switchMeasure,setAmount,portionNutrients,servingConflict,portionRecord,plants,projection,score,calculatedScore,scoreFacts,scoreFingerprint,cachedScore,validScoreResult,isCatalogueQualityHold,isCatalogueQualityCheck,catalogueEvidenceExpiry,allergies,risks,value,peanutButter};
})();
