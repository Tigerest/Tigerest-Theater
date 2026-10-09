// Exercise the real native updater using its debug-only loopback transport.
// Install update-base-2.4.1-debug.apk first. Candidate must be a newer, same-key DEBUG APK.
// Ends at Android's install/permission screen; it never approves an OS dialog itself.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {run,connect,delay}=require('./cdp.cjs');
const apk=path.resolve(process.env.TIGEREST_UPDATE_APK||path.join(__dirname,'../test-artifacts/update-candidate-2.4.2-debug.apk'));
const bytes=fs.readFileSync(apk),hash=crypto.createHash('sha256').update(bytes).digest('hex');
let mode='good',slow=false,c,port,releaseRequests=0,downloadRequests=0,rangeRequests=0;
const release=()=>[{tag_name:'v2.4.2',html_url:'https://github.com/Tigerest/Tigerest-Theater/releases/tag/v2.4.2',draft:false,prerelease:false,
 body:'更新检测实机验收\n升级到 2.4.2，保留现有设置。',assets:[{name:'TigerestTheater-2.4.2-android.apk',state:'uploaded',size:bytes.length,
 digest:'sha256:'+(mode==='bad-hash'?'0'.repeat(64):hash),browser_download_url:'https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.4.2/TigerestTheater-2.4.2-android.apk'}]}];
const server=http.createServer((req,res)=>{
 if(req.url==='/releases'){releaseRequests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(release()));return;}
 if(req.url==='/download'){
  downloadRequests++;
  // Honour resume requests like GitHub's asset host does.
  const start=Number(/^bytes=(\d+)-$/.exec(req.headers.range||'')?.[1]||0),resumed=start>0&&start<bytes.length,body=resumed?bytes.subarray(start):bytes;
  if(resumed){rangeRequests++;res.writeHead(206,{'Content-Type':'application/octet-stream','Content-Length':body.length,'Content-Range':`bytes ${start}-${bytes.length-1}/${bytes.length}`});}
  else res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length});
  if(!slow){res.end(body);return;}
  let offset=0;const timer=setInterval(()=>{const next=Math.min(offset+256*1024,body.length);res.write(body.subarray(offset,next));offset=next;if(offset===body.length){clearInterval(timer);res.end();}},12);
  res.on('close',()=>clearInterval(timer));return;
 }
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#10141c;color:white"><h1>更新流程验收</h1></body>');
});
async function wait(expression){for(let i=0;i<240;i++){try{if(await c.evaluate(expression))return;}catch(e){if(!/context.*destroyed|Cannot find context/i.test(e.message))throw e;}await delay(150);}throw Error('Timeout: '+expression+'\n'+JSON.stringify(await c.evaluate('api.system.appUpdateState()')));}
async function reload(){await c.evaluate('window.__updateReloadMark=true');await c.call('Page.reload');await wait('!window.__updateReloadMark&&!!window.api&&!!window.TigerestUpdate&&document.readyState==="complete"');}
async function launch(){
 c?.close();run('shell','am','force-stop','top.tigerest.theater.debug');
 run('shell','am','start','-n','top.tigerest.theater.debug/top.tigerest.theater.MainActivity','--es','url','http://127.0.0.1:'+port,'--es','updateFixture','http://127.0.0.1:'+port);
 c=await connect();await wait('!!window.api?.system?.appUpdateState&&!!window.TigerestUpdate');
}
async function click(action){await wait(`!!document.querySelector('[data-update-action="${action}"]')`);await c.evaluate(`document.querySelector('[data-update-action="${action}"]').click()`);}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
 run('reverse','tcp:'+port,'tcp:'+port);
 run('shell','am','force-stop','top.tigerest.theater.debug');
 run('shell','run-as','top.tigerest.theater.debug','rm','-f','shared_prefs/app-updates.xml');
 await launch();await wait('api.system.appUpdateState().then(s=>s.status==="available")');
 assert.equal((await c.evaluate('api.system.appUpdateState()')).version,'2.4.2');
 await wait('document.querySelector("#tigerest-update-dialog")?.open');
 const count=releaseRequests;await click('close');await wait('api.system.appUpdateState().then(s=>s.deferred)');
 await reload();await c.evaluate('TigerestUpdate.start()');
 assert.equal(releaseRequests,count,'page reload must not duplicate automatic check');
 assert.equal(await c.evaluate('!!document.querySelector("#tigerest-update-dialog[open]")'),false,'Later survives page reload');
 await c.evaluate('TigerestUpdate.check()');await wait('api.system.appUpdateState().then(s=>s.status==="available"&&!s.deferred)');await click('skip');
 await wait('api.system.appUpdateState().then(s=>s.status==="idle"&&s.deferred)');
 for(let i=0;i<50;i++){try{if(run('shell','run-as','top.tigerest.theater.debug','cat','shared_prefs/app-updates.xml').includes('2.4.2'))break;}catch{}await delay(100);}
 await launch();await wait('api.system.appUpdateState().then(s=>s.status==="current")');
 assert.equal(await c.evaluate('!!document.querySelector("#tigerest-update-dialog[open]")'),false,'skip survives app restart');
 mode='bad-hash';await c.evaluate('TigerestUpdate.check()');await wait('api.system.appUpdateState().then(s=>s.status==="available")');await click('download');
 await wait('api.system.appUpdateState().then(s=>s.status==="error")');
 assert.match((await c.evaluate('api.system.appUpdateState()')).error,/SHA-256/,'corrupt package must not be installed');
 assert.ok(await c.evaluate('document.querySelector("#tigerest-update-dialog").textContent.includes("SHA-256")'));
 mode='good';slow=true;await c.evaluate('TigerestUpdate.check()');await wait('api.system.appUpdateState().then(s=>s.status==="available")');await click('download');
 await wait('api.system.appUpdateState().then(s=>s.status==="downloading"&&s.received>0)');await click('cancel');
 await wait('api.system.appUpdateState().then(s=>s.status==="available"&&!s.installAfterDownload)');
 await c.evaluate('api.settings.setValue("danmaku","opacity",0.5)');
 await click('download');await wait('api.system.appUpdateState().then(s=>s.status==="downloading"&&s.received>0)');
 await reload();
 await wait('api.system.appUpdateState().then(s=>s.status==="installing"&&!s.installAfterDownload)');
 assert.ok(rangeRequests>0,'downloading again after cancel must resume the kept prefix');
 console.log(JSON.stringify({passed:true,startup:true,laterAcrossNavigation:true,skipAcrossRestart:true,manualBypassesSkip:true,hashRejection:true,cancelRetry:true,cancelResumes:true,oneClickSurvivesReload:true,installerHandoff:true,releaseRequests,downloadRequests,rangeRequests}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{c?.close();try{if(port)run('reverse','--remove','tcp:'+port);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}});
