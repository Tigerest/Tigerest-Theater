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

async function flushPromises() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

async function main() {
    const currentPlayer = {id: 'mpv-player'};
    const calls = [];
    const results = [];
    let switchImplementation = () => Promise.resolve();

    const playbackManager = {
        _currentPlayer: currentPlayer,
        setMaxStreamingBitrate(options, player) {
            calls.push({options, player});
            return switchImplementation(options, player);
        },
    };

    const playerApi = {
        streamingBitrateRequested: new Signal(),
        playbackRateChanged: new Signal(),
        notifyStreamingBitrateResult(bitrate, success, message) {
            results.push({bitrate, success, message});
        },
    };
    const inputApi = {
        hostInput: new Signal(),
        volumeChanged: new Signal(),
        rateChanged: new Signal(),
        positionSeek: new Signal(),
    };
    const api = {
        player: playerApi,
        input: inputApi,
        system: {hello() {}},
    };
    const Events = {on() {}, off() {}, trigger() {}};
    const context = {
        console,
        Promise,
        Number,
        setInterval,
        clearInterval,
        window: {
            api,
            apiPromise: Promise.resolve(api),
            Events,
            playbackManager,
            jmpInfo: {
                settings: {main: {fullscreen: false}},
                settingsUpdate: [],
            },
        },
    };

    vm.createContext(context);
    const source = fs.readFileSync(path.join(__dirname, '..', 'native', 'inputPlugin.js'), 'utf8');
    vm.runInContext(source, context, {filename: 'inputPlugin.js'});
    const Plugin = context.window._inputPlugin;
    const instance = new Plugin({inputManager: {handleCommand() {}}, playbackManager});
    await flushPromises();

    assert.strictEqual(playerApi.streamingBitrateRequested.handlers.size, 1,
        'streaming bitrate bridge was not connected exactly once');

    playerApi.streamingBitrateRequested.emit(15_000_000);
    await flushPromises();
    assert.strictEqual(calls[0].player, currentPlayer);
    assert.strictEqual(calls[0].options.enableAutomaticBitrateDetection, false);
    assert.strictEqual(calls[0].options.maxBitrate, 15_000_000);
    assert.deepStrictEqual(results[0], {bitrate: 15_000_000, success: true, message: ''});

    playerApi.streamingBitrateRequested.emit(0);
    await flushPromises();
    assert.strictEqual(calls[1].options.enableAutomaticBitrateDetection, true);
    assert.strictEqual(calls[1].options.maxBitrate, 0);
    assert.strictEqual(results[1].success, true, 'automatic bitrate request did not complete');

    switchImplementation = () => Promise.reject(new Error('network failed'));
    playerApi.streamingBitrateRequested.emit(8_000_000);
    await flushPromises();
    assert.deepStrictEqual(results[2], {
        bitrate: 8_000_000,
        success: false,
        message: 'network failed',
    });

    let finishDeferred;
    switchImplementation = () => new Promise(resolve => { finishDeferred = resolve; });
    playerApi.streamingBitrateRequested.emit(5_000_000);
    playerApi.streamingBitrateRequested.emit(4_000_000);
    await flushPromises();
    assert.strictEqual(calls.length, 4, 'overlapping request reached Emby playback manager');
    assert.deepStrictEqual(results[3], {
        bitrate: 4_000_000,
        success: false,
        message: '上一次品质切换尚未完成',
    });
    finishDeferred();
    await flushPromises();
    assert.strictEqual(results[4].success, true, 'first deferred quality request did not finish');

    playbackManager._currentPlayer = null;
    playerApi.streamingBitrateRequested.emit(3_000_000);
    await flushPromises();
    assert.strictEqual(results[5].success, false, 'no-player request was reported as successful');
    assert.match(results[5].message, /Emby/);

    instance.destroy();
    assert.strictEqual(playerApi.streamingBitrateRequested.handlers.size, 0,
        'streaming bitrate bridge leaked after plugin destruction');

    console.log('stream quality bridge: all checks passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
