const assert=require('node:assert/strict'),path=require('node:path'),withBrowser=require('./community_browser.cjs');
const root=path.resolve(__dirname,'..'),embedded=process.argv.includes('--webengine')||!!process.env.TIGEREST_ANDROID_FIXTURE;
const routes={
 '/':{type:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#101722}.page{position:fixed;inset:0;padding:40px;background:#17263a}.hide{display:none}img{width:120px;height:180px}.detailImageContainer{width:240px;height:360px;margin-left:200px;background:url(/poster.svg) center/cover}</style><div id="library" class="page view-tv-tv"><h1>媒体夹</h1><div class="itemsContainer"><div class="card"><div class="cardImageContainer"><img class="cardImage" src="/poster.svg"></div></div></div></div><div id="detail" class="page hide"><div class="detailImageContainer"></div></div>'+ (embedded?'':'<script src="/transitions.js"></script><script src="/motion.js"></script>')},
 '/poster.svg':{type:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720"><rect width="480" height="720" fill="#7d643d"/></svg>'},
 '/transitions.js':{path:path.join(root,'native/homeTransitions.js')},'/motion.js':{path:path.join(root,'native/homeMotion.js')}
};
routes['/scroller.css']={type:'text/css',body:'.linked-scroller{height:300px;overflow:auto}'};
routes['/backdrop.js']={path:path.join(root,'native/homeBackdrop.js')};if(!embedded)routes['/'].body=routes['/'].body.replace('<script src="/transitions.js">','<script src="/backdrop.js"></script><script src="/transitions.js">');
withBrowser(routes,async({evaluate,call,url})=>{
 await evaluate('window.TigerestAmbientBackdrop?.dispose();true');
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 assert.equal(await evaluate('typeof TigerestHomeTransitions.prewarm'),'function','current page can prewarm the expensive background');
 await evaluate(`window.motionFrame=predicate=>new Promise((resolve,reject)=>{const deadline=performance.now()+8000;const observe=()=>{const result=predicate();if(result)return resolve(result);if(performance.now()>deadline)return reject(Error('motion phase was not observed'));requestAnimationFrame(observe);};requestAnimationFrame(observe);});window.state={params:{topParentId:'library'},contextPath:'/tv?topParentId=library'};window.libraryRoot=document.querySelector('#library');libraryRoot.querySelector('.itemsContainer').getItemFromElement=()=>({Id:'work',Type:'Movie'});window.show=name=>{document.querySelectorAll('.page').forEach(n=>n.classList.toggle('hide',n.id!==name));state.contextPath=name==='detail'?'/item?id=work':'/tv?topParentId=library';state.params=name==='detail'?{id:'work'}:{topParentId:'library'};};window.router={showItem:()=>show('detail'),back:()=>window.returnGate?new Promise(resolve=>{window.releaseReturn=()=>{show('library');resolve();};}):show('library'),goHome:()=>{},getRouteUrl:()=>'/tv?topParentId=library'};TigerestHomeMotion.attach({router,pageJs:{replace:()=>show('library')},manager:{currentApiClient:()=>({serverId:()=> 'fixture',getCurrentUserId:()=> 'one'})},viewManager:{currentViewInfo:()=>state}});`);
 const edgePixels=await evaluate(`(async()=>{const root=document.createElement('div');Object.assign(root.style,{position:'fixed',inset:'0',background:'rgb(40,84,200)'});document.body.append(root);const r=await TigerestHomeBackdrop.build(root,new AbortController().signal),c=document.createElement('canvas');c.width=r.width;c.height=r.height;const ctx=c.getContext('2d');ctx.drawImage(r.bitmap,0,0);const corner=Array.from(ctx.getImageData(0,0,1,1).data),center=Array.from(ctx.getImageData(c.width>>1,c.height>>1,1,1).data);r.bitmap.close();root.remove();return {corner,center};})()`);
 assert.deepEqual(edgePixels.corner,[40,84,200,255],'blur clamps the viewport edges instead of revealing a different page through alpha');
 assert.deepEqual(edgePixels.center,[40,84,200,255]);
 assert.equal(await evaluate('TigerestHomeTransitions.prewarm()'),true);
 // Canvas-backed ambient layers must survive freezing without becoming blank.
 const canvasPixels=await evaluate(`(async()=>{
  const canvas=document.createElement('canvas');canvas.id='snapshot-canvas';canvas.width=32;canvas.height=24;
  Object.assign(canvas.style,{position:'absolute',left:'20px',top:'20px',width:'32px',height:'24px'});
  const context=canvas.getContext('2d');context.fillStyle='rgb(29,83,147)';context.fillRect(0,0,32,24);libraryRoot.append(canvas);
  TigerestHomeTransitions.invalidate(false);await TigerestHomeTransitions.prewarm();
  const copy=document.querySelector('.tigerest-motion-cache').firstElementChild.shadowRoot.querySelector('#snapshot-canvas');
  const result=Array.from(copy.getContext('2d').getImageData(8,8,1,1).data);canvas.remove();return result;
 })()`);
 assert.deepEqual(canvasPixels,[29,83,147,255],'frozen canvas retains its displayed pixels');
 const ambientSnapshot=await evaluate(`(async()=>{
  const background=document.createElement('div');background.className='backgroundContainer';
  const canvas=document.createElement('canvas');canvas.id='ambient-snapshot-canvas';canvas.width=32;canvas.height=24;
  const source=document.createElement('canvas');source.width=32;source.height=24;const paint=source.getContext('2d');paint.fillStyle='rgb(51,121,181)';paint.fillRect(0,0,32,24);
  canvas.getContext('bitmaprenderer').transferFromImageBitmap(await createImageBitmap(source));background.append(canvas);document.body.append(background);
  const home=document.createElement('div');home.className='tg-home-host';home.textContent='Home fixture';document.body.append(home);document.body.classList.add('tg-home-active');
  const oldInfo=window.jmpInfo;window.jmpInfo={...oldInfo,platform:'ipad'};
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  TigerestHomeTransitions.invalidate(false);const animation=canvas.animate([{opacity:0},{opacity:1}],{duration:900,fill:'both'});
  await TigerestHomeTransitions.prewarm();
  const shadow=document.querySelector('.tigerest-motion-cache').firstElementChild.shadowRoot,copy=shadow.querySelector('#ambient-snapshot-canvas');
  const result={pixels:Array.from(copy.getContext('2d').getImageData(8,8,1,1).data),opacity:getComputedStyle(copy).opacity};
  animation.cancel();background.remove();home.remove();document.body.classList.remove('tg-home-active');window.jmpInfo=oldInfo;TigerestHomeTransitions.invalidate(false);return result;
 })()`);
 assert.deepEqual(ambientSnapshot.pixels,[51,121,181,255],'home background preserves bitmap-renderer canvas pixels');
 assert.equal(ambientSnapshot.opacity,'1','prewarming waits for the ambient fade outside the page root');
 // Frozen snapshots must preserve a customized built-in's appearance and
 // form/scroll state without constructing another live application control.
 const staticControls=await evaluate(`(async()=>{
  window.snapshotConstructors=0;window.snapshotConnections=0;
  customElements.define('fixture-snapshot-scroll',class extends HTMLDivElement{
   constructor(){super();window.snapshotConstructors++;}
   connectedCallback(){window.snapshotConnections++;}
  },{extends:'div'});
  customElements.define('fixture-snapshot-input',class extends HTMLInputElement{
   constructor(){super();window.snapshotConstructors++;}
   connectedCallback(){window.snapshotConnections++;}
  },{extends:'input'});
  const style=document.createElement('style');style.textContent='.fixture-snapshot-scroll{width:230px;height:100px;overflow:auto;border:3px solid rgb(31,79,121);padding:7px}';document.head.append(style);
  const scroller=document.createElement('div',{is:'fixture-snapshot-scroll'});scroller.id='snapshot-scroll';scroller.className='fixture-snapshot-scroll';scroller.setAttribute('is','fixture-snapshot-scroll');
  const content=document.createElement('div');content.style.cssText='width:600px;height:800px';
  const field=document.createElement('input',{is:'fixture-snapshot-input'});field.id='snapshot-field';field.type='checkbox';field.value='live value';field.checked=true;field.indeterminate=true;content.append(field);
  const text=document.createElement('input',{is:'fixture-snapshot-input'});text.id='snapshot-text';text.value='edited without an attribute';content.append(text);
  const file=document.createElement('input',{is:'fixture-snapshot-input'});file.id='snapshot-file';file.type='file';const files=new DataTransfer();files.items.add(new File(['local fixture'],'snapshot.txt',{type:'text/plain'}));file.files=files.files;content.append(file);scroller.append(content);libraryRoot.append(scroller);
  scroller.scrollTop=180;scroller.scrollLeft=60;
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const live=scroller.getBoundingClientRect().toJSON();TigerestHomeTransitions.invalidate(false);snapshotConstructors=0;snapshotConnections=0;
  await TigerestHomeTransitions.prewarm();
  const shadow=document.querySelector('.tigerest-motion-cache').firstElementChild.shadowRoot,copy=shadow.querySelector('#snapshot-scroll'),input=shadow.querySelector('#snapshot-field');
  const result={constructors:snapshotConstructors,connections:snapshotConnections,live,copy:copy.getBoundingClientRect().toJSON(),scroll:[copy.scrollLeft,copy.scrollTop],is:copy.getAttribute('is'),border:getComputedStyle(copy).borderTopColor,value:input.value,checked:input.checked,indeterminate:input.indeterminate,text:shadow.querySelector('#snapshot-text').value,files:[...shadow.querySelector('#snapshot-file').files].map(file=>file.name)};
  scroller.remove();style.remove();return result;
 })()`);
 assert.equal(staticControls.constructors,0,'frozen pictures must not construct duplicate Emby-style application controls');
 assert.equal(staticControls.connections,0,'frozen pictures must not reconnect scrolling, timers or requests');
 assert.deepEqual(staticControls.scroll,[60,180]);
 // Emby and Jellyfin style their controls by class, never by `is`; a copied
 // `is` lets custom element polyfills upgrade the copy.
 assert.equal(staticControls.is,null,'copies leave out the is attribute');
 assert.equal(staticControls.border,'rgb(31, 79, 121)');
 assert.equal(staticControls.value,'live value');assert.equal(staticControls.checked,true,'live form state is copied');assert.equal(staticControls.indeterminate,true);assert.equal(staticControls.text,'edited without an attribute');assert.deepEqual(staticControls.files,['snapshot.txt']);
 assert.ok(Math.max(...['x','y','width','height'].map(k=>Math.abs(staticControls.live[k]-staticControls.copy[k])))<1,'static customized built-ins keep exact visible geometry');
 // Inactive Emby views can contain thousands of cached controls. Recreating
 // those controls during a frozen-scene capture wastes the click's frame budget.
 // A custom-element constructor observes real deep cloning, including descendants.
 const hiddenClones=await evaluate(`(async()=>{
  customElements.define('fixture-hidden-control',class extends HTMLElement{constructor(){super();window.hiddenControlCopies=(window.hiddenControlCopies||0)+1;}getBoundingClientRect(){window.hiddenControlMeasurements=(window.hiddenControlMeasurements||0)+1;return super.getBoundingClientRect();}});
  const old=document.createElement('div');old.id='inactive-fixture';old.className='page hide';
  for(let i=0;i<500;i++)old.append(document.createElement('fixture-hidden-control'));
  document.body.append(old);TigerestHomeTransitions.invalidate(false);window.hiddenControlCopies=0;
  await TigerestHomeTransitions.prewarm();
  const copies=window.hiddenControlCopies;old.remove();return copies;
 })()`);
 assert.equal(hiddenClones,0,'frozen scenes must not construct controls from hidden cached views');
 const embyHiddenClones=await evaluate(`(async()=>{
  const old=document.createElement('div');old.className='page page-hidden';old.style.display='none';
  for(let i=0;i<40;i++)old.append(document.createElement('fixture-hidden-control'));
  document.body.append(old);TigerestHomeTransitions.invalidate(false);window.hiddenControlCopies=0;window.hiddenControlMeasurements=0;
  await TigerestHomeTransitions.prewarm();const result={copies:window.hiddenControlCopies,measurements:window.hiddenControlMeasurements};old.remove();return result;
 })()`);
 assert.deepEqual(embyHiddenClones,{copies:0,measurements:0},'Emby page-hidden views must be excluded from both snapshot and raster traversal');

 await evaluate('TigerestHomeTransitions.prewarm()');
 // A scrolled poster wall only needs the cards intersecting the viewport.
 // Offscreen placeholders must still preserve grid flow and scroll offsets.
 const wallCopy=await evaluate(`(async()=>{
  customElements.define('fixture-card-content',class extends HTMLElement{constructor(){super();window.cardContentCopies=(window.cardContentCopies||0)+1;}});
  const grid=document.createElement('div');grid.id='large-wall-fixture';Object.assign(grid.style,{display:'grid',gridTemplateColumns:'repeat(4,120px)',gap:'20px'});
  for(let i=0;i<160;i++){const card=document.createElement('div');card.className='card';card.id='wall-card-'+i;card.style.width='120px';const content=document.createElement('fixture-card-content');Object.assign(content.style,{display:'block',height:'180px'});card.append(content);grid.append(card);}
  libraryRoot.append(grid);libraryRoot.style.overflow='auto';libraryRoot.scrollTop=1800;
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const visible=[...grid.children].filter(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})[0];
  const live=visible.getBoundingClientRect().toJSON();TigerestHomeTransitions.invalidate(false);window.cardContentCopies=0;
  await TigerestHomeTransitions.prewarm();
  const shadow=document.querySelector('.tigerest-motion-cache').firstElementChild.shadowRoot;
  const result={constructed:window.cardContentCopies,visible:Math.ceil(innerHeight/200)*4,
   live,copy:shadow.querySelector('#'+visible.id).getBoundingClientRect().toJSON(),scroll:shadow.querySelector('#library').scrollTop};
  grid.remove();libraryRoot.style.removeProperty('overflow');libraryRoot.scrollTop=0;return result;
 })()`);
 assert.ok(wallCopy.constructed<=wallCopy.visible+12,'offscreen card contents should not be cloned: '+JSON.stringify(wallCopy));
 assert.equal(wallCopy.scroll,1800);
 assert.ok(Math.max(...['x','y','width','height'].map(k=>Math.abs(wallCopy.live[k]-wallCopy.copy[k])))<1,'scrolled visible cards must keep their exact geometry');

 const virtualCopy=await evaluate(`(async()=>{
  const wall=document.createElement('div');wall.id='virtual-wall';Object.assign(wall.style,{position:'relative',height:'8000px',width:'600px'});
  for(let i=0;i<160;i++){
   const card=document.createElement('div');card.className='card virtualScrollItem';card.id='virtual-card-'+i;
   Object.assign(card.style,{position:'absolute',top:Math.floor(i/4)*200+'px',left:(i%4)*140+'px',width:'120px'});
   const content=document.createElement('fixture-card-content');Object.assign(content.style,{display:'block',height:'180px'});card.append(content);wall.append(card);
  }
  libraryRoot.append(wall);libraryRoot.style.overflow='auto';libraryRoot.scrollTop=1800;
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const visible=[...wall.children].find(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;});
  const live=visible.getBoundingClientRect().toJSON();TigerestHomeTransitions.invalidate(false);window.cardContentCopies=0;
  await TigerestHomeTransitions.prewarm();
  const shadow=document.querySelector('.tigerest-motion-cache').firstElementChild.shadowRoot;
  const result={constructed:window.cardContentCopies,visible:Math.ceil(innerHeight/200)*4,
   live,copy:shadow.querySelector('#'+visible.id).getBoundingClientRect().toJSON(),scroll:shadow.querySelector('#library').scrollTop,
   wallHeight:shadow.querySelector('#virtual-wall').getBoundingClientRect().height};
  wall.remove();libraryRoot.style.removeProperty('overflow');libraryRoot.scrollTop=0;return result;
 })()`);
 assert.ok(virtualCopy.constructed<=virtualCopy.visible+12,'absolute virtual cards outside the viewport must not copy their contents: '+JSON.stringify(virtualCopy));
 assert.equal(virtualCopy.scroll,1800);assert.equal(virtualCopy.wallHeight,8000);
 assert.ok(Math.max(...['x','y','width','height'].map(k=>Math.abs(virtualCopy.live[k]-virtualCopy.copy[k])))<1,'virtual poster geometry must survive pruning');
 // Emby's list scroller only scrolls with its linked stylesheet, which a copy
 // applies after it is attached. Its offset must survive that, or a return
 // home flies the empty top of the list instead of the cards on screen.
 const linkedScroll=await evaluate(`(async()=>{
  const link=document.createElement('link');link.rel='stylesheet';link.href='/scroller.css';
  await new Promise(r=>{link.onload=r;document.head.append(link);});
  const scroller=document.createElement('div');scroller.id='linked-scroller';scroller.className='linked-scroller';
  const content=document.createElement('div');content.style.height='2000px';scroller.append(content);libraryRoot.append(scroller);scroller.scrollTop=500;
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  TigerestHomeTransitions.invalidate(false);await TigerestHomeTransitions.prewarm();
  const shadow=document.querySelector('.tigerest-motion-cache').firstElementChild.shadowRoot,copy=shadow.querySelector('link[href$="/scroller.css"]');
  if(!copy.sheet)await new Promise(r=>copy.addEventListener('load',r,{once:true}));
  await new Promise(r=>requestAnimationFrame(r));
  const result={live:scroller.scrollTop,copy:shadow.querySelector('#linked-scroller').scrollTop};
  scroller.remove();link.remove();TigerestHomeTransitions.invalidate(false);return result;
 })()`);
 assert.deepEqual(linkedScroll,{live:500,copy:500},'a copy keeps the offset of a scroller styled by a linked stylesheet');
 await evaluate('TigerestHomeTransitions.prewarm()');
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
 const returnClickVisibility=await evaluate(`window.returnGate=true;window.returning=router.back();window.returnShrinkFrame=motionFrame(()=>{const n=document.querySelector('.tigerest-motion-poster');return n&&n.getBoundingClientRect().width<239.9;});const card=document.querySelector('#detail .detailImageContainer'),first=getComputedStyle(card).visibility;let frames=0;motionFrame(()=>++frames&&getComputedStyle(card).visibility==='hidden'&&{first,frames})`);
 // Hidden in the click frame, the card left an empty slot until its copy was drawn.
 assert.ok(returnClickVisibility.first==='visible'&&returnClickVisibility.frames<=3,'CSS-background posters are hidden under their moving copy once it is drawn: '+JSON.stringify(returnClickVisibility));
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
 const firstPosterFrame=await evaluate(`(()=>{window.originalBitmap=createImageBitmap;window.coldDecoders=[];window.createImageBitmap=(...args)=>new Promise(resolve=>coldDecoders.push(()=>originalBitmap(...args).then(resolve)));TigerestHomeTransitions.invalidate();window.clickedPosterRect=libraryRoot.querySelector('img').getBoundingClientRect().toJSON();press();window.coldStart=performance.now();window.cold=router.showItem('work');window.coldStarted=motionFrame(()=>{const n=document.querySelector('.tigerest-motion-lens'),veil=document.querySelector('.tigerest-motion-veil'),p=document.querySelector('.tigerest-motion-poster'),rect=p?.getBoundingClientRect();const moved=rect&&Math.max(...['x','y','width','height'].map(k=>Math.abs(rect[k]-clickedPosterRect[k])))>.25;return n&&+getComputedStyle(n).opacity>0&&moved&&coldDecoders.length?{present:true,opacity:+getComputedStyle(n).opacity,veil:+getComputedStyle(veil).opacity,copies:document.querySelectorAll('.tigerest-motion-frozen').length,old:state.params.topParentId==='library',poster:rect.toJSON(),elapsedMs:performance.now()-coldStart}:null;});return document.querySelector('.tigerest-motion-poster').getBoundingClientRect().toJSON()})()`);
 const clickedPoster=await evaluate('clickedPosterRect');
 assert.ok(Math.max(...['x','y','width','height'].map(k=>Math.abs(firstPosterFrame[k]-clickedPoster[k])))<1,'the floating poster starts exactly at the clicked poster');
 const started=await evaluate('coldStarted');
 assert.ok(started.present&&started.opacity>0&&started.old,'cold background preparation does not prevent the animation from starting: '+JSON.stringify(started));
 assert.ok(started.veil===0&&started.copies===0,'a cold click blurs the live page instead of copying it, and keeps the dark veil until the raster covers it: '+JSON.stringify(started));
 const earlyPoster=started.poster;
 // Same measure as the observer: at 240 Hz the first moving frame may change only the height by more than .25 px.
 assert.ok(Math.max(...['x','y','width','height'].map(k=>Math.abs(earlyPoster[k]-clickedPoster[k])))>.25,'the poster itself moves promptly while the cold background is still preparing: '+JSON.stringify(earlyPoster));
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
 await evaluate('motionFrame(()=>!!window.releaseNoRaster)');
 assert.ok(await evaluate(`(()=>{const n=document.querySelector('.tigerest-motion-veil');return +getComputedStyle(n).opacity>.99&&getComputedStyle(n).backgroundColor==='rgb(11, 13, 18)'})()`),'the DOM fallback covers its blur borders before the real route changes');
 assert.equal(await evaluate('state.params.topParentId'),'library');
 await evaluate('releaseNoRaster();true');await evaluate(`noRaster.then(()=>{window.Worker=savedWorker;show('library')})`);

 // Background image decoding must stop when a navigation that does not use
 // that raster begins, rather than continuing through its animation frames.
 for(const kind of ['library','homeReturn']){
  const cancelledWarm=await evaluate(`(async()=>{
   TigerestHomeTransitions.invalidate(false);const original=TigerestHomeBackdrop.build;let signal;
   TigerestHomeBackdrop.build=(root,s)=>{signal=s;return new Promise(resolve=>s.addEventListener('abort',()=>resolve(null),{once:true}));};
   const warm=TigerestHomeTransitions.prewarm();await motionFrame(()=>!!signal);
   const transition=${kind==='library'?"TigerestHomeTransitions.library({gallery:{active:true,root:libraryRoot},navigate:()=>{}})":"TigerestHomeTransitions.homeReturn({navigate:()=>{},findGallery:()=>null})"};
   const abortedAtStart=signal.aborted;TigerestHomeTransitions.cancel('fixture');
   await transition;await warm;TigerestHomeBackdrop.build=original;TigerestHomeTransitions.invalidate(false);
   return abortedAtStart;
  })()`);
  assert.equal(cancelledWarm,true,kind+' must abort unused in-flight background decoding before animating');
 }
 // Legacy Custom Elements v0 shims walk open shadow roots and upgrade nodes
 // by their `is` attribute. A static clone must not carry an upgrade-triggering attribute.
 const legacySnapshot = await evaluate(`(async()=>{
  const previous=window.CustomElements,previousInfo=window.jmpInfo,attachShadow=Element.prototype.attachShadow,roots=new WeakMap();
  window.CustomElements={useNative:false};window.jmpInfo={...previousInfo,platform:'ipad'};
  Element.prototype.attachShadow=function(options){const root=attachShadow.call(this,options);roots.set(this,root);return root;};
  const field=document.createElement('input');field.setAttribute('is','fixture-v0-input');field.id='v0-snapshot-input';libraryRoot.append(field);
  const scroller=document.createElement('div');scroller.id='v0-snapshot-scroll';scroller.style='width:200px;height:100px;overflow:auto';
  const content=document.createElement('div');content.style='width:600px;height:800px';scroller.append(content);libraryRoot.append(scroller);scroller.scrollLeft=60;scroller.scrollTop=180;
  let upgradedCopies=0;const seen=new WeakSet();
  const walk=root=>{for(const node of root.querySelectorAll('*')){if(node.shadowRoot)walk(node.shadowRoot);if(node.getAttribute('is')==='fixture-v0-input'&&node!==field&&!seen.has(node)){seen.add(node);upgradedCopies++;}}};
  const observer=new MutationObserver(()=>walk(document));observer.observe(document,{childList:true,subtree:true});
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  TigerestHomeTransitions.invalidate(false);await TigerestHomeTransitions.prewarm();
  await new Promise(r=>setTimeout(r,100));walk(document);
  const snapshot=document.querySelector('.tigerest-motion-cache').firstElementChild;
  const copy=roots.get(snapshot).querySelector('#v0-snapshot-scroll');copy.scrollLeft=copy.scrollTop=0;
  const transition=TigerestHomeTransitions.poster({source:libraryRoot.querySelector('img'),findTarget:()=>document.querySelector('#detail .detailImageContainer'),navigate:()=>show('detail')});
  const result={upgradedCopies,width:snapshot.getBoundingClientRect().width,scroll:[copy.scrollLeft,copy.scrollTop],promoted:!!snapshot.closest('.tigerest-motion-scene')};
  await transition;result.cacheHit=TigerestHomeTransitions.last.cacheHit;show('library');
  observer.disconnect();field.remove();scroller.remove();Element.prototype.attachShadow=attachShadow;window.CustomElements=previous;window.jmpInfo=previousInfo;TigerestHomeTransitions.invalidate(false);return result;
 })()`);
 assert.equal(legacySnapshot.upgradedCopies,0,'legacy component shims must not activate frozen controls');
 assert.ok(legacySnapshot.width>0,'isolated snapshots still participate in rendering');
 assert.equal(legacySnapshot.promoted,true,'iPad promotes the same snapshot into its scene');
 assert.equal(legacySnapshot.cacheHit,true);
 assert.deepEqual(legacySnapshot.scroll,[60,180],'cached iPad scenes restore scroll offsets in the sanitized snapshot');
 await evaluate('TigerestHomeMotion.reset()');assert.equal(await evaluate('TigerestHomeTransitions.cacheState.ready'),false,'account reset releases the cached background');
 await evaluate('TigerestHomeTransitions.prewarm()');await call('Emulation.setDeviceMetricsOverride',{width:900,height:700,deviceScaleFactor:1,mobile:false});assert.equal(await evaluate('TigerestHomeTransitions.cacheState.ready'),false,'viewport changes cannot use the old background');
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});assert.equal(await evaluate('TigerestHomeTransitions.prewarm()'),false);assert.equal(await evaluate('TigerestHomeTransitions.cacheState.bytes'),0);
 console.log('async background/cache fixture:',JSON.stringify({checks:'passed',hot,started,foreignMetric}));
},{gpu:true,visible:true}).catch(e=>{console.error(e);process.exitCode=1});
