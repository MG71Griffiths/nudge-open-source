// Read-only display guard uses the whole diary and current requirements.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const copy=value=>JSON.parse(JSON.stringify(value));
const c={console,Date,Math,document:{getElementById:()=>null}};c.window=c;c.NudgeIcons=()=>'';c.NudgeResults={finding:()=>'',productImage:()=>({src:'',fallback:''})};
vm.createContext(c);for(const file of ['streaks.js','core/diary.js','core/food-log.js','food-patterns.js','core/nutrition-profile.js','nudge-fit.js','core/nudge-score.js','core/meal-score.js','food-detail-model.js','core/frequency-policy.js','diet.js','scan-history.js'])vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),c,{filename:file});
const nutrient=(value,unit='g')=>({value,unit,status:'supplied'}),product={name:'Saved synthetic oats',categoryTag:'en:porridge',basisUnit:'g',nutritionPreparation:'as_sold',sourceName:'Synthetic fixture',ingredients:'Oats (100%)',ingredientsNeedsReview:false,energyKj:nutrient(500,'kJ'),nutrients:{energyKcal:nutrient(120,'kcal'),saturatedFat:nutrient(0),sugars:nutrient(0),salt:nutrient(0),fibre:nutrient(8),protein:nutrient(12)}};
const base=c.NudgeFoodDetailModel.score(product),f=c.NudgeFrequency,m=c.NudgeDiet,day='2026-10-04';
assert.equal(base.baseFrequency,null);assert.equal(c.NudgeScoreCore.validResult(base),true);
const historical={...copy(base),methodId:'nudge_nutrition_v0_2',version:'0.2',baseFrequency:'Daily',finalFrequency:'Daily',frequencyStatus:'complete'};
const entry={id:'saved',name:'Saved oats',day,slot:'Lunch',portions:1,plants:['oats'],ferments:[],energyPerPortion:120,proteinPerPortion:12,fibrePerPortion:8,portionAmount:100,portionUnit:'g',ingredients:{text:'Oats, water',needsReview:false},nutritionSnapshot:{salt:{portion:.8,portionStatus:'calculated'}},sourceMeta:{entryKind:'product-consumption',confirmationId:'saved',scoreMethod:historical}};
for(const profile of [{},{care:'clinical'},{glutenRequirement:'coeliac'},{allergies:['milk'],allergiesAnswered:true}]){
 const entries=[copy(entry)],before=JSON.stringify(entries),context={entry:entries[0],entries,profile};
 const displayed=f.savedDisplay(entries[0].sourceMeta.scoreMethod,context);
 assert.equal(displayed.value,historical.value);assert.equal(displayed.finalFrequency,null);assert.equal(displayed.baseFrequency,null);assert.equal(f.render(displayed),'');
 const rating=m.scoreForEntry(entries[0],{entries,profile});assert.equal(rating.value,historical.value);assert.equal(rating.frequency,null);assert.equal(rating.legacy,true);
 assert.equal(JSON.stringify(entries),before,'Retiring frequency display never rewrites logged nutrition or source score');
}
const current=f.apply(base,{product,salt:0});assert.equal(current.finalFrequency,null);assert.equal(f.savedDisplay(current),current);
console.log('PASS: historic grade-to-frequency guidance retired without altering saved evidence, nutrition or current quality ratings.');
