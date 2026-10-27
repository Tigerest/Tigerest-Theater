(function() {
const remap = {
    "play_pause": "playpause",
    "seek_forward": "fastforward",
    "seek_backward": "rewind",
    "host:fullscreen": "togglefullscreen",
    "cycle_audio": "changeaudiotrack",
    "cycle_subtitles": "changesubtitletrack",
    "increase_volume": "volumeup",
    "decrease_volume": "volumedown",
    "step_backward": "previouschapter",
    "step_forward": "nextchapter",
    "enter": "select",
}

class inputPlugin {
    constructor({ inputManager, playbackManager, connectionManager }) {
        this.name = 'Input Plugin';
        this.type = 'input';
        this.id = 'inputPlugin';

        this.durationCheckInterval = null;
        this.positionUpdateInterval = null;
        this.attachedPlayer = null;
        this.streamingBitrateSignal = null;
        this.onStreamingBitrateRequested = null;
        this.streamingBitratePending = false;

        (async () => {
            const api = await window.apiPromise;

            // UOSC owns only the quality picker. Emby Web owns the stream
            // change so it can re-run PlaybackInfo with the current position,
            // media source, audio/subtitle tracks and play session.
            this.streamingBitrateSignal = api.player.streamingBitrateRequested;
            this.onStreamingBitrateRequested = (requestedBitrate) => {
                const bitrate = Number(requestedBitrate);
                const report = (success, message = '') => {
                    this.streamingBitratePending = false;
                    api.player.notifyStreamingBitrateResult(bitrate, success, message);
                };

                if (this.streamingBitratePending) {
                    api.player.notifyStreamingBitrateResult(bitrate, false, '上一次品质切换尚未完成');
                    return;
                }
                if (!Number.isSafeInteger(bitrate) || bitrate < 0) {
                    report(false, '无效的码率档位');
                    return;
                }

                const currentPlayer = playbackManager._currentPlayer;
                if (!currentPlayer || typeof playbackManager.setMaxStreamingBitrate !== 'function') {
                    report(false, '当前没有可切换的 Emby 播放流');
                    return;
                }

                this.streamingBitratePending = true;
                let switchPromise;
                try {
                    switchPromise = playbackManager.setMaxStreamingBitrate({
                        enableAutomaticBitrateDetection: bitrate === 0,
                        maxBitrate: bitrate,
                    }, currentPlayer);
                } catch (error) {
                    console.error('PlayerMedia: streaming bitrate switch failed:', error);
                    report(false, error?.message || '无法发起品质切换');
                    return;
                }

                Promise.resolve(switchPromise).then(() => {
                    report(true);
                }).catch(error => {
                    console.error('PlayerMedia: streaming bitrate switch failed:', error);
                    report(false, error?.message || 'Emby 服务器拒绝了品质切换');
                });
            };
            this.streamingBitrateSignal.connect(this.onStreamingBitrateRequested);

            // Emby queues a single episode when playback starts from a series'
            // next-up item. The episode list then offers the rest of its
            // season; choosing one starts that episode as Emby's new queue.
            const seasonItemPrefix = 'season-episode:';
            let season = {key: '', episodes: []};
            const loneEpisode = (playlist) => {
                const item = playlist.length === 1 ? playlist[0] : null;
                return item?.Type === 'Episode' && item.SeriesId ? item : null;
            };
            const seasonKey = (episode) => [episode.ServerId, episode.SeriesId, episode.SeasonId || ''].join('/');
            const loadSeason = (playlist, loaded) => {
                const episode = loneEpisode(playlist);
                if (!episode || season.key === seasonKey(episode)) return;
                const apiClient = connectionManager?.getApiClient?.(episode);
                if (!apiClient) return;
                const key = seasonKey(episode);
                const query = {UserId: apiClient.getCurrentUserId(), IsMissing: false, IsVirtualUnaired: false};
                if (episode.SeasonId) query.SeasonId = episode.SeasonId;
                season = {key, episodes: []};
                Promise.resolve().then(() => apiClient.getEpisodes(episode.SeriesId, query)).then(result => {
                    if (season.key !== key) return;
                    season.episodes = (result?.Items || []).filter(entry => entry?.Id && entry.LocationType !== 'Virtual')
                        .map(({Id, Name, IndexNumber, ParentIndexNumber}) => ({Id, Name, IndexNumber, ParentIndexNumber}));
                    loaded();
                }).catch(error => {
                    console.error('PlayerMedia: season episode list failed:', error);
                });
            };
            // The offered season with the queued episode under its queue
            // identity, or null while Emby's own queue is the list.
            const seasonEntries = (playlist) => {
                const episode = loneEpisode(playlist);
                if (!episode || season.key !== seasonKey(episode) || !season.episodes.some(entry => entry.Id === episode.Id)) return null;
                return season.episodes.map(entry => Object.assign({}, entry,
                    {PlaylistItemId: entry.Id === episode.Id ? episode.PlaylistItemId : seasonItemPrefix + entry.Id}));
            };
            const seasonPosition = (entries) => entries.findIndex(entry => !entry.PlaylistItemId.startsWith(seasonItemPrefix));

            const selectPlaylistItem = (id) => {
                const player = playbackManager._currentPlayer;
                const playlist = playbackManager._playQueueManager?.getPlaylist() || [];
                if (!player || typeof id !== 'string') return;
                if (playlist.some(item => item.PlaylistItemId === id)) {
                    Promise.resolve().then(() => playbackManager.setCurrentPlaylistItem(id, player)).catch(error => {
                        console.error('PlayerMedia: episode selection failed:', error);
                    });
                    return;
                }
                const episode = id.startsWith(seasonItemPrefix) ? seasonEntries(playlist)?.find(entry => entry.PlaylistItemId === id) : null;
                if (!episode) return;
                Promise.resolve().then(() => playbackManager.play({ids: [episode.Id], serverId: playlist[0].ServerId, fullscreen: true})).catch(error => {
                    console.error('PlayerMedia: episode selection failed:', error);
                });
            };
            // Previous / next move through the offered season as well.
            const stepSeason = (delta) => {
                const entries = seasonEntries(playbackManager._playQueueManager?.getPlaylist() || []);
                const target = entries?.[seasonPosition(entries) + delta];
                if (!target) return false;
                selectPlaylistItem(target.PlaylistItemId);
                return true;
            };
            if ((api.system.isAndroid || api.system.isIPad) && api.input.playlistItemRequested) {
                api.input.playlistItemRequested.connect(selectPlaylistItem);
            }

            api.input.hostInput.connect((actions) => {
                actions.forEach(action => {
                    if (typeof action === 'string' && action.startsWith('playlist-item:')) {
                        selectPlaylistItem(action.slice('playlist-item:'.length));
                    } else if ((action === 'next' || action === 'previous') && stepSeason(action === 'next' ? 1 : -1)) {
                        // Moved within the offered season.
                    } else if (action === 'shuffle') {
                        playbackManager.setQueueShuffleMode('Shuffle');
                    } else if (action === 'sorted') {
                        playbackManager.setQueueShuffleMode('Sorted');
                    } else if (action === 'previous') {
                        const currentPlayer = playbackManager._currentPlayer;
                        if (currentPlayer && playbackManager.isPlayingAudio(currentPlayer)) {
                            const currentTime = playbackManager.currentTime(currentPlayer);
                            const currentIndex = playbackManager.getCurrentPlaylistIndex(currentPlayer);

                            if (currentTime >= 5 * 1000 || currentIndex <= 0) {
                                playbackManager.seekPercent(0, currentPlayer);
                            } else {
                                playbackManager.previousTrack(currentPlayer);
                            }
                        } else if (currentPlayer) {
                            playbackManager.previousTrack(currentPlayer);
                        }
                    } else {
                        if (remap.hasOwnProperty(action)) {
                            action = remap[action];
                        }
                        inputManager.handleCommand(action, {});
                    }
                });
            });

            let lastQueueSnapshot = '';
            const updateQueueState = function(force = false) {
                try {
                    if (!api || !api.player) {
                        return;
                    }

                    const rawPlaylist = playbackManager._playQueueManager?.getPlaylist();
                    const playlist = Array.isArray(rawPlaylist) ? rawPlaylist : [];
                    loadSeason(playlist, updateQueueState);
                    const offered = seasonEntries(playlist);

                    if (typeof api.player.setWebPlaylist === 'function') {
                        // Emby owns the streams and queue order. Native controls need
                        // only identity and labels, not full media/source metadata.
                        const items = (offered || playlist).map(({PlaylistItemId, Id, Name, IndexNumber, ParentIndexNumber}) =>
                            ({PlaylistItemId, Id, Name, IndexNumber, ParentIndexNumber}));
                        const currentId = playbackManager.getCurrentPlaylistItemId() || '';
                        const snapshot = JSON.stringify([items, currentId]);
                        if (force === true || snapshot !== lastQueueSnapshot) {
                            lastQueueSnapshot = snapshot;
                            api.player.setWebPlaylist(items, currentId);
                        }
                    }

                    const currentIndex = playbackManager._playQueueManager?.getCurrentPlaylistIndex();
                    if (currentIndex === undefined || currentIndex === null || currentIndex < 0) {
                        api.player.notifyQueueChange(false, false);
                        return;
                    }

                    if (offered) {
                        const position = seasonPosition(offered);
                        api.player.notifyQueueChange(position < offered.length - 1, position > 0);
                        return;
                    }

                    const canNext = currentIndex < playlist.length - 1;

                    const state = playbackManager.getPlayerState();
                    const isMusic = state?.NowPlayingItem?.MediaType === 'Audio';
                    const canPrevious = isMusic ? true : currentIndex > 0;

                    api.player.notifyQueueChange(canNext, canPrevious);
                } catch (e) {
                    console.error('PlayerMedia: Error in updateQueueState:', e);
                }
            };

            let globalListenersAttached = false;
            let lastReportedPosition = 0;

            if (!globalListenersAttached) {
                let lastFullscreenState = window.jmpInfo.settings.main.fullscreen;
                window.jmpInfo.settingsUpdate.push(function(section) {
                    if (section === 'main') {
                        const currentFullscreenState = window.jmpInfo.settings.main.fullscreen;
                        if (currentFullscreenState !== lastFullscreenState) {
                            lastFullscreenState = currentFullscreenState;
                            const currentPlayer = playbackManager._currentPlayer;
                            if (currentPlayer) {
                                window.Events.trigger(currentPlayer, 'fullscreenchange');
                            }
                        }
                    }
                });

                if (window.api && window.api.player) {
                    window.api.player.playbackRateChanged.connect(function(rate) {
                        const currentPlayer = playbackManager._currentPlayer;

                        if (currentPlayer && currentPlayer._playRate !== undefined) {
                            currentPlayer._playRate = rate;
                        }

                        if (window.Events && currentPlayer) {
                            window.Events.trigger(currentPlayer, 'ratechange');
                        }
                    });
                } else {
                    console.log('SystemMedia: Cannot attach playbackRateChanged listener - api:', !!window.api, 'player:', !!window.api?.player);
                }

                if (window.api && window.api.input) {
                    window.api.input.volumeChanged.connect(function(volume) {
                        const currentPlayer = playbackManager._currentPlayer;
                        if (currentPlayer && typeof currentPlayer.setVolume === 'function') {
                            currentPlayer.setVolume(volume);
                        }
                    });

                    window.api.input.rateChanged.connect(function(rate) {
                        const currentPlayer = playbackManager._currentPlayer;
                        if (currentPlayer && typeof currentPlayer.setPlaybackRate === 'function') {
                            currentPlayer.setPlaybackRate(rate);
                        }
                    });

                    // WORKAROUND: MPRIS spec has no "Buffering" playback state
                    // During seek buffering, we set Rate to 0.0 to stop MPRIS clients from
                    // auto-incrementing position. Once buffering completes, we restore Rate to 1.0.

                    window.api.input.positionSeek.connect(function(positionMs) {
                        const currentPlayer = playbackManager._currentPlayer;
                        if (currentPlayer) {
                            const duration = playbackManager.duration();
                            if (duration) {
                                const percent = (positionMs * 10000) / duration * 100;
                                playbackManager.seekPercent(percent, currentPlayer);
                            }
                        }

                        api.player.notifyPosition(Math.floor(positionMs));
                        lastReportedPosition = positionMs;

                        api.player.notifyRateChange(0.0);
                    });
                }

                window.Events.on(playbackManager, 'playlistitemremove', updateQueueState);
                window.Events.on(playbackManager, 'playlistitemadd', updateQueueState);
                window.Events.on(playbackManager, 'playlistitemchange', updateQueueState);

                window.Events.on(playbackManager, 'playbackstop', function(e, playbackStopInfo) {
                    updateQueueState();

                    const isNavigating = !!(playbackStopInfo && playbackStopInfo.nextMediaType);
                    api.player.notifyPlaybackStop(isNavigating);
                });

                globalListenersAttached = true;
            }

            window.Events.on(playbackManager, 'playbackstart', (e, player) => {
                if (!player) return;
                // The native playing signal can precede Emby's playbackstart.
                // Publish here as well, after Emby has established queue identity.
                updateQueueState(true);

                const state = playbackManager.getPlayerState();
                if (state && state.NowPlayingItem) {
                    api.player.notifyMetadata(state.NowPlayingItem);

                    const initialPos = playbackManager.currentTime();
                    if (initialPos !== undefined && initialPos !== null) {
                        api.player.notifyPosition(Math.floor(initialPos));
                        lastReportedPosition = initialPos;
                    }

                    if (player && typeof player.getVolume === 'function') {
                        const volume = player.getVolume();
                        api.player.notifyVolumeChange(volume / 100.0);
                    }
                }

                let lastDuration = 0;
                const checkDuration = function() {
                    updateQueueState();
                    const duration = playbackManager.duration();
                    if (duration && duration !== lastDuration) {
                        lastDuration = duration;
                        const durationMs = Math.floor(duration / 10000);
                        api.player.notifyDurationChange(durationMs);
                    }
                };
                if (this.durationCheckInterval) clearInterval(this.durationCheckInterval);
                checkDuration();
                this.durationCheckInterval = setInterval(checkDuration, 1000);

                if (player !== this.attachedPlayer) {
                    if (this.attachedPlayer) {
                        window.Events.off(this.attachedPlayer, 'shufflequeuemodechange');
                        window.Events.off(this.attachedPlayer, 'repeatmodechange');
                        window.Events.off(this.attachedPlayer, 'playing');
                        window.Events.off(this.attachedPlayer, 'pause');
                        window.Events.off(this.attachedPlayer, 'playbackstop');
                        window.Events.off(this.attachedPlayer, 'volumechange');
                        window.Events.off(this.attachedPlayer, 'ratechange');
                        window.Events.off(this.attachedPlayer, 'timeupdate');
                    }

                    this.attachedPlayer = player;

                    window.Events.on(player, 'shufflequeuemodechange', () => {
                    const mode = playbackManager.getQueueShuffleMode();
                    const enabled = (mode === 'Shuffle');
                    api.player.notifyShuffleChange(enabled);
                });

                window.Events.on(player, 'repeatmodechange', () => {
                    const mode = playbackManager.getRepeatMode();
                    api.player.notifyRepeatChange(mode);
                });

                window.Events.on(player, 'playing', () => {
                    api.player.notifyPlaybackState('Playing');

                    updateQueueState(true);

                    api.player.notifyRateChange(1.0);

                    if (this.durationCheckInterval) {
                        clearInterval(this.durationCheckInterval);
                    }
                    checkDuration();
                    this.durationCheckInterval = setInterval(checkDuration, 1000);

                    const initialPos = playbackManager.currentTime();
                    if (initialPos !== undefined && initialPos !== null) {
                        api.player.notifyPosition(Math.floor(initialPos));
                    }

                    if (this.positionUpdateInterval) {
                        clearInterval(this.positionUpdateInterval);
                    }
                    this.positionUpdateInterval = setInterval(() => {
                        const positionMs = playbackManager.currentTime();
                        if (positionMs !== undefined && positionMs !== null) {
                            const positionDiff = Math.abs(positionMs - lastReportedPosition);
                            if (lastReportedPosition > 0 && positionDiff > 2000) {
                                api.player.notifyRateChange(0.0);
                                api.player.notifySeek(Math.floor(positionMs));
                            } else {
                                api.player.notifyPosition(Math.floor(positionMs));
                            }
                            lastReportedPosition = positionMs;
                        }
                    }, 500);
                });

                window.Events.on(player, 'pause', () => {
                    api.player.notifyPlaybackState('Paused');
                    api.player.notifyRateChange(0.0);

                    if (this.durationCheckInterval) {
                        clearInterval(this.durationCheckInterval);
                        this.durationCheckInterval = null;
                    }

                    const currentPos = playbackManager.currentTime();
                    if (currentPos !== undefined && currentPos !== null) {
                        lastReportedPosition = currentPos;
                    }
                });

                window.Events.on(player, 'playbackstop', () => {
                    if (this.durationCheckInterval) {
                        clearInterval(this.durationCheckInterval);
                        this.durationCheckInterval = null;
                    }

                    if (this.positionUpdateInterval) {
                        clearInterval(this.positionUpdateInterval);
                        this.positionUpdateInterval = null;
                    }

                    lastDuration = 0;
                    lastReportedPosition = 0;
                });

                    window.Events.on(player, 'volumechange', () => {
                        if (player && typeof player.getVolume === 'function') {
                            const volume = player.getVolume();
                            api.player.notifyVolumeChange(volume / 100.0);
                        }
                    });

                    window.Events.on(player, 'ratechange', () => {
                        if (player && typeof player.getPlaybackRate === 'function') {
                            const rate = player.getPlaybackRate();
                            api.player.notifyRateChange(rate);
                        }
                    });

                    window.Events.on(player, 'timeupdate', () => {
                        const positionMs = playbackManager.currentTime();
                        if (positionMs !== undefined && positionMs !== null) {
                            const positionDiff = Math.abs(positionMs - lastReportedPosition);
                            if (lastReportedPosition > 0 && positionDiff > 2000) {
                                // Player-initiated seek - set rate to 0 during buffering
                                api.player.notifyRateChange(0.0);
                                api.player.notifySeek(Math.floor(positionMs));
                            } else if (positionDiff > 100) {
                                api.player.notifyPosition(Math.floor(positionMs));
                            }
                            lastReportedPosition = positionMs;
                        }
                    });
                }
            });

            api.system.hello("jmpInputPlugin");
        })();
    }

    destroy() {
        if (this.streamingBitrateSignal && this.onStreamingBitrateRequested) {
            this.streamingBitrateSignal.disconnect(this.onStreamingBitrateRequested);
            this.streamingBitrateSignal = null;
            this.onStreamingBitrateRequested = null;
        }

        if (this.durationCheckInterval) {
            clearInterval(this.durationCheckInterval);
            this.durationCheckInterval = null;
        }

        if (this.positionUpdateInterval) {
            clearInterval(this.positionUpdateInterval);
            this.positionUpdateInterval = null;
        }

        if (this.attachedPlayer) {
            window.Events.off(this.attachedPlayer, 'shufflequeuemodechange');
            window.Events.off(this.attachedPlayer, 'repeatmodechange');
            window.Events.off(this.attachedPlayer, 'playing');
            window.Events.off(this.attachedPlayer, 'pause');
            window.Events.off(this.attachedPlayer, 'playbackstop');
            window.Events.off(this.attachedPlayer, 'volumechange');
            window.Events.off(this.attachedPlayer, 'timeupdate');
            this.attachedPlayer = null;
        }

        if (window.playbackManager) {
            window.Events.off(window.playbackManager, 'playlistitemremove');
            window.Events.off(window.playbackManager, 'playlistitemadd');
            window.Events.off(window.playbackManager, 'playlistitemchange');
            window.Events.off(window.playbackManager, 'playbackstop');
        }

        console.log('SystemMedia: inputPlugin destroyed and cleaned up');
    }
}

window._inputPlugin = inputPlugin;
})();
