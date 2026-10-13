const assert=require('node:assert/strict'),path=require('node:path'),withBrowser=require('./community_browser.cjs');
const root=path.resolve(__dirname,'..'),embedded=process.argv.includes('--webengine')||!!process.env.TIGEREST_ANDROID_FIXTURE;
const routes={
 '/':{type:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#101722}.page{position:fixed;inset:0;padding:40px;background:#17263a}.hide{display:none}img{width:120px;height:180px}.detailImageContainer{width:240px;height:360px;margin-left:200px;background:url(/poster.svg) center/cover}</style><div id="library" class="page view-tv-tv"><h1>媒体夹</h1><div class="itemsContainer"><div class="card"><div class="cardImageContainer"><img class="cardImage" src="/poster.svg"></div></div></div></div><div id="detail" class="page hide"><div class="detailImageContainer"></div></div>'+ (embedded?'':'<script src="/transitions.js"></script><script src="/motion.js"></script>')},
 '/poster.svg':{type:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720"><rect width="480" height="720" fill="#7d643d"/></svg>'},
 '/transitions.js':{path:path.join(root,'native/homeTransitions.js')},'/motion.js':{path:path.join(root,'native/homeMotion.js')}
};
routes['/backdrop.js']={path:path.join(root,'native/homeBackdrop.js')};if(!embedded)routes['/'].body=routes['/'].body.replace('<script src="/transitions.js">','<script src="/backdrop.js"></script><script src="/transitions.js">');
// A slow stylesheet, and one that loads once and then fails, both uncached so
// every frozen copy of the page has to fetch them again.
routes['/slow.css']={type:'text/css',body:'.slow-styled{outline:1px solid #f00}',delay:120,headers:{'Cache-Control':'no-store'}};
let flakyServed=0;Object.defineProperty(routes,'/flaky.css',{enumerable:true,get:()=>flakyServed++?undefined:{type:'text/css',body:'.flaky-styled{outline:1px solid #0f0}',headers:{'Cache-Control':'no-store'}}});
withBrowser(routes,async({evaluate,call,url})=>{
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 assert.equal(await evaluate('typeof TigerestHomeTransitions.prewarm'),'function','current page can prewarm the expensive background');
 await evaluate(`window.motionFrame=predicate=>new Promise((resolve,reject)=>{const deadline=performance.now()+8000;const observe=()=>{const result=predicate();if(result)return resolve(result);if(performance.now()>deadline)return reject(Error('motion phase was not observed'));requestAnimationFrame(observe);};requestAnimationFrame(observe);});window.state={params:{topParentId:'library'},contextPath:'/tv?topParentId=library'};window.libraryRoot=document.querySelector('#library');libraryRoot.querySelector('.itemsContainer').getItemFromElement=()=>({Id:'work',Type:'Movie'});window.show=name=>{document.querySelectorAll('.page').forEach(n=>n.classList.toggle('hide',n.id!==name));state.contextPath=name==='detail'?'/item?id=work':'/tv?topParentId=library';state.params=name==='detail'?{id:'work'}:{topParentId:'library'};};window.router={showItem:()=>show('detail'),back:()=>window.returnGate?new Promise(resolve=>{window.releaseReturn=()=>{show('library');resolve();};}):show('library'),goHome:()=>{},getRouteUrl:()=>'/tv?topParentId=library'};TigerestHomeMotion.attach({router,pageJs:{replace:()=>show('library')},manager:{currentApiClient:()=>({serverId:()=> 'fixture',getCurrentUserId:()=> 'one'})},viewManager:{currentViewInfo:()=>state}});`);
 const edgePixels=await evaluate(`(async()=>{const root=document.createElement('div');Object.assign(root.style,{position:'fixed',inset:'0',background:'rgb(40,84,200)'});document.body.append(root);const r=await TigerestHomeBackdrop.build(root,new AbortController().signal),c=document.createElement('canvas');c.width=r.width;c.height=r.height;const ctx=c.getContext('2d');ctx.drawImage(r.bitmap,0,0);const corner=Array.from(ctx.getImageData(0,0,1,1).data),center=Array.from(ctx.getImageData(c.width>>1,c.height>>1,1,1).data);r.bitmap.close();root.remove();return {corner,center};})()`);
 assert.deepEqual(edgePixels.corner,[40,84,200,255],'blur clamps the viewport edges instead of revealing a different page through alpha');
 assert.deepEqual(edgePixels.center,[40,84,200,255]);
 assert.equal(await evaluate('TigerestHomeTransitions.prewarm()'),true);
 // A completed page entrance must stay completed in the frozen background.
 // Emby's important animation rule otherwise starts again inside the shadow tree.
 await evaluate(`document.body.classList.add('skinBody');const s=document.createElement('style');s.textContent='.skinBody .page.motion-enter{animation:fixturePageEnter 160ms both!important}@keyframes fixturePageEnter{from{transform:translateY(72px)}to{transform:none}}';document.head.append(s);libraryRoot.classList.add('motion-enter');true`);
 await evaluate('Promise.all(libraryRoot.getAnimations().map(a=>a.finished))');await evaluate('TigerestHomeTransitions.prewarm()');
 const frozenGeometry=await evaluate(`(()=>{const live=libraryRoot.querySelector('img').getBoundingClientRect(),copy=document.querySelector('.tigerest-motion-cache').firstElementChild.shadowRoot.querySelector('#library img').getBoundingClientRect();return {live:live.toJSON(),copy:copy.toJSON()}})()`);
 assert.ok(Math.max(...['x','y','width','height'].map(k=>Math.abs(frozenGeometry.live[k]-frozenGeometry.copy[k])))<1,'frozen background stays aligned with the live poster at the first frame: '+JSON.stringify(frozenGeometry));
 await evaluate(`TigerestHomeTransitions.invalidate(false);window.titleEntrance=document.querySelector('#library h1').animate([{opacity:0,transform:'translateX(-52px)'},{opacity:1,transform:'none'}],{duration:180,fill:'both'});true`);
 await evaluate('TigerestHomeTransitions.prewarm()');await evaluate('titleEntrance.finished');
 assert.equal(await evaluate(`getComputedStyle(document.querySelector('.tigerest-motion-cache').firstElementChild.shadowRoot.querySelector('h1')).opacity`),'1','prewarming waits for the real entrance rather than caching its hidden first frame');
 await evaluate('libraryRoot.className=libraryRoot.className;true');
 assert.equal(await evaluate('TigerestHomeTransitions.cacheState.ready'),true,'writing an unchanged CSS class cannot discard the prewarmed scene');
 assert.ok(await evaluate('TigerestHomeTransitions.cacheState.ready&&TigerestHomeTransitions.cacheState.bytes<=240*innerHeight/innerWidth*240*4+1000'));
 const hotClickOpacity=await evaluate(`window.press=()=>document.querySelector('#library img').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));press();window.pending=router.showItem('work');({copies:document.querySelectorAll('.tigerest-motion-layer .tigerest-motion-frozen').length,canvas:!!document.querySelector('.tigerest-motion-veil canvas'),lens:!!document.querySelector('.tigerest-motion-lens')})`);
 assert.deepEqual(hotClickOpacity,{copies:0,canvas:true,lens:false},'a cached small background is the only page surface on the click frame');
 await evaluate('pending');
 const hot=await evaluate('TigerestHomeTransitions.last');assert.equal(hot.kind,'poster','poster clicks in a directly opened library use the shared transition');assert.equal(hot.cacheHit,true);assert.equal(hot.domCopies,0,'neither the old nor the new page is copied for a poster transition');assert.equal(hot.syncRasterMs,0);assert.ok(hot.landingErrorPx<2);
 await evaluate('TigerestHomeTransitions.prewarm()');
 const returnClickVisibility=await evaluate(`window.returnGate=true;window.returning=router.back();window.returnShrinkFrame=motionFrame(()=>{const n=document.querySelector('.tigerest-motion-poster');return n&&n.getBoundingClientRect().width<239.9;});getComputedStyle(document.querySelector('#detail .detailImageContainer')).visibility`);
 assert.equal(returnClickVisibility,'hidden','CSS-background posters are hidden under their moving copy');
 assert.ok(await evaluate('returnShrinkFrame'),'returning starts by shrinking the detail poster while its destination prepares');
 await evaluate('motionFrame(()=>!!window.releaseReturn)');assert.equal(await evaluate('state.params.id'),'work');
 await evaluate('returnGate=false;releaseReturn();true');
 await evaluate('returning');assert.equal(await evaluate('state.contextPath'),'/tv?topParentId=library');
 // A prewarm still waiting for a long page entrance must not hold the route:
 // the click rasters the current frame instead of awaiting that entrance.
 await evaluate(`TigerestHomeTransitions.invalidate(false);window.longEntrance=document.querySelector('#library h1').animate([{opacity:.5},{opacity:1}],{duration:2000});TigerestHomeTransitions.prewarm();true`);
 const settleRoute=await evaluate(`(()=>{press();const start=performance.now();window.settlePending=router.showItem('work');return motionFrame(()=>state.params.id==='work'?performance.now()-start:null);})()`);
 assert.ok(settleRoute<1200,'navigation is not held behind the 2s entrance: '+settleRoute);
 await evaluate('settlePending');await evaluate('longEntrance.cancel();router.back()');
 // A return home promotes the prepared offscreen copy instead of re-attaching it.
 await evaluate('TigerestHomeTransitions.prewarm()');
 const promoted=await evaluate(`(()=>{const wrapper=document.querySelector('.tigerest-motion-cache');window.homeGallery={active:false,root:document.createElement('div')};window.promotedReturn=TigerestHomeTransitions.homeReturn({findGallery:()=>homeGallery,navigate:()=>{homeGallery.active=true;homeGallery.root.classList.add('tg-entered');}});return {same:!!wrapper&&document.querySelector('.tigerest-motion-layer')===wrapper,connected:!!wrapper?.isConnected,background:wrapper&&getComputedStyle(wrapper).backgroundColor};})()`);
 assert.deepEqual(promoted,{same:true,connected:true,background:'rgb(11, 13, 18)'},'the snapshot wrapper becomes the opaque return cover in place');
 await evaluate('promotedReturn');assert.ok(await evaluate('TigerestHomeTransitions.last.lightCacheHit===true&&TigerestHomeTransitions.last.domCopies===0'));
 assert.equal(await evaluate(`document.querySelectorAll('.tigerest-motion-layer,.tigerest-motion-cache').length`),0);
 await evaluate('TigerestHomeTransitions.prewarm()');
 await evaluate(`document.querySelector('#library h1').textContent='另一媒体夹';true`);
 assert.equal(await evaluate('TigerestHomeTransitions.cacheState.ready'),false,'content changes invalidate the previous background');
 // The clicked poster is excluded from the backdrop. Supply another visible
 // image so this test really holds a source-background decode.
 await evaluate(`new Promise((resolve,reject)=>{const img=document.createElement('img');img.id='cold-backdrop-image';Object.assign(img.style,{position:'fixed',right:'20px',top:'20px'});img.onload=resolve;img.onerror=reject;img.src='/poster.svg';libraryRoot.append(img);})`);
 // Hold actual decoding until motion is observed. The observer runs in the
 // browser, so CDP delivery and runner scheduling cannot miss the click phase.
 const firstPosterFrame=await evaluate(`(()=>{window.originalBitmap=createImageBitmap;window.coldDecoders=[];window.createImageBitmap=(...args)=>new Promise(resolve=>coldDecoders.push(()=>originalBitmap(...args).then(resolve)));TigerestHomeTransitions.invalidate();window.clickedPosterRect=libraryRoot.querySelector('img').getBoundingClientRect().toJSON();press();window.coldStart=performance.now();window.cold=router.showItem('work');window.coldStarted=motionFrame(()=>{const n=document.querySelector('.tigerest-motion-lens'),veil=document.querySelector('.tigerest-motion-veil'),p=document.querySelector('.tigerest-motion-poster'),rect=p?.getBoundingClientRect();const moved=rect&&Math.max(...['x','y','width','height'].map(k=>Math.abs(rect[k]-clickedPosterRect[k])))>.25;return n&&+getComputedStyle(n).opacity>0&&moved&&coldDecoders.length?{present:true,opacity:+getComputedStyle(n).opacity,veil:+getComputedStyle(veil).opacity,copies:document.querySelectorAll('.tigerest-motion-veil .tigerest-motion-frozen').length,covered:!!document.querySelector('.tigerest-motion-freeze'),poster:rect.toJSON(),elapsedMs:performance.now()-coldStart}:null;});return document.querySelector('.tigerest-motion-poster').getBoundingClientRect().toJSON()})()`);
 const clickedPoster=await evaluate('clickedPosterRect');
 assert.ok(Math.max(...['x','y','width','height'].map(k=>Math.abs(firstPosterFrame[k]-clickedPoster[k])))<1,'the floating poster starts exactly at the clicked poster');
 const started=await evaluate('coldStarted');
 assert.ok(started.present&&started.opacity>0&&started.covered,'cold background preparation does not prevent the animation from starting, and a freeze frame keeps the old page on screen: '+JSON.stringify(started));
 assert.ok(started.veil===0&&started.copies===0,'a cold click blurs through a lens rather than a blurred copy, and keeps the dark veil until the raster covers it: '+JSON.stringify(started));
 const earlyPoster=started.poster;
 assert.ok(Math.abs(earlyPoster.width-clickedPoster.width)>.25||Math.abs(earlyPoster.x-clickedPoster.x)>.25||Math.abs(earlyPoster.y-clickedPoster.y)>.25,'the poster itself moves promptly while the cold background is still preparing');
 await evaluate('window.createImageBitmap=originalBitmap;Promise.all(coldDecoders.map(release=>release()))');
 await evaluate('cold');assert.equal(await evaluate('TigerestHomeTransitions.last.syncRasterMs'),0);await evaluate('router.back()');await evaluate(`document.querySelector('#cold-backdrop-image').remove();TigerestHomeTransitions.prewarm()`);
 // A slow destination image decode must not hold the poster, keep the
 // revealed page locked or attach a late canvas; the destination uses a lens.
 await evaluate(`new Promise(resolve=>{const img=document.createElement('img');img.id='slow-detail-image';Object.assign(img.style,{position:'fixed',right:'30px',bottom:'30px'});img.onload=resolve;img.src='/poster.svg';document.querySelector('#detail').append(img);})`);
 await evaluate('TigerestHomeTransitions.prewarm()');
 await evaluate(`window.destinationDecoders=[];window.createImageBitmap=(node,...args)=>node.closest?.('#detail')?new Promise(resolve=>destinationDecoders.push(()=>originalBitmap(node,...args).then(resolve))):originalBitmap(node,...args);press();window.slowDestination=router.showItem('work');true`);
 await evaluate('slowDestination');assert.equal(await evaluate('destinationDecoders.length'),0,'the destination is blurred live; its images are never decoded for the transition');
 assert.equal(await evaluate('TigerestHomeTransitions.busy'),false,'a late destination bitmap cannot keep the finished page locked');
 assert.equal(await evaluate(`document.querySelectorAll('.tigerest-motion-layer,.tigerest-motion-poster,[data-tigerest-poster-held]').length`),0);
 await evaluate('window.createImageBitmap=originalBitmap;Promise.all(destinationDecoders.map(release=>release())).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
 assert.equal(await evaluate(`document.querySelectorAll('.tigerest-motion-layer,.tigerest-motion-poster').length`),0,'late background results stay detached after completion');
 await evaluate(`window.createImageBitmap=originalBitmap;document.querySelector('#slow-detail-image').remove();router.back()`);
 // A different host is deliberately served without CORS. Android's appasset
 // posters have the same origin-clean restriction and cannot cross a worker.
 const foreign=new URL('/poster.svg',url);foreign.hostname=foreign.hostname==='127.0.0.1'?'localhost':'127.0.0.1';
 await evaluate(`new Promise((resolve,reject)=>{const img=document.querySelector('#library img');img.onload=()=>resolve(true);img.onerror=()=>reject(Error('foreign fixture image'));img.src=${JSON.stringify(foreign.href)};})`);
 assert.equal(await evaluate('TigerestHomeTransitions.prewarm()'),true,'cross-origin posters still produce a cached small background');
 await evaluate('press();window.foreignEntry=router.showItem("work");true');await evaluate('foreignEntry');
 const foreignMetric=await evaluate('TigerestHomeTransitions.last');assert.equal(foreignMetric.cacheHit,true);assert.equal(foreignMetric.backgroundPhases[0].rasterThread,'main-small');await evaluate('router.back()');
 await evaluate(`TigerestHomeTransitions.invalidate(false);window.savedWorker=Worker;window.Worker=undefined;window.noRaster=TigerestHomeTransitions.poster({source:libraryRoot.querySelector('img'),findTarget:()=>document.querySelector('#detail .detailImageContainer'),navigate:()=>new Promise(resolve=>{window.releaseNoRaster=()=>{show('detail');resolve();};})});true`);
 await evaluate(`motionFrame(()=>{const n=document.querySelector('.tigerest-motion-veil');return window.releaseNoRaster&&n&&+getComputedStyle(n).opacity>.99;})`);
 assert.ok(await evaluate(`(()=>{const n=document.querySelector('.tigerest-motion-veil');return +getComputedStyle(n).opacity>.99&&getComputedStyle(n).backgroundColor==='rgb(11, 13, 18)'})()`),'the DOM fallback covers its blur borders before the real route changes');
 assert.equal(await evaluate('state.params.topParentId'),'library');
 await evaluate('releaseNoRaster();true');await evaluate(`noRaster.then(()=>{window.Worker=savedWorker;show('library')})`);
 // Off-screen list cards are size-holding placeholders in the frozen page;
 // visible cards keep their exact positions after the list has scrolled,
 // including fractional card sizes that rounding would accumulate.
 await evaluate(`window.listCards=Array.from({length:60},(_,i)=>{const c=document.createElement('div');c.className='card extra-card';c.style.cssText='display:inline-block;vertical-align:top;width:90.4px;height:140.4px;margin:4px';c.innerHTML='<div class="cardImageContainer"><img class="cardImage" style="width:90px;height:130px" src="/poster.svg"></div>';return c;});libraryRoot.querySelector('.itemsContainer').prepend(...listCards);libraryRoot.style.overflow='auto';libraryRoot.scrollTop=600;Promise.all(listCards.map(c=>c.querySelector('img').decode().catch(()=>{}))).then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))`);
 // Late image loads, the scroll event or the client's pending page entrance can
 // invalidate or defer a prewarm; retry until the snapshot is settled.
 await evaluate(`(async()=>{for(let i=0;i<30&&!TigerestHomeTransitions.cacheState.snapshot;i++)if(!await TigerestHomeTransitions.prewarm())await new Promise(r=>setTimeout(r,100));return TigerestHomeTransitions.cacheState.snapshot;})()`);
 const pruned=await evaluate(`(()=>{const copies=Array.from(document.querySelector('.tigerest-motion-cache').firstElementChild.shadowRoot.querySelectorAll('.extra-card'));const inView=listCards.findIndex(c=>{const r=c.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;});if(inView<0)return {inView};const live=listCards[inView].querySelector('img').getBoundingClientRect(),copy=copies[inView].querySelector('img')?.getBoundingClientRect();return {count:copies.length,aboveEmpty:copies[0].childElementCount===0,aboveSize:Math.abs(copies[0].getBoundingClientRect().height-listCards[0].getBoundingClientRect().height),offset:copy?Math.max(...['x','y','width','height'].map(k=>Math.abs(live[k]-copy[k]))):null};})()`);
 assert.ok(pruned.count===60&&pruned.aboveEmpty&&pruned.aboveSize<1&&pruned.offset!==null&&pruned.offset<1,'off-screen cards hold their size and visible cards stay aligned: '+JSON.stringify(pruned));
 await evaluate(`listCards.forEach(c=>c.remove());libraryRoot.scrollTop=0;libraryRoot.style.overflow='';new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
 // A visible frozen copy must never be missing a copied stylesheet.
 await evaluate(`window.unstyledFrames=0;window.watchStyles=true;(function watch(){for(const host of document.querySelectorAll('.tigerest-motion-frozen')){const layer=host.closest('.tigerest-motion-layer');if(layer&&getComputedStyle(layer).opacity!=='0'&&getComputedStyle(host).opacity!=='0'&&Array.from(host.shadowRoot.querySelectorAll('link[rel="stylesheet"]')).some(l=>!l.sheet))unstyledFrames++;}if(watchStyles)requestAnimationFrame(watch);})();window.addSheet=href=>new Promise((resolve,reject)=>{const l=document.createElement('link');l.rel='stylesheet';l.href=href;l.onload=()=>resolve(true);l.onerror=()=>reject(Error(href));document.head.append(l);window[href.includes('slow')?'slowLink':'flakyLink']=l;});window.homeStub={active:false,root:document.createElement('div')};window.toHome=()=>TigerestHomeTransitions.homeReturn({findGallery:()=>homeStub,navigate:()=>{homeStub.active=true;homeStub.root.classList.add('tg-entered');}}).then(()=>{homeStub.active=false;homeStub.root.classList.remove('tg-entered');});window.toDetail=()=>{window.atRoute=null;return TigerestHomeTransitions.poster({source:libraryRoot.querySelector('img'),findTarget:()=>document.querySelector('#detail .detailImageContainer'),navigate:()=>{const freeze=document.querySelector('.tigerest-motion-freeze .tigerest-motion-frozen');window.atRoute={freeze:!!freeze,styled:!!freeze&&Array.from(freeze.shadowRoot.querySelectorAll('link[rel="stylesheet"]')).every(l=>l.sheet),veil:+getComputedStyle(document.querySelector('.tigerest-motion-veil')).opacity};show('detail');}}).then(()=>show('library'));};true`);
 // Slow sheet: fresh copies stay hidden until it loads, then are used.
 await evaluate(`addSheet('/slow.css')`);
 await evaluate('TigerestHomeTransitions.invalidate(false);toDetail()');
 const slowRoute=await evaluate('atRoute');
 assert.ok(slowRoute.freeze&&slowRoute.styled&&slowRoute.veil<.99,'a fresh freeze frame waits for a slow copied sheet, then the route still starts mid-fade: '+JSON.stringify(slowRoute));
 await evaluate('TigerestHomeTransitions.invalidate(false);toHome()');
 assert.ok(await evaluate(`TigerestHomeTransitions.last.lightCacheHit===false&&!TigerestHomeTransitions.last.copy&&!TigerestHomeTransitions.last.fallback`),'a fresh home-return copy is shown once its slow sheet loads');
 // Failing sheet: a copy whose stylesheet errors is never offered or shown.
 await evaluate(`addSheet('/flaky.css')`);
 await evaluate('TigerestHomeTransitions.invalidate(false);TigerestHomeTransitions.prewarm()');
 assert.deepEqual(await evaluate('({ready:TigerestHomeTransitions.cacheState.ready,snapshot:TigerestHomeTransitions.cacheState.snapshot})'),{ready:true,snapshot:false},'a snapshot whose copied sheet fails to load is never offered');
 await evaluate('toDetail()');
 const flakyRoute=await evaluate('({atRoute,freeze:TigerestHomeTransitions.last.freeze})');
 assert.ok(flakyRoute.freeze==='late'&&!flakyRoute.atRoute.freeze&&flakyRoute.atRoute.veil>.99,'a failed copied sheet counts as not ready; the route waits for the opaque veil: '+JSON.stringify(flakyRoute));
 await evaluate('TigerestHomeTransitions.invalidate(false);toHome()');
 assert.equal(await evaluate('TigerestHomeTransitions.last.copy'),'unstyled','home return falls back to a plain fade instead of an unstyled copy');
 await evaluate('watchStyles=false;slowLink.remove();flakyLink.remove();true');
 assert.equal(await evaluate('unstyledFrames'),0,'no frame showed a frozen copy with a missing stylesheet');
 await evaluate('TigerestHomeMotion.reset()');assert.equal(await evaluate('TigerestHomeTransitions.cacheState.ready'),false,'account reset releases the cached background');
 await evaluate('TigerestHomeTransitions.prewarm()');await call('Emulation.setDeviceMetricsOverride',{width:900,height:700,deviceScaleFactor:1,mobile:false});assert.equal(await evaluate('TigerestHomeTransitions.cacheState.ready'),false,'viewport changes cannot use the old background');
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});assert.equal(await evaluate('TigerestHomeTransitions.prewarm()'),false);assert.equal(await evaluate('TigerestHomeTransitions.cacheState.bytes'),0);
 console.log('async background/cache fixture:',JSON.stringify({checks:37,hot,started,foreignMetric}));
},{gpu:true,visible:true}).catch(e=>{console.error(e);process.exitCode=1});
