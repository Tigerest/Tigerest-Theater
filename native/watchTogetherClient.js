// Watch-together protocol client: REST, the realtime socket and the server clock.
// The contract is docs/watch-together-api.md (/watch/v1, protocol 1).
(function () {
    'use strict';
    const trustedServer = '62526c3bf747439c99327ddec5fed4a8';
    const messages = {
        AUTH_REQUIRED: '请登录 Emby 后使用一起看。', AUTH_INVALID: '登录已失效，请重新登录。',
        TICKET_INVALID: '连接凭证已失效，正在重新连接。', SERVER_NOT_ALLOWED: '此服务器未开放一起看。',
        FORBIDDEN: '没有执行此操作的权限。', ITEM_FORBIDDEN: '你无权观看房间当前的影片。',
        KICKED: '你已被移出这个房间。', NOT_OWNER: '只有房主能这样做。',
        NOT_FOUND: '房间不存在，或你已不在房间里。', ROOM_NOT_FOUND: '房间码无效，请检查后重试。',
        ROOM_ENDED: '房间已结束。', ROOM_FULL: '房间人数已满。', ALREADY_IN_ROOM: '你已在另一个房间里。',
        IDEMPOTENCY_CONFLICT: '请求已变更，请重试。', STALE_REVISION: '其他成员刚刚操作，已同步到最新进度。',
        MEMBER_ITEM_FORBIDDEN: '有成员无权观看该影片，未切换。', ROOM_CHANGED: '房间正在切换影片，请稍后重试。',
        INITIATOR_LEFT: '发起切换的成员已离开，切换取消。', CHANGE_IN_PROGRESS: '正在切换影片，请稍候。',
        ITEM_TYPE_UNSUPPORTED: '只能一起看电影或剧集的单集。', MEDIA_SOURCE_INVALID: '所选版本不属于这部影片。',
        UNSUPPORTED_TYPE: '服务器不支持此操作。', RATE_LIMITED: '操作太频繁，请稍后再试。',
        WATCH_UNAVAILABLE: '一起看暂不可用，请稍后重试。', WATCH_CAPACITY: '一起看房间已满，请稍后重试。',
        AUTH_UNAVAILABLE: '身份验证服务暂不可用，请稍后重试。', INVALID_REQUEST: '请求格式无效。',
        DISCONNECTED: '与一起看服务的连接已断开。', TIMEOUT: '一起看服务没有响应。'
    };
    function message(code) { return messages[code] || '一起看请求失败，请稍后重试。'; }
    function failure(code, extra = {}) { return Object.assign(new Error(message(code)), {code}, extra); }
    function uuid(crypto = window.crypto) {
        // Emby is served over HTTP, where randomUUID may be unavailable.
        if (crypto.randomUUID) return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
    }
    const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    // Self-reported build details the service records with each new room;
    // never a device identifier or a credential.
    function clientHeaders(platform, version) {
        const clean = (value, limit) => String(value || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, limit);
        const values = {'X-Tigerest-Client-Name': 'Tigerest Theater', 'X-Tigerest-Client-Version': clean(version, 40),
            'X-Tigerest-Client-Platform': clean(platform, 32)};
        return Object.fromEntries(Object.entries(values).filter(([, value]) => value));
    }

    // Offset between the local monotonic clock and the server's monotonic
    // timeline, from the lowest round trip among the last eight pings.
    class WatchClock {
        constructor() { this.samples = []; this.lastRtt = null; }
        add(t0, t3, serverReceive, serverSend) {
            if (![t0, t3, serverReceive, serverSend].every(Number.isFinite) || t3 < t0) return false;
            const rtt = Math.max(0, (t3 - t0) - Math.max(0, serverSend - serverReceive));
            const offset = ((serverReceive - t0) + (serverSend - t3)) / 2;
            this.samples.push({rtt, offset});
            if (this.samples.length > 8) this.samples.shift();
            this.lastRtt = rtt;
            return true;
        }
        get ready() { return this.samples.length > 0; }
        best() { return this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)); }
        get offset() { return this.ready ? this.best().offset : 0; }
        get rttMs() { return this.ready ? Math.min(60000, Math.max(0, Math.round(this.lastRtt))) : 0; }
        toServer(local) { return local + this.offset; }
        toLocal(server) { return server - this.offset; }
        reset() { this.samples = []; this.lastRtt = null; }
    }

    class WatchClient {
        constructor({fetch: request = window.fetch.bind(window), platform, appVersion} = {}) {
            this.fetch = request;
            this.identity = clientHeaders(platform, appVersion);
            this.context = null;
        }
        static session(api) {
            if (!api) return null;
            return {serverId: api.serverId?.(), userId: api.getCurrentUserId?.(),
                token: api.accessToken?.(), address: api.serverAddress?.()};
        }
        static supported(session) {
            const normalize = value => String(value || '').replace(/-/g, '').toLowerCase();
            const expected = WatchClient.trustedServerId === undefined ? trustedServer : WatchClient.trustedServerId;
            if (!session?.token || !session.userId || !expected || normalize(session.serverId) !== normalize(expected)) return false;
            try {
                const url = new URL(session.address);
                return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
                    (WatchClient.trustedServerId !== undefined || ['192.168.5.150', 'nas.tigerest.top'].includes(url.hostname.toLowerCase()));
            } catch (_) { return false; }
        }
        static setTrustedServer(id) { WatchClient.trustedServerId = id; }
        // Same host rule as the comment service: the LAN Emby address uses
        // the LAN service, every other trusted address the public host.
        setSession(session) {
            const next = WatchClient.supported(session) ? {...session} : null;
            const key = next ? JSON.stringify(next) : '';
            if (key !== this.key) {
                this.key = key;
                this.context = next;
                const host = next ? (WatchClient.hostOverride || (new URL(next.address).hostname === '192.168.5.150'
                    ? '192.168.5.150:18443' : 'nas.tigerest.top:18443')) : null;
                this.base = host ? 'http://' + host + '/watch/v1' : null;
                this.socketUrl = host ? 'ws://' + host + '/watch/v1/socket' : null;
            }
            return Boolean(this.context);
        }
        async request(path, {method = 'GET', body, auth = true, identify = false, signal} = {}) {
            if (!this.base || (auth && !this.context)) throw failure('AUTH_REQUIRED');
            const headers = identify ? {...this.identity} : {};
            if (auth) Object.assign(headers, {'X-Emby-Token': this.context.token,
                'X-Emby-Server-Id': this.context.serverId, 'X-Emby-User-Id': this.context.userId});
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            const controller = new AbortController();
            const cancel = () => controller.abort();
            signal?.addEventListener('abort', cancel, {once: true});
            if (signal?.aborted) cancel();
            const timeout = setTimeout(cancel, 15000);
            let response;
            try {
                response = await this.fetch(this.base + path, {method, headers,
                    body: body === undefined ? undefined : JSON.stringify(body),
                    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal});
            } catch (error) {
                if (signal?.aborted) throw error;
                throw failure(controller.signal.aborted ? 'TIMEOUT' : 'WATCH_UNAVAILABLE', {network: true});
            } finally {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', cancel);
            }
            let payload = {};
            try { payload = await response.json(); } catch (_) { if (response.ok) throw failure('WATCH_UNAVAILABLE'); }
            if (!response.ok) {
                const code = String(payload?.error?.code || (response.status === 429 ? 'RATE_LIMITED' : 'WATCH_UNAVAILABLE'));
                const retryAfter = response.status === 429
                    ? Math.min(3600, Math.max(1, Number(response.headers.get('Retry-After')) || 3)) : 0;
                throw failure(code, {status: response.status, retryAfter,
                    activeRoom: payload?.error?.activeRoom || null});
            }
            return payload.data;
        }
        health() { return this.request('/health', {auth: false}); }
        me() { return this.request('/me'); }
        createRoom({itemId, mediaSourceId, positionMs, clientRequestId, clientId, leaveCurrent = false}) {
            return this.request('/rooms', {method: 'POST', identify: true, body: {itemId: String(itemId), mediaSourceId: String(mediaSourceId),
                positionMs: Math.max(0, Math.round(Number(positionMs) || 0)), clientRequestId, clientId, leaveCurrent: leaveCurrent === true}});
        }
        joinRoom({code, clientId, leaveCurrent = false}) {
            return this.request('/rooms/join', {method: 'POST', body: {code: String(code).trim(), clientId, leaveCurrent: leaveCurrent === true}});
        }
        ticket(roomId, clientId) {
            return this.request('/rooms/' + encodeURIComponent(roomId) + '/tickets', {method: 'POST', body: {clientId}});
        }
        leave(roomId) { return this.request('/rooms/' + encodeURIComponent(roomId) + '/leave', {method: 'POST', body: {}}); }
        room(roomId) { return this.request('/rooms/' + encodeURIComponent(roomId)); }
    }

    // One room membership over the realtime socket: hello, heartbeat, clock,
    // commands and reconnection with fresh tickets.
    const noReconnect = new Set([4400, 4409, 4410]);
    class WatchConnection {
        constructor({client, clientId, platform, appVersion, WebSocket: Socket = window.WebSocket,
            now = () => performance.now(),
            // Browsers reject window timer functions called on another object.
            timers = {setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t),
                setInterval: (f, ms) => setInterval(f, ms), clearInterval: t => clearInterval(t)},
            onEvent = () => {}, log = () => {}}) {
            Object.assign(this, {client, clientId, platform, appVersion, Socket, now, timers, onEvent, log});
            this.clock = new WatchClock();
            this.pending = new Map();
            this.room = null;
            this.memberId = null;
            this.socket = null;
            this.connected = false;
            this.ended = false;
            this.pingId = 0;
            this.pings = new Map();
            this.attempt = 0;
            this.statusQueue = null;
            this.lastStatusAt = -Infinity;
        }
        get roomId() { return this.room?.roomId || null; }
        get revision() { return this.room?.playback?.revision || 0; }
        start(room, ticket) {
            this.room = room;
            this.open(ticket);
        }
        open(ticket) {
            this.closeSocket();
            if (this.ended) return;
            let socket;
            try { socket = new this.Socket(this.client.socketUrl); }
            catch (_) { this.scheduleReconnect(); return; }
            this.socket = socket;
            socket.onopen = () => {
                if (this.socket !== socket) return;
                socket.send(JSON.stringify({type: 'hello', protocol: 1, ticket, clientId: this.clientId,
                    platform: this.platform, appVersion: this.appVersion, capabilities: ['sync']}));
            };
            socket.onmessage = event => {
                if (this.socket !== socket || typeof event.data !== 'string') return;
                let data;
                try { data = JSON.parse(event.data); } catch (_) { return; }
                if (data && typeof data.type === 'string') this.receive(data);
            };
            socket.onclose = event => { if (this.socket === socket) this.closed(event.code, event.reason); };
            socket.onerror = () => {};
        }
        closeSocket() {
            const socket = this.socket;
            this.socket = null;
            this.connected = false;
            this.timers.clearInterval(this.heartbeat);
            for (const timer of this.burst || []) this.timers.clearTimeout(timer);
            this.burst = [];
            this.pings.clear();
            for (const request of this.pending.values()) {
                this.timers.clearTimeout(request.timer);
                request.reject(failure('DISCONNECTED'));
            }
            this.pending.clear();
            if (socket) {
                socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
                try { socket.close(1000); } catch (_) {}
            }
        }
        send(data) {
            if (!this.socket || this.socket.readyState !== 1) return false;
            this.socket.send(JSON.stringify(data));
            return true;
        }
        ping() {
            const id = this.pingId++, t0 = this.now();
            if (this.pings.size > 16) this.pings.clear();
            this.pings.set(id, t0);
            this.send({type: 'ping', id, t0: Math.max(0, t0)});
        }
        receive(data) {
            switch (data.type) {
            case 'welcome':
                this.connected = true;
                this.attempt = 0;
                this.memberId = data.memberId;
                this.room = data.room;
                this.features = data.features || [];
                this.clock.reset();
                this.lastStatusKey = null;
                // A short burst fills the clock samples, then the 5 s heartbeat
                // keeps the connection alive (also while paused or hidden).
                this.burst = [0, 300, 600, 900].map(delay => this.timers.setTimeout(() => this.ping(), delay));
                this.heartbeat = this.timers.setInterval(() => this.ping(), Math.max(1, Number(data.heartbeatSeconds) || 5) * 1000);
                this.onEvent('welcome', {room: this.room, memberId: this.memberId});
                break;
            case 'pong': {
                const t0 = this.pings.get(data.id);
                if (t0 === undefined) return;
                this.pings.delete(data.id);
                const first = !this.clock.ready;
                if (this.clock.add(t0, this.now(), data.serverReceive, data.serverSend) && first) this.onEvent('clock', {});
                this.flushStatus();
                break;
            }
            case 'state':
                if (!this.room || !(data.revision > this.revision)) return;
                this.room = {...this.room, media: data.media, playback: {...data.playback, revision: data.revision}};
                this.onEvent('state', {room: this.room});
                break;
            case 'members':
                if (!this.room) return;
                this.room = {...this.room, members: data.members, ownerMemberId: data.ownerMemberId};
                this.onEvent('members', {room: this.room});
                break;
            case 'waiting': {
                const playback = this.room?.playback;
                // A late waiting update must never overwrite a newer state.
                if (!playback || data.revision !== playback.revision || playback.state !== 'waiting') return;
                this.room = {...this.room, playback: {...playback, waiting: {...playback.waiting,
                    memberIds: data.memberIds, deadline: data.deadline}}};
                this.onEvent('waiting', {room: this.room});
                break;
            }
            case 'itemChange':
                if (!this.room) return;
                this.room = {...this.room, pendingChange: data.phase === 'pending' ? {changeId: data.changeId, memberId: data.memberId} : null};
                this.timers.clearTimeout(this.changeTimer);
                if (data.phase === 'pending') this.changeTimer = this.timers.setTimeout(() => this.refresh(), 10000);
                this.onEvent('itemChange', {room: this.room, change: data});
                break;
            case 'ack': {
                const request = this.pending.get(data.requestId);
                if (!request) return;
                this.pending.delete(data.requestId);
                this.timers.clearTimeout(request.timer);
                request.resolve({revision: data.revision});
                break;
            }
            case 'error': {
                const error = failure(String(data.code || 'WATCH_UNAVAILABLE'), {room: data.room || null,
                    memberIds: data.memberIds || null, retryAfterMs: data.retryAfterMs || 0});
                if (data.room) this.adopt(data.room);
                if (data.code === 'CHANGE_IN_PROGRESS') {
                    this.timers.clearTimeout(this.changeTimer);
                    this.changeTimer = this.timers.setTimeout(() => this.refresh(), 10000);
                }
                const request = this.pending.get(data.requestId);
                if (!request) { this.log('watch error ' + error.code); return; }
                this.pending.delete(data.requestId);
                this.timers.clearTimeout(request.timer);
                request.reject(error);
                break;
            }
            case 'closed':
                this.closedReason = data.reason;
                break;
            }
        }
        // Snapshots from errors and REST reads replace older state only.
        adopt(room) {
            if (!room?.playback) return;
            if (this.room && room.playback.revision < this.revision) return;
            const changed = room.playback.revision !== this.revision;
            this.room = {...this.room, ...room};
            this.onEvent(changed ? 'state' : 'members', {room: this.room});
        }
        async refresh() {
            const roomId = this.roomId;
            if (!roomId || this.ended) return;
            try {
                const data = await this.client.room(roomId);
                if (roomId === this.roomId && data?.room) this.adopt(data.room);
            } catch (error) {
                if (['ROOM_ENDED', 'NOT_FOUND'].includes(error.code)) this.finish('ended');
            }
        }
        command(type, fields = {}) {
            if (!this.connected) return Promise.reject(failure('DISCONNECTED'));
            const requestId = uuid();
            const message = {type, requestId, ...fields};
            if (['pause', 'play', 'seek', 'changeItem'].includes(type)) message.baseRevision = this.revision;
            return new Promise((resolve, reject) => {
                const timer = this.timers.setTimeout(() => {
                    this.pending.delete(requestId);
                    reject(failure('TIMEOUT'));
                    // Commands have no server-side dedup: re-read, never resend.
                    this.refresh();
                }, 10000);
                this.pending.set(requestId, {resolve, reject, timer});
                if (!this.send(message)) {
                    this.pending.delete(requestId);
                    this.timers.clearTimeout(timer);
                    reject(failure('DISCONNECTED'));
                }
            });
        }
        // leave and close finish with `closed` and a socket close, not an ack.
        control(type, fields = {}) {
            return this.send({type, requestId: uuid(), ...fields});
        }
        // Sent at once when the state or revision changes, every 2 s while
        // playing, and never more than about 4 per second.
        status({state, positionMs, sampledAtLocal}) {
            const key = state + ':' + this.revision;
            if (key === this.lastStatusKey && this.now() - this.lastStatusAt < (state === 'playing' ? 2000 : 10000)) return;
            this.statusQueue = {state, positionMs, sampledAtLocal};
            this.flushStatus();
        }
        flushStatus() {
            const next = this.statusQueue;
            if (!next || !this.connected || !this.clock.ready || !(this.revision > 0)) return;
            const wait = this.lastStatusAt + 260 - this.now();
            if (wait > 0) {
                if (!this.statusTimer) this.statusTimer = this.timers.setTimeout(() => { this.statusTimer = null; this.flushStatus(); }, wait);
                return;
            }
            this.statusQueue = null;
            this.lastStatusAt = this.now();
            this.lastStatusKey = next.state + ':' + this.revision;
            const sampledAt = Math.max(0, this.clock.toServer(next.sampledAtLocal ?? this.now()));
            this.send({type: 'status', revision: this.revision, state: next.state,
                positionMs: Math.max(0, Number(next.positionMs) || 0), rttMs: this.clock.rttMs, sampledAt});
        }
        closed(code, reason) {
            const serverReason = this.closedReason || reason || '';
            this.closedReason = null;
            this.closeSocket();
            if (this.ended) return;
            this.log('watch socket closed ' + code + ' ' + serverReason);
            if (code === 4409) return this.finish('replaced');
            if (code === 4410) return this.finish('kicked');
            if (noReconnect.has(code)) return this.finish('protocol');
            if (code === 1000 && ['left', 'room_closed', 'room_expired'].includes(serverReason)) return this.finish(serverReason);
            this.onEvent('connection', {connected: false});
            this.scheduleReconnect(code === 4429 ? 30000 : undefined);
        }
        scheduleReconnect(delay) {
            if (this.ended || this.reconnectTimer) return;
            const wait = delay ?? Math.min(15000, 1000 * 2 ** Math.min(4, this.attempt));
            this.attempt++;
            this.reconnectTimer = this.timers.setTimeout(() => { this.reconnectTimer = null; this.reconnect(); }, wait);
        }
        // Network recovery or a page becoming visible again: retry at once.
        wake() {
            if (this.ended || this.connected || this.socket) return;
            this.timers.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
            this.reconnect();
        }
        async reconnect() {
            const roomId = this.roomId;
            if (!roomId || this.ended || this.socket) return;
            try {
                const data = await this.client.ticket(roomId, this.clientId);
                if (this.ended || roomId !== this.roomId) return;
                this.open(data.ticket);
            } catch (error) {
                if (this.ended) return;
                if (['ROOM_ENDED', 'NOT_FOUND'].includes(error.code)) return this.finish('ended');
                if (error.status === 401 || error.status === 403) return this.finish('auth');
                this.scheduleReconnect(error.retryAfter ? error.retryAfter * 1000 : undefined);
            }
        }
        finish(reason) {
            if (this.ended) return;
            this.ended = true;
            this.timers.clearTimeout(this.reconnectTimer);
            this.timers.clearTimeout(this.changeTimer);
            this.timers.clearTimeout(this.statusTimer);
            this.closeSocket();
            this.onEvent('ended', {reason});
        }
        // REST leave is idempotent and also works while reconnecting.
        leave() {
            const roomId = this.roomId;
            this.finish('left');
            return roomId ? this.client.leave(roomId) : Promise.resolve();
        }
        dispose() { this.finish('disposed'); }
    }

    window.TigerestWatchClient = WatchClient;
    window.TigerestWatchConnection = WatchConnection;
    window.TigerestWatchClock = WatchClock;
    window.TigerestWatchMessages = {message, uuid: () => uuid(), uuidPattern};
})();
