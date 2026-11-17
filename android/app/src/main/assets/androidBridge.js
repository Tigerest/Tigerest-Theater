(function(global){
 'use strict';
 global.createAndroidBridge=function(transport,bootstrap){
  let sequence=0,closed=false;const pending=new Map(),signals=new Map();
  function signal(component,name){
   const key=component+'.'+name;if(!signals.has(key))signals.set(key,new Set());
   return {connect(fn){signals.get(key).add(fn);},disconnect(fn){signals.get(key).delete(fn);}};
  }
  function method(component,name){return function(...args){
   const callback=typeof args.at(-1)==='function'?args.pop():null;
   if(closed)return Promise.reject(new Error('页面已关闭'));
   const id=++sequence;
   const promise=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('客户端请求超时'));},30000);
    pending.set(id,{resolve,reject,timeout});
    try{transport.postMessage(JSON.stringify({id,component,method:name,args}));}catch(e){clearTimeout(timeout);pending.delete(id);reject(e);}
   });
   if(callback)promise.then(callback,()=>callback(false));
   return promise;
  };}
  const operations={
   player:'load queueMedia clearQueue seekTo stop streamSwitch pause play showMessage setVolume volume setMuted muted getAudioDeviceList setAudioDevice setAudioStream setSubtitleStream getSubtitleStreams setAudioDelay setSubtitleDelay setVideoOnlyMode setVideoRectangle setPlaybackRate getPosition getDuration setIntroSkip mpvDiagnostics getWebPlaylist getCurrentWebPlaylistItemId setWebPlaylist notifyShuffleChange notifyRepeatChange notifyFullscreenChange notifyRateChange notifyQueueChange notifyPlaybackStop notifyDurationChange notifyPlaybackState notifyPosition notifySeek notifyMetadata notifyVolumeChange notifyStreamingBitrateResult',
   settings:'setValue resetToDefault value',
   system:'communityRequest communitySourceAvatar communityCancel communityCredential communitySetEmbySession exit restart hello isAddressOnLocalSubnet checkServerConnectivity cancelServerConnectivity finishServerSelection takeServerSelectionError openExternalUrl systemInformation getUserAgent debugInformation setReportDiagnosticsScope collectReportDiagnostics checkForUpdates appUpdateState downloadAppUpdate installAppUpdate cancelAppUpdate skipAppUpdate deferAppUpdate openAppUpdateMirror',
   window:'setFullScreen isFullScreen beginPlaybackSession endPlaybackSession requestPlaybackFullScreen setCursorVisibility',
   danmaku:'search episodes match load loadUrl importFile setSource sources setEnabled',
  };
  const notifications={
   player:'backgrounded playing paused finished canceled stopped error stateChanged videoPlaybackActive windowVisible updateDuration playbackRateChanged positionUpdate onVideoRecangleChanged onMetaData bufferedRangesUpdated buffering seekingChanged streamingBitrateRequested subtitleStreamRequested webPlaylistChanged',
   settings:'sectionValueUpdate groupUpdate',system:'serverConnectivityResult appUpdateChanged communityResponse',window:'fullScreenSwitched',input:'hostInput playlistItemRequested volumeChanged rateChanged positionSeek',danmaku:'status sourcesChanged',
  };
  const api={};
  for(const [component,names]of Object.entries(operations)){api[component]={};for(const name of names.split(' '))api[component][name]=method(component,name);}
  for(const [component,names]of Object.entries(notifications)){api[component]??={};for(const name of names.split(' '))api[component][name]=signal(component,name);}
  Object.assign(api.system,{isWindows:false,isMacos:false,isAndroid:true});
  // Native prompts have a user-controlled completion/cancel lifecycle, without
  // the bridge's 30-second operation timeout. WebHost supplies the EditText.
  api.system.editServerAddress=value=>closed?Promise.reject(new Error('页面已关闭')):
   Promise.resolve(global.prompt('Tigerest.ServerAddress',String(value||'')));
  return {api,receive(message){
   if(closed)return;
   if(message.id){const request=pending.get(message.id);if(!request)return;clearTimeout(request.timeout);pending.delete(message.id);message.error?request.reject(new Error(message.error)):request.resolve(message.result);}
   else if(message.component&&message.signal){for(const listener of signals.get(message.component+'.'+message.signal)||[])try{listener(...(message.args||[]));}catch(e){console.error('客户端事件处理失败',e);}}
  },close(){closed=true;for(const request of pending.values()){clearTimeout(request.timeout);request.reject(new Error('页面已关闭'));}pending.clear();signals.clear();}};
 };
 if(global.tigerestNative&&global.__tigerestBootstrap){
  global.jmpInfo=global.__tigerestBootstrap;
  const bridge=global.createAndroidBridge(global.tigerestNative,global.jmpInfo);
  global.tigerestAndroidApi=bridge.api;
  global.tigerestNative.onmessage=event=>{try{bridge.receive(JSON.parse(event.data));}catch(e){console.error('客户端消息格式错误');}};
  // Jellyfin's web client dispatches its own bubbling pagehide events from view
  // elements. Only the browser's pagehide for the document means the page is
  // going away, and a view change must not use up the listener.
  const leave=event=>{
   if(!event.isTrusted||(event.target!==global.document&&event.target!==global))return;
   global.removeEventListener('pagehide',leave);bridge.close();
  };
  global.addEventListener('pagehide',leave);
 }
})(window);
