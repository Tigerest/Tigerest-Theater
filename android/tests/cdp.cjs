const {execFileSync}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const adb=process.env.ADB || 'C:/platform-tools-latest-windows/platform-tools/adb.exe';
const serial=process.env.ANDROID_SERIAL || 'cd8bdd86';
const run=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',windowsHide:true,timeout:15000}).trim();
async function connect(){
 let pid;for(let i=0;i<100;i++){try{pid=run('shell','pidof','top.tigerest.theater.debug');}catch{}if(pid)break;await delay(100);}
 if(!pid)throw Error('Android debug client is not running');
 run('forward','tcp:9223','localabstract:webview_devtools_remote_'+pid);
 let page;
 // A newly installed WebView can take several seconds to expose its target.
 for(let i=0;i<100;i++){
  try{const pages=await(await fetch('http://127.0.0.1:9223/json/list',{signal:AbortSignal.timeout(1500)})).json();page=pages.find(p=>p.type==='page');if(page)break;}catch{}
  await delay(100);
 }
 if(!page)throw Error('WebView debugging target unavailable');
 const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{const timer=setTimeout(()=>{socket.close();j(Error('Android WebView debugging connection timeout'));},5000);socket.addEventListener('open',()=>{clearTimeout(timer);r();},{once:true});socket.addEventListener('error',e=>{clearTimeout(timer);j(e);},{once:true});});
 let next=0,closed=false;const pending=new Map(),listeners=new Set();
 socket.addEventListener('close',()=>{closed=true;for(const entry of pending.values())entry.reject(Error('Android WebView debugging connection closed'));pending.clear();});
 socket.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else for(const listener of listeners)listener(m);});
 const call=(method,params={})=>new Promise((resolve,reject)=>{if(closed){reject(Error('Android WebView debugging connection closed'));return;}const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},45000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 return {call,evaluate,onEvent:listener=>listeners.add(listener),close:()=>socket.close(),page};
}
module.exports={connect,run,delay,adb,serial};
if(require.main===module)(async()=>{const c=await connect();try{console.log(JSON.stringify(await c.evaluate(process.argv[2] || '({url:location.href,title:document.title,body:document.body?.innerText,api:!!window.api,bootstrap:!!window.jmpInfo})'),null,2));}finally{c.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
