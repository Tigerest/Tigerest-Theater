// Real settings renderer/controllers; Emby navigation and native persistence are boundary doubles.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const withBrowser=require('./community_browser.cjs');
const shell=fs.readFileSync(path.resolve(__dirname,'../native/nativeshell.js'),'utf8');
const renderer=shell.slice(shell.indexOf('function createRifeExtensionPanel('),shell.indexOf('window.tigerestMountSettings ='));
const catalog=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../resources/settings/settings_description.json'),'utf8'));
const sections=catalog.filter(s=>!s.hidden && s.order && s.values);
const descriptions={},defaults={};
// Optional local copy of Emby's own font, for screenshots without a live server.
const iconFont=process.env.TIGEREST_SETTINGS_ICON_FONT;
for(const section of sections){
 const values=section.values.filter(v=>!v.hidden && (!v.platforms || v.platforms.includes('windows')) && !v.platforms_excluded?.includes('windows'));
 descriptions[section.section]=values.map(v=>({key:v.value,displayName:v.display_name||v.value,help:v.help||'',inputType:v.input_type,options:v.possible_values?.map(o=>({value:o[0],title:String(o[1])}))}));
 defaults[section.section]=Object.fromEntries(values.map(v=>[v.value,v.default]));
}
withBrowser({
 ...(iconFont?{'/emby-material-icons.woff2':{type:'font/woff2',path:path.resolve(iconFont)}}:{}),
 '/':{type:'text/html',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
 body{margin:0;background:#141414;color:#eee;font:16px system-ui}#origin{margin:20px}#host{margin:30px auto;max-width:1100px}.view{margin-left:260px}
 .mainDrawer{position:fixed;inset:0 auto 0 0;width:260px;overflow:auto;background:#202020}.navMenuOption{display:block;width:100%;padding:0;border:0;color:inherit;background:none;text-align:left;font:inherit;cursor:pointer}.listItem-content{display:flex;align-items:center;padding:14px 20px}.navMenuOption-selected{color:#ffbe38;background:#ffffff09}
 /* Emby 4.10.0.40 modules/navdrawer/navdrawer.css: preserve the actual cascade. */
 .navMenuOption-listItem-content{-webkit-padding-start:.6em!important;padding-inline-start:.6em!important}.navMenuOption-listItem-content-reduceleftpadding{-webkit-padding-start:.25em!important;padding-inline-start:.25em!important}.navDrawerListItemImageContainer{width:1.8em!important;height:1.8em!important;flex-shrink:0}.navDrawerListItemBody{padding:.19em .5em!important}
 ${iconFont?'@font-face{font-family:"Material Symbols Rounded";font-style:normal;font-weight:400;src:url(/emby-material-icons.woff2) format("woff2")}':''}
 .md-icon{font-family:'Material Symbols Rounded'!important;font-weight:400;font-style:normal;line-height:1;letter-spacing:normal;text-transform:none;display:inline-block;white-space:nowrap;overflow-wrap:normal;-webkit-font-smoothing:antialiased;text-rendering:optimizelegibility;font-feature-settings:'liga';font-variation-settings:"FILL" 0,"wght" 400,"GRAD" 0,"opsz" 24;overflow:hidden;vertical-align:middle}
 @media(max-width:760px){.mainDrawer{display:none;z-index:1000;box-shadow:0 0 0 100vmax #0008}.mainDrawer.drawer-open{display:block}.view{margin-left:0}}
 </style><script src="/homeData.js"></script><body><aside class="mainDrawer"><div class="mainDrawerScrollSlider"><div class="navDrawerCollapseSection"><button class="navDrawerCollapseButton"><h3 class="navMenuHeader">Tigerest Theater 设置</h3></button><div class="navDrawerItemsContainer itemsContainer" data-listindex="0"></div></div></div></aside><div class="view"><button id="origin">设置</button><div id="host" class="readOnlyContent"></div></div><script>
 // The injected Qt shell must finish wiring native settings before this fixture replaces its boundary.
 window.fixtureReady=Promise.resolve(window.initCompleted).then(()=>{
 window.saves=[];window.resets=[];window.confirm=()=>true;window.initCompleted=Promise.resolve();
 const defaults=${JSON.stringify(defaults)};
 window.jmpInfo={sections:${JSON.stringify(sections.map(s=>({key:s.section,order:s.order})))},settingsDescriptions:${JSON.stringify(descriptions)},settings:{},mpvConfigMode:'embedded',mpvConfigDir:'内置配置'};
 for(const section of Object.keys(defaults))jmpInfo.settings[section]=new Proxy({...defaults[section]},{set(target,key,value){saves.push([section,key,value]);target[key]=value;return true}});
 window.api={player:{mpvDiagnostics:async()=>({renderBackend:'gpu-next-native',rife:{runtimeAvailable:true,state:0,status:'可用'}})},settings:{resetToDefault:async section=>{resets.push(section);Object.assign(jmpInfo.settings[section],defaults[section]);}}};
 window.tigerestOpenOfflineLibrary=()=>{};
 });
 </script><script src="/settings.js"></script></body>`},
 '/settings.js':{body:renderer},
 '/homeData.js':{path:path.resolve(__dirname,'../native/homeData.js')}
},async({evaluate,call})=>{
 const assertDrawerAlignment = async layout => {
  const positions=await evaluate(`(()=>{const position=row=>({icon:row.querySelector('.navDrawerListItemIcon').getBoundingClientRect().left,text:row.querySelector('.listItemBodyText').getBoundingClientRect().left});return {native:position(document.querySelector('.mainDrawer .navMenuOption')),categories:[...document.querySelectorAll('.mainDrawer [data-settings-category]')].map(row=>({category:row.dataset.settingsCategory,...position(row)}))}})()`);
  assert.equal(positions.categories.length,7);
  for(const category of positions.categories){
   assert.ok(Math.abs(category.icon-positions.native.icon)<1,`${layout}: ${category.category} icon must align with native General (${JSON.stringify(positions)})`);
   assert.ok(Math.abs(category.text-positions.native.text)<1,`${layout}: ${category.category} text must align with native General (${JSON.stringify(positions)})`);
  }
 };
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await evaluate('window.fixtureReady');
 // A signed-in Emby account with three libraries, for the home library list.
 await evaluate(`window.fixtureConnectionManager={currentApiClient:()=>({serverId:()=> 'fixture-server',getCurrentUserId:()=> 'fixture-user',
  getUserViews:async()=>({Items:[{Id:'movies',Name:'电影'},{Id:'shows',Name:'剧集'},{Id:'anime',Name:'动漫'}]})})}`);
 await evaluate(`window.NativeShell={AppHost:{}};window.settingsModules=new Map();window.define=(id,deps,factory)=>settingsModules.set(id,{deps,factory});window.tigerestMountSettings=mountTigerestSettings;window.tigerestSettingsCategories=getTigerestSettingsCategories;window.tigerestInstallSettingsMenu=installTigerestSettingsMenu;`);
 await evaluate(fs.readFileSync(path.resolve(__dirname,'../native/embycompat.js'),'utf8'));
 await evaluate(fs.readFileSync(path.resolve(__dirname,'fixtures/settings_navigation.js'),'utf8'));
 if(iconFont){
  await evaluate('document.fonts.ready');
  assert.equal(await evaluate('document.fonts.check(\'16px "Material Symbols Rounded"\')'),true,'local native icon font loaded');
 }
 await evaluate('openSettingsCategory("home")');
 assert.equal(await evaluate(`document.querySelector('[data-setting="main.fullscreen"]')`),null,'runtime fullscreen is not an editable startup setting');
 assert.equal(await evaluate(`document.querySelector('[data-setting="home.startupFullscreen"] input')?.checked`),false,'new home startup preference defaults to windowed');
 await evaluate(`document.querySelector('[data-setting="home.startupFullscreen"] input').click()`);
 assert.deepEqual(await evaluate('saves.at(-1)'),['home','startupFullscreen',true],'home startup toggle persists its independent preference');
 assert.match(await evaluate('document.querySelector("#tigerest-settings-inline .tgs-status").textContent'),/已保存；此项将在重启后生效。/,'startup preference confirms next-launch application');
 // Home media folders: shown or hidden, and their order, for this server and account.
 const libraryRows=`[...document.querySelectorAll('.tgs-library-row')].map(row=>(row.querySelector('input').checked?'':'!')+row.querySelector('.tgs-library-name').textContent)`;
 const savedLayout=`JSON.parse(saves.filter(save=>save[1]==='libraryLayout').at(-1)[2])['fixture-server/fixture-user']`;
 const libraryButton=(label)=>`document.querySelector('[aria-label="${label}"]')`;
 for(let i=0;i<40&&!(await evaluate(`document.querySelectorAll('.tgs-library-row').length===4`));i++)await new Promise(r=>setTimeout(r,25));
 assert.deepEqual(await evaluate(libraryRows),['电影','剧集','动漫','收藏'],'every candidate, in the server order, starts shown');
 assert.equal(await evaluate(`${libraryButton('上移：电影')}.disabled&&${libraryButton('下移：收藏')}.disabled`),true);
 await evaluate(`document.querySelectorAll('.tgs-library-row input')[1].click()`);
 assert.deepEqual(await evaluate(savedLayout),['movies','!shows','anime','tigerest-favorites'],'hiding a folder saves at once');
 await evaluate(`${libraryButton('上移：动漫')}.click()`);
 assert.deepEqual(await evaluate(libraryRows),['电影','动漫','!剧集','收藏']);
 assert.deepEqual(await evaluate(savedLayout),['movies','anime','!shows','tigerest-favorites']);
 assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`),'上移：动漫','the moved folder keeps the keyboard');
 await evaluate(`${libraryButton('上移：动漫')}.click()`);
 assert.equal(await evaluate(`document.activeElement.closest('.tgs-library-row').querySelector('.tgs-library-name').textContent`),'动漫','at the top, focus falls back to the folder itself');
 for(const index of [0,1,2,3])await evaluate(`(()=>{const box=document.querySelectorAll('.tgs-library-row input')[${index}];if(box.checked)box.click()})()`);
 assert.deepEqual(await evaluate(libraryRows),['!动漫','!电影','!剧集','收藏'],'the last shown folder cannot be hidden');
 assert.equal(await evaluate('document.querySelector("#tigerest-settings-inline .tgs-status").textContent'),'首页至少保留一个媒体夹。');
 await evaluate(`[...document.querySelectorAll('.tgs-home-libraries button')].find(b=>b.textContent==='恢复服务器默认顺序').click()`);
 assert.equal(await evaluate(`saves.filter(save=>save[1]==='libraryLayout').at(-1)[2]`),'','restoring clears this server layout');
 assert.deepEqual(await evaluate(libraryRows),['电影','剧集','动漫','收藏']);
 if(process.env.TIGEREST_SETTINGS_SCREENSHOTS){
  fs.mkdirSync(process.env.TIGEREST_SETTINGS_SCREENSHOTS,{recursive:true});
  fs.writeFileSync(path.join(process.env.TIGEREST_SETTINGS_SCREENSHOTS,'settings-home.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
 }
 await evaluate('openSettingsCategory("audio")');
 assert.equal(await evaluate('document.querySelectorAll("#tigerest-settings-inline .tgs-tabs, #tigerest-settings-inline [role=tablist]").length'),0,
  'content has no duplicate category navigation');
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".mainDrawer [data-settings-category]")].map(row=>row.dataset.settingsCategory)'),
  ['home','main','video','audio','subtitles','mpv','danmaku'],'all supported categories are in Emby left navigation');
 // Emby's app group becomes the library group; player categories get their own.
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".mainDrawer .navMenuHeader")].map(node=>node.textContent)'),
  ['媒体库设置','播放器设置'],'settings drawer groups library and player settings');
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".mainDrawer .tigerest-player-settings [data-settings-category]")].map(row=>row.dataset.settingsCategory)'),
  ['main','video','audio','subtitles','mpv','danmaku'],'player settings group holds the player categories in order');
 // Emby collapses .collapseContent unless it has an explicit height.
 assert.equal(await evaluate('document.querySelector(".mainDrawer .tigerest-player-settings-items").style.height'),'auto','player group starts expanded');
 await evaluate('document.querySelector(".mainDrawer .tigerest-player-settings .navDrawerCollapseButton").click()');
 assert.equal(await evaluate('document.querySelector(".mainDrawer .tigerest-player-settings-items").style.height'),'0px','player group collapses');
 await evaluate('document.querySelector(".mainDrawer .tigerest-player-settings .navDrawerCollapseButton").click()');
 assert.equal(await evaluate('document.querySelector(".mainDrawer .tigerest-player-settings-items").style.height'),'auto','player group expands again');
 assert.equal(await evaluate('document.querySelector(".mainDrawer [aria-current=page]").dataset.settingsCategory'),'audio');
 // The phone layout reaches settings through Emby's settings page, which renders the same rows.
 await evaluate('renderSettingsPage()');
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".dynamicRoutes .navMenuHeader h3")].map(node=>node.textContent)'),
  ['媒体库设置','播放器设置'],'settings page groups library and player settings');
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".dynamicRoutes .tigerest-player-settings-page [data-settings-category]")].map(row=>row.dataset.settingsCategory)'),
  ['main','video','audio','subtitles','mpv','danmaku'],'settings page player group holds the player categories in order');
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".dynamicRoutes .listItemBodyText")].filter(node=>node.offsetParent).map(node=>node.textContent).slice(0,2)'),
  ['General','首页设置'],'settings page library group keeps the library categories');
 await evaluate('document.querySelector(".dynamicRoutes .tigerest-player-settings-page [data-settings-category=video]").click()');
 await new Promise(resolve=>setTimeout(resolve,80));
 assert.equal(await evaluate('document.querySelector("#tigerest-settings-inline .tgs-section.active")?.dataset.section'),'video','a grouped page row opens its category');
 await evaluate('document.querySelector(".dynamicRoutes").remove()');
 await evaluate('openSettingsCategory("audio")');
 const playbackCategoryTitle=await evaluate('window.tigerestAndroidApi ? "播放器" : "MPV 画质与插件"');
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".mainDrawer .listItemBodyText")].filter(node=>node.offsetParent).map(node=>node.textContent)'),
  ['General','首页设置','客户端','视频','音频','字幕',playbackCategoryTitle,'弹幕样式'],'native menu has categories without a redundant parent entry');
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".mainDrawer [data-settings-category] .md-icon")].map(node=>node.textContent.codePointAt(0))'),
  [0xe88a,0xe30c,0xe04b,0xe050,0xe01c,0xe024,0xe0b7],'native rows render each semantic category icon instead of arrows');
 await assertDrawerAlignment('desktop');
 await evaluate(`document.querySelectorAll('.mainDrawer .listItem-content').forEach(node=>node.classList.replace('navMenuOption-listItem-content','navMenuOption-listItem-content-reduceleftpadding'))`);
 await assertDrawerAlignment('TV wrapper');
 await evaluate(`document.querySelectorAll('.mainDrawer .listItem-content').forEach(node=>node.classList.replace('navMenuOption-listItem-content-reduceleftpadding','navMenuOption-listItem-content'))`);
 assert.ok(await evaluate('document.querySelectorAll(".tgs-setting").length>70'),'all supported setting definitions render');
 assert.equal(await evaluate('[...document.querySelectorAll(".tgs-setting input,.tgs-setting select,.tgs-setting textarea")].every(input=>input.labels?.length===1)'),true,'every input is associated with its visible form label');
 await evaluate(`(()=>{const search=document.querySelector('.tgs-search');search.value='透明度';search.dispatchEvent(new Event('input'))})()`);
 assert.equal(await evaluate('document.querySelector("[data-setting=\\"danmaku.opacity\\"]").offsetHeight'),0,'search only filters the selected category');
 assert.equal(await evaluate('document.querySelector(".tgs-empty").hidden'),false);
 await evaluate('openSettingsCategory("danmaku")');
 assert.equal(await evaluate('document.querySelector(".tgs-search").value'),'','category change clears search');
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".tgs-section")].filter(group=>group.offsetHeight>0).map(group=>group.dataset.section)'),['danmaku']);
 await evaluate(`const opacity=document.querySelector('[data-setting="danmaku.opacity"] select');opacity.value=String(jmpInfo.settingsDescriptions.danmaku.find(s=>s.key==='opacity').options.findIndex(o=>o.value===0.5));opacity.dispatchEvent(new Event('change'))`);
 assert.deepEqual(await evaluate('saves.at(-1)'),['danmaku','opacity',0.5],'selected values reach persistence immediately');
 await evaluate(`document.querySelector('[data-section="danmaku"] .tgs-reset').click();new Promise(resolve=>setTimeout(resolve,50))`);
 // The page asks in its own dialog; a native confirm() could freeze the page.
 assert.match(await evaluate('document.querySelector(".tgs-confirm-modal")?.textContent||""'),/恢复“弹幕样式”的默认设置/);
 await evaluate(`[...document.querySelectorAll('.tgs-confirm-modal button')].find(b=>b.textContent==='恢复默认').click();new Promise(resolve=>setTimeout(resolve,50))`);
 assert.deepEqual(await evaluate('resets'),['danmaku']);
 assert.equal(await evaluate('jmpInfo.settings.danmaku.opacity'),0.7,'reset restores defaults');
 assert.equal(await evaluate('document.querySelectorAll("#tigerest-settings-style").length'),1,'reset releases prior style and controls');
 await evaluate('renderSettingsDrawer();new Promise(resolve=>setTimeout(resolve,20))');
 assert.equal(await evaluate('document.querySelectorAll(".mainDrawer [data-settings-category]").length'),7,'rerender does not duplicate native menu entries');
 assert.equal(await evaluate('document.querySelector(".mainDrawer [aria-current=page]").dataset.settingsCategory'),'danmaku','reset/rerender preserve selected category');
 await evaluate(`(()=>{const container=document.querySelector('.navDrawerItemsContainer');const rowItems=new Map([...container.children].map((row,index)=>[row,container.items[index]]));container.getItemFromElement=row=>rowItems.get(row);container.items=null;container.getItem=()=>null;for(const row of container.children){delete row.dataset.index;row.querySelector('.listItemBodyText').textContent=rowItems.get(row).Name;}window.virtualRowItems=rowItems;})()`);
 assert.equal(await evaluate('document.querySelectorAll(".mainDrawer [data-settings-category]").length'),7,'virtualized native rows resolve through getItemFromElement');
 await call('Emulation.setDeviceMetricsOverride',{width:360,height:740,deviceScaleFactor:1,mobile:true});
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'phone has no document overflow');
 assert.equal(await evaluate('document.querySelectorAll(".tgs-tabs").length'),0,'phone has no horizontal category strip');
 await evaluate('document.querySelector(".mainDrawer").classList.add("drawer-open");document.querySelector("[data-settings-category=video]").focus()');
 await assertDrawerAlignment('phone drawer');
 assert.equal(await evaluate('document.activeElement.dataset.settingsCategory'),'video','native category accepts focus');
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,text:'\r'});
 await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
 await evaluate('new Promise(resolve=>setTimeout(resolve,60))');
 assert.equal(await evaluate('document.querySelector(".tgs-section.active").dataset.section'),'video','native menu remains keyboard activatable');
 assert.equal(await evaluate('document.querySelector(".mainDrawer").classList.contains("drawer-open")'),false,'native navigation action can close the mobile drawer');
 await evaluate('settingsController.onPause({});settingsController.onResume({});new Promise(resolve=>setTimeout(resolve,50))');
 assert.equal(await evaluate('document.querySelector(".tgs-section.active").dataset.section'),'video','cached route resumes the same category');
 // Emby 4.8 leaves .readOnlyContent at the start of the page; in a wide
 // window the settings stay centered rather than in the left half.
 await call('Emulation.setDeviceMetricsOverride',{width:2560,height:1440,deviceScaleFactor:1,mobile:false});
 const wide=await evaluate(`(async()=>{const host=document.getElementById('host'),rule=[...document.styleSheets[0].cssRules].find(r=>r.selectorText==='#host'),fixture=rule.style.cssText;
  rule.style.cssText='margin-top:30px';await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const h=host.getBoundingClientRect(),v=host.parentElement.getBoundingClientRect();const gaps={left:h.left-v.left,right:v.right-h.right,width:h.width,host:host.className};rule.style.cssText=fixture;return gaps;})()`);
 assert.ok(wide.left>100&&Math.abs(wide.left-wide.right)<=2,'wide window centers the settings '+JSON.stringify(wide));
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 if(process.env.TIGEREST_SETTINGS_SCREENSHOTS){
  fs.mkdirSync(process.env.TIGEREST_SETTINGS_SCREENSHOTS,{recursive:true});
  fs.writeFileSync(path.join(process.env.TIGEREST_SETTINGS_SCREENSHOTS,'settings-phone.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate('document.querySelector(".mainDrawer").classList.add("drawer-open")');
  fs.writeFileSync(path.join(process.env.TIGEREST_SETTINGS_SCREENSHOTS,'settings-phone-drawer.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  fs.writeFileSync(path.join(process.env.TIGEREST_SETTINGS_SCREENSHOTS,'settings-desktop.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
 }
 await evaluate('document.querySelector(".tgs-close").click()');
 assert.equal(await evaluate('window.returned'),true,'inline return leaves Emby route in control');
 assert.equal(await evaluate('document.querySelectorAll("#tigerest-settings-style").length'),0);
 await evaluate('document.querySelector("#origin").focus();mountTigerestSettings(null,"audio").then(value=>window.mount=value)');
 assert.equal(await evaluate('document.querySelector("#tigerest-settings-overlay [role=dialog]")?.getAttribute("aria-modal")'),'true');
 await evaluate(`(()=>{const select=document.querySelector('.tgs-category-select');select.value='danmaku';select.dispatchEvent(new Event('change'))})()`);
 assert.equal(await evaluate('document.querySelector(".tgs-section.active").dataset.section'),'danmaku','standalone fallback can still select a category');
 // Without a server menu (offline, Jellyfin) the desktop dialog lists the
 // categories beside the page in the server menu's groups and order.
 const standaloneNav=()=>evaluate(`(()=>{const nav=document.querySelector('#tigerest-settings-overlay .tgs-nav'),select=document.querySelector('.tgs-category-select');
  return {nav:nav.getClientRects().length>0,select:select.getClientRects().length>0,groups:[...nav.querySelectorAll('.tgs-nav-title')].map(node=>node.textContent),
   items:[...nav.querySelectorAll('.tgs-nav-item')].map(node=>node.dataset.section),current:nav.querySelector('[aria-current=page]')?.dataset.section,
   options:[...select.querySelectorAll('optgroup')].map(group=>group.label+':'+[...group.children].map(option=>option.value).join(',')),
   title:document.getElementById('tgs-settings-title').textContent,active:document.querySelector('.tgs-section.active').dataset.section};})()`);
 assert.deepEqual(await standaloneNav(),{nav:true,select:false,groups:['播放器设置','媒体库设置'],items:['main','video','audio','subtitles','mpv','danmaku','home'],
  current:'danmaku',options:['播放器设置:main,video,audio,subtitles,mpv,danmaku','媒体库设置:home'],title:'播放器设置',active:'danmaku'},'desktop dialog groups its categories beside the page');
 await evaluate(`document.querySelector('.tgs-nav-item[data-section="home"]').click()`);
 assert.deepEqual(await standaloneNav().then(({current,title,active})=>({current,title,active})),{current:'home',title:'媒体库设置',active:'home'},'side menu opens a category');
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 assert.deepEqual(await standaloneNav().then(({nav,select})=>({nav,select})),{nav:false,select:true},'narrow dialog keeps the selector');
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
 assert.equal(await evaluate('!!document.querySelector("#tigerest-settings-overlay")'),false);
 assert.equal(await evaluate('document.activeElement.id'),'origin','fallback closes and restores focus');
 // Jellyfin has no Emby settings route: its user menu opens the overlay, which
 // reads the account from the connection manager the Jellyfin plugin received.
 await evaluate(fs.readFileSync(path.resolve(__dirname,'../native/jellyfinPlugin.js'),'utf8'));
 await evaluate(`(()=>{const account=(server,user,names)=>({serverId:()=>server,getCurrentUserId:()=>user,
  getUserViews:async()=>({Items:names.map((Name,index)=>({Id:server+'-'+index,Name}))})});
  window.jellyfinAccounts={alice:account('jf-a','alice',['电影','剧集']),bob:account('jf-b','bob',['纪录片']),signedOut:account('jf-b',null,[])};
  window.jellyfinAccount=jellyfinAccounts.alice;
  // The embedded client also injects the community and watch-together plugins. They need
  // the native bridge this fixture replaced, and the settings do not use them.
  const unrelated={_communityPlugin:window._communityPlugin,_watchTogetherPlugin:window._watchTogetherPlugin};
  window._communityPlugin=window._watchTogetherPlugin=undefined;
  try{window.jellyfinPlugin=new _tigerestJellyfinPlugin({events:{on(){}},appRouter:{show(){}},ServerConnections:{currentApiClient:()=>jellyfinAccount}});}
  finally{Object.assign(window,unrelated);}})()`);
 const overlayLibraries=async account=>{
  const message=`document.querySelector('#tigerest-settings-overlay .tgs-home-libraries > .tgs-help:not(.fieldDescription)')`;
  await evaluate(`jellyfinAccount=jellyfinAccounts.${account};openTigerestSettings('home').then(value=>window.mount=value)`);
  for(let i=0;i<40&&!(await evaluate(`!!${message}&&${message}.textContent!=='正在读取媒体夹…'`));i++)await new Promise(r=>setTimeout(r,25));
  const shown=await evaluate(`({rows:[...document.querySelectorAll('#tigerest-settings-overlay .tgs-library-name')].map(node=>node.textContent),message:${message}.textContent})`);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await evaluate('!!document.querySelector("#tigerest-settings-overlay")'),false);
  return shown;
 };
 assert.deepEqual(await overlayLibraries('alice'),{rows:['电影','剧集','收藏'],message:''},'Jellyfin overlay lists the signed-in account folders');
 assert.deepEqual(await overlayLibraries('bob'),{rows:['纪录片','收藏'],message:''},'a server or account switch shows the new account');
 assert.deepEqual(await overlayLibraries('signedOut'),{rows:[],message:'登录服务器后，可以在这里选择首页显示的媒体夹。'},'signed out keeps no old account');
 await evaluate('jellyfinPlugin.home.destroy()');
 console.log('settings UI: native category routes without redundant parent, desktop/TV/phone native alignment, single pane, search/reset/persistence, drawer rerender, keyboard activation, phone layout, cached route resume, fallback cleanup and Jellyfin overlay accounts passed');
// Qt does not tick animation frames when launched with windowsHide, even while document.hidden is false.
},{visible:true}).catch(error=>{console.error(error);process.exitCode=1});
