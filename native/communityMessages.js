(function () {
    'use strict';
    const Client=window.TigerestCommunityClient;
    const node=(tag,text,className)=>{
        const element=document.createElement(tag);
        if(text!=null)element.textContent=String(text);
        if(className)element.className=className;
        return element;
    };
    const button=(label,action)=>{
        const element=node('button',label,'tm-button');element.type='button';
        element.addEventListener('click',action);return element;
    };
    const time=value=>{
        const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString();
    };
    const body=comment=>comment?.state==='visible'?(comment.body||''):comment?.state==='pending_review'?(comment.body??'内容待审核'):'评论已删除';
    const categories={playback_error:'播放错误',subtitle_missing:'字幕缺失',subtitle_error:'字幕错误',other:'其他问题'};
    const unavailableDiagnostics=Symbol('unavailable diagnostics bridge');
    // Qt invokes callbacks; Android may also return a Promise. Consume the first
    // delivery only and fail closed when a bridge is unavailable or unresponsive.
    function systemCall(system,name,args=[]){
        if(typeof system?.[name]!=='function')return Promise.resolve(unavailableDiagnostics);
        return new Promise(resolve=>{
            let settled=false;
            const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
            const timer=setTimeout(()=>finish(unavailableDiagnostics),5000);
            try{
                const result=system[name](...args,finish);
                if(result?.then)result.then(finish,()=>finish(unavailableDiagnostics));
                else if(result!==undefined)finish(result);
            }catch(_){finish(unavailableDiagnostics);}
        });
    }
    function reportPlatform(){
        const system=window.api?.system;
        if(window.tigerestAndroidApi||system?.isAndroid===true)return 'Android';
        for(const [flag,name]of [['isWindows','Windows'],['isMacos','macOS'],['isLinux','Linux'],['isFreeBSD','FreeBSD']]){
            if(system?.[flag]===true)return name;
        }
        // The native shell identifies Windows as Winnt and macOS as Darwin.
        // An unrecognized browser must not be reported as Linux by default.
        const userAgent=navigator.userAgent;
        for(const [pattern,name]of [[/Android/i,'Android'],[/Windows|Winnt/i,'Windows'],[/Mac|Darwin/i,'macOS'],[/FreeBSD/i,'FreeBSD'],[/Linux/i,'Linux']]){
            if(pattern.test(userAgent))return name;
        }
    }
    function style(){
        if(document.getElementById('tigerest-messages-style'))return;
        const sheet=node('style');sheet.id='tigerest-messages-style';
        sheet.textContent=`
        #tigerest-message-entry{font:inherit;color:inherit;background:transparent;border:1px solid #59697e;border-radius:20px;padding:7px 13px;margin:0 8px;cursor:pointer;white-space:nowrap}
        #tigerest-message-entry:focus-visible{outline:2px solid #79c5ff;outline-offset:3px}
        #tigerest-messages{color:#e9eff8;background:#141d2b;border:1px solid #3a4b62;border-radius:18px;padding:0;width:min(780px,calc(100vw - 32px));max-width:none;box-shadow:0 24px 90px #0008}
        #tigerest-messages::backdrop{background:#0009}
        #tigerest-messages .tm-shell{display:flex;flex-direction:column;max-height:min(800px,calc(100dvh - 48px))}
        #tigerest-messages .tm-head{padding:24px 26px 16px;border-bottom:1px solid #334156}
        #tigerest-messages .tm-title{display:flex;justify-content:space-between;gap:14px;align-items:center}
        #tigerest-messages h2{font-size:25px;margin:0}#tigerest-messages p{margin:8px 0}
        #tigerest-messages .tm-muted{color:#a9b8cb;font-size:13px;line-height:1.5}
        #tigerest-messages .tm-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:16px}
        #tigerest-messages .tm-button{font:inherit;font-size:14px;background:#24344a;color:#e9eff8;border:1px solid #43556e;border-radius:8px;padding:8px 13px;cursor:pointer}
        #tigerest-messages .tm-button:hover{background:#304c6d}
        #tigerest-messages .tm-button[aria-pressed=true]{background:#175487;border-color:#72bbf2}
        #tigerest-messages .tm-button:disabled{opacity:.45;cursor:default}
        #tigerest-messages .tm-button:focus-visible{outline:2px solid #79c5ff;outline-offset:3px}
        #tigerest-messages .tm-content{padding:8px 26px 22px;overflow:auto}
        #tigerest-messages .tm-status{margin:12px 0;color:#b5c8de;font-size:14px;white-space:pre-wrap}
        #tigerest-messages .tm-card{padding:18px;margin:12px 0;background:#1d293b;border:1px solid #33435a;border-radius:12px}
        #tigerest-messages .tm-unread{border-left:3px solid #72c6ff}
        #tigerest-messages .tm-card-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
        #tigerest-messages .tm-author{display:flex;gap:10px;align-items:center}#tigerest-messages .tc-avatar{width:36px;height:36px;border-radius:50%;background:#2c4d72;color:white;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0}
        #tigerest-messages .tm-avatar-status{display:flex;gap:10px;align-items:center;flex-wrap:wrap}#tigerest-messages .tm-avatar-status[hidden]{display:none}
        #tigerest-messages .tm-topic{color:#87c8fa;font-size:14px;margin:10px 0}
        #tigerest-messages .tm-body{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;margin:12px 0;font-size:15px}
        #tigerest-messages blockquote{margin:12px 0;padding:10px 14px;background:#111b29;border-left:2px solid #506884;border-radius:4px}
        #tigerest-messages .tm-empty{text-align:center;padding:40px 10px;color:#a9b8cb}
        #tigerest-messages .tm-field{display:block;margin:14px 0;line-height:1.7}
        #tigerest-messages textarea,#tigerest-messages select,#tigerest-messages input{box-sizing:border-box;display:block;width:100%;margin-top:6px;padding:10px;border:1px solid #59697e;border-radius:8px;background:#1d293b;color:inherit;font:inherit}
        #tigerest-messages textarea{min-height:140px;resize:vertical}
        #tigerest-messages .tm-position{border:0;padding:0;margin:14px 0;min-width:0}
        #tigerest-messages .tm-position legend{padding:0;line-height:1.7}
        #tigerest-messages .tm-time-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
        #tigerest-messages .tm-time-row .tm-field{min-width:0;margin:6px 0 0}
        #tigerest-messages .tm-diagnostics{display:flex;gap:10px;align-items:flex-start;margin:16px 0;line-height:1.5}
        #tigerest-messages .tm-diagnostics input{width:auto;margin:4px 0 0;flex:none}
        #tigerest-messages .tm-diagnostics small{display:block;color:#a9b8cb;margin-top:4px}
        @media(max-width:600px){#tigerest-messages .tm-head{padding:18px 16px 14px}#tigerest-messages .tm-content{padding:6px 14px 18px}#tigerest-messages h2{font-size:22px}#tigerest-messages .tm-card{padding:14px}}
        `.replaceAll('#tigerest-messages',':is(#tigerest-messages,#tigerest-report-form,#tigerest-report-detail)');
        (document.head||document.documentElement).appendChild(sheet);
    }
    class CommunityMessages {
        constructor({connectionManager,openDiscussion,account}){
            this.connectionManager=connectionManager;this.openDiscussion=openDiscussion;
            this.client=new Client();this.summaryVersion=0;this.lastSummary=0;this.unread=0;
            this.account=account;this.privateClient=this.client;this.publicClient=account?new window.TigerestCommunityPublicClient(account.session,account.avatars):null;
            this.unsubscribeProfile=account?.subscribeProfile?.(()=>{const state=this.state;if(state&&this.client.public&&this.valid(state))this.load(state);});
            this.unsubscribeAccount=account?.subscribe(()=>{
                this.publicClient.clear();
                if(!this.client.public)return;
                const kind=this.state?.kind;this.reset();this.sync();if(kind)this.open(kind);
            });
        }
        session(){return Client.session(this.connectionManager.currentApiClient?.());}
        valid(state){
            return this.state===state && this.sessionKey===JSON.stringify(this.session()) && Boolean(this.client.context);
        }
        sync(){
            const session=this.session(),key=(this.account?!!session?.token:Client.supported(session))?JSON.stringify(session):'';
            const nextClient=this.account&&!Client.supported(session)?this.publicClient:this.privateClient;
            // Emby logout can keep returning the old token until its network call finishes.
            // Account callbacks and polls must honor the same block as detail views.
            if(this.blockedKey===key||this.account?.blockedKey===key)return;
            if(key!==this.sessionKey||this.client!==nextClient){
                this.reset();this.client=nextClient;this.sessionKey=key;
                if(key){
                    this.client.setSession(session);
                    this.diagnosticsSystem=this.client.public?null:window.api?.system||window.tigerestAndroidApi?.system;
                    const bytes=window.crypto.getRandomValues(new Uint8Array(16));
                    this.diagnosticsScope=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
                    this.diagnosticsReady=systemCall(this.diagnosticsSystem,'setReportDiagnosticsScope',[this.diagnosticsScope]);
                }
            }
            if(!key)return;
            const host=window.TigerestServer?.headerActions?.()||document.querySelector('.headerRight');
            if(host && !this.entry?.isConnected){
                style();this.entry=button('消息',()=>this.open());this.entry.id='tigerest-message-entry';
                host.prepend(this.entry);this.badge();
            }
            if(!document.hidden && Date.now()-this.lastSummary>=60000)this.refreshSummary();
        }
        badge(){
            if(!this.entry)return;
            this.entry.textContent='消息'+(this.unread>0?' · '+(this.unread>99?'99+':this.unread):'');
            this.entry.setAttribute('aria-label','消息中心'+(this.unread>0?'，'+this.unread+' 条未读消息':''));
        }
        async refreshSummary(){
            if(!this.client.context||this.state?.loading||this.state?.busy)return;
            this.lastSummary=Date.now();
            const version=++this.summaryVersion,key=this.sessionKey;
            try{
                const summary=await this.client.messageSummary();
                if(version!==this.summaryVersion||key!==JSON.stringify(this.session()))return;
                this.updateUnread(summary);
            }catch(error){
                // Authentication invalidates this account, even if a newer view
                // superseded the poll that discovered it. Never clear a new account.
                if(error.status===401&&!this.client.public&&key===this.sessionKey&&key===JSON.stringify(this.session()))this.reset(true);
                // A badge refresh must never interrupt browsing or playback.
            }
        }
        updateUnread(data){
            if(Number.isFinite(data.unreadCount))this.unread=Math.max(0,data.unreadCount);
            this.badge();
        }
        open(kind='replies'){
            this.sync();if(!this.client.context)return;
            if(this.state){this.state.panel.focus();return;}
            style();const panel=node('dialog');panel.id='tigerest-messages';
            panel.setAttribute('aria-labelledby','tm-heading');
            const state={panel,kind,version:0,ids:new Set(),cursor:null,busy:false};
            this.state=state;
            if(window.TigerestCommunityAvatarView)state.avatarView=new window.TigerestCommunityAvatarView({client:this.client,valid:()=>this.valid(state),coordinator:this.client.public?this.account?.avatars:null});
            const shell=node('div',null,'tm-shell'),head=node('div',null,'tm-head');
            const title=node('div',null,'tm-title'),heading=node('h2','消息中心');heading.id='tm-heading';
            title.append(heading,button('关闭',()=>this.close()));head.append(title,node('p','查看回复、报错处理结果，以及你的历史发言。','tm-muted'));
            const toolbar=node('div',null,'tm-toolbar');state.tabs=[];
            if(this.account)toolbar.appendChild(button('评论账号',()=>this.account.show()));
            for(const [kind,label] of (this.client.public?[['replies','公共回复'],['sent','我的公共发言']]:[['replies','收到的消息'],['sent','我的发言'],['reports','我的报错']])){
                const tab=button(label,()=>{if(state.busy||state.kind===kind)return;state.kind=kind;this.load(state);});
                tab.dataset.kind=kind;state.tabs.push(tab);toolbar.appendChild(tab);
            }
            state.refresh=button('刷新消息',()=>this.load(state));toolbar.appendChild(state.refresh);
            state.readAll=button('全部已读',()=>this.readAll(state));toolbar.appendChild(state.readAll);head.appendChild(toolbar);
            const content=node('div',null,'tm-content');state.status=node('p','','tm-status');
            state.status.setAttribute('role','status');state.status.setAttribute('aria-live','polite');
            state.avatarStatus=node('div',null,'tm-avatar-status tm-muted');state.avatarStatus.setAttribute('role','status');state.avatarStatus.setAttribute('aria-live','polite');
            state.avatarMessage=node('span');state.avatarRetry=button('重试头像同步',()=>{if(this.valid(state))Promise.resolve(this.account.avatars.retry()).catch(()=>{});});
            state.avatarStatus.append(state.avatarMessage,state.avatarRetry);
            state.unsubscribeAvatars=this.account?.avatars?.subscribe(event=>{
                if(!this.valid(state))return;
                if(this.client.public&&event.author)state.avatarView?.update(event.author);
                this.avatarStatus(state);
            });this.avatarStatus(state);
            state.list=node('div');state.more=button('加载更多消息',()=>this.load(state,true));state.more.hidden=true;
            content.append(state.status,state.avatarStatus,state.list,state.more);shell.append(head,content);panel.appendChild(shell);
            panel.addEventListener('cancel',e=>{e.preventDefault();this.close();});
            document.body.appendChild(panel);panel.showModal();
            this.load(state);
        }
        controls(state){
            state.refresh.disabled=Boolean(state.loading||state.busy);
            state.more.disabled=Boolean(state.loading||state.busy);
            state.readAll.hidden=state.kind!=='replies';
            state.readAll.disabled=Boolean(state.loading||state.busy||!state.through||!this.unread);
            for(const tab of state.tabs){tab.disabled=state.busy;tab.setAttribute('aria-pressed',String(tab.dataset.kind===state.kind));}
        }
        error(state,error){
            if(this.state!==state||this.sessionKey!==JSON.stringify(this.session())||error.name==='AbortError')return;
            if(error.status===401&&!this.client.public){this.reset(true);return;}
            if(this.client.public&&(error.status===401||['LOGIN_REQUIRED','AUTH_REQUIRED','AUTH_INVALID'].includes(error.code))){
                state.avatarView?.clear();state.ids.clear();state.list.replaceChildren();state.cursor=null;state.more.hidden=true;state.through=null;
                state.status.textContent='注册或登录评论账号后查看评论';this.controls(state);return;
            }
            state.status.textContent=error.status===404?'消息功能尚未启用，请联系管理员升级评论服务。':
                error.message+(error.requestId?'（请求编号：'+error.requestId+'）':'');
        }
        async load(state,more=false){
            if(!this.valid(state)||state.busy||(more&&(!state.cursor||state.loading)))return;
            state.avatarView?.beginRead();
            const version=++state.version,kind=state.kind,cursor=more?state.cursor:null;
            ++this.summaryVersion;
            state.loading=true;state.status.textContent='正在加载消息…';
            // Keep a successful page through transient errors, but never mix tabs.
            if(state.loadedKind!==kind){state.avatarView?.clear();state.ids.clear();state.list.replaceChildren();state.cursor=null;state.more.hidden=true;state.through=null;}
            this.controls(state);
            try{
                const data=kind==='reports'?await this.client.reports('all',cursor):await this.client.messages(kind,cursor);
                if(!this.valid(state)||version!==state.version)return;
                if(!more){state.avatarView?.clear();state.ids.clear();state.list.replaceChildren();}
                state.loadedKind=kind;
                if(kind==='replies'){
                    this.updateUnread(data);this.lastSummary=Date.now();
                    state.through=data.readThroughToken;
                }
                for(const message of data.items||[]){
                    const id=kind==='sent'?message.comment?.id:message.id;
                    if(!id||state.ids.has(id))continue;state.ids.add(id);
                    state.list.appendChild(this.card(state,message));
                }
                if(!state.ids.size)state.list.appendChild(node('p',kind==='sent'?'还没有发言，去喜欢的作品聊聊吧。':kind==='reports'?'还没有提交报错。':'还没有收到消息。','tm-empty'));
                state.cursor=data.nextCursor;state.more.hidden=!state.cursor;
                state.status.textContent=kind==='replies'?'未读消息 '+this.unread+' 条':kind==='reports'?'你提交过的问题与处理结果':'你发表过的评论和回复';
            }catch(error){if(version===state.version||error.status===401)this.error(state,error);}
            finally{if(this.valid(state)&&version===state.version){state.loading=false;this.controls(state);}}
        }
        avatarStatus(state){
            const status=this.account?.avatars?.status||{};
            state.avatarStatus.hidden=!this.client.public||!status.message;
            state.avatarMessage.textContent=status.message||'';state.avatarRetry.hidden=!status.retryable;
            state.avatarRetry.disabled=Boolean(status.busy||status.retryAt>Date.now());
            clearTimeout(state.avatarRetryTimer);
            if(status.retryable&&status.retryAt>Date.now())state.avatarRetryTimer=setTimeout(()=>{if(this.valid(state))this.avatarStatus(state);},Math.min(1000,status.retryAt-Date.now()));
        }
        avatar(state,author){
            if(state.avatarView)return state.avatarView.render(author||{});
            const holder=node('span',Array.from(author?.name||'?')[0],'tc-avatar');holder.setAttribute('aria-hidden','true');return holder;
        }
        card(state,message){
            const received=state.kind==='replies',report=message.type==='report_resolved'?message.report:state.kind==='reports'?message:null;
            const comment=(received?message.reply:message.comment)||{};
            const available=message.availability!=='unavailable',location=available?message.location:null;
            const card=node('article',null,'tm-card');card.dataset.messageId=state.kind==='sent'?comment.id:message.id;
            const unread=received&&!message.isRead&&!message.readAt;card.classList.toggle('tm-unread',unread);
            const header=node('div',null,'tm-card-head');
            const author=node('div',null,'tm-author');
            if(!report&&available)author.appendChild(this.avatar(state,comment.author));
            author.appendChild(node('strong',report?(received?'报错已修复':(report.status==='resolved'?'已修复':'待处理')+' · '+(categories[report.category]||'其他问题')):comment.author?.name||'用户'));
            header.append(author,node('span',time(message.createdAt||comment.createdAt),'tm-muted'));
            card.appendChild(header);
            if(location)card.appendChild(node('p',(location.scope==='episode'?'本集 · ':'作品 · ')+
                (location.workTitle?location.workTitle+' · ':'')+(location.title||'未命名作品'),'tm-topic'));
            if(available&&message.originalComment){
                const original=node('blockquote'),originalAuthor=node('div',null,'tm-author');
                originalAuthor.append(this.avatar(state,message.originalComment.author),node('span',(message.originalComment.author?.name||'用户')+' · 回复的原发言','tm-muted'));
                original.append(originalAuthor,node('div',body(message.originalComment),'tm-body'));card.appendChild(original);
            }
            if(report){
                card.appendChild(node('div',report.description||'','tm-body'));
                if(report.status==='resolved')card.appendChild(node('p','修复结果','tm-muted')),card.appendChild(node('div',report.resolution||'','tm-body'));
            }else card.appendChild(node('div',available?(comment.replyToAuthor?'回复 @'+comment.replyToAuthor.name+'：\n':'')+body(comment):'内容已不可用','tm-body'));
            const actions=node('div',null,'tm-toolbar');
            let read;
            const markRead=async()=>{
                state.busy=true;++this.summaryVersion;this.controls(state);
                try{
                    const result=await this.client.readMessage(message.id);if(!this.valid(state))return;
                    ++this.summaryVersion;this.lastSummary=Date.now();this.updateUnread(result);
                    message.isRead=true;message.readAt=new Date().toISOString();card.classList.remove('tm-unread');read?.remove();
                    state.status.textContent='未读消息 '+this.unread+' 条';
                }finally{if(this.valid(state)){state.busy=false;this.controls(state);}}
            };
            if(location?.itemId||location?.media){
                const open=button(!report&&location.canNavigate?'查看讨论':'查看作品',async()=>{
                    if(!this.valid(state)||state.busy||state.loading||open.disabled)return;
                    open.disabled=true;
                    try{
                        if(received&&!message.isRead&&!message.readAt)await markRead();
                        if(!this.valid(state))return;
                        await this.openDiscussion?.(message);if(this.valid(state))this.close();
                    }
                    catch(error){this.error(state,error);}
                    finally{open.disabled=false;}
                });
                actions.appendChild(open);
            }else actions.appendChild(node('span','作品当前不可访问','tm-muted'));
            if(report)actions.appendChild(button('查看报错',async()=>{
                if(!this.valid(state)||state.busy||state.loading)return;
                try{
                    if(unread&&!message.isRead&&!message.readAt)await markRead();
                    if(this.valid(state))await this.reportDetails(report.id);
                }catch(error){this.error(state,error);}
            }));
            if(unread){
                read=button('标为已读',async()=>{
                    if(!this.valid(state)||state.busy||state.loading||read.disabled)return;
                    read.disabled=true;
                    try{await markRead();}catch(error){this.error(state,error);}
                    finally{read.disabled=false;}
                });
                actions.appendChild(read);
            }
            card.appendChild(actions);return card;
        }
        async readAll(state){
            if(!this.valid(state)||state.readAll.disabled)return;
            state.busy=true;++this.summaryVersion;this.controls(state);
            const through=state.through;
            try{
                const result=await this.client.readAllMessages(through);if(!this.valid(state))return;
                ++this.summaryVersion;this.updateUnread(result);this.lastSummary=Date.now();
                state.busy=false;await this.load(state);
            }catch(error){
                if(error.status===400&&this.valid(state)){
                    state.through=null;state.busy=false;await this.load(state);
                    if(this.valid(state)&&state.through)state.status.textContent='消息快照已更新，请再次点击全部已读。';
                }else this.error(state,error);
            }
            finally{if(this.valid(state)){state.busy=false;this.controls(state);}}
        }
        async reportDetails(id){
            this.closeReportDetails();style();
            const panel=node('dialog');panel.id='tigerest-report-detail';
            const content=node('div',null,'tm-content'),heading=node('h2','报错详情');heading.id='tm-report-heading';
            panel.setAttribute('aria-labelledby',heading.id);content.append(heading,button('关闭',()=>this.closeReportDetails()));
            const status=node('p','正在加载报错…','tm-status');status.setAttribute('role','status');content.appendChild(status);panel.appendChild(content);
            const state={panel,key:this.sessionKey};this.reportDetail=state;
            panel.addEventListener('cancel',event=>{event.preventDefault();this.closeReportDetails();});document.body.appendChild(panel);panel.showModal();
            try{
                const report=await this.client.report(id);
                if(this.reportDetail!==state||state.key!==JSON.stringify(this.session()))return;
                status.textContent=(categories[report.category]||'其他问题')+' · '+(report.status==='resolved'?'已修复':'待处理');
                content.append(node('div',report.description,'tm-body'));
                if(report.status==='resolved')content.append(node('p','修复结果','tm-muted'),node('div',report.resolution,'tm-body'));
                if(report.location)content.append(node('p',[report.location.workTitle,report.location.title].filter(Boolean).join(' · '),'tm-topic'));
            }catch(error){
                if(this.reportDetail!==state||state.key!==JSON.stringify(this.session()))return;
                if(error.status===401)this.reset(true);else status.textContent=error.message;
            }
        }
        closeReportDetails(){this.reportDetail?.panel.close();this.reportDetail?.panel.remove();this.reportDetail=null;}
        reportProblem(item){
            this.sync();if(this.client.public||!this.client.context||!item?.Id)return;
            if(this.reportForm){this.reportForm.panel.focus();return;}
            style();const panel=node('dialog');panel.id='tigerest-report-form';
            const shell=node('div',null,'tm-shell'),head=node('div',null,'tm-head'),title=node('div',null,'tm-title');
            const heading=node('h2','上报问题');heading.id='tm-report-form-heading';panel.setAttribute('aria-labelledby',heading.id);
            title.append(heading,button('关闭',()=>this.closeReportForm()));head.append(title,node('p',item.Name||'当前作品','tm-muted'));
            const form=node('form',null,'tm-content'),status=node('p','','tm-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
            const category=node('select');category.setAttribute('aria-label','问题类型');
            for(const [value,label]of Object.entries(categories)){const option=node('option',label);option.value=value;category.appendChild(option);}
            const categoryLabel=node('label','问题类型','tm-field');categoryLabel.appendChild(category);
            const description=node('textarea');description.setAttribute('aria-label','报错说明');description.placeholder='请描述问题现象、发生时间或复现方式（3–2000 字）。';
            const descriptionLabel=node('label','问题说明','tm-field');descriptionLabel.appendChild(description);
            const position=node('fieldset',null,'tm-position'),positionRow=node('div',null,'tm-time-row');
            const minutes=node('input'),seconds=node('input');
            for(const [input,label,max]of [[minutes,'分钟','10080'],[seconds,'秒','59']]){
                input.type='number';input.inputMode='numeric';input.min='0';input.max=max;input.step='1';input.placeholder='0';
                input.setAttribute('aria-label','发生时间：'+label+'（可选）');
                const field=node('label',label,'tm-field');field.appendChild(input);positionRow.appendChild(field);
            }
            position.append(node('legend','发生时间（可选）'),positionRow);
            const include=node('input');include.type='checkbox';include.checked=true;include.setAttribute('aria-label','附带诊断日志');
            const includeLabel=node('label',null,'tm-diagnostics'),includeText=node('span','附带诊断日志');
            includeText.appendChild(node('small','自动附带近期已脱敏的应用日志，帮助排查问题。可取消勾选；日志仅供你和后台管理员查看。'));
            includeLabel.append(include,includeText);
            const submit=button('提交报错',()=>form.requestSubmit()),retry=button('重试日志附件',()=>upload());retry.hidden=true;
            const actions=node('div',null,'tm-toolbar');actions.append(submit,retry);
            form.append(categoryLabel,descriptionLabel,position,includeLabel,status,actions);shell.append(head,form);panel.appendChild(shell);
            const state={panel,key:this.sessionKey,busy:false,attempt:null,diagnostics:null};this.reportForm=state;
            const valid=()=>this.reportForm===state&&state.key===JSON.stringify(this.session());
            const controls=()=>{
                const frozen=Boolean(state.attempt||state.saved||state.busy);
                category.disabled=description.disabled=minutes.disabled=seconds.disabled=include.disabled=frozen;
                submit.disabled=Boolean(state.busy||state.saved);
                retry.disabled=Boolean(state.busy||this.client.diagnosticsCooldownUntil>this.client.now());
            };
            const savedText='报错已提交。管理员确认修复后会在消息中心通知你。';
            const showSaved=()=>{
                submit.hidden=true;
                if(!state.savedAction){state.savedAction=button('查看我的报错',()=>{this.closeReportForm();this.open('reports');});actions.appendChild(state.savedAction);}
            };
            const upload=async()=>{
                if(!valid()||state.busy||!state.saved||!state.diagnostics)return;
                state.busy=true;retry.hidden=true;controls();status.textContent=savedText+' 正在附带日志…';
                try{
                    await this.client.uploadReportDiagnostics(state.reportId,state.diagnostics);
                    if(!valid())return;state.diagnostics=null;clearInterval(state.retryTimer);state.retryTimer=null;
                    status.textContent=savedText+' 日志已附带。';
                }catch(error){
                    if(!valid()||error.name==='AbortError')return;
                    if(error.status===401){this.reset(true);return;}
                    const retryable=!error.status||error.status===429||error.status>=500;
                    status.textContent=savedText+' 日志附件未上传。'+error.message;
                    retry.hidden=!retryable;
                    if(!retryable)state.diagnostics=null;
                    if(retryable&&!state.retryTimer)state.retryTimer=setInterval(()=>{if(valid())controls();},250);
                }finally{if(valid()){state.busy=false;controls();}}
            };
            form.addEventListener('submit',async event=>{
                event.preventDefault();if(!valid()||state.busy||state.saved)return;
                state.busy=true;controls();status.textContent='正在提交报错…';
                try{
                    if(!state.attempt){
                        const context={platform:reportPlatform(),clientVersion:window.jmpInfo?.version};
                        if(minutes.value!==''||seconds.value!==''){
                            const minuteValue=Number(minutes.value||0),secondValue=Number(seconds.value||0);
                            if(!Number.isInteger(minuteValue)||minuteValue<0||!Number.isInteger(secondValue)||secondValue<0||secondValue>59)throw new Error('请填写非负整数分钟和 0–59 秒。');
                            const total=minuteValue*60+secondValue;
                            if(total>604800)throw new Error('发生时间不能超过 7 天。');
                            context.positionSeconds=total;
                        }
                        const text=description.value.trim(),length=Array.from(text).length;
                        if(length<3||length>2000)throw new Error('请填写 3–2000 字的说明，补充现象、发生时间或复现方式。');
                        state.attempt=Object.freeze({itemId:String(item.Id),category:category.value,description:text,context:Object.freeze(context),include:include.checked});
                        controls();
                        if(state.attempt.include){
                            status.textContent='正在准备已脱敏的诊断日志…';
                            const scopeReady=await this.diagnosticsReady;if(!valid())return;
                            const snapshot=scopeReady===unavailableDiagnostics||scopeReady===false?null:await systemCall(this.diagnosticsSystem,'collectReportDiagnostics');
                            if(!valid())return;
                            try{state.diagnostics=this.client.createReportDiagnostics(snapshot);}catch(_){state.diagnostics=null;}
                        }
                    }
                    const result=await this.client.sendReport(state.attempt.itemId,state.attempt.category,state.attempt.description,state.attempt.context);
                    if(!valid())return;state.saved=true;state.reportId=result?.report?.id;showSaved();
                    status.textContent=savedText+(state.attempt.include&&!state.diagnostics?' 未能取得可用的诊断日志。':'');
                    state.busy=false;
                    if(state.diagnostics)await upload();
                }catch(error){if(valid()){if(error.status===401)this.reset(true);else status.textContent=error.message;}}
                finally{if(valid()){state.busy=false;controls();}}
            });
            panel.addEventListener('cancel',event=>{event.preventDefault();this.closeReportForm();});document.body.appendChild(panel);panel.showModal();description.focus();
        }
        // Silent report for faults the client detected itself. A separate client
        // keeps its request state and cooldowns apart from the report form.
        // Returns 'unavailable' while no private account session exists yet.
        async autoReport({itemId,description,context={},snapshot=null,collect=false}){
            this.sync();
            const session=this.session();
            if(this.client.public||!this.client.context||!Client.supported(session))return 'unavailable';
            const client=new Client();
            if(!client.setSession(session))return 'unavailable';
            let diagnostics=null;
            try{
                let data=snapshot;
                if(collect){
                    const scopeReady=await this.diagnosticsReady;
                    data=scopeReady===unavailableDiagnostics||scopeReady===false?null:await systemCall(this.diagnosticsSystem,'collectReportDiagnostics');
                }
                if(data&&data!==unavailableDiagnostics)diagnostics=client.createReportDiagnostics(data);
            }catch(_){diagnostics=null;}
            const result=await client.sendReport(itemId,'playback_error',description,{platform:reportPlatform(),clientVersion:window.jmpInfo?.version,...context});
            const reportId=result?.report?.id;
            if(diagnostics&&reportId){
                try{await client.uploadReportDiagnostics(reportId,diagnostics);}
                catch(error){console.warn('[Fault] Diagnostics attachment failed:',error?.status||'',error?.message||error);}
            }
            return 'sent';
        }
        closeReportForm(){
            const state=this.reportForm;this.reportForm=null;
            if(state){
                clearInterval(state.retryTimer);state.attempt=null;state.diagnostics=null;
                this.client.cancelReportRequests();state.panel.close();state.panel.remove();
            }
        }
        close(){
            this.closeReportDetails();
            const state=this.state;this.state=null;
            if(state){state.unsubscribeAvatars?.();clearTimeout(state.avatarRetryTimer);state.avatarView?.clear();this.client.cancelRequests();++this.summaryVersion;state.panel.close();state.panel.remove();}
            this.entry?.focus();
        }
        reset(block=false){
            const session=this.session(),key=(this.account?!!session?.token:Client.supported(session))?JSON.stringify(session):'';
            this.close();this.closeReportForm();this.client.clear();++this.summaryVersion;
            systemCall(this.diagnosticsSystem,'setReportDiagnosticsScope',['']);
            this.diagnosticsSystem=null;this.diagnosticsScope=null;this.diagnosticsReady=null;
            this.entry?.remove();this.entry=null;this.sessionKey='';this.unread=0;this.lastSummary=0;
            this.blockedKey=block?key:null;
        }
        destroy(){this.unsubscribeAccount?.();this.unsubscribeProfile?.();this.reset();}
    }
    window.TigerestCommunityMessages=CommunityMessages;
})();
