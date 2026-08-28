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
        'onVideoRecangleChanged', 'onMetaData',
    ];
    const player = Object.fromEntries(signalNames.map(name => [name, new Signal()]));
    let nativeStops = 0;
    let loads = 0;
    let nextLoadResult = true;
    Object.assign(player, {
        load(...args) { loads += 1; args.at(-1)(nextLoadResult); },
        stop() { nativeStops += 1; },
        setVideoRectangle() {},
        setVolume() {},
        setPlaybackRate() {},
        notifyRateChange() {},
        setSubtitleStream() {},
        setAudioStream() {},
        setSubtitleDelay() {},
    });

    let windowBegins = 0;
    let windowEnds = 0;
    const windowApi = {
        beginPlaybackSession() { windowBegins += 1; },
        endPlaybackSession() { windowEnds += 1; },
    };
    const triggered = [];
    const loading = {showCount: 0, hideCount: 0, show() { this.showCount += 1; }, hide() { this.hideCount += 1; }};
    const context = {
        console,
        URL,
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
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
    const instance = new Player({
        events: {trigger(target, name, args) { triggered.push({target, name, args}); }},
        loading,
        appRouter: {showVideoOsd() {}},
        globalize: {translate(value) { return value; }},
        appHost: {},
        appSettings: {get() { return 1; }, set() {}},
        confirm: async () => { throw new Error('declined'); },
        dashboard: {default: {setBackdropTransparency() {}}},
    });
    const options = {
        url: 'http://127.0.0.1/video.mkv',
        fullscreen: true,
        playerStartPositionTicks: 0,
        item: {Name: 'Lifecycle test'},
        mediaSource: {DefaultSubtitleStreamIndex: null, DefaultAudioStreamIndex: 0, MediaStreams: []},
    };

    await instance.play(options);
    assert.strictEqual(loads, 1);
    assert.strictEqual(windowBegins, 1);
    assert.strictEqual(timers.size, 1, 'startup watchdog was not armed');
    for (const name of signalNames)
        assert.strictEqual(player[name].handlers.size, 1, `${name} was not connected exactly once`);

    instance.onPlaying();
    assert.strictEqual(timers.size, 0, 'startup watchdog was not cleared by playing');

    player.canceled.emit();
    assert.strictEqual(triggered.filter(event => event.name === 'stopped').length, 1);
    const canceledStop = triggered.filter(event => event.name === 'stopped').at(-1).args[0];
    assert.strictEqual(canceledStop.playNext, false, 'native cancel would auto-play the next queue item');
    assert.strictEqual(canceledStop.resetPlayQueue, true, 'native cancel did not clear the stale play queue');
    assert.strictEqual(windowEnds, 1);
    assert.strictEqual(videoDialog, null);
    player.canceled.emit();
    assert.strictEqual(triggered.filter(event => event.name === 'stopped').length, 1, 'cancel cleanup was not idempotent');

    await instance.play(options);
    assert.strictEqual(loads, 2);
    assert.strictEqual(windowBegins, 2);
    for (const name of signalNames)
        assert.strictEqual(player[name].handlers.size, 1, `${name} accumulated a duplicate connection`);

    player.finished.emit();
    assert.strictEqual(triggered.filter(event => event.name === 'stopped').length, 2);
    const naturalStop = triggered.filter(event => event.name === 'stopped').at(-1).args[0];
    assert.strictEqual(naturalStop.playNext, undefined, 'natural completion no longer advances the queue');
    assert.strictEqual(windowEnds, 2, 'natural completion did not end the window session');
    assert.strictEqual(videoDialog, null, 'natural completion left the media container mounted');

    await instance.play(options);
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

    console.log('player lifecycle: all checks passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
