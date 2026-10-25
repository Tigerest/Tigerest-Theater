const assert=require('node:assert/strict'),path=require('node:path'),withBrowser=require('./community_browser.cjs');
const root=path.resolve(__dirname,'..');
const embedded=process.argv.includes('--webengine')||Boolean(process.env.TIGEREST_ANDROID_FIXTURE);
// A series page with landscape episode cards (one episode also appears in a
// "next up" row above its season) and an episode page with its large still.
const page=`<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#101722;color:white;font:18px sans-serif}.page{position:fixed;inset:0;padding:40px;box-sizing:border-box;background:linear-gradient(120deg,#34495c,#101722)}.hide{display:none}
.itemsContainer{display:flex;gap:16px;margin:12px 0}.cardImageContainer{width:240px;height:135px;border-radius:8px;overflow:hidden}.cardImage{width:100%;height:100%;object-fit:cover;display:block}
#series .detailImageContainer{width:120px;height:180px}#episode .detailImageContainer{width:480px;height:270px;margin:30px 0 0 60px}#episode .detailImageContainer img{width:100%;height:100%;object-fit:cover}</style>
<div class="page view-item-item" id="series"><div class="detailImageContainer"><img src="/thumb.svg" style="width:100%;height:100%;object-fit:cover"></div><h2>下一集</h2><div class="itemsContainer" id="next"><div class="card" data-id="ep2"><div class="cardImageContainer"><img class="cardImage" src="/thumb.svg"></div></div></div>
<h2>第 1 季</h2><div class="itemsContainer" id="season"><div class="card" data-id="ep1"><div class="cardImageContainer"><img class="cardImage" src="/thumb.svg"></div></div><div class="card" data-id="ep2"><div class="cardImageContainer"><img class="cardImage" src="/thumb.svg"></div></div></div></div>
<div class="page view-item-item hide" id="episode"><div class="detailImageContainer"><img class="cardImage" src="/thumb.svg"></div><h1>第 2 集</h1></div>
<script src="/transitions.js"></script><script src="/motion.js"></script>`;
const routes={
 '/':{type:'text/html',body:embedded?page.replace('<script src="/transitions.js"></script><script src="/motion.js"></script>',''):page},
 '/thumb.svg':{type:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#2f5d7c"/><circle cx="330" cy="120" r="70" fill="#e3c28f"/></svg>'},
 '/transitions.js':{path:path.join(root,'native/homeTransitions.js')},'/motion.js':{path:path.join(root,'native/homeMotion.js')}
};
withBrowser(routes,async({evaluate,call})=>{
 const software=await withBrowser.softwareRenderer(evaluate);
 if(software){console.log('SKIP: frame-precise motion needs a hardware GPU ('+software+')');process.exitCode=withBrowser.SKIP_CODE;return;}
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await evaluate(`window.fixture={state:{params:{id:'series'},contextPath:'/item?id=series'},show(name,id){document.querySelectorAll('.page').forEach(p=>p.classList.toggle('hide',p.id!==name));this.state.params={id};this.state.contextPath='/item?id='+id;},
  route(name,id){return new Promise(resolve=>setTimeout(()=>{this.show(name,id);resolve();},120));}};
  window.router={showItem:item=>fixture.route('episode',item.Id),back:()=>fixture.route('series','series'),goHome:()=>{},getRouteUrl:()=>'/library'};
  document.querySelectorAll('.itemsContainer').forEach(list=>list.getItemFromElement=card=>({Id:card.dataset.id,Type:'Episode'}));
  TigerestHomeMotion.attach({router,pageJs:{replace:()=>{}},manager:{currentApiClient:()=>({serverId:()=> 'fixture',getCurrentUserId:()=> 'one'})},viewManager:{currentViewInfo:()=>fixture.state}});
  // Record the floating poster's first and last rectangles of each flight.
  // Slow software rendering can drop the frame after the last sample: read the final
  // rectangle again just before the flight layer is removed.
  window.flights=[];const tracked=[],remove=Element.prototype.remove;
  Element.prototype.remove=function(){for(const [flight,node] of tracked)if(node.isConnected&&this.contains(node))flight.last=node.getBoundingClientRect().toJSON();return remove.call(this);};
  new MutationObserver(records=>records.forEach(r=>r.addedNodes.forEach(added=>{const node=added.querySelector?.('.tigerest-motion-poster');if(!node)return;
   const flight={first:node.getBoundingClientRect().toJSON(),last:null};flights.push(flight);tracked.push([flight,node]);
   const sample=()=>{if(!node.isConnected)return;flight.last=node.getBoundingClientRect().toJSON();requestAnimationFrame(sample);};sample();}))).observe(document.body,{childList:true});
  true`);
 await evaluate(`Promise.all(Array.from(document.images,i=>i.decode().catch(()=>{})))`);
 const pressed=await evaluate(`(()=>{const image=document.querySelector('#season [data-id="ep2"] img');image.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));window.opening=router.showItem({Id:'ep2',Type:'Episode'});return image.getBoundingClientRect().toJSON();})()`);
 await evaluate('opening');
 const opened=await evaluate(`({metric:TigerestHomeTransitions.last,flight:flights.at(-1),target:document.querySelector('#episode .detailImageContainer img').getBoundingClientRect().toJSON(),
  leaks:document.querySelectorAll('.tigerest-motion-layer,.tigerest-motion-poster,[data-tigerest-poster-held]').length,busy:TigerestHomeTransitions.busy,id:fixture.state.params.id,entry:TigerestHomeMotion.entry?.itemId})`);
 const near=(a,b)=>Math.max(...['x','y','width','height'].map(k=>Math.abs(a[k]-b[k])));
 assert.equal(opened.id,'ep2');assert.equal(opened.busy,false);assert.equal(opened.leaks,0,'no transition layer remains');
 assert.ok(opened.flight,'pressing an episode thumbnail starts a poster flight');
 assert.ok(near(opened.flight.first,pressed)<1,'the flight starts from the pressed thumbnail: '+JSON.stringify(opened.flight.first));
 assert.ok(opened.metric.kind==='poster'&&!opened.metric.fallback&&opened.metric.landingErrorPx<2,'the thumbnail lands on the episode still: '+JSON.stringify(opened.metric));
 assert.ok(near(opened.flight.last,opened.target)<2,'last poster frame covers the episode still');
 assert.equal(opened.entry,'ep2');
 await evaluate('router.back()');
 const returned=await evaluate(`({metric:TigerestHomeTransitions.last,flight:flights.at(-1),pressed:document.querySelector('#season [data-id="ep2"] img').getBoundingClientRect().toJSON(),
  first:document.querySelector('#next [data-id="ep2"] img').getBoundingClientRect().toJSON(),leaks:document.querySelectorAll('.tigerest-motion-layer,.tigerest-motion-poster,[data-tigerest-poster-held]').length,
  id:fixture.state.params.id,entry:TigerestHomeMotion.entry,flights:flights.length})`);
 assert.equal(returned.id,'series');assert.equal(returned.leaks,0);assert.equal(returned.flights,2,'one flight each way');
 assert.ok(returned.metric.kind==='poster'&&!returned.metric.fallback&&returned.metric.landingErrorPx<2,'the still flies back: '+JSON.stringify(returned.metric));
 assert.ok(near(returned.flight.last,returned.pressed)<2&&near(returned.flight.last,returned.first)>20,'the return lands on the pressed season card, not the earlier next-up card');
 assert.equal(returned.entry,null,'no return flight is invented for a series page opened elsewhere');
 // Below 50em Emby hides the episode's own image and shows the still only as
 // the page's top backdrop. The thumbnail lands there and flies back from it.
 await evaluate(`(()=>{const episode=document.querySelector('#episode');episode.querySelector('.detailImageContainer').style.display='none';
  episode.insertAdjacentHTML('afterbegin','<div class="itemBackdropContainer" style="position:relative;height:300px"><div class="itemBackdrop" style="position:absolute;inset:60px 0 0;background:url(/thumb.svg) center/cover"></div></div>');
  const image=document.querySelector('#season [data-id="ep1"] img');image.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));window.opening=router.showItem({Id:'ep1',Type:'Episode'});return true;})()`);
 await evaluate('opening');
 const compact=await evaluate(`({metric:TigerestHomeTransitions.last,flight:flights.at(-1),target:document.querySelector('#episode .itemBackdrop').getBoundingClientRect().toJSON(),id:fixture.state.params.id})`);
 assert.equal(compact.id,'ep1');
 assert.ok(compact.metric.kind==='poster'&&!compact.metric.fallback&&compact.metric.landingErrorPx<2,'the thumbnail lands on the compact backdrop: '+JSON.stringify(compact.metric));
 assert.ok(near(compact.flight.last,compact.target)<2,'last poster frame covers the backdrop still: '+JSON.stringify({last:compact.flight.last,target:compact.target}));
 await evaluate('router.back()');
 const back=await evaluate(`({metric:TigerestHomeTransitions.last,flight:flights.at(-1),pressed:document.querySelector('#season [data-id="ep1"] img').getBoundingClientRect().toJSON(),
  leaks:document.querySelectorAll('.tigerest-motion-layer,.tigerest-motion-poster,[data-tigerest-poster-held]').length,id:fixture.state.params.id})`);
 assert.equal(back.id,'series');assert.equal(back.leaks,0);
 assert.ok(back.metric.kind==='poster'&&!back.metric.fallback&&near(back.flight.last,back.pressed)<2,'the backdrop still flies back to its card: '+JSON.stringify(back.metric));
 console.log('episode motion fixture:',JSON.stringify({opened:opened.metric.landingErrorPx,returned:returned.metric.landingErrorPx,compact:compact.metric.landingErrorPx,compactReturn:back.metric.landingErrorPx}));
},{gpu:true,visible:true}).catch(error=>{console.error(error);process.exitCode=1;});
