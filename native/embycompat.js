(function () {
    'use strict';

    const existingStartInfo = globalThis.appStartInfo || {};
    const nativePluginIds = [
        'tigerest/mpv-video.js',
        'tigerest/mpv-audio.js',
        'tigerest/input.js',
        'tigerest/session-navigation.js',
        'tigerest/community.js',
        'tigerest/watch.js',
        'tigerest/settings.js'
    ];

    // In app mode, Emby sends a first run without a known server to Emby
    // Connect. Record the server the user chose so its own sign-in opens.
    function chosenServer() {
        const localAddress = 'http://192.168.5.150:8095';
        const remoteAddress = 'https://nas.tigerest.top:18445';
        if (window.location.origin === localAddress || window.location.origin === remoteAddress) return () => ({
            Id: '62526c3bf747439c99327ddec5fed4a8',
            Name: 'TIGEREST-NAS',
            ManualAddress: remoteAddress,
            LocalAddress: localAddress,
            RemoteAddress: remoteAddress,
            IsLocalServer: true,
            LastConnectionMode: 0
        });
        // Only a server's own web client is loaded here, after the user chose
        // that server. The injected settings are a start-up snapshot, so they
        // cannot identify a server entered during this session.
        if (!/^https?:$/.test(window.location.protocol) || !/\/web(?:\/|$)/i.test(window.location.pathname)) return null;
        // Jellyfin's web client finds the server that serves it by itself.
        if (window.TigerestServer?.isJellyfin?.()) return null;
        return () => {
            // The web client lives under /web; a path before it is a reverse-proxy prefix.
            const address = window.location.origin + window.location.pathname.replace(/\/web(?:\/.*)?$/i, '');
            // Emby reads its server list as it starts, so ask before continuing, once per server.
            const request = new XMLHttpRequest();
            request.open('GET', address + '/System/Info/Public', false);
            request.send();
            const info = request.status === 200 ? JSON.parse(request.responseText) : null;
            // A first visit learns the server kind here, before the web client starts.
            if (window.TigerestServer?.remember?.(info) === 'jellyfin') return null;
            // Manual mode keeps the address and port the user entered.
            return info?.Id ? {Id: info.Id, Name: info.ServerName || window.location.host, ManualAddress: address, LastConnectionMode: 2} : null;
        };
    }

    function seedDefaultServer() {
        const server = chosenServer();
        if (!server) return;

        try {
            const storageKey = 'servercredentials3';
            const credentials = JSON.parse(localStorage.getItem(storageKey) || '{}');
            if (!Array.isArray(credentials.Servers) || credentials.Servers.length === 0) {
                const known = server();
                if (!known) return;
                credentials.Servers = [{...known, DateLastAccessed: Date.now()}];
                localStorage.setItem(storageKey, JSON.stringify(credentials));
            }
            // The server is already known, so the generic first-run tour would
            // only delay the normal server sign-in screen.  Emby Connect and
            // server switching remain available from the standard UI.
            if (localStorage.getItem('welcome_seen') !== '1') {
                localStorage.setItem('welcome_seen', '1');
            }
        } catch (error) {
            console.warn('Tigerest Theater: unable to seed the default server');
        }
    }

    seedDefaultServer();

    globalThis.appStartInfo = {
        ...existingStartInfo,
        name: 'Tigerest Theater',
        version: window.jmpInfo.version,
        deviceName: window.jmpInfo.deviceName,
        paths: {
            ...(existingStartInfo.paths || {}),
            apphost: 'tigerest/apphost'
        },
        plugins: [...new Set([...(existingStartInfo.plugins || []), ...nativePluginIds])]
    };

    const moduleValue = value => value && value.default ? value.default : value;

    function getDeviceId() {
        const key = '_tigerestTheaterDeviceId';
        let id = localStorage.getItem(key);
        if (!id) {
            id = globalThis.crypto && crypto.randomUUID
                ? crypto.randomUUID()
                : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                    const r = Math.random() * 16 | 0;
                    return (c === 'x' ? r : (r & 3 | 8)).toString(16);
                });
            localStorage.setItem(key, id);
        }
        return id;
    }

    function createAppHost() {
        const nativeHost = window.NativeShell.AppHost;
        return {
            ...nativeHost,
            moreIcon: 'dots-horiz',
            deviceId: getDeviceId,
            deviceIconUrl() { return null; },
            getPushTokenInfo() { return {}; },
            // Emby 4.8 reports capabilities on every connection with
            // getSyncProfile().then(...); later versions ask only apps that
            // support sync.
            getSyncProfile() { return Promise.resolve(nativeHost.getSyncProfile ? nativeHost.getSyncProfile() : null); },
            downloadFile(downloadInfo) { return window.NativeShell.downloadFile(downloadInfo); },
            openUrl(url, target) { return window.NativeShell.openUrl(url, target); },
            openClientSettings() { return window.NativeShell.openClientSettings(); },
            getPreferredTheme() { return null; },
            setTheme(themeSettings) {
                const meta = document.querySelector('meta[name=theme-color]');
                if (meta && themeSettings && themeSettings.themeColor) {
                    meta.setAttribute('content', themeSettings.themeColor);
                }
            },
            setUserScalable(scalable) {
                const meta = document.querySelector('meta[name=viewport]');
                if (!meta) return;
                meta.setAttribute('content', scalable
                    ? 'viewport-fit=cover, width=device-width, initial-scale=1, minimum-scale=1, user-scalable=yes'
                    : 'viewport-fit=cover, width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no');
            },
            getWindowState() { return document.windowState || 'Normal'; },
            setWindowState() { return Promise.resolve(); }
        };
    }

    // Emby's settings frame, as Emby 4.10 builds it around a 'none' template.
    // Emby 4.9 loads a route's content by address and uses it as given only
    // when it contains "://"; the cache argument it appends falls after the
    // '#', outside the request.
    function settingsFrameAddress() {
        const frame = '<div is="emby-scroller" class="view flex flex-direction-column scrollFrameY flex-grow" data-mousewheel="true" data-horizontal="false" data-forcescrollbar="true" data-focusscroll="true" data-bindheader="true">'
            + '<div class="scrollSlider flex-grow flex-direction-column padded-left padded-left-page padded-right padded-top-page padded-bottom-page settingsContainer">'
            + '<div class="readOnlyContent auto-center padded-top"></div></div></div>';
        return URL.createObjectURL(new Blob([frame], {type: 'text/html'})) + '#';
    }

    let registered = false;
    const registeredDefines = new WeakSet();
    function registerModules(defineModule = window.define) {
        if (typeof defineModule !== 'function' || registeredDefines.has(defineModule)) return;
        registeredDefines.add(defineModule);
        registered = true;

        // Emby's custom-path loader deliberately appends `.js` before passing
        // the identifier to Alameda, so the in-memory module ID must include
        // that suffix as well.
        defineModule('tigerest/apphost.js', [], createAppHost);

        // HomeView still owns /home and its favorites tab. Replace its home
        // controller so every existing Home command uses the same gallery.
        defineModule('home/hometab.js', ['modules/tabbedview/basetab.js', 'connectionManager', 'appRouter', 'modules/maintabsmanager.js'], function (baseTab, connectionManager, appRouter, mainTabsManager) {
            const BaseTab = moduleValue(baseTab), manager = moduleValue(connectionManager), router = moduleValue(appRouter), tabs = moduleValue(mainTabsManager);
            function HomeTab(view, params, options) { BaseTab.apply(this, arguments); }
            Object.assign(HomeTab.prototype, BaseTab.prototype);
            HomeTab.prototype.onTemplateLoaded = function () {
                this.scroller?.pause?.();
                this.scroller = null;
                // sectionstab.template.html is an upgraded Emby scroller.
                // It must not resume against the legacy slider we replace.
                this.view.classList?.remove('scrollFrameY');
                this.view.removeAttribute?.('is');
                // Select the active original HomeView tab. Some Emby versions'
                // showFavorites() helper emits /home&tab=favorites, losing the
                // query parameter and reopening the home tab instead.
                this.gallery = new window.TigerestHomeGallery(this.view, { apiProvider: () => manager.currentApiClient(), router, openFavorites: () => tabs.selectedTabIndex(1) });
                window.TigerestHomeMotion?.setGallery(this.gallery);
                BaseTab.prototype.onTemplateLoaded.apply(this, arguments);
            };
            HomeTab.prototype.enableFocusPreview = function () { return false; };
            HomeTab.prototype.getFocusContainerElement = function () { return this.view; };
            HomeTab.prototype.scrollToBeginning = function () { this.gallery?.scrollToBeginning(); };
            HomeTab.prototype.onResume = function (options) {
                BaseTab.prototype.onResume.apply(this, arguments);
                return this.gallery?.start(options);
            };
            HomeTab.prototype.onPause = function () {
                this.gallery?.stop();
                BaseTab.prototype.onPause.apply(this, arguments);
            };
            HomeTab.prototype.destroy = function () {
                this.gallery?.destroy(); this.gallery = null;
                BaseTab.prototype.destroy.apply(this, arguments);
            };
            return { default: HomeTab };
        });

        // Emby 4.10 keeps a plugin route's own content and builds the settings
        // frame around the empty 'none' template. Emby 4.9 replaces it with a
        // page beside the plugin, which does not exist, so those versions load
        // the same frame as a page of its own.
        let settingsFrame = null;
        const settingsContent = route => {
            let content = 'none';
            return Object.defineProperty(route, 'contentPath', {configurable: true, enumerable: true,
                get: () => content,
                set: () => { content = settingsFrame ||= settingsFrameAddress(); }});
        };
        defineModule('tigerest/settings.js', [], function () {
            return class TigerestSettingsPlugin {
                constructor() { this.id = 'tigerest-native-settings'; }
                getRoutes() {
                    window.tigerestInstallSettingsMenu?.();
                    const base = {templateType: 'settings', settingsTheme: true, icon: '&#xe8b8;'};
                    // Keep old links routable, but only category routes belong
                    // to Emby's shared settings drawer/overview menu filter.
                    return [settingsContent({...base, path: 'settings.html', order: 25,
                        title: '播放器设置',
                        controller: 'tigerest/settings-view.js'}),
                        ...(window.tigerestSettingsCategories?.() || []).map((section, index) => settingsContent({
                            ...base, type: 'settings', settingsType: 'app',
                            path: `settings/${section.key}.html`, title: section.title, icon: section.icon,
                            order: 25 + (index + 1) / 100,
                            tigerestSettingsSection: section.key,
                            controller: `tigerest/settings-${section.key}-view.js`
                        }))];
                }
            };
        });

        const settingsViewDependencies = [
            'modules/viewmanager/baseview.js', 'appRouter', 'connectionManager'
        ];
        const createSettingsView = section => function (baseView, appRouter, connectionManager) {
            const BaseView = moduleValue(baseView), router = moduleValue(appRouter), manager = moduleValue(connectionManager);
            function SettingsView(view, params) {
                BaseView.apply(this, arguments);
                this.settingsHost = view.querySelector('.readOnlyContent');
                this.settingsHost?.classList.add('tigerest-settings-host');
                this.settingsSection = section || params?.section;
                this.mountGeneration = 0;
            }
            Object.assign(SettingsView.prototype, BaseView.prototype);
            SettingsView.prototype.onResume = function () {
                BaseView.prototype.onResume.apply(this, arguments);
                const generation = ++this.mountGeneration;
                router.setTitle?.(window.tigerestSettingsGroupTitle?.(this.settingsSection || 'mpv') || '播放器设置');
                this.settingsMount?.dispose();
                this.mountAbort?.abort();
                this.mountAbort = new AbortController();
                this.settingsMount = null;
                window.tigerestMountSettings(this.settingsHost, this.settingsSection,
                    () => router.show('/settings'), this.mountAbort.signal,
                    {apiProvider: () => manager?.currentApiClient?.()}).then(mount => {
                    if (generation !== this.mountGeneration) mount?.dispose();
                    else this.settingsMount = mount;
                }).catch(() => {
                    if (generation === this.mountGeneration && this.settingsHost)
                        this.settingsHost.textContent = '设置加载失败，请返回后重试。';
                });
            };
            SettingsView.prototype.onPause = function () {
                ++this.mountGeneration;
                this.mountAbort?.abort();
                this.settingsMount?.dispose();
                this.settingsMount = null;
                BaseView.prototype.onPause.apply(this, arguments);
            };
            return SettingsView;
        };
        defineModule('tigerest/settings-view.js', settingsViewDependencies, createSettingsView());
        for (const section of ['main', 'home', 'audio', 'video', 'subtitles', 'mpv', 'danmaku', 'other'])
            defineModule(`tigerest/settings-${section}-view.js`, settingsViewDependencies, createSettingsView(section));

        defineModule('tigerest/mpv-video.js', [
            'events', 'loading', 'appRouter', 'globalize', 'apphost', 'appSettings', 'confirm', 'connectionManager'
        ], function (events, loading, appRouter, globalize, appHost, appSettings, confirm, connectionManager) {
            const NativeVideoPlayer = window._mpvVideoPlayer;
            const router = moduleValue(appRouter);
            return class TigerestMpvVideoPlayer extends NativeVideoPlayer {
                constructor() {
                    super({
                        events: moduleValue(events),
                        loading: moduleValue(loading),
                        appRouter: router,
                        globalize: moduleValue(globalize),
                        appHost: moduleValue(appHost),
                        appSettings: moduleValue(appSettings),
                        confirm: moduleValue(confirm),
                        connectionManager: moduleValue(connectionManager),
                        // Jellyfin Desktop historically injected dashboard's
                        // setBackdropTransparency().  Current Emby exposes the
                        // equivalent compositor hook on appRouter instead.
                        dashboard: {
                            default: {
                                setBackdropTransparency(level) {
                                    if (router && typeof router.setTransparency === 'function') {
                                        router.setTransparency(level);
                                    }
                                }
                            }
                        }
                    });
                    this.name = 'Tigerest MPV Video Player';
                }
            };
        });

        defineModule('tigerest/mpv-audio.js', [
            'events', 'apphost', 'appSettings', 'toast', 'connectionManager'
        ], function (events, appHost, appSettings, toast, connectionManager) {
            const NativeAudioPlayer = window._mpvAudioPlayer;
            return class TigerestMpvAudioPlayer extends NativeAudioPlayer {
                constructor() {
                    super({
                        events: moduleValue(events),
                        appHost: moduleValue(appHost),
                        appSettings: moduleValue(appSettings),
                        toast: moduleValue(toast),
                        connectionManager: moduleValue(connectionManager)
                    });
                    this.name = 'Tigerest MPV Audio Player';
                }
            };
        });

        defineModule('tigerest/input.js', [
            'inputManager', 'playbackManager', 'connectionManager'
        ], function (inputManager, playbackManager, connectionManager) {
            const NativeInputPlugin = window._inputPlugin;
            return class TigerestInputPlugin extends NativeInputPlugin {
                constructor() {
                    super({
                        inputManager: moduleValue(inputManager),
                        playbackManager: moduleValue(playbackManager),
                        connectionManager: moduleValue(connectionManager)
                    });
                }
            };
        });

        defineModule('tigerest/session-navigation.js', [
            'pageJs', 'appRouter', 'connectionManager', 'viewManager'
        ], function (pageJs, appRouter, connectionManager, viewManager) {
            const SessionNavigationPlugin = window._sessionNavigationPlugin;
            return class TigerestSessionNavigationPlugin extends SessionNavigationPlugin {
                constructor() {
                    super({
                        pageJs: moduleValue(pageJs),
                        appRouter: moduleValue(appRouter),
                        connectionManager: moduleValue(connectionManager),
                        viewManager: moduleValue(viewManager)
                    });
                }
            };
        });

        defineModule('tigerest/community.js', ['connectionManager', 'events', 'appRouter'], function (connectionManager, events, appRouter) {
            return class TigerestCommunityPlugin extends window._communityPlugin {
                constructor() {
                    super({connectionManager: moduleValue(connectionManager), events: moduleValue(events), appRouter:moduleValue(appRouter)});
                }
            };
        });

        defineModule('tigerest/watch.js', ['connectionManager', 'events', 'playbackManager', 'appRouter'], function (connectionManager, events, playbackManager, appRouter) {
            const WatchPlugin = window._watchTogetherPlugin;
            return class TigerestWatchPlugin {
                constructor() {
                    if (WatchPlugin) this.watch = new WatchPlugin({connectionManager: moduleValue(connectionManager), events: moduleValue(events),
                        playbackManager: moduleValue(playbackManager), appRouter: moduleValue(appRouter)});
                }
            };
        });

        console.info('Tigerest Theater: Emby native modules registered');
    }

    // This script runs at DocumentCreation, before Emby's AMD loader.  Emby
    // requests appStartInfo.paths.apphost immediately after exposing define,
    // so a timer-based poll is inherently racy.  Observe that assignment and
    // register our in-memory modules synchronously on the same call stack.
    if (typeof window.define !== 'function') {
        try {
            const existingDescriptor = Object.getOwnPropertyDescriptor(window, 'define');
            if (!existingDescriptor || existingDescriptor.configurable) {
                let amdDefine;
                Object.defineProperty(window, 'define', {
                    configurable: true,
                    enumerable: true,
                    get() { return amdDefine; },
                    set(value) {
                        amdDefine = value;
                        registerModules(value);
                    }
                });
            }
        } catch (error) {
            console.warn('Tigerest Theater: unable to install AMD registration hook', error);
        }
    }

    if (typeof window.require !== 'function') {
        try {
            const existingDescriptor = Object.getOwnPropertyDescriptor(window, 'require');
            if (!existingDescriptor || existingDescriptor.configurable) {
                let amdRequire;
                Object.defineProperty(window, 'require', {
                    configurable: true,
                    enumerable: true,
                    get() { return amdRequire; },
                    set(value) {
                        amdRequire = value;
                        registerModules(window.define);
                        if (registered && typeof value === 'function') {
                            // Alameda's define() queues declarations.  Drain
                            // that queue as soon as require() is available so
                            // apphost cannot race ahead and issue a network
                            // request for our in-memory module.
                            value([], function () {});
                        }
                    }
                });
            }
        } catch (error) {
            console.warn('Tigerest Theater: unable to install AMD queue hook', error);
        }
    }

    registerModules();
    const registrationTimer = setInterval(() => {
        registerModules();
        if (registered) clearInterval(registrationTimer);
    }, 0);
    setTimeout(() => clearInterval(registrationTimer), 15000);
})();
