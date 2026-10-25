(function(){
    'use strict';
    let singleton;
    const element=(tag,text)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;return e;};
    const openUrl=url=>window.NativeShell?.openUrl?window.NativeShell.openUrl(url):window.open(url,'_blank','noopener');
    class Account {
        constructor(connectionManager){
            this.connectionManager=connectionManager;
            this.listeners=new Set();this.profileListeners=new Set();
            this.bridge=new window.TigerestCommunityBridge(window.api?.system||window.tigerestAndroidApi?.system);
            this.session=new window.TigerestCommunitySession({transport:this.bridge.transport,store:this.bridge.store,
                onTrust:session=>{window.TigerestCommunityClient.setTrustedServer(this.session?.caps?.embyExchangeServerId||'');this.mappingSession(session);},onChange:()=>this.identityChanged()});
            if(window.TigerestCommunityAvatar)this.avatars=new window.TigerestCommunityAvatar({session:this.session,sourceAvatar:(emby,options)=>this.bridge.sourceAvatar(emby,options)});
            window.TigerestCommunityClient.setTrustedServer('');this.sync();
            // Jellyfin's web client dispatches its own pagehide from view elements;
            // only the browser's pagehide for the document ends this page.
            const leave=event=>{if(!event.isTrusted||(event.target!==document&&event.target!==window))return;window.removeEventListener('pagehide',leave);this.session.setSession(null);};
            window.addEventListener('pagehide',leave);
        }
        subscribe(listener){this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
        // The same author under a new name: lists reload, drafts stay.
        subscribeProfile(listener){this.profileListeners.add(listener);return ()=>this.profileListeners.delete(listener);}
        async rename(displayName){
            const author=await this.session.changeDisplayName(displayName);
            for(const listener of this.profileListeners)listener(author);
            return author;
        }
        identityChanged(){
            const identity=JSON.stringify([this.session.fingerprint,this.session.tokens?.author?.id||null]);
            if(identity===this.identity)return;
            const previous=this.identity;this.identity=identity;
            this.avatars?.clear();
            for(const listener of this.listeners)listener({previous,identity,author:this.session.tokens?.author||null});
        }
        async mappingSession(emby){
            const key=JSON.stringify(emby);
            if(this.mappingContext!==key){
                this.mappingContext=key;this.mappingKey=null;this.mappingFlight=null;this.mappingRetryAt=0;
                await this.bridge.setEmby(null).catch(()=>{});
            }
            if(!emby||this.mappingContext!==key||this.mappingKey===key||Date.now()<this.mappingRetryAt||this.mappingFlight===key)return;
            this.mappingFlight=key;
            try{
                const response=await this.bridge.transport('/mapping-capabilities');
                if(this.mappingContext!==key)return;
                if(response.status===404){await this.bridge.setEmby({...emby,mappingAuth:'legacy'});this.mappingKey=key;return;}
                const caps=JSON.parse(response.body);
                if(response.status===200&&caps.success===true&&caps.writeAuth?.includes('emby-session')){
                    if(await this.bridge.setEmby(emby)!==false)this.mappingKey=key;
                }
            }catch(_){/* A transient capability failure must remain retryable. */}
            finally{if(this.mappingContext===key){this.mappingFlight=null;this.mappingRetryAt=Date.now()+30000;}}
        }
        sync(){
            const emby=window.TigerestCommunityClient.session(this.connectionManager.currentApiClient?.());
            if(this.blockedKey===JSON.stringify(emby))return null;
            this.blockedKey=null;
            if(this.session.setSession(emby)){
                this.dialog?.close();this.dialog?.remove();this.dialog=null;
                if(emby)this.session.discover().catch(()=>{});
            }
            if(emby&&this.session.trusted())this.mappingSession(emby);
            return emby;
        }
        reset(){this.blockedKey=JSON.stringify(window.TigerestCommunityClient.session(this.connectionManager.currentApiClient?.()));this.session.setSession(null);this.dialog?.close();}
        async show(onDone=()=>{},notice=''){
            this.dialog?.close();this.dialog?.remove();
            const dialog=element('dialog');this.dialog=dialog;dialog.id='tigerest-community-account';
            dialog.style.cssText='color:#e9eff8;background:#172335;border:1px solid #526882;border-radius:14px;padding:24px;width:min(420px,calc(100vw - 64px));max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box';
            const title=element('h2','公共评论账号'),summary=element('p'),status=element('p',notice||'正在连接评论服务…'),body=element('div'),controls=element('div');
            summary.hidden=true;summary.style.whiteSpace='pre-wrap';
            status.setAttribute('role','status');status.style.whiteSpace='pre-wrap';body.style.cssText='display:grid;gap:22px';controls.style.cssText='display:flex;gap:10px;flex-wrap:wrap;margin-top:18px';
            const close=element('button','关闭');close.type='button';close.onclick=()=>dialog.close();controls.append(close);
            dialog.append(title,summary,status,body,controls);document.body.append(dialog);dialog.showModal();
            const current=()=>this.dialog===dialog&&dialog.open;
            const addButton=(label,action,parent=null)=>{const b=element('button',label);b.type='button';b.className='tc-button';b.onclick=action;if(parent)parent.append(b);else controls.prepend(b);return b;};
            // One request at a time: every control waits for it to settle.
            const run=async(operation,done=()=>{dialog.close();onDone();})=>{
                for(const input of dialog.querySelectorAll('input,button'))input.disabled=true;
                try{const result=await operation();if(current())done(result);}
                catch(error){if(current())status.textContent=error.message;}
                finally{for(const input of dialog.querySelectorAll('input,button'))input.disabled=false;}
            };
            const group=heading=>{
                const form=element('form');form.style.cssText='display:grid;gap:12px';form.onsubmit=e=>{e.preventDefault();form.querySelector('button')?.click();};
                if(heading){const h=element('h3',heading);h.style.cssText='margin:0;font-size:16px;font-weight:600';form.append(h);}
                body.append(form);return form;
            };
            const field=(form,label,type,autocomplete,required=true)=>{
                const wrap=element('label',label),input=element('input');input.type=type;input.autocomplete=autocomplete;input.required=required;
                input.setAttribute('aria-label',label);input.style.cssText='box-sizing:border-box;display:block;width:100%;padding:9px;margin-top:5px;font:inherit';wrap.append(input);form.append(wrap);return input;
            };
            const hint=(input,text,id)=>{const help=element('small',text);help.id=id;help.style.cssText='display:block;margin-top:5px;color:#aebbd0';input.parentElement.append(help);input.setAttribute('aria-describedby',id);return help;};
            const checkbox=(form,label)=>{
                const wrap=element('label'),input=element('input');input.type='checkbox';wrap.style.cssText='display:flex;gap:8px;align-items:center';
                wrap.append(input,element('span',label));form.append(wrap);return input;
            };
            // Terms and contact details come from the service; nothing shows before it announces them.
            const legal=()=>{
                const terms=this.session.terms();if(!terms)return;
                const box=element('div');box.style.cssText='display:flex;gap:10px;flex-wrap:wrap;align-items:center;color:#aebbd0';
                addButton('阅读使用条款',()=>openUrl(terms.url),box);
                const contact=typeof terms.contact==='string'?terms.contact.replace(/^mailto:/i,''):'';
                if(contact)box.append(element('small','联系我们：'+contact));
                body.append(box);
            };
            const blocks=async()=>{
                if(this.session.moderation()?.blocks!==true)return;
                const form=group('已屏蔽的用户'),list=element('div');list.style.cssText='display:grid;gap:8px';form.append(list);
                const more=addButton('加载更多',()=>run(load,()=>{}),form);more.hidden=true;
                let cursor=null;
                const empty=()=>{if(!list.children.length)list.append(element('small','没有屏蔽任何用户。'));};
                const load=async()=>{
                    const page=await this.session.request('/me/blocks?limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
                    if(!current())return;
                    for(const entry of page.items||[]){
                        if(!entry?.author?.id)continue;
                        const row=element('div');row.style.cssText='display:flex;gap:10px;align-items:center;justify-content:space-between';
                        const name=entry.author.name||'已注销用户';row.append(element('span',name));
                        addButton('解除屏蔽',()=>run(()=>this.session.request('/me/blocks/'+encodeURIComponent(entry.author.id),{method:'DELETE'}),()=>{
                            row.remove();empty();status.textContent='已解除对 '+name+' 的屏蔽，刷新评论后可见。';}),row);
                        list.append(row);
                    }
                    cursor=page.nextCursor||null;more.hidden=!cursor;empty();
                };
                try{await load();}catch(error){if(current())list.append(element('small',error.message));}
            };
            const deletion=me=>{
                if(!this.session.canDeleteAccount(me))return;
                const form=group('注销评论账号'),emby=me.account.authKind==='emby';
                form.append(element('p','仅注销评论身份，不会删除 Emby 账号。将删除昵称、头像、屏蔽名单、消息以及你发表的评论正文；有他人回复的评论会显示为「已注销用户」。注销后无法恢复。'));
                const password=emby?null:field(form,'当前密码','password','current-password');
                const sure=checkbox(form,'我了解注销后无法恢复');sure.required=true;
                addButton('注销评论账号',()=>{if(form.reportValidity())run(()=>this.session.deleteAccount(password?.value),()=>{
                    this.avatars?.clear?.();this.show(onDone,'评论账号已注销。'+(emby?'不会自动重新加入，需要时可以在这里重新加入。':''));});},form);
            };
            try{
                const caps=await this.session.discover();if(!current())return;
                const policy=this.session.passwordPolicy?.()||{minLength:12,maxLength:128};
                const passwordLabel=prefix=>prefix+'（'+policy.minLength+'–'+policy.maxLength+' 个字符）';
                const helpText='可使用字母、数字和符号，不可包含换行等控制字符。';
                if(this.session.trusted()){
                    try{await this.session.ready();}catch(error){if(error.code!=='COMMUNITY_LEFT')throw error;}
                    if(!current())return;
                    if(this.session.left){
                        status.textContent=notice||'你已注销评论身份，不会自动重新加入。';
                        addButton('重新加入公共评论',()=>run(()=>this.session.rejoin(),()=>this.show(onDone,'已重新加入公共评论。')));
                        legal();return;
                    }
                    status.textContent=notice||'已使用大河 Emby 账号登录公共评论。';
                    summary.textContent='评论里显示的名称和登录密码由 Emby 管理，请在 Emby 中修改。';summary.hidden=false;
                    let me=null;try{me=await this.session.request('/me');}catch(_){}
                    if(!current())return;
                    await blocks();if(!current())return;
                    deletion(me);legal();return;
                }
                try{await this.session.ready();}catch(error){if(!['LOGIN_REQUIRED','AUTH_REQUIRED','AUTH_INVALID'].includes(error.code))throw error;}
                if(!current())return;
                if(this.session.tokens){
                    const account=()=>'当前评论账号：'+this.session.tokens.author.name+(this.session.persisted?'':'\n安全存储不可用，本次登录仅在当前运行期间有效。');
                    summary.textContent=account();summary.hidden=false;status.textContent=notice;
                    // Edit rights come from /me; an older service without them still offers the password change.
                    let me=null;try{me=await this.session.request('/me');}catch(_){}
                    if(!current())return;
                    if(!this.session.tokens){this.show(onDone,'登录已失效，请重新登录。');return;}
                    addButton('退出评论账号',()=>run(()=>this.session.logout()));
                    if(this.session.canChangeDisplayName(me)){
                        const form=group('显示昵称'),limits=this.session.displayNamePolicy();
                        const name=field(form,'显示昵称（'+limits.minLength+'–'+limits.maxLength+' 个字符）','text','nickname');
                        name.value=this.session.tokens.author.name;name.maxLength=limits.maxLength*2;
                        hint(name,'只改变评论里显示的名称；登录用户名、头像和历史评论都保留。','tc-name-help');
                        addButton('保存昵称',()=>{if(form.reportValidity())run(()=>this.rename(name.value),author=>{
                            name.value=author.name;summary.textContent=account();status.textContent='昵称已改为「'+author.name+'」。';});},form);
                    }
                    if(me?.account?.canChangePassword!==false){
                        const form=group('修改密码');
                        const old=field(form,'当前密码','password','current-password'),next=field(form,passwordLabel('新密码'),'password','new-password');
                        const again=field(form,'确认新密码','password','new-password',false);
                        hint(next,helpText+'修改后所有设备上的评论登录都会退出。','tc-password-requirements');
                        addButton('修改密码',()=>{if(form.reportValidity())run(()=>this.session.changePassword(old.value,next.value,again.value),
                            ()=>this.show(onDone,'密码已修改，所有设备上的评论登录都已退出。请用新密码重新登录。'));},form);
                    }
                    await blocks();if(!current())return;
                    deletion(me);legal();return;
                }
                status.textContent=notice||'使用独立评论账号参与公共讨论。你的 Emby 登录凭据只用于自己的服务器。';
                const form=group();
                const username=field(form,'用户名','text','username'),password=field(form,'密码','password','current-password');
                const passwordHelp=hint(password,helpText,'tc-password-requirements');passwordHelp.hidden=true;
                let displayName,repeated,agree,register=false;
                const terms=this.session.terms();
                const submit=addButton('登录',()=>{if(form.reportValidity())run(()=>register?this.session.register(username.value,displayName.value,password.value,repeated.value,agree?.checked?terms.version:null):this.session.login(username.value,password.value));});
                form.onsubmit=e=>{e.preventDefault();submit.click();};
                if(caps.registrationEnabled)addButton('注册新账号',event=>{
                    register=!register;event.target.textContent=register?'已有账号，返回登录':'注册新账号';submit.textContent=register?'注册并登录':'登录';
                    if(!displayName){
                        displayName=field(form,'显示名称（1–60 字符）','text','nickname');displayName.maxLength=120;form.insertBefore(displayName.parentElement,password.parentElement);
                        repeated=field(form,'确认密码','password','new-password',false);
                        if(terms)agree=checkbox(form,'我已阅读并同意使用条款（零容忍不当内容）');
                    }
                    displayName.parentElement.hidden=!register;displayName.required=register;repeated.parentElement.hidden=!register;
                    if(agree){agree.parentElement.hidden=!register;agree.required=register;}
                    password.autocomplete=register?'new-password':'current-password';
                    password.parentElement.firstChild.textContent=register?passwordLabel('密码'):'密码';
                    passwordHelp.hidden=!register;
                    status.textContent=register?'用户名 3–32 位，以字母开头，可含数字、_、.、-。':'请输入评论账号和密码。';
                });
                legal();
            }catch(error){if(current()){
                status.textContent=error.message;addButton('重试连接',()=>this.show(onDone));
                if(this.session.renewalError)addButton('重新登录',()=>{this.session.tokens=null;this.session.renewalError=null;this.session.onChange();this.show(onDone);});
            }}
        }
    }
    window.TigerestCommunityAccount={get(connectionManager){if(!singleton)singleton=new Account(connectionManager);return singleton;}};
})();
