const assert=require('node:assert/strict'),path=require('node:path');
const withBrowser=require('./community_browser.cjs');
withBrowser({'/':{type:'text/html',body:`<!doctype html><style>
body{margin:0;background:#123;color:white}.page{position:fixed;inset:0;padding:30px}.hide{display:none}
.tigerest-page-enter{animation:fixtureEntrance 700ms 80ms both!important}
@keyframes fixtureEntrance{from{opacity:.08;filter:blur(12px);transform:translateY(72px)}to{opacity:1;filter:blur(0);transform:none}}
</style><div id=home class=page><div class=tg-home-nav>Library</div><div class=tg-home-rail>Posters</div><div class=tg-home-stage>Home</div></div>
<div id=library class="page hide"><h1>Library</h1><p>Sharp destination page</p></div><script src=/transitions.js></script>`},
 '/transitions.js':{path:path.join(__dirname,'../native/homeTransitions.js')}},async({evaluate,call})=>{
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await evaluate(`window.fixtureTransition=TigerestHomeTransitions.library({gallery:{active:true,root:document.querySelector('#home')},navigate:()=>{
 document.querySelector('#home').classList.add('hide');document.querySelector('#library').className='page tigerest-page-enter';}});true`);
 let snapshot;
 for(let i=0;i<120;i++){
  snapshot=await evaluate(`(()=>{const incoming=document.querySelector('.tigerest-motion-layer .tigerest-motion-frozen');const page=incoming?.shadowRoot.querySelector('#library');if(!page)return null;const s=getComputedStyle(page);return {opacity:s.opacity,filter:s.filter,transform:s.transform,incomingAnimations:incoming.getAnimations().length}})()`);
  // The copy is drawn under the cover for a few frames before it moves.
  if(snapshot?.incomingAnimations)break;await new Promise(r=>setTimeout(r,20));
 }
 assert.ok(snapshot,'the central incoming animation was observed');
 assert.equal(snapshot.opacity,'1','the opaque cover must hide the competing page entrance until it is finished');
 assert.ok(['none','blur(0px)'].includes(snapshot.filter),'incoming page must not freeze a partly blurred entrance: '+JSON.stringify(snapshot));
 assert.ok(['none','matrix(1, 0, 0, 1, 0, 0)'].includes(snapshot.transform),'incoming page has its final geometry');
 assert.ok(snapshot.incomingAnimations>0,'the central incoming animation still runs');
 await evaluate('fixtureTransition');
 assert.equal(await evaluate('document.querySelectorAll(".tigerest-motion-layer,.tigerest-motion-input").length'),0,'transition releases its cover');
 console.log('library incoming page is settled and animated');
}).catch(e=>{console.error(e);process.exitCode=1});
