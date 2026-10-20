/* Recipe quantities describe a batch, independently of the photographed plate.
 * Calculate the complete recipe, then scale only its ingredients by the selected
 * fraction. A printed yield is optional and never identifies what was eaten. */
(function(root){
  'use strict';
  const VERSION='recipe-composition-v1',clone=v=>JSON.parse(JSON.stringify(v));
  const validServings=n=>typeof n==='number'&&Number.isFinite(n)&&n>=1&&n<=50;
  const validFraction=n=>typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=1;
  function apply(meal,servings,{source='user',portionFraction}={}){
    const recipe=meal?.recipeCalculation;
    const fraction=portionFraction===undefined&&validServings(servings)?1/servings:portionFraction;
    if(!recipe||recipe.userEdited||recipe.version!==VERSION||servings!==null&&!validServings(servings)||!validFraction(fraction)||!['recipe','user'].includes(source)||!root.NudgeComposition?.total)return meal;
    const original=recipe.applied?recipe.originalPlateComponents:meal.components;
    const indexes=recipe.componentIndexes,batch=recipe.batchComponents;
    if(!Array.isArray(original)||!Array.isArray(indexes)||!indexes.length||new Set(indexes).size!==indexes.length||indexes.some(i=>!Number.isInteger(i)||i<0||i>=original.length)
      ||!Array.isArray(batch)||!batch.length||batch.length+original.length-indexes.length>40)return meal;
    const result=clone(meal),selected=new Set(indexes),first=Math.min(...indexes);
    const scaled=batch.map(c=>({...clone(c),amountGrams:typeof c.amountGrams==='number'&&Number.isFinite(c.amountGrams)&&c.amountGrams>0?c.amountGrams*fraction:null,
      amountSource:'recipe_serving',recipeQuantity:{batchAmountGrams:c.amountGrams??null,servings,selectedFraction:fraction,fractionSource:source},
      assumptions:[...new Set([...(c.assumptions||[]),'Recipe batch quantities multiplied by '+fraction+'; cooking water loss and the photographed serving weight are not measured.'])]}));
    result.components=original.flatMap((c,i)=>i===first?scaled:selected.has(i)?[]:[clone(c)]);
    result.nutrients=root.NudgeComposition.total(result.components);
    const complete=Object.values(result.nutrients).every(n=>typeof n.value==='number'&&Number.isFinite(n.value));
    result.recipeCalculation={...clone(recipe),applied:true,servings,servingsSource:recipe.servings===servings?recipe.servingsSource:source,selectedFraction:fraction,fractionSource:source,
      originalPlateComponents:clone(original),status:complete?'ready':'incomplete'};
    // Ingredient input weights are not the cooked plate's edible weight. Keep a
    // serving multiplier, but never offer their sum as measured plated grams.
    result.portion={label:fraction===1?'Whole recipe':fraction+' of recipe',amount:null,unit:null,source:'estimated'};
    result.portionAmbiguity={requiresSelection:false,reason:'Select the fraction of the recipe you ate. Any photographed side is included separately.'};
    result.message=complete?'Estimated from the recipe. Select how much you ate before adding to today.':'Partial nutrition from the recipe. Select how much you ate; some ingredient quantities or source values are still missing.';
    delete result.scoreSnapshot;
    return result;
  }
  const HOUSEHOLD_VERSION='recipe-household-v3';
  const normal=s=>String(s||'').toLowerCase().replace(/[’']/g,'').replace(/[-_]/g,' ').replace(/\s+/g,' ').trim();
  const usdaURL='https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip';
  const usdaSHA='b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0';
  const manufacturerRecord=(id,name,url,values,group='nuts_seeds')=>({id,name,source:'Manufacturer nutrition panel',sourceVersion:'label-2026-10-11',sourceURL:url,basis:'per100g',carbohydrateDefinition:'available',foodGroup:group,fvlEligible:false,
    nutrients:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,unit:key==='energyKcal'?'kcal':'g',status:'composition_estimate'}]))});
  function householdMeasure(row,recipeText=''){
    if(typeof row?.amount!=='number'||!Number.isFinite(row.amount)||row.amount<=0||!['g','kg','ml','l','tbsp','tsp','count'].includes(row.unit))return null;
    // Newly parsed UK recipe spoons are volumes. Keep historical recipe rows
    // unchanged; never reuse their US spoon weights as a UK density estimate.
    if(row.localMeasureSystem==='uk-volume-v1'&&['tbsp','tsp'].includes(row.unit)){
      const volumeMl=row.amount*(row.unit==='tbsp'?15:5),next={...row,amount:volumeMl,unit:'ml'};delete next.localMeasureSystem;
      const measure=householdMeasure(next,recipeText);if(!measure)return null;
      return {...measure,assumptions:[...measure.assumptions,'UK measuring spoon: tablespoon 15 ml; teaspoon 5 ml. Ingredient-specific volume-to-weight evidence remains an estimate.'],
        conversion:{...measure.conversion,version:HOUSEHOLD_VERSION+'+uk-volume-v1',inputAmount:row.amount,inputUnit:row.unit,volumeMl,unitSourceURL:'https://www.fhft.nhs.uk/patients-and-visitors/patient-information-library/liquidised-diet'}};
    }
    const name=normal(row.name),context=normal([row.name,row.preparation,row.evidence].join(' '));
    if(/\b(?:sweetened|salted|flavou?red|chocolate|vanilla|fried|cooked|soaked|sprouted)\b/.test(context))return null;
    let id,gramsPerTbsp,gramsPerMl,gramsPerCount,sourceURL=usdaURL,sourcePortionId,assumption,record;
    // A printed choice supplies one shared quantity, never one quantity for
    // each option. Only the validated choice operation establishes a selection.
    const choice=row.recipeChoiceSelection,choiceSelected=choice&&typeof choice.choiceId==='string'&&choice.choiceId&&typeof choice.optionId==='string'&&choice.optionId&&choice.evidence==='User selected '+row.name;
    const unresolvedChoice=/\bor\b|\//i.test(row.evidence||'')&&!choiceSelected;
    if(row.recipeTextRecovered===true&&/^(?:(?:raw|fresh) )?shallots?$/.test(name)&&['g','kg'].includes(row.unit)&&/\braw\b/.test(context)
      &&!/\b(?:pickled|dried|powder|sauce|paste|roasted|oil)\b/.test(context)){
      id='usda:170499';assumption='Exact raw-shallot whole-source estimate from USDA. The recovered printed gram quantity is retained. This complete source uses the same total-carbohydrate basis as the other USDA recipe ingredients; no individual nutrients are spliced.';
    }else if(/^(?:(?:canned|full fat|canned full fat|full fat canned) )?coconut milk(?: canned)?$/.test(name)){
      if(unresolvedChoice||/\b(?:light|lite|reduced|low fat|fat free|skim|drink|beverage|carton|cream|powder|frozen)\b/.test(context))return null;
      id='usda:170173';gramsPerTbsp=15;gramsPerMl=226/(8*29.573);sourcePortionId=['tbsp','tsp'].includes(row.unit)?'86172':'86171';
      assumption='Generic standard canned coconut-milk cooking estimate: the complete USDA canned coconut-milk record; 226 g per US cup or 15 g per tablespoon. This is not coconut drink or reduced-fat coconut milk. Actual brand, fat content and density may differ; change the ingredient if needed.';
    }else if(/^(?:(?:small|medium|large|fresh|raw) )*(?:red bell peppers?|red peppers?|red capsicums?)$/.test(name)){
      if(unresolvedChoice||/\b(?:canned|frozen|pickled|dried|powder|sauce|paste|roasted)\b/.test(context))return null;
      id='usda:170108';const size=/\blarge\b/.test(context)?'large':/\bsmall\b/.test(context)?'small':'medium';
      gramsPerCount={small:74,medium:119,large:164}[size];sourcePortionId={small:'86067',medium:'86066',large:'86065'}[size];
      assumption='Generic raw red bell-pepper estimate from USDA. '+(!/\b(?:small|medium|large)\b/.test(context)?'Size was unspecified; a medium pepper is proposed at 119 g edible weight.':'The '+size+' pepper household estimate is '+gramsPerCount+' g edible weight.')+' Actual size and discarded stalk/seeds may differ.';
    }else if(/^(?:(?:fresh|raw) )*green (?:chillies|chilies|chilli|chili)(?: peppers?)?$/.test(name)){
      if(unresolvedChoice||!['g','kg'].includes(row.unit)||/\b(?:canned|pickled|dried|powder|sauce|paste|roasted)\b/.test(context))return null;
      id='usda:170497';assumption='Generic raw green-chilli composition from the complete USDA green hot-chili record. The printed gram amount is retained; cultivar and heat level may differ. No count-to-weight estimate is made for chillies.';
    }else if(/^(?:olive oil|rapeseed oil|canola oil|vegetable oil)$/.test(name)){
      if(unresolvedChoice||/\b(?:spray|blend|margarine|butter|dressing|infused)\b/.test(normal(row.name+' '+row.preparation)))return null;
      const oils={'olive oil':['usda:171413',13.5,'88667'],'rapeseed oil':['usda:172336',14,'90374'],'canola oil':['usda:172336',14,'90374'],'vegetable oil':['usda:172370',13.6,'90462']};
      [id,gramsPerTbsp,sourcePortionId]=oils[name];
      assumption=(name==='vegetable oil'?'Generic vegetable-oil proxy: refined soybean oil; the actual oil type or blend is unknown. ':name==='rapeseed oil'?'Generic rapeseed-oil proxy: USDA canola oil; the exact product may differ. ':'Generic '+name+' composition. ')+'USDA tablespoon weight is '+gramsPerTbsp+' g; actual spoon sizes may differ.';
    }else if(/^(?:honey|sugar|white sugar|granulated sugar|white granulated sugar)$/.test(name)){
      if(unresolvedChoice||/\b(?:brown|palm|coconut|syrup|powdered|icing|packed|heaped)\b/.test(normal(row.name+' '+row.preparation)))return null;
      const honey=name==='honey';id=honey?'usda:169640':'usda:169655';gramsPerTbsp=honey?21:4.2*3;sourcePortionId=honey?'85265':'85287';
      assumption=honey?'Generic honey estimate: USDA lists 21 g per tablespoon; the exact honey and spoon size may differ.':'Generic white granulated-sugar estimate: USDA lists 4.2 g per teaspoon; one tablespoon is three teaspoons (12.6 g). Actual spoon size may differ; this does not identify palm or brown sugar.';
    }else if(/^(?:pea protein(?: powder| isolate)?|pea protein isolate powder)$/.test(name)){
      record=manufacturerRecord('proxy:bulk-plain-pea-protein-2026-10-11','Plain pea protein isolate (Bulk label proxy)','https://www.bulk.com/ie/products/super-pea-protein-isolate/bpb-sppi-0000',{energyKcal:394,protein:80,carbohydrate:3,sugars:.1,fat:6,saturatedFat:1,fibre:4.1,salt:1.9},'sports_nutrition');
      gramsPerTbsp=7.5;sourceURL='https://www.bulksupplements.com/products/pea-protein-powder';
      assumption='Unflavoured pea isolate proxy: Bulk nutrient panel; BulkSupplements lists 4 tablespoons as about 30 g. Your brand, flavour and spoon size may differ.';
    }else if(/^chia seeds?$/.test(name)){
      id='usda:170554';gramsPerTbsp=13;sourceURL='https://www.bobsredmill.com/product/organic-chia-seed';
      assumption='Dry chia estimate: Bob’s Red Mill lists 2 tablespoons as 26 g; the complete USDA chia record supplies nutrients. Actual spoon weights may differ.';
    }else if(/^(?:(?:3|three|mixed) )?seed mix$|^mixed seeds$/.test(name)){
      id='usda:170562';gramsPerTbsp=140/16;sourcePortionId='86856';
      assumption='Generic seed-mix proxy: dried sunflower kernels, including their USDA 140 g cup weight. The mix and proportions are unknown; this does not identify its plant species.';
    }else if(/\blinwoods\b/.test(context)&&/\bflaxseed\b/.test(context)&&/\bgoji berr(?:y|ies)\b/.test(context)){
      record=manufacturerRecord('linwoods:flaxseed-goji-2026-10-11','Linwoods Milled Flaxseed & Goji Berries','https://linwoodshealthfoods.com/product/milled-flaxseed-goji-berries/',{energyKcal:500,protein:21,carbohydrate:11,sugars:4.6,fat:37,saturatedFat:4.1,fibre:22,salt:.31});
      gramsPerTbsp=7;sourcePortionId='84818';
      assumption='One combined Linwoods flaxseed/goji ingredient. Spoon weight uses the USDA ground-flaxseed estimate (7 g per tablespoon); the blend may weigh differently. Check the current pack.';
    }else if(/^(?:ground |milled )?(?:flaxseed|flax seed|linseed)s?$/.test(name)){
      id='usda:169414';gramsPerTbsp=/\b(?:ground|milled)\b/.test(context)?7:10.3;sourcePortionId=gramsPerTbsp===7?'84818':'84816';assumption='USDA flaxseed household estimate; actual spoon weight may differ.';
    }else if(/^blueberr(?:y|ies)$/.test(name)){
      id='14-325:b05499af697f';gramsPerTbsp=148/16;sourcePortionId='89238';assumption='Plain blueberry estimate: USDA raw blueberry cup weight, with the complete UK CoFID blueberry nutrient record.';
    }else if(/^mixed berr(?:y|ies)$/.test(name)){
      id='usda:167755';gramsPerTbsp=123/16;sourcePortionId='81905';assumption='Generic unsweetened mixed-berry proxy: raw raspberries and their USDA cup weight. The actual berry mix is unknown and is not counted as raspberry.';
    }else if(/^(?:(?:5|five|mixed) )?nut mix$|^mixed nuts$/.test(name)){
      id='usda:170585';gramsPerTbsp=131/16;sourcePortionId='86904';assumption='Generic nut-mix proxy: unsalted dry-roasted mixed nuts including peanuts, with USDA cup weight. The actual nuts and proportions may differ; this does not establish allergens or plant species.';
    }else if(/^(?:plain |dairy )?kefir(?: drink)?$/.test(name)&&!/(?:dairy free|plant based|vegan|coconut|water kefir)/.test(normal(recipeText))){
      id='usda:170904';gramsPerTbsp=243/16;gramsPerMl=243/(8*29.573);sourcePortionId='87527';assumption='Plain dairy kefir proxy: USDA low-fat Lifeway kefir (243 g per US cup). Brand, fat content and density may differ; not a measured volume-to-weight conversion.';
    }
    record=record||root.NudgeMealRecovery?.record?.(id);if(!record||!assumption)return null;
    const grams=row.unit==='g'?row.amount:row.unit==='kg'?row.amount*1000:row.unit==='count'?row.amount*gramsPerCount:row.unit==='tbsp'?row.amount*gramsPerTbsp:row.unit==='tsp'?row.amount*gramsPerTbsp/3:gramsPerMl?row.amount*gramsPerMl*(row.unit==='l'?1000:1):NaN;
    if(!Number.isFinite(grams)||grams<=0||grams>5000)return null;
    return {amountGrams:grams,sourceRecord:record,assumptions:[assumption,'Explicit generic estimate; weigh the ingredient or choose its label to refine it. Unknown source nutrients stay unknown.'],conversion:{version:HOUSEHOLD_VERSION,status:'household_measure_estimate',inputAmount:row.amount,inputUnit:row.unit,amountGrams:grams,sourcePortionId:sourcePortionId||null,sourceURL,sourceSHA256:sourceURL===usdaURL?usdaSHA:null,nutrientSourceId:record.id,nutrientSourceURL:record.sourceURL,gramsPerTbsp:gramsPerTbsp||null,gramsPerMl:gramsPerMl||null,gramsPerCount:gramsPerCount||null,unitSourceURL:'https://www.nist.gov/document/2026-nist-handbook-44-appendix-c'}};
  }
  function normaliseRows(rows,{recoverQuantities=true}={}){
    const result=[];
    for(const original of rows||[]){
      const row=clone(original),quote=normal(row.evidence);
      // Repair only this previously unsupported abbreviation in an exact,
      // scalar printed quantity. Never infer a missing quantity from a photo.
      const tbs=quote.match(/(?:^|\s|x)(\d+(?:\.\d+)?)\s+tbs\b/);
      const quantities=[...quote.matchAll(/\d+(?:\.\d+)?\s*(?:tbsp|tbs|tablespoons?|tsp|teaspoons?|ml|grams?|kg|g)\b/g)];
      // This runs after backend validation as well as during client recovery.
      // Do not resurrect a choice, multipack or compound quantity it rejected.
      if(recoverQuantities&&row.amount===null&&row.unit===null&&tbs&&quantities.length===1
        &&!/[-–—−/%;]|\b(?:to|between|or)\b|\d\s*[x×]\s*\d/i.test(String(row.evidence))){row.amount=Number(tbs[1]);row.unit='tbsp';}
      const duplicate=result.find(r=>normal(r.evidence)===quote&&r.amount===row.amount&&r.unit===row.unit&&normal(r.name)!==normal(row.name));
      // One printed spoonful of a named blend cannot become one spoonful of
      // each ingredient. Distinct printed quantities and repeated rows remain.
      if(duplicate&&quantities.length===1&&row.amount!==null){duplicate.name+=" and "+row.name;continue;}
      result.push(row);
    }
    return result;
  }
  const EVIDENCE_RECOVERY_VERSION='recipe-text-recovery-v1';
  function recoverIngredientRows(rows,text){
    if(!Array.isArray(rows)||typeof text!=='string'||text.length>6000)return rows;
    const words=s=>normal(s).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(Boolean);
    // The entire ingredient identity must agree. Token subsets can silently
    // turn coconut milk into dairy milk or chicken stock into chicken meat.
    const identity=(row,line)=>{const name=words(row.name),printed=words(line.split(/[,(]/)[0]);return name.length>0&&name.length===printed.length&&name.every((word,i)=>word===printed[i]||word+'s'===printed[i]||word.endsWith('s')&&word.slice(0,-1)===printed[i]);};
    const lines=text.split(/[\r\n\u000B\u000C]+/).map(line=>line.trim()).filter(Boolean);
    const units={g:'g',gram:'g',grams:'g',kg:'kg',kilogram:'kg',kilograms:'kg',ml:'ml',millilitre:'ml',millilitres:'ml',milliliter:'ml',milliliters:'ml',l:'l',litre:'l',litres:'l',liter:'l',liters:'l',tsp:'tsp',teaspoon:'tsp',teaspoons:'tsp',tbsp:'tbsp',tbs:'tbsp',tablespoon:'tbsp',tablespoons:'tbsp',x:'count'};
    const supported=lines.flatMap(line=>{
      const match=line.match(/^\s*(?:[-•*]\s+)?(\d+(?:[.,]\d+)?)\s*(kilograms?|kg|grams?|g|millilitres?|milliliters?|ml|litres?|liters?|l|tablespoons?|tbsp|tbs|teaspoons?|tsp|x)\s+(.+)$/i);
      if(!match||line.length>160||/\b(?:or|between|and)\b|\/|[;,&]/i.test(match[3])
        ||/\((?!approx(?:imately)?\s+(?:qty\s+)?\d)/i.test(match[3])
        ||/\d\s*(?:kilograms?|kg|grams?|g|millilitres?|milliliters?|ml|litres?|liters?|l|tablespoons?|tbsp|tbs|teaspoons?|tsp)\b/i.test(match[3]))return [];
      const amount=Number(match[1].replace(',','.')),unit=units[match[2].toLowerCase()];
      if(!Number.isFinite(amount)||amount<=0||amount>5000||unit==='kg'&&amount*1000>5000)return [];
      // A printed ingredient line is distinct from percentages inside a sauce,
      // alternate ingredients, ranges and prose referring to another quantity.
      if(/%/.test(match[3])||/[–—−]|\d\s*-\s*\d/.test(match[3].split('(')[0]))return [];
      const matches=rows.filter(row=>row&&identity(row,match[3]));
      return matches.length===1?[{row:matches[0],line,amount,unit}]:[];
    });
    return rows.map(row=>{
      if(!row||row.amount!==null||row.unit!==null||row.evidence?.trim()&&row.evidence!=='Recipe ingredient could not be linked to the printed text.')return row;
      const matches=supported.filter(item=>item.row===row);
      if(matches.length!==1)return row;
      const match=matches[0];
      return {...row,amount:match.amount,unit:match.unit,evidence:match.line,recipeTextRecovered:true};
    });
  }
  // Choice quantities belong to one printed line. They never belong to every
  // offered option at once; only an explicit review selection supplies an option.
  const recipeKey=s=>normal(s).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  const lineID=s=>{let h=2166136261;for(const c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return 'recipe-choice-'+(h>>>0).toString(16);};
  function parsedChoice(line){
    const m=line.trim().match(/^(?:[-•*]\s+)?(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|tbs|tbsp|tsp|x)\s+(.+)$/i);
    if(!m||line.length>160)return null;
    const amount=Number(m[1].replace(',','.')),unit={tbs:'tbsp',x:'count'}[m[2].toLowerCase()]||m[2].toLowerCase();
    if(!(amount>0)||amount>5000||unit==='kg'&&amount*1000>5000)return null;
    let text=m[3].trim(),names;
    const parenthetical=text.match(/^([^()]+)\s*\(or\s+([^()]+)\)$/i);
    if(parenthetical)names=[parenthetical[1],...parenthetical[2].split(/,|\bor\b/i)];
    else if(/\bor\b/i.test(text))names=text.split(/\bor\b/i);
    else if(text.includes('/')){
      names=text.split('/');
      const suffix=names.at(-1).trim().match(/\s+(oil)$/i)?.[1];
      if(suffix)names=names.map(n=>new RegExp('\\b'+suffix+'$','i').test(n.trim())?n:n.trim()+' '+suffix);
    }else return null;
    names=names.map(n=>n.trim()).filter(Boolean);
    if(names.length<2||names.length>4||names.some(n=>n.length>60||/[\d%/;()]/.test(n)||!/[a-z]/i.test(n))||new Set(names.map(recipeKey)).size!==names.length)return null;
    const options=names.map(name=>({id:recipeKey(name).replace(/ /g,'-'),title:name,name,preparation:'raw',amount,unit,evidence:line.trim()}));
    return {id:lineID(line.trim()),title:names.join(' or '),evidence:line.trim(),selected:'',options};
  }
  function planRows(input,text=''){
    const rows=(input||[]).map(clone),lines=String(text).split(/[\r\n]+/).map(s=>s.trim()).filter(Boolean);
    // Only explicit recipe-list headings open this scope. A pack's separate
    // ingredients/allergen declaration is not a list of alternative additions.
    const recipeHeading=/^(?:shopping list|ingredients(?: list)?|recipe ingredients|(?:what )?you(?: will|'ll|’ll) need)\s*:?$/i;
    const shopping=lines.findIndex(line=>recipeHeading.test(line));
    if(shopping<0)return rows;
    const section=lines.findIndex((line,i)=>i>shopping&&/^ingredients\s*(?:&|and)\s*allerg(?:ies|ens)\s*:?$/i.test(line));
    const end=lines.findIndex((line,i)=>i>shopping&&/^(?:ingredients\s*(?:&|and)\s*allerg(?:ies|ens)|method|instructions|directions|preparation|nutrition(?: information| facts)?|allerg(?:ies|ens)|storage|serving suggestions)\s*:?$/i.test(line));
    const shoppingLines=lines.slice(shopping+1,end<0?undefined:end);
    let planned=rows;
    for(const line of shoppingLines){
      const choice=parsedChoice(line);if(!choice)continue;
      if(shoppingLines.filter(other=>other===line).length!==1)continue;
      const existing=planned.find(r=>r.recipeChoice?.id===choice.id);
      if(existing)continue;
      const identities=new Set([...choice.options.map(o=>recipeKey(o.name)),recipeKey(line.replace(/^(?:[-•*]\s+)?\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l|tbs|tbsp|tsp|x)\s+/i,''))]);
      const indexes=planned.flatMap((r,i)=>identities.has(recipeKey(r.name))?[i]:[]);
      if(!indexes.length)continue;
      const first=indexes[0],used=new Set(indexes);
      planned=planned.flatMap((row,i)=>i===first?[{name:choice.title,preparation:'unknown',amount:null,unit:null,evidence:choice.evidence,recipeChoice:choice}]:used.has(i)?[]:[row]);
    }
    // The separately headed nested paste/sauce declaration describes the kit,
    // not thirty independently weighed additions. Preserve its full provenance
    // but keep one explicitly unquantified contribution in the recipe arithmetic.
    if(section>=0&&!planned.some(r=>r.recipeGroup==='kit')){
      const block=lines.slice(section+1).join(' '),nested=(block.match(/[^().]+\([^()]*\)/g)||[]);
      if(nested.length>=2&&/\b(?:paste|sauce|sachet)\b/i.test(block)){
        const words=' '+recipeKey(block)+' ';
        const indexes=planned.flatMap((r,i)=>!r.recipeChoice&&r.amount===null&&r.unit===null&&recipeKey(r.name)&&words.includes(' '+recipeKey(r.name)+' ')?[i]:[]);
        if(indexes.length>=2){const first=indexes[0],used=new Set(indexes);planned=planned.flatMap((r,i)=>i===first?[{name:'Recipe kit sauces and seasonings',preparation:'unknown',amount:null,unit:null,evidence:lines[section]+' '+block.slice(0,120),recipeGroup:'kit',recipeGroupEvidence:block}]:used.has(i)?[]:[r]);}
      }
    }
    return planned;
  }
  function rowComponent(row,original,recipe,text){
    const same=original&&recipeKey(original.recipeIngredient?.name||original.name)===recipeKey(row.name);
    const base=same?clone(original):{photoIndex:recipe.photoIndex,photoId:recipe.photoId||null,assumptions:[]};
    const measure=householdMeasure(row,text),printedGrams=row.unit==='g'?row.amount:row.unit==='kg'&&row.amount!==null?row.amount*1000:null;
    const grams=measure?.amountGrams??printedGrams??(same&&original.recipeIngredient?.amount===row.amount&&original.recipeIngredient?.unit===row.unit?original.amountGrams:null);
    let component={...base,name:row.name,preparation:row.preparation||'unknown',amountGrams:grams??null,amountSource:row.recipeChoiceSelection?'recipe_choice':'recipe_evidence',
      evidence:('Recipe photo '+recipe.photoIndex+': '+row.evidence).slice(0,160),recipeIngredient:clone(row),
      recordId:base.recordId||null,sourceRecord:base.sourceRecord||null,nutrients:base.nutrients||{},candidates:base.candidates||[],
      ...(row.recipeChoice?{recipeChoice:clone(row.recipeChoice)}:{}),...(row.recipeGroup?{recipeGroup:row.recipeGroup}:{})};
    if(measure)component={...component,recordId:measure.sourceRecord.id,sourceRecord:measure.sourceRecord,nutrients:measure.sourceRecord.nutrients,candidates:[],matchStatus:'matched',matchMethod:'recipe_household_measure',householdMeasure:measure.conversion,assumptions:[...(component.assumptions||[]),...measure.assumptions],
      ...(base.recordId&&base.recordId!==measure.sourceRecord.id?{recipeSourceRecovery:{reason:'Whole-source recipe estimate after printed quantity recovery',original:{recordId:base.recordId,sourceRecord:clone(base.sourceRecord),nutrients:clone(base.nutrients)}}}:{})};
    if(!component.recordId&&component.amountGrams>0&&root.NudgeMealRecovery?.recover){
      const found=root.NudgeMealRecovery.recover({name:row.name,portionMode:'estimated_serving',ingredients:[{name:row.name,evidence:component.evidence}],components:[component]});
      component=found.components[0];
    }
    return component;
  }
  function recover(meal,{confirmed=false,userEdited=false}={}){
    const recipe=meal?.recipeCalculation;
    if(confirmed||userEdited||meal?.userEdited||!recipe?.applied||recipe.userEdited||!Array.isArray(recipe.batchComponents)||recipe.batchComponents.some(c=>c.userEdited||c.amountSource==='confirmed'||c.matchMethod==='user_selected'))return meal;
    const originals=recipe.batchComponents.map(c=>c.recipeIngredient||{name:c.name,amount:null,unit:null,evidence:c.evidence});
    const recoveredRows=recoverIngredientRows(originals,meal.recipeEvidence?.text||''),rows=planRows(normaliseRows(recoveredRows),meal.recipeEvidence?.text||'');
    let changed=JSON.stringify(rows)!==JSON.stringify(originals);
    const batch=rows.map(row=>{
      const identities=recipe.batchComponents.filter(c=>recipeKey(c.recipeIngredient?.name||c.name)===recipeKey(row.name));
      const original=row.recipeChoice?.id?recipe.batchComponents.find(c=>c.recipeChoice?.id===row.recipeChoice.id):identities.find(c=>normal(c.recipeIngredient?.evidence||c.evidence)===normal(row.evidence))||(identities.length===1?identities[0]:null);
      // Existing sourced quantities and user choices are retained verbatim.
      if(original&&(original.recipeChoice?.selected||original.amountGrams>0&&original.recordId&&original.sourceRecord?.id===original.recordId))return clone(original);
      const component=rowComponent(row,original,recipe,meal.recipeEvidence?.text||'');
      if(original&&JSON.stringify(component)!==JSON.stringify(original)||!original)changed=true;
      const prior=originals.find(r=>recipeKey(r.name)===recipeKey(row.name));
      if(prior&&prior.evidence!==row.evidence)component.recipeEvidenceRecovery={version:EVIDENCE_RECOVERY_VERSION,original:clone(prior)};
      return component;
    });
    if(!changed)return meal;
    const candidate={...clone(meal),recipeCalculation:{...clone(recipe),batchComponents:batch,batchNutrients:root.NudgeComposition.total(batch),householdRecoveryVersion:HOUSEHOLD_VERSION}};
    return apply(candidate,recipe.servings,{source:recipe.fractionSource||'recipe',portionFraction:recipe.selectedFraction||1});
  }
  function selectChoice(meal,id,value,{confirmed=false}={}){
    const recipe=meal?.recipeCalculation;
    if(confirmed||!recipe?.applied||recipe.userEdited||meal.userEdited||typeof id!=='string'||typeof value!=='string')return meal;
    const index=recipe.batchComponents.findIndex(c=>c.recipeChoice?.id===id),current=recipe.batchComponents[index],choice=current?.recipeChoice;
    const option=choice?.options.find(o=>o.id===value);if(!choice||value&&!option)return meal;
    const selected={...clone(choice),selected:value},row=option?{...clone(option),recipeChoice:selected,recipeChoiceSelection:{choiceId:id,optionId:value,evidence:'User selected '+option.name}}:{name:choice.title,preparation:'unknown',amount:null,unit:null,evidence:choice.evidence,recipeChoice:selected};
    const result=clone(meal),batch=result.recipeCalculation.batchComponents;
    batch[index]=rowComponent(row,null,recipe,meal.recipeEvidence?.text||'');
    result.recipeCalculation.batchNutrients=root.NudgeComposition.total(batch);
    const names=new Set([...choice.options.map(o=>recipeKey(o.name)),recipeKey(choice.title),recipeKey(choice.evidence.replace(/^(?:[-•*]\s+)?\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l|tbs|tbsp|tsp|x)\s+/i,''))]);
    result.ingredients=(result.ingredients||[]).filter(i=>!names.has(recipeKey(i.name)));
    // The unchanged full choice quote remains in recipeIngredient. Do not put
    // unselected food names back into active ingredient/allergen/plant evidence.
    if(option)result.ingredients.push({name:option.name,evidence:'User selected '+option.name});
    const evidence=result.ingredients.map(i=>recipeKey(i.name+' '+i.evidence));
    result.plants=(result.plants||[]).filter(p=>evidence.some(e=>e.includes(recipeKey(p.evidence||p.name))));
    const proteinGroups=new Set(batch.filter(c=>c.amountGrams>0&&c.recordId===c.sourceRecord?.id).map(c=>({poultry:'poultry_egg',egg:'poultry_egg',fish:'fish',red_meat:'red_meat',processed_meat:'processed_meat',legume:'plant'}[c.sourceRecord?.foodGroup])).filter(Boolean));
    result.qualityEstimate={proteinType:proteinGroups.size===1?[...proteinGroups][0]:'unknown',confidence:'low',evidence:'Protein type reflects the currently selected source-backed ingredients. Printed alternatives are not simultaneous ingredients.'};
    delete result.scoreSnapshot;delete result.recovery;delete result.compoundProposal;
    return apply(result,recipe.servings,{source:recipe.fractionSource||'recipe',portionFraction:recipe.selectedFraction||1});
  }
  const api={VERSION,HOUSEHOLD_VERSION,EVIDENCE_RECOVERY_VERSION,validServings,validFraction,apply,householdMeasure,normaliseRows,recoverIngredientRows,planRows,selectChoice,recover};root.NudgeRecipeComposition=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window==='object'?window:globalThis);
