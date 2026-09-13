'use strict';

// Integration regression: ask the real Chromium instance which GPU mode and
// arguments it received. A parser accepting --disable-gpu is not sufficient.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function systemInfo(url) {
    const socket = new WebSocket(url);
    try {
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('SystemInfo timed out')), 10000);
            socket.addEventListener('message', event => {
                const message = JSON.parse(event.data);
                if (message.id !== 1) return;
                clearTimeout(timer);
                if (message.error) reject(new Error(JSON.stringify(message.error)));
                else resolve(message.result);
            });
            socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' }));
        });
    } finally {
        socket.close();
    }
}

async function run(executable, allowBrowserZoom) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tigerest-webengine-test-'));
    const id = randomUUID().replaceAll('-', '');
    const profile = path.join(root, 'profiles', id);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'profile.json'), JSON.stringify({ name: `GpuTest-${id}` }));
    fs.writeFileSync(path.join(profile, 'Tigerest Theater.conf'), JSON.stringify({
        version: 10,
        sections: {
            main: { allowBrowserZoom, enableWindowsTrayIcon: false },
            path: { startupurl_desktop: 'about:blank' },
        },
    }));
    const port = await freePort();
    const child = spawn(executable, [
        '--config-dir', root, '--profile', `GpuTest-${id}`, '--disable-gpu',
        '--remote-debugging-port', `127.0.0.1:${port}`,
    ], {
        windowsHide: true,
        env: { ...process.env, QTWEBENGINE_CHROMIUM_FLAGS: '--disable-gpu-vsync' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    child.stdout.on('data', chunk => { diagnostics += chunk; });
    child.stderr.on('data', chunk => { diagnostics += chunk; });
    try {
        let version;
        for (let attempt = 0; attempt < 150; attempt++) {
            assert.equal(child.exitCode, null, `Application exited early: ${diagnostics}`);
            try {
                const response = await fetch(`http://127.0.0.1:${port}/json/version`);
                version = await response.json();
                break;
            } catch { await delay(200); }
        }
        assert.ok(version, `DevTools startup timed out: ${diagnostics}`);
        const info = await systemInfo(version.webSocketDebuggerUrl);
        assert.match(info.commandLine, /(?:^|\s)--disable-gpu(?:\s|$)/,
            `--disable-gpu never reached Chromium (allowBrowserZoom=${allowBrowserZoom})`);
        assert.match(info.commandLine, /--disable-gpu-vsync(?:\s|$)/,
            'Application flags overwrote the caller\'s Chromium configuration');
        assert.equal(info.gpu.featureStatus.gpu_compositing, 'disabled_software');
        if (!allowBrowserZoom) assert.match(info.commandLine, /--disable-pinch(?:\s|$)/);
        console.log(`PASS: zoom=${allowBrowserZoom}; Chromium GPU compositing=${info.gpu.featureStatus.gpu_compositing}`);
    } finally {
        if (child.exitCode === null) {
            child.kill();
            await new Promise(resolve => child.once('exit', resolve));
        }
        // This is exclusively the random directory created by this test.
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('tigerest-webengine-test-'));
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
}

(async () => {
    assert.ok(process.argv[2], 'Pass the built application executable');
    await run(path.resolve(process.argv[2]), true);
    await run(path.resolve(process.argv[2]), false);
})().catch(error => { console.error(error); process.exitCode = 1; });
