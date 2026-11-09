// Server-side skins write extra <script> and <link> lines into Emby's index.html.
// On the Emby versions whose stock page is known (4.8 to 4.10) the client must not
// run them, must keep Emby's own loader working, and must leave other servers alone.
const assert=require('node:assert/strict');
const withBrowser=require('./community_browser.cjs');
const {setTimeout:delay}=require('node:timers/promises');

// Shaped like Emby's stock page, with emby-crx's lines before </head> and other
// mods' lines where they are usually put.
const page=`<!doctype html><html><head><meta charset="utf-8"><title>Emby</title>
<link rel="preload" href="stock-font.woff2" as="font" type="font/woff2" crossorigin>
<script type="importmap">{"imports":{"stock-module":"./stock.js"}}</script>
<style>#shell{outline:1px solid rgb(1,2,3)}</style>
<link rel="stylesheet" id="theme-css" href="emby-crx/style.css" type="text/css" media="all" />
<script src="emby-crx/common-utils.js"></script>
<script src="emby-crx/jquery-3.6.0.min.js"></script>
<script src="emby-crx/main.js"></script>
<script>window.skinRuns=(window.skinRuns||0)+1;</script>
</head><body><div id="shell"></div>
<script src="apploader.js?v=4.10.2.0" defer></script>
<script src="ede.js" defer></script>
<link rel="stylesheet" href="last-line.css">
</body></html>`;

// Stands in for Emby's own loader, which adds its modules after the page is parsed.
const loader=`import('stock-module');
const script=document.createElement('script');script.src='dynamic.js';document.head.append(script);
const sheet=document.createElement('link');sheet.rel='stylesheet';sheet.href='dynamic.css';document.head.append(sheet);`;

const skinScript={body:'window.skinRuns=(window.skinRuns||0)+1;'};
const emby=Version=>({Id:'fixture',ServerName:'Fixture',Version});
const jellyfin={Id:'fixture',ServerName:'Fixture',ProductName:'Jellyfin Server',Version:'10.11.0'};
let answer,loads=0;

const routes={
 '/':{type:'text/html',body:'<!doctype html><meta charset="utf-8"><title>start</title>'},
 '/System/Info/Public':{type:'application/json',get body(){return JSON.stringify(answer);}},
 '/web/index.html':{type:'text/html',get body(){loads++;return page;}},
 '/web/apploader.js':{body:loader},
 '/web/stock.js':{body:'window.stockModule=true;'},
 '/web/stock-font.woff2':{type:'font/woff2',body:''},
 '/web/dynamic.js':{body:'window.dynamicRan=true;'},
 '/web/dynamic.css':{type:'text/css',body:'#shell{color:rgb(4,5,6)}'},
 '/web/emby-crx/style.css':{type:'text/css',body:'#shell{letter-spacing:7px}'},
 '/web/last-line.css':{type:'text/css',body:'#shell{word-spacing:9px}'},
 '/web/emby-crx/common-utils.js':skinScript,
 '/web/emby-crx/jquery-3.6.0.min.js':skinScript,
 '/web/emby-crx/main.js':skinScript,
 '/web/ede.js':skinScript
};

const SKIN_LINES=5; // three emby-crx scripts, the inline script and ede.js
const started='location.pathname==="/web/index.html"&&document.readyState==="complete"&&window.dynamicRan===true&&window.stockModule===true';

withBrowser(routes,async({url,call,evaluate,webengine})=>{
 assert.ok(webengine,'the filter is injected by the client; run with the client executable and --webengine');
 const visit=async({server,cached,knownServer=true,clear=true,until=started})=>{
  answer=server;
  if(clear)await evaluate(`(()=>{
   localStorage.removeItem('tigerestServerKind:'+location.origin);
   localStorage.removeItem('servercredentials3');
   ${cached?`localStorage.setItem('tigerestServerKind:'+location.origin,${JSON.stringify(JSON.stringify(cached))});`:''}
   ${knownServer?`localStorage.setItem('servercredentials3',${JSON.stringify(JSON.stringify({Servers:[{Id:'fixture',ManualAddress:url}]}))});`:''}
  })()`);
  loads=0;
  await call('Page.navigate',{url:url+'/web/index.html?'+Date.now()});
  let ready=false;
  for(let i=0;i<200&&!ready;i++){
   ready=await evaluate(until).catch(()=>false);
   if(!ready)await delay(50);
  }
  assert.ok(ready,'the page did not start: '+until);
  // Long enough for the server's version answer and a reload it might cause.
  await delay(400);
  return {...await evaluate(`(()=>{const style=getComputedStyle(document.getElementById('shell'));return {
   skinRuns:window.skinRuns??0,
   skinTags:document.querySelectorAll('[src*="emby-crx"],[href*="emby-crx"],[src$="ede.js"],[href$="last-line.css"]').length,
   letterSpacing:style.letterSpacing,wordSpacing:style.wordSpacing,
   stockStyle:style.outlineColor,dynamicStyle:style.color,
   importMaps:document.querySelectorAll('script[type=importmap]').length,
   fontPreloads:document.querySelectorAll('link[rel=preload]').length,
   remembered:JSON.parse(localStorage.getItem('tigerestServerKind:'+location.origin)||'null')
  };})()`),loads};
 };
 const assertSkinGone=(state,what)=>{
  assert.equal(state.skinRuns,0,what+': a skin script ran');
  assert.equal(state.skinTags,0,what+': a skin tag is still in the page');
  assert.equal(state.letterSpacing,'normal',what+': the skin stylesheet applied');
  assert.equal(state.wordSpacing,'0px',what+': the last-line stylesheet applied');
  assert.equal(state.stockStyle,'rgb(1, 2, 3)',what+': the stock inline style is gone');
  assert.equal(state.dynamicStyle,'rgb(4, 5, 6)',what+': the loader\'s stylesheet did not apply');
  assert.equal(state.importMaps,1,what+': the stock import map is gone');
  assert.equal(state.fontPreloads,1,what+': the stock font preload is gone');
  assert.equal(state.loads,1,what+': the page was loaded '+state.loads+' times');
 };
 const assertSkinLeftAlone=(state,what)=>{
  assert.equal(state.skinRuns,SKIN_LINES,what+': the page was changed');
  assert.equal(state.letterSpacing,'7px',what+': the skin stylesheet was removed');
  assert.equal(state.wordSpacing,'9px',what+': the last-line stylesheet was removed');
  assert.equal(state.loads,1,what+': the page was loaded '+state.loads+' times');
 };

 for(const version of ['4.8.0.80','4.8.11.0','4.9.3.0','4.9.5.0','4.10.0.40','4.10.1.0','4.10.2.0']){
  assertSkinGone(await visit({server:emby(version),cached:{kind:'emby',version}}),'Emby '+version);
 }
 assertSkinGone(await visit({server:emby('4.10.2.0'),knownServer:false}),'first run on a new profile');

 for(const version of ['4.7.14.0','4.11.0.13']){
  assertSkinLeftAlone(await visit({server:emby(version),cached:{kind:'emby',version}}),'Emby '+version);
 }
 assertSkinLeftAlone(await visit({server:jellyfin,cached:{kind:'jellyfin',version:'10.11.0'}}),'Jellyfin');

 // A further server added to a profile: its version is not known on the very first load.
 assertSkinLeftAlone(await visit({server:emby('4.10.2.0')}),'version not known yet');
 assertSkinGone(await visit({server:emby('4.10.2.0'),clear:false}),'second load of that server');

 // The server was updated past the known versions since the last visit.
 const updated=await visit({server:emby('4.11.0.13'),cached:{kind:'emby',version:'4.10.2.0'},
  until:`window.skinRuns===${SKIN_LINES}&&document.readyState==="complete"&&window.dynamicRan===true`});
 assert.equal(updated.skinRuns,SKIN_LINES,'the page did not get its tags back after the update');
 assert.equal(updated.loads,2,'expected exactly one reload after the update, loaded '+updated.loads+' times');
 assert.deepEqual(updated.remembered,{kind:'emby',version:'4.11.0.13'});

 console.log('server skin filter: Emby 4.8 to 4.10 pages start without the added tags, every other page is untouched');
},{startupTimeout:30000}).catch(error=>{console.error(error);process.exitCode=1;});
