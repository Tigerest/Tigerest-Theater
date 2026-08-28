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
];

const getPlugins = () => {
    const basePlugins = [
        'inputPlugin',
        'updatePlugin'
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
        return window.api.system.startDownload(downloadInfo);
    },

    openClientSettings() {
        showSettingsModal();
    },

    openMpvSettings() {
        showSettingsModal();
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
    await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve);
    });

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
window.apiPromise = createApi();
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
        return features.includes(command.toLowerCase());
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
        legendHeader.textContent = "已保存的 Emby 服务器";
        legend.appendChild(legendHeader);
        const legendSubHeader = document.createElement("h4");
        legendSubHeader.textContent = (
            "客户端会优先连接已保存的服务器。重置后，下次启动将先尝试内网地址，" +
            "再尝试公网地址；此操作不会从当前 Emby 账号退出。"
        );
        legend.appendChild(legendSubHeader);
        group.appendChild(legend);

        const resetSavedServer = document.createElement("button");
        resetSavedServer.className = "raised button-cancel block btnCancel emby-button";
        resetSavedServer.textContent = "重置服务器地址"
        resetSavedServer.style.marginLeft = "auto";
        resetSavedServer.style.marginRight = "auto";
        resetSavedServer.style.maxWidth = "50%";
        resetSavedServer.addEventListener("click", async () => {
            window.jmpInfo.settings.main.userWebClient = '';
            window.location.href = jmpInfo.scriptPath + "/find-webclient.html";
        });
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

async function showSettingsModal() {
    await initCompleted;

    let mpvDiagnostics = {};
    try {
        mpvDiagnostics = await window.api.player.mpvDiagnostics();
    } catch (error) {
        console.warn('Unable to read MPV diagnostics', error);
    }

    const previous = document.getElementById('tigerest-settings-overlay');
    if (previous) return;

    const sectionMeta = {
        main: {
            title: '客户端',
            subtitle: '窗口、启动与系统集成'
        },
        audio: {
            title: '音频',
            subtitle: '输出设备、声道与直通'
        },
        video: {
            title: '视频',
            subtitle: '硬件解码、同步与转码策略'
        },
        subtitles: {
            title: '字幕',
            subtitle: '字体、样式、位置与 ASS 行为'
        },
        mpv: {
            title: 'MPV 画质与插件',
            subtitle: '渲染、HDR、缓存、uosc 与弹幕'
        },
        other: {
            title: '高级',
            subtitle: '直接传入 mpv.conf 选项'
        }
    };
    const restartSettings = new Set([
        'main.enableMPV',
        'mpv.configMode',
        'mpv.renderBackend',
        'mpv.systemConfigDir',
        'mpv.enableUosc',
        'mpv.enableDanmaku'
    ]);
    const embeddedOnlyMpvSettings = new Set([
        'shaderPreset',
        'enableUosc',
        'enableDanmaku',
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

    const css = document.createElement('style');
    css.id = 'tigerest-settings-style';
    css.textContent = `
        #tigerest-settings-overlay {
            position: fixed; inset: 0; z-index: 100000;
            display: flex; align-items: center; justify-content: center;
            padding: 3vh 3vw; background: rgba(0, 0, 0, .72);
            backdrop-filter: blur(8px);
        }
        .tgs-dialog {
            width: min(1120px, 94vw); height: min(820px, 92vh);
            display: grid; grid-template-rows: auto 1fr auto;
            color: #f5f5f5; background: #111214;
            border: 1px solid rgba(255,255,255,.12); border-radius: 18px;
            box-shadow: 0 24px 90px rgba(0,0,0,.65); overflow: hidden;
        }
        .tgs-header {
            display: flex; align-items: center; gap: 18px; padding: 20px 24px;
            border-bottom: 1px solid rgba(255,255,255,.09);
            background: linear-gradient(110deg, rgba(255,183,20,.13), transparent 52%);
        }
        .tgs-brand { width: 5px; align-self: stretch; border-radius: 4px; background: #ffb714; }
        .tgs-title { margin: 0; font-size: 25px; font-weight: 750; }
        .tgs-subtitle { margin-top: 4px; color: #aeb0b5; font-size: 13px; }
        .tgs-search {
            margin-left: auto; width: min(310px, 31vw); padding: 10px 13px;
            color: #fff; background: #202226; border: 1px solid #3b3d42;
            border-radius: 9px; outline: none;
        }
        .tgs-search:focus { border-color: #ffb714; box-shadow: 0 0 0 2px rgba(255,183,20,.16); }
        .tgs-body { min-height: 0; display: grid; grid-template-columns: 225px 1fr; }
        .tgs-tabs { padding: 16px 12px; overflow-y: auto; background: #0d0e10; border-right: 1px solid rgba(255,255,255,.08); }
        .tgs-tab {
            width: 100%; margin: 2px 0; padding: 12px 13px; color: #c8c9cd;
            text-align: left; background: transparent; border: 0; border-radius: 9px; cursor: pointer;
        }
        .tgs-tab:hover { background: #202124; }
        .tgs-tab.active { color: #111; background: #ffb714; font-weight: 700; }
        .tgs-tab small { display: block; margin-top: 3px; color: inherit; opacity: .72; font-size: 11px; font-weight: 400; }
        .tgs-content { min-width: 0; overflow-y: auto; padding: 24px clamp(18px, 3vw, 38px) 40px; }
        .tgs-section { display: none; max-width: 780px; margin: 0 auto; }
        .tgs-section.active { display: block; }
        .tgs-section-head { display: flex; align-items: start; gap: 16px; margin-bottom: 20px; }
        .tgs-section-head h2 { margin: 0; font-size: 24px; }
        .tgs-section-head p { margin: 5px 0 0; color: #aeb0b5; }
        .tgs-reset {
            margin-left: auto; white-space: nowrap; padding: 8px 12px; color: #e6e6e6;
            background: #27282c; border: 1px solid #414349; border-radius: 8px; cursor: pointer;
        }
        .tgs-callout {
            margin: 0 0 18px; padding: 14px 16px; color: #ddd;
            background: rgba(255,183,20,.08); border: 1px solid rgba(255,183,20,.28); border-radius: 10px;
            line-height: 1.55;
        }
        .tgs-setting {
            display: grid; grid-template-columns: minmax(220px, 1fr) minmax(230px, 320px);
            gap: 20px; align-items: center; padding: 16px 0;
            border-bottom: 1px solid rgba(255,255,255,.075);
        }
        .tgs-setting-title { display: flex; align-items: center; gap: 8px; font-weight: 650; }
        .tgs-help { margin-top: 5px; color: #a9abb0; font-size: 12px; line-height: 1.5; white-space: pre-line; }
        .tgs-restart {
            display: inline-block; padding: 2px 6px; color: #ffcc58; font-size: 10px;
            border: 1px solid rgba(255,190,45,.45); border-radius: 4px; font-weight: 500;
        }
        .tgs-scope {
            display: inline-block; padding: 2px 6px; color: #b9bdc6; font-size: 10px;
            border: 1px solid rgba(185,189,198,.35); border-radius: 4px; font-weight: 500;
        }
        .tgs-control {
            box-sizing: border-box; width: 100%; min-height: 40px; padding: 9px 11px;
            color: #fff; background: #202226; border: 1px solid #42444a; border-radius: 8px; outline: none;
        }
        .tgs-control:focus { border-color: #ffb714; }
        textarea.tgs-control { min-height: 150px; resize: vertical; font-family: Consolas, Menlo, monospace; }
        .tgs-switch-wrap { display: flex; justify-content: flex-end; align-items: center; gap: 10px; }
        .tgs-switch { width: 22px; height: 22px; accent-color: #ffb714; }
        .tgs-switch-state { min-width: 32px; color: #bfc1c5; font-size: 12px; }
        .tgs-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 22px; }
        .tgs-action { padding: 13px; color: #fff; background: #27282c; border: 1px solid #414349; border-radius: 9px; cursor: pointer; }
        .tgs-footer {
            display: flex; align-items: center; gap: 14px; padding: 14px 24px;
            background: #0d0e10; border-top: 1px solid rgba(255,255,255,.08);
        }
        .tgs-status { color: #9fa2a7; font-size: 12px; }
        .tgs-close { margin-left: auto; min-width: 120px; padding: 10px 18px; color: #151515; background: #ffb714; border: 0; border-radius: 8px; font-weight: 700; cursor: pointer; }
        @media (max-width: 760px) {
            #tigerest-settings-overlay { padding: 0; }
            .tgs-dialog { width: 100vw; height: 100vh; border-radius: 0; }
            .tgs-body { grid-template-columns: 1fr; }
            .tgs-tabs { display: flex; gap: 5px; overflow-x: auto; border-right: 0; border-bottom: 1px solid rgba(255,255,255,.08); }
            .tgs-tab { min-width: 126px; }
            .tgs-setting { grid-template-columns: 1fr; gap: 9px; }
            .tgs-search { width: 35vw; }
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
    overlay.id = 'tigerest-settings-overlay';
    const dialog = element('div', 'tgs-dialog');
    overlay.appendChild(dialog);

    const header = element('div', 'tgs-header');
    header.appendChild(element('div', 'tgs-brand'));
    const heading = element('div');
    heading.appendChild(element('h2', 'tgs-title', '大河影院 / MPV 设置'));
    heading.appendChild(element('div', 'tgs-subtitle', '常规配置即时应用；带“需重启”标记的项目在下次启动生效'));
    header.appendChild(heading);
    const search = element('input', 'tgs-search');
    search.type = 'search';
    search.placeholder = '搜索设置，例如 HDR、字幕、缓存…';
    header.appendChild(search);
    dialog.appendChild(header);

    const body = element('div', 'tgs-body');
    const tabs = element('nav', 'tgs-tabs');
    const content = element('main', 'tgs-content');
    body.append(tabs, content);
    dialog.appendChild(body);

    const footer = element('div', 'tgs-footer');
    const status = element('div', 'tgs-status', '设置保存在当前客户端配置中，不会包含 Emby 密码或令牌。');
    const closeButton = element('button', 'tgs-close', '完成');
    footer.append(status, closeButton);
    dialog.appendChild(footer);

    const orderedSections = [...jmpInfo.sections]
        .sort((a, b) => a.order - b.order)
        .filter(entry => sectionMeta[entry.key] && jmpInfo.settingsDescriptions[entry.key]);
    const tabButtons = new Map();
    const groups = new Map();
    let activeSection = sessionStorage.getItem('tigerestSettingsTab') || 'mpv';
    if (!orderedSections.some(entry => entry.key === activeSection)) {
        activeSection = orderedSections[0]?.key || 'main';
    }

    const showSaved = message => {
        status.textContent = message;
        clearTimeout(showSaved.timer);
        showSaved.timer = setTimeout(() => {
            status.textContent = '设置保存在当前客户端配置中，不会包含 Emby 密码或令牌。';
        }, 2200);
    };

    const saveSetting = (section, key, value) => {
        jmpInfo.settings[section][key] = value;
        showSaved(restartSettings.has(`${section}.${key}`) ? '已保存；此项将在重启后生效。' : '已保存并应用。');
    };

    const activate = section => {
        activeSection = section;
        sessionStorage.setItem('tigerestSettingsTab', section);
        for (const [key, button] of tabButtons) button.classList.toggle('active', key === section);
        for (const [key, group] of groups) group.classList.toggle('active', key === section);
        content.scrollTop = 0;
    };

    const makeControl = (section, setting, currentValue) => {
        const key = setting.key;
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
        const meta = sectionMeta[section];
        const tab = element('button', 'tgs-tab');
        tab.type = 'button';
        tab.append(element('span', '', meta.title), element('small', '', meta.subtitle));
        tab.addEventListener('click', () => {
            search.value = '';
            activate(section);
        });
        tabs.appendChild(tab);
        tabButtons.set(section, tab);

        const group = element('section', 'tgs-section');
        group.dataset.section = section;
        const groupHead = element('div', 'tgs-section-head');
        const groupTitle = element('div');
        groupTitle.append(element('h2', '', meta.title), element('p', '', meta.subtitle));
        const reset = element('button', 'tgs-reset', '恢复本页默认值');
        reset.type = 'button';
        reset.addEventListener('click', async () => {
            if (!window.confirm(`确定恢复“${meta.title}”的默认设置吗？`)) return;
            await window.api.settings.resetToDefault(section);
            showSaved('已恢复默认值。正在刷新设置页…');
            setTimeout(() => {
                overlay.remove();
                css.remove();
                showSettingsModal();
            }, 180);
        });
        groupHead.append(groupTitle, reset);
        group.appendChild(groupHead);

        if (section === 'mpv') {
            const activeMode = jmpInfo.mpvConfigMode === 'system' ? '系统用户配置' : '大河内置配置';
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
                `当前实际使用：${activeMode} · ${activeRoot}。渲染后端：${rendererName}（当前 VO：${activeVo}）；默认配置档：${profileName}；视频 ${sourceSize} → 输出 ${outputSize}；实际缩放：${actualScale}；当前加载着色器：${shaderSummary}；完整帧流水线：${passSummary}。播放中按 Ctrl+J 开关统计总览、按数字 2 查看完整处理页，或按 Ctrl+Shift+J 直接显示完整页。自动模式优先读取你现有的 Windows/macOS 用户 mpv.conf；只有找不到用户配置时才部署内置配置。GPU-Next 模式会把 mpv 子窗口绑定到客户端窗口；兼容模式则锁定 vo=libmpv，防止 profile 另开播放窗口。标记“仅内置”的项可预先编辑，但只在切换为大河内置模式后生效，不会覆盖当前用户配置档与着色器。`
            ));
        } else if (section === 'other') {
            group.appendChild(element(
                'div',
                'tgs-callout',
                '这里接受标准 mpv.conf 的 key=value，每行一项，并在客户端选项之后应用。请不要填写 vo、wid 或 gpu-context；错误参数会记录为无敏感信息的警告。'
            ));
        }

        const values = jmpInfo.settings[section];
        for (const setting of jmpInfo.settingsDescriptions[section]) {
            const row = element('div', 'tgs-setting');
            row.dataset.search = `${meta.title} ${setting.displayName || setting.key} ${setting.key} ${setting.help || ''}`.toLowerCase();
            const label = element('div');
            const labelTitle = element('div', 'tgs-setting-title');
            labelTitle.appendChild(element('span', '', setting.displayName || setting.key));
            if (restartSettings.has(`${section}.${setting.key}`)) {
                labelTitle.appendChild(element('span', 'tgs-restart', '需重启'));
            }
            if (section === 'mpv' && embeddedOnlyMpvSettings.has(setting.key)) {
                labelTitle.appendChild(element('span', 'tgs-scope', '仅内置'));
            }
            label.appendChild(labelTitle);
            if (setting.help) label.appendChild(element('div', 'tgs-help', setting.help));
            row.append(label, makeControl(section, setting, values[setting.key]));
            group.appendChild(row);
        }

        if (section === 'main') {
            const actions = element('div', 'tgs-actions');
            if (jmpInfo.settings.main.userWebClient) {
                const resetServer = element('button', 'tgs-action', '重置已保存的服务器地址');
                resetServer.addEventListener('click', () => {
                    window.jmpInfo.settings.main.userWebClient = '';
                    window.location.href = jmpInfo.scriptPath + '/find-webclient.html';
                });
                actions.appendChild(resetServer);
            }
            const offline = element('button', 'tgs-action', '打开下载与离线媒体管理');
            offline.addEventListener('click', () => {
                overlay.remove();
                css.remove();
                window.tigerestOpenOfflineLibrary();
            });
            actions.appendChild(offline);
            group.appendChild(actions);
        }

        content.appendChild(group);
        groups.set(section, group);
    }

    const applySearch = () => {
        const query = search.value.trim().toLowerCase();
        if (!query) {
            activate(activeSection);
            for (const group of groups.values()) {
                for (const row of group.querySelectorAll('.tgs-setting')) row.style.display = '';
            }
            return;
        }
        for (const group of groups.values()) {
            let matches = 0;
            for (const row of group.querySelectorAll('.tgs-setting')) {
                const visible = row.dataset.search.includes(query);
                row.style.display = visible ? '' : 'none';
                if (visible) matches += 1;
            }
            group.classList.toggle('active', matches > 0);
        }
        status.textContent = '正在显示所有分类中的匹配项。';
    };
    search.addEventListener('input', applySearch);

    const close = () => {
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        css.remove();
    };
    const onKeyDown = event => {
        if (event.key === 'Escape') close();
    };
    closeButton.addEventListener('click', close);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) close();
    });
    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(overlay);
    activate(activeSection);
    search.focus();
}

// Emby 4.9.5 routes its “应用设置” item to the server-provided settings page
// and never calls NativeShell.openClientSettings(). Keep a version-independent
// direct entry in the top bar and a conventional Ctrl/Cmd+, shortcut.
window.tigerestOpenMpvSettings = showSettingsModal;

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

function installMpvSettingsEntry() {
    // The native shell is injected at DocumentCreation, before <head> and
    // <html> necessarily exist. Defer mounting instead of aborting the rest
    // of the shell on an early null append/observe target.
    if (!document.head || !document.documentElement) {
        setTimeout(installMpvSettingsEntry, 50);
        return;
    }

    if (!document.getElementById('tigerest-mpv-entry-style')) {
        const style = document.createElement('style');
        style.id = 'tigerest-mpv-entry-style';
        style.textContent = `
            #tigerest-mpv-settings-button {
                width: auto; min-width: 3.25em; padding: 0 .7em; margin: 0 .15em;
                color: #ffbe38; font: 800 12px/1 system-ui, sans-serif;
                letter-spacing: .06em; border-radius: 999px;
                border: 1px solid rgba(255,190,56,.42);
                background: rgba(255,190,56,.08);
            }
            #tigerest-mpv-settings-button:hover,
            #tigerest-mpv-settings-button:focus-visible {
                color: #151515; background: #ffbe38;
            }
        `;
        document.head.appendChild(style);
    }

    const mount = () => {
        if (document.getElementById('tigerest-mpv-settings-button')) return;
        const userButton = document.querySelector('.headerUserButton');
        if (!userButton?.parentElement) return;

        const button = document.createElement('button');
        button.id = 'tigerest-mpv-settings-button';
        button.type = 'button';
        button.className = 'headerButton headerSectionItem paper-icon-button-light emby-button-focusscale';
        button.textContent = 'MPV';
        button.title = 'MPV 画质与插件设置（Ctrl+,）';
        button.setAttribute('aria-label', 'MPV 画质与插件设置');
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            showSettingsModal();
        });
        userButton.parentElement.insertBefore(button, userButton);
    };

    mount();
    const observer = new MutationObserver(mount);
    observer.observe(document.documentElement, {childList: true, subtree: true});

    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === ',') {
            event.preventDefault();
            showSettingsModal();
        }
    }, true);
}

installMpvSettingsEntry();
installHorizontalShelfDragging();

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
