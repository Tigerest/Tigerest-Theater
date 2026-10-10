// Isolated Chromium/QtWebEngine fixture host; never uses an Emby account.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const net=require('node:net');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const configVersion=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../resources/settings/settings_description.json'),'utf8')).find(section=>section.section==='__meta__').version;

module.exports=async function withBrowser(routes,work,{settings={},gpu=false,visible=false,prepareProfile,startupTimeout=12000}={}){
    if(process.env.TIGEREST_ANDROID_FIXTURE) return require('../android/tests/android_browser.cjs')(routes,work,{settings});
    const executable=process.argv[2]?path.resolve(process.argv[2]):null,webengine=process.argv.includes('--webengine');
    assert.ok(executable&&fs.existsSync(executable),'supply a browser executable');
    const server=http.createServer((req,res)=>{
        const route=routes[new URL(req.url,'http://fixture').pathname];
        if(!route){res.writeHead(404);res.end();return;}
        res.setHeader('Content-Type',route.type||'text/javascript; charset=utf-8');
        res.end(route.path?fs.readFileSync(route.path):route.body);
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const url='http://127.0.0.1:'+server.address().port;
    const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tigerest-messages-'));
    let port,child,socket;
    try{
    if(webengine){
        const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
        port=listener.address().port;await new Promise(r=>listener.close(r));
        const id=require('node:crypto').randomUUID().replaceAll('-','');
        const folder=path.join(profile,'profiles',id);fs.mkdirSync(folder,{recursive:true});
        fs.writeFileSync(path.join(folder,'profile.json'),JSON.stringify({name:'MessagesFixture'}));
        fs.writeFileSync(path.join(folder,'Tigerest Theater.conf'),JSON.stringify({version:configVersion,sections:{
            ...settings,main:{...settings.main,enableWindowsTrayIcon:false},path:{...settings.path,startupurl_desktop:url}}}));
        if(prepareProfile)await prepareProfile(profile,folder);
    }
    const args=webengine?['--config-dir',profile,'--profile','MessagesFixture',...(gpu?[]:['--disable-gpu']),'--remote-debugging-port','127.0.0.1:'+port]
        :['--headless','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,url];
    child=spawn(executable,args,{stdio:['ignore','pipe','pipe'],windowsHide:!visible,cwd:path.dirname(executable)});
    let startup='';child.stdout.on('data',d=>startup=(startup+d).slice(-2000));child.stderr.on('data',d=>startup=(startup+d).slice(-2000));
        const startupDeadline=Date.now()+startupTimeout;
        while(Date.now()<startupDeadline){
            assert.equal(child.exitCode,null,'browser exited: '+startup);
            try{
                if(!webengine)port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
                await fetch('http://127.0.0.1:'+port+'/json/list');break;
            }catch{await delay(100);}
        }
        let page;
        while(Date.now()<startupDeadline){
            const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
            page=pages.find(p=>p.type==='page');if(page)break;await delay(100);
        }
        assert.ok(page,'browser page available: '+startup);
        socket=new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
        let id=0;const pending=new Map();
        socket.addEventListener('message',e=>{
            const m=JSON.parse(e.data),entry=pending.get(m.id);
            if(entry){pending.delete(m.id);m.error?entry.reject(Error(m.error.message)):entry.resolve(m.result);}
        });
        const call=(method,params={})=>new Promise((resolve,reject)=>{
            const current=++id,timer=setTimeout(()=>{pending.delete(current);reject(Error(method+' timeout'));},15000);
            pending.set(current,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
            socket.send(JSON.stringify({id:current,method,params}));
        });
        const evaluate=async expression=>{
            if(process.env.TIGEREST_BROWSER_TRACE) console.log('fixture evaluate:',expression);
            const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
            if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));
            return r.result.value;
        };
        await call('Page.navigate',{url});
        for(let i=0;i<100;i++){if(await evaluate('document.readyState==="complete"'))break;await delay(50);}
        // Native macOS windows launched directly can remain behind the runner's
        // desktop. Give the fixture a foreground WebContents before testing
        // animation frames and short asynchronous bridge callbacks.
        await call('Page.bringToFront');
        await call('Emulation.setFocusEmulationEnabled',{enabled:true});
        await work({url,call,evaluate,webengine,pid:child.pid,profile,devToolsPort:port});
    }finally{
        socket?.close();
        if(child&&child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}
        await new Promise(r=>server.close(r));await delay(150);
        assert.equal(path.dirname(path.resolve(profile)),path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('tigerest-messages-'));
        fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
    }
};
