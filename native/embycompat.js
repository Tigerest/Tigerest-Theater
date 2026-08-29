(function () {
    'use strict';

    const existingStartInfo = globalThis.appStartInfo || {};
    const nativePluginIds = [
        'tigerest/mpv-video.js',
        'tigerest/mpv-audio.js',
        'tigerest/input.js',
        'tigerest/session-navigation.js'
    ];

    function seedDefaultServer() {
        const localAddress = 'http://192.168.5.150:8095';
        const remoteAddress = 'http://nas.tigerest.top:8095';
        if (window.location.origin !== localAddress && window.location.origin !== remoteAddress) return;

        try {
            const storageKey = 'servercredentials3';
            const credentials = JSON.parse(localStorage.getItem(storageKey) || '{}');
            if (!Array.isArray(credentials.Servers) || credentials.Servers.length === 0) {
                credentials.Servers = [{
                    Id: '62526c3bf747439c99327ddec5fed4a8',
                    Name: 'TIGEREST-NAS',
                    ManualAddress: remoteAddress,
                    LocalAddress: localAddress,
                    RemoteAddress: remoteAddress,
                    IsLocalServer: true,
                    LastConnectionMode: 0,
                    DateLastAccessed: Date.now()
                }];
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

        defineModule('tigerest/mpv-video.js', [
            'events', 'loading', 'appRouter', 'globalize', 'apphost', 'appSettings', 'confirm'
        ], function (events, loading, appRouter, globalize, appHost, appSettings, confirm) {
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
            'events', 'apphost', 'appSettings', 'toast'
        ], function (events, appHost, appSettings, toast) {
            const NativeAudioPlayer = window._mpvAudioPlayer;
            return class TigerestMpvAudioPlayer extends NativeAudioPlayer {
                constructor() {
                    super({
                        events: moduleValue(events),
                        appHost: moduleValue(appHost),
                        appSettings: moduleValue(appSettings),
                        toast: moduleValue(toast)
                    });
                    this.name = 'Tigerest MPV Audio Player';
                }
            };
        });

        defineModule('tigerest/input.js', [
            'inputManager', 'playbackManager'
        ], function (inputManager, playbackManager) {
            const NativeInputPlugin = window._inputPlugin;
            return class TigerestInputPlugin extends NativeInputPlugin {
                constructor() {
                    super({
                        inputManager: moduleValue(inputManager),
                        playbackManager: moduleValue(playbackManager)
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
