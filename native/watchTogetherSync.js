// Keeps the local player on the room timeline and turns the user's own
// pause, play and seek into room commands. Actions this engine performs are
// recorded as expectations so their player signals never echo back.
(function () {
    'use strict';
    const JUMP_FORWARD_MS = 1500, JUMP_BACK_MS = 1000;
    const ALIGN_PAUSED_MS = 100, READY_MS = 250, STALL_MS = 700;
    const RATE_START_MS = 50, RATE_STOP_MS = 15, RATE_WINDOW_MS = 3000, RATE_INTERVAL_MS = 1000;
    const RATE_SEEK_MS = 2000, NO_RATE_SEEK_MS = 300, PLAY_LEAD_MS = 30, MAX_HOLD_MS = 8000;
    // Position reports reach the page with tens of milliseconds of jitter,
    // and the first frames after a start are not representative: estimate
    // the drift from a longer window and skip the first half second.
    const DRIFT_WINDOW_MS = 1500, DRIFT_SPAN_MS = 1000, DRIFT_SETTLE_MS = 500;
    // A player that says when a seek has decoded its frame is believed for this
    // long; a running player this far ahead stops in place instead of seeking.
    const RESTART_LIMIT_MS = 15000, STILL_HOLD_MS = 2500;
    // Held seeks that keep missing the room are given up for a while. A frame
    // that arrives this late is played from at once: another seek costs more.
    const HOLD_TRIES = 3, HOLD_REST_MS = 30000, HOLD_GRACE_MS = 150;
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

    class WatchSync {
        constructor({player, clock, now = () => performance.now(),
            timers = {setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t)}, command, report = () => {}, rateCorrection = true, log = () => {}}) {
            Object.assign(this, {player, clock, now, timers, command, report, rateCorrection, log});
            this.room = null;
            this.attached = null;
            this.suspended = false;
            this.intent = null;
            this.hold = null;
            this.holdLead = 1500;
            this.rate = 1000;
            this.rateAt = -Infinity;
            this.drifts = [];
            this.driftFrom = 0;
            this.startedRevision = 0;
            this.controlAt = -Infinity;
            this.resetLocal();
        }
        // Player signals are tracked even while detached: the "playing" of a
        // freshly loaded item usually arrives before Emby's playbackstart.
        resetLocal(clearPlayer = true) {
            if (clearPlayer || !this.local) this.local = {paused: null, pos: null, posAt: 0, advanceAt: 0, ended: false, restarting: 0};
            else this.local.ended = false;
            this.expect = {pause: 0, play: 0, seek: null};
            this.attachedAt = 0;
            this.hold = null;
            this.holdTries = 0;
            this.restUntil = 0;
            this.drifts = [];
            this.timers.clearTimeout(this.startTimer);
            this.startTimer = null;
            this.startAt = null;
        }

        // ---- room input ----------------------------------------------------
        setRoom(room) {
            const playback = room?.playback;
            if (!playback) return;
            const previous = this.room?.playback?.revision || 0;
            this.room = {media: room.media, playback};
            if (playback.revision > previous) {
                if (this.intent && playback.revision > this.intent.baseRevision) this.intent = null;
                this.hold = null;
                this.holdTries = 0;
                this.restUntil = 0;
            }
            this.control();
        }
        clearRoom() {
            this.room = null;
            this.intent = null;
            this.setRate(1000);
            this.timers.clearTimeout(this.startTimer);
            this.startTimer = null;
        }

        // ---- local player lifecycle ---------------------------------------
        attach(itemId) {
            this.resetLocal(false);
            this.attached = {itemId: String(itemId)};
            this.attachedAt = this.now();
            this.rate = null;
            this.setRate(1000);
            this.control();
        }
        detach() {
            if (!this.attached) return;
            this.attached = null;
            this.resetLocal();
            this.publish();
        }
        // Android pauses the player when the app goes to the background. That
        // is not a room action: report away and follow again on return.
        suspend(hidden) {
            if (this.suspended === hidden) return;
            this.suspended = hidden;
            if (hidden) this.expect.pause = this.now() + 3000;
            this.control();
        }

        // ---- player signals ------------------------------------------------
        onPaused() {
            const wasPaused = this.local.paused;
            this.local.paused = true;
            if (!this.attached) return;
            // A hold that stops in place takes its target from this pause.
            if (this.expect.pause > this.now()) { this.expect.pause = 0; return this.hold ? this.control() : this.publish(); }
            if (this.suspended || wasPaused === true || !this.settled()) return this.publish();
            const state = this.room?.playback?.state;
            if (state === 'playing' || state === 'waiting')
                this.userAction('pause', {positionMs: Math.round(this.position())});
            this.publish();
        }
        onPlaying() {
            const wasPaused = this.local.paused;
            this.local.paused = false;
            this.local.advanceAt = this.now();
            if (!this.attached) return;
            if (this.expect.play > this.now()) { this.expect.play = 0; this.publish(); return; }
            // Buffering finishing re-sends "playing" without a pause before it.
            if (wasPaused !== true || this.suspended || !this.settled()) return this.publish();
            const playback = this.room?.playback;
            if (!playback) return;
            if (playback.state === 'playing' && !this.scheduled()) {
                // The room is already running (e.g. returning from a hold):
                // just follow it.
                this.hold = null;
                this.control();
                return;
            }
            // Start together: hold here and let the room schedule the start.
            this.pausePlayer();
            this.userAction('play', {});
        }
        onPosition(ms) {
            const position = Number(ms);
            if (!Number.isFinite(position)) return;
            const now = this.now(), local = this.local;
            const previous = local.pos, elapsed = now - local.posAt;
            if (previous !== null && position > previous + 5) local.advanceAt = now;
            local.pos = position;
            local.posAt = now;
            if (!this.attached) return;
            const seek = this.expect.seek;
            if (seek && Math.abs(position - seek.target) < READY_MS) this.expect.seek = null;
            if (previous !== null && this.settled()) {
                const advance = local.paused ? 0 : elapsed * this.rateFactor();
                const jumped = position - previous > advance + JUMP_FORWARD_MS || previous - position > JUMP_BACK_MS;
                const ours = seek && Math.abs(position - seek.target) < JUMP_FORWARD_MS;
                if (jumped && !ours && !this.suspended && this.room) {
                    this.hold = null;
                    this.userAction('seek', {positionMs: Math.round(position)});
                }
            }
            this.sampleDrift(now);
            if (previous === null || now - this.controlAt >= 200 || this.expect.seek === null && seek) this.control();
        }
        onEnded() {
            this.local.ended = true;
            this.publish();
        }
        // mpv reports the position of a seek at once and then decodes towards
        // it from the keyframe before, which takes seconds with frame
        // interpolation. A player that says when the frame is there is not
        // released, or reported ready, before that.
        onSeeking(active) {
            this.local.restarting = active ? this.now() + RESTART_LIMIT_MS : 0;
            if (this.attached) this.control();
        }

        // ---- user actions → room commands ---------------------------------
        userAction(type, fields) {
            if (!this.room || !this.command) return;
            const baseRevision = this.room.playback.revision;
            const intent = {type, baseRevision, until: this.now() + 4000};
            this.intent = intent;
            this.log('watch user ' + type);
            Promise.resolve(this.command(type, fields)).then(result => {
                if (this.intent !== intent) return;
                // The state broadcast normally arrives before the ack.
                if (!(result?.revision > (this.room?.playback?.revision || 0))) this.intent = null;
                this.control();
            }, error => {
                if (this.intent === intent) this.intent = null;
                this.onCommandError?.(type, error);
                this.control();
            });
        }

        // ---- timeline -------------------------------------------------------
        rateFactor() { return (this.rate || 1000) / 1000; }
        settled() { return this.now() - this.attachedAt > 2000 && this.local.pos !== null; }
        position(now = this.now()) {
            const local = this.local;
            if (local.pos === null) return 0;
            if (local.paused !== false || now - local.advanceAt > STALL_MS) return local.pos;
            return local.pos + Math.min(1000, now - local.posAt) * this.rateFactor();
        }
        scheduled(now = this.now()) {
            const playback = this.room?.playback;
            return playback?.state === 'playing' && this.clock.ready && this.clock.toServer(now) < playback.serverTime;
        }
        target(now = this.now()) {
            const playback = this.room?.playback;
            if (!playback) return null;
            if (playback.state !== 'playing' || !this.clock.ready) return playback.positionMs;
            const serverNow = this.clock.toServer(now);
            if (serverNow <= playback.serverTime) return playback.positionMs;
            return playback.positionMs + (serverNow - playback.serverTime) * (playback.rate || 1);
        }
        sampleDrift(now) {
            if (this.local.paused !== false || now < this.driftFrom || this.scheduled(now) || this.room?.playback?.state !== 'playing') return;
            const target = this.target(now);
            if (target === null) return;
            this.drifts.push([now, this.local.pos - target]);
            while (this.drifts.length && this.drifts[0][0] < now - DRIFT_WINDOW_MS) this.drifts.shift();
        }
        drift(now = this.now()) {
            const samples = this.drifts.filter(([at]) => at >= now - DRIFT_WINDOW_MS);
            if (samples.length < 4 || now - samples[0][0] < DRIFT_SPAN_MS) return null;
            const sorted = samples.map(([, value]) => value).sort((a, b) => a - b);
            return sorted[sorted.length >> 1];
        }
        resetDrift(settle = 0) {
            this.drifts = [];
            this.driftFrom = this.now() + settle;
        }
        // Measured on mpv: a player that was seeked while stopped, or stopped
        // after it had started playing, often jumps ahead by up to ~250 ms
        // when it resumes. So small offsets are absorbed by shifting the start
        // time, and only a large one (something moved the player) is a seek.
        misaligned(playback) {
            return Math.abs(this.local.pos - playback.positionMs) > ALIGN_PAUSED_MS;
        }
        stalled(now = this.now()) {
            return this.local.paused === false && now - this.local.advanceAt > STALL_MS;
        }

        // ---- player actions (never echoed) --------------------------------
        // A play still in flight counts as playing (and the reverse), so a
        // quick play → pause is never skipped because of a stale signal.
        pausePlayer() {
            const now = this.now();
            if (this.local.paused === true && this.expect.play <= now || this.expect.pause > now && this.expect.play <= now) return;
            this.expect.pause = now + 3000;
            this.player.pause();
        }
        playPlayer() {
            const now = this.now();
            if (this.local.paused === false && this.expect.pause <= now || this.expect.play > now && this.expect.pause <= now) return;
            this.expect.play = now + 3000;
            this.resetDrift(DRIFT_SETTLE_MS);
            this.player.play();
        }
        seekPlayer(ms) {
            const target = Math.max(0, Math.round(ms));
            this.expect.seek = {target, until: this.now() + 10000};
            this.resetDrift(DRIFT_SETTLE_MS);
            this.player.seek(target);
        }
        seeking() {
            const now = this.now(), seek = this.expect.seek;
            if (seek && seek.until <= now) this.expect.seek = null;
            return Boolean(this.expect.seek) || this.local.restarting > now;
        }
        setRate(rate) {
            if (this.rate === rate) return;
            this.rate = rate;
            this.rateAt = this.now();
            this.player.setRate(rate);
        }

        // ---- control loop ---------------------------------------------------
        control() {
            const now = this.now();
            this.controlAt = now;
            const playback = this.room?.playback;
            if (!playback || !this.attached || this.suspended || this.local.pos === null) return this.publish();
            if (this.intent) {
                if (this.intent.until > now) return this.publish();
                this.intent = null;
            }
            if (playback.state !== 'playing') {
                this.cancelStart();
                this.hold = null;
                this.pausePlayer();
                if (!this.seeking() && this.misaligned(playback)) this.seekPlayer(playback.positionMs);
                this.setRate(1000);
                return this.publish();
            }
            if (!this.clock.ready) return this.publish();
            // Once the start for this revision has fired, the player runs
            // even if it was started a few milliseconds early.
            if (this.scheduled(now) && this.startedRevision !== playback.revision) {
                this.hold = null;
                this.pausePlayer();
                this.setRate(1000);
                if (this.seeking()) return this.publish();
                // Start when the room reaches the frame we are paused on; a
                // seek for a few tens of milliseconds would cost more.
                const offset = this.local.pos - playback.positionMs;
                if (this.misaligned(playback)) this.seekPlayer(playback.positionMs);
                else {
                    const revision = playback.revision;
                    this.scheduleStart(this.clock.toLocal(playback.serverTime + offset), () => { this.startedRevision = revision; });
                }
                return this.publish();
            }
            const expected = this.target(now);
            if (this.hold) return this.continueHold(expected, now);
            if (this.local.paused !== false) {
                if (this.seeking() || this.expect.play > now) return this.publish();
                // Slightly behind or barely ahead: start now and let the speed
                // close the gap. Further ahead: hold until the room arrives.
                const offset = this.local.pos - expected;
                if (offset >= -NO_RATE_SEEK_MS && offset <= PLAY_LEAD_MS + 50 || offset < 0 && this.resting(now)) {
                    this.setRate(1000);
                    this.playPlayer();
                } else this.startHold(expected);
                return this.publish();
            }
            if (this.stalled(now) || this.seeking()) return this.publish();
            const drift = this.drift(now);
            if (drift === null) return this.publish();
            const limit = this.rateCorrection ? RATE_SEEK_MS : NO_RATE_SEEK_MS;
            if (Math.abs(drift) > limit && !(drift < 0 && this.resting(now))) {
                this.setRate(1000);
                this.startHold(expected);
                return this.publish();
            }
            if (this.rateCorrection) this.correctRate(drift, now);
            this.publish();
        }
        correctRate(drift, now) {
            const correcting = this.rate !== 1000;
            if (Math.abs(drift) < RATE_STOP_MS || (!correcting && Math.abs(drift) < RATE_START_MS)) {
                this.setRate(1000);
                return;
            }
            const desired = Math.round(clamp(1000 - drift / RATE_WINDOW_MS * 1000, 950, 1050) / 5) * 5;
            if (now - this.rateAt < RATE_INTERVAL_MS || desired === this.rate) return;
            // Small steps are not worth another speed change.
            if (correcting && Math.abs(desired - this.rate) < 10 && Math.sign(1000 - desired) === Math.sign(1000 - this.rate)) return;
            this.setRate(desired);
        }
        // Large offsets: pause at a point a little ahead of the room, wait
        // until that frame is ready, then start exactly when the room gets
        // there. Independent of how long the seek itself takes.
        startHold(expected) {
            const now = this.now();
            // Ahead of the room: wait for it instead of seeking. A late joiner
            // loads a few seconds ahead and is already stopped. A running
            // player that crept ahead (display-resample plays 23.976 fps
            // material about 0.1% fast) stops on the frame it is showing, so
            // nothing has to be decoded again.
            if (!this.seeking()) {
                const stopped = this.local.paused === true;
                const ahead = this.position(now) - expected;
                if (ahead > PLAY_LEAD_MS && ahead <= (stopped ? MAX_HOLD_MS : STILL_HOLD_MS)) {
                    this.hold = {still: true, target: this.local.pos, startedAt: now};
                    if (!stopped) this.pausePlayer();
                    return this.continueHold(expected, now);
                }
            }
            this.hold = {target: Math.round(expected + this.holdLead), startedAt: now};
            this.pausePlayer();
            this.seekPlayer(this.hold.target);
            this.publish();
        }
        continueHold(expected, now) {
            const hold = this.hold;
            if (hold.still) return this.continueStillHold(now);
            // Still playing with no pause on its way: the hold is over. A
            // position report often arrives before the pause has landed.
            if (this.local.paused === false && !this.expect.play && this.expect.pause <= now) { this.hold = null; return this.control(); }
            if (this.seeking()) {
                // The room passed the target and its frame is still not there.
                if (expected > hold.target + HOLD_GRACE_MS) { this.cancelStart(); this.retryHold(expected); }
                return this.publish();
            }
            if (Math.abs(this.local.pos - hold.target) > READY_MS) { this.seekPlayer(hold.target); return this.publish(); }
            const wait = this.clock.toLocal(this.room.playback.serverTime + (hold.target - this.room.playback.positionMs)) - now;
            if (wait < -PLAY_LEAD_MS) {
                if (wait < -HOLD_GRACE_MS - PLAY_LEAD_MS) return this.retryHold(expected);
                // Barely late: the paused branch plays from here.
                this.hold = null;
                this.holdTries = 0;
                return this.control();
            }
            this.scheduleStart(now + wait, () => {
                this.hold = null;
                this.holdTries = 0;
                this.holdLead = Math.max(1000, this.holdLead * 0.9);
            });
            this.publish();
        }
        // Stopped in place: the frame the pause landed on is where the room
        // has to get to.
        continueStillHold(now) {
            const hold = this.hold, playback = this.room.playback;
            if (this.local.paused !== true) {
                if (this.expect.pause > now) return this.publish();
                this.hold = null;
                return this.control();
            }
            if (this.seeking()) { this.hold = null; return this.control(); }
            hold.target = this.local.pos;
            const wait = this.clock.toLocal(playback.serverTime + (hold.target - playback.positionMs)) - now;
            // The room is already here: the paused branch plays, or seeks.
            if (wait < -PLAY_LEAD_MS) { this.hold = null; return this.control(); }
            this.scheduleStart(now + wait, () => { this.hold = null; });
            this.publish();
        }
        // Each miss allows the next seek more time. After a few in a row the
        // player goes on from wherever the last one lands, behind the room,
        // and is left alone for a while: playing late beats never playing.
        retryHold(expected) {
            this.holdLead = Math.min(8000, this.holdLead * 1.5);
            if (++this.holdTries >= HOLD_TRIES) {
                this.hold = null;
                this.restUntil = this.now() + HOLD_REST_MS;
                return this.control();
            }
            this.startHold(expected);
        }
        resting(now = this.now()) { return now < this.restUntil; }
        scheduleStart(localTime, started = () => {}) {
            const when = localTime - PLAY_LEAD_MS;
            if (this.startTimer && Math.abs((this.startAt ?? 0) - when) < 5) return;
            this.timers.clearTimeout(this.startTimer);
            this.startAt = when;
            this.startTimer = this.timers.setTimeout(() => {
                this.startTimer = null;
                this.startAt = null;
                if (!this.attached || this.room?.playback?.state !== 'playing' || this.intent || this.suspended) return;
                // Something restarted the player since this was scheduled.
                if (this.seeking()) return this.control();
                started();
                this.setRate(1000);
                this.playPlayer();
                this.publish();
            }, Math.max(0, when - this.now()));
        }
        cancelStart() {
            this.timers.clearTimeout(this.startTimer);
            this.startTimer = null;
            this.startAt = null;
        }

        // ---- status ---------------------------------------------------------
        status(now = this.now()) {
            const playback = this.room?.playback;
            if (!this.attached || this.suspended) return 'away';
            if (this.local.ended) return 'ended';
            if (!playback || this.local.pos === null) return 'loading';
            if (playback.state === 'paused') return 'paused';
            if (playback.state === 'waiting' || this.scheduled(now)) {
                const settled = !this.seeking() && this.local.paused === true &&
                    !this.misaligned(playback);
                return settled ? 'ready' : 'loading';
            }
            if (this.hold || this.seeking() || this.local.paused !== false) return 'loading';
            return this.stalled(now) ? 'buffering' : 'playing';
        }
        publish() {
            const now = this.now();
            this.report({state: this.status(now), positionMs: Math.max(0, this.position(now)), sampledAtLocal: now});
        }
        snapshot() {
            const now = this.now(), target = this.target(now);
            return {status: this.status(now), position: this.position(now), target,
                drift: target === null || this.local.pos === null ? null : this.position(now) - target,
                rate: this.rate, hold: Boolean(this.hold), holdLead: this.holdLead,
                serverNow: this.clock.ready ? this.clock.toServer(now) : null, rttMs: this.clock.rttMs};
        }
    }

    window.TigerestWatchSync = WatchSync;
})();
