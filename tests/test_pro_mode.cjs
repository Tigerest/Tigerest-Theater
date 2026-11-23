// Professional mode in the real Windows client, on a local clip:
// - the embedded video shrinks into the page's video area and returns to the
//   whole window afterwards;
// - the panels mirror the running mpv, and a change made in a panel reaches
//   mpv, is listed, and is undone by the compare button and by reset; a
//   value changed elsewhere is not listed as a change of the panel;
// - "the untouched picture" takes every shader and adjustment off while held,
//   also on a paused frame, where the window itself is compared;
// - dialogs stay inside the side panel (the video is a native window above
//   the page), render timings come in stages, the rings and graphs get figures,
//   hints stay inside the side panel, a save goes back into the profile or to
//   the settings, a profile made here can be deleted,
//   and the danmaku page restyles the plugin and stores the setting;
// - "save as profile" writes a new profile into mpv.conf and switches to it;
// - options the client owns are refused, keys stay away from the page
//   underneath, and stopping playback leaves the mode;
// - the page shows its panels during video-only playback (a local file),
//   where it is otherwise hidden.
//
// TIGEREST_TEST_CLIP plays a real file instead of the generated Y4M.
// TIGEREST_PRO_SHOTS names a folder that receives the page's panels (a web
// screenshot, without the native video) and mpv's own window at each stage.
// TIGEREST_PRO_REAL_INPUT=1 also checks where the keyboard goes, with real
// key presses and the desktop pointer (put back afterwards). It brings the
// test client to the front, and presses or clicks only while it is there.
// It needs the desktop to itself for those ten seconds: a pointer moved
// meanwhile, or a window covering the client, fails it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {setTimeout: delay} = require('node:timers/promises');
const withBrowser = require('./community_browser.cjs');

const clip = process.env.TIGEREST_TEST_CLIP ? path.resolve(process.env.TIGEREST_TEST_CLIP) : '';
if (clip) assert.ok(fs.existsSync(clip), 'TIGEREST_TEST_CLIP does not exist: ' + clip);
const shots = process.env.TIGEREST_PRO_SHOTS ? path.resolve(process.env.TIGEREST_PRO_SHOTS) : '';
if (shots) fs.mkdirSync(shots, {recursive: true});

// 160x90, 24 fps, 40 s: small enough to upscale, so the profile's shaders run.
const WIDTH = 160, HEIGHT = 90;
const frames = Array.from({length: 24 * 40}, (_, index) => {
    const frame = Buffer.alloc(WIDTH * HEIGHT * 3 / 2, 128);
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            // Blocks with hard edges over a slow ramp: scalers, shaders and
            // debanding each have something to change.
            const block = (((x + index) >> 3) + (y >> 3)) & 1;
            frame[y * WIDTH + x] = (block ? 150 : 60) + (x >> 2) + (y >> 2);
        }
    }
    return Buffer.concat([Buffer.from('FRAME\n'), frame]);
});
const video = Buffer.concat([Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F24:1 Ip A1:1 C420jpeg\n`), ...frames]);
const routes = {
    '/': {type: 'text/html', body: '<!doctype html><title>Isolated professional mode check</title><body style="background:#123">'},
    '/clip.y4m': {type: 'video/x-yuv4mpeg', body: video}
};
const pipe = '\\\\.\\pipe\\TigerestProMode-' + randomUUID();
const realInput = process.env.TIGEREST_PRO_REAL_INPUT === '1' && process.platform === 'win32';

// One action on the real desktop: 'window' reports the foreground window and
// the pointer, 'front' brings a process's main window forward, 'move' places
// the pointer, 'click' and 'key' press and release.
function desktop(action, a = 0, b = 0) {
    const script = `
Add-Type -Namespace Win32 -Name Desktop -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out System.Drawing.Point point);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr window, out uint process);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr window, out System.Drawing.Rectangle rect);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr window);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr context);
'@ -ReferencedAssemblies System.Drawing
# -4 is per-monitor aware (v2): physical pixels on every display, whatever its scale.
[void][Win32.Desktop]::SetThreadDpiAwarenessContext([System.IntPtr](-4))
if ('${action}' -eq 'front') {
    # Windows lets a background process set the foreground window only while
    # it shares input with the thread that owns the current one.
    $ignored = 0
    $holder = [Win32.Desktop]::GetWindowThreadProcessId([Win32.Desktop]::GetForegroundWindow(), [ref]$ignored)
    $self = [Win32.Desktop]::GetCurrentThreadId()
    [void][Win32.Desktop]::AttachThreadInput($self, $holder, $true)
    [void][Win32.Desktop]::SetForegroundWindow((Get-Process -Id ${Math.round(a)}).MainWindowHandle)
    [void][Win32.Desktop]::AttachThreadInput($self, $holder, $false)
    Start-Sleep -Milliseconds 300
}
if ('${action}' -eq 'move') { [void][Win32.Desktop]::SetCursorPos(${Math.round(a)}, ${Math.round(b)}) }
if ('${action}' -eq 'click') {
    [Win32.Desktop]::mouse_event(2, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Win32.Desktop]::mouse_event(4, 0, 0, 0, [System.UIntPtr]::Zero)
}
if ('${action}' -eq 'key') {
    [Win32.Desktop]::keybd_event(${Math.round(a)}, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Win32.Desktop]::keybd_event(${Math.round(a)}, 0, 2, [System.UIntPtr]::Zero)
}
$at = New-Object System.Drawing.Point
[void][Win32.Desktop]::GetCursorPos([ref]$at)
$window = [Win32.Desktop]::GetForegroundWindow()
$owner = 0
[void][Win32.Desktop]::GetWindowThreadProcessId($window, [ref]$owner)
# GetWindowRect writes left, top, right, bottom into the rectangle's four fields.
$rect = New-Object System.Drawing.Rectangle
[void][Win32.Desktop]::GetWindowRect($window, [ref]$rect)
"$($at.X),$($at.Y),$owner,$($rect.X),$($rect.Y),$($rect.Width),$($rect.Height)"
`;
    return new Promise((resolve, reject) => {
        const shell = require('node:child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
        let stdout = '', stderr = '';
        shell.stdout.on('data', data => { stdout += data; });
        shell.stderr.on('data', data => { stderr += data; });
        shell.on('close', status => {
            const match = /(-?\d+),(-?\d+),(\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+)\s*$/.exec(stdout);
            if (status !== 0 || !match) return reject(Error('desktop ' + action + ' failed: ' + stderr));
            const [x, y, pid, left, top, right, bottom] = match.slice(1).map(Number);
            resolve({x, y, pid, left, top, right, bottom});
        });
    });
}

// The client window as it is on screen (PrintWindow takes this window only),
// and how much the middle of the video area differs between two captures:
// the mean absolute difference per colour channel, 0-255.
function onScreen(action, first, second) {
    const script = `
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class TigerestShot {
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rectangle rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    public static bool Capture(IntPtr window, string file) {
        SetThreadDpiAwarenessContext((IntPtr)(-4));
        Rectangle rect;
        if (!GetWindowRect(window, out rect)) return false;
        // GetWindowRect writes left, top, right, bottom into the four fields.
        using (var bitmap = new Bitmap(rect.Width - rect.X, rect.Height - rect.Y, PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(bitmap)) {
            IntPtr dc = graphics.GetHdc();
            bool ok = PrintWindow(window, dc, 2);
            graphics.ReleaseHdc(dc);
            bitmap.Save(file, ImageFormat.Png);
            return ok;
        }
    }
    public static double Difference(string first, string second) {
        using (var a = new Bitmap(first)) using (var b = new Bitmap(second)) {
            if (a.Width != b.Width || a.Height != b.Height) return -1;
            var area = new Rectangle((int)(a.Width * 0.15), (int)(a.Height * 0.25), (int)(a.Width * 0.40), (int)(a.Height * 0.35));
            var da = a.LockBits(area, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            var db = b.LockBits(area, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            var pa = new byte[da.Stride * area.Height];
            var pb = new byte[pa.Length];
            Marshal.Copy(da.Scan0, pa, 0, pa.Length);
            Marshal.Copy(db.Scan0, pb, 0, pb.Length);
            a.UnlockBits(da);
            b.UnlockBits(db);
            long sum = 0;
            for (int row = 0; row < area.Height; row++)
                for (int column = 0; column < area.Width; column++)
                    for (int channel = 0; channel < 3; channel++) {
                        int at = row * da.Stride + column * 4 + channel;
                        sum += Math.Abs(pa[at] - pb[at]);
                    }
            return (double)sum / (area.Width * area.Height * 3);
        }
    }
}
'@
if ('${action}' -eq 'capture') { [TigerestShot]::Capture((Get-Process -Id ${first}).MainWindowHandle, '${second}') }
else { [TigerestShot]::Difference('${first}', '${second}').ToString([Globalization.CultureInfo]::InvariantCulture) }
`;
    return new Promise((resolve, reject) => {
        const shell = require('node:child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
        let stdout = '', stderr = '';
        shell.stdout.on('data', data => { stdout += data; });
        shell.stderr.on('data', data => { stderr += data; });
        shell.on('close', status => {
            const answer = stdout.trim().split(/\s+/).pop();
            if (status !== 0 || !answer) return reject(Error('window ' + action + ' failed: ' + stderr));
            resolve(action === 'capture' ? answer === 'True' : Number(answer));
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
    await withBrowser(routes, async ({evaluate, call, profile, process: client}) => {
        const log = () => withBrowser.clientLog(profile);
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
            // A profile's "glsl-shaders=" line leaves one empty entry at the front.
            const shaderChain = async () => ((await property('glsl-shaders')) || []).filter(Boolean);
            const shot = async name => {
                if (!shots) return;
                const page = await call('Page.captureScreenshot', {format: 'png'});
                fs.writeFileSync(path.join(shots, name + '-panels.png'), Buffer.from(page.data, 'base64'));
                await command('screenshot-to-file', path.join(shots, name + '-video.png'), 'window');
            };

            // The page side of the checks: the panel lives in a shadow root.
            await evaluate(`(${(() => {
                const root = () => window.tigerestProMode.host.shadowRoot;
                window.proTest = {
                    root,
                    stats: null,
                    keys: 0,
                    row: key => root().querySelector('.ctl[data-key="' + key + '"]'),
                    tab: id => root().querySelector('.tabs button[data-tab="' + id + '"]').click(),
                    button: text => [...root().querySelectorAll('button')].find(button => button.textContent.trim() === text),
                    // The confirming button of the open dialog.
                    confirm: () => root().querySelector('.sheet footer .primary'),
                    // Moves the pointer onto an element, as far as the page can tell, and off it again.
                    hover: (node, on) => node.dispatchEvent(new PointerEvent(on ? 'pointerover' : 'pointerout', {bubbles: true, composed: true})),
                    box: selector => {
                        const rect = root().querySelector(selector).getBoundingClientRect();
                        return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom};
                    },
                    stage: () => {
                        const rect = root().querySelector('.stage').getBoundingClientRect();
                        return {w: rect.width * devicePixelRatio, h: rect.height * devicePixelRatio};
                    },
                    // Drags a slider to a value; `release` lets go of it there.
                    slide: (key, value, release) => {
                        const input = window.proTest.row(key).querySelector('input[type=range]');
                        input.value = value;
                        input.dispatchEvent(new Event('input', {bubbles: true}));
                        if (release) input.dispatchEvent(new Event('change', {bubbles: true}));
                    },
                    hold: (text, down) => window.proTest.button(text).dispatchEvent(
                        new PointerEvent(down ? 'pointerdown' : 'pointerup', {button: 0, pointerId: 1, bubbles: true})),
                    // Frames the page was asked to draw in half a second: none while it is hidden.
                    frames: () => new Promise(resolve => {
                        let count = 0, counting = true;
                        const step = () => { if (counting) { count++; requestAnimationFrame(step); } };
                        requestAnimationFrame(step);
                        setTimeout(() => { counting = false; resolve(count); }, 500);
                    })
                };
                api.player.proStats.connect(stats => { window.proTest.stats = stats; });
                // The real pointer as the page sees it, and where it pressed.
                window.proTest.pointer = null;
                window.proTest.presses = [];
                window.addEventListener('mousemove', event => { window.proTest.pointer = [event.clientX, event.clientY]; }, true);
                window.addEventListener('pointerdown', event => { if (event.isTrusted) window.proTest.presses.push([event.clientX, event.clientY]); }, true);
                // The empty stretch of the panels' top bar, and the middle of the video area.
                window.proTest.places = () => {
                    const bar = root().querySelector('.spring').getBoundingClientRect();
                    const stage = root().querySelector('.stage').getBoundingClientRect();
                    return {bar: [bar.left + bar.width / 2, bar.top + bar.height / 2],
                        stage: [stage.left + stage.width / 2, stage.top + stage.height / 2], pointer: window.proTest.pointer};
                };
                // Stands for Emby's own key handling underneath the panels.
                document.addEventListener('keydown', () => { window.proTest.keys++; });
            }).toString()})()`);

            assert.equal(await evaluate('Promise.resolve(api.player.proModeAvailable())'), true, 'the mode is offered with embedded gpu-next and uosc');
            await evaluate('Promise.resolve(api.player.setProMode(true))');
            await delay(300);
            assert.equal(await evaluate('Promise.resolve(api.player.proModeActive())'), false, 'the mode needs a playing video');

            await evaluate(`(${(async url => {
                await api.window.beginPlaybackSession();
                if (!await api.player.load(url, {autoplay: true, startMilliseconds: 0}, {type: 'video', frameRate: 24}, 1, -1))
                    throw Error('native load rejected');
            }).toString()})(${JSON.stringify(clip ? pathToFileURL(clip).href : '/clip.y4m')}.replace(/^\\//, location.origin + '/'))`);
            await until(async () => await property('time-pos') > 1.5, 'playback', 300);
            assert.equal(await property('user-data/tigerest/pro/available'), true, 'uosc is told the mode exists');
            const full = await property('osd-dimensions');
            const startProfile = await property('user-data/profile_menu/current');
            const startShaders = await shaderChain();
            assert.equal(startShaders.length, 3, 'the default profile mounts three shaders: ' + JSON.stringify(startShaders));

            // ---- entering: the video takes the page's video area ----------
            await evaluate('Promise.resolve(api.player.setProMode(true))');
            await until(() => evaluate('window.tigerestProMode.isActive() && window.proTest.root().querySelectorAll(".ctl").length > 8'), 'the panels');
            const stage = await evaluate('window.proTest.stage()');
            const small = await until(async () => {
                const size = await property('osd-dimensions');
                return Math.abs(size.w - stage.w) <= 3 && Math.abs(size.h - stage.h) <= 3 && size;
            }, 'the video inside the stage ' + JSON.stringify(stage));
            assert.ok(small.w < full.w - 200 && small.h < full.h - 100, 'the video shrank: ' + JSON.stringify({full, small}));
            // The first sample is taken as the mode starts, before the video has moved.
            const stats = await until(async () => {
                const sample = await evaluate('window.proTest.stats');
                return sample && Math.abs(sample.output.w - small.w) <= 3 && sample;
            }, 'statistics from the data script for the smaller window');
            assert.equal(stats.video.w, clip ? stats.video.w : WIDTH, 'the statistics describe the playing video');
            await until(() => evaluate('window.proTest.stats?.passes?.fresh?.length > 0'), 'render timings');
            await until(() => evaluate('window.tigerestProMode.shaders().length === 3 && window.proTest.root().querySelectorAll(".shader").length === 3'), 'the mirrored shader chain');
            assert.deepEqual(await evaluate('window.tigerestProMode.changes()'), [], 'entering changes nothing');

            // ---- render timings in stages; a click opens a stage ------------
            const stageTitles = () => evaluate('[...window.proTest.root().querySelectorAll(".steps .step:not(.sub) span")].map(node => node.textContent)');
            await until(async () => (await stageTitles()).some(title => title.startsWith('滤镜')), 'the shader stage');
            assert.ok((await stageTitles()).length <= 8 && (await stageTitles()).some(title => title.startsWith('缩放')),
                'the steps are gathered into stages: ' + JSON.stringify(await stageTitles()));
            assert.equal(await evaluate('window.proTest.root().querySelectorAll(".steps .step.sub").length'), 0, 'stages start closed');
            await evaluate('[...window.proTest.root().querySelectorAll(".steps .step")].find(node => node.textContent.startsWith("▸滤镜")).click()');
            await until(() => evaluate('window.proTest.root().querySelectorAll(".steps .step.sub").length >= 1'), 'the shaders of the opened stage');
            await delay(1200);
            assert.ok(await evaluate('window.proTest.root().querySelectorAll(".steps .step.sub").length >= 1'), 'the stage stays open across updates');

            // ---- load gauges --------------------------------------------------
            const load = await until(() => evaluate('window.tigerestProMode.load()'), 'processor and graphics load', 60);
            assert.ok(load.cpu >= 0 && load.cpu <= 100 && load.cpuSelf >= 0 && load.cpuSelf <= load.cpu + 1, 'processor load: ' + JSON.stringify(load));
            assert.ok(load.gpu === undefined || (load.gpu >= 0 && load.gpu <= 100), 'graphics load: ' + JSON.stringify(load));
            // One ring for each place a frame can be lost, the machine's two, and the frames lost.
            assert.match(await evaluate('[...window.proTest.root().querySelectorAll(".gauge")].map(node => node.textContent).join("|")'),
                /^(—|…|够|停|\d+%)补帧\|\d+%渲染\|(—|[\d.]+%)呈现掉拍\|(\d+%|—)GPU 占用\|\d+%CPU 占用\|(0|[\d.]+\/s)丢帧$/, 'the six rings show figures');
            assert.match(await evaluate('window.proTest.root().querySelector(".load h4").textContent'), /^各环节负载(没有丢帧|丢帧出在.+|丢帧不在这几环)$/,
                'the heading says whether frames are lost and where');
            // Two graphs: the frames that reach the screen, and the refreshes it was given.
            const graphs = await evaluate('[...window.proTest.root().querySelectorAll(".pace > div")].map(node => ({' +
                'label: node.querySelector(".label").textContent, big: node.querySelector(".big").textContent, caption: node.querySelector(".caption").textContent,' +
                'points: node.querySelector("polyline").getAttribute("points").split(" ").length}))');
            assert.equal(graphs.length, 2, 'two graphs in the pace card');
            assert.match(graphs[0].big, /^[\d.]+fps$/, 'frames shown: ' + JSON.stringify(graphs[0]));
            assert.match(graphs[0].label, /^视频帧率 · 应为 [\d.]+$/, 'against frames due');
            assert.match(graphs[1].big, /^([\d.]+|—)Hz$/, 'refreshes given: ' + JSON.stringify(graphs[1]));
            assert.match(graphs[1].label, /^实际呈现 · 屏幕 \d+$/, 'against the screen\'s');
            assert.ok(graphs[0].points >= 2, 'the graph has a line');

            // ---- hints stay inside the side panel ----------------------------
            assert.equal(await evaluate('window.proTest.root().querySelectorAll("[title]:not(option)").length'), 0,
                'no element keeps a browser tooltip, which the video would cover');
            await evaluate('window.proTest.hover(window.proTest.row("scale").querySelector("label"), true)');
            const hint = await until(() => evaluate(`(() => {
                const tip = window.proTest.root().querySelector('.tip');
                if (tip.hidden) return null;
                const rect = tip.getBoundingClientRect();
                return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, text: tip.textContent, wrap: getComputedStyle(tip).whiteSpace};
            })()`), 'the hint of a control');
            const sideBox = await evaluate('window.proTest.box(".side")');
            assert.ok(hint.left >= sideBox.left && hint.right <= sideBox.right && hint.top >= sideBox.top && hint.bottom <= sideBox.bottom,
                'the hint lies inside the side panel: ' + JSON.stringify({hint, sideBox}));
            assert.ok(hint.text.includes('（scale）') && hint.wrap === 'pre-wrap', 'it carries the help text and wraps: ' + JSON.stringify(hint));
            await shot('2b-hint');
            await evaluate('window.proTest.hover(window.proTest.row("scale").querySelector("label"), false)');
            assert.equal(await evaluate('window.proTest.root().querySelector(".tip").hidden'), true, 'and goes when the pointer leaves');

            // ---- a dialog covers the side panel, not the video ---------------
            await evaluate('window.proTest.button("+ 挂载着色器").click()');
            const sheet = await until(() => evaluate(`(() => {
                const sheet = window.proTest.root().querySelector('.sheet'); if (!sheet) return null;
                const area = sheet.getBoundingClientRect(), video = window.proTest.root().querySelector('.stage').getBoundingClientRect();
                return {left: area.left, videoRight: video.right, picks: sheet.querySelectorAll('.pick').length};
            })()`), 'the shader picker');
            assert.ok(sheet.left >= sheet.videoRight && sheet.picks > 50, 'the picker lists the library beside the video: ' + JSON.stringify(sheet));
            // ArtCNN C4F32 compiles for about 100 s on Direct3D 11; on Windows
            // the picker says so, for the slow shaders only.
            const compileNotes = await evaluate(`(() => {
                const meta = file => [...window.proTest.root().querySelectorAll('.sheet .pick')]
                    // The panel moves each title into its own hint (data-tip): path, then note.
                    .find(pick => (pick.dataset.tip || pick.title).split('\\n')[0] === file)?.querySelector('small')?.textContent || '';
                return {slow: meta('ArtCNN/ArtCNN_C4F32.glsl'), quick: meta('SSim/SSimSuperRes_RT.glsl'),
                        windows: window.api?.system?.isWindows === true,
                        note: [...window.proTest.root().querySelectorAll('.sheet .note')].map(note => note.textContent).join('\\n')};
            })()`);
            const firstCompile = /首次启用要编译约 \d+ 秒，期间画面停住，之后有缓存/;
            assert.ok(compileNotes.slow && compileNotes.quick, 'both shaders are listed: ' + JSON.stringify(compileNotes));
            assert.equal(firstCompile.test(compileNotes.slow), compileNotes.windows, 'the first compile on Windows: ' + JSON.stringify(compileNotes));
            assert.equal(firstCompile.test(compileNotes.quick), false, 'only the slow shaders carry it: ' + JSON.stringify(compileNotes));
            assert.equal(compileNotes.note.includes('首次启用要编译约 N 秒'), compileNotes.windows, 'the sheet explains it on Windows');
            await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}))');
            assert.equal(await evaluate('Boolean(window.proTest.root().querySelector(".sheet")) || !window.tigerestProMode.isActive()'), false, 'Escape closes the dialog, not the mode');

            // ---- a value changed elsewhere is not a change of the panel -------
            await command('set', 'deband-grain', '33');
            await until(async () => await evaluate('window.proTest.row("deband-grain").querySelector("input").value') === '33', 'the value from elsewhere in the panel');
            assert.deepEqual(await evaluate('window.tigerestProMode.changes()'), [], 'and it is not listed');
            await shot('1-entered');

            // ---- a toggle, a slider and the shader chain reach mpv --------
            const deband = await property('deband');
            await evaluate('window.proTest.row("deband").querySelector("input").click()');
            await until(async () => await property('deband') !== deband, 'the deband toggle in mpv');
            await evaluate('window.proTest.slide("deband-threshold", 77)');
            await until(async () => await property('deband-threshold') === 77, 'the slider in mpv');
            await evaluate('window.proTest.tab("color")');
            await evaluate('window.proTest.slide("brightness", 12)');
            await until(async () => await property('brightness') === 12, 'brightness in mpv');
            await evaluate('window.proTest.tab("quality")');
            await evaluate('window.proTest.root().querySelector(".shader input").click()');
            await until(async () => (await shaderChain()).length === 2, 'the shader taken off the chain');
            assert.deepEqual(await shaderChain(), startShaders.slice(1), 'the rest of the chain keeps its order');
            const changed = await until(async () => {
                const list = await evaluate('window.tigerestProMode.changes()');
                return list.length === 3 && list;
            }, 'the three changes in the list');
            assert.deepEqual(changed.map(change => change.key).sort(), ['brightness', 'deband', 'deband-threshold']);
            assert.equal(await evaluate('window.proTest.row("deband").classList.contains("dirty")'), true, 'changed controls are marked');
            assert.match(await evaluate('window.proTest.root().querySelector(".foot .summary").textContent'), /已改动 4 项/, 'three options and the chain');
            await shot('2-changed');

            // ---- compare: held shows the state before, released the changes
            await evaluate('window.proTest.hold("按住对比改动前", true)');
            await until(async () => await property('deband') === deband && await property('brightness') === 0 &&
                (await shaderChain()).length === 3, 'the earlier picture while held');
            await evaluate('window.proTest.hold("按住对比改动前", false)');
            await until(async () => await property('deband') !== deband && await property('brightness') === 12 &&
                (await shaderChain()).length === 2, 'the changes again after release');
            // The untouched picture: no shader, no debanding, no adjustment, bilinear scaling.
            const scale = await property('scale');
            const untouched = async () => (await shaderChain()).length === 0 && await property('scale') === 'bilinear' &&
                await property('cscale') === 'bilinear' && await property('deband') === false && await property('brightness') === 0 &&
                await property('sigmoid-upscaling') === false;
            const changedAgain = async () => (await shaderChain()).length === 2 && await property('scale') === scale &&
                await property('deband') !== deband && await property('brightness') === 12 && await property('sigmoid-upscaling') === true;
            await evaluate('window.proTest.hold("按住看原始画面", true)');
            await until(untouched, 'the untouched picture while held');
            await until(() => evaluate('!window.proTest.stats.passes.fresh.some(pass => pass.desc.startsWith("["))'), 'no shader among the render steps');
            await evaluate('window.proTest.hold("按住看原始画面", false)');
            await until(changedAgain, 'the changes again after release');
            await until(() => evaluate('window.proTest.stats.passes.fresh.some(pass => pass.desc.startsWith("["))'), 'the shaders among the render steps again');

            // The same on a paused frame, judged by the window itself: mpv has
            // to draw the frame again for a held button to show anything.
            let paused = 'not checked: the window could not be captured';
            const captures = fs.mkdtempSync(path.join(os.tmpdir(), 'tigerest-pro-shots-'));
            try {
                await evaluate('api.player.pause()');
                await until(() => property('pause'), 'the pause');
                await delay(1500);
                const file = name => path.join(captures, name + '.png');
                if (await onScreen('capture', client.pid, file('before'))) {
                    await evaluate('window.proTest.hold("按住看原始画面", true)');
                    await until(untouched, 'the untouched picture while held and paused');
                    await delay(1200);
                    await onScreen('capture', client.pid, file('held'));
                    await evaluate('window.proTest.hold("按住看原始画面", false)');
                    await until(changedAgain, 'the changes again after release, still paused');
                    await delay(1500);
                    await onScreen('capture', client.pid, file('after'));
                    const held = await onScreen('difference', file('before'), file('held'));
                    const after = await onScreen('difference', file('before'), file('after'));
                    if (shots) for (const name of ['before', 'held', 'after']) fs.copyFileSync(file(name), path.join(shots, 'paused-' + name + '.png'));
                    assert.ok(held > 2, 'the paused frame changes on screen while held: ' + JSON.stringify({held, after}));
                    assert.ok(after < held / 4, 'and returns when released: ' + JSON.stringify({held, after}));
                    paused = {differenceWhileHeld: Number(held.toFixed(2)), differenceAfterRelease: Number(after.toFixed(2))};
                }
            } finally {
                fs.rmSync(captures, {recursive: true, force: true});
                await evaluate('api.player.play()');
                await until(async () => !await property('pause'), 'playback again');
            }
            await delay(900);
            assert.equal((await evaluate('window.tigerestProMode.changes()')).length, 3, 'comparing leaves the changes as they were');

            // ---- where the keyboard goes -----------------------------------
            // "m" toggles mute in mpv and does nothing in the panels.
            let keyboard = 'not checked (TIGEREST_PRO_REAL_INPUT=1 presses real keys)';
            if (realInput) {
                const pointer = await desktop('window');
                const front = pointer.pid === client.pid ? pointer : await desktop('front', client.pid);
                if (front.pid !== client.pid) {
                    keyboard = 'skipped: the test client could not be brought to the front';
                } else {
                    const scale = await evaluate('devicePixelRatio');
                    // Never into another program's window.
                    const mine = async () => assert.equal((await desktop('window')).pid, client.pid, 'the test client stays in front');
                    const press = async () => { await mine(); await desktop('key', 0x4D); await delay(500); };
                    // The pointer is steered by what the page reports of it: a
                    // window's screen position is not dependable between
                    // displays of different scale.
                    let screen = null;
                    const toBar = async () => {
                        let at = await desktop('move', front.left + (front.right - front.left) * 0.45, front.top + (36 + 26) * scale);
                        for (let attempt = 0; attempt < 8; attempt++) {
                            await delay(250);
                            const places = await evaluate('window.proTest.places()');
                            if (!places.pointer) { at = await desktop('move', at.x + 4, at.y + 4); continue; }
                            const [dx, dy] = [places.bar[0] - places.pointer[0], places.bar[1] - places.pointer[1]];
                            if (Math.abs(dx) < 40 && Math.abs(dy) < 8) { screen = {at, places}; return; }
                            at = await desktop('move', at.x + dx * scale, at.y + dy * scale);
                        }
                        throw Error('the desktop pointer could not be placed on the panels\' top bar (was it moved meanwhile?): ' +
                            JSON.stringify(await evaluate('window.proTest.places()')));
                    };
                    const clickBar = async () => {
                        await toBar();
                        const before = await evaluate('window.proTest.presses.length');
                        await mine();
                        await desktop('click');
                        await until(async () => await evaluate('window.proTest.presses.length') > before, 'the click in the page', 30);
                        await delay(400);
                    };
                    try {
                        await clickBar();
                        const mute = await property('mute');
                        await press();
                        assert.equal(await property('mute'), mute, 'after a click on the panels, keys stay with the page');
                        const {at, places} = screen;
                        await desktop('move', at.x + (places.stage[0] - places.pointer[0]) * scale, at.y + (places.stage[1] - places.pointer[1]) * scale);
                        await until(async () => (await property('mouse-pos'))?.hover === true, 'the pointer over the video', 30);
                        await delay(400);
                        await press();
                        assert.notEqual(await property('mute'), mute, 'with the pointer over the video, keys reach mpv');
                        await press();
                        assert.equal(await property('mute'), mute, 'and again');
                        await clickBar();
                        await press();
                        assert.equal(await property('mute'), mute, 'a click on the panels takes the keyboard back');
                        keyboard = 'the page after a click on the panels, mpv with the pointer over the video';
                    } finally {
                        await desktop('move', pointer.x, pointer.y);
                    }
                }
            }

            // ---- what the client owns stays out of reach -------------------
            for (const [key, value] of [['vo', 'null'], ['input-ipc-server', 'x'], ['script', 'x.lua'], ['glsl-shaders', ''], ['profile', 'fast']]) {
                const answer = await evaluate(`Promise.resolve(api.player.proSet(${JSON.stringify(key)}, ${JSON.stringify(value)}))`);
                assert.equal(answer.ok, false, key + ' is refused: ' + JSON.stringify(answer));
            }
            assert.equal((await evaluate('Promise.resolve(api.player.proSetShaders(["C:/Windows/x.glsl"]))')).ok, false, 'a shader outside the client folder is refused');
            assert.equal((await evaluate('Promise.resolve(api.player.proSetShaders(["~~/shaders/../x.glsl"]))')).ok, false);
            assert.equal(await property('current-vo'), 'gpu-next');

            // ---- keys stay away from the page underneath -------------------
            await evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowLeft", bubbles: true, cancelable: true}))');
            assert.equal(await evaluate('window.proTest.keys'), 0, 'the page underneath sees no key');

            // ---- reset ------------------------------------------------------
            await evaluate('window.proTest.button("重置改动").click()');
            await until(async () => await property('deband') === deband && await property('brightness') === 0 &&
                await property('deband-threshold') !== 77 && (await shaderChain()).length === 3, 'the reset in mpv');
            assert.deepEqual(await shaderChain(), startShaders, 'the chain is back in its order');
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 0, 'an empty change list');

            // ---- save as a new profile --------------------------------------
            await evaluate('window.proTest.tab("color")');
            await evaluate('window.proTest.slide("saturation", 9)');
            await evaluate('window.proTest.tab("quality")');
            await evaluate('window.proTest.root().querySelectorAll(".shader input")[1].click()');
            await until(async () => await property('saturation') === 9 && (await shaderChain()).length === 2, 'the changes to save');
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 1, 'the change to save in the list');
            await evaluate('window.proTest.button("保存为新档位…").click()');
            await until(() => evaluate('Boolean(window.proTest.button("保存并启用"))'), 'the save dialog');
            await shot('3-save-dialog');
            await evaluate('window.proTest.button("保存并启用").click()');
            const saved = await until(async () => {
                const current = await property('user-data/profile_menu/current');
                return current !== startProfile && current;
            }, 'the new profile in use', 200);
            assert.match(saved, /^tigerest-user-pro-\d{8}-\d{6}$/);
            const conf = await evaluate('Promise.resolve(api.player.mpvConfState())');
            const block = conf.user.slice(conf.user.indexOf('[' + saved + ']'));
            assert.ok(block.includes('profile=' + startProfile) && block.includes('saturation=9') && block.includes('glsl-shaders=\n'),
                'the profile inherits the earlier one and holds the changes:\n' + block);
            assert.deepEqual([...block.matchAll(/^glsl-shader=(.+)$/gm)].map(match => match[1]), [startShaders[0], startShaders[2]],
                'with the chain as it was in the panel');
            assert.ok(conf.user.startsWith(conf.defaultUser.replace(/\n*$/, '\n')), 'the bundled profiles are untouched');
            await until(async () => await property('saturation') === 9 && (await shaderChain()).length === 2, 'the saved profile applied');
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 0, 'nothing left to save');
            assert.equal(await evaluate('jmpInfo.settings.mpv.shaderPreset'), saved, 'the settings page follows the new profile');
            await shot('4-saved');

            // ---- save: back into the profile in use --------------------------
            assert.equal(await evaluate('window.proTest.button("删除").disabled'), false, 'a profile made here can be deleted');
            await evaluate('window.proTest.tab("color")');
            await evaluate('window.proTest.slide("saturation", 12, true)');
            await evaluate('window.proTest.tab("quality")');
            await evaluate('window.proTest.root().querySelectorAll(".shader input")[0].click()');
            await until(async () => await property('saturation') === 12 && (await shaderChain()).length === 1, 'changes on top of the saved profile');
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 1, 'the change in the list');
            await evaluate('window.proTest.button("保存").click()');
            await until(() => evaluate('Boolean(window.proTest.confirm())'), 'the save dialog');
            assert.ok((await evaluate('window.proTest.root().querySelector(".sheet .content").textContent')).includes('饱和度 = 12'), 'the dialog lists what it writes');
            await evaluate('window.proTest.confirm().click()');
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 0 &&
                !await evaluate('Boolean(window.proTest.root().querySelector(".sheet"))'), 'saved, nothing left to save');
            const again = (await evaluate('Promise.resolve(api.player.mpvConfState())')).user;
            const kept = again.slice(again.indexOf('[' + saved + ']'));
            assert.deepEqual(kept.match(/^saturation=.*$/gm), ['saturation=12'], 'the value is replaced, not written twice:\n' + kept);
            assert.deepEqual(kept.match(/^glsl-shaders=.*$/gm), ['glsl-shaders='], 'one chain in the profile');
            assert.deepEqual([...kept.matchAll(/^glsl-shader=(.+)$/gm)].map(match => match[1]), [startShaders[2]], 'the chain as it is in the panel');
            assert.ok(kept.includes('profile=' + startProfile), 'the profile still builds on the earlier one');
            assert.equal(await property('user-data/profile_menu/current'), saved, 'and stays the profile in use');
            assert.ok(again.startsWith(conf.defaultUser.replace(/\n*$/, '\n')), 'the bundled profiles are still untouched');
            await until(async () => await property('saturation') === 12 && (await shaderChain()).length === 1, 'the picture as saved');

            // ---- save: subtitle font and size, and the sync mode, to the settings
            const families = await evaluate('Promise.resolve(api.player.proFontFamilies())');
            assert.ok(Array.isArray(families) && families.length > 0 && !families.some(family => /^[@.]/.test(family)), 'installed fonts: ' + families.length);
            await evaluate('window.proTest.tab("subtitle")');
            await evaluate('window.proTest.row("sub-font").querySelector("button.tool").click()');
            await until(() => evaluate('window.proTest.root().querySelectorAll(".sheet .font").length > 0'), 'the font list');
            const family = await evaluate(`(() => {
                const item = [...window.proTest.root().querySelectorAll('.sheet .font')].find(node => !node.classList.contains('current'));
                item.querySelector('button').click();
                return item.querySelector('div').textContent.split('　')[0];
            })()`);
            await until(async () => await property('sub-font') === family, 'the font on the subtitles: ' + family);
            await shot('5-fonts');
            await evaluate('window.proTest.confirm().click()');
            await evaluate('window.proTest.slide("sub-scale", 1.25, true)');
            await evaluate('window.proTest.slide("sub-pos", 92, true)');
            await evaluate('window.proTest.tab("frame")');
            assert.deepEqual(await evaluate('[...window.proTest.row("video-sync").querySelectorAll("option")].map(option => option.value)'),
                ['audio', 'display-resample', 'display-adrop'], 'the sync modes of the settings page');
            await evaluate(`(() => { const select = window.proTest.row('video-sync').querySelector('select'); select.value = 'audio'; select.dispatchEvent(new Event('change', {bubbles: true})); })()`);
            await until(async () => await property('video-sync') === 'audio' && await property('sub-scale') === 1.25 && await property('sub-pos') === 92, 'the live values');
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 4, 'four changes: ' + JSON.stringify(await evaluate('window.tigerestProMode.changes()')));
            await shot('7-frame');
            await evaluate('window.proTest.tab("subtitle")');
            await shot('6-subtitle');
            await evaluate('window.proTest.tab("motion")');
            await shot('8-motion');
            await evaluate('window.proTest.tab("frame")');
            const before = (await evaluate('Promise.resolve(api.player.mpvConfState())')).user;
            await evaluate('window.proTest.button("保存").click()');
            await until(() => evaluate('Boolean(window.proTest.confirm())'), 'the save dialog');
            assert.ok((await evaluate('window.proTest.root().querySelector(".sheet .content").textContent')).includes('写入客户端设置'), 'these go to the settings');
            await evaluate('window.proTest.confirm().click()');
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 0, 'nothing left to save');
            assert.deepEqual(await evaluate('[jmpInfo.settings.subtitles.font, jmpInfo.settings.subtitles.size, jmpInfo.settings.subtitles.vertical_position, jmpInfo.settings.video.sync_mode]'),
                [family, 40, 92, 'audio'], 'the settings hold them');
            assert.equal((await evaluate('Promise.resolve(api.player.mpvConfState())')).user, before, 'and the profiles were not written for it');
            assert.ok((await evaluate('Promise.resolve(api.player.mpvConfState())')).tail.includes('sub-pos=92'), 'the managed part of mpv.conf shows the position');
            assert.deepEqual([await property('video-sync'), await property('sub-scale'), await property('sub-pos'), await property('sub-font')],
                ['audio', 1.25, 92, family], 'and the player keeps them');
            await evaluate(`(() => { const select = window.proTest.row('video-sync').querySelector('select'); select.value = 'display-resample'; select.dispatchEvent(new Event('change', {bubbles: true})); })()`);
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 1, 'the sync mode changed back');
            await evaluate('window.proTest.button("保存").click()');
            await until(() => evaluate('Boolean(window.proTest.confirm())'), 'the save dialog');
            await evaluate('window.proTest.confirm().click()');
            await until(() => evaluate('jmpInfo.settings.video.sync_mode === "display-resample"'), 'the sync mode setting back');
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 0, 'nothing left to save');

            // ---- the display's ICC profile: a setting, not a line of the profile
            await evaluate('window.proTest.tab("color")');
            const colour = await evaluate('Promise.resolve(api.player.proIccState())');
            assert.ok(colour.setting === 'auto' && ['', 'hdr', 'acm'].includes(colour.managed) && colour.overridden === false, 'the ICC state: ' + JSON.stringify(colour));
            assert.equal(await property('icc-profile-auto'), colour.managed === '', '"auto" reads the profile unless Windows manages colour on this display');
            assert.deepEqual(await evaluate('[...window.proTest.row("icc-mode").querySelectorAll("option")].map(option => option.value)'), ['auto', 'on', 'off']);
            const chooseIcc = mode => evaluate(`(() => { const select = window.proTest.row('icc-mode').querySelector('select'); select.value = '${mode}'; select.dispatchEvent(new Event('change', {bubbles: true})); })()`);
            await chooseIcc('on');
            await until(async () => await property('icc-profile-auto') === true, '"on" reads the profile');
            await chooseIcc('off');
            await until(async () => await property('icc-profile-auto') === false, '"off" does not');
            assert.deepEqual(await evaluate('window.tigerestProMode.changes()'), [{key: 'icc-mode', before: 'auto', now: 'off'}], 'the choice is a change against the setting');
            await evaluate('window.proTest.button("保存").click()');
            await until(() => evaluate('Boolean(window.proTest.confirm())'), 'the save dialog');
            await evaluate('window.proTest.confirm().click()');
            await until(() => evaluate('jmpInfo.settings.video.iccProfile === "off"'), 'the ICC choice in the settings');
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 0, 'nothing left to save');
            // The profile holds icc-profile-auto=yes; applying it again must not turn the profile back on.
            assert.ok((await evaluate('Promise.resolve(api.player.mpvConfState())')).user.includes('icc-profile-auto=yes'), 'the profile asks for it');
            assert.equal(await evaluate('Promise.resolve(api.player.proApplyProfile(' + JSON.stringify(saved) + '))'), true);
            await delay(1200);
            assert.equal(await property('icc-profile-auto'), false, 'a profile applied during playback leaves the choice alone');
            await chooseIcc('auto');
            await until(async () => await property('icc-profile-auto') === (colour.managed === ''), '"auto" again');
            await evaluate('window.proTest.button("保存").click()');
            await until(() => evaluate('Boolean(window.proTest.confirm())'), 'the save dialog');
            await evaluate('window.proTest.confirm().click()');
            await until(() => evaluate('jmpInfo.settings.video.iccProfile === "auto"'), 'the ICC setting back');
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 0, 'nothing left to save');
            await shot('9-colour');

            // ---- RTX video: the driver's d3d11vpp filter, kept last, and two settings
            await evaluate('window.proTest.tab("quality")');
            const rtxState = () => evaluate('Promise.resolve(api.player.proRtxState())');
            const lastFilter = async () => ((await property('vf')) || []).at(-1)?.label;
            const rtxStart = await rtxState();
            assert.ok(rtxStart.available === true && !rtxStart.vsr && !rtxStart.hdr && !rtxStart.settingVsr && rtxStart.filter === '',
                'RTX video starts off: ' + JSON.stringify(rtxStart));
            await until(() => evaluate('Boolean(window.proTest.row("rtx-vsr")) && Boolean(window.proTest.row("rtx-hdr"))'), 'the RTX switches');
            await evaluate('window.proTest.row("rtx-vsr").querySelector("input").click()');
            await until(async () => (await rtxState()).filter.startsWith('d3d11vpp=scaling-mode=nvidia:scale=') && await lastFilter() === 'tigerest-rtx',
                'super resolution as the last filter');
            const rtxScale = Number((await rtxState()).filter.match(/scale=([\d.]+)/)[1]);
            assert.ok(rtxScale >= 1.05 && rtxScale <= 4, 'up to the screen, at most 4x: ' + rtxScale);
            const source = await property('video-params');
            await until(async () => (await property('video-out-params'))?.w === ((Math.trunc(source.w * rtxScale) + 1) & ~1),
                'the enlarged frames reach the output');
            assert.deepEqual(await evaluate('window.tigerestProMode.changes()'), [{key: 'rtx-vsr', before: 'no', now: 'yes'}], 'the switch is a change against the setting');
            // A filter added afterwards (RIFE, VFG and SVP add theirs when they start) does not stay behind it.
            await command('vf', 'add', '@probe:format=fmt=yuv420p');
            await until(async () => (await property('vf')).some(entry => entry.label === 'probe') && await lastFilter() === 'tigerest-rtx', 'the RTX filter last again');
            await command('vf', 'remove', '@probe');
            // RTX Video HDR where Windows HDR is on; elsewhere the panel says why not.
            await evaluate('window.proTest.row("rtx-hdr").querySelector("input").click()');
            await until(async () => (await rtxState()).hdr === true, 'the HDR choice');
            await until(async () => {
                const state = await rtxState();
                return colour.managed === 'hdr' ? state.filter.includes(':nvidia-true-hdr=yes') && !state.hdrReason
                    : !state.filter.includes('nvidia-true-hdr') && state.hdrReason.includes('Windows HDR');
            }, colour.managed === 'hdr' ? 'HDR in the filter' : 'why HDR is not used');
            await shot('10-rtx');
            await evaluate('window.proTest.button("保存").click()');
            await until(() => evaluate('Boolean(window.proTest.confirm())'), 'the save dialog');
            await evaluate('window.proTest.confirm().click()');
            await until(() => evaluate('jmpInfo.settings.video.rtxVsr === true && jmpInfo.settings.video.rtxHdr === true'), 'the RTX choices in the settings');
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 0, 'nothing left to save');
            assert.equal(await lastFilter(), 'tigerest-rtx', 'saving keeps the filter');
            // Both off in quick succession, then saved: the filter goes and the settings follow.
            await evaluate('window.proTest.row("rtx-vsr").querySelector("input").click(); window.proTest.row("rtx-hdr").querySelector("input").click()');
            await until(async () => {
                const state = await rtxState();
                return !state.vsr && !state.hdr && state.filter === '' && !(await property('vf')).some(entry => entry.label === 'tigerest-rtx');
            }, 'the RTX filter removed');
            await evaluate('window.proTest.button("保存").click()');
            await until(() => evaluate('Boolean(window.proTest.confirm())'), 'the save dialog');
            await evaluate('window.proTest.confirm().click()');
            await until(() => evaluate('jmpInfo.settings.video.rtxVsr === false && jmpInfo.settings.video.rtxHdr === false'), 'the RTX settings off again');
            await until(async () => (await evaluate('window.tigerestProMode.changes()')).length === 0, 'nothing left to save');

            // ---- deleting the profile made here -------------------------------
            await evaluate('window.proTest.tab("quality")');
            await evaluate('window.proTest.button("删除").click()');
            await until(() => evaluate('Boolean(window.proTest.confirm())'), 'the delete dialog');
            await evaluate('window.proTest.confirm().click()');
            await until(async () => await property('user-data/profile_menu/current') === startProfile &&
                !(await evaluate('Promise.resolve(api.player.mpvConfState())')).user.includes('[' + saved + ']'), 'the profile gone and the default in use', 200);
            assert.equal((await evaluate('Promise.resolve(api.player.mpvConfState())')).user, conf.defaultUser.replace(/\n*$/, '\n'),
                'mpv.conf is as it was before the profile was made');
            await until(() => evaluate('window.proTest.button("删除").disabled === true'), 'a bundled profile cannot be deleted');
            // A bundled profile is stored by its short name.
            assert.equal(await evaluate('jmpInfo.settings.mpv.shaderPreset'), startProfile.replace(/^tigerest-/, ''), 'the settings page follows');
            await until(async () => (await shaderChain()).length === 3 && await property('saturation') === 0, 'the default profile\'s picture');
            await until(async () => !await evaluate('[...window.proTest.root().querySelectorAll(".group select option")].some(option => option.value === ' + JSON.stringify(saved) + ')'),
                'the deleted profile gone from the list');

            // ---- danmaku: the plugin is restyled at once and the setting kept --
            await evaluate('window.proTest.tab("danmaku")');
            await until(() => evaluate('Boolean(window.proTest.row("fontsize"))'), 'the danmaku page');
            const style = await property('user-data/uosc_danmaku/style');
            assert.equal(await evaluate('window.proTest.row("fontsize").querySelector("input").value'), String(style.fontsize), 'the page shows the plugin\'s style');
            await evaluate('window.proTest.slide("fontsize", 64, true)');
            await until(async () => (await property('user-data/uosc_danmaku/style')).fontsize === 64, 'the font size in the plugin');
            await until(() => evaluate('jmpInfo.settings.danmaku.fontsize === 64'), 'the font size in the settings');
            await evaluate('window.proTest.row("bold").querySelector("input").click()');
            await until(async () => (await property('user-data/uosc_danmaku/style')).bold === !style.bold, 'bold in the plugin');
            assert.deepEqual(await evaluate('window.tigerestProMode.changes()'), [], 'danmaku style is not part of the picture changes');
            await evaluate('window.proTest.tab("quality")');

            // ---- leaving ------------------------------------------------------
            await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key: "F2", bubbles: true, cancelable: true}))');
            await until(async () => !await evaluate('window.tigerestProMode.isActive()'), 'F2 leaves the mode');
            await until(async () => {
                const size = await property('osd-dimensions');
                return size.w === full.w && size.h === full.h;
            }, 'the video in the whole window again');
            assert.equal(await evaluate('Boolean(document.getElementById("tigerest-pro-mode"))'), false, 'the panels are gone');
            assert.equal(await evaluate('[...document.body.children].some(node => node.inert)'), false, 'the page underneath takes input again');

            // A local file plays video-only: the page is hidden until the mode
            // needs it for the panels, and hidden again afterwards. UOSC's
            // button (and F2 inside mpv) go through the message used here.
            assert.ok(await evaluate('window.proTest.frames()') > 5, 'the page is drawn while it is shown');
            await evaluate('Promise.resolve(api.player.setVideoOnlyMode(true))');
            await delay(300);
            assert.equal(await evaluate('window.proTest.frames()'), 0, 'video-only playback hides the page');
            await command('script-message', 'tigerest-pro-toggle');
            await until(() => evaluate('window.tigerestProMode.isActive()'), 'the mode from mpv');
            await until(async () => await evaluate('window.proTest.frames()') > 5, 'the page shown for the panels');
            await command('script-message', 'tigerest-pro-toggle');
            await until(async () => !await evaluate('window.tigerestProMode.isActive()'), 'the mode left from mpv');
            await delay(300);
            assert.equal(await evaluate('window.proTest.frames()'), 0, 'and the page hidden again');
            await evaluate('Promise.resolve(api.player.setVideoOnlyMode(false))');

            await command('script-message', 'tigerest-pro-toggle');
            await until(() => evaluate('window.tigerestProMode.isActive()'), 'the mode once more');
            await evaluate('Promise.resolve(api.player.stop())');
            await until(async () => !await evaluate('window.tigerestProMode.isActive()'), 'stopping playback leaves the mode');
            assert.equal(await evaluate('Promise.resolve(api.player.proModeActive())'), false);

            const errors = log().split('\n').filter(line => /Lua error|stack traceback/i.test(line));
            assert.deepEqual(errors, [], 'scripts reported errors');
            result = {fullWindow: full, inMode: small, renderSteps: stats.passes.fresh.length, load, pausedCompare: paused, savedProfile: saved, keyboard,
                clip: clip ? path.basename(clip) : 'generated Y4M'};
        } catch (error) {
            console.error(log().split('\n').slice(-40).join('\n'));
            throw error;
        } finally {
            ipc?.destroy();
            if (process.env.TIGEREST_TEST_LOG) fs.writeFileSync(process.env.TIGEREST_TEST_LOG, log());
        }
    }, {gpu: true, visible: true, startupTimeout: 30000, args: ['--log-level', process.env.TIGEREST_TEST_LOG_LEVEL || 'info'],
        settings: {mpv: {enableDanmaku: true}, video: {'refreshrate.auto_switch': false, 'hdr.auto_switch': false}},
        // The danmaku plugin runs for its style page; its servers point at a
        // closed local port, so nothing is asked of the real ones.
        prepareProfile: async () => {
            process.env.TIGEREST_MPV_TEST_OPTIONS = ['input-ipc-server=' + pipe, 'mute=yes',
                'script-opts-append=uosc_danmaku-api_server=http://127.0.0.1:9',
                'script-opts-append=uosc_danmaku-fallback_server=http://127.0.0.1:9'].join('\n');
        }});
    console.log(JSON.stringify({proMode: result,
        scope: 'real client, libmpv gpu-next and a local clip; isolated profile; no Emby server'}));
})().catch(error => { console.error(error); process.exitCode = 1; });
