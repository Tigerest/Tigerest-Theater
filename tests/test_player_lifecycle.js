const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class Signal {
    constructor() { this.handlers = new Set(); }
    connect(handler) { this.handlers.add(handler); }
    disconnect(handler) { this.handlers.delete(handler); }
    emit(...args) { for (const handler of [...this.handlers]) handler(...args); }
}

function makeElement() {
    const classes = new Set();
    return {
        style: {},
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
        },
        parentNode: null,
        innerHTML: '',
    };
}

async function main() {
    const timers = new Map();
    const timerDelays = new Map();
    let now = 0;
    let timerId = 0;
    let videoDialog = null;
    const bodyClasses = new Set();
    const body = {
        firstChild: null,
        classList: {
            add: name => bodyClasses.add(name),
            remove: name => bodyClasses.delete(name),
        },
        insertBefore(element) {
            element.parentNode = body;
            videoDialog = element;
        },
        removeChild(element) {
            if (videoDialog === element) videoDialog = null;
            element.parentNode = null;
        },
    };

    const signalNames = [
        'playing', 'positionUpdate', 'finished', 'canceled', 'stopped',
        'updateDuration', 'error', 'paused', 'bufferedRangesUpdated',
        'buffering', 'stateChanged', 'videoPlaybackActive', 'windowVisible',
        'onVideoRecangleChanged', 'onMetaData', 'volumeChanged',
    ];
    const player = Object.fromEntries(signalNames.map(name => [name, new Signal()]));
    let nativeStops = 0;
    let loads = 0;
    let nextLoadResult = true;
    let lastSeekMilliseconds = null;
    let nativeVolume = 100;
    const volumesAtLoad = [];
    const loadUrls = [];
    Object.assign(player, {
        load(...args) { loads += 1; loadUrls.push(args[0]); volumesAtLoad.push(nativeVolume); args.at(-1)(nextLoadResult); },
        stop() { nativeStops += 1; player.stopped.emit(); },
        seekTo(milliseconds) { lastSeekMilliseconds = milliseconds; },
        getPosition() { return Promise.resolve(23456); },
        setVideoRectangle() {},
        setVolume(value) { nativeVolume = value; },
        setPlaybackRate() {},
        notifyRateChange() {},
        setSubtitleStream() {},
        setAudioStream() {},
        setSubtitleDelay() {},
    });

    let windowBegins = 0;
    let windowEnds = 0;
    const fullscreenRequests = [];
    const windowActions = [];
    const windowApi = {
        beginPlaybackSession() { windowBegins += 1; windowActions.push('begin'); },
        endPlaybackSession() { windowEnds += 1; windowActions.push('end'); },
        requestPlaybackFullScreen() {
            fullscreenRequests.push(true);
            windowActions.push('playback-fullscreen');
        },
        setFullScreen() {
            assert.fail('playback must route fullscreen through the native playback window owner');
        },
    };
    const triggered = [];
    const loading = {showCount: 0, hideCount: 0, show() { this.showCount += 1; }, hide() { this.hideCount += 1; }};
    const context = {
        console,
        URL,
        Date: {now: () => now},
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, callback);
            timerDelays.set(id, delay);
            return id;
        },
        clearTimeout(id) { timers.delete(id); timerDelays.delete(id); },
        document: {
            body,
            querySelector(selector) { return selector === '.videoPlayerContainer' ? videoDialog : null; },
            createElement() { return makeElement(); },
            webkitIsFullScreen: false,
        },
        window: {
            api: {player, window: windowApi},
            jmpInfo: null,
        },
        jmpInfo: {
            userAgent: 'Tigerest lifecycle test',
            settings: {mpv: {enableUosc: true}, video: {default_playback_speed: 1}},
            settingsDescriptions: {video: []},
        },
    };
    context.window.jmpInfo = context.jmpInfo;
    vm.createContext(context);
    const source = fs.readFileSync(path.join(__dirname, '..', 'native', 'mpvVideoPlayer.js'), 'utf8');
    vm.runInContext(source, context, {filename: 'mpvVideoPlayer.js'});

    const Player = context.window._mpvVideoPlayer;
    const savedSettings = new Map([['volume', 0.28]]);
    // Jellyfin's playback manager (10.11 and 12.2 bundles) ignores the stop
    // info: its 'stopped' handler queues the next item whenever its own
    // _playNextAfterEnded flag is set and the stop is not an error string.
    // Only its stop()/onAppClose() clear the flag; each playback start sets it.
    const jellyfin = {_playNextAfterEnded: true, nextItems: 0};
    const instance = new Player({
        events: {trigger(target, name, args) {
            triggered.push({target, name, args});
            if (name === 'stopped' && jellyfin._playNextAfterEnded && typeof args?.[0] !== 'string') jellyfin.nextItems++;
        }},
        playbackManager: jellyfin,
        loading,
        appRouter: {showVideoOsd() {}},
        globalize: {translate(value) { return value; }},
        appHost: {},
        appSettings: {get(key) { return savedSettings.get(key); }, set(key, value) { savedSettings.set(key, value); }},
        confirm: async () => { throw new Error('declined'); },
        dashboard: {default: {setBackdropTransparency() {}}},
        connectionManager: {
            getApiClient(id) {
                return id === 'lifecycle-server'
                    ? {serverAddress: () => 'http://127.0.0.1', accessToken: () => 'lifecycle-token'} : null;
            },
        },
    });
    const options = {
        url: 'http://127.0.0.1/video.mkv',
        fullscreen: true,
        playerStartPositionTicks: 0,
        item: {Name: 'Lifecycle test', ServerId: 'lifecycle-server'},
        mediaSource: {DefaultSubtitleStreamIndex: null, DefaultAudioStreamIndex: 0, MediaStreams: []},
    };

    await instance.play(options);
    assert.ok(Math.abs(volumesAtLoad[0] - 28) < 1e-8,
        'remembered volume must be restored before autoplay can emit its first audio');
    assert.strictEqual(loads, 1);
    assert.strictEqual(loadUrls[0], 'http://127.0.0.1/video.mkv?api_key=lifecycle-token',
        'a same-server stream without credentials must reach the native player with the session token');
    assert.strictEqual(instance._currentSrc, 'http://127.0.0.1/video.mkv',
        'the web player must keep the server URL without the token');
    assert.strictEqual(windowBegins, 1);
    assert.deepStrictEqual(windowActions.slice(0, 2), ['begin', 'playback-fullscreen'],
        'fullscreen playback must snapshot the window session before entering native fullscreen');
    assert.deepStrictEqual(fullscreenRequests, [true],
        'an explicit fullscreen playback request did not enter system fullscreen');
    assert.strictEqual(timers.size, 1, 'startup watchdog was not armed');
    for (const name of signalNames)
        assert.strictEqual(player[name].handlers.size, 1, `${name} was not connected exactly once`);

    instance.onPlaying();
    nativeVolume = 23.5; // UOSC modifies the native core before sending its observation.
    player.volumeChanged.emit(23.5);
    assert.strictEqual(instance.getVolume(), 23.5, 'UOSC volume did not reach the web player');
    assert.strictEqual(savedSettings.get('volume'), 0.235, 'UOSC volume was not persisted');
    const volumeEvents = triggered.filter(event => event.name === 'volumechange').length;
    player.volumeChanged.emit(NaN);
    player.volumeChanged.emit(-1);
    assert.strictEqual(instance.getVolume(), 23.5, 'invalid native volume changed the remembered value');
    assert.strictEqual(triggered.filter(event => event.name === 'volumechange').length, volumeEvents);
    assert.strictEqual(timers.size, 0, 'startup watchdog was not cleared by playing');
    player.positionUpdate.emit(12345);
    player.updateDuration.emit(90000);
    assert.strictEqual(instance.currentTime(), 12345, 'Emby player position must remain in milliseconds');
    assert.strictEqual(instance.duration(), 90000, 'Emby player duration must remain in milliseconds');
    assert.strictEqual(instance.currentTime() * 10000, 123450000,
        'Emby milliseconds were not convertible to server ticks');
    instance.currentTime(7500);
    assert.strictEqual(lastSeekMilliseconds, 7500, 'Emby seek milliseconds were changed at the native boundary');
    assert.strictEqual(await instance.currentTimeAsync(), 23456,
        'async Emby player position must remain in milliseconds');

    player.canceled.emit();
    assert.strictEqual(triggered.filter(event => event.name === 'stopped').length, 1);
    assert.strictEqual(jellyfin.nextItems, 0, 'native Back/cancel let Jellyfin start the next episode');
    const canceledStop = triggered.filter(event => event.name === 'stopped').at(-1).args[0];
    assert.strictEqual(canceledStop.playNext, false, 'native cancel would auto-play the next queue item');
    assert.strictEqual(canceledStop.resetPlayQueue, true, 'native cancel did not clear the stale play queue');
    assert.strictEqual(nativeStops, 0, 'native cancel issued a duplicate stop during signal cleanup');
    assert.strictEqual(windowEnds, 1);
    assert.strictEqual(videoDialog, null);
    player.canceled.emit();
    assert.strictEqual(triggered.filter(event => event.name === 'stopped').length, 1, 'cancel cleanup was not idempotent');

    jellyfin._playNextAfterEnded = true; // Jellyfin's playback start
    await instance.play(options);
    assert.strictEqual(volumesAtLoad[1], 23.5, 'switching episodes restored an older louder volume');
    assert.strictEqual(loads, 2);
    assert.strictEqual(windowBegins, 2);
    for (const name of signalNames)
        assert.strictEqual(player[name].handlers.size, 1, `${name} accumulated a duplicate connection`);

    player.finished.emit();
    assert.strictEqual(triggered.filter(event => event.name === 'stopped').length, 2);
    const naturalStop = triggered.filter(event => event.name === 'stopped').at(-1).args[0];
    assert.strictEqual(naturalStop.playNext, undefined, 'natural completion no longer advances the queue');
    assert.strictEqual(jellyfin.nextItems, 1, 'natural completion must still let Jellyfin play the next episode');
    assert.strictEqual(nativeStops, 0, 'natural completion issued a duplicate stop during signal cleanup');
    assert.strictEqual(windowEnds, 2, 'natural completion did not end the window session');
    assert.strictEqual(videoDialog, null, 'natural completion left the media container mounted');
    nativeVolume = 0;
    player.volumeChanged.emit(0);
    assert.strictEqual(savedSettings.get('volume'), 0, 'zero volume was not persisted');

    await instance.play(options);
    assert.strictEqual(volumesAtLoad[2], 0, 'zero volume was treated as an absent setting');
    instance.onPlaying();
    assert.strictEqual(nativeVolume, 0, 'playing restored full volume over remembered silence');
    assert.strictEqual(loads, 3);
    assert.strictEqual(windowBegins, 3);
    await instance.stop(false);
    assert.strictEqual(nativeStops, 1);
    const explicitStop = triggered.filter(event => event.name === 'stopped').at(-1).args[0];
    assert.strictEqual(explicitStop.playNext, false, 'explicit stop would auto-play the next queue item');
    assert.strictEqual(explicitStop.resetPlayQueue, true, 'explicit stop did not clear the stale play queue');
    assert.strictEqual(windowEnds, 3, 'stop(false) did not end the window session');
    assert.strictEqual(videoDialog, null, 'stop(false) left the media container mounted');

    await instance.play(options);
    const timeoutCallback = [...timers.values()][0];
    timeoutCallback();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(windowEnds, 4, 'startup timeout did not end the window session');
    assert.strictEqual(videoDialog, null, 'startup timeout left the media container mounted');
    assert.strictEqual(nativeStops, 2, 'startup timeout did not stop native playback exactly once');

    nextLoadResult = false;
    await assert.rejects(instance.play(options), /mpv/);
    nextLoadResult = true;
    assert.strictEqual(windowEnds, 5, 'load-command error did not end the window session');
    assert.strictEqual(videoDialog, null, 'load-command error left the media container mounted');
    assert.strictEqual(nativeStops, 3, 'load-command error did not stop native playback exactly once');

    for (let cycle = 0; cycle < 10; cycle += 1) {
        await instance.play(options);
        instance.onPlaying();
        await instance.stop(false);
        for (const name of signalNames)
            assert.strictEqual(player[name].handlers.size, 1, `${name} accumulated during replay cycle ${cycle + 1}`);
    }
    assert.strictEqual(loads, 15, 'ten immediate replay cycles did not all load');
    assert.strictEqual(nativeStops, 13, 'ten immediate replay cycles did not stop exactly once each');
    assert.strictEqual(windowBegins, 15);
    assert.strictEqual(windowEnds, 15);

    await instance.play(options);
    assert.strictEqual(loads, 16);
    assert.strictEqual(windowBegins, 16);

    await instance.stop(true);
    assert.strictEqual(nativeStops, 14, 'stop/destroy called native stop more than once per session');
    assert.strictEqual(windowEnds, 16);
    for (const name of signalNames)
        assert.strictEqual(player[name].handlers.size, 0, `${name} was not disconnected`);

    assert.strictEqual(fullscreenRequests.length, 16,
        'each explicit fullscreen playback session must request native fullscreen');
    assert.ok(fullscreenRequests.every(value => value === true),
        'native fullscreen was requested with a value other than true');

    const nonFullscreenInstance = new Player({
        events: {trigger(target, name, args) { triggered.push({target, name, args}); }},
        loading,
        appRouter: {showVideoOsd() {}},
        globalize: {translate(value) { return value; }},
        appHost: {},
        appSettings: {get(key) { return savedSettings.get(key); }, set(key, value) { savedSettings.set(key, value); }},
        confirm: async () => { throw new Error('declined'); },
        dashboard: {default: {setBackdropTransparency() {}}},
    });
    const fullscreenCountBeforeWindowedPlayback = fullscreenRequests.length;
    await nonFullscreenInstance.play({...options, fullscreen: false});
    assert.strictEqual(nativeVolume, 0, 'a new player session lost the persisted zero volume');
    nonFullscreenInstance.setVolume(0);
    assert.strictEqual(savedSettings.get('volume'), 0, 'web volume controls cannot save zero');
    assert.strictEqual(fullscreenRequests.length, fullscreenCountBeforeWindowedPlayback,
        'fullscreen=false unexpectedly requested system fullscreen');
    await nonFullscreenInstance.stop(false);

    await nonFullscreenInstance.play({...options, fullscreen: 'true'});
    assert.strictEqual(fullscreenRequests.length, fullscreenCountBeforeWindowedPlayback,
        'a truthy non-boolean fullscreen value unexpectedly requested system fullscreen');
    await nonFullscreenInstance.stop(true);

    const flush = () => new Promise(resolve => setImmediate(resolve));
    async function fireNextTimer() {
        const [id, callback] = timers.entries().next().value;
        now += timerDelays.get(id);
        timers.delete(id);
        timerDelays.delete(id);
        callback();
        await flush();
    }
    // A real native preparation hold may exceed the ordinary 30-second startup
    // window. It must not be stopped or replaced with a transcode retry.
    const preparationInstance = nonFullscreenInstance;
    player.rifeExtensionStatus = async () => ({runtime: {
        startupWaiting: true, enginePreparing: true, preparingForItem: true,
        preparationElapsedMs: 30000,
    }});
    await preparationInstance.play(options);
    const stopsBeforePreparation = nativeStops;
    await fireNextTimer();
    assert.strictEqual(nativeStops, stopsBeforePreparation,
        'the startup watchdog aborted a valid native RIFE preparation hold');
    assert.ok(videoDialog, 'preparation removed the playback surface');
    assert.strictEqual(timers.size, 1, 'preparation lost its bounded startup watchdog');
    await fireNextTimer();
    assert.strictEqual(nativeStops, stopsBeforePreparation, 'a preparation recheck aborted the same item');
    preparationInstance.onPlaying();
    assert.strictEqual(timers.size, 0, 'successful preparation left a watchdog armed');
    await preparationInstance.stop(false);

    // Explicit pause is a user state, including when the engine becomes ready
    // while paused. It is never an unresponsive autoplay attempt.
    await preparationInstance.play(options);
    const stopsBeforePause = nativeStops;
    player.paused.emit();
    assert.strictEqual(timers.size, 0, 'explicit pause left the autoplay watchdog armed');
    assert.strictEqual(nativeStops, stopsBeforePause);
    await preparationInstance.stop(false);

    for (const runtime of [
        {startupWaiting: false, preparationElapsedMs: 30000},
        {startupWaiting: true, preparationElapsedMs: NaN},
        {startupWaiting: true, preparationElapsedMs: -1},
        {startupWaiting: true, preparationElapsedMs: 1000000},
    ]) {
        player.rifeExtensionStatus = async () => ({runtime});
        await preparationInstance.play(options);
        const stopsBeforeInvalidStatus = nativeStops;
        await fireNextTimer();
        assert.strictEqual(nativeStops, stopsBeforeInvalidStatus + 1,
            'absent, invalid or expired native preparation suppressed startup failure');
        assert.strictEqual(timers.size, 0);
    }

    player.rifeExtensionStatus = async () => { throw new Error('native status unavailable'); };
    await preparationInstance.play(options);
    const stopsBeforeRejection = nativeStops;
    await fireNextTimer();
    assert.strictEqual(nativeStops, stopsBeforeRejection + 1, 'status rejection disabled startup protection');

    let finishStatus;
    player.rifeExtensionStatus = () => new Promise(resolve => { finishStatus = resolve; });
    await preparationInstance.play(options);
    const stopsBeforeHungStatus = nativeStops;
    await fireNextTimer();
    assert.strictEqual(nativeStops, stopsBeforeHungStatus);
    assert.strictEqual(timers.size, 1, 'an unresponsive native bridge has no deadline');
    await fireNextTimer();
    assert.strictEqual(nativeStops, stopsBeforeHungStatus + 1, 'an unresponsive bridge hung autoplay forever');
    finishStatus({runtime: {startupWaiting: true, preparationElapsedMs: 30000}});
    await flush();
    assert.strictEqual(timers.size, 0, 'late native status resurrected failed playback');

    // A frozen native main thread answers late; its queued load starts right
    // after. Wait for it instead of stopping it, then report a real timeout.
    const faults = [];
    context.window.TigerestFaultReports = {record: fault => faults.push(fault), setPlayback() {}};
    player.rifeExtensionStatus = () => new Promise(resolve => { finishStatus = resolve; });
    await preparationInstance.play(options);
    const stopsBeforeFrozen = nativeStops;
    await fireNextTimer();
    now += 29000;
    finishStatus({runtime: {startupWaiting: false, preparationElapsedMs: 0}});
    await flush();
    assert.strictEqual(nativeStops, stopsBeforeFrozen, 'a late native answer stopped a load that had just resumed');
    assert.strictEqual(timers.size, 1, 'the resumed load has no bounded grace period');
    assert.strictEqual(faults.length, 0, 'a recovered startup was reported as a timeout');
    player.rifeExtensionStatus = async () => ({runtime: {startupWaiting: false, preparationElapsedMs: 0}});
    await fireNextTimer();
    assert.strictEqual(nativeStops, stopsBeforeFrozen + 1, 'the grace period never ends');
    assert.strictEqual(faults.length, 1, 'a startup timeout was not reported');
    assert.strictEqual(faults[0].kind, 'startup-timeout');
    assert.ok(faults[0].nativeDelayMs >= 29000, 'the report omits how long the native side was silent');
    player.rifeExtensionStatus = () => new Promise(resolve => { finishStatus = resolve; });
    await preparationInstance.play(options);
    await fireNextTimer();
    now += 5000;
    finishStatus({runtime: {startupWaiting: false, preparationElapsedMs: 0}});
    await flush();
    preparationInstance.onPlaying();
    assert.strictEqual(timers.size, 0, 'playback after a late answer left a watchdog armed');
    assert.strictEqual(faults.length, 1, 'a load that started after the freeze was reported');
    await preparationInstance.stop(false);
    delete context.window.TigerestFaultReports;

    await preparationInstance.play(options);
    await fireNextTimer();
    const oldStatus = finishStatus;
    await preparationInstance.stop(false);
    await preparationInstance.play(options);
    const currentTimer = [...timers.keys()][0];
    const stopsBeforeLateStatus = nativeStops;
    oldStatus({runtime: {startupWaiting: false, preparationElapsedMs: 0}});
    await flush();
    assert.strictEqual(nativeStops, stopsBeforeLateStatus, 'stale native status stopped a replacement item');
    assert.deepStrictEqual([...timers.keys()], [currentTimer], 'stale status changed the new startup watchdog');
    await preparationInstance.stop(false);

    // A cold server: the moov-at-end MP4 opens in 11 s, the resume seek shows
    // the first frame at 28.5 s and mpv refills its cache past the deadline.
    async function fireTimerAt(time) {
        const [id, callback] = timers.entries().next().value;
        now = time;
        timers.delete(id);
        timerDelays.delete(id);
        callback();
        await flush();
    }
    player.rifeExtensionStatus = async () => ({runtime: {startupWaiting: false, preparationElapsedMs: 0}});
    await preparationInstance.play(options);
    const slowStart = now;
    const stopsBeforeSlowStart = nativeStops;
    now = slowStart + 28500;
    player.buffering.emit(0);
    player.buffering.emit(3);
    player.buffering.emit(48);
    await fireTimerAt(slowStart + 30000);
    assert.strictEqual(nativeStops, stopsBeforeSlowStart, 'the startup watchdog stopped a filling cache');
    assert.deepStrictEqual([...timerDelays.values()], [10000], 'a filling cache was not rechecked');
    now = slowStart + 35000;
    player.buffering.emit(60);
    await fireTimerAt(slowStart + 40000);
    assert.strictEqual(nativeStops, stopsBeforeSlowStart, 'continued cache progress was stopped');
    await fireTimerAt(slowStart + 50000);
    assert.strictEqual(nativeStops, stopsBeforeSlowStart + 1, 'a cache that stopped filling never timed out');
    assert.strictEqual(timers.size, 0);

    // Progress belongs to one session: the next load starts from 0 %.
    await preparationInstance.play(options);
    const nextStart = now;
    now = nextStart + 29000;
    player.buffering.emit(5);
    await fireTimerAt(nextStart + 30000);
    assert.strictEqual(nativeStops, stopsBeforeSlowStart + 1, 'cache progress of the new load was ignored');
    preparationInstance.onPlaying();
    assert.strictEqual(timers.size, 0, 'playing after a slow start left a watchdog armed');
    await preparationInstance.stop(false);
    await preparationInstance.play(options);
    const repeatStart = now;
    await fireTimerAt(repeatStart + 30000);
    assert.strictEqual(nativeStops, stopsBeforeSlowStart + 3,
        'old cache progress kept a new load without progress alive');

    player.rifeExtensionStatus = async () => ({runtime: {startupWaiting: true, preparationElapsedMs: 30000}});
    await preparationInstance.play(options);
    const stopsBeforeStuckPreparation = nativeStops;
    await fireNextTimer();
    now += 1000000;
    await fireNextTimer();
    assert.strictEqual(nativeStops, stopsBeforeStuckPreparation + 1,
        'a stale native elapsed value allowed an unlimited preparation hold');
    await preparationInstance.stop(true);

    // Emby unbinds its stopped handler, awaits stop(false), then rebinds and
    // loads the selected episode. Resolving early lets an old cancel end it.
    for (const android of [true, false]) {
        context.window.api.system = {isAndroid: android};
        let finishNativeStop, completed = false;
        player.stop = () => android ? new Promise(resolve => {finishNativeStop = resolve;}) : undefined;
        await preparationInstance.play(options);
        const stopped = preparationInstance.stop(false).then(() => {completed = true;});
        await flush();
        assert.strictEqual(completed, false, `${android ? 'Android' : 'desktop'} stop resolved before native completion`);
        player.canceled.emit();
        player.stopped.emit();
        finishNativeStop?.(true);
        await stopped;
        await preparationInstance.play(options);
        assert.strictEqual(preparationInstance._sessionActive, true, 'old stop ended the selected episode');
        player.finished.emit();
    }
    preparationInstance.destroy();

    // Native END_FILE_ERROR ends playback without emitting stopped on desktop.
    // It must not arm a stop barrier that prevents every later play request.
    context.window.api.system = {isAndroid:false};
    player.stop = () => assert.fail('native error already ended the file; do not stop the idle core again');
    await preparationInstance.play(options);
    player.error.emit('unplayable URL');
    await flush();
    assert.strictEqual(preparationInstance._nativeStopPromise, null);
    await preparationInstance.play(options);
    assert.strictEqual(preparationInstance._sessionActive,true,'a native error permanently blocked playback recovery');
    player.finished.emit();
    preparationInstance.destroy();

    const idleInstance = new Player({loading, events:{trigger(){}}, appSettings:{get(){},set(){}},
        dashboard:{default:{setBackdropTransparency(){}}}});
    await idleInstance.stop(true); // A never-started native core has no END_FILE to await.

    player.stop = () => undefined;
    await preparationInstance.play(options);
    const timedStop = preparationInstance.stop(true);
    const rejectedStop = assert.rejects(timedStop,/未能完成停止/);
    await fireNextTimer();
    await rejectedStop;
    for (const name of signalNames) assert.strictEqual(player[name].handlers.size,0,'timeout still releases '+name);
    await assert.rejects(preparationInstance.play(options),/未能完成停止/);
    await preparationInstance.play(options);
    assert.strictEqual(preparationInstance._sessionActive,true,'a failed stop promise is cleared for subsequent recovery');
    player.finished.emit();
    preparationInstance.destroy();

    // Emby 4.10 onPlaybackStopped synchronously destroys the player when
    // playNext:false leaves no next player. Native END_FILE arrives afterward.
    const originalEvents = preparationInstance.events;
    preparationInstance.events = {
        trigger(target, name, args) {
            originalEvents.trigger(target, name, args);
            if (name === 'stopped') target.destroy();
        },
    };
    for (const completionSignal of ['stopped', 'error', 'finished']) {
        player.stop = () => undefined;
        await preparationInstance.play(options);
        let completed = false;
        const stopped = preparationInstance.stop(true).then(() => {completed = true;});
        await flush();
        assert.strictEqual(completed, false, 'SDK cleanup cannot acknowledge native completion');
        assert.strictEqual(player.stopped.handlers.size, 1,
            'SDK destroy removed the independent native stop completion listener');
        assert.strictEqual(player.error.handlers.size, 1,
            'SDK destroy removed the independent native error completion listener');
        for (const name of signalNames.filter(name => name !== 'stopped' && name !== 'error'))
            assert.strictEqual(player[name].handlers.size, 0, 'SDK destroy still releases UI signal ' + name);
        const loadsBeforeReplay = loads;
        const replay = preparationInstance.play(options);
        await flush();
        assert.strictEqual(loads, loadsBeforeReplay, 'a new play bypassed the pending native stop');
        player[completionSignal].emit('native file ended');
        if (completionSignal === 'finished') {
            // PlayerComponent emits finished then stopped for native EOF.
            await flush();
            assert.strictEqual(completed, false, 'EOF bypassed the native stopped completion barrier');
            assert.strictEqual(loads, loadsBeforeReplay, 'EOF started replacement before native stopped');
            player.stopped.emit();
        }
        await stopped;
        await replay;
        assert.strictEqual(completed, true, completionSignal + ' did not settle stop after SDK destroy');
        assert.strictEqual(preparationInstance._sessionActive, true, 'SDK cleanup blocked subsequent playback');
        for (const name of signalNames)
            assert.strictEqual(player[name].handlers.size, 1, 'completion leaked a temporary ' + name + ' connection');
        player.finished.emit();
        for (const name of signalNames)
            assert.strictEqual(player[name].handlers.size, 0, 'SDK final cleanup leaked ' + name);
        assert.strictEqual(timers.size, 0, 'native completion retained a stop timeout');
    }

    // A command error and a missing END_FILE also release their private
    // listeners, even though SDK destruction already removed ordinary ones.
    player.stop = () => { throw new Error('native stop command rejected'); };
    await preparationInstance.play(options);
    await assert.rejects(preparationInstance.stop(true), /native stop command rejected/);
    for (const name of signalNames)
        assert.strictEqual(player[name].handlers.size, 0, 'command error leaked ' + name);
    assert.strictEqual(timers.size, 0, 'command error retained the stop timeout');
    await assert.rejects(preparationInstance.play(options), /native stop command rejected/);
    player.stop = () => undefined;
    await preparationInstance.play(options);
    const destroyedTimeout = preparationInstance.stop(true);
    const destroyedRejected = assert.rejects(destroyedTimeout, /未能完成停止/);
    await fireNextTimer();
    await destroyedRejected;
    for (const name of signalNames)
        assert.strictEqual(player[name].handlers.size, 0, 'SDK-destroyed timeout leaked ' + name);
    assert.strictEqual(timers.size, 0, 'SDK-destroyed timeout retained its timer');
    preparationInstance.events = originalEvents;

    // Dynamic range for automatic Windows HDR: Emby and Jellyfin fields, and
    // no guess when the server transcodes.
    const range = (video, extra = {}) => instance.tryGetDynamicRange({url: 'http://s/Videos/1/stream.mkv',
        mediaSource: {MediaStreams: [{Type: 'Audio'}, {Type: 'Video', ...video}], ...extra}});
    assert.strictEqual(range({VideoRange: 'HDR', ExtendedVideoType: 'Hdr10'}), 'hdr');
    assert.strictEqual(range({VideoRange: 'SDR', ExtendedVideoType: 'None'}), 'sdr');
    assert.strictEqual(range({ColorTransfer: 'arib-std-b67'}), 'hdr');
    assert.strictEqual(range({VideoRangeType: 'DOVIWithHDR10', DvProfile: 8, DvBlSignalCompatibilityId: 1}), 'hdr');
    assert.strictEqual(range({VideoRangeType: 'DOVIWithHLG'}), 'hdr');
    assert.strictEqual(range({VideoRange: 'HDR', ExtendedVideoType: 'DolbyVision', ExtendedVideoSubType: 'DoviProfile81'}), 'hdr');
    // Without an HDR10/HLG base layer Android must not hand the stream to MediaCodec.
    assert.strictEqual(range({VideoRangeType: 'DOVI', DvProfile: 5, DvBlSignalCompatibilityId: 0}), 'dovi');
    assert.strictEqual(range({VideoRange: 'HDR', ExtendedVideoType: 'DolbyVision', ExtendedVideoSubType: 'DoviProfile50'}), 'dovi');
    assert.strictEqual(range({VideoRangeType: 'DOVIWithSDR'}), 'dovi');
    assert.strictEqual(range({VideoRangeType: 'SDR', ColorTransfer: 'bt709'}), 'sdr');
    assert.strictEqual(range({VideoRange: 'HDR'}, {TranscodingUrl: '/videos/1/master.m3u8'}), '');
    assert.strictEqual(instance.tryGetDynamicRange({mediaSource: {MediaStreams: [{Type: 'Audio'}]}}), '');

    console.log('player lifecycle: all checks passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
