(function () {
    'use strict';
    const Client = window.TigerestCommunityClient;
    const styleId = 'tigerest-community-style';
    function node(tag, text, className) {
        const element = document.createElement(tag);
        if (text != null) element.textContent = String(text);
        if (className) element.className = className;
        return element;
    }
    function button(text, action) {
        const element = node('button', text, 'tc-button');
        element.type = 'button';
        element.addEventListener('click', action);
        return element;
    }
    function time(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    }
    function installStyle() {
        if (document.getElementById(styleId)) return;
        const style = node('style');
        style.id = styleId;
        style.textContent = `
        #tigerest-community{padding-block:24px;color:inherit;box-sizing:border-box;width:100%;min-width:0;align-self:stretch;text-align:start}
        #tigerest-community .tc-content{box-sizing:border-box;min-width:0}
        #tigerest-community h2{font-size:24px;margin-block:0 16px}#tigerest-community h3{font-size:18px;margin:12px 0}
        #tigerest-community .tc-toolbar,#tigerest-community .tc-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}
        #tigerest-community .tc-pagination{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:20px 0}
        #tigerest-community .tc-pagination[hidden]{display:none}
        #tigerest-community .tc-button{font:inherit;color:inherit;background:rgba(127,145,170,.15);border:1px solid rgba(127,145,170,.35);border-radius:8px;padding:8px 14px;cursor:pointer}
        #tigerest-community .tc-button:hover{background:rgba(77,155,235,.3)}#tigerest-community .tc-button:focus-visible,#tigerest-community textarea:focus-visible,#tigerest-community select:focus-visible{outline:2px solid #65b8ff;outline-offset:3px}
        #tigerest-community .tc-button[aria-pressed=true]{background:#24649d;color:white;border-color:#65b8ff}
        #tigerest-community button:disabled{opacity:.45;cursor:default}
        #tigerest-community textarea{box-sizing:border-box;width:100%;min-height:96px;resize:vertical;background:rgba(127,145,170,.08);color:inherit;border:1px solid rgba(127,145,170,.45);border-radius:10px;padding:12px;font:inherit}
        #tigerest-community .tc-muted{opacity:.72;font-size:14px}#tigerest-community .tc-status{min-height:24px;margin:8px 0;white-space:pre-wrap}
        #tigerest-community .tc-card{border-top:1px solid rgba(127,145,170,.22);padding:20px 0}
        #tigerest-community .tc-highlight{outline:2px solid #72c6ff;outline-offset:6px;border-radius:6px;background:rgba(77,155,235,.08)}
        #tigerest-community .tc-header{display:flex;gap:10px;align-items:center}#tigerest-community .tc-avatar{width:36px;height:36px;border-radius:50%;background:#2c4d72;color:white;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0}
        #tigerest-community .tc-avatar img{width:100%;height:100%;object-fit:cover}
        #tigerest-community .tc-body{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;line-height:1.65}
        #tigerest-community .tc-replies{margin:12px 0 0 20px;padding-left:16px;border-left:2px solid rgba(127,145,170,.3)}
        #tigerest-community .tc-replies .tc-card{padding:12px 0}#tigerest-community .tc-dialog,#tigerest-community .tc-management{padding:16px;background:rgba(127,145,170,.1);border-radius:10px;margin:12px 0}
        #tigerest-community select{font:inherit;color:inherit;background:#243344;padding:8px;border:1px solid #678;border-radius:6px}
        @media(max-width:600px){#tigerest-community{padding-block:20px}#tigerest-community .tc-replies{margin-left:8px;padding-left:10px}}
        `;
        (document.head || document.documentElement).appendChild(style);
    }
    // Emby's item page is .itemView; Jellyfin's is #itemDetailPage.
    const ITEM_VIEW='.itemView, .itemDetailPage';
    const FLAG_REASONS={spam:'垃圾广告',harassment:'辱骂骚扰',sexual:'色情低俗',illegal:'违法违规',other:'其他'};
    const openUrl=url=>window.NativeShell?.openUrl?window.NativeShell.openUrl(url):window.open(url,'_blank','noopener');
    const itemRoute=(id,serverId)=>window.TigerestServer?.itemRoute?.(id,serverId)??'/item?id='+encodeURIComponent(id)+'&serverId='+encodeURIComponent(serverId);
    class CommunityPlugin {
        constructor({connectionManager, events, appRouter}) {
            this.connectionManager = connectionManager;
            this.events = events;
            this.client = new Client();
            this.privateClient=this.client;
            this.account=window.TigerestCommunityAccount?.get(connectionManager);
            this.publicClient=this.account?new window.TigerestCommunityPublicClient(this.account.session,this.account.avatars):null;
            this.appRouter=appRouter;
            this.messages=window.TigerestCommunityMessages?new window.TigerestCommunityMessages({
                connectionManager,account:this.account,openDiscussion:message=>this.openDiscussion(message)}):null;
            if(this.messages)window.TigerestFaultReports?.attach(this.messages);
            this.unsubscribeAccount=this.account?.subscribe(()=>this.commentIdentityChanged());
            // A renamed author reloads the list under the new name; drafts stay.
            this.unsubscribeProfile=this.account?.subscribeProfile?.(()=>{const state=this.state;if(state?.channel==='public'&&this.valid(state))this.load(state,true);});
            this.epoch = 0;
            this.itemShow = event => this.onItem(event);
            this.viewShow = event => this.onView(event);
            this.hideView = event => {
                const view=this.state?.view || this.metadataView;
                if (view && (event.target === view || event.target.contains?.(view))) this.close();
            };
            this.sessionChanged = () => {this.account?.reset();this.close();this.pendingFocus=null;this.messages?.reset(true);};
            this.signedIn = () => {if(this.account)this.account.blockedKey=null;this.account?.sync();this.close();this.pendingFocus=null;this.messages?.reset();this.messages?.sync();};
            document.addEventListener('itemshow', this.itemShow);
            document.addEventListener('viewshow', this.viewShow);
            document.addEventListener('viewbeforehide', this.hideView);
            events?.on(connectionManager, 'localusersignedout', this.sessionChanged);
            events?.on(connectionManager, 'localusersignedin', this.signedIn);
            this.poll = setInterval(() => {
                this.account?.sync();
                if (this.state && !this.valid(this.state)) this.close();
                this.messages?.sync();
            }, 500);
            // Logout starts a network operation: clear drafts before it finishes.
            this.reset = this.sessionChanged;
            window.TigerestCommunityReset = this.reset;
            this.messages?.sync();
        }
        session() { return Client.session(this.connectionManager.currentApiClient?.()); }
        available(session){return this.account?!!session?.token&&!!session?.userId&&this.account.blockedKey!==JSON.stringify(session):Client.supported(session);}
        async openDiscussion(message) {
            const session=this.session(),location=message.location;
            if(this.account&&location?.media){return this.openPublicDiscussion(message,session);}
            if(!Client.supported(session)||message.availability==='unavailable'||!location?.itemId||
                location.embyServerId!==session.serverId||!this.appRouter?.show)throw new Error('无法打开讨论');
            const focus={itemId:String(location.itemId),scope:location.scope,topicId:location.topicId,
                rootId:location.canNavigate?location.rootId:null,commentId:location.canNavigate?location.commentId:null,
                sessionKey:JSON.stringify(session),channel:'private'};
            this.pendingFocus=focus;
            if(this.state?.item.Id===focus.itemId && this.valid(this.state)){
                if(this.state.busy){this.state.queuedFocus=focus;this.pendingFocus=null;return;}
                this.applyFocus(this.state,focus);this.pendingFocus=null;await this.load(this.state);return;
            }
            try {await this.appRouter.show(itemRoute(focus.itemId,session.serverId));}
            catch(error){if(this.pendingFocus===focus)this.pendingFocus=null;throw error;}
        }
        async openPublicDiscussion(message,session){
            const location=message.location,key=JSON.stringify(session);
            if(message.availability==='unavailable'||!location.topicId||!this.available(session))throw new Error('讨论暂不可用。');
            let item=null;
            try{item=await window.TigerestCommunityPublicClient.locateMedia(this.connectionManager.currentApiClient(),location.media);}catch(_){}
            if(key!==JSON.stringify(this.session()))return;
            const focus={itemId:item?.Id,scope:location.media.scope,topicId:location.topicId,rootId:location.canNavigate?location.rootId:null,commentId:location.canNavigate?location.commentId:null,sessionKey:key,channel:'public'};
            if(item&&this.appRouter?.show){this.pendingFocus=focus;await this.appRouter.show(itemRoute(item.Id,session.serverId));return;}
            this.close();
            const panel=node('dialog');panel.style.cssText='color:#e9eff8;background:#172335;border:1px solid #526882;width:min(900px,calc(100vw - 48px));max-height:90vh;border-radius:14px';
            const view=node('div');panel.append(button('关闭',()=>{this.close();panel.close();panel.remove();}),node('p','当前媒体库无法唯一定位此作品，可在此查看公共讨论。'),view);
            document.body.append(panel);panel.showModal();panel.addEventListener('cancel',()=>{this.close();panel.remove();});
            const m=location.media;
            // Server-issued v2 locations are canonical aired keys; Emby metadata still requires an explicit order.
            const synthetic={Id:'public-topic:'+location.topicId,Type:m.scope==='episode'?'Episode':m.mediaType==='movie'?'Movie':'Series',Name:'公共讨论',ProviderIds:{Tmdb:m.tmdbId},ParentIndexNumber:m.season,IndexNumber:m.episode,DisplayOrder:m.order||'aired'};
            this.pendingFocus={...focus,itemId:synthetic.Id};this.onItem({target:view,detail:{item:synthetic}});
            if(this.state){this.state.publicDialog=panel;this.state.series={Type:'Series',ProviderIds:{Tmdb:m.tmdbId}};this.load(this.state);}
        }
        valid(state) {
            if (this.state !== state) return false;
            const session = this.session();
            return this.available(session) && state.sessionKey === JSON.stringify(session);
        }
        async onView(event) {
            const view=event.target.closest?.(ITEM_VIEW) || event.target.querySelector?.(ITEM_VIEW);
            const id=event.detail?.params?.id;
            if(!view || !id || String(id).startsWith('local'))return;
            if(this.state?.view===view && this.state.item.Id===id && this.valid(this.state))return;
            this.close();
            const api=this.connectionManager.currentApiClient?.();
            const session=this.session();
            if(!this.available(session))return;
            const epoch=this.epoch;
            const controller=new AbortController();this.metadataController=controller;this.metadataView=view;
            const signal=event.detail?.currentResumeSignal || event.detail?.signal;
            signal?.addEventListener('abort',()=>controller.abort(),{once:true});
            if(signal?.aborted)controller.abort();
            try {
                const item=await api.getItem(session.userId,id,{},controller.signal);
                if(controller.signal.aborted || epoch!==this.epoch || JSON.stringify(this.session())!==JSON.stringify(session))return;
                this.onItem({target:view,detail:{item,signal}});
            }catch(_){/* Detail metadata errors must not interrupt Emby navigation. */}
        }
        onItem(event) {
            const item = event.detail?.item;
            const view = event.target.closest?.(ITEM_VIEW) || event.target;
            this.close();
            if (!item?.Id || !['Movie','Series','Season','Episode'].includes(item.Type)) return;
            const session = this.session();
            if(!this.available(session))return;
            this.account?.sync();
            const focus=this.pendingFocus?.itemId===String(item.Id)&&this.pendingFocus.sessionKey===JSON.stringify(session)?this.pendingFocus:null;
            this.client=focus?.channel==='private'?this.privateClient:this.publicClient||this.privateClient;
            if (!this.client.setContext(session, item.Id)) return;
            this.publicClient?.setMedia(item);
            installStyle();
            const panel = node('section');
            panel.id = 'tigerest-community';
            panel.className = 'verticalSection';
            panel.setAttribute('aria-label', '评论区');
            const state = {panel, view, item, sessionKey:JSON.stringify(session), scope:item.Type==='Episode'?'episode':'work',
                avatars:new Map(), urls:new Set(), rootIds:new Set(), pages:new Map(), drafts:new Map(),channel:this.client.public?'public':'private',channelResolved:!this.account||!!focus,version:0, reply:null, busy:false};
            this.state = state;
            this.createAvatarView(state);
            if(focus){
                state.focus=focus;this.pendingFocus=null;
                state.scope=state.focus.scope==='episode'&&item.Type==='Episode'?'episode':'work';
            }
            event.detail?.signal?.addEventListener('abort', () => {if (this.state===state) this.close();}, {once:true});
            if (event.detail?.signal?.aborted) {this.close();return;}
            const content=node('div',null,'tc-content padded-left padded-left-page padded-right');
            state.content=content;panel.appendChild(content);
            state.title=node('h2','评论区');content.appendChild(state.title);
            const toolbar = node('div', null, 'tc-toolbar');
            if(this.account){
                toolbar.appendChild(button('评论账号',()=>this.account.show()));
            }
            state.tabs = [];
            const scopes = item.Type==='Episode' ? [['episode','本集评论'],['work','作品评论']] : [['work','作品评论']];
            for (const [scope, label] of scopes) {
                const tab = button(label, () => {
                    if (!this.valid(state) || state.busy || state.scope===scope) return;
                    this.selectContext(state,state.channel,scope);
                    this.updateComposer(state);this.load(state);
                });
                tab.dataset.scope=scope;toolbar.appendChild(tab);state.tabs.push(tab);
            }
            state.refresh = button('刷新评论', () => this.load(state, true));
            if(item.Type!=='Season'&&this.messages){state.reportButton=button('上报问题',()=>{if(this.valid(state)&&Client.supported(this.session()))this.messages.reportProblem(item);});state.reportButton.hidden=!Client.supported(session);toolbar.appendChild(state.reportButton);}
            toolbar.appendChild(state.refresh);content.appendChild(toolbar);
            state.topicLabel = node('div', '正在加载…', 'tc-muted');content.appendChild(state.topicLabel);
            state.status = node('div', '', 'tc-status');state.status.setAttribute('role','status');state.status.setAttribute('aria-live','polite');content.appendChild(state.status);
            state.avatarStatus=node('div',null,'tc-avatar-status tc-muted');state.avatarStatus.setAttribute('role','status');state.avatarStatus.setAttribute('aria-live','polite');
            state.avatarMessage=node('span');state.avatarRetry=button('重试头像同步',()=>{if(this.valid(state))Promise.resolve(this.account.avatars.retry()).catch(()=>{});});
            state.avatarStatus.append(state.avatarMessage,state.avatarRetry);content.appendChild(state.avatarStatus);
            state.unsubscribeAvatars=this.account?.avatars?.subscribe(event=>{
                if(!this.valid(state))return;
                if(state.channel==='public'&&event.author)state.avatarView?.update(event.author);
                this.avatarStatus(state);
            });this.avatarStatus(state);
            state.dialog = node('div');content.appendChild(state.dialog);
            state.readOnlyNote=node('p','专属评论已停止发言。这部作品缺少可靠的 TMDB 信息，暂时无法在公共评论中讨论。','tc-muted');state.readOnlyNote.hidden=true;content.appendChild(state.readOnlyNote);
            state.termsBox=node('div',null,'tc-dialog');state.termsBox.setAttribute('role','group');state.termsBox.setAttribute('aria-label','使用条款');state.termsBox.hidden=true;
            state.termsBox.append(node('p','发言前请阅读并同意使用条款：对不当内容和辱骂行为零容忍，违规内容会被删除，违规账号会被禁言或封禁。你可以举报评论或屏蔽用户，举报会在 24 小时内处理。'),
                button('阅读使用条款',()=>{const terms=this.account?.session.terms();if(terms)openUrl(terms.url);}),button('同意并继续',()=>this.acceptTerms(state)));
            content.appendChild(state.termsBox);
            state.composer = node('form');
            state.replyLabel = node('div', '', 'tc-muted');state.composer.appendChild(state.replyLabel);
            state.cancelReply = button('取消回复', () => {state.reply=null;this.updateComposer(state);});state.composer.appendChild(state.cancelReply);
            state.input = node('textarea');state.input.placeholder='说说你的看法（最多 2000 字）';state.input.setAttribute('aria-label','评论内容');
            state.input.addEventListener('input',()=>this.updateComposer(state));state.composer.appendChild(state.input);
            const footer=node('div',null,'tc-toolbar');
            state.send=button('发表评论',()=>this.submit(state));footer.appendChild(state.send);
            state.counter=node('span','0 / 2000','tc-muted');footer.appendChild(state.counter);state.composer.appendChild(footer);
            state.composer.addEventListener('submit',e=>{e.preventDefault();this.submit(state);});
            content.appendChild(state.composer);
            state.list=node('div');content.appendChild(state.list);
            state.pagination=node('nav',null,'tc-pagination');state.pagination.setAttribute('aria-label','评论分页');
            state.previous=button('上一页',()=>this.changePage(state,-1));state.pagination.appendChild(state.previous);
            state.pageLabel=node('span','','tc-muted');state.pageLabel.setAttribute('aria-live','polite');state.pagination.appendChild(state.pageLabel);
            state.next=button('下一页',()=>this.changePage(state,1));state.pagination.appendChild(state.next);
            state.first=button('返回最新评论',()=>this.load(state,true));state.pagination.appendChild(state.first);
            content.appendChild(state.pagination);
            state.management=node('div');content.appendChild(state.management);
            this.placePanel(state);
            state.placementObserver=new MutationObserver(records=>{
                if(records.some(record=>!panel.contains(record.target)))this.placePanel(state);
            });
            state.placementObserver.observe(view,{childList:true,subtree:true});
            if(window.ResizeObserver){state.resizeObserver=new ResizeObserver(()=>this.schedulePanelAlignment(state));state.resizeObserver.observe(view);}
            this.load(state);
        }
        selectContext(state,channel,scope){
            if(channel===state.channel&&scope===state.scope)return;
            const key=state.channel+':'+state.scope;
            state.drafts.set(key,{text:state.input.value,reply:state.reply,pendingSend:this.client.pendingSend});
            this.client.cancelRequests();state.channel=channel;state.scope=scope;
            this.client=state.channel==='public'?this.publicClient:this.privateClient;this.client.setContext(this.session(),state.item.Id);
            this.createAvatarView(state);this.avatarStatus(state);
            const draft=state.drafts.get(state.channel+':'+state.scope);state.input.value=draft?.text||'';state.reply=draft?.reply||null;
            this.client.pendingSend=draft?.pendingSend||null;
            state.focus=null;state.dialog.replaceChildren();
        }
        clearContent(state){
            this.clearAvatars(state);
            state.me=null;state.topic=null;state.cursor=null;state.loadedKey=null;state.page=null;state.rootIds.clear();
            state.list.replaceChildren();state.pagination.hidden=true;state.management.replaceChildren();state.admin?.remove();state.admin=null;
            state.topicLabel.textContent='正在加载…';
        }
        commentIdentityChanged(){
            this.publicClient?.clear();
            const state=this.state;
            if(state){
                for(const key of state.drafts.keys())if(key.startsWith('public:'))state.drafts.delete(key);
                for(const key of state.pages.keys())if(key.startsWith('public:'))state.pages.delete(key);
            }
            if(!state||state.channel!=='public')return;
            ++state.version;state.busy=false;state.loading=false;state.drafts.clear();state.pages.clear();
            state.input.value='';state.reply=null;state.focus=null;state.queuedFocus=null;state.dialog.replaceChildren();
            this.clearContent(state);this.updateComposer(state);
            if(!this.valid(state))return;
            this.publicClient.setContext(this.session(),state.item.Id);
            if(this.account.session.tokens)this.load(state,true);
            else state.status.textContent=this.account.session.left?'你已注销评论身份。需要时可在「评论账号」中重新加入。':'注册或登录评论账号后查看评论';
        }
        placePanel(state) {
            if(!this.valid(state))return;
            const view=state.view;
            const anchor=view.querySelector('.peopleSection, #peopleSection, .castSection, #castCollapsible, .castCollapsible') ||
                view.querySelector('.chaptersSection, #chaptersCollapsible, .chaptersCollapsible, .mediaInfoSection, #mediaInfoCollapsible, .mediaInfoCollapsible, .aboutSection, .audioVideoMediaInfo');
            // Insert beside the complete detail section, never into its horizontal card scroller.
            const section=anchor?.closest('.detailSection, .verticalSection, .emby-collapsible') || anchor;
            if(section?.parentElement){
                if(state.panel.nextElementSibling!==section)section.before(state.panel);
                state.alignmentSection=section;
            }else{
                const host=view.querySelector('.details-additionalContent') || view.querySelector('.itemMainScrollSlider') || view.querySelector('.scrollSlider') || view;
                if(state.panel.parentElement!==host)host.appendChild(state.panel);
                state.alignmentSection=null;
            }
            this.schedulePanelAlignment(state);
        }
        schedulePanelAlignment(state) {
            // Detail sections load in separate mutation batches. Measuring in
            // each observer callback repeatedly flushes the same page layout.
            // Read the latest placement once before the next paint instead.
            if(state.alignmentFrame!=null)return;
            state.alignmentFrame=requestAnimationFrame(()=>{
                state.alignmentFrame=null;
                if(this.valid(state)&&state.panel.isConnected)this.alignPanel(state);
            });
        }
        alignPanel(state) {
            const section=state.alignmentSection;
            if(!section?.isConnected || !section.getClientRects().length){
                // Jellyfin keeps empty cast sections in the DOM with display:none.
                // Their zero rectangle is not a usable content alignment anchor.
                state.content.style.paddingInline='clamp(16px,4vw,48px)';return;
            }
            const heading=section.querySelector('h2,h3,.sectionTitle') || section;
            if(heading.closest('.padded-left-page')){
                // Emby owns responsive spacing (including safe areas and docked drawers).
                state.content.style.paddingInline='';
                state.content.style.paddingLeft='';state.content.style.paddingRight='';
                state.title.classList.toggle('sectionTitle-cards',heading.classList.contains('sectionTitle-cards'));
                return;
            }
            state.title.classList.remove('sectionTitle-cards');
            state.content.style.paddingInline='';
            const panelRect=state.panel.getBoundingClientRect(),sectionRect=section.getBoundingClientRect();
            const left=heading.getBoundingClientRect().left-panelRect.left;
            const right=panelRect.right-sectionRect.right+parseFloat(getComputedStyle(section).paddingRight||0);
            if(left>=0)state.content.style.paddingLeft=left+'px';
            if(right>=0)state.content.style.paddingRight=right+'px';
        }
        async load(state, reset=false) {
            if (!this.valid(state) || state.busy) return;
            state.avatarView?.beginRead();
            const version=++state.version;
            this.client.cancelRequests({preserveSend:true});
            const focus=state.focus;state.focus=null;
            let pageKey=state.channel+':'+state.scope;
            if(state.loadedKey!==pageKey)this.clearContent(state);
            state.loading=true;
            state.status.textContent='正在加载评论…';
            for(const tab of state.tabs) tab.setAttribute('aria-pressed',String(tab.dataset.scope===state.scope));
            this.updateComposer(state);
            try {
                if(this.account){
                    await this.account.session.discover();if(!this.valid(state)||version!==state.version)return;
                    if(['Episode','Season'].includes(state.item.Type)&&!state.series&&state.item.SeriesId&&(state.channel==='public'||!state.channelResolved)){
                        const result=await this.connectionManager.currentApiClient().getItems(this.session().userId,{Ids:state.item.SeriesId,Fields:window.TigerestServer?.fields?.('ProviderIds,DisplayOrder')??'ProviderIds,DisplayOrder',Limit:1});
                        state.series=result.Items?.find(item=>String(item.Id)===String(state.item.SeriesId));
                        if(!this.valid(state)||version!==state.version)return;
                    }
                    if(!state.channelResolved){
                        // Every new comment goes to v2; trusted Emby users join it by exchange.
                        // A trusted item without a reliable TMDB identity still shows its old
                        // dedicated discussion, read-only, since v1 no longer accepts posts.
                        let channel='public';
                        if(Client.supported(this.session())){try{window.TigerestCommunityPublicClient.mediaIdentity(state.item,state.series,state.scope);}catch(_){channel='private';}}
                        this.selectContext(state,channel,state.scope);
                        state.channelResolved=true;
                        pageKey=state.channel+':'+state.scope;
                        if(state.loadedKey!==pageKey)this.clearContent(state);
                    }
                    if(state.reportButton)state.reportButton.hidden=!Client.supported(this.session());
                    if(state.channel==='public'){
                        this.publicClient.setMedia(state.item,state.series);
                        window.TigerestCommunityPublicClient.mediaIdentity(state.item,state.series,state.scope);
                    }
                }
                const me=await this.client.me();
                if(!this.valid(state)||version!==state.version)return;
                const topic=await this.client.resolve(state.scope);
                if(!this.valid(state)||version!==state.version)return;
                const anchor=focus?.topicId===topic.id?focus.rootId:null;
                let page=state.pages.get(pageKey);
                if(reset||focus||!page||page.topicId!==topic.id){
                    page={topicId:topic.id,entries:[{cursor:null,anchorId:anchor}],index:0};
                }else page={...page,entries:page.entries.map(entry=>({...entry}))};
                const entry=page.entries[page.index];
                let data,missing=false;
                try{data=await this.client.comments(topic.id,entry.cursor,entry.anchorId);}
                catch(error){
                    if(!entry.anchorId||error.status!==404)throw error;
                    if(!this.valid(state)||version!==state.version)return;
                    missing=true;page.entries=[{cursor:null,anchorId:null}];page.index=0;data=await this.client.comments(topic.id);
                }
                if(!this.valid(state)||version!==state.version)return;
                state.me=me;state.topic=topic;state.page=page;state.pages.set(pageKey,page);state.loadedKey=pageKey;
                const terms=state.channel==='public'?this.account?.session.terms():null;
                state.termsRequired=!!terms&&me.termsAcceptedVersion!==terms.version;
                state.topicLabel.textContent=(state.scope==='episode'?'当前发言对象：本集 · ':'当前发言对象：作品 · ')+(topic.title||state.item.Name||'');
                this.adminButton(state);
                this.renderRoots(state,data);
                // A completed report or block keeps its confirmation through the reload.
                state.status.textContent=state.notice||(me.muted?'你已被禁言，可浏览评论和删除自己的评论。':('以 '+me.author.name+' 的身份发言'));state.notice=null;
                if(anchor&&!missing){await this.focusComment(state,version,focus,data);if(!this.valid(state)||version!==state.version)return;}
                if(missing||(focus?.commentId&&!anchor))state.status.textContent='目标评论已不可用，已显示当前讨论。';
            } catch(error) {if(version===state.version)this.showError(state,error);}
            finally {if(this.valid(state)&&version===state.version){state.loading=false;this.updateComposer(state);}}
        }
        updateComposer(state) {
            const length=Array.from(state.input.value.trim()).length;
            state.counter.textContent=length+' / 2000';
            const readOnly=state.channel==='private';
            state.composer.hidden=readOnly;state.readOnlyNote.hidden=!readOnly||!state.me;
            state.termsBox.hidden=readOnly||!state.termsRequired;
            for(const control of state.termsBox.querySelectorAll('button'))control.disabled=Boolean(state.loading||state.busy);
            state.input.disabled=Boolean(!state.me || state.me.muted || state.termsRequired || readOnly || state.loading || state.busy);
            state.send.disabled=state.input.disabled || !state.topic || length<1 || length>2000;
            state.send.textContent=state.reply?'发送回复':'发表评论';
            state.cancelReply.hidden=!state.reply;
            state.replyLabel.textContent=state.reply?'正在回复 @'+(state.reply.author?.name||'用户'):'';
            state.refresh.disabled=Boolean(state.loading||state.busy);
            for(const tab of state.tabs)tab.disabled=Boolean(state.busy);
            this.updatePagination(state);
        }
        updatePagination(state) {
            const page=state.page,locked=Boolean(state.loading||state.busy||!state.me||!state.topic);
            state.previous.disabled=locked||!page?.index;
            state.next.disabled=locked||!state.cursor;
            state.first.hidden=!page?.entries[0].anchorId;
            state.first.disabled=locked;
            if(!page)return;
            const total=page.rootCount==null?'':' · 共 '+page.rootCount+' 条';
            state.pageLabel.textContent=(page.entries[0].anchorId?'定位评论 · ':'')+'第 '+(page.index+1)+' 页'+total;
        }
        applyFocus(state,focus) {
            const scope=focus.scope==='episode'&&state.item.Type==='Episode'?'episode':'work';
            this.selectContext(state,focus.channel||state.channel,scope);
            state.reply=null;state.dialog.replaceChildren();state.scope=scope;state.focus=focus;
        }
        async resumeFocus(state) {
            if(!this.valid(state)||!state.queuedFocus)return false;
            this.applyFocus(state,state.queuedFocus);state.queuedFocus=null;
            await this.load(state);return true;
        }
        async focusComment(state,version,focus,data) {
            const root=data.items?.find(comment=>comment.id===focus.rootId);
            if(!root)return;
            if(focus.commentId!==focus.rootId){
                let replies;
                try{state.avatarView?.beginRead();replies=await this.client.replies(focus.rootId,null,focus.commentId);}
                catch(error){
                    if(error.status!==404)throw error;
                    if(this.valid(state)&&version===state.version)state.status.textContent='目标回复已不可用，已显示当前讨论。';
                    return;
                }
                if(!this.valid(state)||version!==state.version)return;
                root.replies=replies.items||[];root.repliesNextCursor=replies.nextCursor;
            }
            const existing=Array.from(state.list.children).find(row=>row.dataset.commentId===root.id);
            const card=this.card(state,root);
            if(existing)existing.replaceWith(card);
            else {state.list.querySelector('.tc-empty')?.remove();state.rootIds.add(root.id);state.list.prepend(card);}
            const target=focus.commentId===root.id?card:Array.from(card.querySelectorAll('[data-comment-id]')).find(row=>row.dataset.commentId===focus.commentId);
            if(!target){state.status.textContent='目标评论已不可用，已显示当前讨论。';return;}
            target.classList.add('tc-highlight');target.tabIndex=-1;target.focus({preventScroll:true});
            target.scrollIntoView({block:'center',behavior:'smooth'});
        }
        showError(state,error) {
            if(!this.valid(state)||error.name==='AbortError')return;
            const loginRequired=state.channel==='public'&&(error.status===401||['LOGIN_REQUIRED','AUTH_REQUIRED','AUTH_INVALID','COMMUNITY_LEFT'].includes(error.code));
            state.status.textContent=error.code==='COMMUNITY_LEFT'?error.message:loginRequired?'注册或登录评论账号后查看评论':error.message+(error.requestId?'（请求编号：'+error.requestId+'）':'');
            if(error.status===401||loginRequired){this.clearContent(state);state.input.value='';state.reply=null;state.drafts.clear();state.pages.clear();state.dialog.replaceChildren();this.client.pendingSend=null;this.updateComposer(state);}
        }
        async submit(state) {
            if(!this.valid(state)||state.send.disabled||state.busy)return;
            const version=state.version;
            state.busy=true;this.updateComposer(state);
            let sent=false, deletedError=null;
            try {await this.client.send(state.topic.id,state.input.value,state.reply);
                if(!this.valid(state)||version!==state.version)return;
                state.input.value='';state.reply=null;sent=true;
            } catch(error) {
                if(!this.valid(state)||version!==state.version)return;
                this.showError(state,error);
                if(error.code==='TARGET_DELETED'){state.reply=null;deletedError=error;}
                if(error.code==='TERMS_NOT_ACCEPTED'){state.termsRequired=true;state.retryAfterTerms=true;}
                if(error.code==='USER_MUTED'){
                    try {state.me=await this.client.me();}catch(_){}
                }
            } finally {if(this.valid(state)&&version===state.version){state.busy=false;this.updateComposer(state);}}
            if(!this.valid(state)||version!==state.version)return;
            if(sent){state.pages.delete(state.channel+':'+state.scope);this.messages?.refreshSummary();}
            if(await this.resumeFocus(state))return;
            if(sent)await this.load(state,true);
            else if(deletedError){await this.load(state,true);this.showError(state,deletedError);}
        }
        async acceptTerms(state) {
            const terms=this.account?.session.terms();
            if(!this.valid(state)||!terms||state.loading||state.busy)return;
            const version=state.version;
            state.busy=true;this.updateComposer(state);
            let accepted=false;
            try{const data=await this.account.session.acceptTerms(terms.version);if(!this.valid(state)||version!==state.version)return;
                if(state.me)state.me.termsAcceptedVersion=data.termsAcceptedVersion;state.termsRequired=false;accepted=true;
                state.status.textContent='已同意使用条款。';}
            catch(error){if(version===state.version){this.showError(state,error);
                if(error.code==='TERMS_OUTDATED')state.status.textContent='使用条款已更新，请重新阅读后再同意。';}}
            finally{if(this.valid(state)&&version===state.version){state.busy=false;this.updateComposer(state);}}
            if(accepted&&state.retryAfterTerms&&this.valid(state)&&version===state.version){state.retryAfterTerms=false;await this.submit(state);}
        }
        renderRoots(state,data) {
            this.clearAvatars(state);
            state.list.replaceChildren();state.rootIds.clear();
            for(const comment of data.items || []) {
                if(state.rootIds.has(comment.id))continue;
                state.rootIds.add(comment.id);
                state.list.appendChild(this.card(state,comment));
            }
            if(!state.rootIds.size)state.list.appendChild(node('p','暂无评论，来聊聊这部作品吧。','tc-empty tc-muted'));
            state.cursor=data.nextCursor;
            if(Number.isInteger(data.rootCount))state.page.rootCount=data.rootCount;
            state.pagination.hidden=false;this.updatePagination(state);
        }
        async changePage(state,direction) {
            if(!this.valid(state)||state.loading||state.busy||!state.topic||!state.me)return;
            const page=state.page,index=page.index+direction;
            if(index<0||(direction>0&&!state.cursor))return;
            const entry=direction>0?{cursor:state.cursor,anchorId:null}:page.entries[index];
            const version=++state.version;this.client.cancelRequests({preserveSend:true});
            state.avatarView?.beginRead();
            state.loading=true;state.dialog.replaceChildren();state.reply=null;this.updateComposer(state);
            try {
                const data=await this.client.comments(state.topic.id,entry.cursor,entry.anchorId);
                if(!this.valid(state)||version!==state.version)return;
                page.index=index;page.entries[index]=entry;page.entries.length=index+1;
                this.renderRoots(state,data);
                state.status.textContent=state.me.muted?'你已被禁言，可浏览评论和删除自己的评论。':'以 '+state.me.author.name+' 的身份发言';
                state.list.scrollIntoView({block:'start',behavior:'smooth'});
            }catch(error){if(version===state.version)this.showError(state,error);}
            finally {if(this.valid(state)&&version===state.version){state.loading=false;this.updateComposer(state);}}
        }
        createAvatarView(state){
            this.clearAvatars(state);
            state.avatarView=window.TigerestCommunityAvatarView?new window.TigerestCommunityAvatarView({client:this.client,valid:()=>this.valid(state),coordinator:this.client.public?this.account?.avatars:null}):null;
        }
        clearAvatars(state){
            state.avatarView?.clear();state.avatarGeneration=(state.avatarGeneration||0)+1;
            state.avatars.clear();for(const url of state.urls)URL.revokeObjectURL(url);state.urls.clear();
        }
        avatarStatus(state){
            if(!state.avatarStatus)return;
            const status=this.account?.avatars?.status||{};
            state.avatarStatus.hidden=state.channel!=='public'||!status.message;
            state.avatarMessage.textContent=status.message||'';state.avatarRetry.hidden=!status.retryable;
            state.avatarRetry.disabled=Boolean(status.busy||status.retryAt>Date.now());
            clearTimeout(state.avatarRetryTimer);
            if(status.retryable&&status.retryAt>Date.now())state.avatarRetryTimer=setTimeout(()=>{if(this.valid(state))this.avatarStatus(state);},Math.min(1000,status.retryAt-Date.now()));
        }
        avatar(state,author) {
            if(state.avatarView)return state.avatarView.render(author);
            const generation=state.avatarGeneration;
            const holder=node('span',(author.name||'?').slice(0,1),'tc-avatar');holder.setAttribute('aria-hidden','true');
            if(!author.avatarPath)return holder;
            if(!state.avatars.has(author.avatarPath)) {
                state.avatars.set(author.avatarPath,this.client.avatar(author.avatarPath).then(blob=>{
                    if(!this.valid(state)||generation!==state.avatarGeneration)return null;
                    const url=URL.createObjectURL(blob);state.urls.add(url);return url;
                }).catch(()=>null));
            }
            state.avatars.get(author.avatarPath).then(url=>{
                if(!url||!this.valid(state)||generation!==state.avatarGeneration)return;
                const image=node('img');image.alt='';image.src=url;
                image.addEventListener('error',()=>holder.replaceChildren(node('span',(author.name||'?').slice(0,1))),{once:true});
                holder.replaceChildren(image);
            });
            return holder;
        }
        card(state,comment,isReply=false) {
            const card=node('article',null,'tc-card');card.dataset.commentId=comment.id;
            const author=comment.author,blocked=comment.state==='blocked_by_viewer';
            const header=node('div',null,'tc-header');header.appendChild(this.avatar(state,author||{}));
            const names=node('div');names.appendChild(node('strong',author?.name||(blocked?'已屏蔽的用户':'已注销用户')));names.appendChild(node('div',time(comment.createdAt),'tc-muted'));header.appendChild(names);card.appendChild(header);
            const target=comment.replyToAuthor?'回复 @'+comment.replyToAuthor.name+'：\n':comment.replyToState==='blocked_by_viewer'?'回复已屏蔽用户：\n':'';
            // Withheld text stays null: nothing from an older render or cache fills it in.
            const text=comment.state==='visible'?target+(comment.body||''):comment.state==='pending_review'?(comment.body==null?'内容待审核':target+comment.body+'\n（内容待审核，仅你可见）'):blocked?'你已屏蔽此用户的评论':'评论已删除';
            const body=node('div',text,'tc-body');card.appendChild(body);
            if(comment.viewerFlagged&&comment.state==='visible'){
                body.hidden=true;
                const reveal=button('你已举报这条评论 · 显示内容',()=>{body.hidden=false;reveal.remove();});card.appendChild(reveal);
            }
            const actions=node('div',null,'tc-actions');
            const own=!!author&&author.id===state.me?.author?.id,moderation=state.channel==='public'?this.account?.session.moderation():null;
            if(comment.permissions?.canReply&&comment.state==='visible'&&state.channel==='public')actions.appendChild(button('回复',()=>{
                if(!this.valid(state)||state.loading||state.busy||state.me?.muted)return;
                state.reply=comment;this.updateComposer(state);state.input.focus();state.composer.scrollIntoView({block:'nearest',behavior:'smooth'});
            }));
            if(comment.permissions?.canDelete)actions.appendChild(button('删除',()=>this.deleteDialog(state,comment,false)));
            if(author&&!own&&['visible','pending_review'].includes(comment.state)){
                if(Array.isArray(moderation?.flagReasons)&&moderation.flagReasons.length&&!comment.viewerFlagged)actions.appendChild(button('举报',()=>this.flagDialog(state,comment)));
                if(moderation?.blocks===true)actions.appendChild(button('屏蔽',()=>this.blockDialog(state,author)));
            }
            if(state.channel==='private'&&state.me?.isCommentAdmin){
                if(comment.permissions?.canModerate)actions.appendChild(button('管理删除',()=>this.deleteDialog(state,comment,true)));
                actions.appendChild(button('禁言',()=>this.muteDialog(state,comment.author)));
            }
            card.appendChild(actions);
            if(!isReply) {
                const replies=node('div',null,'tc-replies');const ids=new Set();
                const append=items=>{for(const reply of items || []){if(ids.has(reply.id))continue;ids.add(reply.id);replies.appendChild(this.card(state,reply,true));}};
                append(comment.replies);
                let cursor=comment.repliesNextCursor;
                const more=button('加载更多回复',async()=>{
                    if(!this.valid(state)||state.loading||state.busy||more.disabled)return;
                    const version=state.version;more.disabled=true;
                    try {state.avatarView?.beginRead();const data=await this.client.replies(comment.id,cursor);
                        if(this.valid(state)&&version===state.version){append(data.items);cursor=data.nextCursor;more.hidden=!cursor;}
                    }catch(error){this.showError(state,error);}
                    finally {more.disabled=false;}
                });
                more.hidden=!cursor;card.appendChild(replies);card.appendChild(more);
            }
            return card;
        }
        dialog(state,title) {
            if(!this.valid(state)||state.loading||state.busy)return null;
            const box=node('div',null,'tc-dialog');box.setAttribute('role','group');box.setAttribute('aria-label',title);box.appendChild(node('h3',title));
            state.dialog.replaceChildren(box);box.scrollIntoView({block:'nearest',behavior:'smooth'});return box;
        }
        async mutation(state,operation,refresh=true,done='操作完成') {
            if(!this.valid(state)||state.loading||state.busy)return;
            const version=state.version;
            state.busy=true;this.updateComposer(state);
            let success=false;
            try {await operation();if(!this.valid(state)||version!==state.version)return;state.dialog.replaceChildren();state.status.textContent=done;success=true;}
            catch(error){if(version===state.version)this.showError(state,error);}
            finally {if(this.valid(state)&&version===state.version){state.busy=false;this.updateComposer(state);}}
            if(!this.valid(state)||version!==state.version)return;
            if(success&&refresh)state.pages.delete(state.channel+':'+state.scope);
            if(await this.resumeFocus(state))return success;
            if(success&&refresh){state.reply=null;if(done!=='操作完成')state.notice=done;await this.load(state,true);}
            return success;
        }
        deleteDialog(state,comment,admin) {
            const box=this.dialog(state,admin?'管理员删除评论':'删除这条评论？');if(!box)return;
            let scope=null,reason=null;
            if(admin){
                scope=node('select');scope.setAttribute('aria-label','删除范围');
                scope.appendChild(new Option('仅此评论','single'));
                if(!comment.rootId)scope.appendChild(new Option('整条讨论（含所有回复）','thread'));
                box.appendChild(scope);reason=node('textarea');reason.placeholder='删除原因（1–200 字）';reason.setAttribute('aria-label','删除原因');box.appendChild(reason);
            }else box.appendChild(node('p','删除后正文将清除；已有回复会保留。'));
            box.appendChild(button('确认删除',()=>{
                if(admin&&!this.reason(state,reason.value))return;
                return this.mutation(state,()=>admin?this.client.moderate(comment.id,scope.value,reason.value.trim()):this.client.remove(comment.id));
            }));box.appendChild(button('取消',()=>state.dialog.replaceChildren()));
        }
        flagDialog(state,comment) {
            const reasons=(this.account?.session.moderation()?.flagReasons||[]).filter(reason=>typeof reason==='string');
            const box=this.dialog(state,'举报这条评论');if(!box||!reasons.length)return;
            const reason=node('select');reason.setAttribute('aria-label','举报原因');
            for(const value of reasons)reason.appendChild(new Option(FLAG_REASONS[value]||value,value));
            const note=node('textarea');note.placeholder='补充说明（可选，最多 500 字）';note.setAttribute('aria-label','补充说明');
            box.append(reason,note,node('p','举报人不会透露给对方。管理员会在 24 小时内处理。','tc-muted'));
            box.appendChild(button('提交举报',()=>{
                const text=note.value.trim();
                if(Array.from(text).length>500){state.status.textContent='补充说明最多 500 字。';return;}
                // A retry of the same report reuses its UUID; a changed report gets a new one.
                const key=JSON.stringify([comment.id,reason.value,text]);
                if(state.flagAttempt?.key!==key)state.flagAttempt={key,id:Client.uuid()};
                const attempt=state.flagAttempt;
                return this.mutation(state,async()=>{await this.client.flag(comment.id,reason.value,text,attempt.id);if(state.flagAttempt===attempt)state.flagAttempt=null;},true,'已收到举报，管理员会在 24 小时内处理。');
            }));box.appendChild(button('取消',()=>state.dialog.replaceChildren()));
        }
        blockDialog(state,author) {
            const box=this.dialog(state,'屏蔽 @'+author.name+'？');if(!box)return;
            box.appendChild(node('p','屏蔽后你将看不到 TA 的评论、回复和回复通知，对方不会收到提示。可在「评论账号」中解除屏蔽。'));
            box.appendChild(button('确认屏蔽',()=>this.mutation(state,()=>this.client.block(author.id),true,'已屏蔽 @'+author.name+'。')));
            box.appendChild(button('取消',()=>state.dialog.replaceChildren()));
        }
        reason(state,value) {
            const length=Array.from(value.trim()).length;
            if(length<1||length>200){state.status.textContent='请输入 1–200 字的操作原因。';return false;}return true;
        }
        muteDialog(state,author) {
            const box=this.dialog(state,'禁言 @'+author.name);if(!box)return;
            const duration=node('select');duration.setAttribute('aria-label','禁言时长');
            for(const [seconds,label] of [[3600,'1 小时'],[86400,'1 天'],[604800,'7 天'],[0,'永久']])duration.appendChild(new Option(label,String(seconds)));
            box.appendChild(duration);
            const reason=node('textarea');reason.placeholder='禁言原因（1–200 字）';reason.setAttribute('aria-label','禁言原因');box.appendChild(reason);
            box.appendChild(button('确认禁言',()=>{if(this.reason(state,reason.value))this.mutation(state,()=>this.client.mute(author.id,Number(duration.value),reason.value.trim()));}));
            box.appendChild(button('取消',()=>state.dialog.replaceChildren()));
        }
        adminButton(state) {
            if(state.admin)state.admin.remove();
            state.management.replaceChildren();
            if(state.channel==='public'||!state.me.isCommentAdmin)return;
            state.admin=button('管理',()=>this.manage(state));state.refresh.parentElement.appendChild(state.admin);
        }
        async manage(state,kind='mutes') {
            if(!this.valid(state)||state.channel==='public'||!state.me?.isCommentAdmin)return;
            state.management.replaceChildren();
            const box=node('div',null,'tc-management');state.management.appendChild(box);
            box.appendChild(node('h3','评论管理'));
            const toolbar=node('div',null,'tc-toolbar');box.appendChild(toolbar);
            toolbar.appendChild(button('禁言列表',()=>this.manage(state,'mutes')));toolbar.appendChild(button('管理记录',()=>this.manage(state,'actions')));
            const list=node('div');box.appendChild(list);
            const ids=new Set();let cursor=null;
            const more=button('加载更多记录',()=>load());box.appendChild(more);
            const load=async()=>{
                if(more.disabled||!this.valid(state))return;
                more.disabled=true;
                try {const data=await (kind==='mutes'?this.client.mutes(cursor):this.client.actions(cursor));
                    if(!this.valid(state)||!box.isConnected)return;
                    for(const record of data.items || []){
                        if(ids.has(record.id))continue;ids.add(record.id);
                        const row=node('div',null,'tc-card');
                        if(kind==='mutes'){
                            row.appendChild(node('strong',record.name));
                            row.appendChild(node('div',record.muteState==='permanent'?'永久禁言':(record.mutedUntil?'禁言至 '+time(record.mutedUntil):'禁言'),'tc-muted'));
                            row.appendChild(button('解除禁言',async()=>{if(await this.mutation(state,()=>this.client.unmute(record.id),false))this.manage(state,kind);}));
                        }else {
                            const labels={delete_single:'删除评论',delete_thread:'删除整条讨论',mute:'禁言',unmute:'解除禁言'};
                            row.appendChild(node('div',(labels[record.action]||record.action)+' · '+time(record.createdAt)));
                            row.appendChild(node('div',record.reason||'','tc-body'));
                            row.appendChild(node('div','操作人 '+record.actorId+' · 对象 '+record.targetId,'tc-muted'));
                        }
                        list.appendChild(row);
                    }
                    if(!ids.size)list.appendChild(node('p','暂无记录','tc-muted'));
                    cursor=data.nextCursor;more.hidden=!cursor;
                }catch(error){this.showError(state,error);}
                finally{more.disabled=false;}
            };
            await load();
        }
        close() {
            this.messages?.closeReportForm();
            this.epoch++;
            this.metadataController?.abort();this.metadataController=null;this.metadataView=null;
            this.client.clear();
            this.publicClient?.clear();this.privateClient.clear();
            if(this.state){this.state.placementObserver?.disconnect();this.state.resizeObserver?.disconnect();cancelAnimationFrame(this.state.alignmentFrame);this.state.unsubscribeAvatars?.();clearTimeout(this.state.avatarRetryTimer);this.clearAvatars(this.state);this.state.panel.remove();this.state.publicDialog?.close();this.state.publicDialog?.remove();}
            this.state=null;
        }
        destroy() {
            this.unsubscribeAccount?.();this.unsubscribeProfile?.();
            this.close();clearInterval(this.poll);
            this.messages?.destroy();
            document.removeEventListener('itemshow',this.itemShow);document.removeEventListener('viewbeforehide',this.hideView);
            document.removeEventListener('viewshow',this.viewShow);
            this.events?.off(this.connectionManager,'localusersignedout',this.sessionChanged);
            this.events?.off(this.connectionManager,'localusersignedin',this.signedIn);
            if(window.TigerestCommunityReset===this.reset)delete window.TigerestCommunityReset;
        }
    }
    window._communityPlugin=CommunityPlugin;
})();
