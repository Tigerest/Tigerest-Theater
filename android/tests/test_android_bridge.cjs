const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(prompt){
 const sent=[],context={window:{},setTimeout,clearTimeout,console,URL,prompt};context.window=context;
 const file=path.join(__dirname,'../app/src/main/assets/androidBridge.js');
 vm.createContext(context);vm.runInContext(fs.existsSync(file)?fs.readFileSync(file,'utf8'):'',context);
 assert.equal(typeof context.createAndroidBridge,'function','platform transport is implemented');
 const bridge=context.createAndroidBridge({postMessage:s=>sent.push(JSON.parse(s))},{settings:{},sections:[],settingsDescriptions:{}});
 return {bridge,sent};
}
test('address edit uses a native prompt without timing out a user or sending a bridge request',async()=>{
 let answer=null,initial;
 const {bridge,sent}=setup((message,value)=>{initial=value;return answer;});
 assert.equal(await bridge.api.system.editServerAddress('https://old.example/'),null);
 assert.equal(initial,'https://old.example/');
 answer='https://new.example:8920/jellyfin/';
 assert.equal(await bridge.api.system.editServerAddress(''),answer);
 assert.equal(sent.length,0);
 bridge.close();
});
test('load forwards actual metadata and resolves Qt-style callback from the native reply',async()=>{
 const {bridge,sent}=setup();let callback;
 const p=bridge.api.player.load('https://media.example/video',{startMilliseconds:24000},{metadata:{IndexNumber:3}},1,-1,result=>callback=result);
 assert.equal(sent[0].method,'load');assert.equal(sent[0].args.length,5);assert.equal(sent[0].args[1].startMilliseconds,24000);
 bridge.receive({id:sent[0].id,result:true});assert.equal(await p,true);assert.equal(callback,true);bridge.close();
});
test('native failure rejects calls and disconnect really removes event delivery',async()=>{
 const {bridge,sent}=setup();let positions=[];const listener=p=>positions.push(p);
 bridge.api.player.positionUpdate.connect(listener);bridge.receive({component:'player',signal:'positionUpdate',args:[25000]});
 bridge.api.player.positionUpdate.disconnect(listener);bridge.receive({component:'player',signal:'positionUpdate',args:[26000]});
 assert.deepEqual(positions,[25000]);const p=bridge.api.settings.setValue('video','cache',-1);
 bridge.receive({id:sent[0].id,error:'值超出范围'});await assert.rejects(p,/值超出范围/);bridge.close();
});
// The installed bridge on a page whose window keeps listeners as a browser does:
// an event reaching window removes a once listener before it runs.
function installedPage(){
 const sent=[],listeners=[],context={setTimeout,clearTimeout,console,URL,document:{},
  tigerestNative:{postMessage:s=>sent.push(JSON.parse(s))},__tigerestBootstrap:{settings:{},sections:[],settingsDescriptions:{}},
  addEventListener(type,fn,options){listeners.push({type,fn,once:!!options?.once});},
  removeEventListener(type,fn){const i=listeners.findIndex(l=>l.type===type&&l.fn===fn);if(i>=0)listeners.splice(i,1);}};
 context.window=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/src/main/assets/androidBridge.js'),'utf8'),context);
 const deliver=event=>{for(const l of listeners.filter(l=>l.type===event.type)){if(l.once)context.removeEventListener(l.type,l.fn);l.fn(event);}};
 const reply=message=>context.tigerestNative.onmessage({data:JSON.stringify(message)});
 return {page:context,api:context.tigerestAndroidApi,sent,deliver,reply,pagehideListeners:()=>listeners.filter(l=>l.type==='pagehide').length};
}
test('a Jellyfin view change keeps the bridge, and leaving the page still closes it',async()=>{
 const {page,api,sent,deliver,reply,pagehideListeners}=installedPage();
 // Jellyfin's web client dispatches its own bubbling pagehide CustomEvent from a view element.
 deliver({type:'pagehide',isTrusted:false,target:{tagName:'DIV'},bubbles:true,detail:{}});
 const hello=api.system.hello();assert.equal(sent.at(-1).method,'hello');
 reply({id:sent.at(-1).id,result:true});assert.equal(await hello,true);
 const seen=[];api.player.positionUpdate.connect(value=>seen.push(value));
 const pending=api.settings.setValue('main','fullscreen',true);
 deliver({type:'pagehide',isTrusted:true,target:page.document,persisted:false});
 await assert.rejects(pending,/页面已关闭/);
 reply({component:'player',signal:'positionUpdate',args:[1]});assert.deepEqual(seen,[]);
 await assert.rejects(api.system.hello(),/页面已关闭/);
 assert.equal(pagehideListeners(),0,'the page lifecycle listener is released');
});
test('skip intro and seeking are bridged as on the desktop',async()=>{
 const {bridge,sent}=setup();
 // mpvVideoPlayer.js publishes the intro marker only when the player has setIntroSkip.
 assert.equal(typeof bridge.api.player.setIntroSkip,'function');
 const marker=bridge.api.player.setIntroSkip({start:12.5,end:95,auto:false});
 assert.equal(sent[0].method,'setIntroSkip');assert.deepEqual(sent[0].args,[{start:12.5,end:95,auto:false}]);
 bridge.receive({id:sent[0].id,result:true});assert.equal(await marker,true);
 const seeking=[];bridge.api.player.seekingChanged.connect(value=>seeking.push(value));
 bridge.receive({component:'player',signal:'seekingChanged',args:[true]});bridge.receive({component:'player',signal:'seekingChanged',args:[false]});
 assert.deepEqual(seeking,[true,false]);bridge.close();
});
test('a page message takes its duration to the native label',async()=>{
 const {bridge,sent}=setup();const shown=bridge.api.player.showMessage('朋友 跳转到 12:34，等待 朋友 就绪…',16000);
 assert.deepEqual(sent[0].args,['朋友 跳转到 12:34，等待 朋友 就绪…',16000]);
 bridge.receive({id:sent[0].id,result:true});assert.equal(await shown,true);bridge.close();
});
test('closing the page cancels pending operations and late responses cannot settle new calls',async()=>{
 const {bridge,sent}=setup();const pending=bridge.api.player.getPosition();bridge.close();await assert.rejects(pending,/页面已关闭/);
 bridge.receive({id:sent[0].id,result:999});await assert.rejects(bridge.api.player.play(),/页面已关闭/);
});
