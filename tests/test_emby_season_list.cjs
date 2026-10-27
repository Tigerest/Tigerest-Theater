// A lone queued episode offers the rest of its season in the native episode list.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Signal {
    constructor() { this.handlers = new Set(); }
    connect(fn) { this.handlers.add(fn); }
    disconnect(fn) { this.handlers.delete(fn); }
    emit(...args) { for (const fn of this.handlers) fn(...args); }
}
const settle = () => new Promise(r => setImmediate(r));
const episode = (id, n, season = 'season1', extra = {}) => ({Id: id, Name: 'Episode ' + n, IndexNumber: n, ParentIndexNumber: 1,
    Type: 'Episode', SeriesId: 'series', SeasonId: season, ServerId: 'server', ...extra});
(async () => {
    const sources = new Map(), snapshots = [], queueStates = [], plays = [], commands = [], requests = [], intervals = new Map();
    let playlist = [{...episode('e2', 2), PlaylistItemId: 'playlistItem0'}], current = 'playlistItem0', timer = 0;
    const seasons = {
        season1: [episode('e1', 1), episode('e2', 2), episode('e3', 3), episode('e4', 4, 'season1', {LocationType: 'Virtual'})],
        season2: [episode('f1', 1, 'season2'), episode('f2', 2, 'season2')],
    };
    const manager = {
        _currentPlayer: {id: 'native'},
        _playQueueManager: {getPlaylist: () => playlist, getCurrentPlaylistIndex: () => playlist.findIndex(item => item.PlaylistItemId === current)},
        getCurrentPlaylistItemId: () => current, getPlayerState: () => ({NowPlayingItem: {MediaType: 'Video'}}),
        currentTime: () => 0, duration: () => 100000000,
        setCurrentPlaylistItem: id => { plays.push(['queue', id]); return Promise.resolve(); },
        play: options => { plays.push(['play', JSON.parse(JSON.stringify(options))]); return Promise.resolve(); },
        previousTrack: () => commands.push('previousTrack'),
        isPlayingAudio: () => false,
    };
    const apiClient = {
        getCurrentUserId: () => 'user',
        getEpisodes: (seriesId, query) => {
            requests.push([seriesId, JSON.parse(JSON.stringify(query))]);
            return Promise.resolve({Items: seasons[query.SeasonId]});
        },
    };
    const api = {
        system: {hello() {}},
        player: new Proxy({streamingBitrateRequested: new Signal(), playbackRateChanged: new Signal(),
            setWebPlaylist: (list, id) => snapshots.push({ids: list.map(item => item.PlaylistItemId), names: list.map(item => item.Name), id}),
            notifyQueueChange: (next, previous) => queueStates.push([next, previous])}, {get: (target, key) => target[key] || (() => {})}),
        input: {hostInput: new Signal(), volumeChanged: new Signal(), rateChanged: new Signal(), positionSeek: new Signal()},
    };
    const events = {
        on(source, event, fn) { if (!sources.has(source)) sources.set(source, new Map()); sources.get(source).set(event, fn); },
        off() {}, trigger(source, event, ...args) { sources.get(source)?.get(event)?.({}, ...args); },
    };
    const sandbox = {console, Promise, Number, Object, setInterval: fn => { intervals.set(++timer, fn); return timer; }, clearInterval: id => intervals.delete(id),
        window: {api, apiPromise: Promise.resolve(api), Events: events, jmpInfo: {settings: {main: {fullscreen: false}}, settingsUpdate: []}}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../native/inputPlugin.js'), 'utf8'), sandbox);
    const plugin = new sandbox.window._inputPlugin({inputManager: {handleCommand: command => commands.push(command)}, playbackManager: manager,
        connectionManager: {getApiClient: item => item.ServerId === 'server' ? apiClient : null}});
    await settle();

    events.trigger(manager, 'playbackstart', manager._currentPlayer);
    assert.deepEqual(snapshots[0].ids, ['playlistItem0'], 'the Emby queue is published at once');
    await settle();
    assert.deepEqual(requests, [['series', {UserId: 'user', IsMissing: false, IsVirtualUnaired: false, SeasonId: 'season1'}]],
        'the season is read once for its own series');
    assert.deepEqual(snapshots.at(-1), {ids: ['season-episode:e1', 'playlistItem0', 'season-episode:e3'],
        names: ['Episode 1', 'Episode 2', 'Episode 3'], id: 'playlistItem0'}, 'the list offers the season, virtual episodes left out');
    assert.deepEqual(queueStates.at(-1), [true, true], 'taskbar and media keys see a previous and a next episode');

    const published = snapshots.length;
    events.trigger(manager._currentPlayer, 'playing');
    [...intervals.values()].forEach(poll => poll());
    await settle();
    assert.equal(requests.length, 1, 'polls reuse the season already read');
    assert.equal(snapshots.length, published + 1, 'only the forced sync on playing republishes the list');

    api.input.hostInput.emit(['playlist-item:season-episode:e3', 'playlist-item:season-episode:missing', 'playlist-item:playlistItem0']);
    await settle();
    assert.deepEqual(plays, [['play', {ids: ['e3'], serverId: 'server', fullscreen: true}], ['queue', 'playlistItem0']],
        'a season episode starts as a new queue; stale choices are ignored');
    plays.length = 0;
    api.input.hostInput.emit(['next', 'previous']);
    await settle();
    assert.deepEqual(plays.map(([, options]) => options.ids[0]), ['e3', 'e1'], 'next and previous move through the season');
    assert.deepEqual(commands, [], 'Emby does not also step its one-item queue');

    // Emby's own queue takes over once it holds more than the one episode.
    playlist = seasons.season1.slice(0, 3).map((item, i) => ({...item, PlaylistItemId: 'playlistItem' + (i + 1)}));
    current = 'playlistItem3';
    events.trigger(manager, 'playlistitemchange');
    assert.deepEqual(snapshots.at(-1).ids, ['playlistItem1', 'playlistItem2', 'playlistItem3'], 'a full Emby queue is the list');
    assert.deepEqual(queueStates.at(-1), [false, true]);
    plays.length = 0;
    api.input.hostInput.emit(['next', 'previous', 'playlist-item:season-episode:e1']);
    await settle();
    assert.deepEqual(commands, ['next', 'previousTrack'], 'previous / next go back to Emby');
    assert.deepEqual(plays, [], 'season choices no longer apply');

    // Another lone episode in another season reads that season.
    playlist = [{...seasons.season2[1], PlaylistItemId: 'playlistItem9'}];
    current = 'playlistItem9';
    events.trigger(manager, 'playlistitemchange');
    await settle();
    assert.equal(requests.at(-1)[1].SeasonId, 'season2');
    assert.deepEqual(snapshots.at(-1).ids, ['season-episode:f1', 'playlistItem9']);
    assert.deepEqual(queueStates.at(-1), [false, true], 'the last episode has no next');
    commands.length = 0;
    api.input.hostInput.emit(['next']);
    await settle();
    assert.deepEqual(commands, ['next'], 'past the season end Emby decides');

    // A single movie, or an episode missing from its season listing, stays Emby's queue.
    playlist = [{Id: 'movie', PlaylistItemId: 'playlistItem10', Type: 'Movie', ServerId: 'server', Name: 'Movie'}];
    current = 'playlistItem10';
    events.trigger(manager, 'playlistitemchange');
    await settle();
    assert.deepEqual(snapshots.at(-1).ids, ['playlistItem10']);
    playlist = [{...episode('gone', 7, 'season2'), PlaylistItemId: 'playlistItem11'}];
    current = 'playlistItem11';
    events.trigger(manager, 'playlistitemchange');
    await settle();
    assert.deepEqual(snapshots.at(-1).ids, ['playlistItem11']);
    assert.equal(requests.length, 2, 'the season already read is not read again');

    playlist = []; current = '';
    events.trigger(manager, 'playbackstop', {});
    assert.deepEqual(snapshots.at(-1).ids, [], 'stopping clears the list');
    plugin.destroy();
    console.log('PASS: a lone queued episode offers its season');
})().catch(error => { console.error(error); process.exitCode = 1; });
