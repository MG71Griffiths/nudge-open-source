/* Shared source recovery for unconfirmed meal estimates. Source quantities are
 * copied from whole official records; observations and confirmed diary snapshots
 * are never replaced. See the generated dataset's attribution and source hashes. */
(function(root){
  'use strict';
  const VERSION='meal-source-recovery-v7';
  const clone=v=>JSON.parse(JSON.stringify(v));
  const normal=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  const singular={figs:'fig',eggs:'egg',noodles:'noodle',onions:'onion',limes:'lime',leaves:'leaf',vegetables:'vegetable',greens:'green',beans:'bean',peas:'pea',tomatoes:'tomato',potatoes:'potato',berries:'berry',cherries:'cherry',strawberries:'strawberry'};
  function canonical(s){return normal(s).replace(/\byoghurt\b/g,'yogurt').replace(/\b(?:mince|minced)\b/g,'ground').replace(/\bvermicelli\b/g,'noodle').replace(/\bscallions?\b/g,'spring onion').replace(/\baubergines?\b/g,'eggplant').replace(/\bcourgettes?\b/g,'zucchini').replace(/\bcoriander\b/g,'cilantro').replace(/\bprawns?\b/g,'shrimp').replace(/\bgarbanzo\b/g,'chickpea').split(' ').map(w=>singular[w]||(w.length>4&&/s$/.test(w)&&!/(?:ss|us)$/.test(w)?w.slice(0,-1):w)).join(' ');}
  // A plate-position suffix is not part of a food's identity. Keep compound
  // parts (particularly a pie filling) distinct from complete dishes.
  const presentationName=s=>canonical(s).replace(/\s+side(?: dish)?$/,'').replace(/^(mashed potato) topping$/,'$1');
  const ignored=new Set('raw fresh cooked cooking boiled steamed roasted baked grilled fried stir sauteed saute braised stewed scrambled poached microwaved ground chopped diced sliced slice wedge floret piece grated shredded whole plain ready eat edible drained flesh skin boneless skinless large small medium thin thick leaf garnish and the of a in without with salt added unsalted unprepared'.split(' '));
  const atoms=s=>canonical(s).split(' ').filter(t=>t&&!ignored.has(t));
  const headAtoms=s=>atoms(s.replace(/\([^)]*\)/g,'').split(',')[0]);
  function state(s){const n=normal(s);if(/\b(cooked|boiled|steamed|roasted|baked|grilled|fried|braised|stewed|scrambled|poached|microwaved|sauteed|saute|soaked)\b/.test(n))return 'cooked';if(/\b(raw|fresh|uncooked)\b/.test(n))return 'raw';if(/\b(dried|dry|dehydrated|powder)\b/.test(n))return 'dry';return 'unknown';}
  const method=s=>normal(s).match(/\b(scrambled|boiled|steamed|roasted|baked|grilled|fried|braised|stewed|poached|microwaved)\b/)?.[0]||null;
  let index=null,byId=null,byHead=null;
  function prepare(){
    if(index)return;
    const data=root.NudgeMealRecoveryData;if(!data?.records)return;
    byId=new Map();index=data.records.map(tuple=>{const entry={tuple};byId.set(tuple[0],entry);return entry;});
  }
  function searchIndex(){
    if(byHead)return;byHead=new Map();
    for(const entry of index){entry.head=headAtoms(entry.tuple[3]);for(const atom of new Set(entry.head)){if(!byHead.has(atom))byHead.set(atom,[]);byHead.get(atom).push(entry);}}
  }
  function hydrate(entry){
    if(entry.words)return entry;
    entry.name=canonical(entry.tuple[3]);entry.head=entry.head||headAtoms(entry.tuple[3]);entry.words=new Set(atoms(entry.tuple[3]));entry.state=state(entry.tuple[3]);entry.method=method(entry.tuple[3]);return entry;
  }
  function publicRecord(entry){
    const t=entry.tuple,data=root.NudgeMealRecoveryData,source=data.sources[t[1]],values=Object.fromEntries(data.keys.map((key,i)=>[key,t[8][i]]));
    return {id:t[0],code:t[2],name:t[3],description:t[4],sourceReference:t[5],source:source.name,sourceVersion:source.version,
      sourceURL:t[1]==='u'?'https://fdc.nal.usda.gov/food-details/'+t[2]+'/nutrients':source.url,licenceURL:source.licenceURL,
      basis:'per100g',valueStatus:'composition_estimate',foodGroup:t[6],fvlEligible:t[7],plantIdentity:null,
      mealScoringProfile:t[9]||'unknown',specialOilFvlEligible:typeof t[10]==='boolean'?t[10]:null,
      carbohydrateDefinition:t[1]==='u'?'by_difference_including_fibre':'available',nutrients:root.NudgeComposition.nutrients({values})};
  }
  function scoringMetadata(record){
    prepare();const t=byId?.get(record?.id)?.tuple;
    // Older selected sources can use reviewed classification read-only. Neither
    // arbitrary component text nor a caller-supplied profile is classification
    // evidence. A mismatched source identity remains unsupported.
    if(!t||record.basis!=='per100g'||record.name!==t[3])return {mealScoringProfile:'unknown',specialOilFvlEligible:null};
    return {mealScoringProfile:t[9]||'unknown',specialOilFvlEligible:typeof t[10]==='boolean'?t[10]:null};
  }
  const complete=entry=>[0,4,6,8].every(i=>/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(entry.tuple[8][i]??'')));
  const kinds=['beef','pork','lamb','veal','venison','chicken','turkey','duck','goose','quail','salmon','tuna','cod','haddock','shrimp'];
  const extras=/\b(battered|breaded|stuffed|sauce|soup|gravy|salad|sandwich|pizza|burger|nugget|babyfood|formula|dessert|pudding|sweetened|candied|pickled|smoked|cured|bacon|ham|dried|dehydrated|powder|concentrate|imitation|substitute|replacer|reduced|light|lowfat|nonfat|fatfree)\b/;
  const potatoSkins=context=>/\b(?:potato skin|skin only)\b/.test(context)&&!/\b(?:flesh|peeled|unpeeled|skin on|with skin|in skin|without skin|skin removed)\b/.test(context);
  function compatible(entry,wanted,context,requestedState){
    if(['unknown','drink','beverage','alcohol','supplement','infant_food','medical_food'].includes(entry.tuple[6]))return false;
    if(!entry.head.length||!entry.head.every(t=>wanted.includes(t)))return false;
    if(!wanted.every(t=>entry.words.has(t)))return false;
    if(requestedState==='raw'&&entry.state==='cooked'||requestedState==='cooked'&&['raw','dry'].includes(entry.state)||requestedState==='dry'&&entry.state==='cooked')return false;
    if(requestedState==='cooked'&&entry.state!=='cooked'&&!['cheese','fat_oil'].includes(entry.tuple[6]))return false;
    // A potato skin source describes the isolated edible fraction, not a
    // potato cooked in its skin. Keep comma-delimited source fractions intact
    // even though ordinary search tokens omit flesh/skin preparation words.
    if(entry.head.includes('potato')){
      const skinOnly=entry.tuple[3].split(',').some(part=>/^skin(?: only)?(?: (?:with|without) salt)?$/.test(canonical(part)));
      if(skinOnly!==potatoSkins(context))return false;
    }
    for(const kind of kinds)if(entry.words.has(kind)&&!context.includes(kind))return false;
    // Edible muscle is not skin, giblets or separable fat. Ordinary rice is not
    // wild rice, and unripe green tomatoes are not a default ripe-tomato source.
    for(const type of ['skin','giblet','liver','heart','kidney','blood','wild','green','yellow']){
      const sourceHas=type==='skin'?['red_meat','poultry','fish'].includes(entry.tuple[6])&&entry.name.split(' ').includes(type):entry.words.has(type);
      if(sourceHas&&!context.split(' ').includes(type)&&!(type==='skin'&&/without skin|skin removed/.test(entry.name))&&!(type==='green'&&!entry.words.has('tomato'))&&!(type==='yellow'&&!entry.words.has('tomato')))return false;
    }
    if(/\bseparable fat\b/.test(entry.name)&&!context.includes('fat'))return false;
    // Do not turn an ingredient into a prepared recipe containing it. Dried then
    // boiled noodles are cooked food, unlike dehydrated noodles weighed dry.
    const unexpected=entry.name.match(new RegExp(extras.source,'g'))||[];
    if(unexpected.some(word=>!context.split(' ').includes(word)&&!(entry.state==='cooked'&&['dried','dehydrated'].includes(word))))return false;
    if(/\b(with|in)\b/.test(entry.name)&&/\b(butter|cream|milk|oil|cheese|sugar|syrup|dressing)\b/.test(entry.name)&&!['cheese','fat_oil'].includes(entry.tuple[6]))return false;
    if(/\b(mix|mixture|recipe|sauce|stock)\b/.test(normal(entry.tuple[4]))&&!/\b(recipe|mix|mixture)\b/.test(context))return false;
    // Source records containing unobserved additional vegetables cannot stand
    // in for a plain grain or a different vegetable component.
    if(entry.tuple[6]==='grain'&&/\b(spinach|tomato|cheese|chicken|beef|pork|egg)\b/.test(entry.name)&&!context.match(/\b(spinach|tomato|cheese|chicken|beef|pork|egg)\b/))return false;
    return true;
  }
  function query(component,meal){
    const context=canonical(component.name+' '+component.preparation),requestedState=state(context);
    const foodName=presentationName(component.name);
    const recipeContext=canonical([meal.name,meal.subject?.description,...(Array.isArray(meal.ingredients)?meal.ingredients:[]).flatMap(i=>[i?.name,i?.evidence]),component.name,component.preparation,component.evidence].filter(Boolean).join(' '));
    if(/\b(raw|uncooked)\b/.test(context)&&requestedState==='cooked')return {reason:'Conflicting raw and cooked preparation.'};
    if(/\b(filling|topping|base)\b/.test(foodName))return {reason:'This is part of a mixed dish; use its ingredient quantities rather than a whole-dish source.'};
    // Unknown composite recipes need identification, not a guessed ingredient.
    if(/\b(with|and|sauce|stuffed|battered|breaded|vegan|vegetarian|meat free|plant based)\b/.test(canonical(component.name))||/\b(sauce|stuffed|battered|breaded|vegan|vegetarian|meat free|plant based)\b/.test(context))return {reason:'Choose a source for this mixed or specialised food.'};
    if(/\b(vegan|vegetarian|meat free|plant based|dairy free)\b/.test(recipeContext)&&/\b(meat|pork|beef|lamb|chicken|turkey|duck|fish|salmon|cheese|egg)\b/.test(context))return {reason:'The dietary or ingredient context conflicts with a generic animal-food proxy.'};
    if(/\b(vegan|plant based|dairy free)\b/.test(recipeContext)&&/\b(milk|yogurt|kefir|butter)\b/.test(context))return {reason:'The dietary context conflicts with a generic dairy-food proxy.'};
    if(/\bgluten free\b/.test(recipeContext)&&/\bflour\b/.test(context))return {reason:'Identify the gluten-free flour before choosing a source.'};
    const name=foodName.replace(/\b(?:wedge|slice|piece|floret|grated|shredded|chopped|diced|fresh|raw|cooked|plain|whole)\b/g,'').replace(/\s+/g,' ').trim();
    const explicitGround=/\bground\b/.test(context),cooked=requestedState==='cooked',raw=requestedState==='raw';
    let id=null,identity='matched_identity',assumptions=[];
    // Scoring-profile coverage must not exclude ordinary recipe ingredients
    // from nutrient calculation. These are complete existing CoFID records.
    if(/^(?:butter|unsalted butter|butter unsalted|salted butter|butter salted)$/.test(foodName)&&!extras.test(context)){
      id=/\bsalted\b/.test(context)?'17-685:5d11e1950606':'17-661:7c4e65f156d3';identity='generic_proxy';
      assumptions.push(/\b(?:salted|unsalted)\b/.test(context)?'Generic full-fat butter composition; the exact brand may differ.':'Generic full-fat unsalted butter composition; added salt is unknown and the exact butter may differ.');
    }
    if(/^(?:plain (?:white |wheat )?flour|white plain flour|all purpose flour)$/.test(foodName)&&['raw','dry','unknown'].includes(requestedState)&&!extras.test(context)){
      id='11-886:ab04b5c4da43';identity='generic_proxy';assumptions.push('Generic dry plain white wheat flour composition; the exact flour may differ.');
    }
    if(name==='smoked haddock'&&raw&&!extras.test(context.replace(/\bsmoked\b/g,''))){
      id='16-492:d35747a63193';identity='generic_proxy';assumptions.push('Generic raw smoked haddock edible flesh; brand and smoking/salting levels may differ.');
    }
    if(name==='haddock'&&raw&&!extras.test(context)){
      id='16-375:fcf21536084f';identity='generic_proxy';assumptions.push('Generic raw haddock edible flesh; the exact fish may differ.');
    }
    // A linked ingredient quote can retain preparation detail omitted from the
    // short preparation field. Do not borrow peeling from another ingredient.
    const potatoContext=context+' '+(/^Recipe photo [1-4]:\s*/i.test(component.evidence||'')?canonical(component.evidence):'');
    if(/^(?:peeled )?potato(?: peeled)?$/.test(name)&&raw&&/\b(?:peeled|flesh only)\b/.test(potatoContext)&&!extras.test(potatoContext)&&!/\b(?:unpeeled|skin on|with skin|boiled|cooked|fried|baked|roasted|grilled|steamed)\b/.test(potatoContext)){
      id='13-489:214c339aadef';identity='generic_proxy';assumptions.push('Generic raw peeled potato flesh; the variety and actual water content may differ.');
    }
    if(name==='mashed potato'&&cooked){
      const localEvidence=canonical([component.evidence,...(Array.isArray(meal.ingredients)?meal.ingredients:[]).filter(i=>/\b(?:topping|mashed potato)\b/.test(canonical(i?.name+' '+i?.evidence))).flatMap(i=>[i.name,i.evidence])].join(' '));
      const dairyConflict=/\b(?:vegan|plant based|dairy free|without (?:milk|butter)|no (?:milk|butter))\b/.test(recipeContext);
      if(!dairyConflict&&/\bmilk\b/.test(localEvidence)&&/\bbutter\b/.test(localEvidence)){
        id='13-553:91e2fd193325';identity='generic_proxy';assumptions.push('Generic mashed potato with milk and butter: the reference uses 100 g boiled potato, 5 g butter and 7 g milk. The actual topping proportions and baking loss are unknown.');
      }else return {reason:'Mashed potato additions are unknown; identify milk, butter or other additions before choosing a recipe source.'};
    }
    if(id&&byId.has(id))return {entries:[byId.get(id)],identity,assumptions};
    // These whole CoFID records supply ingredient nutrition, independently of
    // scoring-profile support. Dairy was excluded with unknown/drink scoring
    // groups even when its food identity and edible gram amount were explicit.
    const dairyName=canonical(component.name).replace(/\b(?:fresh|raw)\b/g,'').replace(/\s+/g,' ').trim();
    if(dairyName==='whole milk'&&!/\b(raw milk|unpasteuri[sz]ed|powder|dried|condensed|evaporated|flavou?red|sweetened)\b/.test(context)){
      id=/\buht\b/.test(context)?'12-320:012eba70ce95':'12-596:d379c671eb80';identity='generic_proxy';assumptions.push('Generic whole cow’s milk composition; the exact brand and seasonal values may differ.');
    }
    if(/^(?:plain greek(?: style)? yogurt|greek(?: style)? plain yogurt|greek(?: style)? yogurt)$/.test(dairyName)&&!extras.test(context)&&!/(?:\b[0-9]+\s*(?:percent|fat)\b|\b(?:low|non|reduced|zero) fat\b)/.test(context)){
      const yogurt=byId.get('12-555:bf4be7c34952');
      if(yogurt&&!/\bplain\b/.test(context))return {entries:[yogurt],reason:'Confirm that this is plain Greek yogurt and check its fat content.'};
      id='12-555:bf4be7c34952';identity='generic_proxy';assumptions.push('Generic plain Greek-style yogurt composition; the exact brand and fat content may differ.');
    }
    if(id&&byId.has(id))return {entries:[byId.get(id)],identity,assumptions};
    // Reviewed food-class proxies apply across dishes. These preserve the
    // observed food name and disclose exactly which unknown identity is assumed.
    if(/^(glass|cellophane|mung bean|bean thread|transparent) noodle$/.test(name)&&cooked){id='usda:168914';identity='generic_proxy';assumptions.push('Generic cooked starch-noodle proxy: cooked rice noodles. The observed glass-noodle starch and exact recipe are unknown; this does not identify it as rice.');}
    else if(/^(leafy green vegetable|leafy green|green vegetable|green)$/.test(name)&&(cooked||raw)){id=cooked?'usda:168463':'usda:168462';identity='generic_proxy';assumptions.push('Generic leafy-green proxy: spinach. The photographed plant species is unknown and is not counted as spinach.');}
    else if(/^(?:ground )?meat$/.test(name)&&explicitGround&&cooked){
      if(/\b(pork|lamb|chicken|turkey|duck|veal|venison|goose|quail)\b/.test(recipeContext))return {reason:'Identify the named meat species before choosing its source.'};
      id='usda:171799';identity='generic_proxy';assumptions.push('Generic cooked minced-meat proxy: beef, 80% lean / 20% fat, pan-browned. The observed species and fat content remain unknown.');}
    else if(name==='cheese'){id='12-526:344df15a32a6';identity='generic_proxy';assumptions.push('Generic cheese proxy: fresh Parmesan. The observed cheese variety is unknown; edit the match if known.');}
    else if(name==='rice noodle'&&cooked)id='usda:168914';
    else if(name==='rice'&&cooked){id='usda:169757';identity='generic_proxy';assumptions.push('Generic cooked rice proxy: white rice. The observed rice variety is unknown.');}
    else if((name==='pork'||name==='ground pork'||name==='pork ground')&&explicitGround&&cooked)id='usda:169192';
    else if((name==='beef'||name==='ground beef'||name==='beef ground')&&explicitGround&&cooked)id='usda:171799';
    else if(name==='egg'&&/\bscrambled\b/.test(context))id='usda:172187';
    else if(name==='red onion'&&cooked){id='usda:170001';assumptions.push('Generic cooked onion composition; the red variety and cooking method may differ.');}
    else if(name==='red onion'&&raw){id='usda:170000';assumptions.push('Generic raw onion composition; the red variety may differ.');}
    else if(name==='parsley'&&raw)id='usda:170416';
    else if(name==='lime'&&raw)id='usda:168155';
    if(id&&byId.has(id))return {entries:[byId.get(id)],identity,assumptions};
    let wanted=atoms(foodName);
    if(wanted.includes('potato')&&potatoSkins(context))wanted=wanted.filter(word=>word!=='only');
    if(wanted.includes('zucchini')&&!wanted.includes('squash'))wanted.push('squash');
    if(wanted.some(w=>['salmon','tuna','cod','haddock'].includes(w))&&!wanted.includes('fish'))wanted.push('fish');
    // Preparation descriptions do not establish new food identities, but a
    // visible mince/ground preparation selects the ground form of known meat.
    if(!wanted.length)return {reason:'Food identity is missing.'};
    searchIndex();
    const candidates=[...new Set(wanted.flatMap(word=>byHead.get(word)||[]))].map(hydrate).filter(e=>compatible(e,wanted,context,requestedState));
    if(!candidates.length)return {reason:'No compatible source for this food and preparation.'};
    const score=e=>(e.state===requestedState?100:0)+(method(context)&&e.method===method(context)?30:0)+(complete(e)?20:0)+(explicitGround&&/\bground\b/.test(e.name)?25:0)+(/without (?:added )?salt|unsalted/.test(e.name)?3:0)-e.name.length/100;
    candidates.sort((a,b)=>score(b)-score(a)||a.tuple[0].localeCompare(b.tuple[0]));
    // Pinned raw/cooked mushroom sources identify particular varieties. Their
    // completeness or shorter names cannot establish an observed species.
    if(wanted.length===1&&wanted[0]==='mushroom')return {entries:candidates.slice(0,3),reason:'Choose a mushroom variety before using one of these sources.'};
    // Do not default unknown meat/egg preparations to a raw or cooked quantity.
    if(requestedState==='unknown'&&['red_meat','poultry','fish','egg'].includes(candidates[0].tuple[6]))return {entries:candidates.slice(0,3),reason:'Choose the preparation before using this source.'};
    return {entries:candidates.slice(0,3),identity,assumptions};
  }
  function protectedComponent(c){return !c||c.recordId||c.sourceRecord||c.userEdited||c.selected===false||c.matchStatus==='confirmed'||c.matchMethod==='user_selected'||c.amountSource==='confirmed';}
  function recover(meal,{confirmed=false,userEdited=false}={}){
    if(!meal||confirmed||userEdited||meal.userEdited||meal.scoreSnapshot?.available||meal.portionMode!=='estimated_serving'||!Array.isArray(meal.components)||!root.NudgeComposition?.nutrients)return meal;
    prepare();if(!index)return meal;
    const proposed=root.NudgeComposition.proposeMeal?.(meal,{confirmed,userEdited})||meal;
    const result=clone(proposed),unresolved=[],assumptions=[];let changed=proposed!==meal;
    result.components=result.components.map((c,i)=>{
      if(protectedComponent(c)){if(!c?.recordId)unresolved.push({index:i,name:c?.name||'Food',reason:'This selection or edit is preserved; choose its source in Edit.'});return c;}
      if(typeof c.amountGrams!=='number'||!Number.isFinite(c.amountGrams)||c.amountGrams<=0||c.amountGrams>5000){unresolved.push({index:i,name:c.name,reason:'Add an edible gram amount.'});return c;}
      if(!Number.isInteger(c.photoIndex)||c.photoIndex<1||c.photoIndex>4||typeof c.evidence!=='string'||!c.evidence.trim()){unresolved.push({index:i,name:c.name,reason:'A linked food observation is needed.'});return c;}
      const match=query(c,result),records=(match.entries||[]).map(publicRecord);
      if(match.reason){unresolved.push({index:i,name:c.name,reason:match.reason});if(records.length){changed=true;return {...c,candidates:records,matchStatus:'needs_confirmation'};}return c;}
      const record=records[0];if(!record){unresolved.push({index:i,name:c.name,reason:'Choose a food composition source.'});return c;}
      const sourceAssumptions=[...match.assumptions,'Generic food estimate: '+record.name+'.',
        'Uses one complete source record; no nutrient values are inferred from the photograph.',
        'The proposed edible grams are retained. The actual recipe, added oil and seasonings may differ from the reference.'];
      if(state(c.name+' '+c.preparation)!==state(record.name)||method(c.preparation)&&method(c.preparation)!==method(record.name))sourceAssumptions.push('Preparation proxy: '+record.name+'. Hidden cooking oil, sauces and ingredients are not separately quantified.');
      assumptions.push(...sourceAssumptions);changed=true;
      return {...c,recordId:record.id,sourceRecord:record,nutrients:record.nutrients,candidates:records,matchStatus:'matched',matchMethod:'source_recovery',
        preparationProxy:true,assumptions:[...new Set([...(Array.isArray(c.assumptions)?c.assumptions:[]),...sourceAssumptions])],
        recovery:{version:VERSION,identity:match.identity,sourceRecordId:record.id,original:{name:c.name,preparation:c.preparation,evidence:c.evidence,photoIndex:c.photoIndex,photoId:c.photoId||null,amountGrams:c.amountGrams},assumptions:sourceAssumptions}};
    });
    const recovered=result.components.filter(c=>c?.recovery).length;
    result.recovery={version:VERSION,status:unresolved.length?(recovered?'partial':'unresolved'):'complete',assumptions:[...new Set(assumptions)],unresolved};
    result.nutrients=root.NudgeComposition.mealNutrition(result);
    if(changed){result.compositionVersion=[proposed.compositionVersion,VERSION].filter(Boolean).join('+');if(result.scoreSnapshot?.available===false)delete result.scoreSnapshot;}
    return result;
  }
  function record(id){prepare();const entry=byId?.get(id);return entry?publicRecord(entry):null;}
  const api={VERSION,recover,scoringMetadata,record};root.NudgeMealRecovery=api;
  // Worker module startup (and browser script loading) builds the reusable name
  // index. Requests only inspect compatible headword candidates, not 10k rows.
  prepare();if(index)searchIndex();
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window==='object'?window:globalThis);
