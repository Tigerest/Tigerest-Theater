// The shared page scripts as the Android client injects and drives them; no device.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'../..');
const webHost=fs.readFileSync(path.join(root,'android/app/src/main/java/top/tigerest/theater/WebHost.kt'),'utf8');
const injected=JSON.parse('['+/val nativeFiles = listOf\(([^)]*)\)/.exec(webHost)[1]+']');

test('every injected script exists, once, and the server skin filter follows embycompat.js',()=>{
 for(const file of injected)assert.ok(fs.existsSync(path.join(root,'native',file)),file);
 assert.equal(new Set(injected).size,injected.length);
 // As on the desktop (SystemComponent.cpp): embycompat.js's first request tells the filter the server version.
 assert.equal(injected[injected.indexOf('embycompat.js')+1],'serverSkinFilter.js');
 assert.ok(injected.indexOf('serverKind.js')<injected.indexOf('serverSkinFilter.js'),'TigerestServer exists before the filter runs');
 // Without localPlayer.js the server page has no first screen or local playback (tests/test_server_onboarding.js).
 for(const desktop of ['localPlayer.js','proMode.js','mpvConfEditor.js'])assert.ok(!injected.includes(desktop),desktop);
});

function watchPlugin(player){
 const context={console,performance,setTimeout,clearTimeout,document:{},api:{player},
  TigerestWatchClient:function(){},TigerestWatchConnection:function(){},TigerestWatchSync:function(){},
  TigerestWatchMessages:{message:code=>code,uuid:()=>'00000000-0000-4000-8000-000000000000'}};
 context.window=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync(path.join(root,'native/watchTogether.js'),'utf8'),context);
 const plugin=Object.create(context._watchTogetherPlugin.prototype);
 plugin.sync={attached:true};
 return plugin;
}
test('watch-together notices keep their duration on Android, which has no mpv command line',()=>{
 const shown=[];const plugin=watchPlugin({showMessage:(...args)=>shown.push(args)});
 plugin.notify('朋友 跳转到 12:34，等待 朋友 就绪…',16000);plugin.notify('同步开始',1499.6);plugin.notify('已和房间同步');
 assert.deepEqual(shown,[['朋友 跳转到 12:34，等待 朋友 就绪…',16000],['同步开始',1500],['已和房间同步',3000]]);
 // The desktop keeps its mpv OSD.
 const commands=[];watchPlugin({userCommand:command=>commands.push(command),showMessage:()=>assert.fail('desktop uses show-text')}).notify('同步开始',1500);
 assert.deepEqual(commands,['show-text "同步开始" 1500']);
});
