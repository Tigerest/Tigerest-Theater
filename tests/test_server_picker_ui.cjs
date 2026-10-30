// The shipped chooser page, stylesheet and remembered-server model in Chrome.
// The native connectivity check and selection transaction are the doubles.
const assert = require('node:assert/strict'), path = require('node:path'), withBrowser = require('./community_browser.cjs');
const native = file => path.join(__dirname, '../native', file);
const history = require('../native/serverHistory.js');
let known = '';
for (const [n, [address, name, kind]] of [['http://[fe80::2]:8096/', '', ''], ['https://media.example.org:8920/jellyfin/', 'Living room media server with a very long name', 'jellyfin'],
    ['https://other.example/emby/', '<img src=x onerror="window.injected=1">', 'emby']].entries())
    known = history.annotate(history.remember(known, {mode: 'custom', address, at: 1_700_000_000_000 + n}), {mode: 'custom', address, name, kind});
const bootstrap = `<script>
window.injected = 0; window.commits = []; window.checks = [];
const fixtureInfo = {settings: {main: {userWebClient: 'https://media.example.org:8920/jellyfin/', serverConnectionMode: 'custom', knownServers: ${JSON.stringify(known)}}}};
const fixtureApi = {system: {isAddressOnLocalSubnet: async () => false, cancelServerConnectivity() {},
  finishServerSelection: async (...args) => { commits.push(args); return true; }}};
// In the client, nativeshell binds window.api and jmpInfo.settings to the real
// (isolated) profile once its channel connects. Install the fixture after that,
// so neither the saved list nor the server commit can reach the real profile.
window.apiPromise = Promise.resolve(window.initCompleted).catch(() => {}).then(() => {
  window.jmpInfo = fixtureInfo; window.api = fixtureApi; return fixtureApi; });
window.jmpCheckServerConnectivity = async url => { checks.push(url); if (url.includes('other.example')) throw new Error('HTTP 502'); return url + 'web/index.html'; };
window.jmpCheckServerConnectivity.abort = () => {};
window.tigerestOpenOfflineLibrary = () => {};
history.replaceState(null, '', '/find-webclient.html?choose=1');
</script>`;
const html = require('node:fs').readFileSync(native('find-webclient.html'), 'utf8').replace('<link rel="stylesheet"', bootstrap + '<link rel="stylesheet"');
const routes = {'/': {type: 'text/html', body: html}, '/find-webclient.html': {type: 'text/html', body: html}, '/find-webclient.css': {type: 'text/css', path: native('find-webclient.css')},
    '/serverHistory.js': {path: native('serverHistory.js')}, '/find-webclient.lang.js': {path: native('find-webclient.lang.js')},
    '/find-webclient.js': {path: native('find-webclient.js')}, '/logo.png': {type: 'image/png', path: native('logo.png')}};
withBrowser(routes, async ({evaluate, call}) => {
    await call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'no-preference'}]});
    const settle = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    for (const [width, height] of [[390, 844], [600, 900], [847, 948], [948, 847], [1280, 800]]) {
        await call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 900});
        await evaluate('document.documentElement.dataset.stale = 1, location.reload()');
        const ready = () => evaluate(`!document.documentElement.dataset.stale && document.querySelectorAll('.saved-server').length === 3`).catch(() => false);
        for (let i = 0; i < 100 && !await ready(); i++) await new Promise(resolve => setTimeout(resolve, 30));
        const layout = await evaluate(`(() => {
          const cards = [...document.querySelectorAll('.saved-server')], rect = node => node.getBoundingClientRect();
          return {cards: cards.map(card => ({name: card.querySelector('.saved-server-name').textContent, current: !!card.querySelector('.saved-server-tag'),
              inside: rect(card).left >= 0 && rect(card).right <= innerWidth + 0.5,
              overlap: [...card.querySelectorAll('.saved-server-name,.saved-server-meta,.saved-server-tag')].some((a, i, all) => all.slice(i + 1).some(b => {
                const x = rect(a), y = rect(b); return x.left < y.right - 1 && y.left < x.right - 1 && x.top < y.bottom - 1 && y.top < x.bottom - 1; }))})),
            scroll: document.documentElement.scrollWidth <= innerWidth, injected: window.injected, images: document.querySelectorAll('#saved-server-list img').length,
            options: rect(document.querySelector('.server-options')).top >= rect(document.querySelector('#saved-servers')).bottom};
        })()`);
        assert.deepEqual(layout.cards.map(card => [card.name, card.current]), [['<img src=x onerror="window.injected=1">', false],
            ['Living room media server with a very long name', true], ['[fe80::2]:8096', false]], width + ': cards in recent order');
        assert.ok(layout.cards.every(card => card.inside && !card.overlap), width + ': cards fit without overlap ' + JSON.stringify(layout.cards));
        assert.equal(layout.scroll, true, width + ': no sideways scroll');
        assert.equal(layout.injected + layout.images, 0, 'server names are text');
        assert.equal(layout.options, true, width + ': add/dedicated choices stay below the list');
        if (process.env.TIGEREST_PICKER_SCREENSHOTS) require('node:fs').writeFileSync(path.join(process.env.TIGEREST_PICKER_SCREENSHOTS, 'picker-' + width + '.png'),
            Buffer.from((await call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true})).data, 'base64'));
    }
    // Pointer: anywhere on a saved server's card highlights and opens it, like the
    // server options, including the empty space beside its buttons; hovering its
    // edit/remove buttons does not.
    const point = (selector, corner) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return ${corner ? '{x: r.right - 12, y: r.bottom - 12}' : '{x: r.left + r.width / 2, y: r.top + r.height / 2}'}; })()`);
    const hover = async (selector, corner) => {
        const box = await point(selector, corner);
        await call('Input.dispatchMouseEvent', {type: 'mouseMoved', ...box});
        await new Promise(resolve => setTimeout(resolve, 300));
        return evaluate(`(() => { const card = document.querySelectorAll('.saved-server')[1], style = getComputedStyle(card);
          return {border: style.borderTopColor, background: style.backgroundColor, lifted: style.transform !== 'none', name: getComputedStyle(card.querySelector('.saved-server-name')).color}; })()`);
    };
    const rest = await hover('#saved-title'), highlighted = await hover('.saved-server:nth-child(2) .saved-server-open');
    assert.deepEqual(highlighted, {border: 'rgb(227, 179, 92)', background: 'rgb(59, 46, 28)', lifted: true, name: 'rgb(240, 198, 117)'}, 'hovered saved server is highlighted');
    assert.notDeepEqual(rest, highlighted, 'saved server is plain without hover');
    assert.deepEqual(await hover('.saved-server:nth-child(2) .saved-server-action'), rest, 'hovering an action button does not highlight the card');
    assert.deepEqual(await hover('.saved-server:nth-child(2)', true), highlighted, 'the empty corner beside the buttons belongs to the card');
    assert.equal(await evaluate(`(() => { const card = document.querySelectorAll('.saved-server')[1], r = card.getBoundingClientRect();
      return [[r.left + 4, r.top + 4], [r.right - 12, r.bottom - 12], [r.left + r.width / 2, r.bottom - 4]].every(([x, y]) => document.elementFromPoint(x, y) === card.querySelector('.saved-server-open')); })()`), true,
      'every edge of the card reaches its open button');
    await call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: 1, y: 1});
    // Keyboard: the card is a focusable button with a visible outline.
    await evaluate(`document.querySelector('.saved-server-open').focus()`);
    assert.notEqual(await evaluate(`getComputedStyle(document.activeElement).outlineStyle`), 'none');
    // An offline server shows its error on its card; retry and remove stay available.
    await evaluate(`document.querySelector('.saved-server-open').click()`);
    for (let i = 0; i < 20 && !await evaluate(`!!document.querySelector('.saved-server-status.is-error:not([hidden])')`); i++) await settle();
    const failed = await evaluate(`(() => { const card = document.querySelector('.saved-server');
      return {error: card.querySelector('.saved-server-status').textContent, actions: [...card.querySelectorAll('.saved-server-actions button')].map(b => b.textContent),
        cards: document.querySelectorAll('.saved-server').length, commits: commits.length}; })()`);
    assert.match(failed.error, /502/);
    assert.deepEqual(failed.actions, ['重试', '编辑地址', '移除']);
    assert.equal(failed.cards, 3);
    assert.equal(failed.commits, 0);
    // Removal asks first, then removes only that record.
    await evaluate(`[...document.querySelector('.saved-server').querySelectorAll('button')].find(b => b.textContent === '移除').click()`);
    assert.equal(await evaluate(`document.activeElement.textContent`), '保留', 'confirmation takes focus');
    await evaluate(`[...document.querySelector('.saved-server').querySelectorAll('button')].find(b => b.textContent === '确认移除').click()`);
    const removed = await evaluate(`({names: [...document.querySelectorAll('.saved-server-name')].map(n => n.textContent), saved: JSON.parse(jmpInfo.settings.main.knownServers).servers.length})`);
    assert.deepEqual(removed, {names: ['Living room media server with a very long name', '[fe80::2]:8096'], saved: 2});
    // A reachable card hands the native transaction its updated list; a real
    // click in the card's empty corner beside its buttons connects.
    const corner = await point('.saved-server:nth-child(2)', true);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
        await call('Input.dispatchMouseEvent', {type, ...corner, button: 'left', clickCount: 1});
    for (let i = 0; i < 20 && !await evaluate('commits.length'); i++) await settle();
    const commit = await evaluate('commits[0]');
    assert.deepEqual(commit.slice(0, 3), ['http://[fe80::2]:8096/', 'custom', 'http://[fe80::2]:8096/web/index.html']);
    assert.equal(history.parse(commit[3])[0].address, 'http://[fe80::2]:8096/');
    console.log(JSON.stringify({passed: true, widths: 5, cards: 3}));
}).catch(error => { console.error(error); process.exitCode = 1; });
