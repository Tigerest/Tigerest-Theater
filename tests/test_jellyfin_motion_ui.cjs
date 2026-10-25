// A Jellyfin library card flies onto the detail poster and back, through the
// plugin's own attach: real hash history, Jellyfin's card markup (artwork as a
// background), its detail DOM and stylesheet, and the compact detail layout.
const assert = require('node:assert/strict'), path = require('node:path'), withBrowser = require('./community_browser.cjs');
const root = path.resolve(__dirname, '..');
const embedded = process.argv.includes('--webengine') || Boolean(process.env.TIGEREST_ANDROID_FIXTURE);
const art = "background-image:url('/poster.svg')";
const card = id => `<div class="card portraitCard" data-id="${id}"><div class="cardBox"><div class="cardScalable"><div class="cardPadder cardPadder-portrait"></div><div class="cardImageContainer coveredImage cardContent" style="${art}"></div></div><div class="cardText">${id}</div></div></div>`;
const cards = ['a', 'b', 'c', 'work', 'e', 'f'].map(card).join('');
const page = `<!doctype html><html class="layout-desktop"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/jellyfin.css"><style>body{background:#101010;color:#ddd}.flex{display:flex}.align-items-center{align-items:center}.flex-grow{flex-grow:1}
#moviesPage{padding-top:7em}#moviesPage .itemsContainer{display:flex;flex-wrap:wrap;padding:0 3.3%}#moviesPage .card{width:150px}</style>

</head><body dir="ltr">
<div class="skinHeader skinHeader-withBackground semiTransparent"><div class="flex align-items-center flex-grow headerTop"><div class="headerLeft"><button type="button" class="headerButton headerBackButton">&lsaquo;</button></div></div></div>
<div class="mainAnimatedPages skinBody">
<div id="moviesPage" class="page libraryPage mainAnimatedPage"><div class="pageTabContent" style="display:none"><div class="itemsContainer">${card('work')}</div></div><div class="itemsContainer" id="shown">${cards}</div></div>
<div id="itemDetailPage" class="page libraryPage itemDetailPage noSecondaryNavPage selfBackdropPage mainAnimatedPage hide">
  <div id="itemBackdrop" class="itemBackdrop" style="background-image:linear-gradient(#456,#123)"></div>
  <div class="detailPageWrapperContainer"><div class="detailPagePrimaryContainer">
    <div class="detailImageContainer hide-mobile"><div class="card portraitCard"><div class="cardBox"><div class="cardScalable"><div class="cardPadder cardPadder-portrait"></div><div class="cardImageContainer coveredImage cardContent" style="${art}"></div></div></div></div></div>
    <div class="detailRibbon padded-left padded-right"><div class="infoWrapper"><div class="nameContainer"><h1 class="itemName infoText parentNameLast">Work</h1></div></div>
      <div class="mainDetailButtons"><button type="button" class="button-flat btnPlay detailButton">Play</button></div></div>
    <div class="detailPagePrimaryContent padded-right"><div class="detailSection"><p class="overview">Overview</p></div></div>
  </div><div class="detailPageSecondaryContainer padded-bottom-page"></div></div>
</div></div>
${embedded ? '' : '<script src="/transitions.js"></script><script src="/motion.js"></script><script src="/jellyfin.js"></script>'}`;
const routes = {
    '/': {type: 'text/html', body: page},
    '/poster.svg': {type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#2f5d7c"/><circle cx="150" cy="180" r="80" fill="#e3c28f"/></svg>'},
    '/jellyfin.css': {type: 'text/css', path: path.join(__dirname, 'fixtures/jellyfin-detail/jellyfin-10.11.css')},
    '/transitions.js': {path: path.join(root, 'native/homeTransitions.js')}, '/motion.js': {path: path.join(root, 'native/homeMotion.js')},
    '/jellyfin.js': {path: path.join(root, 'native/jellyfinPlugin.js')}
};
const library = '#/movies?topParentId=L&collectionType=movies';
withBrowser(routes, async ({evaluate, call}) => {
    const software = await withBrowser.softwareRenderer(evaluate);
    if (software) { console.log('SKIP: frame-precise motion needs a hardware GPU (' + software + ')'); process.exitCode = withBrowser.SKIP_CODE; return; }
    await call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'no-preference'}]});
    await call('Emulation.setDeviceMetricsOverride', {width: 847, height: 948, deviceScaleFactor: 1, mobile: true});
    // Jellyfin's router: the address selects the page, show() waits for the
    // shown view, back() for the history change, showItem() returns nothing.
    await evaluate(`(() => {
      const render = () => {
        const detail = location.hash.startsWith('#/details');
        // Like Jellyfin's legacy home tabs, the page can rebuild its cards when shown again.
        if (!detail && window.rebuild) document.getElementById('shown').innerHTML = ${JSON.stringify(cards)};
        document.getElementById('moviesPage').classList.toggle('hide', detail);
        document.getElementById('itemDetailPage').classList.toggle('hide', !detail);
        document.querySelector(detail ? '#itemDetailPage' : '#moviesPage').dispatchEvent(new CustomEvent('viewshow', {bubbles: true}));
      };
      // Jellyfin mounts the next view after its router sees the change.
      addEventListener('hashchange', () => setTimeout(render, 120));
      history.replaceState(null, '', ${JSON.stringify(library)}); render();
      window.appRouter = {
        baseUrl: () => location.href.split('#')[0],
        getRouteUrl: item => item.Type === 'CollectionFolder' ? '#/movies?topParentId=' + item.Id + '&collectionType=movies' : '#/details?id=' + item.Id + '&serverId=' + item.ServerId,
        show(route) { return new Promise(resolve => { document.addEventListener('viewshow', () => resolve(), {once: true}); location.hash = route; }); },
        showItem(item) { this.show(this.getRouteUrl(item)); },
        back() { return new Promise(resolve => { addEventListener('hashchange', () => resolve(), {once: true}); history.back(); }); },
        goHome() { return this.show('#/home'); }
      };
      window.plugin = new _tigerestJellyfinPlugin({events: {on() {}}, appRouter, ServerConnections: {currentApiClient: () => ({serverId: () => 's', getCurrentUserId: () => 'one'})}});
      window.flights = [];
      window.press = () => { const node = document.querySelector('#shown [data-id="work"] .cardImageContainer');
        node.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
        appRouter.showItem({Id: 'work', Type: 'Movie', ServerId: 's'});
        return node.getBoundingClientRect().toJSON(); };
      // The poster is the innermost box of the flight stack added to the body.
      // Slow software rendering can drop the frame after the last sample, so the
      // final rectangle is also read just before the flight layer is removed.
      const tracked = [], remove = Element.prototype.remove;
      Element.prototype.remove = function () { for (const [flight, node] of tracked) if (node.isConnected && this.contains(node)) flight.last = node.getBoundingClientRect().toJSON(); return remove.call(this); };
      new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(added => {
        const node = added.querySelector?.('.tigerest-motion-poster'); if (!node) return;
        const flight = {first: node.getBoundingClientRect().toJSON(), last: null}; flights.push(flight); tracked.push([flight, node]);
        const sample = () => { if (!node.isConnected) return; flight.last = node.getBoundingClientRect().toJSON(); requestAnimationFrame(sample); }; sample();
      }))).observe(document.body, {childList: true});
      return true;
    })()`);
    await evaluate(`new Promise(resolve => { const image = new Image(); image.onload = image.onerror = resolve; image.src = '/poster.svg'; })`);
    await new Promise(resolve => setTimeout(resolve, 300));
    const pressed = await evaluate('press()');
    const settle = () => evaluate(`new Promise(resolve => { const poll = () => TigerestHomeTransitions.busy ? setTimeout(poll, 50) : resolve(); setTimeout(poll, 50); })`);
    await settle();
    const report = () => evaluate(`({metric: TigerestHomeTransitions.last, flight: flights.at(-1), flights: flights.length, hash: location.hash,
      target: document.querySelector('#itemDetailPage .detailImageContainer .cardImageContainer').getBoundingClientRect().toJSON(),
      card: document.querySelector('#shown [data-id="work"] .cardImageContainer').getBoundingClientRect().toJSON(),
      header: document.querySelector('.skinHeader').getBoundingClientRect().bottom,
      leaks: document.querySelectorAll('.tigerest-motion-layer,.tigerest-motion-poster,.tigerest-motion-input,[data-tigerest-poster-held]').length,
      entry: TigerestHomeMotion.entry?.itemId ?? null})`);
    const near = (a, b) => Math.max(...['x', 'y', 'width', 'height'].map(k => Math.abs(a[k] - b[k])));
    const opened = await report();
    assert.equal(opened.hash, '#/details?id=work&serverId=s');
    assert.equal(opened.leaks, 0, 'no transition layer remains');
    assert.equal(opened.entry, 'work', 'the detail keeps its return context');
    assert.ok(opened.flight, 'pressing a Jellyfin card starts a poster flight');
    assert.ok(near(opened.flight.first, pressed) < 1, 'the flight starts from the pressed card: ' + JSON.stringify(opened.flight.first));
    assert.ok(opened.metric.kind === 'poster' && !opened.metric.fallback && opened.metric.landingErrorPx < 2, 'the card lands on the detail poster: ' + JSON.stringify(opened.metric));
    assert.ok(near(opened.flight.last, opened.target) < 2, 'the last frame covers the detail poster: ' + JSON.stringify({last: opened.flight.last, target: opened.target}));
    assert.ok(opened.target.y >= opened.header, 'the detail poster is below the header');
    await evaluate('appRouter.back()');
    await settle();
    const returned = await report();
    assert.equal(returned.hash, library);
    assert.equal(returned.leaks, 0);
    assert.equal(returned.flights, 2, 'one flight each way');
    assert.ok(returned.metric.kind === 'poster' && !returned.metric.fallback && returned.metric.landingErrorPx < 2, 'the poster flies back: ' + JSON.stringify(returned.metric));
    assert.ok(near(returned.flight.last, returned.card) < 2, 'the return lands on the pressed library card');
    assert.equal(returned.entry, null);
    // The pressed card is gone after the rebuild; the return finds the shown copy, not the hidden tab's.
    await evaluate('window.rebuild = true, press()');
    await settle();
    await evaluate('appRouter.back()');
    await settle();
    const rebuilt = await report();
    assert.equal(rebuilt.hash, library);
    assert.equal(rebuilt.leaks, 0);
    assert.ok(rebuilt.metric.kind === 'poster' && !rebuilt.metric.fallback && rebuilt.metric.landingErrorPx < 2, 'a rebuilt page still receives the poster: ' + JSON.stringify(rebuilt.metric));
    assert.ok(near(rebuilt.flight.last, rebuilt.card) < 2, 'the return lands on the visible card');
    // Modern 10.x uses a React overlay anchor, separate from its artwork.
    // Its default navigation bypasses appRouter.showItem and loses the flight.
    await evaluate(`(() => {
      window.rebuild = false;
      const card = document.querySelector('#shown [data-id="work"]');
      card.dataset.type = 'Movie'; card.dataset.serverid = 's';
      const link = document.createElement('a'); link.href = '#/details?id=work&serverId=s';
      link.className = 'react-detail-overlay'; link.innerHTML = '<button data-action="play">Play</button>';
      card.querySelector('.cardScalable').append(link);
      window.reactPress = () => {
        link.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
        link.click();
      };
      window.documentMarker = {};
    })()`);
    await evaluate('reactPress()'); await settle();
    const reactOpened = await report();
    assert.equal(reactOpened.entry, 'work', 'React overlay navigation retains the return context');
    assert.equal(reactOpened.flights, rebuilt.flights + 1, 'React overlay starts one flight');
    assert.ok(reactOpened.metric.kind === 'poster' && !reactOpened.metric.fallback, 'React overlay uses the artwork');
    await evaluate('appRouter.back()'); await settle();
    const reactReturned = await report();
    assert.equal(reactReturned.hash, library); assert.equal(reactReturned.leaks, 0);
    assert.ok(near(reactReturned.flight.last, reactReturned.card) < 2, 'React return lands on its card');
    // Native link behavior and nested playback controls must remain untouched.
    const ignored = await evaluate(`(() => {
      const link = document.querySelector('.react-detail-overlay'), outcomes = [];
      const run = (target, init) => {
        let prevented;
        const stop = event => { prevented = event.defaultPrevented; event.preventDefault(); };
        document.addEventListener('click', stop);
        target.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, ...init}));
        document.removeEventListener('click', stop); outcomes.push(prevented);
      };
      run(link, {ctrlKey: true}); run(link, {button: 1}); run(link.querySelector('button'), {});
      const href = link.href; link.href = 'https://elsewhere.test/#/details?id=work'; run(link, {});
      link.href = '#/details?id=another&serverId=s'; run(link, {}); link.href = href;
      plugin.disposeMotion(); run(link, {});
      return outcomes;
    })()`);
    assert.deepEqual(ignored, [false, false, false, false, false, false], 'unrelated actions and disposed listeners leave link behavior intact');
    console.log('jellyfin motion fixture:', JSON.stringify({opened: opened.metric.landingErrorPx, returned: returned.metric.landingErrorPx, rebuilt: rebuilt.metric.landingErrorPx}));
}, {gpu: true, visible: true}).catch(error => { console.error(error); process.exitCode = 1; });
