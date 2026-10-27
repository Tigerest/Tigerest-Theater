'use strict';
// Measures Android page transitions on a real phone against the server the
// debug build is signed in to. Nothing is written to the server.
//   node dev/android-motion/measure.cjs <plan> [--rounds=3] [--inject[=homeTransitions,...]] [--cold] [--set=<expr>] [--record=<dir>] [--trace=<prefix>] [--out=<file.json>]
// Plans: cycle (home -> detail -> wall -> detail -> wall -> home -> library -> home),
//        wall (wall -> detail -> wall, repeated), home (home -> detail -> wall -> home).
// --inject loads the working tree's native/homeTransitions.js and
// native/homeMotion.js into the running page instead of the APK's copies.
// Frame times come from SurfaceFlinger (what the display presented), mapped
// to the page clock through requestAnimationFrame, which runs on the same
// vsync as the app's frames.
// ADB and ANDROID_SERIAL pick the device as for android/tests. --record runs
// screenrecord on each round; on a foldable set ANDROID_DISPLAY_ID to the
// screen in use (`dumpsys SurfaceFlinger --display-id`). flicker.py then
// checks a recording frame by frame.
const fs = require('node:fs'), path = require('node:path'), {execFileSync, spawn} = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const {connect, run, delay, adb, serial} = require(path.join(repo, 'android/tests/cdp.cjs'));
const argument = (name, fallback) => process.argv.find(a => a.startsWith('--' + name + '='))?.split('=').slice(1).join('=') ?? (process.argv.includes('--' + name) ? true : fallback);
const PACKAGE = 'top.tigerest.theater.debug';
const shell = command => run('shell', command);

function layerName() {
    const list = shell('dumpsys SurfaceFlinger --list');
    const names = [...list.matchAll(/RequestedLayerState\{(top\.tigerest\.theater\.debug\/top\.tigerest\.theater\.MainActivity#\d+)/g)].map(m => m[1]);
    if (!names.length) throw Error('debug activity layer not found');
    return names.at(-1);
}
// SurfaceFlinger keeps the last 128 presents of a layer; poll and merge.
function presents(layer) {
    const rows = shell(`dumpsys SurfaceFlinger --latency '${layer}'`).split('\n').slice(1).map(l => l.trim().split(/\s+/).map(Number));
    return rows.filter(r => r.length === 3 && r[1] > 0 && r[1] < 9e18).map(r => r[1] / 1e6);
}
function recorder(layer) {
    const seen = new Set();
    let stop = false;
    const loop = (async () => { while (!stop) { for (const t of presents(layer)) seen.add(Math.round(t * 1000) / 1000); await delay(250); } })();
    return async () => { stop = true; await loop; for (const t of presents(layer)) seen.add(Math.round(t * 1000) / 1000); return [...seen].sort((a, b) => a - b); };
}
const probe = `(()=>{
  if (window.__tgm) return true;
  const m = window.__tgm = {events: [], inputs: []};
  for (const type of ['pointerdown','pointerup','click']) addEventListener(type, e => m.events.push([type, e.timeStamp, performance.now()]), true);
  const motion = window.TigerestHomeMotion, back = motion && motion.handleNativeBack;
  if (back && !back.__tgm) { motion.handleNativeBack = function () { m.events.push(['back', performance.now(), performance.now()]); return back.apply(this, arguments); }; motion.handleNativeBack.__tgm = true; }
  new MutationObserver(records => { for (const r of records) {
      for (const n of r.addedNodes) if (n.classList?.contains('tigerest-motion-input')) m.inputs.push(['blocked', performance.now()]);
      for (const n of r.removedNodes) if (n.classList?.contains('tigerest-motion-input')) m.inputs.push(['released', performance.now()]);
  } }).observe(document.body, {childList: true});
  return true;
})()`;
// Offset (ms) from the page clock to CLOCK_MONOTONIC: rAF timestamps are the
// vsync times hwui reports as IntendedVsync.
async function clockOffset(c) {
    shell(`dumpsys gfxinfo ${PACKAGE} reset`);
    // A changing pixel keeps the app drawing every vsync while sampling.
    const raf = await c.evaluate(`new Promise(r=>{const d=document.createElement('div');d.style.cssText='position:fixed;left:0;top:0;width:2px;height:2px;z-index:2147483647;pointer-events:none;background:#000';document.body.append(d);const t=[];const f=ts=>{t.push(ts);d.style.opacity=t.length%2?'.5':'.6';if(t.length<40)requestAnimationFrame(f);else{d.remove();r(t)}};requestAnimationFrame(f);})`);
    const vsync = shell(`dumpsys gfxinfo ${PACKAGE} framestats`).split('\n').filter(l => /^\d+,/.test(l)).map(l => Number(l.split(',')[2]) / 1e6);
    let best = [0, 0];
    for (const v of vsync.slice(0, 20)) for (const t of raf.slice(0, 5)) {
        const off = v - t, hits = raf.filter(u => vsync.some(w => Math.abs(w - u - off) < .25)).length;
        if (hits > best[1]) best = [off, hits];
    }
    if (best[1] < raf.length * .8) throw Error('could not align page clock to vsync: ' + best[1] + '/' + raf.length);
    return best[0];
}
// The APK injects its scripts at document start; the working-tree copies are
// evaluated after them, at DOMContentLoaded, before Emby constructs the plugin
// that attaches the router hooks. The page is reloaded to apply them.
async function inject(c) {
    if (argument('inject', false) === false) return [];
    const names = argument('inject') === true ? ['homeTransitions', 'homeMotion'] : String(argument('inject')).split(',');
    const files = names.map(n => `native/${n}.js`);
    const stamp = Date.now().toString(36);
    const body = files.map(f => `;(function(){\n${fs.readFileSync(path.join(repo, f), 'utf8')}\n}).call(window);`).join('\n');
    const source = `if(window===window.top)document.addEventListener('DOMContentLoaded',()=>{${body}\nwindow.__tgmInjected=${JSON.stringify(stamp)};},{once:true});`;
    await c.call('Page.enable');
    await c.call('Page.addScriptToEvaluateOnNewDocument', {source});
    await c.call('Page.reload', {ignoreCache: false});
    await delay(1500);
    const ok = await waitFor(c, `window.__tgmInjected===${JSON.stringify(stamp)}&&document.readyState==='complete'&&!!window.TigerestHomeMotion`, 20000);
    if (!ok) throw Error('working-tree scripts did not load');
    await delay(2500);
    return files;
}
const state = `(()=>{
  const view=[...document.querySelectorAll('.mainAnimatedPage,.page')].filter(n=>!n.classList.contains('hide')&&n.getBoundingClientRect().width>0).at(-1);
  // A home press during the gallery's entrance can land on a cover still flying in.
  return {home:document.body.classList.contains('tg-home-active')&&!!document.querySelector('.tg-home.tg-entered'),detail:!!view?.matches('.view-item-item,.itemDetailPage'),hash:location.hash.replace(/id=[^&]+/,'id=…'),busy:!!window.TigerestHomeTransitions?.busy};
})()`;
// Card to press, in device pixels (the WebView fills the screen).
const pick = kind => `(()=>{
  const ok=r=>r.width>20&&r.height>20&&r.top>=60&&r.bottom<=innerHeight-8&&r.left>=0&&r.right<=innerWidth;
  const view=[...document.querySelectorAll('.mainAnimatedPage,.page')].filter(n=>!n.classList.contains('hide')&&n.getBoundingClientRect().width>0).at(-1)||document;
  // A touch on an unselected home cover or library only selects it.
  const g=window.TigerestHomeMotion?.gallery;
  const sel={cover:'.tg-cover[data-index="'+g?.index+'"]',library:'.tg-library[data-library-id="'+g?.selectedLibrary?.Id+'"]',card:'.card .cardImageContainer, .card img.cardImage'}[${JSON.stringify(kind)}];
  const root=${JSON.stringify(kind)}==='card'?view:document;
  const nodes=[...root.querySelectorAll(sel)].filter(n=>ok(n.getBoundingClientRect()));
  const index=Math.min(nodes.length-1,window.__tgmPick=((window.__tgmPick??-1)+1)%Math.max(1,Math.min(nodes.length,${kind === 'card' ? 6 : 3})));
  const n=nodes[Math.max(0,index)];if(!n)return null;const r=n.getBoundingClientRect();
  return {x:(r.x+r.width/2)*devicePixelRatio,y:(r.y+r.height/2)*devicePixelRatio,name:(n.closest('.card,.tg-cover,.tg-library')?.innerText||'').split('\\n')[0].slice(0,20)};
})()`;
async function waitFor(c, expression, timeout = 6000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const value = await c.evaluate(expression).catch(() => null); if (value) return value; await delay(60); }
    return null;
}
function frameStats(times, from, to) {
    const inside = times.filter(t => t >= from && t <= to), gaps = inside.slice(1).map((t, i) => t - inside[i]);
    const sorted = [...gaps].sort((a, b) => a - b);
    return {frames: inside.length, fps: inside.length > 1 ? Math.round((inside.length - 1) / ((inside.at(-1) - inside[0]) / 1000)) : 0,
        over9: gaps.filter(g => g > 9.5).length, over12: gaps.filter(g => g > 12.5).length, over17: gaps.filter(g => g > 17.5).length,
        maxGap: Math.round((sorted.at(-1) || 0) * 10) / 10, p95: Math.round((sorted[Math.floor(sorted.length * .95)] || 0) * 10) / 10,
        gaps: gaps.map((g, i) => [Math.round(inside[i] - from), Math.round(g * 10) / 10]).filter(([, g]) => g > 9.5)};
}
const TRACE_CATEGORIES = ['toplevel', 'benchmark', 'cc', 'viz', 'gpu', 'blink', 'v8', 'input', 'loading', 'android_webview', 'devtools.timeline',
    'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-cc.debug.scheduler.frames', 'disabled-by-default-viz.debug.overlay_planes'];
async function traced(c, file, work) {
    if (!file) return work();
    let complete;
    const done = new Promise(resolve => { complete = resolve; });
    c.onEvent(m => { if (m.method === 'Tracing.tracingComplete') complete(m.params.stream); });
    await c.call('Tracing.start', {transferMode: 'ReturnAsStream', traceConfig: {recordMode: 'recordAsMuchAsPossible', includedCategories: TRACE_CATEGORIES}});
    await delay(300);
    try { return await work(); }
    finally {
        await c.call('Tracing.end');
        const stream = await done;
        const out = fs.openSync(file, 'w');
        for (;;) { const chunk = await c.call('IO.read', {handle: stream, size: 1 << 20}); fs.writeSync(out, chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data); if (chunk.eof) break; }
        fs.closeSync(out); await c.call('IO.close', {handle: stream});
    }
}
async function step(c, layer, offset, name, trigger) {
    await c.evaluate('window.__tgm.events.length=0;window.__tgm.inputs.length=0;window.__tgmLast=window.TigerestHomeTransitions?.last;true');
    const stop = recorder(layer);
    await delay(300);
    // --cold drops the prepared background bitmap, as a press right after a page appeared.
    if (argument('cold', false)) await c.evaluate('window.TigerestHomeTransitions.invalidate(false);true');
    const before = await c.evaluate('performance.now()');
    await trigger();
    // The transition object changes once a run has finished.
    const done = await waitFor(c, '!window.TigerestHomeTransitions.busy && window.TigerestHomeTransitions.last!==window.__tgmLast && window.TigerestHomeTransitions.last', 8000);
    await delay(700);
    const times = (await stop()).map(t => t - offset);
    const probeData = await c.evaluate('JSON.parse(JSON.stringify(window.__tgm))');
    const pressed = probeData.events.find(e => e[0] === 'pointerdown' || e[0] === 'back');
    const start = pressed ? pressed[1] : before;
    const released = probeData.inputs.filter(i => i[0] === 'released').at(-1)?.[1];
    const click = probeData.events.find(e => e[0] === 'click');
    const metric = done || {};
    const end = released ?? (start + (metric.totalMs || 0));
    // Frames presented from the press until input is released, and until
    // the screen stops changing for 100 ms after that.
    const after = times.filter(t => t > end);
    let settle = end;
    for (const t of after) { if (t - settle > 100) break; settle = t; }
    const result = {name, state: await c.evaluate(state), pressToClickMs: click ? Math.round(click[1] - start) : null,
        operableMs: released ? Math.round(released - start) : null, settledMs: Math.round(settle - start),
        frames: frameStats(times, start, end), tail: frameStats(times, end, settle),
        metric: Object.fromEntries(Object.entries(metric).filter(([k]) => !['surfaces', 'backgroundPhases'].includes(k)).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v]))};
    console.log(JSON.stringify({name, operableMs: result.operableMs, settledMs: result.settledMs, pressToClickMs: result.pressToClickMs, fps: result.frames.fps, over9: result.frames.over9, over12: result.frames.over12, over17: result.frames.over17, maxGap: result.frames.maxGap, tailMax: result.tail.maxGap, aim: metric.aim, fallback: metric.fallback, cacheHit: metric.cacheHit, deferRoute: metric.deferRoute, takeoffMs: result.metric.posterFirstMotionMs, routeStartMs: result.metric.routeStartMs, routedMs: result.metric.routedMs, homeMs: result.metric.homeMs, pageMs: result.metric.pageMs, loadedMs: result.metric.loadedMs, incomingMs: result.metric.incomingMs, landedMs: result.metric.landedMs, lightCacheHit: result.metric.lightCacheHit, preparedArt: result.metric.preparedArt, gaps: result.frames.gaps, tailGaps: result.tail.gaps.map(([at, g]) => [Math.round(at + end - start), g])}));
    return result;
}
async function screenRecord(dir, label) {
    if (!dir) return null;
    fs.mkdirSync(dir, {recursive: true});
    const remote = `/data/local/tmp/tgm-${label}.mp4`;
    const display = process.env.ANDROID_DISPLAY_ID ? ['--display-id', process.env.ANDROID_DISPLAY_ID] : [];
    const child = spawn(adb, ['-s', serial, 'shell', 'screenrecord', '--bit-rate', '60000000', ...display, remote], {stdio: 'ignore'});
    await delay(800);
    return async () => {
        try { shell('pkill -INT -x screenrecord'); } catch {}
        await new Promise(resolve => child.on('exit', resolve));
        await delay(500);
        const local = path.join(dir, label + '.mp4');
        execFileSync(adb, ['-s', serial, 'pull', remote, local], {stdio: 'ignore'});
        shell('rm -f ' + remote);
        return local;
    };
}
const tap = p => shell(`input tap ${Math.round(p.x)} ${Math.round(p.y)}`);
const back = () => shell('input keyevent KEYCODE_BACK');
(async () => {
    const plan = process.argv[2] || 'cycle', rounds = Number(argument('rounds', 3)), out = argument('out', null), recordDir = argument('record', null);
    const c = await connect();
    try {
        const injected = await inject(c);
        await c.evaluate(probe);
        // --set=<expression> runs in the page before measuring, e.g. an experiment switch.
        if (argument('set', null)) await c.evaluate(String(argument('set')) + ';true');
        const offset = await clockOffset(c), layer = layerName(), results = [];
        const press = kind => async () => {
            for (let attempt = 0; ; attempt++) {
                const p = await c.evaluate(pick(kind)); if (!p) throw Error('nothing to press: ' + kind); tap(p);
                // The gallery's auto-advance can unselect the cover between picking and the tap,
                // which then only selects it: press again, measured from that press.
                if (kind === 'card' || attempt || await waitFor(c, 'window.TigerestHomeTransitions.busy||window.TigerestHomeTransitions.last!==window.__tgmLast', 600)) return;
                await c.evaluate('window.__tgm.events.length=0;true');
            }
        };
        const ensure = async (want, timeout = 6000) => {
            // Home is reached unmeasured by going back from wherever a previous run stopped.
            for (let i = 0; want === 'home' && i < 3 && !await waitFor(c, `(${state}).home&&!window.TigerestHomeTransitions.busy`, 1500); i++) { back(); await delay(2500); }
            const s = await waitFor(c, `(${state}).${want}&&!window.TigerestHomeTransitions.busy`, timeout); if (!s) throw Error('not on ' + want); await delay(900);
        };
        const steps = {
            'home>detail': async () => { await ensure('home'); return step(c, layer, offset, 'home>detail', press('cover')); },
            'wall>detail': async () => {
                // Reach a wall without measuring: from home open the selected library, from a detail page go back.
                for (let i = 0; i < 3; i++) {
                    const s = await waitFor(c, `!window.TigerestHomeTransitions.busy&&(${state})`);
                    if (!s.home && !s.detail) break;
                    if (s.home) await press('library')(); else back();
                    await waitFor(c, `!window.TigerestHomeTransitions.busy`, 8000); await delay(1500);
                }
                await delay(600);
                return step(c, layer, offset, 'wall>detail', press('card'));
            },
            'detail>wall': async () => { await ensure('detail'); return step(c, layer, offset, 'detail>wall', back); },
            'wall>home': async () => step(c, layer, offset, 'wall>home', back),
            'home>library': async () => { await ensure('home'); return step(c, layer, offset, 'home>library', press('library')); }
        };
        const sequence = {cycle: ['home>detail', 'detail>wall', 'wall>detail', 'detail>wall', 'wall>home', 'home>library', 'wall>home'],
            wall: ['wall>detail', 'detail>wall'], home: ['home>detail', 'detail>wall', 'wall>home'], library: ['home>library', 'wall>home']}[plan];
        for (let round = 0; round < rounds; round++) {
            const stopRecording = await screenRecord(recordDir, `${plan}-${round + 1}`);
            const trace = argument('trace', null);
            for (const name of sequence) {
                const file = trace && `${trace}-${round + 1}-${results.length}-${name.replace('>', '-')}.json`;
                results.push({round: round + 1, trace: file, ...await traced(c, file, steps[name])}); await delay(800);
            }
            if (stopRecording) console.log(JSON.stringify({recording: await stopRecording()}));
        }
        if (out) fs.writeFileSync(out, JSON.stringify({plan, injected, offset, results}, null, 1));
    } finally { c.close(); try { run('forward', '--remove', 'tcp:9223'); } catch {} }
})().catch(error => { console.error(error); process.exitCode = 1; });
