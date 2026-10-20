window.createNudgeAccount = function(ctx) {
  'use strict';
  const {view,escapeHtml:esc,render,navigate}=ctx;
  const state={state:'checking',available:false,privateAccess:false,photoAnalysisAllowed:false,email:''};
  let sequence=0,requestId=null;

  function request(action) {
    const handler=window.webkit?.messageHandlers?.nudgeBarcode;
    if(!handler){Object.assign(state,{state:'unavailable',available:false,privateAccess:false,photoAnalysisAllowed:false,email:''});if(view.screen==='account')render();return;}
    requestId=`account-${Date.now()}-${++sequence}`;
    handler.postMessage({action,requestId});
  }
  function receive(event) {
    if(!event||event.type!=='status'||event.requestId!==requestId)return;
    const value=event.status;
    if(!value||!['checking','unavailable','signedOut','signedIn'].includes(value.state))return;
    // Account state is deliberately separate from the persisted diary. Only
    // display fields cross this bridge; tokens and verification codes do not.
    Object.assign(state,{
      state:value.state,available:value.available===true,privateAccess:value.privateAccess===true,photoAnalysisAllowed:value.photoAnalysisAllowed===true,
      email:value.state==='signedIn'&&typeof value.email==='string'?value.email.slice(0,254):''
    });
    // A background account check must not replace unsaved photo-review inputs.
    if(view.screen==='account')render();
  }
  function screen() {
    const signedIn=state.state==='signedIn';
    const status=signedIn?'Signed in':state.state==='checking'?'Checking availability…':'Not signed in';
    return `<button class="text-button back" data-action="navigate" data-value="you">You</button><h1>My account</h1><section class="card"><h2>${status}</h2>${signedIn&&state.email?`<p>${esc(state.email)}</p>`:''}${state.available||signedIn?`<button class="button primary" data-action="account-open">${signedIn?'Manage my account':'Sign in with email'}</button>`:state.state==='checking'?'':'<p class="notice">Sign-in is not available yet.</p><button class="button secondary" data-action="account-refresh">Check again</button>'}<p>Your diary stays on this iPhone.</p><button class="button secondary" data-action="photo-permission-settings">Food AI · ${state.photoAnalysisAllowed?'Allowed':'Not allowed'}</button></section><details><summary>Data &amp; connections</summary><p>Signing in enables photo reading and product ratings without a ChatGPT subscription. Diary entries and targets are not uploaded or synced. Signing out or deleting your account keeps this device’s diary.</p><p>Cloud backup and optional ChatGPT linking are not available yet.</p></details>`;
  }
  function handleAction(action) {
    if(action==='photo-permission-settings'){request(action);return true;}
    if(action==='account-show'){navigate('account');request('account-status');return true;}
    if(action==='account-open'){request('account-open');return true;}
    if(action==='account-refresh'){request('account-status');return true;}
    return false;
  }
  return {screen,receive,handleAction,refresh:()=>request('account-status'),canConfigurePrivateConnection:()=>state.privateAccess,_state:state};
};
