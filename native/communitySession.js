// Public comment credentials never share the private Emby authorization path.
(function () {
    'use strict';
    const errors = {
        LOGIN_REQUIRED:'注册或登录评论账号后查看评论', AUTH_REQUIRED:'请重新登录评论账号。', AUTH_INVALID:'登录已失效，请重新登录。',
        AUTH_UNAVAILABLE:'身份验证服务暂不可用，请稍后重试。', AUTH_BUSY:'身份验证服务繁忙，请稍后重试。',
        NETWORK_UNAVAILABLE:'公共评论网络暂不可用，请稍后重试。', NETWORK_STORAGE_UNAVAILABLE:'公共评论存储暂不可用。',
        NETWORK_CAPACITY:'公共评论服务繁忙，请稍后重试。', REGISTRATION_DISABLED:'暂未开放评论账号注册。',
        USER_MUTED:'你已被禁言，暂时无法发言。', NOT_FOUND:'内容不可见或已删除，请刷新。',
        TARGET_DELETED:'回复目标已删除，请重新选择。', IDEMPOTENCY_CONFLICT:'发送内容已变更，请重新发起。',
        MEDIA_ORDER_UNSUPPORTED:'此媒体的集序暂不支持公共讨论。', MEDIA_MAPPING_CONFLICT:'此媒体身份存在冲突，暂时无法打开讨论。',
        PASSWORD_LOGIN_UNAVAILABLE:'此账号使用 Emby 登录，请在 Emby 中管理密码。', INVALID_REQUEST:'提交格式无效，请检查后重试。',
        USERNAME_TAKEN:'用户名已被使用，请换一个。', SERVER_NOT_ALLOWED:'此账号无法使用大河身份交换。',
        TERMS_NOT_ACCEPTED:'发言前请先阅读并同意使用条款。', TERMS_OUTDATED:'使用条款已更新，请重新阅读并同意。',
        CANNOT_FLAG_SELF:'不能举报自己的评论。', CANNOT_BLOCK_SELF:'不能屏蔽自己。', BLOCK_LIMIT:'屏蔽名单已满，请先解除部分屏蔽。',
        CONTENT_REJECTED:'内容不符合社区规则，请修改后再试。', COMMENT_API_RETIRED:'专属评论已停止发言，请在公共评论中发表。',
        COMMUNITY_LEFT:'你已注销评论身份。需要时可在「评论账号」中重新加入。'
    };
    const abort = () => Object.assign(new Error('请求已取消'), {name:'AbortError'});
    const fail = (code, status = 0) => Object.assign(new Error(errors[code] || '公共评论请求失败，请稍后重试。'), {code,status});
    const guid = value => typeof value === 'string' && /^[0-9a-f-]+$/i.test(value) && value.replace(/-/g,'').length === 32 ? value.replace(/-/g,'').toLowerCase() : '';
    function validTokens(value) {
        return value && value.tokenType === 'Bearer' && ['accessToken','refreshToken'].every(k =>
            typeof value[k] === 'string' && /^[A-Za-z0-9._~+\/-]{1,4000}={0,2}$/.test(value[k])) &&
            Number.isFinite(Date.parse(value.expiresAt)) && Number.isFinite(Date.parse(value.refreshExpiresAt)) &&
            typeof value.author?.id === 'string' && typeof value.author?.name === 'string';
    }
    class CommunitySession {
        constructor({transport,store,now=Date.now,onTrust=()=>{},onChange=()=>{}}) {
            Object.assign(this,{transport,store,now,onTrust,onChange});this.generation=0;this.controllers=new Set();this.storageQueue=Promise.resolve();
        }
        setSession(emby) {
            const next=emby?.token && emby.userId && emby.serverId ? {...emby} : null;
            const fingerprint=JSON.stringify(next);
            if(fingerprint===this.fingerprint)return false;
            this.generation++;for(const c of this.controllers)c.abort();this.controllers.clear();
            this.emby=next;this.fingerprint=fingerprint;this.tokens=null;this.renewalError=null;this.flight=null;this.capFlight=null;this.loaded=false;this.persisted=false;this.left=false;
            this.key=next?JSON.stringify([guid(next.serverId)||next.serverId,next.userId,next.address]):null;
            this.onTrust(null);this.onChange();return true;
        }
        trusted() { return !!(this.emby && this.caps?.enabled && this.caps.auth?.includes('emby-exchange') && guid(this.caps.embyExchangeServerId) && guid(this.emby.serverId)===guid(this.caps.embyExchangeServerId)); }
        check(g) {if(g!==this.generation)throw abort();}
        // Compliance entries appear only where the service announces them.
        moderation() {
            const value=this.caps?.moderation;
            return value&&typeof value==='object'?value:null;
        }
        terms() {
            const terms=this.moderation()?.terms;
            return typeof terms?.version==='string'&&terms.version&&/^https?:\/\//.test(terms.url||'')?terms:null;
        }
        canDeleteAccount(me) {
            const kinds=this.moderation()?.accountDeletion?.authKinds;
            return Array.isArray(kinds)&&kinds.includes(me?.account?.authKind);
        }
        storage(operation,key,value) {
            const pending=this.storageQueue.then(()=>this.store[operation](key,value));
            this.storageQueue=pending.catch(()=>{});return pending;
        }
        passwordPolicy() {
            const policy=this.caps?.passwordPolicy;
            return policy?.minLength===8 && policy.maxLength===128 && policy.lengthUnit==='unicode-code-point' && policy.allowControlCharacters===false
                ? {minLength:8,maxLength:128} : {minLength:12,maxLength:128};
        }
        validatePassword(password,repeated=password) {
            const {minLength,maxLength}=this.passwordPolicy(),length=Array.from(password).length;
            if(length<minLength||length>maxLength)throw Object.assign(fail('INVALID_REQUEST'),{message:'密码需为 '+minLength+'–'+maxLength+' 个字符（当前 '+length+' 个）。'});
            if(/[\u0000-\u001f\u007f]/.test(password))throw Object.assign(fail('INVALID_REQUEST'),{message:'密码不可包含换行等控制字符。'});
            // The service never receives the repeat; only this comparison does.
            if(repeated!==password)throw Object.assign(fail('INVALID_REQUEST'),{message:'两次输入的密码不一致。'});
        }
        displayNamePolicy() {
            const policy=this.caps?.profilePolicy?.displayName;
            return Number.isInteger(policy?.minLength)&&Number.isInteger(policy?.maxLength)&&policy.minLength>=1&&policy.maxLength>=policy.minLength
                ? {minLength:policy.minLength,maxLength:policy.maxLength} : {minLength:1,maxLength:60};
        }
        validateDisplayName(value) {
            const name=String(value).trim(),{minLength,maxLength}=this.displayNamePolicy(),length=Array.from(name).length;
            const invalid=message=>{throw Object.assign(fail('INVALID_REQUEST'),{message});};
            if(length<minLength||length>maxLength)invalid('显示名称需为 '+minLength+'–'+maxLength+' 个字符，不能只填空格（当前 '+length+' 个）。');
            if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(name))invalid('显示名称不可包含控制字符。');
            return name;
        }
        // Self-service names exist only where the service announces them and
        // /me grants this password account the edit.
        canChangeDisplayName(me) {
            const policy=this.caps?.profilePolicy;
            return !!(policy?.displayName&&Array.isArray(policy.authKinds)&&policy.authKinds.includes('password')&&
                me?.account?.authKind==='password'&&me.account.canChangeDisplayName===true);
        }
        async raw(path,{method='GET',body,headers={},signal,responseType}={}) {
            const generation=this.generation,controller=new AbortController();this.controllers.add(controller);
            const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
            const timeout=setTimeout(cancel,15000);
            try {
                const response=await this.transport(path,{method,body:body===undefined?undefined:JSON.stringify(body),headers,signal:controller.signal,...(responseType?{responseType}:{})});
                this.check(generation);if(controller.signal.aborted)throw abort();
                if(responseType==='image' && response.status>=200 && response.status<300){
                    const encoded=response.bodyBase64;
                    if(!/^image\/png(?:;|$)/i.test(response.headers?.['content-type']||response.headers?.['Content-Type']||'') ||
                        typeof encoded!=='string'||!encoded.length||encoded.length>349528||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw fail('NETWORK_UNAVAILABLE');
                    const decoded=atob(encoded);if(decoded.length>262144)throw fail('NETWORK_UNAVAILABLE');
                    return new Blob([Uint8Array.from(decoded,c=>c.charCodeAt(0))],{type:'image/png'});
                }
                let payload;try {payload=JSON.parse(response.body);}catch(_){throw fail('NETWORK_UNAVAILABLE',response.status);}
                if(response.status<200 || response.status>=300){
                    const error=fail(payload?.error?.code,response.status);
                    if(response.status===429){error.retryAfter=Math.min(86400,Math.max(1,Number(response.headers?.['retry-after']||response.headers?.['Retry-After'])||3));error.message='操作过于频繁，请等待 '+error.retryAfter+' 秒后重试。';}
                    if(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(payload?.requestId||''))error.requestId=payload.requestId;
                    throw error;
                }
                if(!payload?.data)throw fail('NETWORK_UNAVAILABLE');return payload.data;
            }catch(error){this.check(generation);if(signal?.aborted)throw abort();if(error.status||error.code)throw error;throw fail('NETWORK_UNAVAILABLE');}
            finally {clearTimeout(timeout);signal?.removeEventListener('abort',cancel);this.controllers.delete(controller);}
        }
        async discover() {
            if(this.caps && this.now()<this.capsUntil){this.onTrust(this.trusted()?this.emby:null);return this.caps;}
            if(this.capFlight)return this.capFlight;
            const generation=this.generation;
            const work=this.raw('/capabilities').then(data=>{
                this.check(generation);
                if(data.enabled!==true || !Array.isArray(data.auth) || data.mediaIdentity!=='tmdb-aired')throw fail('NETWORK_UNAVAILABLE');
                this.caps=data;this.capsUntil=this.now()+300000;this.onTrust(this.trusted()?this.emby:null);return data;
            });
            this.capFlight=work;try{return await work;}finally{if(this.capFlight===work)this.capFlight=null;}
        }
        async save(data,generation,kind) {
            this.check(generation);if(!validTokens(data))throw fail('AUTH_INVALID');
            const record={...data,kind},key=this.key;
            // A failed secure store keeps an explicit memory-only session, never a plaintext fallback.
            let saved=false;try {saved=await this.storage('write',key,JSON.stringify(record));}catch(_){}
            this.check(generation);this.tokens=record;this.renewalError=null;this.persisted=saved===true;this.onChange();return record;
        }
        async ready(force=false) {
            if(this.flight)return this.flight;
            const generation=this.generation;
            const work=this.prepare(generation,force);this.flight=work;
            try{return await work;}catch(error){
                this.check(generation);if(error.status===401)await this.invalidate(error);throw error;
            }finally{if(this.flight===work)this.flight=null;}
        }
        async invalidate(error){
            const key=this.key;this.generation++;for(const c of this.controllers)c.abort();this.controllers.clear();
            this.tokens=null;this.renewalError=null;this.flight=null;this.loaded=true;this.persisted=false;
            error.revokedGeneration=this.generation;this.onChange();await this.storage('remove',key).catch(()=>{});
        }
        async prepare(generation,force) {
            await this.discover();this.check(generation);if(!this.emby)throw fail('LOGIN_REQUIRED');
            if(!this.loaded){
                this.loaded=true;let saved;
                try{saved=JSON.parse(await this.storage('read',this.key));}catch(_){}
                this.check(generation);
                this.left=saved?.left===true;
                if(validTokens(saved) && (this.trusted()?saved.kind==='emby':saved.kind==='password')){this.tokens=saved;this.persisted=true;this.onChange();}
            }
            if(this.tokens && !force && Date.parse(this.tokens.expiresAt)>this.now()+30000)return this.tokens;
            if(this.trusted()){
                // A deleted identity is never exchanged again until the user asks to rejoin.
                if(this.left)throw fail('COMMUNITY_LEFT');
                const headers={'X-Emby-Token':this.emby.token,'X-Emby-Server-Id':this.emby.serverId,'X-Emby-User-Id':this.emby.userId};
                return this.save(await this.raw('/auth/emby',{method:'POST',body:{},headers}),generation,'emby');
            }
            const old=this.tokens;
            if(this.renewalError)throw this.renewalError;
            if(!old || Date.parse(old.refreshExpiresAt)<=this.now()){this.tokens=null;this.onChange();throw fail('LOGIN_REQUIRED');}
            // Tombstone before dispatch: a crash/lost refresh response cannot replay the old rotating secret.
            this.tokens=null;
            if(this.persisted){
                let removed=false;try{removed=await this.storage('remove',this.key);}catch(_){}
                this.check(generation);if(removed!==true)throw fail('AUTH_REQUIRED');this.persisted=false;
            }
            try{return await this.save(await this.raw('/auth/refresh',{method:'POST',body:{refreshToken:old.refreshToken}}),generation,'password');}
            catch(error){
                this.check(generation);
                if(error.status===503){this.tokens={...old,refreshToken:null};this.renewalError=error;}
                this.onChange();throw error.status===503?error:fail('AUTH_REQUIRED',error.status);
            }
        }
        async authenticate(path,body) {
            await this.discover();if(!this.emby)throw fail('LOGIN_REQUIRED');
            if(this.trusted())throw fail('PASSWORD_LOGIN_UNAVAILABLE');
            if(path==='/auth/register' && !this.caps.registrationEnabled)throw fail('REGISTRATION_DISABLED');
            if(!this.caps.auth.includes('password'))throw fail('PASSWORD_LOGIN_UNAVAILABLE');
            const generation=this.generation;
            const data=await this.raw(path,{method:'POST',body});this.loaded=true;
            return this.save(data,generation,'password');
        }
        login(username,password) {return this.authenticate('/auth/login',{username,password});}
        async register(username,displayName,password,repeated=password,acceptedTermsVersion=null) {
            const invalid=message=>{throw Object.assign(fail('INVALID_REQUEST'),{message});};
            if(!/^[A-Za-z][A-Za-z0-9_.-]{2,31}$/.test(username))invalid('用户名需为 3–32 个字符，以英文字母开头，仅可包含英文字母、数字、_、.、-。');
            await this.discover();const name=this.validateDisplayName(displayName);this.validatePassword(password,repeated);
            const terms=this.terms();
            // Only the user's own tick sends the current version; the service refuses a missing one.
            if(terms&&acceptedTermsVersion!==terms.version)invalid('请先阅读并勾选同意使用条款。');
            return this.authenticate('/auth/register',{username,displayName:name,password,...(terms?{acceptedTermsVersion}:{})});
        }
        async request(path,options={}) {
            const generation=this.generation;let record;
            const call=()=>this.raw(path,{...options,headers:{Authorization:'Bearer '+record.accessToken}});
            try{
                record=await this.ready();this.check(generation);
                try{return await call();}catch(error){
                    this.check(generation);if(error.status!==401)throw error;
                    // Another concurrent request may already have replaced the rejected token.
                    record=this.tokens?.accessToken!==record.accessToken && this.tokens ? this.tokens : await this.ready(true);
                    this.check(generation);return await call();
                }
            }catch(error){
                if(error.status===401&&error.revokedGeneration===this.generation)throw error;
                this.check(generation);
                if(error.status===401)await this.invalidate(error);
                throw error;
            }
        }
        async logout() {
            const token=this.tokens,key=this.key;
            this.generation++;for(const c of this.controllers)c.abort();this.controllers.clear();this.tokens=null;this.flight=null;this.loaded=true;this.persisted=false;this.onChange();
            const outcomes=await Promise.allSettled([
                key?this.storage('remove',key):Promise.resolve(true),
                token?this.raw('/auth/logout',{method:'POST',body:{},headers:{Authorization:'Bearer '+token.accessToken}}):Promise.resolve({})]);
            if(outcomes[0].status!=='fulfilled'||outcomes[0].value!==true)throw new Error('已退出当前会话，但系统凭据未能清除，请重试退出。');
            if(outcomes[1].status==='rejected')throw outcomes[1].reason;
        }
        async acceptTerms(version) {
            try{return await this.request('/me/terms',{method:'POST',body:{version}});}
            catch(error){
                // A newer version must be read and agreed to again; never agree on the user's behalf.
                if(error.code==='TERMS_OUTDATED'){this.capsUntil=0;try{await this.discover();}catch(_){}}
                throw error;
            }
        }
        async deleteAccount(password) {
            await this.discover();
            const record=await this.ready(),generation=this.generation,kind=record.kind;
            let failure=null;
            try{await this.raw('/me/delete',{method:'POST',body:kind==='password'?{password,confirm:'DELETE'}:{confirm:'DELETE'},headers:{Authorization:'Bearer '+record.accessToken}});}
            catch(error){this.check(generation);failure=error;}
            if(failure){
                if(failure.status&&failure.status!==401)throw failure;
                // A wrong password and an ended session both answer 401, and a lost
                // response leaves the outcome open. Ask /me with the same token rather
                // than resubmitting, refreshing or exchanging a new identity.
                let alive=false;
                try{await this.raw('/me',{headers:{Authorization:'Bearer '+record.accessToken}});alive=true;}
                catch(probe){this.check(generation);if(probe.status!==401)throw Object.assign(fail('NETWORK_UNAVAILABLE'),{message:'暂时无法确认评论账号是否已注销，请稍后重新打开评论账号查看，不要重复提交。'});}
                if(alive)throw Object.assign(fail(failure.status?'AUTH_INVALID':'NETWORK_UNAVAILABLE',failure.status),
                    {message:failure.status?'密码不正确，评论账号没有注销。':'网络中断，评论账号没有注销，请重试。'});
                await this.forget(kind);
                throw Object.assign(fail('AUTH_REQUIRED',401),{message:'评论登录已失效，无法确认是否已注销。'+(kind==='emby'?'需要时可在「评论账号」中重新加入。':'请重新登录查看。')});
            }
            await this.forget(kind);return true;
        }
        async forget(kind) {
            const key=this.key;
            this.generation++;for(const c of this.controllers)c.abort();this.controllers.clear();
            this.tokens=null;this.renewalError=null;this.flight=null;this.loaded=true;this.persisted=false;this.left=kind==='emby';this.onChange();
            await (kind==='emby'?this.storage('write',key,JSON.stringify({left:true})):this.storage('remove',key)).catch(()=>{});
        }
        async rejoin() {
            this.left=false;await this.storage('remove',this.key).catch(()=>{});this.onChange();
            return this.ready();
        }
        async changeDisplayName(value) {
            await this.discover();
            const displayName=this.validateDisplayName(value),generation=this.generation;
            let author;
            try{author=(await this.request('/me/profile',{method:'PUT',body:{displayName}})).author;}
            catch(error){
                this.check(generation);if(error.status)throw error;
                // The response was lost: read the name back instead of resubmitting.
                let me;try{me=await this.request('/me');}catch(_){throw Object.assign(fail('NETWORK_UNAVAILABLE'),{message:'无法确认昵称是否已保存，请稍后重新打开评论账号查看。'});}
                if(me?.author?.name!==displayName)throw error;
                author=me.author;
            }
            this.check(generation);
            const record=this.tokens;
            if(!record||typeof author?.name!=='string'||author.id!==record.author.id)return author;
            this.tokens={...record,author:{...record.author,name:author.name}};
            // Only while these exact tokens are current: a queued write must never
            // restore a refresh secret that a later rotation already replaced.
            if(this.persisted){const tokens=this.tokens,key=this.key;
                this.storageQueue=this.storageQueue.then(()=>this.tokens===tokens&&this.store.write(key,JSON.stringify(tokens))).catch(()=>{});}
            return this.tokens.author;
        }
        async changePassword(currentPassword,newPassword,repeated=newPassword) {
            await this.discover();this.validatePassword(newPassword,repeated);
            const record=await this.ready(),generation=this.generation;
            let failure=null;
            try{await this.raw('/me/password',{method:'PUT',body:{currentPassword,newPassword},headers:{Authorization:'Bearer '+record.accessToken}});}
            catch(error){this.check(generation);failure=error;}
            if(failure){
                if(failure.status&&failure.status!==401)throw failure;
                // A wrong current password and an ended session both answer 401, and a
                // lost response leaves the outcome open. A successful change ends every
                // session, so ask /me rather than ever resubmitting the password.
                let alive=false;
                try{await this.request('/me');alive=true;}
                catch(probe){if(probe.status!==401)throw Object.assign(fail('NETWORK_UNAVAILABLE'),{message:'暂时无法确认密码是否已修改，请稍后重新打开评论账号查看，不要重复提交。'});}
                if(alive)throw Object.assign(fail(failure.status?'AUTH_INVALID':'NETWORK_UNAVAILABLE',failure.status),
                    {message:failure.status?'当前密码不正确，密码没有修改。':'网络中断，密码没有修改，请重试。'});
                if(failure.status)throw fail('AUTH_INVALID',401);
            }
            this.generation++;for(const c of this.controllers)c.abort();this.controllers.clear();
            this.tokens=null;this.flight=null;this.loaded=true;this.persisted=false;this.onChange();await this.storage('remove',this.key);
        }
    }
    CommunitySession.normalizeGuid=guid;
    window.TigerestCommunitySession=CommunitySession;
})();
