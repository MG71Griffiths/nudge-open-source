import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {catalogueRecordFromPayload} from '../src/food-catalogue.js';
import {ScoreCore} from '../src/nutrition-core.js';

const source=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-provider-category-products.json',import.meta.url),'utf8'));
const fixed=new Set(['01858907','9340224001102','03263983','4088600256375','4088600440965','5010525202341','5036589254874','5060108457996','29493807']);
const normalize=raw=>catalogueRecordFromPayload({product:raw},raw.code,1780000000000).product;
describe('specific identities versus OFF taxonomy ancestors',()=>{
  it('admits nine compatible provider results without overriding fifteen specific contradictions',()=>{
    for(const raw of source.products){
      const before=structuredClone(raw),p=normalize(raw);
      assert.equal(Boolean(p.providerNutriScore),fixed.has(raw.code),raw.code+' '+p.name);
      if(fixed.has(raw.code)){
        const score=ScoreCore.calculateScore(p);
        assert.equal(p.providerNutriScore.grade,raw.nutriscore['2023'].grade.toUpperCase());
        if(score.available){assert.equal(score.scoreBasis,ScoreCore.ACTIVE_DIRECTIONAL?'nudge_directional':'provider_nutriscore_2023');if(ScoreCore.ACTIVE_DIRECTIONAL)assert.equal(score.providerReference.grade,p.providerNutriScore.grade);else assert.equal(score.grade,p.providerNutriScore.grade);}else assert.ok(score.missingInputs.length>0,'A retained provider rating does not fill missing source nutrition');
      }
      assert.deepEqual(raw,before);
    }
  });
  it('retains incompatible cereal, plain-water and composite identities',()=>{
    for(const [code,change] of [
      ['5010525202341',{product_name:'Chia oat bar',categories_tags:['en:cereal-bars','en:chia-seeds']}],
      ['03263983',{product_name:'Brown rice',categories_tags:['en:brown-rice','en:flax-seeds']}],
      ['4088600256375',{product_name:'Spring water',categories_tags:['en:waters','en:yogurt-drinks']}],
      ['29493807',{product_name:'Yogurt',categories_tags:['en:yogurts','en:kefir']}]
    ]){
      const raw=structuredClone(source.products.find(p=>p.code===code));Object.assign(raw,change);
      // English names are a separate source field and must reflect the fixture.
      raw.product_name_en=change.product_name;
      assert.equal(normalize(raw).providerNutriScore,undefined,change.product_name);
    }
  });
});
