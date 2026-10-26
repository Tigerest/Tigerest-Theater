const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Runs offline.js against a stub Emby client and returns what reached the native download manager.
async function download(item,playbackInfo){
 const downloads=[];
 class HTMLAnchorElement{dispatchEvent(){return false;}}
 const window={HTMLAnchorElement,URL,console,Promise,setTimeout,location:{href:'http://emby.test/web/index.html'},apiPromise:new Promise(()=>{}),document:{getElementById:()=>null}};
 window.window=window;
 window.ApiClient={getItem:async()=>item,getCurrentUserId:()=> 'user',serverAddress:()=> 'http://emby.test/',getPlaybackInfo:async()=>playbackInfo()};
 window.NativeShell={AppHost:{getDeviceProfile:()=>({})},downloadFile:async info=>{downloads.push(info);}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/../native/offline.js','utf8'),window);
 HTMLAnchorElement.prototype.dispatchEvent.call({href:'http://emby.test/emby/Items/13/Download?api_key=token'},{type:'click'});
 for(let i=0;i<50&&!downloads.length;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(downloads.length,1,'the download reached the native manager');
 return downloads[0];
}
const strm={Id:'13',Name:'STRM Direct',MediaType:'Video',FileName:'STRM Direct (2021).strm',Container:'strm'};
test('a .strm link downloads as the media container that playback info reports',async()=>{
 const info=await download(strm,()=>({MediaSources:[{SupportsDirectPlay:true,Container:'mkv',DirectStreamUrl:'/videos/13/original.mkv?MediaSourceId=s13'}]}));
 assert.equal(info.fileName,'STRM Direct (2021).mkv');
 assert.equal(info.url,'http://emby.test/emby/videos/13/original.mkv?MediaSourceId=s13');
 assert.equal(info.title,'STRM Direct');
});
test('a .strm link never keeps the link extension when the stream is unknown',async()=>{
 const info=await download(strm,()=>{throw Error('offline server');});
 assert.equal(info.fileName,'STRM Direct (2021).media');
});
// Opens the offline library and presses 播放 on a finished download; returns the player calls.
async function playDownload(localPlayer){
 const calls=[],clicks=[];
 const node=()=>({style:{},appendChild(child){return child;},replaceChildren(){},remove(){},
  addEventListener(type,handler){if(type==='click')clicks.push({node:this,handler});}});
 const player={setVideoOnlyMode:value=>calls.push(['videoOnly',value]),load:(url,options,metadata)=>calls.push(['load',url,metadata.title]),
  stopped:{connect:()=>calls.push(['stop hook'])}};
 const api={player,system:{downloads:async()=>[{id:'d1',status:'completed',title:'第1集'}],downloadInfo:async()=>({localUrl:'file:///D:/v/1.mkv',title:'第1集'})}};
 const window={HTMLAnchorElement:class{dispatchEvent(){return false;}},URL,console,Promise,setTimeout:()=>{},api,apiPromise:Promise.resolve(api),
  document:{getElementById:()=>null,createElement:node,body:{appendChild(){},contains:()=>false}}};
 window.window=window;
 if(localPlayer)window.tigerestPlayLocalMedia=entries=>calls.push(['local',entries]);
 vm.runInNewContext(fs.readFileSync(__dirname+'/../native/offline.js','utf8'),window);
 await window.tigerestOpenOfflineLibrary();
 await clicks.find(click=>click.node.textContent==='播放').handler();
 return JSON.parse(JSON.stringify(calls));
}
test('a finished download plays through the desktop local player',async()=>{
 assert.deepEqual(await playDownload(true),[['local',[{url:'file:///D:/v/1.mkv',title:'第1集'}]]]);
});
test('without the local player a finished download still loads directly',async()=>{
 assert.deepEqual(await playDownload(false),[['stop hook'],['videoOnly',true],['load','file:///D:/v/1.mkv','第1集']]);
});
test('ordinary media keeps its own file name',async()=>{
 const info=await download({Id:'13',Name:'Plain File',MediaType:'Video',FileName:'Plain File (2019).mkv',Container:'mkv'},
  ()=>({MediaSources:[{SupportsDirectPlay:true,Container:'mkv',DirectStreamUrl:'/videos/13/original.mkv'}]}));
 assert.equal(info.fileName,'Plain File (2019).mkv');
});
