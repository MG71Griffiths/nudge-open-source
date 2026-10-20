import {it,mock} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {catalogueSchema} from '../src/catalogue-schema.js';
import {catalogueScoringRunSchema} from '../src/catalogue-scoring-run-schema.js';
import {catalogueSQLAdapter} from '../src/catalogue-index-object.js';
import {buildCatalogueRow,refreshCatalogue} from '../src/catalogue-index.js';
import {handleCatalogueScoringRun as handle,SCORING_SELECTION_VERSION,NON_UK_SCORING_SELECTION_VERSION} from '../src/catalogue-scoring-run.js';
import {parseOptions,retryDelay,clientTimingSummary} from '../scripts/score-catalogue-pilot.mjs';
import {DIRECTIONAL_SCORE_REVISION} from '../src/product-score.js';
const now=1791676800000,runID='scoring-test-20261011';
const raw={code:'5000000000000',product_name:'Chocolate dessert',brands:'Test',countries_tags:['en:united-kingdom'],categories_tags:[],
 ingredients_text:'Chocolate, eggs, flour, cream, sugar',nutriments:{'energy-kcal_100g':433,proteins_100g:5.8,carbohydrates_100g:39,fat_100g:28,'saturated-fat_100g':13,sugars_100g:34,fiber_100g:.6,salt_100g:.75}};
async function fixture(count=500,fixtureRaw=raw){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');sql.exec(catalogueSchema);
 const storage={sql:{exec:(query,...values)=>({toArray:()=>sql.prepare(query).all(...values)})},transactionSync:fn=>{sql.exec('BEGIN');try{const value=fn();sql.exec('COMMIT');return value;}catch(error){sql.exec('ROLLBACK');throw error;}}};
 const db=catalogueSQLAdapter(storage),row=await buildCatalogueRow(fixtureRaw,{fetchedAt:now,now,source:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz'});
 const columns=Object.keys(row).filter(key=>key!=='filters'),insert=sql.prepare(`INSERT INTO catalogue_products(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
 const discovery=sql.prepare('INSERT INTO catalogue_discovery(barcode,source_fingerprint,rule_version,evidence_json,evaluated_at) VALUES (?,?,?,?,?)'),filter=sql.prepare("INSERT INTO catalogue_discovery_filters(barcode,kind,value) VALUES (?,'aisle',?)");
 sql.exec('BEGIN');for(let i=0;i<count;i++){
  const barcode=String(5000000000000+i),r={...row,score_method:'nudge_nutrition_v0_3',score_version:'0.3',classifier_version:'previous',barcode,provider_json:JSON.stringify({...JSON.parse(row.provider_json),code:barcode}),rating_value:i%2?75:null};
  insert.run(...columns.map(k=>r[k]));discovery.run(barcode,row.source_fingerprint,'test','{}',now);filter.run(barcode,['desserts','pulses','fruit','drinks','nuts'][Math.floor(i/2)%5]);
 }sql.exec('COMMIT');
 return {sql,db,call:(action,body={})=>handle(db,action,{runID,...body},{now,activeRevision:DIRECTIONAL_SCORE_REVISION})};
}
async function finish(f){let status;do{status=await f.call('step',{limit:100});}while(status.counts.pending&&status.state==='running');return status;}
it('keeps shadow migration equal to runtime schema and existing migration complete',()=>{
 assert.equal(readFileSync(new URL('../migrations/0002_catalogue_scoring_runs.sql',import.meta.url),'utf8'),catalogueScoringRunSchema);
 assert.equal(readFileSync(new URL('../migrations/0001_food_catalogue.sql',import.meta.url),'utf8'),catalogueSchema);
});
it('selects a stable 500-record balanced pilot, computes retained facts, resumes without repeats and does not touch live data',async()=>{
 const f=await fixture(1200),before=f.sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all();
 const created=await f.call('create');assert.equal(created.counts.selected,500);assert.equal(created.strata.length,10);assert.ok(created.strata.every(s=>s.selected===50));
 assert.deepEqual((await f.call('create')).counts,created.counts,'duplicate create does not grow cohort');
 const one=await f.call('step',{limit:100});assert.equal(one.metrics.processed,100);assert.equal(one.counts.pending,400);
 await f.call('pause');assert.equal((await f.call('step')).counts.pending,400);await f.call('resume');
 const completed=await finish(f);assert.equal(completed.state,'review');assert.equal(completed.complete,true);assert.equal(completed.counts.scored,500);assert.equal(completed.counts.newly_rated,250);
 assert.equal(completed.metrics.aiCalls,0);assert.equal(completed.metrics.offRequests,0);assert.equal(completed.metrics.estimatedAICostUSD,0);
 assert.deepEqual((await f.call('step')).counts,completed.counts);assert.deepEqual(f.sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all(),before);
 const records=await f.call('records',{limit:3});assert.equal(records.records.length,3);assert.equal(records.hasMore,true);assert.equal(records.records[0].after.methodId,DIRECTIONAL_SCORE_REVISION.method);assert.equal(records.records[0].nutrition.sugars.value,34);
 assert.equal(f.sql.prepare('SELECT count(DISTINCT evaluated_at) AS n FROM catalogue_scoring_run_items').get().n,1);
});
it('requires a completed reviewed pilot, extends to exactly 10000 total and reuses its first500 results',async()=>{
 const f=await fixture(10100);await f.call('create');await assert.rejects(()=>f.call('extend',{reviewPassed:true,reviewNote:'Too early'}),/Complete and review/);
 await finish(f);await assert.rejects(()=>f.call('extend'),/recorded 500/);
 const before=f.sql.prepare("SELECT barcode,result_json FROM catalogue_scoring_run_items WHERE state='scored' ORDER BY barcode").all();
 const extended=await f.call('extend',{reviewPassed:true,reviewNote:'Checked category spread, inputs, scores and zero external calls.'});
 assert.equal(extended.target,10000);assert.equal(extended.counts.selected,10000);assert.equal(extended.counts.pending,9500);assert.equal(extended.counts.scored,500);assert.equal(extended.pilotReviewed,true);
 assert.equal((await f.call('extend',{reviewPassed:true,reviewNote:'Retry'})).counts.selected,10000);
 assert.deepEqual(f.sql.prepare("SELECT barcode,result_json FROM catalogue_scoring_run_items WHERE cohort=500 ORDER BY barcode").all(),before);
 const finished=await finish(f);assert.equal(finished.counts.selected,10000);assert.equal(finished.metrics.processed,10000);assert.equal(finished.complete,true);assert.equal(finished.counts.scored,10000);assert.equal(finished.metrics.aiCalls,0);
});
it('materialized selection retains the original representative500 and the same9500 extension barcodes',async()=>{
 const f=await fixture(10400),legacyID=runID+'-legacy';
 // Mixed eligibility, missing adverse facts and stale discovery bindings make
 // this more than an equal-sized happy-path partition comparison.
 f.sql.exec("UPDATE catalogue_products SET is_uk=0 WHERE CAST(barcode AS INTEGER)%101=0; UPDATE catalogue_products SET score_json='{\"missingInputs\":[\"sugars\"]}' WHERE CAST(barcode AS INTEGER)%7=0 AND rating_value IS NULL; UPDATE catalogue_discovery SET source_fingerprint='stale' WHERE CAST(barcode AS INTEGER)%311=0;");
 const selected=()=>f.sql.prepare('SELECT barcode,stratum,cohort FROM catalogue_scoring_run_items WHERE run_id=? ORDER BY barcode').all(runID);
 const legacy=()=>f.sql.prepare('SELECT barcode,stratum,cohort FROM catalogue_scoring_run_items WHERE run_id=? ORDER BY barcode').all(legacyID);
 const oldSQL=readFileSync(new URL('./fixtures/scoring-selection-v1.sql',import.meta.url),'utf8');
 await f.call('create');
 f.sql.prepare('INSERT INTO catalogue_scoring_runs(id,score_method,score_version,classifier_version,state,target,created_at,updated_at,active_ms,selection_version) SELECT ?,score_method,score_version,classifier_version,state,target,created_at,updated_at,active_ms,selection_version FROM catalogue_scoring_runs WHERE id=?').run(legacyID,runID);
 f.sql.prepare(oldSQL).run(legacyID,legacyID,legacyID,500,500,legacyID);
 assert.equal(selected().length,500);assert.deepEqual(selected(),legacy());
 await finish(f);await f.call('extend',{reviewPassed:true,reviewNote:'Synthetic equivalence check'});
 f.sql.prepare(oldSQL).run(legacyID,legacyID,legacyID,10000,10000,legacyID);
 assert.equal(selected().length,10000);assert.deepEqual(selected(),legacy());
 assert.equal(selected().filter(row=>row.cohort===500).length,500);
 assert.equal(selected().filter(row=>row.cohort===10000).length,9500);
});
it('reports shortages rather than pretending the requested cohort was completed',async()=>{
 const f=await fixture(12);await f.call('create');const status=await finish(f);assert.equal(status.counts.selected,12);assert.equal(status.eligibleShortfall,488);assert.equal(status.complete,false);
 await assert.rejects(()=>f.call('extend',{reviewPassed:true,reviewNote:'Cannot claim500'}),/Complete and review/);
});
it('retains missing nutrition, parse failures and changed source separately with zero artificial scores',async()=>{
 const f=await fixture(500);await f.call('create');
 const chosen=f.sql.prepare('SELECT barcode FROM catalogue_scoring_run_items ORDER BY barcode LIMIT 3').all().map(r=>r.barcode);
 f.sql.prepare("UPDATE catalogue_products SET source_fingerprint='changed' WHERE barcode=?").run(chosen[0]);
 f.sql.prepare("UPDATE catalogue_products SET provider_json='{}' WHERE barcode=?").run(chosen[1]);
 f.sql.prepare('UPDATE catalogue_products SET provider_json=? WHERE barcode=?').run(JSON.stringify({...raw,code:chosen[2],nutriments:{}}),chosen[2]);
 const status=await finish(f);assert.equal(status.counts.source_changed,1);assert.equal(status.counts.errors,1);assert.equal(status.counts.insufficient,1);assert.equal(status.counts.scored,497);assert.ok(status.missingReasons.length);
 await assert.rejects(()=>f.call('activate',{reviewPassed:true,reviewNote:'Errors must block'}),/Resolve incomplete/);
});
it('explicit activation and rollback preserve all source fields and skip subsequent edits',async()=>{
 const f=await fixture(500);await f.call('create');await finish(f);
 const originals=f.sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all();
 await assert.rejects(()=>f.call('activate'),/recorded quality review/);
 let status;do{status=await f.call('activate',{reviewPassed:true,reviewNote:'All500 inspected and release revision enabled',limit:100});}while(status.state==='activating');
 assert.equal(status.counts.activated,500);assert.equal(status.state,'activated');
 const changed=f.sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all();
 for(let i=0;i<changed.length;i++){assert.equal(changed[i].score_method,DIRECTIONAL_SCORE_REVISION.method);for(const key of ['provider_json','source_fingerprint','fetched_at','expires_at','source_revision','name','search_text'])assert.equal(changed[i][key],originals[i][key]);}
 f.sql.prepare("UPDATE catalogue_products SET source_fingerprint='new source' WHERE barcode=?").run(originals[0].barcode);
 do{status=await f.call('rollback',{limit:100});}while(status.state==='rolling_back');
 assert.equal(status.counts.rolled_back,499);assert.equal(status.counts.rollback_conflicts,1);assert.equal(status.state,'rolled_back');
 assert.deepEqual(f.sql.prepare('SELECT * FROM catalogue_products WHERE barcode>? ORDER BY barcode').all(originals[0].barcode),originals.slice(1));
});
it('activation skips changed source, changed scoring evidence and expired concurrent leases',async()=>{
 const f=await fixture(500);await f.call('create');await finish(f);
 f.sql.prepare("UPDATE catalogue_products SET source_fingerprint='new facts' WHERE barcode='5000000000000'").run();
 f.sql.prepare("UPDATE catalogue_products SET score_json='{}' WHERE barcode='5000000000001'").run();
 f.sql.prepare('UPDATE catalogue_scoring_runs SET lease_until=? WHERE id=?').run(now+5000,runID);
 await assert.rejects(()=>f.call('activate',{reviewPassed:true,reviewNote:'Concurrent call'}),e=>e.code==='catalogue_scoring_run_busy');
 f.sql.prepare('UPDATE catalogue_scoring_runs SET lease_until=? WHERE id=?').run(now-1,runID);
 const status=await f.call('activate',{reviewPassed:true,reviewNote:'Source-guarded application',limit:100});
 assert.equal(status.counts.activation_source_changed,1);assert.equal(status.counts.activation_conflicts,1);assert.equal(status.counts.activated,98);
});
it('SCORING_AUTO_REFRESH=false leaves existing live revisions alone',async()=>{
 const f=await fixture(3);f.sql.exec("UPDATE catalogue_products SET score_version='old'");
 await refreshCatalogue({FOOD_CATALOGUE_DB:f.db,SCORING_AUTO_REFRESH:'false'},{now});
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM catalogue_products WHERE score_version='old'").get().n,3);
});
it('validates commands, confines checkpoint output, enforces limits and honours server retry delay',()=>{
 const args=['--action','run','--run-id',runID,'--token-file','/private/tmp/secret'];assert.equal(parseOptions(args).limit,50);
 assert.throws(()=>parseOptions([...args,'--batch-size','101']),/Batch size/);
 assert.throws(()=>parseOptions([...args,'--output','/private/tmp/image-warm/state']),/separate/);
 assert.throws(()=>parseOptions(['--action','extend','--run-id',runID,'--token-file','/private/tmp/secret']),/quality review/);
 assert.equal(retryDelay(new Response('',{headers:{'retry-after':'30'}}),0,now,()=>0),30000);
 assert.equal(retryDelay(new Response('',{headers:{'retry-after':new Date(now+20000).toUTCString()}}),0,now,()=>0),20000);
});
it('concurrent create retries cannot select more than500 and old run reports remain readable',async()=>{
 const f=await fixture(1100);const results=await Promise.all([f.call('create'),f.call('create')]);assert.equal(results.at(-1).counts.selected,500);
 f.sql.prepare("UPDATE catalogue_scoring_runs SET classifier_version='old-classifier' WHERE id=?").run(runID);
 assert.equal((await f.call('status')).classifierVersion,'old-classifier');assert.equal((await f.call('records',{limit:1})).records.length,1);
 await assert.rejects(()=>f.call('step'),e=>e.code==='catalogue_scoring_revision_changed');
});
it('publishing is blocked until the candidate is the active engine',async()=>{
 const f=await fixture(500);await f.call('create');await finish(f);
 await assert.rejects(()=>handle(f.db,'activate',{runID,reviewPassed:true,reviewNote:'Reviewed'},{now,activeRevision:{method:'old',version:'0.3',classifierVersion:'old'}}),e=>e.code==='catalogue_scoring_revision_not_active');
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM catalogue_scoring_run_items WHERE activation_state='applied'").get().n,0);
});

it('does not infer throughput from a frozen server clock or old one-millisecond batch clamps',async()=>{
 const f=await fixture(3);await f.call('create');const timer=mock.method(performance,'now',()=>0);
 try{await finish(f);}finally{timer.mock.restore();}
 assert.equal(f.sql.prepare('SELECT active_ms FROM catalogue_scoring_runs').get().active_ms,0);
 f.sql.prepare('UPDATE catalogue_scoring_runs SET active_ms=1').run();
 const {metrics}=await f.call('status');assert.equal(metrics.clockStatus,'unmeasurable');assert.equal(metrics.activeElapsedMs,null);assert.equal(metrics.productsPerSecond,null);assert.equal(metrics.projected10000ActiveMs,null);
});
it('measures client throughput across separate resumed invocations without counting prior products twice',()=>{
 const summary=clientTimingSummary([{processedRecords:500,elapsedMs:10000},{processedRecords:9500,elapsedMs:190000}]);
 assert.deepEqual(summary,{invocations:2,processedRecords:10000,elapsedMs:200000,productsPerSecond:50,projected10000Ms:200000});
 assert.equal(clientTimingSummary([{processedRecords:0,elapsedMs:100}]).productsPerSecond,null);
});

it('a subsequent bounded run advances past unchanged published results but includes revised source facts',async()=>{
 const f=await fixture(1200);await f.call('create');await finish(f);
 let status;do{status=await f.call('activate',{limit:100,reviewPassed:true,reviewNote:'Synthetic reviewed cohort'});}while(status.state==='activating');
 const first=f.sql.prepare('SELECT barcode FROM catalogue_scoring_run_items WHERE run_id=?').all(runID).map(r=>r.barcode);
 const nextID=runID+'-remaining';const next=await handle(f.db,'create',{runID:nextID},{now});assert.equal(next.counts.selected,500);
 const nextCodes=f.sql.prepare('SELECT barcode FROM catalogue_scoring_run_items WHERE run_id=?').all(nextID).map(r=>r.barcode);
 assert.ok(nextCodes.every(code=>!first.includes(code)),'Completed catalogue results must not consume another run');
 f.sql.prepare('UPDATE catalogue_products SET fetched_at=? WHERE barcode=?').run(now+1,first[0]);
 const revisedID=runID+'-revised';await handle(f.db,'create',{runID:revisedID},{now:now+2});
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM catalogue_scoring_run_items WHERE run_id=? AND barcode=?').get(revisedID,first[0]).n,1,'New source retrieval is eligible again');
});
it('reuses an unchanged current score published after selection without running the calculator again',async()=>{
 const f=await fixture(3);await f.call('create');
 // The bundled default can remain legacy while the candidate is trialled.
 const {catalogueRecordFromPayload}=await import('../src/food-catalogue.js');const {scoreDirectionalProduct}=await import('../src/product-score.js');
 const candidate=scoreDirectionalProduct(catalogueRecordFromPayload({product:raw},raw.code,now).product);
 f.sql.prepare('UPDATE catalogue_products SET score_json=?,rating_value=?,score_method=?,score_version=?,classifier_version=?,calculated_at=? WHERE barcode=?').run(JSON.stringify(candidate),candidate.value,DIRECTIONAL_SCORE_REVISION.method,DIRECTIONAL_SCORE_REVISION.version,DIRECTIONAL_SCORE_REVISION.classifierVersion,now,raw.code);
 const result=await finish(f);assert.equal(result.counts.skipped_current,1);assert.equal(result.metrics.rulesProcessed,2);
 const records=await f.call('records');assert.equal(records.records.find(r=>r.barcode===raw.code).scoringAction,'reused_current');
});

it('revalidates source-bound old label facts without importing the old number or spending another AI call',async()=>{
 const p={...raw,product_name:'Dhal makhani',ingredients_text:'Lentils (60%), tomatoes (10%), water, cream, salt',last_modified_t:1700000000,image_nutrition_url:`https://images.openfoodfacts.org/images/products/${raw.code}/nutrition_en.1.400.jpg`,nutriments:{'energy-kcal_100g':110,proteins_100g:6,carbohydrates_100g:14,sugars_100g:2,fat_100g:3,'saturated-fat_100g':1,fiber_100g:4}};
 const f=await fixture(3,p),snapshot=f.sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(p.code);
 const options={now,classification:{category:'general',evidence:[{field:'name',quote:p.product_name}],sweeteners:'unknown',sweetenerEvidence:[]},nutritionEvidence:{version:'public-label-extraction-v1',barcode:p.code,sourceRevision:p.last_modified_t,sourceURL:`https://world.openfoodfacts.org/product/${p.code}`,images:[{role:'nutrition',url:p.image_nutrition_url}],extraction:{conflictingProduct:false,basis:'100g',basisQuote:'Nutrition per 100 g',preparation:'as_sold',preparationQuote:null,nutrients:{energyKcal:null,energyKj:null,protein:null,carbohydrate:null,sugars:null,fat:null,saturatedFat:null,fibre:null,salt:{value:.5,quote:'Salt 0.5 g',imageIndex:0}},ingredients:null,ingredientsImageIndex:null}}};
 const {evaluateCatalogueEnrichment}=await import('../src/catalogue-enrichment-evidence.js');const {ScoreCore}=await import('../src/nutrition-core.js');
 const prior=evaluateCatalogueEnrichment(p,options,ScoreCore.Legacy),canonical={version:'catalogue-enrichment-v1',classification:prior.classification,evidence:prior.evidence,provenance:prior.provenance};
 f.sql.prepare(`INSERT INTO catalogue_enrichment_scores(barcode,source_fingerprint,source_fetched_at,evidence_version,score_method,score_version,classifier_version,evidence_json,score_json,rating_value,calculated_at,expires_at) VALUES (?,?,?,'catalogue-enrichment-v1','nudge_nutrition_v0_3','0.3','old',?,? ,1,?,?)`).run(p.code,snapshot.source_fingerprint,now,JSON.stringify(canonical),'{"value":1}',now,now+10000);
 await f.call('create');const done=await finish(f);assert.equal(done.counts.evidence_reused,1);assert.equal(done.counts.evidence_rejected,0);assert.equal(done.metrics.aiCalls,0);
 const score=(await f.call('records')).records.find(r=>r.barcode===p.code).after;assert.equal(score.value,100);assert.equal(score.status,'estimated');assert.equal(score.inputs.salt,.5);assert.equal(score.version,'0.4');
 assert.equal(f.sql.prepare('SELECT provider_json FROM catalogue_products WHERE barcode=?').get(p.code).provider_json,snapshot.provider_json);
 for(const expired of [false,true]){
  f.sql.prepare('UPDATE catalogue_enrichment_scores SET source_fingerprint=?,expires_at=?').run(expired?snapshot.source_fingerprint:'changed',expired?now-1:now+10000);
  const other=runID+(expired?'-expired':'-mismatch');await handle(f.db,'create',{runID:other},{now});let status;do{status=await handle(f.db,'step',{runID:other,limit:100},{now});}while(status.counts.pending);assert.equal(status.counts.evidence_reused,0);assert.equal(status.counts.scored,0);
 }
});

it('publishes a reviewed final partial cohort only with its exact nonzero count and retains the original cap in the audit',async()=>{
 const f=await fixture(12);await f.call('create');await finish(f);
 const review={reviewPassed:true,reviewNote:'Reviewed every final remaining product',expectedSelected:12,limit:5};
 await assert.rejects(()=>f.call('activate',{...review,expectedSelected:undefined}),e=>e.code==='catalogue_scoring_partial_review_required');
 await assert.rejects(()=>f.call('activate',{...review,expectedSelected:11}),e=>e.code==='catalogue_scoring_review_count_changed');
 let status;do{status=await f.call('activate',review);}while(status.state==='activating');
 assert.equal(status.state,'activated');assert.equal(status.counts.activated,12);assert.equal(status.target,500);assert.equal(status.eligibleShortfall,488);
 assert.deepEqual(status.activationReview,{note:review.reviewNote,passed:true,at:now,selected:12,target:500,shortfall:488,partialCohort:true,scope:'uk',selectionVersion:SCORING_SELECTION_VERSION});
 assert.equal((await f.call('activate',review)).counts.activated,12,'Retry does not repeat publication');
 let rollback;do{rollback=await f.call('rollback',{limit:5});}while(rollback.state==='rolling_back');
 assert.equal(rollback.counts.rolled_back,12,'Partial publication retains guarded rollback');
});
it('never uses partial-cohort review to bypass pending work, errors, an empty cohort or count validation',async()=>{
 const f=await fixture(3);await f.call('create');
 const review={reviewPassed:true,reviewNote:'Review',expectedSelected:3};
 await assert.rejects(()=>f.call('activate',review),/Complete the current cohort/);
 await finish(f);
 for(const value of [0,-1,10001,1.5,'3',null])await assert.rejects(()=>f.call('activate',{...review,expectedSelected:value}),/expectedSelected/);
 await assert.rejects(()=>f.call('status',{expectedSelected:3}),/expectedSelected/);
 f.sql.prepare("UPDATE catalogue_scoring_run_items SET state='error' WHERE barcode=?").run(raw.code);
 await assert.rejects(()=>f.call('activate',review),/Resolve incomplete work, errors/);
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM catalogue_scoring_run_items WHERE activation_state='applied'").get().n,0);
 const empty=await fixture(0);await empty.call('create');await finish(empty);
 await assert.rejects(()=>empty.call('activate',{...review,expectedSelected:1}),/empty cohort/);
});
it('allows a reviewed partial10000 extension without resetting or rescoring the first500',async()=>{
 const f=await fixture(512);await f.call('create');await finish(f);
 const initial=f.sql.prepare('SELECT barcode,result_json FROM catalogue_scoring_run_items ORDER BY barcode').all();
 await f.call('extend',{reviewPassed:true,reviewNote:'Reviewed pilot'});const done=await finish(f);
 assert.equal(done.target,10000);assert.equal(done.counts.selected,512);assert.equal(done.eligibleShortfall,9488);
 assert.deepEqual(f.sql.prepare('SELECT barcode,result_json FROM catalogue_scoring_run_items WHERE cohort=500 ORDER BY barcode').all(),initial);
 let status;do{status=await f.call('activate',{reviewPassed:true,reviewNote:'Reviewed entire remainder',expectedSelected:512,limit:100});}while(status.state==='activating');
 assert.equal(status.counts.activated,512);assert.equal(status.activationReview.target,10000);assert.equal(status.activationReview.selected,512);
});
it('reports read-only stored revision coverage separately for UK, non-UK and reviewed products without treating overlap as new products',async()=>{
 const f=await fixture(8),rev=DIRECTIONAL_SCORE_REVISION;
 f.sql.prepare('UPDATE catalogue_products SET score_method=?,score_version=?,classifier_version=? WHERE barcode<?').run(rev.method,rev.version,rev.classifierVersion,'5000000000004');
 f.sql.exec("UPDATE catalogue_products SET is_uk=0 WHERE barcode IN('5000000000002','5000000000003','5000000000006','5000000000007'); UPDATE catalogue_products SET score_json='malformed' WHERE barcode='5000000000000'");
 const insert=f.sql.prepare('INSERT INTO reviewed_products(barcode,provider_json,score_json,source_fingerprint,source_revision,observed_at,reviewed_at,expires_at,calculated_at,score_method,score_version,classifier_version,provenance_json) VALUES (?,\'{}\',?,\'fingerprint\',1,?,?,?,?,?,?,?,\'{}\')');
 for(const [barcode,score,current] of [[raw.code,{available:true,value:75},true],['6000000000000',{available:false,value:null},true],['6000000000001',{available:true,value:25},false]])insert.run(barcode,JSON.stringify(score),now,now,now+1000,now,current?rev.method:'old',current?rev.version:'old',current?rev.classifierVersion:'old');
 const before=f.sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all(),reviewedBefore=f.sql.prepare('SELECT * FROM reviewed_products ORDER BY barcode').all();
 const queries=[],db={prepare(query){queries.push(query);return f.db.prepare(query);}};
 const report=await handle(db,'coverage',{runID},{now});
 const expected={total:4,storedRated:2,storedUnrated:2,currentRevision:2,currentRated:1,currentUnrated:1,outdatedRevision:2,outdatedRated:1,outdatedUnrated:1};
 assert.deepEqual(report.coverage.catalogue.uk,expected);assert.deepEqual(report.coverage.catalogue.nonUK,expected);
 assert.deepEqual(report.coverage.reviewed,{total:3,storedRated:2,storedUnrated:1,currentRevision:2,currentRated:1,currentUnrated:1,outdatedRevision:1,outdatedRated:1,outdatedUnrated:0});
 assert.equal(report.coverage.combinedRows.total,11);assert.equal(report.coverage.reviewedBarcodesAlsoInCatalogue,1);assert.equal(report.coverage.distinctBarcodes,10);
 assert.equal(report.eligibility.ukCatalogueOutdatedRevision,2);assert.equal(report.eligibility.nonUKCatalogueOutdatedRevision,2);assert.equal(report.eligibility.reviewedOutdatedRevision,1);assert.equal(report.eligibility.exactSelectionCount,null);assert.match(report.eligibility.basis,/lower bound/);
 assert.ok(queries.every(query=>!query.includes('provider_json')));assert.ok(queries.find(query=>query.includes('catalogue_rating_candidates')));
 const plan=f.sql.prepare('EXPLAIN QUERY PLAN '+queries.find(query=>query.includes('catalogue_rating_candidates'))).all(rev.method,rev.version,rev.classifierVersion);
 assert.ok(plan.some(row=>/COVERING INDEX catalogue_rating_candidates/.test(row.detail)),'Catalogue census must use the covering index');
 assert.deepEqual(f.sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all(),before);assert.deepEqual(f.sql.prepare('SELECT * FROM reviewed_products ORDER BY barcode').all(),reviewedBefore);
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM catalogue_scoring_runs').get().n,0,'Coverage must not create a run');
 await assert.rejects(()=>f.call('coverage',{limit:10}),/Coverage accepts only/);
});
it('requires the separate admin credential for the new read-only coverage route',async()=>{
 const {default:worker}=await import('../src/worker.js'),{createHash}=await import('node:crypto');
 const appToken='67'.repeat(32),adminToken='89'.repeat(32),hash=value=>createHash('sha256').update(value).digest('hex'),calls=[];
 const env={PRIVATE_ACCESS_TOKEN_SHA256:hash(appToken),CATALOGUE_ADMIN_TOKEN_SHA256:hash(adminToken),FOOD_CATALOGUE_INDEX:{idFromName:name=>name,get:()=>({fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json({ok:true});}})}};
 const request=token=>new Request('https://nudge.example/v1/catalogue/scoring/coverage',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({runID})});
 assert.equal((await worker.fetch(request(appToken),env)).status,401);assert.equal(calls.length,0);
 assert.equal((await worker.fetch(request(adminToken),env)).status,200);assert.deepEqual(calls,[{url:'https://catalogue-index/scoring/coverage',body:{runID}}]);
});
it('exports retained raw facts only on request and only for the exact selected source fingerprint and retrieval time',async()=>{
 const f=await fixture(3);await f.call('create');await finish(f);
 const plain=await f.call('records');assert.ok(plain.records.every(row=>!Object.hasOwn(row,'source')));
 const withSource=await f.call('records',{includeSource:true});
 for(const row of withSource.records){
  const retained=f.sql.prepare('SELECT provider_json,source_fingerprint,fetched_at FROM catalogue_products WHERE barcode=?').get(row.barcode);
  assert.deepEqual(row.source,{raw:JSON.parse(retained.provider_json),sourceFingerprint:retained.source_fingerprint,sourceFetchedAt:retained.fetched_at});
 }
 f.sql.prepare("UPDATE catalogue_products SET source_fingerprint='revised' WHERE barcode=?").run(withSource.records[0].barcode);
 f.sql.prepare('UPDATE catalogue_products SET fetched_at=fetched_at+1 WHERE barcode=?').run(withSource.records[1].barcode);
 const changed=await f.call('records',{includeSource:true});assert.equal(changed.records[0].source,null);assert.equal(changed.records[1].source,null);assert.ok(changed.records[2].source);
 await assert.rejects(()=>f.call('records',{includeSource:'yes'}),/includeSource/);await assert.rejects(()=>f.call('step',{includeSource:true}),/includeSource/);
});

it('keeps default UK selection separate from an explicit five-record non-UK cohort with guarded partial publication',async()=>{
 const f=await fixture(8);
 f.sql.exec("UPDATE catalogue_products SET is_uk=0 WHERE barcode>='5000000000003'");
 const ukBefore=f.sql.prepare('SELECT * FROM catalogue_products WHERE is_uk=1 ORDER BY barcode').all();
 const uk=await f.call('create');assert.equal(uk.scope,'uk');assert.equal(uk.selectionVersion,SCORING_SELECTION_VERSION);assert.equal(uk.counts.selected,3);
 const tailID=runID+'-non-uk',call=(action,body={})=>handle(f.db,action,{runID:tailID,...body},{now,activeRevision:DIRECTIONAL_SCORE_REVISION});
 const created=await call('create',{scope:'non-uk'});assert.equal(created.scope,'non-uk');assert.equal(created.selectionVersion,NON_UK_SCORING_SELECTION_VERSION);assert.equal(created.counts.selected,5);assert.equal(created.target,500);
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM catalogue_scoring_run_items i JOIN catalogue_products p USING(barcode) WHERE i.run_id=? AND p.is_uk=1').get(tailID).n,0);
 await assert.rejects(()=>call('activate',{reviewPassed:true,reviewNote:'Too early',expectedSelected:5}),/Complete the current cohort/);
 const done=await call('step',{limit:100});assert.equal(done.state,'review');assert.equal(done.complete,false);assert.equal(done.eligibleShortfall,495);assert.equal(done.counts.scored,5);
 const exported=await call('records',{includeSource:true});assert.equal(exported.scope,'non-uk');assert.equal(exported.selectionVersion,NON_UK_SCORING_SELECTION_VERSION);assert.equal(exported.records.length,5);assert.ok(exported.records.every(row=>row.source?.sourceFingerprint===row.sourceFingerprint));
 await assert.rejects(()=>call('activate',{reviewPassed:true,reviewNote:'Reviewed all five'}),e=>e.code==='catalogue_scoring_partial_review_required');
 await assert.rejects(()=>call('activate',{reviewPassed:true,reviewNote:'Wrong count',expectedSelected:4}),e=>e.code==='catalogue_scoring_review_count_changed');
 const activated=await call('activate',{reviewPassed:true,reviewNote:'Reviewed all five retained-source results',expectedSelected:5});
 assert.equal(activated.counts.activated,5);assert.equal(activated.activationReview.scope,'non-uk');assert.equal(activated.activationReview.selectionVersion,NON_UK_SCORING_SELECTION_VERSION);assert.equal(activated.activationReview.selected,5);assert.equal(activated.activationReview.target,500);
 assert.deepEqual(f.sql.prepare('SELECT * FROM catalogue_products WHERE is_uk=1 ORDER BY barcode').all(),ukBefore,'Non-UK publication must not alter UK catalogue rows');
 assert.equal((await call('rollback')).counts.rolled_back,5);
});
it('persists cohort scope across retries and rejects scope changes or unsupported selection identities before mutation',async()=>{
 const f=await fixture(6);f.sql.exec('UPDATE catalogue_products SET is_uk=0');
 const created=await f.call('create',{scope:'non-uk'});assert.deepEqual((await f.call('create',{scope:'non-uk'})).counts,created.counts);
 for(const body of [{},{scope:'uk'}])await assert.rejects(()=>f.call('create',body),e=>e.code==='catalogue_scoring_scope_changed');
 for(const scope of ['all','nonUK',null,0])await assert.rejects(()=>f.call('create',{scope}),/create-only/);
 for(const action of ['step','records','activate','extend','coverage','status'])await assert.rejects(()=>f.call(action,{scope:'non-uk'}),/create-only/);
 assert.equal((await f.call('status')).scope,'non-uk');assert.equal((await f.call('records')).scope,'non-uk');
 f.sql.prepare("UPDATE catalogue_scoring_runs SET selection_version='unsupported' WHERE id=?").run(runID);
 await assert.rejects(()=>f.call('step'),e=>e.code==='catalogue_scoring_selection_changed');
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM catalogue_scoring_run_items WHERE state='pending'").get().n,6);
});
it('retains exact-source and changed-score activation guards for a non-UK cohort',async()=>{
 const f=await fixture(5);f.sql.exec('UPDATE catalogue_products SET is_uk=0');await f.call('create',{scope:'non-uk'});await finish(f);
 f.sql.prepare('UPDATE catalogue_products SET fetched_at=fetched_at+1 WHERE barcode=?').run(raw.code);
 f.sql.prepare("UPDATE catalogue_products SET score_json='{}' WHERE barcode=?").run('5000000000001');
 const result=await f.call('activate',{reviewPassed:true,reviewNote:'Reviewed five',expectedSelected:5});
 assert.equal(result.counts.activated,3);assert.equal(result.counts.activation_source_changed,1);assert.equal(result.counts.activation_conflicts,1);
});
it('keeps persisted market scope when membership changes after selection or scoring',async()=>{
 for(const scope of ['uk','non-uk']){
  const f=await fixture(4),market=scope==='uk'?1:0;
  f.sql.prepare('UPDATE catalogue_products SET is_uk=?').run(market);
  const originals=f.sql.prepare('SELECT * FROM catalogue_products ORDER BY barcode').all();
  await f.call('create',{scope});
  f.sql.prepare('UPDATE catalogue_products SET is_uk=? WHERE barcode=?').run(1-market,originals[0].barcode);
  const scored=await f.call('step');assert.equal(scored.counts.source_changed,1);assert.equal(scored.counts.scored,3);
  assert.equal(f.sql.prepare('SELECT result_json FROM catalogue_scoring_run_items WHERE barcode=?').get(originals[0].barcode).result_json,null);
  f.sql.prepare('UPDATE catalogue_products SET is_uk=? WHERE barcode=?').run(1-market,originals[1].barcode);
  const exported=await f.call('records',{includeSource:true});
  assert.ok(exported.records.slice(0,2).every(row=>row.source===null&&row.nutrition===null),'Changed market membership is not exported as a still-matching cohort source');
  assert.ok(exported.records.slice(2).every(row=>row.source&&row.nutrition));
  const review={reviewPassed:true,reviewNote:'Reviewed the four selected sources',expectedSelected:4};
  await assert.rejects(()=>f.call('activate',{...review,expectedSelected:3}),e=>e.code==='catalogue_scoring_review_count_changed');
  const activated=await f.call('activate',review);assert.equal(activated.scope,scope);assert.equal(activated.counts.activated,2);assert.equal(activated.counts.activation_source_changed,2);
  for(const original of originals.slice(0,2))assert.deepEqual({...f.sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(original.barcode)},{...original,is_uk:1-market},'Scope changes alone leave that product score and all source fields untouched');
  const restored=await f.call('rollback');assert.equal(restored.counts.rolled_back,2);
  assert.deepEqual(f.sql.prepare('SELECT * FROM catalogue_products WHERE barcode>=? ORDER BY barcode').all(originals[2].barcode),originals.slice(2));
 }
});
it('guards market scope atomically during scoring, publication and rollback',async()=>{
 for(const scope of ['uk','non-uk'])for(const action of ['step','activate','rollback']){
  const f=await fixture(2),market=scope==='uk'?1:0,review={reviewPassed:true,reviewNote:'Reviewed both selected sources',expectedSelected:2};
  f.sql.prepare('UPDATE catalogue_products SET is_uk=?').run(market);await f.call('create',{scope});
  if(action!=='step')await f.call('step');
  if(action==='rollback')await f.call('activate',review);
  const before=f.sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(raw.code),batch=f.db.batch;
  f.db.batch=async statements=>{
   f.db.batch=batch;
   f.sql.prepare('UPDATE catalogue_products SET is_uk=? WHERE barcode=?').run(1-market,raw.code);
   return batch(statements);
  };
  const result=await f.call(action,action==='activate'?review:{});
  assert.deepEqual({...f.sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(raw.code)},{...before,is_uk:1-market},'A scope change between hydration and the transaction must not alter the product');
  if(action==='step'){
   assert.equal(result.counts.scored,1);assert.equal(result.counts.source_changed,1);
   assert.equal(f.sql.prepare('SELECT result_json FROM catalogue_scoring_run_items WHERE barcode=?').get(raw.code).result_json,null);
  }else if(action==='activate'){
   assert.equal(result.counts.activated,1);assert.equal(result.counts.activation_source_changed,1);
  }else{
   assert.equal(result.counts.rolled_back,1);assert.equal(result.counts.rollback_conflicts,1);
  }
 }
});
it('preserves the current product when market scope changes before rollback',async()=>{
 for(const scope of ['uk','non-uk']){
  const f=await fixture(2),market=scope==='uk'?1:0;
  f.sql.prepare('UPDATE catalogue_products SET is_uk=?').run(market);await f.call('create',{scope});await f.call('step');
  await f.call('activate',{reviewPassed:true,reviewNote:'Reviewed both sources',expectedSelected:2});
  f.sql.prepare('UPDATE catalogue_products SET is_uk=? WHERE barcode=?').run(1-market,raw.code);
  const changed=f.sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(raw.code),result=await f.call('rollback');
  assert.equal(result.counts.rolled_back,1);assert.equal(result.counts.rollback_conflicts,1);
  assert.deepEqual(f.sql.prepare('SELECT * FROM catalogue_products WHERE barcode=?').get(raw.code),changed);
 }
});
