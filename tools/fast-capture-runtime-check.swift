// Actual macOS JavaScriptCore; synthetic OCR, no camera, storage or network.
import Foundation
import JavaScriptCore
guard CommandLine.arguments.count == 2 else { fatalError("Usage: swift fast-capture-runtime-check.swift REPOSITORY") }
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let runtime = JSContext()!
var errors: [String] = []
runtime.exceptionHandler = { _, value in errors.append(value?.toString() ?? "JavaScript exception") }
let uuid: @convention(block) () -> String = { "7455c090-b269-4f60-bd93-c84a180e8d03" }
runtime.setObject(uuid, forKeyedSubscript: "__nudgeChatGPTUUID" as NSString)
runtime.evaluateScript("var window=globalThis;")
for file in ["core/nudge-score.js", "core/food-composition.js", "core/meal-recovery-data.js", "core/meal-recovery.js", "core/recipe-composition.js", "core/meal-score.js", "core/fast-food-capture.js"] {
    let url = root.appendingPathComponent("Web").appendingPathComponent(file)
    runtime.evaluateScript(try String(contentsOf: url, encoding: .utf8), withSourceURL: url)
}
for (index, name) in ["local-label-ocr.json", "local-label-ocr-split.json"].enumerated() {
    runtime.setObject(try String(contentsOf: root.appendingPathComponent("tests/fixtures/" + name), encoding: .utf8), forKeyedSubscript: "labelFixture\(index)" as NSString)
}
let result = runtime.evaluateScript(#"""
(function(){
 let checks=0;const check=(condition,label)=>{if(!condition)throw new Error(label);checks++;};
 const api=NudgeFastCapture;
 check(api.version==='nudge-fast-capture-v1','Version');
 check(typeof fetch==='undefined'&&typeof TextEncoder==='undefined'&&typeof structuredClone==='undefined'&&typeof crypto==='undefined','No browser API dependency');
 const texts=['Synthetic curry','Serves 4','Ingredients','600 g chicken breast','400 ml coconut milk','2 onions','2 tomatoes','3 tablespoons vegetable oil','1 teaspoon salt','Kit sachets','4 naan breads'];
 const pages=[{photoID:'photo-1',photoIndex:1,lines:texts.map((text,i)=>({id:'line-'+i,text,confidence:.99,box:{x:.05,y:.95-i*.04,width:.9,height:.03},words:[]}))}];
 const input={pages,photoIds:['photo-1'],captureRevision:3,requestId:'synthetic-request'},out=api.localCapture(input);
 check(out.status==='partial','Partial recipe is useful');
 check(out.extraction.analysisId==='7455c090-b269-4f60-bd93-c84a180e8d03','Native UUID');
 check(out.extraction.meal.nutrients.energyKcal.value===null&&out.extraction.meal.nutrients.energyKcal.knownSubtotal>0,'Missing kit retains subtotal');
 check(out.extraction.meal.portion.amount===null,'No invented cooked grams');
 check(out.extraction.meal.recipeCalculation.servings===4,'Printed servings');
 const options=out.extraction.meal.recipeCalculation.recipeOptions;
 check(options.length===1&&!options[0].selected,'Naan remains opt-in');
 out.extraction.meal=NudgeRecipeComposition.apply(out.extraction.meal,4,{source:'user',portionFraction:.25});
 const changed=api.recalculate({extraction:out.extraction,includedOptionIds:[options[0].id]});
 check(changed.extraction.meal.recipeCalculation.selectedFraction===.25,'Local side change retains fraction');
 check(changed.extraction.meal.recipeCalculation.batchComponents.find(c=>c.name==='naan breads').amountGrams===null,'Naan weight unknown');
 for(const fixtureText of [labelFixture0,labelFixture1]){
  const f=JSON.parse(fixtureText),r=api.localCapture({...input,pages:f.pages,photoIds:f.pages.map(p=>p.photoID),label:f.label});
  check(r.status!=='fallback','Swift label bridge');
  check(Object.keys(f.label.nutrients).every(k=>(r.extraction.nutrients[k]?.value??null)===f.label.nutrients[k].value),'Swift label values unchanged');
 }
 check(api.localCapture({...input,token:'forbidden'}).status==='fallback','Unknown transport/credential input rejected');
 return checks;
})()
"""#)
guard errors.isEmpty, let count = result?.toInt32(), count == 15 else {
    for error in errors { fputs(error + "\n", stderr) }
    exit(1)
}
print("Fast capture JavaScriptCore: \(count) checks passed; synthetic OCR only, no network or device performance claim.")
