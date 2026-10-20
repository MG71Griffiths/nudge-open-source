import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {buildRecoveryContext,applyRecoveryChoice,foodRecoveryCandidates,RECOVERY_PROMPT,RECOVERY_VERSION} from '../src/food-recovery.js';
import {ScoreCore} from '../src/nutrition-core.js';
const product=()=>({name:'Raw salmon',basisUnit:'g',nutritionPreparation:'as_sold',nutrients:{energyKcal:{value:null,unit:'kcal',status:'unknown'},protein:{value:20,unit:'g',status:'supplied'}}});
const choice=(p,recordId=null)=>({category:'general',evidence:[{field:'name',quote:p.name}],sweeteners:'unknown',sweetenerEvidence:[],recordId,reason:recordId?'compatible_generic_estimate':'category_only'});

describe('bounded AI choice of approved food evidence',()=>{
  it('offers at most eight sourced records with deterministic names and versioned provenance',()=>{
    const p=product(),context=buildRecoveryContext(p);
    assert.ok(context.candidates.length>0&&context.candidates.length<=8);assert.equal(context.missingFields.includes('fibre'),!ScoreCore.ACTIVE_DIRECTIONAL);assert.ok(context.missingFields.includes('salt'));assert.ok(!context.missingFields.includes('protein'));
    assert.equal(context.version,RECOVERY_VERSION);assert.ok(context.candidates.every(r=>r.basis==='per100g'&&r.sourceSHA256&&r.licenceURL));
    assert.deepEqual(context,buildRecoveryContext(p));assert.match(RECOVERY_PROMPT,/Never generate nutrient values/);
  });
  it('hydrates chosen quantities from the server dataset, keeping branded facts separate and unchanged',()=>{
    const p={...product(),brand:'Example brand',barcode:'1234567890123'},before=structuredClone(p),context=buildRecoveryContext(p),id=context.candidates[0].id;
    context.candidates[0].nutrients.protein.value=999;context.candidates[0].sourceURL='https://evil.example';
    const result=applyRecoveryChoice(p,context,choice(p,id));assert.deepEqual(p,before);assert.notEqual(result.estimate.nutrients.protein.value,999);assert.notEqual(result.estimate.sourceRecord.sourceURL,'https://evil.example');assert.equal(result.estimate.valueStatus,'estimated');assert.equal(result.estimate.sourceIdentity,'generic_food_estimate');assert.equal(result.estimate.basisUnit,'g');
    assert.equal(p.nutrients.energyKcal.value,null);assert.equal(p.nutrients.protein.value,20);
  });
  it('rejects invented record IDs, nutrient fields and invented evidence',()=>{
    const p=product(),context=buildRecoveryContext(p);
    assert.throws(()=>applyRecoveryChoice(p,context,choice(p,'usda:invented')),/not offered/);
    assert.throws(()=>applyRecoveryChoice(p,context,{...choice(p),nutrients:{salt:0}}),/Invalid/);
    assert.throws(()=>applyRecoveryChoice(p,context,{...choice(p),evidence:[{field:'name',quote:'Cooked chicken'}]}),/Invalid/);
    assert.throws(()=>applyRecoveryChoice(p,context,{...choice(p),sweeteners:'absent'}),/ingredients/);
  });
  it('rejects stale contexts and cannot select a compatible source from a tampered context alone',()=>{
    const p=product(),context=buildRecoveryContext(p),id=context.candidates[0].id;
    assert.throws(()=>applyRecoveryChoice(p,{...context,version:'old'},choice(p,id)),/Invalid/);
    const unrelated={...p,name:'Raw chicken'};
    assert.throws(()=>applyRecoveryChoice(unrelated,context,choice(unrelated,id)),/incompatible/);
  });
  it('does not use g records for ml, unknown identities or unresolved preparations',()=>{
    for(const change of [{basisUnit:'ml'},{basisUnit:null},{unresolvedFields:['identity']},{unresolvedFields:['preparation']}])assert.deepEqual(foodRecoveryCandidates({...product(),...change}),[]);
  });
  it('keeps incompatible preparations and hidden variants out of model choices',()=>{
    const raw=foodRecoveryCandidates(product());assert.ok(raw.every(r=>/raw/i.test(r.name)&&!/cooked|smoked|breaded/i.test(r.name)));
    const cooked=foodRecoveryCandidates({...product(),name:'Cooked lentils'});assert.ok(cooked.length>0);assert.ok(cooked.every(r=>!/raw|sprouted/i.test(r.name)));
    const nuts=foodRecoveryCandidates({...product(),name:'Organic almonds'});assert.ok(nuts.length>0);assert.ok(nuts.every(r=>!/shells|ground|toasted|salted|sweetened/i.test(r.name)));
    assert.deepEqual(foodRecoveryCandidates({...product(),name:'Salmon'}),[]);
  });
  it('leaves absence of a compatible source explicit without inventing a zero',()=>{
    const p={...product(),name:'Unknown branded delight'},context=buildRecoveryContext(p),result=applyRecoveryChoice(p,context,{...choice(p),category:'unknown',reason:'no_compatible_source'});
    assert.equal(result.estimate,null);assert.equal(result.provenance.reason,'no_compatible_source');assert.equal(p.nutrients.energyKcal.value,null);
  });
  it('matches a plain packaged egg identity despite marketing words, without changing product facts',()=>{
    const p={name:'British Free Range Mixed Size Eggs',brand:'Example shop',sourceName:'Open Food Facts',basisUnit:'g',nutritionPreparation:'as_sold',
      categories:['en:eggs','en:chicken-eggs'],ingredients:'just eggs',nutrients:{carbohydrate:{value:0,unit:'g',status:'supplied'}}};
    const before=structuredClone(p),records=foodRecoveryCandidates(p);
    assert.ok(records.length>0);assert.ok(records.every(r=>/chicken, whole, raw/i.test(r.name)));
    assert.ok(records.every(r=>r.nutrients.fibre.value===0));
    assert.ok(records.every(r=>r.nutrients.sugars.value===null),'Source trace remains unknown, not an invented zero');
    assert.deepEqual(p,before);
  });
  it('keeps whole eggs, whites, yolks and species distinct across raw and prepared identities',()=>{
    for(const [name,species,component,prep] of [
      ['Raw eggs','chicken','whole','raw'],['Raw chicken egg whites','chicken','white','raw'],['Raw chicken egg yolks','chicken','yolk','raw'],
      ['Raw duck eggs','duck','whole','raw'],['Raw quail eggs','quail','whole','raw'],['Raw turkey eggs','turkey','whole','raw'],
      ['Boiled chicken eggs','chicken','whole','boiled']
    ]){
      const records=foodRecoveryCandidates({...product(),name});assert.ok(records.length>0,name);
      assert.ok(records.every(r=>new RegExp(species+', '+component+',.*'+prep,'i').test(r.name)),name+' must not substitute component/species/preparation');
    }
    for(const name of ['Egg replacement','Vegan eggs','Egg mayonnaise sandwich','Chocolate eggs','Egg salad']){
      assert.ok(foodRecoveryCandidates({...product(),name}).every(r=>!/egg.*whole.*raw/i.test(r.name)),name+' is not a raw whole egg');
    }
    assert.deepEqual(foodRecoveryCandidates({...product(),name:'Eggs'}),[],'Unspecified meal preparation is still unknown');
    assert.deepEqual(foodRecoveryCandidates({...product(),name:'Raw duck eggs',categories:['en:chicken-eggs']}),[],'Conflicting species cannot be silently selected');
  });
  it('checks categoryTag, ingredients, component and preparation before inferring a packaged raw egg',()=>{
    const plain={...product(),name:'Eggs',sourceName:'Open Food Facts',categories:['en:eggs']};
    for(const extra of [
      {ingredients:'Egg whites'}, {ingredients:'Egg yolks'}, {ingredients:'Eggs, salt'},
      {ingredients:'Eggs and mayonnaise'}, {ingredients:'Cooked eggs'}, {ingredients:'Dried eggs'},
      {categories:['en:eggs','en:boiled-eggs']}, {categoriesTags:['en:egg-whites']},
      {categoryTag:'en:duck-eggs'}, {categoryTag:'en:boiled-eggs'}, {categoryTag:'en:egg-yolks'},
      {name:'Duck eggs',ingredients:'Chicken eggs'}, {name:'Raw duck eggs',ingredients:'Chicken eggs'},
      {name:'Raw chicken eggs',ingredients:'Duck eggs'}, {name:'Raw chicken eggs',ingredients:'Boiled eggs'},
      {name:'Raw chicken eggs',ingredients:'Egg whites'}, {name:'Boiled chicken eggs',categoryTag:'en:fried-eggs'},
      {name:'Cooked chicken eggs',categoryTag:'en:fried-eggs',ingredients:'Boiled eggs'},
      {name:'Raw chicken egg whites',ingredients:'Egg yolks'}, {name:'Raw duck chicken eggs'}
    ])assert.deepEqual(foodRecoveryCandidates({...plain,...extra}),[],JSON.stringify(extra));
    for(const extra of [{ingredients:'just eggs'},{ingredients:'Whole chicken eggs'},
      {categories:[],categoryTag:'en:eggs'},{ingredients:'Raw chicken eggs'},
      {name:'Duck eggs',categories:['en:duck-eggs'],ingredients:'Duck eggs'}]){
      assert.ok(foodRecoveryCandidates({...plain,...extra}).length>0,JSON.stringify(extra));
    }
    const cooked=foodRecoveryCandidates({...plain,name:'Cooked chicken eggs',categoryTag:'en:boiled-eggs'});
    assert.ok(cooked.length>0);assert.ok(cooked.every(r=>/boiled/i.test(r.name)),'Specific category preparation narrows a generic cooked identity');
  });
  it('normalises singular and qualified whole fruit while excluding dried/cooked counterparts',()=>{
    for(const name of ['Banana','Bananas','Fresh banana','Organic Bananas','Fairtrade bananas','5 Fairtrade Bananas','Rainforest Alliance Bananas','Shop Organic Bananas']){
      const p={...product(),name,brand:'Shop',sourceName:'Open Food Facts',categories:['en:fruits','en:bananas','en:fruit-based-foods-and-beverages','en:plant-based-foods-and-beverages'],ingredients:'Bananas.'};
      const before=structuredClone(p),records=foodRecoveryCandidates(p);
      assert.equal(records.length,1,name);assert.equal(records[0].id,'usda:173944');
      assert.equal(records[0].fvlEligible,true);assert.match(records[0].name,/raw/i);assert.doesNotMatch(records[0].name,/dehydrated|powder|cooked|dried/i);
      assert.deepEqual(p,before);
    }
    for(const name of ['Apple','Apples','Pear','Pears','Strawberry','Strawberries']){
      const records=foodRecoveryCandidates({...product(),name,sourceName:'Open Food Facts',categories:['en:fruits'],ingredients:name});
      assert.ok(records.length>0,name);assert.ok(records.every(r=>/raw/i.test(r.name)&&!/dry|dried|dehydrated|cooked|powder/i.test(r.name)),name);
    }
  });
  it('rejects conflicting fruit ingredients/taxonomy and never borrows raw banana for processed products',()=>{
    const plain={...product(),name:'Banana',sourceName:'Open Food Facts',categories:['en:bananas'],ingredients:'Banana'};
    for(const change of [{ingredients:'Banana, sugar'},{ingredients:'Apples'},{ingredientsNeedsReview:true},
      {categories:['en:bananas','en:dried-fruits']},{categories:['en:apples']},{ingredientItems:[{text:'Banana'},{text:'Sugar'}]},{nutritionPreparation:'prepared'}]){
      assert.deepEqual(foodRecoveryCandidates({...plain,...change}),[],JSON.stringify(change));
    }
    for(const name of ['Dried banana','Banana powder','Banana chips','Banana cake','Banana milkshake','Banana puree','Cooked banana']){
      assert.ok(foodRecoveryCandidates({...product(),name}).every(r=>r.id!=='usda:173944'),name);
    }
  });
  it('uses the same missingness and point-invariant bounds as the shared calculator',()=>{
    const n=(value,unit='g',extra={})=>({value,unit,status:'supplied',...extra});
    const p={...product(),name:'Fairtrade bananas',sourceName:'Open Food Facts',categories:['en:bananas'],ingredients:'Bananas',energyKj:n(435,'kJ'),
      nutrients:{energyKcal:n(103,'kcal'),sugars:n(20.9),protein:n(1.2),fibre:n(1.1),salt:n(.01,'g',{relation:'<'}),saturatedFat:n(.1,'g',{relation:'<'})}};
    assert.equal(ScoreCore.calculateScore(p).value,75);assert.deepEqual(buildRecoveryContext(p).missingFields,[]);
    assert.deepEqual(buildRecoveryContext(p).candidates,[],'A supported complete label needs no recovery call');
    const missing=structuredClone(p);delete missing.nutrients.salt;
    assert.deepEqual(buildRecoveryContext(missing).missingFields,['salt']);assert.equal(buildRecoveryContext(missing).candidates[0].id,'usda:173944');
    for(const extra of [{value:.3,relation:'<'},{value:.01,status:'estimated',relation:'~'},{value:null,status:'unknown'},{value:.01,unit:'mg'}]){
      const q={...p,nutrients:{...p.nutrients,salt:{...n(.01),...extra}}};
      assert.ok(buildRecoveryContext(q).missingFields.includes('salt'),JSON.stringify(extra));
    }
    const kjOnly=structuredClone(p);delete kjOnly.nutrients.energyKcal;
    assert.ok(!buildRecoveryContext(kjOnly).missingFields.includes('energyKcal'),'Supplied kJ satisfies energy without kcal');
    const prepared={...p,nutritionPreparation:'prepared'};
    assert.equal(buildRecoveryContext(prepared).missingFields.includes('nutritionPreparation'),!ScoreCore.ACTIVE_DIRECTIONAL);
  });
});
