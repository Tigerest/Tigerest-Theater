const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const withBrowser=require('./community_browser.cjs');
const root=path.resolve(__dirname,'..'),embedded=process.argv.includes('--webengine')||Boolean(process.env.TIGEREST_ANDROID_FIXTURE);
const shell=fs.readFileSync(path.join(root,'native/nativeshell.js'),'utf8');
const controls=shell.slice(shell.indexOf('function installHeaderControlsStyle()'),shell.indexOf('\ninstallMpvSettingsEntry();'));
const routes={
 '/':{type:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#101216;color:white;font:16px system-ui}header{height:84px}#home{position:relative}</style><header class="skinHeader">Tigerest Theater</header><aside class="mainDrawer">Original Emby navigation</aside><main id="home"></main>'+(!embedded?'<script src="/data.js"></script><script src="/gallery.js"></script><script src="/controls.js"></script>':'')},
 '/controls.js':{body:'window.initCompleted=Promise.resolve();window.api={window:{isFullScreen:async()=>false,setFullScreen:async()=>{},fullScreenSwitched:{connect(){}}}};'+controls+';installWindowModeEntry();'},
 '/data.js':{path:path.join(root,'native/homeData.js')},'/gallery.js':{path:path.join(root,'native/homeGallery.js')},
 '/poster.svg':{type:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="g"><stop stop-color="#163748"/><stop offset="1" stop-color="#4d3159"/></linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/><circle cx="1100" cy="350" r="240" fill="#c98b52"/><path d="M0 700 L600 400 L1000 900 H0" fill="#08131c"/></svg>'}
};
for(const name of ['anime','movies','series','favorites'])routes['/art/'+name+'.png']={type:'image/png',path:path.join(root,'native/home-art',name+'.png')};
withBrowser(routes,async({evaluate,call})=>{
 // Keyboard focus requires an active page even when the native test window is
 // in the background. Keep the fixture independent of the desktop's focus.
 await call('Emulation.setFocusEmulationEnabled',{enabled:true});
 // The animation contract must not depend on the runner's accessibility
 // preference. Reduced motion is verified separately below.
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 const result=await evaluate('('+ (async function(embedded){
  const check=(value,message)=>{if(!value)throw Error(message);};
  check(document.hasFocus(),'keyboard-focus fixture has an active page');
  const wait=async(fn)=>{for(let i=0;i<400;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('condition timeout: '+JSON.stringify({visibility:document.visibilityState,animations:window.gallery?.animations.map(a=>({state:a.playState,time:a.currentTime}))}));};
  check(window.TigerestHomeGallery,'rebuilt gallery is available');
  // This fixture verifies the Gallery in isolation; actual navigation has its own fixture.
  window.TigerestHomeMotion=null;
  const opened=[],requests=[],fullscreen=[];let heldResolve,currentUser='one';
  const api={serverId:()=> 'fixture-server',serverAddress:()=>location.origin,getCurrentUserId:()=>currentUser,
   getUserViews:async()=>({Items:Array.from({length:7},(_,i)=>({Id:'library'+i,Name:'我的媒体库 '+(i+1),CollectionType:i===0?'tvshows':'movies'}))}),
   getItems:async(user,query,signal)=>{
    requests.push({user,query});if(query.Ids)return {Items:query.Ids.split(',').map(id=>({Id:id,Type:'Series',Name:'剧集 '+id,BackdropImageTags:['image']}))};
    if(query.ParentId==='library1')return new Promise(resolve=>heldResolve=resolve);
    if(query.ParentId==='library6')return {Items:Array.from({length:24},(_,i)=>({Id:'long-'+i,Name:'作品 '+i,Type:'Movie',DateCreated:'2026-10-09',BackdropImageTags:['image']}))};
    return {Items:[{Id:query.ParentId+'-new',Name:'最近入库作品',Overview:'<p>这是作品简介。<br>用于预览剧情，人物相遇 &amp; 故事开始。</p>',Type:'Movie',DateCreated:'2026-10-09',BackdropImageTags:['image']},
     {Id:query.ParentId+'-old',Name:'较早作品',Type:'Movie',DateCreated:'2026-10-01',BackdropImageTags:['image']}]};
   },getImageUrl:()=>location.origin+'/poster.svg'};
  localStorage.setItem('tigerest-home-style','gallery');
  window.gallery=new TigerestHomeGallery(document.getElementById('home'),{apiProvider:()=>api,enterFullscreen:()=>fullscreen.push(true),router:{showItem:(item,server)=>opened.push({item,server}),showFavorites:()=>opened.push({favorite:true})},artBase:embedded?undefined:location.origin+'/art'});
  // Hold the actual browser timelines so slow startup cannot finish the
  // entrance before its ordering assertions inspect it.
  const enter=gallery.enter,animateText=gallery.animateText;
  gallery.enter=function(generation){enter.call(this,generation);this.animations.forEach(animation=>{animation.pause();animation.currentTime=0;});};
  gallery.animateText=function(...args){animateText.apply(this,args);this.textAnimations.forEach(animation=>{animation.pause();animation.currentTime=0;});};
  await gallery.start({});
  check(fullscreen.length===0,'home entry does not request fullscreen');
  // Synthetic pointer events do not establish CSS :hover. Actual gallery
  // focus keeps its automatic carousel paused during manual-selection checks.
  gallery.hero.focus({preventScroll:true});
  check(gallery.root.contains(document.activeElement),'manual-selection fixture has actual gallery focus');
  check(gallery.root.dataset.style==='cinema'&&!document.querySelector('.tg-home-style-button'),'chosen cinema design replaces the comparison controls and old style preference');
  check(getComputedStyle(document.querySelector('.skinHeader')).display==='none'&&getComputedStyle(document.querySelector('.mainDrawer')).display==='none','original chrome hidden only on the new home');
  check(document.querySelectorAll('.tg-library').length===8,'all seven accessible libraries plus favorites');
  check(document.querySelector('.tg-library').textContent.includes('我的媒体库 1'),'actual library name');
  check(!document.querySelector('.tg-home').classList.contains('tg-entered'),'poster waits for both entrance groups');
  check(Number(getComputedStyle(gallery.title).opacity)===0,'title stays hidden during the flying lists');
  const railEntrance=gallery.animations.find(animation=>animation.effect.target===gallery.rail);
  check(railEntrance&&gallery.animations.some(animation=>animation.effect.target===gallery.nav),'both entrance groups animate');
  gallery.animations.filter(animation=>animation!==railEntrance).forEach(animation=>animation.finish());
  await Promise.resolve();await Promise.resolve();
  check(!gallery.root.classList.contains('tg-entered'),'finishing the media list alone cannot reveal the poster');
  railEntrance.finish();
  await wait(()=>document.querySelector('.tg-home').classList.contains('tg-entered'));
  check(document.querySelector('.tg-home').classList.contains('tg-ready'),'poster reveals after content and entrances');
  check(Number(getComputedStyle(gallery.title).opacity)===0,'title enters separately after the poster begins revealing');
  gallery.enter=enter;gallery.animateText=animateText;gallery.textAnimations.forEach(animation=>animation.play());
  await wait(()=>Number(getComputedStyle(gallery.title).opacity)>.95);
  check(gallery.overview.textContent==='这是作品简介。 用于预览剧情，人物相遇 & 故事开始。'&&!gallery.overview.querySelector('*'),'overview renders readable plain text');
  document.querySelectorAll('.tg-cover')[1].dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));
  check(Number(getComputedStyle(gallery.title).opacity)===0,'a carousel change resets the independent title entrance');
  await wait(()=>Number(getComputedStyle(gallery.title).opacity)>.95);
  check(gallery.title.textContent==='较早作品','carousel text ends on the selected work');
  const selectedCover=document.querySelector('.tg-cover.is-selected'),selection=gallery.selection,sceneryBeforeFocus=gallery.scenery;
  selectedCover.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));selectedCover.focus({preventScroll:true});
  check(gallery.selection===selection&&gallery.scenery===sceneryBeforeFocus,'hovering or focusing the current cover preserves its scene and transition cache');
  check(gallery.overview.hidden,'a work without an overview has no empty summary block');
  const create=document.createElement.bind(document);
  document.createElement=function(tag,...args){const node=create(tag,...args);if(tag==='img')Object.defineProperty(node,'src',{set(){},configurable:true});return node;};
  const previousScenery=gallery.scenery;
  gallery.select(0,false);
  check(gallery.heroImages.querySelector('.is-visible')&&previousScenery.isConnected,'a carousel change keeps the previous artwork until the new artwork loads, without a dark gap');
  await wait(()=>Number(getComputedStyle(gallery.title).opacity)>.95);
  check(gallery.title.textContent==='最近入库作品'&&!gallery.overview.hidden,'stalled artwork never blocks work metadata or synopsis');
  check(!gallery.heroImages.querySelector('.is-visible'),'stalled artwork cannot retain a previous work behind new metadata');
  check(!previousScenery.isConnected,'a stalled backdrop cannot retain the previous ambient artwork');
  document.createElement=create;
  document.querySelector('.tg-cover').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));
  await wait(()=>Number(getComputedStyle(gallery.title).opacity)>.95);
  document.querySelector('.tg-home-hero').click();document.querySelector('.tg-cover').click();
  check(opened.length===2&&opened.every(x=>x.item.Id==='library0-new'&&x.server==='fixture-server'),'hero and cover open work detail');
  const library=document.querySelector('[data-library-id="library2"]');library.click();check(opened.at(-1).item.Id==='library2','library uses original Emby item routing');
  document.querySelector('[data-library-id="tigerest-favorites"]').click();check(opened.at(-1).favorite,'favorites uses original favorites route');
  const first=document.querySelector('[data-library-id="library1"]');first.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));await wait(()=>heldResolve);
  library.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));await wait(()=>document.querySelector('.tg-cover')?.dataset.itemId==='library2-new');
  heldResolve({Items:[{Id:'stale',Type:'Movie',Name:'过期作品',DateCreated:'2026-10-10'}]});await new Promise(r=>setTimeout(r,60));
  check(!document.querySelector('[data-item-id="stale"]'),'slow previous hover cannot overwrite selected library');
  // Route/account changes cancel pending responses and discard cached artwork.
  first.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));await new Promise(r=>setTimeout(r,10));
  currentUser='two';gallery.stop();heldResolve?.({Items:[{Id:'old-user',Type:'Movie',Name:'前账号',DateCreated:'2026-10-10'}]});
  await gallery.start({});await wait(()=>document.querySelector('.tg-cover'));
  check(!document.querySelector('[data-item-id="old-user"]'),'old account media discarded');
  check(requests.at(-1).user==='two','new account uses own API identity');
  const image=document.querySelector('.tg-library img');await wait(()=>image.complete);
  check(image.naturalWidth>0,'packaged category artwork loads in this browser');
  // Pin the entrance before its first visible frame. Keyboard navigation must
  // reveal layout content even when a background compositor holds its timeline.
  gallery.animations.forEach(animation=>{animation.pause();animation.currentTime=0;});
  if (embedded) await window.api?.window.raiseWindow?.();
  const lastLibrary=document.querySelector('[data-library-id="library6"]');lastLibrary.focus({preventScroll:true});
  const libraryFrame=gallery.libraryList.getBoundingClientRect(),focusedLibrary=lastLibrary.getBoundingClientRect();
  check(gallery.libraryList.scrollTop>0||gallery.libraryList.scrollLeft>0,'keyboard focus reveals a library outside the list viewport: '+JSON.stringify({frame:libraryFrame.toJSON(),item:focusedLibrary.toJSON(),scrollTop:gallery.libraryList.scrollTop,scrollLeft:gallery.libraryList.scrollLeft,active:document.activeElement?.dataset.libraryId,animations:gallery.animations.map(a=>a.playState)}));
  check(focusedLibrary.top>=libraryFrame.top-1&&focusedLibrary.bottom<=libraryFrame.bottom+1&&focusedLibrary.left>=libraryFrame.left-1&&focusedLibrary.right<=libraryFrame.right+1,'focused library is fully inside its list viewport');
  check(focusedLibrary.top>=0&&focusedLibrary.bottom<=innerHeight&&focusedLibrary.left>=0&&focusedLibrary.right<=innerWidth,'keyboard focus removes the offscreen entrance transform');
  await wait(()=>document.querySelectorAll('.tg-cover').length===24);const lastCover=document.querySelectorAll('.tg-cover')[23];lastCover.focus({preventScroll:true});
  const coverFrame=gallery.coverList.getBoundingClientRect(),focusedCover=lastCover.getBoundingClientRect();
  check(gallery.coverList.scrollLeft>0,'keyboard focus reveals a cover outside the carousel viewport');
  check(focusedCover.left>=coverFrame.left-1&&focusedCover.right<=coverFrame.right+1&&focusedCover.top>=coverFrame.top-1&&focusedCover.bottom<=coverFrame.bottom+1,'focused cover is fully inside the carousel viewport');
  const views=api.getUserViews;api.getUserViews=async()=>{throw Error('offline');};
  await gallery.start({});check(document.querySelector('.tg-home-retry').hidden===false,'library failure exposes retry');
  api.getUserViews=views;document.querySelector('.tg-home-retry').click();await wait(()=>document.querySelector('.tg-cover'));
  check(document.querySelector('.tg-cover').dataset.itemId==='library0-new','retry after a failed return to home reloads libraries');
  gallery.stop();check(!gallery.timer&&gallery.abort.signal.aborted,'pause cancels carousel and requests');
  check(getComputedStyle(document.querySelector('.skinHeader')).display!=='none'&&getComputedStyle(document.querySelector('.mainDrawer')).display!=='none','leaving home restores original navigation');
  await gallery.start({});await wait(()=>document.querySelector('.tg-home').classList.contains('tg-entered'));
  check(fullscreen.length===0,'home reentry, retry and login changes never request fullscreen');
  return {libraries:8,navigation:opened.length,requests:requests.length,artwork:image.naturalWidth};
 }).toString()+')('+JSON.stringify(embedded)+')');
 console.log('home gallery interaction checks:',result);
 const watch=await evaluate(`(async()=>{
  const check=(value,message)=>{if(!value)throw Error(message);};
  let moviePlayed=false,releaseCounts;
  const countsReady=new Promise(resolve=>releaseCounts=resolve);
  gallery.api.getResumableItems=async()=>({Items:[]});
  gallery.api.getItems=async(user,query)=>{
   if(query.Limit===0){await countsReady;return {Items:[],TotalRecordCount:query.IsPlayed===true&&query.ParentId==='watch-partial'?8:12};}
   return {Items:[
    {Id:'watch-partial',Name:'长夜微光',Type:'Series',RecursiveItemCount:12,UserData:{Played:false,UnplayedItemCount:4}},
    {Id:'watch-complete',Name:'夏日来信',Type:'Series',RecursiveItemCount:12,UserData:{Played:true,UnplayedItemCount:0}},
    {Id:'watch-movie',Name:'光影之间',Type:'Movie',UserData:{Played:moviePlayed}},
    {Id:'watch-played',Name:'远方的旅人',Type:'Movie',UserData:{Played:true}},
    {Id:'watch-unknown',Name:'未知状态作品',Type:'Movie'}
   ].map(item=>({...item,DateCreated:'2026-10-13',BackdropImageTags:['image']}))};
  };
  await gallery.start({});gallery.finishEntrance();gallery.hero.focus({preventScroll:true});
  check(gallery.coverList.children.length===5&&gallery.status.hidden,'artwork is shown while episode counts are still pending');
  check(!gallery.coverList.querySelector('.tg-watch-progress'),'pending counts never invent a fraction');
  releaseCounts();
  for(let i=0;i<100&&!gallery.hero.textContent.includes('观看进度：8/12');i++)await new Promise(resolve=>setTimeout(resolve,10));
  const cover=id=>gallery.coverList.querySelector('[data-item-id="'+id+'"]');
  const unplayedBadge=cover('watch-partial').querySelector('.tg-watch-badge');
  check(unplayedBadge?.textContent==='','partly watched series has a plain unplayed dot without text');
  const badgeStyle=getComputedStyle(unplayedBadge);
  check(badgeStyle.width==='8px'&&badgeStyle.height==='8px'&&badgeStyle.borderRadius==='50%','unplayed marker is a small circular dot');
  check(cover('watch-partial').textContent.includes('观看进度：8/12'),'series poster displays account completion over available episodes');
  check(gallery.hero.textContent.includes('观看进度：8/12'),'selected work displays its viewing progress');
  check(!cover('watch-complete').querySelector('.tg-watch-badge'),'complete series has no unplayed badge');
  check(cover('watch-complete').textContent.includes('观看进度：12/12'),'complete series retains its progress');
  check(!!cover('watch-movie').querySelector('.tg-watch-badge'),'unplayed movie has a red badge');
  check(!cover('watch-played').querySelector('.tg-watch-badge'),'played movie has no unplayed badge');
  check(!cover('watch-unknown').querySelector('.tg-watch-badge,.tg-watch-progress'),'unknown metadata does not invent a watch state');
  check(cover('watch-partial').getAttribute('aria-label').includes('未看，观看进度：8/12'),'keyboard and screen-reader labels retain unplayed status and progress');
  check(gallery.hero.getAttribute('aria-label').includes('未看，观看进度：8/12'),'selected work retains accessible unplayed status and progress');
  const getItems=gallery.api.getItems;let releaseLate;
  const lateCounts=new Promise(resolve=>releaseLate=resolve);
  gallery.api.getItems=async(user,query,signal)=>query.Limit===0?lateCounts:getItems(user,query,signal);
  await gallery.start({});
  moviePlayed=true;gallery.stop();gallery.api.getItems=getItems;
  await gallery.start({});gallery.finishEntrance();gallery.hero.focus({preventScroll:true});
  for(let i=0;i<100&&!gallery.hero.textContent.includes('观看进度：8/12');i++)await new Promise(resolve=>setTimeout(resolve,10));
  check(!cover('watch-movie').querySelector('.tg-watch-badge'),'returning after playback refreshes watch state instead of restoring a cached badge');
  releaseLate({Items:[],TotalRecordCount:99});await new Promise(resolve=>setTimeout(resolve,20));
  check(gallery.hero.textContent.includes('观看进度：8/12')&&!gallery.hero.textContent.includes('99/99'),'late count responses from the prior home cannot overwrite current progress');
  return {partial:'8/12',complete:'12/12',playbackReturnRefreshed:true};
 })()`);
 console.log('home gallery watch-state checks:',watch);
 // A pointer swept along the rail selects every cover it crosses (issue #38).
 const sweep=await evaluate(`(async()=>{
  const check=(value,message)=>{if(!value)throw Error(message);};
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const covers=Array.from(gallery.coverList.children);
  const hover=index=>covers[index].dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));
  const layers=()=>({visible:gallery.heroImages.querySelectorAll('.is-visible').length,posters:gallery.heroImages.children.length,
   shown:gallery.root.querySelectorAll('.tg-home-scenery:not(.tg-pending)').length,sceneries:gallery.root.querySelectorAll('.tg-home-scenery').length});
  const settled=async()=>{for(let i=0;i<300;i++){const now=layers();if(now.visible===1&&now.posters===1&&now.shown===1&&now.sceneries===1)return;await sleep(10);}throw Error('artwork never settled on one layer: '+JSON.stringify(layers()));};
  gallery.hero.focus({preventScroll:true});gallery.select(0,false);await settled();
  let peak=layers(),added=0,sampling=true;
  const observer=new MutationObserver(records=>records.forEach(record=>added+=record.addedNodes.length));
  observer.observe(gallery.heroImages,{childList:true});
  (function sample(){const now=layers();for(const key in now)peak[key]=Math.max(peak[key],now[key]);if(sampling)requestAnimationFrame(sample);})();
  // Faster than the artwork settles: only the cover the pointer rests on loads.
  const path=[1,2,3,4,3,2,1,0,1,2,3,4,3,2,1,0,1,2,3,4,3,2,1,0,1,2,3];
  for(const index of path){hover(index);check(gallery.index===index&&gallery.ordinal.textContent.startsWith('0'+(index+1)),'text follows the pointer at once');await sleep(25);}
  for(let i=0;i<100&&!added;i++)await sleep(10);
  await settled();
  // One load is expected; a stalled timer on a busy runner may let another through.
  const fastLoads=added,fastPeak={...peak};
  check(fastLoads>=1&&fastLoads<=3,'a fast sweep loads artwork for the cover it stops on, not for each of '+path.length+' covers: loaded '+fastLoads);
  check(peak.visible<=2&&peak.shown<=2,'a fast sweep never stacks artwork: '+JSON.stringify(peak));
  // Slow enough for every cover to load: fades run one at a time.
  added=0;peak=layers();
  for(const index of [2,1,0,1,2,3,4,3,2,1]){hover(index);await sleep(190);}
  await settled();observer.disconnect();sampling=false;
  check(added>=5,'a slower sweep loads the covers it rests on, loaded '+added);
  check(peak.visible<=2&&peak.posters<=3&&peak.shown<=2&&peak.sceneries<=3,'changing covers mid-fade never stacks more than two visible layers: '+JSON.stringify(peak));
  check(gallery.index===1&&gallery.title.textContent===gallery.cards[1].item.Name,'the sweep ends on its last cover');
  return {fastLoads,fastPeak,slowLoads:added,slowPeak:peak};
 })()`);
 console.log('home gallery sweep checks:',sweep);
 await evaluate('new Promise(r=>setTimeout(r,1600))');
 await evaluate('gallery.hero.focus({preventScroll:true});gallery.cards[0].item.Name="这是一个用于验证窄屏排版的较长作品标题，标题和简介应始终留在海报内";gallery.cards[0].item.Overview="主角们在各自的故事中相遇，面对新的选择，逐渐发现彼此的秘密与梦想。".repeat(8);gallery.select(0,false);new Promise(r=>setTimeout(r,1500))');
 const directory=process.env.TIGEREST_HOME_SCREENSHOTS||path.join(root,'build/home-exploration-2026-10-09');fs.mkdirSync(directory,{recursive:true});
 for(const [width,height,label] of [[1440,900,'wide'],[1050,790,'desktop-1050'],[900,700,'compact'],[390,844,'phone'],[844,390,'landscape'],[320,480,'short-phone'],[568,320,'short-landscape']]){
  await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await evaluate('new Promise(r=>setTimeout(r,80))');
  const bounds=await evaluate('(()=>{const e=document.querySelector(".tg-home"),h=document.querySelector(".tg-home-stage"),n=document.querySelector(".tg-home-nav");return {width:innerWidth,pageWidth:document.documentElement.scrollWidth,hero:h.getBoundingClientRect().toJSON(),copy:gallery.heroCopy.getBoundingClientRect().toJSON(),overview:gallery.overview.getBoundingClientRect().toJSON(),nav:n.getBoundingClientRect().toJSON(),rail:gallery.rail.getBoundingClientRect().toJSON(),root:e.getBoundingClientRect().toJSON(),height:e.offsetHeight,list:gallery.libraryList.getBoundingClientRect().toJSON(),card:gallery.libraryList.firstElementChild.getBoundingClientRect().toJSON()};})()');
  assert.ok(bounds.pageWidth<=width+1,'no page-wide horizontal overflow at '+label);
  assert.ok(bounds.hero.width>150&&bounds.hero.height>110,'usable poster at '+label);
  assert.ok(bounds.hero.right<=width+1&&bounds.nav.right<=width+1,'components within viewport at '+label);
  assert.ok(bounds.copy.top>=bounds.hero.top&&bounds.copy.bottom<=bounds.hero.bottom+1&&bounds.copy.right<=bounds.hero.right,'long title and overview fit in the poster at '+label);
  assert.ok(bounds.rail.bottom<=bounds.root.bottom+1,'the whole carousel remains available at '+label);
  const watchBounds=await evaluate(`(()=>{const cover=gallery.coverList.firstElementChild,badge=cover.querySelector('.tg-watch-badge'),progress=cover.querySelector('.tg-watch-progress'),heading=gallery.nav.querySelector('.tg-home-eyebrow');const text=Array.from(heading.childNodes).find(node=>node.textContent.includes('我的媒体'));const range=document.createRange();range.selectNodeContents(text);const lines=Array.from(range.getClientRects());return {cover:cover.getBoundingClientRect().toJSON(),badge:badge?.getBoundingClientRect().toJSON(),progress:progress?.getBoundingClientRect().toJSON(),headingLines:lines.map(rect=>rect.toJSON()),heading:heading.getBoundingClientRect().toJSON()};})()`);
  for(const key of ['badge','progress']){const box=watchBounds[key];assert.ok(box&&box.left>=watchBounds.cover.left&&box.right<=watchBounds.cover.right&&box.bottom<=watchBounds.cover.bottom&&box.top>=watchBounds.cover.top,key+' fits inside the poster at '+label);}
  if(width===1050)assert.ok(watchBounds.headingLines.length<=2,'the fullscreen heading never splits the Chinese media label into stray characters');
  if(width<=680)assert.ok(bounds.card.top>=bounds.list.top&&bounds.card.bottom<=bounds.list.bottom,'the complete library card fits below the fullscreen heading at '+label+' '+JSON.stringify(bounds));
  const capture=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(directory,'home-'+label+'.png'),Buffer.from(capture.data,'base64'));
 }
 // Emby 4.8 hosts the home in a flex row (.tabContent.flex), where the
 // gallery would otherwise shrink to its content.
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 const spans=await evaluate('(async()=>{const host=document.getElementById("home"),widths={};for(const display of ["block","flex"]){host.style.display=display;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));widths[display]=[host.getBoundingClientRect().width,document.querySelector(".tg-home").getBoundingClientRect().width];}host.style.display="";return widths;})()');
 for(const [display,[host,home]] of Object.entries(spans))assert.ok(Math.abs(host-home)<=1,'the gallery spans a '+display+' host '+JSON.stringify(spans));
 if(process.env.TIGEREST_HOME_SCREENSHOTS){
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await evaluate(`(async()=>{
   const art=['movies','series','anime','favorites'];
   gallery.api.getUserViews=async()=>({Items:[{Id:'preview-movies',Name:'电影',CollectionType:'movies'},{Id:'preview-series',Name:'剧集',CollectionType:'tvshows'},{Id:'preview-anime',Name:'动漫',CollectionType:'tvshows'}]});
   gallery.api.getItems=async(user,query)=>query.Limit===0
    ? {Items:[],TotalRecordCount:query.IsPlayed===true&&query.ParentId==='preview-0'?8:12}
    : {Items:['长夜微光','夏日来信','光影之间','远方的旅人'].map((Name,index)=>({Id:'preview-'+index,Name,Overview:'沿着城市的光影，寻找平凡生活中值得珍藏的瞬间。一次相遇，让熟悉的世界有了新的色彩。',Type:index<2?'Series':'Movie',UserData:{Played:index===1||index===3},ProductionYear:2026,DateCreated:'2026-10-13',BackdropImageTags:['preview'],ImageTags:{Primary:'preview'}}))};
   gallery.api.getImageUrl=id=>location.origin+'/art/'+art[Number(id.split('-').at(-1))||0]+'.png';
   gallery.scenery.remove();gallery.scenery=document.createElement('img');gallery.scenery.className='tg-home-scenery';gallery.root.prepend(gallery.scenery);
   await gallery.start({});gallery.finishEntrance();gallery.hero.focus({preventScroll:true});
   await new Promise(r=>setTimeout(r,1600));
  })()`);
  for(const [width,height,label] of [[1440,900,'wide'],[1050,790,'1050']]){
   await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
   await evaluate('new Promise(resolve=>setTimeout(resolve,150))');
   fs.writeFileSync(path.join(directory,'home-watch-progress-'+label+'.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
 }
 for(const [android,touch] of [[false,true],[true,true]]){
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:touch});
  await call('Emulation.setTouchEmulationEnabled',{enabled:touch,maxTouchPoints:1});
  await evaluate(`(async()=>{const options=gallery.options;gallery.destroy();window.tigerestAndroidApi=${android?'{}':'null'};window.gallery=new TigerestHomeGallery(document.getElementById('home'),options);await gallery.start({});gallery.finishEntrance();})()`);
  const layout=await evaluate(`(()=>{const list=gallery.libraryList.getBoundingClientRect(),card=gallery.libraryList.firstElementChild.getBoundingClientRect();return {fullCard:card.top>=list.top&&card.bottom<=list.bottom,cardHeight:card.height,windowButton:!!gallery.root.querySelector('[data-tigerest-window-mode]'),buttonHeight:gallery.root.querySelector('[data-tigerest-window-mode]')?.getBoundingClientRect().height||0};})()`);
  assert.equal(layout.fullCard,true,(android?'Android':'touch desktop')+' retains the complete library card below the heading');
  assert.equal(layout.cardHeight,78,'compact card keeps its intended height');
  assert.equal(layout.windowButton,!android,'desktop window control visibility follows platform');
  if(!android)assert.ok(layout.buttonHeight>=44,'touch desktop retains a 44px fullscreen target');
 }
 await call('Emulation.setTouchEmulationEnabled',{enabled:false});
 await evaluate('window.tigerestAndroidApi=null');
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 const reduced=await evaluate('(async()=>{gallery.stop();await gallery.start({});for(let i=0;i<200&&Number(getComputedStyle(gallery.title).opacity)<1;i++)await new Promise(r=>setTimeout(r,10));const ready=document.querySelector(".tg-home").classList.contains("tg-entered")&&Number(getComputedStyle(gallery.title).opacity)===1;gallery.destroy();return {ready,empty:document.getElementById("home").children.length===0};})()');
 assert.ok(reduced.ready&&reduced.empty,'reduced motion reveals immediately and destroy releases DOM');
 console.log('home gallery responsive and reduced-motion checks passed');
},{gpu:true,visible:true,startupTimeout:30000}).catch(error=>{console.error(error);process.exitCode=1;});
