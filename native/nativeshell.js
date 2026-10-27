window.tigerestSwitchServer = async function () {
    const api = window.api || await window.apiPromise;
    if (api?.system?.openServerSettings) return api.system.openServerSettings();
    // A deliberate switch bypasses saved-server auto-connect without deleting it.
    window.location.href = window.jmpInfo.scriptPath + '/find-webclient.html?choose=1';
};

const features = [
    "filedownload",
    "displaylanguage",
    "htmlaudioautoplay",
    "htmlvideoautoplay",
    "externallinks",
    "clientsettings",
    "multiserver",
    "exitmenu",
    "remotecontrol",
    "fullscreenchange",
    "filedownload",
    "remotevideo",
    "displaymode",
    "screensaver",
    "fileinput"
].filter(feature => !window.tigerestAndroidApi || !['filedownload', 'fullscreenchange'].includes(feature));

// Jellyfin's web client loads these window plugins; Emby loads the same features
// as AMD modules registered by embycompat.js.
const getPlugins = () => {
    const basePlugins = [
        'inputPlugin',
        ...((window.tigerestAndroidApi || (window.jmpInfo?.capabilities?.selfUpdate === false && window.jmpInfo?.capabilities?.updateCheck !== true)) ? [] : ['updatePlugin']),
        'tigerestJellyfinPlugin'
    ];

    const mpvEnabled = jmpInfo.settings?.main?.enableMPV !== false;
    if (mpvEnabled) {
        return [
            'mpvVideoPlayer',
            'mpvAudioPlayer',
            ...basePlugins
        ];
    }

    return basePlugins;
};

const plugins = getPlugins();

// Plugins are bundled, return class directly
for (const plugin of plugins) {
    window[plugin] = () => {
        return window["_" + plugin];
    };
}

window.NativeShell = {
    openUrl(url, target) {
        window.api.system.openExternalUrl(url);
    },

    downloadFile(downloadInfo) {
        // Jellyfin passes its item with the download. Resolve it the way an
        // Emby download is resolved, so both get the same name and library.
        if (downloadInfo?.item && downloadInfo.url && window.tigerestEnqueueDownload) {
            return window.tigerestEnqueueDownload(downloadInfo.url);
        }
        return window.api.system.startDownload(downloadInfo);
    },

    // Jellyfin 12 lists this in the user menu when the app supports downloadmanagement.
    openDownloadManager() {
        window.tigerestOpenOfflineLibrary?.();
    },

    openClientSettings() {
        openTigerestSettings('main');
    },

    openMpvSettings() {
        openTigerestSettings('mpv');
    },

    openOfflineLibrary() {
        window.tigerestOpenOfflineLibrary();
    },

    getPlugins() {
        return plugins;
    }
};

function getDeviceProfile() {
    const CodecProfiles = [];

    if (jmpInfo.settings.video.force_transcode_dovi) {
        CodecProfiles.push({
            'Type': 'Video',
            'Conditions': [
                {
                    'Condition': 'NotEquals',
                    'Property': 'VideoRangeType',
                    'Value': 'DOVI'
                }
            ]
        });
    }

    if (jmpInfo.settings.video.force_transcode_hdr) {
        CodecProfiles.push({
            'Type': 'Video',
            'Conditions': [
                {
                    'Condition': 'Equals',
                    'Property': 'VideoRangeType',
                    'Value': 'SDR'
                }
            ]
        });
    }

    if (jmpInfo.settings.video.force_transcode_hi10p) {
        CodecProfiles.push({
            'Type': 'Video',
            'Conditions': [
                {
                    'Condition': 'LessThanEqual',
                    'Property': 'VideoBitDepth',
                    'Value': '8',
                }
            ]
        });
    }

    if (jmpInfo.settings.video.force_transcode_hevc) {
        CodecProfiles.push({
            'Type': 'Video',
            'Codec': 'hevc',
            'Conditions': [
                {
                    'Condition': 'Equals',
                    'Property': 'Width',
                    'Value': '0',
                }
            ],
        });
        CodecProfiles.push({
            'Type': 'Video',
            'Codec': 'h265',
            'Conditions': [
                {
                    'Condition': 'Equals',
                    'Property': 'Width',
                    'Value': '0',
                }
            ],
        });
    }

    if (jmpInfo.settings.video.force_transcode_av1) {
        CodecProfiles.push({
            'Type': 'Video',
            'Codec': 'av1',
            'Conditions': [
                {
                    'Condition': 'Equals',
                    'Property': 'Width',
                    'Value': '0',
                }
            ],
        });
    }

    if (jmpInfo.settings.video.force_transcode_4k) {
        CodecProfiles.push({
            'Type': 'Video',
            'Conditions': [
                {
                    'Condition': 'LessThanEqual',
                    'Property': 'Width',
                    'Value': '1920',
                },
                {
                    'Condition': 'LessThanEqual',
                    'Property': 'Height',
                    'Value': '1080',
                }
            ]
        });
    }

    const DirectPlayProfiles = [{ 'Type': 'Audio' }, { 'Type': 'Photo' }];

    if (!jmpInfo.settings.video.always_force_transcode) {
        DirectPlayProfiles.push({ 'Type': 'Video' });
    }

    return {
        'Name': 'Tigerest Theater',
        'MaxStaticBitrate': 1000000000,
        'MusicStreamingTranscodingBitrate': 1280000,
        'TimelineOffsetSeconds': 5,
        'TranscodingProfiles': [
            { 'Type': 'Audio' },
            {
                'Container': 'ts',
                'Type': 'Video',
                'Protocol': 'hls',
                'AudioCodec': 'aac,mp3,ac3,opus,vorbis',
                'VideoCodec': jmpInfo.settings.video.allow_transcode_to_hevc
                    ? (
                        jmpInfo.settings.video.prefer_transcode_to_h265
                            ? 'h265,hevc,h264,mpeg4,mpeg2video'
                            : 'h264,h265,hevc,mpeg4,mpeg2video'
                    )
                    : 'h264,mpeg4,mpeg2video',
                'MaxAudioChannels': jmpInfo.settings.audio.channels === "2.0" ? '2' : '6'
            },
            { 'Container': 'jpeg', 'Type': 'Photo' }
        ],
        DirectPlayProfiles,
        'ResponseProfiles': [],
        'ContainerProfiles': [],
        CodecProfiles,
        'SubtitleProfiles': [
            { 'Format': 'srt', 'Method': 'External' },
            { 'Format': 'srt', 'Method': 'Embed' },
            { 'Format': 'ass', 'Method': 'External' },
            { 'Format': 'ass', 'Method': 'Embed' },
            { 'Format': 'sub', 'Method': 'Embed' },
            { 'Format': 'sub', 'Method': 'External' },
            { 'Format': 'ssa', 'Method': 'Embed' },
            { 'Format': 'ssa', 'Method': 'External' },
            { 'Format': 'smi', 'Method': 'Embed' },
            { 'Format': 'smi', 'Method': 'External' },
            { 'Format': 'pgssub', 'Method': 'Embed' },
            { 'Format': 'dvdsub', 'Method': 'Embed' },
            { 'Format': 'dvbsub', 'Method': 'Embed' },
            { 'Format': 'pgs', 'Method': 'Embed' }
        ]
    };
}

async function createApi() {
    // Can't append script until document exists
    if (document.readyState === 'loading') {
        await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once: true}));
    }

    if (window.tigerestIPadApi) return window.tigerestIPadApi;
    if (window.tigerestAndroidApi) return window.tigerestAndroidApi;

    const channel = await new Promise((resolve) => {
        /*global QWebChannel */
        new QWebChannel(window.qt.webChannelTransport, resolve);
    });
    return channel.objects;
}

const sectionsFromStorage = window.sessionStorage.getItem('sections');
if (sectionsFromStorage) {
    jmpInfo.sections = JSON.parse(sectionsFromStorage);
}

let rawSettings = {};
Object.assign(rawSettings, jmpInfo.settings);
const settingsFromStorage = window.sessionStorage.getItem('settings');
if (settingsFromStorage) {
    rawSettings = JSON.parse(settingsFromStorage);
    Object.assign(jmpInfo.settings, rawSettings);
}

const settingsDescriptionsFromStorage = window.sessionStorage.getItem('settingsDescriptions');
if (settingsDescriptionsFromStorage) {
    jmpInfo.settingsDescriptions = JSON.parse(settingsDescriptionsFromStorage);
}

jmpInfo.settingsDescriptionsUpdate = [];
jmpInfo.settingsUpdate = [];
window.apiPromise = createApi().then(async api => {
    // Jellyfin constructs its plugins synchronously while these native reads
    // are in flight. Publish the ready bridge before refreshing saved settings.
    window.api = api;
    // Native selection can commit/roll back while this origin is unloaded.
    // Both the injected bootstrap and this origin's cache may be stale.
    if (api.settings.value) {
        for (const key of ['userWebClient', 'serverConnectionMode']) {
            const value = await api.settings.value('main', key);
            if (typeof value === 'string') rawSettings.main[key] = value;
        }
        // Hosts without the remembered-server setting keep working without it.
        if ('knownServers' in rawSettings.main) {
            try {
                const value = await api.settings.value('main', 'knownServers');
                if (typeof value === 'string') rawSettings.main.knownServers = value;
            } catch (error) { console.warn('Remembered servers are unavailable'); }
        }
        window.sessionStorage.setItem('settings', JSON.stringify(rawSettings));
    }
    return api;
});
window.initCompleted = new Promise(async (resolve) => {
    window.api = await window.apiPromise;
    const settingUpdate = (section, key) => (
        (data) => {
            rawSettings[section][key] = data;
            window.sessionStorage.setItem("settings", JSON.stringify(rawSettings));
            return window.api.settings.setValue(section, key, data);
        }
    );
    const setSetting = (section, key) => {
        Object.defineProperty(jmpInfo.settings[section], key, {
            set: settingUpdate(section, key),
            get: () => rawSettings[section][key]
        });
    };
    for (const settingGroup of Object.keys(rawSettings)) {
        jmpInfo.settings[settingGroup] = {};
        for (const setting of Object.keys(rawSettings[settingGroup])) {
            setSetting(settingGroup, setting, jmpInfo.settings[settingGroup][setting]);
        }
    }
    window.api.settings.sectionValueUpdate.connect(
        (section, data) => {
            Object.assign(rawSettings[section], data);
            for (const callback of jmpInfo.settingsUpdate) {
                try {
                    callback(section, data);
                } catch (e) {
                    console.error("Update handler failed:", e);
                }
            }

            // Settings will be outdated if page reloads, so save them to session storage
            window.sessionStorage.setItem("settings", JSON.stringify(rawSettings));
        }
    );
    window.api.settings.groupUpdate.connect(
        (section, data) => {
            jmpInfo.settingsDescriptions[section] = data.settings;
            for (const callback of jmpInfo.settingsDescriptionsUpdate) {
                try {
                    callback(section, data);
                } catch (e) {
                    console.error("Description update handler failed:", e);
                }
            }

            // Settings will be outdated if page reloads, so save them to session storage
            window.sessionStorage.setItem("settingsDescriptions", JSON.stringify(jmpInfo.settingsDescriptions));
        }
    );

    // Sync cursor visibility with jellyfin-web's mouse idle state
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.attributeName === 'class') {
                const isIdle = document.body.classList.contains('mouseIdle');
                window.api.window.setCursorVisibility(!isIdle);
            }
        }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    resolve();
});

window.NativeShell.AppHost = {
    init() {
        return Promise.resolve({
            deviceName: jmpInfo.deviceName,
            appName: "Tigerest Theater",
            appVersion: jmpInfo.version
        });
    },
    getDefaultLayout() {
        return jmpInfo.mode;
    },
    supports(command) {
        const feature = String(command).toLowerCase();
        // Only Jellyfin opens the offline library from its own user menu.
        if (feature === 'downloadmanagement') return features.includes('filedownload') && !!window.TigerestServer?.isJellyfin();
        return features.includes(feature);
    },
    getDeviceProfile,
    getSyncProfile: getDeviceProfile,
    appName() {
        return "Tigerest Theater";
    },
    appVersion() {
        return jmpInfo.version;
    },
    deviceName() {
        return jmpInfo.deviceName;
    },
    exit() {
        window.api.system.exit();
    }
};

async function showLegacySettingsModal() {
    await initCompleted;

    const tooltipCSS = `
        .tooltip {
            position: relative;
            display: inline-block;
            margin-left: 0.5rem;
            font-size: 18px;
            vertical-align: sub;
        }

        .tooltip .tooltip-text {
            visibility: hidden;
            width: max-content;
            max-width: 40em;
            background-color: black;
            color: white;
            text-align: left;
            position: absolute;
            z-index: 1;
            border-radius: 6px;
            padding: 5px;
            top: -4px;
            left: 25px;
            border: solid 1px grey;
            font-size: 12px;
        }

        .tooltip:hover .tooltip-text {
            visibility: visible;
        }`;

    var style = document.createElement('style')
    style.innerText = tooltipCSS
    document.head.appendChild(style)

    const modalContainer = document.createElement("div");
    modalContainer.className = "dialogContainer";
    modalContainer.style.backgroundColor = "rgba(0,0,0,0.5)";
    modalContainer.addEventListener("click", e => {
        if (e.target == modalContainer) {
            modalContainer.remove();
        }
    });
    document.body.appendChild(modalContainer);

    const modalContainer2 = document.createElement("div");
    modalContainer2.className = "focuscontainer dialog dialog-fixedSize dialog-small formDialog opened";
    modalContainer.appendChild(modalContainer2);

    const modalHeader = document.createElement("div");
    modalHeader.className = "formDialogHeader";
    modalContainer2.appendChild(modalHeader);

    const title = document.createElement("h3");
    title.className = "formDialogHeaderTitle";
    title.textContent = "Client Settings";
    modalHeader.appendChild(title);

    const modalContents = document.createElement("div");
    modalContents.className = "formDialogContent smoothScrollY";
    modalContents.style.paddingTop = "2em";
    modalContents.style.marginBottom = "6.2em";
    modalContainer2.appendChild(modalContents);

    const settingUpdateHandlers = {};
    for (const sectionOrder of jmpInfo.sections.sort((a, b) => a.order - b.order)) {
        const section = sectionOrder.key;
        const group = document.createElement("fieldset");
        group.className = "editItemMetadataForm editMetadataForm dialog-content-centered";
        group.style.border = 0;
        group.style.outline = 0;
        modalContents.appendChild(group);

        const createSection = async (clear) => {
            if (clear) {
                group.innerHTML = "";
            }

            const values = jmpInfo.settings[section];
            const settings = jmpInfo.settingsDescriptions[section];

            const legend = document.createElement("legend");
            const legendHeader = document.createElement("h2");
            legendHeader.textContent = section;
            legendHeader.style.textTransform = "capitalize";
            legend.appendChild(legendHeader);
            if (section == "other") {
                const legendSubHeader = document.createElement("h4");
                legendSubHeader.textContent = "Use this section to input custom MPV configuration. These will override the above settings.";
                legend.appendChild(legendSubHeader);
            }
            group.appendChild(legend);

            for (const setting of settings) {
                const label = document.createElement("label");
                label.className = "inputContainer";
                label.style.marginBottom = "1.8em";
                label.style.display = "block";

                let helpElement;
                if (setting.help) {
                    helpElement = document.createElement("div");
                    helpElement.className = "tooltip";
                    const helpIcon = document.createElement("span");
                    helpIcon.style.fontSize = "18px"
                    helpIcon.className = "material-icons help_outline";
                    helpElement.appendChild(helpIcon);
                    const tooltipElement = document.createElement("span");
                    tooltipElement.className = "tooltip-text";
                    tooltipElement.innerText = setting.help;
                    helpElement.appendChild(tooltipElement);
                }

                if (setting.options) {
                    const safeValues = {};
                    const control = document.createElement("select");
                    control.className = "emby-select-withcolor emby-select";
                    for (const option of setting.options) {
                        safeValues[String(option.value)] = option.value;
                        const opt = document.createElement("option");
                        opt.value = option.value;
                        opt.selected = option.value == values[setting.key];
                        let optionName = option.title;
                        const swTest = `${section}.${setting.key}.`;
                        const swTest2 = `${section}.`;
                        if (optionName.startsWith(swTest)) {
                            optionName = optionName.substring(swTest.length);
                        } else if (optionName.startsWith(swTest2)) {
                            optionName = optionName.substring(swTest2.length);
                        }
                        opt.appendChild(document.createTextNode(optionName));
                        control.appendChild(opt);
                    }
                    control.addEventListener("change", async (e) => {
                        jmpInfo.settings[section][setting.key] = safeValues[e.target.value];
                    });
                    const labelText = document.createElement('label');
                    labelText.className = "inputLabel";
                    labelText.textContent = (setting.displayName ? setting.displayName : setting.key) + ": ";
                    label.appendChild(labelText);
                    if (helpElement) label.appendChild(helpElement);
                    label.appendChild(control);
                } else if (setting.inputType === "textarea") {
                    const control = document.createElement("textarea");
                    control.className = "emby-select-withcolor emby-select";
                    control.style = "resize: none;"
                    control.value = values[setting.key];
                    control.rows = 5;
                    control.addEventListener("change", e => {
                        jmpInfo.settings[section][setting.key] = e.target.value;
                    });
                    const labelText = document.createElement('label');
                    labelText.className = "inputLabel";
                    labelText.textContent = (setting.displayName ? setting.displayName : setting.key) + ": ";
                    label.appendChild(labelText);
                    if (helpElement) label.appendChild(helpElement);
                    label.appendChild(control);
                } else {
                    const control = document.createElement("input");
                    control.type = "checkbox";
                    control.checked = values[setting.key];
                    control.addEventListener("change", e => {
                        jmpInfo.settings[section][setting.key] = e.target.checked;
                    });
                    label.appendChild(control);
                    label.appendChild(document.createTextNode(" " + (setting.displayName ? setting.displayName : setting.key)));
                    if (helpElement) label.appendChild(helpElement);
                }

                group.appendChild(label);
            }
        };
        settingUpdateHandlers[section] = () => createSection(true);
        createSection();
    }

    const onSectionUpdate = (section) => {
        if (section in settingUpdateHandlers) {
            settingUpdateHandlers[section]();
        }
    };
    jmpInfo.settingsDescriptionsUpdate.push(onSectionUpdate);
    jmpInfo.settingsUpdate.push(onSectionUpdate);

    if (jmpInfo.settings.main.userWebClient) {
        const group = document.createElement("fieldset");
        group.className = "editItemMetadataForm editMetadataForm dialog-content-centered";
        group.style.border = 0;
        group.style.outline = 0;
        modalContents.appendChild(group);
        const legend = document.createElement("legend");
        const legendHeader = document.createElement("h2");
        legendHeader.textContent = "已保存的媒体服务器";
        legend.appendChild(legendHeader);
        const legendSubHeader = document.createElement("h4");
        legendSubHeader.textContent = (
            "返回客户端服务器选择页。保留已保存的地址、登录信息与播放器设置。"
        );
        legend.appendChild(legendSubHeader);
        group.appendChild(legend);

        const resetSavedServer = document.createElement("button");
        resetSavedServer.className = "raised button-cancel block btnCancel emby-button";
        resetSavedServer.textContent = "切换服务器"
        resetSavedServer.style.marginLeft = "auto";
        resetSavedServer.style.marginRight = "auto";
        resetSavedServer.style.maxWidth = "50%";
        resetSavedServer.addEventListener("click", window.tigerestSwitchServer);
        group.appendChild(resetSavedServer);
    }

    const offlineGroup = document.createElement("fieldset");
    offlineGroup.className = "editItemMetadataForm editMetadataForm dialog-content-centered";
    offlineGroup.style.border = 0;
    offlineGroup.style.outline = 0;
    const offlineTitle = document.createElement("h2");
    offlineTitle.textContent = "离线媒体";
    offlineGroup.appendChild(offlineTitle);
    const offlineButton = document.createElement("button");
    offlineButton.className = "raised block emby-button";
    offlineButton.textContent = "打开下载与离线媒体管理";
    offlineButton.addEventListener("click", () => {
        modalContainer.remove();
        window.tigerestOpenOfflineLibrary();
    });
    offlineGroup.appendChild(offlineButton);
    modalContents.appendChild(offlineGroup);

    const closeContainer = document.createElement("div");
    closeContainer.className = "formDialogFooter";
    modalContents.appendChild(closeContainer);

    const close = document.createElement("button");
    close.className = "raised button-cancel block btnCancel formDialogFooterItem emby-button";
    close.textContent = "关闭"
    close.addEventListener("click", () => {
        modalContainer.remove();
    });
    closeContainer.appendChild(close);
}

function createRifeExtensionPanel({element, player, settings, save, notify}) {
    if (typeof player.rifeExtensionStatus !== 'function') return null;
    const node = element('div', 'tgs-callout');
    node.id = 'tigerest-rife-extension';
    node.appendChild(element('strong', '', 'NVIDIA RIFE 扩展'));
    const summary = element('div', 'tgs-help');
    const progress = element('div', 'tgs-help');
    const runtime = element('div', 'tgs-help');
    node.append(summary, progress, runtime);
    const presets = {
        balanced: ['均衡 · 4.25 / 约 60 fps', 'rife-4.25', 60],
        quality: ['画质对比 · heavy / 约 60 fps', 'rife-4.25-heavy', 60],
        high: ['高帧率实验 · lite / 约 240 fps', 'rife-4.25-lite', 240],
        '4k': ['4K 补帧实验 · lite / 约 120 fps', 'rife-4.25-lite', 120],
    };
    const preset = element('select', 'tgs-control');
    preset.setAttribute?.('aria-label', 'RIFE 快速方案');
    for (const [id, title] of [['custom', '自定义模型与目标'], ...Object.entries(presets).map(([id, value]) => [id, value[0]])]) {
        const option = element('option', '', title); option.value = id; preset.appendChild(option);
    }
    const refreshPreferences = () => {
        preset.value = Object.keys(presets).find(id => presets[id][1] === settings.aiRifeModel && presets[id][2] === settings.aiRifeTarget) || 'custom';
    };
    preset.addEventListener('change', () => {
        const selected = presets[preset.value];
        if (!selected) return;
        save('aiRifeModel', selected[1]); save('aiRifeTarget', selected[2]);
        refreshPreferences();
    });
    node.appendChild(element('div', 'tgs-help', '快速方案（下方仍可分别选模型和帧率）：'));
    node.appendChild(preset);
    node.appendChild(element('div', 'tgs-help', '目标帧率由你决定；持续丢帧只提示，不自动关闭补帧或降低目标。建议先试 lite＋两倍帧率，再逐步提高。首次准备引擎时暂停播放并显示进度，完成后自动开始；已有引擎会直接复用。补帧保留你选择的音画同步模式。'));
    const actions = element('div', 'tgs-actions');
    const download = element('button', 'tgs-action', '下载扩展');
    const offline = element('button', 'tgs-action', '导入离线包');
    const cancel = element('button', 'tgs-action', '取消操作');
    const remove = element('button', 'tgs-action', '移除扩展');
    actions.append(download, offline, cancel, remove); node.appendChild(actions);
    let current = {state: 'checking', busy: true}, disposed = false, pending = false, revision = 0;
    const size = bytes => `${(Number(bytes || 0) / 1e9).toFixed(2)} GB`;
    const render = status => {
        if (disposed) return;
        current = status;
        const pack = status.packages?.[0];
        const states = {notInstalled: '尚未安装', checking: '正在核验', downloading: '正在下载', installing: '正在安装', removing: '正在移除', ready: '已安装', restartRequired: '请完全退出并重启客户端', cancelled: '操作已取消', error: '操作失败'};
        const packageKind = pack?.gpuArchitecture && pack.gpuArchitecture !== 'full' ? '当前显卡适配包' : '完整兼容包';
        summary.textContent = pack
            ? `${states[status.state] || status.state} · 推荐下载扩展 ${pack.version} · ${packageKind}：下载 ${size(pack.downloadSize)}，展开 ${size(pack.unpackedSize)}。运行库由各配置共用，引擎缓存按当前配置保存。`
            : `${states[status.state] || status.state} · 当前版本尚未提供可安装的扩展包。`;
        const done = Number(status.doneBytes || 0), total = Number(status.totalBytes || 0);
        progress.textContent = status.error ? String(status.error) : status.busy && total > 0
            ? `${Math.min(100, Math.floor(done * 100 / total))}% · ${size(done)} / ${size(total)}` : '';
        const r = status.runtime || {};
        runtime.textContent = status.restartRequired ? '安装或移除将在重启后生效。'
            : r.enginePreparing ? '正在准备引擎，播放已暂停；准备完成后自动开始。首次准备可能需要数分钟。'
            : r.runtimePreparing ? '正在检查 NVIDIA 运行库。'
            : r.activated ? r.playback?.status || '运行库已就绪；模型与目标帧率在下次播放生效。'
            : status.state === 'ready' ? r.error || '运行库尚未就绪；基础播放仍可使用。' : '';
        const busy = pending || Boolean(status.busy);
        download.disabled = busy || !pack?.downloadAvailable;
        offline.disabled = busy || !pack;
        cancel.disabled = !status.busy;
        remove.disabled = busy || !status.installedVersion || Boolean(status.removalPending);
        download.title = pack?.downloadAvailable ? '仅在点击后下载' : '在线附件尚未发布，可导入本版本的离线包';
    };
    const refresh = async () => {
        const token = ++revision;
        try { const status = await player.rifeExtensionStatus(); if (token === revision) render(status); }
        catch (error) { if (!disposed && token === revision) { progress.textContent = `读取补帧状态失败：${error.message || error}`; } }
    };
    const changed = status => { ++revision; render(status); };
    const request = async action => {
        if (pending || current.busy || disposed) return;
        pending = true; render(current);
        try { if (!(await action())) notify('另一个操作正在进行，请稍后重试。'); }
        catch (error) { notify(`补帧扩展操作失败：${error.message || error}`); }
        finally { pending = false; if (!disposed) await refresh(); }
    };
    download.addEventListener('click', () => request(() => player.downloadRifeExtension(current.packages[0].id)));
    offline.addEventListener('click', () => request(() => player.importRifeExtension()));
    cancel.addEventListener('click', () => player.cancelRifeExtensionOperation());
    remove.addEventListener('click', () => request(() => player.removeRifeExtension()));
    player.rifeExtensionStatusChanged?.connect(changed);
    const timer = setInterval(refresh, 1500);
    refreshPreferences(); render(current); refresh();
    return {node, refreshPreferences, dispose() {
        disposed = true; ++revision; clearInterval(timer);
        player.rifeExtensionStatusChanged?.disconnect(changed);
    }};
}

function createRifeTargetControl({element, value, save, notify}) {
    const input = element('input', 'tgs-control');
    input.type = 'number'; input.min = '0'; input.max = '360'; input.step = '1';
    let saved = value;
    input.value = value;
    input.addEventListener('change', () => {
        const raw = String(input.value).trim(), target = Number(raw);
        if (!raw || !Number.isInteger(target) || (target !== 0 && (target < 24 || target > 360))) {
            input.value = saved;
            notify('请输入 24–360 的整数帧率，或输入 0 使用源帧率两倍。');
            return;
        }
        saved = target; save(target);
    });
    input.setSavedValue = newValue => { saved = newValue; input.value = newValue; };
    return input;
}

// Which media folders the home shows, and in what order, for the signed-in
// server and account. The layout stays on this device (home.libraryLayout).
function createHomeLibraryControl({element, apiProvider, save, notify}) {
    const Home = window.TigerestHomeData;
    if (!Home) return null;
    const node = element('div', 'tgs-setting tgs-home-libraries');
    node.dataset.setting = 'home.libraryLayout';
    node.dataset.search = '首页设置 首页媒体夹 媒体库 显示 隐藏 排序 顺序';
    const heading = element('div', 'tgs-setting-title');
    heading.id = 'tgs-home-libraries-title';
    heading.appendChild(element('span', '', '首页媒体夹'));
    const help = element('div', 'tgs-help fieldDescription', '勾选要在首页左侧显示的媒体夹，用“上移”“下移”调整先后顺序。只对当前服务器和账号生效，保存在这台设备上。');
    const list = element('ol', 'tgs-library-list');
    list.setAttribute('aria-labelledby', heading.id);
    const message = element('div', 'tgs-help');
    const actions = element('div', 'tgs-actions');
    const restore = element('button', 'tgs-action', '恢复服务器默认顺序');
    restore.type = 'button'; restore.hidden = true;
    actions.appendChild(restore);
    node.append(heading, help, message, list, actions);
    const abort = new AbortController();
    let rows = [], key = null, candidates = [];
    const store = next => {
        rows = next;
        save(Home.writeLayout(key, rows));
        render();
    };
    const render = focus => {
        list.replaceChildren(...rows.map((row, index) => {
            const name = row.library.Name || '媒体库 ' + (index + 1);
            const item = element('li', 'tgs-library-row');
            const label = element('label', 'tgs-library-check');
            const box = element('input', 'tgs-switch');
            box.type = 'checkbox'; box.checked = row.visible;
            box.addEventListener('change', () => {
                if (!box.checked && rows.filter(other => other.visible).length === 1) {
                    box.checked = true;
                    notify('首页至少保留一个媒体夹。');
                    return;
                }
                store(rows.map(other => other === row ? {...other, visible: box.checked} : other));
            });
            label.append(box, element('span', 'tgs-library-name', name));
            const move = (text, offset) => {
                const button = element('button', 'tgs-library-move', text);
                button.type = 'button';
                button.setAttribute('aria-label', `${text}：${name}`);
                button.disabled = index + offset < 0 || index + offset >= rows.length;
                button.addEventListener('click', () => {
                    const next = rows.slice();
                    [next[index], next[index + offset]] = [next[index + offset], next[index]];
                    store(next);
                    // Keep the moved folder under the keyboard.
                    const target = list.children[index + offset]?.querySelectorAll('.tgs-library-move')[offset < 0 ? 0 : 1];
                    (target && !target.disabled ? target : list.children[index + offset]?.querySelector('input'))?.focus();
                });
                return button;
            };
            item.append(label, move('上移', -1), move('下移', 1));
            return item;
        }));
        restore.hidden = !Home.readLayout(key);
    };
    restore.addEventListener('click', () => {
        save(Home.writeLayout(key, null));
        rows = Home.arrange(candidates, null);
        render();
    });
    const load = async () => {
        const api = apiProvider?.();
        if (!api?.getCurrentUserId?.()) {
            message.textContent = '登录服务器后，可以在这里选择首页显示的媒体夹。';
            return;
        }
        message.textContent = '正在读取媒体夹…';
        try {
            candidates = await new Home(api).candidates(abort.signal);
            if (abort.signal.aborted) return;
            key = Home.layoutKey(api);
            rows = Home.arrange(candidates, Home.readLayout(key));
            message.textContent = '';
            render();
        } catch (error) {
            if (abort.signal.aborted) return;
            message.textContent = '读取媒体夹失败，请稍后重新打开此页。';
        }
    };
    load();
    return {node, dispose: () => abort.abort()};
}

function getTigerestSettingsCategories() {
    const sectionMeta = {
        main: {
            title: '客户端',
            icon: '&#xe30c;', // desktop_windows
            subtitle: '窗口、启动与系统集成'
        },
        home: {
            title: '首页设置',
            icon: '&#xe88a;', // home
            subtitle: '启动全屏、展示顺序与继续观看'
        },
        audio: {
            title: '音频',
            icon: '&#xe050;', // volume_up
            subtitle: '输出设备、声道与直通'
        },
        video: {
            title: '视频',
            icon: '&#xe04b;', // videocam
            subtitle: '硬件解码、同步与转码策略'
        },
        subtitles: {
            title: '字幕',
            icon: '&#xe01c;', // closed_caption
            subtitle: '字体、样式、位置与 ASS 行为'
        },
        mpv: {
            title: 'MPV 画质与插件',
            icon: '&#xe024;', // high_quality
            subtitle: '渲染后端、插件与 mpv.conf 编辑器'
        },
        danmaku: {
            title: '弹幕样式',
            icon: '&#xe0b7;', // chat
            subtitle: '内置 uosc_danmaku 的长期默认外观'
        }
    };
    if (window.tigerestAndroidApi || window.tigerestIPadApi) {
        sectionMeta.main.subtitle = '服务器、窗口与网页浏览';
        sectionMeta.audio.subtitle = '声道与音量均衡';
        sectionMeta.mpv.title = '播放器';
        sectionMeta.mpv.subtitle = '音轨偏好、HDR、缓存与弹幕';
        sectionMeta.danmaku.subtitle = '字号、描边、速度、透明度与显示范围';
    }
    return [...jmpInfo.sections].sort((a, b) => a.order - b.order)
        .filter(entry => sectionMeta[entry.key] && jmpInfo.settingsDescriptions[entry.key])
        .map(entry => ({...entry, ...sectionMeta[entry.key]}));
}

// Settings categories that configure the player. Emby's drawer only knows
// the app and user groups, so these rows get a group of their own and the
// app group becomes the library group.
const TIGEREST_PLAYER_SETTINGS = ['main', 'video', 'audio', 'subtitles', 'mpv', 'danmaku'];
const TIGEREST_LIBRARY_SETTINGS_TITLE = '媒体库设置';
const TIGEREST_PLAYER_SETTINGS_TITLE = '播放器设置';

function tigerestSettingsGroupTitle(section) {
    return TIGEREST_PLAYER_SETTINGS.includes(section) ? TIGEREST_PLAYER_SETTINGS_TITLE : TIGEREST_LIBRARY_SETTINGS_TITLE;
}

function installTigerestSettingsMenu() {
    if (installTigerestSettingsMenu.refresh) {
        installTigerestSettingsMenu.refresh();
        return;
    }
    if (!document.getElementById('tigerest-settings-menu-style')) {
        const style = document.createElement('style');
        style.id = 'tigerest-settings-menu-style';
        style.textContent = '.mainDrawer .tigerest-moved-settings-row, .dynamicRoutes .tigerest-moved-settings-row { display: none !important; }';
        document.head.appendChild(style);
    }
    // The visible player rows are copies; a click goes to the hidden native
    // row so Emby still routes, closes the drawer and keeps its history.
    const copies = new WeakMap();
    const copyRow = original => {
        let copy = copies.get(original);
        if (copy) return copy;
        copy = original.cloneNode(true);
        copy.removeAttribute('data-index');
        copy.removeAttribute('data-action');
        copy.classList.remove('navMenuOption-selected', 'tigerest-moved-settings-row');
        copy.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            original.click();
        });
        copies.set(original, copy);
        return copy;
    };
    const setText = (node, text) => {
        if (node.textContent !== text) node.textContent = text;
        if (node.getAttribute('title') !== text) node.setAttribute('title', text);
        if (node.getAttribute('aria-label') !== text) node.setAttribute('aria-label', text);
    };
    const groupPlayerRows = rows => {
        const anchor = rows.values().next().value;
        const appSection = anchor?.closest('.navDrawerCollapseSection');
        if (!appSection) return;
        const header = appSection.querySelector('.navMenuHeader');
        if (header) setText(header, TIGEREST_LIBRARY_SETTINGS_TITLE);
        let section = appSection.nextElementSibling?.classList.contains('tigerest-player-settings')
            ? appSection.nextElementSibling : null;
        if (!section) {
            section = document.createElement('div');
            section.className = 'navDrawerCollapseSection focuscontainer-x tigerest-player-settings';
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'navDrawerCollapseButton noautofocus emby-collapsible-button emby-button emby-button-focusscale';
            toggle.setAttribute('aria-expanded', 'true');
            const title = document.createElement('h3');
            title.className = 'navMenuHeader secondaryText emby-collapsible-title';
            setText(title, TIGEREST_PLAYER_SETTINGS_TITLE);
            const icon = document.createElement('i');
            icon.className = 'navDrawerCollapseIcon md-icon emby-collapse-expandIcon emby-collapse-expandIconExpanded';
            icon.textContent = 'expand_more';
            toggle.append(title, icon);
            const list = document.createElement('div');
            list.className = 'navDrawerItemsContainer vertical-list collapseContent navDrawerCollapseContent expanded tigerest-player-settings-items';
            // Emby's collapse styles keep .collapseContent at zero height
            // unless the element carries an explicit height, as its own
            // emby-collapse sets.
            list.style.height = 'auto';
            toggle.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                const expanded = toggle.getAttribute('aria-expanded') !== 'true';
                toggle.setAttribute('aria-expanded', String(expanded));
                icon.classList.toggle('emby-collapse-expandIconExpanded', expanded);
                list.classList.toggle('expanded', expanded);
                list.style.height = expanded ? 'auto' : '0px';
            });
            section.append(toggle, list);
            appSection.after(section);
        }
        const list = section.querySelector('.tigerest-player-settings-items');
        const wanted = TIGEREST_PLAYER_SETTINGS.filter(key => rows.has(key)).map(key => copyRow(rows.get(key)));
        // Only touch the DOM when the rows changed: this runs from a
        // MutationObserver on the drawer.
        if (wanted.length !== list.children.length || wanted.some((row, index) => list.children[index] !== row))
            list.replaceChildren(...wanted);
    };
    // Emby's settings page (the phone layout's way into settings) renders the
    // same menu without collapsible sections: a header row, then its list.
    const groupPagePlayerRows = rows => {
        const container = rows.values().next().value?.closest('.itemsContainer');
        const header = container?.previousElementSibling;
        if (!header?.classList.contains('navMenuHeader')) return;
        const heading = header.querySelector('h3');
        if (heading) setText(heading, TIGEREST_LIBRARY_SETTINGS_TITLE);
        let block = container.nextElementSibling?.classList.contains('tigerest-player-settings-page')
            ? container.nextElementSibling : null;
        if (!block) {
            block = document.createElement('div');
            block.className = 'tigerest-player-settings-page';
            const title = header.cloneNode(false);
            title.classList.remove('navMenuHeader-first');
            const text = document.createElement('h3');
            text.className = heading?.className || 'flex-shrink-zero';
            text.style.margin = '0';
            setText(text, TIGEREST_PLAYER_SETTINGS_TITLE);
            title.append(text);
            const list = document.createElement('div');
            list.className = container.className + ' tigerest-player-settings-items';
            block.append(title, list);
            container.after(block);
        }
        const list = block.querySelector('.tigerest-player-settings-items');
        const wanted = TIGEREST_PLAYER_SETTINGS.filter(key => rows.has(key)).map(key => copyRow(rows.get(key)));
        if (wanted.length !== list.children.length || wanted.some((row, index) => list.children[index] !== row))
            list.replaceChildren(...wanted);
    };
    const refresh = () => {
        const active = document.querySelector('#tigerest-settings-inline .tgs-section.active')?.dataset.section;
        const playerRows = new Map(), pageRows = new Map();
        for (const row of document.querySelectorAll('.mainDrawer .navMenuOption, .dynamicRoutes .navMenuOption')) {
            if (row.closest('.tigerest-player-settings, .tigerest-player-settings-page')) continue;
            const onPage = !row.closest('.mainDrawer');
            // Emby's custom-action list rows resolve their route via the native
            // items container, rather than an href on the rendered element.
            const container = row.closest('.itemsContainer');
            const item = container?.getItemFromElement?.(row)
                || container?.getItem?.(Number(row.dataset.index)) || container?.items?.[Number(row.dataset.index)];
            const href = item?.href || row.getAttribute('href') || '';
            const match = href.match(/\/plugins\/tigerest-native-settings\/settings\/([a-z]+)\.html(?:[?#]|$)/);
            const grouped = match && TIGEREST_PLAYER_SETTINGS.includes(match[1]) && (onPage || row.closest('.navDrawerCollapseSection'));
            row.classList.toggle('tigerest-moved-settings-row', Boolean(grouped));
            if (grouped) {
                // The visible copy carries the category; the hidden native row
                // only routes.
                delete row.dataset.settingsCategory;
                (onPage ? pageRows : playerRows).set(match[1], row);
                const copy = copyRow(row);
                copy.dataset.settingsCategory = match[1];
                copy.classList.toggle('navMenuOption-selected', active ? match[1] === active : row.classList.contains('navMenuOption-selected'));
                if (active === match[1]) copy.setAttribute('aria-current', 'page');
                else copy.removeAttribute('aria-current');
            } else if (match) {
                row.dataset.settingsCategory = match[1];
                if (active) row.classList.toggle('navMenuOption-selected', match[1] === active);
                if (active === match[1]) row.setAttribute('aria-current', 'page');
                else row.removeAttribute('aria-current');
            } else if (row.hasAttribute('data-settings-category')) {
                // Virtualized native rows may be reused for an unrelated item.
                delete row.dataset.settingsCategory;
                row.removeAttribute('aria-current');
            }
        }
        if (playerRows.size) groupPlayerRows(playerRows);
        if (pageRows.size) groupPagePlayerRows(pageRows);
    };
    installTigerestSettingsMenu.refresh = refresh;
    // Drawer content is lazy on mobile and rebuilt when Emby changes context;
    // the settings page renders its menu when shown.
    // Observe insertions only; native focus and selected-class updates remain Emby's.
    const menus = '.mainDrawer, .dynamicRoutes';
    const observer = new MutationObserver(mutations => {
        if (mutations.some(mutation => mutation.target.closest?.(menus)
            || [...mutation.addedNodes].some(node => node.nodeType === 1
                && (node.matches(menus) || node.querySelector(menus))))) refresh();
    });
    observer.observe(document.documentElement, {childList: true, subtree: true});
    refresh();
}

async function mountTigerestSettings(host = null, initialSection = null, onReturn = null, signal = null, options = {}) {
    await initCompleted;
    if (signal?.aborted) return;

    let mpvDiagnostics = {};
    try {
        mpvDiagnostics = await window.api.player.mpvDiagnostics();
    } catch (error) {
        console.warn('Unable to read MPV diagnostics', error);
    }

    if (signal?.aborted) return;
    const previous = host ? host.querySelector('#tigerest-settings-inline') : document.getElementById('tigerest-settings-overlay');
    if (previous) return;
    const returnFocus = document.activeElement;
    const priorBodyOverflow = document.body.style.overflow;
    const orderedSections = getTigerestSettingsCategories();
    const restartSettings = new Set([
        'home.startupFullscreen',
        'main.enableMPV',
        'mpv.renderBackend',
        'mpv.enableUosc',
        'mpv.enableConsole',
        'mpv.enableDanmaku',
        'danmaku.bold',
        'danmaku.fontsize',
        'danmaku.outline',
        'danmaku.shadow',
        'danmaku.scrolltime',
        'danmaku.opacity',
        'danmaku.displayarea'
    ]);
    // On the desktop the mpv.conf editor owns these: the quality preset, the
    // profile parameters and the playback options are lines of that file.
    // Android and iPad keep the plain settings, which they apply themselves.
    const desktopMpvEditor = !window.tigerestAndroidApi && !window.tigerestIPadApi &&
        typeof window.tigerestCreateMpvConfEditor === 'function' && typeof window.api?.player?.mpvConfState === 'function';
    const editorMpvSettings = new Set([
        'configMode',
        'systemConfigDir',
        'advancedProfileOverrides',
        'shaderPreset',
        'scale',
        'cscale',
        'dscale',
        'interpolation',
        'tscale',
        'deband',
        'debandIterations',
        'debandThreshold',
        'debandRange',
        'debandGrain',
        'sigmoidUpscaling',
        'correctDownscaling',
        'scaleAntiring',
        'cscaleAntiring',
        'targetColorspaceHint',
        'iccProfileAuto',
        'toneMapping',
        'gamutMappingMode',
        'hdrComputePeak',
        'ditherDepth',
        'blendSubtitles',
        'audioLanguage',
        'subtitleLanguage',
        'cachePause',
        'demuxerMaxBackBytes',
        'screenshotFormat',
        'screenshotDirectory'
    ]);
    let mpvConfEditor = null;

    const css = document.createElement('style');
    css.id = 'tigerest-settings-style';
    css.textContent = `
        #tigerest-settings-overlay {
            position: fixed; inset: 0; z-index: 100000;
            display: flex; background: #141414;
        }
        .tgs-dialog {
            box-sizing: border-box; width: 100%; height: 100%; min-width: 0;
            display: grid; grid-template-rows: auto minmax(0, 1fr) auto;
            color: inherit; background: #141414; color-scheme: dark;
            border: 0; border-radius: 0; overflow: hidden; font: inherit;
        }
        #tigerest-settings-overlay .tgs-dialog { color: #eee; }
        .tgs-header {
            display: flex; align-items: center; gap: 24px; padding: 24px clamp(20px, 4vw, 56px);
            border-bottom: 1px solid rgba(255,255,255,.09);
        }
        .tgs-title { margin: 0; font-size: 26px; line-height: 1.3; font-weight: 500; }
        .tgs-subtitle { margin-top: 8px; color: #aaa; font-size: 13px; line-height: 1.5; }
        .tgs-search {
            box-sizing: border-box; margin-left: auto; width: min(310px, 31vw); min-height: 44px; padding: 10px 12px;
            color: inherit; background: #252525; border: 1px solid #555;
            border-radius: 3px; outline: none; font: inherit; font-size: 14px;
        }
        .tgs-search:focus { border-color: #ffbe38; }
        .tgs-body { min-height: 0; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
        .tgs-category-select { max-width: 240px; }
        .tgs-with-nav .tgs-body { grid-template-columns: 240px minmax(0, 1fr); }
        .tgs-with-nav .tgs-category-select { display: none; }
        .tgs-nav { min-height: 0; overflow-y: auto; padding: 24px 12px 32px clamp(12px, 2vw, 32px); border-right: 1px solid rgba(255,255,255,.08); }
        .tgs-nav-title { margin: 20px 12px 8px; color: #aaa; font-size: 13px; font-weight: 500; }
        .tgs-nav-title:first-child { margin-top: 0; }
        .tgs-nav-item {
            display: block; box-sizing: border-box; width: 100%; min-height: 44px; padding: 10px 12px; color: inherit;
            background: none; border: 0; border-radius: 3px; text-align: left; font: inherit; font-size: 15px; cursor: pointer;
        }
        .tgs-nav-item:hover { background: rgba(255,255,255,.06); }
        .tgs-nav-item.active { color: #ffbe38; background: rgba(255,190,56,.1); }
        .tgs-content { min-width: 0; overflow-y: auto; padding: 30px clamp(20px, 4vw, 56px) 48px; scrollbar-gutter: stable; }
        .tgs-section { display: none; max-width: 760px; margin: 0 auto 32px; }
        .tgs-section.active { display: block; }
        .tgs-section-head { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-bottom: 24px; }
        .tgs-section-head h2 { margin: 0; font-size: 24px; font-weight: 400; }
        .tgs-section-head p { margin: 8px 0 0; color: #aaa; font-size: 14px; line-height: 1.5; }
        .tgs-reset {
            margin-left: auto; min-height: 44px; padding: 8px 12px; color: #ffbe38; font: inherit; font-size: 13px;
            background: transparent; border: 0; border-radius: 3px; cursor: pointer;
        }
        .tgs-callout {
            margin: 0 0 24px; padding: 0 0 0 14px; color: #bbb;
            border: 0; border-left: 2px solid #6d582a; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere;
        }
        .tgs-setting {
            display: grid; grid-template-columns: minmax(0, 1fr); gap: 9px; padding: 0; margin-bottom: 28px;
        }
        .tgs-setting-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 15px; font-weight: 400; line-height: 1.5; }
        .tgs-help { margin-top: 0; color: #aaa; font-size: 13px; line-height: 1.6; white-space: pre-line; overflow-wrap: anywhere; }
        .tgs-restart {
            display: inline-block; color: #c7aa68; font-size: 11px; font-weight: 400;
        }
        .tgs-scope {
            display: inline-block; color: #aaa; font-size: 11px; font-weight: 400;
        }
        .tgs-control {
            box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; padding: 10px 12px;
            color: inherit; background: #252525; border: 1px solid #555; border-radius: 3px; outline: none; font: inherit; font-size: 15px;
        }
        .tgs-control:focus { border-color: #ffbe38; }
        textarea.tgs-control { min-height: 150px; resize: vertical; font-family: Consolas, Menlo, monospace; }
        .tgs-setting-boolean { grid-template-columns: 28px minmax(0, 1fr); column-gap: 12px; }
        .tgs-setting-boolean .tgs-setting-title { grid-column: 2; grid-row: 1; min-height: 32px; cursor: pointer; }
        .tgs-setting-boolean .tgs-switch-wrap { grid-column: 1; grid-row: 1; }
        .tgs-setting-boolean .tgs-help { grid-column: 2; }
        .tgs-switch-wrap { display: flex; align-items: center; }
        .tgs-switch { width: 22px; height: 22px; margin: 0; accent-color: #ffbe38; cursor: pointer; }
        .tgs-switch-state { display: none; }
        .tgs-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 22px; }
        .tgs-home-libraries .tgs-actions { margin-top: 4px; }
        .tgs-library-list { display: grid; gap: 6px; margin: 4px 0 0; padding: 0; list-style: none; }
        .tgs-library-row { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 0 8px 0 12px; background: #1f1f1f; border: 1px solid #333; border-radius: 3px; }
        .tgs-library-check { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; min-height: 44px; cursor: pointer; }
        .tgs-library-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
        .tgs-library-move { flex: none; min-width: 56px; min-height: 36px; padding: 6px 10px; color: #ddd; background: #303030; border: 0; border-radius: 3px; cursor: pointer; font: inherit; font-size: 13px; }
        .tgs-library-move:disabled { opacity: .35; cursor: default; }
        .tgs-action { min-height: 44px; padding: 10px 20px; color: #eee; background: #303030; border: 0; border-radius: 3px; cursor: pointer; font: inherit; font-size: 14px; }
        .tgs-dialog button:focus-visible, .tgs-switch:focus-visible { outline: 2px solid #ffbe38; outline-offset: 2px; }
        .tgs-empty { max-width: 760px; margin: 20px auto; color: #aaa; line-height: 1.6; }
        .tgs-footer {
            display: flex; align-items: center; gap: 14px; padding: 14px clamp(20px, 4vw, 56px);
            border-top: 1px solid rgba(255,255,255,.08);
        }
        .tgs-status { color: #aaa; font-size: 12px; line-height: 1.5; }
        .tgs-close { margin-left: auto; min-width: 96px; min-height: 44px; padding: 10px 18px; color: #171717; background: #ffbe38; border: 0; border-radius: 3px; font: inherit; cursor: pointer; }
        @media (max-width: 760px) {
            .tgs-header { flex-wrap: wrap; gap: 14px; padding: 18px 20px; }
            .tgs-title { font-size: 22px; }
            .tgs-subtitle { font-size: 12px; }
            .tgs-search { width: 100%; margin: 0; font-size: 16px; }
            .tgs-content { padding: 24px 20px 32px; }
            .tgs-control { font-size: 16px; }
            .tgs-section-head { gap: 8px; }
            .tgs-section-head h2 { font-size: 22px; }
            .tgs-reset { margin-left: 0; padding-left: 0; }
            .tgs-footer { padding: 12px 20px; }
            .tgs-with-nav .tgs-body { grid-template-columns: minmax(0, 1fr); }
            .tgs-with-nav .tgs-nav { display: none; }
            .tgs-with-nav .tgs-category-select { display: block; }
        }
        /* Emby does not center .readOnlyContent here, so wide windows left half the page empty. */
        .tigerest-settings-host { width: 100%; max-width: 1200px; margin-left: auto; margin-right: auto; }
        #tigerest-settings-inline .tgs-dialog {
            width: 100%; height: auto; min-height: 520px;
            background: transparent;
        }
        #tigerest-settings-inline .tgs-body { overflow: visible; }
        #tigerest-settings-inline .tgs-content { overflow: visible; min-width: 0; }
        #tigerest-settings-inline .tgs-search { min-width: 0; }
        @media (max-width: 760px) {
            #tigerest-settings-inline .tgs-dialog { min-height: 0; }
            #tigerest-settings-inline .tgs-header { flex-wrap: wrap; }
            #tigerest-settings-inline .tgs-search { width: 100%; }
        }
    `;
    document.head.appendChild(css);

    const element = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };

    const overlay = element('div');
    overlay.id = host ? 'tigerest-settings-inline' : 'tigerest-settings-overlay';
    const dialog = element('div', 'tgs-dialog');
    dialog.setAttribute('role', host ? 'region' : 'dialog');
    if (!host) dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'tgs-settings-title');
    overlay.appendChild(dialog);

    const header = element('div', 'tgs-header');
    const heading = element('div');
    const headingTitle = element('h2', 'tgs-title', tigerestSettingsGroupTitle(initialSection || 'mpv'));
    headingTitle.id = 'tgs-settings-title';
    heading.appendChild(headingTitle);
    heading.appendChild(element('div', 'tgs-subtitle', '常规配置即时应用；带“需重启”标记的项目在下次启动生效'));
    header.appendChild(heading);
    const search = element('input', 'tgs-search');
    search.type = 'search';
    search.placeholder = '搜索当前分类的设置…';
    search.setAttribute('aria-label', '搜索当前分类的设置');
    header.appendChild(search);
    dialog.appendChild(header);

    const body = element('div', 'tgs-body');
    const content = element('main', 'tgs-content');
    body.appendChild(content);
    dialog.appendChild(body);

    // Before the server UI exists there is no Emby drawer. Keep a compact
    // selector in that standalone dialog only; integrated pages use native routes.
    const categorySelect = host ? null : element('select', 'tgs-control tgs-category-select');
    if (categorySelect) {
        categorySelect.setAttribute('aria-label', '设置分类');
        for (const entry of orderedSections) {
            const option = element('option', '', entry.title);
            option.value = entry.key;
            categorySelect.appendChild(option);
        }
        header.insertBefore(categorySelect, search);
        categorySelect.addEventListener('change', () => { search.value = ''; activate(categorySelect.value); applySearch(); });
    }

    // On the desktop the categories stand beside the page in the server
    // settings menu's groups: the player's first, then the library's. Narrow
    // windows keep the selector, grouped the same way.
    const navButtons = new Map();
    if (categorySelect && !window.tigerestAndroidApi && !window.tigerestIPadApi) {
        dialog.classList.add('tgs-with-nav');
        const nav = element('nav', 'tgs-nav');
        nav.setAttribute('aria-label', '设置分类');
        const navGroups = [
            [TIGEREST_PLAYER_SETTINGS_TITLE, TIGEREST_PLAYER_SETTINGS.map(key => orderedSections.find(entry => entry.key === key)).filter(Boolean)],
            [TIGEREST_LIBRARY_SETTINGS_TITLE, orderedSections.filter(entry => !TIGEREST_PLAYER_SETTINGS.includes(entry.key))]
        ];
        categorySelect.replaceChildren();
        for (const [title, entries] of navGroups) {
            if (!entries.length) continue;
            nav.appendChild(element('h3', 'tgs-nav-title', title));
            const options = element('optgroup');
            options.label = title;
            for (const entry of entries) {
                const button = element('button', 'tgs-nav-item', entry.title);
                button.type = 'button';
                button.dataset.section = entry.key;
                button.addEventListener('click', () => { search.value = ''; activate(entry.key); applySearch(); });
                nav.appendChild(button);
                navButtons.set(entry.key, button);
                const option = element('option', '', entry.title);
                option.value = entry.key;
                options.appendChild(option);
            }
            categorySelect.appendChild(options);
        }
        body.insertBefore(nav, content);
    }

    const footer = element('div', 'tgs-footer');
    const status = element('div', 'tgs-status', '设置保存在当前客户端配置中，不会包含媒体服务器密码或令牌。');
    status.setAttribute('role', 'status');
    const closeButton = element('button', 'tgs-close', host ? '返回设置' : '完成');
    footer.append(status, closeButton);
    dialog.appendChild(footer);

    const groups = new Map();
    let activeSection = initialSection || sessionStorage.getItem('tigerestSettingsTab') || 'mpv';
    if (!orderedSections.some(entry => entry.key === activeSection)) {
        activeSection = orderedSections[0]?.key || 'main';
    }

    const showSaved = message => {
        status.textContent = message;
        clearTimeout(showSaved.timer);
        showSaved.timer = setTimeout(() => {
            status.textContent = '设置保存在当前客户端配置中，不会包含媒体服务器密码或令牌。';
        }, 2200);
    };

    // Messages from the player about the user's mpv.conf (RIFE pausing or
    // restoring conflicting lines) stay visible longer than a plain save.
    const showMpvConfMessage = message => {
        showSaved(message);
        clearTimeout(showSaved.timer);
        showSaved.timer = setTimeout(() => {
            status.textContent = '设置保存在当前客户端配置中，不会包含媒体服务器密码或令牌。';
        }, 8000);
    };
    window.api.player?.mpvConfMessage?.connect?.(showMpvConfMessage);

    // The page's own confirmation. A native confirm() blocks the page until
    // its dialog closes, and the Qt dialog can open where the user cannot
    // see it, which leaves the settings page frozen.
    const confirmInPage = (title, message, okLabel) => new Promise(resolve => {
        const modal = element('div', 'tgs-confirm-modal');
        modal.style.cssText = 'position:fixed;inset:0;z-index:100002;display:flex;align-items:center;justify-content:center;background:#000a';
        const box = element('div', 'tgs-confirm-dialog');
        box.setAttribute('role', 'alertdialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', title);
        box.style.cssText = 'box-sizing:border-box;width:min(520px,calc(100vw - 32px));padding:20px 22px;color:#eee;background:#1d1d1d;border:1px solid #444;border-radius:4px;font-size:14px;line-height:1.6';
        box.appendChild(element('div', '', title)).style.cssText = 'font-size:18px;margin-bottom:8px';
        if (message) box.appendChild(element('div', '', message)).style.color = '#bbb';
        const actions = element('div');
        actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:18px';
        const finish = value => { modal.remove(); document.removeEventListener('keydown', onKey, true); resolve(value); };
        const onKey = event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
        };
        const cancel = element('button', 'tgs-action', '取消');
        const ok = element('button', 'tgs-action', okLabel);
        ok.style.cssText = 'color:#171717;background:#ffbe38';
        cancel.type = ok.type = 'button';
        cancel.addEventListener('click', () => finish(false));
        ok.addEventListener('click', () => finish(true));
        actions.append(cancel, ok);
        box.appendChild(actions);
        modal.appendChild(box);
        modal.addEventListener('click', event => { if (event.target === modal) finish(false); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(modal);
        ok.focus();
    });

    const settingControls = new Map();
    let rifeExtensionPanel = null, homeLibraries = null;
    const saveSetting = (section, key, value) => {
        jmpInfo.settings[section][key] = value;
        if (section === 'video' && key === 'aiRife') updateRifeStatus();
        if (section === 'video' && (key === 'aiRifeModel' || key === 'aiRifeTarget')) {
            const control = settingControls.get(key);
            if (control?.input) control.input.setSavedValue(value);
            else if (control) control.select.value = String(control.options.findIndex(option => option.value == value));
            rifeExtensionPanel?.refreshPreferences();
        }
        showSaved(restartSettings.has(`${section}.${key}`) ? '已保存；此项将在重启后生效。'
            : section === 'video' && key.startsWith('aiRife') ? '已保存；重新打开视频后生效。' : '已保存并应用。');
    };

    let rifeCallout = null;
    const updateRifeStatus = () => {
        if (!rifeCallout) return;
        const enabled = Boolean(jmpInfo.settings.video.aiRife);
        const rife = mpvDiagnostics.rife;
        if (enabled && !rife.runtimeAvailable) {
            rifeCallout.textContent = typeof window.api.player.rifeExtensionStatus === 'function'
                ? 'AI 补帧已开启；请先安装 NVIDIA RIFE 扩展并完全退出、重新启动客户端。运行库检查失败时仍可正常播放原帧。'
                : 'AI 补帧已开启，但内置组件尚未加载。请完全退出并重新启动客户端；若仍不可用，请检查安装包是否完整。';
        } else if (enabled && rife.state === 0) {
            rifeCallout.textContent = 'AI 补帧已开启；重新打开视频后生效。';
        } else if (!enabled && (rife.state === 1 || rife.state === 2)) {
            rifeCallout.textContent = 'AI 补帧设置已关闭；当前视频在重新打开后才会停止补帧。';
        } else {
            rifeCallout.textContent = enabled ? rife.status : 'AI 补帧已关闭。';
        }
    };

    const activate = async section => {
        if (!groups.has(section)) return;
        if (activeSection === 'mpv' && section !== 'mpv' && mpvConfEditor?.pendingErrors()) {
            if (await mpvConfEditor.confirmLeave() === 'stay') {
                if (categorySelect) categorySelect.value = 'mpv';
                return;
            }
        }
        activeSection = section;
        headingTitle.textContent = tigerestSettingsGroupTitle(section);
        sessionStorage.setItem('tigerestSettingsTab', section);
        if (categorySelect) categorySelect.value = section;
        for (const [key, button] of navButtons) {
            button.classList.toggle('active', key === section);
            if (key === section) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        }
        for (const [key, group] of groups) {
            group.classList.toggle('active', key === section);
            group.setAttribute('aria-hidden', String(key !== section));
        }
        content.scrollTop = 0;
        if (host) installTigerestSettingsMenu();
    };

    const makeControl = (section, setting, currentValue) => {
        const key = setting.key;
        if (section === 'video' && key === 'aiRifeTarget') {
            const input = createRifeTargetControl({element, value:currentValue,
                save:value => saveSetting(section, key, value), notify:showSaved});
            settingControls.set(key, {input});
            return input;
        }
        if (setting.options) {
            const select = element('select', 'tgs-control');
            setting.options.forEach((option, index) => {
                const item = element('option', '', option.title.replace(`${section}.${key}.`, '').replace(`${section}.`, ''));
                item.value = String(index);
                item.selected = option.value == currentValue;
                select.appendChild(item);
            });
            select.addEventListener('change', () => {
                saveSetting(section, key, setting.options[Number(select.value)].value);
            });
            if (section === 'video') settingControls.set(key, {select, options: setting.options});
            return select;
        }

        if (setting.inputType === 'textarea') {
            const textarea = element('textarea', 'tgs-control');
            textarea.value = currentValue == null ? '' : currentValue;
            textarea.spellcheck = false;
            textarea.addEventListener('change', () => saveSetting(section, key, textarea.value));
            return textarea;
        }

        if (typeof currentValue === 'boolean') {
            const wrapper = element('div', 'tgs-switch-wrap');
            const state = element('span', 'tgs-switch-state', currentValue ? '开启' : '关闭');
            const checkbox = element('input', 'tgs-switch');
            checkbox.type = 'checkbox';
            checkbox.checked = currentValue;
            checkbox.addEventListener('change', () => {
                state.textContent = checkbox.checked ? '开启' : '关闭';
                saveSetting(section, key, checkbox.checked);
            });
            wrapper.append(state, checkbox);
            return wrapper;
        }

        const input = element('input', 'tgs-control');
        input.type = setting.inputType === 'number' || typeof currentValue === 'number' ? 'number' : 'text';
        input.value = currentValue == null ? '' : currentValue;
        input.addEventListener('change', () => {
            saveSetting(section, key, input.type === 'number' ? Number(input.value) : input.value);
        });
        return input;
    };

    for (const entry of orderedSections) {
        const section = entry.key;
        const meta = entry;

        const group = element('section', 'tgs-section');
        group.dataset.section = section;
        group.id = `tgs-section-${section}`;
        group.setAttribute('aria-labelledby', `tgs-section-title-${section}`);
        const groupHead = element('div', 'tgs-section-head');
        const groupTitle = element('div');
        const title = element('h2', '', meta.title);
        title.id = `tgs-section-title-${section}`;
        groupTitle.append(title, element('p', '', meta.subtitle));
        const reset = element('button', 'tgs-reset', '恢复本页默认值');
        reset.type = 'button';
        reset.addEventListener('click', async () => {
            const note = section === 'mpv' && desktopMpvEditor
                ? '只恢复本页的开关和渲染后端；mpv.conf 不会改动，要还原它请用下方编辑器里的「恢复默认配置」。'
                : '';
            if (!(await confirmInPage(`恢复“${meta.title}”的默认设置？`, note, '恢复默认'))) return;
            reset.disabled = true;
            await window.api.settings.resetToDefault(section);
            if (disposed || signal?.aborted) return;
            showSaved('已恢复默认值。正在刷新设置页…');
            // QWebChannel updates the settings snapshot before rebuilding.
            const sectionToRestore = activeSection;
            cleanup();
            if (!host && returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
            const refreshed = await mountTigerestSettings(host, sectionToRestore, onReturn, resetAbort.signal, options);
            if (disposed || signal?.aborted) { refreshed?.dispose(); return; }
            replacementMount = refreshed;
        });
        groupHead.append(groupTitle, reset);
        group.appendChild(groupHead);

        if (section === 'mpv' && window.tigerestIPadApi) {
            const advanced = element('button', 'tgs-reset', '导入着色器与播放诊断');
            advanced.type = 'button';
            advanced.addEventListener('click', () => window.api.system.openQualitySettings());
            group.appendChild(advanced);
        }
        if (section === 'video' && mpvDiagnostics.rife) {
            rifeCallout = element('div', 'tgs-callout');
            updateRifeStatus();
            group.appendChild(rifeCallout);
        }
        if (section === 'video') {
            rifeExtensionPanel = createRifeExtensionPanel({element, player: window.api.player,
                settings: jmpInfo.settings.video, save: (key, value) => saveSetting('video', key, value), notify: showSaved});
            if (rifeExtensionPanel) group.appendChild(rifeExtensionPanel.node);
        }
        if (section === 'mpv' && !window.tigerestAndroidApi && !window.tigerestIPadApi) {
            const activeRoot = jmpInfo.mpvConfigDir || '尚未解析';
            const shaderFiles = Array.isArray(mpvDiagnostics.shaderFiles) ? mpvDiagnostics.shaderFiles : [];
            const shaderNames = shaderFiles
                .slice(0, 4)
                .map(path => String(path).replaceAll('\\', '/').split('/').pop())
                .join('、');
            const profileName = mpvDiagnostics.configuredProfile || '未声明（使用 mpv 默认）';
            const shaderSummary = shaderFiles.length
                ? `${shaderFiles.length} 个：${shaderNames}${shaderFiles.length > 4 ? '…' : ''}`
                : '0 个';
            const rendererName = mpvDiagnostics.renderBackend === 'gpu-next-native'
                ? '原生 GPU-Next 嵌入'
                : 'libmpv Render API 兼容模式';
            const activeVo = mpvDiagnostics.currentVo || mpvDiagnostics.configuredVo || '等待播放';
            const actualScale = [
                `亮度 ${mpvDiagnostics.scale || '未知'}`,
                `色度 ${mpvDiagnostics.cscale || '未知'}`,
                `缩小 ${mpvDiagnostics.dscale || '未知'}`
            ].join(' / ');
            const sourceSize = mpvDiagnostics.sourceWidth && mpvDiagnostics.sourceHeight
                ? `${mpvDiagnostics.sourceWidth}×${mpvDiagnostics.sourceHeight}`
                : '等待播放';
            const outputSize = mpvDiagnostics.outputWidth && mpvDiagnostics.outputHeight
                ? `${mpvDiagnostics.outputWidth}×${mpvDiagnostics.outputHeight}`
                : '等待播放';
            const passSummary = mpvDiagnostics.voPassesAvailable
                ? `可用（Fresh ${mpvDiagnostics.freshPassCount || 0} / Redraw ${mpvDiagnostics.redrawPassCount || 0} 项）`
                : '等待视频开始渲染';
            group.appendChild(element(
                'div',
                'tgs-callout',
                `当前播放器：配置目录 ${activeRoot}。渲染后端：${rendererName}（当前 VO：${activeVo}）；当前画质档：${profileName}；视频 ${sourceSize} → 输出 ${outputSize}；实际缩放：${actualScale}；当前加载着色器：${shaderSummary}；完整帧流水线：${passSummary}。播放中按 Ctrl+J 开关统计总览、按数字 2 查看完整处理页，或按 Ctrl+Shift+J 直接显示完整页。GPU-Next 模式会把 mpv 子窗口绑定到客户端窗口；兼容模式则锁定 vo=libmpv，防止 profile 另开播放窗口。`
            ));
        }

        const values = jmpInfo.settings[section];
        for (const setting of jmpInfo.settingsDescriptions[section]) {
            if (section === 'mpv' && desktopMpvEditor && editorMpvSettings.has(setting.key)) continue;
            const row = element('div', 'tgs-setting');
            row.dataset.setting = `${section}.${setting.key}`;
            row.dataset.search = `${meta.title} ${setting.displayName || setting.key} ${setting.key} ${setting.help || ''}`.toLowerCase();
            const labelTitle = element('label', 'tgs-setting-title inputLabel');
            labelTitle.appendChild(element('span', '', setting.displayName || setting.key));
            if (restartSettings.has(`${section}.${setting.key}`)) {
                labelTitle.appendChild(element('span', 'tgs-restart', '需重启'));
            }
            const control = makeControl(section, setting, values[setting.key]);
            const input = control.matches('input,select,textarea') ? control : control.querySelector('input');
            if (input) {
                input.id = `tgs-input-${section}-${setting.key}`;
                labelTitle.htmlFor = input.id;
                if (input.type === 'checkbox') row.classList.add('tgs-setting-boolean');
            }
            row.append(labelTitle, control);
            if (setting.help) {
                const help = element('div', 'tgs-help fieldDescription', setting.help);
                help.id = `tgs-help-${section}-${setting.key}`;
                input?.setAttribute('aria-describedby', help.id);
                row.appendChild(help);
            }
            group.appendChild(row);
        }

        if (section === 'mpv' && desktopMpvEditor) {
            mpvConfEditor = window.tigerestCreateMpvConfEditor({element, player: window.api.player, settings: jmpInfo.settings.mpv,
                saveSetting: (sectionName, key, value) => { jmpInfo.settings[sectionName][key] = value; },
                notify: showSaved});
            group.appendChild(mpvConfEditor.node);
        }

        if (section === 'home') {
            homeLibraries = createHomeLibraryControl({element, apiProvider: options.apiProvider,
                save: text => saveSetting('home', 'libraryLayout', text), notify: showSaved});
            if (homeLibraries) group.appendChild(homeLibraries.node);
        }

        if (section === 'main') {
            const actions = element('div', 'tgs-actions');
            if (window.TigerestUpdate) {
                const checkUpdate = element('button', 'tgs-action', '检查客户端更新');
                checkUpdate.addEventListener('click', () => window.TigerestUpdate.check().catch(() => {}));
                actions.appendChild(checkUpdate);
            }
            {
                const resetServer = element('button', 'tgs-action', '切换服务器');
                resetServer.addEventListener('click', window.tigerestSwitchServer);
                actions.appendChild(resetServer);
            }
            const offline = element('button', 'tgs-action', '打开下载与离线媒体管理');
            offline.addEventListener('click', () => {
                close();
                window.tigerestOpenOfflineLibrary();
            });
            if (!window.tigerestAndroidApi) actions.appendChild(offline);
            if (window.tigerestIPadApi) {
                const profiles = element('button', 'tgs-action', '管理配置档');
                profiles.addEventListener('click', () => { close(); window.api.system.openProfiles(); });
                actions.appendChild(profiles);
            }
            group.appendChild(actions);
        }

        content.appendChild(group);
        groups.set(section, group);
    }

    const empty = element('div', 'tgs-empty', '没有找到匹配的设置，请尝试其他关键词。');
    empty.hidden = true;
    empty.setAttribute('role', 'status');
    content.appendChild(empty);
    const applySearch = () => {
        const query = search.value.trim().toLowerCase();
        empty.hidden = true;
        if (!query) {
            activate(activeSection);
            for (const group of groups.values()) {
                for (const row of group.querySelectorAll('.tgs-setting')) row.style.display = '';
            }
            return;
        }
        let matchCount = 0;
        for (const [section, group] of groups) {
            let matches = 0;
            for (const row of group.querySelectorAll('.tgs-setting')) {
                const visible = section === activeSection && row.dataset.search.includes(query);
                row.style.display = visible ? '' : 'none';
                if (visible) matches += 1;
            }
            matchCount += matches;
        }
        empty.hidden = matchCount > 0;
        status.textContent = `已找到 ${matchCount} 项设置。`;
    };
    search.addEventListener('input', applySearch);

    let replacementMount = null;
    let disposed = false;
    const resetAbort = new AbortController();
    const cleanup = () => {
        clearTimeout(showSaved.timer);
        // Leaving through the Emby navigation cannot be held back; keep the
        // draft and offer it once the page is gone.
        if (mpvConfEditor?.pendingErrors()) setTimeout(() => window.tigerestOfferMpvConfDraft?.(window.api.player), 0);
        mpvConfEditor?.dispose();
        mpvConfEditor = null;
        window.api.player?.mpvConfMessage?.disconnect?.(showMpvConfMessage);
        rifeExtensionPanel?.dispose();
        homeLibraries?.dispose();
        document.removeEventListener('keydown', onKeyDown);
        if (!host) document.body.style.overflow = priorBodyOverflow;
        overlay.remove();
        css.remove();
    };
    const close = () => {
        disposed = true;
        resetAbort.abort();
        replacementMount?.dispose();
        signal?.removeEventListener('abort', close);
        cleanup();
        if (!host && returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
    };
    const leave = async () => {
        if (mpvConfEditor?.pendingErrors() && await mpvConfEditor.confirmLeave() === 'stay') return false;
        close();
        return true;
    };
    const onKeyDown = event => {
        if (event.key === 'Escape') { event.preventDefault(); leave(); }
        if (event.key === 'Tab' && !host) {
            const focusable = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')]
                .filter(node => node.tabIndex >= 0 && node.getClientRects().length);
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    };
    closeButton.addEventListener('click', async () => { if (await leave() && host) onReturn?.(); });
    if (!host) {
        overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
        document.addEventListener('keydown', onKeyDown);
    }
    (host || document.body).appendChild(overlay);
    if (!host) document.body.style.overflow = 'hidden';
    signal?.addEventListener('abort', close, {once: true});
    if (signal?.aborted) { close(); return; }
    activate(activeSection);
    if (!host) search.focus();
    return {dispose: close, activate};
}

// Jellyfin's web client has no Emby settings route, so its settings open in
// the overlay below. The Jellyfin plugin keeps its connection manager in
// window.tigerestSessionConnections, and the overlay asks it for the signed-in
// account each time it loads: a sign-out or server switch never leaves an old
// account in the settings.
function currentSessionApiClient() {
    return window.tigerestSessionConnections?.currentApiClient?.() || null;
}

async function openTigerestSettings(section = 'mpv') {
    if (window.Emby?.importModule) {
        try {
            const module = await Emby.importModule('./modules/approuter.js');
            const router = module.default || module;
            const routes = router.getRoutes();
            const category = routes.find(route => route.tigerestSettingsSection === section);
            if (category) return router.show(category.path);
            const route = routes.find(route => route.controller === 'tigerest/settings-view.js');
            if (route) return router.show(route.path + '?section=' + encodeURIComponent(section));
        } catch (error) { console.warn('Unable to open the Emby settings route'); }
    }
    // Jellyfin and the first-run/server selection pages have no Emby router.
    return mountTigerestSettings(null, section, null, null, {apiProvider: currentSessionApiClient});
}
window.tigerestMountSettings = mountTigerestSettings;
window.tigerestSettingsGroupTitle = tigerestSettingsGroupTitle;
window.tigerestSettingsCategories = getTigerestSettingsCategories;
window.tigerestInstallSettingsMenu = installTigerestSettingsMenu;
window.tigerestOpenMpvSettings = openTigerestSettings;

// Emby shelves support touch/trackpad horizontal scrolling, but Chromium
// starts an image drag when a desktop mouse drags an episode card. Convert a
// deliberate horizontal pointer gesture into scrollLeft movement while still
// allowing an ordinary click to select and play an episode.
function installHorizontalShelfDragging() {
    let dragState = null;
    let suppressNextClick = false;

    const findHorizontalScroller = start => {
        let node = start instanceof Element ? start : start?.parentElement;
        while (node && node !== document.body) {
            const style = getComputedStyle(node);
            const looksLikeShelf = /scroll|shelf|itemscontainer/i.test(node.className || '');
            const clipsHorizontally = style.overflowX !== 'visible';
            if (node.scrollWidth > node.clientWidth + 8 && (clipsHorizontally || looksLikeShelf)) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    };

    document.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.isPrimary === false) return;
        const scroller = findHorizontalScroller(event.target);
        if (!scroller) return;
        dragState = {
            scroller,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            scrollLeft: scroller.scrollLeft,
            dragging: false
        };
    }, true);

    document.addEventListener('pointermove', event => {
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        const dx = event.clientX - dragState.startX;
        const dy = event.clientY - dragState.startY;
        if (!dragState.dragging) {
            if (Math.abs(dx) < 7 || Math.abs(dx) <= Math.abs(dy)) return;
            dragState.dragging = true;
            dragState.scroller.classList.add('tigerest-shelf-dragging');
        }
        dragState.scroller.scrollLeft = dragState.scrollLeft - dx;
        event.preventDefault();
        event.stopPropagation();
    }, true);

    const finishDrag = event => {
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        suppressNextClick = dragState.dragging;
        dragState.scroller.classList.remove('tigerest-shelf-dragging');
        dragState = null;
    };
    document.addEventListener('pointerup', finishDrag, true);
    document.addEventListener('pointercancel', finishDrag, true);
    document.addEventListener('dragstart', event => {
        if (dragState && findHorizontalScroller(event.target) === dragState.scroller) {
            event.preventDefault();
        }
    }, true);
    document.addEventListener('click', event => {
        if (!suppressNextClick) return;
        suppressNextClick = false;
        event.preventDefault();
        event.stopPropagation();
    }, true);

    const style = document.createElement('style');
    style.textContent = '.tigerest-shelf-dragging{cursor:grabbing!important;scroll-behavior:auto!important}.tigerest-shelf-dragging *{cursor:grabbing!important;user-select:none!important}';
    const mountStyle = () => {
        if (document.head && !style.isConnected) document.head.appendChild(style);
        else if (!document.head) setTimeout(mountStyle, 30);
    };
    mountStyle();
}

function installHeaderControlsStyle() {
    if (document.getElementById('tigerest-header-controls-style')) return;
    const style = document.createElement('style'); style.id = 'tigerest-header-controls-style';
    style.textContent = `
        .headerRight, .tigerest-header-actions { gap: 6px; align-items: center; }
        .tigerest-header-actions { display: flex; }
        :is(.headerRight,.tigerest-header-actions) .headerButton, :is(.headerRight,.tigerest-header-actions) #tigerest-message-entry, :is(.headerRight,.tigerest-header-actions) #tigerest-watch-entry, :is(.headerRight,.tigerest-header-actions) #tigerest-update-button, .tg-home .tg-home-window-mode {
            box-sizing: border-box; width: 36px; min-width: 36px; height: 36px; min-height: 36px;
            flex: 0 0 auto; margin: 0; padding: 0; border: 1px solid rgba(230,222,205,.18);
            border-radius: 10px; background: rgba(24,27,33,.78); color: #e9e6df;
            box-shadow: inset 0 1px 0 rgba(255,255,255,.035); backdrop-filter: blur(12px);
            font: 600 12px/1 system-ui,sans-serif; vertical-align: middle; cursor: pointer;
            transition: background .16s,border-color .16s,color .16s;
        }
        :is(.headerRight,.tigerest-header-actions) .headerButton:hover, :is(.headerRight,.tigerest-header-actions) #tigerest-message-entry:hover, :is(.headerRight,.tigerest-header-actions) #tigerest-watch-entry:hover, :is(.headerRight,.tigerest-header-actions) #tigerest-update-button:hover, .tg-home .tg-home-window-mode:hover {
            background: rgba(60,54,43,.9); border-color: rgba(239,195,110,.6); color: #f5d493;
        }
        :is(.headerRight,.tigerest-header-actions) .headerButton:focus-visible, :is(.headerRight,.tigerest-header-actions) #tigerest-message-entry:focus-visible, :is(.headerRight,.tigerest-header-actions) #tigerest-watch-entry:focus-visible, :is(.headerRight,.tigerest-header-actions) #tigerest-update-button:focus-visible, .tg-home .tg-home-window-mode:focus-visible {
            outline: 2px solid #efc36e; outline-offset: 2px; border-color: #efc36e;
        }
        :is(.headerRight,.tigerest-header-actions) .headerButton.md-icon, :is(.headerRight,.tigerest-header-actions) .headerButton .md-icon { font-size: 20px; }
        :is(.headerRight,.tigerest-header-actions) #tigerest-update-button svg { width: 20px; height: 20px; }
        :is(.headerRight,.tigerest-header-actions) .headerUserButton { overflow: hidden; }
        :is(.headerRight,.tigerest-header-actions) .headerUserButton img { object-fit: cover; border-radius: 8px; }
        /* Jellyfin draws the avatar as an inline background on an inner
           .headerButton div; keep the button look on the outer button only. */
        :is(.headerRight,.tigerest-header-actions) .headerUserButton > .headerUserButtonRound {
            width: 100%; min-width: 0; height: 100%; min-height: 0; border: 0; border-radius: inherit;
            background-color: transparent; background-size: cover; background-position: center; background-repeat: no-repeat;
            box-shadow: none; backdrop-filter: none; transform: none;
        }
        :is(.headerRight,.tigerest-header-actions) #tigerest-message-entry, :is(.headerRight,.tigerest-header-actions) #tigerest-watch-entry { width: auto; padding: 0 10px; white-space: nowrap; }
        :is(.headerRight,.tigerest-header-actions) #tigerest-mpv-settings-button { width: auto; padding: 0 10px; color: #efc36e; border-color: rgba(239,195,110,.38); background: rgba(82,63,30,.28); font-weight: 700; white-space: nowrap; }
        :is(.headerRight,.tigerest-header-actions) #tigerest-mpv-settings-button::after { content: '▾'; margin-left: 4px; font-size: 10px; opacity: .8; }
        #tigerest-window-mode-button, .tg-home .tg-home-window-mode { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
        #tigerest-window-mode-button .tigerest-window-label { display: none; }
        .tg-home .tg-home-window-mode { width: auto; padding: 0 10px; white-space: nowrap; }
        .tg-home .tg-home-window-mode[hidden] { display: none; }
        .tigerest-window-icon { flex: 0 0 auto; }
        #tigerest-window-mode-button:disabled, .tg-home .tg-home-window-mode:disabled { cursor: wait; opacity: .6; }
        /* Emby's gear opens the "Manage Emby Server" route that its avatar
           menu also lists for administrators (and the avatar menu itself
           otherwise), so the avatar is the one account/server entry. */
        .headerRight .headerSettingsButton { display: none !important; }
        @media(max-width:600px) { .headerRight, .tigerest-header-actions { flex-wrap: wrap; gap: 4px; } }
        @media(pointer:coarse) { :is(.headerRight,.tigerest-header-actions) .headerButton, :is(.headerRight,.tigerest-header-actions) #tigerest-message-entry, :is(.headerRight,.tigerest-header-actions) #tigerest-watch-entry, :is(.headerRight,.tigerest-header-actions) #tigerest-update-button, .tg-home .tg-home-window-mode { min-height: 44px; min-width: 44px; } }
    `;
    document.head.appendChild(style);
}

// The connected server's name for client entries: the server's own name, the
// remembered record, or the address the user entered.
function currentServerLabel() {
    const main = window.jmpInfo?.settings?.main || {}, current = main.userWebClient || '';
    const named = window.TigerestServer?.identity?.name;
    if (named) return named;
    const model = window.TigerestServerHistory;
    if (model && current) {
        const key = model.recordKey(main.serverConnectionMode || 'custom', current);
        const record = model.parse(main.knownServers || '').find(server => server.key === key);
        if (record?.name) return record.name;
    }
    if (main.serverConnectionMode === 'tigerest') return '大河专属 EMBY';
    try { return new URL(current || window.location.href).host; } catch { return '当前服务器'; }
}

let clientMenu = null, clientMenuAnchor = null;
function closeClientMenu(restoreFocus = true) {
    if (!clientMenu) return false;
    const anchor = clientMenuAnchor;
    clientMenu.remove(); clientMenu = clientMenuAnchor = null;
    document.removeEventListener('pointerdown', onClientMenuPointer, true);
    document.removeEventListener('keydown', onClientMenuKey, true);
    window.removeEventListener('resize', onClientMenuResize);
    anchor?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor?.isConnected) anchor.focus({preventScroll: true});
    return true;
}
// Android Back closes the menu before navigating.
window.tigerestClientMenuBack = () => closeClientMenu();
function onClientMenuPointer(event) {
    if (!clientMenu?.contains(event.target) && !clientMenuAnchor?.contains(event.target)) closeClientMenu(false);
}
function onClientMenuResize() { closeClientMenu(false); }
function onClientMenuKey(event) {
    const items = [...(clientMenu?.querySelectorAll('[role="menuitem"]') || [])];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeClientMenu(); }
    else if (event.key === 'Tab') closeClientMenu(false);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next].focus();
    }
}
function installClientMenuStyle() {
    if (document.getElementById('tigerest-client-menu-style')) return;
    const style = document.createElement('style'); style.id = 'tigerest-client-menu-style';
    style.textContent = `
        #tigerest-client-menu { position: fixed; z-index: 2147483000; box-sizing: border-box; width: max-content; min-width: 220px; max-width: calc(100vw - 16px);
            padding: 6px; border: 1px solid rgba(239,195,110,.32); border-radius: 12px; background: rgba(22,21,19,.97); color: #ece7dd;
            box-shadow: 0 16px 40px rgba(0,0,0,.45); font: 14px/1.4 system-ui,"Microsoft YaHei",sans-serif; text-align: left; }
        #tigerest-client-menu .tigerest-client-menu-server { padding: 8px 10px 10px; border-bottom: 1px solid rgba(255,255,255,.08); margin-bottom: 4px; }
        #tigerest-client-menu .tigerest-client-menu-label { display: block; color: #a39b8d; font-size: 12px; }
        #tigerest-client-menu .tigerest-client-menu-name { display: block; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; color: #f2d79e; }
        #tigerest-client-menu [role="menuitem"] { display: flex; justify-content: space-between; gap: 18px; box-sizing: border-box; width: 100%; min-height: 40px; padding: 9px 10px;
            border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
        #tigerest-client-menu [role="menuitem"]:hover, #tigerest-client-menu [role="menuitem"]:focus-visible { background: rgba(239,195,110,.14); outline: none; }
        #tigerest-client-menu [role="menuitem"]:focus-visible { box-shadow: inset 0 0 0 2px #efc36e; }
        #tigerest-client-menu kbd { color: #a39b8d; font: 12px/1.6 system-ui,sans-serif; }
        @media (pointer: coarse) { #tigerest-client-menu [role="menuitem"] { min-height: 44px; } }
    `;
    document.head.appendChild(style);
}
function openClientMenu(anchor) {
    closeClientMenu(false);
    installClientMenuStyle();
    const menu = document.createElement('div');
    menu.id = 'tigerest-client-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '客户端菜单');
    const server = document.createElement('div'); server.className = 'tigerest-client-menu-server';
    const label = document.createElement('span'); label.className = 'tigerest-client-menu-label'; label.textContent = '当前服务器';
    const name = document.createElement('span'); name.className = 'tigerest-client-menu-name'; name.textContent = currentServerLabel();
    server.append(label, name); menu.append(server);
    const android = window.tigerestAndroidApi || window.api?.system?.isAndroid;
    const item = (text, run, shortcut) => {
        const entry = document.createElement('button');
        entry.type = 'button'; entry.setAttribute('role', 'menuitem'); entry.tabIndex = -1;
        entry.append(document.createTextNode(text));
        if (shortcut) { const key = document.createElement('kbd'); key.textContent = shortcut; entry.append(key); }
        entry.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); closeClientMenu(false); run(); });
        menu.append(entry);
    };
    item('切换 / 管理服务器', () => window.tigerestSwitchServer());
    // The Mac's shortcuts use Command, as its other applications do.
    const command = window.api?.system?.isMacos === true ? '⌘' : 'Ctrl+';
    item('播放器设置（MPV）', () => window.tigerestOpenMpvSettings('mpv'), android ? '' : command + ',');
    item('客户端设置', () => window.tigerestOpenMpvSettings('main'));
    if (!android && window.tigerestOpenOfflineLibrary) item('下载与离线媒体', () => window.tigerestOpenOfflineLibrary());
    if (window.tigerestLocalPlayerAvailable?.()) item('打开本地视频', () => window.tigerestOpenLocalFiles(), command + 'O');
    document.body.appendChild(menu);
    // Below the button, inside the viewport; a button moved into a compact
    // overflow menu has no box, so use the top-right corner then.
    const rect = anchor.getBoundingClientRect(), box = menu.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;
    const top = visible ? rect.bottom + 6 : Math.max(8, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tgs-safe-top')) || 0) + 56;
    const left = visible ? Math.min(rect.right, window.innerWidth - 8) - box.width : window.innerWidth - 8 - box.width;
    menu.style.top = Math.max(8, Math.min(top, window.innerHeight - box.height - 8)) + 'px';
    menu.style.left = Math.max(8, left) + 'px';
    clientMenu = menu; clientMenuAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onClientMenuPointer, true);
    document.addEventListener('keydown', onClientMenuKey, true);
    window.addEventListener('resize', onClientMenuResize);
    menu.querySelector('[role="menuitem"]').focus({preventScroll: true});
}

// The user button of the visible header; client header buttons mount beside
// it. Jellyfin's Modern layout keeps a hidden legacy header beside its app
// bar, which may render later; its user menu marks the visible toolbar.
function headerUserAnchor() {
    const modern = window.TigerestServer?.kind !== 'emby' ? document.querySelector('[aria-controls="app-user-menu"]') : null;
    if (modern?.parentElement) { modern.parentElement.classList.add('tigerest-header-actions'); return modern; }
    return window.TigerestServer?.headerUserButton() || document.querySelector('.headerUserButton');
}

function installMpvSettingsEntry() {
    // The native shell is injected at DocumentCreation, before <head> and
    // <html> necessarily exist. Defer mounting instead of aborting the rest
    // of the shell on an early null append/observe target.
    if (!document.head || !document.documentElement) {
        setTimeout(installMpvSettingsEntry, 50);
        return;
    }

    installHeaderControlsStyle();

    // One client menu holds the current server, server switching, player
    // settings and offline media. Its id predates the menu; the update entry
    // and the Android toolbar layout anchor to it.
    const bound = new WeakSet();
    const bind = button => {
        if (bound.has(button)) return;
        bound.add(button);
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (clientMenu?.isConnected) closeClientMenu();
            else openClientMenu(button);
        });
    };
    const mount = () => {
        const existing = document.getElementById('tigerest-mpv-settings-button');
        if (existing) bind(existing);
        if (existing && window.TigerestServer?.kind === 'emby') return;
        const userButton = headerUserAnchor();
        if (existing) {
            if (userButton?.parentElement && existing.parentElement !== userButton.parentElement) {
                closeClientMenu(false);
                userButton.parentElement.insertBefore(existing, userButton);
            }
            return;
        }
        closeClientMenu(false);
        if (!userButton?.parentElement) return;

        const button = document.createElement('button');
        button.id = 'tigerest-mpv-settings-button';
        button.type = 'button';
        button.className = 'headerButton headerSectionItem paper-icon-button-light emby-button-focusscale';
        button.textContent = '客户端';
        button.title = '客户端菜单：切换服务器、播放器设置';
        button.setAttribute('aria-label', '客户端菜单：切换服务器、播放器设置');
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        bind(button);
        userButton.parentElement.insertBefore(button, userButton);
    };

    mount();
    const observer = new MutationObserver(mount);
    observer.observe(document.documentElement, {childList: true, subtree: true});

    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === ',') {
            event.preventDefault();
            openTigerestSettings();
        } else if ((window.api?.system?.isMacos === true ? event.metaKey && !event.ctrlKey : event.ctrlKey) &&
                   !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'o' &&
                   window.tigerestLocalPlayerAvailable?.()) {
            event.preventDefault();
            window.tigerestOpenLocalFiles();
        }
    }, true);
}

function installWindowModeEntry() {
    if (window.jmpInfo?.capabilities?.desktopWindowControls === false || window.tigerestAndroidApi || window.api?.system?.isAndroid) return;
    if (!document.head || !document.documentElement) {
        setTimeout(installWindowModeEntry, 50);
        return;
    }
    installHeaderControlsStyle();

    let fullscreen = false, known = false, pending = false, readVersion = 0;
    const buttons = () => document.querySelectorAll('#tigerest-window-mode-button,[data-tigerest-window-mode]');
    const updateButtons = () => {
        for (const button of buttons()) {
            const label = fullscreen ? '窗口' : '全屏';
            const title = fullscreen ? '退出全屏，恢复窗口（F11）' : '切换为全屏（F11）';
            const text = button.querySelector('.tigerest-window-label');
            if (text && text.textContent !== label) text.textContent = label;
            button.title = title;
            button.setAttribute('aria-label', title);
            button.setAttribute('aria-pressed', String(fullscreen));
            button.setAttribute('aria-busy', String(pending));
            button.disabled = pending;
            const path = button.querySelector('path');
            const shape = fullscreen ? 'M9 3v6H3m12-6v6h6M3 15h6v6m6 0v-6h6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6';
            if (path && path.getAttribute('d') !== shape) path.setAttribute('d', shape);
        }
    };
    const refreshState = async () => {
        if (!window.api?.window?.isFullScreen) return false;
        const version = ++readVersion;
        try {
            const value = await window.api.window.isFullScreen();
            if (version !== readVersion) return known;
            fullscreen = !!value; known = true; updateButtons();
            return true;
        } catch (error) {
            console.warn('Unable to read window fullscreen state', error);
            return false;
        }
    };
    const toggle = async event => {
        event.preventDefault(); event.stopPropagation();
        if (pending || !window.api?.window?.setFullScreen) return;
        pending = true; updateButtons();
        try {
            if (!known && !await refreshState()) return;
            await window.api.window.setFullScreen(!fullscreen);
            await refreshState();
        } catch (error) {
            console.warn('Unable to change window fullscreen state', error);
            await refreshState();
        } finally {
            pending = false; updateButtons();
        }
    };
    const bound = new WeakSet();
    const mount = () => {
        // Same host as the client menu; follows it when Jellyfin's app bar
        // replaces the hidden legacy header.
        const existing = document.getElementById('tigerest-window-mode-button');
        const userButton = existing && window.TigerestServer?.kind === 'emby' ? null : headerUserAnchor();
        const host = userButton?.parentElement;
        if (host && existing?.parentElement !== host) {
            let button = existing;
            if (!button) {
                button = document.createElement('button');
                button.id = 'tigerest-window-mode-button'; button.type = 'button';
                button.className = 'headerButton headerSectionItem paper-icon-button-light emby-button-focusscale';
            }
            const settingsButton = document.getElementById('tigerest-mpv-settings-button');
            host.insertBefore(button, settingsButton?.parentElement === host ? settingsButton : userButton);
        }
        for (const button of buttons()) {
            if (bound.has(button)) continue;
            bound.add(button);
            button.innerHTML = '<svg class="tigerest-window-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path></path></svg><span class="tigerest-window-label"></span>';
            button.addEventListener('click', toggle);
            button.hidden = false;
        }
        updateButtons();
    };
    mount();
    const observer = new MutationObserver(mount);
    observer.observe(document.documentElement, {childList: true, subtree: true});
    window.initCompleted.then(() => {
        window.api?.window?.fullScreenSwitched?.connect(value => {
            if (typeof value === 'boolean') {
                ++readVersion; fullscreen = value; known = true; updateButtons();
            } else refreshState();
        });
        refreshState();
    }).catch(error => console.warn('Unable to initialize window controls', error));
}

installMpvSettingsEntry();
installWindowModeEntry();
if (!window.tigerestAndroidApi && !window.tigerestIPadApi) {
    window.initCompleted.then(() => window.tigerestShowMpvConfNotices?.(window.jmpInfo?.mpvConfNotices))
        .catch(error => console.warn('Unable to show mpv.conf notices', error));
}
installHorizontalShelfDragging();

// A loaded server page names its remembered-server record. The native
// selection commits that record once this page has loaded, so wait past the
// load and read the setting again before annotating it.
async function annotateRememberedServer() {
    const model = window.TigerestServerHistory, server = window.TigerestServer;
    if (!model || !server?.base || !/^https?:$/.test(window.location.protocol)) return;
    const kind = await server.ready;
    await window.initCompleted;
    const main = window.jmpInfo.settings.main;
    if (!('knownServers' in main) || !server.identity) return;
    if (document.readyState !== 'complete') await new Promise(resolve => window.addEventListener('load', resolve, {once: true}));
    await new Promise(resolve => setTimeout(resolve, 1500));
    const current = main.userWebClient, mode = main.serverConnectionMode || 'custom';
    if (!current || model.canonicalAddress(server.base + '/') !== model.canonicalAddress(current)) return;
    let text = main.knownServers || '';
    try {
        const fresh = await window.api.settings.value('main', 'knownServers');
        if (typeof fresh === 'string') text = fresh;
    } catch (error) { return; }
    const next = model.annotate(text, {mode, address: current, name: server.identity.name, kind, serverId: server.identity.serverId});
    if (next !== text) main.knownServers = next;
}
annotateRememberedServer().catch(() => {});

function installServerSwitchEntry() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', installServerSwitchEntry, {once: true}); return; }
    if (/find-webclient\.html/i.test(window.location.pathname)) return;
    const style = document.createElement('style');
    style.textContent = '.tigerest-switch-entry{display:block!important;position:relative!important;width:auto!important;max-width:100%;margin:8px auto 18px!important;padding:10px 18px!important;border:1px solid #a88a50!important;border-radius:8px;background:#211e19!important;color:#f0c675!important;font:500 15px/1.4 system-ui!important;cursor:pointer;z-index:1}';
    style.textContent += '.tg-home .tigerest-home-server{box-sizing:border-box;display:inline-flex;align-items:center;flex:0 1 auto;min-width:0;max-width:11em;min-height:36px;padding:0 10px;border:1px solid #a88a5070;border-radius:10px;background:#211e19;color:#f0c675;font:600 12px/1.4 system-ui,sans-serif;white-space:nowrap;cursor:pointer}.tg-home .tigerest-home-server span{overflow:hidden;text-overflow:ellipsis}.tg-home .tigerest-home-server svg{display:none;flex:0 0 auto}@media(pointer:coarse){.tg-home .tigerest-home-server{min-height:44px}}';
    // Compact steps chosen by fitHomeHeading() from the heading's own width.
    style.textContent += '.tg-home-nav-heading[data-tigerest-compact~=window] .tg-home-window-mode{min-width:36px;padding:0 9px}.tg-home-nav-heading[data-tigerest-compact~=window] .tg-home-window-mode .tigerest-window-label{display:none}'
        + '.tg-home-nav-heading[data-tigerest-compact~=server] .tigerest-home-server{min-width:36px;padding:0 9px;justify-content:center}.tg-home-nav-heading[data-tigerest-compact~=server] .tigerest-home-server span{display:none}.tg-home-nav-heading[data-tigerest-compact~=server] .tigerest-home-server svg{display:block}'
        + '.tg-home-nav-heading[data-tigerest-compact~=wrap]{flex-wrap:wrap;row-gap:6px}.tg-home-nav-heading[data-tigerest-compact~=wrap] .tg-home-eyebrow{flex:1 0 100%}.tg-home-nav-heading[data-tigerest-compact~=wrap] .tigerest-home-server{margin-left:auto}'
        + '@media(pointer:coarse){.tg-home-nav-heading[data-tigerest-compact] :is(.tg-home-window-mode,.tigerest-home-server){min-width:44px}}';
    document.head.appendChild(style);
    // Logged-out pages keep a lightweight in-page entry instead of a toolbar.
    const selector = '.standalonePage,#loginPage,#selectServerPage,#connectPage,#addServerPage,#selectUserPage';
    const bound = new WeakSet();
    const bind = button => {
        if (bound.has(button)) return;
        bound.add(button);
        button.addEventListener('click', window.tigerestSwitchServer);
    };
    // The home names the connected server; it opens the same chooser.
    const homeSelector = '.tg-home-nav-heading';
    // The library column can be narrow: labels give way to icons, and as a
    // last step the controls move below the title, which is never squeezed.
    // Measured only when the heading or its controls change size.
    const fitHomeHeading = heading => {
        if (!heading.isConnected || !heading.clientWidth) return;
        const eyebrow = heading.querySelector('.tg-home-eyebrow'), label = heading.querySelector('.tigerest-home-server span');
        const fits = () => heading.scrollWidth <= heading.clientWidth + 1 && (!eyebrow || eyebrow.scrollWidth <= eyebrow.clientWidth + 1)
            && (!label?.getClientRects().length || label.scrollWidth <= label.clientWidth + 1);
        for (const compact of ['', 'window', 'server', 'window server', 'window server wrap']) {
            heading.dataset.tigerestCompact = compact;
            if (fits()) break;
        }
        if (!heading.dataset.tigerestCompact) delete heading.dataset.tigerestCompact;
    };
    const headingSizes = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
        const headings = new Set(entries.map(entry => entry.target.closest(homeSelector)));
        for (const heading of headings) if (heading) fitHomeHeading(heading);
    }) : null;
    const homeLabel = button => {
        const name = currentServerLabel();
        button.querySelector('span').textContent = name;
        button.title = `当前服务器：${name}。切换服务器`;
        button.setAttribute('aria-label', button.title);
        const heading = button.closest(homeSelector);
        if (heading) fitHomeHeading(heading);
    };
    const mount = root => {
        const headings = [...root.querySelectorAll(homeSelector)];
        if (root.matches?.(homeSelector)) headings.unshift(root);
        for (const heading of headings) {
            const windowMode = heading.querySelector('.tg-home-window-mode');
            const existing = heading.querySelector('.tigerest-home-server');
            if (existing) {
                bind(existing); homeLabel(existing);
                for (const node of [heading, existing, windowMode]) if (node) headingSizes?.observe(node);
                continue;
            }
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'tigerest-home-server';
            button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg><span></span>';
            bind(button);
            heading.insertBefore(button, windowMode);
            homeLabel(button);
            for (const node of [heading, button, windowMode]) if (node) headingSizes?.observe(node);
        }
        const pages = [...root.querySelectorAll(selector)];
        if (root.matches?.(selector)) pages.unshift(root);
        for (const page of pages) {
            const existing = page.querySelector('.tigerest-switch-entry');
            if (existing) { bind(existing); continue; }
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'tigerest-switch-entry'; button.textContent = '切换服务器';
            bind(button);
            page.insertBefore(button, page.firstChild);
        }
    };
    mount(document);
    window.TigerestServer?.ready?.then(() => document.querySelectorAll('.tigerest-home-server').forEach(homeLabel));
    // Only inserted subtrees are searched, and media/motion layers are skipped.
    new MutationObserver(records => {
        const roots = new Set();
        for (const record of records) {
            // A page that rebuilds its own content loses the in-page entry.
            const page = record.addedNodes.length ? record.target.closest?.(selector) : null;
            if (page) roots.add(page);
            for (const node of record.addedNodes) {
                if (node.nodeType === 1 && !node.closest('.tigerest-motion-layer,.tigerest-motion-cache,.tigerest-motion-flight,.tigerest-motion-poster')) roots.add(node);
            }
        }
        for (const root of roots) if (root.isConnected) mount(root);
    }).observe(document.body, {childList: true, subtree: true});
    // The servers' own server-list entries open the client's list instead:
    // Jellyfin's login "change server" and legacy drawer (.btnSelectServer),
    // its Modern user-menu item (storage icon), and select-server links.
    // Their login, expiry and sign-out pages are left alone.
    document.addEventListener('click', event => {
        const menuItem = event.target.closest?.('.MuiMenu-list [role="menuitem"]');
        const entry = event.target.closest?.('.btnSelectServer, a[href*="selectserver" i], [data-id="selectserver"]')
            || (menuItem?.querySelector('svg[data-testid="StorageIcon"]') ? menuItem : null);
        if (!entry || !/^https?:$/.test(window.location.protocol)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        window.tigerestSwitchServer();
    }, true);
}
installServerSwitchEntry();

let lastFullscreenState = window.jmpInfo.settings.main.fullscreen;

window.jmpInfo.settingsUpdate.push(function(section) {
    if (section === 'main') {
        const currentFullscreenState = window.jmpInfo.settings.main.fullscreen;
        if (currentFullscreenState !== lastFullscreenState) {
            lastFullscreenState = currentFullscreenState;

            if (window.api && window.api.player) {
                window.api.player.notifyFullscreenChange(currentFullscreenState);
                console.log('Player fullscreen notified');
            }

            if (window.Events && window.playbackManager && window.playbackManager._currentPlayer) {
                window.Events.trigger(window.playbackManager._currentPlayer, 'fullscreenchange');
            }
        }
    }
});
