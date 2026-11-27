// Raw captures for the usage tour's player pictures (native/tour-art), from the
// real client on an isolated test profile; no media server, no account.
//
//   . ./dev/windows/Enter-TestEnvironment.ps1
//   python dev/windows/tour-art/compose.py clip          # the demo clip
//   node dev/windows/tour-art/capture.cjs "build/src/Tigerest Theater.exe" --webengine
//   python dev/windows/tour-art/compose.py               # native/tour-art/*.webp
//
// The clip (made from the client's own home art) is served over HTTP like a
// server's stream, so the control bar shows the buttons of server playback.
// mpv renders SDR for the capture: on an HDR desktop the window would
// otherwise come out in HDR values. Captures: the playing window with the whole
// uosc interface, professional mode (the page's panels and mpv's own picture,
// joined by compose.py) and 设置 → 视频 at twice the density.
const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const {randomUUID} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const root = path.resolve(__dirname, '../../..');
const withBrowser = require(path.join(root, 'tests/community_browser.cjs'));
const work = path.join(root, 'build/tour-art');
const clip = path.join(work, 'clip.mkv');
const out = path.join(work, 'raw');
if (!fs.existsSync(clip)) throw Error('make the clip first: python dev/windows/tour-art/compose.py clip');
fs.mkdirSync(out, {recursive: true});
const pipe = '\\\\.\\pipe\\TigerestTourArt-' + randomUUID();
process.env.TIGEREST_MPV_TEST_OPTIONS = ['input-ipc-server=' + pipe, 'target-colorspace-hint=no', 'target-trc=srgb', 'target-prim=bt.709'].join('\n');
const routes = {
    '/clip.mkv': {type: 'video/x-matroska', path: clip},
    '/': {type: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Tour art</title><body style="margin:0;background:#101216;color:#eee;font-family:\'Segoe UI\',\'Microsoft YaHei\',sans-serif">'}
};
const until = async (check, label, limit = 300) => {
    for (let i = 0; i < limit; i++) { const value = await check(); if (value) return value; await delay(100); }
    throw Error('Timed out: ' + label);
};

withBrowser(routes, async ({evaluate, call}) => {
    await evaluate('window.initCompleted.then(() => true)');
    let ipc;
    await until(async () => {
        try { ipc = net.connect(pipe); await new Promise((resolve, reject) => { ipc.once('connect', resolve); ipc.once('error', reject); }); return true; }
        catch { ipc?.destroy(); }
    }, 'mpv IPC');
    let sequence = 0, buffer = '';
    const pending = new Map();
    ipc.on('data', data => {
        buffer += data;
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
            const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
            const waiting = pending.get(message.request_id);
            if (waiting) { pending.delete(message.request_id); waiting(message.error === 'success' ? (message.data ?? true) : null); }
        }
    });
    const command = (...args) => new Promise(resolve => { const request_id = ++sequence; pending.set(request_id, resolve); ipc.write(JSON.stringify({command: args, request_id}) + '\n'); });
    const property = name => command('get_property', name);
    const page = async name => { const shot = await call('Page.captureScreenshot', {format: 'png'}); fs.writeFileSync(path.join(out, name), Buffer.from(shot.data, 'base64')); };
    const info = {viewport: await evaluate('({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})')};
    // A fresh profile opens the default 1280×720 window (WEBUI_SIZE); the marks
    // (ART in native/onboardingTour.js) are placed on pictures of that page.
    if (info.viewport.w !== 1280 || info.viewport.h !== 684)
        throw Error(`the page is ${info.viewport.w}×${info.viewport.h}; the tour's marks are placed for 1280×684`);

    await evaluate(`(async url => { await api.window.beginPlaybackSession();
        if (!await api.player.load(url, {autoplay: true, startMilliseconds: 0}, {type: 'video', title: '示例视频', metadata: {Name: '示例视频'}}, 1, -1))
            throw Error('native load rejected'); })(location.origin + '/clip.mkv')`);
    // 1. The playing window, paused nine seconds in, with the whole interface.
    await until(async () => await property('time-pos') > 9, 'nine seconds of playback');
    await command('set_property', 'pause', true);
    await command('script-binding', 'uosc/toggle-ui');
    await delay(1200);
    await command('screenshot-to-file', path.join(out, 'player-window.png'), 'window');
    await command('script-binding', 'uosc/toggle-ui');
    await command('set_property', 'pause', false);

    // 2. Professional mode on its first page, once the graphs have filled.
    await evaluate('Promise.resolve(api.player.setProMode(true))');
    await until(() => evaluate('window.tigerestProMode?.isActive() && window.tigerestProMode.host.shadowRoot.querySelectorAll(".ctl").length > 8'), 'the panels');
    await delay(9000);
    info.stage = await evaluate(`(() => { const r = window.tigerestProMode.host.shadowRoot.querySelector('.stage').getBoundingClientRect();
        return {left: r.left, top: r.top, width: r.width, height: r.height, dpr: devicePixelRatio}; })()`);
    await page('pro-page.png');
    await command('screenshot-to-file', path.join(out, 'pro-window.png'), 'window');
    await evaluate('Promise.resolve(api.player.setProMode(false))');
    await delay(800);
    await evaluate('Promise.resolve(api.player.stop())').catch(() => {});
    await delay(1500);

    // 3. 设置 → 视频 over the blank page, at twice the density.
    await call('Emulation.setDeviceMetricsOverride', {width: info.viewport.w, height: info.viewport.h, deviceScaleFactor: 2, mobile: false});
    await evaluate(`window.tigerestMountSettings(null, 'video')`);
    await delay(1500);
    await evaluate('document.activeElement?.blur?.()');
    await delay(300);
    await page('settings-video.png');
    await call('Emulation.clearDeviceMetricsOverride');
    fs.writeFileSync(path.join(out, 'info.json'), JSON.stringify(info, null, 1));
    console.log('captured into ' + out + ': ' + JSON.stringify(info));
}, {gpu: true, visible: true}).catch(error => { console.error(error); process.exitCode = 1; });
