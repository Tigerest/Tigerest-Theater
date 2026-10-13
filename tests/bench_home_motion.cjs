// Manual Emby-scale latency benchmark for the home/library/detail transitions.
// Not a CTest: timings depend on the machine. Compare runs on the same device.
//   node tests/bench_home_motion.cjs <browser-or-client> [--webengine] [--rounds=5]
// Android: TIGEREST_ANDROID_FIXTURE=1 node tests/bench_home_motion.cjs
// Uses an isolated fixture page and profile; it never touches an Emby account.
const path=require('node:path'),withBrowser=require('./community_browser.cjs');
const repo=path.resolve(__dirname,'..'),rounds=Number(process.argv.find(a=>a.startsWith('--rounds='))?.slice(9)||5);
const embedded=process.argv.includes('--webengine')||!!process.env.TIGEREST_ANDROID_FIXTURE;
// Raster PNG posters like Emby's JPEG artwork. SVG artwork is rasterized on the
// main thread and made QtWebEngine software rendering stall for seconds.
const zlib=require('node:zlib'),posters=new Map();
function chunk(type,data){const len=Buffer.alloc(4),crc=Buffer.alloc(4),body=Buffer.concat([Buffer.from(type),data]);len.writeUInt32BE(data.length);crc.writeUInt32BE(zlib.crc32(body));return Buffer.concat([len,body,crc]);}
function poster(hue){
 if(posters.has(hue))return posters.get(hue);
 const w=300,h=450,raw=Buffer.alloc((w*3+1)*h),a=[(hue*7)%200+40,(hue*3)%180+30,(hue*11)%160+60],b=[a[2]>>2,a[0]>>2,a[1]>>2];
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const t=(x+y)/(w+h),inside=(x-150)**2+(y-170)**2<90**2,o=y*(w*3+1)+1+x*3;for(let c=0;c<3;c++)raw[o+c]=inside?Math.min(255,a[c]+90):Math.round(a[c]*(1-t)+b[c]*t);}
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr.set([8,2,0,0,0],8);
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
 posters.set(hue,png);return png;
}
function sheet(seed,n){let s=':root{'+Array.from({length:40},(_,i)=>`--v${seed}-${i}:${i}px;`).join('')+'}\n';for(let i=0;i<n;i++)s+=`.s${seed}-${i} .k${i%97}>.m${i%31}:not(.hide),.skinBody .z${i}[data-a="${i%13}"]{margin:${i%7}px ${i%5}px;padding:${i%3}px;color:rgb(${i%255},${(i*7)%255},${(i*13)%255});border-radius:${i%9}px;font-size:${10+i%8}px}\n`;return s;}
const layout=`body{margin:0;background:#101722;color:#ddd;font:14px sans-serif;overflow:hidden}
.backgroundContainer,.backdropContainer{position:fixed;inset:0}.backdropImage{position:absolute;inset:0;background-size:cover;opacity:.35}
.skinHeader{position:fixed;left:0;right:0;top:0;height:48px;background:#0d1118cc;z-index:5;display:flex;gap:12px;align-items:center;padding:0 16px}
.page{position:fixed;inset:48px 0 0 0;overflow:auto;background:linear-gradient(120deg,#22313f,#101722)}.hide{display:none!important}
.tg-home{display:grid;grid-template-columns:220px 1fr;grid-template-rows:1fr 240px;height:100%}
.tg-home-nav{grid-row:1/3;display:flex;flex-direction:column;gap:8px;padding:12px;overflow:auto}.tg-library{display:flex;gap:8px;align-items:center;height:64px;background:#ffffff10;border:0;color:#ddd}.tg-library img{width:96px;height:54px;object-fit:cover}
.tg-home-stage{position:relative;overflow:hidden}.tg-home-stage .hero{position:absolute;right:40px;top:30px;width:220px;height:330px;object-fit:cover}.tg-home-stage h2{font-size:42px;margin:60px 40px 10px}.tg-home-stage p{margin:8px 40px;max-width:520px}
.tg-home-rail{overflow:hidden}.tg-cover-list{display:flex;gap:12px;overflow-x:auto;padding:12px}.tg-cover{flex:0 0 120px;height:180px;position:relative;border:0;padding:0;background:#000}.tg-cover img{width:100%;height:100%;object-fit:cover}.tg-cover-label{position:absolute;left:4px;bottom:4px;font-size:11px}
.itemsContainer{display:flex;flex-wrap:wrap;gap:14px;padding:20px}.card{width:150px}.cardBox{margin:0}.cardScalable{position:relative}.cardPadder{padding-bottom:150%}.cardImageContainer{position:absolute;inset:0}.cardImage{width:100%;height:100%;object-fit:cover;display:block}.cardFooter{height:40px}.cardText{white-space:nowrap;overflow:hidden;font-size:12px}
.detailMainContainer{display:flex;gap:24px;padding:40px}.detailImageContainer-main{width:240px;flex:0 0 240px}.detailImageContainer-main img{width:240px;height:360px;object-fit:cover}.detailTextContainer h1{font-size:36px}.castList{display:flex;flex-wrap:wrap;gap:10px;padding:20px 40px}.cast{width:90px}.cast img{width:90px;height:90px;border-radius:50%;object-fit:cover}`;
let id=0;const img=(cls,hue,lazy=false)=>`<img class="${cls}" ${lazy?'loading="lazy" ':''}src="/img/p.png?h=${hue}&n=${id++}">`;
const homeHtml=`<div class="page mainAnimatedPage" id="home"><div class="tg-home-host"><div class="tg-home tg-entered">
<nav class="tg-home-nav">${Array.from({length:10},(_,i)=>`<button class="tg-library" data-library-id="lib${i}">${img('',i*30)}<span class="tg-library-label"><span>媒体夹 ${i}</span><span>LIBRARY 0${i}</span></span></button>`).join('')}</nav>
<section class="tg-home-stage">${img('hero',200)}<div class="hero-content"><div class="kicker">动画 / 继续观看</div><h2 id="hero-title">作品标题</h2><div class="sub">2024 · 最新入库 S1:E12</div><p id="hero-overview">${'简介文字。'.repeat(40)}</p></div></section>
<section class="tg-home-rail"><div class="tg-rail-heading"><span>动画 / 继续观看</span><button class="tg-home-more">查看更多 →</button></div><div class="tg-cover-list">${Array.from({length:24},(_,i)=>`<button class="tg-cover" data-item-id="w${i}" data-index="${i}">${img('',i*15,i>9)}<span class="tg-cover-label">作品 ${i}</span></button>`).join('')}</div></section>
</div></div></div>`;
const card=i=>`<div class="card s1-${i}" data-id="w${i}"><div class="cardBox"><div class="cardScalable"><div class="cardPadder"></div><div class="cardImageContainer">${img('cardImage',i*7,i>40)}</div></div><div class="cardFooter"><div class="cardText">作品 ${i}</div><div class="cardText">2024</div></div></div></div>`;
const libraryHtml=`<div class="page mainAnimatedPage hide" id="library"><div class="itemsContainer">${Array.from({length:240},(_,i)=>card(i)).join('')}</div></div>`;
const detailHtml=`<div class="page mainAnimatedPage hide view-item-item" id="detail"><div class="detailMainContainer"><div class="detailImageContainer detailImageContainer-main">${img('cardImage',7*3)}</div><div class="detailTextContainer"><h1>作品 3</h1>${Array.from({length:30},(_,i)=>`<div class="detail-row k${i}"><span>字段 ${i}</span><span>${'值'.repeat(i%9+1)}</span></div>`).join('')}<p>${'剧情介绍。'.repeat(80)}</p></div></div><div class="castList">${Array.from({length:60},(_,i)=>`<div class="cast">${img('',i*11,i>12)}<div>演员 ${i}</div><div>角色 ${i}</div></div>`).join('')}</div>${Array.from({length:4},(_,s)=>`<div class="itemsContainer">${Array.from({length:20},(_,i)=>card(300+s*20+i)).join('')}</div>`).join('')}</div>`;
const hidden=n=>`<div class="page mainAnimatedPage hide" id="old${n}">${Array.from({length:150},(_,i)=>`<div class="row s2-${i}"><span class="a">${i}</span><span class="b">${'x'.repeat(i%20)}</span><div class="c"><i></i><i></i><i></i></div></div>`).join('')}</div>`;
const body=`<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/a.css"><link rel="stylesheet" href="/css/b.css"><style>${layout}</style>${[1,2,3].map(n=>`<style>${sheet(n,900)}</style>`).join('')}
<body class="skinBody"><div class="backgroundContainer"></div><div class="backdropContainer"><div class="backdropImage" style="background-image:url(/img/p.png?h=99&n=bd)"></div></div><div class="skinHeader"><b>Emby</b>${Array.from({length:8},(_,i)=>`<button>btn${i}</button>`).join('')}</div>${homeHtml}${libraryHtml}${detailHtml}${hidden(1)}${hidden(2)}
${embedded?'':'<script src="/backdrop.js"></script><script src="/transitions.js"></script><script src="/motion.js"></script>'}</body>`;
const routes={'/':{type:'text/html; charset=utf-8',body},'/css/a.css':{type:'text/css',body:sheet(4,900)},'/css/b.css':{type:'text/css',body:sheet(5,900)},
 '/backdrop.js':{path:path.join(repo,'native/homeBackdrop.js')},'/transitions.js':{path:path.join(repo,'native/homeTransitions.js')},'/motion.js':{path:path.join(repo,'native/homeMotion.js')}};
// Card artwork: one deterministic SVG per query, so every card decodes separately.
const proxy=new Proxy(routes,{get(t,k){if(typeof k==='string'&&k.startsWith('/img/'))return {type:'image/png',body:poster([...k].reduce((a,c)=>a*31+c.charCodeAt(0)>>>0,7)%24)};return t[k];}});
withBrowser(proxy,async({evaluate,call})=>{
 if(!process.env.TIGEREST_ANDROID_FIXTURE)await call('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await new Promise(r=>setTimeout(r,800));
 await evaluate(`(async()=>{
  document.body.classList.add('tg-home-active');
  window.state={params:{},contextPath:'/home'};
  window.show=name=>{document.querySelectorAll('.page').forEach(n=>n.classList.toggle('hide',n.id!==name));document.body.classList.toggle('tg-home-active',name==='home');state.params=name==='detail'?{id:'w3'}:name==='library'?{topParentId:'lib0'}:{};state.contextPath='/'+name;};
  window.routeDelay=150;window.route=name=>new Promise(r=>setTimeout(()=>{navigateLog.push(performance.now());show(name);r();},routeDelay));window.navigateLog=[];
  window.gallery={active:true,root:document.querySelector('.tg-home')};
  document.querySelectorAll('.itemsContainer').forEach(list=>list.getItemFromElement=el=>({Id:el.closest('.card').dataset.id,Type:'Movie'}));
  await Promise.all(Array.from(document.images).filter(i=>!i.complete&&i.loading!=='lazy').map(i=>new Promise(r=>{i.onload=i.onerror=r;})));
  window.measure=async(start)=>{
    const loaf=[],t0=performance.now();navigateLog=[];
    const loafSupported=PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame'),po=new PerformanceObserver(l=>loaf.push(...l.getEntries()));if(loafSupported)po.observe({type:'long-animation-frame'});
    const firstFrame=new Promise(r=>requestAnimationFrame(()=>{const ch=new MessageChannel();ch.port1.onmessage=()=>r(performance.now()-t0);ch.port2.postMessage(0);}));
    const p=start();const syncMs=performance.now()-t0;const firstFrameMs=await firstFrame;await p;
    await new Promise(r=>setTimeout(r,300));po.disconnect();
    const m=TigerestHomeTransitions.last||{};
    const during=loaf.filter(e=>e.startTime>=t0-5);
    return {syncMs,firstFrameMs,navigateMs:navigateLog[0]?navigateLog[0]-t0-routeDelay:null,flightMs:m.posterFlightStartsMs??null,posterMoveMs:m.posterFirstMotionMs??null,totalMs:m.totalMs,cacheHit:m.cacheHit,lightHit:m.lightCacheHit,captureMs:m.backgroundPhases?.[0]?.captureMs??null,
      // Long-animation-frame needs Chromium 123+; older engines report null.
      maxFrameMs:loafSupported?Math.max(0,...during.map(e=>e.duration)):null,longFrames:loafSupported?during.filter(e=>e.duration>50).length:null};
  };
  window.heroBusy=()=>Array.from(document.querySelector('.hero-content').children).map((n,i)=>n.animate([{opacity:0,transform:'translate3d(-52px,30px,0)'},{opacity:1,transform:'none'}],{duration:i===1?760:620,delay:160+i*140,fill:'both'}));
  return true;})()`);
 const scenarios={
  // Home poster -> detail.
  homeDetail:`TigerestHomeTransitions.poster({source:document.querySelector('.tg-cover[data-index="3"] img'),findTarget:()=>document.querySelector('#detail .detailImageContainer-main img'),navigate:()=>route('detail'),direction:'enter'})`,
  // Library poster -> detail.
  libraryDetail:`TigerestHomeTransitions.poster({source:document.querySelector('#library .card[data-id="w3"] img'),findTarget:()=>document.querySelector('#detail .detailImageContainer-main img'),navigate:()=>route('detail'),direction:'enter'})`,
  // Detail -> library return.
  detailReturn:`TigerestHomeTransitions.poster({source:document.querySelector('#detail .detailImageContainer-main img'),findTarget:()=>document.querySelector('#library .card[data-id="w3"] img'),navigate:()=>route('library'),direction:'return'})`,
  homeLibrary:`TigerestHomeTransitions.library({gallery,navigate:()=>route('library').then(()=>{gallery.active=false;})})`,
  libraryHome:`TigerestHomeTransitions.homeReturn({findGallery:()=>gallery,navigate:()=>route('home').then(()=>{gallery.active=true;})})`
 };
 const from={homeDetail:'home',libraryDetail:'library',detailReturn:'detail',homeLibrary:'home',libraryHome:'library'};
 const results={};
 for(const [name,code] of Object.entries(scenarios)){
  for(const mode of ['hit','hoverMiss','coldMiss']){
   // hoverMiss: a hovered home poster restarts the hero text entrance just before the click.
   if(mode==='hoverMiss'&&name!=='homeDetail')continue;
   const rows=[];
   for(let r=0;r<rounds;r++){
    await evaluate(`TigerestHomeTransitions.cancel();show(${JSON.stringify(from[name])});gallery.active=${from[name]==='home'};document.querySelector('.page:not(.hide)').scrollTop=0;true`);
    await new Promise(res=>setTimeout(res,250));
    if(mode==='hit'){const ok=await evaluate('TigerestHomeTransitions.prewarm()');if(!ok)console.warn('prewarm failed',name);}
    else if(mode==='hoverMiss'){await evaluate('TigerestHomeTransitions.prewarm()');await evaluate(`heroBusy();document.querySelector('#hero-title').textContent='hover '+Math.random();true`);await new Promise(res=>setTimeout(res,400));}
    else {await evaluate(`TigerestHomeTransitions.invalidate();true`);}
    rows.push(await evaluate(`measure(()=>${code})`));
   }
   const med=k=>{const v=rows.map(x=>x[k]).filter(x=>typeof x==='number').sort((a,b)=>a-b);return v.length?+v[v.length>>1].toFixed(1):null;};
   results[name+'/'+mode]={sync:med('syncMs'),firstFrame:med('firstFrameMs'),navigate:med('navigateMs'),posterMove:med('posterMoveMs'),flight:med('flightMs'),maxFrame:med('maxFrameMs'),capture:med('captureMs'),longFrames:med('longFrames'),total:med('totalMs'),cacheHit:rows.map(x=>x.cacheHit).join(','),lightHit:rows.map(x=>x.lightHit).join(',')};
  }
 }
 console.table(results);
 // Time from a page change until the bitmap and the DOM snapshot are ready.
 for(const page of ['library','home'])for(let i=0;i<3;i++){const r=await evaluate(`(async()=>{TigerestHomeTransitions.cancel();show('${page}');gallery.active=${page==='home'};await new Promise(r=>setTimeout(r,0));TigerestHomeTransitions.invalidate();const t0=performance.now();let ready=null,snap=null;while(performance.now()-t0<4000){const s=TigerestHomeTransitions.cacheState;if(s.ready&&ready===null)ready=performance.now()-t0;if((s.snapshot||(s.snapshot===undefined&&s.ready&&!s.warming))&&snap===null)snap=performance.now()-t0;if(ready!==null&&snap!==null)break;await new Promise(r=>setTimeout(r,5));}return {page:'${page}',bitmapReadyMs:ready,snapshotReadyMs:snap};})()`);console.log(JSON.stringify(r));}
 console.log(JSON.stringify(results));
},{gpu:true,visible:true}).catch(e=>{console.error(e);process.exitCode=1;});
