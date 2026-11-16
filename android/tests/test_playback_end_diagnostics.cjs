// Every way a playback ends leaves a line in the report diagnostics: a stop
// from the page, the end of the file, and a stream the server cuts short.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const media=path.resolve(__dirname,'../test-artifacts/playback-fixture.mp4');
let cutRequests=0;
// The server drops the connection a third of the way in and refuses the
// reconnects, as a stopped transcode or a lost proxy does.
const cut=(req,res)=>{
 if(req.url!=='/cut.mp4')return false;
 cutRequests++;
 const total=fs.statSync(media).size,cutAt=Math.floor(total*0.35),m=/bytes=(\d+)-(\d*)/.exec(req.headers.range||''),start=m?+m[1]:0;
 if(start>=cutAt){req.socket.destroy();return true;}
 res.writeHead(m?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':total-start,...(m?{'Content-Range':`bytes ${start}-${total-1}/${total}`}:{})});
 const body=fs.createReadStream(media,{start,end:cutAt-1});body.pipe(res,{end:false});body.on('end',()=>res.socket?.destroy());
 return true;
};
require('./media_fixture.cjs')(async({c,url})=>{
 const result=await c.evaluate('('+(async function(origin){
  const wait=async(test,message,limit=300)=>{for(let i=0;i<limit;i++){const log=(await api.system.collectReportDiagnostics()).logText||'';if(test(log))return log;await new Promise(r=>setTimeout(r,100));}throw Error(message);};
  const since=log=>mark=>log.slice(log.lastIndexOf(mark));
  const play=async(name,options)=>{await api.player.load(origin+'/'+name,{autoplay:true,...options},{type:'video',metadata:{Name:'结束诊断'}},1,-1);};
  await api.system.setReportDiagnosticsScope('fixture-playback-end');
  const danmaku=await api.settings.value('mpv','enableDanmaku');
  try{
   await api.settings.setValue('mpv','enableDanmaku',false);
   await play('media.mp4',{startMilliseconds:5000});
   await wait(log=>/Player file loaded/.test(log),'fixture did not load');
   await new Promise(r=>setTimeout(r,1500));
   await api.player.stop();
   const stopped=await wait(log=>/Player ended: stop requested by web at \d+\.\ds of \d+\.\ds/.test(log),'web stop left no record');
   await play('media.mp4',{startMilliseconds:86000});
   const finished=since(await wait(log=>/Player ended: end of file/.test(log),'end of file left no record',200))('Player ended: end of file');
   if(/ended before the duration/.test(finished))throw Error('a whole file was reported as cut short: '+finished);
   await play('cut.mp4',{startMilliseconds:25000});
   const cutLog=await wait(log=>/Player ended: (end of file|end-file without EOF)/.test(log.slice(log.lastIndexOf('Player load requested'))),'cut stream left no record',450);
   const tail=cutLog.slice(cutLog.lastIndexOf('Player load requested'));
   return {stopped:stopped.match(/Player ended: stop[^\n]*/)[0],finished:finished.split('\n')[0],cut:tail.match(/Player ended:[^\n]*/)[0],
    cutWarnings:[...new Set(tail.split('\n').filter(l=>/\[(warning|error)\] Android - mpv/.test(l)).map(l=>l.replace(/^\S+ /,'')))].slice(0,8)};
  }finally{
   await api.player.stop();await api.settings.setValue('mpv','enableDanmaku',danmaku);await api.system.setReportDiagnosticsScope('');
  }
 }).toString()+')('+JSON.stringify(url)+')');
 assert.match(result.cut,/ended before the duration|end-file without EOF/);
 console.log(JSON.stringify({passed:true,cutRequests,...result},null,2));
},cut).catch(error=>{console.error(error);process.exitCode=1;});
