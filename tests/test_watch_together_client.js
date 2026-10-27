const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load() {
    const context = {URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
        crypto: require('node:crypto').webcrypto, console, performance};
    context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../native/watchTogetherClient.js'), 'utf8'), context);
    return context;
}
const lan = {serverId: '62526c3bf747439c99327ddec5fed4a8', userId: 'user1', token: 'test-only-token', address: 'http://192.168.5.150:8095'};
const remote = {...lan, address: 'https://nas.tigerest.top:18445'};
const plain = value => JSON.parse(JSON.stringify(value));
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json', ...headers}});

test('REST uses the comment service host rule, exact bodies and Emby identity headers', async () => {
    const {TigerestWatchClient: Client} = load(), calls = [];
    const client = new Client({fetch: async (url, options) => { calls.push({url, options}); return json(200, {data: {ok: true}}); },
        platform: 'Windows', appVersion: ' 2.9.5\u0007 '});
    assert.equal(client.setSession(lan), true);
    assert.equal(client.socketUrl, 'ws://192.168.5.150:18443/watch/v1/socket');
    await client.health();
    assert.equal(calls[0].url, 'http://192.168.5.150:18443/watch/v1/health');
    assert.equal(calls[0].options.headers['X-Emby-Token'], undefined, 'health is anonymous');
    client.setSession(remote);
    assert.equal(client.socketUrl, 'wss://nas.tigerest.top:18446/watch/v1/socket');
    await client.createRoom({itemId: 12, mediaSourceId: 's', positionMs: 1500.7, clientRequestId: 'r', clientId: 'c'});
    assert.equal(calls[1].url, 'https://nas.tigerest.top:18446/watch/v1/rooms');
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
    assert.equal(calls[1].options.headers['X-Emby-Server-Id'], lan.serverId);
    assert.equal(calls[1].options.headers['X-Emby-User-Id'], 'user1');
    assert.deepEqual(JSON.parse(calls[1].options.body), {itemId: '12', mediaSourceId: 's', positionMs: 1501, clientRequestId: 'r', clientId: 'c', leaveCurrent: false});
    assert.equal(calls[1].options.headers['X-Tigerest-Client-Name'], 'Tigerest Theater');
    assert.equal(calls[1].options.headers['X-Tigerest-Client-Version'], '2.9.5', 'control characters and padding are dropped');
    assert.equal(calls[1].options.headers['X-Tigerest-Client-Platform'], 'Windows');
    await client.joinRoom({code: ' 7kq2mz ', clientId: 'c', leaveCurrent: true});
    assert.deepEqual(JSON.parse(calls[2].options.body), {code: '7kq2mz', clientId: 'c', leaveCurrent: true});
    await client.ticket('room-1', 'c');
    assert.deepEqual(JSON.parse(calls[3].options.body), {clientId: 'c'});
    await client.leave('room-1');
    assert.equal(calls[4].url, 'https://nas.tigerest.top:18446/watch/v1/rooms/room-1/leave');
    assert.equal(client.setSession({...lan, serverId: 'other'}), false);
    await assert.rejects(client.me(), error => error.code === 'AUTH_REQUIRED');
    assert.equal(calls.length, 5, 'other servers never receive tokens');
    for (const call of [calls[0], ...calls.slice(2)])
        assert.equal(Object.keys(call.options.headers).some(name => name.startsWith('X-Tigerest-Client-')), false, 'only a new room reports the client');
});

test('REST errors carry codes, Chinese text, activeRoom and Retry-After', async () => {
    const {TigerestWatchClient: Client} = load();
    const responses = [
        json(409, {error: {code: 'ALREADY_IN_ROOM', message: 'ALREADY_IN_ROOM', activeRoom: {roomId: 'r', code: 'ABC234', title: '旧影片'}}}),
        json(429, {error: {code: 'RATE_LIMITED', message: 'RATE_LIMITED'}}, {'Retry-After': '7'})];
    const client = new Client({fetch: async () => responses.shift()});
    client.setSession(lan);
    await assert.rejects(client.joinRoom({code: 'ABC234', clientId: 'c'}), error =>
        error.code === 'ALREADY_IN_ROOM' && error.activeRoom.code === 'ABC234' && /另一个房间/.test(error.message));
    await assert.rejects(client.me(), error => error.code === 'RATE_LIMITED' && error.retryAfter === 7);
});

class FakeSocket {
    static all = [];
    constructor(url) { this.url = url; this.sent = []; this.readyState = 0; FakeSocket.all.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    deliver(data) { this.onmessage?.({data: JSON.stringify(data)}); }
    drop(code, reason = '') { this.readyState = 3; this.onclose?.({code, reason}); }
}
function timers() {
    let now = 0; const queue = [];
    const add = (fn, ms, repeat) => { const t = {at: now + ms, fn, ms, repeat}; queue.push(t); return t; };
    const api = {setTimeout: (fn, ms) => add(fn, ms, false), clearTimeout: t => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); },
        setInterval: (fn, ms) => add(fn, ms, true), clearInterval: t => api.clearTimeout(t)};
    api.now = () => now;
    api.run = ms => {
        const end = now + ms;
        for (;;) {
            queue.sort((a, b) => a.at - b.at);
            const t = queue[0];
            if (!t || t.at > end) break;
            now = t.at;
            if (t.repeat) t.at += t.ms; else queue.shift();
            t.fn();
        }
        now = end;
    };
    return api;
}
const snapshot = (revision = 1, extra = {}) => ({roomId: 'room-1', code: '7KQ2MZ', capacity: 4, ownerMemberId: 'm1', pendingChange: null,
    media: {itemId: 'i1', mediaSourceId: 's1', runTimeMs: 1440000},
    playback: {revision, state: 'paused', positionMs: 0, serverTime: 1000, rate: 1, waiting: null}, members: [], ...extra});

function connection(clientOverrides = {}) {
    const context = load(), clock = timers(), events = [];
    FakeSocket.all = [];
    const client = new context.TigerestWatchClient({fetch: async () => json(200, {data: {ticket: 'ticket-2'}})});
    client.setSession(lan);
    Object.assign(client, clientOverrides);
    const conn = new context.TigerestWatchConnection({client, clientId: 'client-1', platform: 'Windows', appVersion: '2.8.0',
        WebSocket: FakeSocket, now: clock.now, timers: clock, onEvent: (type, data) => events.push({type, data})});
    return {conn, clock, events, client};
}

test('hello, welcome, clock burst and heartbeat follow the contract', () => {
    const {conn, clock, events} = connection();
    conn.start(snapshot(), 'ticket-1');
    const socket = FakeSocket.all[0];
    assert.equal(socket.url, 'ws://192.168.5.150:18443/watch/v1/socket');
    socket.open();
    assert.deepEqual(socket.sent[0], {type: 'hello', protocol: 1, ticket: 'ticket-1', clientId: 'client-1',
        platform: 'Windows', appVersion: '2.8.0', capabilities: ['sync']});
    socket.deliver({type: 'welcome', memberId: 'm1', serverTime: 5000, room: snapshot(3), features: ['sync'], heartbeatSeconds: 5});
    assert.equal(conn.revision, 3);
    clock.run(1000);
    const pings = socket.sent.filter(m => m.type === 'ping');
    assert.equal(pings.length, 4);
    assert.ok(pings.every((m, i) => m.id === i && Number.isFinite(m.t0) && m.t0 >= 0 && Object.keys(m).length === 3));
    // The server timeline is 100000 ms ahead; 20 ms each way.
    for (const ping of pings) socket.deliver({type: 'pong', id: ping.id, t0: ping.t0, serverReceive: ping.t0 + 100020, serverSend: ping.t0 + 100021});
    assert.ok(Math.abs(conn.clock.toServer(clock.now()) - (clock.now() + 100000)) < 1000);
    clock.run(20000);
    assert.ok(socket.sent.filter(m => m.type === 'ping').length >= 8, 'heartbeat keeps running every 5 s');
    assert.equal(events[0].type, 'welcome');
});

test('the clock uses the fastest of the last eight samples', () => {
    const {TigerestWatchClock: Clock} = load();
    const clock = new Clock();
    clock.add(0, 200, 1100, 1100);    // slow sample, asymmetric
    clock.add(1000, 1010, 2005, 2005); // fast sample: offset 1000
    assert.equal(clock.offset, 1000);
    assert.equal(clock.rttMs, 10);
    for (let i = 0; i < 8; i++) clock.add(3000 + i, 3100 + i, 4100 + i, 4100 + i);
    assert.equal(clock.samples.length, 8, 'old samples expire');
    assert.equal(clock.offset, 1050);
});

test('commands carry requestId and baseRevision and resolve on ack; errors adopt the attached room', async () => {
    const {conn, events} = connection();
    conn.start(snapshot(), 'ticket-1');
    const socket = FakeSocket.all[0];
    socket.open();
    socket.deliver({type: 'welcome', memberId: 'm1', serverTime: 5000, room: snapshot(12), heartbeatSeconds: 5});
    const pause = conn.command('pause', {positionMs: 734500});
    const sent = socket.sent.at(-1);
    assert.deepEqual(Object.keys(sent).sort(), ['baseRevision', 'positionMs', 'requestId', 'type']);
    assert.equal(sent.baseRevision, 12);
    socket.deliver({type: 'state', revision: 13, media: snapshot().media, playback: {revision: 13, state: 'paused', positionMs: 734500, serverTime: 6000, rate: 1, waiting: null}});
    socket.deliver({type: 'ack', requestId: sent.requestId, revision: 13});
    assert.deepEqual(plain(await pause), {revision: 13});
    const play = conn.command('play');
    const playMessage = socket.sent.at(-1);
    assert.equal(playMessage.positionMs, undefined, 'play has no position');
    socket.deliver({type: 'error', requestId: playMessage.requestId, code: 'STALE_REVISION', message: 'STALE_REVISION', room: snapshot(14)});
    await assert.rejects(play, error => error.code === 'STALE_REVISION');
    assert.equal(conn.revision, 14);
    assert.ok(events.some(e => e.type === 'state' && e.data.room.playback.revision === 14));
});

test('stale state and late waiting messages never overwrite newer state', () => {
    const {conn} = connection();
    conn.start(snapshot(), 't');
    const socket = FakeSocket.all[0];
    socket.open();
    socket.deliver({type: 'welcome', memberId: 'm1', room: snapshot(5, {playback: {revision: 5, state: 'waiting', positionMs: 1, serverTime: 1, rate: 1, waiting: {memberIds: ['a', 'b'], deadline: 9}}}), heartbeatSeconds: 5});
    socket.deliver({type: 'waiting', revision: 5, memberIds: ['b'], deadline: 9});
    assert.deepEqual([...conn.room.playback.waiting.memberIds], ['b']);
    socket.deliver({type: 'state', revision: 6, media: snapshot().media, playback: {revision: 6, state: 'playing', positionMs: 1, serverTime: 2, rate: 1, waiting: null}});
    socket.deliver({type: 'waiting', revision: 5, memberIds: [], deadline: 9});
    socket.deliver({type: 'state', revision: 4, media: snapshot().media, playback: {revision: 4, state: 'paused', positionMs: 1, serverTime: 2, rate: 1, waiting: null}});
    assert.equal(conn.room.playback.state, 'playing');
    assert.equal(conn.revision, 6);
});

test('status reports wait for the clock, include every field, and are throttled', () => {
    const {conn, clock} = connection();
    conn.start(snapshot(), 't');
    const socket = FakeSocket.all[0];
    socket.open();
    socket.deliver({type: 'welcome', memberId: 'm1', room: snapshot(3), heartbeatSeconds: 5});
    conn.status({state: 'loading', positionMs: 0, sampledAtLocal: clock.now()});
    assert.equal(socket.sent.filter(m => m.type === 'status').length, 0, 'no status before the first pong');
    clock.run(10);
    const ping = socket.sent.find(m => m.type === 'ping');
    socket.deliver({type: 'pong', id: ping.id, t0: ping.t0, serverReceive: ping.t0 + 50000, serverSend: ping.t0 + 50000});
    const first = socket.sent.filter(m => m.type === 'status');
    assert.equal(first.length, 1);
    assert.deepEqual(Object.keys(first[0]).sort(), ['positionMs', 'revision', 'rttMs', 'sampledAt', 'state', 'type']);
    assert.equal(first[0].revision, 3);
    for (let i = 0; i < 10; i++) conn.status({state: i % 2 ? 'ready' : 'buffering', positionMs: i, sampledAtLocal: clock.now()});
    clock.run(1000);
    const sent = socket.sent.filter(m => m.type === 'status');
    assert.ok(sent.length <= 6, 'at most about 4 per second: ' + sent.length);
    conn.status({state: 'playing', positionMs: 1, sampledAtLocal: clock.now()});
    clock.run(300);
    const count = socket.sent.filter(m => m.type === 'status').length;
    conn.status({state: 'playing', positionMs: 2, sampledAtLocal: clock.now()});
    assert.equal(socket.sent.filter(m => m.type === 'status').length, count, 'unchanged playing waits for the 2 s period');
});

test('a dropped socket reconnects with a new ticket; replaced and kicked end without reconnecting', async () => {
    const {conn, clock, events} = connection();
    conn.start(snapshot(), 'ticket-1');
    FakeSocket.all[0].open();
    FakeSocket.all[0].deliver({type: 'welcome', memberId: 'm1', room: snapshot(3), heartbeatSeconds: 5});
    FakeSocket.all[0].drop(1006);
    clock.run(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(FakeSocket.all.length, 2);
    FakeSocket.all[1].open();
    assert.equal(FakeSocket.all[1].sent[0].ticket, 'ticket-2');
    FakeSocket.all[1].deliver({type: 'closed', reason: 'replaced'});
    FakeSocket.all[1].drop(4409);
    clock.run(60000);
    assert.equal(FakeSocket.all.length, 2, 'no automatic reconnect after 4409');
    assert.deepEqual(plain(events.at(-1)), {type: 'ended', data: {reason: 'replaced'}});
});

test('an ended room found while reconnecting finishes the membership', async () => {
    const {conn, clock, events, client} = connection();
    client.fetch = async () => json(404, {error: {code: 'ROOM_ENDED', message: 'ROOM_ENDED'}});
    conn.start(snapshot(), 'ticket-1');
    FakeSocket.all[0].open();
    FakeSocket.all[0].deliver({type: 'welcome', memberId: 'm1', room: snapshot(3), heartbeatSeconds: 5});
    FakeSocket.all[0].drop(1012, 'room_closed');
    clock.run(1000);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(plain(events.at(-1)), {type: 'ended', data: {reason: 'ended'}});
});

test('an item change in progress re-reads the snapshot after 10 s without an outcome', async () => {
    let reads = 0;
    const {conn, clock} = connection();
    conn.client.room = async () => { reads++; return {room: snapshot(9)}; };
    conn.start(snapshot(), 't');
    FakeSocket.all[0].open();
    FakeSocket.all[0].deliver({type: 'welcome', memberId: 'm1', room: snapshot(3), heartbeatSeconds: 5});
    FakeSocket.all[0].deliver({type: 'itemChange', phase: 'pending', changeId: 'c1', memberId: 'm2'});
    assert.deepEqual({...conn.room.pendingChange}, {changeId: 'c1', memberId: 'm2'});
    clock.run(10000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.equal(conn.revision, 9);
});
