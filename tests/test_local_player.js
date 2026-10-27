const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Runs localPlayer.js against stub Qt objects and records what reached the player.
class Signal{constructor(){this.handlers=[];}connect(f){this.handlers.push(f);}disconnect(f){this.handlers=this.handlers.filter(h=>h!==f);}emit(...a){this.handlers.slice().forEach(h=>h(...a));}}
async function start(request){
 const calls=[];
 const player={finished:new Signal(),stopped:new Signal(),error:new Signal(),
  load:url=>calls.push(['load',url]),setVideoOnlyMode:value=>calls.push(['videoOnly',value]),stop(){},
  setWebPlaylist:(items,current)=>calls.push(['list',items.map(item=>item.Name),current]),
  notifyQueueChange:(next,previous)=>calls.push(['queue',next,previous])};
 const api={player,input:{hostInput:new Signal()},window:{beginPlaybackSession:()=>calls.push(['begin']),endPlaybackSession:()=>calls.push(['end'])},
  system:{isWindows:true,chooseLocalFiles(){},localFilesRequested:new Signal(),takeLocalFiles:async()=>{const taken=request;request={};return taken;}}};
 const window={api,apiPromise:Promise.resolve(api),setTimeout,console,document:{querySelector:()=>null,getElementById:()=>null}};
 window.window=window;
 vm.runInNewContext(fs.readFileSync(__dirname+'/../native/localPlayer.js','utf8'),window);
 const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
 await settle();
 return {api,window,settle,calls:()=>JSON.parse(JSON.stringify(calls.splice(0)))};
}
const episodes=['第1集','第2集','第10集'].map(title=>({url:`file:///D:/S01/${encodeURIComponent(title)}.mkv`,title}));
test('an episode opened alone plays within its folder and the list knows which',async()=>{
 const {calls}=await start({items:episodes,start:1});
 assert.deepEqual(calls(),[['begin'],['videoOnly',true],['list',['第1集','第2集','第10集'],'local-1'],['queue',true,true],['load',episodes[1].url]]);
});
test('a uosc list choice and the media keys load through the local player',async()=>{
 const {api,calls}=await start({items:episodes,start:0});
 calls();
 api.input.hostInput.emit(['playlist-item:local-2']);
 assert.deepEqual(calls(),[['list',['第1集','第2集','第10集'],'local-2'],['queue',false,true],['load',episodes[2].url]]);
 api.input.hostInput.emit(['next','playlist-item:local-2','playlist-item:local-9','playlist-item:queue-1']);
 assert.deepEqual(calls(),[],'nothing after the last episode, the playing one, or another queue');
 api.input.hostInput.emit(['previous']);
 assert.deepEqual(calls().at(-1),['load',episodes[1].url]);
});
test('an ended episode continues with the next, and the last one ends local playback',async()=>{
 const {api,window,calls}=await start({items:episodes,start:1});
 calls();
 api.player.finished.emit();api.player.stopped.emit();
 assert.deepEqual(calls().at(-1),['load',episodes[2].url]);
 api.player.finished.emit();api.player.stopped.emit();
 assert.deepEqual(calls(),[['list',[],''],['queue',false,false],['videoOnly',false],['end']]);
 assert.equal(window.tigerestLocalPlaybackActive(),false);
 api.input.hostInput.emit(['playlist-item:local-0']);
 assert.deepEqual(calls(),[],'a stale list choice after the end loads nothing');
});
test('a single offline file still has a one-entry list',async()=>{
 const {window,settle,calls}=await start({});
 await window.tigerestPlayLocalMedia([{url:'file:///D:/dl/a.mkv',title:'离线'}]);
 await settle();
 assert.deepEqual(calls(),[['begin'],['videoOnly',true],['list',['离线'],'local-0'],['queue',false,false],['load','file:///D:/dl/a.mkv']]);
});
