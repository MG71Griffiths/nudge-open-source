const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const root=path.join(__dirname,'..'),core=path.join(root,'Web/core');
const engines={
  'nudge-score.js':'NudgeScoreCore','food-composition.js':'NudgeComposition',
  'meal-recovery-data.js':'NudgeMealRecoveryData','meal-recovery.js':'NudgeMealRecovery',
  'recipe-composition.js':'NudgeRecipeComposition','meal-score.js':'NudgeMealScore',
  'frequency-policy.js':'NudgeFrequency','analysis-result.js':'NudgeAnalysisResult',
  'nutrition-profile.js':'NudgeNutrition','diary.js':'NudgeDiary','food-log.js':'NudgeFoodLog',
  'product-evidence.js':'NudgeProductEvidence'
};
const nativeEngines={'chatgpt-analysis.js':'NudgeChatGPTAnalysis','fast-food-capture.js':'NudgeFastCapture'};
const browserAPIs=['document','navigator','location','localStorage','sessionStorage','indexedDB','fetch','XMLHttpRequest','WebSocket'];
function corePaths(entrypoint){
  if(entrypoint==='native'){
    const source=fs.readFileSync(path.join(root,'Nudge/NativeAppStore.swift'),'utf8');
    const list=source.match(/let paths\s*=\s*\[([^\]]+)\]/);
    assert.ok(list,'Native app must declare its bundled script order');
    return [...list[1].matchAll(/"core\/([^"/]+\.js)"/g)].map(match=>match[1]);
  }
  const html=fs.readFileSync(path.join(root,'Web/index.html'),'utf8');
  return [...html.matchAll(/<script src="\/core\/([^?"/]+)\?/g)].map(match=>match[1]);
}
function headless(entrypoint='web'){
  const sandbox={structuredClone};
  for(const name of browserAPIs)Object.defineProperty(sandbox,name,{get(){throw new Error('Core accessed browser API: '+name);}});
  // The registration wrapper may use window; no DOM or platform services exist.
  sandbox.window=sandbox;vm.createContext(sandbox);
  const paths=corePaths(entrypoint);
  for(const file of paths)vm.runInContext(fs.readFileSync(path.join(core,file),'utf8'),sandbox,{filename:'core/'+file});
  return {sandbox,paths};
}

test('all core engines load in the bundled script order without browser services',()=>{
  const {sandbox,paths}=headless();
  for(const [file,globalName] of Object.entries(engines)){
    assert.equal(paths.filter(name=>name===file).length,1,file+' must be bundled exactly once');
    assert.ok(sandbox[globalName],file+' must expose its browser-compatible API');
  }
  assert.deepEqual(new Set(paths),new Set(Object.keys(engines)),'Every web core engine must be available offline');
  for(const file of Object.keys(engines).slice(0,7))assert.equal(fs.existsSync(path.join(root,'Web',file)),false,'No duplicate root implementation for '+file);
});

test('native core loads its photo adapter after shared engines without browser services',()=>{
  const {sandbox,paths}=headless('native');
  for(const [file,globalName] of Object.entries({...engines,...nativeEngines})){
    assert.equal(paths.filter(name=>name===file).length,1,file+' must be bundled exactly once by native');
    assert.ok(sandbox[globalName],file+' must expose its native-compatible API');
  }
  assert.deepEqual(new Set(paths),new Set(fs.readdirSync(core).filter(file=>file.endsWith('.js'))),'Every core module must be available offline in native');
  for(const dependency of ['food-composition.js','meal-recovery-data.js','meal-recovery.js','recipe-composition.js','meal-score.js','analysis-result.js']){
    assert.ok(paths.indexOf(dependency)<paths.indexOf('chatgpt-analysis.js'),'Photo adapter must load after '+dependency);
  }
  assert.deepEqual(Object.keys(sandbox.NudgeChatGPTAnalysis).sort(),['finish','request','version']);
  assert.equal(sandbox.NudgeChatGPTAnalysis.version,'nudge-chatgpt-analysis-v1');
  assert.equal(typeof sandbox.NudgeChatGPTAnalysis.request,'function');
  assert.equal(typeof sandbox.NudgeChatGPTAnalysis.finish,'function');
  for(const dependency of ['food-composition.js','meal-recovery-data.js','meal-recovery.js','recipe-composition.js','analysis-result.js'])assert.ok(paths.indexOf(dependency)<paths.indexOf('fast-food-capture.js'));
  assert.deepEqual(Object.keys(sandbox.NudgeFastCapture).sort(),['localCapture','recalculate','version']);
  assert.equal(sandbox.NudgeFastCapture.version,'nudge-fast-capture-v1');
});

test('core code has no direct platform or screen dependencies',()=>{
  // Match API access rather than words in comments, source titles or food data.
  const platform=/\b(?:document|navigator|location|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|WebSocket)\s*(?:[.(]|\?\.)/;
  const screen=/\b(?:root|window|globalThis)\.(?:createNudge\w+|NudgeControls|NudgeDiagnostics|NudgeNative|NudgeIcons)\b/;
  for(const file of fs.readdirSync(core).filter(file=>file.endsWith('.js'))){
    const source=fs.readFileSync(path.join(core,file),'utf8');
    assert.doesNotMatch(source,platform,file+' must receive platform services through an adapter');
    assert.doesNotMatch(source,screen,file+' must not depend on a screen controller');
    assert.doesNotMatch(source,/\b(?:import\s|require\s*\()[^\n]*(?:nutrition-label|nudge-fit|scan-history|barcode|food-detail-screen|diet)\.js/,file+' must not import screens');
  }
});

test('backend uses explicit shared-engine exports and agrees with offline arithmetic',async()=>{
  const api=await import('../Backend/src/nutrition-core.js');
  const {sandbox}=headless();
  const modules={ScoreCore:'NudgeScoreCore',Composition:'NudgeComposition',MealRecoveryData:'NudgeMealRecoveryData',MealRecovery:'NudgeMealRecovery',RecipeComposition:'NudgeRecipeComposition',MealScore:'NudgeMealScore'};
  for(const [name,globalName] of Object.entries(modules))assert.deepEqual(Object.keys(api[name]).sort(),Object.keys(sandbox[globalName]).sort(),name+' exposes the same engine');
  const components=[{amountGrams:75,nutrients:{protein:{value:12},carbohydrate:{value:20}},sourceRecord:{carbohydrateDefinition:'available'}},{amountGrams:25,nutrients:{protein:{value:8},carbohydrate:{value:null}},sourceRecord:{carbohydrateDefinition:'available'}}];
  const before=JSON.stringify(components),online=api.Composition.total(components),offline=sandbox.NudgeComposition.total(components);
  assert.equal(JSON.stringify(online),JSON.stringify(offline));
  assert.equal(online.protein.value,11);assert.equal(online.carbohydrate.value,null);assert.equal(online.carbohydrate.knownSubtotal,15);
  assert.equal(JSON.stringify(components),before,'Calculation does not mutate source evidence');
  for(const file of fs.readdirSync(path.join(root,'Backend/src')).filter(file=>file.endsWith('.js')&&file!=='nutrition-core.js')){
    const source=fs.readFileSync(path.join(root,'Backend/src',file),'utf8');
    assert.doesNotMatch(source,/globalThis\.Nudge(?:ScoreCore|Composition|MealRecovery(?:Data)?|RecipeComposition|MealScore)\b/,file+' must use the explicit core facade');
    // Static shared manifests (for example places.v1.json) are data, not
    // executable nutrition engines. Engine imports must use the facade.
    assert.doesNotMatch(source,/import[^\n]*Web\/core\/[^'"\s]+\.js['"]/,file+' must use the explicit core facade');
  }
});
