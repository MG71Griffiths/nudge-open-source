const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const evidence=require('../Web/core/product-evidence.js');
const clone=value=>JSON.parse(JSON.stringify(value));
const extraction={type:'product',productName:'Example yogurt',brand:'Example',basis:'per100g',labelKind:'nutrition',nutritionPreparation:'as_sold',needsClearerPhoto:false,metadata:{country:'UK',variant:'Original',conflicts:[]},ingredients:{text:'Milk',plants:[],needsReview:false},energyKj:{value:600,unit:'kJ'},nutrients:{energyKcal:{value:143,unit:'kcal'},protein:{value:12,unit:'g'},salt:{value:.1,unit:'g'}}};
const previous={name:'Example yogurt',brand:'Example',country:'United Kingdom',variant:'Original',basisUnit:'g',nutritionPreparation:'as_sold',barcode:'12345678',imageURL:'https://images.openfoodfacts.org/images/products/123/front_en.2.400.jpg',sourceName:'Open Food Facts',sourceURL:'https://world.openfoodfacts.org/product/12345678',retrievedAt:'2026-10-01T12:00:00Z',ingredients:'Milk',energyKj:{value:500},nutrients:{protein:{value:10},fibre:{value:2},salt:{value:.3}},scoreResult:{value:75},confirmedPortion:{amount:80,unit:'g'},servingAmount:80,servingUnit:'g',servingDescription:'1 pot'};

test('product evidence converts only physical label servings and retains their original basis',()=>{
  const input={...clone(extraction),basis:'perServing',servingSize:{value:200,unit:'ml'},nutrients:{energyKcal:{value:600,unit:'kJ'},protein:{value:10,unit:'g'},salt:{value:200,unit:'mg'}}};
  const before=JSON.stringify(input),result=evidence.fromExtraction(input);
  assert.equal(result.basisUnit,'ml');assert.equal(result.energyKj.value,300);
  assert.equal(result.nutrients.energyKcal.value,300/4.184);assert.equal(result.nutrients.protein.value,5);assert.equal(result.nutrients.salt.value,.1);
  assert.equal(result.servingNutrients.protein.value,10);assert.equal(result.servingNutrients.salt.value,.2);
  assert.equal(result.servingNutrientSource.kind,'printed_per_serving');assert.equal(result.servingPreparation,'as_sold');
  assert.match(result.nutrientSources.protein,/per labelled serving, normalised to 100 ml/);
  assert.equal(JSON.stringify(input),before);
  for(const servingSize of [{value:1,unit:'serving'},{value:0,unit:'g'},{value:6000,unit:'g'},null]){
    const unknown=evidence.fromExtraction({...input,servingSize});
    assert.equal(unknown.basisUnit,null);assert.deepEqual(unknown.nutrients,{});assert.equal(unknown.energyKj,null);
  }
});

test('compatible source changes retain both facts without filling missing current nutrients',()=>{
  const input=clone(extraction),stored=clone(previous),before=JSON.stringify([input,stored]);
  const result=evidence.augmentFromLabel(input,stored,{provider:'OpenAI',model:'configured model',retrievedAt:'2026-10-05T12:00:00Z',privateField:'excluded'});
  const protein=result.sourceDifferences.find(d=>d.field==='protein');
  assert.equal(protein.previous.value,10);assert.equal(protein.current.value,12);assert.equal(protein.status,'resolved_by_current_label');
  assert.equal(protein.previous.retrievedAt,previous.retrievedAt);assert.equal(protein.current.retrievedAt,'2026-10-05T12:00:00Z');
  assert.equal(protein.current.original.basis,'per100g');assert.equal(result.nutrients.fibre,undefined);
  assert.equal(result.scoreResult,null);assert.equal(result.confirmedPortion,null);assert.equal(result.barcode,previous.barcode);assert.equal(result.imageURL,previous.imageURL);
  assert.equal(result.extractionSource.privateField,undefined);assert.equal(JSON.stringify([input,stored]),before);
  const comparison=evidence.sourceComparison(input,evidence.fromExtraction(input),stored);
  assert.deepEqual(comparison.identity,[]);assert.equal(comparison.differences.find(d=>d.field==='protein').current.value,12);
});

test('identity conflicts quarantine old product facts and incompatible bases are not compared',()=>{
  const different={...clone(extraction),brand:'Different brand'},result=evidence.augmentFromLabel(different,clone(previous));
  assert.equal(result.barcode,'');assert.equal(result.imageURL,'');assert.equal(result.sourceURL,'');assert.equal(result.scoreResult,null);
  assert.equal(result.nutrients.fibre,undefined);assert.equal(result.nutrients.protein.value,12);
  assert.ok(result.metadata.conflicts.some(c=>c.field==='identity'));
  assert.equal(result.sourceDifferences.find(d=>d.field==='brand').status,'unresolved_identity');
  for(const change of [{basis:'per100ml'},{nutritionPreparation:'prepared'},{nutritionPreparation:'unknown'}]){
    const compared=evidence.sourceComparison({...extraction,...change},evidence.fromExtraction({...extraction,...change}),previous);
    assert.equal(compared.differences.some(d=>d.field==='protein'),false);
  }
  const unclear=evidence.augmentFromLabel({...extraction,needsClearerPhoto:true},previous);
  assert.equal(unclear.nutrients.protein.value,10);assert.equal(unclear.scoreResult,null);assert.ok(unclear.metadata.conflicts.some(c=>c.field==='nutrition'));
});

test('results adapter aliases the headless product evidence API',()=>{
  const sandbox={};sandbox.window=sandbox;vm.createContext(sandbox);
  for(const file of ['core/product-evidence.js','scan-results.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web',file),'utf8'),sandbox,{filename:file});
  for(const name of ['fromExtraction','sourceComparison','augmentFromLabel','ingredientDetail','imageURL'])assert.equal(sandbox.NudgeResults[name],sandbox.NudgeProductEvidence[name]);
  assert.equal(JSON.stringify(sandbox.NudgeProductEvidence.fromExtraction(extraction)),JSON.stringify(evidence.fromExtraction(extraction)));
  assert.equal(JSON.stringify(sandbox.NudgeResults.augmentFromLabel(extraction,previous)),JSON.stringify(evidence.augmentFromLabel(extraction,previous)));
});
