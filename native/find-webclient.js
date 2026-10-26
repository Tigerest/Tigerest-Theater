const DEFAULT_LOCAL_SERVER_IP = '192.168.5.150';
const DEFAULT_LOCAL_SERVER = `http://${DEFAULT_LOCAL_SERVER_IP}:8095/`;
const DEFAULT_REMOTE_SERVER = 'http://nas.tigerest.top:8095/';
const descriptions = {
    tigerest: '连接大河李斯特专属 EMBY 服务器。服务器访问权限及说明详见 B站充电页面。',
    custom: '连接你自己搭建的 Emby 或 Jellyfin 服务器。本应用只是播放器，不包含服务器，也不提供自建服务器的影视资源。',
};
const el = id => document.getElementById(id);
let isConnecting = false;
let connectionGeneration = 0;
let mode = '';
const explicitChoice = /(?:^|[?&])choose=1(?:&|$)/.test(window.location.search || '');
let editingAddress = false;
let committingSelection = false;
// Remembered servers (native/serverHistory.js): the card being connected, the
// card whose address is being edited, and per-card connection errors.
let listConnecting = null;
let replacingKey = null;
const cardErrors = new Map();

function cancelServerSwitch() {
    if (committingSelection) return;
    cancelConnection();
    if (explicitChoice && window.history.length > 1) window.history.back();
    else showChoices();
}
// Used by Android's hardware/gesture Back before WebView history handling.
window.tigerestServerSelectionBack = () => {
    if (committingSelection) return true;
    if (listConnecting) { cancelConnection(); return true; }
    if (!el('connect-form').hidden) { showChoices(); return true; }
    if (explicitChoice && window.history.length > 1) { cancelServerSwitch(); return true; }
    return false;
};
window.tigerestServerSelectionFailed = () => {
    committingSelection = false;
    showChoices();
    el('choice-description').textContent = '服务器网页加载失败，请重新选择服务器并检查地址。';
    return true;
};

async function editServerAddress() {
    const edit = window.tigerestAndroidApi?.system?.editServerAddress;
    if (!edit || editingAddress || isConnecting) return;
    editingAddress = true;
    try {
        const value = await edit(el('address').value);
        if (typeof value === 'string' && !el('connect-form').hidden) {
            el('address').value = value;
            el('connect-button').disabled = !value.trim();
        }
    } catch {
        el('connection-error').textContent = '无法打开地址编辑器，请重试。';
        el('connection-error').hidden = false;
    } finally { editingAddress = false; }
}

function normalizeServer(input) {
    let value = (input || '').trim();
    if (!value) throw new Error('请填写你的 Emby 或 Jellyfin 服务器地址。');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = 'http://' + value;
    let url;
    try { url = new URL(value); } catch { throw new Error('地址格式不正确，请填写完整的主机和端口。'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
        throw new Error('请使用 HTTP 或 HTTPS 服务器地址，不要在地址中填写账号密码。');
    }
    return url.href;
}

function isTigerestDefaultServer(server) {
    try {
        const url = new URL(normalizeServer(server));
        return url.port === '8095' && [DEFAULT_LOCAL_SERVER_IP, 'nas.tigerest.top'].includes(url.hostname);
    } catch { return false; }
}

function setConnecting(active) {
    isConnecting = active;
    el('address').disabled = active;
    el('spinner').hidden = !active;
    el('connect-button').disabled = active || !el('address').value.trim();
    el('connect-button').textContent = active ? '正在连接…' : '连接服务器';
    el('connect-form').setAttribute('aria-busy', String(active));
}

function showManualConnection(address = '', error = '') {
    el('server-choice').hidden = true;
    el('connect-form').hidden = false;
    el('title').textContent = mode === 'custom' ? '连接自建 Emby / Jellyfin 服务器' : '连接大河专属 EMBY';
    el('address').value = address;
    el('connection-error').textContent = error;
    el('connection-error').hidden = !error;
    el('connection-status').textContent = '';
    setConnecting(false);
    if (!window.tigerestAndroidApi?.system?.editServerAddress) el('address').focus();
}

function cancelConnection() {
    ++connectionGeneration;
    window.jmpCheckServerConnectivity.abort?.();
    window.api?.system.cancelServerConnectivity();
    setConnecting(false);
    if (listConnecting) { listConnecting = null; renderSavedServers(); }
}

function showChoices() {
    if (committingSelection) return;
    cancelConnection();
    replacingKey = null;
    el('server-choice').hidden = false;
    el('connect-form').hidden = true;
    el('choice-description').textContent = '请选择你要连接的服务器。';
    renderSavedServers();
}

function savedMode(address) {
    return address ? (isTigerestDefaultServer(address) ? 'tigerest' : 'custom') : '';
}

// The server in use before this choice (the startup target).
function currentServer() {
    const main = window.jmpInfo.settings.main, address = main.userWebClient || '';
    return {address, mode: main.serverConnectionMode || savedMode(address)};
}

function savedServers() {
    const main = window.jmpInfo.settings.main, current = currentServer();
    return window.TigerestServerHistory?.list(main.knownServers || '', {current: current.address, mode: current.mode}) || [];
}

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

function displayAddress(address) {
    try {
        const url = new URL(address);
        return (url.protocol === 'https:' ? 'https://' : '') + url.host + url.pathname.replace(/\/$/, '');
    } catch { return address; }
}

// Self-hosted servers this profile has opened. Names come from the servers
// and are rendered as text only.
function renderSavedServers() {
    const servers = savedServers();
    el('tigerest-current').hidden = !servers.some(server => server.mode === 'tigerest' && server.current);
    const items = servers.filter(server => server.mode === 'custom').map(server => {
        const busy = listConnecting === server.key, error = cardErrors.get(server.key) || '';
        const label = server.name || displayAddress(server.address);
        const item = node('li', 'saved-server' + (server.current ? ' is-current' : ''));
        item.dataset.key = server.key;
        const open = node('button', 'saved-server-open');
        open.type = 'button';
        open.disabled = isConnecting || committingSelection;
        const kind = server.kind === 'jellyfin' ? 'Jellyfin' : server.kind === 'emby' ? 'Emby' : '';
        open.append(node('span', 'saved-server-name', label),
            node('span', 'saved-server-meta', [kind, server.name && displayAddress(server.address)].filter(Boolean).join(' · ') || '连接后识别服务器类型'));
        if (server.current) open.append(node('span', 'saved-server-tag', '当前'));
        open.setAttribute('aria-label', `连接 ${label}${server.current ? '（当前服务器）' : ''}`);
        open.addEventListener('click', () => connectSaved(server));
        const status = node('p', 'saved-server-status' + (error ? ' is-error' : ''), busy ? '正在连接…' : error);
        status.setAttribute('role', error ? 'alert' : 'status');
        status.hidden = !busy && !error;
        const actions = node('div', 'saved-server-actions'), confirm = node('div', 'saved-server-confirm');
        confirm.hidden = true;
        const action = (text, handler, extra = '') => {
            const button = node('button', 'saved-server-action' + extra, text);
            button.type = 'button';
            button.disabled = isConnecting || committingSelection;
            button.addEventListener('click', handler);
            return button;
        };
        if (busy) {
            const cancel = action('取消', () => cancelConnection());
            cancel.disabled = false;
            actions.append(cancel);
        } else {
            if (error) actions.append(action('重试', () => connectSaved(server)));
            actions.append(action('编辑地址', () => editSaved(server)));
        }
        // The current server is the startup target and cannot be removed.
        if (!server.current && !busy) {
            const remove = action('移除', () => { actions.hidden = true; confirm.hidden = false; keep.focus(); }, ' is-danger');
            const keep = action('保留', () => { confirm.hidden = true; actions.hidden = false; remove.focus(); });
            confirm.append(node('p', '', `从列表移除“${label}”？不会退出登录，也不会删除服务器上的内容。`),
                action('确认移除', () => forgetSaved(server.key), ' is-danger'), keep);
            actions.append(remove);
        }
        item.append(open, status, actions, confirm);
        return item;
    });
    el('saved-server-list').replaceChildren(...items);
    el('saved-servers').hidden = !items.length;
}

function connectSaved(server) {
    if (isConnecting || committingSelection) return;
    mode = 'custom';
    replacingKey = null;
    cardErrors.delete(server.key);
    return connectServers([server.address], {card: server.key, mode: 'custom', replacing: null});
}

function editSaved(server) {
    if (isConnecting || committingSelection) return;
    mode = 'custom';
    cardErrors.delete(server.key);
    showManualConnection(server.address);
    replacingKey = server.key;
}

function forgetSaved(key) {
    const main = window.jmpInfo.settings.main;
    cardErrors.delete(key);
    main.knownServers = window.TigerestServerHistory.forget(main.knownServers || '', key);
    renderSavedServers();
    const next = el('saved-server-list').querySelector?.('.saved-server-open');
    (next || el('choose-custom')).focus();
}

// Each attempt keeps the mode and replaced record it started with; any later
// choice, Back or cancel bumps the generation so this attempt's answer is ignored.
async function connectServers(servers, {card = null, mode: attemptMode = mode, replacing = replacingKey} = {}) {
    if (isConnecting) return;
    const generation = ++connectionGeneration;
    setConnecting(true);
    if (card) { listConnecting = card; renderSavedServers(); }
    el('connection-error').hidden = true;
    let error = '';
    for (const input of [...new Set(servers)]) {
        if (generation !== connectionGeneration) return;
        try {
            const server = normalizeServer(input);
            el('address').value = server;
            el('connection-status').textContent = `正在连接 ${server}`;
            const resolvedUrl = await window.jmpCheckServerConnectivity(server);
            if (generation !== connectionGeneration) return;
            if (window.api.system.finishServerSelection) {
                // Native code owns the settings/navigation transaction and its
                // rollback. A cancel must not split those two operations. The
                // remembered list is committed only once the server page loads.
                committingSelection = true;
                const main = window.jmpInfo.settings.main;
                const remembered = window.TigerestServerHistory && 'knownServers' in main
                    ? window.TigerestServerHistory.remember(main.knownServers || '', {mode: attemptMode, address: server, replacing, current: currentServer()}) : '';
                const accepted = await window.api.system.finishServerSelection(server, attemptMode, resolvedUrl, remembered);
                if (accepted === false) throw new Error('无法切换服务器，请重试');
                return;
            }
            // Keep the address and external port chosen by this user.
            window.jmpInfo.settings.main.userWebClient = server;
            window.jmpInfo.settings.main.serverConnectionMode = attemptMode;
            window.location = resolvedUrl;
            return;
        } catch (failure) {
            committingSelection = false;
            if (generation !== connectionGeneration) return;
            error = failure.message || '无法连接服务器';
        }
    }
    const message = `${error}。请检查地址、端口及当前网络是否能访问该服务器。`;
    if (card) {
        // A saved server that is offline keeps its card and the rest of the list.
        cardErrors.set(card, message);
        setConnecting(false);
        listConnecting = null;
        renderSavedServers();
        return;
    }
    showManualConnection(el('address').value, message);
}

async function chooseMode(selected) {
    if (committingSelection) return;
    // A new choice supersedes any connection still pending, e.g. a saved card.
    cancelConnection();
    mode = selected;
    replacingKey = null;
    const saved = window.jmpInfo.settings.main.userWebClient || '';
    showManualConnection(mode === 'custom' && !isTigerestDefaultServer(saved) ? saved : '');
    if (mode === 'tigerest') {
        const generation = connectionGeneration;
        const onLan = await window.api.system.isAddressOnLocalSubnet(DEFAULT_LOCAL_SERVER_IP);
        if (generation !== connectionGeneration || mode !== 'tigerest') return;
        await connectServers(onLan ? [DEFAULT_LOCAL_SERVER, DEFAULT_REMOTE_SERVER] : [DEFAULT_REMOTE_SERVER], {mode: 'tigerest', replacing: null});
    }
}

for (const selected of ['tigerest', 'custom']) {
    const button = el(`choose-${selected}`);
    button.addEventListener('click', () => chooseMode(selected));
    for (const event of ['mouseenter', 'focus']) {
        button.addEventListener(event, () => { el('choice-description').textContent = descriptions[selected]; });
    }
}
el('connect-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!isConnecting) return connectServers([el('address').value]);
});
el('address').addEventListener('input', () => {
    if (!isConnecting) el('connect-button').disabled = !el('address').value.trim();
});
el('back-button').addEventListener('click', showChoices);
el('cancel-switch-button').addEventListener('click', cancelServerSwitch);
el('address').addEventListener('click', editServerAddress);
el('address').addEventListener('keydown', event => {
    if (window.tigerestAndroidApi?.system?.editServerAddress && ['Enter', ' '].includes(event.key)) {
        event.preventDefault(); editServerAddress();
    }
});
el('offline-button').addEventListener('click', () => window.tigerestOpenOfflineLibrary());
el('local-files-button').addEventListener('click', () => window.tigerestOpenLocalFiles?.());
el('settings-button').addEventListener('click', () => window.tigerestOpenMpvSettings?.('main'));
document.addEventListener('keydown', event => {
    if (committingSelection && event.key === 'Escape') { event.preventDefault(); return; }
    if (event.key === 'Escape' && listConnecting) {
        event.preventDefault();
        cancelConnection();
    } else if (event.key === 'Escape' && isConnecting) {
        event.preventDefault();
        cancelConnection();
        showManualConnection(el('address').value);
    }
});

(async () => {
    el('server-choice').hidden = false;
    el('connect-form').hidden = true;
    el('choose-tigerest').disabled = el('choose-custom').disabled = true;
    await window.apiPromise;
    el('choose-tigerest').disabled = el('choose-custom').disabled = false;
    el('cancel-switch-button').hidden = !explicitChoice || window.history.length < 2;
    el('local-files-button').hidden = !window.tigerestLocalPlayerAvailable?.();
    // Before a server page there is no other way into the desktop settings.
    el('settings-button').hidden = !window.tigerestOpenMpvSettings || !!window.tigerestAndroidApi || !!window.tigerestIPadApi;
    if (window.tigerestAndroidApi?.system?.editServerAddress) {
        el('address').readOnly = true;
        el('address').setAttribute('aria-haspopup', 'dialog');
    }
    const main = window.jmpInfo.settings.main;
    const saved = main.userWebClient || '';
    mode = main.serverConnectionMode || savedMode(saved);
    renderSavedServers();
    if (await window.api.system.takeServerSelectionError?.()) {
        return window.tigerestServerSelectionFailed();
    }
    if (explicitChoice) return showChoices();
    // Opened with a video file, the client is a local player: no server
    // connects until the user chooses one.
    if (await window.api.system.startedWithLocalFiles?.()) {
        showChoices();
        el('choice-description').textContent = '正在作为本地播放器使用，没有连接媒体服务器。需要媒体库时，请选择要连接的服务器。';
        return;
    }
    if (!['tigerest', 'custom'].includes(mode)) return showChoices();
    main.serverConnectionMode = mode;
    showManualConnection(saved);
    if (mode === 'custom') {
        if (saved) await connectServers([saved]);
    } else {
        const generation = connectionGeneration;
        const onLan = await window.api.system.isAddressOnLocalSubnet(DEFAULT_LOCAL_SERVER_IP);
        if (generation !== connectionGeneration || mode !== 'tigerest') return;
        await connectServers(onLan ? [DEFAULT_LOCAL_SERVER, DEFAULT_REMOTE_SERVER] : [DEFAULT_REMOTE_SERVER]);
    }
})();
