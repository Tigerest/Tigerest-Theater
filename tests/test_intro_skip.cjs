// The shipped Windows client must act on Emby's intro marker while UOSC owns
// the playback surface (issue 39): Emby's own "skip intro" button lives in
// its HTML OSD, which is not shown then. The page publishes the marker through
// api.player.setIntroSkip; here it is published directly, on a local clip.
// A window screenshot is kept when TIGEREST_INTRO_SKIP_SCREENSHOT names a file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const withBrowser = require('./community_browser.cjs');

const INTRO = {start: 3, end: 30};
const frame = Buffer.alloc(64 * 36 * 3 / 2, 128);
frame.fill(32, 0, 64 * 36);
const video = Buffer.concat([Buffer.from('YUV4MPEG2 W64 H36 F24:1 Ip A1:1 C420jpeg\n'),
    ...Array.from({length: 24 * 40}, () => Buffer.concat([Buffer.from('FRAME\n'), frame]))]);
const routes = {
    '/': {type: 'text/html', body: '<!doctype html><title>Isolated intro skip check</title>'},
    '/clip.y4m': {type: 'video/x-yuv4mpeg', body: video}
};
const pipe = '\\\\.\\pipe\\TigerestIntroSkip-' + randomUUID();
const screenshot = process.env.TIGEREST_INTRO_SKIP_SCREENSHOT ? path.resolve(process.env.TIGEREST_INTRO_SKIP_SCREENSHOT) : '';

// TIGEREST_INTRO_SKIP_REAL_POINTER=1 clicks the button with the desktop pointer
// (it is put back afterwards); without it the check uses UOSC's binding.
const realPointer = process.env.TIGEREST_INTRO_SKIP_REAL_POINTER === '1';
// One desktop pointer action; resolves to the pointer's screen position after it.
function pointerAction(action, x = 0, y = 0) {
    const script = `
Add-Type -Namespace Win32 -Name Pointer -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out System.Drawing.Point point);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
'@ -ReferencedAssemblies System.Drawing
[void][Win32.Pointer]::SetProcessDPIAware()
$at = New-Object System.Drawing.Point
[void][Win32.Pointer]::GetCursorPos([ref]$at)
if ('${action}' -eq 'move') { [void][Win32.Pointer]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) }
if ('${action}' -eq 'nudge') { [void][Win32.Pointer]::SetCursorPos($at.X + ${Math.round(x)}, $at.Y + ${Math.round(y)}) }
if ('${action}' -eq 'click') {
    [Win32.Pointer]::mouse_event(2, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Win32.Pointer]::mouse_event(4, 0, 0, 0, [System.UIntPtr]::Zero)
}
[void][Win32.Pointer]::GetCursorPos([ref]$at)
"$($at.X),$($at.Y)"
`;
    return new Promise((resolve, reject) => {
        const shell = require('node:child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
        let stdout = '', stderr = '';
        shell.stdout.on('data', data => { stdout += data; });
        shell.stderr.on('data', data => { stderr += data; });
        shell.on('close', status => {
            const match = /(-?\d+),(-?\d+)\s*$/.exec(stdout);
            if (status !== 0 || !match) reject(Error('desktop pointer ' + action + ' failed: ' + stderr));
            else resolve({x: Number(match[1]), y: Number(match[2])});
        });
    });
}

async function until(check, label, limit = 150) {
    for (let i = 0; i < limit; i++) {
        const value = await check();
        if (value) return value;
        await delay(100);
    }
    throw Error('Timed out: ' + label);
}

(async () => {
    let result;
    await withBrowser(routes, async ({evaluate, profile}) => {
        const log = () => fs.readdirSync(profile, {recursive: true})
            .filter(file => path.basename(file) === 'Tigerest Theater.log')
            .map(file => fs.readFileSync(path.join(profile, file), 'utf8')).join('\n');
        let ipc;
        try {
            await evaluate('window.initCompleted.then(() => true)');
            await until(async () => {
                try {
                    ipc = net.connect(pipe);
                    await new Promise((resolve, reject) => { ipc.once('connect', resolve); ipc.once('error', reject); });
                    return true;
                } catch { ipc?.destroy(); }
            }, 'mpv IPC');
            let sequence = 0, buffer = '';
            const pending = new Map();
            ipc.on('data', data => {
                buffer += data;
                for (let end; (end = buffer.indexOf('\n')) >= 0;) {
                    const message = JSON.parse(buffer.slice(0, end));
                    buffer = buffer.slice(end + 1);
                    const waiting = pending.get(message.request_id);
                    if (!waiting) continue;
                    pending.delete(message.request_id);
                    waiting(message.error === 'success' ? message.data : null);
                }
            });
            const command = (...args) => new Promise(resolve => {
                const request_id = ++sequence;
                pending.set(request_id, resolve);
                ipc.write(JSON.stringify({command: args, request_id}) + '\n');
            });
            const property = name => command('get_property', name);
            const button = () => property('user-data/tigerest/intro-skip-button');
            let pointer;

            await evaluate(`(async () => {
                await api.window.beginPlaybackSession();
                if (!await api.player.load(location.origin + '/clip.y4m', {autoplay: true}, {type: 'video', frameRate: 24}, null, -1))
                    throw Error('native load rejected');
                return true;
            })()`);
            await until(async () => await property('time-pos') > 0.2, 'playback');
            assert.equal(await property('user-data/tigerest/intro-skip'), '', 'a load leaves no marker behind');

            // The button: drawn inside the intro, a click on it lands past the intro.
            await evaluate(`api.player.setIntroSkip(${JSON.stringify({...INTRO, auto: false})})`);
            assert.equal(typeof await button(), 'boolean', 'no button before the intro');
            const rectangle = await until(async () => { const value = await button(); return typeof value === 'object' && value; }, 'the button inside the intro');
            const shownAt = await property('time-pos');
            const size = await property('osd-dimensions');
            assert.ok(shownAt >= INTRO.start && shownAt < INTRO.start + 1.5, 'the button appears when the intro starts, appeared at ' + shownAt);
            assert.ok(rectangle.ax >= 0 && rectangle.bx <= size.w && rectangle.ay >= 0 && rectangle.by <= size.h &&
                rectangle.bx - rectangle.ax > 40 && rectangle.by - rectangle.ay > 20, 'the button is inside the window: ' + JSON.stringify({rectangle, size}));
            await delay(1500);
            const held = await property('time-pos');
            assert.ok(held < INTRO.end - 2 && typeof await button() === 'object', 'the button mode never moves the position by itself');
            if (screenshot) {
                await command('screenshot-to-file', screenshot, 'window');
                assert.ok(fs.existsSync(screenshot), 'the window screenshot was not written');
            }
            // Paused, so that only the click can move the position.
            await command('set_property', 'pause', true);
            await delay(200);
            const paused = await property('time-pos');
            // UOSC reads the pointer from the window system: a click injected through
            // mpv never hovers. The desktop pointer is moved only on request; the
            // binding reaches the same handler without it.
            if (realPointer) {
                // Steer by where mpv reports the pointer: the window's place on the
                // desktop and its scale are not known here.
                const target = {x: Math.round((rectangle.ax + rectangle.bx) / 2), y: Math.round((rectangle.ay + rectangle.by) / 2)};
                const home = await pointerAction('where');
                const steps = [];
                try {
                    await evaluate('api.window.raiseWindow()');
                    let scale = 1;
                    for (let i = 0; i < 8; i++) {
                        await delay(250);
                        pointer = await property('mouse-pos');
                        steps.push(pointer);
                        if (pointer?.hover && Math.abs(pointer.x - target.x) <= 6 && Math.abs(pointer.y - target.y) <= 6) break;
                        if (!pointer?.hover) {
                            // Somewhere inside the window first: its screen centre.
                            const centre = await evaluate('({x: Math.round((window.screenX + window.outerWidth / 2) * devicePixelRatio), y: Math.round((window.screenY + window.outerHeight / 2) * devicePixelRatio)})');
                            await pointerAction('move', centre.x, centre.y);
                            continue;
                        }
                        const before = pointer, wanted = {x: (target.x - pointer.x) * scale, y: (target.y - pointer.y) * scale};
                        await pointerAction('nudge', wanted.x, wanted.y);
                        await delay(250);
                        const after = await property('mouse-pos');
                        // Desktop units per mpv pixel, from what the nudge achieved.
                        const achieved = Math.hypot(after.x - before.x, after.y - before.y), asked = Math.hypot(wanted.x, wanted.y);
                        if (achieved > 20 && asked > 20) scale = Math.min(4, Math.max(0.25, asked / achieved));
                    }
                    assert.ok(pointer?.hover && Math.abs(pointer.x - target.x) <= 6 && Math.abs(pointer.y - target.y) <= 6,
                        'the desktop pointer never reached the button: ' + JSON.stringify({target, steps}));
                    await delay(300);
                    await pointerAction('click');
                } finally {
                    await delay(400);
                    await pointerAction('move', home.x, home.y);
                }
            } else {
                await command('script-binding', 'uosc/skip-intro');
            }
            const clicked = await until(async () => { const time = await property('time-pos'); return time >= INTRO.end - 0.1 && time; },
                'the click to skip the intro' + (pointer ? ', pointer at ' + JSON.stringify(pointer) + ' for ' + JSON.stringify(rectangle) : ''), 30);
            assert.ok(paused < INTRO.end - 2 && clicked < INTRO.end + 0.2,
                'the click moves the paused position from inside the intro to its end: ' + paused + ' -> ' + clicked);
            await command('set_property', 'pause', false);
            await until(async () => await button() === false, 'the button to leave after the skip');

            // Automatic: the position jumps by itself and no button is drawn.
            await command('seek', 0, 'absolute');
            await until(async () => await property('time-pos') < 1, 'the seek back');
            await evaluate(`api.player.setIntroSkip(${JSON.stringify({...INTRO, auto: true})})`);
            const before = Date.now();
            let sawButton = false;
            const jumped = await until(async () => {
                if (typeof await button() === 'object') sawButton = true;
                const time = await property('time-pos');
                return time >= INTRO.end - 0.1 && time;
            }, 'the automatic skip');
            assert.ok(!sawButton, 'automatic skipping draws no button');
            assert.ok(jumped < INTRO.end + 2 && Date.now() - before < 8000, 'the automatic skip follows the start of the intro');
            const errors = log().split('\n').filter(line => /uosc.*(Lua error|stack traceback|attempt to)/i.test(line));
            assert.deepEqual(errors, [], 'UOSC reported script errors');
            result = {buttonShownAt: shownAt, heldAt: held, clickedAt: paused, clickLandedAt: clicked, clickedWith: realPointer ? 'desktop pointer' : 'uosc/skip-intro binding',
                automaticLandedAt: jumped,
                window: size.w + 'x' + size.h, button: rectangle, screenshot: screenshot || undefined};
            await evaluate('api.player.stop()');
        } catch (error) {
            console.error(log().split('\n').slice(-40).join('\n'));
            throw error;
        } finally {
            ipc?.end();
        }
    }, {gpu: true, visible: true, startupTimeout: 30000, args: ['--log-level', 'info'],
        settings: {mpv: {enableDanmaku: false}, video: {'refreshrate.auto_switch': false, 'hdr.auto_switch': false, aiRife: false}},
        // Reaches mpv.conf's managed tail through the client's test hook before mpv initializes.
        prepareProfile: async () => { process.env.TIGEREST_MPV_TEST_OPTIONS = 'input-ipc-server=' + pipe + '\nmute=yes'; }});
    console.log(JSON.stringify({introSkip: result,
        scope: 'real Windows client, libmpv, UOSC and a local Y4M; isolated profile; the marker is published through api.player.setIntroSkip, not by an Emby server'}));
})().catch(error => { console.error(error); process.exitCode = 1; });
