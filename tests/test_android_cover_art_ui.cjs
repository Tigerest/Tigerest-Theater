// Android rasters a flying poster's artwork when its flight starts, and its
// WebView presents nothing until that frame is rastered. The home strip's
// selected cover is decoded beforehand from the bytes its own request left in
// the HTTP cache (Emby varies artwork on Accept), and its flight shows that
// bitmap on a canvas. Other flights paint their artwork as before.
// Runs in Chrome with the real modules and HTTP cache.
const assert=require('node:assert/strict'),path=require('node:path'),withBrowser=require('./community_browser.cjs');
const root=path.resolve(__dirname,'..'),cached={Vary:'Accept','Cache-Control':'public, max-age=31536000'};
let downloads=0;
const routes=new Proxy({
 '/':{type:'text/html',body:`<!doctype html><style>body{margin:0;background:#101722}.page{position:fixed;inset:0}.hide{display:none}
.tg-cover{position:absolute;top:400px;width:88px;height:130px;padding:0;border:0;overflow:hidden}.tg-cover img{width:100%;height:100%;object-fit:cover}
.detailImageContainer{width:130px;height:195px;margin:60px;background-size:cover}</style>
<div class="tg-home-host page" id="home"><div class="tg-home tg-entered">
<button class="tg-cover is-selected" style="left:40px"><img src="/Items/a/Images/Primary?tag=1"></button>
<button class="tg-cover" style="left:160px"><img src="/Items/b/Images/Primary?tag=1"></button></div></div>
<div class="page hide" id="detail"><div class="detailImageContainer" style="background-image:url('/Items/a/Images/Primary?tag=1')"></div></div>
<script src="/backdrop.js"></script><script src="/transitions.js"></script>`},
 '/backdrop.js':{path:path.join(root,'native/homeBackdrop.js')},'/transitions.js':{path:path.join(root,'native/homeTransitions.js')},
 '/Items/a/Images/Primary':{type:'image/png',path:path.join(__dirname,'fixtures/ambient-a.png'),headers:cached},
 '/Items/b/Images/Primary':{type:'image/png',path:path.join(__dirname,'fixtures/ambient-b.png'),headers:cached}
},{get(target,key){if(String(key).startsWith('/Items/'))downloads++;return target[key];}});
withBrowser(routes,async({evaluate,call})=>{
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await evaluate(`document.body.classList.add('tg-home-active');window.tigerestAndroidApi=window.tigerestAndroidApi||{};
  window.fixture={async fly(source){
   const home=document.querySelector('#home'),detail=document.querySelector('#detail');
   let shown=null;
   const centre=canvas=>[...canvas.getContext('2d').getImageData(canvas.width>>1,canvas.height>>1,1,1).data].slice(0,3);
   const expected=Object.assign(document.createElement('canvas'),{width:source.naturalWidth,height:source.naturalHeight});expected.getContext('2d').drawImage(source,0,0);
   setTimeout(()=>{const p=document.querySelector('.tigerest-motion-poster'),c=p?.querySelector('canvas');
    shown=p&&{canvas:c?[c.width,c.height]:null,background:p.style.backgroundImage,pixel:c?centre(c):null,artwork:centre(expected)};},60);
   await TigerestHomeTransitions.poster({source,findTarget:()=>document.querySelector('#detail:not(.hide) .detailImageContainer'),
    navigate:async()=>{home.classList.add('hide');document.body.classList.remove('tg-home-active');detail.classList.remove('hide');},
    landingKey:'cover-art-'+Math.random(),presetRect:{x:60,y:60,width:130,height:195}});
   const result={preparedArt:TigerestHomeTransitions.last.preparedArt,shown,leaks:document.querySelectorAll('.tigerest-motion-flight,[data-tigerest-poster-held]').length};
   detail.classList.add('hide');home.classList.remove('hide');document.body.classList.add('tg-home-active');return result;
  }};Promise.all([...document.images].map(i=>i.decode())).then(()=>true)`);
 const loaded=downloads;
 assert.equal(loaded,2,'the page loads each cover once');
 await evaluate('TigerestHomeTransitions.prewarm().then(()=>new Promise(r=>setTimeout(r,300)))');
 const selected=await evaluate(`fixture.fly(document.querySelector('.tg-cover.is-selected img'))`);
 assert.ok(selected.preparedArt&&selected.shown?.canvas&&!selected.shown.background,'the selected cover flies its prepared bitmap: '+JSON.stringify(selected));
 // No detail landing is known yet: twice the cover's height, at most the artwork's own.
 assert.deepEqual(selected.shown.canvas,[320,240],'prepared at the artwork size here: '+JSON.stringify(selected));
 assert.ok(selected.shown.pixel.every((v,i)=>Math.abs(v-selected.shown.artwork[i])<=6),'the canvas holds the artwork: '+JSON.stringify(selected.shown));
 assert.equal(downloads,loaded,'the cover is decoded from its cached bytes, not downloaded again');
 assert.equal(selected.leaks,0,'the flight cleans up');
 const other=await evaluate(`fixture.fly(document.querySelector('.tg-cover:not(.is-selected) img'))`);
 assert.ok(!other.preparedArt&&!other.shown?.canvas&&other.shown?.background.includes('/Items/b/'),'another cover flies its artwork as before: '+JSON.stringify(other));
 const again=await evaluate(`fixture.fly(document.querySelector('.tg-cover.is-selected img'))`);
 assert.ok(!again.preparedArt&&again.shown?.background.includes('/Items/a/'),'a prepared bitmap is used once: '+JSON.stringify(again));
 console.log('android cover art:',JSON.stringify({selected:selected.shown,other:other.shown,downloads}));
},{gpu:true,visible:true}).catch(error=>{console.error(error);process.exitCode=1;});
