/* Native Search owns discovery only. Existing review and diary commands remain
 * the sole write path. This adapter is enabled only by the native app host. */
window.createNudgeNativeSearch = function(context) {
  'use strict';
  const {navigate,barcode,search,camera}=context;
  const enabled=window.__nudgeNativeProductSearch===true;
  let savedMode=false,last=null;
  function sync(screen){
    if(!enabled)return;
    const active=screen==='search'&&!savedMode,signature=screen+':'+active;
    if(signature===last)return;
    try{window.webkit.messageHandlers.nudgeBarcode.postMessage({action:'native-search-screen',screen,active});last=signature;}catch{}
  }
  function prepareNavigation(screen){if(screen==='search')savedMode=false;}
  function go(screen){
    if(!enabled||!['today','history','camera','search','you'].includes(screen))return false;
    if(screen==='camera'){camera();return true;}
    prepareNavigation(screen);navigate(screen);return true;
  }
  function openProduct(product){
    if(!enabled||!product||typeof product!=='object'||!/^\d{4,18}$/.test(product.barcode||'')||typeof product.name!=='string')return false;
    savedMode=false;barcode.openSearchProduct(product);return true;
  }
  function showSaved(){if(!enabled)return false;savedMode=true;search.showSaved();return true;}
  return {sync,navigate:go,openProduct,showSaved,prepareNavigation,
    usesNative:()=>enabled&&!savedMode};
};
