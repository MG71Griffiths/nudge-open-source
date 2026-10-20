// Test-only promotion for both Node imports and browser/JavaScriptCore source
// harnesses. It never edits the production activation flag or source files.
// Run with the project's Node 24 runtime: node --require ./tests/helpers/directional-preload.cjs --test ...
const fs=require('node:fs'),path=require('node:path'),{registerHooks}=require('node:module');
const corePath=path.resolve(__dirname,'../../Web/core/nudge-score.js');
const coreURL=require('node:url').pathToFileURL(corePath).href;
const promote=source=>source.replace('const ACTIVE_DIRECTIONAL=false;','const ACTIVE_DIRECTIONAL=true;');
const originalRead=fs.readFileSync;
fs.readFileSync=function(file,...args){
  const data=originalRead.call(this,file,...args);
  if(typeof file==='string'&&path.resolve(file)===corePath){
    const promoted=promote(Buffer.isBuffer(data)?data.toString():data);
    return Buffer.isBuffer(data)?Buffer.from(promoted):promoted;
  }
  return data;
};
registerHooks({load(url,context,next){
  const result=next(url,context);
  if(url===coreURL)
    return {...result,source:promote(Buffer.from(result.source).toString())};
  return result;
}});
