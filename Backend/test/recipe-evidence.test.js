import {afterEach,test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import worker,{nutrientKeys} from '../src/worker.js';
import {validateRecipeEvidence,prepareRecipeCalculation,correctRecipeAttribution,needsRecipeEvidenceRecheck,recipeCoverage,mergeRecipeRecheck,recipeEvidenceSchema} from '../src/recipe-evidence.js';
import {bindPhotoEvidence,outputSchemaIssue,matchesOutputSchema} from '../src/photo-evidence.js';
import {recipeMeasure} from '../src/recipe-measures.js';

const clone=v=>structuredClone(v),empty=()=>Object.fromEntries(nutrientKeys.map(k=>[k,null]));
const source={id:'synthetic:cabbage',basis:'per100g',nutrients:Object.fromEntries(nutrientKeys.map(k=>[k,{value:k==='energyKcal'?20:1,unit:k==='energyKcal'?'kcal':'g'}]))};
const component=(name,grams)=>({name,preparation:'cooked',amountGrams:grams,evidence:'Visible '+name,photoIndex:1,assumptions:[]});
const recipe=()=>({photoIndex:2,text:'Serves 4\n100 g butter\n50 g plain flour\n400 g haddock\n0.8 kg potatoes\n4 eggs\n570 ml milk',servings:4,servingsEvidence:'Serves 4',servingsPhotoIndex:2,componentIndexes:[0,1],ingredients:[
  {name:'butter',preparation:'raw',amount:100,unit:'g',evidence:'100 g butter'},
  {name:'plain flour',preparation:'dry',amount:50,unit:'g',evidence:'50 g plain flour'},
  {name:'haddock',preparation:'raw',amount:400,unit:'g',evidence:'400 g haddock'},
  {name:'potatoes',preparation:'raw',amount:.8,unit:'kg',evidence:'0.8 kg potatoes'},
  {name:'eggs',preparation:'raw',amount:4,unit:'count',evidence:'4 eggs'},
  {name:'milk',preparation:'unknown',amount:570,unit:'ml',evidence:'570 ml milk'}]});
const meal=()=>({name:'Fish pie with cabbage',portionMode:'estimated_serving',components:[component('fish pie filling',400),component('mashed potato topping',300),{...component('cabbage',150),recordId:source.id,sourceRecord:source,nutrients:source.nutrients}],ingredients:[],plants:[],recipeEvidence:recipe()});

test('schema diagnostics report only schema paths and reason enums through nullable objects and arrays',()=>{
  assert.equal(outputSchemaIssue(recipe(),recipeEvidenceSchema),null);assert.equal(outputSchemaIssue(null,recipeEvidenceSchema),null);
  const cases=[
    [r=>{r.ingredients[4].amount=0;},'$.ingredients[4].amount','minimum'],
    [r=>{r.ingredients[4].unit='secret invented unit';},'$.ingredients[4].unit','enum'],
    [r=>{r.ingredients[4].evidence='x'.repeat(161);},'$.ingredients[4].evidence','max_length'],
    [r=>{r.text='<private>secret</private>';},'$.text','markup'],
    [r=>{r.text='private\u0001secret';},'$.text','control_character'],
    [r=>{delete r.ingredients[4].name;},'$.ingredients[4].name','missing_field'],
    [r=>{r['PRIVATE_FOOD_NAME']=true;},'$','unexpected_field'],
    [r=>{r.componentIndexes[0]=40;},'$.componentIndexes[0]','maximum']
  ];
  for(const [modify,path,reason] of cases){const r=recipe();modify(r);const issue=outputSchemaIssue(r,recipeEvidenceSchema);assert.deepEqual(issue,{path,reason,...(reason==='control_character'?{codePoint:1}:{})});assert.equal(matchesOutputSchema(r,recipeEvidenceSchema),false);assert.doesNotMatch(JSON.stringify(issue),/private|secret|butter|egg/i);}
  const nullable=recipe();nullable.ingredients[0].amount=null;nullable.ingredients[0].unit=null;
  assert.equal(outputSchemaIssue(nullable,recipeEvidenceSchema),null,'ordinary missing quantities satisfy the nullable schema');
});

test('recipe OCR page and line whitespace is normalized consistently, while other controls remain rejected',()=>{
  for(const character of ['\u000B','\u000C']){
    const r=recipe();r.text=r.text.replaceAll('\n',character).replace('100 g butter','100 g'+character+'butter');r.ingredients[0].evidence='100 g'+character+'butter';
    const original=clone(r),result=validateRecipeEvidence(r,meal().components);
    assert.deepEqual(r,original,'the supplied observation is not mutated');
    assert.equal(result.ingredients[0].amount,100);assert.equal(result.ingredients[0].evidence,'100 g\nbutter');
    assert.ok(!result.text.includes(character));assert.equal(result.servings,4);
  }
  for(const control of ['\u0000','\u0001','\u001B','\u001F']){
    const r=recipe(),issues=[];r.text+=control;
    assert.equal(validateRecipeEvidence(r,meal().components,()=>{},issue=>issues.push(issue)),null);
    assert.deepEqual(issues,[{path:'$.recipeEvidence.text',reason:'control_character',codePoint:control.charCodeAt(0)}]);
  }
});

test('whole recipe replaces filling/topping once and selected fractions preserve sides independently',()=>{
  const input=meal(),before=clone(input),result=prepareRecipeCalculation(input);
  assert.deepEqual(input,before);assert.equal(result.recipeCalculation.applied,true);assert.equal(result.recipeCalculation.servings,4);
  assert.deepEqual(result.components.map(c=>c.name),['butter','plain flour','haddock','potatoes','eggs','milk','cabbage']);
  const milkGrams=570*30.5/29.573;
  assert.deepEqual(result.components.filter((c,i)=>i!==5).map(c=>c.amountGrams),[100,50,400,800,200,150]);assert.ok(Math.abs(result.components[5].amountGrams-milkGrams)<1e-9);assert.equal(result.recipeCalculation.selectedFraction,1);
  assert.equal(result.portion.amount,null);assert.equal(result.portion.unit,null);assert.equal(result.portionAmbiguity.requiresSelection,false);
  assert.ok(result.nutrients.energyKcal.knownSubtotal>30);assert.ok(result.nutrients.protein.knownSubtotal>1.5);
  assert.ok(result.nutrients.energyKcal.value>0);assert.equal(result.recipeCalculation.status,'incomplete','Unknown trace values and incompatible carbohydrate definitions remain incomplete');
  assert.deepEqual(result.recipeCalculation.unsupportedAmounts,[]);
  const changed=globalThis.NudgeRecipeComposition.apply(result,4,{source:'user',portionFraction:.125});
  assert.deepEqual(changed.components.filter((c,i)=>i!==5).map(c=>c.amountGrams),[12.5,6.25,50,100,25,150]);assert.ok(Math.abs(changed.components[5].amountGrams-milkGrams/8)<1e-9);
  assert.equal(changed.components.length,7);assert.equal(changed.recipeCalculation.fractionSource,'user');assert.equal(changed.recipeCalculation.servings,4);
  assert.equal(globalThis.NudgeRecipeComposition.apply({...changed,recipeCalculation:{...changed.recipeCalculation,userEdited:true}},4,{portionFraction:1}).recipeCalculation.selectedFraction,.125);
});

test('household estimates use food-specific USDA rows and retain quantities, units and uncertainty',()=>{
  const amount=(name,preparation,n,unit,evidence)=>recipeMeasure({name,preparation,amount:n,unit,evidence});
  const milk=amount('milk','unknown',570,'ml','570 ml milk');
  assert.ok(milk.amountGrams>570);assert.equal(milk.conversion.sourcePortionId,'90103');assert.equal(milk.sourceRecord.id,'12-596:d379c671eb80');assert.equal(milk.conversion.sourceFoodId,'usda:172217');assert.equal(milk.conversion.nutrientSourceId,milk.sourceRecord.id);
  assert.equal(amount('milk','hot',8,'tbsp','8 tbsp hot milk').amountGrams,120);
  assert.equal(amount('eggs','hard-boiled',4,'count','4 hard-boiled eggs').amountGrams,200);
  assert.equal(amount('eggs','hard-boiled',4,'count','4 hard-boiled eggs').sourceRecord.id,'12-940:dbad4525e00a');
  assert.equal(amount('onion','raw',1,'count','1 large onion').amountGrams,150);
  assert.equal(amount('lemon juice','raw',2,'tbsp','2 tbsp lemon juice').amountGrams,30.5);
  for(const [name,prep,unit,evidence,id]of [['milk','unknown','ml','570 ml milk','12-596:d379c671eb80'],['eggs','raw','count','4 eggs','12-937:bf53bb737a77'],['eggs','hard-boiled','count','4 hard-boiled eggs','12-940:dbad4525e00a'],['onion','raw','count','1 large onion','13-499:d5aa37187733'],['lemon juice','raw','tbsp','2 tbsp lemon juice','14-277:d57cfcbea0f8']]){
    const match=amount(name,prep,1,unit,evidence);assert.equal(match.sourceRecord.id,id);assert.equal(match.sourceRecord.carbohydrateDefinition,'available');assert.equal(match.sourceRecord.source,'UK CoFID');assert.match(match.conversion.sourceFoodId,/^usda:/);assert.equal(match.conversion.nutrientSourceId,id);
  }
  assert.equal(amount('milk','UHT',570,'ml','570 ml whole UHT milk').sourceRecord.id,'12-320:012eba70ce95');
  assert.equal(amount('raw milk','unknown',570,'ml','570 ml raw milk'),null,'Do not replace explicitly unpasteurised milk with pasteurised composition');
  assert.equal(amount('eggs','hard-boiled',4,'count','4 hard-boiled eggs').sourceRecord.nutrients.carbohydrate.status,'trace');
  for(const [name,preparation,unit,evidence] of [['almond milk','unknown','ml','100 ml almond milk'],['semi-skimmed milk','unknown','ml','100 ml semi-skimmed milk'],['eggs','fried','count','2 fried eggs'],['onion','fried','count','1 fried onion'],['bottled lemon juice','unknown','tbsp','2 tbsp bottled lemon juice']])assert.equal(amount(name,preparation,100,unit,evidence),null,name);
  assert.equal(recipeMeasure({name:'milk',preparation:'unknown',amount:570,unit:'ml',evidence:'570 ml milk'},'Vegan recipe; use dairy-free milk'),null);
});

test('representative fish-pie recipe calculates useful whole-dish energy and protein with explicit household estimates',()=>{
  const rows=[['butter','raw',75,'g','75 g butter'],['onion','raw',1,'count','1 large onion'],['plain flour','dry',50,'g','50 g plain flour'],
    ['milk','unknown',570,'ml','570 ml milk'],['lemon juice','raw',2,'tbsp','2 tbsp lemon juice'],['haddock','raw',350,'g','350 g fresh haddock'],
    ['smoked haddock','raw',350,'g','350 g smoked haddock'],['eggs','hard-boiled',4,'count','4 hard-boiled eggs'],['potatoes','raw',900,'g','900 g potatoes'],
    ['butter','raw',50,'g','50 g butter'],['milk','hot',8,'tbsp','8 tbsp hot milk']].map(([name,preparation,amount,unit,evidence])=>({name,preparation,amount,unit,evidence}));
  const input=meal();input.recipeEvidence={...recipe(),text:'Serves 4\n'+rows.map(r=>r.evidence).join('\n'),ingredients:rows};
  const original=clone(input),result=prepareRecipeCalculation(input),batch=result.recipeCalculation.batchNutrients;
  assert.deepEqual(input,original);
  // Pinned whole-record arithmetic, including explicitly raw smoked haddock
  // (83 kcal and 19.7 g protein / 100 g), not a preferred nutritional outcome.
  assert.ok(Math.abs(batch.energyKcal.value-3138.591406181314)<1e-8);
  assert.ok(Math.abs(batch.protein.value-208.85898858756298)<1e-8);
  assert.equal(result.recipeCalculation.batchComponents[6].recordId,'16-492:d35747a63193');
  assert.equal(result.recipeCalculation.batchComponents.filter(c=>c.householdMeasure).length,5);
  assert.equal(result.recipeCalculation.batchComponents[3].recipeIngredient.amount,570);
  assert.equal(result.recipeCalculation.batchComponents[3].recipeIngredient.unit,'ml');
  assert.equal(result.recipeCalculation.batchComponents[7].householdMeasure.sourcePortionId,'92500');
  const quarter=globalThis.NudgeRecipeComposition.apply(result,4,{source:'user',portionFraction:.25});
  assert.ok(Math.abs(quarter.nutrients.energyKcal.value-(batch.energyKcal.value/4+30))<1e-8);
  assert.equal(quarter.components.at(-1).amountGrams,150);assert.equal(quarter.portion.amount,null);
});

test('missing yield still calculates the whole recipe and supports an explicit fraction without a serving count',()=>{
  const input=meal();input.recipeEvidence.servings=null;input.recipeEvidence.servingsEvidence=null;
  const result=prepareRecipeCalculation(input);
  assert.equal(result.recipeCalculation.status,'incomplete');assert.equal(result.recipeCalculation.applied,true);assert.equal(result.recipeCalculation.selectedFraction,1);
  assert.deepEqual(result.recipeCalculation.originalPlateComponents,input.components);assert.equal(result.recipeCalculation.batchComponents[3].amountGrams,800);assert.equal(result.components[3].amountGrams,800);
  assert.equal(result.portionAmbiguity.requiresSelection,false);assert.match(result.message,/Select how much you ate/);assert.equal(result.recipeCalculation.servings,null);
  const edited=globalThis.NudgeRecipeComposition.apply(result,null,{source:'user',portionFraction:.25});
  assert.equal(edited.components[0].amountGrams,25);assert.equal(edited.components.at(-1).amountGrams,150);
});

test('an unusable recipe does not overwrite a separately sourced visual portion estimate',()=>{
  const input=meal();input.components=[{...component('cabbage',150),recordId:source.id,sourceRecord:source,nutrients:source.nutrients}];
  input.recipeEvidence={...recipe(),componentIndexes:[0],text:'salt to taste',servings:null,servingsEvidence:null,servingsPhotoIndex:null,ingredients:[{name:'salt',preparation:'unknown',amount:null,unit:null,evidence:'salt to taste'}]};
  const result=prepareRecipeCalculation(input);
  assert.equal(result.recipeCalculation.applied,false);assert.match(result.recipeCalculation.deferredReason,/photo portion estimate is retained/);
  assert.deepEqual(result.components,input.components);assert.equal(result.recipeCalculation.batchNutrients.energyKcal.knownContributions,0);
});

test('printed yield can belong to a different submitted recipe page without implying consumed amount',()=>{
  const input=meal();input.recipeEvidence.servingsPhotoIndex=1;
  const result=bindPhotoEvidence({type:'meal',meal:prepareRecipeCalculation(input)},{images:[{},{}],photoIds:['yield-page','ingredients-page']});
  assert.equal(result.meal.recipeEvidence.servingsPhotoId,'yield-page');assert.equal(result.meal.recipeEvidence.photoId,'ingredients-page');
  assert.equal(result.meal.recipeCalculation.selectedFraction,1);assert.equal(result.meal.portion.label,'Whole recipe');assert.equal(result.meal.portion.amount,null);
  input.recipeEvidence.servingsPhotoIndex=3;
  assert.throws(()=>bindPhotoEvidence({type:'meal',meal:prepareRecipeCalculation(input)},{images:[{},{}]}),/yield photo reference/);
});

test('recipe validation rejects unsupported quantities, identities, yield ranges and indexes while keeping valid evidence',()=>{
  for(const modify of [r=>{r.servingsEvidence='4 eggs';},r=>{r.servings=8;},r=>{r.servingsEvidence='Serves 4–6';r.text+='\nServes 4–6';}]){
    const r=recipe();modify(r);assert.equal(validateRecipeEvidence(r,meal().components).servings,null);
  }
  for(const modify of [r=>{r.ingredients[0].amount=250;},r=>{r.ingredients[0].evidence='100 g sugar';},r=>{r.ingredients[0].name='olive oil';}]){
    const r=recipe();modify(r);assert.equal(validateRecipeEvidence(r,meal().components).ingredients[0].amount,null);
  }
  const duplicate=recipe();duplicate.componentIndexes=[0,0];assert.equal(validateRecipeEvidence(duplicate,meal().components),null);
  const outside=recipe();outside.componentIndexes=[3];assert.equal(validateRecipeEvidence(outside,meal().components),null);
});

test('matching photo attribution can relink an exact scalar quote without borrowing another food or photo',()=>{
  const check=(evidence,amount=425,name='potatoes')=>{
    const input=recipe();input.text='425 g potatoes';input.ingredients=[{name,preparation:'raw',amount,unit:'g',evidence}];
    return validateRecipeEvidence(input,meal().components).ingredients[0];
  };
  for(const prefix of ['Recipe photo 2: ','PHOTO 2: ']){
    const row=check(prefix+'425 g potatoes');assert.equal(row.amount,425);assert.equal(row.evidence,'425 g potatoes');
  }
  for(const evidence of ['Recipe photo 1: 425 g potatoes','User described: 425 g potatoes','Recipe photo 2: approximately 425 g potatoes']){
    assert.equal(check(evidence).amount,null,evidence);
  }
  assert.equal(check('Recipe photo 2: 425 g potatoes',250).amount,null,'A quote prefix cannot repair a contradictory supplied quantity');
  const input=recipe();input.text='300 ml coconut milk';input.ingredients=[{name:'milk',preparation:'unknown',amount:300,unit:'ml',evidence:'Recipe photo 2: 300 ml coconut milk'}];
  assert.equal(validateRecipeEvidence(input,meal().components).ingredients[0].amount,null,'A milk token must not stand in for coconut milk');
  for(const text of ['425 g potatoes','425 g potatoes\n425 g potatoes']){
    const duplicate=recipe();duplicate.text=text;duplicate.ingredients=Array.from({length:text.includes('\n')?1:2},()=>({name:'potatoes',preparation:'raw',amount:425,unit:'g',evidence:'Recipe photo 2: 425 g potatoes'}));
    assert.ok(validateRecipeEvidence(duplicate,meal().components).ingredients.every(row=>row.amount===null),'Attribution repair must not reuse or arbitrarily select repeated printed quantities');
  }
});

test('legacy rejected shopping-list rows recover only unique explicit lines and retain partial nutrition',()=>{
  const input=meal(),sentinel='Recipe ingredient could not be linked to the printed text.';
  input.recipeEvidence={photoIndex:2,text:'Shopping list\n - 250g carrots\n - 125g onions (approx qty 2-3)\n - 500g chicken (or tofu)\n - 2 tbs olive/rapeseed oil\nIngredients and allergies\nSeasoning (salt, sugar).',
    servings:null,servingsEvidence:null,componentIndexes:[0,1],ingredients:['carrots','onions','chicken','tofu','olive oil','salt'].map(name=>({name,preparation:'raw',amount:null,unit:null,evidence:sentinel}))};
  const before=clone(input),result=prepareRecipeCalculation(input),rows=result.recipeEvidence.ingredients;
  assert.deepEqual(input,before,'Recovery is a projection, not a mutation of retained source evidence');
  assert.deepEqual(rows.map(row=>row.amount),[250,125,null,null,null,null]);
  assert.equal(rows[0].evidence,'- 250g carrots');assert.equal(rows[1].evidence,'- 125g onions (approx qty 2-3)');
  assert.equal(result.recipeCalculation.servings,null,'A shopping list never establishes yield');
  assert.equal(result.recipeCalculation.batchComponents[0].amountGrams,250);
  assert.ok(result.recipeCalculation.batchNutrients.protein.knownSubtotal>0);
  assert.ok(result.recipeCalculation.batchNutrients.protein.unknownContributions>0,'Unselected alternatives and unquantified seasoning remain incomplete');
});

test('printed list markers retain exact quantities without admitting negative amounts or ranges',()=>{
  const check=evidence=>{const r=recipe();r.text=evidence;r.ingredients=[{name:'carrots',preparation:'raw',amount:250,unit:'g',evidence}];return validateRecipeEvidence(r,meal().components).ingredients[0];};
  for(const evidence of ['- 250g carrots',' • 250 g carrots','* 250 g carrots']){
    const row=check(evidence);assert.equal(row.amount,250);assert.equal(row.evidence,evidence);
  }
  for(const evidence of ['-250g carrots','−250 g carrots','- -250 g carrots','- 250–300 g carrots','- 200–250 g carrots'])assert.equal(check(evidence).amount,null,evidence);
});

test('recipe relinking rejects ranges, packs, repeated rows, alternatives, percentages and unrelated identities',()=>{
  const sentinel='Recipe ingredient could not be linked to the printed text.';
  function check(text,names){const r=recipe();r.text=text;r.ingredients=names.map(name=>({name,preparation:'raw',amount:null,unit:null,evidence:sentinel}));return validateRecipeEvidence(r,meal().components).ingredients;}
  for(const [text,names] of [
    ['100–200 g carrots',['carrots']],['-100 g carrots',['carrots']],['2 x 400 g tomatoes',['tomatoes']],
    ['100 g butter and 50 g butter',['butter']],['300 ml coconut milk',['milk']],['200 g chicken stock',['chicken']],
    ['100 g butter',['butter','butter']],['100 g butter\n50 g butter',['butter']],
    ['200 g chicken or tofu',['chicken','tofu']],['2 tbsp olive/rapeseed oil',['olive oil']],['100 g tomato sauce (salt 20%)',['salt']]
  ])assert.ok(check(text,names).every(row=>row.amount===null&&row.unit===null),text);
  const exact=recipe();exact.text='200 g chicken or tofu';exact.ingredients=['chicken','tofu'].map(name=>({name,preparation:'raw',amount:200,unit:'g',evidence:exact.text}));
  assert.ok(validateRecipeEvidence(exact,meal().components).ingredients.every(row=>row.amount===null),'Even exact quotes cannot select both alternatives');
  for(const evidence of ['2 tbs olive/rapeseed oil','2 tbs olive oil or butter']){
    const choice=recipe();choice.text=evidence;choice.ingredients=[{name:'olive oil',preparation:'raw',amount:2,unit:'tbsp',evidence}];
    const result=validateRecipeEvidence(choice,meal().components).ingredients[0];
    assert.equal(result.amount,null,'Legacy tbs normalization must not restore a rejected alternative');assert.equal(result.unit,null);
  }
  const mismatch=recipe();mismatch.text='2 tbs olive oil';mismatch.ingredients=[{name:'olive oil',preparation:'raw',amount:3,unit:'tbsp',evidence:mismatch.text}];
  const rejected=validateRecipeEvidence(mismatch,meal().components).ingredients[0];
  assert.equal(rejected.amount,null,'Backend normalization cannot replace a contradictory supplied quantity with the printed one');assert.equal(rejected.unit,null);
  const r=recipe(),diagnostics=[];r.ingredients[0].evidence='A descriptive caption';validateRecipeEvidence(r,meal().components,()=>{},issue=>diagnostics.push(issue));
  assert.deepEqual(diagnostics,[{path:'$.recipeEvidence.ingredients[0].evidence',reason:'quote_not_in_text'}]);
  assert.doesNotMatch(JSON.stringify(diagnostics),/butter|caption/,'Diagnostics describe the guard, never private ingredient text');
});

test('printed recipe fractions and mixed numbers preserve exact amounts without accepting ranges or mismatches',()=>{
  const validate=(printed,amount,unit='tbsp',name='lemon juice')=>{
    const r=recipe(),evidence=printed+(unit==='count'?' ':' '+unit+' ')+name;
    r.text='Serves 4\n'+evidence;r.ingredients=[{name,preparation:'raw',amount,unit,evidence}];
    return validateRecipeEvidence(r,meal().components).ingredients[0];
  };
  for(const [printed,amount] of [['½',.5],['1/2',.5],['1⁄2',.5],['¼',.25],['¾',.75],['⅛',.125],['⅜',.375],['⅝',.625],['⅞',.875],['⅓',1/3],['⅔',2/3],['1½',1.5],['1 ½',1.5],['1 1/2',1.5],['2 3/4',2.75],['0.5',.5],['.5',.5],['0,5',.5]]){
    const result=validate(printed,amount);assert.equal(result.amount,amount,printed);assert.equal(result.unit,'tbsp',printed);
  }
  assert.equal(validate('½',.5,'count','onion').amount,.5);
  assert.equal(validate('1½',1.5,'kg','potatoes').amount,1.5);
  for(const [printed,amount] of [['½',1],['1/2',2],['1½',.5],['1 1/2',.5],['¼',.5],['1/0',1],['½–1',1],['½–1',.5],['1/2 to 1',1],['1/2 to 1',.5],['½ tbsp–1',.5],['½ tbsp to 1',1],['between ½ and 1',1],['−½',.5],['-0.5',.5]]){
    assert.equal(validate(printed,amount).amount,null,printed+' must not support '+amount);
  }
});

test('recipe retries preserve exact batch identities after alternatives collapse and raw rows reorder',()=>{
  const ingredients=[['chicken',500,'g','500g chicken or tofu'],['tofu',500,'g','500g chicken or tofu'],['carrots',100,'g','100g carrots'],['potatoes',200,'g','200g potatoes'],['red bell pepper',1,'count','1x red bell pepper']].map(([name,amount,unit,evidence])=>({name,preparation:'raw',amount,unit,evidence}));
  const input=meal();input.recipeEvidence={...recipe(),text:'Shopping list\n500g chicken or tofu\n100g carrots\n200g potatoes\n1x red bell pepper',servings:null,servingsEvidence:null,servingsPhotoIndex:null,ingredients};
  const firstInput=clone(input);firstInput.recipeEvidence.ingredients[4].amount=2;
  const first={type:'meal',meal:prepareRecipeCalculation(firstInput)};
  first.meal.recipeCalculation.batchComponents.find(c=>c.name==='carrots').sourceRetentionMarker='original';
  const nextInput=clone(input);nextInput.recipeEvidence.ingredients=[ingredients[0],ingredients[1],ingredients[3],ingredients[2],ingredients[4]];
  const next={type:'meal',meal:prepareRecipeCalculation(nextInput)},before=clone(first),merged=mergeRecipeRecheck(first,next);
  assert.notEqual(merged,first);assert.deepEqual(first,before);
  const batch=merged.meal.recipeCalculation.batchComponents;
  assert.deepEqual(batch.map(c=>c.name),['chicken or tofu','potatoes','carrots','red bell pepper']);
  assert.equal(batch[0].amountGrams,null);assert.equal(batch[0].recipeChoice.selected,'');
  assert.equal(batch[1].amountGrams,200);assert.equal(batch[2].amountGrams,100);assert.equal(batch[2].sourceRetentionMarker,'original');
  assert.equal(batch[3].amountGrams,119);assert.equal(batch[3].recordId,'usda:170108');
  assert.equal(batch.filter(c=>c.name==='potatoes').length,1,'A raw-row index cannot copy potato nutrition onto the pepper');
});

test('fresh recipe calculations recognize explicit ingredient-list headings without selecting alternatives',()=>{
  for(const heading of ['Ingredients','Recipe ingredients:','You will need','What you’ll need']){
    const input=meal();input.recipeEvidence={...recipe(),text:heading+'\n500g chicken or tofu',servings:null,servingsEvidence:null,servingsPhotoIndex:null,ingredients:['chicken','tofu'].map(name=>({name,preparation:'raw',amount:500,unit:'g',evidence:'500g chicken or tofu'}))};
    const result=prepareRecipeCalculation(input),batch=result.recipeCalculation.batchComponents;
    assert.equal(batch.length,1,heading);assert.equal(batch[0].recipeChoice.selected,'');assert.equal(batch[0].amountGrams,null);
    assert.deepEqual(batch[0].recipeChoice.options.map(o=>o.id),['chicken','tofu']);
    assert.ok(result.recipeEvidence.ingredients.every(row=>row.amount===null),'A printed choice is not evidence of two consumed foods');
  }
});

test('summary text invalidates unanchored amounts and requests one targeted recipe recheck',()=>{
  const input=meal();input.recipeEvidence.text='Ingredients list from BBC recipe by Mary Berry for fish pie with topping and filling quantities';
  const result=prepareRecipeCalculation(input),extraction={type:'meal',meal:result};
  assert.equal(needsRecipeEvidenceRecheck(extraction),true);
  assert.deepEqual(recipeCoverage(result),{quantities:0,contributions:0});
  assert.ok(result.recipeEvidence.ingredients.every(row=>row.amount===null&&row.unit===null));
  assert.ok(result.recipeCalculation.batchComponents.every(c=>c.amountGrams===null));
  const good=meal();good.recipeEvidence.text+='\nsalt and black pepper';good.recipeEvidence.ingredients.push({name:'salt and black pepper',preparation:'dry',amount:null,unit:null,evidence:'salt and black pepper'});
  const ready=prepareRecipeCalculation(good);
  assert.equal(needsRecipeEvidenceRecheck({type:'meal',meal:ready}),false,'to-taste ingredients are legitimately unquantified');
  assert.equal(ready.recipeCalculation.batchComponents.at(-1).amountGrams,null);
});

test('recipe recheck accepts only increased evidenced coverage and preserves valid quantities, sources and separate sides',()=>{
  const input=meal();input.recipeEvidence.ingredients[1].amount=500;
  const first={type:'meal',meal:prepareRecipeCalculation(input)};
  const secondInput=meal();secondInput.components[2].amountGrams=900;
  const second={type:'meal',meal:prepareRecipeCalculation(secondInput)},merged=mergeRecipeRecheck(first,second);
  assert.notEqual(merged,first);assert.equal(merged.meal.components.at(-1).amountGrams,150);
  assert.deepEqual(merged.meal.recipeCalculation.batchComponents[0],first.meal.recipeCalculation.batchComponents[0]);
  const dropped=meal();dropped.recipeEvidence.ingredients.splice(1,1);
  assert.equal(mergeRecipeRecheck(first,{type:'meal',meal:prepareRecipeCalculation(dropped)}),first);
  const changed=meal();changed.recipeEvidence.ingredients[0].amount=200;changed.recipeEvidence.ingredients[0].evidence='200 g butter';changed.recipeEvidence.text=changed.recipeEvidence.text.replace('100 g butter','200 g butter');
  assert.equal(mergeRecipeRecheck(first,{type:'meal',meal:prepareRecipeCalculation(changed)}),first);
  assert.equal(mergeRecipeRecheck(first,first),first);
});

test('recipe evidence photo indexes bind to actual submitted images and cannot impersonate voice',()=>{
  const prepared=prepareRecipeCalculation(meal()),result=bindPhotoEvidence({type:'meal',meal:prepared},{images:[{},{}],photoIds:['plate','recipe']});
  assert.equal(result.meal.recipeEvidence.photoId,'recipe');assert.ok(result.meal.recipeCalculation.batchComponents.every(c=>c.photoId==='recipe'));
  assert.equal(result.meal.components.at(-1).photoId,'plate');
  assert.throws(()=>bindPhotoEvidence({type:'meal',meal:prepareRecipeCalculation(meal())},{images:[{}]}),/photo reference/);
  const extraction={type:'meal',meal:{...meal(),ingredients:[{name:'butter',evidence:'User described: 100 g butter'},{name:'pepper',evidence:'User described: pepper'}]}};
  correctRecipeAttribution(extraction,false);assert.match(extraction.meal.ingredients[0].evidence,/^Recipe photo 2:/);assert.doesNotMatch(JSON.stringify(extraction),/User described:/);
});

const token='87'.repeat(32),photo={mimeType:'image/jpeg',imageBase64:readFileSync(new URL('./fixtures/blank.jpg',import.meta.url)).toString('base64')};
function observation(){const m=meal();delete m.components[2].recordId;delete m.components[2].sourceRecord;delete m.components[2].nutrients;return {type:'meal',metadata:null,photoConsistency:'sameMeal',productName:null,brand:null,servingSuggestion:null,categoryTag:null,retailer:null,labelKind:'unreadable',ingredients:null,basis:'unknown',energyKj:null,nutritionPreparation:'unknown',servingSize:null,needsClearerPhoto:false,message:'',nutrients:empty(),meal:{...m,basis:'perPortion',estimated:true,needsReview:true,qualityEstimate:null,subject:{kind:'plated_meal',description:'Plate of fish pie and cabbage',photoIndex:1},portionAmbiguity:{requiresSelection:false,reason:'Editable portion.'},portion:{label:'1 portion',amount:850,unit:'g',source:'estimated'},nutrients:empty(),message:''}};}
afterEach(()=>mock.restoreAll());
const environment=()=>({OPENAI_API_KEY:'private-test-key',OPENAI_MODEL:'gpt-4.1-mini',PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),LABEL_QUOTA:{idFromName:v=>v,get:()=>({fetch:async()=>Response.json({allowed:true})})}});
const request=()=>new Request('https://nudge.example/v1/nutrition-label/analyse',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({images:[photo,photo]})});
const output=value=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});

test('legitimate OCR line/page whitespace no longer spends a second analysis request',async()=>{
  const input=observation();input.meal.recipeEvidence.text=input.meal.recipeEvidence.text.replaceAll('\n','\u000C');
  let calls=0;mock.method(globalThis,'fetch',async()=>{calls++;return output(input);});
  const response=await worker.fetch(request(),environment()),result=await response.json();
  assert.equal(response.status,200);assert.equal(calls,1);assert.equal(result.trace.automaticRecheck,false);
  assert.deepEqual(result.trace.recipeWhitespaceNormalized,['form_feed']);assert.equal(result.extraction.meal.recipeCalculation.batchComponents.length,6);
  assert.ok(result.extraction.meal.nutrients.energyKcal.knownSubtotal>0);
});

test('photo endpoint repairs a summary instead of ingredient text with one recipe-only OCR pass',async()=>{
  const bad=observation();bad.meal.recipeEvidence.text='Ingredients list from BBC recipe by Mary Berry for fish pie with topping and filling quantities';
  bad.meal.recipeEvidence.ingredients[0].name='butter topping';
  const calls=[];mock.method(globalThis,'fetch',async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(init.body);calls.push(body);return output(calls.length===1?bad:{components:observation().meal.components,recipeEvidence:recipe()});});
  const response=await worker.fetch(request(),environment()),result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));assert.equal(calls.length,2);assert.equal(result.trace.upstreamCallCount,2);
  assert.equal(result.trace.recheckReason,'validation_invalid');assert.equal(result.trace.recheckOutcome,'recovered');
  assert.equal(calls[1].text.format.schema.type,'object');assert.deepEqual(calls[1].text.format.schema.required,['components','recipeEvidence']);
  assert.match(calls[1].instructions,/VERBATIM/);assert.match(calls[1].instructions,/peeled\/chopped potatoes are raw/);
  assert.match(calls[0].instructions,/In recipeEvidence.ingredients only, never prefix quotes/);
  assert.match(calls[1].instructions,/In recipeEvidence.ingredients never prefix the quote/);
  assert.equal(calls[0].temperature,0);assert.equal(calls[1].temperature,0);
  assert.match(calls[0].instructions,/shop or recipe website hero image is an illustration/);
  assert.match(calls[0].instructions,/not separately weighed cooking additions/);
  assert.match(calls[1].text.format.schema.properties.recipeEvidence.anyOf[0].properties.text.description,/NEVER a summary/);
  assert.equal(recipeCoverage(result.extraction.meal).quantities,6);assert.ok(recipeCoverage(result.extraction.meal).contributions>0);
  assert.ok(result.extraction.meal.nutrients.energyKcal.knownSubtotal>0);assert.ok(result.extraction.meal.nutrients.protein.knownSubtotal>0);
  assert.equal(result.extraction.meal.components.at(-1).amountGrams,150);assert.equal(result.extraction.meal.recipeCalculation.selectedFraction,1);
  assert.equal(result.extraction.analysisVersion,'nudge-analysis-2026-10-11-recipe-review-v22');
  assert.ok(JSON.stringify(result.extraction).length<240000);
});

test('photo endpoint repairs a discarded recipe mapping and copied batch ingredients, restoring a visual side once',async()=>{
  const bad=observation();
  // Reproduce the live failure shape without storing private photos or output:
  // ten recipe-derived rows masquerade as plate components, and the mapping
  // indexes point past that visual array. The serving cap clears their grams.
  const names=['butter','onion','plain flour','milk','salt and black pepper','lemon juice','fresh haddock','smoked haddock','hard-boiled eggs','potatoes'];
  bad.meal.components=names.map(name=>({...component(name,400),preparation:'raw',evidence:'Recipe photo 2: '+name}));
  bad.meal.recipeEvidence.componentIndexes=[10,11];
  let calls=0;mock.method(globalThis,'fetch',async()=>{calls++;return output(calls===1?bad:{components:observation().meal.components,recipeEvidence:recipe()});});
  const response=await worker.fetch(request(),environment()),result=await response.json(),m=result.extraction.meal;
  assert.equal(response.status,200,JSON.stringify(result));assert.equal(calls,2);assert.equal(result.trace.recheckOutcome,'recovered');
  assert.equal(result.trace.recipeRecheckDetail,'recovered');assert.equal(m.recipeCalculation.applied,true);
  assert.equal(m.recipeCalculation.batchComponents.length,6);assert.equal(m.components.length,7,'recipe batch plus one observed cabbage side');
  assert.equal(m.components.at(-1).name,'cabbage');assert.equal(m.components.at(-1).amountGrams,150);
  assert.equal(m.recipeCalculation.originalPlateComponents.length,3);assert.deepEqual(m.recipeCalculation.componentIndexes,[0,1]);
  assert.ok(m.nutrients.energyKcal.knownSubtotal>0);assert.ok(m.nutrients.protein.knownSubtotal>0);
  const quarter=globalThis.NudgeRecipeComposition.apply(m,4,{source:'user',portionFraction:.25});
  assert.equal(quarter.components.at(-1).amountGrams,150);assert.equal(quarter.components[0].amountGrams,25);
  assert.doesNotMatch(JSON.stringify(result.trace),/cabbage|butter|Recipe photo/);
});

test('photo trace diagnoses exact first and retry schema fields without returning private model content',async()=>{
  const bad=observation();bad.meal.recipeEvidence.ingredients[3].amount=0;
  const retry={components:observation().meal.components,recipeEvidence:recipe()};retry.recipeEvidence.ingredients[4].unit='private secret';
  let count=0;mock.method(globalThis,'fetch',async()=>output(++count===1?bad:retry));
  const response=await worker.fetch(request(),environment()),result=await response.json();
  assert.equal(response.status,200);assert.equal(count,2);assert.equal(result.trace.recheckOutcome,'failed');
  assert.deepEqual(result.trace.recipeValidationIssue,{path:'$.recipeEvidence.ingredients[3].amount',reason:'minimum'});
  assert.deepEqual(result.trace.recipeRecheckValidationIssue,{path:'$.recipeEvidence.ingredients[4].unit',reason:'enum'});
  assert.doesNotMatch(JSON.stringify(result.trace),/private|secret|butter|milk/i);
});

for(const outcome of ['failed','no_improvement'])test('recipe second check '+outcome+' retains the first result and never makes a third call',async()=>{
  const bad=observation();bad.meal.recipeEvidence.text='A summary of ingredients, not a transcription';
  let count=0;mock.method(globalThis,'fetch',async()=>{count++;if(count>1&&outcome==='failed')throw new Error('network');return output(count===1?bad:{components:observation().meal.components,recipeEvidence:bad.meal.recipeEvidence});});
  const response=await worker.fetch(request(),environment()),result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));assert.equal(count,2);assert.equal(result.trace.recheckOutcome,outcome);
  assert.equal(result.extraction.meal.recipeEvidence.text,bad.meal.recipeEvidence.text);
  assert.equal(recipeCoverage(result.extraction.meal).quantities,0);assert.equal(result.extraction.meal.components.at(-1).amountGrams,150);
});

test('photo endpoint preserves printed recipe quantities, avoids a useless repeated vision pass and returns partial arithmetic',async()=>{
  const calls=[];mock.method(globalThis,'fetch',async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');calls.push(JSON.parse(init.body));return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(observation())}]}]});});
  const env={OPENAI_API_KEY:'private-test-key',OPENAI_MODEL:'gpt-4.1-mini',PRIVATE_ACCESS_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),LABEL_QUOTA:{idFromName:v=>v,get:()=>({fetch:async()=>Response.json({allowed:true})})}};
  const response=await worker.fetch(new Request('https://nudge.example/v1/nutrition-label/analyse',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({images:[photo,photo]})}),env),result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));assert.equal(calls.length,1);
  assert.ok(calls[0].text.format.schema.properties.meal.anyOf[0].required.includes('recipeEvidence'));
  assert.match(calls[0].instructions,/Recipe amounts belong to the entire batch/);
  assert.equal(result.extraction.meal.recipeCalculation.servings,4);assert.equal(result.extraction.meal.components.length,7);
  assert.ok(result.extraction.meal.nutrients.energyKcal.knownSubtotal>0);assert.ok(result.extraction.meal.nutrients.protein.knownSubtotal>0);
  assert.equal(result.extraction.meal.portion.amount,null);assert.equal(result.trace.upstreamCallCount,1);
  assert.doesNotMatch(JSON.stringify(result.trace),/fish|haddock|milk|butter|100 g/i);
});
