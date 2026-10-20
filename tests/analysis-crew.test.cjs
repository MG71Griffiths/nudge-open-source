'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const handlers = {}, classes = new Set();
const root = {dataset:{},querySelector(){return button;}};
const button = {textContent:'',attributes:{},setAttribute(k,v){this.attributes[k]=v;}};
const document = {hidden:false,documentElement:{classList:{toggle(k,v){v?classes.add(k):classes.delete(k);},add(k){classes.add(k);}}},addEventListener(k,f){handlers[k]=f;},querySelectorAll(){return [root];}};
const window = {addEventListener(k,f){handlers[k]=f;}};
vm.runInNewContext(fs.readFileSync('Web/analysis-crew.js','utf8'),{window,document});
for(const kind of ['food','product','meal','barcode']){
  const html = window.NudgeAnalysisCrew({kind});
  assert.equal((html.match(/data-crew-state="running"/g)||[]).length,1);
  assert.equal((html.match(/data-crew-state="pending"/g)||[]).length,2);
  assert(!html.includes('data-crew-state="complete"'));
  assert(!/recall|all good|100%|See result/.test(html));
  assert(html.includes('data-crew-toggle'));
  for(const part of ['nc-arm','nc-foot','nc-blink'])assert(html.includes(part));
}
const checking=window.NudgeAnalysisCrew({kind:'barcode',stage:'checking'});
assert(!checking.includes('data-crew-state="complete"'),'A later stage does not imply prior completion');
assert(window.NudgeAnalysisCrew({states:{reading:'complete'}}).includes('data-crew-state="complete"'));
handlers.click({target:{closest(){return button;}}});assert.equal(window.NudgeAnalysisMotion.paused,true);assert.equal(root.dataset.crewPaused,'true');assert.equal(button.textContent,'Resume animation');
handlers.click({target:{closest(){return button;}}});assert.equal(window.NudgeAnalysisMotion.paused,false);assert.equal(button.attributes['aria-pressed'],'false');
document.hidden=true;handlers.visibilitychange();assert(classes.has('n-analysis-hidden'));
document.hidden=false;handlers.pageshow();assert(!classes.has('n-analysis-hidden'));handlers.pagehide();assert(classes.has('n-analysis-hidden'));
const css=fs.readFileSync('Web/analysis-crew.css','utf8');assert(css.includes('prefers-reduced-motion:reduce'));assert(css.includes('data-crew-paused=true'));assert(css.includes('nc-arm-swing'));assert(css.includes('nc-footstep'));assert(css.includes('nc-blink'));
console.log('Analysis crew: route status honesty, articulated art, pause and lifecycle checks passed.');
