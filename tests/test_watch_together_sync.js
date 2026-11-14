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
    // function of the seek's index). restartSignal says whether the player
    // tells the page about that, as the desktop client does.
    constructor(world, {seekMs = 250, playMs = 25, pauseMs = 15, startRate = 1, noiseMs = 0, reportOnPlay = false, seed = 1,
        restartMs = null, restartSignal = false} = {}) {
        Object.assign(this, {world, seekMs, playMs, pauseMs, noiseMs, reportOnPlay, restartMs, restartSignal});
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
        const restart = typeof this.restartMs === 'function' ? this.restartMs(this.seeks) : this.restartMs;
        const token = ++this.seekToken;
        this.seeks++;
        this.seekingUntil = this.world.time + restart;
        if (this.restartSignal) this.world.at(5, () => this.sync.onSeeking?.(true));
        this.world.at(this.seekMs, () => { if (token !== this.seekToken) return; this.pos = ms; this.sync.onPosition(ms); });
        // A newer seek replaces this one; only the last reports its restart.
        this.world.at(restart, () => { if (token !== this.seekToken) return; this.lastAdvance = this.world.time; if (this.restartSignal) this.sync.onSeeking?.(false); });
    }
    setRate(rate) { this.log.push('rate:' + rate); this.rate = rate / 1000; }
}

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
    start() { this.commit({state: 'playing', serverTime: this.now() + 500, waiting: null}); }
    wait(positionMs) {
        const ids = this.clients.filter(c => c.status !== 'away').map(c => c.id);
        this.ready = new Set();
        this.commit({state: 'waiting', positionMs, waiting: {memberIds: ids, deadline: this.now() + 15000, resumeTo: 'playing'}});
    }
    command(client, type, fields) {
        return new Promise((resolve, reject) => this.world.at(client.latency, () => {
            this.commands.push({client: client.id, type, fields});
            if (fields.baseRevision !== undefined && fields.baseRevision !== this.playback.revision)
                return this.world.at(client.latency, () => reject(Object.assign(new Error('stale'), {code: 'STALE_REVISION'})));
            if (type === 'pause') this.commit({state: 'paused', positionMs: fields.positionMs, serverTime: this.now(), waiting: null});
            else if (type === 'play') { if (this.playback.state !== 'playing') this.start(); }
            else if (type === 'seek') { if (this.playback.state === 'paused') this.commit({positionMs: fields.positionMs}); else this.wait(fields.positionMs); }
            const revision = this.playback.revision;
            this.world.at(client.latency, () => resolve({revision}));
        }));
    }
    status(client, report) {
        client.status = report.state;
        if (this.playback.state === 'waiting' && report.state === 'ready' && report.revision === this.playback.revision) {
            this.ready.add(client.id);
            if (this.playback.waiting.memberIds.every(id => this.ready.has(id))) this.start();
        }
    }
}

function client(world, room, {id = 'a', latency = 15, skewMs = 0, clockErrorMs = 0, rateCorrection = true, player: options = {}} = {}) {
    const player = new Player(world, options);
    const entry = {id, latency, status: 'loading', reports: []};
    // Local clocks start at different origins; the estimate carries a small error.
    const local = () => world.time + skewMs;
    const clock = {ready: true, rttMs: latency * 2,
        toServer: value => value - skewMs + room.offset + clockErrorMs,
        toLocal: value => value - room.offset - clockErrorMs + skewMs};
    const sync = new Sync({player: {pause: () => player.pause(), play: () => player.play(), seek: ms => player.seek(ms), setRate: r => player.setRate(r)},
        clock, now: local, timers: {setTimeout: (fn, ms) => world.at(ms, fn), clearTimeout: t => world.cancel(t)},
        command: (type, fields) => room.command(entry, type, {...fields, baseRevision: room.clientRevision?.(entry) ?? sync.room.playback.revision}),
        report: report => { entry.reports.push(report.state); world.at(latency, () => room.status(entry, {...report, revision: sync.room?.playback?.revision})); },
        rateCorrection});
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
    a.player.pos -= 600;
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
    a.player.pos -= 600;
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
    a.player.pos -= 600;
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
    a.player.pos -= 600;
    const before = a.player.log.length;
    world.run(8000);
    const after = a.player.log.slice(before);
    assert.deepEqual(after.filter(x => x === 'play' || x === 'seek' || x === 'pause'), ['pause', 'seek', 'play'], after.join(','));
    assert.ok(Math.abs(drift(a, room)) < 200, 'drift ' + drift(a, room));
});
