const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function boot(enabled=true){
  const messages=[],visits=[],products=[];let camera=0,saved=0;
  const context={__nudgeNativeProductSearch:enabled,webkit:{messageHandlers:{nudgeBarcode:{postMessage:m=>messages.push(m)}}}};
  context.window=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web/native-search.js'),'utf8'),context);
  const bridge=context.createNudgeNativeSearch({navigate:s=>{visits.push(s);bridge.sync(s);},barcode:{openSearchProduct:p=>{products.push(p);bridge.sync('barcode');}},search:{showSaved:()=>{saved++;bridge.sync('search');}},camera:()=>camera++});
  return {bridge,messages,visits,products,camera:()=>camera,saved:()=>saved};
}
test('native discovery hands products to existing review, without a second diary write path',()=>{
  const a=boot();assert.equal(a.bridge.navigate('search'),true);assert.equal(a.messages.at(-1).active,true);
  a.bridge.sync('search');assert.equal(a.messages.length,1,'Repeated renders do not cause native update loops');
  const p={barcode:'1234567890123',name:'Test product',nutrients:{protein:{value:null}}};
  assert.equal(a.bridge.openProduct(p),true);assert.equal(a.products[0],p);assert.equal(a.messages.at(-1).active,false);
  assert.equal(a.bridge.navigate('camera'),true);assert.equal(a.camera(),1);
});
test('saved foods route remains accessible; explicit Search navigation restores native discovery',()=>{
  const a=boot();a.bridge.showSaved();assert.equal(a.saved(),1);assert.equal(a.messages.at(-1).active,false);
  a.bridge.sync('barcode');a.bridge.sync('search');assert.equal(a.messages.at(-1).active,false);
  a.bridge.navigate('search');assert.equal(a.messages.at(-1).active,true);
});
test('browser fallback and route/input boundaries cannot activate native commands',()=>{
  const a=boot(false);assert.equal(a.bridge.navigate('search'),false);assert.equal(a.bridge.showSaved(),false);a.bridge.sync('search');assert.equal(a.messages.length,0);
  const b=boot();assert.equal(b.bridge.navigate('javascript:bad'),false);assert.equal(b.bridge.openProduct({barcode:'bad',name:'Test'}),false);assert.equal(b.products.length,0);
});
