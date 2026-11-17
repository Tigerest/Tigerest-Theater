// Keeps the local player on the room timeline and turns the user's own
// pause, play and seek into room commands. Actions this engine performs are
// recorded as expectations so their player signals never echo back.
(function () {
    'use strict';
    const JUMP_FORWARD_MS = 1500, JUMP_BACK_MS = 1000;
    const ALIGN_PAUSED_MS = 100, READY_MS = 250, STALL_MS = 700;
    const RATE_START_MS = 50, RATE_STOP_MS = 15, RATE_WINDOW_MS = 3000, RATE_INTERVAL_MS = 1000;
    // With speed correction a member up to three seconds off closes the gap at
    // 0.95-1.05x and is sought onto the room beyond that. A stopped member
    // this far behind is started and catches up.
    const RATE_SEEK_MS = 3000, START_BEHIND_MS = 300, PLAY_LEAD_MS = 30, MAX_HOLD_MS = 8000;
    // Without it (any speed but 1x turns frame interpolation off for the item)
    // every correction stops the picture. Ahead of the room a member waits on
    // its frame from here on; behind it, it is left alone for up to a second
    // and then taken to a keyframe ahead of the room.
    const AHEAD_STILL_MS = 300, BEHIND_OK_MS = 1000;
    // Offsets from here on are told to the viewer.
    const NOTICE_MS = 1000;
    // Position reports reach the page with tens of milliseconds of jitter,
    // and the first frames after a start are not representative: estimate
    // the drift from a longer window and skip the first half second.
    const DRIFT_WINDOW_MS = 1500, DRIFT_SPAN_MS = 1000, DRIFT_SETTLE_MS = 500;
    // A player that says when a seek has decoded its frame is believed for this
    // long; a running player this far ahead stops in place instead of seeking.
    const RESTART_LIMIT_MS = 15000, STILL_HOLD_MS = 2500;
    // Held seeks that keep missing the room are given up for a while. A frame
    // that arrives this late is played from at once: another seek costs more.
    // Four tries lead by up to 5 s. Measured on a Mac with RIFE on, a seek
    // 8 s into a 10 s GOP took 4.5 s to decode (about 1.8x real time).
    const HOLD_TRIES = 4, HOLD_REST_MS = 30000, HOLD_GRACE_MS = 150;
    // A keyframe has its frame in a quarter of a second where a seek to the
    // millisecond decodes the whole run up to it (TensorRT RIFE, 2026-11-17:
    // 0.24 s against 1.6-7.0 s). A hold takes the first keyframe this far
    // ahead of the room, and twice as far after each one the room had passed.
    const KEY_MARGIN_MS = 600;
    // Seeks of the viewer this close together are one seek for the room; the
    // move to the keyframe before it is given this long. Position reports of
    // a keyframe seek can arrive this long after its frame.
    const SEEK_SETTLE_MS = 250, SNAP_LIMIT_MS = 3000, LANDING_MS = 300;
    // The room is taken this far past that keyframe. A seek to the millisecond
    // closer to a keyframe than a frame or two starts decoding at the keyframe
    // before it (TensorRT RIFE, 2026-11-17, 10 s between keyframes: 13.7 s for
    // 2 ms past one, 0.37 s for 50 ms past it).
    const SNAP_AHEAD_MS = 150;
    // A player that cannot keep real time (frame interpolation on a busy GPU
    // ran at 0.5-0.75x in a window behind others) is behind again a few
    // seconds after every move. After this many in a row it is left to play
    // behind for a while, and the viewer is told why.
    const BEHIND_RUN = 3, BEHIND_RUN_MS = 45000, SLOW_REST_MS = 60000;
    // The room's clock runs on after the film is over. This close to the end
    // there is nothing left to follow.
    const END_MS = 1000;
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
    const seconds = ms => (ms / 1000).toFixed(2) + ' s';
    const signed = ms => (ms > 0 ? '+' : '') + Math.round(ms) + ' ms';

    class WatchSync {
        constructor({player, clock, now = () => performance.now(),
            timers = {setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t)}, command, report = () => {}, rateCorrection = true, log = () => {}, notice = () => {}}) {
            Object.assign(this, {player, clock, now, timers, command, report, rateCorrection, log, notice});
            // Desktop players can seek to a keyframe and say where it was.
            this.keySeek = typeof player.seekKeyframe === 'function';
            this.exact = true;
            this.told = false;
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
            this.reported = null;
            this.pastEnd = false;
            this.resetLocal();
        }
        // Player signals are tracked even while detached: the "playing" of a
        // freshly loaded item usually arrives before Emby's playbackstart.
        resetLocal(clearPlayer = true) {
            if (clearPlayer || !this.local) this.local = {paused: null, pos: null, posAt: 0, advanceAt: 0, ended: false, restarting: 0};
            else this.local.ended = false;
            this.expect = {pause: 0, play: 0, seek: null};
            this.timers.clearTimeout(this.gesture?.timer);
            this.gesture = null;
            this.landing = 0;
            this.behind = [];
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
                this.log('watch room rev ' + playback.revision + ': ' + playback.state + ' at ' + seconds(playback.positionMs) +
                    (playback.lastAction?.type ? ' after ' + playback.lastAction.type : ''));
                if (this.intent && playback.revision > this.intent.baseRevision) this.intent = null;
                // A seek or another film is followed to the frame. A pause
                // that took a moment to arrive, or a wait for somebody's
                // buffering, leaves the room a little behind this member.
                const action = playback.lastAction?.type;
                if (action === 'pause' || action === 'buffer') this.exact = false;
                else if (action !== 'play' && action !== 'resume' && action !== 'timeout') this.exact = true;
                this.told = false;
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
            this.exact = true;
            this.rate = null;
            this.setRate(1000);
            this.log('watch follows this item, speed correction ' + (this.rateCorrection ? 'on' : 'off'));
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
            if (this.suspended || wasPaused === true || !this.settled() || this.gesture) return this.publish();
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
            if (wasPaused !== true || this.suspended || !this.settled() || this.gesture) return this.publish();
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
            if (seek && !seek.key && Math.abs(position - seek.target) < READY_MS) this.expect.seek = null;
            if (previous !== null && this.settled()) {
                const advance = local.paused ? 0 : elapsed * this.rateFactor();
                const jumped = position - previous > advance + JUMP_FORWARD_MS || previous - position > JUMP_BACK_MS;
                // A keyframe seek lands wherever the keyframe is.
                const ours = seek && (seek.key || Math.abs(position - seek.target) < JUMP_FORWARD_MS) || now < this.landing;
                if (jumped && !ours && !this.suspended && this.room) this.userSeek(position);
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
        // The frame of a keyframe seek is there, and this is where it is.
        onKeyframe(ms) {
            const position = Number(ms), now = this.now();
            if (!Number.isFinite(position)) return;
            this.local.pos = position;
            this.local.posAt = now;
            if (this.expect.seek?.key) this.expect.seek = null;
            this.landing = now + LANDING_MS;
            if (!this.attached) return;
            if (this.gesture?.snapping) return this.finishSeek();
            this.control();
        }

        // ---- the viewer's own seek ------------------------------------------
        // A click on the timeline, a drag or a held arrow key is a run of
        // seeks. The room hears of one: the last, once the player has moved
        // to the keyframe before it. A room position just past a keyframe
        // costs every member with frame interpolation a few frames to decode
        // instead of the run up to the frame. Until the room has moved, this
        // player stands still: the room then stops everyone and starts them
        // together.
        userSeek(position) {
            this.hold = null;
            this.cancelStart();
            this.setRate(1000);
            if (!this.gesture) {
                this.log('watch user seeks');
                if (this.room.playback.state !== 'paused') {
                    this.pausePlayer();
                    this.notice('seeking', {});
                }
            }
            this.timers.clearTimeout(this.gesture?.timer);
            this.gesture = {position, snapping: false, timer: this.timers.setTimeout(() => this.settleSeek(), SEEK_SETTLE_MS)};
            this.publish();
        }
        settleSeek() {
            const gesture = this.gesture;
            if (!gesture) return;
            if (!this.attached || !this.room) { this.gesture = null; return; }
            if (!this.keySeek) return this.finishSeek();
            gesture.snapping = true;
            gesture.timer = this.timers.setTimeout(() => { gesture.snapping = false; this.finishSeek(); }, SNAP_LIMIT_MS);
            // The keyframe before the place the viewer went to. Asked for
            // from a little past it: the timeline seeks to keyframes itself in
            // a room, and "before" a keyframe's own position is the one
            // before that (60.06 s for a click at 73 s that had landed on
            // 70.07 s, in the real client).
            this.seekKey(gesture.position + SNAP_AHEAD_MS, false);
        }
        finishSeek() {
            const gesture = this.gesture;
            if (!gesture) return;
            this.timers.clearTimeout(gesture.timer);
            this.gesture = null;
            if (!this.attached || !this.room) return;
            const position = gesture.snapping ? Math.floor(this.local.pos) + SNAP_AHEAD_MS : Math.round(gesture.position);
            this.userAction('seek', {positionMs: position});
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
        runTime() {
            const ms = Number(this.room?.media?.runTimeMs);
            return ms > 0 ? ms : Infinity;
        }
        target(now = this.now()) {
            const playback = this.room?.playback;
            if (!playback) return null;
            if (playback.state !== 'playing' || !this.clock.ready) return playback.positionMs;
            const serverNow = this.clock.toServer(now);
            if (serverNow <= playback.serverTime) return playback.positionMs;
            return Math.min(this.runTime(), playback.positionMs + (serverNow - playback.serverTime) * (playback.rate || 1));
        }
        // The film is over in the room, whatever the server's clock says.
        over(now = this.now()) {
            return this.room?.playback?.state === 'playing' && this.clock.ready && this.target(now) >= this.runTime() - END_MS;
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
        // A seek costs seconds with frame interpolation. A member the room
        // stopped a little behind of, for a pause or for somebody's
        // buffering, stays on its frame and starts when the room reaches it:
        // it has seen what lies between.
        // The member that took the room to a keyframe stands on it, a little
        // before the room's position, and starts that much earlier.
        aligned(playback) {
            const ahead = this.local.pos - playback.positionMs;
            return ahead >= -SNAP_AHEAD_MS - 10 && ahead <= ALIGN_PAUSED_MS ||
                !this.exact && !this.rateCorrection && ahead > 0 && ahead <= MAX_HOLD_MS;
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
        // To the first keyframe at or after ms, or to the one before it.
        seekKey(ms, after) {
            const target = Math.max(0, Math.round(ms));
            this.expect.seek = {target, key: true, until: this.now() + 10000};
            this.resetDrift(DRIFT_SETTLE_MS);
            this.player.seekKeyframe(target, after);
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
            // The viewer is seeking; the room hears of it when that settles.
            if (this.gesture) return this.publish();
            if (this.intent) {
                if (this.intent.until > now) return this.publish();
                this.intent = null;
            }
            if (playback.state !== 'playing') {
                this.cancelStart();
                this.hold = null;
                this.pausePlayer();
                if (!this.seeking() && !this.aligned(playback)) this.seekPlayer(playback.positionMs);
                this.setRate(1000);
                return this.publish();
            }
            if (!this.clock.ready) return this.publish();
            // A player still running finishes on its own. One that is stopped
            // is not sent after a position the file does not have: every
            // such seek lands on the end and is tried again (Windows log of
            // 2026-11-16: six seeks in 23 s, the room 34 s past the end).
            if (this.over(now)) {
                if (!this.pastEnd) this.log('watch room is past the end of the film: nothing to follow');
                this.pastEnd = true;
                this.cancelStart();
                this.hold = null;
                this.setRate(1000);
                return this.publish();
            }
            this.pastEnd = false;
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
                if (!this.aligned(playback)) this.seekPlayer(playback.positionMs);
                else {
                    const revision = playback.revision;
                    this.scheduleStart(this.clock.toLocal(playback.serverTime + offset), () => {
                        this.startedRevision = revision;
                        this.log('watch starts with the room, rev ' + revision);
                        this.backWithRoom();
                    });
                }
                return this.publish();
            }
            const expected = this.target(now);
            if (this.hold) return this.continueHold(expected, now);
            if (this.local.paused !== false) {
                if (this.seeking() || this.expect.play > now) return this.publish();
                // Slightly behind or barely ahead: start now, and let the
                // speed close the gap where it may. Further ahead: hold until
                // the room arrives.
                const offset = this.local.pos - expected;
                if (offset >= -(this.rateCorrection ? START_BEHIND_MS : BEHIND_OK_MS) && offset <= PLAY_LEAD_MS + 50 || offset < 0 && this.resting(now)) {
                    this.setRate(1000);
                    this.playPlayer();
                    if (!this.resting(now)) this.backWithRoom();
                } else this.startHold(expected);
                return this.publish();
            }
            if (this.stalled(now) || this.seeking()) return this.publish();
            const drift = this.drift(now);
            if (drift === null) return this.publish();
            const off = this.rateCorrection ? Math.abs(drift) > RATE_SEEK_MS : drift > AHEAD_STILL_MS || drift < -BEHIND_OK_MS;
            if (off && !(drift < 0 && this.resting(now))) {
                this.setRate(1000);
                this.startHold(expected);
                return this.publish();
            }
            if (this.rateCorrection) this.correctRate(drift, now);
            this.publish();
        }
        // The viewer was told of an offset: say when it is gone.
        tell(kind, data) {
            this.told = true;
            this.notice(kind, data);
        }
        backWithRoom() {
            if (!this.told) return;
            this.told = false;
            this.notice('synced', {});
        }
        correctRate(drift, now) {
            const correcting = this.rate !== 1000;
            if (Math.abs(drift) < RATE_STOP_MS || (!correcting && Math.abs(drift) < RATE_START_MS)) {
                if (correcting) {
                    this.log('watch speed back to 1, ' + signed(drift) + ' off the room');
                    this.backWithRoom();
                }
                this.setRate(1000);
                return;
            }
            const desired = Math.round(clamp(1000 - drift / RATE_WINDOW_MS * 1000, 950, 1050) / 5) * 5;
            if (now - this.rateAt < RATE_INTERVAL_MS || desired === this.rate) return;
            // Small steps are not worth another speed change.
            if (correcting && Math.abs(desired - this.rate) < 10 && Math.sign(1000 - desired) === Math.sign(1000 - this.rate)) return;
            this.log('watch speed ' + (desired / 1000).toFixed(3) + ', ' + signed(drift) + ' off the room');
            if (!this.told && Math.abs(drift) >= NOTICE_MS) this.tell('catching', {offsetMs: drift});
            this.setRate(desired);
        }
        // Large offsets: pause at a point a little ahead of the room, wait
        // until that frame is ready, then start exactly when the room gets
        // there. Independent of how long the seek itself takes.
        startHold(expected) {
            const now = this.now(), offset = this.position(now) - expected;
            // Ahead of the room: wait for it instead of seeking. A late joiner
            // loads a few seconds ahead and is already stopped. A running
            // player that crept ahead (display-resample plays 23.976 fps
            // material about 0.1% fast) stops on the frame it is showing, so
            // nothing has to be decoded again. Where a seek costs seconds,
            // a running player waits as long as a stopped one would.
            if (!this.seeking()) {
                const stopped = this.local.paused === true;
                if (offset > PLAY_LEAD_MS && offset <= (stopped || !this.rateCorrection ? MAX_HOLD_MS : STILL_HOLD_MS)) {
                    this.hold = {still: true, target: this.local.pos, startedAt: now};
                    this.log('watch ' + signed(offset) + ' off the room: waits in place');
                    if (offset >= NOTICE_MS) this.tell('still', {offsetMs: offset});
                    if (!stopped) this.pausePlayer();
                    return this.continueHold(expected, now);
                }
            }
            // (Another try of the same move is not another move.)
            if (offset < 0 && !this.holdTries && this.fallingBehind(now, offset)) return;
            this.tell('jump', {offsetMs: offset});
            const again = this.holdTries ? ', try ' + (this.holdTries + 1) : '';
            // Where a seek to the millisecond costs seconds: the first
            // keyframe ahead of the room, and a wait on it for the room.
            if (this.keySeek && !this.rateCorrection) {
                const from = expected + Math.min(MAX_HOLD_MS, KEY_MARGIN_MS * 2 ** this.holdTries);
                this.hold = {still: true, key: true, target: null, startedAt: now};
                this.log('watch ' + signed(offset) + ' off the room: seeks to the first keyframe from ' + seconds(from) + again);
                this.pausePlayer();
                this.seekKey(from, true);
                return this.publish();
            }
            this.hold = {target: Math.round(expected + this.holdLead), startedAt: now};
            this.log('watch ' + signed(offset) + ' off the room: seeks to ' + seconds(this.hold.target) +
                ', ' + Math.round(this.holdLead) + ' ms ahead' + again);
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
                this.log('watch frame ' + Math.round(-wait) + ' ms late: plays from it');
                this.hold = null;
                this.holdTries = 0;
                return this.control();
            }
            this.scheduleStart(now + wait, () => {
                this.log('watch back with the room after ' + Math.round(this.now() - hold.startedAt) + ' ms');
                this.hold = null;
                this.holdTries = 0;
                this.holdLead = Math.max(1000, this.holdLead * 0.9);
                this.backWithRoom();
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
            if (this.seeking()) {
                // A keyframe hold is waiting for its frame, which normally
                // takes a quarter of a second: one that takes this long was
                // not in the cache and is not being fetched in time. Anything
                // else has moved the player.
                if (hold.key && now - hold.startedAt <= MAX_HOLD_MS) return this.publish();
                this.hold = null;
                if (hold.key) {
                    this.holdTries = HOLD_TRIES;
                    this.giveUp();
                }
                return this.control();
            }
            hold.target = this.local.pos;
            const wait = this.clock.toLocal(playback.serverTime + (hold.target - playback.positionMs)) - now;
            // The room is already here: the paused branch plays, or seeks.
            if (wait < -PLAY_LEAD_MS) {
                if (hold.key) this.missedKeyframe(-wait);
                this.hold = null;
                return this.control();
            }
            if (hold.key && !hold.waiting) {
                hold.waiting = true;
                this.log('watch waits ' + Math.round(wait) + ' ms on the keyframe at ' + seconds(hold.target));
                if (wait >= NOTICE_MS) this.notice('wait', {waitMs: wait});
            }
            this.scheduleStart(now + wait, () => {
                this.log('watch back with the room after ' + Math.round(this.now() - hold.startedAt) + ' ms' + (hold.key ? '' : ' in place'));
                this.hold = null;
                if (hold.key) this.holdTries = 0;
                this.backWithRoom();
            });
            this.publish();
        }
        // Moved onto the room again and again, and behind it again each time:
        // this player does not run at the room's speed.
        fallingBehind(now, offset) {
            this.behind = this.behind.filter(at => now - at < BEHIND_RUN_MS);
            this.behind.push(now);
            if (this.behind.length <= BEHIND_RUN) return false;
            this.behind = [];
            this.log('watch ' + signed(offset) + ' off the room, behind for the ' + (BEHIND_RUN + 1) + 'th time in ' + BEHIND_RUN_MS / 1000 +
                ' s: this player is not keeping time, plays behind the room for ' + SLOW_REST_MS / 1000 + ' s');
            this.hold = null;
            this.restUntil = now + SLOW_REST_MS;
            this.told = false;
            this.notice('slow', {});
            return true;
        }
        // The keyframe was fetched and decoded too late. The next one is
        // looked for further ahead; after a few the player goes on behind.
        missedKeyframe(late) {
            this.log('watch keyframe at ' + seconds(this.local.pos) + ' came ' + Math.round(late) + ' ms after the room');
            if (++this.holdTries >= HOLD_TRIES) this.giveUp();
        }
        giveUp() {
            this.log('watch gives up after ' + HOLD_TRIES + ' tries: plays behind the room for ' + HOLD_REST_MS / 1000 + ' s');
            this.restUntil = this.now() + HOLD_REST_MS;
            this.told = false;
            this.notice('gaveup', {});
        }
        // Each miss allows the next seek more time. After a few in a row the
        // player goes on from wherever the last one lands, behind the room,
        // and is left alone for a while: playing late beats never playing.
        retryHold(expected) {
            this.log('watch missed the room by ' + Math.round(expected - this.hold.target) + ' ms: the frame was not there');
            this.holdLead = Math.min(8000, this.holdLead * 1.5);
            if (++this.holdTries >= HOLD_TRIES) {
                this.hold = null;
                this.giveUp();
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
                if (!this.attached || this.room?.playback?.state !== 'playing' || this.intent || this.gesture || this.suspended) return;
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
                const settled = !this.seeking() && this.local.paused === true && !this.gesture &&
                    this.aligned(playback);
                return settled ? 'ready' : 'loading';
            }
            // Stopped with the film over in the room: not waiting for anything.
            if (this.over(now) && this.local.paused !== false) return 'ended';
            if (this.hold || this.seeking() || this.local.paused !== false) return 'loading';
            return this.stalled(now) ? 'buffering' : 'playing';
        }
        publish() {
            const now = this.now(), state = this.status(now);
            // "buffering" for 1.5 s makes the server stop the room for this member.
            if (state !== this.reported) {
                this.reported = state;
                this.log('watch reports ' + state);
            }
            this.report({state, positionMs: Math.max(0, this.position(now)), sampledAtLocal: now});
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
