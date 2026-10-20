// Catalogue rules and async controller checks use synthetic evidence, never production recommendations.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const plain=v=>JSON.parse(JSON.stringify(v));
const context={console,window:null,document:{},Date,Math};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web/core/nudge-score.js'),'utf8'),context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../Web/barcode.js'),'utf8'),context);
const rules=context.NudgeAlternatives;
for(const [source,title] of [['Farmfoods','Farmfoods'],['Heron Foods','Heron Foods'],['Booths','Booths'],['Budgens','Budgens'],['SPAR','SPAR'],['Boots','Boots']])assert.equal(rules.canonicalRetailer(source),title);
const scored=(lower,upper=lower,more={})=>({status:lower===upper?'rated':'provisional',methodId:context.NudgeScoreCore.SCORE_METHOD,version:context.NudgeScoreCore.SCORE_VERSION,rawScore:({0:19,25:11,50:4,75:1,100:0})[lower],grade:({0:'E',25:'D',50:'C',75:'B',100:'A'})[lower],category:'general',baseFrequency:null,finalFrequency:null,frequencyStatus:'not_provided',value:lower,displayLower:lower,displayUpper:upper,calculationBasis:{per:100,unit:'g',preparation:'as_sold'},...more});
const product=(id,q,more={})=>({barcode:id,name:'Synthetic snack '+id,categories:['en:snacks','en:cereal-bars'],basisUnit:'g',nutritionPreparation:'as_sold',sourceName:'Test catalogue',sourceURL:'https://example.test/product/'+id,retrievedAt:'2026-10-03T10:00:00Z',ingredients:'Oats, water',labelsTags:[],ingredientsAnalysisTags:[],testScore:typeof q==='number'?scored(q):q,...more});
context.NudgeFoodDetailModel={score:p=>p?.testScore,scoreFingerprint:p=>JSON.stringify([p?.testScore,p?.ingredients]),allergies:p=>({conflict:Boolean(p.conflict),unknown:Boolean(p.unknownAllergens)})};
const select=(p,c,o)=>plain(rules.select(p,c,o)).map(x=>x.product.barcode);
for(const q of [0,25,50,75,100])assert.equal(select(product('current',q),[product('candidate',75)]).length,q<75?1:0);
assert.deepEqual(select(product('current',25),[product('equal',25),product('above',50)]),['above']);
assert.deepEqual(select(product('current',75),[product('equal',75),product('better',100)]),['better'],'Good scores can still have better comparable options');
assert.deepEqual(select(product('current',100),[product('equal',100)]),[]);
for(const [lo,hi,show] of [[25,25,true],[0,0,true],[25,50,false],[40,56,false]])assert.equal(select(product('current',scored(lo,hi)),[product('candidate',75)]).length,show?1:0);
for(const invalid of [null,scored(-1),scored(101),scored(NaN),scored(26),scored(25,50,{status:'rated'}),scored(25,0),scored(25,25,{methodId:'nutri-score-2023'}),scored(25,25,{version:''}),scored(25,25,{calculationBasis:{per:100,unit:'ml',preparation:'as_sold'}})])assert.equal(select(product('current',invalid),[product('candidate',75)]).length,0);
const current=product('current',25,{brand:'The Cotswold Bakery'}),candidates=[product('other82',100,{retailer:'Tesco'}),product('ms74',75,{brand:'Marks & Spencer'}),product('other72',75,{retailer:'Waitrose'}),product('ms64',75,{brand:'M&S Food'})];
assert.deepEqual(select(current,candidates),['other82','ms64','ms74','other72']);
for(const brand of ['M&S','M&S Food','Marks & Spencer','Marks and Spencer'])assert.deepEqual(select({...current,brand},candidates),['ms64','ms74','other82','other72']);
assert.deepEqual(select({...current,retailer:'Tesco'},candidates),['other82','ms64','ms74','other72']);
const selectedShopCandidates=[product('sainsburys-own',75,{brand:'Sainsbury’s',stores:['en:sainsbury-s']}),product('sainsburys-better',100,{brand:'Independent',stores:['Sainsburys','Tesco']}),product('brand-only',100,{brand:'Sainsbury’s',stores:['Tesco']}),product('other-shop',100,{brand:'M&S Food',stores:['M&S']})];
assert.deepEqual(select({...current,brand:'M&S'},selectedShopCandidates,{preferredRetailer:'Sainsbury’s'}),['sainsburys-better','sainsburys-own','brand-only','other-shop'],'Selected supermarket uses source listings, then rating, regardless of scanned or candidate brand');
assert.deepEqual(select(current,[...selectedShopCandidates,product('lower',0,{stores:['Sainsburys']}),product('conflict',100,{stores:['Sainsburys'],labelsTags:['en:milk-free'],conflict:true})],{preferredRetailer:'Sainsbury’s',avoidMilk:true}),[],'Selected store never bypasses a lower score or unsupported/conflicting dietary evidence');
assert.equal(rules.retailer({...current,ingredients:'Sourced for M&S',brand:'Unrelated manufacturer'}),null);
assert.equal(rules.retailer({...current,stores:['Tesco','M&S']}),null);
assert.deepEqual(select(current,[product('same2',75),product('same1',75),product('same2',75),product('current',75)]),['same1','same2']);
for(const p of [product('a',scored(60,70)),product('a',scored(70,70,{version:'2'})),product('a',75,{categories:['en:drinks']}),product('a',75,{basisUnit:'ml'}),product('a',75,{nutritionPreparation:'prepared'}),product('a',75,{sourceURL:''}),product('a',75,{retrievedAt:''}),product('',70)])assert.deepEqual(select(current,[p]),[]);
const both=product('both',75,{labelsTags:['en:gluten-free','en:vegan']}),vegan=product('vegan',75,{labelsTags:['en:vegan']}),glutenfree=product('gf',75,{labelsTags:['en:gluten-free']}),unknown=product('unknown',75);
assert.deepEqual(select(current,[both,vegan,glutenfree,unknown],{profile:{diet:'vegan',avoids:['gluten']}}),['both']);
assert.deepEqual(select(current,[{...both,conflict:true}],{profile:{diet:'vegan',avoids:['gluten']}}),[],'Cross-contact/ingredient conflict overrides positive dietary claim');
assert.deepEqual(select(current,[{...both,unknownAllergens:true}],{profile:{avoids:['gluten']}}),[]);
assert.deepEqual(select(current,[product('milk',75,{labelsTags:['en:vegan']})],{avoidMilk:true}),[],'Vegan is not a milk-allergy absence guarantee');
assert.deepEqual(select(current,[product('milk',75,{labelsTags:['en:milk-free']})],{avoidMilk:true}),['milk']);
// Recovering readable label text must not turn discarded optional evidence
// into confirmation of suitability, even when an older catalogue claim remains.
for(const field of ['allergens','ingredients','claims']){
 const recovered=product('recovered',75,{labelsTags:['en:vegan','en:vegetarian','en:milk-free','en:gluten-free'],metadata:{missingFields:[field],allergenWording:{contains:null,mayContain:null,factoryHandling:null}}});
 for(const restrictions of [{profile:{diet:'vegan'}},{profile:{diet:'vegetarian'}},{profile:{avoids:['gluten']}},{avoidMilk:true}])assert.deepEqual(select(current,[recovered],restrictions),[],field+' missing must block restricted alternatives');
 for(const profile of [{},{diet:'any'},{diet:'mixed'}])assert.deepEqual(select(current,[recovered],{profile}),['recovered'],'Unrestricted catalogue ranking is unchanged');
}
assert.deepEqual(select(current,[{...both,metadata:{missingFields:['netQuantity']}}],{profile:{diet:'vegan',avoids:['gluten']}}),['both'],'Unrelated missing package facts do not invalidate supported dietary evidence');
const messages=[],rendered=[];let p=current,profile={},draft='first',deleted=false;
context.NudgeHistory={isDeleted:()=>deleted};context.NudgeResults={imageURL:()=>null};context.webkit={messageHandlers:{nudgeBarcode:{postMessage:m=>messages.push(m)}}};
const controller=context.createNudgeAlternatives({render:()=>rendered.push(true),esc:x=>String(x).replace(/</g,'&lt;'),getProduct:()=>p,getProfile:()=>profile,getDraftId:()=>draft,prefix:'barcode'});
assert.equal(controller.screen(),'');assert.equal(messages.length,1,'Eligible lookup is automatic without retailer');const first=messages[0];
assert.equal(controller.screen(),'');assert.equal(messages.length,1,'Repeated paints do not duplicate in-flight queries');
controller.receive({type:'alternatives',requestId:'stale',products:candidates});assert.equal(controller.screen(),'');
controller.receive({type:'alternatives',requestId:first.requestId,products:candidates});let html=controller.screen();assert.match(html,/Better alternatives/);assert.match(html,/nf-alternative-track/);assert.match(html,/100<small>\/100/);assert.match(html,/1 of 4/);assert.doesNotMatch(html,/Find alternatives|stock|Next|Previous|position|shop selector|Safer/);assert.match(controller.sources(),/retrieved 2026/);
const original=JSON.stringify(p);controller.screen();assert.equal(JSON.stringify(p),original,'Rendering/swiping never changes the original product or intake');
profile={diet:'vegan'};assert.equal(controller.screen(),'');assert.equal(messages.length,2,'Dietary changes invalidate before painting and start a new lookup');
controller.receive({type:'alternatives',requestId:first.requestId,products:candidates});assert.equal(controller.screen(),'');
controller.receive({type:'alternatives-error',requestId:messages.at(-1).requestId});assert.equal(controller.screen(),'');assert.equal(messages.length,2,'Failures stay nonblocking without render retry loops');
profile={};draft='second';p={...current,captureRevision:2};assert.equal(controller.screen(),'');assert.equal(messages.length,3);
const old=messages.at(-1);p={...p,captureRevision:3};controller.receive({type:'alternatives',requestId:old.requestId,products:candidates});assert.equal(controller.screen(),'');assert.equal(messages.length,4,'Photo revision invalidates late results');
controller.receive({type:'alternatives',requestId:messages.at(-1).requestId,products:[both]});assert.match(controller.screen(),/Better alternatives/);
deleted=true;assert.equal(controller.screen(),'','Deleted scans cannot regain late alternatives');
console.log('Passed: strictly higher score thresholds, fixed v0.2 mapping, same method/basis, dietary and allergy evidence, retailer aliases, stable sorting, deduplication, source requirements, hidden failures, and stale/profile/revision/deletion invalidation.');
