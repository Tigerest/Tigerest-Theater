// Real Chromium DOM test, independent of personal Emby accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {setTimeout:delay} = require('node:timers/promises');

async function run() {
    const source=path.join(__dirname,'../native/communityPlugin.js');
    assert.ok(fs.existsSync(source), 'detail-page comment plugin must exist');
    const browserExe=process.argv[2];
    assert.ok(browserExe && fs.existsSync(browserExe), 'supply a Chromium executable');
    const server=http.createServer((req,res)=>{
        res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/html');
        if(req.url==='/client.js')res.end(fs.readFileSync(path.join(__dirname,'../native/communityClient.js')));
        else if(req.url==='/plugin.js')res.end(fs.readFileSync(source));
        else res.end('<html><meta charset="utf-8"><style>body{background:#151923;color:#e7edf7;font:16px sans-serif;margin:30px}.itemView{max-width:1000px;margin:auto}</style><div class="itemView"><div class="itemMainScrollSlider"><h1>剧集详情 · 评论区验收</h1></div></div><script src="/client.js"></script><script src="/plugin.js"></script></html>');
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const fixtureUrl='http://127.0.0.1:'+server.address().port;
    const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tigerest-comments-'));
    const webengine=process.argv.includes('--webengine');
    let fixedPort;
    const profileId=require('node:crypto').randomUUID().replaceAll('-','');
    const profileName='CommunityFixture-'+profileId;
    if(webengine){
        const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
        fixedPort=listener.address().port;await new Promise(r=>listener.close(r));
        const config=path.join(profile,'profiles',profileId);fs.mkdirSync(config,{recursive:true});
        fs.writeFileSync(path.join(config,'profile.json'),JSON.stringify({name:profileName}));
        fs.writeFileSync(path.join(config,'Tigerest Theater.conf'),JSON.stringify({version:10,sections:{main:{enableWindowsTrayIcon:false},path:{startupurl_desktop:fixtureUrl}}}));
    }
    const args=webengine?['--config-dir',profile,'--profile',profileName,'--disable-gpu','--remote-debugging-port','127.0.0.1:'+fixedPort]
        :['--headless','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,fixtureUrl];
    const child=spawn(browserExe,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,cwd:path.dirname(browserExe)});
    let startup='';child.stdout.on('data',d=>startup=(startup+d).slice(-2500));child.stderr.on('data',d=>startup=(startup+d).slice(-2500));
    let socket;
    try {
        let port;
        for(let i=0;i<100;i++){
            assert.equal(child.exitCode,null,'browser exited early: '+startup);
            try {
                if(webengine){await fetch('http://127.0.0.1:'+fixedPort+'/json/list');port=fixedPort;}
                else port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
                break;
            }catch{}
            await delay(100);
        }
        assert.ok(port,'Chromium started');
        let page;
        for(let i=0;i<100;i++){
            const pages=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
            page=pages.find(p=>p.type==='page');if(page)break;await delay(100);
        }
        assert.ok(page,'browser creates a page');
        socket=new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
        let id=0; const pending=new Map();
        socket.addEventListener('message',e=>{const m=JSON.parse(e.data); if(pending.has(m.id)){const {r,j}=pending.get(m.id);pending.delete(m.id);m.error?j(Error(m.error.message)):r(m.result);}});
        const call=(method,params={})=>new Promise((r,j)=>{
            const current=++id;const timer=setTimeout(()=>{pending.delete(current);j(Error(method+' timed out'));},10000);
            pending.set(current,{r:result=>{clearTimeout(timer);r(result);},j:error=>{clearTimeout(timer);j(error);}});
            socket.send(JSON.stringify({id:current,method,params}));
        });
        const evaluate=async expression=>{
            const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
            if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
        };
        if(webengine)await call('Page.navigate',{url:fixtureUrl});
        for(let i=0;i<100;i++){
            if(await evaluate('typeof window._communityPlugin === "function"'))break;
            await delay(50);
        }
        const result=await evaluate(`(async()=>{
            const check=(value,message)=>{if(!value)throw Error(message);};
            const tick=()=>new Promise(r=>setTimeout(r,30));
            const requests=[];
            let admin=false, muted=false, failSend=false, deletedTarget=false;
            const author={id:'author',name:'小河',avatarPath:null};
            const comment={id:'root',topicId:'episode-topic',rootId:null,state:'visible',body:'<img src=x onerror=alert(1)>你好\\n第二行',createdAt:'2026-10-01T02:00:00Z',author,replyCount:4,
                permissions:{canReply:true,canDelete:true,canModerate:true},
                replies:[{id:'reply1',rootId:'root',author,body:'第一条回复',state:'visible',replyToAuthor:{name:'大河'},createdAt:'2026-10-01T02:01:00Z',permissions:{canReply:true,canDelete:true}}],repliesNextCursor:'next-reply'};
            const api={serverId:()=> '62526c3bf747439c99327ddec5fed4a8',getCurrentUserId:()=> 'user',accessToken:()=> 'fixture-token',serverAddress:()=> 'http://nas.tigerest.top:8095',
                getItem:async(user,id)=>({Id:id,Type:'Episode',Name:'第一集'})};
            window.fetch=async(url,opt)=>{
                requests.push({url,method:opt.method,body:opt.body&&JSON.parse(opt.body),headers:opt.headers});
                let data={};
                if(url.endsWith('/me'))data={author,isCommentAdmin:admin,muted,muteState:muted?'permanent':'none'};
                else if(url.endsWith('/topics/resolve'))data={id:JSON.parse(opt.body).scope+'-topic',title:'验收剧集',scope:JSON.parse(opt.body).scope};
                else if(url.includes('/replies?'))data={items:[{...comment.replies[0]},{...comment.replies[0],id:'reply2',body:'继续加载的回复'}],nextCursor:null};
                else if(url.includes('/comments?'))data={items:[comment],nextCursor:null,rootCount:1};
                else if(url.includes('/admin/mutes?'))data={items:[{id:'muted-user',name:'已禁言用户',muted:true,muteState:'permanent'}],nextCursor:null};
                else if(url.includes('/admin/actions?'))data={items:[{id:1,action:'mute',targetId:'muted-user',reason:'刷屏',createdAt:'2026-10-01T02:00:00Z'}],nextCursor:null};
                else if(opt.method==='POST'&&!url.includes('/admin/')){if(failSend){failSend=false;throw new TypeError('network');}
                    if(deletedTarget){deletedTarget=false;return new Response(JSON.stringify({error:{code:'TARGET_DELETED'}}),{status:409});}
                    data={comment:{id:'new'},replayed:false};}
                return new Response(JSON.stringify({data}),{status:200});
            };
            const handlers={};
            window.TigerestCommunityAccount=undefined; window.TigerestCommunityClient.trustedServerId=undefined; const plugin=new window._communityPlugin({connectionManager:{currentApiClient:()=>api},events:{on:(o,n,f)=>handlers[n]=f,off:()=>{}}});
            const view=document.querySelector('.itemView');
            const show=(item)=>view.dispatchEvent(new CustomEvent('itemshow',{bubbles:true,detail:{item}}));
            const click=(label)=>{const e=Array.from(document.querySelectorAll('#tigerest-community button')).find(e=>e.textContent===label);check(e,'missing '+label);e.click();};
            let finishMetadata, metadataSignal;
            const originalGetItem=api.getItem;
            api.getItem=(user,id,options,signal)=>{metadataSignal=signal;return new Promise(r=>finishMetadata=r);};
            const resumeController=new AbortController();
            view.dispatchEvent(new CustomEvent('viewshow',{bubbles:true,detail:{params:{id:'slow-item'},currentResumeSignal:resumeController.signal}}));
            const callsBeforeHide=requests.length;
            view.dispatchEvent(new CustomEvent('viewbeforehide',{bubbles:true}));resumeController.abort();
            check(metadataSignal.aborted,'pending metadata aborts on leaving detail');
            finishMetadata({Id:'slow-item',Type:'Movie',Name:'旧页面'});await tick();
            check(!document.querySelector('#tigerest-community')&&requests.length===callsBeforeHide,'late metadata cannot mount or fetch old comments');
            api.getItem=originalGetItem;
            view.dispatchEvent(new CustomEvent('viewshow',{bubbles:true,detail:{params:{id:'direct-episode',asDialog:'true'}}}));await tick();
            check(document.querySelector('#tigerest-community'),'direct detail/dialog view mounts without itemshow');
            show({Id:'episode1',Type:'Episode',Name:'第一集'});await tick();
            check(document.querySelector('#tigerest-community'),'mounted');
            check(requests.some(r=>r.body?.scope==='episode'),'episode selected by default');
            check(!document.querySelector('#tigerest-community img[src="x"]'),'HTML must not execute');
            check(document.querySelector('#tigerest-community').textContent.includes('<img src=x'),'body preserved as plaintext');
            click('加载更多回复');await tick();
            check(document.querySelectorAll('[data-comment-id="reply1"]').length===1,'reply IDs deduplicate');
            check(document.querySelector('#tigerest-community').textContent.includes('继续加载的回复'),'reply page appended');
            click('作品评论');await tick();
            check(requests.some(r=>r.body?.scope==='work'),'work tab resolves same item');
            // v1 retired posting: the dedicated discussion stays readable and deletable, never composable.
            const textarea=document.querySelector('#tigerest-community textarea');
            check(plugin.state.composer.hidden&&textarea.disabled,'v1 discussions are read-only');
            check(!Array.from(document.querySelectorAll('#tigerest-community button')).some(b=>b.textContent==='回复'),'read-only discussions offer no reply');
            click('删除');await tick();click('确认删除');await tick();
            check(requests.some(r=>r.method==='DELETE'&&r.url.endsWith('/comments/root')),'owner delete endpoint');
            check(!requests.some(r=>r.body?.clientRequestId),'no v1 comment is ever posted');
            handlers.localusersignedout();
            check(!document.querySelector('#tigerest-community'),'logout clears panel and drafts');
            admin=true;show({Id:'movie1',Type:'Movie',Name:'电影'});await tick();
            click('管理');await tick();
            check(document.querySelector('#tigerest-community').textContent.includes('已禁言用户'),'mute list');
            click('解除禁言');await tick();
            check(requests.some(r=>r.method==='DELETE'&&r.url.endsWith('/authors/muted-user/mute')),'unmute endpoint');
            click('管理记录');await tick();
            check(document.querySelector('#tigerest-community').textContent.includes('刷屏'),'audit record rendered');
            await tick();
            plugin.close();muted=true;show({Id:'movie1',Type:'Movie',Name:'电影'});await tick();
            check(document.querySelector('#tigerest-community textarea').disabled,'muted users cannot compose');
            check(!document.querySelector('[data-scope="episode"]'),'movie has no episode tab');
            plugin.close();muted=false;admin=false;show({Id:'episode1',Type:'Episode',Name:'第一集'});await tick();
            window.fixturePlugin=plugin;
            return {passed:true,requests:requests.length};
        })()`);
        assert.equal(result.passed,true);
        // QtWebEngine exposes DOM automation but not Chromium's screenshot surface.
        if(process.env.COMMUNITY_SCREENSHOT&&!webengine){
            const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
            fs.writeFileSync(process.env.COMMUNITY_SCREENSHOT,Buffer.from(shot.data,'base64'));
        }
        await evaluate('window.fixturePlugin.destroy()');
        console.log(JSON.stringify(result));
    } finally {
        socket?.close();
        if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}
        await new Promise(r=>server.close(r));
        // profile belongs solely to this test; Chromium may still release locks.
        await delay(200);
        assert.equal(path.dirname(path.resolve(profile)),path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('tigerest-comments-'));
        fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
    }
}
run().catch(error=>{console.error(error.message);process.exitCode=1;});
