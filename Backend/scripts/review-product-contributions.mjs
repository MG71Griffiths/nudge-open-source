#!/usr/bin/env node
import {requireAdminOrigin} from './require-admin-origin.mjs';
// Administrative packaging review only. This tool never submits contributions,
// follows image URLs from a response, or sends facts to Open Food Facts.
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';


const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ROLES=['front','nutrition','ingredients'];
const STATUSES=['queued','processing','pending_review','needs_photos','retryable_error','published','rejected'];
const PREFIX='/v1/admin/product-contributions';
const HASH=bytes=>createHash('sha256').update(bytes).digest('hex');
const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}':JSON.stringify(value);
const safeCodes=new Set(['authentication_required','catalogue_admin_not_configured','contribution_not_found','contribution_review_conflict','contribution_invalid','contribution_unavailable','contribution_already_published']);
export class ReviewCLIError extends Error {}
export const HELP=`Usage: node Backend/scripts/review-product-contributions.mjs COMMAND [options]
  list
  show ID --out PRIVATE_DIRECTORY
  photos --snapshot PRIVATE_DIRECTORY/review.json --out PRIVATE_DIRECTORY/photos
  publish --snapshot PRIVATE_DIRECTORY/review.json --confirm-barcode BARCODE
          --confirm-category CATEGORY_OR_unknown --confirm-label-facts
  reject --snapshot PRIVATE_DIRECTORY/review.json

Authentication: --token-file PRIVATE_FILE or --token-env VARIABLE_NAME
Default token environment variable: NUDGE_CATALOGUE_ADMIN_TOKEN
Destination: --base-url HTTPS_ORIGIN or NUDGE_ADMIN_ORIGIN is required.
Tokens are never accepted as command-line values. Output directories must be
private (0700); created snapshots/photos use 0600 and never overwrite files.
Inspect review.json and every photo before explicitly publishing. No write is
retried automatically. After an uncertain outcome, show the submission again.
`;
function origin(raw){try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error();return u.origin;}catch{throw new ReviewCLIError('Use an HTTPS origin without credentials, path, query or fragment.');}}
function id(value){if(typeof value!=='string'||!UUID.test(value))throw new ReviewCLIError('A valid submission ID is required.');return value.toLowerCase();}
function parse(argv){
 const command=argv[0];if(['help','--help','-h'].includes(command)||!command)return {command:'help'};
 if(!['list','show','photos','publish','reject'].includes(command))throw new ReviewCLIError('Unknown command. Use --help.');
 const options={command};let i=1;if(command==='show')options.id=id(argv[i++]);
 const valued=new Set(['out','snapshot','token-file','token-env','base-url','confirm-barcode','confirm-category']);
 for(;i<argv.length;i++){
  const key=argv[i].startsWith('--')?argv[i].slice(2):'';
  if(!valued.has(key)&&key!=='confirm-label-facts'||Object.hasOwn(options,key))throw new ReviewCLIError('Unknown or duplicate option. Tokens must come from a file or environment.');
  options[key]=key==='confirm-label-facts'?true:argv[++i];
  if(options[key]===undefined||typeof options[key]==='string'&&options[key].startsWith('--'))throw new ReviewCLIError('An option value is missing.');
 }
 const allowed={list:[],show:['out'],photos:['snapshot','out'],publish:['snapshot','confirm-barcode','confirm-category','confirm-label-facts'],reject:['snapshot']}[command];
 if(Object.keys(options).some(k=>!['command','id','token-file','token-env','base-url',...allowed].includes(k)))throw new ReviewCLIError('This option is not valid for the selected command.');
 for(const required of {list:[],show:['out'],photos:['snapshot','out'],publish:['snapshot','confirm-barcode','confirm-category','confirm-label-facts'],reject:['snapshot']}[command])if(!options[required])throw new ReviewCLIError('Required review options are missing. Use --help.');
 if(options['token-file']&&options['token-env'])throw new ReviewCLIError('Choose a token file or token environment variable.');
 if(!options['base-url']&&!process.env.NUDGE_ADMIN_ORIGIN)throw new ReviewCLIError('Set NUDGE_ADMIN_ORIGIN or --base-url to your HTTPS service origin.'); options.origin=origin(options['base-url']||requireAdminOrigin());return options;
}
async function privateFile(file,maxBytes){
 let handle;
 try{
  handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  const stat=await handle.stat();if(!stat.isFile()||stat.mode&0o077||stat.size>maxBytes)throw new ReviewCLIError('Use a regular owner-only file within the size limit.');
  return await handle.readFile();
 }catch(error){if(error instanceof ReviewCLIError)throw error;throw new ReviewCLIError('The private file could not be read.');}finally{await handle?.close();}
}
async function tokenFor(options,env){
 let value;
 if(options['token-file'])value=(await privateFile(options['token-file'],256)).toString('utf8').trim();
 else{const key=options['token-env']||'NUDGE_CATALOGUE_ADMIN_TOKEN';if(!/^[A-Z_][A-Z0-9_]{0,80}$/.test(key))throw new ReviewCLIError('Invalid token environment variable name.');value=env[key]?.trim();}
 if(!/^[a-f0-9]{64}$/.test(value||''))throw new ReviewCLIError('A valid catalogue administration token is required in the selected file/environment.');return value;
}
async function privateDirectory(directory){
 try{await fs.mkdir(directory,{recursive:true,mode:0o700});const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077)throw new Error();}
 catch{throw new ReviewCLIError('Use an owner-only directory (0700), not a symlink.');}
 return path.resolve(directory);
}
async function savePrivate(file,bytes){
 let handle;try{handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(bytes);}
 catch{throw new ReviewCLIError('Could not create a private review file; existing files are never overwritten.');}finally{await handle?.close();}
}
async function bounded(response,limit){
 if(Number(response.headers.get('content-length'))>limit)throw new ReviewCLIError('Server response exceeds the review limit.');
 const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks=[];let length=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();throw new ReviewCLIError('Server response exceeds the review limit.');}chunks.push(value);}}
 finally{reader.releaseLock();}return Buffer.concat(chunks,length);
}
function summary(value){
 const c=value?.contribution,category=value?.candidate?.prediction?.category?.value;
 if(!c||!UUID.test(c.id||'')||!/^\d{4,18}$/.test(c.barcode||'')||!STATUSES.includes(c.status)||!Number.isSafeInteger(c.updatedAt)||!Number.isSafeInteger(c.expiresAt))throw new ReviewCLIError('Invalid review response.');
 return {id:c.id,barcode:c.barcode,status:c.status,updatedAt:c.updatedAt,expiresAt:c.expiresAt,
 category:typeof category==='string'&&/^en:[a-z0-9-]{1,100}$/.test(category)?category:'unknown',readyForReview:value.candidate?.readyForReview===true,
 missingPhotoRoles:(Array.isArray(c.missingPhotoRoles)?c.missingPhotoRoles:[]).filter(role=>ROLES.includes(role))};
}
function validateDetail(value,expectedID){
 summary(value);
 const c=value?.contribution;
 if(!c||id(c.id)!==expectedID||!/^\d{4,18}$/.test(c.barcode||'')||!Number.isSafeInteger(c.updatedAt)||!Number.isSafeInteger(c.expiresAt)||!Array.isArray(value.photos)||value.photos.length>3
  ||new Set(value.photos.map(p=>p.role)).size!==value.photos.length||value.photos.some(p=>!ROLES.includes(p.role)||p.mime_type!=='image/jpeg'||!/^[a-f0-9]{64}$/.test(p.sha256)))throw new ReviewCLIError('Invalid review response.');
 return value;
}
export async function runReviewCLI(argv,{env=process.env,fetchImpl=fetch,write=value=>process.stdout.write(value),now=()=>Date.now()}={}){
 const options=parse(argv);if(options.command==='help'){write(HELP);return;}
 const token=await tokenFor(options,env);
 const request=async(route,{method='GET',body,photo=false}={})=>{
  let response;
  try{response=await fetchImpl(options.origin+PREFIX+route,{method,headers:{authorization:'Bearer '+token,'user-agent':'Nudge/0.1 (private product contribution review)',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30_000)});}
  catch{throw new ReviewCLIError(method==='POST'?'Review outcome is unknown; inspect current status before another command.':'Review request failed; no review decision was sent.');}
  const bytes=await bounded(response,response.ok?(photo?750_000:150_000):8192);
  if(!response.ok){let code;try{code=JSON.parse(bytes).code;}catch{}throw new ReviewCLIError(`Review request failed: HTTP ${response.status} (${safeCodes.has(code)?code:'review_unavailable'}). No automatic retry.`);}
  if(photo){if(!/^image\/jpeg(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)throw new ReviewCLIError('Invalid JPEG evidence response.');return bytes;}
  try{return JSON.parse(bytes);}catch{throw new ReviewCLIError('Invalid review response.');}
 };
 if(options.command==='list'){
  const value=await request('');if(!Array.isArray(value.contributions)||value.contributions.length>50)throw new ReviewCLIError('Invalid review list.');
  write(JSON.stringify({contributions:value.contributions.map(contribution=>summary({contribution})),limit:50},null,2)+'\n');return;
 }
 if(options.command==='show'){
  const value=validateDetail(await request('/'+options.id),options.id),directory=await privateDirectory(options.out);
  const snapshot={version:1,origin:options.origin,inspectedAt:now(),detail:value};
  const file=path.join(directory,'review.json');await savePrivate(file,JSON.stringify(snapshot,null,2)+'\n');
  write(JSON.stringify({...summary(value),snapshot:file},null,2)+'\n');return;
 }
 let snapshot;try{snapshot=JSON.parse(await privateFile(options.snapshot,500_000));}catch(error){if(error instanceof ReviewCLIError)throw error;throw new ReviewCLIError('Invalid saved review snapshot.');}
 if(snapshot?.version!==1||snapshot.origin!==options.origin)throw new ReviewCLIError('The snapshot origin does not match the selected server.');
 const detail=validateDetail(snapshot.detail,id(snapshot.detail?.contribution?.id)),c=detail.contribution;
 if(c.expiresAt<=now())throw new ReviewCLIError('This contribution has expired.');
 if(options.command==='photos'){
  const directory=await privateDirectory(options.out);
  for(const photo of detail.photos){const bytes=await request('/'+c.id+'/photos/'+photo.role,{photo:true});if(HASH(bytes)!==photo.sha256)throw new ReviewCLIError('Photo evidence changed; inspect a new snapshot.');await savePrivate(path.join(directory,photo.role+'.jpg'),bytes);}
  write(JSON.stringify({id:c.id,photosSaved:detail.photos.length,directory},null,2)+'\n');return;
 }
 const publish=options.command==='publish';
 if(!['pending_review','needs_photos'].includes(c.status)||publish&&(c.status!=='pending_review'||detail.candidate?.readyForReview!==true))throw new ReviewCLIError('This snapshot cannot be published/rejected in its current state.');
 if(publish&&(options['confirm-barcode']!==c.barcode||options['confirm-category']!==(detail.candidate?.prediction?.category?.value||'unknown')||options['confirm-label-facts']!==true))throw new ReviewCLIError('Confirm the exact barcode, category and every label fact from the inspected evidence.');
 const current=validateDetail(await request('/'+c.id),c.id);
 if(HASH(stable(current))!==HASH(stable(detail)))throw new ReviewCLIError('This submission changed. Save and inspect a new snapshot before deciding.');
 const body={decision:publish?'publish':'reject',expectedUpdatedAt:c.updatedAt,...(publish?{confirmBarcode:true,confirmCategory:true,confirmLabelFacts:true}:{})};
 const response=await request('/'+c.id+'/review',{method:'POST',body});
 if(response?.contribution?.id!==c.id||response.contribution.status!==(publish?'published':'rejected'))throw new ReviewCLIError('Review outcome is unknown; inspect current status before another command.');
 write(JSON.stringify(summary(response),null,2)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 runReviewCLI(process.argv.slice(2)).catch(error=>{process.stderr.write((error instanceof ReviewCLIError?error.message:'Review failed; inspect status before retrying.')+'\n');process.exitCode=1;});
}
