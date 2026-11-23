// Professional mode (desktop with native gpu-next and uosc: Windows embeds the
// video window, the Mac attaches mpv's own window as a child of this one).
// The native side shrinks the video into the rectangle this page reports and
// gives the page input around it. This file draws what is there: live controls
// for the running mpv, the shader chain, danmaku style, and the statistics
// published by plugins/tigerest_pro.lua and the native load sampler. Changes
// apply to the running player at once and are kept by "save": picture options
// and the shader chain go to the profile in mpv.conf (through the same native
// editor calls as the settings page), the rest to the client's settings. The
// page cannot draw over the video (it is a native window above the page), so
// everything, dialogs and hints included, stays inside the panels.

const PRO_HISTORY = 120;          // statistics samples kept for the graph (one minute)
const PRO_SEND_INTERVAL = 70;     // ms between two writes of a slider being dragged
const PRO_PENDING_MS = 1200;      // how long a control waits for mpv to report its new value
const PRO_SHADER_PREFIX = '~~/shaders/';
const PRO_USER_PROFILE = 'tigerest-user-';    // profiles made here; the bundled ones have other names
const PRO_DEFAULT_PROFILE = 'tigerest-default';
const PRO_DANMAKU = 'user-data/uosc_danmaku/';

const proRange = (key, min, max, step, more) => Object.assign({key, kind: 'range', min, max, step}, more);
// Windows renders through Direct3D 11, where the large CNN shaders take
// seconds to minutes to compile the first time (catalog firstCompileSeconds).
const proFirstCompile = info => window.api?.system?.isWindows === true && info?.firstCompileSeconds
    ? `首次启用要编译约 ${info.firstCompileSeconds} 秒，期间画面停住，之后有缓存` : '';

// Keys without a title come from the mpv.conf option catalog (title, help,
// choices, and whether a profile or the global part holds them). `save` says
// where saving writes a key: 'profile' or 'global' in mpv.conf, 'setting' for
// a client setting (`setting` names it, `store` turns the text into its
// value), null for what belongs to this playback only.
const PRO_TABS = [
    {id: 'quality', title: '画质', groups: [
        {custom: 'pipeline'},
        {custom: 'profile'},
        {custom: 'shaders'},
        {title: '缩放', controls: [
            {key: 'scale'}, {key: 'cscale'}, {key: 'dscale'},
            proRange('scale-antiring', 0, 1, 0.05), proRange('cscale-antiring', 0, 1, 0.05),
            {key: 'sigmoid-upscaling'}, {key: 'correct-downscaling'}
        ]},
        {custom: 'rtx'},
        {title: '去色带与抖动', controls: [
            {key: 'deband'},
            proRange('deband-iterations', 1, 8, 1), proRange('deband-threshold', 0, 128, 1),
            proRange('deband-range', 1, 64, 1), proRange('deband-grain', 0, 128, 1),
            {key: 'dither-depth'}
        ]}
    ]},
    {id: 'motion', title: '补帧', groups: [
        {custom: 'rife'},
        {custom: 'native'},
        {custom: 'vfg'},
        {title: 'mpv 时间插帧', note: '在显示器刷新率下混合相邻帧，减轻 24 帧视频的抖动；与 RIFE 不能同时使用。',
            controls: [{key: 'interpolation'}, {key: 'tscale'}]}
    ]},
    {id: 'color', title: '色彩', groups: [
        {title: '画面调整', controls: [
            proRange('brightness', -100, 100, 1, {title: '亮度', save: 'profile'}),
            proRange('contrast', -100, 100, 1, {title: '对比度', save: 'profile'}),
            proRange('saturation', -100, 100, 1, {title: '饱和度', save: 'profile'}),
            proRange('gamma', -100, 100, 1, {title: '伽马', save: 'profile'}),
            proRange('hue', -100, 100, 1, {title: '色相', save: 'profile'})
        ]},
        {title: 'HDR 与色彩管理', controls: [
            {key: 'tone-mapping'}, {key: 'hdr-compute-peak'}, {key: 'gamut-mapping-mode'},
            {key: 'target-colorspace-hint'}, {custom: 'icc'}
        ]}
    ]},
    {id: 'audio', title: '声音', groups: [
        {title: '音量与同步', controls: [
            proRange('volume', 0, 130, 1, {title: '音量', unit: '%', save: null}),
            {key: 'mute', kind: 'toggle', title: '静音', save: null},
            proRange('audio-delay', -2, 2, 0.01, {title: '音频延迟', unit: ' s', signed: true, save: null,
                help: '正值让声音晚一些，用来对齐口型。'})
        ]},
        {custom: 'audio'}
    ]},
    {id: 'subtitle', title: '字幕', groups: [
        {title: '字幕', note: '字体、粗体、大小和垂直位置保存到「设置 → 字幕」，底部边距和阴影保存到 mpv.conf 的全局部分。显示开关和字幕延迟只对本次播放有效。', controls: [
            {key: 'sub-visibility', kind: 'toggle', title: '显示字幕', save: null},
            {key: 'sub-font', kind: 'font', title: '字幕字体', save: 'setting', setting: ['subtitles', 'font'],
                help: 'SRT 等纯文本字幕使用的字体；ASS 字幕按脚本自带的字体。'},
            {key: 'sub-bold', kind: 'toggle', title: '字幕粗体', save: 'setting', setting: ['subtitles', 'bold'], store: text => text === 'yes'},
            proRange('sub-scale', 0.5, 3, 0.03125, {title: '字幕大小', unit: '×', digits: 2, save: 'setting',
                setting: ['subtitles', 'size'], store: text => Math.round(Number(text) * 32)}),
            proRange('sub-pos', 0, 150, 1, {title: '字幕垂直位置', unit: '%', save: 'setting',
                setting: ['subtitles', 'vertical_position'], store: text => Math.round(Number(text)),
                help: '100 在画面底部，数值越小越靠上。'}),
            proRange('sub-delay', -10, 10, 0.05, {title: '字幕延迟', unit: ' s', signed: true, save: null}),
            proRange('sub-margin-y', 0, 200, 1), proRange('sub-shadow-offset', 0, 5, 0.1),
            {key: 'blend-subtitles'}
        ]}
    ]},
    {id: 'danmaku', title: '弹幕', groups: [{custom: 'danmaku'}]},
    {id: 'frame', title: '画面', groups: [
        {title: '同步', controls: [
            {key: 'video-sync', kind: 'choice', title: '同步模式', save: 'setting', setting: ['video', 'sync_mode'],
                choicesFrom: ['video', 'sync_mode'],
                help: '画面跟随哪个时钟呈现，保存到「设置 → 视频 → 同步模式」。显示重采样按屏幕的每次刷新送帧；跟随音频时钟按视频自己的帧间隔送帧。弹幕显示时，「跟随音频时钟」会被弹幕插件换成 display-vdrop，好让弹幕按屏幕刷新移动。'}
        ]},
        {title: '缩放与位置', note: '只对本次播放有效，换集时缩放和平移会恢复。', controls: [
            proRange('video-zoom', -1, 2, 0.01, {title: '缩放', signed: true, save: null,
                help: '以 2 为底：1 是放大一倍，-1 是缩小一半。'}),
            proRange('video-pan-x', -1, 1, 0.005, {title: '水平平移', signed: true, save: null}),
            proRange('video-pan-y', -1, 1, 0.005, {title: '垂直平移', signed: true, save: null}),
            proRange('panscan', 0, 1, 0.01, {title: '裁切填满（panscan）', save: null,
                help: '1 表示裁掉画面边缘直到填满窗口。'}),
            {key: 'video-rotate', kind: 'choice', title: '旋转', save: null,
                choices: [['0', '不旋转'], ['90', '90°'], ['180', '180°'], ['270', '270°']]}
        ]}
    ]}
];

// Danmaku style: the plugin's own names and ranges. A change applies at once
// and is stored in the client's danmaku settings, as its settings page does.
const PRO_DANMAKU_STYLE = [
    proRange('fontsize', 20, 100, 1, {title: '字号'}),
    proRange('opacity', 0, 1, 0.05, {title: '不透明度'}),
    proRange('scrolltime', 5, 30, 1, {title: '滚动时间', unit: ' s', help: '一条弹幕横穿画面用的秒数，越小越快。'}),
    proRange('displayarea', 0.1, 1, 0.05, {title: '显示范围', help: '弹幕占画面高度的比例；最下面五分之一始终留给字幕。'}),
    proRange('outline', 0, 4, 0.5, {title: '描边'}),
    proRange('shadow', 0, 4, 1, {title: '阴影'}),
    {key: 'bold', kind: 'toggle', title: '粗体'}
];

// "The untouched picture" for the compare button: every shader off, no
// debanding, no picture adjustment, plain bilinear scaling. Colour management
// stays as it is; without it the colours, not the processing, would differ.
const PRO_RAW = {
    scale: 'bilinear', cscale: 'bilinear', dscale: 'bilinear', 'scale-antiring': '0', 'cscale-antiring': '0',
    'sigmoid-upscaling': 'no', 'correct-downscaling': 'no', deband: 'no', interpolation: 'no',
    brightness: '0', contrast: '0', saturation: '0', gamma: '0', hue: '0'
};

// The render steps mpv reports, gathered into the stages a viewer thinks in.
const PRO_STAGES = [
    ['input', '输入'], ['shader', '滤镜'], ['scale', '缩放'], ['deband', '去色带'],
    ['color', '色彩'], ['motion', '补帧'], ['output', '输出'], ['other', '其他']
];

function proStageOf(description) {
    if (/^\[[^\]]+\]/.test(description)) return 'shader';
    if (/upscal|downscal|scaling/i.test(description)) return 'scale';
    if (/deband/i.test(description)) return 'deband';
    if (/interpolat|frame mix|oversampl/i.test(description)) return 'motion';
    if (/tone ?map|gamut|icc|3dlut|lineariz|sigmoid|peak|colou?r (manage|adapt|map)/i.test(description)) return 'color';
    if (/upload|decod|plane|chroma/i.test(description)) return 'input';
    if (/dither|osd|overlay|subtitle|blit|output|present/i.test(description)) return 'output';
    return 'other';
}

const PRO_STYLE = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483000; display: grid;
    grid-template-columns: minmax(0, 1fr) clamp(320px, 27vw, 440px); grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 8px; padding: 8px; box-sizing: border-box; background: #0e0e0f; color: #e8e6e1;
    font: 13px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; user-select: none; }
* { box-sizing: border-box; }
button, select, input { font: inherit; color: inherit; }
button { cursor: pointer; }
.bar { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 0 4px; }
.badge { padding: 2px 9px; border-radius: 3px; color: #171717; background: #ffbe38; font-weight: 600; font-size: 12px; }
.name { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.chips { display: flex; gap: 6px; min-width: 0; overflow: hidden; }
.chip { padding: 1px 8px; border: 1px solid #333; border-radius: 10px; color: #b9b6b0; font-size: 11px; white-space: nowrap; }
.spring { flex: 1; }
.tool { min-height: 28px; padding: 3px 12px; border: 1px solid #3a3a3c; border-radius: 3px; background: #1c1c1e; font-size: 12px; white-space: nowrap; }
.tool:hover:not(:disabled) { border-color: #6a6a6e; background: #252528; }
.tool:disabled { opacity: .4; cursor: default; }
.tool.primary, .tool.held { color: #171717; background: #ffbe38; border-color: #ffbe38; }
.stage { grid-column: 1; grid-row: 2; min-height: 0; border-radius: 4px; background: #000; }
.stats { grid-column: 1; grid-row: 3; display: grid; grid-template-columns: 1.15fr 1.2fr 1.15fr auto; gap: 8px; height: 188px; }
@media (max-height: 620px) { .stats { display: none; } }
.card { min-width: 0; padding: 10px 12px; border: 1px solid #262628; border-radius: 4px; background: #161617; overflow: hidden; }
.card h4 { display: flex; justify-content: space-between; gap: 8px; margin: 0 0 6px; overflow: hidden; color: #9a9792; font-size: 11px; font-weight: 400; white-space: nowrap; }
.card h4 .over { color: #ff8b84; }
.rows { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 12px; row-gap: 1px; margin: 0; font-size: 12px; }
.stats .rows { column-gap: 8px; row-gap: 0; font-size: 11px; line-height: 17px; }
.rows dt { color: #8f8c87; }
.rows dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right;
    font-family: Consolas, "Microsoft YaHei", monospace; font-variant-numeric: tabular-nums; }
.passes { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; }
.passes .note { margin: 4px 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.steps { overflow: hidden auto; scrollbar-width: thin; scrollbar-color: #3a3a3c transparent; }
.step { display: grid; grid-template-columns: 12px minmax(0, 1.1fr) minmax(40px, 1fr) 58px; gap: 6px; align-items: center;
    width: 100%; padding: 0; border: 0; background: none; font-size: 12px; line-height: 19px; text-align: left; cursor: default; }
.step.open, .step.closed { cursor: pointer; }
.step.open:hover, .step.closed:hover { background: #1f1f21; }
.step u { color: #8f8c87; font-size: 9px; text-decoration: none; }
.step span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.step i { display: block; height: 4px; border-radius: 2px; background: #2a2a2c; overflow: hidden; }
.step i b { display: block; height: 100%; background: #ffbe38; }
.step em { font: 11px Consolas, monospace; font-style: normal; text-align: right; color: #d9d6d0; }
.step.sub { font-size: 11px; line-height: 17px; }
.step.sub span { padding-left: 10px; color: #a8a5a0; }
.step.sub i b { background: #8a7a4e; }
.over .step i b { background: #e5534b; }
.big { font: 600 20px/1 Consolas, monospace; color: #7ee0a2; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
.big small { margin-left: 5px; color: #8f8c87; font: 11px "Segoe UI", "Microsoft YaHei", sans-serif; }
.big.warm { color: #ffbe38; }
.big.hot { color: #ff8b84; }
.pace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 14px; }
.pace .label { color: #9a9792; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.spark { display: block; width: 100%; height: 24px; margin: 3px 0 1px; }
.spark polyline { fill: none; stroke: #7ee0a2; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.spark.warm polyline { stroke: #ffbe38; }
.spark.hot polyline { stroke: #ff8b84; }
.spark line { stroke: #6a6a6e; stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.caption { color: #8f8c87; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.caption.warm { color: #ffbe38; }
.caption.hot { color: #ff8b84; }
.load { display: grid; grid-template-columns: repeat(3, 58px); gap: 2px 6px; align-content: start; }
.load h4 { grid-column: 1 / -1; }
.load h4 span.hot { color: #ff8b84; }
.gauge { display: grid; justify-items: center; }
.gauge svg { width: 50px; height: 50px; }
.gauge circle { fill: none; stroke-width: 5; }
.gauge .track { stroke: #2a2a2c; }
.gauge .value { stroke: #7ee0a2; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; }
.gauge.warm .value { stroke: #ffbe38; }
.gauge.hot .value { stroke: #e5534b; }
.gauge text { fill: #e8e6e1; font: 600 12px Consolas, monospace; text-anchor: middle; dominant-baseline: central; }
.gauge small { color: #8f8c87; font-size: 11px; white-space: nowrap; }
.side { position: relative; grid-column: 2; grid-row: 2 / 4; min-width: 0; min-height: 0; display: grid;
    grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto;
    border: 1px solid #262628; border-radius: 4px; background: #161617; overflow: hidden; }
.tabs { display: flex; border-bottom: 1px solid #262628; }
.tabs button { flex: 1; min-width: 0; padding: 9px 0; border: 0; border-bottom: 2px solid transparent; background: none; color: #9a9792; }
.tabs button[aria-selected="true"] { color: #ffbe38; border-bottom-color: #ffbe38; }
.body { overflow: hidden auto; padding: 4px 12px 12px; scrollbar-width: thin; scrollbar-color: #3a3a3c transparent; }
.group { padding: 10px 0 4px; border-bottom: 1px solid #222224; }
.group:last-child { border-bottom: 0; }
.group > h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.note { margin: 0 0 6px; color: #8f8c87; font-size: 11px; }
.flow { display: flex; flex-wrap: wrap; gap: 4px 0; align-items: center; font-size: 11px; color: #b9b6b0; }
.flow span { padding: 1px 7px; border: 1px solid #333; border-radius: 3px; }
.flow span.on { border-color: #6b5a2c; color: #ffd98a; }
.flow b { padding: 0 4px; color: #5c5a56; font-weight: 400; }
.ctl { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; align-items: center; padding: 5px 0; }
.ctl label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctl.dirty label::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: #ffbe38; vertical-align: 1px; }
.ctl .value { display: flex; align-items: center; gap: 6px; font: 12px Consolas, monospace; color: #d9d6d0; }
.ctl .undo { width: 20px; height: 20px; padding: 0; border: 0; border-radius: 3px; background: none; color: #8f8c87; visibility: hidden; }
.ctl.dirty .undo { visibility: visible; }
.ctl .undo:hover { color: #ffbe38; background: #252528; }
.ctl .wide { grid-column: 1 / -1; }
.ctl .hint { grid-column: 1 / -1; color: #7d7a75; font-size: 11px; line-height: 1.4; }
.ctl.blocked { opacity: .5; }
.ctl .hint.fallback { color: #ffbe38; }
select { max-width: 210px; padding: 3px 6px; border: 1px solid #3a3a3c; border-radius: 3px; background: #1c1c1e;
    font: 12px "Segoe UI", "Microsoft YaHei", sans-serif; }
select.wide { max-width: none; width: 100%; }
input[type=range] { width: 100%; height: 18px; margin: 0; accent-color: #ffbe38; }
input[type=checkbox] { width: 34px; height: 18px; margin: 0; appearance: none; border-radius: 9px; background: #3a3a3c; position: relative; cursor: pointer; }
input[type=checkbox]::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #d9d6d0; transition: left .12s; }
input[type=checkbox]:checked { background: #ffbe38; }
input[type=checkbox]:checked::after { left: 18px; background: #171717; }
input[type=checkbox]:disabled { opacity: .4; cursor: default; }
input[type=text] { width: 100%; padding: 5px 8px; border: 1px solid #3a3a3c; border-radius: 3px; background: #111112; user-select: text; }
:focus-visible { outline: 2px solid #ffbe38; outline-offset: 1px; }
.shader { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 5px 0; border-top: 1px solid #222224; }
.shader.off .what { opacity: .45; }
.shader .what div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shader .what small { display: block; color: #8f8c87; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shader .ops { display: flex; }
.shader .ops button { width: 22px; height: 22px; padding: 0; border: 0; border-radius: 3px; background: none; color: #8f8c87; }
.shader .ops button:hover:not(:disabled) { color: #ffbe38; background: #252528; }
.shader .ops button:disabled { opacity: .3; cursor: default; }
.link { padding: 4px 0; border: 0; background: none; color: #ffbe38; font-size: 12px; }
.buttons { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.foot { padding: 8px 12px 10px; border-top: 1px solid #262628; }
.foot .summary { color: #b9b6b0; font-size: 12px; }
.foot ul { max-height: 76px; margin: 4px 0 0; padding: 0; overflow: hidden auto; list-style: none; font-size: 11px; color: #8f8c87; scrollbar-width: thin; }
.foot li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.foot li b { color: #d9d6d0; font-weight: 400; }
.foot .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.toast { min-height: 17px; margin-top: 6px; color: #7ee0a2; font-size: 11px; }
.toast.error { color: #ff8b84; }
.sheet { position: absolute; inset: 0; z-index: 3; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; background: #161617; }
.sheet header { display: flex; align-items: center; justify-content: space-between; padding: 8px 8px 8px 12px; border-bottom: 1px solid #262628; font-size: 14px; font-weight: 600; }
.sheet header button { width: 26px; height: 26px; padding: 0; border: 0; border-radius: 3px; background: none; color: #9a9792; font-size: 16px; }
.sheet header button:hover { color: #ffbe38; background: #252528; }
.sheet .content { padding: 10px 12px; overflow: hidden auto; scrollbar-width: thin; scrollbar-color: #3a3a3c transparent; }
.sheet .content .note { margin: 8px 0 4px; }
.sheet .content ul { margin: 0 0 8px; padding-left: 18px; font-size: 12px; }
.sheet footer { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid #262628; }
.pick { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; padding: 7px 0; border-bottom: 1px solid #222224; }
.pick div, .pick small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick small { grid-column: 1; color: #8f8c87; font-size: 11px; }
.pick button { grid-row: 1 / 3; grid-column: 2; align-self: center; }
.pick-group { margin: 12px 0 2px; color: #e6c27a; font-size: 12px; }
.font { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid #222224; }
.font div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.font.current div { color: #ffbe38; }
.ctl .value .face { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
.tip { position: fixed; z-index: 10; left: 0; top: 0; padding: 6px 9px; border: 1px solid #4a4a4e; border-radius: 4px; background: #232326;
    color: #e8e6e1; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; pointer-events: none;
    box-shadow: 0 4px 14px rgba(0, 0, 0, .5); }
.tip[hidden] { display: none; }
`;

function proText(value) {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    if (typeof value === 'number') return String(Math.round(value * 1e6) / 1e6);
    return value === undefined || value === null ? '' : String(value);
}

function proSame(a, b) {
    if (a === b) return true;
    const x = Number(a), y = Number(b);
    return a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1e-6;
}

function proSameList(a, b) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}

function createProMode(player) {
    const host = document.createElement('div');
    host.id = 'tigerest-pro-mode';
    const shadow = host.attachShadow({mode: 'open'});
    const SVG = 'http://www.w3.org/2000/svg';
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const svg = (tag, attributes) => {
        const node = document.createElementNS(SVG, tag);
        for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, value);
        return node;
    };
    const style = el('style');
    style.textContent = PRO_STYLE;
    shadow.appendChild(style);

    let active = false;
    let ready = false;                        // the catalog has loaded and the controls exist
    let conf = null;                          // mpvConfState(): catalog, shader library, profiles
    let catalog = new Map();
    let shaderInfo = new Map();
    const definitions = new Map();            // key -> control definition, completed from the catalog
    const controls = new Map();               // key -> {row, set(text), def}
    const mirror = new Map();                 // key -> text, as mpv reports it
    const pending = new Map();                // key -> {text, at}: written, not yet reported back
    const throttles = new Map();
    // What the changes are measured against: mpv's values as they were before
    // this panel changed them. A value changed elsewhere (a hotkey, the client
    // switching HDR) is not a change of this panel: its baseline follows it.
    const baseline = {values: new Map(), shaders: []};
    const touched = new Set();                // keys this panel has written
    let shadersTouched = false;
    let rebaselineUntil = 0;
    let profile = null, profiles = [];
    let shaderRows = [];                      // [{path, enabled}] in chain order
    let shaderExpect = null;                  // {list, at}: chain written, not yet reported back
    let hold = null;                          // the state a held compare button returns to
    let frozenUntil = 0, latestOptions = null;
    let stats = null, load = null;
    // Frames the interpolation generates per second, from two load samples:
    // TensorRT RIFE runs outside mpv's renderer and reports no time per frame.
    let generated = null, generatedRate = null;
    let danmaku = null;                       // {style, on, loaded} from the danmaku plugin, null without it
    let vfg = null;                           // proVfgState() where the client can run NVIDIA frame generation
    let rtx = null;                           // proRtxState(): the RTX video choices, the settings, why one is not in use
    let native = null;                        // proNativeState() on the Mac: Apple-native frame interpolation
    let nativeChoice = null;                  // {mode, target} chosen here; the settings until it is changed
    const history = [];
    const paceSamples = [];                   // {at, dropped, decoder}: the last three seconds of the drop counters
    const rateHistory = [];                   // {shown, refresh}: frames and refreshes a second, one minute of them
    // What the last statistics said about pace: frames lost a second (and by
    // the decoder alone), and the share of refreshes the screen did not get
    // (null where the sync mode does not count them).
    let pace = {dropRate: 0, decoderRate: 0, missed: null};
    let fontFamilies = null;                  // installed font families, read once
    let icc = null;                           // proIccState(): the setting and who manages colour on the display
    let iccChoice = null;                     // what the select here asks for; the setting until it is changed
    const openStages = new Set();
    let tab = 'quality';
    let inerted = [];

    // ---- layout ---------------------------------------------------------
    const bar = el('div', 'bar');
    const name = el('div', 'name');
    const chips = el('div', 'chips');
    const compareBaseline = el('button', 'tool', '按住对比改动前');
    const compareRaw = el('button', 'tool', '按住看原始画面');
    const leave = el('button', 'tool', '退出专业模式 F2');
    compareBaseline.title = '按住时画面回到这些改动之前的参数，松开恢复当前改动。';
    compareRaw.title = '按住时卸下全部着色器，关闭去色带和画面调整，缩放改用双线性；色彩管理保持不变。松开恢复。';
    bar.append(el('span', 'badge', '专业模式'), name, chips, el('span', 'spring'), compareBaseline, compareRaw, leave);

    const stage = el('div', 'stage');
    const statsRow = el('div', 'stats');
    const signalCard = el('div', 'card'), passCard = el('div', 'card passes'), paceCard = el('div', 'card'), loadCard = el('div', 'card load');
    const passHead = el('h4'), passTotal = el('span'), passList = el('div', 'steps'), passNote = el('p', 'note');
    passHead.append('GPU 渲染耗时', passTotal);
    passHead.title = '每个处理步骤最近的平均耗时；点击带箭头的步骤展开其中各项。';
    passCard.append(passHead, passList, passNote);
    statsRow.append(signalCard, passCard, paceCard, loadCard);

    const side = el('div', 'side');
    const tabs = el('div', 'tabs');
    const body = el('div', 'body');
    const foot = el('div', 'foot');
    const summary = el('div', 'summary');
    const changeList = el('ul');
    const acts = el('div', 'acts');
    const resetAll = el('button', 'tool', '重置改动');
    const copyConf = el('button', 'tool', '复制为 mpv.conf');
    const saveNow = el('button', 'tool primary', '保存');
    const saveProfile = el('button', 'tool', '保存为新档位…');
    const toast = el('div', 'toast');
    saveNow.title = '画质参数和着色器链写回当前档位，其余写入客户端设置；之后每次播放都按保存的来。';
    saveProfile.title = '当前档位保持原样，把画质参数和着色器链存成一个新的档位。';
    acts.append(resetAll, copyConf, saveNow, saveProfile);
    foot.append(summary, changeList, acts, toast);
    side.append(tabs, body, foot);
    shadow.append(bar, stage, statsRow, side);

    let toastTimer = 0;
    const notify = (message, error) => {
        toast.textContent = message;
        toast.classList.toggle('error', Boolean(error));
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.textContent = ''; }, error ? 7000 : 3500);
    };

    // ---- hints ----------------------------------------------------------
    // The browser draws a title's tooltip beside the pointer, where the video
    // (a native window above the page) covers it. Every title in here becomes
    // a hint this page draws itself, wrapped and kept inside the panel its
    // element belongs to: the side panel, or the statistics row.
    const tip = el('div', 'tip');
    tip.hidden = true;
    shadow.appendChild(tip);
    let tipTimer = 0, tipAnchor = null;
    const hideTip = () => { clearTimeout(tipTimer); tipAnchor = null; tip.hidden = true; };
    const placeTip = anchor => {
        const words = anchor.dataset.tip;
        if (!words || !anchor.isConnected) { hideTip(); return; }
        const frame = (anchor.closest('.stats') ? statsRow : side).getBoundingClientRect();
        const box = anchor.getBoundingClientRect();
        tip.textContent = words;
        tip.style.maxWidth = `${Math.max(120, Math.min(360, frame.width - 16))}px`;
        tip.style.left = tip.style.top = '0px';
        tip.hidden = false;
        const size = tip.getBoundingClientRect();
        const left = Math.max(frame.left + 8, Math.min(box.left, frame.right - 8 - size.width));
        const below = box.bottom + 6, above = box.top - 6 - size.height;
        const top = below + size.height <= frame.bottom - 4 ? below
            : above >= frame.top + 4 ? above : Math.max(frame.top + 4, frame.bottom - 4 - size.height);
        tip.style.left = `${Math.round(left)}px`;
        tip.style.top = `${Math.round(top)}px`;
    };
    const adoptTitle = node => {
        // A select's options keep theirs: the list is a window of its own.
        if (node.nodeType !== 1 || node.tagName === 'OPTION' || !node.hasAttribute('title')) return;
        const words = node.getAttribute('title');
        if (words) node.dataset.tip = words; else delete node.dataset.tip;
        node.removeAttribute('title');
        if (node === tipAnchor && !tip.hidden) placeTip(node);
    };
    new MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'attributes') { adoptTitle(record.target); continue; }
            for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue;
                adoptTitle(node);
                for (const inner of node.querySelectorAll('[title]')) adoptTitle(inner);
            }
        }
        if (tipAnchor && !tipAnchor.isConnected) hideTip();
    }).observe(shadow, {subtree: true, childList: true, attributes: true, attributeFilter: ['title']});
    // The ones given a title before this began to watch.
    for (const node of shadow.querySelectorAll('[title]')) adoptTitle(node);
    shadow.addEventListener('pointerover', event => {
        const anchor = event.target instanceof Element ? event.target.closest('[data-tip]') : null;
        if (anchor === tipAnchor) return;
        hideTip();
        if (!anchor || !anchor.closest('.side, .stats, .bar')) return;
        tipAnchor = anchor;
        tipTimer = setTimeout(() => placeTip(anchor), 350);
    });
    shadow.addEventListener('pointerout', event => {
        if (tipAnchor && !(event.relatedTarget instanceof Node && tipAnchor.contains(event.relatedTarget))) hideTip();
    });
    for (const type of ['pointerdown', 'wheel', 'keydown']) shadow.addEventListener(type, hideTip, true);

    // A gauge: a ring filled to `fraction`, a figure inside, a caption under
    // it. `level` ('', 'warm' or 'hot') colours it; left out, the fill decides.
    const gauge = caption => {
        const node = el('div', 'gauge');
        const picture = svg('svg', {viewBox: '0 0 54 54'});
        const ring = svg('circle', {class: 'value', cx: 27, cy: 27, r: 22, 'stroke-dasharray': (2 * Math.PI * 22).toFixed(2)});
        const figure = svg('text', {x: 27, y: 27});
        picture.append(svg('circle', {class: 'track', cx: 27, cy: 27, r: 22}), ring, figure);
        node.append(picture, el('small', '', caption));
        return {node, set: (fraction, words, hint, level) => {
            const filled = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
            const state = level ?? (filled >= 0.9 ? 'hot' : filled >= 0.7 ? 'warm' : '');
            ring.setAttribute('stroke-dashoffset', (2 * Math.PI * 22 * (1 - filled)).toFixed(2));
            if (figure.textContent !== words) figure.textContent = words;
            node.classList.toggle('warm', state === 'warm');
            node.classList.toggle('hot', state === 'hot');
            if (node.dataset.tip !== hint) node.title = hint;
        }};
    };
    // One ring per place a frame can be lost, then the machine, then the
    // frames lost: when frames drop, the ring that is red says where.
    const loadHead = el('h4', '', '各环节负载');
    const loadVerdict = el('span');
    loadHead.appendChild(loadVerdict);
    const gauges = {motion: gauge('补帧'), render: gauge('渲染'), present: gauge('呈现掉拍'),
        gpu: gauge('GPU 占用'), cpu: gauge('CPU 占用'), drops: gauge('丢帧')};
    loadCard.append(loadHead, ...Object.values(gauges).map(item => item.node));

    // A graph of the last minute with a big figure: the rate, the rate it
    // should be (the dashed line), and a caption.
    const paceGraph = label => {
        const node = el('div');
        const big = el('div', 'big'), figure = document.createTextNode(''), of = el('small');
        const caption = el('div', 'caption');
        const picture = svg('svg', {class: 'spark', viewBox: `0 0 ${PRO_HISTORY - 1} 100`, preserveAspectRatio: 'none'});
        const goalLine = svg('line', {x1: 0, x2: PRO_HISTORY - 1});
        const line = svg('polyline');
        big.append(figure, of);
        picture.append(goalLine, line);
        const title = el('div', 'label', label);
        node.append(title, big, picture, caption);
        return {node, set: (values, goal, words, unit, due, note, level, hint) => {
            figure.nodeValue = words;
            of.textContent = unit;
            title.textContent = `${label} · ${due}`;
            big.className = `big ${level}`;
            caption.className = `caption ${level}`;
            picture.setAttribute('class', `spark ${level}`);
            caption.textContent = note;
            if (node.dataset.tip !== hint) node.title = hint;
            const known = values.map((value, index) => [PRO_HISTORY - values.length + index, value]).filter(point => Number.isFinite(point[1]));
            // The goal sits near the top; the scale opens downwards as far as the lowest value.
            const low = Math.min(goal * 0.8, ...known.map(point => point[1] * 0.97)), high = goal * 1.04;
            const y = value => (96 - (value - low) / Math.max(high - low, 1e-6) * 92).toFixed(1);
            goalLine.setAttribute('y1', y(goal));
            goalLine.setAttribute('y2', y(goal));
            line.setAttribute('points', known.map(point => `${point[0]},${y(point[1])}`).join(' '));
        }};
    };
    const paceHead = el('h4', '', '帧率与节奏');
    const paceNote = el('span');
    paceHead.appendChild(paceNote);
    const paceColumns = el('div', 'pace');
    const paceShown = paceGraph('视频帧率'), paceRefresh = paceGraph('实际呈现');
    const paceRows = el('dl', 'rows');
    paceColumns.append(paceShown.node, paceRefresh.node);

    // ---- values ---------------------------------------------------------
    // The choices of a client setting, as its settings page lists them.
    const settingChoices = (section, key) => {
        const entry = (window.jmpInfo?.settingsDescriptions?.[section] || []).find(item => item.key === key);
        return (entry?.options || []).map(option =>
            [String(option.value), String(option.title).replace(`${section}.${key}.`, '').replace(`${section}.`, '')]);
    };
    const define = raw => {
        const entry = catalog.get(raw.key) || {};
        const kind = raw.kind || (entry.type === 'flag' ? 'toggle' : entry.type === 'choice' ? 'choice' : 'range');
        const def = Object.assign({
            title: entry.title || raw.key,
            help: entry.help || '',
            choices: entry.choices || [],
            save: entry.scope === 'profile' ? 'profile' : entry.scope === 'global' ? 'global' : null
        }, raw, {kind});
        if (raw.choicesFrom) def.choices = settingChoices(...raw.choicesFrom);
        return def;
    };
    const decimals = def => def.digits ?? (String(def.step).split('.')[1] || '').length;
    const display = (def, text) => {
        if (def.kind === 'font') return text || '默认';
        if (def.kind === 'toggle') return text === 'yes' ? '开' : '关';
        if (def.kind === 'choice') return (def.choices.find(choice => choice[0] === text) || [text, text])[1];
        const number = Number(text);
        if (!Number.isFinite(number)) return text;
        return (def.signed && number > 0 ? '+' : '') + number.toFixed(decimals(def)) + (def.unit || '');
    };
    const enabledShaders = () => shaderRows.filter(row => row.enabled).map(row => row.path);
    const shadersDirty = () => shadersTouched && !proSameList(enabledShaders(), baseline.shaders);
    const shaderTitle = path => {
        const relative = path.startsWith(PRO_SHADER_PREFIX) ? path.slice(PRO_SHADER_PREFIX.length) : path;
        return (shaderInfo.get(relative) || {}).title || relative.split('/').pop();
    };

    const write = (key, text) => {
        // A change made while a saved or switched profile is still settling
        // is a change: the settling ends here.
        rebaselineUntil = 0;
        touched.add(key);
        pending.set(key, {text, at: performance.now()});
        Promise.resolve(player.proSet(key, text)).then(result => {
            if (result && result.ok) return;
            pending.delete(key);
            touched.delete(key);
            notify(`「${definitions.get(key)?.title || key}」没有生效：${result?.error || '未知原因'}`, true);
            syncControl(key);
            refreshChanges();
        });
        refreshChanges();
    };
    // A dragged slider writes at most once per interval, and always its last value.
    const throttled = (key, text, send) => {
        const state = throttles.get(key) || {timer: 0, next: null};
        throttles.set(key, state);
        if (state.timer) { state.next = text; return; }
        send(text);
        state.timer = setTimeout(() => {
            state.timer = 0;
            if (state.next !== null) { const next = state.next; state.next = null; throttled(key, next, send); }
        }, PRO_SEND_INTERVAL);
    };
    const writeShaders = () => {
        const list = enabledShaders();
        rebaselineUntil = 0;
        shadersTouched = true;
        shaderExpect = {list, at: performance.now()};
        Promise.resolve(player.proSetShaders(list)).then(result => {
            if (!result || !result.ok) notify(`着色器链没有生效：${result?.error || '未知原因'}`, true);
        });
        renderShaders();
        refreshChanges();
    };

    // A written value stops waiting once mpv reports it, or when its time is up.
    function settlePending() {
        const now = performance.now();
        for (const [key, waiting] of pending) {
            const reported = mirror.get(key);
            if ((reported !== undefined && proSame(reported, waiting.text)) || now - waiting.at >= (waiting.life || PRO_PENDING_MS)) pending.delete(key);
        }
    }

    function syncControl(key) {
        const control = controls.get(key);
        const reported = mirror.get(key);
        if (control && reported !== undefined && !pending.has(key)) control.set(reported);
    }

    // ---- controls -------------------------------------------------------
    // One row for a value: `change(text, final)` receives what the user chose
    // (final is false while a slider is still being dragged).
    function buildRow(def, change, blocked) {
        const row = el('div', 'ctl');
        row.dataset.key = def.key;
        const label = el('label', '', def.title);
        label.title = def.help ? `${def.help}\n（${def.key}）` : def.key;
        const value = el('div', 'value');
        let set;
        if (def.kind === 'toggle') {
            const input = el('input');
            input.type = 'checkbox';
            input.disabled = Boolean(blocked);
            input.addEventListener('change', () => change(input.checked ? 'yes' : 'no', true));
            value.appendChild(input);
            row.append(label, value);
            set = text => { input.checked = text === 'yes'; };
        } else if (def.kind === 'font') {
            const face = el('span', 'face');
            const pick = el('button', 'tool', '更换…');
            pick.disabled = Boolean(blocked);
            pick.addEventListener('click', () => openFontPicker(def, face.dataset.family || '', text => change(text, true)));
            value.append(face, pick);
            row.append(label, value);
            set = text => {
                face.dataset.family = text;
                face.textContent = text || '默认';
                face.style.fontFamily = text ? `"${text.replace(/["\\]/g, '')}", "Microsoft YaHei", sans-serif` : '';
            };
        } else if (def.kind === 'choice') {
            const select = el('select', 'wide');
            select.disabled = Boolean(blocked);
            select.addEventListener('change', () => change(select.value, true));
            row.append(label, value, select);
            set = current => {
                select.replaceChildren();
                const choices = def.choices.some(choice => choice[0] === current) || !current
                    ? def.choices : [[current, `当前：${current}`], ...def.choices];
                for (const [choice, title] of choices) {
                    const option = el('option', '', title);
                    option.value = choice;
                    select.appendChild(option);
                }
                select.value = current;
            };
        } else {
            const number = el('span');
            const input = el('input', 'wide');
            input.type = 'range';
            input.min = def.min; input.max = def.max; input.step = def.step;
            input.disabled = Boolean(blocked);
            input.addEventListener('input', () => { number.textContent = display(def, input.value); change(input.value, false); });
            input.addEventListener('change', () => change(input.value, true));
            value.appendChild(number);
            row.append(label, value, input);
            set = text => { input.value = text; number.textContent = display(def, text); };
        }
        if (blocked) {
            row.classList.add('blocked');
            row.appendChild(el('div', 'hint', blocked));
        } else if (def.help && def.kind !== 'range' && def.kind !== 'font') {
            row.appendChild(el('div', 'hint', def.help));
        }
        return {row, value, set, def};
    }

    function buildControl(def) {
        const control = buildRow(def, (text, final) => {
            if (def.kind === 'range' && !final) {
                pending.set(def.key, {text, at: performance.now()});
                throttled(def.key, text, latest => write(def.key, latest));
            } else if (def.kind !== 'range') {
                write(def.key, text);
            }
        }, conf?.analysis?.blocked?.[def.key]);
        const undo = el('button', 'undo', '↺');
        undo.title = '恢复到改动前';
        undo.addEventListener('click', () => {
            if (!baseline.values.has(def.key)) return;
            write(def.key, baseline.values.get(def.key));
            control.set(baseline.values.get(def.key));
        });
        control.value.prepend(undo);
        controls.set(def.key, control);
        return control.row;
    }

    // ---- sheets ---------------------------------------------------------
    // A dialog: it covers the side panel, never the video area.
    let closeSheet = null;
    function openSheet(title, content, buttons) {
        closeSheet?.();
        const sheet = el('div', 'sheet');
        const header = el('header', '', title);
        const dismiss = el('button', '', '×');
        dismiss.title = '关闭（Esc）';
        const box = el('div', 'content');
        box.appendChild(content);
        const footer = el('footer');
        const close = () => { sheet.remove(); closeSheet = null; };
        dismiss.addEventListener('click', close);
        header.appendChild(dismiss);
        for (const [text, className, action] of buttons) {
            const button = el('button', `tool ${className || ''}`, text);
            button.addEventListener('click', () => action(close, button));
            footer.appendChild(button);
        }
        sheet.append(header, box, footer);
        side.appendChild(sheet);
        closeSheet = close;
        return sheet;
    }

    // The installed fonts, each written in itself; a click applies it to the
    // subtitles on screen at once.
    async function openFontPicker(def, current, choose) {
        const search = el('input');
        search.type = 'text';
        search.placeholder = '搜索字体名称';
        const results = el('div');
        const content = el('div');
        content.append(search, results);
        results.appendChild(el('p', 'note', '正在读取已安装的字体…'));
        openSheet(def.title, content, [['完成', 'primary', close => close()]]);
        search.focus();
        if (!fontFamilies) {
            try { fontFamilies = await player.proFontFamilies(); } catch (_) { fontFamilies = []; }
        }
        const fill = () => {
            const query = search.value.trim().toLowerCase();
            results.replaceChildren();
            for (const family of fontFamilies) {
                if (query && !family.toLowerCase().includes(query)) continue;
                const item = el('div', family === current ? 'font current' : 'font');
                const sample = el('div', '', `${family}　字幕样例 Subtitle 123`);
                sample.style.fontFamily = `"${family.replace(/["\\]/g, '')}", "Microsoft YaHei", sans-serif`;
                const use = el('button', 'tool', family === current ? '使用中' : '使用');
                use.disabled = family === current;
                use.addEventListener('click', () => { current = family; choose(family); fill(); });
                item.append(sample, use);
                results.appendChild(item);
            }
            if (!results.children.length) results.appendChild(el('p', 'note', fontFamilies.length ? '没有匹配的字体。' : '没能读取字体列表。'));
        };
        search.addEventListener('input', fill);
        fill();
    }

    // ---- custom groups --------------------------------------------------
    const flow = el('div', 'flow');
    const profileSelect = el('select');
    const deleteProfile = el('button', 'tool', '删除');
    deleteProfile.title = '删除这个自己新建的档位。内置的三个档位不能删除。';
    const shaderList = el('div');
    const rifeRows = el('dl', 'rows');
    const audioRows = el('dl', 'rows');
    const danmakuBox = el('div');
    const danmakuControls = new Map();
    const setRows = (list, rows) => {
        list.replaceChildren();
        for (const [term, text] of rows) list.append(el('dt', '', term), el('dd', '', text));
    };

    function renderFlow() {
        const steps = [];
        const video = stats?.video || {};
        if (video.w) steps.push([`输入 ${video.w}×${video.h}`, false]);
        steps.push([video.hwdec && video.hwdec !== 'no' ? `硬解 ${video.hwdec}` : '软解', false]);
        const named = {'tigerest-rife': 'RIFE 补帧', 'tigerest-vfg': 'VFG 补帧', 'tigerest-vtfi': '系统原生补帧',
            'tigerest-rtx': rtx ? ['RTX', rtx.vsr && !rtx.vsrReason && 'VSR', rtx.hdr && !rtx.hdrReason && 'HDR'].filter(Boolean).join(' ') : 'RTX'};
        for (const filter of stats?.filters || []) {
            if (filter.enabled !== false) steps.push([named[filter.label] || (filter.label ? `@${filter.label}` : filter.name), true]);
        }
        const shaders = enabledShaders().length;
        if (shaders) steps.push([`着色器 ×${shaders}`, true]);
        if (mirror.get('scale')) steps.push([`缩放 ${mirror.get('scale')}`, false]);
        if (mirror.get('deband') === 'yes') steps.push(['去色带', true]);
        if (mirror.get('interpolation') === 'yes') steps.push(['时间插帧', true]);
        const output = stats?.output || {};
        if (output.w) steps.push([`输出 ${output.w - (output.ml || 0) - (output.mr || 0)}×${output.h - (output.mt || 0) - (output.mb || 0)}`, false]);
        flow.replaceChildren();
        steps.forEach(([text, on], index) => {
            if (index) flow.appendChild(el('b', '', '→'));
            flow.appendChild(el('span', on ? 'on' : '', text));
        });
    }

    function renderProfiles() {
        profileSelect.replaceChildren();
        const list = profiles.some(item => item.profile === profile) || !profile
            ? profiles : [{profile, title: profile}, ...profiles];
        for (const item of list) {
            const option = el('option', '', item.title);
            option.value = item.profile;
            if (item.hint) option.title = item.hint;
            profileSelect.appendChild(option);
        }
        profileSelect.value = profile || '';
        deleteProfile.disabled = !String(profile || '').startsWith(PRO_USER_PROFILE);
    }
    const profileTitle = id => profiles.find(item => item.profile === id)?.title || id || '未知';
    deleteProfile.addEventListener('click', () => {
        const target = profile, title = profileTitle(target);
        const content = el('div');
        content.append(el('p', 'note', `从 mpv.conf 里删除档位「${title}」，并切换到「${profileTitle(PRO_DEFAULT_PROFILE)}」。删除后不能恢复；右栏里还没保存的改动也会一起丢掉。`));
        openSheet('删除档位', content, [
            ['取消', '', close => close()],
            ['删除', 'primary', async (close, button) => {
                button.disabled = true;
                try {
                    const result = await player.mpvConfEdit((await player.mpvConfState()).user, {type: 'deleteProfile', name: target});
                    if (result.error) throw new Error(result.error);
                    // The client puts back what the profile had set and applies
                    // the default one once the file no longer holds it.
                    rebaselineUntil = performance.now() + 4000;
                    const saved = await player.mpvConfSave(result.user, false);
                    if (!saved.saved) {
                        const errors = (saved.analysis?.diagnostics || []).filter(item => item.severity === 'error').map(item => item.message);
                        throw new Error(`没有删除：${errors.join('；') || 'mpv.conf 校验未通过'}`);
                    }
                    close();
                    notify(`已删除档位「${title}」。`);
                } catch (error) {
                    button.disabled = false;
                    notify(String(error?.message || error), true);
                }
            }]
        ]);
    });
    profileSelect.addEventListener('change', () => {
        rebaselineUntil = performance.now() + 3000;
        Promise.resolve(player.proApplyProfile(profileSelect.value)).then(ok => {
            if (!ok) notify('档位没能应用，请到「设置 → MPV 画质与插件」检查 mpv.conf。', true);
        });
    });

    function renderShaders() {
        shaderList.replaceChildren();
        if (!shaderRows.length) shaderList.appendChild(el('p', 'note', '当前没有挂载着色器。'));
        shaderRows.forEach((row, index) => {
            const relative = row.path.slice(PRO_SHADER_PREFIX.length);
            const info = shaderInfo.get(relative) || {};
            const item = el('div', row.enabled ? 'shader' : 'shader off');
            const toggle = el('input');
            toggle.type = 'checkbox';
            toggle.checked = row.enabled;
            toggle.title = row.enabled ? '暂时卸下（保留在链中的位置）' : '重新挂载';
            toggle.addEventListener('change', () => { row.enabled = toggle.checked; writeShaders(); });
            const what = el('div', 'what');
            what.append(el('div', '', info.title || relative.split('/').pop()));
            const meta = [info.purpose, info.cost && `开销${info.cost}`, info.trigger].filter(Boolean).join(' · ');
            what.appendChild(el('small', '', meta || relative));
            what.title = [relative, info.note].filter(Boolean).join('\n');
            const ops = el('div', 'ops');
            const move = (text, title, target) => {
                const button = el('button', '', text);
                button.title = title;
                button.disabled = target < 0 || target >= shaderRows.length;
                button.addEventListener('click', () => {
                    shaderRows.splice(target, 0, shaderRows.splice(index, 1)[0]);
                    writeShaders();
                });
                return button;
            };
            const remove = el('button', '', '×');
            remove.title = '从链中移除';
            remove.addEventListener('click', () => { shaderRows.splice(index, 1); writeShaders(); });
            ops.append(move('↑', '上移（先执行）', index - 1), move('↓', '下移（后执行）', index + 1), remove);
            item.append(toggle, what, ops);
            shaderList.appendChild(item);
        });
    }

    function openShaderPicker() {
        const search = el('input');
        search.type = 'text';
        search.placeholder = '搜索名称、用途或文件名';
        const results = el('div');
        const library = [...(conf?.shaders?.shaders || []),
            ...(conf?.userShaders || []).map(path => ({path, group: '自己放入的着色器', title: path.split('/').pop()}))];
        const groups = new Map((conf?.shaders?.groups || []).map(group => [group.id, group.title]));
        const fill = () => {
            const query = search.value.trim().toLowerCase();
            results.replaceChildren();
            let heading = null;
            for (const info of library) {
                const haystack = [info.title, info.purpose, info.content, info.path, info.note].join(' ').toLowerCase();
                if (query && !haystack.includes(query)) continue;
                if (info.group !== heading) {
                    heading = info.group;
                    results.appendChild(el('div', 'pick-group', groups.get(heading) || heading));
                }
                const pick = el('div', 'pick');
                const used = shaderRows.some(row => row.path === PRO_SHADER_PREFIX + info.path);
                const add = el('button', 'tool', used ? '已在链中' : '挂载');
                add.disabled = used;
                add.addEventListener('click', () => {
                    shaderRows.push({path: PRO_SHADER_PREFIX + info.path, enabled: true});
                    writeShaders();
                    add.disabled = true;
                    add.textContent = '已在链中';
                });
                const meta = [info.purpose, info.content, info.cost && `开销${info.cost}`,
                    info.measuredMs > 0 && `实测 ${info.measuredMs} ms`, proFirstCompile(info), info.trigger].filter(Boolean).join(' · ');
                pick.append(el('div', '', info.title), add, el('small', '', meta || info.path));
                pick.title = [info.path, info.note].filter(Boolean).join('\n');
                results.appendChild(pick);
            }
            if (!results.children.length) results.appendChild(el('p', 'note', '没有匹配的着色器。'));
        };
        search.addEventListener('input', fill);
        fill();
        const content = el('div');
        content.append(search, results);
        const note = conf?.shaders?.costNote;
        if (note) content.appendChild(el('p', 'note', note));
        if (window.api?.system?.isWindows === true && conf?.shaders?.firstCompileNote)
            content.appendChild(el('p', 'note', conf.shaders.firstCompileNote));
        openSheet('挂载着色器', content, [['完成', 'primary', close => close()]]);
        search.focus();
    }

    function renderRife() {
        const rife = load?.rife;
        const enabled = Boolean(window.jmpInfo?.settings?.video?.aiRife);
        const rows = [['设置', enabled ? '已开启' : '已关闭']];
        if (rife) {
            rows.push(['状态', rife.status || '—']);
            if (rife.model) rows.push(['模型', `${rife.model} · ${rife.pipeline || ''}`]);
            if (rife.model && rife.factor) rows.push(['倍数', `${rife.factor}×`]);
            if (generatedRate !== null) rows.push(['生成速度', generationText()]);
            if (rife.processedPairs) rows.push(['已处理帧对', String(rife.processedPairs)]);
            if (rife.cutBypasses) rows.push(['转场跳过', String(rife.cutBypasses)]);
            if (rife.timingAvailable && rife.p95Ms !== undefined) rows.push(['推理耗时 P95', `${Number(rife.p95Ms).toFixed(1)} ms`]);
            if (rife.performanceWarning) rows.push(['警告', '补帧跟不上播放速度']);
        }
        if (stats?.video?.output_fps) rows.push(['滤镜后帧率', `${stats.video.output_fps.toFixed(3)} fps`]);
        setRows(rifeRows, rows);
    }

    // NVIDIA Video Frame Generation. What the two selects show is compared
    // with the client's settings: a difference is a change like any other,
    // and saving writes it to 设置 → 视频.
    const VFG_MODES = [['-1', '关闭'], ['0', '低'], ['1', '中'], ['2', '高']];
    const VFG_FACTORS = [['0', '自动（按 RIFE 目标帧率）'], ...[1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map(value => [String(value), `${value}×`])];
    const VFG_SETTING = ['off', 'low', 'medium', 'high'];
    const vfgSelect = el('select'), vfgFactorSelect = el('select');
    const vfgStatus = el('p', 'note');
    for (const [select, list] of [[vfgSelect, VFG_MODES], [vfgFactorSelect, VFG_FACTORS]]) {
        for (const [value, title] of list) {
            const option = el('option', '', title);
            option.value = value;
            select.appendChild(option);
        }
    }
    let vfgFactorChoice = null;               // the factor chosen here while the filter is off
    // What the script counted in its last half second, while that is fresh.
    const vfgLive = () => load?.vfg && Math.abs(Date.now() / 1000 - Number(load.vfg.t)) < 3 ? load.vfg : null;
    const vfgFactor = () => vfg.mode >= 0 ? Number(vfg.factor) || 0 : vfgFactorChoice ?? (Number(vfg.settingFactor) || 0);
    function renderVfg() {
        if (!vfg?.configured) return;
        const filter = (stats?.filters || []).find(item => item.label === 'tigerest-vfg');
        const live = vfgLive();
        vfgSelect.value = String(vfg.mode);
        vfgFactorSelect.value = String(vfgFactor());
        vfgSelect.disabled = vfgFactorSelect.disabled = !vfg.available;
        vfgStatus.textContent = !vfg.available ? vfg.reason
            : vfg.mode < 0 ? '未开启。'
            : !filter ? '正在启动…'
            : filter.enabled === false ? '滤镜没能启动，详情见客户端日志。'
            : live?.disabled ? `已停止生成（${live.disabled}），现在只是重复源帧；重新选一次档位可以恢复。`
            : `运行中：${(stats.video?.fps || 0).toFixed(3)} → ${(stats.video?.output_fps || 0).toFixed(3)} fps（${vfg.effectiveFactor}×）${
                live && live.ms > 0 ? ` · 每帧推理 ${Number(live.ms).toFixed(1)} ms，每秒生成 ${Number(live.generated_fps).toFixed(1)} 帧` : ''}`;
    }
    async function refreshVfg() {
        const before = JSON.stringify(vfg);
        vfg = typeof player.proVfgState === 'function' ? await player.proVfgState() : null;
        renderVfg();
        if (JSON.stringify(vfg) !== before) refreshChanges();
    }
    async function applyVfg(mode, factor) {
        vfgFactorChoice = factor;
        const result = await player.proSetVfg(mode, factor);
        if (!result?.ok) notify(`VFG 没有启动：${result?.error || '未知原因'}`, true);
        await refreshVfg();
        refreshChanges();
    }
    for (const select of [vfgSelect, vfgFactorSelect]) {
        select.addEventListener('change', () => applyVfg(Number(vfgSelect.value), Number(vfgFactorSelect.value)));
    }

    // Apple-native frame interpolation (Mac): VideoToolbox's frame-rate
    // conversion or low-latency interpolation as an mpv filter. A choice here
    // replaces the filter at once; saving writes 设置 → 视频.
    const NATIVE_MODES = [['off', '关闭'], ['quality', '画质优先（帧率转换）'], ['efficient', '低功耗（低延迟插帧）']];
    const NATIVE_TARGETS = [['2x', '2 倍'], ['60', '60 fps'], ['display', '跟随屏幕刷新率']];
    const NATIVE_STATUS = {
        waiting: '等待第一帧…', preparing: '正在载入系统模型（首次使用某个分辨率时要几秒）…', warming: '正在启动…',
        'needs-hardware-frames': '需要硬件解码，当前保持原帧。', unavailable: '这台 Mac 不支持所选的方式。',
        'unsupported-size': '这个分辨率保持原帧（最高 1080p）。', 'unsupported-fps': '这个帧率保持原帧（最高 30 fps）。',
        hdr: 'HDR 视频保持原帧。', interlaced: '隔行视频保持原帧。', 'speed-bypass': '倍速播放时保持原帧。',
        'target-not-higher': '源帧率已经不低于目标帧率，保持原帧。', 'no-timestamps': '视频没有时间戳，保持原帧。',
        'too-slow': '跟不上播放，本集已恢复原帧；可以改用低功耗或 2 倍。', failed: '出错了，本集已恢复原帧，详情见客户端日志。'
    };
    const nativeModeSelect = el('select'), nativeTargetSelect = el('select');
    const nativeStatus = el('p', 'note');
    for (const [select, list] of [[nativeModeSelect, NATIVE_MODES], [nativeTargetSelect, NATIVE_TARGETS]]) {
        for (const [value, title] of list) {
            const option = el('option', '', title);
            option.value = value;
            select.appendChild(option);
        }
    }
    const nativeLive = () => (load?.native?.active ? load.native : native?.active ? native : null);
    function renderNative() {
        if (!native) return;
        const chosen = nativeChoice || {mode: native.setting, target: native.target};
        nativeModeSelect.value = chosen.mode;
        nativeTargetSelect.value = chosen.target;
        nativeModeSelect.disabled = nativeTargetSelect.disabled = !native.available || !native.playing;
        const live = nativeLive();
        const status = live?.status;
        nativeStatus.textContent = !native.available ? '需要客户端的原生视频输出。'
            : !live ? '未开启。'
            : status === 'active' ? `${live.fellBack ? '画质优先跟不上播放，本集已改用低功耗方式。\n' : ''}运行中：${Number(live.sourceFps).toFixed(3)} → ${Number(live.outputFps).toFixed(3)} fps · 每对源帧 ${Number(live.processP95Ms).toFixed(1)} ms（P95）\n已补 ${live.generated} 帧，停住的画面 ${live.statics} 对，镜头切换 ${live.cuts} 次（这两种不补，沿用原帧）`
            : NATIVE_STATUS[status] || `状态：${status || '未知'}`;
    }
    async function refreshNative() {
        const before = JSON.stringify(native);
        native = typeof player.proNativeState === 'function' ? await player.proNativeState() : null;
        renderNative();
        if (JSON.stringify(native) !== before) refreshChanges();
    }
    async function applyNative(mode, target) {
        nativeChoice = {mode, target};
        const result = await player.proSetNative(mode, target);
        if (!result?.ok) notify(`原生补帧没有生效：${result?.error || '未知原因'}`, true);
        await refreshNative();
        refreshChanges();
    }
    for (const select of [nativeModeSelect, nativeTargetSelect]) {
        select.addEventListener('change', () => applyNative(nativeModeSelect.value, nativeTargetSelect.value));
    }

    // Whether mpv reads the display's ICC profile: a setting of the client,
    // not a line of the profile, because the client has to turn it off where
    // the system manages colour already. Compared with the setting like the
    // frame-generation choice above.
    const ICC_MODES = [['auto', '自动（推荐）'], ['on', '始终使用'], ['off', '不使用']];
    const iccSelect = el('select', 'wide');
    const iccHint = el('div', 'hint');
    for (const [value, title] of ICC_MODES) {
        const option = el('option', '', title);
        option.value = value;
        iccSelect.appendChild(option);
    }
    function renderIcc() {
        if (!icc) return;
        const mode = iccChoice ?? icc.setting;
        iccSelect.value = mode;
        iccSelect.disabled = Boolean(icc.overridden);
        const managed = {hdr: '这块屏幕开着 Windows HDR，系统合成画面时已经套用屏幕的 HDR 校准配置',
            acm: 'Windows 的「自动管理应用的颜色」已开启，系统已经按屏幕的配置文件校正所有画面',
            edr: '这块屏幕支持 EDR，macOS 按画面声明的色彩空间自己映射'}[icc.managed];
        const using = mode === 'on' || (mode === 'auto' && !icc.managed);
        iccHint.textContent = icc.overridden ? '「高级覆盖」已开启，这一项由 mpv.conf 里的 icc-profile-auto 决定。'
            : mode === 'auto' ? (managed ? `${managed}，所以「自动」下 mpv 不读取 ICC，免得校正两次。当前：不使用。`
                : '系统没有为这块屏幕管理色彩，「自动」下由 mpv 读取屏幕的 ICC 配置文件。当前：使用。')
            : `${managed ? `${managed}。` : ''}当前：${using ? '使用' : '不使用'}${using && managed ? '（会和系统的校正叠在一起）' : ''}。`;
    }
    async function refreshIcc() {
        icc = typeof player.proIccState === 'function' ? await player.proIccState() : null;
        renderIcc();
    }
    async function applyIcc(mode) {
        iccChoice = mode;
        const result = await player.proSetIcc(mode);
        if (!result?.ok) notify(`ICC 设置没有生效：${result?.error || '未知原因'}`, true);
        renderIcc();
        refreshChanges();
    }
    iccSelect.addEventListener('change', () => applyIcc(iccSelect.value));

    // NVIDIA RTX Video: super resolution and SDR to HDR done by the graphics
    // driver, through mpv's d3d11vpp filter at the end of the filter chain.
    // Both apply at once and are compared with the client's settings like the
    // frame-generation choice; saving writes them to 设置 → 视频.
    const RTX_SWITCHES = [
        {key: 'rtx-vsr', field: 'vsr', stored: 'settingVsr', setting: 'rtxVsr', reason: 'vsrReason', title: 'RTX 超分辨率（VSR）',
            help: '由显卡驱动把视频放大到屏幕的分辨率（最多 4 倍），代替上面的缩放算法。需要 RTX 20 系或更新的显卡，并在 NVIDIA App「系统 → 视频 → RTX 视频增强」里打开「超分辨率」，否则画面不会有变化。'},
        {key: 'rtx-hdr', field: 'hdr', stored: 'settingHdr', setting: 'rtxHdr', reason: 'hdrReason', title: 'RTX Video HDR',
            help: '由显卡驱动把 SDR 视频转换成 HDR，HDR 片源不受影响。需要屏幕开着 Windows HDR、RTX 20 系或更新的显卡，并在 NVIDIA App「系统 → 视频 → RTX 视频增强」里打开「HDR」。'}
    ];
    const rtxControls = new Map();
    const rtxStatus = el('p', 'note');
    rtxStatus.style.whiteSpace = 'pre-line';
    let rtxWanted = null;                     // {vsr, hdr} asked for, until the player reports it back
    function renderRtx() {
        if (!rtx) return;
        if (rtxWanted && rtx.vsr === rtxWanted.vsr && rtx.hdr === rtxWanted.hdr) rtxWanted = null;
        const shown = rtxWanted || rtx;
        for (const item of RTX_SWITCHES) rtxControls.get(item.key)?.set(shown[item.field] ? 'yes' : 'no');
        const filter = (stats?.filters || []).find(entry => entry.label === 'tigerest-rtx');
        const lines = [];
        if (rtx.vsr) {
            lines.push(rtx.vsrReason ? `超分辨率没有生效：${rtx.vsrReason}`
                : `超分辨率：放大 ${Number(rtx.scale).toFixed(2)} 倍${stats?.video?.w ? `（${stats.video.w}×${stats.video.h} → ${Math.round(stats.video.w * rtx.scale)}×${Math.round(stats.video.h * rtx.scale)}）` : ''}`);
        }
        if (rtx.hdr) lines.push(rtx.hdrReason ? `HDR 没有生效：${rtx.hdrReason}` : 'HDR：SDR 画面由显卡转换成 HDR 输出');
        if (rtx.filter && filter?.enabled === false) lines.push('mpv 没能启动 d3d11vpp 滤镜，详情见客户端日志。');
        rtxStatus.textContent = !rtx.available ? '需要客户端的原生视频输出（D3D11）。' : lines.join('\n') || '未开启。';
    }
    async function refreshRtx() {
        const before = JSON.stringify(rtx);
        rtx = typeof player.proRtxState === 'function' ? await player.proRtxState() : null;
        renderRtx();
        if (JSON.stringify(rtx) !== before) { refreshChanges(); renderFlow(); }
    }
    async function applyRtx(vsr, hdr) {
        rtxWanted = {vsr: Boolean(vsr), hdr: Boolean(hdr)};
        const result = await player.proSetRtx(rtxWanted.vsr, rtxWanted.hdr);
        if (!result?.ok) {
            rtxWanted = null;
            notify(`RTX 设置没有生效：${result?.error || '未知原因'}`, true);
        }
        await refreshRtx();
    }

    const customControls = {
        icc: () => {
            const row = el('div', 'ctl');
            row.dataset.key = 'icc-mode';
            row.hidden = !icc;
            const label = el('label', '', '显示器 ICC 色彩配置');
            label.title = '播放时是否让 mpv 读取显示器的 ICC 配置文件来校正颜色，保存到「设置 → 视频 → 显示器 ICC 色彩配置」。\n系统已经在为屏幕管理色彩时（Windows HDR、自动颜色管理），「自动」不读取，免得校正两次。';
            row.append(label, el('div', 'value'), iccSelect, iccHint);
            renderIcc();
            return row;
        }
    };

    // Danmaku: the plugin's messages, not mpv options.
    const danmakuCommand = (...words) => player.userCommand(words.join(' '));
    function buildDanmaku() {
        danmakuControls.clear();
        danmakuBox.replaceChildren();
        if (!danmaku) {
            danmakuBox.appendChild(el('p', 'note', '弹幕插件没有加载：在「设置 → MPV 画质与插件」里启用弹幕后重启客户端。'));
            return;
        }
        const show = buildRow({key: 'show', kind: 'toggle', title: '显示弹幕', help: '本地视频不加载弹幕。'}, () => {
            danmakuCommand('script-message', 'show_danmaku_keyboard');
            // The plugin may decline (a local file): show what it reports.
            setTimeout(syncDanmaku, 800);
        });
        danmakuControls.set('show', show);
        const menus = el('div', 'buttons');
        for (const [text, message] of [['搜索弹幕…', 'open_search_danmaku_menu'], ['添加弹幕源…', 'open_add_source_menu'], ['弹幕延迟…', 'open_source_delay_menu']]) {
            const button = el('button', 'tool', text);
            button.title = '在画面里打开对应的菜单';
            button.addEventListener('click', () => { danmakuCommand('script-message', message); player.proFocus(true); });
            menus.appendChild(button);
        }
        danmakuBox.append(show.row, menus, el('p', 'note', '下面的样式立即生效，并保存到「设置 → 弹幕样式」。'));
        const stored = window.jmpInfo?.settings?.danmaku;
        for (const def of PRO_DANMAKU_STYLE) {
            const control = buildRow(def, (text, final) => {
                throttled(PRO_DANMAKU + def.key, text, latest => danmakuCommand('script-message-to', 'uosc_danmaku', 'tigerest-style', def.key, latest));
                // The stored setting takes the value the slider is released at.
                if (final && stored && def.key in stored) stored[def.key] = def.kind === 'toggle' ? text === 'yes' : Number(text);
            });
            danmakuControls.set(def.key, control);
            danmakuBox.appendChild(control.row);
        }
        syncDanmaku();
    }
    function syncDanmaku() {
        if (!danmaku) return;
        danmakuControls.get('show')?.set(danmaku.on ? 'yes' : 'no');
        for (const def of PRO_DANMAKU_STYLE) {
            const value = danmaku.style[def.key];
            if (value !== undefined && !throttles.get(PRO_DANMAKU + def.key)?.timer) danmakuControls.get(def.key)?.set(proText(value));
        }
    }

    const customGroups = {
        pipeline: () => { const group = el('div', 'group'); group.append(el('h3', '', '处理顺序'), flow); return group; },
        profile: () => {
            const group = el('div', 'group');
            const row = el('div', 'ctl');
            const value = el('div', 'value');
            value.append(profileSelect, deleteProfile);
            row.append(el('label', '', '档位'), value,
                el('div', 'hint', '切换档位会按 mpv.conf 重新设置下面的参数和着色器，并清空未保存的改动。「保存」把改动写回这个档位，「保存为新档位…」另存一个。'));
            group.append(el('h3', '', '画质档位'), row);
            return group;
        },
        shaders: () => {
            const group = el('div', 'group');
            const add = el('button', 'link', '+ 挂载着色器');
            add.addEventListener('click', openShaderPicker);
            group.append(el('h3', '', '着色器链'), el('p', 'note', '从上到下依次执行；勾选框可以临时卸下某一个来对比效果。'), shaderList, add);
            return group;
        },
        rife: () => {
            const group = el('div', 'group');
            group.append(el('h3', '', 'RIFE AI 补帧'), rifeRows,
                el('p', 'note', 'RIFE 的开关、模型和目标帧率在「设置 → 视频」里修改，重新打开视频后生效。'));
            return group;
        },
        native: () => {
            const group = el('div', 'group');
            group.hidden = !native;
            nativeStatus.style.whiteSpace = 'pre-line';
            const pair = (title, select, hint) => {
                const row = el('div', 'ctl');
                const value = el('div', 'value');
                value.appendChild(select);
                const label = el('label', '', title);
                label.title = hint;
                row.append(label, value);
                return row;
            };
            group.append(el('h3', '', '系统原生补帧（VideoToolbox）'),
                pair('方式', nativeModeSelect, '画质优先用 Apple 的帧率转换，鬼影最少；低功耗用低延迟插帧，只用神经引擎，只有 2 倍和 4 倍。'),
                pair('输出帧率', nativeTargetSelect, '2 倍：23.976 → 47.95；60 fps：23.976 → 59.94；跟随屏幕：补到屏幕刷新率，最多 5 倍。'),
                nativeStatus,
                el('p', 'note', '由 macOS 在显卡和神经引擎上补帧，处理 1080p、30 fps 以内的 SDR 视频。切换立即生效（画面会停顿一下），开启后本集的 RIFE 会让出。点「保存」后写入「设置 → 视频」，以后每次播放自动开启。'));
            renderNative();
            return group;
        },
        vfg: () => {
            const group = el('div', 'group');
            group.hidden = !vfg?.configured;
            const pair = (title, select, hint) => {
                const row = el('div', 'ctl');
                const value = el('div', 'value');
                value.appendChild(select);
                const label = el('label', '', title);
                label.title = hint;
                row.append(label, value);
                return row;
            };
            group.append(el('h3', '', 'NVIDIA VFG 补帧'),
                pair('质量档位', vfgSelect, '档位越高画质越好，每生成一帧花的时间也越长。'),
                pair('倍数', vfgFactorSelect, '输出帧率是源帧率的多少倍，0.5 倍一档。「自动」按「设置 → 视频」里的 RIFE 目标帧率选最接近的一档。倍数越高，每秒要生成的帧越多。'),
                vfgStatus,
                el('p', 'note', '需要 RTX 40 / 50 显卡，切换立即生效（画面会停顿约 0.2 秒）。开启后本集的 RIFE 会让出，要回到 RIFE 请重新打开视频。点「保存」后，档位和倍数写入「设置 → 视频」，以后每次播放自动开启。'));
            renderVfg();
            return group;
        },
        rtx: () => {
            const group = el('div', 'group');
            group.hidden = !rtx;
            group.appendChild(el('h3', '', 'NVIDIA RTX 视频增强'));
            rtxControls.clear();
            for (const item of RTX_SWITCHES) {
                // From what was asked last: a second click may come before the first is reported back.
                const control = buildRow({key: item.key, kind: 'toggle', title: item.title, help: item.help}, text => {
                    const choice = Object.assign({vsr: rtx.vsr, hdr: rtx.hdr}, rtxWanted, {[item.field]: text === 'yes'});
                    applyRtx(choice.vsr, choice.hdr);
                }, rtx && !rtx.available ? '需要客户端的原生视频输出（D3D11）' : null);
                rtxControls.set(item.key, control);
                group.appendChild(control.row);
            }
            group.append(rtxStatus, el('p', 'note', '由显卡驱动处理，排在所有滤镜和补帧之后；切换立即生效。点「保存」后写入「设置 → 视频」，以后每次播放自动开启。'));
            renderRtx();
            return group;
        },
        audio: () => { const group = el('div', 'group'); group.append(el('h3', '', '当前音频'), audioRows); return group; },
        danmaku: () => { const group = el('div', 'group'); group.append(el('h3', '', '弹幕'), danmakuBox); buildDanmaku(); return group; }
    };

    function buildTabs() {
        closeSheet?.();
        tabs.replaceChildren();
        controls.clear();
        definitions.clear();
        for (const item of PRO_TABS) {
            const button = el('button', '', item.title);
            button.dataset.tab = item.id;
            button.setAttribute('aria-selected', String(item.id === tab));
            button.addEventListener('click', () => { tab = item.id; buildTabs(); });
            tabs.appendChild(button);
            for (const group of item.groups) {
                for (const raw of group.controls || []) if (!raw.custom) definitions.set(raw.key, define(raw));
            }
        }
        body.replaceChildren();
        for (const group of PRO_TABS.find(item => item.id === tab).groups) {
            if (group.custom) { body.appendChild(customGroups[group.custom]()); continue; }
            const node = el('div', 'group');
            node.appendChild(el('h3', '', group.title));
            if (group.note) node.appendChild(el('p', 'note', group.note));
            for (const raw of group.controls) node.appendChild(raw.custom ? customControls[raw.custom]() : buildControl(definitions.get(raw.key)));
            body.appendChild(node);
        }
        body.scrollTop = 0;
        for (const key of controls.keys()) syncControl(key);
        renderFlow(); renderProfiles(); renderShaders(); renderRife(); refreshChanges();
    }

    // ---- changes --------------------------------------------------------
    // What differs from before: values of mpv this panel wrote, against how
    // they were; and the frame-generation choice, against the client's setting.
    function changes() {
        const list = [];
        for (const key of touched) {
            const def = definitions.get(key);
            if (!def || !mirror.has(key) || !baseline.values.has(key)) continue;
            const before = baseline.values.get(key), now = mirror.get(key);
            if (!proSame(before, now)) list.push({key, def, before, now});
        }
        if (icc && !icc.overridden && iccChoice !== null && iccChoice !== icc.setting) {
            list.push({key: 'icc-mode', other: true, before: icc.setting, now: iccChoice,
                def: {title: '显示器 ICC 色彩配置', kind: 'choice', choices: ICC_MODES, save: 'setting', setting: ['video', 'iccProfile']}});
        }
        if (vfg?.configured) {
            const stored = String(vfg.setting), storedFactor = String(Number(vfg.settingFactor) || 0);
            if (String(vfg.mode) !== stored) {
                list.push({key: 'vfg-mode', other: true, before: stored, now: String(vfg.mode),
                    def: {title: 'VFG 档位', kind: 'choice', choices: VFG_MODES, save: 'setting', setting: ['video', 'vfg'],
                        store: text => VFG_SETTING[Number(text) + 1]}});
            }
            if (String(vfgFactor()) !== storedFactor) {
                list.push({key: 'vfg-factor', other: true, before: storedFactor, now: String(vfgFactor()),
                    def: {title: 'VFG 倍数', kind: 'choice', choices: VFG_FACTORS, save: 'setting', setting: ['video', 'vfgFactor'],
                        store: text => Number(text) ? String(Number(text)) : 'auto'}});
            }
        }
        if (native && nativeChoice) {
            if (nativeChoice.mode !== native.setting) {
                list.push({key: 'native-mode', other: true, before: native.setting, now: nativeChoice.mode,
                    def: {title: '系统原生补帧', kind: 'choice', choices: NATIVE_MODES, save: 'setting', setting: ['video', 'nativeInterpolation']}});
            }
            if (nativeChoice.target !== native.target) {
                list.push({key: 'native-target', other: true, before: native.target, now: nativeChoice.target,
                    def: {title: '原生补帧输出帧率', kind: 'choice', choices: NATIVE_TARGETS, save: 'setting', setting: ['video', 'nativeInterpolationTarget']}});
            }
        }
        for (const item of rtx ? RTX_SWITCHES : []) {
            const before = rtx[item.stored] ? 'yes' : 'no', now = rtx[item.field] ? 'yes' : 'no';
            if (before !== now) {
                list.push({key: item.key, other: true, before, now,
                    def: {title: item.title, kind: 'toggle', save: 'setting', setting: ['video', item.setting], store: text => text === 'yes'}});
            }
        }
        return list;
    }

    function refreshChanges() {
        const list = changes();
        const shaders = shadersDirty();
        const count = list.length + (shaders ? 1 : 0);
        for (const [key, control] of controls) {
            control.row.classList.toggle('dirty', list.some(change => change.key === key));
        }
        summary.textContent = count ? `已改动 ${count} 项：已经作用到画面，点「保存」后以后每次播放都生效。` : '没有改动。调整会立即作用到画面。';
        changeList.replaceChildren();
        for (const change of list) {
            const item = el('li');
            item.append(`${change.def.title}：${display(change.def, change.before)} → `, el('b', '', display(change.def, change.now)));
            changeList.appendChild(item);
        }
        if (shaders) {
            const item = el('li');
            item.append('着色器链：', el('b', '', enabledShaders().map(shaderTitle).join(' → ') || '无'));
            changeList.appendChild(item);
        }
        resetAll.disabled = saveNow.disabled = saveProfile.disabled = !count;
        // The two below work on mpv's own options only.
        copyConf.disabled = compareBaseline.disabled = !(shaders || list.some(change => !change.other));
    }

    resetAll.addEventListener('click', () => {
        const list = changes();
        for (const change of list.filter(item => !item.other)) {
            write(change.key, change.before);
            controls.get(change.key)?.set(change.before);
        }
        if (shadersDirty()) {
            shaderRows = baseline.shaders.map(path => ({path, enabled: true}));
            writeShaders();
        }
        if (list.some(change => change.key.startsWith('vfg-'))) applyVfg(Number(vfg.setting), Number(vfg.settingFactor) || 0);
        if (list.some(change => change.key === 'icc-mode')) applyIcc(icc.setting);
        if (list.some(change => change.key.startsWith('rtx-'))) applyRtx(rtx.settingVsr, rtx.settingHdr);
        if (list.some(change => change.key.startsWith('native-'))) { nativeChoice = null; applyNative(native.setting, native.target).then(() => { nativeChoice = null; refreshChanges(); }); }
        notify('已恢复到改动前。');
    });

    const confLines = () => {
        const lines = changes().filter(change => !change.other && (change.def.save === 'profile' || change.def.save === 'global'))
            .map(change => `${change.key}=${change.now}`);
        if (shadersDirty()) lines.push('glsl-shaders=', ...enabledShaders().map(path => `glsl-shader=${path}`));
        return lines;
    };
    copyConf.addEventListener('click', async () => {
        const text = [`# 专业模式导出的改动（基于档位 ${profile || '未知'}）`, ...confLines()].join('\n') + '\n';
        notify(await player.mpvConfCopyText(text) ? '已复制，可以粘贴到 mpv.conf 的档位里。' : '复制失败。', false);
    });

    // What a save will do with each change, as lists in a dialog.
    function describeSave(content, list, target) {
        const listing = (title, items) => {
            if (!items.length) return;
            content.appendChild(el('p', 'note', title));
            const ul = el('ul');
            for (const words of items) ul.appendChild(el('li', '', words));
            content.appendChild(ul);
        };
        const value = change => `${change.def.title} = ${display(change.def, change.now)}`;
        listing(target, [
            ...list.filter(change => change.def.save === 'profile').map(value),
            ...(shadersDirty() ? [`着色器链：${enabledShaders().map(shaderTitle).join(' → ') || '无'}`] : [])]);
        listing('写入 mpv.conf 的全局部分（对所有档位生效）：', list.filter(change => change.def.save === 'global').map(value));
        listing('写入客户端设置（「设置」里对应的项会跟着变）：', list.filter(change => change.def.save === 'setting').map(value));
        listing('只对本次播放有效，不会保存：', list.filter(change => !change.def.save).map(change => change.def.title));
    }
    const saveButton = (words, done, action) => [words, 'primary', async (close, button) => {
        button.disabled = true;
        try {
            await action();
            close();
            notify(done());
        } catch (error) {
            button.disabled = false;
            notify(String(error?.message || error), true);
        }
    }];

    saveNow.addEventListener('click', () => {
        const list = changes();
        const content = el('div');
        if (list.some(change => change.def.save === 'profile') || shadersDirty()) {
            content.appendChild(el('p', 'note', String(profile || '').startsWith(PRO_USER_PROFILE)
                ? `画质参数和着色器链写回档位「${profileTitle(profile)}」。`
                : `画质参数和着色器链写回内置档位「${profileTitle(profile)}」。改过的内置档位不再跟随客户端更新默认参数；想保留它原样，请改用「保存为新档位…」，以后也可以在「设置 → MPV 画质与插件」里恢复默认。`));
        }
        describeSave(content, list, `写入档位「${profileTitle(profile)}」：`);
        openSheet('保存', content, [['取消', '', close => close()],
            saveButton('保存', () => '已保存，以后每次播放都按这样来。', () => persist(list, null))]);
    });

    saveProfile.addEventListener('click', () => {
        const list = changes();
        const now = new Date();
        const pad = number => String(number).padStart(2, '0');
        const input = el('input');
        input.type = 'text';
        input.maxLength = 40;
        input.value = `专业模式 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const content = el('div');
        content.append(el('p', 'note', `在 mpv.conf 里新建一个自定义档位，继承「${profileTitle(profile)}」，写入下面的画质改动并切换过去。原有档位不会被修改；新档位以后可以在这里继续调整、保存或删除。`),
            el('p', 'note', '档位名称（显示在 UOSC 的滤镜菜单里）'), input);
        describeSave(content, list, '写入新档位：');
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        openSheet('保存为新档位', content, [['取消', '', close => close()],
            saveButton('保存并启用', () => `已保存为档位「${input.value.trim() || stamp}」并启用。`,
                () => persist(list, {name: `pro-${stamp}`, description: input.value.trim()}))]);
        input.focus();
        input.select();
    });

    // Writes the changes where each belongs: the profile (a new one when
    // `create` names it) and the global part of mpv.conf, then the client's
    // settings. Afterwards nothing counts as changed.
    async function persist(list, create) {
        const picture = list.filter(change => change.def.save === 'profile' || change.def.save === 'global');
        const chain = shadersDirty();
        const toFile = Boolean(create) || picture.length > 0 || chain;
        let section = profile;
        if (toFile) {
            if (!create && !section) throw new Error('还不知道当前档位，没有保存。');
            let user = (await player.mpvConfState()).user;
            const edit = async operation => {
                const result = await player.mpvConfEdit(user, operation);
                if (result.error) throw new Error(result.error);
                user = result.user;
                return result;
            };
            if (create) section = (await edit({type: 'newProfile', name: create.name, base: profile, description: create.description})).profile;
            for (const change of picture) {
                await edit({type: 'set', section: change.def.save === 'profile' ? section : 'default',
                    key: change.key, value: change.now, comment: `专业模式保存：${change.def.title}`});
            }
            if (chain) {
                const paths = enabledShaders();
                await edit({type: 'replaceShaders', section, paths: paths.map(path => path.slice(PRO_SHADER_PREFIX.length)),
                    titles: paths.map(shaderTitle)});
            }
            const saved = await player.mpvConfSave(user, false);
            if (!saved.saved) {
                const errors = (saved.analysis?.diagnostics || []).filter(item => item.severity === 'error').map(item => item.message);
                throw new Error(`没有保存：${errors.join('；') || 'mpv.conf 校验未通过'}`);
            }
        }
        for (const change of list.filter(item => item.def.save === 'setting')) {
            const [group, key] = change.def.setting;
            window.jmpInfo.settings[group][key] = change.def.store ? change.def.store(change.now) : change.now;
        }
        // What is on screen is what was saved: nothing counts as changed any
        // more, and neither does what the player reports while the profile is
        // applied again. (A setting written with the value mpv already has
        // makes mpv report nothing at all.)
        rebaselineUntil = performance.now() + 3000;
        if (toFile && !await player.proApplyProfile(section)) throw new Error('已写入 mpv.conf，但档位没能应用。');
        touched.clear();
        for (const [key, text] of mirror) baseline.values.set(key, text);
        shadersTouched = false;
        baseline.shaders = enabledShaders();
        await refreshVfg();
        await refreshIcc();
        await refreshRtx();
        refreshChanges();
    }

    // ---- compare --------------------------------------------------------
    // Held: the picture before the changes, or the untouched picture. The
    // writes go straight to the player; the panel keeps showing the changes.
    function beginHold(kind, button) {
        if (hold || !ready) return;
        hold = {kind, button, values: new Map(), shaders: enabledShaders(), restoreShaders: false};
        const put = (key, text) => {
            if (!mirror.has(key) || proSame(mirror.get(key), text)) return;
            hold.values.set(key, mirror.get(key));
            player.proSet(key, text);
        };
        if (kind === 'baseline') {
            for (const change of changes()) put(change.key, change.before);
            if (shadersDirty()) { hold.restoreShaders = true; player.proSetShaders(baseline.shaders); }
        } else {
            for (const [key, text] of Object.entries(PRO_RAW)) put(key, text);
            if (hold.shaders.length) { hold.restoreShaders = true; player.proSetShaders([]); }
        }
        button.classList.add('held');
    }
    function endHold() {
        if (!hold) return;
        for (const [key, text] of hold.values) {
            // Shaders may have to compile again before mpv reports these.
            pending.set(key, {text, at: performance.now(), life: 6000});
            player.proSet(key, text);
        }
        if (hold.restoreShaders) {
            shaderExpect = {list: hold.shaders, at: performance.now()};
            player.proSetShaders(hold.shaders);
        }
        hold.button.classList.remove('held');
        hold = null;
        // mpv reports the restored values a moment later; until then the
        // panel keeps what it showed.
        frozenUntil = performance.now() + 700;
        setTimeout(() => { if (!hold && latestOptions) applyOptions(latestOptions); }, 720);
    }
    for (const [button, kind] of [[compareBaseline, 'baseline'], [compareRaw, 'raw']]) {
        button.addEventListener('pointerdown', event => {
            if (button.disabled || event.button !== 0) return;
            button.setPointerCapture(event.pointerId);
            beginHold(kind, button);
        });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, endHold);
    }

    // ---- data from the player -------------------------------------------
    function applyOptions(data) {
        latestOptions = data;
        if (!ready || hold || performance.now() < frozenUntil) return;
        const values = data.values && !Array.isArray(data.values) ? data.values : {};
        // Published before the script took this panel's watch list.
        if (!('glsl-shaders' in values)) return;
        for (const key of definitions.keys()) {
            if (key in values) mirror.set(key, proText(values[key]));
        }
        const reported = (Array.isArray(values['glsl-shaders']) ? values['glsl-shaders'] : []).filter(Boolean).map(String);
        const now = performance.now();
        const fresh = profile === null || (data.profile || '') !== profile || now < rebaselineUntil;
        profile = data.profile || '';
        try { profiles = JSON.parse(data.profiles || '[]'); } catch (_) { profiles = []; }
        if (fresh) {
            touched.clear();
            shadersTouched = false;
            shaderExpect = null;
        }

        // Untouched values carry the baseline along; a touched one that is
        // back at its baseline is no longer a change.
        settlePending();
        for (const [key, text] of mirror) {
            if (touched.has(key) && !pending.has(key) && baseline.values.has(key) && proSame(text, baseline.values.get(key))) touched.delete(key);
            if (!touched.has(key)) baseline.values.set(key, text);
        }
        if (shaderExpect && (proSameList(reported, shaderExpect.list) || now - shaderExpect.at > 2500)) shaderExpect = null;
        if (!shaderExpect) {
            if (shadersTouched && proSameList(reported, baseline.shaders) && proSameList(enabledShaders(), reported)) shadersTouched = false;
            // A chain that differs from what this panel wrote was changed
            // elsewhere (a profile switch, uosc): take it as it is.
            if (!proSameList(reported, enabledShaders())) {
                shaderRows = reported.map(path => ({path, enabled: true}));
                shadersTouched = false;
            }
            if (!shadersTouched) baseline.shaders = reported.slice();
        }

        const style = values[PRO_DANMAKU + 'style'];
        const had = Boolean(danmaku);
        danmaku = style && typeof style === 'object' && !Array.isArray(style)
            ? {style, on: values[PRO_DANMAKU + 'danmaku-switch-on'] === true, loaded: values[PRO_DANMAKU + 'has-danmaku'] === true} : null;
        if (had !== Boolean(danmaku) && tab === 'danmaku') buildDanmaku();
        else syncDanmaku();

        for (const key of controls.keys()) syncControl(key);
        renderProfiles(); renderShaders(); renderFlow(); refreshChanges();
    }

    const ms = nanoseconds => `${(nanoseconds / 1e6).toFixed(2)} ms`;
    // What the interpolation generates against what the frame rates ask of it.
    const generationText = () => {
        const needed = (stats?.video?.output_fps || 0) - (stats?.video?.fps || 0);
        return `${generatedRate.toFixed(1)} 帧/秒${needed > 1 ? `（需要 ${needed.toFixed(1)}）` : ''}`;
    };
    const dynamicRange = params => params?.gamma === 'pq' ? 'HDR10' : params?.gamma === 'hlg' ? 'HLG' : 'SDR';
    const interpolationMs = () => load?.rife?.timingAvailable && Number.isFinite(Number(load.rife.p95Ms)) ? Number(load.rife.p95Ms) : 0;

    // The render steps under their stages. A stage with more than one step
    // opens on a click; rows are kept between updates so a tooltip can show.
    const stepRows = new Map();
    function renderPasses(passes, budget) {
        const stages = new Map(PRO_STAGES.map(([id, title]) => [id, {id, title, total: 0, steps: []}]));
        for (const pass of passes.fresh || []) {
            const stageId = proStageOf(pass.desc || '');
            const stage = stages.get(stageId);
            stage.total += pass.avg || 0;
            // A shader's passes are one step, under the shader's name.
            const shader = stageId === 'shader' ? /^\[([^\]]+)\]/.exec(pass.desc)[1] : null;
            const label = shader ? ([...shaderInfo.values()].find(info => info.path.split('/').pop().replace(/\.[^.]+$/, '') === shader)?.title || shader) : pass.desc;
            const known = stage.steps.find(step => step.label === label);
            if (known) { known.avg += pass.avg || 0; known.peak += pass.peak || 0; known.parts.push(pass.desc); }
            else stage.steps.push({label, avg: pass.avg || 0, peak: pass.peak || 0, parts: [pass.desc]});
        }
        const inference = interpolationMs();
        if (inference) {
            const motion = stages.get('motion');
            motion.total += inference * 1e6;
            motion.steps.push({label: `${load.rife.model || 'RIFE'} 推理（P95，不在 GPU 渲染里）`, avg: inference * 1e6, peak: inference * 1e6, parts: ['每对源帧的推理耗时']});
        }
        const nativeRun = nativeLive();
        if (nativeRun?.status === 'active' && Number(nativeRun.processP95Ms) > 0) {
            const motion = stages.get('motion');
            const value = Number(nativeRun.processP95Ms) * 1e6;
            motion.total += value;
            motion.steps.push({label: '系统原生补帧（每对源帧，P95，不在 GPU 渲染里）', avg: value, peak: value,
                parts: ['VideoToolbox 处理一对源帧的时间，在渲染之前运行']});
        }
        const generation = vfgLive();
        if (generation && generation.ms > 0 && !generation.disabled) {
            const motion = stages.get('motion');
            motion.total += generation.ms * 1e6;
            motion.steps.push({label: 'VFG 推理（每生成一帧，不在 GPU 渲染里）', avg: generation.ms * 1e6, peak: generation.ms * 1e6,
                parts: ['插件生成一帧新画面花的时间，在渲染之前运行']});
        }
        const shown = [...stages.values()].filter(stage => stage.steps.length);
        const top = Math.max(1, ...shown.map(stage => stage.total));
        const total = passes.fresh_total || 0;
        passTotal.textContent = `合计 ${(total / 1e6).toFixed(2)} / 预算 ${ms(budget)}`;
        passTotal.className = total > budget ? 'over' : '';
        passList.classList.toggle('over', total > budget);

        const wanted = [];
        const place = (key, className, caret, label, value, tip) => {
            let row = stepRows.get(key);
            if (!row) {
                const node = el('button', '');
                row = {node, caret: el('u'), label: el('span'), fill: el('b'), value: el('em')};
                const track = el('i');
                track.appendChild(row.fill);
                node.append(row.caret, row.label, track, row.value);
                node.addEventListener('click', () => {
                    if (!node.dataset.stage) return;
                    if (!openStages.delete(node.dataset.stage)) openStages.add(node.dataset.stage);
                    if (stats) renderPasses(stats.passes || {}, 1e9 / (stats.video?.output_fps || stats.video?.fps || 24));
                });
                stepRows.set(key, row);
            }
            row.node.className = `step ${className}`;
            row.caret.textContent = caret;
            row.label.textContent = label;
            row.fill.style.width = `${Math.max(2, value / top * 100)}%`;
            row.value.textContent = ms(value);
            row.node.title = tip;
            wanted.push(row.node);
            return row.node;
        };
        for (const stage of shown) {
            const expandable = stage.steps.length > 1 || stage.id === 'shader' || stage.id === 'motion';
            const open = expandable && openStages.has(stage.id);
            const node = place(stage.id, expandable ? (open ? 'open' : 'closed') : '', expandable ? (open ? '▾' : '▸') : '',
                expandable ? `${stage.title}（${stage.steps.length}）` : stage.title, stage.total,
                expandable ? '点击展开或收起这一步里的各项' : stage.steps[0].parts.join('\n'));
            node.dataset.stage = expandable ? stage.id : '';
            if (!open) continue;
            for (const step of stage.steps) {
                place(`${stage.id}/${step.label}`, 'sub', '', step.label, step.avg, `${step.parts.join('\n')}\n峰值 ${ms(step.peak)}`).dataset.stage = '';
            }
        }
        const generating = (stats?.filters || []).some(item => item.label === 'tigerest-vfg' && item.enabled !== false);
        passNote.textContent = generatedRate !== null && !inference ? `补帧在渲染之前运行，不计入上面的耗时：生成 ${generationText()}`
            : generating ? 'VFG 在渲染之前运行，推理耗时列在「补帧」里，不计入合计。' : '';
        passNote.title = passNote.textContent;
        if (!wanted.length) {
            passList.replaceChildren(el('p', 'note', '还没有渲染计时（暂停时不产生新帧）。'));
        } else if (wanted.length !== passList.children.length || wanted.some((node, index) => passList.children[index] !== node)) {
            passList.replaceChildren(...wanted);
        }
    }

    // The rings: each place a frame can be lost against what it has to do.
    function renderLoad() {
        const video = stats?.video || {};
        const output = video.output_fps || video.fps || 24;
        const interval = 1000 / output;                         // ms each frame has
        const level = (value, warm, hot) => (value >= hot ? 'hot' : value >= warm ? 'warm' : '');
        const share = value => `${Math.round(value * 100)}%`;

        // Rendering: GPU time for a new frame against the time a frame has.
        const render = (stats?.passes?.fresh_total || 0) / 1e6;
        const rendering = render / interval;
        gauges.render.set(rendering, share(rendering),
            `GPU 渲染一帧 ${render.toFixed(2)} ms，每帧有 ${interval.toFixed(2)} ms。\n接近 100% 时渲染跟不上，开始丢帧；各步骤的耗时在左边「GPU 渲染耗时」里。`,
            level(rendering, 0.7, 0.9));

        // Interpolation: time to generate against the pace it has to keep.
        const needed = Math.max(0, (video.output_fps || 0) - (video.fps || 0));
        const live = vfgLive();
        const generating = (stats?.filters || []).some(item => item.label === 'tigerest-vfg' && item.enabled !== false);
        const inference = interpolationMs();
        let motion = {load: 0, words: '—', hint: '没有在补帧。', state: ''};
        const nativeNow = nativeLive();
        if (nativeNow?.status === 'active' && Number(nativeNow.processP95Ms) > 0 && Number(nativeNow.sourceFps) > 0) {
            const value = Number(nativeNow.processP95Ms) * Number(nativeNow.sourceFps) / 1000;
            motion = {load: value, words: share(value), state: level(value, 0.7, 0.9),
                hint: `系统原生补帧处理一对源帧 ${Number(nativeNow.processP95Ms).toFixed(1)} ms（P95），每秒有 ${Number(nativeNow.sourceFps).toFixed(2)} 对。\n接近 100% 时跟不上播放。`};
        } else if (nativeNow && nativeNow.status !== 'active') {
            motion = {load: 0, words: '—', hint: `系统原生补帧：${NATIVE_STATUS[nativeNow.status] || nativeNow.status}`, state: ''};
        } else if (generating && live?.disabled) {
            motion = {load: 1, words: '停', hint: `VFG 已停止生成（${live.disabled}），现在只是重复源帧。`, state: 'hot'};
        } else if (generating && live && live.ms > 0 && needed > 0) {
            const value = live.ms * needed / 1000;
            motion = {load: value, words: share(value), state: level(value, 0.7, 0.9),
                hint: `VFG 生成一帧 ${Number(live.ms).toFixed(1)} ms，每秒要生成 ${needed.toFixed(1)} 帧（实际 ${Number(live.generated_fps).toFixed(1)}）。\n按一次只生成一帧估算；接近 100% 时生成跟不上，开始丢帧。`};
        } else if (generating) {
            motion = {load: 0, words: '…', hint: 'VFG 正在启动，还没有报告耗时。', state: ''};
        } else if (inference && needed > 0) {
            const value = inference * needed / 1000;
            motion = {load: value, words: share(value), state: level(value, 0.7, 0.9),
                hint: `${load.rife.model || 'RIFE'} 推理一对帧 ${inference.toFixed(1)} ms（P95），每秒要生成 ${needed.toFixed(1)} 帧。`};
        } else if (generatedRate !== null && needed > 1) {
            motion = generatedRate < needed * 0.97
                ? {load: 1, words: share(generatedRate / needed), state: 'hot',
                    hint: `RIFE 每秒只生成 ${generatedRate.toFixed(1)} 帧，需要 ${needed.toFixed(1)}：生成跟不上。`}
                : {load: 0, words: '够', state: '',
                    hint: `RIFE 每秒生成 ${generatedRate.toFixed(1)} 帧，够用（需要 ${needed.toFixed(1)}）。\nTensorRT 版不报告单帧耗时，所以这里没有负载比例。`};
        }
        gauges.motion.set(motion.load, motion.words, motion.hint, motion.state);

        // Presentation: the refreshes the screen did not get.
        if (pace.missed === null) {
            gauges.present.set(0, '—', '只有 display-* 同步模式统计屏幕的每次刷新；当前同步模式下没有这个数字。', '');
        } else {
            const screen = stats?.display || {};
            gauges.present.set(pace.missed / 0.15, `${(pace.missed * 100).toFixed(pace.missed < 0.0995 ? 1 : 0)}%`,
                `屏幕每秒刷新 ${Number(screen.fps).toFixed(0)} 次，画面实际送出 ${Number(screen.measured).toFixed(1)} 次：${(pace.missed * 100).toFixed(1)}% 的刷新没赶上。\n画面要按屏幕的每次刷新送出；视频和面板一起由系统合成时，显卡再忙一点就会掉拍，掉得多了播放器就丢帧。`,
                level(pace.missed, 0.02, 0.05));
        }

        const machine = (ring, value, own, what, extra) => ring.set(Number(value) / 100,
            Number.isFinite(Number(value)) ? `${Math.round(value)}%` : '—',
            `整机${what}占用${Number.isFinite(Number(own)) ? `；其中播放器进程 ${Math.round(own)}%` : ''}。${extra || ''}`,
            level(Number(value) / 100 || 0, 0.8, 0.95));
        // Windows counts some inference work as rendering; the split is shown where it has one.
        machine(gauges.gpu, load?.gpu, load?.gpuSelf, '显卡', Number(load?.gpuCompute) >= 1
            ? `\n渲染 ${Math.round(load.gpuRender)}% + 计算（补帧推理等）${Math.round(load.gpuCompute)}%，两者共用显卡的运算核心。` : '');
        machine(gauges.cpu, load?.cpu, load?.cpuSelf, '处理器');

        // Display sync that drifted earlier keeps this and later items on the
        // audio clock until a mode is chosen again; the control says so.
        const syncRow = controls.get('video-sync')?.row;
        const fallback = syncRow?.querySelector('.fallback');
        if (syncRow && load?.syncFallback && !fallback) {
            syncRow.appendChild(el('div', 'hint fallback', '客户端之前检测到显示同步下音画持续偏差，已临时改用音频时钟，之后打开的视频也是。在这里重新选一次同步模式就恢复按设置来。'));
        } else if (fallback && !load?.syncFallback) {
            fallback.remove();
        }

        gauges.drops.set(pace.dropRate / (output * 0.1), pace.dropRate >= 0.05 ? `${pace.dropRate.toFixed(1)}/s` : '0',
            `最近三秒平均每秒丢 ${pace.dropRate.toFixed(1)} 帧（输出丢帧和解码丢帧合计），占输出帧率的 ${(pace.dropRate / output * 100).toFixed(1)}%。`,
            level(pace.dropRate, 0.5, 2));

        // Where the frames go: the ring over its limit, the worst one first.
        const suspects = [];
        if (motion.state === 'hot' || motion.load >= 0.9) suspects.push(['补帧', 1 + motion.load]);
        if (rendering >= 0.9) suspects.push(['渲染', 1 + rendering]);
        if (pace.missed !== null && pace.missed >= 0.02) suspects.push(['呈现', 1 + pace.missed * 10]);
        if (pace.decoderRate >= 0.5) suspects.push(['解码', 1.5]);
        if (stats?.cache?.buffering) suspects.push(['缓冲', 4]);
        suspects.sort((a, b) => b[1] - a[1]);
        const dropping = pace.dropRate >= 0.5;
        loadVerdict.className = dropping ? 'hot' : '';
        loadVerdict.textContent = !dropping ? '没有丢帧' : suspects.length ? `丢帧出在${suspects[0][0]}` : '丢帧不在这几环';
        const hint = !dropping ? '最近三秒没有丢帧。丢帧时，这里写出问题出在哪一环，对应的环会变红。'
            : suspects.length ? `正在丢帧，超出限度的环节：${suspects.map(item => item[0]).join('、')}。`
            : '正在丢帧，但补帧、渲染和呈现都还有余量：多半是一时的卡顿（跳转、切换窗口、别的程序抢占显卡）。';
        if (loadHead.dataset.tip !== hint) loadHead.title = hint;
    }

    function applyStats(data) {
        if (!active) return;
        stats = data;
        const video = data.video || {}, output = data.output || {}, screen = data.display || {};
        const frames = data.frames || {}, cache = data.cache || {}, audio = data.audio || {}, passes = data.passes || {};
        const budget = 1e9 / (video.output_fps || video.fps || 24);
        history.push({render: passes.fresh_total || 0, budget});
        if (history.length > PRO_HISTORY) history.shift();

        name.textContent = data.title || '';
        chips.replaceChildren();
        const chip = text => chips.appendChild(el('span', 'chip', text));
        const pictureW = output.w - (output.ml || 0) - (output.mr || 0), pictureH = output.h - (output.mt || 0) - (output.mb || 0);
        if (video.h) chip(`${video.h}p ${video.fps ? video.fps.toFixed(2) : ''} · ${dynamicRange(video)}`);
        if (output.w) chip(`画面 ${pictureW}×${pictureH}`);
        if (data.pause) chip('已暂停');

        signalCard.replaceChildren(el('h4', '', '信号'));
        const signal = el('dl', 'rows');
        setRows(signal, [
            ['输入', video.w ? `${video.w}×${video.h} · ${(video.fps || 0).toFixed(3)} · ${video.codec || ''}` : '—'],
            ['解码', `${video.hwdec && video.hwdec !== 'no' ? video.hwdec : '软解'} · ${video.hw_pixelformat || video.pixelformat || ''}`],
            ['画面', output.w ? `${pictureW}×${pictureH}（窗口 ${output.w}×${output.h}）` : '—'],
            ['色彩', `${dynamicRange(video)} ${video.primaries || ''} → ${dynamicRange(output)} ${output.primaries || ''}`],
            ['显示', `${(screen.fps || 0).toFixed(2)} Hz`],
            ['同步', screen.sync || '—'],
            ['缓冲', `${(cache.seconds || 0).toFixed(1)} s · ${((cache.speed || 0) / 1048576).toFixed(1)} MB/s${cache.buffering ? ' · 缓冲中' : ''}`],
            ['音频', `${audio.codec || '—'} ${audio.channels || ''} → ${audio.out_channels || ''} ${audio.device || ''}`]
        ]);
        signalCard.appendChild(signal);

        renderPasses(passes, budget);

        // Frames lost a second over the last three seconds, and the refreshes
        // the screen did not get. The measured refresh rate means something
        // only while a display-sync mode counts refreshes; under audio it
        // goes stale.
        const last = paceSamples[paceSamples.length - 1];
        if (last && ((frames.dropped || 0) < last.dropped || (frames.decoder_dropped || 0) < last.decoder || data.time < last.at)) paceSamples.length = 0;
        paceSamples.push({at: data.time, dropped: frames.dropped || 0, decoder: frames.decoder_dropped || 0});
        if (paceSamples.length > 7) paceSamples.shift();
        const first = paceSamples[0], span = data.time - first.at;
        const settled = !data.pause && span > 0.9;
        const decoderRate = settled ? ((frames.decoder_dropped || 0) - first.decoder) / span : 0;
        const dropRate = settled ? ((frames.dropped || 0) - first.dropped) / span + decoderRate : 0;
        const counted = String(screen.sync || '').startsWith('display-') && screen.sync_active && screen.fps > 0 && screen.measured > 0;
        const missed = counted ? Math.max(0, 1 - screen.measured / screen.fps) : null;
        pace = {dropRate, decoderRate, missed};
        const outputRate = video.output_fps || video.fps || 0;
        const shown = Math.max(0, outputRate - dropRate);
        if (!data.pause) {
            rateHistory.push({shown, refresh: counted ? screen.measured : NaN});
            if (rateHistory.length > PRO_HISTORY) rateHistory.shift();
        }

        paceNote.textContent = `渲染峰值 ${ms(Math.max(...history.map(sample => sample.render)))}`;
        const state = (value, warm, hot) => (value >= hot ? 'hot' : value >= warm ? 'warm' : '');
        paceShown.set(rateHistory.map(sample => sample.shown), outputRate || 24, shown.toFixed(2), 'fps', `应为 ${outputRate.toFixed(2)}`,
            dropRate >= 0.5 ? `每秒丢 ${dropRate.toFixed(1)} 帧` : '没有丢帧', state(dropRate, 0.5, 2),
            '每秒真正送到屏幕的视频帧数：滤镜后的帧率减去丢掉的帧。\n曲线是最近一分钟，虚线是应有的帧率。');
        paceRefresh.set(rateHistory.map(sample => sample.refresh), screen.fps || 60, counted ? screen.measured.toFixed(1) : '—',
            'Hz', `屏幕 ${(screen.fps || 0).toFixed(0)}`,
            !counted ? `${screen.sync || '当前模式'} 下不统计` : missed >= 0.005 ? `掉拍 ${(missed * 100).toFixed(1)}%` : '没有掉拍',
            counted ? state(missed, 0.02, 0.05) : '',
            '画面每秒实际交给屏幕多少次，对比屏幕的刷新率。\n只有 display-* 同步模式统计它；曲线是最近一分钟，虚线是屏幕刷新率。');
        setRows(paceRows, [
            ['丢帧 / 解码丢帧', `${frames.dropped || 0} / ${frames.decoder_dropped || 0}`],
            ['延迟帧 / 错时帧', `${frames.delayed || 0} / ${frames.mistimed || 0}`],
            ['音画差', `${((data.sync?.av || 0) * 1000).toFixed(1)} ms`]
        ]);
        if (!paceHead.isConnected) paceCard.replaceChildren(paceHead, paceColumns, paceRows);

        setRows(audioRows, [
            ['编码', audio.codec || '—'],
            ['源', `${audio.samplerate || '—'} Hz · ${audio.channels || '—'} · ${audio.format || ''}`],
            ['输出', `${audio.out_samplerate || '—'} Hz · ${audio.out_channels || '—'} · ${audio.out_format || ''}`],
            ['设备', audio.device || '—']
        ]);
        renderFlow(); renderRife(); renderVfg(); renderLoad();
    }

    function applyLoad(data) {
        if (!active) return;
        load = data;
        const rife = data.rife, now = performance.now();
        const interpolating = rife && Number(rife.processedPairs) > 0 && Number.isFinite(Number(rife.generatedFrames));
        if (interpolating && generated && generated.generation === rife.generation && rife.generatedFrames >= generated.frames) {
            const rate = (rife.generatedFrames - generated.frames) / ((now - generated.at) / 1000);
            // Samples are a second apart and frames arrive in batches: smooth it.
            generatedRate = generatedRate === null ? rate : generatedRate * 0.6 + rate * 0.4;
        } else {
            generatedRate = null;
        }
        generated = interpolating ? {frames: rife.generatedFrames, at: now, generation: rife.generation} : null;
        // The filter may have been started by the setting, or stopped with the item.
        if (vfg?.configured) refreshVfg();
        // The reasons follow the video and the screen (size, HDR, the driver's answer).
        if (rtx) refreshRtx();
        if (native) renderNative();
        renderRife(); renderLoad();
        if (stats) renderPasses(stats.passes || {}, 1e9 / (stats.video?.output_fps || stats.video?.fps || 24));
    }

    // ---- entering and leaving -------------------------------------------
    // What the data script mirrors for this panel.
    const watchList = () => ['glsl-shaders', ...definitions.keys(),
        PRO_DANMAKU + 'style', PRO_DANMAKU + 'danmaku-switch-on', PRO_DANMAKU + 'has-danmaku'];
    const reportStage = () => {
        if (!active) return;
        const rect = stage.getBoundingClientRect();
        player.setProVideoRect(Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height));
    };
    const stageObserver = new ResizeObserver(reportStage);

    async function enter() {
        if (active) return;
        active = true;
        shaderExpect = null; hold = null; latestOptions = null; stats = null; load = null; danmaku = null; profile = null;
        generated = null; generatedRate = null;
        mirror.clear(); pending.clear(); touched.clear(); baseline.values.clear(); baseline.shaders = [];
        history.length = 0; shaderRows = []; shadersTouched = false; frozenUntil = 0; rebaselineUntil = 0;
        paceSamples.length = 0; rateHistory.length = 0; pace = {dropRate: 0, decoderRate: 0, missed: null}; vfgFactorChoice = null; rtxWanted = null;
        hideTip();
        // Emby's page stays loaded underneath; it must not take focus or keys.
        inerted = [...document.body.children].filter(node => node !== host && !node.inert);
        for (const node of inerted) node.inert = true;
        controls.clear();
        definitions.clear();
        stepRows.clear();
        closeSheet?.();
        tabs.replaceChildren();
        body.replaceChildren(el('p', 'note', '正在读取播放器配置…'));
        name.textContent = '';
        chips.replaceChildren();
        for (const card of [signalCard, paceCard]) card.replaceChildren();
        passList.replaceChildren();
        passTotal.textContent = passNote.textContent = '';
        renderLoad();
        refreshChanges();
        document.body.appendChild(host);
        stageObserver.observe(stage);
        window.addEventListener('resize', reportStage);
        reportStage();
        try {
            conf = await player.mpvConfState();
        } catch (error) {
            console.warn('[pro mode] mpv.conf state unavailable', error);
            conf = {};
        }
        if (!active) return;
        catalog = new Map((conf.catalog?.options || []).map(option => [option.key, option]));
        shaderInfo = new Map((conf.shaders?.shaders || []).map(shader => [shader.path, shader]));
        await refreshVfg();
        iccChoice = null;
        await refreshIcc();
        await refreshRtx();
        nativeChoice = null;
        await refreshNative();
        if (!active) return;
        ready = true;
        buildTabs();
        player.proWatch(watchList());
        if (latestOptions) applyOptions(latestOptions);
    }

    function exit() {
        if (!active) return;
        active = false;
        ready = false;
        endHold();
        closeSheet?.();
        stageObserver.disconnect();
        window.removeEventListener('resize', reportStage);
        for (const node of inerted) node.inert = false;
        inerted = [];
        host.remove();
    }

    leave.addEventListener('click', () => player.setProMode(false));
    // A click here gives the page the keyboard; the pointer over the video
    // returns it to mpv (the native side watches for that).
    host.addEventListener('pointerdown', () => player.proFocus(false), true);
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu']) {
        host.addEventListener(type, event => event.stopPropagation());
    }

    // While the mode is on, no key reaches the page underneath.
    const onKey = event => {
        if (!active) return;
        event.stopImmediatePropagation();
        const target = event.composedPath()[0];
        const inside = target instanceof Node && shadow.contains(target);
        if (event.type !== 'keydown') { if (!inside) event.preventDefault(); return; }
        if (event.key === 'F2' || event.key === 'Escape') {
            event.preventDefault();
            if (closeSheet) closeSheet();
            else player.setProMode(false);
        } else if (event.key === ' ' && !(inside && target.matches('input, select, button'))) {
            event.preventDefault();
            player.proTogglePause();
        } else if (!inside) {
            event.preventDefault();
        }
    };

    player.proModeChanged.connect(on => (on ? enter() : exit()));
    player.proOptions.connect(applyOptions);
    player.proStats.connect(applyStats);
    player.proLoad?.connect(applyLoad);
    player.proSetFailed.connect((key, message) => {
        if (key === 'vfg') {
            notify(`VFG 没有启动：${message}`, true);
            refreshVfg();
            return;
        }
        pending.delete(key);
        notify(`「${definitions.get(key)?.title || key}」没有生效：${message}`, true);
        syncControl(key);
    });
    Promise.resolve(player.proModeActive()).then(on => { if (on) enter(); });

    return {
        host,
        onKey,
        isActive: () => active,
        changes: () => changes().map(change => ({key: change.key, before: change.before, now: change.now})),
        shaders: () => shaderRows.map(row => Object.assign({}, row)),
        load: () => load
    };
}

// Added while the document is created, so these run ahead of the listeners
// Emby's own scripts add to the window later.
for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(type, event => window.tigerestProMode?.onKey(event), true);
}

if (window.apiPromise) {
    window.apiPromise.then(api => {
        // Older native shells and other platforms have no professional mode.
        if (!api?.player?.proModeChanged || typeof api.player.setProMode !== 'function') return;
        window.tigerestProMode = createProMode(api.player);
    });
}
