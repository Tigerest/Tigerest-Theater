// Real Windows/libmpv/curl regression with isolated configuration and loopback HTTP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {setTimeout: delay} = require('node:timers/promises');
const withBrowser = require('./community_browser.cjs');
const frame = Buffer.alloc(64 * 36 * 3 / 2, 128);
frame.fill(32, 0, 64 * 36);
const video = Buffer.concat([Buffer.from('YUV4MPEG2 W64 H36 F24:1 Ip A1:1 C420jpeg\n'),
    ...Array.from({length:24 * 90}, () => Buffer.concat([Buffer.from('FRAME\n'), frame]))]);
const routes = {'/': {type:'text/html', body:'<!doctype html><title>Danmaku HTTP regression</title>'},
    '/clip.y4m': {type:'video/x-yuv4mpeg', body:video}};
const wait = async (condition, label, timeout = 5000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {const value = condition(); if (value) return value; await delay(40);}
    throw Error(label);
};
// The probe creates a result file before writing it; only complete JSON counts.
const readJson = file => { try { return JSON.parse(fs.readFileSync(file)); } catch { return null; } };

(async () => {
    const hits = {}, rows = [];
    const server = http.createServer((req, res) => {
        const name = req.url.slice(1), times = hits[name] ||= [];
        times.push(Date.now());
        if (name === 'timeout' && times.length === 1) return; // curl must enforce its own deadline
        const status = name === 'limited' ? 429 : name === 'denied' ? 403 :
            name === 'cancel' || ((name === 'gateway' || name === 'timeout') && times.length === 1) ? 503 : 200;
        res.writeHead(status, {'Content-Type':'application/json', ...(status === 429 ? {'Retry-After':'60'} : {})});
        res.end(JSON.stringify(name === 'empty' ? {count:0, comments:[]} : {count:1, comments:[{m:'fixture'}]}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
        await withBrowser(routes, async ({evaluate, profile}) => {
            await evaluate(`(${(async () => {
                await window.initCompleted;
                let position = 0;
                api.player.positionUpdate.connect(value => position = value);
                await api.window.beginPlaybackSession();
                if (!await api.player.load(location.origin + '/clip.y4m', {autoplay:true},
                    {type:'video', frameRate:24}, null, null)) throw Error('media load rejected');
                for (let i = 0; i < 180; i++) {
                    if (position > 0) return true;
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                throw Error('native video playback did not start');
            }).toString()})()`);
            const relative = fs.readdirSync(profile, {recursive:true}).find(file => file.endsWith(path.join('modules','http.lua')));
            assert.ok(relative, 'new HTTP module must be included in the installed binary resources');
            const moduleFile = path.join(profile, relative), root = path.dirname(path.dirname(moduleFile));
            for (const name of ['utils','http','mapping']) assert.equal(
                fs.readFileSync(path.join(root, 'modules', name + '.lua'), 'utf8'),
                fs.readFileSync(path.join(__dirname, '../resources/mpv/plugins/uosc_danmaku/modules', name + '.lua'), 'utf8'),
                'embedded ' + name + ' module must match source');
            const output = path.join(profile, 'http-results'); fs.mkdirSync(output);
            const quote = value => JSON.stringify(value.replaceAll('\\','/'));
            const command = text => evaluate(`api.player.userCommand(${JSON.stringify(text)}).then(() => true)`);
            const probe = path.join(__dirname, 'fixtures/tigerest_danmaku_http_probe.lua');
            await command('load-script ' + quote(probe));
            // Loading a Lua script is asynchronous; repeat only the idempotent init message.
            for (let i = 0; i < 20 && !fs.existsSync(path.join(output,'ready.json')); i++) {
                await command('script-message http-probe-init ' + quote(root) + ' ' + quote(output));
                await delay(100);
            }
            assert.ok(fs.existsSync(path.join(output,'ready.json')), 'native Lua probe loaded');
            for (const name of ['timeout','gateway','empty','limited','denied','cancel']) {
                const started = Date.now(), file = path.join(output, name + '.json');
                await command('script-message http-probe-request ' + name + ' ' + quote(origin + '/' + name));
                if (name === 'cancel') {
                    await wait(() => hits.cancel?.length === 1, 'cancel request reached server');
                    await delay(100);
                    await command('script-message http-probe-cancel');
                    await wait(() => readJson(path.join(output,'cancelled.json')), 'cancel completed');
                    await delay(1300);
                    assert.equal(hits.cancel.length, 1); assert.equal(fs.existsSync(file), false);
                    assert.equal(JSON.parse(fs.readFileSync(path.join(output,'cancelled.json'))).running, false);
                    rows.push({name, attempts:1, cancelled:true}); continue;
                }
                const result = await wait(() => readJson(file), name + ': response timeout', 27000);
                const expected = name === 'timeout' || name === 'gateway' ? 2 : 1;
                if (!hits[name]) {
                    const diagnostics = fs.readdirSync(profile, {recursive:true}).filter(file => path.basename(file) === 'Tigerest Theater.log')
                        .map(file => fs.readFileSync(path.join(profile,file),'utf8').split('\n').filter(line => /http_probe|Danmaku HTTP|subprocess/.test(line)).slice(-15).join('\n')).join('\n');
                    throw Error(name + ': request did not reach loopback: ' + JSON.stringify(result) + '\n' + diagnostics);
                }
                assert.equal(hits[name].length, expected, name + ': bounded attempt count');
                assert.equal(result.running, false, name + ': loading counter released');
                assert.equal(result.ok, !['limited','denied'].includes(name));
                if (result.ok) assert.equal(JSON.parse(result.body).count, name === 'empty' ? 0 : 1);
                if (name === 'limited') assert.equal(result.status, 429);
                if (name === 'denied') assert.equal(result.status, 403);
                if (name === 'timeout') assert.ok(hits[name][1] - hits[name][0] >= 20500, 'real 20 s deadline + 1 s backoff');
                if (name === 'gateway') assert.ok(hits[name][1] - hits[name][0] >= 900, '1 s backoff');
                rows.push({name, attempts:expected, status:result.status, elapsedMs:Date.now() - started});
            }
            const logs = fs.readdirSync(profile, {recursive:true}).filter(file => path.basename(file) === 'Tigerest Theater.log')
                .map(file => fs.readFileSync(path.join(profile,file),'utf8')).join('\n');
            assert.match(logs, /Danmaku HTTP retry: kind=comment status=0 curl=28 attempt=1/);
            console.log(JSON.stringify({danmakuHttp:rows, scope:'packaged Lua, real libmpv timers and curl, loopback HTTP, isolated profile'}));
        }, {startupTimeout:30000, settings:{mpv:{enableDanmaku:false}}});
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => {console.error(error); process.exitCode = 1;});
