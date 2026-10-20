import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {catalogueRecordFromPayload} from '../src/food-catalogue.js';
import {LABEL_EVIDENCE_VERSION,applyCatalogueLabelEvidence,publicCatalogueLabelImages} from '../src/catalogue-label-evidence.js';

const now=Date.now(),barcode='5000000000018';
function fixture(){
  const url='https://images.openfoodfacts.org/images/products/500/000/000/0018/nutrition_en.3.400.jpg';
  const raw={code:barcode,product_name:'Plain lentils',last_modified_t:1234,categories_tags:['en:lentils'],ingredients_text:'Lentils',nutriments:{proteins_100g:24},image_nutrition_url:url};
  const product=catalogueRecordFromPayload({product:raw},barcode,now).product;
  const extraction={conflictingProduct:false,basis:'100g',basisQuote:'Nutrition per 100 g',preparation:'as_sold',preparationQuote:null,
    nutrients:Object.fromEntries(['energyKcal','energyKj','protein','carbohydrate','sugars','fat','saturatedFat','fibre','salt'].map(k=>[k,null])),ingredients:null,ingredientsImageIndex:null};
  extraction.nutrients.salt={value:0.03,quote:'Salt 0.03 g',imageIndex:0};
  return {raw,product,evidence:{version:LABEL_EVIDENCE_VERSION,barcode,sourceRevision:1234,sourceURL:`https://world.openfoodfacts.org/product/${barcode}`,images:[{role:'nutrition',url}],extraction}};
}
describe('public packaging evidence',()=>{
  it('honours explicit legacy per-100-ml basis even without package quantity',()=>{
    const f=fixture();f.raw.nutrition_data_per='100ml';
    const p=catalogueRecordFromPayload({product:f.raw},barcode,now).product;
    assert.equal(p.basisUnit,'ml');assert.throws(()=>applyCatalogueLabelEvidence(f.raw,p,f.evidence));
    f.raw.nutrition_data_per='100g';f.raw.quantity='500 ml';assert.equal(catalogueRecordFromPayload({product:f.raw},barcode,now).product.basisUnit,'g');
  });
  it('retains source-bound nutrition photos but never mutates original label or fills unknown zeros',()=>{
    const f=fixture(),before=structuredClone(f.product),result=applyCatalogueLabelEvidence(f.raw,f.product,f.evidence);
    assert.equal(publicCatalogueLabelImages(f.raw).length,1);
    assert.equal(result.projection.nutrients.salt.value,0.03);assert.equal(result.projection.nutrients.salt.status,'estimated');
    assert.equal(result.projection.nutrients.protein.value,24);assert.equal(result.projection.nutrients.fibre.value,null);
    assert.deepEqual(f.product,before);assert.equal(result.provenance.verification,'unverified_public_label_extraction');
  });
  it('rejects arbitrary images, identity/revision drift and incorrect preparation or measurement basis',()=>{
    const edits=[f=>f.evidence.barcode='99999999',f=>f.evidence.sourceRevision++,f=>f.evidence.images[0].url='https://example.com/nutrition.jpg',
      f=>f.evidence.images[0].role='ingredients',f=>f.evidence.extraction.basis='100ml',f=>f.evidence.extraction.preparation='prepared',
      f=>f.evidence.extraction.conflictingProduct=true,f=>f.evidence.extraction.nutrients.salt.quote='Salt <0.03 g'];
    for(const edit of edits){const f=fixture();edit(f);assert.throws(()=>applyCatalogueLabelEvidence(f.raw,f.product,f.evidence));}
  });
  it('requires the exact numeric row quotation and does not overwrite conflicting source facts',()=>{
    for(const quote of ['Salt 3 g','Sodium 0.03 g','Salt 0.03 mg']){const f=fixture();f.evidence.extraction.nutrients.salt.quote=quote;assert.throws(()=>applyCatalogueLabelEvidence(f.raw,f.product,f.evidence));}
    const f=fixture();f.evidence.extraction.nutrients.protein={value:12,quote:'Protein 12 g',imageIndex:0};assert.throws(()=>applyCatalogueLabelEvidence(f.raw,f.product,f.evidence));
  });
  it('binds registered images to the exact barcode and role, rejecting normalized-path tricks',()=>{
    const badURLs=[
      'https://images.openfoodfacts.org/images/products/999/999/999/9999/nutrition_en.3.400.jpg',
      'https://images.openfoodfacts.org/images/products/500/000/000/0018/ingredients_en.3.400.jpg',
      'https://images.openfoodfacts.org/images/products/050/000/000/00018/nutrition_en.3.400.jpg',
      'https://images.openfoodfacts.org/images/products/500/000/000/0018/%6eutrition_en.3.400.jpg',
      'https://images.openfoodfacts.org/images/products/999/../500/000/000/0018/nutrition_en.3.400.jpg',
      'https://images.openfoodfacts.org/images/products/500/000/000/0018/nutrition_en.3.400.jpg?other=1'
    ];
    for(const url of badURLs){const f=fixture();f.raw.image_nutrition_url=url;f.evidence.images[0].url=url;
      assert.deepEqual(publicCatalogueLabelImages(f.raw),[],url);assert.throws(()=>applyCatalogueLabelEvidence(f.raw,f.product,f.evidence),undefined,url);}
    const f=fixture(),expected=f.evidence.images[0].url;
    f.raw.image_nutrition_url=badURLs[0];f.raw.selected_images={nutrition:{display:{en:expected}}};
    assert.deepEqual(publicCatalogueLabelImages(f.raw),[{role:'nutrition',url:expected}]);
    assert.equal(applyCatalogueLabelEvidence(f.raw,f.product,f.evidence).projection.nutrients.salt.value,0.03);
  });
  it('accepts a short barcode only when all image-directory digits match it',()=>{
    const f=fixture();f.raw.code='12345678';f.raw.image_nutrition_url='https://images.openfoodfacts.org/images/products/12345678/nutrition_en.3.400.jpg';
    assert.deepEqual(publicCatalogueLabelImages(f.raw),[{role:'nutrition',url:f.raw.image_nutrition_url}]);
    f.raw.code='012345678';assert.deepEqual(publicCatalogueLabelImages(f.raw),[]);
  });
  it('binds sugars to the sugar row rather than carbohydrate or a per-100-g heading',()=>{
    const f=fixture();f.evidence.extraction.nutrients.sugars={value:80,quote:'Carbohydrate 80 g of which sugars 5 g',imageIndex:0};
    assert.throws(()=>applyCatalogueLabelEvidence(f.raw,f.product,f.evidence));
    f.evidence.extraction.nutrients.sugars.value=5;
    assert.equal(applyCatalogueLabelEvidence(f.raw,f.product,f.evidence).projection.nutrients.sugars.value,5);
    for(const quote of ['Per 100 g Salt 0.03 g','Salt per 100 g: 0.03 g','Salt 0.03 g per 100 g']){
      const g=fixture();g.evidence.extraction.nutrients.salt={value:100,quote,imageIndex:0};assert.throws(()=>applyCatalogueLabelEvidence(g.raw,g.product,g.evidence));
    }
  });
  it('does not turn saturated, unsaturated or trans fat into a total-fat observation',()=>{
    for(const quote of ['Saturated fat 0.2 g','of which saturates 0.2 g','Monounsaturated fat 0.2 g','Unsaturated fat 0.2 g','Trans fat 0.2 g']){
      const f=fixture();f.evidence.extraction.nutrients.fat={value:0.2,quote,imageIndex:0};assert.throws(()=>applyCatalogueLabelEvidence(f.raw,f.product,f.evidence));
    }
    const f=fixture();f.evidence.extraction.nutrients.fat={value:2.5,quote:'Total fat: 2,5 g; of which saturated fat 0.2 g',imageIndex:0};
    f.evidence.extraction.nutrients.saturatedFat={value:0.2,quote:'Total fat: 2,5 g; of which saturated fat 0.2 g',imageIndex:0};
    const p=applyCatalogueLabelEvidence(f.raw,f.product,f.evidence).projection;
    assert.equal(p.nutrients.fat.value,2.5);assert.equal(p.nutrients.saturatedFat.value,0.2);
  });
  it('supports a dual kJ/kcal row in either order without mixing rows or units',()=>{
    for(const quote of ['Energy 1475 kJ / 350 kcal','Energy: 350 kcal (1475 kJ)','Energy 1475 kJ 350 kcal']){
      const f=fixture();Object.assign(f.evidence.extraction.nutrients,{energyKcal:{value:350,quote,imageIndex:0},energyKj:{value:1475,quote,imageIndex:0}});
      const p=applyCatalogueLabelEvidence(f.raw,f.product,f.evidence).projection;
      assert.equal(p.nutrients.energyKcal.value,350);assert.equal(p.energyKj.value,1475);
      f.evidence.extraction.nutrients.energyKcal.value=1475;assert.throws(()=>applyCatalogueLabelEvidence(f.raw,f.product,f.evidence));
    }
  });
  it('rejects competing row values and ambiguous serving columns',()=>{
    const cases=[['salt',0.03,'Salt 0.03 g / 0.01 g'],['salt',0.03,'Salt 0.03 g Salt 0.01 g'],
      ['energyKcal',350,'Energy 350 kcal / 175 kcal'],['energyKcal',350,'Energy 350 kcal per 100 g'],['salt',0.03,'Salt -0.03 g']];
    for(const [key,value,quote] of cases){const f=fixture();f.evidence.extraction.nutrients[key]={value,quote,imageIndex:0};assert.throws(()=>applyCatalogueLabelEvidence(f.raw,f.product,f.evidence));}
  });
  it('rejects impossible nutrient subsets and gross energy disagreements',()=>{
    const f=fixture();Object.assign(f.evidence.extraction.nutrients,{carbohydrate:{value:2,quote:'Carbohydrate 2 g',imageIndex:0},sugars:{value:20,quote:'Sugars 20 g',imageIndex:0}});
    assert.throws(()=>applyCatalogueLabelEvidence(f.raw,f.product,f.evidence));
    const g=fixture();Object.assign(g.evidence.extraction.nutrients,{energyKcal:{value:100,quote:'Energy 100 kcal',imageIndex:0},energyKj:{value:2000,quote:'Energy 2000 kJ',imageIndex:0}});
    assert.throws(()=>applyCatalogueLabelEvidence(g.raw,g.product,g.evidence));
  });
  it('accepts only the complete registered ingredient-photo transcript and retains source ingredients on conflict',()=>{
    const f=fixture(),url='https://images.openfoodfacts.org/images/products/500/000/000/0018/ingredients_en.2.400.jpg';
    f.raw.selected_images={ingredients:{display:{en:url}}};f.evidence.images.push({role:'ingredients',url});
    f.evidence.extraction.ingredients='Lentils, sugar';f.evidence.extraction.ingredientsImageIndex=1;
    assert.throws(()=>applyCatalogueLabelEvidence(f.raw,f.product,f.evidence));
    f.product.ingredients=null;const r=applyCatalogueLabelEvidence(f.raw,f.product,f.evidence);
    assert.equal(r.projection.ingredients,'Lentils, sugar');assert.equal(f.product.ingredients,null);
  });
});
