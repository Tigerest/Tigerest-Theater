// Shared prompt in a real browser with a Qt-shaped native boundary; no real installer is run.
const assert=require('node:assert/strict'),path=require('node:path');
const withBrowser=require('./community_browser.cjs');
withBrowser({
 '/':{type:'text/html',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/emby-layout.css"><style>body{margin:0;background:#141414;color:#eee;font:15px system-ui}.skinHeader{background:#171717}.headerTop,.headerLeft,.headerRight{display:flex;align-items:center}.headerTop{padding:10px 20px}.headerLeft{flex:1}.headerRight{margin-left:auto}.headerButton{box-sizing:border-box;min-width:44px;height:44px;border:0;background:transparent;color:inherit;font:inherit;padding:8px;white-space:nowrap}#origin{margin:30px}</style><body><main class="padded-top-page"><button id="origin">客户端设置</button></main><script>
 window.TigerestUpdate?.destroy();delete window.TigerestUpdate;
 window.calls=[];window.externalLinks=[];window.listeners=[];window.state={status:'idle',currentVersion:'2.4.1'};
 const system={openExternalUrl(url){externalLinks.push(url)},appUpdateChanged:{connect(fn){listeners.push(fn)},disconnect(fn){listeners=listeners.filter(f=>f!==fn)}},appUpdateState(cb){cb(state)}};
 for(const method of ['checkForUpdates','downloadAppUpdate','installAppUpdate','cancelAppUpdate','skipAppUpdate','deferAppUpdate'])system[method]=(...args)=>{const cb=args.pop();calls.push([method,...args]);cb?.()};
 window.apiPromise=Promise.resolve({system});window.emit=next=>{state={...state,...next};for(const fn of listeners)fn(state)};
 </script><script src="/update.js"></script></body>`},
 '/update.js':{path:path.resolve(__dirname,'../native/updatePlugin.js')},
 '/android.css':{type:'text/css',path:path.resolve(__dirname,'../android/app/src/main/assets/androidResponsive.css')},
 '/android.js':{path:path.resolve(__dirname,'../android/app/src/main/assets/androidResponsive.js')},
 // Emby 4.10's fixed header contract; an actual downloaded stylesheet may be supplied for release QA.
 '/emby-layout.css':process.env.TIGEREST_EMBY_LAYOUT_CSS ? {type:'text/css',path:process.env.TIGEREST_EMBY_LAYOUT_CSS} : {type:'text/css',body:':root{--header-height:5.527em}.skinHeader{position:fixed;top:0;left:0;right:0;box-sizing:border-box;height:var(--header-height);contain:strict;flex-wrap:wrap}.padded-top-page{padding-top:var(--header-height)}'}
},async({evaluate,call})=>{
 assert.equal(await evaluate('typeof window.TigerestUpdate'), 'object','startup prompt must exist before Emby login');
 await evaluate('TigerestUpdate.start()');await evaluate('TigerestUpdate.start()');
 assert.deepEqual(await evaluate('calls'),[['checkForUpdates',false]],'one startup request per page, native deduplicates per process');
 await evaluate(`emit({status:'current',manual:false});`);assert.equal(await evaluate('!!document.querySelector("#tigerest-update-dialog[open]")'),false,'silent when current');
 await evaluate(`emit({status:'error',error:'网络不可用',manual:false});`);assert.equal(await evaluate('!!document.querySelector("#tigerest-update-dialog[open]")'),false,'automatic network errors do not interrupt startup');
 await evaluate(`emit({status:'available',version:'2.5.0',size:1024,notes:'<img src=x onerror="window.unsafe=true">',error:'',manual:false,installLabel:'安装更新'});`);
 const dialogOpen=()=>evaluate('!!document.querySelector("#tigerest-update-dialog[open]")');
 const actionLabels=()=>evaluate('[...document.querySelectorAll("#tigerest-update-dialog [data-update-action]")].map(node=>node.textContent)');
 assert.equal(await dialogOpen(),true,'a release found before the user acts prompts at startup');
 assert.deepEqual(await actionLabels(),['直接下载','忽略本次更新','稍后']);
 await evaluate('document.querySelector("[data-update-action=close]").click()');
 assert.deepEqual(await evaluate('calls.at(-1)'),['deferAppUpdate']);
 await evaluate(`emit({deferred:true});emit({deferred:false});`);
 assert.equal(await dialogOpen(),false,'the startup prompt shows once per document');
 assert.equal(await evaluate('document.querySelectorAll("#tigerest-update-button").length'),1,'one pre-login update entry');
 assert.equal(await evaluate('document.querySelector("[data-update-dot]").hidden'),false,'actionable update has a red dot');
 assert.ok(await evaluate('document.querySelector("#tigerest-update-button").getAttribute("aria-label").includes("2.5.0")'));
 await evaluate(`document.body.insertAdjacentHTML('afterbegin','<header class="skinHeader headerTop"><div class="headerLeft"><button class="headerButton">返回</button><button class="headerButton">首页</button><button class="headerButton">菜单</button></div><div class="headerRight"><button class="headerButton">消息</button><button class="headerButton">投屏</button><button class="headerButton">搜索</button><button class="headerButton" id="tigerest-window-mode-button">全屏</button><button class="headerButton" id="tigerest-mpv-settings-button">MPV</button><button class="headerButton headerUserButton">账户</button><button class="headerButton">设置</button></div></header>')`);
 await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
 assert.equal(await evaluate('document.querySelector("#tigerest-update-button").parentElement.className'),'headerRight','entry moves into the Emby header');
 await evaluate(`(()=>{const header=document.querySelector('.headerRight');const replacement=header.cloneNode(true);replacement.querySelector('#tigerest-update-button').remove();header.replaceWith(replacement)})()`);
 await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
 assert.equal(await evaluate('document.querySelectorAll("#tigerest-update-button").length'),1,'header replacement restores one entry');
 await evaluate('document.querySelector("#tigerest-update-button").click()');
 assert.equal(await evaluate('document.querySelector("#tigerest-update-dialog").open'),true,'entry opens the existing release without a second check');
 assert.equal(await evaluate('calls.filter(c=>c[0]==="checkForUpdates").length'),1);
 assert.equal(await evaluate('document.querySelector("#tigerest-update-dialog img")'),null,'release notes rendered as text');
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".tg-update-links a")].map(link=>({href:link.href,label:link.getAttribute("aria-label")}))'),[
  {href:'https://github.com/Tigerest/Tigerest-Theater',label:'GitHub 项目'},
  {href:'https://space.bilibili.com/12562485',label:'B站主页'}
 ],'project and creator links remain accessible in the dialog header');
 await evaluate('document.querySelectorAll(".tg-update-links a").forEach(link=>link.click())');
 assert.deepEqual(await evaluate('externalLinks'),['https://github.com/Tigerest/Tigerest-Theater','https://space.bilibili.com/12562485'],'links open through the native external browser bridge');
 await evaluate('document.querySelector("[data-update-action=close]").click()');
 assert.equal(await evaluate('document.querySelector("#tigerest-update-button").getAttribute("aria-expanded")'),'false','closed details are announced correctly');
 assert.equal(await evaluate('document.querySelector("[data-update-dot]").hidden'),false,'Later keeps the available update reachable');
 assert.deepEqual(await evaluate('calls.at(-1)'),['deferAppUpdate']);
 await evaluate(`emit({mirrors:{quark:'https://pan.quark.cn/s/abc123def',baidu:'https://pan.baidu.com/s/1AbCdEf?pwd=ab12'}});document.querySelector("#tigerest-update-button").click()`);
 assert.deepEqual(await actionLabels(),['直接下载','备用下载','夸克网盘','百度网盘','忽略本次更新','稍后'],'netdisk buttons follow the release mirrors');
 const backupShown=()=>evaluate('(()=>{const panel=document.querySelector("#tigerest-update-backup");return !panel.hidden&&panel.getClientRects().length>0&&document.querySelector("[data-update-action=backup]").getAttribute("aria-expanded")==="true"})()');
 assert.equal(await backupShown(),false,'netdisks start folded under 备用下载');
 assert.equal(await evaluate('document.querySelector("[data-update-action=baidu]").getClientRects().length'),0,'folded netdisk buttons are not visible');
 await evaluate('document.querySelector("[data-update-action=backup]").click()');
 assert.equal(await backupShown(),true,'备用下载 unfolds the netdisks');
 for(const width of [1100,360]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:740,deviceScaleFactor:1,mobile:width<500});
  const rows=await evaluate(`(()=>{const box=action=>document.querySelector('[data-update-action='+action+']').getBoundingClientRect(),bg=action=>getComputedStyle(document.querySelector('[data-update-action='+action+']')).backgroundColor;return {together:Math.abs(box('skip').top-box('close').top)<1,below:box('quark').top>=box('close').bottom,primary:bg('download'),skip:bg('skip'),backup:bg('backup')}})()`);
  assert.ok(rows.together&&rows.below&&rows.primary!==rows.skip&&rows.backup===rows.skip,'Ignore and Later stay on one row, netdisks sit below and only 直接下载 is primary at '+width+'px: '+JSON.stringify(rows));
 }
 await call('Emulation.clearDeviceMetricsOverride');
 await evaluate('document.querySelector("[data-update-action=baidu]").click()');
 assert.equal(await evaluate('externalLinks.at(-1)'),'https://pan.baidu.com/s/1AbCdEf?pwd=ab12','without native folder lookup the share opens through the external opener');
 await evaluate(`apiPromise.then(api=>{api.system.openAppUpdateMirror=(...args)=>{const cb=args.pop();calls.push(['openAppUpdateMirror',...args]);cb?.()}})`);
 const links=await evaluate('externalLinks.length');
 await evaluate('document.querySelector("[data-update-action=quark]").click()');
 assert.deepEqual(await evaluate('calls.at(-1)'),['openAppUpdateMirror','quark'],'native code opens the version folder');
 assert.equal(await evaluate('externalLinks.length'),links,'the share itself is not opened as well');
 assert.ok(await evaluate('document.querySelector("#tigerest-update-dialog").textContent.includes("从网盘下载安装包")'));
 await evaluate(`emit({mirrors:{quark:'javascript:alert(1)'}})`);
 assert.deepEqual(await actionLabels(),['直接下载','忽略本次更新','稍后'],'only https mirrors are offered');
 await evaluate(`emit({mirrors:{}});document.querySelector("[data-update-action=close]").click()`);
 await evaluate(`emit({status:'available',deferred:true});`);
 assert.equal(await evaluate('document.querySelector("#tigerest-update-dialog").open'),false,'Later survives state replay without persisting skip');
 await evaluate(`emit({status:'available',deferred:false});`);
 await evaluate('document.querySelector("#tigerest-update-button").click()');
 await evaluate('document.querySelector("[data-update-action=skip]").click()');
 assert.deepEqual(await evaluate('calls.at(-1)'),['skipAppUpdate']);
 assert.equal(await evaluate('document.querySelector("#tigerest-update-dialog").open'),false);
 assert.equal(await evaluate('document.querySelector("[data-update-dot]").hidden'),true,'skip removes the actionable indicator immediately');
 await evaluate('TigerestUpdate.check()');assert.deepEqual(await evaluate('calls.at(-1)'),['checkForUpdates',true]);
 await evaluate(`emit({status:'available',manual:true});document.querySelector('[data-update-action=download]').click()`);
 assert.deepEqual(await evaluate('calls.at(-1)'),['downloadAppUpdate']);
 await evaluate(`emit({status:'downloading',received:512,speed:2048,source:'gh-proxy.com'});`);
 assert.equal(await evaluate('document.querySelector("#tigerest-update-dialog progress").value'),50);
 assert.ok(await evaluate('document.querySelector("#tigerest-update-dialog").textContent.includes("2.0 KB/s · 来源 gh-proxy.com")'),'download speed and source are visible');
 await evaluate(`emit({retrying:true,retryAttempt:2,retryLimit:5,retryDelay:5,source:'ghproxy.net'});`);
 assert.ok(await evaluate('document.querySelector("#tigerest-update-dialog").textContent.includes("第 2/5 次自动重试（ghproxy.net）")'),'native retry budget and next source are visible');
 await evaluate(`emit({platform:'android',retrying:false,source:''});`);
 assert.equal(await evaluate('document.querySelector("[data-update-action=cancel]").textContent'),'暂停下载','Android keeps a paused partial');
 await evaluate(`emit({status:'available',resumable:true,retrying:false});`);
 assert.equal(await evaluate('document.querySelector("[data-update-action=download]").textContent'),'继续下载');
 await evaluate(`emit({status:'downloading',resumable:false,retrying:false});`);
 await evaluate(`emit({status:'ready',received:1024});`);
 assert.deepEqual(await evaluate('calls.at(-1)'),['installAppUpdate',true],'one click downloads then opens installer');
 await evaluate(`emit({status:'ready',error:'系统安装已取消'});`);
 assert.equal(await evaluate('calls.filter(c=>c[0]==="installAppUpdate").length'),1,'installer cancellation must not loop');
 assert.ok(await evaluate('document.querySelector("#tigerest-update-dialog").textContent.includes("系统安装已取消")'));
 await evaluate(`emit({status:'installing',autoRestart:true,error:''})`);
 assert.ok(await evaluate('(()=>{const text=document.querySelector("#tigerest-update-dialog").textContent;return text.includes("正在安装更新")&&text.includes("自动重新打开")})()'),'a silent Windows install explains that the app closes and reopens');
 await evaluate(`emit({status:'ready',autoRestart:false})`);
 await evaluate(`emit({status:'ready',installAfterDownload:true});emit({status:'ready',installAfterDownload:true});`);
 assert.equal(await evaluate('calls.filter(c=>c[0]==="installAppUpdate").length'),2,'native session retains one-click intent after document replacement');
 await evaluate(`emit({status:'ready',installAfterDownload:false});`);
 await evaluate(`emit({status:'downloading',received:100,mirrors:{quark:'https://pan.quark.cn/s/abc123def'}});emit({status:'error',error:'无法获取更新'})`);
 assert.equal(await backupShown(),true,'a failed download unfolds 备用下载');
 await evaluate(`document.querySelector('[data-update-action=backup]').click();emit({error:'仍无法获取更新'})`);
 assert.equal(await backupShown(),false,'the user can fold it again after the failure');
 await evaluate(`emit({mirrors:{}})`);
 await evaluate(`emit({status:'error',error:'下载校验失败'});document.querySelector('[data-update-action=download]').click()`);
 assert.deepEqual(await evaluate('calls.at(-1)'),['downloadAppUpdate']);
 await evaluate(`emit({status:'downloading',received:100});document.querySelector('[data-update-action=cancel]').click()`);
 assert.deepEqual(await evaluate('calls.at(-1)'),['cancelAppUpdate']);
 await evaluate(`emit({status:'ready'});`);assert.equal(await evaluate('calls.filter(c=>c[0]==="installAppUpdate").length'),2,'cancel prevents delayed auto-install');
 await evaluate(`emit({status:'downloading',received:256});document.querySelector('[data-update-action=close]').click();emit({status:'downloading',received:512});`);
 assert.equal(await evaluate('document.querySelector("#tigerest-update-dialog").open'),false,'background progress stays closed');
 await evaluate('document.querySelector("#tigerest-update-button").click()');
 assert.equal(await evaluate('document.querySelector("#tigerest-update-dialog progress").value'),50,'entry reopens live progress');
 await call('Emulation.setDeviceMetricsOverride',{width:360,height:740,deviceScaleFactor:1,mobile:true});
 await evaluate(`new Promise(resolve=>{const css=document.createElement('link');css.rel='stylesheet';css.href='/android.css';css.onload=resolve;document.head.appendChild(css)})`);
 await evaluate(`new Promise(resolve=>{const js=document.createElement('script');js.src='/android.js';js.onload=resolve;document.head.appendChild(js)})`);
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'narrow phone fits');
 await evaluate(`emit({status:'installing'});`);
 const dialogGeometry=await evaluate(`(()=>{const dialog=document.querySelector('#tigerest-update-dialog'),title=dialog.querySelector('h2').getBoundingClientRect(),links=dialog.querySelector('.tg-update-links').getBoundingClientRect();return {fits:dialog.scrollWidth<=dialog.clientWidth,overlap:title.right>links.left+1,inside:links.right<=dialog.getBoundingClientRect().right}})()`);
 assert.deepEqual(dialogGeometry,{fits:true,overlap:false,inside:true},'long update status and icons fit the phone dialog without overlap');
 await evaluate('TigerestUpdate.close()');
 const headerGeometry=await evaluate(`(()=>{const left=document.querySelector('.headerLeft').getBoundingClientRect(),right=document.querySelector('.headerRight').getBoundingClientRect();return {width:document.documentElement.scrollWidth,overlap:left.right>right.left+1&&left.top<right.bottom&&left.bottom>right.top}})()`);
 assert.ok(headerGeometry.width<=360,'full phone header fits the actual 360px viewport: '+JSON.stringify(headerGeometry));
 assert.equal(headerGeometry.overlap,false,'navigation and action groups do not overlap');
 const overlappingButtons=await evaluate(`(()=>{const buttons=[...document.querySelectorAll('.headerTop button')].filter(node=>node.getClientRects().length).map(node=>({label:node.id||node.textContent,rect:node.getBoundingClientRect()})),pairs=[];for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++){const a=buttons[i].rect,b=buttons[j].rect;if(a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1)pairs.push([buttons[i].label,buttons[j].label])}return pairs})()`);
 assert.deepEqual(overlappingButtons,[],'actual header buttons remain separately reachable');
 assert.equal(await evaluate('document.querySelector("#origin").getBoundingClientRect().top>=document.querySelector(".skinHeader").getBoundingClientRect().bottom'),true,'page content clears the entire wrapped header');
 assert.equal(await evaluate('[...document.querySelectorAll(".headerTop button")].filter(node=>node.getClientRects().length).every(node=>node.getBoundingClientRect().bottom<=document.querySelector(".skinHeader").getBoundingClientRect().bottom)'),true,'Emby strict containment does not clip the second row');
 await evaluate(`document.querySelector('.skinHeader').insertAdjacentHTML('beforeend','<div class="headerTabs" style="height:42px;flex-basis:100%">主页　媒体库</div>')`);
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 assert.equal(await evaluate('document.querySelector("#origin").getBoundingClientRect().top>=document.querySelector(".skinHeader").getBoundingClientRect().bottom'),true,'new Emby tabs also propagate their header height to page padding');
 if(process.env.TIGEREST_UPDATE_SCREENSHOTS){
  await evaluate(`emit({status:'available',deferred:false,version:'2.4.3',currentVersion:'2.4.2',size:78046671,error:'',notes:'设置页跟随 Emby 的分类与表单样式。\\n更新提醒收进右上角，点开后可下载并安装。'});`);
  const fs=require('node:fs');
  fs.mkdirSync(process.env.TIGEREST_UPDATE_SCREENSHOTS,{recursive:true});
  fs.writeFileSync(path.join(process.env.TIGEREST_UPDATE_SCREENSHOTS,'updates-header-phone.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate('TigerestUpdate.open()');
  fs.writeFileSync(path.join(process.env.TIGEREST_UPDATE_SCREENSHOTS,'updates-phone.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await call('Emulation.setDeviceMetricsOverride',{width:1100,height:800,deviceScaleFactor:1,mobile:false});
  fs.writeFileSync(path.join(process.env.TIGEREST_UPDATE_SCREENSHOTS,'updates-desktop.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate('TigerestUpdate.close()');
  fs.writeFileSync(path.join(process.env.TIGEREST_UPDATE_SCREENSHOTS,'updates-header-desktop.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
 }
 await call('Emulation.setDeviceMetricsOverride',{width:1100,height:800,deviceScaleFactor:1,mobile:false});
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 assert.equal(await evaluate('document.documentElement.style.getPropertyValue("--header-height")'),'','expanded viewport restores Emby header sizing');
 await call('Emulation.setDeviceMetricsOverride',{width:360,height:740,deviceScaleFactor:1,mobile:true});
 await evaluate(`window.tigerestWindowMetrics={safeInsets:{top:28,right:0,bottom:20,left:0}};dispatchEvent(new Event('tigerest-window-changed'))`);
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 assert.equal(await evaluate('document.querySelector("#origin").getBoundingClientRect().top>=document.querySelector(".skinHeader").getBoundingClientRect().bottom'),true,'system top inset is included in content clearance');
 await evaluate('document.querySelector(".skinHeader").remove()');
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 assert.equal(await evaluate('document.querySelectorAll("#tigerest-update-button").length'),1,'header removal returns to one onboarding entry');
 assert.equal(await evaluate('document.querySelector("#tigerest-update-button").classList.contains("tg-update-fallback")'),true);
 assert.equal(await evaluate('document.documentElement.style.getPropertyValue("--header-height")'),'','removed header releases its layout override');
 await evaluate(`apiPromise.then(api=>{api.system.checkForUpdates=(manual,callback)=>{const p=Promise.reject(new Error('桥接请求失败'));p.then(callback,()=>callback(false));return p;}});`);
 await evaluate('TigerestUpdate.check()');
 assert.ok(await evaluate('document.querySelector("#tigerest-update-dialog").textContent.includes("桥接请求失败")'),'Android Promise rejection must reach the visible error instead of callback(false) hiding it');
 await evaluate(`emit({status:'available',currentVersion:'2.5.0',version:'2.5.0'})`);
 assert.equal(await evaluate('document.querySelector("[data-update-dot]").hidden'),true,'same version is not actionable');
 await evaluate(`emit({status:'available',currentVersion:'2.5.0',version:'2.5.0.1'})`);
 assert.equal(await evaluate('document.querySelector("[data-update-dot]").hidden'),false,'a fix release is newer than its base version');
 await evaluate(`emit({status:'available',currentVersion:'2.5.0.1',version:'2.5.0'})`);
 assert.equal(await evaluate('document.querySelector("[data-update-dot]").hidden'),true,'the base version is older than its fix release');
 await evaluate(`emit({status:'available',currentVersion:'2.5.0.1',version:'2.5.0.10'})`);
 assert.equal(await evaluate('document.querySelector("[data-update-dot]").hidden'),false,'fix numbers compare numerically');
 // The build number sits under the version, and is left out when the native side has none.
 await evaluate(`window.jmpInfo={buildNumber:'2090501 · 1a2b3c4d'};emit({status:'current',version:'',currentVersion:'2.5.0.1'});TigerestUpdate.check()`);
 assert.ok(await evaluate('document.querySelector("#tigerest-update-dialog").textContent.includes("当前版本 2.5.0.1\\n构建号 2090501 · 1a2b3c4d")'),'the update page shows the build number');
 await evaluate(`delete window.jmpInfo;emit({status:'current'})`);
 assert.ok(await evaluate('!document.querySelector("#tigerest-update-dialog").textContent.includes("构建号")'),'no build number line without one');
 // New documents: a check finishing after the user acts waits for the next launch,
 // where the remembered (cached) release prompts even after an early keypress.
 const relaunch=async()=>{
  await evaluate(`TigerestUpdate.destroy();delete window.TigerestUpdate;window.listeners=[];window.calls=[];window.state={status:'idle',currentVersion:'2.4.1'};
   new Promise(resolve=>{const js=document.createElement('script');js.src='/update.js?'+calls.length+Math.random();js.onload=resolve;document.head.appendChild(js)})`);
  await evaluate('TigerestUpdate.start()');
  for(const type of ['rawKeyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16});
 };
 await relaunch();
 await evaluate(`emit({status:'available',version:'2.5.0',size:1024,manual:false,deferred:false,error:''})`);
 assert.equal(await dialogOpen(),false,'a check finishing after the user acts does not interrupt');
 assert.deepEqual(await evaluate('calls.at(-1)'),['deferAppUpdate'],'and stays quiet for the rest of this launch');
 await relaunch();
 await evaluate(`emit({status:'available',version:'2.5.0',size:1024,manual:false,deferred:false,cached:true,error:''})`);
 assert.equal(await dialogOpen(),true,'the remembered release prompts at the next launch');
 await evaluate('TigerestUpdate.destroy()');assert.equal(await evaluate('listeners.length'),0);
 assert.equal(await evaluate('document.querySelector("#tigerest-update-button")'),null);
 console.log('update UI: startup prompt once (cached or before interaction), netdisk mirrors under 备用下载, red dot, header replacement, skip/manual, text safety, progress, install-once, retry/cancel and narrow layout passed');
// Qt does not tick animation frames when launched with windowsHide, even while document.hidden is false.
},{visible:true}).catch(e=>{console.error(e);process.exitCode=1});
