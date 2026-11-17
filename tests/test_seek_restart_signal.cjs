// The desktop client must tell the page when a seek has its frame, not only
// its position. mpv reports the target of a seek at once and then decodes
// towards it from the keyframe before; the watch-together sync released held
// players against the position and they started late (Mac log of 2026-11-15:
// up to 3.3 s late with RIFE on, repeated up to eight times in a row).
//
// It must also seek to a keyframe and say where that was (seekToKeyframe and
// keyframeSeekLanded): with frame interpolation a keyframe has its frame in a
// quarter of a second where a seek to the millisecond decodes for seconds, so
// the sync sends a member that is behind to the next keyframe and takes the
// room to one when a viewer seeks.
//
// Without TIGEREST_TEST_CLIP a generated Y4M checks the order of the signals.
// With it (a local file with long GOPs), the gap between "position reported"
// and "frame there" is measured too; TIGEREST_TEST_RIFE=1 turns RIFE on and
// TIGEREST_TEST_LOG names a file that receives the client log.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {setTimeout: delay} = require('node:timers/promises');
const withBrowser = require('./community_browser.cjs');

const clip = process.env.TIGEREST_TEST_CLIP ? path.resolve(process.env.TIGEREST_TEST_CLIP) : '';
if (clip) assert.ok(fs.existsSync(clip), 'TIGEREST_TEST_CLIP does not exist: ' + clip);
const rife = process.env.TIGEREST_TEST_RIFE === '1';
const frame = Buffer.alloc(64 * 36 * 3 / 2, 128);
frame.fill(32, 0, 64 * 36);
const video = Buffer.concat([Buffer.from('YUV4MPEG2 W64 H36 F24:1 Ip A1:1 C420jpeg\n'),
    ...Array.from({length: 24 * 40}, () => Buffer.concat([Buffer.from('FRAME\n'), frame]))]);
const routes = {
    '/': {type: 'text/html', body: '<!doctype html><title>Isolated seek restart check</title>'},
    '/clip.y4m': {type: 'video/x-yuv4mpeg', body: video}
};
// Seek targets in milliseconds. The Y4M is 40 s long and every frame of it is
// a keyframe; a real clip gets targets at different distances into its GOPs.
const targets = clip ? [21700, 47300, 33900, 58200] : [12000, 30000, 5000];

(async () => {
    let result;
    await withBrowser(routes, async ({evaluate, profile}) => {
        const log = () => withBrowser.clientLog(profile);
        const events = () => evaluate('window.seekRestart.events');
        const until = async (check, label, limit = 300) => {
            for (let i = 0; i < limit; i++) {
                const value = await check();
                if (value) return value;
                await delay(100);
            }
            throw Error('Timed out: ' + label);
        };
        try {
            await evaluate(`(${(async url => {
                await window.initCompleted;
                const state = window.seekRestart = {events: [], error: ''};
                const add = (name, value) => state.events.push([name, value, Math.round(performance.now())]);
                if (!api.player.seekingChanged) throw Error('api.player.seekingChanged is missing');
                api.player.seekingChanged.connect(seeking => add('seeking', seeking === true));
                if (!api.player.keyframeSeekLanded || !api.player.seekToKeyframe) throw Error('api.player.seekToKeyframe is missing');
                api.player.keyframeSeekLanded.connect(ms => add('landed', Number(ms)));
                api.player.positionUpdate.connect(ms => add('position', Number(ms)));
                api.player.playing.connect(() => add('playing', 0));
                api.player.paused.connect(() => add('paused', 0));
                api.player.error.connect(message => state.error = String(message));
                await api.window.beginPlaybackSession();
                if (!await api.player.load(url, {autoplay: true, startMilliseconds: 0}, {type: 'video', frameRate: 24}, 1, -1))
                    throw Error('native load rejected');
                return true;
            }).toString()})(${JSON.stringify(clip ? pathToFileURL(clip).href : '/clip.y4m')}.replace(/^\\//, location.origin + '/'))`);
            await until(async () => (await events()).some(([name, value]) => name === 'position' && value > 1500), 'playback', 600);
            assert.equal(await evaluate('window.seekRestart.error'), '', 'playback error');
            // Interpolation prepares its graph with seeks of its own at the start.
            await delay(rife ? 6000 : 500);

            const seeks = [];
            for (const target of targets) {
                await evaluate('api.player.pause()');
                await until(async () => (await events()).findLast(([name]) => name === 'paused' || name === 'playing')?.[0] === 'paused', 'the pause');
                await delay(300);
                const mark = (await events()).length;
                const sentAt = await evaluate(`(() => { api.player.seekTo(${target}); return Math.round(performance.now()); })()`);
                const after = await until(async () => {
                    const list = (await events()).slice(mark);
                    const began = list.findIndex(([name, value]) => name === 'seeking' && value === true);
                    return began >= 0 && list.slice(began).some(([name, value]) => name === 'seeking' && value === false) && list;
                }, 'the frame of the seek to ' + target);
                const began = after.findIndex(([name, value]) => name === 'seeking' && value === true);
                const done = after.findIndex(([name, value], index) => index > began && name === 'seeking' && value === false);
                const reported = after.findIndex(([name, value]) => name === 'position' && Math.abs(value - target) < 250);
                assert.ok(began >= 0 && done > began, 'seeking is reported from the seek to its frame: ' + JSON.stringify(after));
                // The engine reads the position as "seek done": it must never see the
                // target before it has been told that a seek is under way.
                assert.ok(reported === -1 || reported > began, 'the target position is reported before the seek: ' + JSON.stringify(after));
                assert.ok(!after.slice(done + 1).some(([name]) => name === 'seeking'), 'one restart per seek: ' + JSON.stringify(after));

                // With the frame there, playing starts at once from the target.
                const playMark = (await events()).length;
                const playAt = await evaluate('(() => { api.player.play(); return Math.round(performance.now()); })()');
                const moving = await until(async () => (await events()).slice(playMark).find(([name, value]) => name === 'position' && value > target + 80),
                    'playback after the seek to ' + target, 100);
                assert.ok(moving[1] < target + 2000, 'playback continues from the target: ' + JSON.stringify(moving));
                seeks.push({target, positionReportedAfterMs: reported >= 0 ? after[reported][2] - sentAt : null,
                    frameReadyAfterMs: after[done][2] - sentAt, movingAfterPlayMs: moving[2] - playAt});
            }
            // Released on the frame, a start never waits for decoding.
            const slowest = Math.max(...seeks.map(seek => seek.movingAfterPlayMs));
            assert.ok(slowest < 700, 'a player released after its frame starts at once: ' + JSON.stringify(seeks));
            assert.ok(!(await events()).some(([name]) => name === 'landed'), 'a seek to the millisecond reports no keyframe');

            // Keyframe seeks: the first one at or after the target, the one
            // before it, and one sent while a seek to the millisecond is
            // still on its way (the restart of that seek must not be taken
            // for the keyframe's). Every frame of the Y4M is a keyframe.
            const span = clip ? 30000 : 50, keyframes = [];
            for (const [target, after, first] of [[20010, true, null], [20010, false, null], [31010, false, 9000]]) {
                await evaluate('api.player.pause()');
                await until(async () => (await events()).findLast(([name]) => name === 'paused' || name === 'playing')?.[0] === 'paused', 'the pause');
                await delay(300);
                const mark = (await events()).length;
                const sentAt = await evaluate(`(() => { ${first === null ? '' : `api.player.seekTo(${first});`} api.player.seekToKeyframe(${target}, ${after}); return Math.round(performance.now()); })()`);
                const list = await until(async () => {
                    const seen = (await events()).slice(mark);
                    const landed = seen.findIndex(([name]) => name === 'landed');
                    return landed >= 0 && seen.slice(landed).some(([name, value]) => name === 'seeking' && value === false) && seen;
                }, 'the keyframe seek to ' + target);
                await delay(300);
                const landed = list.findIndex(([name]) => name === 'landed');
                const done = list.findIndex(([name, value], index) => index > landed && name === 'seeking' && value === false);
                assert.equal((await events()).slice(mark).filter(([name]) => name === 'landed').length, 1, 'one landing per keyframe seek: ' + JSON.stringify(list));
                assert.ok(done > landed, 'the landing is reported before the restart: ' + JSON.stringify(list));
                const position = list[landed][1];
                assert.ok(after ? position >= target && position < target + span : position <= target && position > target - span,
                    'landed on the ' + (after ? 'first keyframe from ' : 'keyframe before ') + target + ': ' + position);
                assert.equal(await evaluate('Promise.resolve(api.player.getPosition())'), position, 'and that is where the player is');
                keyframes.push({target, after, duringSeekTo: first, landedMs: position, frameReadyAfterMs: list[done][2] - sentAt});
                await evaluate('api.player.play()');
                await until(async () => (await events()).findLast(([name]) => name === 'paused' || name === 'playing')?.[0] === 'playing', 'playback after the keyframe seek');
            }
            const errors = log().split('\n').filter(line => /Lua error|stack traceback/i.test(line));
            assert.deepEqual(errors, [], 'scripts reported errors');
            result = {seeks, keyframes, rife, clip: clip ? path.basename(clip) : 'generated Y4M'};
            await evaluate('api.player.stop()');
        } catch (error) {
            console.error(log().split('\n').slice(-40).join('\n'));
            throw error;
        } finally {
            // The profile is removed afterwards; keep the client log on request.
            if (process.env.TIGEREST_TEST_LOG) fs.writeFileSync(process.env.TIGEREST_TEST_LOG, log());
        }
    }, {gpu: true, visible: true, startupTimeout: 30000, args: ['--log-level', process.env.TIGEREST_TEST_LOG_LEVEL || 'info'],
        settings: {mpv: {enableDanmaku: false}, video: {'refreshrate.auto_switch': false, 'hdr.auto_switch': false, aiRife: rife}},
        prepareProfile: async () => { process.env.TIGEREST_MPV_TEST_OPTIONS = 'mute=yes'; }});
    console.log(JSON.stringify({seekRestart: result,
        scope: 'real client, libmpv and a local clip; isolated profile; no Emby server and no watch-together room'}));
})().catch(error => { console.error(error); process.exitCode = 1; });
