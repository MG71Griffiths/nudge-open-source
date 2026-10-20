// macOS JavaScriptCore smoke: the same runtime class used by NativeAppStore,
// with no browser APIs, network, credentials, app storage or phone operations.
import Foundation
import JavaScriptCore

guard CommandLine.arguments.count == 2 else { fatalError("Usage: swift chatgpt-analysis-runtime-check.swift REPOSITORY") }
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let runtime = JSContext()!
var errors: [String] = []
runtime.exceptionHandler = { _, value in errors.append(value?.toString() ?? "JavaScript exception") }
let uuid: @convention(block) () -> String = { "7455c090-b269-4f60-bd93-c84a180e8d03" }
runtime.setObject(uuid, forKeyedSubscript: "__nudgeChatGPTUUID" as NSString)
runtime.evaluateScript("var window=globalThis;")
for file in ["core/nudge-score.js", "core/food-composition.js", "core/meal-recovery-data.js", "core/meal-recovery.js", "core/recipe-composition.js", "core/meal-score.js", "core/chatgpt-analysis.js"] {
    let url = root.appendingPathComponent("Web").appendingPathComponent(file)
    runtime.evaluateScript(try String(contentsOf: url, encoding: .utf8), withSourceURL: url)
}
let result = runtime.evaluateScript(#"""
(function(){
  let checks=0;const check=(condition,label)=>{if(!condition)throw new Error(label);checks++;};
  const keys=['energyKcal','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'];
  const empty=()=>Object.fromEntries(keys.map(k=>[k,null]));
  const options={photoIds:['d747c1f9-f1f3-4ee1-ac19-e9b23a87cfc1'],captureRevision:2};
  const base={type:'product',metadata:null,meal:null,productName:'Marmite',brand:null,photoConsistency:'sameProduct',servingSuggestion:null,categoryTag:null,retailer:null,labelKind:'unreadable',ingredients:null,basis:'unknown',energyKj:null,nutritionPreparation:'unknown',servingSize:null,needsClearerPhoto:true,message:'',nutrients:empty()};
  const api=NudgeChatGPTAnalysis,request=api.request(options);
  check(request.schema.properties.type.enum.includes('meal'),'Current meal schema');
  check(typeof request.instructions==='string'&&request.instructions.includes('PHOTO'),'Fixed photo instructions');
  check(request.inputText==='','No invented user input');
  check(typeof fetch==='undefined'&&typeof TextEncoder==='undefined'&&typeof structuredClone==='undefined'&&typeof crypto==='undefined','No browser APIs required or overwritten');
  const product=api.finish({...options,text:JSON.stringify(base)}).extraction;
  check(product.type==='product'&&product.productName==='Marmite','Front-only product identity');
  check(product.nutrients.energyKcal===null&&product.basis==='unknown','No invented label nutrition');
  check(product.analysisId==='7455c090-b269-4f60-bd93-c84a180e8d03','Native UUID callback');
  const meal={...base,type:'meal',productName:null,photoConsistency:'sameMeal',meal:{name:'Carrot plate',ingredients:[{name:'carrot',evidence:'Visible carrot'}],plants:[],components:[{name:'Carrots, old, raw',preparation:'raw',amountGrams:150,evidence:'Visible carrot',photoIndex:1,assumptions:[]}],recipeEvidence:null,qualityEstimate:null,portionMode:'estimated_serving',subject:{kind:'plated_meal',description:'Foreground plate',photoIndex:1},portionAmbiguity:{requiresSelection:false,reason:''},portion:{label:'1 portion',amount:150,unit:'g',source:'estimated'},basis:'perPortion',estimated:true,needsReview:true,message:'',nutrients:empty()}};
  const mealHints={ingredients:['carrot','kefir'],portion:{amount:500,unit:'ml'}};
  const observation=api.finish({...options,mealHints,text:JSON.stringify(meal)}).extraction;
  check(observation.meal.components[0].sourceRecord.source==='UK CoFID','Shared source matching');
  check(observation.meal.components[0].photoId===options.photoIds[0],'One-based photo binding');
  check(observation.meal.components.find(c=>c.name==='kefir').amountGrams===null,'Omitted selection stays unquantified');
  check(observation.meal.nutrients.energyKcal.value===null&&observation.meal.nutrients.energyKcal.knownSubtotal>0,'Partial source nutrition');
  check(observation.meal.userPortion.amount===500&&observation.meal.userPortion.unit==='ml','Exact user portion retained');
  let rejected=false;try{api.finish({...options,text:JSON.stringify({...meal,score:100})});}catch{rejected=true;}
  check(rejected,'Model score injection rejected');
  rejected=false;try{api.finish({...options,text:'界'.repeat(80001)});}catch(e){rejected=e.code==='result_too_large';}
  check(rejected,'UTF-8 output byte limit');
  return checks;
})()
"""#)
guard errors.isEmpty, let count = result?.toInt32(), count == 14 else {
    for error in errors { fputs(error + "\n", stderr) }
    exit(1)
}
print("ChatGPT analysis JavaScriptCore: \(count) checks passed; no browser IO or credentials.")
