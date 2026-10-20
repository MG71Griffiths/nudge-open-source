import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {catalogueFetch,readCatalogue,writeCatalogue,supplementProduct,CATALOGUE_VERSION,CATALOGUE_TTL_MS} from '../src/food-catalogue.js';

const barcode='5060178075250', now=Date.UTC(2026,9,4);
const payload=()=>({status:'success',product:{code:barcode,product_name:'Organic chickpeas',brands:'Synthetic foods',last_modified_t:1700000000,
  ingredients_text:'Chickpeas (60%), water',categories_tags:['en:chickpeas'],
  nutrition:{aggregated_set:{per:'100g',preparation:'as_sold',nutrients:{'energy-kcal':{value:100,unit:'kcal',source:'packaging'},proteins:{value:6.7,unit:'g'},fiber:{value:5.7,unit:'g'},salt:{value:.53,unit:'g'},sugars:{value:1,unit:'g'},'saturated-fat':{value:.3,unit:'g'}}}},
  image_front_url:'https://images.openfoodfacts.org/images/products/506/017/807/5250/front_en.1.400.jpg',
  selected_images:{front:{display:{en:'https://images.openfoodfacts.org/images/products/506/front.jpg'}}}
}});
const fetched=async(p=payload(),options={})=>catalogueFetch(barcode,{now,fetchImpl:async()=>Response.json(p),...options});
const store=()=>{const data=new Map();return {data,get:async key=>structuredClone(data.get(key)),put:async(key,value)=>data.set(key,structuredClone(value))};};
const product=()=>({name:'Organic chickpeas',brand:'Synthetic foods',barcode,basisUnit:'g',nutritionPreparation:'as_sold',nutrients:{energyKcal:{value:100,unit:'kcal',status:'supplied'},fibre:{value:null,unit:'g',status:'unknown'}}});

describe('server-owned public food catalogue',()=>{
  it('uses a fixed barcode-only endpoint with a timeout, never caller URLs or redirects',async()=>{
    let called=0;
    await fetched(payload(),{fetchImpl:async(url,init)=>{called++;assert.equal(new URL(url).origin,'https://world.openfoodfacts.org');assert.equal(new URL(url).pathname,`/api/v3.6/product/${barcode}.json`);assert.equal(init.redirect,'manual');assert.ok(init.signal);assert.equal(init.method,'GET');return Response.json(payload());}});
    assert.equal(called,1);
    await assert.rejects(()=>catalogueFetch('https://evil.example/secret',{fetchImpl:()=>{throw new Error('must not fetch');}}),/barcode/);
    await assert.rejects(()=>fetched(payload(),{fetchImpl:async()=>Response.redirect('https://evil.example')}),/unavailable/);
  });
  it('requires the returned barcode to equal the requested barcode',async()=>{
    const p=payload();p.product.code='1234567890123';await assert.rejects(()=>fetched(p),/identity/);
    delete p.product.code;await assert.rejects(()=>fetched(p),/identity/);
  });
  it('normalizes newer structured nutrition and leaves absent nutrients unknown',async()=>{
    const record=await fetched();assert.equal(record.product.nutrients.fibre.value,5.7);assert.equal(record.product.nutrients.fat.value,null);assert.equal(record.product.nutrients.fat.status,'unknown');
    assert.equal(record.product.basisUnit,'g');assert.equal(record.product.nutritionPreparation,'as_sold');assert.equal(record.product.sourceURL,`https://world.openfoodfacts.org/product/${barcode}`);
    assert.equal(record.providerPayload.product.selected_images.front.display.en,'https://images.openfoodfacts.org/images/products/506/front.jpg');
  });
  it('does not promote provider estimates or unsupported units to exact label evidence',async()=>{
    const p=payload();p.product.nutrition.aggregated_set.nutrients.fiber.source='estimate';p.product.nutrition.aggregated_set.nutrients.sugars.unit='mg';
    const record=await fetched(p),result=supplementProduct(product(),record);
    assert.equal(record.product.nutrients.fibre.status,'estimated');assert.equal(result.product.nutrients.fibre.value,null);assert.equal(record.product.nutrients.sugars.value,null);
  });
  it('never mixes prepared structured values with legacy as-sold values',async()=>{
    const p=payload();p.product.nutrition.aggregated_set.preparation='prepared';delete p.product.nutrition.aggregated_set.nutrients.fiber;p.product.nutriments={fiber_100g:99};
    const record=await fetched(p);assert.equal(record.product.nutrients.fibre.value,null);assert.equal(supplementProduct(product(),record).status,'conflict');
  });
  it('keeps an unrecognized serving basis unknown instead of interpreting it as per100g',async()=>{
    const p=payload();p.product.nutrition.aggregated_set.per='serving';p.product.nutriments={fiber_100g:99};
    const record=await fetched(p);assert.equal(record.product.basisUnit,null);assert.equal(record.product.nutrients.fibre.value,null);
  });
  it('preserves inequalities and does not equate a trace or absent nutrient to zero',async()=>{
    const p=payload();p.product.nutrition.aggregated_set.nutrients.salt.modifier='<';p.product.nutrition.aggregated_set.nutrients.fiber.value='trace';
    const record=await fetched(p);assert.equal(record.product.nutrients.salt.relation,'<');assert.equal(record.product.nutrients.fibre.value,null);
  });
  it('strips private/client-only fields and off-domain image URLs from the stored raw subset',async()=>{
    const p=payload();Object.assign(p.product,{voiceMemo:'private speech',diary:'private',apiKey:'private',image_front_url:'https://evil.example/track',sourceURL:'https://evil.example'});
    const record=await fetched(p),serial=JSON.stringify(record);assert.doesNotMatch(serial,/private|evil\.example/);assert.equal(record.providerPayload.product.image_front_url,null);
  });
  it('persists source facts with version, expiry, attribution and guards against poisoned normalized facts',async()=>{
    const storage=store(),record=await fetched();record.product.nutrients.salt.value=0;record.product.ingredients='invented client claim';
    await writeCatalogue(storage,record,{now});const read=await readCatalogue(storage,barcode,{now});assert.equal(read.product.nutrients.salt.value,.53);assert.equal(read.product.ingredients,'Chickpeas (60%), water');assert.equal(read.version,CATALOGUE_VERSION);assert.match(read.licenceURL,/odbl/);
    assert.equal(await readCatalogue(storage,barcode,{now:now+CATALOGUE_TTL_MS}),null);
    storage.data.get('public-food-record').version='old';assert.equal(await readCatalogue(storage,barcode,{now}),null);
  });
  it('refuses caller objects without internal source metadata and stale source updates',async()=>{
    const storage=store();await assert.rejects(()=>writeCatalogue(storage,{...product(),sourceName:'Open Food Facts',verified:true},{now}),/Invalid/);
    const newer=await fetched(payload(),{now:now+1000});await writeCatalogue(storage,newer,{now:now+1000});await writeCatalogue(storage,await fetched(),{now:now+1000});assert.equal((await readCatalogue(storage,barcode,{now:now+1000})).fetchedAt,now+1000);
    const changed=payload();changed.product.last_modified_t=1600000000;await writeCatalogue(storage,await fetched(changed,{now:now+2000}),{now:now+2000});assert.equal((await readCatalogue(storage,barcode,{now:now+2000})).sourceUpdatedAt,1700000000);
  });
  it('supplements missing exact facts only and never mutates input',async()=>{
    const input=product(),before=structuredClone(input),result=supplementProduct(input,await fetched());
    assert.deepEqual(input,before);assert.equal(result.status,'supplemented');assert.equal(result.product.nutrients.fibre.value,5.7);assert.equal(result.product.nutrients.energyKcal.value,100);assert.ok(result.provenance[0].fields.includes('fibre'));assert.equal(result.product.nutrients.fat,undefined);
  });
  it('protects brand, variant, preparation, per100 basis and unknown identity',async()=>{
    const record=await fetched();
    for(const change of [{brand:'Different brand'},{name:'Sweetened organic chickpeas'},{name:'Drained organic chickpeas'},{name:'Chocolate almonds'},{basisUnit:'ml'},{basisUnit:null},{nutritionPreparation:'prepared'},{barcode:'1234567890123'}]){
      const input={...product(),...change},result=supplementProduct(input,record);assert.equal(result.status,'conflict',JSON.stringify(change));assert.deepEqual(result.product,input);
    }
  });
  it('does not merge different recipe panels when a known value conflicts',async()=>{
    const input=product();input.nutrients.energyKcal.value=400;
    const result=supplementProduct(input,await fetched());assert.equal(result.status,'conflicting_values');assert.equal(result.product.nutrients.fibre.value,null);assert.deepEqual(result.product,input);assert.deepEqual(result.addedFields,[]);
  });
  it('limits source response size without buffering an unbounded body',async()=>{
    await assert.rejects(()=>fetched(payload(),{fetchImpl:async()=>new Response(' '.repeat(512001))}),/too large/);
  });
});
