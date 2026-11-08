// Settings-page editor for the single mpv.conf (Windows and macOS desktop).
// The native player owns parsing, validation and saving; this file renders
// the form, the line editor with its "+" gutter, diagnostics and dialogs.

const MPVCONF_DRAFT_KEY = 'tigerestMpvConfDraft';
const MPVCONF_PRESETS = {
    'tigerest-default': 'default',
    'tigerest-liveaction': 'liveaction',
    'tigerest-aggressive-test': 'aggressive'
};

function mpvConfPresetToProfile(preset) {
    if (String(preset || '').startsWith('tigerest-user-')) return preset;
    return Object.keys(MPVCONF_PRESETS).find(key => MPVCONF_PRESETS[key] === preset) || 'tigerest-default';
}

function mpvConfProfileToPreset(profile) {
    return MPVCONF_PRESETS[profile] || profile;
}

// Line diff (longest common subsequence) for the paste and default-update
// dialogs. Files are a few hundred lines, so the quadratic table is fine.
function mpvConfDiff(before, after) {
    const a = String(before || '').replace(/\n$/, '').split('\n');
    const b = String(after || '').replace(/\n$/, '').split('\n');
    const rows = a.length + 1, cols = b.length + 1;
    const table = new Uint16Array(rows * cols);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1
                : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
        }
    }
    const result = [];
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) { result.push({type: ' ', text: a[i]}); i++; j++; }
        else if (j < b.length && (i >= a.length || table[i * cols + j + 1] >= table[(i + 1) * cols + j])) { result.push({type: '+', text: b[j]}); j++; }
        else { result.push({type: '-', text: a[i]}); i++; }
    }
    return result;
}

const MPVCONF_FILTERS = [
    ['bwdif', '去隔行（bwdif，质量较好）', 'mode=send_frame'],
    ['yadif', '去隔行（yadif，开销低）', 'mode=send_frame'],
    ['hqdn3d', '降噪（hqdn3d，轻量时域降噪）', ''],
    ['nlmeans', '降噪（nlmeans，效果强、开销高）', 's=2'],
    ['cas', '锐化（CAS 对比度自适应）', 'strength=0.4'],
    ['unsharp', '锐化（unsharp 反锐化掩模）', '5:5:0.6'],
    ['eq', '亮度 / 对比度 / 饱和度 / 伽马', 'gamma=1.1'],
    ['crop', '裁切画面', 'w=iw:h=ih-140'],
    ['hflip', '水平翻转', ''],
    ['vflip', '垂直翻转', ''],
    ['rotate', '旋转', 'angle=PI/2'],
    ['fps', '改变帧率（会与 RIFE 冲突）', 'fps=60'],
    ['minterpolate', 'FFmpeg 运动插帧（会与 RIFE 冲突）', 'fps=60']
];

function createMpvConfEditor({element, player, settings, saveSetting, notify}) {
    const node = element('div', 'tgs-mpvconf');
    const style = document.createElement('style');
    style.textContent = `
        .tgs-mpvconf { display: grid; gap: 20px; margin-top: 8px; }
        .tgs-mpvconf h3 { margin: 8px 0 0; font-size: 18px; font-weight: 400; }
        .tgs-mpvconf .tgs-conf-note { color: #aaa; font-size: 13px; line-height: 1.6; }
        .tgs-conf-help { padding: 4px 16px 10px; color: #bbb; font-size: 13px; line-height: 1.7; background: #1b1b1b; border: 1px solid #333; border-radius: 3px; }
        .tgs-conf-help summary { padding: 8px 0; color: #ddd; font-size: 14px; cursor: pointer; }
        .tgs-conf-help h4 { margin: 12px 0 4px; color: #e6c27a; font-size: 14px; font-weight: 500; }
        .tgs-conf-help ul { margin: 0; padding-left: 20px; }
        .tgs-conf-help li { margin: 3px 0; overflow-wrap: anywhere; }
        .tgs-conf-form { display: grid; gap: 18px; }
        .tgs-conf-field { display: grid; gap: 6px; }
        .tgs-conf-field-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; font-size: 15px; }
        .tgs-conf-source { color: #aaa; font-size: 11px; }
        .tgs-conf-source.own { color: #c7aa68; }
        .tgs-conf-inline { display: flex; gap: 8px; align-items: center; }
        .tgs-conf-inline .tgs-control { flex: 1; }
        .tgs-conf-link { padding: 4px 8px; color: #ffbe38; background: none; border: 0; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
        .tgs-conf-toolbar { display: flex; flex-wrap: wrap; gap: 10px; }
        .tgs-conf-toolbar .tgs-action { min-height: 38px; padding: 8px 14px; font-size: 13px; }
        .tgs-conf-editor { border: 1px solid #3a3a3a; border-radius: 3px; background: #191919; overflow: hidden; }
        .tgs-conf-managed { margin: 0; }
        .tgs-conf-managed summary { padding: 8px 12px; color: #999; font-size: 12px; cursor: pointer; background: #1e1e1e; }
        .tgs-conf-managed pre { margin: 0; padding: 6px 12px 10px 68px; color: #777; font: 13px/20px Consolas, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
        .tgs-conf-scroll { max-height: 62vh; overflow: hidden auto; border-top: 1px solid #2c2c2c; border-bottom: 1px solid #2c2c2c; }
        .tgs-conf-code { position: relative; padding: 6px 0; background: linear-gradient(90deg, #1e1e1e 56px, transparent 56px); }
        .tgs-conf-grid { display: grid; grid-template-columns: 56px minmax(0, 1fr); }
        .tgs-conf-grid .num { position: relative; padding-right: 8px; color: #666; font: 12px/20px Consolas, Menlo, monospace; text-align: right; user-select: none; }
        .tgs-conf-grid .num[data-mark]::before { content: ''; position: absolute; left: 6px; top: 7px; width: 7px; height: 7px; border-radius: 50%; }
        .tgs-conf-grid .num[data-mark="error"]::before { background: #e5534b; }
        .tgs-conf-grid .num[data-mark="warning"]::before { background: #d29922; }
        .tgs-conf-grid .num[data-mark="info"]::before { background: #6e7681; }
        .tgs-conf-plus { position: absolute; top: 0; left: 14px; width: 18px; height: 18px; margin-top: -9px; padding: 0; z-index: 2;
            border: 0; border-radius: 50%; color: #141414; background: #ffbe38; font: 600 14px/18px system-ui; cursor: pointer; opacity: .18; }
        .tgs-conf-plus.last { top: 100%; }
        .tgs-conf-plus:hover, .tgs-conf-plus:focus-visible { opacity: 1; }
        .tgs-conf-row, .tgs-conf-text { box-sizing: border-box; padding: 0 12px; font: 13px/20px Consolas, Menlo, monospace;
            letter-spacing: normal; word-spacing: normal; text-indent: 0; tab-size: 4; white-space: pre-wrap; overflow-wrap: anywhere; }
        .tgs-conf-row { min-height: 20px; color: transparent; }
        .tgs-conf-row.error { background: #e5534b2e; }
        .tgs-conf-row.warning { background: #d2992224; }
        .tgs-conf-row.suspended { background: #bb800926; }
        .tgs-conf-row.ignored { background: #6e768130; }
        .tgs-conf-row.flash { background: #ffbe3840; }
        .tgs-conf-text { position: absolute; top: 6px; left: 56px; width: calc(100% - 56px); height: calc(100% - 12px); margin: 0;
            border: 0; outline: none; resize: none; overflow: hidden; color: #ddd; background: transparent; caret-color: #ffbe38; }
        .tgs-conf-status { color: #aaa; font-size: 13px; }
        .tgs-conf-status.error { color: #ff8b84; }
        .tgs-conf-diagnostics { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; font-size: 13px; line-height: 1.5; }
        .tgs-conf-diagnostics button { padding: 2px 0; color: inherit; background: none; border: 0; font: inherit; text-align: left; cursor: pointer; }
        .tgs-conf-diagnostics .error { color: #ff8b84; }
        .tgs-conf-diagnostics .warning { color: #e3b341; }
        .tgs-conf-diagnostics .info { color: #9aa4ae; }
        .tgs-conf-library table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 1.5; }
        .tgs-conf-library th, .tgs-conf-library td { padding: 6px 8px; border-bottom: 1px solid #2a2a2a; text-align: left; vertical-align: top; }
        .tgs-conf-library th { color: #aaa; font-weight: 400; position: sticky; top: 0; background: #1b1b1b; }
        .tgs-conf-library .wrap { max-height: 60vh; overflow: auto; }
        .tgs-conf-library summary { cursor: pointer; padding: 6px 0; }
        .tgs-conf-modal { position: fixed; inset: 0; z-index: 100001; display: flex; align-items: center; justify-content: center; background: #000a; }
        .tgs-conf-dialog { box-sizing: border-box; width: min(860px, calc(100vw - 32px)); max-height: calc(100vh - 48px); display: grid;
            grid-template-rows: auto minmax(0, 1fr) auto; background: #1d1d1d; color: #eee; border: 1px solid #444; border-radius: 4px; }
        .tgs-conf-dialog header { padding: 16px 20px 8px; font-size: 18px; }
        .tgs-conf-dialog .body { padding: 8px 20px; overflow: auto; font-size: 14px; line-height: 1.6; }
        .tgs-conf-dialog footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; padding: 12px 20px 16px; }
        .tgs-conf-dialog .primary { color: #171717; background: #ffbe38; }
        .tgs-conf-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
        .tgs-conf-tabs button { padding: 6px 12px; color: #ccc; background: #2a2a2a; border: 0; border-radius: 3px; font: inherit; font-size: 13px; cursor: pointer; }
        .tgs-conf-tabs button[aria-selected="true"] { color: #171717; background: #ffbe38; }
        .tgs-conf-pick { display: grid; gap: 4px; padding: 10px 0; border-bottom: 1px solid #2c2c2c; }
        .tgs-conf-pick-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
        .tgs-conf-pick .meta { color: #999; font-size: 12px; }
        .tgs-conf-pick.disabled { opacity: .55; }
        .tgs-conf-diff { margin: 0; font: 12px/18px Consolas, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; overflow: auto; max-height: 50vh; }
        .tgs-conf-diff .add { color: #7ee787; background: #2ea04326; display: block; }
        .tgs-conf-diff .del { color: #ffa198; background: #f8514926; display: block; }
    `;
    document.head.appendChild(style);

    let state = null, analysis = null, user = '', savedUser = '', section = 'tigerest-default';
    let disposed = false, timer = null, generation = 0, pendingEdit = Promise.resolve();
    const listeners = [];

    const button = (label, className = 'tgs-action', handler = null) => {
        const node = element('button', className, label);
        node.type = 'button';
        if (handler) node.addEventListener('click', handler);
        return node;
    };

    // ---- layout ----
    const intro = element('div', 'tgs-callout');
    const presetRow = element('div', 'tgs-setting');
    const presetLabel = element('label', 'tgs-setting-title inputLabel', '画质预设（下面的画质参数编辑这一档）');
    const presetSelect = element('select', 'tgs-control');
    presetSelect.id = 'tgs-mpvconf-preset';
    presetLabel.htmlFor = presetSelect.id;
    presetRow.append(presetLabel, presetSelect, element('div', 'tgs-help fieldDescription',
        '播放中通过 uosc「滤镜」按钮或 Alt+1/2/3 切换时，这里会同步切到同一档。'));

    const qualityTitle = element('h3', '', '画质参数');
    const qualityForm = element('div', 'tgs-conf-form');
    const globalTitle = element('h3', '', '播放、缓存与字幕（全局）');
    const globalForm = element('div', 'tgs-conf-form');

    const editorTitle = element('h3', '', 'mpv.conf');
    const editorNote = element('details', 'tgs-conf-help');
    editorNote.open = true;
    const toolbar = element('div', 'tgs-conf-toolbar');
    const editor = element('div', 'tgs-conf-editor');
    const headDetails = element('details', 'tgs-conf-managed');
    headDetails.append(element('summary', '', '头部管理区（只读，由软件维护；点击折叠）'), element('pre'));
    // Shown open: the whole chain, including what the client decides, is
    // part of the file the user (or their AI) reads.
    headDetails.open = true;
    const tailDetails = element('details', 'tgs-conf-managed');
    tailDetails.open = true;
    tailDetails.append(element('summary', '', '尾部管理区（只读：由软件和其他设置页决定的配置，及播放时软件执行的动作；点击折叠）'), element('pre'));
    // Long lines wrap instead of scrolling sideways. Each line is a grid row of
    // its number and an invisible copy of its text, which wraps exactly like
    // the textarea laid over the copies; numbers, "+" and highlights therefore
    // keep to the wrapped height of their line.
    const scroll = element('div', 'tgs-conf-scroll');
    const code = element('div', 'tgs-conf-code');
    const grid = element('div', 'tgs-conf-grid');
    const textarea = element('textarea', 'tgs-conf-text');
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', 'mpv.conf 用户区');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('autocomplete', 'off');
    code.append(grid, textarea);
    scroll.appendChild(code);
    editor.append(headDetails, scroll, tailDetails);
    const status = element('div', 'tgs-conf-status');
    status.setAttribute('role', 'status');
    const diagnosticsList = element('ul', 'tgs-conf-diagnostics');
    const library = element('details', 'tgs-conf-library');
    library.appendChild(element('summary', '', '内置滤镜库清单（着色器作用、触发条件、开销与强度）'));

    node.append(intro, presetRow, qualityTitle, qualityForm, globalTitle, globalForm,
        editorTitle, editorNote, toolbar, editor, status, diagnosticsList, library);

    // ---- helpers ----
    const catalogOptions = () => state?.catalog?.options || [];
    const lineInfo = number => analysis?.lines?.[number - 1];
    const sectionOfBoundary = afterLine => afterLine <= 0 ? 'default' : (lineInfo(afterLine)?.section || 'default');
    const profileTitle = name => (analysis?.profiles || []).find(p => p.name === name)?.description || name;
    const visibleProfiles = () => (analysis?.profiles || []).filter(p => p.name !== 'tigerest-quality-base');

    const setStatus = (text, error = false) => {
        status.textContent = text;
        status.classList.toggle('error', error);
    };

    const scrollToLine = (number, select = true) => {
        const lines = textarea.value.split('\n');
        let start = 0;
        for (let i = 0; i < number - 1 && i < lines.length; i++) start += lines[i].length + 1;
        const end = start + (lines[number - 1] || '').length;
        const row = grid.querySelectorAll('.tgs-conf-row')[number - 1];
        scroll.scrollTop = Math.max(0, (row?.offsetTop || 0) - 120);
        if (select) {
            textarea.focus({preventScroll: true});
            textarea.setSelectionRange(start, end);
        }
        if (row) {
            row.classList.add('flash');
            setTimeout(() => row.classList.remove('flash'), 1200);
        }
    };

    // ---- rendering ----
    const renderLines = () => {
        const lines = textarea.value.split('\n');
        const marks = new Map(), messages = new Map();
        const rank = {error: 3, warning: 2, info: 1};
        for (const item of analysis?.diagnostics || []) {
            if ((rank[item.severity] || 0) > (rank[marks.get(item.line)] || 0)) marks.set(item.line, item.severity);
            messages.set(item.line, [...(messages.get(item.line) || []), item.message]);
        }
        // The "+" before a line sits on the top edge of its number; the one
        // after the last line on the bottom edge.
        const plus = boundary => {
            const node = button('+', 'tgs-conf-plus', () => openPicker(boundary));
            node.title = boundary === 0 ? '在第 1 行之前插入' : `在第 ${boundary} 行之后插入`;
            node.setAttribute('aria-label', node.title);
            return node;
        };
        grid.replaceChildren();
        lines.forEach((line, index) => {
            const number = index + 1;
            const num = element('div', 'num', String(number));
            const mark = marks.get(number);
            if (mark) {
                num.dataset.mark = mark;
                num.title = messages.get(number).join('\n');
            }
            num.appendChild(plus(index));
            if (number === lines.length) {
                const last = plus(number);
                last.classList.add('last');
                num.appendChild(last);
            }
            const kind = lineInfo(number)?.kind;
            const row = element('div', 'tgs-conf-row', line);
            if (mark === 'error' || mark === 'warning') row.classList.add(mark);
            else if (kind === 'suspended' || kind === 'ignored') row.classList.add(kind);
            row.setAttribute('aria-hidden', 'true');
            grid.append(num, row);
        });
    };

    const renderDiagnostics = () => {
        diagnosticsList.replaceChildren();
        const items = analysis?.diagnostics || [];
        for (const item of items.slice(0, 60)) {
            const li = element('li', item.severity);
            const jump = button(`第 ${item.line} 行：${item.message}`, '', () => scrollToLine(item.line));
            li.appendChild(jump);
            diagnosticsList.appendChild(li);
        }
        if (items.length > 60) diagnosticsList.appendChild(element('li', 'info', `另有 ${items.length - 60} 条提示未列出`));
    };

    const controlFor = (option, current) => {
        const value = current?.found ? current.value : '';
        if (option.type === 'flag') {
            const select = element('select', 'tgs-control');
            for (const [v, label] of [['', '未设置'], ['yes', '开启（yes）'], ['no', '关闭（no）']]) {
                const item = element('option', '', label);
                item.value = v;
                select.appendChild(item);
            }
            select.value = value === 'yes' || value === 'no' ? value : '';
            return select;
        }
        if (option.choices) {
            const select = element('select', 'tgs-control');
            const choices = option.choices.map(c => [String(c[0]), c[1]]);
            if (!current?.found) choices.unshift(['', '未设置（使用 mpv 默认）']);
            else if (!choices.some(c => c[0] === value)) choices.unshift([value, `自定义：${value}`]);
            for (const [v, label] of choices) {
                const item = element('option', '', label);
                item.value = v;
                select.appendChild(item);
            }
            select.value = value;
            return select;
        }
        const input = element('input', 'tgs-control');
        input.type = option.type === 'int' || option.type === 'float' ? 'number' : 'text';
        if (option.type === 'float') input.step = 'any';
        if (option.min != null) input.min = option.min;
        if (option.max != null) input.max = option.max;
        input.value = value;
        input.placeholder = current?.found ? '' : '未设置';
        return input;
    };

    const renderForm = () => {
        qualityTitle.textContent = `画质参数（当前档位：${profileTitle(section)}）`;
        for (const [target, scope] of [[qualityForm, 'profile'], [globalForm, 'global']]) {
            target.replaceChildren();
            for (const option of catalogOptions().filter(o => o.form && o.scope === scope)) {
                const owner = scope === 'profile' ? section : 'default';
                const current = analysis?.form?.[option.key];
                const field = element('div', 'tgs-conf-field');
                const head = element('div', 'tgs-conf-field-head');
                const title = element('label', '', option.title);
                const own = current?.found && current.section === owner;
                const source = element('span', `tgs-conf-source${own ? ' own' : ''}`,
                    !current?.found ? '未设置' : own ? `第 ${current.line} 行` : `继承自 ${current.section === 'default' ? '全局' : current.section}（第 ${current.line} 行）`);
                head.append(title, source);
                const control = controlFor(option, current);
                control.id = `tgs-mpvconf-${option.key}`;
                title.htmlFor = control.id;
                const blocked = analysis?.blocked?.[option.key];
                if (blocked && !own) {
                    control.disabled = true;
                    control.title = blocked;
                }
                control.addEventListener('change', () => {
                    const v = String(control.value).trim();
                    applyEdit(v === '' ? {type: 'remove', section: owner, key: option.key}
                        : {type: 'set', section: owner, key: option.key, value: v, comment: option.title});
                });
                const inline = element('div', 'tgs-conf-inline');
                inline.appendChild(control);
                if (own && scope === 'profile') {
                    inline.appendChild(button('改回继承', 'tgs-conf-link',
                        () => applyEdit({type: 'remove', section: owner, key: option.key})));
                }
                if (current?.found) inline.appendChild(button('定位', 'tgs-conf-link', () => scrollToLine(current.line)));
                field.append(head, inline);
                if (option.help) field.appendChild(element('div', 'tgs-help', blocked ? `${option.help} ${blocked}` : option.help));
                target.appendChild(field);
            }
        }
    };

    const renderPresets = () => {
        presetSelect.replaceChildren();
        for (const profile of visibleProfiles()) {
            const item = element('option', '', `${profile.description || profile.name}（${profile.shaders} 个着色器）`);
            item.value = profile.name;
            presetSelect.appendChild(item);
        }
        presetSelect.value = section;
    };

    const renderManaged = () => {
        headDetails.querySelector('pre').textContent = state?.head || '';
        tailDetails.querySelector('pre').textContent = state?.tail || '';
    };

    const renderLibrary = () => {
        library.querySelector('.wrap')?.remove();
        const wrap = element('div', 'wrap');
        const note = element('p', 'tgs-conf-note',
            `${state?.shaders?.costNote || ''}${state?.shaders?.measuredOn ? `实测设备：${state.shaders.measuredOn}。` : ''} 自己的着色器放在 ${state?.userShaderDir || 'shaders/user'}，写成 glsl-shader=~~/shaders/user/文件名.glsl；升级不会改动这个目录。`);
        const table = element('table');
        const head = element('tr');
        for (const label of ['着色器', '作用', '适合', '触发条件', '开销', '强度', '说明']) head.appendChild(element('th', '', label));
        table.appendChild(head);
        for (const shader of state?.shaders?.shaders || []) {
            const row = element('tr');
            const name = element('td');
            name.append(element('div', '', shader.title), element('div', 'tgs-conf-source', shader.path));
            row.appendChild(name);
            for (const value of [shader.purpose, shader.content, shader.trigger,
                shader.measuredMs != null ? `${shader.cost}（约 ${shader.measuredMs} ms）` : shader.cost, shader.strength, shader.note]) {
                row.appendChild(element('td', '', value));
            }
            table.appendChild(row);
        }
        for (const path of state?.userShaders || []) {
            const row = element('tr');
            row.append(element('td', '', path), element('td', '', '我的着色器'), element('td', '', ''), element('td', '', ''),
                element('td', '', ''), element('td', '', ''), element('td', '', '放在 shaders/user，升级不会改动'));
            table.appendChild(row);
        }
        wrap.append(note, table);
        library.appendChild(wrap);
    };

    const renderAll = () => {
        renderLines();
        renderDiagnostics();
        renderForm();
        renderPresets();
    };

    const describeSaveState = () => {
        const errors = analysis?.errors || 0;
        if (errors > 0) setStatus(`有 ${errors} 处错误，尚未保存。修改标红的行，或离开本页时选择「强行使用」。`, true);
        else if (textarea.value === savedUser) setStatus(`已保存${analysis?.warnings ? `；另有 ${analysis.warnings} 条提醒` : ''}。`);
        else setStatus('正在保存…');
    };

    // ---- analysis and saving ----
    const analyze = async () => {
        const mine = ++generation;
        const result = await player.mpvConfAnalyze(textarea.value, section);
        if (disposed || mine !== generation) return false;
        analysis = result;
        renderAll();
        return true;
    };

    const save = async (force = false) => {
        const text = textarea.value;
        const result = await player.mpvConfSave(text, force);
        if (disposed) return result;
        analysis = result.analysis || analysis;
        if (result.saved) {
            savedUser = result.user;
            try { sessionStorage.removeItem(MPVCONF_DRAFT_KEY); } catch (e) {}
            if (result.user !== textarea.value && textarea.value === text) setText(result.user);
            if (result.suspended) notify(`已保存；有 ${result.suspended} 行与已开启的功能冲突，已暂停执行。`);
            else if (result.ignored) notify(`已保存；有 ${result.ignored} 行写了不能放在用户区的配置，已注释。`);
            else notify('mpv.conf 已保存并应用。');
            refreshManaged();
        }
        renderAll();
        describeSaveState();
        return result;
    };

    const schedule = () => {
        clearTimeout(timer);
        try { sessionStorage.setItem(MPVCONF_DRAFT_KEY, textarea.value); } catch (e) {}
        setStatus('正在检查…');
        timer = setTimeout(async () => {
            if (!(await analyze())) return;
            if ((analysis.errors || 0) === 0 && textarea.value !== savedUser) await save(false);
            describeSaveState();
        }, 500);
    };

    const setText = text => {
        const position = textarea.selectionStart;
        textarea.value = text;
        try { textarea.setSelectionRange(Math.min(position, text.length), Math.min(position, text.length)); } catch (e) {}
        renderLines();
    };

    const applyEdit = operation => {
        pendingEdit = pendingEdit.then(async () => {
            const result = await player.mpvConfEdit(textarea.value, operation);
            if (disposed) return;
            if (result.error) { notify(result.error); return; }
            setText(result.user);
            schedule();
            return result;
        });
        return pendingEdit;
    };

    const refreshManaged = async () => {
        const fresh = await player.mpvConfState();
        if (disposed) return;
        state.head = fresh.head;
        state.tail = fresh.tail;
        state.userShaders = fresh.userShaders;
        renderManaged();
    };

    // ---- dialogs ----
    const dialog = (title, body, actions) => new Promise(resolve => {
        const modal = element('div', 'tgs-conf-modal');
        const box = element('div', 'tgs-conf-dialog');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', title);
        const header = element('header', '', title);
        const content = element('div', 'body');
        if (typeof body === 'string') content.textContent = body; else content.appendChild(body);
        const footer = element('footer');
        const finish = value => { modal.remove(); document.removeEventListener('keydown', onKey, true); resolve(value); };
        for (const action of actions) {
            footer.appendChild(button(action.label, `tgs-action${action.primary ? ' primary' : ''}`, () => finish(action.value)));
        }
        const onKey = event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(actions.find(a => a.cancel)?.value); }
        };
        document.addEventListener('keydown', onKey, true);
        box.append(header, content, footer);
        modal.appendChild(box);
        modal.addEventListener('click', event => { if (event.target === modal) finish(actions.find(a => a.cancel)?.value); });
        document.body.appendChild(modal);
        footer.querySelector('.primary')?.focus();
        listeners.push(() => finish(actions.find(a => a.cancel)?.value));
    });

    const diffView = (before, after) => {
        const pre = element('pre', 'tgs-conf-diff');
        const changes = mpvConfDiff(before, after);
        let shown = 0;
        changes.forEach((change, index) => {
            const near = changes.slice(Math.max(0, index - 2), index + 3).some(c => c.type !== ' ');
            if (!near || shown > 400) return;
            const span = element('span', change.type === '+' ? 'add' : change.type === '-' ? 'del' : '', `${change.type} ${change.text}\n`);
            pre.appendChild(span);
            shown++;
        });
        if (!shown) pre.textContent = '没有差异。';
        return pre;
    };

    const pickerItem = (title, meta, actionLabel, onClick, disabledReason = '') => {
        const item = element('div', `tgs-conf-pick${disabledReason ? ' disabled' : ''}`);
        const head = element('div', 'tgs-conf-pick-head');
        head.appendChild(element('div', '', title));
        if (actionLabel) {
            const action = button(actionLabel, 'tgs-action', onClick);
            action.disabled = Boolean(disabledReason) && actionLabel !== '跳到这一行';
            head.appendChild(action);
        }
        item.appendChild(head);
        if (meta) item.appendChild(element('div', 'meta', meta));
        if (disabledReason) item.appendChild(element('div', 'meta', disabledReason));
        return item;
    };

    const optionValueControl = option => {
        const control = controlFor(option, null);
        if (option.type === 'flag') control.value = 'yes';
        else if (option.choices) control.value = String(option.choices[0][0]);
        return control;
    };

    const openPicker = boundary => {
        const target = sectionOfBoundary(boundary);
        const targetLabel = target === 'default' ? '全局（所有档位共用）' : `${profileTitle(target)}（${target}）`;
        const container = element('div');
        container.appendChild(element('p', 'tgs-conf-note', `插入位置：${boundary === 0 ? '第 1 行之前' : `第 ${boundary} 行之后`}；将添加到：${targetLabel}`));
        const tabs = element('div', 'tgs-conf-tabs');
        tabs.setAttribute('role', 'tablist');
        const panel = element('div');
        container.append(tabs, panel);
        let close = null;
        const done = async operation => {
            const result = await applyEdit({afterLine: boundary, section: target, ...operation});
            if (result?.user != null) close?.();
        };
        const existing = key => (analysis?.lines || []).find(line => line.kind === 'option' && line.section === target && line.key === key);
        const categories = state?.catalog?.categories || [];
        const renderCategory = id => {
            for (const tab of tabs.children) tab.setAttribute('aria-selected', String(tab.dataset.id === id));
            panel.replaceChildren();
            if (id === 'shader') {
                const groups = new Map();
                for (const shader of state?.shaders?.shaders || []) groups.set(shader.group, [...(groups.get(shader.group) || []), shader]);
                const mine = (state?.userShaders || []).map(path => ({path: path, title: path.split('/').pop(), purpose: '我的着色器', content: '', trigger: '', cost: '', strength: '', note: ''}));
                if (mine.length) groups.set('user', mine);
                for (const [group, shaders] of groups) {
                    const details = element('details');
                    details.appendChild(element('summary', '', group === 'user' ? '我的着色器（shaders/user）'
                        : (state?.shaders?.groups || []).find(g => g.id === group)?.title || group));
                    for (const shader of shaders) {
                        details.appendChild(pickerItem(`${shader.title}`, [shader.path, shader.purpose, shader.content && `适合${shader.content}`,
                            shader.trigger, shader.cost && `开销${shader.cost}${shader.measuredMs != null ? `（约 ${shader.measuredMs} ms）` : ''}`, shader.strength && `强度${shader.strength}`, shader.note].filter(Boolean).join(' · '),
                            '添加', () => done({type: 'shader', path: shader.path, comment: `${shader.title}：${shader.note || shader.purpose}`}),
                            target === 'default' ? '着色器建议写在档位里；写在全局部分时，切档会被清空。' : ''));
                    }
                    panel.appendChild(details);
                }
                return;
            }
            if (id === 'vf') {
                if (target !== 'default') {
                    panel.appendChild(element('p', 'tgs-conf-note', 'vf 滤镜只能加在全局部分（第一个档位之前），请在那里点「+」。'));
                    return;
                }
                const rife = Boolean(analysis?.settings?.['video.aiRife']);
                const select = element('select', 'tgs-control');
                for (const [name, label] of MPVCONF_FILTERS) {
                    const item = element('option', '', label);
                    item.value = name;
                    item.disabled = rife && ['fps', 'minterpolate'].includes(name);
                    select.appendChild(item);
                }
                const custom = element('option', '', '其他（手动填写滤镜名）');
                custom.value = '';
                select.appendChild(custom);
                const name = element('input', 'tgs-control');
                name.placeholder = '滤镜名，例如 gradfun';
                name.hidden = true;
                const params = element('input', 'tgs-control');
                params.placeholder = '参数，例如 strength=0.4（可留空）';
                params.value = MPVCONF_FILTERS[0][2];
                select.addEventListener('change', () => {
                    name.hidden = select.value !== '';
                    params.value = MPVCONF_FILTERS.find(f => f[0] === select.value)?.[2] || '';
                });
                const add = button('添加滤镜', 'tgs-action primary', () => {
                    const filter = select.value || name.value.trim();
                    const label = MPVCONF_FILTERS.find(f => f[0] === filter)?.[1] || filter;
                    done({type: 'filter', filter, params: params.value, comment: label});
                });
                panel.append(element('p', 'tgs-conf-note', `软件会自动加上 @user- 标签；滤镜按顺序执行，RIFE 总在你的滤镜之后。${rife ? '当前已开启 RIFE，改变帧率的滤镜暂不可添加。' : ''}大多数滤镜在 CPU 上运行，需要「视频」页的硬件解码使用回读（copy）模式。`),
                    select, name, params, add);
                return;
            }
            if (id === 'profile') {
                const name = element('input', 'tgs-control');
                name.placeholder = '档位名（小写字母、数字、短横线），例如 night';
                const description = element('input', 'tgs-control');
                description.placeholder = '显示名称，例如 夜间观影';
                const base = element('select', 'tgs-control');
                const none = element('option', '', '不继承，从空白开始');
                none.value = '';
                base.appendChild(none);
                for (const profile of analysis?.profiles || []) {
                    const item = element('option', '', `以「${profile.description || profile.name}」为基础`);
                    item.value = profile.name;
                    base.appendChild(item);
                }
                base.value = section;
                const add = button('新建档位', 'tgs-action primary', () => done({type: 'newProfile', name: name.value, description: description.value, base: base.value}));
                panel.append(element('p', 'tgs-conf-note', '新档位会出现在上方「画质预设」和 uosc「滤镜」菜单里；以某一档为基础时，只需写要改的项。'),
                    name, description, base, add);
                return;
            }
            for (const option of catalogOptions().filter(o => o.category === id && !['shader', 'vf'].includes(o.type))) {
                const found = existing(option.key);
                const blocked = analysis?.blocked?.[option.key];
                const scopeNote = option.scope === 'profile' && target === 'default' ? '这是档位参数，写在全局部分会被档位里的同名项覆盖。' : '';
                if (found) {
                    panel.appendChild(pickerItem(option.title, option.help, '跳到这一行', () => { close?.(); scrollToLine(found.n); },
                        `这一段第 ${found.n} 行已经有 ${option.key}，请直接修改那一行。`));
                    continue;
                }
                const item = pickerItem(option.title, [option.key, option.help, scopeNote].filter(Boolean).join(' · '), '', null, blocked || '');
                const control = optionValueControl(option);
                control.disabled = Boolean(blocked);
                const add = button('添加', 'tgs-action', () => {
                    const value = String(control.value).trim();
                    if (value) done({type: 'insert', key: option.key, value, comment: option.title});
                });
                add.disabled = Boolean(blocked);
                const inline = element('div', 'tgs-conf-inline');
                inline.append(control, add);
                item.appendChild(inline);
                panel.appendChild(item);
            }
        };
        for (const category of categories) {
            const tab = button(category.title, '', () => renderCategory(category.id));
            tab.dataset.id = category.id;
            tab.setAttribute('role', 'tab');
            tabs.appendChild(tab);
        }
        renderCategory(target === 'default' ? 'playback' : 'quality');
        const result = dialog('插入配置', container, [{label: '关闭', value: null, cancel: true}]);
        close = () => document.querySelector('.tgs-conf-modal:last-of-type .tgs-conf-dialog footer button')?.click();
        return result;
    };

    // ---- toolbar actions ----
    const copyText = async text => {
        // The page's own routes depend on the server's origin and on where
        // focus is; the native clipboard depends on neither.
        try {
            if (await player.mpvConfCopyText?.(text)) return true;
        } catch (e) {}
        try {
            if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
        } catch (e) {}
        const area = element('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    };

    const fullFile = () => `${state.head}\n${textarea.value.replace(/\n*$/, '\n')}\n${state.tail}`;

    toolbar.append(
        button('复制给 AI', 'tgs-action', async () => {
            const text = `${state.aiGuide}\n\n## 当前完整的 mpv.conf\n\n\`\`\`ini\n${fullFile()}\`\`\`\n`;
            notify(await copyText(text) ? '已复制修改说明和完整 mpv.conf。把它整段交给 AI，再把 AI 返回的完整文本粘贴到编辑器里。' : '复制失败，请手动选择文本复制。');
        }),
        button('打开我的着色器目录', 'tgs-action', async () => {
            if (!(await player.mpvConfOpenShaderFolder())) notify(`无法打开目录：${state.userShaderDir}`);
        }),
        button('恢复默认配置', 'tgs-action', async () => {
            const choice = await dialog('恢复默认配置', diffView(textarea.value, state.defaultUser),
                [{label: '取消', value: false, cancel: true}, {label: '恢复默认', value: true, primary: true}]);
            if (!choice) return;
            const fresh = await player.mpvConfRestoreDefault();
            if (disposed) return;
            load(fresh);
            notify('已恢复默认配置；原来的用户区备份为 mpv.conf.before-restore。');
        })
    );
    const updateButton = button('查看新版默认配置的变化', 'tgs-action', async () => {
        const choice = await dialog('新版默认配置有变化', diffView(textarea.value, state.defaultUser), [
            {label: '保留我的配置', value: 'keep', cancel: true},
            {label: '换成新版默认', value: 'replace', primary: true}]);
        if (choice === 'replace') load(await player.mpvConfRestoreDefault());
        else await player.mpvConfAcknowledgeDefault();
        updateButton.hidden = true;
    });

    // ---- events ----
    textarea.addEventListener('input', () => { renderLines(); schedule(); });
    textarea.addEventListener('keydown', event => {
        if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            document.execCommand('insertText', false, '    ');
        }
    });
    textarea.addEventListener('paste', async event => {
        const text = event.clipboardData?.getData('text/plain') || '';
        const whole = text.includes('==== 大河影院管理区·头部') || text.split('\n').length > 40;
        if (!whole) return;
        event.preventDefault();
        const pasted = await player.mpvConfPaste(text);
        const body = element('div');
        body.appendChild(element('p', '', pasted.ignoredManaged
            ? `粘贴内容改动了 ${pasted.ignoredManaged} 行只读管理区，这些改动会被忽略。下面是用户区将发生的变化：`
            : '下面是用户区将发生的变化：'));
        body.appendChild(diffView(textarea.value, pasted.user));
        const choice = await dialog('确认粘贴的配置', body, [
            {label: '取消', value: false, cancel: true}, {label: '应用这些改动', value: true, primary: true}]);
        if (!choice || disposed) return;
        setText(pasted.user);
        schedule();
    });
    presetSelect.addEventListener('change', () => {
        section = presetSelect.value;
        saveSetting('mpv', 'shaderPreset', mpvConfProfileToPreset(section));
        analyze().then(() => describeSaveState());
    });

    // ---- usage notes ----
    const renderHelp = fresh => {
        editorNote.replaceChildren(element('summary', '', '使用说明（点击收起）'));
        const sections = [
            ['这份文件是什么', [
                '客户端只读取这一份 mpv.conf，编辑器显示的就是它的全部内容。',
                '灰色的头部和尾部是管理区：写着由软件和「视频」「字幕」「音频」等设置页决定的配置，以及播放时软件会执行的动作。它们只读，要改请到对应的设置页。',
                '中间可编辑的部分是用户区：开头是所有档位共用的全局选项，后面每个 [名称] 是一个画质档位。'
            ]],
            ['怎么修改', [
                '上方表单和下方文本是同一份内容，改哪边都行，另一边会立即跟着变。表单里的画质参数改的是上面「画质预设」选中的那一档；显示「继承自 …」的项点「定位」可以找到来源行。',
                '左侧每两行之间的「+」可以在那个位置插入配置：画质参数、着色器、vf 滤镜，或新建自己的档位。面板会写明插入到哪一段，已经有的项会让你直接跳过去改。',
                '每行写成 key=value，上一行用 # 写中文说明。值里有 # 或首尾空格时要加双引号，例如 sub-color="#FFFFFF"。',
                '没有错误时自动保存并立即应用，不用重启；删除的配置项恢复为 mpv 默认值。',
                '写错的行会标红，下方列出原因，点击可跳到那一行；有错误时不会保存。离开设置页时如果还有错误，可以选「强行使用」（mpv 会跳过它不认识的行）或「返回修改」。'
            ]],
            ['档位、着色器和滤镜', [
                '切档时客户端先清空着色器，再按顺序执行该档位的内容（profile= 表示继承另一档）。自建档位名以 tigerest-user- 开头并写 profile-desc，会出现在「画质预设」和播放时 uosc 的「滤镜」菜单里。',
                '着色器写在档位里：先写 glsl-shaders= 清空，再用 glsl-shader= 逐个追加。下方「内置滤镜库清单」写了每个内置着色器的作用、触发条件、开销和强度。',
                `自己的 .glsl 放进「打开我的着色器目录」打开的文件夹（${fresh.userShaderDir}），写成 glsl-shader=~~/shaders/user/文件名.glsl；升级不会改动这个文件夹。`,
                'vf 滤镜只能写在全局部分，用 vf-append=@user-编号:滤镜名=参数；RIFE 总在你的滤镜之后执行。大多数滤镜需要「视频 → 硬件解码」选回读模式。',
                '标黄的行与已开启的功能冲突（例如开启 RIFE 时改变帧率的滤镜和 interpolation=yes），已暂停执行，关闭该功能后自动恢复，不用自己改。'
            ]],
            ['让 AI 帮你改', [
                '1. 点「复制给 AI」。复制的内容包括一份修改规则说明（哪些能改、哪些不能改、可用的着色器和写法）和你当前完整的 mpv.conf。',
                '2. 把它整段粘贴给 AI（ChatGPT、Claude 等），在后面写下你的需求，例如：「帮我新建一个适合老动画的档位，降噪强一点、线条细一点」。',
                '3. 请 AI 只返回修改后的完整 mpv.conf 文本，不要让它直接改你电脑上的文件。',
                '4. 复制 AI 返回的全文，点进下方编辑区粘贴。编辑器会先显示用户区的逐行变化，确认后才替换；AI 改动了灰色管理区的话，这些改动会被忽略。',
                '5. 有标红的行时，把下方的报错原文发给 AI，让它按报错修改后再给你一份完整文本。',
                `规则说明也保存在 ${fresh.aiGuidePath}，可以作为附件直接交给 AI。`
            ]],
            ['写坏了怎么办', [
                '点「恢复默认配置」把用户区换回默认内容，原来的内容会备份为 mpv.conf.before-restore。上方「恢复本页默认值」只恢复本页的开关和渲染后端，不会改动 mpv.conf。',
                'mpv 无法用你的配置启动时，客户端会自动改用默认配置并提示你回来检查。'
            ]]
        ];
        for (const [title, items] of sections) {
            editorNote.appendChild(element('h4', '', title));
            const list = element('ul');
            for (const item of items) list.appendChild(element('li', '', item));
            editorNote.appendChild(list);
        }
    };

    // ---- loading ----
    // Only reopening the page resumes an unsaved draft; a restore replaces it.
    const load = (fresh, resumeDraft = false) => {
        // A pending check of the old text must not save over the new one.
        clearTimeout(timer);
        generation++;
        state = fresh;
        section = fresh.activeProfile || mpvConfPresetToProfile(settings.shaderPreset);
        savedUser = fresh.user;
        let draft = null;
        try {
            if (resumeDraft) draft = sessionStorage.getItem(MPVCONF_DRAFT_KEY);
            else sessionStorage.removeItem(MPVCONF_DRAFT_KEY);
        } catch (e) {}
        textarea.value = draft != null && draft !== fresh.user ? draft : fresh.user;
        analysis = fresh.analysis;
        intro.textContent = '';
        intro.append(
            element('div', '', '2.9.4 起 mpv 配置方式已更新：客户端只使用下面这一份 mpv.conf，旧版的「高级 → 直接传入 mpv.conf 选项」、user-overrides.conf 和配置模式都不再生效，请在这里重新设置自定义配置。'),
            element('div', '', fresh.backupPath ? `旧版的自定义内容已备份到：${fresh.backupPath}` : ''),
            element('div', '', `配置文件：${fresh.configPath}`));
        renderHelp(fresh);
        updateButton.hidden = !fresh.defaultUpdated;
        if (fresh.defaultUpdated && !toolbar.contains(updateButton)) toolbar.appendChild(updateButton);
        renderManaged();
        renderLibrary();
        renderAll();
        if (textarea.value !== savedUser) schedule(); else describeSaveState();
    };

    const ready = player.mpvConfState().then(fresh => { if (!disposed) load(fresh, true); });

    return {
        node,
        ready,
        // Unsaved text that still has errors; the page asks before leaving.
        pendingErrors: () => textarea.value !== savedUser && (analysis?.errors || 0) > 0 ? analysis.errors : 0,
        confirmLeave: async () => {
            const errors = analysis?.errors || 0;
            const choice = await dialog('mpv.conf 还有错误', `编辑器里有 ${errors} 处错误，修改尚未保存。强行使用时，mpv 会跳过它无法识别的行。`, [
                {label: '返回修改', value: 'stay', cancel: true}, {label: '强行使用', value: 'force', primary: true}]);
            if (choice === 'force') await save(true);
            return choice;
        },
        dispose: () => {
            disposed = true;
            clearTimeout(timer);
            listeners.splice(0).forEach(close => close());
            style.remove();
            node.remove();
        }
    };
}

// The settings page was left (for example through the Emby navigation) while
// the editor still held unsaved text with errors. The draft stays in session
// storage; offer to use it anyway or to go back to it.
async function offerMpvConfDraft(player) {
    let draft = null;
    try { draft = sessionStorage.getItem(MPVCONF_DRAFT_KEY); } catch (e) {}
    if (draft == null) return;
    const modal = document.createElement('div');
    modal.className = 'tgs-conf-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:#000a';
    modal.innerHTML = '<div role="dialog" aria-modal="true" style="box-sizing:border-box;width:min(560px,calc(100vw - 32px));padding:20px;background:#1d1d1d;color:#eee;border:1px solid #444;border-radius:4px;font:14px/1.6 system-ui">' +
        '<div style="font-size:18px;margin-bottom:8px">mpv.conf 还有错误</div><div>你离开设置页时，编辑器里的修改还有错误，尚未保存。</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px"><button type="button" data-choice="stay" style="min-height:40px;padding:8px 16px;color:#eee;background:#303030;border:0;border-radius:3px;font:inherit;cursor:pointer">返回修改</button>' +
        '<button type="button" data-choice="force" style="min-height:40px;padding:8px 16px;color:#171717;background:#ffbe38;border:0;border-radius:3px;font:inherit;cursor:pointer">强行使用</button></div></div>';
    document.body.appendChild(modal);
    const choice = await new Promise(resolve => modal.addEventListener('click', event => {
        const value = event.target.dataset?.choice;
        if (value) resolve(value);
    }));
    modal.remove();
    if (choice === 'force') {
        await player.mpvConfSave(draft, true);
        try { sessionStorage.removeItem(MPVCONF_DRAFT_KEY); } catch (e) {}
    } else {
        window.NativeShell?.openMpvSettings?.();
    }
}

// Startup notices from the native side: mpv fell back to the default
// configuration, shaders went missing after an update, or locked options
// were found in the user area.
function showMpvConfNotices(notices) {
    if (!Array.isArray(notices) || !notices.length) return;
    try {
        const key = 'tigerestMpvConfNoticesShown';
        const signature = JSON.stringify(notices.map(n => n.kind));
        if (sessionStorage.getItem(key) === signature) return;
        sessionStorage.setItem(key, signature);
    } catch (e) {}
    const modal = document.createElement('div');
    modal.className = 'tgs-conf-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:#000a';
    const box = document.createElement('div');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.style.cssText = 'box-sizing:border-box;width:min(560px,calc(100vw - 32px));padding:20px;background:#1d1d1d;color:#eee;border:1px solid #444;border-radius:4px;font:14px/1.6 system-ui';
    for (const notice of notices) {
        const title = document.createElement('div');
        title.style.cssText = 'font-size:17px;margin:4px 0';
        title.textContent = notice.title;
        const message = document.createElement('div');
        message.style.marginBottom = '10px';
        message.textContent = notice.message;
        box.append(title, message);
    }
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:8px';
    for (const [label, value, primary] of [['稍后', 'later', false], ['前往设置', 'open', true]]) {
        const action = document.createElement('button');
        action.type = 'button';
        action.textContent = label;
        action.style.cssText = `min-height:40px;padding:8px 16px;border:0;border-radius:3px;font:inherit;cursor:pointer;${primary ? 'color:#171717;background:#ffbe38' : 'color:#eee;background:#303030'}`;
        action.addEventListener('click', () => {
            modal.remove();
            if (value === 'open') window.NativeShell?.openMpvSettings?.();
        });
        actions.appendChild(action);
    }
    box.appendChild(actions);
    modal.appendChild(box);
    document.body.appendChild(modal);
}

window.tigerestCreateMpvConfEditor = createMpvConfEditor;
window.tigerestOfferMpvConfDraft = offerMpvConfDraft;
window.tigerestShowMpvConfNotices = showMpvConfNotices;
