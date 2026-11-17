const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load() {
    const context = {console};
    context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../native/watchTogetherSync.js'), 'utf8'), context);
    return context.TigerestWatchSync;
}
const Sync = load();

// Virtual time shared by the room, the network and every simulated client.
class World {
    constructor() { this.time = 0; this.queue = []; this.seq = 0; }
    at(delay, fn) { const timer = {at: this.time + Math.max(0, delay), fn, seq: this.seq++}; this.queue.push(timer); return timer; }
    cancel(timer) { const i = this.queue.indexOf(timer); if (i >= 0) this.queue.splice(i, 1); }
    run(ms) {
        const end = this.time + ms;
        for (;;) {
            this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
            const next = this.queue[0];
            if (!next || next.at > end) break;
            this.queue.shift();
            this.time = next.at;
            next.fn();
        }
        this.time = end;
    }
}

// Deterministic pseudo-random numbers for noisy players.
function random(seed) {
    return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// mpv-like player: commands take effect after a latency, position updates
// arrive every 40 ms while playing. User actions go through the same paths.
// noiseMs adds report jitter like the desktop client's (frame timing and
// delivery through the web channel); the true position stays exact.
class Player {
    // restartMs models mpv more closely: a seek reports its target after seekMs,
    // but the frame is only there after restartMs of decoding (a number, or a
    // function of the seek's index and its target). restartSignal says whether
    // the player tells the page about that, as the desktop client does.
    // keyframes: the file has a keyframe every gopMs and the player can seek
    // to one (its frame is there after keyMs) and say where it landed.
    constructor(world, {seekMs = 250, playMs = 25, pauseMs = 15, startRate = 1, noiseMs = 0, reportOnPlay = false, seed = 1,
        restartMs = null, restartSignal = false, keyframes = false, gopMs = 10000, keyMs = 250} = {}) {
        Object.assign(this, {world, seekMs, playMs, pauseMs, noiseMs, reportOnPlay, restartMs, restartSignal, keyframes, gopMs, keyMs});
        this.seeks = 0; this.seekToken = 0;
        this.paused = false; this.pos = 0; this.rate = startRate; this.seekingUntil = 0; this.log = [];
        this.lastAdvance = 0; this.alive = true; this.random = random(seed);
        const tick = () => {
            if (!this.alive) return;
            const now = world.time, dt = now - this.lastAdvance;
            this.lastAdvance = now;
            if (!this.paused && now >= this.seekingUntil && !this.stalled) { this.pos += dt * this.rate; this.report(); }
            world.at(40, tick);
        };
        world.at(40, tick);
    }
    report() { this.sync?.onPosition(this.pos + (this.noiseMs ? (this.random() * 2 - 1) * this.noiseMs : 0)); }
    bind(sync) { this.sync = sync; }
    pause() { this.log.push('pause'); this.world.at(this.pauseMs, () => { if (!this.paused) { this.paused = true; this.sync.onPaused(); } }); }
    // reportOnPlay: mpv shows the next frame and reports it right away.
    play() {
        this.log.push('play');
        this.world.at(this.playMs, () => {
            if (!this.paused) return;
            this.paused = false; this.lastAdvance = this.world.time;
            const started = () => { if (this.paused) return; this.sync.onPlaying(); if (this.reportOnPlay) this.report(); };
            // mpv says "playing" only once the frame is there; until then the
            // client shows buffering.
            const restarting = this.restartMs !== null ? this.seekingUntil - this.world.time : 0;
            if (restarting > 0) this.world.at(restarting, started); else started();
        });
    }
    seek(ms) {
        this.log.push('seek');
        if (this.restartMs === null) {
            this.seekingUntil = this.world.time + this.seekMs;
            this.world.at(this.seekMs, () => { this.pos = ms; this.lastAdvance = this.world.time; this.sync.onPosition(ms); });
            return;
        }
        const restart = typeof this.restartMs === 'function' ? this.restartMs(this.seeks, ms) : this.restartMs;
        const token = ++this.seekToken;
        this.seeks++;
        this.seekingUntil = this.world.time + restart;
        if (this.restartSignal) this.world.at(5, () => this.sync.onSeeking?.(true));
        this.world.at(this.seekMs, () => { if (token !== this.seekToken) return; this.pos = ms; this.sync.onPosition(ms); });
        // A newer seek replaces this one; only the last reports its restart.
        this.world.at(restart, () => { if (token !== this.seekToken) return; this.lastAdvance = this.world.time; if (this.restartSignal) this.sync.onSeeking?.(false); });
    }
    // Like mpv: the first keyframe at or after ms when that lies ahead,
    // otherwise the one before it. The request is reported at once, the
    // keyframe when its frame is there.
    seekKey(ms, after) {
        this.log.push('key');
        // "Before" a position that is a keyframe's own is the keyframe before it.
        const landing = after && ms > this.pos ? Math.ceil(ms / this.gopMs) * this.gopMs
            : (Math.floor(ms / this.gopMs) - (ms % this.gopMs < 60 && ms >= this.gopMs ? 1 : 0)) * this.gopMs;
        const token = ++this.seekToken;
        this.seeks++;
        this.keys = (this.keys || []).concat(landing);
        this.seekingUntil = this.world.time + this.keyMs;
        this.world.at(5, () => this.sync.onSeeking(true));
        this.world.at(this.seekMs, () => { if (token === this.seekToken) this.sync.onPosition(ms); });
        this.world.at(this.keyMs, () => {
            if (token !== this.seekToken) return;
            this.pos = landing; this.lastAdvance = this.world.time;
            this.sync.onKeyframe(landing);
            this.sync.onSeeking(false);
        });
    }
    // A seek the viewer made in the player (timeline, keys, the web page):
    // to the keyframe before ms, or to the millisecond. No keyframe report.
    userSeek(ms, keyframe) {
        const landing = keyframe ? Math.floor(ms / this.gopMs) * this.gopMs : ms;
        const restart = keyframe ? this.keyMs : typeof this.restartMs === 'function' ? this.restartMs(this.seeks, ms) : this.restartMs ?? this.seekMs;
        const token = ++this.seekToken;
        this.seeks++;
        this.seekingUntil = this.world.time + restart;
        if (this.restartSignal) this.world.at(5, () => this.sync.onSeeking(true));
        this.world.at(Math.min(this.seekMs, restart), () => { if (token === this.seekToken) this.sync.onPosition(ms); });
        this.world.at(restart, () => {
            if (token !== this.seekToken) return;
            this.pos = landing; this.lastAdvance = this.world.time;
            this.sync.onPosition(landing);
            if (this.restartSignal) this.sync.onSeeking(false);
        });
    }
    setRate(rate) { this.log.push('rate:' + rate); this.rate = rate / 1000; }
}
// A seek to the millisecond with frame interpolation: the run from the
// keyframe before it is decoded at about real-time speed. Less than a frame
// or two past a keyframe, mpv starts at the keyframe before that one.
const decodeRun = (gopMs = 10000) => (n, ms) => 250 + 0.85 * (ms % gopMs < 60 && ms >= gopMs ? gopMs + ms % gopMs : ms % gopMs);

// The relevant part of the server: revisions, play scheduling with leadMs,
// waiting for ready members, and broadcasts with per-client latency.
class Room {
    constructor(world, {runTimeMs = 1440000} = {}) {
        this.world = world; this.clients = []; this.offset = 5e6;
        this.media = {itemId: 'item1', mediaSourceId: 'src1', runTimeMs};
        this.playback = {revision: 1, state: 'paused', positionMs: 0, serverTime: this.now(), rate: 1, waiting: null};
        this.commands = [];
    }
    now() { return this.world.time + this.offset; }
    expected() {
        const p = this.playback;
        return p.state === 'playing' ? p.positionMs + Math.max(0, this.now() - p.serverTime) * p.rate : p.positionMs;
    }
    commit(change) {
        this.playback = {...this.playback, ...change, revision: this.playback.revision + 1};
        for (const client of this.clients) this.world.at(client.latency, () => client.sync.setRoom({media: this.media, playback: {...this.playback}}));
    }
    start(type = 'play') { this.commit({state: 'playing', serverTime: this.now() + 500, waiting: null, lastAction: {type}}); }
    wait(positionMs, type = 'seek') {
        const ids = this.clients.filter(c => c.status !== 'away').map(c => c.id);
        this.ready = new Set();
        this.commit({state: 'waiting', positionMs, waiting: {memberIds: ids, deadline: this.now() + 15000, resumeTo: 'playing'}, lastAction: {type}});
    }
    command(client, type, fields) {
        return new Promise((resolve, reject) => this.world.at(client.latency, () => {
            this.commands.push({client: client.id, type, fields});
            if (fields.baseRevision !== undefined && fields.baseRevision !== this.playback.revision)
                return this.world.at(client.latency, () => reject(Object.assign(new Error('stale'), {code: 'STALE_REVISION'})));
            if (type === 'pause') this.commit({state: 'paused', positionMs: fields.positionMs, serverTime: this.now(), waiting: null, lastAction: {type}});
            else if (type === 'play') { if (this.playback.state !== 'playing') this.start(); }
            else if (type === 'seek') { if (this.playback.state === 'paused') this.commit({positionMs: fields.positionMs, lastAction: {type}}); else this.wait(fields.positionMs); }
            const revision = this.playback.revision;
            this.world.at(client.latency, () => resolve({revision}));
        }));
    }
    status(client, report) {
        client.status = report.state;
        if (this.playback.state === 'waiting' && report.state === 'ready' && report.revision === this.playback.revision) {
            this.ready.add(client.id);
            if (this.playback.waiting.memberIds.every(id => this.ready.has(id))) this.start('resume');
        }
    }
}

function client(world, room, {id = 'a', latency = 15, skewMs = 0, clockErrorMs = 0, rateCorrection = true, player: options = {}} = {}) {
    const player = new Player(world, options);
    const entry = {id, latency, status: 'loading', reports: [], logs: [], notices: []};
    // Local clocks start at different origins; the estimate carries a small error.
    const local = () => world.time + skewMs;
    const clock = {ready: true, rttMs: latency * 2,
        toServer: value => value - skewMs + room.offset + clockErrorMs,
        toLocal: value => value - room.offset - clockErrorMs + skewMs};
    const controls = {pause: () => player.pause(), play: () => player.play(), seek: ms => player.seek(ms), setRate: r => player.setRate(r)};
    if (player.keyframes) controls.seekKeyframe = (ms, after) => player.seekKey(ms, after);
    const sync = new Sync({player: controls,
        clock, now: local, timers: {setTimeout: (fn, ms) => world.at(ms, fn), clearTimeout: t => world.cancel(t)},
        command: (type, fields) => room.command(entry, type, {...fields, baseRevision: room.clientRevision?.(entry) ?? sync.room.playback.revision}),
        report: report => { entry.reports.push(report.state); world.at(latency, () => room.status(entry, {...report, revision: sync.room?.playback?.revision})); },
        rateCorrection, log: text => entry.logs.push(text), notice: (kind, data) => entry.notices.push([kind, data])});
    player.bind(sync);
    Object.assign(entry, {player, sync, local});
    room.clients.push(entry);
    // The plugin looks at deadlines twice a second: a paused player sends no
    // position reports.
    const tick = () => { if (sync.attached) sync.control(); world.at(500, tick); };
    world.at(500, tick);
    return entry;
}
// Position on the room timeline at the same instant, for comparing clients.
const drift = (entry, room) => entry.player.pos - room.expected();
// Frames lost bit by bit: a step of more than a second would be a seek.
const fallBehind = (entry, world, ms) => {
    for (let left = ms; left > 0; left -= 500) { entry.player.pos -= Math.min(500, left); world.run(45); }
};

test('a scheduled start begins on the room timeline within a few frames', () => {
    const world = new World(), room = new Room(world);
    const a = client(world, room, {latency: 20});
    a.player.paused = true;
    a.sync.setRoom({media: room.media, playback: room.playback});
    a.sync.attach('item1');
    a.player.sync.onPaused();
    a.player.sync.onPosition(0);
    world.run(2500);
    room.commit({state: 'playing', positionMs: 0, serverTime: room.now() + 800});
    world.run(5000);
    assert.ok(Math.abs(drift(a, room)) < 40, 'drift ' + drift(a, room));
    assert.deepEqual(room.commands, [], 'following the room must not send commands');
});

test('a late joiner seeks ahead, holds, and starts exactly as the room reaches that frame', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 7, state: 'playing', positionMs: 120000, serverTime: room.now()};
    world.run(30000);
    const b = client(world, room, {latency: 40, skewMs: 123456, player: {seekMs: 900}});
    b.player.pos = 120000;
    b.sync.onPlaying();
    b.sync.setRoom({media: room.media, playback: room.playback});
    b.sync.attach('item1');
    world.run(12000);
    assert.ok(Math.abs(drift(b, room)) < 50, 'drift ' + drift(b, room));
    assert.deepEqual(room.commands, []);
    assert.equal(b.sync.status(), 'playing');
});

test('small offsets are corrected by playback speed, never by seeking', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 3, state: 'playing', positionMs: 0, serverTime: room.now()};
    const a = client(world, room);
    a.sync.onPlaying();
    a.sync.setRoom({media: room.media, playback: room.playback});
    a.sync.attach('item1');
    world.run(3000);
    a.player.pos += 400;
    const seeksBefore = a.player.log.filter(x => x === 'seek').length;
    world.run(1500);
    assert.ok(a.player.rate < 1, 'ahead of the room slows down');
    world.run(20000);
    assert.ok(Math.abs(drift(a, room)) < 50, 'drift ' + drift(a, room));
    assert.equal(a.player.log.filter(x => x === 'seek').length, seeksBefore);
    assert.equal(a.player.rate, 1, 'speed returns to 1x once aligned');
    assert.ok(a.player.log.every(x => !x.startsWith('rate:') || (+x.slice(5) >= 950 && +x.slice(5) <= 1050)));
});

test('with frame interpolation the speed stays at 1x and offsets are fixed by a held seek', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 3, state: 'playing', positionMs: 0, serverTime: room.now()};
    const a = client(world, room, {rateCorrection: false});
    a.sync.onPlaying();
    a.sync.setRoom({media: room.media, playback: room.playback});
    a.sync.attach('item1');
    world.run(3000);
    a.player.pos += 600;
    world.run(8000);
    assert.ok(Math.abs(drift(a, room)) < 50, 'drift ' + drift(a, room));
    assert.ok(a.player.log.every(x => x === 'rate:1000' || !x.startsWith('rate:')));
});

test('a user pause becomes one room command and its own signals are not echoed', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 3, state: 'playing', positionMs: 0, serverTime: room.now()};
    const a = client(world, room), b = client(world, room, {id: 'b', latency: 30, skewMs: -777});
    for (const c of [a, b]) { c.sync.onPlaying(); c.sync.setRoom({media: room.media, playback: room.playback}); c.sync.attach("item1"); }
    world.run(5000);
    a.player.pause();
    world.run(3000);
    assert.deepEqual(room.commands.map(c => c.client + ':' + c.type), ['a:pause']);
    assert.equal(room.playback.state, 'paused');
    assert.ok(b.player.paused, 'the other member pauses');
    assert.ok(Math.abs(b.player.pos - room.playback.positionMs) <= 100, 'and aligns to the pause position');
    assert.ok(Math.abs(a.player.pos - b.player.pos) <= 100);
});

test('a user play starts everyone together from the paused position', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 2, state: 'paused', positionMs: 60000};
    const a = client(world, room, {latency: 10}), b = client(world, room, {id: 'b', latency: 60, skewMs: 999});
    for (const c of [a, b]) {
        c.player.paused = true; c.player.pos = 60000;
        c.sync.setRoom({media: room.media, playback: room.playback}); c.sync.attach('item1');
        c.sync.onPaused(); c.sync.onPosition(60000);
    }
    world.run(3000);
    a.player.play();
    world.run(6000);
    assert.deepEqual(room.commands.map(c => c.client + ':' + c.type), ['a:play']);
    assert.ok(Math.abs(a.player.pos - b.player.pos) < 40, 'members start together: ' + (a.player.pos - b.player.pos));
    assert.ok(Math.abs(drift(a, room)) < 40);
});

test('a user seek sends one command, then the room waits until everyone is ready', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 3, state: 'playing', positionMs: 0, serverTime: room.now()};
    const a = client(world, room), b = client(world, room, {id: 'b', latency: 35, player: {seekMs: 1200}});
    for (const c of [a, b]) { c.sync.onPlaying(); c.sync.setRoom({media: room.media, playback: room.playback}); c.sync.attach("item1"); }
    world.run(5000);
    a.player.seek(300000);
    world.run(10000);
    assert.deepEqual(room.commands.map(c => c.client + ':' + c.type), ['a:seek']);
    assert.equal(room.playback.state, 'playing');
    assert.ok(Math.abs(a.player.pos - b.player.pos) < 40, 'both resume together: ' + (a.player.pos - b.player.pos));
    assert.ok(a.player.pos > 300000 && a.player.pos < 310000);
    assert.ok(b.reports.includes('ready'));
});

test('a rejected command returns the member to the room state', async () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 3, state: 'playing', positionMs: 0, serverTime: room.now()};
    const a = client(world, room);
    room.clientRevision = () => 1;
    a.sync.onPlaying();
    a.sync.setRoom({media: room.media, playback: room.playback});
    a.sync.attach('item1');
    world.run(4000);
    let rejected = null;
    a.sync.onCommandError = (type, error) => { rejected = type + ':' + error.code; };
    a.player.pause();
    world.run(100);
    await new Promise(resolve => setImmediate(resolve));
    world.run(6000);
    assert.equal(rejected, 'pause:STALE_REVISION');
    assert.equal(a.player.paused, false, 'local pause is reverted to the playing room');
    assert.ok(Math.abs(drift(a, room)) < 60, "drift " + drift(a, room) + " " + a.player.log.join(","));
});

test('backgrounding on Android reports away instead of pausing the room', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 3, state: 'playing', positionMs: 0, serverTime: room.now()};
    const a = client(world, room);
    a.sync.onPlaying();
    a.sync.setRoom({media: room.media, playback: room.playback});
    a.sync.attach('item1');
    world.run(4000);
    a.sync.suspend(true);
    a.player.pause();
    world.run(10000);
    assert.deepEqual(room.commands, []);
    assert.equal(a.sync.status(), 'away');
    a.sync.suspend(false);
    world.run(8000);
    assert.equal(a.player.paused, false);
    assert.ok(Math.abs(drift(a, room)) < 50, 'follows again after returning: ' + drift(a, room));
});

test('a stalled player reports buffering, and a detached player reports away', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 3, state: 'playing', positionMs: 0, serverTime: room.now()};
    const a = client(world, room);
    a.sync.onPlaying();
    a.sync.setRoom({media: room.media, playback: room.playback});
    a.sync.attach('item1');
    world.run(4000);
    a.player.stalled = true;
    world.run(1200);
    assert.equal(a.sync.status(), 'buffering');
    a.player.stalled = false;
    a.sync.detach();
    assert.equal(a.sync.status(), 'away');
    assert.equal(a.reports.at(-1), 'away');
});

test('a start fired slightly early is not undone before the room time', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 2, state: 'paused', positionMs: 30000};
    const a = client(world, room, {player: {playMs: 3, reportOnPlay: true}});
    a.player.paused = true; a.player.pos = 30000;
    a.sync.setRoom({media: room.media, playback: room.playback}); a.sync.attach('item1');
    a.sync.onPaused(); a.sync.onPosition(30000);
    world.run(3000);
    const before = a.player.log.length;
    room.start();
    world.run(4000);
    const after = a.player.log.slice(before);
    assert.deepEqual(after.filter(x => x === 'play' || x === 'pause' || x === 'seek'), ['play'], 'one play and nothing undoing it: ' + after.join(','));
    assert.ok(Math.abs(drift(a, room)) < 40, 'drift ' + drift(a, room));
});

test('members paused a frame or two apart shift their start instead of seeking', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 2, state: 'waiting', positionMs: 60000, waiting: {memberIds: ['a', 'b'], deadline: 0, resumeTo: 'playing'}};
    room.ready = new Set();
    const a = client(world, room, {latency: 10}), b = client(world, room, {id: 'b', latency: 50, skewMs: 4321});
    for (const [c, pos] of [[a, 60083], [b, 59958]]) {
        c.player.paused = true; c.player.pos = pos;
        c.sync.setRoom({media: room.media, playback: room.playback}); c.sync.attach('item1');
        c.sync.onPaused(); c.sync.onPosition(pos);
    }
    // Both report ready; the room then starts by itself.
    world.run(4500);
    assert.equal(room.playback.state, 'playing');
    assert.ok([a, b].every(c => c.player.log.every(x => x !== 'seek')), 'a start shift instead of a seek');
    assert.ok(Math.abs(a.player.pos - b.player.pos) < 10, 'same frame at the same time: ' + (a.player.pos - b.player.pos));
    assert.ok(Math.abs(drift(a, room)) < 40 && Math.abs(drift(b, room)) < 40, "drift " + [drift(a, room), drift(b, room)]);
});

test('noisy position reports do not make the speed hunt', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 3, state: 'playing', positionMs: 0, serverTime: room.now()};
    const a = client(world, room, {player: {noiseMs: 50, seed: 7}}), b = client(world, room, {id: 'b', latency: 30, player: {noiseMs: 50, seed: 99}});
    for (const c of [a, b]) { c.sync.onPlaying(); c.sync.setRoom({media: room.media, playback: room.playback}); c.sync.attach('item1'); }
    world.run(5000);
    const rates = c => c.player.log.filter(x => x.startsWith('rate:') && x !== 'rate:1000').length;
    const before = [rates(a), rates(b)];
    let worst = 0;
    for (let i = 0; i < 60; i++) { world.run(1000); worst = Math.max(worst, Math.abs(a.player.pos - b.player.pos)); }
    assert.ok(rates(a) - before[0] <= 2 && rates(b) - before[1] <= 2, 'speed changes in a minute: ' + [rates(a) - before[0], rates(b) - before[1]]);
    assert.ok(worst < 40, 'members stay together: ' + worst.toFixed(1));
});

test('a steady playback-speed skew is corrected now and then, not continuously', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 3, state: 'playing', positionMs: 0, serverTime: room.now()};
    // display-resample plays 23.976 fps material about 0.1% fast.
    const a = client(world, room, {player: {noiseMs: 20, startRate: 1.001}});
    const setRate = a.player.setRate.bind(a.player);
    a.player.setRate = rate => { setRate(rate); a.player.rate *= 1.001; };
    a.sync.onPlaying(); a.sync.setRoom({media: room.media, playback: room.playback}); a.sync.attach('item1');
    let worst = 0;
    for (let i = 0; i < 120; i++) { world.run(1000); if (i > 5) worst = Math.max(worst, Math.abs(drift(a, room))); }
    const changes = a.player.log.filter(x => x.startsWith('rate:')).length;
    assert.ok(worst < 75, 'worst drift ' + worst.toFixed(1));
    assert.ok(changes <= 16, 'speed changes in two minutes: ' + changes);
});

test('a late joiner that loaded ahead of the room waits there without seeking', () => {
    const world = new World(), room = new Room(world);
    room.playback = {...room.playback, revision: 9, state: 'playing', positionMs: 600000, serverTime: room.now()};
    world.run(10000);
    // Loaded stopped about 2 s ahead of where the room is now.
    const b = client(world, room, {latency: 25, skewMs: 777});
    b.player.paused = true; b.player.pos = Math.round(room.expected() + 2000);
    b.sync.setRoom({media: room.media, playback: room.playback}); b.sync.attach('item1');
    b.sync.onPaused(); b.sync.onPosition(b.player.pos);
    world.run(1000);
    assert.ok(b.player.paused, 'still waiting for the room');
    world.run(3000);
    assert.equal(b.player.paused, false);
    assert.ok(b.player.log.every(x => x !== 'seek'), b.player.log.join(','));
    assert.ok(Math.abs(drift(b, room)) < 40, 'drift ' + drift(b, room));
    assert.deepEqual(room.commands, []);
});

// Measured on a Mac with RIFE on (2026-11-15): mpv reported the seek target at
// once, then needed 0.2-3.3 s to decode from the keyframe before it. Holds were
// released against the reported position, started late, and were repeated up to
// eight times in a row; the stall was reported as buffering, which paused the
// whole room.
const playingRoom = (world, room, options) => {
    room.playback = {...room.playback, revision: 3, state: 'playing', positionMs: 0, serverTime: room.now()};
    const entry = client(world, room, options);
    entry.sync.onPlaying(); entry.sync.setRoom({media: room.media, playback: room.playback}); entry.sync.attach('item1');
    return entry;
};

test('with frame interpolation a seek that takes seconds to decode ends in one hold, not a chain', () => {
    const world = new World(), room = new Room(world);
    const decode = [3100, 2100, 200];
    const a = playingRoom(world, room, {rateCorrection: false,
        player: {seekMs: 30, restartSignal: true, restartMs: n => decode[Math.min(n, decode.length - 1)]}});
    world.run(3000);
    fallBehind(a, world, 1500);
    const before = a.player.log.length, reports = a.reports.length;
    world.run(20000);
    const after = a.player.log.slice(before);
    assert.equal(after.filter(x => x === 'play').length, 1, 'one resume: ' + after.join(','));
    assert.equal(after.filter(x => x === 'pause').length, 1, 'one pause: ' + after.join(','));
    assert.equal(a.player.paused, false);
    assert.ok(Math.abs(drift(a, room)) < 50, 'drift ' + drift(a, room));
    assert.ok(!a.reports.slice(reports).includes('buffering'), 'the hold is never reported as buffering');
    assert.deepEqual(room.commands, []);
});

test('with frame interpolation a player that runs fast stops for a moment instead of seeking', () => {
    const world = new World(), room = new Room(world);
    // display-resample on a 120 Hz panel plays 23.976 fps material 0.1% fast:
    // 300 ms ahead of the room every five minutes.
    const a = playingRoom(world, room, {rateCorrection: false,
        player: {noiseMs: 20, seekMs: 30, restartSignal: true, restartMs: 2500}});
    const setRate = a.player.setRate.bind(a.player);
    a.player.setRate = rate => { setRate(rate); a.player.rate *= 1.001; };
    a.player.rate = 1.001;
    let worst = 0, stopped = 0, longest = 0;
    for (let i = 0; i < 15 * 60 * 50; i++) {
        world.run(20);
        if (i > 250) worst = Math.max(worst, Math.abs(drift(a, room)));
        stopped = a.player.paused ? stopped + 20 : 0;
        longest = Math.max(longest, stopped);
    }
    const pauses = a.player.log.filter(x => x === 'pause').length;
    assert.ok(a.player.log.every(x => x !== 'seek'), 'no seek: ' + a.player.log.join(','));
    assert.ok(pauses >= 2 && pauses <= 4, 'stops in fifteen minutes: ' + pauses);
    assert.ok(longest <= 500, 'longest stop ' + longest + ' ms');
    assert.ok(worst < 400, 'worst drift ' + worst.toFixed(1));
    assert.ok(!a.reports.includes('buffering'));
    assert.deepEqual(room.commands, []);
});

test('a room seek resumes only once a slow member has decoded its frame', () => {
    const world = new World(), room = new Room(world);
    const a = playingRoom(world, room, {});
    const b = client(world, room, {id: 'b', latency: 35, rateCorrection: false, player: {seekMs: 30, restartSignal: true, restartMs: 4000}});
    b.sync.onPlaying(); b.sync.setRoom({media: room.media, playback: room.playback}); b.sync.attach('item1');
    world.run(5000);
    const before = b.player.log.length;
    a.player.seek(300000);
    world.run(3000);
    assert.equal(room.playback.state, 'waiting', 'still waiting for the frame');
    world.run(9000);
    const after = b.player.log.slice(before);
    assert.equal(room.playback.state, 'playing');
    assert.deepEqual(after.filter(x => x === 'play' || x === 'seek'), ['seek', 'play'], after.join(','));
    assert.ok(Math.abs(a.player.pos - b.player.pos) < 40, 'both resume together: ' + (a.player.pos - b.player.pos));
});

test('seeks that never finish in time stop being retried and playback goes on', () => {
    const world = new World(), room = new Room(world);
    const a = playingRoom(world, room, {rateCorrection: false, player: {seekMs: 30, restartSignal: true, restartMs: 9000}});
    world.run(3000);
    fallBehind(a, world, 1500);
    const before = a.player.log.length;
    world.run(25000);
    const after = a.player.log.slice(before);
    assert.equal(a.player.paused, false, 'playing again: ' + after.join(','));
    assert.equal(after.filter(x => x === 'seek').length, 4, after.join(','));
    assert.equal(after.filter(x => x === 'play').length, 1, after.join(','));
    const position = a.player.pos;
    world.run(10000);
    assert.ok(a.player.pos - position > 9000, 'and left alone for a while');
});

test('a player that does not report its restarts is released on the position, as before', () => {
    const world = new World(), room = new Room(world);
    const a = playingRoom(world, room, {rateCorrection: false, player: {seekMs: 400}});
    world.run(3000);
    fallBehind(a, world, 1500);
    const before = a.player.log.length;
    world.run(8000);
    const after = a.player.log.slice(before);
    assert.deepEqual(after.filter(x => x === 'play' || x === 'seek' || x === 'pause'), ['pause', 'seek', 'play'], after.join(','));
    assert.ok(Math.abs(drift(a, room)) < 50, 'drift ' + drift(a, room));
});

test('a frame that arrives just after the room passed it is played, not sought again', () => {
    const world = new World(), room = new Room(world);
    // The first hold leads by 1.5 s; this frame takes 1.58 s.
    const a = playingRoom(world, room, {rateCorrection: false, player: {seekMs: 30, restartSignal: true, restartMs: 1580}});
    world.run(3000);
    fallBehind(a, world, 1500);
    const before = a.player.log.length;
    world.run(8000);
    const after = a.player.log.slice(before);
    assert.deepEqual(after.filter(x => x === 'play' || x === 'seek' || x === 'pause'), ['pause', 'seek', 'play'], after.join(','));
    assert.ok(Math.abs(drift(a, room)) < 200, 'drift ' + drift(a, room));
});

test('a room whose clock ran past the end of the film is not chased', () => {
    // Windows log of 2026-11-16: the room was 34 s past the end of a 1420 s
    // episode when a member entered. The player loaded on the end of the file
    // and was sent after the room six times in 23 s, each seek further out.
    const world = new World(), room = new Room(world, {runTimeMs: 1420000});
    room.playback = {...room.playback, revision: 9, state: 'playing', positionMs: 1415000, serverTime: room.now()};
    world.run(39000);
    const a = client(world, room, {rateCorrection: false, player: {seekMs: 30, restartSignal: true, restartMs: 400}});
    a.player.paused = true;
    a.player.pos = 1420000;
    a.sync.setRoom({media: room.media, playback: room.playback});
    a.sync.attach('item1');
    a.sync.onPaused();
    a.sync.onPosition(1420000);
    world.run(60000);
    assert.deepEqual(a.player.log.filter(x => x === 'seek' || x === 'play'), [], 'nothing is sought or started: ' + a.player.log.join(','));
    assert.equal(a.sync.target(), 1420000, 'the room is at the end, not past it');
    assert.equal(a.sync.status(), 'ended');
    assert.deepEqual(room.commands, []);
    assert.equal(a.logs.filter(line => line.includes('past the end')).length, 1, 'said once: ' + a.logs.join(' | '));
});

test('a member playing along reaches the end of the film without being stopped', () => {
    const world = new World(), room = new Room(world, {runTimeMs: 60000});
    const a = playingRoom(world, room, {rateCorrection: false, player: {noiseMs: 20, seekMs: 30, restartSignal: true, restartMs: 2500}});
    world.run(50000);
    const before = a.player.log.length;
    // The simulated file has no end: the player runs on past the room's.
    world.run(30000);
    assert.deepEqual(a.player.log.slice(before).filter(x => x === 'pause' || x === 'seek'), [], a.player.log.slice(before).join(','));
    assert.equal(a.player.paused, false);
    assert.deepEqual(room.commands, []);
});

test('the log says why a member was stopped, where it was sent and how that ended', () => {
    const world = new World(), room = new Room(world);
    const decode = [3100, 2100, 200];
    const a = playingRoom(world, room, {rateCorrection: false,
        player: {seekMs: 30, restartSignal: true, restartMs: n => decode[Math.min(n, decode.length - 1)]}});
    world.run(3000);
    fallBehind(a, world, 1500);
    const before = a.logs.length;
    world.run(20000);
    const lines = a.logs.slice(before);
    assert.match(lines[0], /^watch -1[3-6]\d\d ms off the room: seeks to \d+\.\d\d s, 1500 ms ahead$/, lines.join(' | '));
    assert.ok(lines.some(line => /^watch missed the room by \d+ ms: the frame was not there$/.test(line)), lines.join(' | '));
    assert.ok(lines.some(line => /^watch -?\d+ ms off the room: seeks to .*, 2250 ms ahead, try 2$/.test(line)), lines.join(' | '));
    assert.ok(lines.some(line => /^watch back with the room after \d+ ms$/.test(line)), lines.join(' | '));
    assert.deepEqual(lines.filter(line => line.startsWith('watch reports ')), ['watch reports loading', 'watch reports playing'], lines.join(' | '));

    // Ahead of the room, and speed corrections where they are allowed.
    const world2 = new World(), room2 = new Room(world2);
    const c = playingRoom(world2, room2, {rateCorrection: false, player: {seekMs: 30, restartSignal: true, restartMs: 300}});
    world2.run(3000);
    c.player.pos += 400;
    world2.run(5000);
    assert.ok(c.logs.some(line => /^watch \+\d+ ms off the room: waits in place$/.test(line)), c.logs.join(' | '));
    assert.ok(c.logs.some(line => /^watch back with the room after \d+ ms in place$/.test(line)), c.logs.join(' | '));
    const world3 = new World(), room3 = new Room(world3);
    const d = playingRoom(world3, room3, {});
    world3.run(3000);
    d.player.pos += 400;
    world3.run(20000);
    assert.ok(d.logs.some(line => /^watch speed 0\.\d+, \+\d+ ms off the room$/.test(line)), d.logs.join(' | '));
    assert.ok(d.logs.some(line => /^watch speed back to 1, [+-]?\d+ ms off the room$/.test(line)), d.logs.join(' | '));
    assert.deepEqual(d.logs.slice(0, 3), ['watch room rev 3: playing at 0.00 s', 'watch reports away', 'watch follows this item, speed correction on']);
});

// ---- seeks, offsets and waits with frame interpolation --------------------
const interpolating = (extra = {}) => ({rateCorrection: false,
    player: {seekMs: 30, restartSignal: true, restartMs: decodeRun(), keyframes: true, ...extra}});
const moves = (entry, from) => entry.player.log.slice(from).filter(x => !x.startsWith('rate:'));

test('with frame interpolation a member up to a second behind the room is left alone', () => {
    const world = new World(), room = new Room(world);
    const a = playingRoom(world, room, interpolating());
    world.run(3000);
    fallBehind(a, world, 800);
    const before = a.player.log.length;
    world.run(30000);
    assert.deepEqual(moves(a, before), [], 'every correction would stop the picture');
    assert.ok(drift(a, room) < -700 && drift(a, room) > -900, 'drift ' + drift(a, room));
    assert.deepEqual(a.notices, []);
    assert.deepEqual(room.commands, []);
});

test('with frame interpolation a member further behind goes to the next keyframe and waits there for the room', () => {
    const world = new World(), room = new Room(world);
    // Keyframes every 10 s. A seek to the millisecond a little ahead of the
    // room would decode for 4-5 s here, and be passed by the room meanwhile.
    const a = playingRoom(world, room, interpolating());
    world.run(3000);
    fallBehind(a, world, 1800);
    const before = a.player.log.length, reports = a.reports.length;
    world.run(15000);
    assert.deepEqual(moves(a, before), ['pause', 'key', 'play'], moves(a, before).join(','));
    assert.deepEqual(a.player.keys, [10000], 'the first keyframe ahead of the room');
    assert.ok(Math.abs(drift(a, room)) < 50, 'drift ' + drift(a, room));
    assert.ok(!a.reports.slice(reports).includes('buffering'), 'never reported as buffering');
    assert.deepEqual(a.notices.map(([kind]) => kind), ['jump', 'wait', 'synced']);
    assert.ok(a.notices[0][1].offsetMs < -1500 && a.notices[0][1].offsetMs > -2000, JSON.stringify(a.notices[0]));
    assert.ok(a.notices[1][1].waitMs > 4000 && a.notices[1][1].waitMs < 6000, JSON.stringify(a.notices[1]));
    assert.ok(a.logs.some(line => /^watch -1[5-9]\d\d ms off the room: seeks to the first keyframe from \d+\.\d\d s$/.test(line)), a.logs.join(' | '));
    assert.ok(a.logs.some(line => /^watch waits \d+ ms on the keyframe at 10\.00 s$/.test(line)), a.logs.join(' | '));
    assert.deepEqual(room.commands, []);
});

test('a keyframe the room has passed is followed by one further ahead, and playback goes on either way', () => {
    const world = new World(), room = new Room(world);
    // A keyframe every second, each fetched and decoded in 4 s.
    const a = playingRoom(world, room, interpolating({gopMs: 1000, keyMs: 4000}));
    world.run(3000);
    fallBehind(a, world, 2500);
    const before = a.player.log.length;
    world.run(40000);
    const after = moves(a, before);
    assert.equal(a.player.paused, false, after.join(','));
    assert.ok(a.player.keys.length >= 2 && a.player.keys.length <= 4, 'keyframes tried: ' + a.player.keys.join(','));
    assert.ok(a.player.keys.every((key, i) => i === 0 || key > a.player.keys[i - 1]), 'each one further ahead: ' + a.player.keys.join(','));
    assert.ok(!after.includes('seek'), 'never a seek to the millisecond: ' + after.join(','));
    assert.ok(drift(a, room) <= 50 && drift(a, room) >= -1000, 'with the room, or within the second that is left alone: ' + drift(a, room));
    assert.ok(a.logs.some(line => /^watch keyframe at \d+\.\d\d s came \d+ ms after the room$/.test(line)), a.logs.join(' | '));

    // A keyframe that never comes: after eight seconds the player goes on
    // from wherever the seek ends, and is left alone for a while.
    const world2 = new World(), room2 = new Room(world2);
    const b = playingRoom(world2, room2, interpolating({keyMs: 11000}));
    world2.run(3000);
    fallBehind(b, world2, 2500);
    world2.run(20000);
    assert.equal(b.player.paused, false);
    assert.deepEqual(b.player.log.filter(x => x === 'key' || x === 'seek'), ['key']);
    assert.ok(b.notices.some(([kind]) => kind === 'gaveup'), JSON.stringify(b.notices));
    const position = b.player.pos;
    world2.run(10000);
    assert.ok(b.player.pos - position > 9000, 'left alone afterwards');
});

test('a drag on the timeline is one seek for the room, to a keyframe that every member reaches at once', () => {
    const world = new World(), room = new Room(world);
    const a = playingRoom(world, room, {...interpolating(), id: 'a'}), b = playingRoom(world, room, {...interpolating(), id: 'b', latency: 40});
    world.run(5000);
    // Seven seeks in 0.7 s, the last to 47.3 s. In a room the timeline seeks
    // to keyframes and does not pause the player.
    for (let i = 0; i < 7; i++) { a.player.userSeek(20000 + i * 4550, true); world.run(100); }
    world.run(850);
    assert.equal(a.sync.status(), 'ready', 'stopped for the seek, waiting for the others');
    assert.equal(a.player.paused, true);
    world.run(12000);
    assert.deepEqual(room.commands.map(c => c.client + ':' + c.type), ['a:seek'], 'one seek, no pause and no play around it');
    assert.equal(room.commands[0].fields.positionMs, 40150, 'the keyframe before it, and far enough past it for a cheap seek');
    assert.equal(a.player.paused, false);
    assert.equal(b.player.paused, false);
    assert.ok(Math.abs(drift(a, room)) < 60 && Math.abs(drift(b, room)) < 60, 'drift ' + drift(a, room) + ' / ' + drift(b, room));
    // Just past a keyframe the other member's seek to the millisecond decodes
    // a few frames: 0.4 s here, against 6.5 s for 47.3 s. The member that
    // sought stays on the keyframe and starts 150 ms before the room.
    assert.deepEqual(b.player.log.filter(x => x === 'seek' || x === 'key'), ['seek']);
    assert.deepEqual(a.player.log.filter(x => x === 'seek' || x === 'key'), ['key'], 'no second seek for the member that sought');
    assert.deepEqual(a.notices.map(([kind]) => kind), ['seeking']);
    assert.ok(a.logs.includes('watch user seeks') && a.logs.filter(line => line === 'watch user seek').length === 1, a.logs.join(' | '));

    // A seek to the millisecond from elsewhere (the web page, a script) is
    // taken to the keyframe before it as well; so is one in a paused room,
    // which stays paused.
    const commands = room.commands.length;
    a.player.pause();
    world.run(1000);
    a.player.userSeek(123456, false);
    world.run(9000);
    assert.deepEqual(room.commands.slice(commands).map(c => c.type), ['pause', 'seek']);
    assert.equal(room.commands.at(-1).fields.positionMs, 120150);
    assert.equal(room.playback.state, 'paused');
    assert.ok(Math.abs(b.player.pos - 120150) < 60 && b.player.paused, 'the other member is there too: ' + b.player.pos);
});

test('without keyframe seeks a run of seeks is still one seek for the room', () => {
    const world = new World(), room = new Room(world);
    const a = playingRoom(world, room, {id: 'a'}), b = playingRoom(world, room, {id: 'b'});
    world.run(5000);
    for (let i = 0; i < 4; i++) { a.player.userSeek(60000 + i * 5000, false); world.run(150); }
    world.run(8000);
    assert.deepEqual(room.commands.map(c => c.type), ['seek']);
    assert.equal(room.commands[0].fields.positionMs, 75000, 'where the last one went');
    assert.ok(Math.abs(drift(a, room)) < 60 && Math.abs(drift(b, room)) < 60, 'drift ' + drift(a, room) + ' / ' + drift(b, room));
});

test('a wait for somebody else\'s buffering leaves a member with frame interpolation on its frame', () => {
    const world = new World(), room = new Room(world);
    const a = playingRoom(world, room, interpolating());
    world.run(20000);
    // Another member stalled: the room goes back 1.8 s to where it stopped
    // and waits for everyone. This member has seen those 1.8 s.
    room.wait(room.expected() - 1800, 'buffer');
    world.run(400);
    assert.equal(a.sync.status(), 'ready', 'ready without a seek');
    world.run(8000);
    assert.deepEqual(a.player.log.filter(x => x === 'seek' || x === 'key'), [], 'no seek at all');
    assert.equal(a.player.paused, false);
    assert.ok(Math.abs(drift(a, room)) < 50, 'starts when the room reaches its frame: ' + drift(a, room));

    // A seek by somebody is followed to the frame, also backwards.
    room.wait(room.expected() - 1800, 'seek');
    world.run(12000);
    assert.deepEqual(a.player.log.filter(x => x === 'seek' || x === 'key'), ['seek']);
    assert.ok(Math.abs(drift(a, room)) < 50, 'drift ' + drift(a, room));

    // Without frame interpolation a seek is cheap, and the member goes back
    // to the room's frame as before.
    const world2 = new World(), room2 = new Room(world2);
    const b = playingRoom(world2, room2, {});
    world2.run(20000);
    room2.wait(room2.expected() - 1800, 'buffer');
    world2.run(8000);
    assert.deepEqual(b.player.log.filter(x => x === 'seek'), ['seek']);
    assert.ok(Math.abs(drift(b, room2)) < 50, 'drift ' + drift(b, room2));
});

test('with speed correction a member is told from a second off, and is sought only past three', () => {
    const world = new World(), room = new Room(world);
    const a = playingRoom(world, room, {});
    world.run(3000);
    fallBehind(a, world, 2500);
    const before = a.player.log.length;
    world.run(70000);
    assert.deepEqual(a.player.log.slice(before).filter(x => x === 'pause' || x === 'seek'), [], 'closed by speed alone');
    assert.ok(Math.abs(drift(a, room)) < 50, 'drift ' + drift(a, room));
    assert.deepEqual(a.notices.map(([kind]) => kind), ['catching', 'synced']);
    assert.ok(a.notices[0][1].offsetMs <= -1000, JSON.stringify(a.notices[0]));

    fallBehind(a, world, 3600);
    const later = a.player.log.length;
    world.run(12000);
    assert.deepEqual(a.player.log.slice(later).filter(x => x === 'pause' || x === 'seek' || x === 'play'), ['pause', 'seek', 'play']);
    assert.ok(Math.abs(drift(a, room)) < 50, 'drift ' + drift(a, room));
    assert.deepEqual(a.notices.slice(2).map(([kind]) => kind), ['jump', 'synced']);

    // Half a second off is corrected without a word.
    const world2 = new World(), room2 = new Room(world2);
    const b = playingRoom(world2, room2, {});
    world2.run(3000);
    fallBehind(b, world2, 500);
    world2.run(30000);
    assert.ok(Math.abs(drift(b, room2)) < 50, 'drift ' + drift(b, room2));
    assert.deepEqual(b.notices, []);
});

test('a player that cannot keep the room\'s speed is moved three times, then left to play behind', () => {
    const world = new World(), room = new Room(world);
    const a = playingRoom(world, room, interpolating({gopMs: 2000}));
    // Frame interpolation on a busy GPU: three quarters of real time.
    const setRate = a.player.setRate.bind(a.player);
    a.player.setRate = rate => { setRate(rate); a.player.rate *= 0.75; };
    a.player.rate = 0.75;
    world.run(40000);
    assert.equal(a.player.keys.length, 3, 'moved onto the room three times: ' + a.player.keys.join(','));
    assert.deepEqual(a.notices.map(([kind]) => kind).filter(kind => kind === 'slow'), ['slow'], JSON.stringify(a.notices.map(([kind]) => kind)));
    assert.equal(a.player.paused, false, 'and plays on');
    world.run(40000);
    assert.equal(a.player.keys.length, 3, 'left alone for a minute');
    assert.ok(a.logs.some(line => /not keeping time, plays behind the room for 60 s$/.test(line)), a.logs.join(' | '));
    world.run(15000);
    assert.ok(a.player.keys.length > 3, 'then tried again');
});
