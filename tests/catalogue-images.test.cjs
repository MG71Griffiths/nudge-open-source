// Existing catalogue sources must render through the native CSP boundary without
// changing product evidence, confirmation links, captured previews or intake.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {boot,product}=require('./food-detail.test.cjs');
const app=boot();app.sandbox.location={protocol:'nudge-local:'};
for(const file of ['core/product-evidence.js','scan-results.js','food-detail-screen.js'])vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),app.sandbox);
const results=app.sandbox.NudgeResults,source='https://images.openfoodfacts.org/images/products/123/front_en.5.400.jpg',photo='data:image/jpeg;base64,YWJj';
const route='/catalogue-image?url='+encodeURIComponent(source);
for(const key of ['imageURL','imageUrl','imageFrontURL']){
  const p={[key]:source},before=JSON.stringify(p);
  assert.equal(results.productImage(p,photo).src,route);assert.equal(results.productImage(p,photo).fallback,photo);
  assert.equal(JSON.stringify(p),before,'Only display gets a local cache route; source URLs remain evidence');
}
assert.equal(results.productImage({imageURL:'javascript:bad',imageFrontURL:source}).src,route);
for(const source of ['http://images.openfoodfacts.org/a.jpg','https://images.openfoodfacts.org.evil.test/a.jpg','https://world.openfoodfacts.org/a.jpg','https://user@images.openfoodfacts.org/a.jpg','https://images.openfoodfacts.org:443/a.jpg','https://images.openfoodfacts.org/a.svg','https://images.openfoodfacts.org/a.jpg?token=private','https://images.openfoodfacts.org/a.jpg#x','https://images.openfoodfacts.org/../a.jpg','https://images.openfoodfacts.org/%2e%2e/a.jpg','file:///a.jpg','data:image/svg+xml,anything']){
  assert.equal(results.productImage({imageURL:source},photo).src,photo,source);
}
assert.ok(results.productImage({imageURL:'https://images.openfoodfacts.net/front.webp'}).src.startsWith('/catalogue-image?'));
assert.equal(results.imageURL(source),source,'Native camera gets the verified remote source, not a WebKit-only route');
app.receive({...product,imageURL:source});app.controller._scan.thumbnail=photo;
assert.match(app.controller.screen(),/class="nf-product-photo" src="\/catalogue-image\?url=/);
assert.match(app.controller.screen(),/data-nudge-fallback="data:image\/jpeg/);
assert.equal(app.data.foodLog.entries.length,0);
app.action('detail-log');assert.equal(app.data.foodLog.entries.length,1);
const intake=JSON.stringify(app.data),imageTarget={tagName:'IMG',dataset:{nudgeFallback:photo},style:{},src:route,matches:()=>true,getAttribute(){return this.src},setAttribute(k,v){this[k]=v},removeAttribute(k){delete this[k]}};
results.imageFailed(imageTarget);assert.equal(imageTarget.src,photo);assert.equal(imageTarget.dataset.nudgeFallback,undefined);
results.imageFailed(imageTarget);assert.equal(imageTarget.style.visibility,'hidden');assert.equal(JSON.stringify(app.data),intake);

// Load persisted history with its confirmed intake, then revisit All/Scanned/Eaten
// and the linked detail. No migration, re-scan, API request or diary write required.
const stored=new Map(),entries=[{id:'eaten-1',name:'Catalogue fixture',day:'2026-10-04',slot:'Snack',portions:1,plants:[],ferments:[],portionAmount:15,portionUnit:'g',energyPerPortion:90,proteinPerPortion:4,fibrePerPortion:1,sourceMeta:{entryKind:'product-consumption',productScanEventId:'scan-1',confirmationId:'eaten-1'}}];
const historyRecord={id:'scan-1',kind:'product',status:'ready',createdAt:'2026-10-04T18:00:00Z',name:'Catalogue fixture',product:{...product,imageURL:source},thumbnail:photo,entryId:'eaten-1'};
stored.set('nudge-scan-history-v1',JSON.stringify({version:3,events:[historyRecord],favourites:[]}));
let writes=0,opened;
const s={console,Date,Math,location:{protocol:'nudge-local:'},document:{getElementById:()=>null},localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>{writes++;stored.set(k,v)}}};s.window=s;s.NudgeIcons=()=>'';s.NudgeBarcode={openStored:(item,options)=>{opened={item,options}}};vm.createContext(s);
for(const file of ['core/diary.js','streaks.js','core/product-evidence.js','scan-results.js','scan-history.js'])vm.runInContext(fs.readFileSync('Web/'+file,'utf8'),s,{filename:file});
const data={foodLog:{entries}},before=JSON.stringify(data),storageBefore=JSON.stringify([...stored]);
const h=s.createNudgeHistory({getState:()=>data,view:{},escapeHtml:v=>String(v??''),todayKey:()=> '2026-10-04',render(){},navigate(){},showToast(){},save(){throw Error('Image presentation cannot write intake')}});
for(const filter of ['all','scanned','eaten']){
 h.handleAction('history-filter',filter);const html=h.screen();assert.match(html,/class="n-history-photo" src="\/catalogue-image\?url=/);assert.match(html,/✓ Eaten/);assert.equal((html.match(/data-action="history-open"/g)||[]).length,1);
}
h.reopen('scan-1');assert.equal(opened.item.product.imageURL,source);assert.equal(opened.item.thumbnail,photo);assert.equal(opened.options.entryId,'eaten-1');assert.equal(results.productImage(opened.item.product,opened.item.thumbnail).src,route);
assert.equal(JSON.stringify(data),before);assert.equal(JSON.stringify([...stored]),storageBefore);assert.equal(writes,0);
s.location.protocol='http:';assert.equal(s.NudgeResults.productImage({imageURL:source}).src,source,'Browser preview keeps the approved remote source');
console.log('Passed: native catalogue image route, approved aliases/hosts, capture fallback, existing History/Scanned/Eaten/detail images and original source/intake preserved without rescanning.');
