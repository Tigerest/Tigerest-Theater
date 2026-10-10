'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tigerest-compositor-rerun-'));
try {
    const reportPath = path.join(directory, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify({passed: true, manual: {passed: true}, previousRun: true}));
    const result = spawnSync(process.execPath, [path.join(__dirname, 'test_windows_compositor.cjs'),
        'missing-fixture.exe', '--webengine', '--capture=missing-capture.exe', '--output=' + directory],
        {encoding: 'utf8', timeout: 10000, windowsHide: true});
    assert.equal(result.error, undefined, 'failure-path check must finish');
    assert.notEqual(result.status, 0, 'missing capture helper must fail');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.passed, false, 'failed rerun must invalidate the previous passing report');
    assert.equal(report.manual.passed, false, 'old manual approval must not carry into a rerun');
    assert.equal(report.previousRun, undefined, 'previous evidence must not survive');
    console.log('PASS: failed compositor rerun invalidates prior successful evidence');
} finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('tigerest-compositor-rerun-'));
    fs.rmSync(directory, {recursive: true, force: true});
}
