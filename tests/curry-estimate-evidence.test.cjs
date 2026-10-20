const assert=require('node:assert/strict');require('../Web/core/nudge-score.js');const score=require('../Web/core/meal-score.js');
const curry={name:'Green Thai Curry',components:[{name:'green thai curry',preparation:'cooked',amountGrams:600,recordId:null,sourceRecord:null,nutrients:{}}],qualityEstimate:{wholePlants:'medium',wholeGrains:'no',legumesNuts:'no',proteinType:'poultry_egg',refinedStarch:'no',sugaryFood:'yes',frying:'yes',evidence:'Chicken curry with vegetables, oil and honey as a sugar source; typical preparation notes for frying and oil use.'}};
const before=JSON.stringify(curry),result=score.calculate(curry);
assert.equal(JSON.stringify(curry),before);assert.equal(result.status,'estimated_rough');assert.equal(result.value,60);assert.equal(result.factors.frying,'unknown');assert.equal(result.factors.sugaryFood,'unknown');assert.equal(result.grade,null);
const fried=score.calculate({...curry,qualityEstimate:{...curry.qualityEstimate,evidence:'Deep-fried battered chicken in curry.'}});assert.equal(fried.factors.frying,'yes');assert.equal(fried.value,50);
const sugary=score.calculate({...curry,qualityEstimate:{...curry.qualityEstimate,evidence:'A very sweet, sugary curry sauce, not just a small seasoning amount.'}});assert.equal(sugary.factors.sugaryFood,'yes');assert.equal(sugary.value,40);
assert.equal(score.estimate({name:'Chocolate cake'}).factors.sugaryFood,'yes');
console.log('PASS: a savoury curry does not acquire sugary-food or deep-frying deductions from a little honey and cooking oil; explicit evidence still applies and source data stays unchanged.');
