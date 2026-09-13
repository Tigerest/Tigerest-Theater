'use strict';

// Test the deployed application and its app-local DLLs, rather than the build
// tree where a newer system/toolchain runtime can hide packaging mistakes.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

(async () => {
  assert.ok(process.argv[2], 'Pass the packaged application executable');
  const executable = path.resolve(process.argv[2]);
  assert.ok(fs.existsSync(executable), 'Packaged executable is missing');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tigerest-bundle-test-'));
  const id = randomUUID().replaceAll('-', '');
  const profile = path.join(root, 'profiles', id);
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'profile.json'), JSON.stringify({ name: `BundleTest-${id}` }));
  fs.writeFileSync(path.join(profile, 'Tigerest Theater.conf'), JSON.stringify({
    version: 10,
    sections: {
      main: { enableWindowsTrayIcon: false },
      path: { startupurl_desktop: 'about:blank' },
    },
  }));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const child = spawn(executable, [
    '--config-dir', root, '--profile', `BundleTest-${id}`, '--disable-gpu',
    '--remote-debugging-port', `127.0.0.1:${port}`,
  ], { cwd: path.dirname(executable), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.stdout.on('data', data => { diagnostics = (diagnostics + data).slice(-8000); });
  child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-8000); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `Packaged application exited early: ${diagnostics}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        const pages = await response.json();
        if (pages.some(page => page.type === 'page')) { ready = true; break; }
      } catch { /* Wait for WebEngine startup. */ }
      await delay(200);
    }
    assert.ok(ready, `Packaged WebEngine startup timed out: ${diagnostics}`);
    await delay(1500);
    assert.equal(child.exitCode, null, `Packaged application crashed after startup: ${diagnostics}`);
    console.log('PASS: packaged application starts with its bundled runtime and creates a WebEngine page');
  } finally {
    if (child.pid && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    // Only remove the random, test-owned directory created above.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('tigerest-bundle-test-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
