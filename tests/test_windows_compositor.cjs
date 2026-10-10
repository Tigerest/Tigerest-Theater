// Real packaged application, production appearance and transition cache, local
// posters, and observed Windows client pixels. CDP screenshots cannot validate
// the WebEngine -> Qt -> desktop handoff that caused the historical corruption.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const withBrowser=require('./community_browser.cjs');
const capture=process.argv.find(a=>a.startsWith('--capture='))?.slice(10);
const output=path.resolve(process.argv.find(a=>a.startsWith('--output='))?.slice(9)||fs.mkdtempSync(path.join(os.tmpdir(),'tigerest-compositor-evidence-')));
fs.mkdirSync(output,{recursive:true});
// A failed or interrupted rerun must never leave a previous passing report.
const report={passed:false,checkedAt:new Date().toISOString(),error:'Check did not complete',phases:[],manual:{passed:false,observedCorruption:null}};
const saveReport=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
saveReport();
assert.ok(process.platform==='win32'&&capture&&fs.existsSync(capture),'supply Windows compositor capture helper');
const colors=['#ff0000','#00ff00','#0000ff','#ffffff'];
const routes={};
const posters=Array.from({length:96},(_,i)=>`<div class="card portraitCard" data-id="work-${i}" data-color="${colors[i%4]}" tabindex="0"><div class="cardBox"><div class="cardImageContainer"><img class="cardImage" src="/poster-${i%4}.svg"></div><div class="cardText">作品 ${i+1}</div></div></div>`).join('');
routes['/']={type:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><style>
body{margin:0;color:white;font:18px sans-serif;background:#172334}header{height:76px;display:flex;align-items:center;padding:0 30px;background:#263b4e}
.page{position:relative;padding:36px}.itemsContainer{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:32px}.card{position:relative}.cardBox{position:relative}.cardImageContainer{position:relative;aspect-ratio:2/3}.cardImage{width:100%;height:100%;object-fit:cover;display:block}.cardText{padding-top:12px;height:26px}
</style><body class="skinBody"><header class="skinHeader">媒体夹 · 海报墙</header><main id="library" class="page view-tv-tv"><div class="itemsContainer">${posters}</div></main></body>`};
colors.forEach((color,i)=>routes['/poster-'+i+'.svg']={type:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360"><rect width="240" height="360" fill="${color}"/><path d="M0 0H240V65H0zM0 300H240V360H0z" fill="#283748"/><circle cx="120" cy="32" r="18" fill="${color}"/></svg>`});

async function gpuInfo(port){
 const info=await(await fetch('http://127.0.0.1:'+port+'/json/version')).json();
 const socket=new WebSocket(info.webSocketDebuggerUrl);
 try{
  await new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('GPU socket timeout')),5000);socket.addEventListener('open',()=>{clearTimeout(timer);r();},{once:true});socket.addEventListener('error',j,{once:true});});
  return await new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('GPU information timeout')),5000);socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id!==1)return;clearTimeout(timer);m.error?j(Error(m.error.message)):r(m.result);});socket.send(JSON.stringify({id:1,method:'SystemInfo.getInfo'}));});
 }finally{socket.close();}
}

async function observe(pid,spec,name,duration,stimulate){
 const folder=path.join(output,name);fs.mkdirSync(folder,{recursive:true});
 const filename=path.join(folder,'samples.json');fs.writeFileSync(filename,JSON.stringify(spec,null,2));
 const child=spawn(path.resolve(capture),[String(pid),filename,folder,String(duration),'33'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
 const timeout=setTimeout(()=>child.kill(),duration+15000);
 try{
  if(stimulate)await stimulate();
  const code=await completion;
  assert.ok(stdout.trim(),'native observer did not return pixel evidence: '+stderr);
  const result=JSON.parse(stdout.trim());fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify(result,null,2));
  return {code,...result};
 }finally{clearTimeout(timeout);if(child.exitCode===null)child.kill();}
}

withBrowser(routes,async({evaluate,call,pid,profile,devToolsPort})=>{
 await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+15000;const wait=()=>{if(window.api?.window&&window.TigerestHomeMotion&&document.body.classList.contains('tigerest-appearance-ready'))return resolve();if(Date.now()>end)return reject(Error('production appearance did not load'));setTimeout(wait,30)};wait();})`);
 // Activate prewarming on the same library classes/routing contract as Emby.
 await evaluate(`window.state={params:{topParentId:'library'},contextPath:'/tv?topParentId=library'};const list=document.querySelector('.itemsContainer');list.getItemFromElement=e=>({Id:e.closest('[data-id]').dataset.id,Type:'Movie'});window.router={showItem:()=>{},back:()=>{},goHome:()=>{},getRouteUrl:()=>'/tv?topParentId=library'};TigerestHomeMotion.attach({router,pageJs:{replace:()=>{}},manager:{currentApiClient:()=>({serverId:()=> 'fixture',getCurrentUserId:()=> 'fixture'})},viewManager:{currentViewInfo:()=>state}});`);
 await evaluate(`Promise.all(Array.from(document.images).map(i=>i.decode())).then(()=>new Promise(r=>setTimeout(r,1800)))`);
 const gpu=await gpuInfo(devToolsPort);
 const renderer=gpu.gpu.auxAttributes.glRenderer;
 assert.match(gpu.gpu.featureStatus.gpu_compositing,/^enabled/,'software rendering cannot validate the shared GPU texture path');
 assert.match(renderer,/Direct3D11/);
 assert.doesNotMatch(gpu.commandLine,/(?:^|\s)--disable-gpu(?:\s|$)/);
 Object.assign(report,{exe:path.resolve(process.argv[2]),renderer,hardware:!/SwiftShader|WARP|Microsoft Basic Render/i.test(renderer)});
 fs.writeFileSync(path.join(output,'gpu.json'),JSON.stringify(gpu.gpu,null,2));
 const spec=()=>evaluate(`({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,samples:Array.from(document.querySelectorAll('.card')).filter(c=>{const r=c.querySelector('img').getBoundingClientRect();return r.top>90&&r.bottom<innerHeight-20}).map(c=>{const r=c.querySelector('img').getBoundingClientRect();return {name:c.dataset.id,color:c.dataset.color,x:r.x+r.width/2-7,y:r.y+r.height/2-7,width:14,height:14}})})`);
 const raise=()=>evaluate('new Promise(r=>api.window.raiseWindow(r))');
 await raise();await delay(400);
 // Wrong expected color is a negative control of the *displayed* pixels.
 const wrong=await spec();assert.ok(wrong.samples.length>=4,'enough complete posters are actually visible');
 wrong.samples[0].color='#000000';
 const negative=await observe(pid,wrong,'negative-control',0);
 assert.equal(negative.error,'','negative control had invalid capture prerequisites');
 assert.ok(negative.code!==0&&negative.damagedFrames>0,'pixel observer must reject a deliberately wrong visible poster');
 report.negativeControl=negative;
 report.webEngineCore=negative.webEngineCore;
 assert.ok(report.webEngineCore&&fs.existsSync(report.webEngineCore),'actual loaded WebEngine runtime must be recorded');
 for(const [name,scroll,fullscreen] of [['wall-windowed',0,false],['wall-scrolled',350,false],['wall-fullscreen',0,true]]){
  await raise();await delay(300);
  await evaluate(`new Promise(r=>api.window.setFullScreen(${fullscreen},r))`);
  // NVIDIA's fullscreen toast is an external overlay on the displayed surface.
  // Keep its initial announcement out of the pixel verdict; never turn it off
  // or accept the occluded frame as a successful application sample.
  await delay(fullscreen?7000:500);await evaluate(`scrollTo(0,${scroll});TigerestHomeTransitions.prewarm();true`);await delay(1000);
  assert.equal(await evaluate('new Promise(r=>api.window.isFullScreen(r))'),fullscreen,'actual fullscreen state for '+name);
  const samples=await spec();assert.ok(samples.samples.length>=4,'visible posters for '+name);
  await evaluate(`window.fixtureMoves=0;window.fixtureMoveListener=()=>fixtureMoves++;addEventListener('pointermove',fixtureMoveListener,{passive:true});true`);
  const start=performance.now();let sentMoves=0;
  const result=await observe(pid,samples,name,8000,async()=>{
   while(performance.now()-start<8000){
    // Bound the in-flight batch while avoiding a round-trip per mouse event.
    const batch=Array.from({length:8},()=>{const move=sentMoves++,p=samples.samples[Math.floor(move/5)%samples.samples.length];return call('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+7+Math.sin(move)*45,y:p.y+7+Math.cos(move)*24});});
    await Promise.all(batch);await delay(3);
   }
  });
  const moves=await evaluate(`removeEventListener('pointermove',fixtureMoveListener);fixtureMoves`);
  assert.equal(result.error,'','invalid actual-window capture in '+name+': '+result.error);
  assert.equal(result.webEngineCore,report.webEngineCore,'the same loaded runtime was observed in '+name);
  assert.equal(result.damagedFrames,0,'unexpected displayed pixels in '+name+'; inspect evidence: '+path.join(output,name));
  assert.ok(result.frames>=40&&moves>=100,'enough actual displayed frames and mouse events');
  report.phases.push({name,moves,sentMoves,...result});
 }
 const logFiles=fs.readdirSync(path.join(profile,'profiles')).map(id=>path.join(profile,'profiles',id,'logs','Tigerest Theater.log'));
 const log=logFiles.filter(f=>fs.existsSync(f)).map(f=>fs.readFileSync(f,'utf8')).join('\n');
 assert.match(log,/D3D11 producer wait: completed=1, reset=0/);
 assert.doesNotMatch(log,/D3D11 producer wait failed/);
 report.coreSha256=require('node:crypto').createHash('sha256').update(fs.readFileSync(report.webEngineCore)).digest('hex');
 report.exeSha256=require('node:crypto').createHash('sha256').update(fs.readFileSync(report.exe)).digest('hex');
 report.passed=true;report.error='';saveReport();
 console.log('PASS: displayed Windows poster-wall pixel samples; '+JSON.stringify({hardware:report.hardware,renderer,phases:report.phases,output}));
},{gpu:true,visible:true,startupTimeout:30000}).catch(error=>{report.passed=false;report.error=error.message;saveReport();console.error(error);console.error('Pixel evidence: '+output);process.exitCode=1;});
