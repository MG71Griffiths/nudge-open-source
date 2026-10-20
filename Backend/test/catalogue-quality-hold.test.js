import {it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueSQLAdapter} from '../src/catalogue-index-object.js';
import {buildCatalogueRow} from '../src/catalogue-index.js';
import {handleCatalogueScoringRun as handle} from '../src/catalogue-scoring-run.js';
import {DIRECTIONAL_SCORE_REVISION as revision,stableStringify} from '../src/product-score.js';
import {QUALITY_HOLD_VERSION,withheldCatalogueScore,qualityHoldCandidateSHA256,validCatalogueQualityHold,
 publicCatalogueQualityHoldMatches,activeQualityHoldSQL,applyActiveQualityHoldStatement} from '../src/catalogue-quality-hold.js';

const now=1791676800000,runID='quality-test-20261011';
async function fixture(count=1){
 const sql=new DatabaseSync(':memory:');sql.exec(catalogueSchema);
 const storage={sql:{exec:(query,...values)=>({toArray:()=>sql.prepare(query).all(...values)})},transactionSync:fn=>{sql.exec('BEGIN');try{const result=fn();sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
 const db=catalogueSQLAdapter(storage);
 for(let i=0;i<count;i++){
  const raw={code:String(5000000000000+i),product_name:'Chocolate dessert',brands:'Test',countries_tags:['en:united-kingdom'],categories_tags:[],
   ingredients_text:'Chocolate, eggs, flour, cream, sugar',nutriments:{'energy-kcal_100g':433,proteins_100g:5.8,carbohydrates_100g:39,fat_100g:28,'saturated-fat_100g':13,sugars_100g:34,fiber_100g:.6,salt_100g:.75}};
  const row=await buildCatalogueRow(raw,{fetchedAt:now,now,source:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz'});
  const columns=Object.keys(row).filter(key=>key!=='filters');
  row.score_method='previous';row.score_version='previous';row.classifier_version='previous';
  sql.prepare(`INSERT INTO catalogue_products(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(key=>row[key]));
 }
 const call=(action,body={},at=now)=>handle(db,action,{runID,...body},{now:at,activeRevision:revision});
 await call('create');await call('step');
 return {sql,db,call};
}
async function request(f){
 const rows=(await f.call('records',{includeSource:true})).records;
 return {reviewID:'review-test-20261011',reviewNote:'Reviewed the retained source against the candidate.',items:rows.map(row=>({
  barcode:row.barcode,sourceFingerprint:row.sourceFingerprint,sourceFetchedAt:row.sourceFetchedAt,
  reasonCode:'source_identity_conflict',evidenceNote:'The product title and retained ingredient identity disagree.'}))};
}
const live=(f,barcode='5000000000000')=>f.sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(barcode);
const review=count=>({reviewPassed:true,reviewNote:'Reviewed all candidates and bound quality holds.',expectedSelected:count});

it('stages source-bound holds without changing live facts and exports the exact original candidate plus a canonical public result',async()=>{
 const f=await fixture(2),before=live(f),original=(await f.call('records')).records[0].after,body=await request(f);
 body.items=body.items.slice(0,1);
 const status=await f.call('quality-hold',body,now+10);
 assert.equal(status.counts.quality_held,1);assert.equal(status.counts.insufficient,1);assert.equal(status.counts.scored,1);
 assert.deepEqual(live(f),before);assert.equal(f.sql.prepare('SELECT count(*) n FROM catalogue_quality_holds').get().n,0);
 const row=(await f.call('records',{includeSource:true})).records[0];
 assert.equal(row.state,'insufficient');assert.deepEqual(row.computedCandidate,original);
 assert.equal(row.qualityHold.candidateSHA256,await qualityHoldCandidateSHA256(original));
 assert.deepEqual(row.holdApplication,{runID,sourceFetchedAt:now,candidateSHA256:row.qualityHold.candidateSHA256});
 assert.equal(row.qualityHold.version,QUALITY_HOLD_VERSION);assert.equal(row.qualityHold.reviewedAt,now+10);
 assert.equal(row.qualityHold.reviewNote,body.reviewNote);assert.equal(row.qualityHold.evidenceNote,body.items[0].evidenceNote);
 assert.deepEqual(row.after,withheldCatalogueScore(original,row.qualityHold));assert.equal(row.after.value,null);
 assert.equal(Object.hasOwn(row.after,'components'),false);assert.equal(Object.hasOwn(row.after,'inputs'),false);
 assert.equal(Object.hasOwn(row.after.catalogueQualityHold,'reviewNote'),false);
 assert.equal(await qualityHoldCandidateSHA256(row.source.raw),row.sourceFingerprint);
 assert.deepEqual(row.source.raw,JSON.parse(before.provider_json));
 assert.deepEqual((await f.call('quality-hold',body,now+20)).counts,status.counts);
 assert.equal((await f.call('records')).records[0].qualityHold.reviewedAt,now+10,'retries do not rewrite review provenance');
});

it('publishes an active hold atomically, preserves source facts and refuses to revive its old rating during rollback',async()=>{
 const f=await fixture(2),before=live(f),body=await request(f);body.items=body.items.slice(0,1);
 await f.call('quality-hold',body,now+10);
 const staged=(await f.call('records')).records[0];
 const activated=await f.call('activate',review(2),now+20);
 assert.equal(activated.counts.activated,2);assert.equal(live(f).rating_value,null);
 assert.deepEqual(JSON.parse(live(f).score_json),staged.after);assert.equal(live(f).provider_json,before.provider_json);
 assert.equal(live(f).source_fingerprint,before.source_fingerprint);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM catalogue_quality_holds').get().n,1);
 assert.equal((await f.call('quality-hold',body,now+30)).counts.quality_held,1,'lost response can be retried after publication');
 const rolled=await f.call('rollback',{},now+40);
 assert.equal(rolled.counts.rolled_back,1);assert.equal(rolled.counts.rollback_conflicts,1);
 assert.equal(live(f).rating_value,null);assert.deepEqual(JSON.parse(live(f).score_json),staged.after);
});

it('validates the public note-free envelope strictly and only against its trusted source identity',async()=>{
 const f=await fixture(),body=await request(f);await f.call('quality-hold',body);
 const row=(await f.call('records')).records[0],score=row.after,binding={barcode:row.barcode,sourceFingerprint:row.sourceFingerprint};
 assert.equal(validCatalogueQualityHold(row.qualityHold),true);assert.equal(publicCatalogueQualityHoldMatches(score,binding),true);
 assert.equal(publicCatalogueQualityHoldMatches(score,{...binding,sourceFingerprint:'a'.repeat(64)}),false);
 assert.equal(publicCatalogueQualityHoldMatches(score,{...binding,barcode:'12345678'}),false);
 for(const extra of [{value:100},{grade:'A'},{rawScore:-5},{components:{}},{points:1},{available:true},{version:'0.3'},{methodId:'bogus'},{methodStatus:'provisional'},
  {catalogueQualityHold:{...score.catalogueQualityHold,reviewNote:'private'}},{catalogueQualityHold:{...score.catalogueQualityHold,reasonCode:'arbitrary'}},
  {catalogueQualityHold:{...score.catalogueQualityHold,reviewedAt:now-1}}])assert.equal(publicCatalogueQualityHoldMatches({...score,...extra},binding),false,JSON.stringify(extra));
 assert.equal(validCatalogueQualityHold({...row.qualityHold,extra:true}),false);
});

it('rejects unbound, duplicate, stale, conflicting and closed reviews without partial staging',async()=>{
 const f=await fixture(2),body=await request(f);
 for(const changed of [
  {...body,items:[...body.items,body.items[0]]},
  {...body,items:[{...body.items[0],barcode:'12345678'}]},
  {...body,items:[{...body.items[0],sourceFingerprint:'a'.repeat(64)}]},
  {...body,items:[{...body.items[0],sourceFetchedAt:now-1}]},
  {...body,items:[{...body.items[0],reasonCode:'unsupported_reason'}]},
  {...body,items:[{...body.items[0],evidenceNote:''}]},
  {...body,items:Array.from({length:51},()=>body.items[0])},
  {...body,unknown:true}
 ])await assert.rejects(()=>f.call('quality-hold',changed));
 assert.equal(f.sql.prepare('SELECT count(*) n FROM catalogue_scoring_run_holds').get().n,0);
 await f.call('quality-hold',{...body,items:[body.items[0]]});
 await assert.rejects(()=>f.call('quality-hold',{...body,reviewID:'different-review'}),e=>e.code==='catalogue_quality_hold_conflict');
 await f.call('activate',review(2));
 await assert.rejects(()=>f.call('quality-hold',{...body,items:[body.items[1]]}),e=>e.code==='catalogue_quality_hold_review_closed');
});

it('checks the literal raw hash and aborts the entire hold batch if a source changes during admission',async()=>{
 for(const atomic of [false,true]){
  const f=await fixture(2),body=await request(f),mutate=()=>f.sql.prepare("UPDATE catalogue_products SET provider_json=json_set(provider_json,'$.product_name','Revised identity') WHERE barcode=?").run(body.items[1].barcode);
  if(atomic){const batch=f.db.batch;f.db.batch=async statements=>{f.db.batch=batch;mutate();return batch(statements);};}else mutate();
  await assert.rejects(()=>f.call('quality-hold',body),e=>e.code==='catalogue_quality_hold_source_changed');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalogue_scoring_run_holds').get().n,0);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM catalogue_scoring_run_items WHERE state='scored'").get().n,2);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalogue_quality_hold_guards').get().n,0);
  assert.equal(f.sql.prepare('SELECT lease_token FROM catalogue_scoring_runs').get().lease_token,null);
 }
});

it('never activates a staged hold for a source changed immediately before publication',async()=>{
 const f=await fixture(),body=await request(f);await f.call('quality-hold',body);
 const before=live(f),batch=f.db.batch;
 f.db.batch=async statements=>{f.db.batch=batch;f.sql.prepare('UPDATE catalogue_products SET fetched_at=fetched_at+1').run();return batch(statements);};
 const status=await f.call('activate',review(1));
 assert.equal(status.counts.activated,0);assert.equal(status.counts.activation_source_changed,1);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM catalogue_quality_holds').get().n,0);
 assert.equal(live(f).score_json,before.score_json);assert.equal(live(f).rating_value,before.rating_value);
});

it('rolls back the score write if persisting its active review fails',async()=>{
 const f=await fixture(),body=await request(f);await f.call('quality-hold',body);const before=live(f);
 f.sql.exec("CREATE TRIGGER reject_hold BEFORE INSERT ON catalogue_quality_holds BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;");
 await assert.rejects(()=>f.call('activate',review(1)),/simulated storage failure/);
 assert.deepEqual(live(f),before);assert.equal(f.sql.prepare('SELECT count(*) n FROM catalogue_quality_holds').get().n,0);
 assert.equal(f.sql.prepare('SELECT activation_state FROM catalogue_scoring_run_items').get().activation_state,'pending');
});

it('keeps holds across same-source refreshes and later runs, but does not bind them to changed raw facts',async()=>{
 const f=await fixture(),body=await request(f);await f.call('quality-hold',body,now+10);await f.call('activate',review(1),now+20);
 const original=(await f.call('records')).records[0],fingerprint=original.sourceFingerprint;
 f.sql.prepare("UPDATE catalogue_products SET fetched_at=?,score_method='previous',score_version='previous',classifier_version='previous'").run(now+30);
 const next='quality-test-next-run';await f.call('create',{runID:next},now+40);await f.call('step',{runID:next},now+40);
 const inherited=(await f.call('records',{runID:next,includeSource:true},now+40)).records[0];
 assert.equal(inherited.state,'insufficient');assert.deepEqual(inherited.qualityHold,original.qualityHold);
 assert.equal(inherited.qualityHold.sourceFetchedAt,now);assert.equal(inherited.holdApplication.sourceFetchedAt,now+30);
 assert.equal(inherited.holdApplication.runID,next);assert.equal(inherited.computedCandidate.available,true);
 assert.equal(inherited.holdApplication.candidateSHA256,await qualityHoldCandidateSHA256(inherited.computedCandidate));
 assert.equal((await f.call('activate',{...review(1),runID:next},now+50)).counts.activated,1);
 const replacement=structuredClone(inherited.source.raw);replacement.product_name='Chocolate cake';
 const changed=await qualityHoldCandidateSHA256(replacement);
 f.sql.prepare("UPDATE catalogue_products SET provider_json=?,source_fingerprint=?,fetched_at=?,score_method='previous',score_version='previous',classifier_version='previous'").run(JSON.stringify(replacement),changed,now+60);
 await f.call('create',{runID:'quality-test-third-run'},now+70);await f.call('step',{runID:'quality-test-third-run'},now+70);
 const fresh=(await f.call('records',{runID:'quality-test-third-run'},now+70)).records[0];
 assert.equal(fresh.after.available,true);assert.equal(Object.hasOwn(fresh,'qualityHold'),false);
 assert.notEqual(fresh.sourceFingerprint,fingerprint);
});

it('the SQL backstop masks same-source writes only and preserves the current scoring headers',async()=>{
 const f=await fixture(2),body=await request(f);body.items=body.items.slice(0,1);await f.call('quality-hold',body);await f.call('activate',review(2));
 const row=(await f.call('records')).records[0];
 f.sql.prepare('UPDATE catalogue_products SET score_json=?,rating_value=100,classifier_version=? WHERE barcode=?').run(JSON.stringify(row.computedCandidate),'future-classifier',row.barcode);
 const {sql,values}=activeQualityHoldSQL({barcode:row.barcode,sourceFingerprint:row.sourceFingerprint,fetchedAt:now});
 f.sql.prepare(sql).run(...values);
 assert.equal(live(f).rating_value,null);assert.equal(JSON.parse(live(f).score_json).classifierVersion,'future-classifier');
 assert.equal(live(f,'5000000000001').rating_value!==null,true);
 f.sql.prepare("UPDATE catalogue_products SET source_fingerprint=?,score_json=?,rating_value=100 WHERE barcode=?").run('a'.repeat(64),JSON.stringify(row.computedCandidate),row.barcode);
 await f.db.batch([applyActiveQualityHoldStatement(f.db)]);
 assert.equal(live(f).rating_value,100,'a different raw source cannot inherit an old hold');
});

it('a newly active review between scoring and activation prevents a stale unheld candidate from publishing',async()=>{
 const f=await fixture(),candidate=(await f.call('records')).records[0],body=await request(f);
 const other={version:QUALITY_HOLD_VERSION,runID:'other-review-run',barcode:candidate.barcode,sourceFingerprint:candidate.sourceFingerprint,sourceFetchedAt:now,
  reasonCode:body.items[0].reasonCode,reviewID:'other-review-id',reviewNote:body.reviewNote,evidenceNote:body.items[0].evidenceNote,reviewedAt:now,
  revision,candidateSHA256:await qualityHoldCandidateSHA256(candidate.after)};
 const batch=f.db.batch;f.db.batch=async statements=>{f.db.batch=batch;f.sql.prepare('INSERT INTO catalogue_quality_holds VALUES(?,?,?,?,?,?)').run(candidate.barcode,candidate.sourceFingerprint,other.runID,JSON.stringify(other),JSON.stringify(withheldCatalogueScore(candidate.after,other)),now);return batch(statements);};
 const status=await f.call('activate',review(1));assert.equal(status.counts.activated,0);assert.equal(status.counts.activation_conflicts,1);
 assert.equal(live(f).rating_value,null);assert.equal(JSON.parse(live(f).score_json).catalogueQualityHold.reviewID,other.reviewID);
});

it('rejects corrupted staged candidates on export and activation',async()=>{
 const f=await fixture(),body=await request(f);await f.call('quality-hold',body);
 f.sql.prepare("UPDATE catalogue_scoring_run_holds SET candidate_json=json_set(candidate_json,'$.value',100)").run();
 await assert.rejects(()=>f.call('records'),e=>e.code==='catalogue_quality_hold_invalid');
 await assert.rejects(()=>f.call('activate',review(1)),e=>e.code==='catalogue_quality_hold_invalid');
 assert.equal(f.sql.prepare('SELECT count(*) n FROM catalogue_quality_holds').get().n,0);
});
