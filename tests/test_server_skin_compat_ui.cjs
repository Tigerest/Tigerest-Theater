// A server-side skin (emby-crx) covers the page with .misty-loading and removes
// it only on Emby's stock home page. In the real client it must not block input.
const assert=require('node:assert/strict');
const withBrowser=require('./community_browser.cjs');

withBrowser({
 '/':{type:'text/html',body:'<!doctype html><meta charset="utf-8"><title>server skin fixture</title><body style="margin:0"><button id="under" style="width:200px;height:80px">home</button></body>'}
},async({evaluate,webengine})=>{
 assert.ok(webengine,'the compatibility rule is injected by the client; run with the client executable and --webengine');
 await evaluate('window.initCompleted');
 const state=await evaluate(`(()=>{
  const cover=document.createElement('div');
  cover.className='misty-loading';
  cover.style.cssText='position:fixed;inset:0;z-index:99999;background:#000';
  document.body.append(cover);
  return {display:getComputedStyle(cover).display,top:document.elementFromPoint(100,40)?.id};
 })()`);
 assert.equal(state.display,'none','the skin\'s loading cover is still displayed');
 assert.equal(state.top,'under','the skin\'s loading cover still swallows clicks');
 console.log('server skin compatibility: the .misty-loading cover no longer blocks the page');
},{startupTimeout:30000});
