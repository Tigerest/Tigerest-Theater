const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),withBrowser=require('./community_browser.cjs');
const root=path.resolve(__dirname,'..'),renderer=path.join(root,'native/homeTransitions.js');
const embedded=process.argv.includes('--webengine')||Boolean(process.env.TIGEREST_ANDROID_FIXTURE);
assert.ok(fs.existsSync(renderer),'production transition renderer exists');
const routes={
 '/':{type:'text/html',body:`<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="http://localhost:PORT/theme.css"><style>body{margin:0;background:#101722;color:white;font:18px sans-serif}.page{position:fixed;inset:0;padding:60px;box-sizing:border-box;background:linear-gradient(120deg,#34495c,#101722)}.hide{display:none}.cardImage{width:100px;height:150px;object-fit:cover}.detailImageContainer{width:200px;height:300px;margin:70px 0 0 80px;background-size:cover}h1{margin:30px 0}</style><div class="page" id="home"><h1>首页</h1><img id="source" class="cardImage" src="/poster.svg"></div><div class="page hide" id="detail"><div class="detailImageContainer" style="background-image:url('/poster.svg')"></div><h1>作品详情</h1></div><div class="page hide" id="library"><h1>媒体夹</h1><div data-id="work"><img class="cardImage" src="/poster.svg"></div></div><script src="/transitions.js"></script><script src="/motion.js"></script>`},
 '/theme.css':{type:'text/css',body:'h1{color:rgb(227,194,143)}'},
 '/poster.svg':{type:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720"><rect width="480" height="720" fill="#856633"/><circle cx="240" cy="280" r="140" fill="#c5b185"/></svg>'},
 '/transitions.js':{path:renderer},'/motion.js':{path:path.join(root,'native/homeMotion.js')}
};
// localhost and 127.0.0.1 are different origins. CSSOM access must not be needed.
routes['/'].body=routes['/'].body.replace('http://localhost:PORT/theme.css','/theme.css');
if(embedded)routes['/'].body=routes['/'].body.replace('<script src="/transitions.js"></script><script src="/motion.js"></script>','');
routes['/backdrop.js']={path:path.join(root,'native/homeBackdrop.js')};if(!embedded)routes['/'].body=routes['/'].body.replace('<script src="/transitions.js">','<script src="/backdrop.js"></script><script src="/transitions.js">');
withBrowser(routes,async({evaluate,call,url})=>{
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await evaluate(`document.querySelector('link').href=${JSON.stringify(url.replace('127.0.0.1','localhost')+'/theme.css')}`);
 await evaluate(`window.fixture={state:{params:{},contextPath:'/home'},show(name){document.querySelectorAll('.page').forEach(p=>p.classList.toggle('hide',p.id!==name));this.state.params=name==='detail'?{id:'work'}:{};this.state.contextPath='/'+name;},async route(name,delay=0){await new Promise(r=>setTimeout(r,delay));this.show(name);}};window.router={showItem:()=>fixture.route('detail'),back:()=>fixture.route('home'),goHome:()=>fixture.route('home'),getRouteUrl:()=>'/library'};TigerestHomeMotion.attach({router,pageJs:{replace:()=>fixture.route('library')},manager:{currentApiClient:()=>({serverId:()=> 'fixture',getCurrentUserId:()=> 'user'})},viewManager:{currentViewInfo:()=>fixture.state}});`);
 await evaluate(`const hidden=document.createElement('div');hidden.className='detailImageContainer hide';document.querySelector('#detail').prepend(hidden);`);
 await evaluate(`const card=document.querySelector('#library [data-id]');card.removeAttribute('data-id');card.className='card';const list=document.createElement('div');list.className='virtualItemsContainer itemsContainer';card.replaceWith(list);list.append(card);list._itemSource=Array(80);list.indexOfItemId=()=>-1;list.getItemFromElement=()=>list.mounted?{Id:'grouped-work',Type:'Movie'}:null;list.fetchItems=async(q,signal)=>{window.indexQuery=q;return {Items:Array.from({length:80},(_,i)=>({Id:i===61?'grouped-work':'other-'+i,PresentationUniqueKey:i===61?'same-work':null}))}};list.scrollToIndex=index=>{list.mounted=index===61;};`);
 const begin=(holdRoute=false)=>evaluate(`window.pending=TigerestHomeMotion.openItem({card:{item:{Id:'work',Type:'Movie',PresentationUniqueKey:'same-work'}},library:{Id:'library',Type:'CollectionFolder'},source:document.querySelector('#source'),navigate:()=>${holdRoute ? `new Promise(resolve=>{const freeze=document.querySelector('.tigerest-motion-freeze');fixture.atRoute={freeze:!!freeze&&getComputedStyle(freeze).opacity==='1',veil:+getComputedStyle(document.querySelector('.tigerest-motion-veil')).opacity};fixture.releaseDetail=()=>fixture.route('detail',450).then(resolve);})` : `fixture.route('detail',450)`}});true`);
 // Keep the slow route pending until inspected. A wall-clock sample can arrive
 // after navigation on a loaded runner and confuse that with a missing veil.
 await begin(true);
 assert.equal(await evaluate('TigerestHomeTransitions.busy'),true);
 await evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+8000;const poll=()=>{if(fixture.releaseDetail)return resolve();if(performance.now()>deadline)return reject(Error('poster never reached navigation'));setTimeout(poll,16);};poll();})`);
 // The route starts during the fade, behind a crisp freeze frame of the old page.
 const atRoute=await evaluate('fixture.atRoute');
 assert.ok(atRoute.freeze&&atRoute.veil<.99,'the real route starts while the veil is still fading in, behind a freeze frame: '+JSON.stringify(atRoute));
 await evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+8000;const poll=()=>{if(+getComputedStyle(document.querySelector('.tigerest-motion-veil')).opacity>.99)return resolve();if(performance.now()>deadline)return reject(Error('veil never became opaque'));requestAnimationFrame(poll);};poll();})`);
 const waiting=await evaluate(`({busy:TigerestHomeTransitions.busy,veil:+getComputedStyle(document.querySelector('.tigerest-motion-veil')).opacity,poster:!!document.querySelector('.tigerest-motion-poster'),old:!document.querySelector('#home').classList.contains('hide')})`);
 assert.ok(waiting.busy&&waiting.poster&&waiting.veil>.99&&waiting.old,'blur becomes opaque and stays while the real route loads: '+JSON.stringify(waiting));
 // Change the responsive target after its flight starts, rather than relying
 // on a timer measured from an earlier CDP command.
 await evaluate(`fixture.resizedDuringFlight=false;const target=document.querySelector('#detail .detailImageContainer:not(.hide)');const deadline=performance.now()+8000;const resize=()=>{if(target.hasAttribute('data-tigerest-poster-held')){target.style.width='240px';target.style.height='360px';fixture.resizedDuringFlight=true;}else if(performance.now()<deadline)requestAnimationFrame(resize);};requestAnimationFrame(resize);fixture.releaseDetail();true`);
 await evaluate('pending');
 const landed=await evaluate(`({metric:TigerestHomeTransitions.last,leaks:document.querySelectorAll('.tigerest-motion-layer,[data-tigerest-poster-held]').length,busy:TigerestHomeTransitions.busy,detail:!document.querySelector('#detail').classList.contains('hide')})`);
 assert.ok(landed.detail&&!landed.busy&&landed.leaks===0);assert.ok(landed.metric.landingErrorPx<2,'poster meets the actual background-image detail poster');assert.ok(landed.metric.surfaces.every(s=>s.width<=240));
 assert.equal(await evaluate('fixture.resizedDuringFlight'),true,'responsive target changed during the poster flight');
 await evaluate('router.back()');assert.equal(await evaluate('fixture.state.contextPath'),'/library');
 assert.ok(await evaluate('TigerestHomeTransitions.last.landingErrorPx<2&&indexQuery.EnableImages===false'),'return locates the work through the real virtual-list API');
 await evaluate('router.back()');assert.equal(await evaluate('fixture.state.contextPath'),'/home');
 const returnBackground=await evaluate(`fixture.show('library');window.returnGallery={active:false,root:document.querySelector('#home')};window.returning=TigerestHomeTransitions.homeReturn({findGallery:()=>returnGallery,navigate:()=>{fixture.show('home');returnGallery.active=true;returnGallery.root.classList.add('tg-entered');}});getComputedStyle(document.querySelector('.tigerest-motion-layer')).backgroundColor`);
 assert.equal(returnBackground,'rgb(11, 13, 18)','the shrinking return copy must cover the stationary real page');
 await evaluate('returning');
 await evaluate(`window.failure=TigerestHomeMotion.openItem({card:{item:{Id:'work'}},library:{Id:'library'},source:document.querySelector('#source'),navigate:async()=>{throw Error('fixture offline');}}).then(()=>false,()=>true)`);
 assert.equal(await evaluate('failure'),true);assert.equal(await evaluate('TigerestHomeTransitions.busy||!!document.querySelector(".tigerest-motion-layer")'),false);
 await begin();await call('Emulation.setDeviceMetricsOverride',{width:900,height:700,deviceScaleFactor:1,mobile:false});await evaluate('pending');
 assert.equal(await evaluate('TigerestHomeTransitions.busy||!!document.querySelector(".tigerest-motion-layer")'),false,'resize releases all effects');
 await evaluate(`fixture.show('home');window.missing=TigerestHomeTransitions.poster({source:null,findTarget:()=>null,navigate:()=>fixture.route('detail')})`);await evaluate('missing');
 assert.equal(await evaluate('fixture.state.contextPath'),'/detail');assert.equal(await evaluate('TigerestHomeTransitions.busy'),false);
 await evaluate(`fixture.show('home');window.cancelledRoute=false;window.cancelled=TigerestHomeTransitions.poster({source:document.querySelector('#source'),findTarget:()=>document.querySelector('.detailImageContainer'),navigate:()=>{cancelledRoute=true;return fixture.route('detail');}});TigerestHomeMotion.reset();true`);await evaluate('cancelled');
 assert.equal(await evaluate('cancelledRoute'),false,'logout/reset during outgoing must not run the old route');
 // Home -> library flies the parts of a crisp home copy that covers the real
 // home, so the library route starts during the fly-out rather than after it.
 const flyOut=await evaluate(`fixture.show('home');const homePage=document.querySelector('#home');window.liveParts=['nav','rail','stage'].map(n=>{const e=document.createElement('div');e.className='tg-home-'+n;e.textContent=n;homePage.append(e);return e;});window.flyGallery={active:true,root:homePage};window.flyRoute=null;window.flyLibrary=TigerestHomeTransitions.library({gallery:flyGallery,navigate:()=>{const copy=document.querySelector('.tigerest-motion-layer .tigerest-motion-frozen');window.flyRoute={during:!!copy&&!!copy.shadowRoot.querySelector('.tg-home-nav')?.getAnimations().some(a=>a.playState==='running')};flyGallery.active=false;return fixture.route('library');}});({live:liveParts.some(p=>p.getAnimations().length>0),cover:getComputedStyle(document.querySelector('.tigerest-motion-layer')).backgroundColor})`);
 assert.deepEqual(flyOut,{live:false,cover:'rgb(11, 13, 18)'},'the real home is covered by its copy and not animated');
 await evaluate('flyLibrary');
 assert.equal(await evaluate('!!(flyRoute&&flyRoute.during)'),true,'the library route starts while the home copy is still flying out');
 assert.ok(await evaluate(`TigerestHomeTransitions.last.kind==='library'&&!TigerestHomeTransitions.last.interrupted&&!document.querySelector('.tigerest-motion-layer')`),'fly-out effects are released after the incoming page');
 await evaluate('liveParts.forEach(p=>p.remove());true');
 // Returning home starts the route under the shrinking cover. A gallery
 // entrance that begins while still covered is paused, then resumes on reveal.
 await evaluate(`fixture.show('library');window.entryGallery={active:false,root:document.querySelector('#home'),animations:[]};window.entryStates=new Set();window.entryReturn=TigerestHomeTransitions.homeReturn({findGallery:()=>entryGallery,navigate:()=>{fixture.show('home');entryGallery.active=true;const a=document.querySelector('#home h1').animate([{opacity:.2},{opacity:1}],{duration:600});a.createdAt=performance.now();entryGallery.animations=[a];setTimeout(()=>entryGallery.root.classList.add('tg-entered'),20);}});(function sample(){const a=entryGallery.animations[0];if(a&&document.querySelector('.tigerest-motion-layer'))entryStates.add(a.playState);if(TigerestHomeTransitions.busy)requestAnimationFrame(sample);})();true`);
 const revealedAt=await evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+8000;const poll=()=>{const a=entryGallery.animations[0];if(a&&!document.querySelector('.tigerest-motion-layer'))return resolve({state:a.playState,lag:performance.now()-a.createdAt-a.currentTime});if(performance.now()>deadline)return reject(Error('home was never revealed'));requestAnimationFrame(poll);};poll();})`);
 await evaluate('entryReturn');
 assert.ok(await evaluate(`entryStates.has('paused')`)&&revealedAt.state!=='paused'&&revealedAt.lag>60,'the covered gallery entrance waits and resumes on reveal: '+JSON.stringify(revealedAt));
 await evaluate(`entryGallery.animations[0].cancel();document.querySelector('#home').classList.remove('tg-entered');true`);
 await evaluate(`fixture.show('home');window.tabGallery={active:true};window.tabStart=performance.now();window.tabIncoming=new Promise((resolve,reject)=>{const deadline=performance.now()+8000;const observe=()=>{const n=document.querySelector('.tigerest-motion-frozen');if(n&&getComputedStyle(n).transform!=='none'&&+getComputedStyle(n).opacity>0)return resolve({observed:true,elapsedMs:performance.now()-tabStart});if(performance.now()>deadline)return reject(Error('same-page central incoming animation was not observed'));requestAnimationFrame(observe);};requestAnimationFrame(observe);});window.tab=TigerestHomeTransitions.library({gallery:tabGallery,samePage:true,navigate:()=>{tabGallery.active=false;document.querySelector('#home h1').textContent='收藏';history.replaceState({},'',location.pathname+'?tab=favorites');}});true`);
 assert.equal((await evaluate('tabIncoming')).observed,true,'same-page Favorites uses the central incoming animation');
 await evaluate('tab');assert.ok(await evaluate(`TigerestHomeTransitions.last.kind==='library'&&!TigerestHomeTransitions.last.interrupted`),'Favorites completes the observed incoming animation on the reused page');
 // A detail image that is still loading must not hold the flight back; the
 // poster copy lands and keeps covering it until the image is complete. A
 // slow engine may still move the target after the flight's last read, so
 // the landing is checked after release.
 await evaluate(`fixture.show('home');window.slowTarget=document.createElement('img');slowTarget.src='/poster.svg';slowTarget.style.cssText='width:200px;height:300px;display:block;margin:20px 0 0 80px';document.querySelector('#detail').append(slowTarget);window.artReady=false;Object.defineProperty(slowTarget,'complete',{configurable:true,get:()=>artReady});window.slowRun=TigerestHomeTransitions.poster({source:document.querySelector('#source'),findTarget:()=>slowTarget,navigate:()=>fixture.route('detail')});true`);
 const landedEarly=await evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+8000;const poll=()=>{const p=document.querySelector('.tigerest-motion-poster'),r=p?.getBoundingClientRect(),t=slowTarget.getBoundingClientRect();const settled=p&&Array.from(document.querySelectorAll('.tigerest-motion-poster,.tigerest-motion-veil,.tigerest-motion-lens')).every(n=>n.getAnimations().every(a=>a.playState!=='running'));if(settled&&Math.max(...['x','y','width','height'].map(k=>Math.abs(r[k]-t[k])))<24)return setTimeout(()=>resolve({busy:TigerestHomeTransitions.busy,held:slowTarget.hasAttribute('data-tigerest-poster-held'),poster:!!document.querySelector('.tigerest-motion-poster'),ready:artReady}),100);if(performance.now()>deadline)return reject(Error('poster never landed'));requestAnimationFrame(poll);};poll();})`);
 assert.deepEqual(landedEarly,{busy:true,held:true,poster:true,ready:false},'the poster lands while the target image loads and keeps covering it');
 await evaluate('artReady=true;slowRun');
 const artMetric=await evaluate('TigerestHomeTransitions.last');
 assert.ok(artMetric.artworkWaitMs>artMetric.posterFlightStartsMs+700&&artMetric.landingErrorPx<2,'the image wait follows the completed flight: '+JSON.stringify(artMetric));
 assert.equal(await evaluate(`TigerestHomeTransitions.busy||slowTarget.hasAttribute('data-tigerest-poster-held')||!!document.querySelector('.tigerest-motion-poster')`),false,'the held image and poster copy are released once it is ready');
 await evaluate('slowTarget.remove();true');
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await evaluate(`fixture.show('home');window.reduced=TigerestHomeTransitions.poster({source:document.querySelector('#source'),findTarget:()=>document.querySelector('.detailImageContainer'),navigate:()=>fixture.route('detail')});true`);
 assert.equal(await evaluate('!!document.querySelector(".tigerest-motion-poster,.tigerest-motion-veil")'),false);await evaluate('reduced');
 console.log('production motion fixture:',JSON.stringify({checks:20,landed}));
},{gpu:true,visible:true}).catch(error=>{console.error(error);process.exitCode=1;});
