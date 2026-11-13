/* eslint-disable indent */
(function() {
    function getMediaStreamAudioTracks(mediaSource) {
        return mediaSource.MediaStreams.filter(function (s) {
            return s.Type === 'Audio';
        });
    }

    const CREDENTIAL_KEY = /^(api_key|apikey|x-emby-token|x-mediabrowser-token)$/i;

    // A server can take a long time over the first reads (a sleeping disk, a
    // seek for the index at the end of an MKV or MP4). Reports show single reads
    // of 15-29 s, which added up past the old 30 s limit. mpv keeps waiting on a
    // server that never answers, so this is also how long such a server takes
    // to be reported.
    const STARTUP_TIMEOUT_MS = 75000;

    // Emby returns same-server stream URLs without credentials when
    // AddApiKeyToDirectStreamUrl is off. Add the session token for the item's
    // own server only; the native player moves it from the URL into a header.
    // Jellyfin builds its own URLs with the parameter its version accepts;
    // a missing one is added as ApiKey, the only name Jellyfin 12 still reads.
    function authorizedStreamUrl(url, item, connectionManager) {
        let apiClient;
        try {
            apiClient = (item?.ServerId && connectionManager?.getApiClient?.(item.ServerId)) || window.ApiClient;
        } catch (error) {
            apiClient = window.ApiClient;
        }
        const token = apiClient?.accessToken?.();
        let target, server;
        try {
            target = new URL(url);
            server = new URL(apiClient?.serverAddress?.());
        } catch (error) {
            return url;
        }
        if (!token || target.origin !== server.origin) return url;
        for (const key of target.searchParams.keys()) {
            if (CREDENTIAL_KEY.test(key)) return url;
        }
        const hash = url.indexOf('#');
        const base = hash < 0 ? url : url.slice(0, hash);
        const separator = !base.includes('?') ? '?' : /[?&]$/.test(base) ? '' : '&';
        const parameter = window.TigerestServer?.tokenParameter?.() || 'api_key';
        return base + separator + parameter + '=' + encodeURIComponent(token) + (hash < 0 ? '' : url.slice(hash));
    }
    window._tigerestAuthorizedStreamUrl = authorizedStreamUrl;

    // Emby marks a detected intro with IntroStart / IntroEnd chapter markers.
    // Returns it in seconds on the item's timeline, or null.
    function introMarker(options) {
        // A transcode that starts at an offset runs on its own clock.
        if (options?.transcodingOffsetTicks) return null;
        const chapters = options?.mediaSource?.Chapters || options?.item?.Chapters || [];
        let start, end;
        chapters.forEach((chapter, index) => {
            if (chapter.MarkerType === 'IntroStart') {
                start = chapter.StartPositionTicks;
                // Emby's own reading: the next chapter ends an intro that has no end marker.
                if (index < chapters.length - 1) end = chapters[index + 1].StartPositionTicks;
            } else if (chapter.MarkerType === 'IntroEnd') {
                end = chapter.StartPositionTicks;
            }
        });
        return start >= 0 && end > start ? {start: start / 1e7, end: end / 1e7} : null;
    }

    class mpvVideoPlayer {
        constructor({ events, loading, appRouter, globalize, appHost, appSettings, confirm, dashboard, connectionManager, ServerConnections, playbackManager }) {
            this.events = events;
            // Passed by Jellyfin's plugin manager only.
            this.playbackManager = playbackManager;
            // Jellyfin's plugin manager passes the same API client registry as ServerConnections.
            this.connectionManager = connectionManager || ServerConnections;
            this.loading = loading;
            this.appRouter = appRouter;
            this.globalize = globalize;
            this.appHost = appHost;
            this.appSettings = appSettings;

            this.setTransparency = dashboard.default.setBackdropTransparency.bind(dashboard);

            /**
             * @type {string}
             */
            this.name = 'MPV Video Player';
            /**
             * @type {string}
             */
            this.type = 'mediaplayer';
            /**
             * @type {string}
             */
            this.id = 'mpvvideoplayer';
            this.syncPlayWrapAs = 'htmlvideoplayer';
            this.priority = -1;
            this.useFullSubtitleUrls = true;
            /**
             * @type {boolean}
             */
            this.isLocalPlayer = true;
            /**
             * @type {boolean}
             */
            this.isFetching = false;

            /**
             * @type {HTMLDivElement | null | undefined}
             */
            this._videoDialog = undefined;
            /**
             * @type {number | undefined}
             */
            this._subtitleTrackIndexToSetOnPlaying = undefined;
            /**
             * @type {number | null}
             */
            this._audioTrackIndexToSetOnPlaying = undefined;
            /**
             * @type {boolean | undefined}
             */
            this._showTrackOffset = undefined;
            /**
             * @type {number | undefined}
             */
            this._currentTrackOffset = undefined;
            /**
             * @type {string[] | undefined}
             */
            this._supportedFeatures = undefined;
            /**
             * @type {string | undefined}
             */
            this._currentSrc = undefined;
            /**
             * @type {boolean | undefined}
             */
            this._started = undefined;
            /**
             * @type {boolean | undefined}
             */
            this._timeUpdated = undefined;
            /**
             * @type {number | null | undefined}
             */
            this._currentTime = undefined;
            /**
             * @private (used in other files)
             * @type {any | undefined}
             */
            this._currentPlayOptions = undefined;
            /**
             * @type {any | undefined}
             */
            this._lastProfile = undefined;
            /**
             * @type {number | undefined}
             */
            this._duration = undefined;
            /**
             * @type {boolean}
             */
            this._paused = false;
            /**
             * @type {int}
             */
            this._volume = 100;
            this._volumeInitialized = false;
            /**
             * @type {boolean}
             */
            this._muted = false;
            /**
             * @type {float}
             */
            this._playRate;
            /**
             * @type {boolean}
             */
            this._hasConnection = false;
            this._sessionActive = false;
            this._sessionId = 0;
            this._nativeStopRequested = false;
            this._nativeStopPromise = null;
            this._completeNativeStop = null;
            this._windowSessionActive = false;
            this._startupTimer = null;
            this._errorHandling = false;
            this._bufferingPercent = 0;
            this._bufferingProgressAt = null;
            /**
             * @type {Array<{start: number, end: number}>}
             */
            this._bufferedRanges = [];

            /**
             * @private
             */
            this.onBufferedRangesUpdated = (ranges) => {
                this._bufferedRanges = ranges;
            };

            /**
             * @private
             */
            this.onEnded = () => {
                // MPV has already ended the file. Emby's synchronous stopped
                // handlers can call stop() again while this signal is being
                // delivered, which deadlocks a native macOS VO teardown.
                this._nativeStopRequested = true;
                if (this.onEndedInternal()) {
                    this.removeMediaDialog();
                }
            };

            this.onCanceled = () => {
                console.log('[MPV Signal] canceled');
                // CLOSE_WIN/Escape/q already issued stop inside mpv. Mark it
                // before notifying Emby so its cleanup cannot send a second
                // synchronous stop into the terminating native VO.
                this._nativeStopRequested = true;
                const canceledSessionId = this._sessionId;
                if (this._sessionActive) this.declineNextItem();
                if (this.onEndedInternal({playNext: false, resetPlayQueue: true})) {
                    // Native Escape/UOSC stop bypasses the web player's stop()
                    // method.  Explicit user cancellation must also opt out of
                    // Emby's default next-track behavior or playback relaunches
                    // immediately after the native window is hidden.
                    if (this._sessionId === canceledSessionId)
                        this.removeMediaDialog();
                }
            };

            this.onStopped = () => {
                console.log('[MPV Signal] stopped');
                this._completeNativeStop?.();
            };
            this.onNativeError = (error) => {
                // END_FILE_ERROR has already ended the native file. Desktop
                // emits error without stopped; do not wait on an idle-core stop.
                this._nativeStopRequested = true;
                this._completeNativeStop?.();
                this.onError(error);
            };
            this.onSubtitleStreamRequested = (index) => this.setSubtitleStreamIndex(Number(index));
            this.onBuffering = (percent) => {
                console.log(`[MPV Signal] buffering: ${percent}`);
                // mpv reports rising percentages only while it refills its
                // cache after the first frame: data is arriving.
                if (percent > this._bufferingPercent) this._bufferingProgressAt = Date.now();
                this._bufferingPercent = percent;
            };
            this.onStateChanged = (newState, oldState) => console.log(`[MPV Signal] stateChanged: ${oldState} -> ${newState}`);
            this.onVideoPlaybackActive = (active) => console.log(`[MPV Signal] videoPlaybackActive: ${active}`);
            this.onWindowVisible = (visible) => console.log(`[MPV Signal] windowVisible: ${visible}`);
            this.onVideoRectangleChanged = () => console.log('[MPV Signal] onVideoRecangleChanged');
            this.onMetadata = (meta) => console.log(`[MPV Signal] onMetaData: ${meta?.Name || meta?.name || 'media'}`);
            this.onVolumeChanged = (value) => {
                const volume = Number(value);
                if (!this._volumeInitialized || !Number.isFinite(volume) || volume < 0) return;
                const changed = this._volume !== volume;
                this._volume = volume;
                this.saveVolume(volume / 100);
                if (changed) this.events.trigger(this, 'volumechange');
            };

            /**
             * @private
             */
            this.onTimeUpdate = (time) => {
                if (time && !this._timeUpdated) {
                    this._timeUpdated = true;
                }

                this._currentTime = time;
                this.events.trigger(this, 'timeupdate');
            };

            /**
             * @private
             */
            this.onPlaying = () => {
                this.clearStartupTimer();
                if (!this._started) {
                    this._started = true;

                    this.loading.hide();

                    this.setPlaybackRate(this.getPlaybackRate());

                    // Hide backdrop when playback starts
                    const dlg = this._videoDialog;
                    if (dlg) {
                        dlg.style.backgroundImage = '';
                    }

                    const useUoscPlaybackUi = jmpInfo.settings?.mpv?.enableUosc !== false;
                    if (useUoscPlaybackUi) {
                        // libmpv/uosc owns the entire playback surface. Keep the
                        // Emby page alive underneath it solely for playback state,
                        // progress reporting, stream selection and SyncPlay events.
                        if (dlg) {
                            dlg.style.zIndex = 'unset';
                        }
                    } else if (this._currentPlayOptions?.fullscreen) {
                        // Disabling uosc is an explicit fallback to Emby's HTML OSD.
                        this.appRouter.showVideoOsd();
                    }
                    window.api.player.setVideoRectangle(0, 0, 0, 0);
                }

                if (this._paused) {
                    this._paused = false;
                    this.events.trigger(this, 'unpause');
                }

                this.events.trigger(this, 'playing');
            };

            /**
             * @private
             */
            this.onPause = () => {
                // An explicit native pause is a valid user state, including
                // preparation completed while the user chose to stay paused.
                this.clearStartupTimer();
                this._paused = true;
                // For Syncplay ready notification
                this.events.trigger(this, 'pause');
            };

            this.onWaiting = () => {
                this.events.trigger(this, 'waiting');
            };

            /**
             * @private
             * @param e {Event} The event received from the `<video>` element
             */
            this.onError = async (error) => {
                if (this._errorHandling) return;
                this._errorHandling = true;
                this.clearStartupTimer();
                this.loading.hide();
                this._sessionActive = false;
                this.requestNativeStop();
                this.removeMediaDialog();
                console.error(`media error: ${error}`);

                const errorData = {
                    type: 'mediadecodeerror'
                };

                try {
                    await confirm({
                        title: "Playback Failed",
                        text: `Playback failed with error "${error}". Retry with transcode?`,
                        cancelText: "Cancel",
                        confirmText: "Retry"
                    });
                } catch (ex) {
                    // User declined retry
                    errorData.streamInfo = {
                        // Emby reads url before it looks at SupportsTranscoding;
                        // without one it throws and skips its stop handling.
                        url: '',
                        // Prevent jellyfin-web retrying with transcode
                        // which crashes the player
                        mediaSource: {
                            SupportsTranscoding: false
                        }
                    };
                    // The user has already answered: Emby must not open a
                    // second error dialog and then move on to the next item.
                    errorData.returnPromise = true;
                }

                this.events.trigger(this, 'error', [errorData]);
            };

            this.onDuration = (duration) => {
                this._duration = duration;
            };
        }

        currentSrc() {
            return this._currentSrc;
        }

        async play(options) {
            const previousStop = this._nativeStopPromise;
            if (previousStop) {
                try { await previousStop; }
                finally { if (this._nativeStopPromise === previousStop) this._nativeStopPromise = null; }
            }
            this.clearStartupTimer();
            this.loading.hide();
            this._started = false;
            this._timeUpdated = false;
            this._currentTime = null;
            this._bufferedRanges = [];
            this._bufferingPercent = 0;
            this._bufferingProgressAt = null;
            this._sessionActive = true;
            this._sessionId += 1;
            this._nativeStopRequested = false;
            this._nativeStopPromise = null;
            this._errorHandling = false;

            if (!this._windowSessionActive && window.api.window) {
                this._windowSessionActive = true;
                window.api.window.beginPlaybackSession();
            }
            if (options.fullscreen === true && window.api.window) {
                window.api.window.requestPlaybackFullScreen();
            }

            this.resetSubtitleOffset();
            if (options.fullscreen) {
                this.loading.show();
            }
            window.TigerestFaultReports?.setPlayback({
                itemId: options.item?.Id, serverId: options.item?.ServerId, mediaSourceId: options.mediaSource?.Id
            });
            this.startStartupTimer();
            try {
                const elem = await this.createMediaElement(options);
                return await this.setCurrentSrc(elem, options);
            } catch (error) {
                await this.onError(error?.message || error);
                throw error;
            }
        }

        clearStartupTimer() {
            this._startupCheckId = (this._startupCheckId || 0) + 1;
            if (this._startupTimer != null) {
                clearTimeout(this._startupTimer);
                this._startupTimer = null;
            }
        }

        startStartupTimer() {
            this.clearStartupTimer();
            const startupSessionId = this._sessionId;
            const startupCheckId = this._startupCheckId;
            const startedAt = Date.now();
            let preparing = false;
            let nativeDelayMs = 0;
            let graceUsed = false;
            const isCurrent = () => this._sessionId === startupSessionId &&
                this._startupCheckId === startupCheckId && this._sessionActive && !this._started;
            const fail = () => {
                if (!isCurrent()) return;
                const message = preparing ? 'RIFE 准备超时，请重试播放'
                    : `播放器启动超时（${Math.round((Date.now() - startedAt) / 1000)} 秒）`;
                window.TigerestFaultReports?.record({kind: 'startup-timeout', message, nativeDelayMs,
                    elapsedMs: Date.now() - startedAt});
                this.onError(message);
            };
            const check = async () => {
                if (!isCurrent()) return;
                this._startupTimer = null;
                const player = window.api.player;
                // Keep normal startup bounded. Only a growing cache or the
                // native startup hold can extend it, and neither a hung bridge
                // nor a stale native clock can wait forever (worker: 950 s;
                // first-frame gate: 15 s).
                if (Date.now() - startedAt >= 1000000) {
                    fail();
                    return;
                }
                // A slow server can show the first frame near the deadline and
                // still be refilling the cache. Keep waiting while the cache
                // grows; one that stops filling still times out.
                const progressAt = this._bufferingProgressAt;
                if (progressAt != null && Date.now() - progressAt < 10000) {
                    this._startupTimer = setTimeout(check, 10000);
                    return;
                }
                if (!player.rifeExtensionStatus) {
                    fail();
                    return;
                }
                // The native side answers at once unless its main thread is
                // frozen. Playback queued behind such a freeze usually starts
                // right after it, so wait for the answer (bounded) instead of
                // stopping a load that is about to succeed.
                const asked = Date.now();
                this._startupTimer = setTimeout(fail, 90000);
                let status;
                try {
                    status = await player.rifeExtensionStatus();
                } catch (_) {
                    fail();
                    return;
                }
                if (!isCurrent()) return;
                clearTimeout(this._startupTimer);
                this._startupTimer = null;
                nativeDelayMs = Math.max(nativeDelayMs, Date.now() - asked);
                const runtime = status?.runtime;
                if (runtime?.startupWaiting === true &&
                    Number.isFinite(runtime.preparationElapsedMs) &&
                    runtime.preparationElapsedMs >= 0 && runtime.preparationElapsedMs < 980000) {
                    preparing = true;
                    this._startupTimer = setTimeout(check, 5000);
                } else if (Date.now() - asked > 1500 && !graceUsed) {
                    // The answer was late: the native side has just resumed.
                    graceUsed = true;
                    this._startupTimer = setTimeout(check, 10000);
                } else {
                    fail();
                }
            };
            this._startupTimer = setTimeout(check, STARTUP_TIMEOUT_MS);
        }

        requestNativeStop() {
            if (this._nativeStopRequested) return this._nativeStopPromise || Promise.resolve();
            this._nativeStopRequested = true;
            if (window.api.system?.isAndroid) {
                // Android delivers cancellation signals before this bridge reply.
                this._nativeStopPromise = Promise.resolve(window.api.player.stop());
            } else {
                // Qt's command callback acknowledges stop, but END_FILE (and Mac
                // native VO teardown) can happen later. Wait for its stopped signal.
                this._nativeStopPromise = new Promise((resolve, reject) => {
                    const player = window.api.player;
                    const connected = [];
                    let settled = false;
                    const cleanup = () => {
                        clearTimeout(timer);
                        for (const signal of connected) signal.disconnect(complete);
                        if (this._completeNativeStop === complete) this._completeNativeStop = null;
                    };
                    const complete = () => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        resolve();
                    };
                    const fail = error => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        reject(error);
                    };
                    const timer = setTimeout(() => {
                        fail(new Error('mpv 未能完成停止播放'));
                    }, 15000);
                    this._completeNativeStop = complete;
                    try {
                        // Emby's synchronous stopped handler can destroy the
                        // player before native END_FILE arrives. These temporary
                        // connections survive removal of ordinary UI listeners.
                        for (const signal of [player.stopped, player.error]) {
                            signal.connect(complete);
                            connected.push(signal);
                        }
                        player.stop();
                    }
                    catch (error) {
                        fail(error);
                    }
                });
            }
            this._nativeStopPromise.catch(error => console.error('[MPV] stop failed:', error));
            return this._nativeStopPromise;
        }

        getSavedVolume() {
            // The old shared Emby key could be reduced to zero by the volume
            // notification feedback bug. A separate key makes the first
            // corrected initialization distinguishable from intentional zero.
            const current = this.appSettings.get('tigerest-mpv-volume-v2');
            if (current != null && current !== '' && Number.isFinite(Number(current)) && Number(current) >= 0)
                return Number(current);
            const saved = this.appSettings.get('volume');
            if (saved == null || saved === '') return 1;
            const volume = Number(saved);
            return Number.isFinite(volume) && volume > 0 ? volume : 1;
        }


        tryGetFramerate(options) {
            if (options.mediaSource && options.mediaSource.MediaStreams) {
                for (let stream of options.mediaSource.MediaStreams) {
                    if (stream.Type == "Video") {
                        return stream.RealFrameRate || stream.AverageFrameRate || null;
                    }
                }
            }
        }

        /**
         * 'hdr', 'sdr', 'dovi' (Dolby Vision without an HDR10 or HLG base
         * layer, such as profile 5) or '' when a transcode may change it.
         * Emby reports VideoRange/ExtendedVideoType, Jellyfin VideoRangeType
         * and the DV fields; both report the transfer function.
         * @private
         */
        tryGetDynamicRange(options) {
            const source = options.mediaSource;
            if (!source || source.TranscodingUrl || options.url?.includes('/master.m3u8')) return '';
            const video = (source.MediaStreams || []).find(stream => stream.Type === 'Video');
            if (!video) return '';
            const transfer = String(video.ColorTransfer || '').toLowerCase();
            const type = String(video.VideoRangeType || video.ExtendedVideoType || '').toLowerCase();
            const subType = String(video.ExtendedVideoSubType || '').toLowerCase();
            const profile = Number(video.DvProfile) || Number(/doviprofile(\d)/.exec(subType)?.[1]) || 0;
            const dovi = type.startsWith('dovi') || type === 'dolbyvision' || profile > 0;
            if (dovi && (type === 'dovi' || type === 'doviwithsdr' || profile === 5 ||
                (profile > 0 && video.DvBlSignalCompatibilityId === 0))) return 'dovi';
            const hdr = transfer === 'smpte2084' || transfer === 'arib-std-b67' ||
                String(video.VideoRange || '').toUpperCase() === 'HDR' ||
                /hdr|hlg|hyperloggamma|dovi|dolbyvision/.test(type);
            return hdr ? 'hdr' : 'sdr';
        }

        /**
         * @private
         */
        getStreamByIndex(mediaStreams, jellyIndex) {
            for (const stream of mediaStreams) {
                if (stream.Index == jellyIndex) {
                    return stream;
                }
            }
            return null;
        }

        /**
         * @private
         */
        getRelativeIndexByType(mediaStreams, jellyIndex, streamType) {
            let relIndex = 1;
            for (const source of mediaStreams) {
                if (source.Type != streamType || source.IsExternal) {
                    continue;
                }
                if (source.Index == jellyIndex) {
                    return relIndex;
                }
                relIndex += 1;
            }
            return null;
        }

        /** Resolve Emby's root-relative external subtitle URL for libmpv. */
        getExternalSubtitleUrl(deliveryUrl, stream) {
            // Jellyfin's DeliveryUrl starts after the server's Base URL, which
            // only its API client address includes.
            if (window.TigerestServer?.isJellyfin?.() && !stream?.IsExternalUrl && /^\/(?!\/)/.test(deliveryUrl)) {
                const serverId = this._currentPlayOptions?.item?.ServerId;
                let apiClient = window.ApiClient;
                try { apiClient = (serverId && this.connectionManager?.getApiClient?.(serverId)) || apiClient; } catch (_) { /* current client */ }
                const address = apiClient?.serverAddress?.();
                if (address) return address.replace(/\/+$/, '') + deliveryUrl;
            }
            try {
                return new URL(deliveryUrl, this._currentSrc).href;
            } catch (error) {
                console.warn('[MPV] Could not resolve external subtitle URL');
                return deliveryUrl;
            }
        }

        /**
         * @private
         */
        setCurrentSrc(elem, options) {
            return new Promise((resolve, reject) => {
                const val = options.url;
                this._currentSrc = val;
                console.debug('[MPV] Starting media playback');

                // Convert to seconds
                const ms = (options.playerStartPositionTicks || 0) / 10000;
                this._currentPlayOptions = options;
                this._subtitleTrackIndexToSetOnPlaying = options.mediaSource.DefaultSubtitleStreamIndex == null ? -1 : options.mediaSource.DefaultSubtitleStreamIndex;
                this._audioTrackIndexToSetOnPlaying = options.mediaSource.DefaultAudioStreamIndex;

                console.log('[MPV] Audio track index:', this._audioTrackIndexToSetOnPlaying);
                console.log('[MPV] Subtitle track index:', this._subtitleTrackIndexToSetOnPlaying);

                const streamdata = {type: 'video', headers: {'User-Agent': jmpInfo.userAgent}, metadata: options.item, media: {}};
                const fps = this.tryGetFramerate(options);
                if (fps) {
                    streamdata.frameRate = fps;
                }
                streamdata.dynamicRange = this.tryGetDynamicRange(options);

                const player = window.api.player;

                const streams = options.mediaSource?.MediaStreams || [];
                if (window.api.system?.isAndroid) {
                    streamdata.media.subtitleStreams = streams.filter(stream => stream.Type === 'Subtitle').map(stream => ({
                        index: stream.Index,
                        title: stream.DisplayTitle || stream.Title || stream.Language || '字幕',
                        language: stream.Language || ''
                    }));
                }

                // Handle audio
                const audioRelIndex = this._audioTrackIndexToSetOnPlaying != null && this._audioTrackIndexToSetOnPlaying >= 0
                    ? this.getRelativeIndexByType(streams, this._audioTrackIndexToSetOnPlaying, 'Audio')
                    : 1;

                // Handle subtitle - check for external first
                let subtitleParam;
                if (this._subtitleTrackIndexToSetOnPlaying >= 0) {
                    const subStream = this.getStreamByIndex(streams, this._subtitleTrackIndexToSetOnPlaying);
                    if (subStream && subStream.DeliveryMethod === 'External' && subStream.DeliveryUrl) {
                        subtitleParam = '#,' + this.getExternalSubtitleUrl(subStream.DeliveryUrl, subStream);
                        console.log('[MPV] External subtitle stream selected');
                    } else {
                        const relIndex = this.getRelativeIndexByType(streams, this._subtitleTrackIndexToSetOnPlaying, 'Subtitle');
                        subtitleParam = relIndex != null ? relIndex : -1;
                        console.log('[MPV] Mapped subtitle index:', this._subtitleTrackIndexToSetOnPlaying, '->', subtitleParam);
                    }
                } else {
                    subtitleParam = -1;
                }

                console.log('[MPV] Mapped audio index:', this._audioTrackIndexToSetOnPlaying, '->', audioRelIndex);

                // Restore once, before autoplay can produce audio. Subsequent
                // episodes retain mpv's live volume, including UOSC changes
                // whose web-channel notification may still be queued.
                if (!this._volumeInitialized) {
                    const savedVolume = this.getSavedVolume();
                    this.setVolume(savedVolume * 100, false);
                    this.saveVolume(savedVolume);
                    this._volumeInitialized = true;
                }
                // 一起看 loads room items stopped; the room starts them together.
                const autoplay = !window.TigerestWatch?.loadPaused?.(options.item?.Id);
                player.load(authorizedStreamUrl(val, options.item, this.connectionManager),
                    { startMilliseconds: ms, autoplay },
                    streamdata,
                    audioRelIndex,
                    subtitleParam,
                    (loaded) => {
                        if (loaded) resolve();
                        else reject(new Error('mpv 拒绝了媒体加载命令'));
                    });
                // The load has cleared the previous item's marker.
                this.publishIntroSkip(options);
            });
        }

        /**
         * Emby's "skip intro" button belongs to its HTML OSD, which stays
         * hidden while uosc owns the playback surface, so uosc gets the item's
         * intro marker instead. The conditions are those of Emby's button:
         * the user's IntroSkipMode and the server's Emby Premiere.
         * @private
         */
        async publishIntroSkip(options) {
            const player = window.api.player;
            const intro = introMarker(options);
            if (!intro || typeof player.setIntroSkip !== 'function') return;
            try {
                const serverId = options.item?.ServerId;
                const apiClient = (serverId && this.connectionManager?.getApiClient?.(serverId)) || window.ApiClient;
                const mode = (await apiClient.getCurrentUser())?.Configuration?.IntroSkipMode;
                if (mode === 'None') return;
                const services = await window.Emby.importModule('./modules/registrationservices/registrationservices.js');
                await (services.default || services).validateFeature('dvr', {viewOnly: true, showDialog: false, serverId});
                // 一起看 turns a jump into a seek for the whole room: there the
                // button stays, and skipping is left to whoever presses it.
                if (this._currentPlayOptions === options && this._sessionActive)
                    player.setIntroSkip({start: intro.start, end: intro.end,
                        auto: mode === 'AutoSkip' && !window.TigerestWatch?.inRoom?.()});
            } catch (error) {
                // Emby rejects without a reason when the server has no Premiere.
                console.warn('[MPV] Intro skip is unavailable: ' + (error?.message || 'Emby Premiere was not confirmed'));
            }
        }

        setSubtitleStreamIndex(index) {
            console.log('[MPV] setSubtitleStreamIndex called with index:', index);
            this._subtitleTrackIndexToSetOnPlaying = index;

            if (index < 0) {
                window.api.player.setSubtitleStream(-1);
                return;
            }

            const streams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const stream = this.getStreamByIndex(streams, index);

            // Handle external subtitle URL
            if (stream && stream.DeliveryMethod === 'External' && stream.DeliveryUrl) {
                console.log('[MPV] Loading external subtitle stream');
                window.api.player.setSubtitleStream('#,' + this.getExternalSubtitleUrl(stream.DeliveryUrl, stream));
                return;
            }

            // Handle embedded subtitle via relative index
            const relIndex = this.getRelativeIndexByType(streams, index, 'Subtitle');
            console.log('[MPV] Mapped subtitle index:', index, '->', relIndex);
            window.api.player.setSubtitleStream(relIndex != null ? relIndex : -1);
        }

        setSecondarySubtitleStreamIndex(index) {
            // MPV doesn't support secondary subtitles - no-op for compatibility
            console.log('[MPV] setSecondarySubtitleStreamIndex not supported, ignoring index:', index);
        }

        resetSubtitleOffset() {
            this._currentTrackOffset = 0;
            this._showTrackOffset = false;
            window.api.player.setSubtitleDelay(0);
        }

        enableShowingSubtitleOffset() {
            this._showTrackOffset = true;
        }

        disableShowingSubtitleOffset() {
            this._showTrackOffset = false;
        }

        isShowingSubtitleOffsetEnabled() {
            return this._showTrackOffset;
        }

        setSubtitleOffset(offset) {
            const offsetValue = parseFloat(offset);
            this._currentTrackOffset = offsetValue;
            window.api.player.setSubtitleDelay(Math.round(offsetValue * 1000));
        }

        getSubtitleOffset() {
            return this._currentTrackOffset;
        }

        /**
         * @private
         */
        isAudioStreamSupported() {
            return true;
        }

        /**
         * @private
         */
        getSupportedAudioStreams() {
            const profile = this._lastProfile;

            return getMediaStreamAudioTracks(this._currentPlayOptions.mediaSource).filter((stream) => {
                return this.isAudioStreamSupported(stream, profile);
            });
        }

        setAudioStreamIndex(index) {
            console.log('[MPV] setAudioStreamIndex called with index:', index);
            this._audioTrackIndexToSetOnPlaying = index;

            const streams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const relIndex = index < 0 ? -1 : this.getRelativeIndexByType(streams, index, 'Audio');
            console.log('[MPV] Mapped audio index:', index, '->', relIndex);
            window.api.player.setAudioStream(relIndex != null ? relIndex : -1);
        }

        // Jellyfin's playback manager ignores the stop info's playNext: its
        // 'stopped' handler starts the next queue item unless its own stop()
        // cleared _playNextAfterEnded first. A native cancel (player or system
        // Back, media-session stop) bypasses that stop(), so clear it the same
        // way. Natural end of file keeps Jellyfin's autoplay setting.
        declineNextItem() {
            const manager = this.playbackManager;
            if (manager && typeof manager._playNextAfterEnded === 'boolean') manager._playNextAfterEnded = false;
        }

        onEndedInternal(stopOptions = {}) {
            if (!this._sessionActive) return false;

            this._sessionActive = false;
            this.clearStartupTimer();
            this.loading.hide();
            const stopInfo = {
                src: this._currentSrc,
                ...stopOptions
            };

            this.events.trigger(this, 'stopped', [stopInfo]);

            this._currentTime = null;
            this._currentSrc = null;
            this._currentPlayOptions = null;
            return true;
        }

        stop(destroyPlayer) {
            const stopped = this._sessionActive || this._currentSrc
                ? this.requestNativeStop()
                : this._nativeStopPromise || Promise.resolve();
            this.onEndedInternal({playNext: false, resetPlayQueue: true});
            this.removeMediaDialog();

            return stopped.finally(() => {
                if (destroyPlayer) this.destroy();
            });
        }

        removeMediaDialog() {
            this.clearStartupTimer();
            this.loading.hide();
            window.api.player.setVideoRectangle(-1, 0, 0, 0);

            document.body.classList.remove('hide-scroll');

            const dlg = this._videoDialog;
            if (dlg) {
                this.setTransparency(0); // TRANSPARENCY_LEVEL.None
                this._videoDialog = null;
                dlg.parentNode.removeChild(dlg);
            }

            // Only supporting QtWebEngine here
            if (document.webkitIsFullScreen && document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }

            if (this._windowSessionActive && window.api.window) {
                this._windowSessionActive = false;
                window.api.window.endPlaybackSession();
            }
        }

        destroy() {
            if (this._sessionActive || this._currentSrc)
                this.requestNativeStop();
            this.onEndedInternal();
            this.removeMediaDialog();

            const player = window.api.player;
            this._hasConnection = false;
            this._bufferedRanges = [];
            player.playing.disconnect(this.onPlaying);
            player.positionUpdate.disconnect(this.onTimeUpdate);
            player.finished.disconnect(this.onEnded);
            player.canceled.disconnect(this.onCanceled);
            player.stopped.disconnect(this.onStopped);
            player.subtitleStreamRequested?.disconnect(this.onSubtitleStreamRequested);
            this._duration = undefined;
            player.updateDuration.disconnect(this.onDuration);
            player.error.disconnect(this.onNativeError);
            player.paused.disconnect(this.onPause);
            player.bufferedRangesUpdated.disconnect(this.onBufferedRangesUpdated);
            player.buffering.disconnect(this.onBuffering);
            player.stateChanged.disconnect(this.onStateChanged);
            player.videoPlaybackActive.disconnect(this.onVideoPlaybackActive);
            player.windowVisible.disconnect(this.onWindowVisible);
            player.onVideoRecangleChanged.disconnect(this.onVideoRectangleChanged);
            player.onMetaData.disconnect(this.onMetadata);
            player.volumeChanged?.disconnect(this.onVolumeChanged);
        }

        /**
         * @private
         */
        createMediaElement(options) {
            const dlg = document.querySelector('.videoPlayerContainer');

            if (!dlg) {
                const dlg = document.createElement('div');

                dlg.classList.add('videoPlayerContainer');
                dlg.style.position = 'fixed';
                dlg.style.top = 0;
                dlg.style.bottom = 0;
                dlg.style.left = 0;
                dlg.style.right = 0;
                dlg.style.display = 'flex';
                dlg.style.alignItems = 'center';

                if (options.fullscreen) {
                    dlg.style.zIndex = 1000;
                }

                const html = '';

                dlg.innerHTML = html;

                // Set backdrop if available
                if (options.backdropUrl) {
                    dlg.style.backgroundImage = `url('${options.backdropUrl}')`;
                    dlg.style.backgroundSize = 'cover';
                    dlg.style.backgroundPosition = 'center';
                }

                document.body.insertBefore(dlg, document.body.firstChild);
                this.setTransparency(2); // TRANSPARENCY_LEVEL.Full
                this._videoDialog = dlg;
                const player = window.api.player;
                if (!this._hasConnection) {
                    this._hasConnection = true;
                    player.playing.connect(this.onPlaying);
                    player.positionUpdate.connect(this.onTimeUpdate);
                    player.finished.connect(this.onEnded);
                    player.canceled.connect(this.onCanceled);
                    player.stopped.connect(this.onStopped);
                    player.subtitleStreamRequested?.connect(this.onSubtitleStreamRequested);
                    player.updateDuration.connect(this.onDuration);
                    player.error.connect(this.onNativeError);
                    player.paused.connect(this.onPause);
                    player.bufferedRangesUpdated.connect(this.onBufferedRangesUpdated);
                    player.buffering.connect(this.onBuffering);
                    player.stateChanged.connect(this.onStateChanged);
                    player.videoPlaybackActive.connect(this.onVideoPlaybackActive);
                    player.windowVisible.connect(this.onWindowVisible);
                    player.onVideoRecangleChanged.connect(this.onVideoRectangleChanged);
                    player.onMetaData.connect(this.onMetadata);
                    player.volumeChanged?.connect(this.onVolumeChanged);
                }

                if (options.fullscreen) {
                    // At this point, we must hide the scrollbar placeholder, so it's not being displayed while the item is being loaded
                    document.body.classList.add('hide-scroll');
                }
                return Promise.resolve();
            } else {
                // we need to hide scrollbar when starting playback from page with animated background
                if (options.fullscreen) {
                    document.body.classList.add('hide-scroll');
                }

                return Promise.resolve();
            }
        }

    /**
     * @private
     */
    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'video';
    }

    canPlayItem(item, playOptions) {
        // Delegate to canPlayMediaType - MPV can play any video the media type check passes
        return this.canPlayMediaType(item.MediaType);
    }

    /**
     * @private
     */
    supportsPlayMethod() {
        return true;
    }

    /**
     * @private
     */
    getDeviceProfile(item, options) {
        if (this.appHost.getDeviceProfile) {
            return Promise.resolve(this.appHost.getDeviceProfile(item, options));
        }

        return Promise.resolve({});
    }

    /**
     * @private
     */
    static getSupportedFeatures() {
        return ['PlaybackRate', 'SetAspectRatio'];
    }

    supports(feature) {
        if (!this._supportedFeatures) {
            this._supportedFeatures = mpvVideoPlayer.getSupportedFeatures();
        }

        return this._supportedFeatures.includes(feature);
    }

    isFullscreen() {
        // Check native window fullscreen state
        if (window.jmpInfo && window.jmpInfo.settings && window.jmpInfo.settings.main) {
            return window.jmpInfo.settings.main.fullscreen === true;
        }
        return false;
    }

    toggleFullscreen() {
        if (window.api && window.api.input) {
            window.api.input.executeActions(['host:fullscreen']);
        }
    }

    // Save this for when playback stops, because querying the time at that point might return 0
    currentTime(val) {
        if (val != null) {
            window.api.player.seekTo(val);
            return;
        }

        return this._currentTime;
    }

    currentTimeAsync() {
        return window.api.player.getPosition();
    }

    duration() {
        if (this._duration) {
            return this._duration;
        }

        return null;
    }

    canSetAudioStreamIndex() {
        return true;
    }

    static onPictureInPictureError(err) {
        console.error(`Picture in picture error: ${err}`);
    }

    setPictureInPictureEnabled() {}

    isPictureInPictureEnabled() {
        return false;
    }

    isAirPlayEnabled() {
        return false;
    }

    setAirPlayEnabled() {}

    setBrightness() {}

    getBrightness() {
        return 100;
    }

    seekable() {
        return Boolean(this._duration);
    }

    pause() {
        window.api.player.pause();
    }

    // This is a retry after error
    resume() {
        this._paused = false;
        window.api.player.play();
    }

    unpause() {
        window.api.player.play();
    }

    paused() {
        return this._paused;
    }

    setPlaybackRate(value) {
        let playSpeed = +value; //this comes as a string from player force int for now
        this._playRate = playSpeed;
        window.api.player.setPlaybackRate(playSpeed * 1000);

        if (window.api && window.api.player) {
            window.api.player.notifyRateChange(playSpeed);
        }
    }

    getPlaybackRate() {
        if(!this._playRate) //On startup grab default
        {
            let playRate = window.jmpInfo.settings.video.default_playback_speed;

            if(!playRate) //fallback if default missing
                playRate = 1;

            this._playRate = playRate;
        }
        return this._playRate;
    }

    getSupportedPlaybackRates() {
        return [{
            name: '0.5x',
            id: 0.5
        }, {
            name: '0.75x',
            id: 0.75
        }, {
            name: '1x',
            id: 1.0
        }, {
            name: '1.25x',
            id: 1.25
        }, {
            name: '1.5x',
            id: 1.5
        }, {
            name: '1.75x',
            id: 1.75
        }, {
            name: '2x',
            id: 2.0
        }, {
            name: '2.5x',
            id: 2.5
        }, {
            name: '3x',
            id: 3.0
        }, {
            name: '3.5x',
            id: 3.5
        }, {
            name: '4.0x',
            id: 4.0
        }];
    }

    saveVolume(value) {
        if (Number.isFinite(value) && value >= 0) {
            for (const key of ['tigerest-mpv-volume-v2', 'volume']) {
                try {
                    this.appSettings.set(key, value);
                } catch (error) {
                    // Storage can be unavailable or full; playback and live
                    // volume controls must remain usable in that case.
                    console.warn('[MPV] Could not save volume preference');
                }
            }
        }
    }

    setVolume(val, save = true) {
        val = Number(val);
        if (Number.isFinite(val) && val >= 0) {
            this._volume = val;
            if (save) {
                this.saveVolume(val / 100);
                this.events.trigger(this, 'volumechange');
            }
            window.api.player.setVolume(val);
        }
    }

    getVolume() {
        return this._volume;
    }

    volumeUp() {
        this.setVolume(Math.min(this.getVolume() + 2, 100));
    }

    volumeDown() {
        this.setVolume(Math.max(this.getVolume() - 2, 0));
    }

    setMute(mute, triggerEvent = true) {
        this._muted = mute;
        window.api.player.setMuted(mute);
        if (triggerEvent) {
            this.events.trigger(this, 'volumechange');
        }
    }

    isMuted() {
        return this._muted;
    }

    togglePictureInPicture() {
    }

    toggleAirPlay() {
    }

    getBufferedRanges() {
        return this._bufferedRanges;
    }

    getStats() {
        const playOptions = this._currentPlayOptions || [];
        const categories = [];

        if (!this._currentPlayOptions) {
            return Promise.resolve({
                categories: categories
            });
        }

        const mediaCategory = {
            stats: [],
            type: 'media'
        };
        categories.push(mediaCategory);

        if (playOptions.url) {
            //  create an anchor element (note: no need to append this element to the document)
            let link = document.createElement('a');
            //  set href to any path
            link.setAttribute('href', playOptions.url);
            const protocol = (link.protocol || '').replace(':', '');

            if (protocol) {
                mediaCategory.stats.push({
                    label: this.globalize.translate('LabelProtocol'),
                    value: protocol
                });
            }

            link = null;
        }

        mediaCategory.stats.push({
            label: this.globalize.translate('LabelStreamType'),
            value: 'Video'
        });

        const videoCategory = {
            stats: [],
            type: 'video'
        };
        categories.push(videoCategory);

        const audioCategory = {
            stats: [],
            type: 'audio'
        };
        categories.push(audioCategory);

        return Promise.resolve({
            categories: categories
        });
    }

    getSupportedAspectRatios() {
        const options = window.jmpInfo.settingsDescriptions.video.find(x => x.key == 'aspect').options;
        const current = window.jmpInfo.settings.video.aspect;

        const getOptionName = (option) => {
            const canTranslate = {
                'normal': 'Auto',
                'zoom': 'AspectRatioCover',
                'stretch': 'AspectRatioFill',
            }
            const name = option.replace('video.aspect.', '');
            return canTranslate[name]
                ? this.globalize.translate(canTranslate[name])
                : name;
        }

        return options.map(x => ({
            id: x.value,
            name: getOptionName(x.title),
            selected: x.value == current
        }));
    }

    getAspectRatio() {
        return window.jmpInfo.settings.video.aspect;
    }

    setAspectRatio(value) {
        window.jmpInfo.settings.video.aspect = value;
    }
}
/* eslint-enable indent */

window._mpvVideoPlayer = mpvVideoPlayer;
})();
