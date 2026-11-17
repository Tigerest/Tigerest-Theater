'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Only the browser DOM and native network boundary are doubled. The shipped
// connection controller runs unchanged, including asynchronous cancellation.
function fakeElement(tag = 'div') {
    return {
        tag, value: '', textContent: '', className: '', hidden: false, disabled: false, style: {}, dataset: {}, children: [],
        attributes: new Map([['data-original-text', '服务器地址']]),
        listeners: new Map(), classList: { add() {}, remove() {} },
        get firstChild() { return this.children[0] || null; },
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        addEventListener(event, listener) { this.listeners.set(event, listener); },
        getAttribute(name) { return this.attributes.get(name); },
        setAttribute(name, value) { this.attributes.set(name, value); },
        focus() { this.focused = true; this.listeners.get('focus')?.({ target: this }); },
        // Descendants by class, in document order.
        all(className) {
            return this.children.flatMap(child => [...(child.className.split(' ').includes(className) ? [child] : []), ...child.all(className)]);
        },
        querySelector(selector) { return this.all(selector.replace(/^\./, ''))[0] || null; },
        async emit(event) {
            return this.listeners.get(event)?.({ target: this, preventDefault() {}, stopPropagation() {} });
        },
    };
}

const markup = fs.readFileSync(path.join(__dirname, '../native/find-webclient.html'), 'utf8');

// `local` is a desktop client that plays local files (Windows, or the Mac with
// `mac`); `startedWithFiles` is that client opened with a video file.
function page({ saved = '', mode = '', known, lan = false, connect, switching = false, editAddress, finishSelection,
    local = false, mac = false, startedWithFiles = false } = {}) {
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
    }
    // Elements start hidden where the shipped page hides them.
    for (const [, id] of markup.matchAll(/<\w+ id="([^"]+)"[^>]*\bhidden>/g)) element(id).hidden = true;
    const requests = [], opened = [];
    const settings = { main: { userWebClient: saved, serverConnectionMode: mode, ...(known === undefined ? {} : { knownServers: known }) } };
    const check = async url => {
        requests.push(url);
        return connect ? connect(url) : `${url.replace(/\/+$/, '')}/web/index.html`;
    };
    check.abort = () => {};
    const window = {
        apiPromise: Promise.resolve(), jmpInfo: { settings }, location: switching ? { search: '?choose=1' } : '',
        history: { length: switching ? 2 : 1, back() { window.wentBack = true; } },
        tigerestAndroidApi: editAddress ? { system: { editServerAddress: editAddress } } : null,
        api: { system: { isAddressOnLocalSubnet: () => lan, cancelServerConnectivity() {}, finishServerSelection: finishSelection,
            isMacos: mac, startedWithLocalFiles: () => startedWithFiles } },
        jmpCheckServerConnectivity: check, tigerestOpenOfflineLibrary() { opened.push('offline'); },
        tigerestOpenMpvSettings(section) { opened.push('settings:' + section); },
        ...(local ? { tigerestLocalPlayerAvailable: () => true, tigerestOpenLocalFiles() { opened.push('files'); } } : {}),
    };
    const context = vm.createContext({
        window, URL, console: { log() {}, error() {}, warn() {} },
        document: { getElementById: element, createElement: fakeElement, addEventListener() {}, removeEventListener() {} },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../native/serverHistory.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../native/find-webclient.js'), 'utf8'), context);
    const cards = () => element('saved-server-list').children.map(item => ({
        item, key: item.dataset.key, name: item.all('saved-server-name')[0].textContent, meta: item.all('saved-server-meta')[0].textContent,
        current: item.all('saved-server-tag').length > 0, open: item.all('saved-server-open')[0],
        status: item.all('saved-server-status')[0], button: text => item.all('saved-server-action').find(button => button.textContent === text) || null,
    }));
    // The one screen showing: usage-choice, local-choice, server-choice or connect-form.
    const screen = () => ['usage-choice', 'local-choice', 'server-choice', 'connect-form'].filter(id => !element(id).hidden).join();
    return { element, elements, requests, opened, settings, window, context, cards, screen };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('native selection owns saving and navigation; Back cannot split its commit', async () => {
    let finish, args;
    const p = page({ saved: 'https://old.example/', mode: 'custom', switching: true,
        finishSelection: (...values) => { args = values; return new Promise(resolve => { finish = resolve; }); } });
    await settle();
    await p.element('choose-custom').emit('click');
    p.element('address').value = 'https://new.example/';
    const pending = p.element('connect-form').emit('submit');
    await settle();
    assert.deepEqual(args.slice(0, 3), ['https://new.example/', 'custom', 'https://new.example/web/index.html']);
    await p.element('cancel-switch-button').emit('click');
    assert.equal(p.window.tigerestServerSelectionBack(), true);
    assert.equal(p.window.wentBack, undefined);
    assert.equal(p.settings.main.userWebClient, 'https://old.example/');
    finish(true); await pending;
    assert.deepEqual(p.window.location, { search: '?choose=1' });
});

const history = require('../native/serverHistory.js');
const known = (...entries) => entries.reduce((text, [address, extra = {}], n) =>
    history.annotate(history.remember(text, { mode: 'custom', address, at: 1_700_000_000_000 + n }), { mode: 'custom', address, ...extra }), '');

test('remembered servers are listed with the current one marked and not removable', async () => {
    const p = page({ saved: 'https://b.example/jellyfin/', mode: 'custom', switching: true,
        known: known(['https://a.example/', { name: 'Alpha', kind: 'emby' }], ['https://b.example/jellyfin/', { name: '<b>Beta</b>', kind: 'jellyfin' }]) });
    await settle();
    assert.equal(p.element('saved-servers').hidden, false);
    const cards = p.cards();
    assert.deepEqual(cards.map(card => [card.name, card.meta, card.current]),
        [['<b>Beta</b>', 'Jellyfin · https://b.example/jellyfin', true], ['Alpha', 'Emby · https://a.example', false]]);
    assert.equal(cards[0].button('移除'), null, 'the startup server cannot be removed');
    assert.ok(cards[1].button('移除'));
    assert.deepEqual(p.requests, [], 'listing never probes servers');
});

test('a saved address from before the list appears once, and the dedicated server is not a self-hosted card', async () => {
    const p = page({ saved: 'https://old.example/emby/', mode: 'custom', switching: true });
    await settle();
    assert.deepEqual(p.cards().map(card => [card.key, card.current]), [['custom:https://old.example/emby/', true]]);
    const dedicated = page({ saved: 'https://nas.tigerest.top:18445/', mode: 'tigerest', switching: true });
    await settle();
    assert.equal(dedicated.element('saved-servers').hidden, true);
    assert.equal(dedicated.element('tigerest-current').hidden, false);
});

test('choosing a saved server connects it and hands the updated list to the native commit', async () => {
    let args;
    const p = page({ saved: 'https://a.example/', mode: 'custom', switching: true,
        known: known(['https://a.example/'], ['https://b.example/', { name: 'Beta' }]), finishSelection: async (...values) => { args = values; return true; } });
    await settle();
    await p.cards().find(card => card.name === 'Beta').open.emit('click');
    assert.deepEqual(p.requests, ['https://b.example/']);
    assert.deepEqual(args.slice(0, 3), ['https://b.example/', 'custom', 'https://b.example/web/index.html']);
    assert.deepEqual(history.parse(args[3]).map(server => [server.address, server.name]), [['https://b.example/', 'Beta'], ['https://a.example/', undefined]]);
    assert.equal(p.settings.main.userWebClient, 'https://a.example/', 'settings change only inside the native transaction');
});

test('an offline saved server keeps its card, shows the error and can be retried', async () => {
    let online = false;
    const p = page({ saved: 'https://a.example/', mode: 'custom', switching: true, known: known(['https://a.example/'], ['https://b.example/']),
        connect: async url => { if (!online) throw new Error('HTTP 502'); return `${url}web/index.html`; }, finishSelection: async () => true });
    await settle();
    await p.cards().find(card => card.key === 'custom:https://b.example/').open.emit('click');
    let card = p.cards().find(card => card.key === 'custom:https://b.example/');
    assert.equal(p.element('server-choice').hidden, false, 'the list stays in place');
    assert.equal(p.cards().length, 2);
    assert.match(card.status.textContent, /502/);
    assert.equal(card.status.hidden, false);
    online = true;
    await card.button('重试').emit('click');
    assert.deepEqual(p.requests, ['https://b.example/', 'https://b.example/']);
    assert.equal(p.settings.main.knownServers, known(['https://a.example/'], ['https://b.example/']), 'nothing is saved before the native commit');
});

test('Back during a saved-server connection cancels it and a late answer is ignored', async () => {
    let finish, committed = false;
    const p = page({ saved: 'https://a.example/', mode: 'custom', switching: true, known: known(['https://a.example/'], ['https://b.example/']),
        connect: () => new Promise(resolve => { finish = resolve; }), finishSelection: async () => { committed = true; return true; } });
    await settle();
    const pending = p.cards()[0].open.emit('click');
    await settle();
    assert.equal(p.cards()[0].status.textContent, '正在连接…');
    assert.equal(p.window.tigerestServerSelectionBack(), true);
    assert.equal(p.window.wentBack, undefined, 'Back first cancels the connection, not the switch');
    finish('https://b.example/web/index.html');
    await pending; await settle();
    assert.equal(committed, false);
    assert.equal(p.cards()[0].status.hidden, true);
});

test('upgrading: the migrated address survives the first new connection; failure and cancel record nothing', async () => {
    const commits = [];
    const p = page({ saved: 'https://old.example/emby/', mode: 'custom', switching: true, known: '',
        connect: async url => { if (url.includes('down.example')) throw new Error('HTTP 502'); return `${url}web/index.html`; },
        finishSelection: async (...values) => { commits.push(values); return true; } });
    await settle();
    await p.element('choose-custom').emit('click');
    p.element('address').value = 'https://down.example/';
    await p.element('connect-form').emit('submit');
    assert.equal(commits.length, 0, 'a failed connection commits nothing');
    p.element('address').value = 'https://new.example/jellyfin/';
    await p.element('connect-form').emit('submit');
    assert.deepEqual(commits[0].slice(0, 2), ['https://new.example/jellyfin/', 'custom']);
    assert.deepEqual(history.parse(commits[0][3]).map(server => [server.address, server.lastConnectedAt > 0]),
        [['https://new.example/jellyfin/', true], ['https://old.example/emby/', false]], 'the old address can still be chosen');
    assert.equal(p.settings.main.knownServers, '', 'only the native commit writes the list');
});

test('upgrading: editing the migrated current address replaces it', async () => {
    let args;
    const p = page({ saved: 'https://old.example/emby/', mode: 'custom', switching: true, known: '',
        finishSelection: async (...values) => { args = values; return true; } });
    await settle();
    await p.cards()[0].button('编辑地址').emit('click');
    p.element('address').value = 'https://old.example:8920/emby/';
    await p.element('connect-form').emit('submit');
    assert.deepEqual(history.parse(args[3]).map(server => server.address), ['https://old.example:8920/emby/']);
});

// A saved-card answer that arrives after the user picked something else.
function racingPage(lan) {
    const answers = new Map(), commits = [];
    const p = page({ saved: 'https://a.example/', mode: 'custom', switching: true, known: known(['https://a.example/'], ['https://b.example/']), lan,
        connect: url => url.includes('b.example') ? new Promise(resolve => answers.set(url, resolve)) : `${url}web/index.html`,
        finishSelection: async (...values) => { commits.push(values); return true; } });
    return { p, commits, answerB: () => answers.get('https://b.example/')('https://b.example/web/index.html') };
}

test('choosing the dedicated server while a saved card connects drops the card answer', async () => {
    let lookup;
    const { p, commits, answerB } = racingPage(new Promise(resolve => { lookup = resolve; }));
    await settle();
    const card = p.cards().find(card => card.key === 'custom:https://b.example/').open.emit('click');
    await settle();
    const dedicated = p.element('choose-tigerest').emit('click');
    answerB(); await card; await settle();
    assert.equal(commits.length, 0, 'the card answer never commits, least of all as the dedicated server');
    lookup(false); await dedicated; await settle();
    assert.deepEqual(commits.map(args => args.slice(0, 2)), [['https://nas.tigerest.top:18445/', 'tigerest']]);
    assert.deepEqual(history.parse(commits[0][3]).map(server => [server.mode, server.address]),
        [['tigerest', 'https://nas.tigerest.top:18445/'], ['custom', 'https://b.example/'], ['custom', 'https://a.example/']]);
});

test('adding a server while a saved card connects drops the card answer', async () => {
    const { p, commits, answerB } = racingPage(false);
    await settle();
    const card = p.cards().find(card => card.key === 'custom:https://b.example/').open.emit('click');
    await settle();
    await p.element('choose-custom').emit('click');
    assert.equal(p.element('connect-form').hidden, false);
    answerB(); await card; await settle();
    assert.equal(commits.length, 0);
    p.element('address').value = 'https://c.example/';
    await p.element('connect-form').emit('submit');
    assert.deepEqual(commits.map(args => args.slice(0, 2)), [['https://c.example/', 'custom']]);
});

test('a late saved-card answer after returning to the list neither commits nor marks the card', async () => {
    const { p, commits, answerB } = racingPage(false);
    await settle();
    const card = p.cards().find(card => card.key === 'custom:https://b.example/').open.emit('click');
    await settle();
    await p.element('choose-custom').emit('click');
    await p.element('back-button').emit('click');
    answerB(); await card; await settle();
    assert.equal(commits.length, 0);
    assert.ok(p.cards().every(card => card.status.hidden && !card.open.disabled));
});

test('removing a server needs confirmation and only edits the list', async () => {
    const p = page({ saved: 'https://a.example/', mode: 'custom', switching: true, known: known(['https://a.example/'], ['https://b.example/', { name: 'Beta' }]) });
    await settle();
    let beta = p.cards().find(card => card.name === 'Beta');
    await beta.button('移除').emit('click');
    assert.equal(p.cards().length, 2, 'one click only asks');
    await beta.item.all('saved-server-action').find(button => button.textContent === '保留').emit('click');
    assert.equal(p.cards().length, 2);
    await beta.item.all('saved-server-action').find(button => button.textContent === '确认移除').emit('click');
    assert.deepEqual(p.cards().map(card => card.key), ['custom:https://a.example/']);
    assert.deepEqual(history.parse(p.settings.main.knownServers).map(server => server.address), ['https://a.example/']);
    assert.equal(p.settings.main.userWebClient, 'https://a.example/');
});

test('editing a saved address replaces that record once the new address commits', async () => {
    let args;
    const p = page({ saved: 'https://a.example/', mode: 'custom', switching: true, known: known(['https://a.example/'], ['http://b.example:8096/']),
        finishSelection: async (...values) => { args = values; return true; } });
    await settle();
    await p.cards().find(card => card.key === 'custom:http://b.example:8096/').button('编辑地址').emit('click');
    assert.equal(p.element('address').value, 'http://b.example:8096/');
    p.element('address').value = 'https://b.example/';
    await p.element('connect-form').emit('submit');
    assert.deepEqual(history.parse(args[3]).map(server => server.address), ['https://b.example/', 'https://a.example/']);
});

test('a failed server page leaves the remembered list unchanged and the chooser usable', async () => {
    const text = known(['https://a.example/']);
    const p = page({ saved: 'https://a.example/', mode: 'custom', switching: true, known: text, finishSelection: async () => true });
    await settle();
    await p.element('choose-custom').emit('click');
    p.element('address').value = 'https://broken.example/';
    await p.element('connect-form').emit('submit');
    // Native rollback after the HTML load fails.
    p.window.tigerestServerSelectionFailed();
    assert.equal(p.settings.main.knownServers, text);
    assert.equal(p.element('server-choice').hidden, false);
    assert.deepEqual(p.cards().map(card => card.key), ['custom:https://a.example/']);
    assert.equal(p.cards()[0].open.disabled, false);
});

test('rejected native selection retains old settings and allows another choice', async () => {
    const p = page({ saved: 'https://old.example/', mode: 'custom', switching: true,
        finishSelection: async () => false });
    await settle(); await p.element('choose-custom').emit('click');
    p.element('address').value = 'https://new.example/';
    await p.element('connect-form').emit('submit');
    assert.equal(p.settings.main.userWebClient, 'https://old.example/');
    assert.equal(p.element('connection-error').hidden, false);
    await p.element('cancel-switch-button').emit('click');
    assert.equal(p.window.wentBack, true);
});

test('a desktop first launch asks how the client will be used before any server', async () => {
    const p = page({ local: true, lan: true });
    assert.equal(p.screen(), '', 'only the logo until the native API answers');
    await settle();
    assert.equal(p.screen(), 'usage-choice');
    assert.deepEqual(p.requests, []);
    assert.equal(p.element('client-actions').hidden, true, 'the first screen has no links under it');
    for (const id of p.elements.keys()) assert.ok(markup.includes(`id="${id}"`), `the page has no #${id}`);
});

test('the media server choice shows the servers as before, with a way back to the first screen', async () => {
    const p = page({ local: true });
    await settle();
    await p.element('choose-server').emit('click');
    assert.equal(p.screen(), 'server-choice');
    assert.equal(p.element('choice-title').focused, true);
    assert.equal(p.element('server-back-button').hidden, false);
    assert.equal(p.element('client-actions').hidden, false);
    assert.equal(p.element('local-files-button').hidden, false);
    await p.element('choose-custom').emit('click');
    assert.equal(p.screen(), 'connect-form');
    await p.element('back-button').emit('click');
    assert.equal(p.screen(), 'server-choice', 'the address form returns to the servers');
    await p.element('server-back-button').emit('click');
    assert.equal(p.screen(), 'usage-choice');
    await p.element('choose-server').emit('click');
    await p.element('choose-custom').emit('click');
    p.element('address').value = '192.168.114.114:8097';
    await p.element('connect-form').emit('submit');
    assert.deepEqual(p.requests, ['http://192.168.114.114:8097/']);
    assert.equal(p.window.location, 'http://192.168.114.114:8097/web/index.html');
});

test('the local playback choice opens files and offline media without any server', async () => {
    const p = page({ local: true });
    await settle();
    await p.element('choose-local').emit('click');
    assert.equal(p.screen(), 'local-choice');
    assert.equal(p.element('local-title').focused, true);
    assert.equal(p.element('local-notice').hidden, true);
    assert.equal(p.element('client-actions').hidden, true, 'the local screen has its own buttons');
    assert.deepEqual([p.element('share-help-windows').hidden, p.element('share-help-mac').hidden], [false, true]);
    await p.element('open-local-files').emit('click');
    await p.element('open-offline-media').emit('click');
    assert.deepEqual(p.opened, ['files', 'offline']);
    await p.element('local-back-button').emit('click');
    assert.equal(p.screen(), 'usage-choice');
    assert.deepEqual(p.requests, []);
    assert.equal(p.settings.main.serverConnectionMode, '', 'local playback is not saved as a server choice');
    const mac = page({ local: true, mac: true });
    await settle();
    assert.deepEqual([mac.element('share-help-windows').hidden, mac.element('share-help-mac').hidden], [true, false]);
});

test('settings open from the corner button on the desktop and stay hidden on Android', async () => {
    const p = page({ local: true });
    await settle();
    assert.equal(p.element('settings-button').hidden, false);
    await p.element('settings-button').emit('click');
    assert.deepEqual(p.opened, ['settings:main']);
    const linux = page();
    await settle();
    assert.equal(linux.element('settings-button').hidden, false, 'a desktop client without local playback keeps settings');
    const android = page({ editAddress: async () => null });
    await settle();
    assert.equal(android.element('settings-button').hidden, true);
});

// Android injects no localPlayer.js (WebHost.kt), so it has no local playback and
// no first screen; its settings live in the player and the server pages.
test('Android starts on the servers and never shows the first screen, local playback or the settings button', async () => {
    const editAddress = async () => null;
    const firstScreen = ['usage-choice', 'local-choice', 'settings-button', 'server-back-button', 'local-files-button'];
    const hidden = (p, when) => { for (const id of firstScreen) assert.equal(p.element(id).hidden, true, `#${id} ${when}`); };
    for (const options of [{}, { switching: true, saved: 'https://a.example/', mode: 'custom' }]) {
        const android = page({ editAddress, ...options });
        assert.equal(android.screen(), 'server-choice', 'the servers show before the native API answers');
        hidden(android, 'before the native API answers');
        await settle();
        assert.equal(android.screen(), 'server-choice');
        hidden(android, 'once the native API answered');
        await android.element('choose-custom').emit('click');
        assert.equal(android.screen(), 'connect-form');
        await android.element('back-button').emit('click');
        assert.equal(android.screen(), 'server-choice', 'the address form returns to the servers, not to a first screen');
        hidden(android, 'after leaving the address form');
        assert.deepEqual(android.requests, []);
    }
    const saved = page({ editAddress, saved: 'https://a.example/', mode: 'custom' });
    await settle();
    assert.deepEqual(saved.requests, ['https://a.example/'], 'a saved server still connects at start');
    hidden(saved, 'while a saved server connects');
});

test('a saved server still connects at start, and a server switch still opens on the servers', async () => {
    const p = page({ local: true, saved: 'https://a.example/', mode: 'custom' });
    await settle();
    assert.deepEqual(p.requests, ['https://a.example/']);
    assert.equal(p.element('usage-choice').hidden, true);
    const switching = page({ local: true, saved: 'https://a.example/', mode: 'custom', switching: true });
    assert.equal(switching.screen(), 'server-choice', 'a switch shows the servers at once');
    await settle();
    assert.deepEqual(switching.requests, []);
    assert.equal(switching.screen(), 'server-choice');
    assert.equal(switching.element('server-back-button').hidden, false);
    assert.equal(switching.element('cancel-switch-button').hidden, false);
});

test('returning to the first screen drops a saved-server connection still pending', async () => {
    let finish, committed = false;
    const p = page({ local: true, saved: 'https://a.example/', mode: 'custom', switching: true, known: known(['https://a.example/'], ['https://b.example/']),
        connect: () => new Promise(resolve => { finish = resolve; }), finishSelection: async () => { committed = true; return true; } });
    await settle();
    const pending = p.cards()[0].open.emit('click');
    await settle();
    await p.element('server-back-button').emit('click');
    assert.equal(p.screen(), 'usage-choice');
    finish('https://b.example/web/index.html');
    await pending; await settle();
    assert.equal(committed, false);
    assert.equal(p.screen(), 'usage-choice');
});

test('opened with a video file, the client rests on the local screen and connects nothing', async () => {
    const p = page({ local: true, startedWithFiles: true, saved: 'https://a.example/', mode: 'custom' });
    await settle();
    assert.deepEqual(p.requests, []);
    assert.equal(p.screen(), 'local-choice');
    assert.equal(p.element('local-notice').hidden, false);
    await p.element('local-back-button').emit('click');
    await p.element('choose-server').emit('click');
    assert.deepEqual(p.cards().map(card => [card.key, card.current]), [['custom:https://a.example/', true]], 'the saved server is still offered');
    // A client without the first screen keeps the notice on the servers.
    const other = page({ startedWithFiles: true, saved: 'https://a.example/', mode: 'custom' });
    await settle();
    assert.deepEqual(other.requests, []);
    assert.equal(other.screen(), 'server-choice');
    assert.match(other.element('choice-description').textContent, /本地播放器/);
});

test('a failed server page returns the desktop to the servers, not to the first screen', async () => {
    const p = page({ local: true, finishSelection: async () => true });
    await settle();
    await p.element('choose-server').emit('click');
    await p.element('choose-custom').emit('click');
    p.element('address').value = 'https://broken.example/';
    await p.element('connect-form').emit('submit');
    await p.element('server-back-button').emit('click');
    assert.equal(p.screen(), 'connect-form', 'nothing leaves the form while native code commits the selection');
    // Native rollback after the HTML load fails.
    p.window.tigerestServerSelectionFailed();
    assert.equal(p.screen(), 'server-choice');
    assert.match(p.element('choice-description').textContent, /加载失败/);
});

test('first launch without local playback waits on the servers without probing any server', async () => {
    const p = page({ lan: true });
    await settle();
    assert.deepEqual(p.requests, []);
    assert.equal(p.screen(), 'server-choice', 'no first screen where local files cannot play');
    assert.equal(p.element('server-back-button').hidden, true);
    assert.equal(p.element('client-actions').hidden, false);
});

test('self-hosted choice opens a blank form and connects directly to the supplied IP and port', async () => {
    const p = page();
    await settle();
    await p.element('choose-custom').emit('click');
    assert.equal(p.element('address').value, '');
    p.element('address').value = '  192.168.114.114:8097  ';
    await p.element('connect-form').emit('submit');
    await settle();
    assert.deepEqual(p.requests, ['http://192.168.114.114:8097/']);
    assert.equal(p.settings.main.serverConnectionMode, 'custom');
    assert.equal(p.window.location, 'http://192.168.114.114:8097/web/index.html');
});

test('saved custom server failure stays on that server and exposes the connection error', async () => {
    const p = page({ saved: 'http://192.168.114.114:8097/', mode: 'custom',
        connect: async () => { throw new Error('HTTP 403'); } });
    await settle();
    assert.deepEqual(p.requests, ['http://192.168.114.114:8097/']);
    assert.equal(p.element('address').value, 'http://192.168.114.114:8097/');
    assert.match(p.element('connection-error').textContent, /403/);
    assert.equal(p.element('connect-form').hidden, false);
});

test('exclusive server choice tries LAN first only on that subnet, then the public domain', async () => {
    const p = page({ lan: true, connect: async url => {
        if (url.includes('192.168.5.150')) throw new Error('unavailable');
        return `${url}web/index.html`;
    } });
    await settle();
    await p.element('choose-tigerest').emit('click');
    await settle();
    assert.deepEqual(p.requests, ['http://192.168.5.150:8095/', 'https://nas.tigerest.top:18445/']);
    assert.equal(p.settings.main.userWebClient, 'https://nas.tigerest.top:18445/');
});

test('hover and keyboard focus expose the appropriate server explanation', async () => {
    const p = page();
    await settle();
    await p.element('choose-tigerest').emit('mouseenter');
    assert.match(p.element('choice-description').textContent, /B站充电/);
    await p.element('choose-custom').emit('focus');
    assert.match(p.element('choice-description').textContent, /播放器.*不包含服务器/);
});

test('asynchronous native subnet result false uses the public dedicated server only', async () => {
    const p = page({ lan: Promise.resolve(false) });
    await settle();
    await p.element('choose-tigerest').emit('click');
    assert.deepEqual(p.requests, ['https://nas.tigerest.top:18445/']);
});

test('a dedicated profile saved on the old public address reconnects over HTTPS', async () => {
    const p = page({ saved: 'http://nas.tigerest.top:8095/' });
    await settle();
    assert.deepEqual(p.requests, ['https://nas.tigerest.top:18445/']);
    assert.equal(p.settings.main.userWebClient, 'https://nas.tigerest.top:18445/');
    assert.equal(p.settings.main.serverConnectionMode, 'tigerest');
});

test('returning to choices during native subnet lookup cannot start a stale connection', async () => {
    let finish;
    const p = page({ lan: new Promise(resolve => { finish = resolve; }) });
    await settle();
    const pending = p.element('choose-tigerest').emit('click');
    await p.element('back-button').emit('click');
    await p.element('choose-custom').emit('click');
    finish(true);
    await pending;
    assert.deepEqual(p.requests, []);
    assert.equal(p.settings.main.serverConnectionMode, '');
    assert.equal(p.element('address').value, '');
});

test('explicit switching shows choices without connecting or erasing the saved server', async () => {
    const p = page({ saved: 'https://example.org/jellyfin/', mode: 'custom', switching: true });
    await settle();
    assert.deepEqual(p.requests, []);
    assert.equal(p.element('server-choice').hidden, false);
    await p.element('choose-custom').emit('click');
    assert.equal(p.element('address').value, 'https://example.org/jellyfin/');
    await p.element('back-button').emit('click');
    await p.element('cancel-switch-button').emit('click');
    assert.equal(p.window.wentBack, true);
    assert.equal(p.settings.main.userWebClient, 'https://example.org/jellyfin/');
    assert.equal(p.settings.main.serverConnectionMode, 'custom');
});

test('failed replacement leaves the original launch destination intact', async () => {
    const p = page({ saved: 'https://old.example/', mode: 'custom', switching: true, connect: async () => { throw Error('offline'); } });
    await settle();
    await p.element('choose-custom').emit('click');
    p.element('address').value = 'https://new.example/';
    await p.element('connect-form').emit('submit');
    assert.equal(p.settings.main.userWebClient, 'https://old.example/');
    assert.equal(p.settings.main.serverConnectionMode, 'custom');
});

test('Android native address editing preserves cancel and sends accepted text through normal validation', async () => {
    let result = null;
    const p = page({ switching: true, saved: 'https://old.example/', mode: 'custom', editAddress: async () => result });
    await settle();
    await p.element('choose-custom').emit('click');
    await p.element('address').emit('click');
    assert.equal(p.element('address').value, 'https://old.example/');
    result = 'https://example.org:8920/jellyfin/';
    await p.element('address').emit('click');
    assert.equal(p.element('address').value, result);
    assert.equal(p.settings.main.userWebClient, 'https://old.example/');
    await p.element('connect-form').emit('submit');
    assert.deepEqual(p.requests, [result]);
    assert.equal(p.settings.main.userWebClient, result);
});

test('back cancels an in-flight connection and a late result cannot navigate or save it', async () => {
    let finish;
    const p = page({ mode: 'custom', connect: () => new Promise(resolve => { finish = resolve; }) });
    await settle();
    p.element('address').value = 'http://192.168.114.114:8097';
    const pending = p.element('connect-form').emit('submit');
    await settle();
    await p.element('back-button').emit('click');
    finish('http://192.168.114.114:8097/web/index.html');
    await pending;
    await settle();
    assert.equal(p.window.location, '');
    assert.equal(p.settings.main.userWebClient, '');
    assert.equal(p.element('server-choice').hidden, false);
});
