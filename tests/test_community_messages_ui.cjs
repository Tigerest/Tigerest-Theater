const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const withBrowser=require('./community_browser.cjs');
const repo=path.join(__dirname,'..');
// QtWebEngine must exercise the scripts embedded in the executable. Chromium
// loads source files explicitly because it has no native shell injection.
const scripts=process.argv.includes('--webengine')?'':'<script src="/client.js"></script><script src="/messages.js"></script><script src="/plugin.js"></script>';
const routes={
    '/':{type:'text/html',body:'<!doctype html><meta charset="utf-8"><style>body{background:#151923;color:#e7edf7;font:16px sans-serif}.headerRight{display:flex;justify-content:flex-end}</style><div class="headerRight"></div><div class="itemView"><div class="itemMainScrollSlider"><h1>媒体详情</h1></div></div>'+scripts},
    '/client.js':{path:path.join(repo,'native/communityClient.js')},
    '/messages.js':{path:path.join(repo,'native/communityMessages.js')},
    '/plugin.js':{path:path.join(repo,'native/communityPlugin.js')},
};
async function run(){
    assert.ok(fs.existsSync(routes['/messages.js'].path),'message center implementation must exist');
    await withBrowser(routes,async({call,evaluate,webengine})=>{
        const result=await evaluate('('+ (async function(){
            const check=(v,m)=>{if(!v)throw Error(m);};
            const wait=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('condition timeout');};
            await wait(()=>window.TigerestCommunityMessages&&window._communityPlugin);
            const find=(label,root=document)=>Array.from(root.querySelectorAll('button')).find(b=>b.textContent===label);
            const click=label=>{const b=find(label);check(b,'button: '+label);b.click();};
            let token='fixture-token',unread=2,hold=false,release,missing=false,unavailable=false,expire=false,unauthorized=false,anchorMissing=false;
            let snapshot='snapshot-visible',summaryHold=false,releaseSummary,readIds=new Set();
            const requests=[],handlers={},navigations=[];
            const author={id:'author',name:'测试作者',avatarPath:null};
            const comment=(id,body,rootId=null)=>({id,topicId:'topic',rootId,replyToId:rootId,author,body,state:'visible',createdAt:'2026-10-04T10:00:00Z',permissions:{canReply:true},replies:[],repliesNextCursor:null});
            const location=(id,rootId='old-root',canNavigate=true)=>({embyServerId:'62526c3bf747439c99327ddec5fed4a8',itemId:'movie1',scope:'work',topicId:'topic',rootId,commentId:id,title:'测试作品 <b>原样</b>',workTitle:null,seasonNumber:null,episodeNumber:null,canNavigate});
            const record=(id,c)=>({id,reply:c,originalComment:comment('original','我的原发言'),location:location(c.id,c.rootId),availability:'available',readAt:readIds.has(id)?'2026-10-04T11:00:00Z':null,isRead:readIds.has(id),createdAt:c.createdAt});
            const own=(id,body,canNavigate=true)=>({comment:comment(id,body),availability:'available',location:location(id,id,canNavigate)});
            const replies=()=>({items:[record('notification1',comment('reply1','<img src=x onerror=alert(1)> 回复内容','old-root')),record('notification2',comment('reply2','第二条回复','old-root')),
                {id:'unavailable',createdAt:'2026-10-04T10:00:00Z',isRead:true,readAt:'2026-10-04T11:00:00Z',availability:'unavailable',reply:null,originalComment:null,location:null}],nextCursor:null,unreadCount:unread,readThroughToken:snapshot});
            window.fetch=async(url,o)=>{
                const u=new URL(url),p=u.pathname.replace('/community/v1','');requests.push({p,query:u.search,method:o.method,body:o.body,headers:o.headers});
                if(unauthorized)return Response.json({error:{code:'AUTH_INVALID'}},{status:401});
                if(anchorMissing&&u.searchParams.has('anchorId'))return Response.json({error:{code:'NOT_FOUND'}},{status:404});
                if(p==='/me/messages'&&o.method==='POST'){
                    const b=JSON.parse(o.body);
                    if(b.readThroughToken){
                        if(expire){expire=false;return Response.json({error:{code:'INVALID_REQUEST'}},{status:400});}
                        check(b.readThroughToken==='snapshot-visible','use displayed list snapshot, never polling snapshot');
                        readIds.add('notification1');readIds.add('notification2');unread=1;
                    }else {check(b.messageIds.length===1,'single notification read');readIds.add(b.messageIds[0]);unread--;}
                    return Response.json({data:{markedCount:1,unreadCount:unread}});
                }
                if(p==='/me/messages'&&u.searchParams.get('limit')==='1'){
                    if(summaryHold){summaryHold=false;return new Promise(r=>releaseSummary=(status=200)=>r(status===200?Response.json({data:{...replies(),unreadCount:99,readThroughToken:'poll-newer'}}):Response.json({error:{code:'AUTH_INVALID'}},{status})));}
                    return Response.json({data:{...replies(),readThroughToken:'poll-newer'}});
                }
                if(p==='/me/messages'||p==='/me/comments'){
                    if(missing)return Response.json({error:{code:'NOT_FOUND'}},{status:404});
                    if(unavailable)return Response.json({error:{code:'COMMUNITY_UNAVAILABLE'}},{status:503});
                    if(hold){hold=false;return new Promise(r=>release=(status=200)=>r(status===200?Response.json({data:{items:[own('stale','旧回复不应出现')],nextCursor:null}}):Response.json({error:{code:'AUTH_INVALID'}},{status})));}
                    if(p==='/me/comments')return Response.json({data:{items:u.searchParams.has('cursor')?[own('own1','我的评论'),own('own2','我的回复')]:[own('own1','我的评论'),{...own('deleted',null,false),comment:{...comment('deleted',null),state:'author_deleted'}}],totalCount:3,nextCursor:u.searchParams.has('cursor')?null:'page+/='}});
                    return Response.json({data:replies()});
                }
                if(p==='/me')return Response.json({data:{author,isCommentAdmin:false,muted:false}});
                if(p==='/topics/resolve')return Response.json({data:{id:'topic',scope:'work',title:'测试作品'}});
                if(p==='/topics/topic/comments')return Response.json({data:{items:u.searchParams.has('anchorId')?[comment('old-root','旧主评论')]:[comment('new-root','新评论')],nextCursor:u.searchParams.has('anchorId')?'roots-next':null}});
                if(p==='/comments/old-root/replies')return Response.json({data:{items:u.searchParams.has('anchorId')?[comment('reply1','需要定位的回复','old-root')]:[comment('reply3','下一页回复','old-root')],nextCursor:u.searchParams.has('anchorId')?'replies-next':null}});
                throw Error('unhandled '+p);
            };
            const api={serverId:()=> '62526c3bf747439c99327ddec5fed4a8',getCurrentUserId:()=> 'user1',accessToken:()=>token,serverAddress:()=> 'https://nas.tigerest.top:18445'};
            window.TigerestCommunityAccount=undefined; window.TigerestCommunityClient.trustedServerId=undefined; const plugin=new window._communityPlugin({connectionManager:{currentApiClient:()=>api},events:{on:(x,k,h)=>handlers[k]=h,off(){}},appRouter:{show:async p=>navigations.push(p)}});
            plugin.messages.sync();await wait(()=>document.querySelector('#tigerest-message-entry')?.textContent.includes('2'));
            check(!plugin.state,'entry works away from detail pages');
            document.querySelector('#tigerest-message-entry').click();
            await wait(()=>document.querySelector('[data-message-id="notification1"]'));
            const panel=document.querySelector('#tigerest-messages');
            check(panel.textContent.includes('我的原发言'),'received reply context');
            check(panel.textContent.includes('<img src=x'),'plain body');
            check(!panel.querySelector('img[src=x]'),'no HTML execution');
            check(!document.querySelector('[data-message-id="unavailable"] button'),'unavailable read placeholder cannot navigate');
            check(!requests.some(r=>r.method==='POST'),'opening a list does not read it');
            unavailable=true;click('刷新消息');await wait(()=>panel.textContent.includes('暂不可用'));
            check(panel.querySelector('[data-message-id="notification1"]'),'503 preserves displayed list');
            check(document.querySelector('#tigerest-message-entry').textContent.includes('2'),'503 preserves unread count');
            unavailable=false;click('刷新消息');await wait(()=>!plugin.messages.state.loading);
            summaryHold=true;plugin.messages.refreshSummary();await wait(()=>releaseSummary);
            click('标为已读');await wait(()=>!document.querySelector('[data-message-id="notification1"]').classList.contains('tm-unread'));
            releaseSummary();await new Promise(r=>setTimeout(r,20));
            check(!document.querySelector('#tigerest-message-entry').textContent.includes('99'),'old poll cannot roll back read result');
            click('我的发言');await wait(()=>document.querySelector('[data-message-id="own1"]'));
            const deleted=panel.querySelector('[data-message-id="deleted"]');check(deleted.textContent.includes('评论已删除'),'deleted body placeholder');
            const before=navigations.length;deleted.querySelector('button').click();await wait(()=>navigations.length>before);
            check(!plugin.pendingFocus?.commentId,'canNavigate false opens media without comment anchoring');
            await wait(()=>!document.querySelector('#tigerest-messages'));
            plugin.messages.open();await wait(()=>document.querySelector('[data-message-id="notification1"]'));
            click('我的发言');await wait(()=>document.querySelector('[data-message-id="own1"]'));
            click('加载更多消息');await wait(()=>document.querySelector('[data-message-id="own2"]'));
            check(document.querySelectorAll('[data-message-id="own1"]').length===1,'page deduplication');
            check(requests.some(r=>r.query.includes('cursor=page%2B%2F%3D')),'opaque cursor');
            hold=true;click('收到的消息');await wait(()=>release);click('我的发言');
            await wait(()=>document.querySelector('[data-message-id="own1"]'));release();await new Promise(r=>setTimeout(r,20));
            check(!document.querySelector('#tigerest-messages').textContent.includes('旧回复不应出现'),'tab race discarded');
            click('收到的消息');await wait(()=>document.querySelector('[data-message-id="notification1"]'));
            await plugin.messages.refreshSummary();
            click('全部已读');await wait(()=>requests.some(r=>r.body?.includes('readThroughToken')));
            check(JSON.parse(requests.find(r=>r.body?.includes('readThroughToken')).body).readThroughToken==='snapshot-visible','server list snapshot');
            await wait(()=>!plugin.messages.state.busy&&!plugin.messages.state.loading);
            check(document.querySelector('#tigerest-message-entry').textContent.includes('1'),'new arrival stays unread');
            expire=true;click('全部已读');await wait(()=>document.querySelector('#tigerest-messages').textContent.includes('快照已更新'));
            check(requests.filter(r=>r.body?.includes('readThroughToken')).length===2,'expired token refreshes without silently reading new snapshot');
            click('查看讨论');await wait(()=>navigations.length===2);
            check(navigations[1].includes('id=movie1'),'discussion route');
            document.querySelector('.itemView').dispatchEvent(new CustomEvent('itemshow',{bubbles:true,detail:{item:{Id:'movie1',Type:'Movie',Name:'测试作品'}}}));
            await wait(()=>document.querySelector('.tc-highlight[data-comment-id="reply1"]'));
            check(document.querySelector('[data-comment-id="old-root"]'),'old thread retrieved');
            const anchored=requests.filter(r=>r.query.includes('anchorId='));
            check(anchored.length===2,'two authorized anchor pages');
            check(anchored.every(r=>r.headers['X-Tigerest-Item-Id']==='movie1'&&!r.query.includes('cursor=')),'anchor permission and cursor exclusion');
            check(anchored[0].query.includes('anchorId=old-root')&&anchored[1].query.includes('anchorId=reply1'),'root then target reply');
            check(plugin.state.cursor==='roots-next','anchored roots retain pagination');
            click('加载更多回复');await wait(()=>document.querySelector('[data-comment-id="reply3"]'));
            check(requests.some(r=>r.p==='/comments/old-root/replies'&&r.query.includes('cursor=replies-next')&&!r.query.includes('anchorId')),'reply continuation uses server cursor');
            anchorMissing=true;await plugin.openDiscussion(replies().items[0]);
            check(document.querySelector('[data-comment-id="new-root"]'),'missing anchor falls back to accessible current discussion');
            check(plugin.state.status.textContent.includes('目标评论已不可用'),'missing anchor is not a message service error');anchorMissing=false;
            plugin.messages.open();await wait(()=>document.querySelector('[data-message-id="notification1"]'));
            hold=true;click('刷新消息');await new Promise(r=>setTimeout(r,20));
            handlers.localusersignedout();
            check(!document.querySelector('#tigerest-messages'),'logout clears message content immediately');
            token=null;plugin.messages.sync();release();await new Promise(r=>setTimeout(r,20));
            check(!document.querySelector('#tigerest-message-entry'),'logged out entry removed, stale request discarded');
            token='fixture-token';handlers.localusersignedin();missing=true;plugin.messages.open();
            await wait(()=>document.querySelector('#tigerest-messages')?.textContent.includes('升级评论服务'));
            missing=false;plugin.messages.close();plugin.messages.open();await wait(()=>document.querySelector('[data-message-id="notification1"]'));
            unauthorized=true;click('刷新消息');await wait(()=>!document.querySelector('#tigerest-messages'));
            check(!document.querySelector('#tigerest-message-entry'),'expired account clears private messages immediately');
            unauthorized=false;handlers.localusersignedin();plugin.messages.open();await wait(()=>document.querySelector('[data-message-id="notification1"]'));
            summaryHold=true;releaseSummary=null;plugin.messages.refreshSummary();await wait(()=>releaseSummary);
            click('刷新消息');await wait(()=>!plugin.messages.state.loading);
            releaseSummary(401);await wait(()=>!document.querySelector('#tigerest-messages'));
            check(!document.querySelector('#tigerest-message-entry'),'delayed unauthorized poll clears the newer list');
            handlers.localusersignedin();plugin.messages.open();await wait(()=>document.querySelector('[data-message-id="notification1"]'));
            hold=true;release=null;click('我的发言');await wait(()=>release);click('收到的消息');
            await wait(()=>document.querySelector('[data-message-id="notification1"]'));
            release(401);await wait(()=>!document.querySelector('#tigerest-messages'));
            check(!document.querySelector('#tigerest-message-entry'),'delayed unauthorized tab clears the current account');
            handlers.localusersignedin();plugin.messages.open();await wait(()=>document.querySelector('[data-message-id="notification1"]'));
            window.fixturePlugin=plugin;
            return {passed:true,requests:requests.length};
        }).toString()+')()');
        assert.equal(result.passed,true);
        if(process.env.MESSAGE_SCREENSHOT&&!webengine){
            await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
            const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.MESSAGE_SCREENSHOT,Buffer.from(shot.data,'base64'));
        }
        await evaluate('window.fixturePlugin.destroy()');console.log(JSON.stringify(result));
    });
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
