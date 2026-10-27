// Local video files, played as a local player: no media server and no online
// service (danmaku, comments, watch together, playback progress). The native
// side gathers the files from the command line, a later launch ("Open with" in
// Explorer) or the file dialog; downloaded offline media plays the same way.
(function () {
    // The desktop clients: Windows and the Mac, which receives Finder's files itself.
    const available = () => !!((window.api?.system?.isWindows || window.api?.system?.isMacos) && window.api.system.chooseLocalFiles &&
        !window.tigerestAndroidApi && !window.tigerestIPadApi);
    // The files in play order and the one playing. uosc lists them through the
    // web player's queue property, so its list, previous and next come back
    // here: a file mpv opened by itself would bypass the local playback state.
    let entries = [];
    let index = -1;
    let active = false;
    let advancing = false;
    // Like the web player's: leaving playback restores the window state from
    // before it (fullscreen entered while playing ends with it).
    let windowSession = false;

    function notify(text) {
        document.getElementById('tigerest-local-toast')?.remove();
        const toast = document.createElement('div');
        toast.id = 'tigerest-local-toast';
        toast.setAttribute('role', 'alert');
        toast.textContent = text;
        Object.assign(toast.style, {
            position: 'fixed', left: '50%', bottom: '48px', transform: 'translateX(-50%)', zIndex: '2147483000',
            maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', padding: '12px 18px', borderRadius: '10px',
            background: 'rgba(22,21,19,.96)', color: '#ece7dd', border: '1px solid rgba(239,195,110,.32)',
            font: '14px/1.5 system-ui,"Microsoft YaHei",sans-serif', overflowWrap: 'anywhere'
        });
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
    }

    const itemPrefix = 'local-';
    const itemId = i => itemPrefix + i;

    function publishQueue() {
        const player = window.api.player;
        player.setWebPlaylist?.(entries.map((entry, i) => ({PlaylistItemId: itemId(i), Id: itemId(i), Name: entry.title})),
            index >= 0 ? itemId(index) : '');
        player.notifyQueueChange?.(index >= 0 && index < entries.length - 1, index > 0);
    }

    function load(i) {
        index = i;
        const entry = entries[i];
        publishQueue();
        window.api.player.load(entry.url, {autoplay: true, startMilliseconds: 0}, {
            type: 'video',
            localPlayback: true,
            title: entry.title,
            metadata: {Name: entry.title}
        }, null, null);
    }

    // An entry chosen in the uosc list, or the previous / next one.
    function select(i) {
        if (active && Number.isInteger(i) && i >= 0 && i < entries.length && i !== index) load(i);
    }

    function finish() {
        active = advancing = false;
        entries = [];
        index = -1;
        publishQueue();
        window.api.player.setVideoOnlyMode(false);
        if (windowSession) {
            windowSession = false;
            window.api.window?.endPlaybackSession();
        }
    }

    // The web client's own playback reports its stop to the server; it ends
    // before a local file replaces it, so no progress lands on that item.
    async function endServerPlayback() {
        if (active || !document.querySelector('.videoPlayerContainer')) return;
        const player = window.api.player;
        await new Promise(resolve => {
            const done = () => { clearTimeout(timer); player.stopped.disconnect(done); resolve(); };
            const timer = setTimeout(done, 3000);
            player.stopped.connect(done);
            player.stop();
        });
        for (let i = 0; i < 40 && document.querySelector('.videoPlayerContainer'); i++)
            await new Promise(resolve => setTimeout(resolve, 50));
    }

    async function play(list, start = 0) {
        if (!list?.length) return;
        await window.apiPromise;
        await endServerPlayback();
        document.getElementById('tigerest-local-toast')?.remove();
        entries = list.slice();
        active = true;
        advancing = false;
        if (!windowSession && window.api.window) {
            windowSession = true;
            window.api.window.beginPlaybackSession();
        }
        window.api.player.setVideoOnlyMode(true);
        load(Math.min(Math.max(0, Number(start) || 0), entries.length - 1));
    }

    async function takeRequested() {
        const request = await window.api.system.takeLocalFiles();
        if (request?.items?.length) await play(request.items, request.start);
    }

    window.tigerestLocalPlayerAvailable = available;
    window.tigerestPlayLocalMedia = play;
    window.tigerestOpenLocalFiles = () => window.api.system.chooseLocalFiles();
    window.tigerestLocalPlaybackActive = () => active;

    window.apiPromise.then(api => {
        const player = api.player;
        if (player?.stopped) {
            player.finished.connect(() => { if (active) advancing = index < entries.length - 1; });
            player.stopped.connect(() => {
                if (!active) return;
                if (advancing) {
                    advancing = false;
                    load(index + 1);
                } else {
                    finish();
                }
            });
            // A file mpv cannot open ends in an error, not a stop. mpv's own
            // message ("loading failed") says less than the file's name.
            player.error.connect(() => {
                if (!active) return;
                const title = entries[index]?.title;
                notify(title ? `无法播放「${title}」。` : '无法播放这个文件。');
                if (index < entries.length - 1) load(index + 1);
                else finish();
            });
        }
        // PlayerComponent turns a uosc list choice into "playlist-item:<id>";
        // media keys send previous / next.
        const choice = 'playlist-item:' + itemPrefix;
        api.input?.hostInput?.connect(actions => {
            for (const action of actions || []) {
                if (typeof action !== 'string') continue;
                if (action.startsWith(choice)) select(Number(action.slice(choice.length)));
                else if (action === 'next') select(index + 1);
                else if (action === 'previous') select(index - 1);
            }
        });
        if (!api.system?.localFilesRequested) return;
        api.system.localFilesRequested.connect(takeRequested);
        takeRequested();
    });
})();
