import {readFile,writeFile,mkdir,rename,open,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DIRECTIONAL_SCORE_REVISION} from '../src/product-score.js';
import {SCORING_SELECTION_VERSION,NON_UK_SCORING_SELECTION_VERSION} from '../src/catalogue-scoring-run.js';

const hash=text=>createHash('sha256').update(text).digest('hex');
const code=value=>typeof value==='string'&&/^[0-9]{4,18}$/.test(value);
async function save(path,value){await writeFile(path+'.part',JSON.stringify(value)+'\n',{mode:0o600});await rename(path+'.part',path);}
function snapshot(status){return {target:status.target,selected:status.counts.selected,processed:status.metrics.processed,updatedAt:status.updatedAt,state:status.state,activated:status.counts.activated??0,rolledBack:status.counts.rolled_back??0};}
function scopeIdentity(value){
 // The UK-only server included selectionVersion on status, but neither
 // selectionVersion nor scope on records. Both identify the legacy UK scope.
 // Non-UK exports always require their explicit persisted selection identity.
 if(value.scope===undefined&&(value.selectionVersion===undefined||value.selectionVersion===SCORING_SELECTION_VERSION))return {};
 if(value.scope==='uk'&&value.selectionVersion===SCORING_SELECTION_VERSION||value.scope==='non-uk'&&value.selectionVersion===NON_UK_SCORING_SELECTION_VERSION)return {scope:value.scope,selectionVersion:value.selectionVersion};
 throw new Error('Scoring export has an invalid selection scope.');
}
function header(runID,status){return {runID,...DIRECTIONAL_SCORE_REVISION,...scopeIdentity(status)};}
function checkPage(value,after){
 if(!Array.isArray(value.records)||value.records.length>100||typeof value.hasMore!=='boolean')throw new Error('Invalid scoring export page.');
 let previous=after;
 for(const row of value.records){if(!code(row.barcode)||row.barcode<=previous)throw new Error('Scoring export rows are not in stable barcode order.');previous=row.barcode;}
 if(value.hasMore&&(!value.records.length||value.nextAfter!==previous))throw new Error('Invalid scoring export cursor.');
 return previous;
}

// Page files are immutable checkpoints. Only the small manifest is rewritten
// per response; the potentially large combined file is streamed exactly once.
export async function exportPilot({options,request,sleep,stopped,diagnostic}){
 const status=await request('status');if(!status)return {exported:0,complete:false};
 const selected=snapshot(status),identity=header(options.runID,status),includeSource=options.includeSource===true;
 const generation=hash(JSON.stringify({...identity,snapshot:selected,...(includeSource?{includeSource:true}:{})})).slice(0,24);
 const manifestPath=options.output+'/export-manifest.json',recordsPath=options.output+'/records.json',directory=options.output+'/export-pages-'+generation;
 let previous;try{previous=JSON.parse(await readFile(manifestPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(previous&&(previous.scope??'uk')!==(status.scope??'uk'))throw new Error('Local export checkpoint belongs to a different selection scope. Use its own output directory.');
 const priorIdentity=previous?{...previous,...(previous.scope===undefined&&previous.selectionVersion===undefined?{scope:'uk',selectionVersion:SCORING_SELECTION_VERSION}:{})}:null;
 if(previous&&Object.keys(identity).some(key=>priorIdentity[key]!==identity[key]))throw new Error('Local export checkpoint belongs to a different run, scoring revision or scope. Use its own output directory.');
 let manifest=previous?.generation===generation?previous:null;
 if(manifest){
  if(manifest.formatVersion!==1||(manifest.includeSource===true)!==includeSource||Object.keys(identity).some(key=>manifest[key]!==identity[key])||!Array.isArray(manifest.pages)||manifest.pages.length>101)throw new Error('Invalid local export checkpoint.');
 }else{
  manifest={formatVersion:1,...identity,includeSource,generation,snapshot:selected,complete:false,fetchComplete:false,recordCount:0,nextAfter:'',pages:[]};
  await mkdir(directory,{recursive:true});
  // Never leave a previous completed500-row export looking like the new10k.
  await save(recordsPath,{...identity,complete:false,records:[],manifest:'export-manifest.json'});
  await save(manifestPath,manifest);
 }
 let cursor='',count=0;
 for(let i=0;i<manifest.pages.length;i++){
  const page=manifest.pages[i];
  if(page.file!==String(i).padStart(5,'0')+'.json'||page.after!==cursor||!Number.isSafeInteger(page.count)||page.count<0||page.count>100)throw new Error('Invalid local export page checkpoint.');
  const text=await readFile(directory+'/'+page.file,'utf8');
  if(hash(text)!==page.sha256)throw new Error('A retained export page failed its integrity check.');
  const records=JSON.parse(text);checkPage({records,hasMore:page.nextAfter!==null,nextAfter:page.nextAfter},cursor);
  if(records.length!==page.count)throw new Error('A retained export page has the wrong row count.');
  count+=page.count;cursor=page.nextAfter;
 }
 if(count!==manifest.recordCount||(manifest.pages.length&&cursor!==manifest.nextAfter)||manifest.fetchComplete!==(manifest.pages.length>0&&cursor===null))throw new Error('Local export checkpoint counts do not match its pages.');
 if(manifest.complete){
  const final=await stat(recordsPath).catch(()=>null);
  if(final?.size===manifest.finalBytes)return {exported:manifest.recordCount,complete:true,file:recordsPath,resumed:true};
  manifest.complete=false;
 }
 while(!manifest.fetchComplete&&!stopped()){
  const value=await request('records',{after:manifest.nextAfter,limit:100,...(includeSource?{includeSource:true}:{})});if(!value)break;
  if(JSON.stringify(scopeIdentity(value))!==JSON.stringify(scopeIdentity(status)))throw new Error('Scoring export page belongs to a different selection scope.');
  checkPage(value,manifest.nextAfter);
  const file=String(manifest.pages.length).padStart(5,'0')+'.json',text=JSON.stringify(value.records)+'\n';
  if(manifest.pages.length>=101||manifest.recordCount+value.records.length>selected.selected)throw new Error('Scoring export grew beyond its selected snapshot.');
  await writeFile(directory+'/'+file+'.part',text,{mode:0o600});await rename(directory+'/'+file+'.part',directory+'/'+file);
  manifest.pages.push({file,after:manifest.nextAfter,nextAfter:value.hasMore?value.nextAfter:null,count:value.records.length,sha256:hash(text)});
  manifest.recordCount+=value.records.length;manifest.nextAfter=value.hasMore?value.nextAfter:null;manifest.fetchComplete=!value.hasMore;
  await save(manifestPath,manifest);
  await diagnostic('export_page_saved',{page:manifest.pages.length,recordCount:manifest.recordCount,complete:false});
  if(!manifest.fetchComplete&&!stopped())await sleep(options.delay);
 }
 if(stopped()||!manifest.fetchComplete)return {exported:manifest.recordCount,complete:false,file:recordsPath,manifest:manifestPath};
 if(manifest.recordCount!==selected.selected)throw new Error('Scoring export row count does not match the selected snapshot.');
 const finalStatus=await request('status');if(!finalStatus)return {exported:manifest.recordCount,complete:false,file:recordsPath};
 if(JSON.stringify(snapshot(finalStatus))!==JSON.stringify(selected)||JSON.stringify(scopeIdentity(finalStatus))!==JSON.stringify(scopeIdentity(status)))throw new Error('Scoring run changed during export. Run export again to checkpoint the new snapshot.');
 if(stopped())return {exported:manifest.recordCount,complete:false,file:recordsPath};
 const started=performance.now(),out=await open(recordsPath+'.part','w',0o600);let nonempty=false;
 try{
  await out.writeFile(JSON.stringify({...identity,complete:true}).slice(0,-1)+',"records":[');
  for(const page of manifest.pages){
   const text=await readFile(directory+'/'+page.file,'utf8');if(hash(text)!==page.sha256)throw new Error('A retained export page failed its integrity check.');
   const content=text.trim().slice(1,-1);if(!content)continue;
   await out.writeFile((nonempty?',':'')+content);nonempty=true;
  }
  await out.writeFile(']}\n');
 }finally{await out.close();}
 await rename(recordsPath+'.part',recordsPath);
 manifest.complete=true;manifest.finalBytes=(await stat(recordsPath)).size;await save(manifestPath,manifest);
 await diagnostic('export_assembled',{recordCount:manifest.recordCount,bytes:manifest.finalBytes,durationMs:Math.max(0,Math.round(performance.now()-started))});
 return {exported:manifest.recordCount,complete:true,file:recordsPath};
}
