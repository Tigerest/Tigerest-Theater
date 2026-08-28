(function () {
    'use strict';

    const callSystem = (method, ...args) => window.api.system[method](...args);

    function getNativeDownloadId(rawUrl) {
        try {
            const url = new URL(rawUrl, window.location.href);
            const match = url.pathname.match(/\/(?:emby\/)?Items\/([^/]+)\/Download$/i)
                || url.pathname.match(/\/Videos\/([^/]+)\/[^/]+\/Subtitles\//i);
            return match ? decodeURIComponent(match[1]) : null;
        } catch (_) {
            return null;
        }
    }

    async function enqueueNativeDownload(rawUrl) {
        const itemId = getNativeDownloadId(rawUrl);
        if (!itemId) return;

        let item = null;
        let downloadUrl = rawUrl;
        try {
            if (window.ApiClient && typeof window.ApiClient.getItem === 'function') {
                item = await window.ApiClient.getItem(window.ApiClient.getCurrentUserId(), itemId);
            }

            if (item?.MediaType && typeof window.ApiClient.getPlaybackInfo === 'function') {
                const options = {
                    UserId: window.ApiClient.getCurrentUserId(),
                    EnableDirectPlay: true,
                    EnableDirectStream: true,
                    EnableTranscoding: false,
                    AutoOpenLiveStream: false,
                    MaxStreamingBitrate: 200000000,
                    StartTimeTicks: 0
                };
                const profile = window.NativeShell.AppHost.getDeviceProfile(item, options);
                const playbackInfo = await window.ApiClient.getPlaybackInfo(itemId, options, profile);
                const source = playbackInfo?.MediaSources?.find(mediaSource => mediaSource.SupportsDirectPlay && mediaSource.DirectStreamUrl);
                if (source) {
                    const serverAddress = window.ApiClient.serverAddress().replace(/\/+$/, '');
                    const directPath = source.DirectStreamUrl;
                    downloadUrl = /^https?:\/\//i.test(directPath)
                        ? directPath
                        : serverAddress + (directPath.startsWith('/emby/') ? directPath : `/emby${directPath.startsWith('/') ? '' : '/'}${directPath}`);
                }
            }
        } catch (_) {
            // The download can still proceed with a safe fallback name.
        }

        const container = item?.Container || item?.MediaSources?.[0]?.Container || 'media';
        const title = item?.Name || `Emby ${itemId}`;
        const fileName = item?.FileName || `${title}.${container}`;
        await window.NativeShell.downloadFile({
            url: downloadUrl,
            itemId,
            title,
            fileName
        });
        window.tigerestOpenOfflineLibrary();
    }

    // Emby 4.9 implements its Download command by dispatching a click on a
    // detached <a download> element.  Route those media URLs into the native
    // resumable/offline manager instead of Chromium's unmanaged download UI.
    const nativeAnchorDispatch = HTMLAnchorElement.prototype.dispatchEvent;
    if (!nativeAnchorDispatch.__tigerestDownloadHook) {
        const hookedAnchorDispatch = function(event) {
            if (event?.type === 'click' && getNativeDownloadId(this.href)) {
                enqueueNativeDownload(this.href).catch(() => {
                    console.error('Tigerest Theater: unable to start offline download');
                });
                return true;
            }
            return nativeAnchorDispatch.call(this, event);
        };
        hookedAnchorDispatch.__tigerestDownloadHook = true;
        HTMLAnchorElement.prototype.dispatchEvent = hookedAnchorDispatch;
    }

    function formatBytes(value) {
        const bytes = Number(value || 0);
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
    }

    async function playOffline(id, close) {
        const item = await callSystem('downloadInfo', id);
        if (!item || !item.localUrl) return;
        close();
        window.api.player.setVideoOnlyMode(true);
        window.api.player.load(item.localUrl, {
            autoplay: true,
            startMilliseconds: 0
        }, {
            type: 'video',
            title: item.title || item.fileName,
            metadata: { Name: item.title || item.fileName }
        }, null, null);
    }

    function createButton(text, handler, destructive) {
        const button = document.createElement('button');
        button.className = 'raised block emby-button';
        button.textContent = text;
        button.style.margin = '.35em';
        button.style.width = 'auto';
        if (destructive) button.style.background = '#b3261e';
        button.addEventListener('click', handler);
        return button;
    }

    async function openOfflineLibrary() {
        await window.apiPromise;
        document.getElementById('tigerestOfflineLibrary')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'tigerestOfflineLibrary';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', zIndex: '999999', overflow: 'auto',
            background: 'rgba(10,10,12,.97)', color: '#eee', padding: 'min(5vw,48px)',
            fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
        });
        const close = () => {
            overlay.remove();
            if (window.__tigerestOfflineRender === render) {
                window.__tigerestOfflineRender = null;
            }
        };

        const heading = document.createElement('h1');
        heading.textContent = '离线媒体';
        overlay.appendChild(heading);
        const hint = document.createElement('p');
        hint.textContent = '下载文件只保存在当前客户端用户目录中，不会修改服务器媒体。';
        overlay.appendChild(hint);

        const list = document.createElement('div');
        overlay.appendChild(list);
        overlay.appendChild(createButton('关闭', close));
        document.body.appendChild(overlay);

        const render = async supplied => {
            const items = supplied || await callSystem('downloads');
            list.replaceChildren();
            if (!items.length) {
                const empty = document.createElement('p');
                empty.textContent = '暂无离线媒体。请在 Emby 详情页使用下载按钮。';
                list.appendChild(empty);
                return;
            }

            for (const item of items) {
                const row = document.createElement('section');
                Object.assign(row.style, {
                    margin: '1em 0', padding: '1em', borderRadius: '10px', background: '#202126'
                });
                const title = document.createElement('h3');
                title.textContent = item.title || item.fileName;
                title.style.margin = '0 0 .5em';
                row.appendChild(title);

                const progress = document.createElement('div');
                const total = Number(item.total || -1);
                const received = Number(item.received || 0);
                progress.textContent = `${item.status} · ${formatBytes(received)}` +
                    (total > 0 ? ` / ${formatBytes(total)}` : '') +
                    (item.error ? ` · ${item.error}` : '');
                row.appendChild(progress);

                const controls = document.createElement('div');
                controls.style.marginTop = '.6em';
                if (item.status === 'completed') {
                    controls.appendChild(createButton('播放', () => playOffline(item.id, close)));
                } else if (item.status === 'downloading') {
                    controls.appendChild(createButton('暂停', () => window.api.system.pauseDownload(item.id)));
                } else if (item.status === 'paused') {
                    controls.appendChild(createButton('继续', () => window.api.system.resumeDownload(item.id)));
                }
                controls.appendChild(createButton('删除', () => window.api.system.removeDownload(item.id), true));
                row.appendChild(controls);
                list.appendChild(row);
            }
        };

        window.__tigerestOfflineRender = render;
        await render();
        const system = window.api.system;
        if (system.downloadsChanged && !system.__tigerestOfflineConnected) {
            system.__tigerestOfflineConnected = true;
            system.downloadsChanged.connect(items => {
                const activeRender = window.__tigerestOfflineRender;
                if (typeof activeRender === 'function') activeRender(items);
            });
        }

        // Very small files can finish between the initial render and signal
        // connection.  Refresh once after wiring the listener so their final
        // state and Play action are visible without reopening this overlay.
        setTimeout(() => {
            if (document.body.contains(overlay)) render();
        }, 500);
    }

    window.tigerestOpenOfflineLibrary = openOfflineLibrary;

    window.apiPromise.then(api => {
        if (api.player && api.player.stopped) {
            api.player.stopped.connect(() => api.player.setVideoOnlyMode(false));
        }
    });
})();
