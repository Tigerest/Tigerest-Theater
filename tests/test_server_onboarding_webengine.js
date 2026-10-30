'use strict';

// The real Qt WebChannel, networking stack and Chromium page are exercised
// against a loopback fixture. No user's profile or Emby account is touched.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const configVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/settings/settings_description.json'), 'utf8')).find(section => section.section === '__meta__').version;

// Switching between the bundled chooser and a server page replaces the
// document (and its renderer); a CDP call caught in that swap is answered
// with one of these errors instead of a value.
const documentReplaced = error => /Inspected target navigated or closed|Execution context was destroyed/.test(error?.message);
async function until(check, label) {
    for (let i = 0; i < 150; i++) {
        let value;
        try { value = await check(); } catch (error) { if (!documentReplaced(error)) throw error; }
        if (value) return value;
        await delay(100);
    }
    throw new Error(`Timed out: ${label}`);
}
async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
}
async function devtools(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`${method} timed out`));
        }, 10000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    return {
        send,
        async evaluate(expression) {
            const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
            return result.result.value;
        },
        close() { socket.close(); },
    };
}

(async () => {
    const executable = path.resolve(process.argv[2]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tigerest-onboarding-test-'));
    const id = randomUUID().replaceAll('-', '');
    // macOS UNIX socket paths include the profile name and have a short limit.
    const profileName = `Onboarding-${id.slice(0, 8)}`;
    const profile = path.join(root, 'profiles', id);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'profile.json'), JSON.stringify({ name: profileName }));
    fs.writeFileSync(path.join(profile, 'Tigerest Theater.conf'), JSON.stringify({
        version: configVersion, sections: { main: { enableWindowsTrayIcon: false } },
    }));
    const requests = [];
    const fixture = http.createServer((req, res) => {
        // Requests from the page carry Fetch Metadata; the client's native
        // connection check does not.
        requests.push(`${req.method} ${req.url}${req.headers['sec-fetch-mode'] ? ' (page)' : ''}`);
        if (req.url === '/disconnect/web/index.html') {
            req.socket.destroy();
        } else if (req.url === '/emby/System/Info/Public' || req.url === '/badweb/System/Info/Public' || req.url === '/disconnect/System/Info/Public' || req.url === '/jellyfin/System/Info/Public') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ Id: 'onboarding-test-server', ServerName: 'Fixture', Version: req.url.startsWith('/jellyfin/') ? '10.11.11' : '4.9' }));
        } else if (req.url === '/emby/web/index.html' || req.url === '/jellyfin/web/index.html') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end('<!doctype html><title>Fixture Emby</title><p id="fixture">自己的 Emby 已连接</p>');
        } else {
            res.writeHead(403); res.end('Forbidden');
        }
    });
    const fixturePort = await listen(fixture);
    const origin = `http://127.0.0.1:${fixturePort}`;
    let child, cdp, startupErrors = '';
    async function stop() {
        cdp?.close(); cdp = null;
        if (child && child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => child.once('exit', resolve));
            child.kill(); await exited;
        }
    }
    async function launch() {
        const reservation = net.createServer();
        const port = await listen(reservation);
        await new Promise(resolve => reservation.close(resolve));
        child = spawn(executable, ['--config-dir', root, '--profile', profileName,
            '--disable-gpu', '--remote-debugging-port', `127.0.0.1:${port}`], {
            windowsHide: !process.env.TIGEREST_ONBOARDING_INSPECT, stdio: ['ignore', 'ignore', 'pipe'],
        });
        startupErrors = '';
        child.stderr.on('data', chunk => { startupErrors = (startupErrors + chunk).slice(-8000); });
        const target = await until(async () => {
            assert.equal(child.exitCode, null, 'app exited early: ' + startupErrors);
            assert.equal(child.signalCode, null, 'app terminated early: ' + startupErrors);
            try {
                const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
                return list.find(item => item.type === 'page');
            } catch { return null; }
        }, 'app devtools');
        cdp = await devtools(target.webSocketDebuggerUrl);
        // The window is hidden or behind other windows; focus events must not
        // depend on which window the desktop has active.
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    }
    try {
        await launch();
        await until(() => cdp.evaluate("Boolean(document.querySelector('#choose-custom') && window.api && !document.querySelector('#choose-custom').disabled)"), 'server choices');
        assert.deepEqual(requests, []);
        assert.equal(await cdp.evaluate("document.querySelector('#connect-form').hidden"), true);
        await cdp.evaluate("document.querySelector('#choose-tigerest').focus()");
        assert.match(await cdp.evaluate("document.querySelector('#choice-description').textContent"), /B站充电/);
        // Optional pause for inspection through the native window capture tool.
        if (process.env.TIGEREST_ONBOARDING_INSPECT)
            await delay(45000);
        await cdp.evaluate("document.querySelector('#choose-custom').click()");
        assert.equal(await cdp.evaluate("document.querySelector('#address').value"), '');
        async function submit(address) {
            await cdp.evaluate(`document.querySelector('#address').value = ${JSON.stringify(address)}; document.querySelector('#address').dispatchEvent(new Event('input')); document.querySelector('#connect-form').requestSubmit()`);
        }
        // The switch replaces this document, sometimes before its WebChannel
        // reply arrives, so the chooser is awaited instead of the reply.
        const switchServer = () => cdp.evaluate('void window.tigerestSwitchServer()');
        await submit(`${origin}/blocked`);
        await until(() => cdp.evaluate("document.querySelector('#connection-error').textContent.includes('403')"), 'native HTTP error');
        await submit(`${origin}/emby`);
        await until(() => cdp.evaluate("Boolean(document.querySelector('#fixture'))"), 'own server page');
        assert.equal(await cdp.evaluate('location.href'), `${origin}/emby/web/index.html`);
        await until(async () => (await cdp.send('Page.getNavigationHistory')).currentIndex === 0, 'successful load clears old server history');
        const connectedHistory = await cdp.send('Page.getNavigationHistory');
        assert.equal(connectedHistory.currentIndex, 0, 'a successful connection starts a new server history');
        // The page records the chosen server for Emby, so its own sign-in
        // opens instead of the welcome tour and Emby Connect.
        const recorded = await cdp.evaluate("JSON.parse(localStorage.getItem('servercredentials3') || '{}').Servers");
        assert.deepEqual(recorded.map(({ Id, Name, ManualAddress, LastConnectionMode }) => ({ Id, Name, ManualAddress, LastConnectionMode })),
            [{ Id: 'onboarding-test-server', Name: 'Fixture', ManualAddress: `${origin}/emby`, LastConnectionMode: 2 }]);
        assert.equal(await cdp.evaluate("localStorage.getItem('welcome_seen')"), '1');
        assert.ok(requests.includes('GET /emby/System/Info/Public (page)'));
        await until(() => {
            const config = JSON.parse(fs.readFileSync(path.join(profile, 'Tigerest Theater.conf'), 'utf8'));
            return config.sections.main.userWebClient === `${origin}/emby` && config.sections.main.serverConnectionMode === 'custom';
        }, 'persisted custom address');
        const remembered = () => JSON.parse(JSON.parse(fs.readFileSync(path.join(profile, 'Tigerest Theater.conf'), 'utf8')).sections.main.knownServers).servers;
        assert.deepEqual(remembered().map(x => x.address), [`${origin}/emby/`], 'real Qt commits remembered metadata after HTML success');
        const nativeChecks = requests.filter(value => value === 'GET /emby/System/Info/Public').length;
        await switchServer();
        await until(() => cdp.evaluate("Boolean(document.querySelector('#choose-custom') && window.api && !document.querySelector('#choose-custom').disabled)"), 'explicit server choices');
        assert.equal(await cdp.evaluate("document.querySelector('#server-choice').hidden"), false);
        assert.equal(requests.filter(value => value === 'GET /emby/System/Info/Public').length, nativeChecks, 'switch must not auto-connect');
        await cdp.evaluate("document.querySelector('#choose-custom').click()");
        assert.equal(await cdp.evaluate("document.querySelector('#address').value"), `${origin}/emby`);
        await cdp.evaluate("document.querySelector('#cancel-switch-button').click()");
        await until(() => cdp.evaluate("Boolean(document.querySelector('#fixture'))"), 'cancel returns to previous server');
        assert.equal(await cdp.evaluate("JSON.parse(localStorage.getItem('servercredentials3')).Servers[0].Id"), 'onboarding-test-server');
        assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'Tigerest Theater.conf'), 'utf8')).sections.main.userWebClient, `${origin}/emby`);
        await switchServer();
        await until(() => cdp.evaluate("Boolean(document.querySelector('#choose-custom') && window.api && !document.querySelector('#choose-custom').disabled)"), 'switch before failed web document');
        await cdp.evaluate("document.querySelector('#choose-custom').click()");
        await submit(`${origin}/badweb`);
        await until(() => requests.some(value => value.startsWith('GET /badweb/web/index.html')), 'failing web document requested');
        await until(() => cdp.evaluate("Boolean(document.querySelector('#choose-custom') && window.api && !document.querySelector('#choose-custom').disabled)"), 'failed document returns to chooser');
        await until(() => JSON.parse(fs.readFileSync(path.join(profile, 'Tigerest Theater.conf'), 'utf8')).sections.main.userWebClient === `${origin}/emby`, 'failed document restores saved destination');
        await cdp.evaluate("document.querySelector('#choose-custom').click()");
        assert.equal(await cdp.evaluate("document.querySelector('#address').value"), `${origin}/emby`, 'chooser session cache cannot restore the failed address');
        await cdp.evaluate("document.querySelector('#cancel-switch-button').click()");
        await until(() => cdp.evaluate("Boolean(document.querySelector('#fixture'))"), 'failed switch still permits cancel to original server');
        await switchServer();
        await until(() => cdp.evaluate("Boolean(document.querySelector('#choose-custom') && window.api && !document.querySelector('#choose-custom').disabled)"), 'chooser before disconnected document');
        await cdp.evaluate("document.querySelector('#choose-custom').click()");
        await submit(`${origin}/disconnect`);
        await until(() => cdp.evaluate("Boolean(document.querySelector('#server-choice') && !document.querySelector('#server-choice').hidden && document.querySelector('#choice-description').textContent.includes('失败'))"), 'connection failure unlocks original chooser');
        assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'Tigerest Theater.conf'), 'utf8')).sections.main.userWebClient, `${origin}/emby`);
        await cdp.evaluate("document.querySelector('#cancel-switch-button').click()");
        await until(() => cdp.evaluate("Boolean(document.querySelector('#fixture'))"), 'cancel after disconnected document');
        assert.deepEqual(remembered().map(x => x.address), [`${origin}/emby/`], 'failed and cancelled HTML loads never enter history');
        await switchServer();
        await until(() => cdp.evaluate("Boolean(document.querySelector('#choose-custom') && window.api && !document.querySelector('#choose-custom').disabled)"), 'chooser before second base path');
        await cdp.evaluate("document.querySelector('#choose-custom').click()");
        await submit(`${origin}/jellyfin`);
        await until(() => cdp.evaluate("location.pathname === '/jellyfin/web/index.html' && !!document.querySelector('#fixture')"), 'second server loaded');
        // Qt writes the profile settings shortly after the page has loaded.
        const rememberedAs = (addresses, label) => until(() => remembered().map(x => x.address).join() === addresses.join(), label);
        await rememberedAs([`${origin}/jellyfin/`, `${origin}/emby/`], 'same hostname and server ID retain different base paths');
        await switchServer();
        await until(() => cdp.evaluate("document.querySelectorAll('.saved-server-open').length === 2"), 'saved cards');
        await cdp.evaluate(`document.querySelector('[data-key="custom:${origin}/emby/"] .saved-server-open').click()`);
        await until(() => cdp.evaluate("location.pathname === '/emby/web/index.html' && !!document.querySelector('#fixture')"), 'saved card returns to first server');
        await rememberedAs([`${origin}/emby/`, `${origin}/jellyfin/`], 'saved card moves the first server to the front');
        assert.equal(await cdp.evaluate("JSON.parse(localStorage.getItem('servercredentials3')).Servers[0].Id"), 'onboarding-test-server');
        const beforeRestart = remembered();
        await stop();
        await launch();
        await until(() => cdp.evaluate("Boolean(document.querySelector('#fixture'))"), 'saved server reconnection');
        // Reconnecting at launch is itself a connection and may refresh the time.
        const withoutTime = list => list.map(({ lastConnectedAt, ...record }) => record);
        const afterRestart = remembered();
        assert.deepEqual(withoutTime(afterRestart), withoutTime(beforeRestart), 'restart retains both records and last connection order');
        afterRestart.forEach((record, i) => assert.ok(record.lastConnectedAt >= beforeRestart[i].lastConnectedAt));
        assert.ok(!requests.some(value => value.startsWith('HEAD ')), 'unnecessary HEAD redirect check');
        console.log('PASS: real Qt startup, errors, exact port/path, explicit switch without reconnect, saved address and credentials after cancel, persistent reconnection, native history rollback and base-path card return');
    } catch(error) {
        console.error('Native startup diagnostics', startupErrors);
        try { console.error('Navigation history', await cdp.send('Page.getNavigationHistory')); } catch {}
        try { console.error('Fixture failure state', await cdp.evaluate('({url:location.href,api:!!window.api,choices:!!document.querySelector("#choose-custom"),error:document.querySelector("#connection-error")?.textContent,description:document.querySelector("#choice-description")?.textContent})')); } catch {}
        throw error;
    } finally {
        await stop();
        await new Promise(resolve => fixture.close(resolve));
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('tigerest-onboarding-test-'));
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
