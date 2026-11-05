// Real Windows/libmpv/curl regression with isolated configuration and loopback HTTP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
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

(async () => {
    const hits = {}, encodings = {}, rows = [];
    const server = http.createServer((req, res) => {
        const name = req.url.slice(1), times = hits[name] ||= [];
        times.push(Date.now());
        const encoding = req.headers['accept-encoding'] || '';
        (encodings[name] ||= []).push(encoding);
        if (name === 'timeout' && times.length === 1) return; // curl must enforce its own deadline
        // The NAS answers an exhausted upstream budget and plain throttling with the same 429.
        if (name.startsWith('budget') || name === 'throttled') {
            res.writeHead(429, {'Content-Type':'application/json', 'Retry-After':'60'});
            return res.end(JSON.stringify({success:false,
                errorMessage: name === 'throttled' ? 'Too many requests' : 'Local upstream budget exhausted'}));
        }
        if (name.startsWith('gzip')) {
            const body = Buffer.from(JSON.stringify({count:1, comments:[{m:'fixture'}]}));
            const gzip = /\bgzip\b/.test(encoding);
            res.writeHead(200, {'Content-Type':'application/json', ...(gzip ? {'Content-Encoding':'gzip'} : {})});
            return res.end(gzip ? zlib.gzipSync(body) : body);
        }
        if (name.startsWith('bilibili')) { // comment.bilibili.com deflates whatever the client accepts
            res.writeHead(200, {'Content-Type':'text/xml', 'Content-Encoding':'deflate'});
            return res.end(zlib.deflateRawSync(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><i><d p="1,1,25,16777215">fixture</d></i>')));
        }
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
            for (const name of ['modules/utils','modules/http','modules/mapping','sites/bilibili']) assert.equal(
                fs.readFileSync(path.join(root, name + '.lua'), 'utf8'),
                fs.readFileSync(path.join(__dirname, '../resources/mpv/plugins/uosc_danmaku', name + '.lua'), 'utf8'),
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
                    await wait(() => fs.existsSync(path.join(output,'cancelled.json')), 'cancel completed');
                    await delay(1300);
                    assert.equal(hits.cancel.length, 1); assert.equal(fs.existsSync(file), false);
                    assert.equal(JSON.parse(fs.readFileSync(path.join(output,'cancelled.json'))).running, false);
                    rows.push({name, attempts:1, cancelled:true}); continue;
                }
                await wait(() => fs.existsSync(file), name + ': response timeout', 27000);
                const result = JSON.parse(fs.readFileSync(file));
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
            // Loopback stands in for the Tigerest API; each phase starts with fresh module state.
            const result = async (message, name) => {
                const file = path.join(output, name + '.json');
                await command(message);
                await wait(() => fs.existsSync(file), name + ': response timeout', 27000);
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            };
            const managed = async mode => {
                await result('script-message http-probe-managed ' + quote(origin) + ' ' + mode, 'managed-' + mode);
                fs.rmSync(path.join(output, 'managed-' + mode + '.json'));
            };
            const request = (name, compressed = '') => result(`script-message http-probe-request ${name} ${quote(origin + '/' + name)} ${compressed}`, name);
            const curlCommand = name => result(`script-message http-probe-command ${name} ${quote(origin + '/' + name)}`, name);
            const quota = '大河服务器API额度已耗尽，请明日重试';

            await managed('real');
            let reply = await request('gzip-real', 'compressed');
            assert.ok(reply.ok && JSON.parse(reply.body).count === 1, 'curl with zlib decodes gzip');
            assert.match(encodings['gzip-real'][0], /gzip/, 'a curl with zlib keeps --compressed');
            reply = await curlCommand('budget-command');
            assert.equal(reply.err, undefined); assert.equal(reply.notice, quota, 'search body names the exhausted budget');
            await managed('real');
            reply = await request('budget');
            assert.equal(reply.status, 429); assert.equal(hits.budget.length, 1); assert.equal(reply.notice, quota);
            await managed('real');
            reply = await request('throttled');
            assert.equal(reply.status, 429); assert.match(reply.notice, /^弹幕接口请求过于频繁，请 \d+ 秒后重试$/);
            await managed('plain');
            reply = await request('gzip-plain', 'compressed');
            assert.ok(reply.ok && JSON.parse(reply.body).count === 1, 'a curl without zlib still completes the request');
            assert.equal(encodings['gzip-plain'][0], '', 'a curl without zlib drops --compressed');
            reply = await curlCommand('gzip-command');
            assert.equal(reply.err, undefined); assert.equal(JSON.parse(reply.json).count, 1);
            assert.equal(encodings['gzip-command'][0], '');
            reply = await curlCommand('bilibili-plain');
            assert.equal(reply.raw, false, 'the deflated XML arrives undecoded');
            assert.match(reply.xml, /<d p="1,1,25,16777215">fixture<\/d>/, 'bilibili XML is inflated in Lua');
            rows.push({name:'curl-without-zlib', acceptEncoding:encodings['gzip-plain'][0]}, {name:'budget', notice:quota});
            reply = await result('script-message http-probe-compile', 'compiled');
            assert.ok(reply.files >= 20, 'compiled the packaged plugin tree: ' + reply.files);
            assert.equal(reply.count, 0, 'packaged plugin Lua compiles: ' + JSON.stringify(reply.errors));
            rows.push({name:'compile', files:reply.files});

            const logs = fs.readdirSync(profile, {recursive:true}).filter(file => path.basename(file) === 'Tigerest Theater.log')
                .map(file => fs.readFileSync(path.join(profile,file),'utf8')).join('\n');
            assert.match(logs, /Danmaku HTTP retry: kind=comment status=0 curl=28 attempt=1/);
            assert.match(logs, /curl cannot decode compressed responses/);
            console.log(JSON.stringify({danmakuHttp:rows, scope:'packaged Lua, real libmpv timers and curl, loopback HTTP, isolated profile'}));
        }, {startupTimeout:30000, settings:{mpv:{enableDanmaku:false}}});
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => {console.error(error); process.exitCode = 1;});
