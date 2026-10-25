// The glass header: skinHeader blurs the page under it. Its rows, buttons,
// title and tabs also carry backdrop filters (ours on .headerTop, the header
// controls', and a theme's !important ones). In Chromium 143+ an element with
// a backdrop filter is a Backdrop Root, so those children only re-filter the
// header's own flat background, yet each costs a filter pass on every
// scrolled frame (device scroll P95 16.7 ms with them, 8.5 ms without).
// Painting that colour directly must look the same, at rest and on hover.
// Real webAppearance, header-control and Jellyfin 10.11.11 header styles:
// Jellyfin's header buttons keep `appearance: auto` and are skinned by their
// background and border. The theme rules mirror a popular Jellyfin theme's
// header selectors.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const rawBrowser = require('./community_browser.cjs');
// Native startup also injects appearance scripts into the top document.
// Keep the fixture in its own same-origin frame, so both screenshot variants
// exercise only the requested source and not the executable's bundled copy.
const withBrowser = (routes, work) => rawBrowser({...routes, '/fixture': routes['/'],
    '/': {type: 'text/html', body: '<!doctype html><style>html,body,iframe{margin:0!important;width:100%;height:100%;border:0}iframe{display:block}</style><iframe id="fixture" src="/fixture"></iframe>'}},
    async ({evaluate: outerEvaluate, call}) => work({call,
        evaluate: expression => outerEvaluate('document.getElementById("fixture").contentWindow.eval(' + JSON.stringify(expression) + ')')}));
const root = path.resolve(__dirname, '..');
const shell = fs.readFileSync(path.join(root, 'native/nativeshell.js'), 'utf8');
const controls = shell.slice(shell.indexOf('function installHeaderControlsStyle()'), shell.indexOf('function currentServerLabel()'));
const jellyfin = fs.readFileSync(path.join(__dirname, 'fixtures/jellyfin-detail/jellyfin-10.11.css'), 'utf8');
// A colourful wall under the header makes any real backdrop blur visible.
// Explicit tab font/Latin labels keep this pixel fixture deterministic:
// identical unoptimized reloads otherwise changed 464 CJK glyph pixels on
// Windows. Chinese title/native-control coverage remains in the top row.
const stripes = Array.from({length: 60}, (_, i) => `<div style="height:14px;background:hsl(${i * 47 % 360} 90% ${40 + i % 3 * 15}%)"></div>`).join('');
const icon = 'headerButton paper-icon-button-light';
const page = `<!doctype html><meta charset="utf-8"><style>${jellyfin}
body{font:16px system-ui}
/* jellyfin-web emby-button.scss */
.paper-icon-button-light{position:relative;display:inline-flex;align-items:center;justify-content:center;font-size:1.5em;color:inherit;margin:0 .29em;background:transparent;text-align:center;padding:.556em;vertical-align:middle;border:0;border-radius:50%;outline:none!important;overflow:hidden;z-index:0;flex-shrink:0}
.headerTabs{display:flex;justify-content:center}.emby-tabs-slider{display:flex;border-radius:50px}
.emby-tab-button{padding:.7em 1.2em;border:0;background:transparent;color:#fff;font:14px/20px Arial}
.headerButton,.pageTitle,.emby-tabs-slider{-webkit-backdrop-filter:blur(15px)!important;backdrop-filter:blur(15px)!important}
.emby-tabs-slider{background-color:rgba(20,20,24,.69)!important}
.paper-icon-button-light:hover,.paper-icon-button-light:hover:not(:disabled){background-color:rgba(0,0,0,.4)!important}
</style>
<div class="skinHeader focuscontainer-x skinHeader-withBackground semiTransparent"><div class="flex align-items-center flex-grow headerTop"><div class="headerLeft">
<button class="${icon} headerButtonLeft headerBackButton">‹</button><button class="${icon} headerHomeButton barsMenuButton headerButtonLeft">⌂</button><h3 class="pageTitle">电影</h3><button class="pageTitle native">原生</button></div>
<div class="headerRight"><button class="${icon} headerButtonRight headerSearchButton" id="search">⌕</button><button class="${icon} headerButtonRight headerUserButton headerUserButtonRound">☺</button></div></div>
<div class="headerTabs"><div class="tabs-viewmenubar"><div class="tabs-viewmenubar-slider emby-tabs-slider"><button class="emby-tab-button main-tab-button emby-tab-button-active">Movies</button><button class="emby-tab-button main-tab-button">Favorites</button></div></div></div></div>
<main>${stripes}</main><script src="/appearance.js"></script><script>${controls};installHeaderControlsStyle();</script>`;
// A theme stylesheet that arrives after its <link> is inserted.
const late = http.createServer((request, response) => setTimeout(() => {
    response.setHeader('Content-Type', 'text/css');
    response.end('html body .skinHeader.skinHeader-withBackground.semiTransparent{background:rgba(170,15,60,.82)!important}html body .skinHeader .headerTop{background:rgba(80,30,130,.75)!important}');
}, 400));
(async () => {
    await new Promise(resolve => late.listen(0, '127.0.0.1', resolve));
    try {
        await withBrowser({'/': {type: 'text/html', body: page}, '/appearance.js': {path: path.join(root, 'native/webAppearance.js')}}, run);
    } finally { late.closeAllConnections(); await new Promise(resolve => late.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

async function run({evaluate, call}) {
    const frames = () => evaluate('new Promise(r => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 400))');
    await call('Emulation.setDeviceMetricsOverride', {width: 600, height: 400, deviceScaleFactor: 1, mobile: false});
    const {userAgent} = await call('Browser.getVersion');
    const away = () => call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: 300, y: 390});
    const load = async agent => {
        const previousOrigin = await evaluate('performance.timeOrigin');
        await call('Emulation.setUserAgentOverride', {userAgent: agent});
        await call('Page.reload', {ignoreCache: true});
        const ready = `performance.timeOrigin !== ${previousOrigin} && document.readyState === 'complete' && !!document.getElementById('tigerest-header-controls-style')`;
        for (let i = 0; i < 100 && !await evaluate(ready).catch(() => false); i++) await new Promise(r => setTimeout(r, 50));
        assert.ok(await evaluate(ready), 'the new fixture document finished loading');
        await evaluate('document.fonts.ready.then(() => true)');
        await away(); await frames();
    };
    const children = ['.headerTop', '.headerBackButton', '.headerHomeButton', '.pageTitle', '#search', '.headerUserButton', '.emby-tabs-slider'];
    const filters = () => evaluate(`Object.fromEntries(['.skinHeader', ...${JSON.stringify(children)}].map(s => [s, getComputedStyle(document.querySelector(s)).backdropFilter]))`);
    // The whole header, tabs included.
    const shot = async () => {
        if (process.env.TIGEREST_HEADER_EVIDENCE) {
            fs.mkdirSync(process.env.TIGEREST_HEADER_EVIDENCE, {recursive: true});
            fs.appendFileSync(path.join(process.env.TIGEREST_HEADER_EVIDENCE,'geometry.jsonl'),JSON.stringify(await evaluate(`({ua:navigator.userAgent,
                nodes:[...document.querySelectorAll('.skinHeader,.skinHeader *')].map(e=>({tag:e.tagName,cls:e.className,rect:e.getBoundingClientRect().toJSON(),font:getComputedStyle(e).font,transform:getComputedStyle(e).transform,animations:e.getAnimations().map(a=>({state:a.playState,time:a.currentTime}))}))})`))+'\n');
        }
        return (await call('Page.captureScreenshot', {format: 'png', clip: {x: 0, y: 0, width: 600, scale: 1,
            height: Math.ceil(await evaluate(`document.querySelector('.skinHeader').getBoundingClientRect().bottom`))}})).data;
    };
    // Right after a reload a pointer move can reach the page late, leaving the
    // capture without its hover state: wait until the element reports :hover,
    // nudging the pointer again if it does not.
    const pointAt = async selector => {
        const target = JSON.stringify(selector);
        for (let attempt = 0; attempt < 5; attempt++) {
            const at = await evaluate(`(() => { const r = document.querySelector(${target}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
            await call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: at[0] + attempt % 2, y: at[1]});
            for (let i = 0; i < 20; i++) {
                if (await evaluate(`document.querySelector(${target}).matches(':hover')`)) { await frames(); return; }
                await new Promise(r => setTimeout(r, 25));
            }
        }
        assert.fail('the pointer never hovered ' + selector);
    };
    const hover = async () => { await pointAt('#search'); const image = await shot(); await away(); await frames(); return image; };
    // The compositor may snap text to a different pixel row between loads; each
    // pixel matches its closest neighbour within 1px, which a lost filter (it
    // changes the whole glass) cannot pass.
    const compare = (a, b) => evaluate(`(async () => {
      async function pixels(data) { const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
        const c = new OffscreenCanvas(image.width, image.height), x = c.getContext('2d'); x.drawImage(image, 0, 0); return {w: c.width, h: c.height, data: x.getImageData(0, 0, c.width, c.height).data}; }
      const A = await pixels(${JSON.stringify(a)}), B = await pixels(${JSON.stringify(b)}), d = [];
      const at = (image, x, y, k) => image.data[(y * image.w + x) * 4 + k];
      for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
        let best = 255;
        for (let dy = -1; dy <= 1 && best; dy++) for (let dx = -1; dx <= 1 && best; dx++) {
          const u = x + dx, v = y + dy;
          if (u < 0 || v < 0 || u >= B.w || v >= B.h) continue;
          best = Math.min(best, Math.max(...[0, 1, 2].map(k => Math.abs(at(A, x, y, k) - at(B, u, v, k)))));
        }
        d.push(best);
      }
      d.sort((x, y) => x - y);
      return {mean: d.reduce((s, v) => s + v, 0) / d.length, p99: d[Math.floor(d.length * .99)], over20: d.filter(v => v > 20).length, max: d.at(-1)};
    })()`);
    // The previous nested filter stack: an engine without Backdrop Roots.
    await load(userAgent.replace(/(?:Headless)?Chrome\/[\d.]+/, 'Fixture/1'));
    const nestedFilters = await filters();
    assert.equal(nestedFilters['.headerTop'], 'blur(20px) saturate(1.32)', 'fixture: the nested stack is present ' + JSON.stringify(nestedFilters));
    assert.equal(nestedFilters['.headerBackButton'], 'blur(15px)', 'fixture: the theme blurs Jellyfin buttons');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.headerBackButton')).appearance`), 'auto', 'fixture: Jellyfin buttons keep appearance:auto');
    const nested = {rest: await shot(), hover: await hover()};
    // QtWebEngine 6.9 (Chromium 130) lets a nested filter see the page (its
    // own pixels differ): it keeps the real stack.
    await load(userAgent.replace(/Chrome\/[\d.]+/, 'Chrome/130.0.0.0') + ' QtWebEngine/6.9.3');
    assert.deepEqual(await filters(), nestedFilters, 'Chromium 130 keeps every nested filter');
    await load(userAgent);
    const shipped = await filters();
    assert.equal(shipped['.skinHeader'], 'blur(20px) saturate(1.32)', 'the header keeps its glass');
    const chromiumVersion = +(/Chrome\/(\d+)\./.exec(userAgent)?.[1] || 0);
    if (chromiumVersion < 143) {
        assert.deepEqual(shipped, nestedFilters, 'the actual older engine keeps every original filter');
        assert.equal(await evaluate(`document.querySelectorAll('[data-tigerest-flat-glass]').length`), 0,
            'the actual older engine creates no flat replacements');
        const rest = await compare(await shot(), nested.rest), hovered = await compare(await hover(), nested.hover);
        for (const [name, diff] of Object.entries({rest, hovered})) assert.ok(diff.mean < .8 && diff.p99 <= 8 && diff.over20 <= 80,
            'retaining the old engine filter stack preserves its pixels (' + name + '): ' + JSON.stringify(diff));
        console.log(JSON.stringify({passed: true, chromiumVersion, path: 'original filters', shipped, rest, hovered}));
        return;
    }
    for (const child of children.filter(child => !['.emby-tabs-slider', '.headerTop'].includes(child)))
        assert.equal(shipped[child], 'none', `${child} runs no filter pass of its own: ${JSON.stringify(shipped)}`);
    assert.equal(shipped['.headerTop'], 'blur(20px) saturate(1.32)', 'the unstyled native button retains its backdrop root');
    // The top row's drop shadow falls into the tabs' box, and the old filter
    // copied that gradient under them: no one colour matches it.
    assert.equal(shipped['.emby-tabs-slider'], 'blur(15px)', 'tabs under a sibling shadow keep their real filter');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.native')).backdropFilter`), 'blur(15px)', 'an unstyled native control keeps its own look and filter');
    const flat = {rest: await shot(), hover: await hover()};
    const animationReads = await evaluate(`(() => {
        const original=Element.prototype.getAnimations;let reads=0;
        Element.prototype.getAnimations=function(...args){if(this.closest('.skinHeader'))reads++;return original.apply(this,args)};
        try{flattenTigerestHeaderGlass();return {reads,nodes:document.querySelectorAll('.skinHeader,.skinHeader *').length};}
        finally{Element.prototype.getAnimations=original;}
    })()`);
    assert.ok(animationReads.reads <= animationReads.nodes,
        'a header pass must not flush animation state repeatedly for each CSS property: '+JSON.stringify(animationReads));
    if (process.env.TIGEREST_HEADER_EVIDENCE) {
        fs.mkdirSync(process.env.TIGEREST_HEADER_EVIDENCE, {recursive: true});
        for (const [kind, variants] of Object.entries({nested, flat}))
            for (const [state, data] of Object.entries(variants))
                fs.writeFileSync(path.join(process.env.TIGEREST_HEADER_EVIDENCE, `${kind}-${state}.png`), Buffer.from(data, 'base64'));
    }
    assert.equal((await filters())['#search'], 'none', 'leaving a control restores its flat glass');
    const rest = await compare(flat.rest, nested.rest), hovered = await compare(flat.hover, nested.hover);
    for (const [name, d] of [['at rest', rest], ['on hover', hovered]])
        // Left: 8-bit rounding of the filtered colour and the antialiased rim
        // of rounded corners (a clipped backdrop versus a rounded background).
        assert.ok(d.mean < .8 && d.p99 <= 8 && d.over20 <= 80, `the flattened header looks the same ${name}: ${JSON.stringify(d)}`);

    // The stored colours always follow the page's current styles.
    const read = `Object.fromEntries(${JSON.stringify(children)}.map(s => [s, document.querySelector(s).style.getPropertyValue('--tigerest-flat-glass-bg')]))`;
    const stored = () => evaluate(read);
    const fresh = () => evaluate(`(() => { flattenTigerestHeaderGlass(); return ${read}; })()`);
    const initial = await stored();
    // A theme change while a control is hovered, then the pointer leaves.
    await pointAt('#search');
    await evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>html body .skinHeader.skinHeader-withBackground.semiTransparent{background:rgba(160,20,30,.8)!important}html body .skinHeader .headerTop{background:rgba(20,160,30,.7)!important}</style>')`);
    await frames(); await away(); await frames();
    const afterHover = await stored();
    assert.notEqual(afterHover['#search'], initial['#search'], 'fixture: the theme changed the header control colour');
    assert.deepEqual(afterHover, await fresh(), 'leaving a control after a theme change shows the new colours');
    // A stylesheet <link> that loads after it is inserted.
    await evaluate(`new Promise(resolve => { const link = document.createElement('link'); link.rel = 'stylesheet';
      link.href = 'http://127.0.0.1:${late.address().port}/late.css'; link.onload = resolve; document.head.append(link); })`);
    await frames();
    const afterLink = await stored();
    assert.notDeepEqual(afterLink, afterHover, 'fixture: the late stylesheet changes the header');
    assert.deepEqual(afterLink, await fresh(), 'a late stylesheet updates the flat colours');
    // Without that shadow the tabs sit on one colour too.
    await evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>html body .skinHeader .headerTop{box-shadow:none!important}</style>')`);
    await frames();
    assert.equal((await filters())['.emby-tabs-slider'], 'none', 'tabs clear of other paint are flattened');
    assert.deepEqual(await stored(), await fresh(), 'the tabs colour follows the page');
    // A patterned background is not one colour: keep the real filters.
    await evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>html body .skinHeader .headerLeft{background:repeating-linear-gradient(90deg,#ff2040 0 15px,#2070ff 15px 30px)!important}</style>')`);
    await frames();
    const patterned = await filters();
    for (const child of ['.headerBackButton', '.headerHomeButton', '.pageTitle'])
        assert.equal(patterned[child], 'blur(15px)', `${child} over a gradient keeps its real filter: ${JSON.stringify(patterned)}`);
    assert.equal(patterned['#search'], 'none', 'controls outside the gradient stay flat');
    await evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>html body .skinHeader.skinHeader-withBackground.semiTransparent{background:repeating-linear-gradient(90deg,#ff2040 0 15px,#2070ff 15px 30px)!important}</style>')`);
    await frames();
    const striped = await filters();
    assert.equal(striped['.headerTop'], 'blur(20px) saturate(1.32)', 'a patterned header keeps every real filter ' + JSON.stringify(striped));
    assert.equal(striped['.emby-tabs-slider'], 'blur(15px)', 'a patterned header keeps every real filter ' + JSON.stringify(striped));
    console.log(JSON.stringify({passed: true, shipped, rest, hovered, afterHover, afterLink}));
}
