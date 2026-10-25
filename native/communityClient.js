// Public client for the independently deployed, private community service.
(function () {
    'use strict';
    const trustedServer = '62526c3bf747439c99327ddec5fed4a8';
    const messages = {
        AUTH_REQUIRED: '请登录 Emby 后使用评论区。', AUTH_INVALID: '登录已失效，请重新登录。',
        SERVER_NOT_ALLOWED: '此服务器暂未开放评论区。', FORBIDDEN: '没有执行此操作的权限。',
        USER_MUTED: '你已被禁言，暂时无法发表或回复。', NOT_FOUND: '内容不可见或已删除，请刷新评论。',
        TARGET_DELETED: '回复目标已删除，请刷新后重新选择。', PROTECTED_ADMIN: '评论管理员不可被禁言。',
        IDEMPOTENCY_CONFLICT: '本次发送的内容已变更，请刷新后重试。',
        AUTH_UNAVAILABLE: '身份验证服务暂不可用，请稍后重试。',
        COMMUNITY_UNAVAILABLE: '评论服务暂不可用，请稍后重试。',
        MESSAGES_UNAVAILABLE: '消息功能尚未启用，请联系管理员升级评论服务。',
        DIAGNOSTICS_ALREADY_EXISTS: '此报错已有日志附件，无法替换。',
        DIAGNOSTICS_EXPIRED: '日志附件已到期，报错及修复结果仍可查看。',
        DIAGNOSTICS_TOO_LARGE: '日志附件过大，报错仍已保存。',
        DIAGNOSTICS_STORAGE_UNAVAILABLE: '日志存储暂不可用，请稍后重试附件。',
        UNSUPPORTED_MEDIA_TYPE: '日志附件格式不受支持。',
        INVALID_REQUEST: '提交内容格式无效，请检查后重试。',
        COMMENT_API_RETIRED: '专属评论已停止发言，请在公共评论中发表。'
    };
    function abortError() { const error = new Error('评论请求已取消'); error.name = 'AbortError'; return error; }
    function uuid() {
        // Emby is served over HTTP, where randomUUID may be unavailable.
        if (window.crypto.randomUUID) return window.crypto.randomUUID();
        const bytes = window.crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
    }
    const uuidPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    function textBytes(text) {
        let bytes=0;
        for(let i=0;i<text.length;i++){
            const code=text.charCodeAt(i);
            if(code>=0xd800&&code<=0xdbff){
                const low=text.charCodeAt(++i);
                if(!(low>=0xdc00&&low<=0xdfff))throw new Error('诊断日志含有无效字符。');
                bytes+=4;
            }else if(code>=0xdc00&&code<=0xdfff)throw new Error('诊断日志含有无效字符。');
            else bytes+=code<0x80?1:code<0x800?2:3;
        }
        return bytes;
    }
    function validateDiagnostics(payload) {
        if(!payload||typeof payload!=='object'||Object.keys(payload).length!==4||
            !['clientRequestId','capturedAt','truncated','logText'].every(key=>Object.hasOwn(payload,key))||
            typeof payload.clientRequestId!=='string'||!uuidPattern.test(payload.clientRequestId)||typeof payload.truncated!=='boolean'||
            typeof payload.logText!=='string'||payload.logText.length>1048576||!payload.logText.trim()||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(payload.logText))
            throw new Error('诊断日志格式无效。');
        const utc=typeof payload.capturedAt==='string'&&payload.capturedAt.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
        const date=utc&&new Date(payload.capturedAt);
        if(!date||!Number.isFinite(date.getTime())||date.toISOString()!==utc[1]+'.'+(utc[2]||'').padEnd(3,'0')+'Z')
            throw new Error('诊断日志时间无效。');
        if(textBytes(payload.logText)>1048576||textBytes(JSON.stringify(payload))>8388608)
            throw new Error('诊断日志超过大小限制。');
        return payload;
    }
    class CommunityClient {
        constructor({ fetch: request = window.fetch.bind(window), now = Date.now } = {}) {
            this.fetch = request;
            this.now = now;
            this.generation = 0;
            this.controllers = new Set();
            this.reportControllers = new Set();
            this.reportGeneration = 0;
            this.pendingSend = null;
            this.pendingReport = null;
            this.cooldownUntil = 0;
            this.reportCooldownUntil = 0;
            this.diagnosticsCooldownUntil = 0;
            this.diagnosticsSnapshots = new WeakMap();
        }
        static session(api) {
            if (!api) return null;
            return {serverId: api.serverId?.(), userId: api.getCurrentUserId?.(),
                token: api.accessToken?.(), address: api.serverAddress?.()};
        }
        static supported(session) {
            const normalize=value=>String(value||'').replace(/-/g,'').toLowerCase();
            const expected=CommunityClient.trustedServerId===undefined?trustedServer:CommunityClient.trustedServerId;
            if (!session?.token || !session.userId || !expected || normalize(session.serverId)!==normalize(expected)) return false;
            try {
                const url = new URL(session.address);
                return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
                    (CommunityClient.trustedServerId!==undefined || ['192.168.5.150', 'nas.tigerest.top'].includes(url.hostname.toLowerCase()));
            } catch (_) { return false; }
        }
        static setTrustedServer(id) { CommunityClient.trustedServerId=id; }
        setSession(session) { return this.setContext(session); }
        setContext(session, itemId = null) {
            const next = CommunityClient.supported(session) ? {...session, itemId: itemId ? String(itemId) : null} : null;
            const key = next ? JSON.stringify(next) : '';
            if (key !== this.contextKey) {
                this.clear();
                this.contextKey = key;
                this.context = next;
                this.base = next ? 'http://' + (new URL(next.address).hostname === '192.168.5.150'
                    ? '192.168.5.150' : 'nas.tigerest.top') + ':18443/community/v1' : null;
            }
            return Boolean(this.context);
        }
        cancelRequests({preserveSend=false}={}) {
            this.generation++;
            for (const controller of this.controllers) controller.abort();
            this.controllers.clear();
            if(!preserveSend)this.pendingSend = null;
            this.cancelReportRequests();
        }
        cancelReportRequests() {
            this.reportGeneration++;
            for(const controller of this.reportControllers)controller.abort();
            this.reportControllers.clear();
            this.pendingReport = null;
            this.diagnosticsSnapshots = new WeakMap();
        }
        clear() {
            this.cancelRequests();
            this.context = null;
            this.contextKey = '';
            this.base = null;
            this.cooldownUntil = 0;
            this.reportCooldownUntil = 0;
            this.diagnosticsCooldownUntil = 0;
        }
        async request(path, {method = 'GET', body, item = false, image = false, signal} = {}) {
            if (!this.context) throw new Error(messages.AUTH_REQUIRED);
            if (item && !this.context.itemId) throw new Error('请先打开可访问的媒体详情。');
            const generation = this.generation;
            const reportRequest=method!=='GET'&&/^\/reports(?:\/|$)/.test(path),reportGeneration=this.reportGeneration;
            const cancelled=()=>generation!==this.generation||(reportRequest&&reportGeneration!==this.reportGeneration);
            const controller = new AbortController();
            const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
            this.controllers.add(controller);
            if(reportRequest)this.reportControllers.add(controller);
            const timeout = setTimeout(() => controller.abort(), 15000);
            const headers = {'X-Emby-Token': this.context.token,
                'X-Emby-Server-Id': this.context.serverId, 'X-Emby-User-Id': this.context.userId};
            if (item) headers['X-Tigerest-Item-Id'] = this.context.itemId;
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            try {
                const response = await this.fetch(this.base + path, {method, headers,
                    body: body === undefined ? undefined : JSON.stringify(body),
                    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal});
                if (cancelled()) throw abortError();
                if (response.ok && image) {
                    if (!/^image\/(png|jpeg|webp)(;|$)/i.test(response.headers.get('Content-Type') || ''))
                        throw new Error('头像暂不可用');
                    const blob = await response.blob();
                    if (cancelled()) throw abortError();
                    if (blob.size > 5 * 1024 * 1024) throw new Error('头像暂不可用');
                    return blob;
                }
                let payload;
                try{payload=await response.json();}
                catch(error){if(response.ok)throw error;payload={};}
                if (cancelled()) throw abortError();
                if (!response.ok) {
                    const code = String(payload?.error?.code || 'UNKNOWN');
                    let message = messages[code] || '评论请求失败，请稍后重试。';
                    let retryAfter = 0;
                    if (response.status === 429) {
                        retryAfter = Math.min(86400, Math.max(1, Number(response.headers.get('Retry-After')) || 3));
                        const cooldown=/^\/reports\/[^/]+\/diagnostics$/.test(path)?'diagnosticsCooldownUntil':path==='/reports'?'reportCooldownUntil':'cooldownUntil';
                        this[cooldown] = Math.max(this[cooldown], this.now() + retryAfter * 1000);
                        message = '操作过于频繁，请等待 ' + retryAfter + ' 秒后重试。';
                    }
                    const error = new Error(message);
                    Object.assign(error, {code, status: response.status, retryAfter});
                    // Only display a UUID request ID; never forward backend error text.
                    if (uuidPattern.test(payload?.requestId || '')) error.requestId = payload.requestId;
                    if (response.status === 401) this.clear();
                    throw error;
                }
                return payload.data;
            } catch (error) {
                if (cancelled()) {
                    if (error.status === 401) throw error;
                    throw abortError();
                }
                if (error.name === 'AbortError') throw new Error('评论请求超时，请重试。');
                if (error.status) throw error;
                throw new Error('网络连接失败，请重试。');
            } finally {
                clearTimeout(timeout);
                signal?.removeEventListener('abort',cancel);
                this.controllers.delete(controller);
                this.reportControllers.delete(controller);
            }
        }
        me() { return this.request('/me'); }
        resolve(scope) { return this.request('/topics/resolve', {method:'POST', body:{itemId:this.context?.itemId, scope}}); }
        page(path, cursor, item = true, anchorId = null, limit = 20) {
            if (cursor && anchorId) return Promise.reject(new Error('定位与分页不能同时使用。'));
            return this.request(path + (path.includes('?') ? '&' : '?') + 'limit=' + limit +
                (cursor ? '&cursor=' + encodeURIComponent(cursor) : '') +
                (anchorId ? '&anchorId=' + encodeURIComponent(anchorId) : ''), {item});
        }
        comments(topicId, cursor, anchorId) { return this.page('/topics/' + encodeURIComponent(topicId) + '/comments', cursor, true, anchorId, 10); }
        replies(rootId, cursor, anchorId) { return this.page('/comments/' + encodeURIComponent(rootId) + '/replies', cursor, true, anchorId); }
        async send(topicId, text, reply = null) {
            const body = text.trim();
            if (!body || Array.from(body).length > 2000) throw new Error('请输入 1–2000 个字符。');
            const wait = Math.ceil((this.cooldownUntil - this.now()) / 1000);
            if (wait > 0) throw new Error('请等待 ' + wait + ' 秒后重试。');
            const path = reply ? '/comments/' + encodeURIComponent(reply.rootId || reply.id) + '/replies'
                : '/topics/' + encodeURIComponent(topicId) + '/comments';
            const key = JSON.stringify([path, body, reply?.id]);
            if (this.pendingSend?.key !== key)
                this.pendingSend = {key, payload: {body, clientRequestId: uuid()}};
            if (reply) this.pendingSend.payload.replyToId = reply.id;
            const attempt=this.pendingSend,generation=this.generation;
            if(this.prepareSend)await this.prepareSend(attempt);
            if(generation!==this.generation)throw abortError();
            const result = await this.request(path, {method:'POST', body:attempt.payload, item:true});
            if(this.pendingSend===attempt)this.pendingSend = null;
            this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + 3000);
            // The server has accepted the comment. A secondary avatar task must never turn that into a failed send.
            try{this.afterSend?.(result,attempt);}catch(_){}
            return result;
        }
        remove(id) { return this.request('/comments/' + encodeURIComponent(id), {method:'DELETE', item:true}); }
        moderate(id, scope, reason) { return this.request('/admin/comments/' + encodeURIComponent(id) + '/delete',
            {method:'POST', body:{scope, reason}}); }
        mute(id, durationSeconds, reason) { return this.request('/admin/authors/' + encodeURIComponent(id) + '/mute',
            {method:'PUT', body:{durationSeconds, reason}}); }
        unmute(id) { return this.request('/admin/authors/' + encodeURIComponent(id) + '/mute', {method:'DELETE'}); }
        mutes(cursor) { return this.page('/admin/mutes', cursor, false); }
        actions(cursor) { return this.page('/admin/actions', cursor, false); }
        messageSummary() { return this.request('/me/messages?limit=1&type=all'); }
        messages(kind = 'replies', cursor, unreadOnly = false) {
            if (!['sent', 'replies'].includes(kind)) return Promise.reject(new Error('消息类型无效。'));
            return this.page(kind === 'sent' ? '/me/comments' : '/me/messages?type=all&unreadOnly=' + Boolean(unreadOnly), cursor, false);
        }
        readMessage(id) { return this.request('/me/messages', {method:'POST', body:{messageIds:[id]}}); }
        readAllMessages(readThroughToken) {
            if (typeof readThroughToken !== 'string' || !readThroughToken) return Promise.reject(new Error('消息快照无效，请刷新后重试。'));
            return this.request('/me/messages', {method:'POST', body:{readThroughToken}});
        }
        reports(status='all',cursor) {
            if(!['all','open','resolved'].includes(status))return Promise.reject(new Error('报错状态无效。'));
            return this.page('/me/reports?status='+status,cursor,false);
        }
        report(id) { return this.request('/me/reports/'+encodeURIComponent(id)); }
        createReportDiagnostics(snapshot) {
            const payload=Object.freeze(validateDiagnostics({clientRequestId:uuid(),capturedAt:snapshot?.capturedAt,
                truncated:snapshot?.truncated,logText:snapshot?.logText}));
            this.diagnosticsSnapshots.set(payload,{generation:this.generation,contextKey:this.contextKey,blocked:false});
            return payload;
        }
        async uploadReportDiagnostics(reportId,payload) {
            validateDiagnostics(payload);
            const binding=this.diagnosticsSnapshots.get(payload);
            if(!binding||binding.blocked||binding.generation!==this.generation||binding.contextKey!==this.contextKey)
                throw new Error('诊断日志已取消或无法重试。');
            if(!this.context)throw new Error(messages.AUTH_REQUIRED);
            if(typeof reportId!=='string'||!reportId)throw new Error('报错编号无效。');
            if(binding.reportId&&binding.reportId!==reportId)throw new Error('诊断日志已绑定其他报错。');
            binding.reportId=reportId;
            const wait=Math.ceil((this.diagnosticsCooldownUntil-this.now())/1000);
            if(wait>0)throw new Error('请等待 '+wait+' 秒后重试日志附件。');
            try{
                const result=await this.request('/reports/'+encodeURIComponent(reportId)+'/diagnostics',{method:'PUT',body:payload});
                this.diagnosticsCooldownUntil=Math.max(this.diagnosticsCooldownUntil,this.now()+3000);
                return result;
            }catch(error){
                if(error.status===401||error.status===409)binding.blocked=true;
                throw error;
            }
        }
        async sendReport(itemId,category,description,context={}) {
            if(!itemId)throw new Error('请先打开可访问的作品。');
            if(!['playback_error','subtitle_missing','subtitle_error','other'].includes(category))throw new Error('问题类型无效。');
            description=String(description||'').trim();
            const length=Array.from(description).length;
            if(length<3||length>2000)throw new Error('请填写 3–2000 字的说明，补充现象、发生时间或复现方式。');
            const wait=Math.ceil((this.reportCooldownUntil-this.now())/1000);
            if(wait>0)throw new Error('请等待 '+wait+' 秒后重试。');
            const details={};
            if(Number.isFinite(context.positionSeconds)&&context.positionSeconds>=0&&context.positionSeconds<=604800)details.positionSeconds=context.positionSeconds;
            for(const [key,max] of [['platform',64],['clientVersion',64],['mediaSourceId',128]]){
                if(typeof context[key]==='string'&&context[key].trim()&&Array.from(context[key]).length<=max)details[key]=context[key];
            }
            if(Number.isInteger(context.subtitleStreamIndex)&&context.subtitleStreamIndex>=-1&&context.subtitleStreamIndex<=1000)details.subtitleStreamIndex=context.subtitleStreamIndex;
            const payload={itemId:String(itemId),category,description,context:details},key=JSON.stringify(payload);
            if(this.pendingReport?.key!==key)this.pendingReport={key,payload:{...payload,clientRequestId:uuid()}};
            const pending=this.pendingReport;
            const result=await this.request('/reports',{method:'POST',body:pending.payload});
            if(this.pendingReport===pending)this.pendingReport=null;
            this.reportCooldownUntil=Math.max(this.reportCooldownUntil,this.now()+3000);
            return result;
        }
        adminMessages(filters = {}, cursor) {
            const query = new URLSearchParams({limit:'20'});
            for (const key of ['query', 'kind', 'state', 'rootId']) {
                if (filters[key]) query.set(key, String(filters[key]));
            }
            if (cursor) query.set('cursor', cursor);
            return this.request('/admin/messages?' + query);
        }
        avatar(path,options={}) {
            if (!/^\/community\/v1\/avatars\/[0-9a-z-]+(?:\?v=[^#]*)?$/i.test(path || ''))
                return Promise.reject(new Error('头像暂不可用'));
            return this.request(path.slice('/community/v1'.length), {...options,image:true});
        }
    }
    CommunityClient.uuid = uuid;
    window.TigerestCommunityClient = CommunityClient;
})();
