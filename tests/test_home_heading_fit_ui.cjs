// The home library heading with the real gallery, server chip and desktop
// window control. Labels give way to icons only when the heading itself has
// no room; the title is never squeezed.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const withBrowser = require('./community_browser.cjs');
const root = path.resolve(__dirname, '..');
const shell = fs.readFileSync(path.join(root, 'native/nativeshell.js'), 'utf8');
const entries = shell.slice(shell.indexOf('function installHorizontalShelfDragging()'), shell.indexOf('\ninstallServerSwitchEntry();'));
const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#101216;color:#fff;font:16px system-ui}</style><main id="home"></main>
<script>
window.jmpInfo = {capabilities: {desktopWindowControls: true}, settings: {main: {userWebClient: 'https://nas.tigerest.top:18445/', serverConnectionMode: 'tigerest'}}};
window.api = {window: {isFullScreen: async () => false, setFullScreen: async () => {}, fullScreenSwitched: {connect() {}}}, settings: {value: async () => ''}};
window.initCompleted = Promise.resolve(); window.switches = 0; window.tigerestSwitchServer = () => switches++;
let identity = null, ready; const readyPromise = new Promise(resolve => { ready = resolve; });
window.TigerestServer = {base: location.origin, get identity() { return identity; }, ready: readyPromise, headerUserButton: () => null};
window.nameServer = name => { identity = {name, serverId: 'x'}; ready('emby'); };
</script>
<script src="/gallery.js"></script>
<script>${entries};installServerSwitchEntry();
window.TigerestHomeMotion = null;
if (location.hash) nameServer(decodeURIComponent(location.hash.slice(1)));
window.gallery = new TigerestHomeGallery(document.getElementById('home'), {apiProvider: () => ({serverId: () => 's', serverAddress: () => location.origin, getCurrentUserId: () => 'u',
  getUserViews: async () => ({Items: [{Id: 'a', Name: '电影', CollectionType: 'movies'}]}), getItems: async () => ({Items: []}), getImageUrl: () => ''})});
</script>`;
withBrowser({'/': {type: 'text/html', body: page}, '/gallery.js': {path: path.join(root, 'native/homeGallery.js')}}, async ({evaluate, call}) => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    // Each server name is a fresh page load: the page learns its server once.
    const load = async name => {
        await evaluate(`location.hash = ${JSON.stringify(name)}; location.reload()`).catch(() => {});
        for (let i = 0; i < 100 && !await evaluate(`!!document.querySelector('.tg-home-nav-heading .tigerest-home-server') && !document.querySelector('.tg-home-window-mode').hidden
          && document.querySelector('.tigerest-home-server span').textContent === ${JSON.stringify(name)}`).catch(() => false); i++) await wait(30);
    };
    const measure = () => evaluate(`(() => {
      const heading = document.querySelector('.tg-home-nav-heading'), eyebrow = heading.querySelector('.tg-home-eyebrow');
      const chip = heading.querySelector('.tigerest-home-server'), label = chip.querySelector('span'), windowButton = heading.querySelector('.tg-home-window-mode');
      const windowLabel = windowButton.querySelector('.tigerest-window-label'), rect = node => node.getBoundingClientRect();
      const shown = node => !!node && node.getClientRects().length > 0;
      const parts = [eyebrow, chip, windowButton].map(rect);
      return {width: Math.round(rect(heading).width), titleFits: eyebrow.scrollWidth <= eyebrow.clientWidth + 1,
        headingFits: heading.scrollWidth <= heading.clientWidth + 1 && parts.every(r => r.right <= rect(heading).right + 1),
        overlap: parts.some((a, i) => parts.slice(i + 1).some(b => a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1)),
        rows: new Set(parts.map(r => Math.round(r.top + r.height / 2))).size > 2 ? 3 : parts[0].bottom <= Math.min(parts[1].top, parts[2].top) + 1 ? 2 : 1,
        serverText: shown(label) ? label.textContent : '', serverTruncated: shown(label) && label.scrollWidth > label.clientWidth + 1,
        serverIcon: shown(chip.querySelector('svg')), windowText: shown(windowLabel) ? windowLabel.textContent : '', windowIcon: shown(windowButton.querySelector('svg')),
        serverLabel: chip.getAttribute('aria-label'), windowLabelAria: windowButton.getAttribute('aria-label'),
        chipSize: [Math.round(rect(chip).width), Math.round(rect(chip).height)], windowSize: [Math.round(rect(windowButton).width), Math.round(rect(windowButton).height)]};
    })()`);
    const results = {};
    for (const name of ['TIGEREST THEATER MEDIA SERVER', '大河专属 EMBY']) {
        await load(name);
        for (const width of [948, 1100, 1280, 1600, 1920]) {
            await call('Emulation.setDeviceMetricsOverride', {width, height: 860, deviceScaleFactor: 1, mobile: false});
            await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
            await wait(30);
            const m = await measure();
            results[name + ' @' + width] = m;
            const where = `${name} @${width}: ${JSON.stringify(m)}`;
            assert.ok(m.titleFits, 'title is never squeezed: ' + where);
            assert.ok(m.headingFits && !m.overlap, 'controls stay inside the heading: ' + where);
            assert.ok(!m.serverTruncated, 'the server name is shown whole or replaced by its icon: ' + where);
            assert.ok(m.serverText === name || (m.serverText === '' && m.serverIcon), 'server chip shows its name or an icon: ' + where);
            assert.ok(m.windowText === '全屏' || (m.windowText === '' && m.windowIcon), 'window control keeps its icon: ' + where);
            assert.equal(m.serverLabel, `当前服务器：${name}。切换服务器`, 'icon-only chip keeps its accessible name');
            assert.match(m.windowLabelAria, /全屏/);
            assert.ok(m.chipSize.every(v => v >= 36) && m.windowSize.every(v => v >= 36), 'icon buttons stay large enough to hit: ' + where);
        }
        // A wide library column shows text again: the server name when it fits, else the window label.
        const wide = results[name + ' @1920'];
        assert.ok(wide.serverText || wide.windowText, name + ': labels return when there is room ' + JSON.stringify(wide));
    }
    assert.equal(results['大河专属 EMBY @1920'].serverText, '大河专属 EMBY');
    await evaluate(`document.querySelector('.tigerest-home-server').click()`);
    assert.equal(await evaluate('switches'), 1);
    console.log(JSON.stringify({passed: true, fit: Object.fromEntries(Object.entries(results).map(([k, m]) => [k, [m.width, m.serverText ? "name" : "icon", m.windowText ? "label" : "icon", m.rows]]))}));
}).catch(error => { console.error(error); process.exitCode = 1; });
