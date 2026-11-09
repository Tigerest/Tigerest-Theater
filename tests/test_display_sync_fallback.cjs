'use strict';
// Manual GPU acceptance in the full Windows client, isolated profile, local clip.
// Report: on a 144 Hz laptop panel the buffer swaps did not wait for the
// refresh. display-resample counted refreshes that never happened, the video
// ran 0.5-1.6 s ahead of the audio and repeating frames did not hold it back.
// Case "healthy": display-resample stays in sync and is left alone.
// Case "unthrottled": d3d11-sync-interval=0 makes the swaps return at once;
// the client must fall back to the audio clock and come back into sync, and
// the danmaku script must not turn that into display-vdrop.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {randomUUID}=require('node:crypto');
const withBrowser=require('./community_browser.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const source=process.env.TIGEREST_TEST_CLIP;
assert.ok(source&&fs.existsSync(source),'TIGEREST_TEST_CLIP must name a local >=60s SDR clip with an audio track');
const routes={'/':{type:'text/html',body:'<!doctype html><meta charset="utf-8"><style>html,body{background:transparent}</style>'}};
async function until(fn,label,limit=300){
    for(let i=0;i<limit;i++){const value=await fn();if(value)return value;await wait(100);}
    throw Error('Timed out: '+label);
}
async function run(name,report){
    const pipe='\\\\.\\pipe\\TigerestDisplaySync-'+randomUUID(),unthrottled=name==='unthrottled';
    Object.assign(report,{case:name,samples:[]});
    let clip;
    await withBrowser(routes,async({evaluate,profile})=>{
        await until(()=>evaluate('!!window.api?.player'),'native bridge');
        let ipc;
        await until(async()=>{try{ipc=net.connect(pipe);await new Promise((r,j)=>{ipc.once('connect',r);ipc.once('error',j)});return true;}catch{ipc?.destroy();}},'test IPC');
        let seq=0,buffer='';const pending=new Map();
        ipc.on('data',d=>{buffer+=d;let end;while((end=buffer.indexOf('\n'))>=0){const v=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const p=pending.get(v.request_id);if(p){pending.delete(v.request_id);clearTimeout(p.timer);p.resolve(v.error==='success'?v.data:null);}}});
        const cmd=(...command)=>new Promise((resolve,reject)=>{const request_id=++seq,timer=setTimeout(()=>{pending.delete(request_id);reject(Error('IPC timeout: '+command[0]));},10000);pending.set(request_id,{resolve,timer});ipc.write(JSON.stringify({command,request_id})+'\n');});
        const prop=k=>cmd('get_property',k);
        const snapshot=async at=>({at,...Object.fromEntries(await Promise.all(['avsync','video-sync','time-pos','audio-pts','mistimed-frame-count','estimated-display-fps','display-fps','user-data/tigerest/display-sync-fallback'].map(async k=>[k,await prop(k)])))});
        try{
            await evaluate('api.player.setVideoOnlyMode(true);api.window.raiseWindow()');
            await evaluate(`api.player.load(${JSON.stringify(pathToFileURL(clip).href)},{autoplay:true,startMilliseconds:0},{type:'video',title:'显示同步验收'},1,-1)`);
            await until(async()=>await prop('time-pos')>0.2,'playing');
            const started=Date.now();
            report.vo=await prop('current-vo');report.context=await prop('current-gpu-context');report.syncInterval=await prop('d3d11-sync-interval');
            assert.equal(await prop('video-sync'),'display-resample','the fixture starts with the default display resampling');
            if(unthrottled){
                assert.equal(report.context,'d3d11','the unthrottled case needs the native D3D11 output');
                assert.equal(report.syncInterval,0,'the swaps must not wait for the refresh in this case');
            }
            if(!await prop('user-data/uosc_danmaku/has-danmaku'))await cmd('script-message-to','uosc_danmaku','show_danmaku_keyboard');
            await until(()=>prop('user-data/uosc_danmaku/has-danmaku'),'local comments shown');
            let worst=0,fallbackAt=0;
            for(let i=0;i<24;i++){
                await wait(500);
                const sample=await snapshot(Date.now()-started);report.samples.push(sample);
                if(!fallbackAt){
                    worst=Math.max(worst,Math.abs(sample.avsync||0));
                    if(sample['user-data/tigerest/display-sync-fallback']===true)fallbackAt=sample.at;
                }
            }
            const last=report.samples.at(-1);
            report.worstBeforeFallback=worst;report.fallbackAfterMs=fallbackAt||null;
            if(unthrottled){
                assert.ok(worst>0.2,'the case must reproduce the drift before the fallback, worst '+worst);
                assert.ok(fallbackAt&&fallbackAt<9000,'the fallback must follow within a few seconds, at '+fallbackAt);
                assert.equal(last['video-sync'],'audio','playback is paced by the audio clock, danmaku shown');
                // Wait for the audio to reach the frame the video stopped on.
                const settled=await until(async()=>{const s=await snapshot(Date.now()-started);report.samples.push(s);return typeof s.avsync==='number'&&Math.abs(s.avsync)<0.08?s:null;},'audio and video back together',400);
                report.inSyncAfterMs=settled.at;
                const position=settled['time-pos'];await wait(2000);
                const later=await snapshot(Date.now()-started);report.samples.push(later);
                assert.ok(typeof later.avsync==='number'&&Math.abs(later.avsync)<0.08,'playback stays in sync, avsync '+later.avsync);
                assert.ok(later['time-pos']-position>1.5&&later['time-pos']-position<2.6,'playback runs at normal speed again: '+(later['time-pos']-position));
                const log=fs.readdirSync(profile,{recursive:true}).filter(f=>path.basename(f)==='Tigerest Theater.log').map(f=>fs.readFileSync(path.join(profile,f),'utf8')).join('\n');
                assert.ok(log.includes('Display sync cannot keep audio and video together'),'the fallback is logged with its numbers');
                // The next item starts on the audio clock straight away.
                await evaluate(`api.player.load(${JSON.stringify(pathToFileURL(clip).href)},{autoplay:true,startMilliseconds:30000},{type:'video',title:'显示同步验收'},1,-1)`);
                await until(async()=>await prop('time-pos')>30.5,'second item playing');
                await wait(3000);
                const second=await snapshot(Date.now()-started);report.second=second;
                assert.equal(second['video-sync'],'audio','the next item keeps the audio clock');
                assert.ok(typeof second.avsync==='number'&&Math.abs(second.avsync)<0.08,'the next item is in sync from the start, avsync '+second.avsync);
            }else{
                assert.equal(fallbackAt,0,'healthy display sync must be left alone');
                assert.equal(last['video-sync'],'display-resample');
                assert.ok(worst<0.1,'healthy playback stays in sync, worst '+worst);
            }
            await evaluate('api.player.stop()');
        }finally{ipc.end();}
    },{gpu:true,visible:true,startupTimeout:120000,args:['--log-level','info'],
        settings:{video:{sync_mode:'display-resample','refreshrate.auto_switch':false,'hdr.auto_switch':false,aiRife:false},mpv:{renderBackend:'gpu-next',shaderPreset:'default'}},
        prepareProfile:async root=>{
            // Reaches mpv.conf's managed tail through the client's test hook
            // before mpv initializes; muted, the audio clock still runs.
            process.env.TIGEREST_MPV_TEST_OPTIONS='input-ipc-server='+pipe+'\nmute=yes'+(unthrottled?'\nd3d11-sync-interval=0':'');
            clip=path.join(root,'display-sync-acceptance.mp4');fs.copyFileSync(source,clip);
            fs.writeFileSync(clip.replace(/\.mp4$/,'.xml'),'<i>'+Array.from({length:160},(_,i)=>`<d p="${i*.5},1,25,16777215,0,0,0,${i}">显示同步验证 ${i}</d>`).join('')+'</i>');
        }});
}
(async()=>{
    const cases=process.env.TIGEREST_SYNC_CASE?[process.env.TIGEREST_SYNC_CASE]:['healthy','unthrottled'];
    const output=path.resolve(process.env.TIGEREST_TEST_REPORT||'build/display-sync-fallback.json'),reports=[];
    for(const name of cases){
        const report={};reports.push(report);
        try{await run(name,report);}finally{fs.writeFileSync(output,JSON.stringify(reports,null,2));}
        console.log(JSON.stringify({case:name,vo:report.vo,context:report.context,worstBeforeFallback:report.worstBeforeFallback,
            fallbackAfterMs:report.fallbackAfterMs,inSyncAfterMs:report.inSyncAfterMs??null,secondItem:report.second?{sync:report.second['video-sync'],avsync:report.second.avsync}:null}));
    }
    console.log(JSON.stringify({completed:true,scope:'full QtWebEngine/mpv client, isolated profile, local clip and danmaku; unthrottled swaps simulated with d3d11-sync-interval=0'}));
})().catch(e=>{console.error(e);process.exitCode=1});
