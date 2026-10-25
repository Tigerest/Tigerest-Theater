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
 const software=await withBrowser.softwareRenderer(evaluate);
 if(software){console.log('SKIP: frame-precise motion needs a hardware GPU ('+software+')');process.exitCode=withBrowser.SKIP_CODE;return;}
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await evaluate(`document.querySelector('link').href=${JSON.stringify(url.replace('127.0.0.1','localhost')+'/theme.css')}`);
 await evaluate(`window.fixture={state:{params:{},contextPath:'/home'},show(name){document.querySelectorAll('.page').forEach(p=>p.classList.toggle('hide',p.id!==name));this.state.params=name==='detail'?{id:'work'}:{};this.state.contextPath='/'+name;},async route(name,delay=0){await new Promise(r=>setTimeout(r,delay));this.show(name);}};window.router={showItem:()=>fixture.route('detail'),back:()=>fixture.route('home'),goHome:()=>fixture.route('home'),getRouteUrl:()=>'/library'};TigerestHomeMotion.attach({router,pageJs:{replace:()=>fixture.route('library')},manager:{currentApiClient:()=>({serverId:()=> 'fixture',getCurrentUserId:()=> 'user'})},viewManager:{currentViewInfo:()=>fixture.state}});`);
 await evaluate(`const hidden=document.createElement('div');hidden.className='detailImageContainer hide';document.querySelector('#detail').prepend(hidden);`);
 await evaluate(`const card=document.querySelector('#library [data-id]');card.removeAttribute('data-id');card.className='card';const list=document.createElement('div');list.className='virtualItemsContainer itemsContainer';card.replaceWith(list);list.append(card);list._itemSource=Array(80);list.indexOfItemId=()=>-1;list.getItemFromElement=()=>list.mounted?{Id:'grouped-work',Type:'Movie'}:null;list.fetchItems=async(q,signal)=>{window.indexQuery=q;return {Items:Array.from({length:80},(_,i)=>({Id:i===61?'grouped-work':'other-'+i,PresentationUniqueKey:i===61?'same-work':null}))}};list.scrollToIndex=index=>{list.mounted=index===61;};`);
 const begin=(holdRoute=false,delay=450,type='Movie')=>evaluate(`window.pending=TigerestHomeMotion.openItem({card:{item:{Id:'work',Type:'${type}',PresentationUniqueKey:'same-work'}},library:{Id:'library',Type:'CollectionFolder'},source:document.querySelector('#source'),navigate:()=>${holdRoute ? `new Promise(resolve=>{fixture.releaseDetail=()=>fixture.route('detail',${delay}).then(resolve);})` : `fixture.route('detail',${delay})`}});true`);
 // Change the responsive target after its flight starts, rather than relying
 // on a timer measured from an earlier CDP command.
 await evaluate(`fixture.resizedDuringFlight=false;const target=document.querySelector('#detail .detailImageContainer:not(.hide)');const deadline=performance.now()+8000;const resize=()=>{if(target.hasAttribute('data-tigerest-poster-held')){target.style.width='240px';target.style.height='360px';fixture.resizedDuringFlight=true;}else if(performance.now()<deadline)requestAnimationFrame(resize);};requestAnimationFrame(resize);true`);
 await begin(false,60);await evaluate('pending');
 const flown=await evaluate(`({metric:TigerestHomeTransitions.last,leaks:document.querySelectorAll('.tigerest-motion-layer,[data-tigerest-poster-held]').length,busy:TigerestHomeTransitions.busy,detail:!document.querySelector('#detail').classList.contains('hide')})`);
 assert.ok(flown.detail&&!flown.busy&&flown.leaks===0);assert.ok(flown.metric.landingErrorPx<2,'poster meets the actual background-image detail poster');assert.ok(flown.metric.surfaces.every(s=>s.width<=240));
 assert.ok(flown.metric.plannedEndMs<=700,'a prompt route lands by the deadline: '+flown.metric.plannedEndMs);
 assert.equal(await evaluate('fixture.resizedDuringFlight'),true,'responsive target changed during the poster flight');
 await evaluate(`fixture.show('home');true`);
 // A page whose layout is known is flown to at once, without a lift.
 const preset=await evaluate(`(async()=>{fixture.show('detail');const b=document.querySelector('#detail .detailImageContainer:not(.hide)').getBoundingClientRect();fixture.show('home');
  await TigerestHomeTransitions.poster({source:document.querySelector('#source'),findTarget:()=>document.querySelector('#detail .detailImageContainer:not(.hide)'),navigate:()=>fixture.route('detail',60),landingKey:'preset-fixture',presetRect:{x:b.x,y:b.y,width:b.width,height:b.height}});
  fixture.show('home');return TigerestHomeTransitions.last;})()`);
 assert.equal(preset.aim,'preset');assert.ok(preset.posterFlightStartsMs<20&&preset.aimErrorPx<1&&preset.landingErrorPx<2&&preset.plannedEndMs<=620,'preset landing: '+JSON.stringify(preset));
 // Explicit pointer-events on a child overrides inherited pointer-events:none.
 // A transition must still prevent this real click from reaching the old page.
 await evaluate(`window.blockedPageClicks=0;const button=document.createElement('button');button.id='input-probe';button.textContent='action';Object.assign(button.style,{position:'fixed',left:'8px',top:'8px',width:'80px',height:'32px',pointerEvents:'auto'});button.onclick=()=>++blockedPageClicks;document.querySelector('#home').append(button);true`);
 // Keep the slow route pending until inspected. A wall-clock sample can arrive
 // after navigation on a loaded runner and confuse that with a missing veil.
 // Another kind of page has no remembered landing, so the poster lifts in place.
 await begin(true,450,'Series');
 assert.equal(await evaluate('TigerestHomeTransitions.busy'),true);
 await evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+8000;const poll=()=>{if(fixture.releaseDetail)return resolve();if(performance.now()>deadline)return reject(Error('poster never reached navigation'));setTimeout(poll,16);};poll();})`);
 const waiting=await evaluate(`({busy:TigerestHomeTransitions.busy,veil:+getComputedStyle(document.querySelector('.tigerest-motion-veil')).opacity,poster:!!document.querySelector('.tigerest-motion-poster'),old:!document.querySelector('#home').classList.contains('hide')})`);
 assert.ok(waiting.busy&&waiting.poster&&waiting.veil>.99&&waiting.old,'blur remains opaque while the real route loads: '+JSON.stringify(waiting));
 await call('Input.dispatchMouseEvent',{type:'mousePressed',x:30,y:20,button:'left',clickCount:1});
 await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:30,y:20,button:'left',clickCount:1});
 assert.equal(await evaluate('blockedPageClicks'),0,'transition cover must intercept clicks even when the underlying control explicitly accepts pointer input');
 await evaluate('fixture.releaseDetail();pending');
 // Too late for a flight by the deadline: the poster stays where it rose and
 // fades out as the page is revealed, with the real poster in its own place.
 const late=await evaluate(`({metric:TigerestHomeTransitions.last,leaks:document.querySelectorAll('.tigerest-motion-layer,[data-tigerest-poster-held]').length,busy:TigerestHomeTransitions.busy,detail:!document.querySelector('#detail').classList.contains('hide')})`);
 assert.ok(late.detail&&!late.busy&&late.leaks===0,JSON.stringify(late));
 assert.equal(late.metric.fallback,'late-target');assert.ok(late.metric.plannedEndMs-late.metric.targetMs<=130,'the late page is revealed at once: '+JSON.stringify(late.metric));
 await evaluate('router.back()');assert.equal(await evaluate('fixture.state.contextPath'),'/library');
 assert.ok(await evaluate('TigerestHomeTransitions.last.landingErrorPx<2&&indexQuery.EnableImages===false'),'return locates the work through the real virtual-list API');
 await evaluate('router.back()');assert.equal(await evaluate('fixture.state.contextPath'),'/home');
 assert.equal(await evaluate('!!document.querySelector(".tigerest-motion-input")'),false,'input is restored after the transition');
 await call('Input.dispatchMouseEvent',{type:'mousePressed',x:30,y:20,button:'left',clickCount:1});
 await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:30,y:20,button:'left',clickCount:1});
 assert.equal(await evaluate('blockedPageClicks'),1,'the same control accepts input again after the transition');
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
 // Home -> library flies the live gallery parts; nothing is copied on click.
 const liveOut=await evaluate(`fixture.show('home');const homePage=document.querySelector('#home');window.liveParts=['nav','rail','stage'].map(n=>{const e=document.createElement('div');e.className='tg-home-'+n;e.textContent=n;homePage.append(e);return e;});window.liveGallery={active:true,root:homePage,nav:liveParts[0],rail:liveParts[1],stage:liveParts[2]};window.liveLibrary=TigerestHomeTransitions.library({gallery:liveGallery,navigate:()=>{liveGallery.active=false;return fixture.route('library');}});({copies:document.querySelectorAll('.tigerest-motion-frozen').length,animated:liveParts.every(p=>p.getAnimations().length>0),cover:+getComputedStyle(document.querySelector('.tigerest-motion-layer')).opacity})`);
 assert.deepEqual(liveOut,{copies:0,animated:true,cover:0},'library fly-out animates the live gallery under a transparent cover');
 await evaluate('liveLibrary');
 assert.ok(await evaluate(`TigerestHomeTransitions.last.kind==='library'&&!TigerestHomeTransitions.last.interrupted&&liveParts.every(p=>p.getAnimations().length===0)&&!document.querySelector('.tigerest-motion-layer')`),'live fly-out effects are released after the incoming page');
 await evaluate('liveParts.forEach(p=>p.remove());true');
 await evaluate(`fixture.show('home');window.tabGallery={active:true};window.tabStart=performance.now();window.tabIncoming=new Promise((resolve,reject)=>{const deadline=performance.now()+8000;const observe=()=>{const n=document.querySelector('.tigerest-motion-frozen');if(n&&getComputedStyle(n).transform!=='none'&&+getComputedStyle(n).opacity>0)return resolve({observed:true,elapsedMs:performance.now()-tabStart});if(performance.now()>deadline)return reject(Error('same-page central incoming animation was not observed'));requestAnimationFrame(observe);};requestAnimationFrame(observe);});window.tab=TigerestHomeTransitions.library({gallery:tabGallery,samePage:true,navigate:()=>{tabGallery.active=false;document.querySelector('#home h1').textContent='收藏';history.replaceState({},'',location.pathname+'?tab=favorites');}});true`);
 assert.equal((await evaluate('tabIncoming')).observed,true,'same-page Favorites uses the central incoming animation');
 await evaluate('tab');assert.ok(await evaluate(`TigerestHomeTransitions.last.kind==='library'&&!TigerestHomeTransitions.last.interrupted`),'Favorites completes the observed incoming animation on the reused page');
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await evaluate(`fixture.show('home');window.reduced=TigerestHomeTransitions.poster({source:document.querySelector('#source'),findTarget:()=>document.querySelector('.detailImageContainer'),navigate:()=>fixture.route('detail')});true`);
 assert.equal(await evaluate('!!document.querySelector(".tigerest-motion-poster,.tigerest-motion-veil")'),false);await evaluate('reduced');
 console.log('production motion fixture:',JSON.stringify({checks:16,flown,late}));
},{gpu:true,visible:true}).catch(error=>{console.error(error);process.exitCode=1;});
