// First-run usage tour: the page dims, the part being explained stays lit and
// a bubble beside it explains it. Windows, macOS, Android and iPhone/iPad share
// this script; Apple TV has its own SwiftUI tour.
//
// The progress is the hidden setting main.onboardingTour, written by the native
// settings when they first load (docs/superpowers/specs/2026-11-20-first-run-tour-design.md):
//   new      a new profile: starts on the home page and cannot be skipped
//   upgrade  settings an earlier version left behind: starts, can be skipped
//   replay   「重新打开引导」 in the client settings: starts, can be skipped
//   ''       not decided by this platform yet: treated as upgrade
//   done / skipped  finished or closed; never starts by itself again
//   off      test profiles: never starts by itself
// A tour that is interrupted (playback starts, the page goes away, the client
// quits) keeps its state and starts again on the next visit to the home page.
//
// The player steps of the desktop clients show a picture of the real player
// (native/tour-art, made from the client's own home art) with numbered marks
// that their text refers to; without room or the picture, the plain text.
(function () {
    'use strict';
    if (window.TigerestTour) return;

    const KEY = 'onboardingTour';
    const PENDING = ['new', 'upgrade', 'replay', ''];
    const debug = {environment: null, stepWaitMs: 3000, pageWaitMs: 8000, readyMs: 1000, pollMs: 600};
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    let state, session = null;

    // Pictures of the player: the file, and where its numbered marks sit, in
    // percent of the picture. All are 1280×684, the page of the default window
    // (dev/windows/tour-art makes them).
    const ART = {
        player: {file: 'player.webp', marks: [[14.7, 84.5], [52.7, 83.4], [92, 84.5]]},
        pro: {file: 'pro-mode.webp', marks: [[2.7, 11.5], [96.9, 15.2], [16.6, 71.4]]},
        interpolation: {file: 'interpolation.webp', marks: [[28.5, 51.8], [28.5, 67.5]]}
    };
    const ART_RATIO = 1280 / 684;
    const artBase = () => window.jmpInfo?.tourArtPath || (window.jmpInfo?.scriptPath || '') + '/tour-art';

    // ---- Page state -------------------------------------------------------

    function shown(node) {
        if (!node?.isConnected || node.closest?.('[hidden],.hide')) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none';
    }
    const find = selector => Array.from(document.querySelectorAll(selector)).find(node => shown(node) && !session?.root.contains(node)) || null;
    const motionBusy = () => !!window.TigerestHomeMotion?.busy;
    function homeReady() {
        if (!document.body?.classList.contains('tg-home-active')) return false;
        const home = find('.tg-home');
        if (!home?.classList.contains('tg-entered') || !home.querySelector('.tg-library')) return false;
        if (home.classList.contains('tg-ready')) return true;
        // A library without works still shows its home page.
        const status = home.querySelector('.tg-home-status');
        return !!status && !status.hidden && /还没有/.test(status.textContent);
    }
    const detailRoot = () => find('.itemDetailPage,.view-item-item,#itemDetailPage');
    const playbackVisible = () => !!find('.view-videoosd-videoosd,.videoOsdPage,#videoOsdPage');
    // Dialogs, menus and startup notices on screen come first. A window that is
    // covered or minimized does not wait: the first card waits for the user.
    function blocked() {
        if (motionBusy()) return true;
        const modal = '#tigerest-client-menu,#tigerest-settings-overlay,dialog[open],.dialogContainer .dialog,[aria-modal="true"],[role="dialog"],[role="alertdialog"]';
        return Array.from(document.querySelectorAll(modal)).some(node => {
            if (!shown(node) || session?.root.contains(node)) return false;
            const rect = node.getBoundingClientRect();
            return rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
        });
    }
    // The header's 一起看 sits in the 「⋯」 menu on narrow Android screens.
    function watchEntryInOverflow() {
        const more = document.getElementById('tigerest-header-more');
        return !!more && shown(more) && !shown(document.getElementById('tigerest-watch-entry'));
    }
    function safeInsets() {
        const style = getComputedStyle(document.documentElement);
        const read = name => parseFloat(style.getPropertyValue('--tgs-safe-' + name)) || 0;
        return {top: read('top'), right: read('right'), bottom: read('bottom'), left: read('left')};
    }
    async function goHome() {
        try {
            if (window.Emby?.importModule) {
                const module = await window.Emby.importModule('./modules/approuter.js');
                const router = module.default || module;
                if (typeof router.goHome === 'function') return await router.goHome();
            }
        } catch (error) { /* try the next way */ }
        try { if (typeof window.Emby?.Page?.goHome === 'function') return await window.Emby.Page.goHome(); } catch (error) { /* try the next way */ }
        if (/^#!?\//.test(location.hash)) location.hash = location.hash.startsWith('#!') ? '#!/home' : '#/home';
    }

    // ---- Saved progress ---------------------------------------------------

    // The injected settings are a snapshot from when the client started, so
    // ask the native settings for the current value.
    async function refreshState() {
        const main = window.jmpInfo?.settings?.main;
        let value = main && KEY in main ? main[KEY] : undefined;
        try {
            if (typeof window.api?.settings?.value === 'function') {
                const live = await Promise.race([window.api.settings.value('main', KEY), sleep(2000).then(() => undefined)]);
                if (typeof live === 'string') value = live;
            }
        } catch (error) { /* keep the snapshot */ }
        state = typeof value === 'string' ? value : undefined;
        return state;
    }
    function writeState(value) {
        state = value;
        try {
            const main = window.jmpInfo?.settings?.main;
            if (main && Object.getOwnPropertyDescriptor(main, KEY)?.set) main[KEY] = value;
            else Promise.resolve(window.api?.settings?.setValue?.('main', KEY, value)).catch(() => {});
        } catch (error) { console.warn('Tigerest Theater: unable to save the usage tour progress', error); }
    }
    // A platform that has not added the setting yet (undefined) never starts by itself.
    const pending = value => typeof value === 'string' && PENDING.includes(value);
    const modeFor = value => value === 'new' ? 'new' : value === 'replay' ? 'replay' : 'upgrade';

    // ---- What this client and machine have ---------------------------------

    function webglRenderer() {
        try {
            const gl = document.createElement('canvas').getContext('webgl');
            if (!gl) return '';
            const info = gl.getExtension('WEBGL_debug_renderer_info');
            const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
            gl.getExtension('WEBGL_lose_context')?.loseContext();
            return renderer;
        } catch (error) { return ''; }
    }
    async function environment() {
        const api = window.api, system = api?.system || {};
        const android = !!(window.tigerestAndroidApi || system.isAndroid);
        const ios = !android && !!(window.tigerestIPadApi || system.isIPad);
        const platform = android ? 'android' : ios ? 'ios' : system.isMacos === true ? 'mac' : system.isWindows ? 'windows' : 'linux';
        const env = {platform, touch: android || ios, windowControls: !android && !ios && window.jmpInfo?.capabilities?.desktopWindowControls !== false,
            interpolation: false, rtx: false, vfg: false};
        if (debug.environment) return Object.assign(env, debug.environment);
        if (platform === 'ios') env.interpolation = !!window.jmpInfo?.capabilities?.rife;
        if (platform !== 'windows' && platform !== 'mac') return env;
        let diagnostics = null;
        try { diagnostics = await Promise.race([api.player.mpvDiagnostics(), sleep(1500).then(() => null)]); } catch (error) { /* unknown */ }
        if (platform === 'mac') { env.interpolation = !!(diagnostics?.rife || diagnostics?.native); return env; }
        // Windows interpolation (RIFE's TensorRT engine, RTX video, VFG) needs an
        // NVIDIA card. The RIFE probe knows its CUDA compute capability once the
        // extension ran; the page's own GPU name covers the time before that.
        const renderer = webglRenderer(), named = /NVIDIA/i.test(renderer);
        const capability = parseFloat(diagnostics?.vfg?.computeCapability) || 0;
        env.interpolation = named || capability > 0;
        env.rtx = /\bRTX\b/i.test(renderer) || (!named && capability >= 7.5);
        env.vfg = diagnostics?.vfg?.configured !== false && (capability >= 8.9 || /\bRTX\s*(?:PRO\s*)?[45]0\d\d/i.test(renderer));
        return env;
    }

    // ---- Steps ------------------------------------------------------------

    function buildSteps(env, mode) {
        const touch = env.touch, command = env.platform === 'mac' ? '⌘' : 'Ctrl+';
        const leave = touch ? '随时可以点 × 退出' : '随时可以按 Esc 或点 × 退出';
        const header = ['bottom', 'left', 'right', 'top'];
        let interpolation = null;
        if (env.platform === 'windows' && env.interpolation) {
            const more = (env.rtx ? '同一页还能打开 RTX 视频超分辨率和 RTX Video HDR。' : '') + (env.vfg ? '你的显卡还支持 NVIDIA 帧生成（VFG）。' : '');
            interpolation = {id: 'interpolation', title: env.rtx ? '补帧与画质增强' : '补帧', art: 'interpolation',
                body: '在「设置 → 视频」里打开「AI 补帧（RIFE）」，可以把 24 帧的动画补到 60 帧以上。第一次使用要先下载补帧扩展。' + more,
                artBody: '在「设置 → 视频」里 ① 选一个补帧方案，第一次使用先 ② 下载补帧扩展，再打开「AI 补帧（RIFE）」，24 帧的动画就能补到 60 帧以上。' + more};
        } else if (env.platform === 'mac' && env.interpolation) {
            interpolation = {id: 'interpolation', title: '补帧', body: '在「设置 → 视频」里打开「AI 补帧（RIFE）」或「系统原生补帧」，把 24 帧的动画补到更高帧率。'};
        } else if (env.platform === 'ios' && env.interpolation) {
            interpolation = {id: 'interpolation', title: '补帧', body: '在「设置 → 视频」里打开补帧，可以把 24 帧的动画补到更高帧率。'};
        }
        const gestures = '第一次播放时会先教你手势：双击暂停，横着滑快进快退，左右两侧上下滑调亮度和音量，长按画面临时两倍速。';
        return [
            {id: 'welcome', title: '欢迎使用大河影院', welcome: true,
                body: '用一分钟认识首页、作品页和播放器。' + (mode === 'new' ? '' : leave + '，以后在「客户端 → 客户端设置」里重新打开。')},
            {id: 'libraries', context: 'home', target: '.tg-home-nav', placement: ['right', 'bottom', 'left', 'top'], title: '媒体库',
                body: touch ? '你的媒体库和收藏都在这里。点一下预览它的作品，再点一下进入整个媒体库。'
                    : '你的媒体库和收藏都在这里。鼠标停在上面（或用方向键选中），右边就换成它的作品；点一下进入整个媒体库。'},
            {id: 'hero', context: 'home', target: '.tg-home-stage', placement: ['bottom', 'left', 'top', 'right'], title: '推荐海报',
                body: '轮播当前媒体库的作品，默认继续观看的排在前面。点海报或「查看作品」打开作品页。'},
            {id: 'rail', context: 'home', target: '.tg-home-rail', placement: ['top', 'left', 'right', 'bottom'], title: '作品列表',
                body: '红点表示还有没看的集，金色细条是上次看到的位置；「查看更多」打开整个媒体库。排序和显示哪些媒体库，在「设置 → 首页设置」里改。'},
            env.windowControls && {id: 'window', context: 'home', target: '.tg-home-window-mode', placement: ['right', 'bottom', 'left', 'top'], title: '窗口与全屏',
                body: '在窗口和全屏之间切换。想每次打开就全屏，在「设置 → 首页设置」里打开「启动时自动全屏」。'},
            {id: 'detail', context: 'detail', target: '.mainDetailButtons', placement: ['bottom', 'top', 'right', 'left'], title: '作品页',
                body: '「播放」从上次看到的地方接着放。剧集的季和集排在下面，也可以直接点某一集。'},
            {id: 'watch', context: 'detail', target: '.tw-detail-entry', placement: ['bottom', 'top', 'right', 'left'], title: '一起看',
                body: () => '和朋友同时看同一集：建个房间，把房间码发给朋友。暂停、拖进度、换下一集，房间里的人都一起跟着走。朋友发来的房间码，'
                    + (watchEntryInOverflow() ? '在顶栏「⋯」里的「一起看」输入。' : '在顶栏的「一起看」里输入。')},
            {id: 'comments', context: 'detail', target: '#tigerest-community', placement: ['top', 'left', 'right', 'bottom'], title: '评论区',
                body: '作品和每一集都有公共评论。大河服务器的账号可以直接发言；自建服务器的用户注册一个评论账号就能看、能发。'},
            {id: 'client', context: 'detail', target: '#tigerest-mpv-settings-button', toTop: true, placement: header, title: '客户端菜单',
                body: env.platform === 'android' ? '切换或管理服务器、播放器设置、客户端设置都在这里。'
                    : env.platform === 'ios' ? '切换或管理服务器、播放器设置、客户端设置、下载与离线媒体都在这里。'
                    : `切换或管理服务器、播放器设置（${command},）、客户端设置、下载与离线媒体、打开本地视频（${command}O）都在这里。`},
            {id: 'messages', context: 'detail', target: '#tigerest-message-entry', toTop: true, placement: header, title: '消息',
                body: '评论收到的回复、你上报问题的处理结果都会出现在这里；有新消息时，按钮上会显示数量。'},
            {id: 'player', title: '播放器', art: touch ? null : 'player',
                body: env.platform === 'android' ? gestures + '其他设置在控制栏的「更多」里。'
                    : env.platform === 'ios' ? gestures
                    : '播放时把鼠标移到画面下方，会出现控制栏：字幕、音轨、画质、弹幕、倍速和选集都在上面。右键打开完整菜单；空格暂停，↑ ↓ 调音量。',
                artBody: '播放时把鼠标移到画面下方，会出现控制栏：① 字幕、画质、专业模式和弹幕，② 倍速，③ 上一集、选集和下一集。右键打开完整菜单；空格暂停，↑ ↓ 调音量。'},
            (env.platform === 'windows' || env.platform === 'mac') && {id: 'pro', title: '专业模式', art: 'pro',
                body: '播放时按 F2，或点控制栏上的面板图标：画面缩到左上，右边实时调画质、补帧、色彩、字幕和弹幕，下面显示帧率和负载统计。再按一次 F2 返回。',
                artBody: '播放时按 F2，或点控制栏上的面板图标：① 画面缩到左上，② 右边实时调画质、补帧、色彩、字幕和弹幕，③ 下面显示帧率和负载统计。再按一次 F2 返回。'},
            interpolation,
            {id: 'end', target: '#tigerest-mpv-settings-button', optionalTarget: true, placement: header, title: '引导结束',
                body: '想再看一遍：点「客户端 → 客户端设置」里的「重新打开引导」。祝观影愉快！'}
        ].filter(Boolean);
    }

    // ---- Overlay ----------------------------------------------------------

    const css = `
#tigerest-tour{position:fixed;inset:0;z-index:2147483600;pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;
 --tgt-bg:rgba(24,23,21,.98);--tgt-border:rgba(239,195,110,.32);--tgt-text:#f1ece3;--tgt-body:#d6cfc2;--tgt-muted:#a39b8d;--tgt-accent:#efc36e;--tgt-accent-hover:#f2d79e;
 --tgt-accent-text:#1d1912;--tgt-secondary:rgba(255,255,255,.08);--tgt-secondary-hover:rgba(255,255,255,.15);--tgt-dim:rgba(6,7,10,.66);--tgt-ring:#efc36e;
 font:14px/1.6 system-ui,"Microsoft YaHei","PingFang SC",sans-serif;color:var(--tgt-text);text-align:left}
#tigerest-tour.tgt-light{--tgt-bg:#fffdf8;--tgt-border:rgba(200,150,46,.4);--tgt-text:#2e2a24;--tgt-body:#4a443b;--tgt-muted:#7a7164;--tgt-accent:#c8962e;--tgt-accent-hover:#b6851f;
 --tgt-accent-text:#1d1912;--tgt-secondary:rgba(46,42,36,.07);--tgt-secondary-hover:rgba(46,42,36,.14);--tgt-dim:rgba(20,18,15,.55);--tgt-ring:#c8962e}
#tigerest-tour .tgt-spot{position:fixed;left:50%;top:50%;width:0;height:0;border-radius:14px;box-shadow:0 0 0 200vmax var(--tgt-dim);outline:2px solid var(--tgt-ring);outline-offset:0;pointer-events:none;
 transition:left .34s cubic-bezier(.3,.7,.2,1),top .34s cubic-bezier(.3,.7,.2,1),width .34s cubic-bezier(.3,.7,.2,1),height .34s cubic-bezier(.3,.7,.2,1),border-radius .34s,outline-color .2s}
#tigerest-tour.tgt-centered .tgt-spot{outline-color:transparent}
#tigerest-tour .tgt-bubble{position:fixed;left:0;top:0;box-sizing:border-box;width:372px;max-width:calc(100vw - 24px);padding:18px 20px 16px;border:1px solid var(--tgt-border);border-radius:14px;
 background:var(--tgt-bg);color:var(--tgt-text);box-shadow:0 18px 50px rgba(0,0,0,.45);outline:none;opacity:0;transition:transform .34s cubic-bezier(.3,.7,.2,1),opacity .2s}
#tigerest-tour.tgt-shown .tgt-bubble{opacity:1}
#tigerest-tour .tgt-arrow{position:absolute;width:12px;height:12px;box-sizing:border-box;background:var(--tgt-bg);border:1px solid transparent;transform:rotate(45deg)}
#tigerest-tour .tgt-arrow[data-side="right"]{left:-7px;border-left-color:var(--tgt-border);border-bottom-color:var(--tgt-border)}
#tigerest-tour .tgt-arrow[data-side="left"]{right:-7px;border-top-color:var(--tgt-border);border-right-color:var(--tgt-border)}
#tigerest-tour .tgt-arrow[data-side="bottom"]{top:-7px;border-top-color:var(--tgt-border);border-left-color:var(--tgt-border)}
#tigerest-tour .tgt-arrow[data-side="top"]{bottom:-7px;border-right-color:var(--tgt-border);border-bottom-color:var(--tgt-border)}
#tigerest-tour .tgt-close{position:absolute;top:8px;right:8px;display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:none;color:var(--tgt-muted);
 font:20px/1 system-ui,sans-serif;cursor:pointer}
#tigerest-tour .tgt-close:hover{background:var(--tgt-secondary);color:var(--tgt-text)}
#tigerest-tour .tgt-title{margin:0 30px 6px 0;font-size:17px;font-weight:700;line-height:1.4;color:var(--tgt-text)}
#tigerest-tour .tgt-body{margin:0;color:var(--tgt-body);font-size:14px;line-height:1.65;overflow-wrap:anywhere}
#tigerest-tour .tgt-art{position:relative;margin:4px 0 12px;aspect-ratio:1280/684;border:1px solid var(--tgt-border);border-radius:10px;overflow:hidden;background:#0c0c0d}
#tigerest-tour .tgt-art img{display:block;width:100%;height:100%;object-fit:cover;-webkit-user-drag:none}
#tigerest-tour .tgt-mark{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:var(--tgt-accent);color:var(--tgt-accent-text);
 font:700 12px/22px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.45);pointer-events:none}
#tigerest-tour .tgt-wait{display:none;align-items:center;gap:10px;color:var(--tgt-body)}
#tigerest-tour .tgt-spinner{width:16px;height:16px;flex:0 0 auto;border:2px solid var(--tgt-secondary-hover);border-top-color:var(--tgt-accent);border-radius:50%;animation:tgt-spin .8s linear infinite}
@keyframes tgt-spin{to{transform:rotate(360deg)}}
#tigerest-tour.tgt-waiting .tgt-wait{display:flex}
#tigerest-tour.tgt-waiting .tgt-title,#tigerest-tour.tgt-waiting .tgt-art,#tigerest-tour.tgt-waiting .tgt-body,#tigerest-tour.tgt-waiting .tgt-footer{display:none}
#tigerest-tour .tgt-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}
#tigerest-tour .tgt-count{color:var(--tgt-muted);font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}
#tigerest-tour .tgt-buttons{display:flex;gap:8px;margin-left:auto}
#tigerest-tour .tgt-button{min-height:34px;padding:6px 16px;border:0;border-radius:9px;font:inherit;font-weight:600;line-height:1.4;cursor:pointer;white-space:nowrap}
#tigerest-tour .tgt-primary{background:var(--tgt-accent);color:var(--tgt-accent-text)}
#tigerest-tour .tgt-primary:hover{background:var(--tgt-accent-hover)}
#tigerest-tour .tgt-secondary{background:var(--tgt-secondary);color:var(--tgt-text)}
#tigerest-tour .tgt-secondary:hover{background:var(--tgt-secondary-hover)}
#tigerest-tour .tgt-button:focus-visible,#tigerest-tour .tgt-close:focus-visible{outline:2px solid var(--tgt-accent);outline-offset:2px}
#tigerest-tour [hidden]{display:none!important}
@media (pointer:coarse){#tigerest-tour .tgt-button{min-height:42px;padding:8px 18px}#tigerest-tour .tgt-close{width:40px;height:40px;top:4px;right:4px}}
@media (prefers-reduced-motion:reduce){#tigerest-tour .tgt-spot,#tigerest-tour .tgt-bubble{transition:none!important}#tigerest-tour .tgt-spinner{animation-duration:2.4s}}`;

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }
    function lightPage() {
        // Android and iPhone/iPad keep their pages dark (webAppearance.js).
        if (window.tigerestAndroidApi || window.tigerestIPadApi) return false;
        const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(getComputedStyle(document.body).color || '');
        if (!match) return false;
        const [r, g, b] = match.slice(1, 4).map(value => Number(value) / 255);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
    }
    function mount(s) {
        if (!document.getElementById('tigerest-tour-style')) {
            const style = element('style'); style.id = 'tigerest-tour-style'; style.textContent = css; document.head.append(style);
        }
        const root = element('div', lightPage() ? 'tgt-light tgt-centered' : 'tgt-centered'); root.id = 'tigerest-tour';
        const spot = element('div', 'tgt-spot');
        const bubble = element('section', 'tgt-bubble'); bubble.setAttribute('role', 'dialog'); bubble.setAttribute('aria-modal', 'true');
        bubble.setAttribute('aria-labelledby', 'tigerest-tour-title'); bubble.setAttribute('aria-describedby', 'tigerest-tour-body');
        const arrow = element('span', 'tgt-arrow'); arrow.hidden = true;
        const close = element('button', 'tgt-close', '×'); close.type = 'button'; close.setAttribute('aria-label', '退出引导'); close.hidden = !s.skippable;
        const title = element('h2', 'tgt-title'); title.id = 'tigerest-tour-title';
        const art = element('figure', 'tgt-art'); art.hidden = true;
        const picture = element('img'); picture.alt = ''; picture.draggable = false; picture.decoding = 'async';
        art.append(picture);
        // A picture that cannot load leaves its step with the plain text.
        picture.addEventListener('error', () => {
            if (!picture.dataset.art) return;
            s.artFailed.add(picture.dataset.art); picture.removeAttribute('src'); delete picture.dataset.art;
            if (session === s) layout(s);
        });
        const body = element('p', 'tgt-body'); body.id = 'tigerest-tour-body'; body.setAttribute('aria-live', 'polite');
        const wait = element('div', 'tgt-wait'); const waitText = element('span', '');
        wait.append(element('span', 'tgt-spinner'), waitText);
        const footer = element('div', 'tgt-footer'), count = element('span', 'tgt-count'), buttons = element('div', 'tgt-buttons');
        const previous = element('button', 'tgt-button tgt-secondary'); previous.type = 'button';
        const next = element('button', 'tgt-button tgt-primary'); next.type = 'button';
        buttons.append(previous, next); footer.append(count, buttons);
        bubble.append(arrow, close, title, art, body, wait, footer); root.append(spot, bubble);
        close.addEventListener('click', () => quit());
        previous.addEventListener('click', () => previous.dataset.action === 'skip' ? quit() : back(-1));
        next.addEventListener('click', () => forward());
        // Nothing under the overlay is clickable while the tour is open.
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchend'])
            root.addEventListener(type, event => {
                if (bubble.contains(event.target) && type !== 'contextmenu') { event.stopPropagation(); return; }
                if (event.cancelable) event.preventDefault();
                event.stopPropagation();
            }, {passive: false});
        for (const type of ['wheel', 'touchmove']) root.addEventListener(type, event => { if (event.cancelable) event.preventDefault(); event.stopPropagation(); }, {passive: false});
        // Swiping across the bubble moves between steps on touch screens.
        let swipe = null;
        bubble.addEventListener('pointerdown', event => { swipe = event.pointerType === 'mouse' ? null : {x: event.clientX, y: event.clientY}; });
        bubble.addEventListener('pointerup', event => {
            if (!swipe) return;
            const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y; swipe = null;
            if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) dx < 0 ? forward() : back(-1);
        });
        bubble.addEventListener('pointercancel', () => { swipe = null; });
        document.body.append(root);
        Object.assign(s, {root, spotNode: spot, bubble, arrow, close, title, art, picture, body, wait, waitText, count, previous, next});
    }

    // ---- Layout -----------------------------------------------------------

    // Emby's fixed header covers the top of a scrolled page.
    function headerBottom() {
        const header = find('.skinHeader');
        return header && getComputedStyle(header).position === 'fixed' ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
    }
    function spotRect(node) {
        const rect = node.getBoundingClientRect(), pad = 8, edge = 4;
        const left = Math.max(edge, rect.left - pad), right = Math.min(innerWidth - edge, rect.right + pad);
        let top = Math.max(edge, rect.top - pad), bottom = Math.min(innerHeight - edge, rect.bottom + pad);
        // A block taller than the window (the comments): light its top part below
        // the header and leave the rest of the window to the bubble.
        if (rect.height > innerHeight / 2) {
            const header = headerBottom();
            if (rect.height + 2 * pad > innerHeight - header - 2 * edge) {
                top = Math.max(top, header + edge);
                bottom = Math.min(bottom, top + Math.max(120, Math.round(innerHeight * 0.45)));
            }
        }
        if (right - left < 12 || bottom - top < 12) return null;
        const radius = clamp((parseFloat(getComputedStyle(node).borderTopLeftRadius) || 6) + pad / 2, 8, 20);
        return {left, top, right, bottom, width: right - left, height: bottom - top, radius};
    }
    const sameRect = (a, b) => a === b || (!!a && !!b && ['left', 'top', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) < 0.5));
    function place(spot, size, order) {
        const W = innerWidth, H = innerHeight, gap = 16, margin = 16;
        const cy = (spot.top + spot.bottom) / 2, cx = (spot.left + spot.right) / 2;
        const fit = {
            right: () => spot.right + gap + size.w <= W - margin && {x: spot.right + gap, y: clamp(cy - size.h / 2, margin, H - size.h - margin)},
            left: () => spot.left - gap - size.w >= margin && {x: spot.left - gap - size.w, y: clamp(cy - size.h / 2, margin, H - size.h - margin)},
            bottom: () => spot.bottom + gap + size.h <= H - margin && {x: clamp(cx - size.w / 2, margin, W - size.w - margin), y: spot.bottom + gap},
            top: () => spot.top - gap - size.h >= margin && {x: clamp(cx - size.w / 2, margin, W - size.w - margin), y: spot.top - gap - size.h}
        };
        order = order || ['right', 'left', 'bottom', 'top'];
        for (const side of order) {
            const position = fit[side]();
            if (position) return {...position, side};
        }
        // No room beside it: on the roomiest side, as far out as the window allows.
        const room = {right: W - spot.right, left: spot.left, bottom: H - spot.bottom, top: spot.top};
        const side = order.reduce((best, item) => room[item] > room[best] ? item : best, order[0]);
        const x = side === 'right' ? W - size.w - margin : side === 'left' ? margin : clamp(cx - size.w / 2, margin, W - size.w - margin);
        const y = side === 'bottom' ? H - size.h - margin : side === 'top' ? margin : clamp(cy - size.h / 2, margin, H - size.h - margin);
        return {x, y, side: null};
    }
    // A big lit block that leaves the bubble no room on any side (the comments
    // on a short window): light its top part and put the bubble under it.
    function fitSpot(spot, size, narrow, safe, order) {
        if (!spot) return spot;
        const H = innerHeight;
        const fits = narrow ? Math.max(H - spot.bottom - safe.bottom, spot.top - safe.top) >= size.h + 24 : !!place(spot, size, order).side;
        if (fits) return spot;
        const bottom = Math.max(spot.top + 120, H - size.h - (narrow ? 24 + safe.bottom : 48));
        return bottom < spot.bottom ? {...spot, bottom, height: bottom - spot.top, below: true} : spot;
    }
    // The step's picture, as large as the window has room for (`room` across);
    // its text refers to the marks, so without the picture the plain text.
    // Returns the bubble's width for the picture, 0 without one.
    function showArt(s, step, room) {
        const art = step?.art && !s.artFailed.has(step.art) ? ART[step.art] : null;
        const width = art ? Math.floor(Math.min(640, room - 42, (innerHeight - 282) * ART_RATIO)) : 0;
        const pictured = width >= 280;
        s.art.hidden = !pictured;
        if (pictured && s.picture.dataset.art !== step.art) {
            s.picture.dataset.art = step.art; s.picture.alt = step.title;
            s.picture.src = artBase() + '/' + art.file;
            for (const mark of s.art.querySelectorAll('.tgt-mark')) mark.remove();
            art.marks.forEach(([x, y], index) => {
                const mark = element('span', 'tgt-mark', String(index + 1));
                mark.style.left = x + '%'; mark.style.top = y + '%'; mark.setAttribute('aria-hidden', 'true');
                s.art.append(mark);
            });
        }
        if (step) {
            const text = pictured && step.artBody ? step.artBody : typeof step.body === 'function' ? step.body() : step.body;
            if (s.body.textContent !== text) s.body.textContent = text;
        }
        return pictured ? width + 42 : 0;
    }
    function layout(s) {
        const W = innerWidth, H = innerHeight, narrow = W < 600, safe = safeInsets(), step = s.current?.step;
        const across = Math.max(220, W - 24 - safe.left - safe.right);
        const pictured = showArt(s, step, narrow ? across : W - 32);
        s.bubble.style.width = narrow ? across + 'px' : pictured ? pictured + 'px' : '';
        const size = {w: s.bubble.offsetWidth, h: s.bubble.offsetHeight};
        const order = step?.placement, spot = fitSpot(s.spot, size, narrow, safe, order);
        s.root.classList.toggle('tgt-centered', !spot);
        Object.assign(s.spotNode.style, spot
            ? {left: spot.left + 'px', top: spot.top + 'px', width: spot.width + 'px', height: spot.height + 'px', borderRadius: spot.radius + 'px'}
            : {left: W / 2 + 'px', top: H / 2 + 'px', width: '0px', height: '0px', borderRadius: '50%'});
        let x, y, side = null;
        if (narrow) {
            // Phones: across the screen, on the side away from the lit area.
            x = 12 + safe.left;
            const above = 12 + safe.top, below = H - size.h - 12 - safe.bottom;
            y = !spot ? Math.max(above, (H - size.h) / 2) : spot.below || H - spot.bottom >= spot.top ? Math.max(above, below) : above;
        } else if (!spot) {
            x = (W - size.w) / 2; y = Math.max(16, (H - size.h) / 2);
        } else ({x, y, side} = place(spot, size, order));
        s.bubble.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
        s.arrow.hidden = !side;
        if (side) {
            s.arrow.dataset.side = side;
            const horizontal = side === 'left' || side === 'right';
            const along = horizontal ? clamp((spot.top + spot.bottom) / 2 - y - 6, 16, size.h - 28) : clamp((spot.left + spot.right) / 2 - x - 6, 16, size.w - 28);
            s.arrow.style.top = horizontal ? along + 'px' : '';
            s.arrow.style.left = horizontal ? '' : along + 'px';
        }
        if (!s.root.classList.contains('tgt-shown')) {
            // Appear in place, then animate between steps.
            const transition = s.bubble.style.transition; s.bubble.style.transition = 'none';
            s.bubble.getBoundingClientRect(); s.bubble.style.transition = transition;
            s.root.classList.add('tgt-shown');
        }
    }
    function follow(s) {
        if (s !== session) return;
        s.frame = requestAnimationFrame(() => follow(s));
        const step = s.current?.step;
        let target = s.current?.target;
        if (target && !shown(target)) target = s.current.target = step?.target ? find(step.target) : null;
        const rect = target ? spotRect(target) : s.waitTarget && shown(s.waitTarget) ? spotRect(s.waitTarget) : null;
        if (!sameRect(rect, s.spot) || innerWidth !== s.width || innerHeight !== s.height) {
            s.spot = rect; s.width = innerWidth; s.height = innerHeight; layout(s);
        }
    }
    function reveal(node) {
        const rect = node.getBoundingClientRect(), header = node.closest('.skinHeader') ? 0 : headerBottom();
        if (rect.top >= header + 8 && rect.bottom <= innerHeight - 8 && rect.left >= 0 && rect.right <= innerWidth) return;
        // At once: the lit area glides there anyway, and smooth scrolling stalls
        // in a covered window (no animation frames) and races later jumps.
        // A block taller than the window shows its top, just under the header.
        const options = {block: rect.height > innerHeight - header - 32 ? 'start' : 'center', inline: 'nearest'};
        const margin = node.style.scrollMarginTop;
        node.style.scrollMarginTop = header + 16 + 'px';
        try { node.scrollIntoView({...options, behavior: 'instant'}); } catch (error) { node.scrollIntoView(options); }
        node.style.scrollMarginTop = margin;
    }
    // Emby hides its header while the page scrolls down.
    function scrollToTop() {
        for (let node = detailRoot(); node; node = node.parentElement)
            if (node.scrollTop > 0) node.scrollTop = 0;
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    }

    // ---- Running ----------------------------------------------------------

    const live = token => !!session && session.token === token;
    async function waitFor(check, ms, token) {
        const until = Date.now() + ms;
        for (;;) {
            if (!live(token)) return null;
            const result = check();
            if (result) return result;
            if (Date.now() >= until) return null;
            await sleep(100);
        }
    }
    function showWaiting(s, text, node) {
        s.root.classList.add('tgt-waiting'); s.waitText.textContent = text; s.waitTarget = node || null;
        s.current = null; s.spot = node && shown(node) ? spotRect(node) : null; layout(s);
    }
    // Brings the page a step belongs to: the home page, or the work on the poster.
    async function enter(s, step, token) {
        if (step.context === 'home') {
            if (homeReady() && !motionBusy()) return true;
            const onHome = document.body.classList.contains('tg-home-active');
            showWaiting(s, onHome ? '正在载入首页…' : '正在返回首页…');
            if (!onHome && detailRoot() && s.openedDetail) { s.openedDetail = false; history.back(); }
            else if (!onHome) goHome();
            return !!await waitFor(() => homeReady() && !motionBusy(), debug.pageWaitMs, token);
        }
        if (step.context === 'detail') {
            if (s.openedDetail && detailRoot() && !motionBusy()) return true;
            const hero = find('.tg-home-hero');
            if (!homeReady() || !hero || hero.disabled) return false;
            showWaiting(s, '正在打开作品页…', find('.tg-home-stage'));
            hero.click();
            const opened = await waitFor(() => !motionBusy() && !document.body.classList.contains('tg-home-active')
                && detailRoot() && find('.mainDetailButtons'), debug.pageWaitMs, token);
            s.openedDetail = !!opened;
            return !!opened;
        }
        return true;
    }
    async function go(index, direction) {
        const s = session; if (!s || s.moving) return;
        const token = ++s.token; s.moving = true;
        try {
            for (;;) {
                if (!live(token)) return;
                if (index >= s.steps.length) { finish('done'); return; }
                if (index < 0) { index = 0; direction = 1; }
                const step = s.steps[index];
                if (s.skipped.has(step.id)) { index += direction; continue; }
                if (!await enter(s, step, token)) {
                    if (!live(token)) return;
                    // Without that page none of its steps can be shown.
                    for (const other of s.steps) if (other.context === step.context) s.skipped.add(other.id);
                    index += direction; continue;
                }
                if (step.toTop) scrollToTop();
                let target = null;
                if (step.target) {
                    target = await waitFor(() => find(step.target), step.optionalTarget ? 600 : debug.stepWaitMs, token);
                    if (!live(token)) return;
                    if (target) reveal(target);
                    if (target && !spotRect(target)) target = null;
                    if (!target && !step.optionalTarget) { s.skipped.add(step.id); index += direction; continue; }
                }
                show(s, index, target);
                return;
            }
        } finally { if (session === s) s.moving = false; }
    }
    function show(s, index, target) {
        const step = s.steps[index], visible = s.steps.filter(item => !s.skipped.has(item.id));
        const position = visible.indexOf(step) + 1, last = position === visible.length;
        s.index = index; s.current = {step, target}; s.waitTarget = null;
        s.root.classList.remove('tgt-waiting');
        s.title.textContent = step.title;
        s.count.textContent = position + ' / ' + visible.length;
        const skip = step.welcome && s.skippable;
        s.previous.dataset.action = skip ? 'skip' : 'back';
        s.previous.textContent = skip ? '跳过' : '上一步';
        s.previous.hidden = position === 1 && !skip;
        s.next.textContent = last ? '完成' : step.welcome ? '开始' : '下一步';
        s.spot = target ? spotRect(target) : null;
        layout(s);
        s.next.focus({preventScroll: true});
    }
    function forward() { if (session && !session.moving) go(session.index + 1, 1); }
    function back(direction) {
        const s = session; if (!s || s.moving || s.index <= 0) return;
        go(s.index + direction, -1);
    }
    function quit() { if (session?.skippable) finish('skipped'); }
    function finish(result) {
        const s = session; if (!s) return;
        session = null;
        if (result) writeState(result);
        cancelAnimationFrame(s.frame); clearInterval(s.watch);
        s.root.remove();
        if (s.focus?.isConnected && !s.focus.closest('[hidden],.hide')) s.focus.focus({preventScroll: true});
        else if (document.activeElement && s.root.contains(document.activeElement)) document.activeElement.blur();
    }
    function moveFocus(delta) {
        const s = session; if (!s) return;
        const buttons = [s.close, s.previous, s.next].filter(button => !button.hidden && shown(button));
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + delta + buttons.length) % buttons.length].focus({preventScroll: true});
    }
    function activate() {
        const s = session; if (!s) return;
        const focused = document.activeElement;
        if (focused && s.bubble.contains(focused) && focused.matches('button') && !focused.hidden) focused.click();
        else if (!s.moving && !s.root.classList.contains('tgt-waiting')) s.next.click();
    }
    // Back keys: close a tour that can be skipped; a new user's tour goes back a step.
    function backKey() {
        const s = session; if (!s) return false;
        if (s.skippable) quit(); else back(-1);
        return true;
    }

    async function start(mode = 'replay') {
        if (session) return false;
        const s = session = {mode, skippable: mode !== 'new', token: 0, index: 0, skipped: new Set(), artFailed: new Set(), focus: document.activeElement};
        mount(s);
        showWaiting(s, '正在准备引导…');
        const env = await environment();
        if (session !== s) return false;
        s.env = env; s.steps = buildSteps(env, mode);
        // The player pictures load while the first steps are on screen.
        for (const step of s.steps) if (step.art) new Image().src = artBase() + '/' + ART[step.art].file;
        s.width = innerWidth; s.height = innerHeight;
        follow(s);
        // Playback, or the page a step belongs to going away, interrupts the
        // tour; it starts again on the next visit to the home page.
        s.watch = setInterval(() => {
            if (session !== s || s.moving || !s.current) return;
            const context = s.current.step.context;
            if (playbackVisible() || (context === 'home' && !document.body.classList.contains('tg-home-active'))
                || (context === 'detail' && !detailRoot())) finish(null);
        }, 400);
        await go(0, 1);
        return true;
    }

    // ---- Input ------------------------------------------------------------

    // Registered before the web client's own handlers so the tour sees keys first.
    function onKey(event) {
        const s = session; if (!s) return;
        const inBubble = s.bubble.contains(event.target);
        if (event.type !== 'keydown') { event.stopImmediatePropagation(); return; }
        const onButton = inBubble && event.target.matches?.('button');
        switch (event.key) {
        case 'ArrowRight': case 'PageDown': forward(); break;
        case 'ArrowLeft': case 'PageUp': back(-1); break;
        case 'ArrowUp': moveFocus(-1); break;
        case 'ArrowDown': moveFocus(1); break;
        case 'Tab': moveFocus(event.shiftKey ? -1 : 1); break;
        case 'Enter': case ' ': case 'Spacebar':
            // A focused button activates itself.
            if (onButton) { event.stopImmediatePropagation(); return; }
            activate(); break;
        case 'Escape': case 'Backspace': case 'BrowserBack': case 'GoBack': backKey(); break;
        default: break;
        }
        event.preventDefault(); event.stopImmediatePropagation();
    }
    for (const type of ['keydown', 'keyup', 'keypress']) window.addEventListener(type, onKey, true);

    // Remote controls, gamepads and CEC (inputPlugin.js): true when the tour used the action.
    function hostAction(action) {
        if (!session) return false;
        const name = String(action || '');
        if (name.startsWith('host:') || /volume|mute/.test(name)) return false;
        switch (name) {
        case 'right': case 'next': case 'seek_forward': case 'step_forward': forward(); break;
        case 'left': case 'previous': case 'seek_backward': case 'step_backward': back(-1); break;
        case 'up': moveFocus(-1); break;
        case 'down': moveFocus(1); break;
        case 'enter': case 'select': case 'play_pause': case 'play': activate(); break;
        case 'back': case 'exit': backKey(); break;
        default: break;
        }
        return true;
    }

    // ---- Starting by itself -------------------------------------------------

    let readySince = 0, checking = false;
    async function poll() {
        if (session || checking) return;
        if (!pending(state) || !homeReady() || blocked() || playbackVisible()) { readySince = 0; return; }
        // Let startup notices (updates, mpv.conf) open first.
        if (!readySince) { readySince = Date.now(); return; }
        if (Date.now() - readySince < debug.readyMs) return;
        readySince = 0; checking = true;
        try { await refreshState(); } finally { checking = false; }
        if (!session && pending(state) && homeReady() && !blocked()) start(modeFor(state));
    }
    async function replay() {
        if (session) return;
        writeState('replay');
        if (homeReady() && !blocked()) { start('replay'); return; }
        // Started by the poll once the home page is ready.
        await goHome();
    }

    window.TigerestTour = {
        get active() { return !!session; },
        get state() { return state; },
        get mode() { return session?.mode || null; },
        get skippable() { return !!session?.skippable; },
        // For tests and the shared notes: what the bubble shows now.
        get current() {
            const s = session;
            if (!s) return null;
            const waiting = s.root.classList.contains('tgt-waiting');
            return {id: waiting ? null : s.current?.step.id || null, waiting: waiting ? s.waitText.textContent : null,
                title: s.title.textContent, body: s.body.textContent, count: s.count.textContent, centered: s.root.classList.contains('tgt-centered'),
                light: s.root.classList.contains('tgt-light'), close: !s.close.hidden,
                buttons: [s.previous, s.next].filter(button => !button.hidden).map(button => button.textContent),
                art: waiting || s.art.hidden ? null : {name: s.picture.dataset.art || null, loaded: s.picture.complete && s.picture.naturalWidth > 0,
                    marks: s.art.querySelectorAll('.tgt-mark').length}};
        },
        start, replay, next: forward, previous: () => back(-1), close: quit,
        back: backKey, hostAction, reload: refreshState, homeReady,
        steps: async (mode = 'upgrade') => buildSteps(await environment(), mode).map(step => step.id),
        debug
    };

    (async () => {
        try { await window.initCompleted; } catch (error) { /* settings stay unknown */ }
        await refreshState();
        window.jmpInfo?.settingsUpdate?.push((section, data) => {
            if (section === 'main' && data && typeof data[KEY] === 'string') state = data[KEY];
        });
        const tick = () => { Promise.resolve(poll()).catch(error => console.warn('Tigerest Theater: usage tour check failed', error)).finally(() => setTimeout(tick, debug.pollMs)); };
        tick();
    })();
}());
