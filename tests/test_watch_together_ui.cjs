// Watch-together room page and playback wiring in the real web engine. The
// watch service, socket, Emby client and player bridge are in-page fixtures;
// no account or network service is used.
const assert = require('node:assert/strict'), path = require('node:path');
const withBrowser = require('./community_browser.cjs');
const version = require('node:fs').readFileSync(path.join(__dirname, '../VERSION'), 'utf8').trim();
const files = ['watchTogetherClient', 'watchTogetherSync', 'watchTogether'];
const routes = Object.fromEntries(files.map(f => ['/' + f + '.js', {path: path.join(__dirname, '../native/' + f + '.js')}]));
// Emby's item page button bar, as in its item.html.
const itemView = '<div class="itemView"><div class="mainDetailButtons"><button class="btnResume hide raised detailButton">继续播放</button>' +
    '<button class="btnPlay btnMainPlay raised detailButton">播放</button><button class="btnPlayTrailer btnPlayTrailer-main raised detailButton">预告片</button>' +
    '<button class="btnSyncDownload hide fab detailButton">下载</button>' +
    '<button class="btnPlaystate fab detailButton">已播放</button><button class="btnMoreCommands fab detailButton">更多</button></div></div>';
routes['/'] = {type: 'text/html', body: '<html><meta charset="utf-8"><div class="headerRight"><button id="tigerest-message-entry">消息</button></div>' + itemView +
    files.map(f => '<script src="/' + f + '.js"></script>').join('') + '</html>'};

const fixture = `(() => {
    window.log = {fetch: [], sent: [], player: [], plays: []};
    window.serverLog = [];
    window.jmpInfo = {version: '${version}'};
    log.errors = [];
    const report = console.error.bind(console);
    console.error = (...args) => { log.errors.push(args.map(x => x?.stack || String(x)).join(' ')); report(...args); };
    window.addEventListener('error', event => log.errors.push(String(event.error?.stack || event.message)));
    window.addEventListener('unhandledrejection', event => log.errors.push(String(event.reason?.stack || event.reason)));
    const signal = () => { const set = new Set(); return {connect: f => set.add(f), disconnect: f => set.delete(f), emit: (...a) => set.forEach(f => f(...a))}; };
    const player = window.api = {player: {}};
    for (const name of ['playing', 'paused', 'positionUpdate', 'finished', 'canceled', 'playbackRateChanged']) api.player[name] = signal();
    for (const name of ['pause', 'play', 'seekTo', 'setPlaybackRate', 'userCommand']) api.player[name] = (...args) => log.player.push(name + ':' + args.join(','));
    const episodes = [1, 2, 3].map(n => ({Id: 'ep' + n, Type: 'Episode', Name: '第 ' + n + ' 集', IndexNumber: n, ParentIndexNumber: 1, SeriesId: 'series', SeasonId: 'season1',
        SeriesName: '兽王武神', MediaSources: [{Id: 'src-ep' + n, Name: '1080p'}], UserData: {PlaybackPositionTicks: 0}}));
    window.emby = {serverId: () => '62526c3bf747439c99327ddec5fed4a8', getCurrentUserId: () => 'u1', accessToken: () => 'fixture-token',
        serverAddress: () => 'http://192.168.5.150:8095',
        // A 1x1 image tagged with the request, so the page keeps it.
        getImageUrl: (id, options) => 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==#' + id + '/' + options.type,
        getItem: async (user, id) => episodes.find(e => e.Id === id) || {Id: id, Type: 'Series', Name: '兽王武神'},
        getSeasons: async () => ({Items: [{Id: 'season1', Name: '第 1 季', IndexNumber: 1}]}),
        getEpisodes: async () => ({Items: episodes}), getItems: async () => ({Items: []}),
        getResumableItems: async () => ({Items: [{...episodes[2], UserData: {PlaybackPositionTicks: 6000000000, PlayedPercentage: 40}}, {Id: 'tv1', Type: 'TvChannel', Name: '频道'}]}),
        getLatestItems: async () => [{Id: 'series', Type: 'Series', Name: '兽王武神', ProductionYear: 2024, ImageTags: {Primary: 'p1', Thumb: 't1'}},
            {Id: 'long', Type: 'Movie', Name: '「凭你也想讨伐魔王？」被勇者小队逐出队伍，只好在王都自在过活', ProductionYear: 2026}]};
    const handlers = new Map();
    window.events = {on: (target, name, f) => handlers.set(name, f), trigger: (name, ...a) => handlers.get(name)?.({}, ...a)};
    window.current = null;
    window.playbackManager = {play: options => { log.plays.push(options); return Promise.resolve(); },
        getCurrentPlayer: () => window.current ? {} : null, isPlaying: () => Boolean(window.current),
        currentItem: () => window.current, currentMediaSource: () => ({Id: 'src-' + window.current?.Id})};
    const snapshot = {roomId: '7e47169f-0801-48bf-9d0a-b113488376ad', code: '7KQ2MZ', capacity: 4, ownerMemberId: 'm1', pendingChange: null,
        media: {itemId: 'ep2', mediaSourceId: 'src-ep2', type: 'Episode', title: '第 2 集', seriesName: '兽王武神', seasonNumber: 1, episodeNumber: 2, runTimeMs: 1440000},
        playback: {revision: 1, state: 'paused', positionMs: 0, serverTime: 1000, rate: 1, waiting: null, lastAction: {type: 'create', memberId: 'm1'}},
        members: [{memberId: 'm1', authorId: 'a1', name: '大河', avatarPath: null, role: 'owner', platform: 'Windows', connection: 'online', status: 'away', lagging: false}]};
    window.snapshot = snapshot;
    const reply = (status, body) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
    window.fetch = async (url, options) => {
        const call = {url, method: options.method, body: options.body ? JSON.parse(options.body) : null, token: options.headers['X-Emby-Token'],
            client: Object.fromEntries(Object.entries(options.headers).filter(([name]) => name.startsWith('X-Tigerest-Client-')))};
        log.fetch.push(call);
        const p = new URL(url).pathname.replace('/watch/v1', '');
        if (p === '/health') return reply(200, {data: {status: 'ok', enabled: true, protocol: 1}});
        if (p === '/me') return reply(200, {data: {author: {id: 'a1', name: '大河'}, capacity: 20, activeRoom: null, features: ['sync']}});
        if (p === '/rooms/join') return reply(404, {error: {code: 'ROOM_NOT_FOUND', message: 'ROOM_NOT_FOUND'}});
        if (p === '/rooms') return reply(201, {data: {room: snapshot, ticket: 'ticket-1', ticketExpiresAt: '2099-01-01T00:00:00Z', replayed: false}});
        if (p.endsWith('/leave')) return reply(200, {data: {left: true}});
        return reply(404, {error: {code: 'NOT_FOUND', message: 'NOT_FOUND'}});
    };
    window.sockets = [];
    window.WebSocket = class { constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
        send(text) { log.sent.push(JSON.parse(text)); } close() { this.readyState = 3; }
        deliver(data) { this.onmessage?.({data: JSON.stringify(data)}); } };
    // Server timeline = page clock + 1e6.
    window.serve = () => {
        const socket = sockets.at(-1);
        for (const message of log.sent.splice(0)) {
            if (message.type === 'ping') socket.deliver({type: 'pong', id: message.id, t0: message.t0, serverReceive: message.t0 + 1e6, serverSend: message.t0 + 1e6});
            else serverLog.push(message);
        }
    };
    window.serverPump = setInterval(serve, 20);
    window.plugin = new _watchTogetherPlugin({connectionManager: {currentApiClient: () => emby}, events, playbackManager, appRouter: {}});
})()`;

withBrowser(routes, async ({evaluate}) => {
    const wait = async (expression, label = expression) => {
        for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 50)); }
        throw Error('Timed out: ' + label + ' | page: ' + await evaluate(`(document.querySelector('#tigerest-watch')?.textContent || '').slice(0, 300) + ' | ' + JSON.stringify(log.fetch.map(c => c.method + ' ' + c.url)).slice(-400) + ' | errors: ' + log.errors.join(' // ').slice(0, 1200)`));
    };
    const click = text => evaluate(`Array.from(document.querySelectorAll('#tigerest-watch button')).find(b => b.textContent === ${JSON.stringify(text)}).click()`);
    await evaluate(fixture);
    await wait(`!!document.querySelector('#tigerest-watch-entry')`);
    assert.equal(await evaluate(`document.querySelector('#tigerest-watch-entry').nextElementSibling.id`), 'tigerest-message-entry', 'entry sits left of 消息');
    assert.equal(await evaluate(`log.fetch[0].url`), 'http://192.168.5.150:18443/watch/v1/health');

    await evaluate(`document.querySelector('#tigerest-watch-entry').click()`);
    await wait(`!!document.querySelector('#tigerest-watch[open]')`);
    assert.match(await evaluate(`document.querySelector('#tigerest-watch').textContent`), /选择影片并创建[\s\S]*加入房间/);
    assert.match(await evaluate(`document.querySelector('#tigerest-watch').textContent`), /最多 20 人/, 'capacity comes from /me');
    await evaluate(`{ const input = document.querySelector('.tw-code-input'); input.value = 'abc'; input.dispatchEvent(new Event('input')); input.form.requestSubmit(); }`);
    assert.match(await evaluate(`document.querySelector('#tigerest-watch .tw-status').textContent`), /6 位/);
    await evaluate(`{ const input = document.querySelector('.tw-code-input'); input.value = '7kq2mz'; input.dispatchEvent(new Event('input')); input.form.requestSubmit(); }`);
    await wait(`document.querySelector('#tigerest-watch .tw-status').textContent.includes('房间码无效')`);
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(log.fetch.find(c => c.url.endsWith('/rooms/join')).body)`)).code, '7KQ2MZ');

    // From the header the picker starts on suggestion rows.
    await evaluate(`history.replaceState(null, '', '#!/item?id=ep2&serverId=x'); document.querySelector('.tw-primary').click()`);
    await wait(`document.querySelectorAll('#tigerest-watch .tw-shelf:not([hidden])').length === 3`, 'suggestion rows');
    const shelves = `Array.from(document.querySelectorAll('#tigerest-watch .tw-shelf:not([hidden])'))`;
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(${shelves}.map(s => s.querySelector('h3').textContent))`)), ['当前页面', '继续观看', '最近添加']);
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(${shelves}.map(s => Array.from(s.querySelectorAll('.tw-pick'), p => p.textContent)))`)),
        [['兽王武神第1季 第2集'], ['兽王武神第1季 第3集'], ['兽王武神2024', '「凭你也想讨伐魔王？」被勇者小队逐出队伍，只好在王都自在过活2026']], 'full titles; channels are left out');
    // Buttons default to align-items:flex-start; long titles must still stop at the card edge.
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('#tigerest-watch .tw-strip .tw-pick'), p => {
        const card = p.getBoundingClientRect(), text = p.querySelector('.tw-pick-lines').getBoundingClientRect();
        return text.left >= card.left && text.right <= card.right; }))`)), [true, true, true, true], 'titles stay inside their cards');
    assert.ok(await evaluate(`(e => e.scrollWidth > e.clientWidth)(document.querySelectorAll('#tigerest-watch .tw-pick-main')[3])`), 'a long title is cut with an ellipsis');
    assert.equal(await evaluate(`document.querySelectorAll('#tigerest-watch .tw-strip .tw-pick')[3].title`), '「凭你也想讨伐魔王？」被勇者小队逐出队伍，只好在王都自在过活 2026', 'and shown whole on hover');
    assert.equal(await evaluate(`${shelves}[1].querySelector('.tw-progress span').style.width`), '40%');
    assert.match(await evaluate(`${shelves}[2].querySelector('img').src`), /#series\/Thumb$/, 'rows use 16:9 images');
    assert.equal(await evaluate(`document.querySelector('#tigerest-watch .tw-status').textContent`), '');
    await click('返回');
    await wait(`!!document.querySelector('#tigerest-watch .tw-code-input')`, 'back to the lobby');

    // Emby's item page: the entry takes the trailer button's place right after 播放.
    await evaluate(`plugin.close(); document.querySelector('.itemView').dispatchEvent(new CustomEvent('itemshow', {detail: {item: {Id: 'ep2', Type: 'Episode'}}, bubbles: true}))`);
    const bar = `JSON.stringify(Array.from(document.querySelector('.mainDetailButtons').children, b => b.classList.contains('tw-detail-entry') ? '一起看' : b.className.split(' ')[0]))`;
    const order = ['btnResume', 'btnPlay', '一起看', 'btnPlayTrailer', 'btnSyncDownload', 'btnPlaystate', 'btnMoreCommands'];
    assert.deepEqual(JSON.parse(await evaluate(bar)), order);
    assert.equal(await evaluate(`document.querySelector('.tw-detail-entry').textContent`), '一起看', 'a labelled button');
    assert.equal(await evaluate(`document.querySelector('.tw-detail-entry').classList.contains('raised')`), true);
    assert.equal(await evaluate(`document.querySelector('.tw-detail-entry').classList.contains('hide')`), false);
    const trailer = `getComputedStyle(document.querySelector('.btnPlayTrailer')).display`;
    assert.equal(await evaluate(trailer), 'none', 'the trailer button gives way');
    await evaluate(`document.querySelector('.itemView').dispatchEvent(new CustomEvent('itemshow', {detail: {item: {Id: 'box', Type: 'BoxSet'}}, bubbles: true}))`);
    assert.equal(await evaluate(`document.querySelectorAll('.tw-detail-entry').length`), 0, 'only films and shows get the entry');
    assert.notEqual(await evaluate(trailer), 'none', 'without the entry the trailer button is back');
    for (let i = 0; i < 2; i++)
        await evaluate(`document.querySelector('.itemView').dispatchEvent(new CustomEvent('itemshow', {detail: {item: {Id: 'ep2', Type: 'Episode'}}, bubbles: true}))`);
    assert.deepEqual(JSON.parse(await evaluate(bar)), order, 'shown again, once');
    assert.equal(await evaluate(trailer), 'none');

    // Outside a room it creates one with that episode: the season is listed with it chosen.
    await evaluate(`document.querySelector('.tw-detail-entry').click()`);
    await wait(`!!Array.from(document.querySelectorAll('#tigerest-watch button')).find(b => b.textContent === '创建房间')`);
    assert.equal(await evaluate(`document.querySelector('.tw-pick[aria-pressed=true]').textContent`), '第2集', 'a name that repeats the number is not shown twice');
    await evaluate(`Array.from(document.querySelectorAll('#tigerest-watch .tw-pick')).find(p => p.textContent === '第3集').click()`);
    await wait(`document.querySelector('#tigerest-watch .tw-card .tw-film')?.textContent === '兽王武神 第1季 第3集'`, 'another episode');
    assert.equal(await evaluate(`document.querySelectorAll('#tigerest-watch .tw-card').length`), 1, 'one choice at a time');
    await evaluate(`Array.from(document.querySelectorAll('#tigerest-watch .tw-pick')).find(p => p.textContent === '第2集').click()`);
    await wait(`document.querySelector('#tigerest-watch .tw-card .tw-film')?.textContent === '兽王武神 第1季 第2集'`, 'back to episode 2');
    assert.equal(await evaluate(`document.querySelector('.tw-pick[aria-pressed=true]').textContent`), '第2集');
    await click('创建房间');
    await wait(`!!document.querySelector('#tigerest-watch .tw-code')`, 'room view');
    const create = JSON.parse(await evaluate(`JSON.stringify(log.fetch.find(c => c.url.endsWith('/rooms') && c.method === 'POST'))`));
    assert.deepEqual({...create.body, clientRequestId: 'x', clientId: 'x'}, {itemId: 'ep2', mediaSourceId: 'src-ep2', positionMs: 0, clientRequestId: 'x', clientId: 'x', leaveCurrent: false});
    assert.equal(create.token, 'fixture-token');
    assert.deepEqual(create.client, {'X-Tigerest-Client-Name': 'Tigerest Theater', 'X-Tigerest-Client-Version': version, 'X-Tigerest-Client-Platform': 'Windows'});
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(log.fetch.find(c => c.url.endsWith('/rooms/join')).client)`)), {}, 'only a new room reports the client');
    await wait(`sockets.length === 1 && serverLog.some(m => m.type === 'hello')`);
    const hello = JSON.parse(await evaluate(`JSON.stringify(serverLog.find(m => m.type === 'hello'))`));
    assert.deepEqual({...hello, clientId: 'x'}, {type: 'hello', protocol: 1, ticket: 'ticket-1', clientId: 'x', platform: 'Windows', appVersion: version, capabilities: ['sync']});
    assert.equal(hello.clientId, create.body.clientId, 'the same client id binds ticket and hello');
    assert.equal(await evaluate(`sockets[0].url`), 'ws://192.168.5.150:18443/watch/v1/socket');
    await evaluate(`sockets[0].deliver({type: 'welcome', memberId: 'm1', serverTime: 1000, room: snapshot, features: ['sync'], heartbeatSeconds: 5})`);
    await wait(`serverLog.some(m => m.type === 'status' && m.state === 'paused')`, 'room page reports paused');
    assert.match(await evaluate(`document.querySelector('#tigerest-watch').textContent`), /7KQ2MZ[\s\S]*兽王武神第1季 第2集[\s\S]*开始放映/);
    assert.equal(await evaluate(`document.querySelector('#tigerest-watch .tw-film-detail').textContent`), '第1季 第2集');
    assert.match(await evaluate(`document.querySelector('#tigerest-watch .tw-art').src`), /#ep2\/Primary$/, 'the film card shows the episode image');

    await evaluate(`sockets[0].deliver({type: 'members', ownerMemberId: 'm1', members: [...snapshot.members, {memberId: 'm2', authorId: 'a2', name: '朋友', avatarPath: null, role: 'member', platform: 'Android', connection: 'online', status: 'paused', lagging: false}]})`);
    await wait(`document.querySelector('#tigerest-watch').textContent.includes('朋友')`);
    assert.match(await evaluate(`document.querySelector('#tigerest-watch-entry').textContent`), /一起看 · 2人/);
    assert.match(await evaluate(`document.querySelector('#tigerest-watch .tw-status').textContent`), /朋友 加入了房间/);

    // Copying works on the plain-http Emby origin (no navigator.clipboard there).
    await evaluate(`Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true})`);
    await evaluate(`window.copied = []; { const exec = document.execCommand.bind(document);
        document.execCommand = (name, ...rest) => { if (name === 'copy') { window.copied.push(getSelection().toString() || document.activeElement?.value); return true; } return exec(name, ...rest); }; }`);
    await click('复制房间码');
    await wait(`Array.from(document.querySelectorAll('#tigerest-watch button')).some(b => b.textContent === '已复制')`, 'copy feedback');
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(window.copied)`)), ['7KQ2MZ']);

    // Kick and close ask inside the room page, not with the browser's confirm box.
    await evaluate(`window.confirm = () => { throw new Error('browser confirm used'); }`);
    await click('移出');
    await wait(`!!document.querySelector('#tigerest-watch .tw-ask')`, 'kick confirmation');
    assert.match(await evaluate(`document.querySelector('#tigerest-watch .tw-ask').textContent`), /移出 朋友？/);
    await click('取消');
    await wait(`!document.querySelector('#tigerest-watch .tw-ask')`);
    await click('解散房间');
    await wait(`!!document.querySelector('#tigerest-watch .tw-ask')`, 'close confirmation');
    assert.match(await evaluate(`document.querySelector('#tigerest-watch .tw-ask').textContent`), /解散房间？[\s\S]*所有成员都会退出房间/);
    await evaluate(`document.querySelector('#tigerest-watch .tw-ask').click()`);
    await wait(`!document.querySelector('#tigerest-watch .tw-ask')`, 'backdrop cancels');
    assert.equal(await evaluate(`serverLog.filter(m => m.type === 'kick' || m.type === 'close').length`), 0, 'cancelled confirmations send nothing');

    // In a room the picker adds the rest of the room's season, with the room's episode marked.
    await click('更换影片');
    await wait(`document.querySelectorAll('#tigerest-watch .tw-shelf:not([hidden])').length === 4`, 'suggestion rows in a room');
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(${shelves}.map(s => s.querySelector('h3').textContent))`)), ['当前页面', '本剧其他集', '继续观看', '最近添加']);
    assert.equal(await evaluate(`document.querySelector('#tigerest-watch .tw-pick[aria-current=true]').dataset.itemId`), 'ep2');
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(Array.from(${shelves}[1].querySelectorAll('.tw-pick'), p => p.textContent))`)), ['第1集', '当前第2集', '第3集']);
    await evaluate(`${shelves}[2].querySelector('.tw-pick').click()`);
    await wait(`!!Array.from(document.querySelectorAll('#tigerest-watch button')).find(b => b.textContent === '换成这部并开始放映（从 10:00）')`, 'continue watching offers the resume point');
    await click('返回');
    await wait(`!document.querySelector('#tigerest-watch .tw-card') && ${shelves}.length === 4`, 'back to the rows');
    await click('全部剧集');
    await wait(`document.querySelector('#tigerest-watch .tw-pick[aria-pressed=true]')?.textContent === '第2集'`, 'the full season');
    await click('返回');
    await wait(`${shelves}.length === 4`);
    await click('返回');
    await wait(`!!document.querySelector('#tigerest-watch .tw-code')`, 'back to the room');
    assert.equal(await evaluate(`serverLog.filter(m => m.type === 'changeItem').length`), 0, 'browsing sends nothing');
    // The room's own film on its item page just shows the room.
    await evaluate(`plugin.close(); document.querySelector('.tw-detail-entry').click()`);
    await wait(`!!document.querySelector('#tigerest-watch .tw-code')`, 'the room page');

    await click('开始放映');
    await wait(`serverLog.some(m => m.type === 'changeItem')`);
    const change = JSON.parse(await evaluate(`JSON.stringify(serverLog.find(m => m.type === 'changeItem'))`));
    assert.deepEqual({...change, requestId: 'x'}, {type: 'changeItem', requestId: 'x', itemId: 'ep2', mediaSourceId: 'src-ep2', positionMs: 0, baseRevision: 1});
    await evaluate(`{ const s = sockets[0], now = performance.now() + 1e6;
        s.deliver({type: 'itemChange', phase: 'pending', changeId: 'c1', memberId: 'm1'});
        s.deliver({type: 'state', revision: 2, media: snapshot.media, playback: {revision: 2, state: 'waiting', positionMs: 0, serverTime: now, rate: 1,
            waiting: {memberIds: ['m1', 'm2'], deadline: now + 15000, resumeTo: 'playing'}, lastAction: {type: 'changeItem', memberId: 'm1'}}});
        s.deliver({type: 'itemChange', phase: 'committed', changeId: 'c1', memberId: 'm1', revision: 2});
        s.deliver({type: 'ack', requestId: ${JSON.stringify(change.requestId)}, revision: 2}); }`);
    await wait(`log.plays.length === 1`, 'members on the page enter the player');
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(log.plays[0])`)), {ids: ['ep2'], serverId: '62526c3bf747439c99327ddec5fed4a8',
        mediaSourceId: 'src-ep2', startPositionTicks: 0, fullscreen: true});
    assert.equal(await evaluate(`!!document.querySelector('#tigerest-watch')`), false, 'the room page closes for the player');
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify([TigerestWatch.loadPaused('ep2'), TigerestWatch.loadPaused('ep3')])`)), [true, false],
        'the room item loads stopped, other items autoplay');
    await wait(`serverLog.some(m => m.type === 'status' && m.state === 'loading' && m.revision === 2)`);

    // The room item loads stopped at the start and reports no position
    // change; the page asks the player for it, then reports ready.
    await evaluate(`api.player.getPosition = async () => 0; current = {Id: 'ep2', Type: 'Episode'}; api.player.paused.emit(); events.trigger('playbackstart', {})`);
    await wait(`serverLog.some(m => m.type === 'status' && m.state === 'ready' && m.revision === 2)`, 'ready report');
    assert.equal(await evaluate(`log.player.filter(x => x === 'pause:' || x === 'play:' || x.startsWith('seekTo:')).length`), 0, 'a stopped load needs no pause or seek');
    assert.equal(await evaluate(`serverLog.filter(m => ['pause', 'play', 'seek'].includes(m.type)).length`), 0, 'following the room sends no commands');

    await evaluate(`sockets[0].deliver({type: 'state', revision: 3, media: snapshot.media, playback: {revision: 3, state: 'playing', positionMs: 0,
        serverTime: performance.now() + 1e6 + 400, rate: 1, waiting: null, lastAction: {type: 'resume', memberId: null}}})`);
    await wait(`log.player.includes('play:')`, 'scheduled start');
    await evaluate(`api.player.playing.emit()`);
    await new Promise(r => setTimeout(r, 2600));
    await evaluate(`sockets[0].deliver({type: 'state', revision: 4, media: snapshot.media, playback: {revision: 4, state: 'paused', positionMs: 1200,
        serverTime: performance.now() + 1e6, rate: 1, waiting: null, lastAction: {type: 'pause', memberId: 'm2'}}})`);
    await wait(`log.player.filter(x => x === 'pause:').length >= 1`, 'remote pause pauses the player');
    await evaluate(`api.player.paused.emit()`);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(await evaluate(`serverLog.filter(m => ['pause', 'play', 'seek'].includes(m.type)).length`), 0, 'no echo of remote actions');
    assert.ok(await evaluate(`log.player.some(x => x.startsWith('userCommand:show-text') && x.includes('朋友 暂停了'))`), 'in-player notice uses the mpv OSD');

    await evaluate(`api.player.playing.emit()`);
    await wait(`serverLog.some(m => m.type === 'play')`, 'a local play becomes a room command');

    // iPad RIFE must not repeatedly bypass/re-warm for tiny room speed corrections.
    await evaluate(`window.jmpInfo = {platform: 'ipad', settings: {video: {aiRife: true}}}; plugin.attach(current.Id)`);
    assert.equal(await evaluate(`plugin.sync.rateCorrection`), false, 'iPad RIFE uses the same held-seek correction as desktop');
    await evaluate(`window.jmpInfo.settings.video.aiRife = false; plugin.attach(current.Id)`);
    assert.equal(await evaluate(`plugin.sync.rateCorrection`), true, 'normal iPad playback retains fine speed correction');
    await evaluate(`delete api.player.userCommand; api.player.showMessage = text => log.player.push('showMessage:' + text); plugin.notify('朋友 跳转了')`);
    assert.equal(await evaluate(`log.player.at(-1)`), 'showMessage:朋友 跳转了', 'native iPad overlay receives room actions');

    await evaluate(`current = null; events.trigger('playbackstop')`);
    await wait(`serverLog.some(m => m.type === 'status' && m.state === 'away')`);
    await evaluate(`plugin.open()`);
    await wait(`!!document.querySelector('#tigerest-watch .tw-danger')`);
    await click('离开房间');
    await wait(`log.fetch.some(c => c.url.endsWith('/leave'))`);
    assert.match(await evaluate(`document.querySelector('#tigerest-watch').textContent`), /选择影片并创建/);
    assert.equal(await evaluate(`JSON.stringify(log.fetch).includes('fixture-token') && !JSON.stringify(serverLog).includes('fixture-token')`), true, 'the token never enters the socket');
    console.log('watch-together room page, start-together, follow and leave passed');
}).catch(error => { console.error(error); process.exitCode = 1; });
