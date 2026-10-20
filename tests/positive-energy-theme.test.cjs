const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const tokens=JSON.parse(fs.readFileSync('Web/theme-tokens.json','utf8'));
const palette=fs.readFileSync('Web/approved.css','utf8'),shared=fs.readFileSync('Web/shared-controls.css','utf8'),html=fs.readFileSync('Web/index.html','utf8');
function lum(hex){const c=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]}
function contrast(a,b){const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
const kebab=k=>k.replace(/[A-Z]/g,m=>'-'+m.toLowerCase());
for(const mode of ['light','dark']){
 const t=tokens[mode];for(const [name,color] of Object.entries(t))assert.ok(palette.includes('--n-'+kebab(name)+':'+color),mode+' '+name);
 for(const [fg,bg] of [['ink','canvas'],['ink','surface'],['muted','canvas'],['muted','surface'],['accent','selectedSurface'],['primaryText','primaryFill'],['plantText','plantSurface'],['successText','successSurface'],['errorText','errorSurface'],['warningText','warningSurface']])assert.ok(contrast(t[fg],t[bg])>=4.5,`${mode} ${fg}/${bg} contrast ${contrast(t[fg],t[bg])}`);
 for(const [fg,bg] of [['progressFill','progressTrack'],['strongBorder','surface'],['accent','surface'],['plantText','plantSurface']])assert.ok(contrast(t[fg],t[bg])>=3,`${mode} graphic ${fg}/${bg} contrast ${contrast(t[fg],t[bg])}`);
}
assert.equal(tokens.version,'3.1.0');
const objectiveNames=['protein','energy','carbs','fat','fibre','plants'];
assert.equal(new Set(objectiveNames.map(name=>tokens.objectiveMetrics[name])).size,6,'Each objective has its own colour');
for(const name of objectiveNames)assert.ok(palette.includes('--n-metric-'+name+':'+tokens.objectiveMetrics[name]),'Central objective colour: '+name);
assert.equal(tokens.objectiveMetrics.fat,tokens.light.accent);assert.equal(tokens.objectiveMetrics.darkOverrides.fat,tokens.dark.accent);
assert.ok(palette.includes('--n-metric-fat:'+tokens.objectiveMetrics.darkOverrides.fat),'Fat uses its approved dark tint');
assert.deepEqual(tokens.nutritionScale.scores,{A:100,B:75,C:50,D:25,E:0});
for(const mode of ['light','dark'])for(const band of tokens.frequencyDisplay.bands){
 for(const role of ['Mark','Badge','Text'])assert.ok(palette.includes('--n-frequency-'+band.id+'-'+role.toLowerCase()+':'+band[mode+role]));
 assert.ok(contrast(band[mode+'Text'],band[mode+'Badge'])>=4.5,mode+' '+band.id+' badge contrast');
 assert.ok(contrast(band[mode+'Mark'],tokens[mode].canvas)>=3,mode+' '+band.id+' marker contrast');
}
assert.doesNotMatch(html,/<button class="avatar"/);assert.match(html,/data-value="you"/);assert.match(html,/result-close/);assert.match(html,/result-favourite/);
assert.match(shared,/\.button\.primary[^}]+color:var\(--n-primary-text\)/);
assert.match(shared,/prefers-reduced-motion:reduce/);assert.match(palette,/prefers-contrast:more/);
// Only central tokens, explicitly preserved crew illustration and Apple Health mark may contain literal colours.
for(const file of fs.readdirSync('Web').filter(f=>f.endsWith('.css'))){if(file==='approved.css'||file==='analysis-crew.css')continue;let s=fs.readFileSync(path.join('Web',file),'utf8');if(file==='nudge-fit.css')s=s.replace('color:#d9869b','color:preserved-apple-health');assert.doesNotMatch(s,/#[\da-f]{3,8}\b/i,'Uncentralised colour in '+file);}
// Photo/media assets have no filter that recolours pixels. CSS compatibility names do not imply purple UI.
for(const file of fs.readdirSync('Web').filter(f=>f.endsWith('.css')))assert.doesNotMatch(fs.readFileSync(path.join('Web',file),'utf8'),/hue-rotate\(|filter\s*:\s*(?:sepia|saturate|invert)\(/,file);
console.log('PASS Positive Energy: all supplied light/dark roles, text/graphic contrast, central palette exceptions, primary contrast, preserved artwork and shell controls.');
