/* Pinned package/official algorithm checks; synthetic facts, no user/API data. */
const assert=require('node:assert/strict');
require('../Web/core/nudge-score.js');
const c=globalThis.NudgeScoreCore.Legacy,n=(value,unit='g')=>({value,unit,status:value===null?'unknown':'supplied'});
const pret=()=>({name:'Pret Chicken Satay Wrap',categoryTag:'wraps',basisUnit:'g',nutritionPreparation:'as_sold',
 sourceName:'Pinned manufacturer fixture UK020394',sourceURL:'https://www.pret.co.uk/en-GB/pret-delivers/products/UK020394/chicken-satay-wrap',retrievedAt:'2026-10-04',
 scoringFacts:{fvlPercent:{value:0,source:'synthetic-QA',evidence:'Synthetic qualifying share for nutrient-table checks; manufacturer fixture has no FVL claim'}},energyKj:n(772,'kJ'),nutrients:{energyKcal:n(184,'kcal'),saturatedFat:n(1.4),sugars:n(3.6),salt:n(.96),protein:n(9.8),fibre:n(1.9)}});
const p=pret(),frozen=JSON.stringify(p),r=c.calculateScore(p);
assert.equal(JSON.stringify(p),frozen);assert.equal(r.methodId,'nudge_nutrition_v0_3');assert.equal(r.model_version,'0.3');
assert.deepEqual([r.negativePoints,r.positivePoints,r.rawScore,r.grade,r.value,r.baseFrequency],[8,4,4,'C',50,null]);
assert.equal(r.status,'rated');assert.equal(r.inputs.fvlPercent,0);assert.equal(r.components.positive[0].points,0);
assert.equal(r.displayLower,r.displayUpper);assert.equal(r.finalFrequency,null);assert.equal(r.frequencyStatus,'not_provided');
const missingFvl=pret();delete missingFvl.scoringFacts;assert.equal(c.calculateScore(missingFvl).status,'unrated');assert.equal(c.calculateScore(missingFvl).value,null);assert.equal(r.sourceData.source,p.sourceName);assert.equal(c.validResult(r),true);
for(const [raw,grade,value] of [[-17,'A',100],[0,'A',100],[1,'B',75],[2,'B',75],[3,'C',50],[10,'C',50],[11,'D',25],[18,'D',25],[19,'E',0],[55,'E',0]]) {
 for(const category of ['general','cheese','red_meat']){assert.equal(c.gradeFor(raw,category),grade);assert.equal(c.displayFor(raw,category),value);}
}
assert.deepEqual([...new Set(Array.from({length:73},(_,i)=>c.displayFor(i-17)))],[100,75,50,25,0]);
for(const value of [68,62,-1,101,undefined,null,NaN])assert.equal(c.bandFor(value),null);
for(const raw of [null,NaN,Infinity,-18,56,1.5])assert.equal(c.gradeFor(raw,'general'),null);
const reference={energy:[335,670,1005,1340,1675,2010,2345,2680,3015,3350],saturatedFat:[1,2,3,4,5,6,7,8,9,10],
 sugars:[3.4,6.8,10,14,17,20,24,27,31,34,37,41,44,48,51],salt:Array.from({length:20},(_,i)=>(i+1)/5),protein:[2.4,4.8,7.2,9.6,12,14,17],fibre:[3,4.1,5.2,6.3,7.4]};
for(const [key,thresholds] of Object.entries(reference)){
 assert.deepEqual(c.TABLES[key],thresholds);
 thresholds.forEach((t,i)=>{assert.equal(c.pointsFor(t,c.TABLES[key]),i);assert.equal(c.pointsFor(t+.0001,c.TABLES[key]),i+1);});
}
for(const [plant,expected] of [[0,50],[40,50],[50,50],[70,75],[80,75],[90,100]]) {
 const pp=pret();pp.scoringFacts={fvlPercent:{value:plant,source:'declared',evidence:'Synthetic QA only'}};
 const score=c.calculateScore(pp);assert.equal(score.value,expected);assert.equal(score.status,'rated');
 assert.equal(c.withPortion(score,2.39).finalFrequency,null,'Nutrition grades do not imply eating frequency');
}
for(const [key,unit] of [['energyKj','kJ'],['saturatedFat','g'],['sugars','g'],['salt','g'],['fibre','g'],['protein','g']]) {
 for(const missing of [null,{value:null,unit,status:'unknown'},{value:0,unit,status:'estimated'},{value:0,unit:'mg',status:'supplied'},{value:-1,unit,status:'supplied'},{value:NaN,unit,status:'supplied'},{value:Infinity,unit,status:'supplied'},{value:100,unit,status:'supplied',relation:'lt'}]){
  const pp=pret();if(key==='energyKj'){pp.energyKj=missing;delete pp.nutrients.energyKcal;}else pp.nutrients[key]=missing;
  const result=c.calculateScore(pp);assert.equal(result.value,null,key+' missing must not score');assert.equal(result.status,'unrated');
 }
}
for(const category of ['unknown','unsupported','unreviewed-category'])assert.equal(c.calculateScore(p,{category}).value,null);
assert.equal(c.calculateScore({...p,sourceKind:'meal'}).value,null,'No product-score bypass for photo meals');
for(const [salt,frequency] of [[0,'Daily'],[1.999,'Daily'],[2,'Weekly'],[3.999,'Weekly'],[4,'Monthly'],[4.78,'Monthly']])assert.equal(c.frequency('Daily',salt).frequency,frequency);
for(const bad of [undefined,null,-1,NaN,Infinity,'2'])assert.equal(c.frequency('Daily',bad).finalFrequency,null);
for(const base of ['Weekly','Monthly'])assert.equal(c.frequency(base,0).finalFrequency,base,'Portion policy cannot improve base frequency');
for(const [multiplier,frequency] of [[.5,'Weekly'],[1,'Weekly'],[2,'Monthly']]) {
 const selected=c.withPortion(r,2.39*multiplier);assert.equal(selected.value,50);assert.equal(selected.grade,'C');assert.equal(selected.finalFrequency,null);
 assert.equal(selected.frequencyPolicy,null);assert.equal(selected.frequencyStatus,'not_provided');
}
for(const [suitability,status] of [['confirmed_conflict','unsuitable'],['matched_recall','unsuitable'],['restriction_unresolved','check_required'],['unchecked','check_required']]) {
 const result=c.withPortion(r,0,{suitability});assert.equal(result.value,50);assert.equal(result.finalFrequency,null);assert.equal(result.frequencyStatus,'not_provided');assert.equal(result.personalSuitability,suitability);
}
for(const exclusion of ['children','clinical diets','special medical nutrition','specialist sports products','pregnancy-specific advice'])assert.equal(c.withPortion(r,0,{exclusions:[exclusion]}).frequencyStatus,'not_provided');
const meat=pret();meat.nutrients.protein=n(30);
assert.equal(c.calculateScore(meat,{category:'red_meat'}).components.positive.find(p=>p.id==='protein').points,2);
meat.nutrients.salt=n(2.4);assert.equal(c.calculateScore(meat,{category:'general'}).countProteins,false);assert.equal(c.calculateScore(meat,{category:'cheese'}).countProteins,true);
// Retained, independently reviewed category engines: official category grade
// edges, inclusive fat ratio, beverage NNS and water exception (FAQ pp29–33).
for(const [raw,grade] of [[-6,'A'],[-5,'B'],[2,'B'],[3,'C'],[10,'C'],[11,'D'],[18,'D'],[19,'E']])assert.equal(c.gradeFor(raw,'fats_nuts_seeds'),grade);
for(const [raw,grade] of [[-10,'B'],[2,'B'],[3,'C'],[6,'C'],[7,'D'],[9,'D'],[10,'E']])assert.equal(c.gradeFor(raw,'beverage'),grade);
for(const [ratio,points] of [[9.999,0],[10,1],[16,2],[64,10]])assert.equal(c.pointsFor(ratio,c.TABLES.saturateRatio,true),points);
const water=c.calculateScore({name:'water',basisUnit:'ml',nutritionPreparation:'as_sold'});assert.equal(water.value,100);assert.equal(water.grade,'A');assert.equal(c.withPortion(water,null).finalFrequency,null);
const original={methodId:'nudge_label_v0_1',value:68,rawScore:1,grade:'B'},saved=JSON.stringify(original);
assert.equal(c.validResult(original),false);assert.equal(JSON.stringify(original),saved);assert.notEqual(c.calculateScore(p).value,75,'No snapping a legacy number');
const html=c.renderDial(50);assert.match(html,/<svg viewBox="0 0 240 132"/);assert.match(html,/nf-dial-marker" cx="120.000" cy="14.000"/);assert.doesNotMatch(html,/nf-score-discrete|nf-grade-step/);
console.log('Passed v0.3: synthetic-FVL Pret50, all fixed grades, exact thresholds, six essential fields, strict packaged FVL boundary, category engines, separate legacy salt-policy boundaries, no product frequency inference, immutable provenance and approved gauge display.');

// Cached/admitted scores must have a coherent grade, method and base band; malformed data is inert.
{ const valid=c.calculateScore(pret());
  assert.equal(c.validResult({...valid,rawScore:-100,grade:null,value:undefined}),false);
  assert.equal(c.validResult({...valid,version:'old'}),false);
  assert.equal(c.validResult({...valid,band:{id:'monthly',label:'Monthly'}}),false);
}
