// The shipped Windows client must start an item whose external subtitle the
// server is still preparing. Report: Emby had not answered the subtitle of a
// 24 GB film after 73 s; playback never left mpv's on_preloaded hook and the
// startup watchdog stopped it at 75 s. The client now waits 10 s, starts
// without the track and selects it when the same request is answered.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const withBrowser = require('./community_browser.cjs');

const ANSWER_AFTER_MS = 14000;
const frame = Buffer.alloc(64 * 36 * 3 / 2, 128);
frame.fill(32, 0, 64 * 36);
const video = Buffer.concat([Buffer.from('YUV4MPEG2 W64 H36 F24:1 Ip A1:1 C420jpeg\n'),
    ...Array.from({length: 24 * 40}, () => Buffer.concat([Buffer.from('FRAME\n'), frame]))]);
const routes = {
    '/': {type: 'text/html', body: '<!doctype html><title>Isolated slow subtitle regression</title>'},
    '/clip.y4m': {type: 'video/x-yuv4mpeg', body: video}
};

(async () => {
    const subtitle = {requests: 0, requestedAt: 0, answeredAt: 0};
    const slow = http.createServer((req, res) => {
        subtitle.requests++;
        subtitle.requestedAt = Date.now();
        setTimeout(() => {
            res.writeHead(200, {'Content-Type': 'application/x-subrip'});
            res.end('1\n00:00:00,000 --> 00:01:00,000\nslow subtitle\n\n');
            subtitle.answeredAt = Date.now();
        }, ANSWER_AFTER_MS);
    });
    await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve));
    const subtitleUrl = 'http://127.0.0.1:' + slow.address().port + '/Videos/1/1/Subtitles/7/0/Stream.srt';
    let result;
    try {
        await withBrowser(routes, async ({evaluate, profile}) => {
            const log = () => fs.readdirSync(profile, {recursive: true})
                .filter(file => path.basename(file) === 'Tigerest Theater.log')
                .map(file => fs.readFileSync(path.join(profile, file), 'utf8')).join('\n');
            try {
                await evaluate(`(${(async url => {
                    await window.initCompleted;
                    const state = window.slowSubtitle = {position: 0, startedAt: 0, error: ''};
                    api.player.positionUpdate.connect(value => {
                        state.position = value;
                        if (value > 0 && !state.startedAt) state.startedAt = Date.now();
                    });
                    api.player.error.connect(message => state.error = String(message));
                    await api.window.beginPlaybackSession();
                    state.loadedAt = Date.now();
                    if (!await api.player.load(location.origin + '/clip.y4m', {autoplay: true},
                        {type: 'video', frameRate: 24}, null, '#,' + url)) throw Error('native load rejected');
                    return true;
                }).toString()})(${JSON.stringify(subtitleUrl)})`);
                let state;
                for (let i = 0; i < 300; i++) {
                    state = await evaluate('window.slowSubtitle');
                    assert.equal(state.error, '', 'playback error: ' + state.error);
                    if (state.startedAt) break;
                    await delay(100);
                }
                assert.ok(state.startedAt, 'playback never started while the subtitle was pending');
                const waited = state.startedAt - state.loadedAt;
                assert.equal(subtitle.requests, 1, 'the subtitle is requested once');
                assert.equal(subtitle.answeredAt, 0, 'playback must start before the server answers the subtitle');
                assert.ok(waited >= 9000 && waited < ANSWER_AFTER_MS, 'the start waits about 10 s for the subtitle, waited ' + waited + ' ms');

                // The same request is answered during playback and its track is selected.
                while (!subtitle.answeredAt) await delay(100);
                let text = '';
                for (let i = 0; i < 50 && !text.includes('Late external subtitle stream loaded'); i++) {
                    await delay(100);
                    text = log();
                }
                assert.ok(text.includes('starting playback without them'), 'the late start is logged');
                assert.ok(text.includes('Late external subtitle stream loaded'), 'the late subtitle is selected');
                assert.ok(!text.includes('Unable to add external subtitle stream'), 'the add must not fail');
                assert.equal(subtitle.requests, 1, 'the late subtitle comes from the first request');
                const before = (await evaluate('window.slowSubtitle')).position;
                await delay(1000);
                const after = await evaluate('window.slowSubtitle');
                assert.equal(after.error, '', 'playback error: ' + after.error);
                assert.ok(after.position > before, 'playback continues after the subtitle arrives');
                result = {startAfterMs: waited, subtitleAnsweredAfterMs: subtitle.answeredAt - subtitle.requestedAt,
                    positionMs: after.position};
            } catch (error) {
                console.error(log().split('\n').slice(-40).join('\n'));
                throw error;
            }
        }, {settings: {mpv: {enableDanmaku: false}}, startupTimeout: 30000, args: ['--log-level', 'info']});
    } finally {
        slow.closeAllConnections();
        await new Promise(resolve => slow.close(resolve));
    }
    console.log(JSON.stringify({slowSubtitleStart: result,
        scope: 'real Windows client, libmpv and local Y4M; isolated profile; local server that answers the subtitle after 14 s'}));
})().catch(error => {console.error(error); process.exitCode = 1;});
