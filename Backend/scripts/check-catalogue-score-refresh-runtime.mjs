// Local Workers SQLite migration benchmark; only public OFF fixture records.
// Build with wrangler deploy --dry-run first. No external network is permitted.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,realpathSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const directory=mkdtempSync(join(tmpdir(),'nudge-score-refresh-'));
const current=fileURLToPath(new URL('../.wrangler/dry-run/index.js',import.meta.url));
const token='48'.repeat(32),hash=createHash('sha256').update(token).digest('hex');
const options=scriptPath=>convertV4MiniflareOptions({resourcePersistencePath:join(directory,'storage'),workers:[{
 name:'score-refresh-runtime',modules:true,scriptPath,compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],
 durableObjects:{FOOD_CATALOGUE_INDEX:{className:'FoodCatalogueIndex',useSQLite:true},LABEL_QUOTA:{className:'LabelQuota',useSQLite:true}},
 bindings:{PRIVATE_ACCESS_TOKEN_SHA256:hash,CATALOGUE_ADMIN_TOKEN_SHA256:hash},outboundService:async()=>{throw new Error('No external network allowed');}
}]});
const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/off-provider-compatibility-products.json',import.meta.url))).products;
let mf=new Miniflare(options(current));
const send=(path,body)=>mf.dispatchFetch('https://nudge.example'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
try{
 const now=Date.now();
 const products=Array.from({length:600},(_,i)=>({...structuredClone(fixture[i%fixture.length]),code:String(5000000000000+i),countries_tags:['en:united-kingdom']}));
 for(let i=0;i<products.length;i+=50){const response=await send('/v1/catalogue/import',{products:products.slice(i,i+50),sourceURL:'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',fetchedAt:now});assert.equal(response.status,200);assert.equal((await response.json()).accepted,50);}
 const before=await (await send('/v1/products/batch',{codes:products.slice(0,4).map(p=>p.code)})).json();
 await mf.dispose();
 // Change only the isolated test database to represent a previous engine version.
 const files=readdirSync(join(directory,'storage'),{recursive:true}).filter(file=>file.endsWith('.sqlite'));
 let seeded=false;
 for(const file of files){const db=new DatabaseSync(join(directory,'storage',file));try{if(db.prepare("SELECT name FROM sqlite_master WHERE name='catalogue_products'").get()){db.exec("UPDATE catalogue_products SET classifier_version='runtime-fixture-old-classifier'");seeded=true;}}finally{db.close();}}
 assert.equal(seeded,true);mf=new Miniflare(options(current));
 let response=await send('/v1/catalogue/recalculate',{statusOnly:true});assert.equal(response.status,200);let status=await response.json();
 assert.deepEqual(status.scoreCoverage,{currentRated:0,currentUnrated:0,outdated:600,total:600});
 const start=performance.now();response=await send('/v1/catalogue/recalculate',{});assert.equal(response.status,200);status=await response.json();const durationMs=Math.round(performance.now()-start);
 assert.equal(status.updated,500);assert.equal(status.remaining,100);assert.equal(status.complete,false);assert.equal(status.scoreCoverage,undefined);
 response=await send('/v1/catalogue/recalculate',{});status=await response.json();assert.equal(status.updated,100);assert.equal(status.remaining,0);assert.equal(status.complete,true);
 status=await (await send('/v1/catalogue/recalculate',{statusOnly:true})).json();assert.deepEqual(status.scoreCoverage,{currentRated:600,currentUnrated:0,outdated:0,total:600});
 const after=await (await send('/v1/products/batch',{codes:products.slice(0,4).map(p=>p.code)})).json();assert.deepEqual(after.products,before.products,'Migration leaves public product facts and images intact');
 for(let i=0;i<4;i++){assert.equal(after.ratings[i].fetchedAt,before.ratings[i].fetchedAt);assert.equal(after.ratings[i].expiresAt,before.ratings[i].expiresAt);}
 console.log(JSON.stringify({event:'score_refresh_runtime_pass',updated:600,batchLimit:500,batchDurationMs:durationMs,scoreCoverage:status.scoreCoverage,externalRequests:0}));
}finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
