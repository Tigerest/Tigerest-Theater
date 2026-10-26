// Local video files, played as a local player: no media server and no online
// service (danmaku, comments, watch together, playback progress). The native
// side gathers the files from the command line, a later launch ("Open with" in
// Explorer) or the file dialog; downloaded offline media plays the same way.
(function () {
    // Windows only for now; the Mac build adds its file handling separately.
    const available = () => !!(window.api?.system?.isWindows && window.api.system.chooseLocalFiles &&
        !window.tigerestAndroidApi && !window.tigerestIPadApi);
    let queue = [];
    let current = null;
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

    function load(entry) {
        current = entry;
        window.api.player.load(entry.url, {autoplay: true, startMilliseconds: 0}, {
            type: 'video',
            localPlayback: true,
            title: entry.title,
            metadata: {Name: entry.title}
        }, null, null);
    }

    function finish() {
        active = advancing = false;
        queue = [];
        current = null;
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

    async function play(entries) {
        if (!entries?.length) return;
        await window.apiPromise;
        await endServerPlayback();
        document.getElementById('tigerest-local-toast')?.remove();
        queue = entries.slice(1);
        active = true;
        advancing = false;
        if (!windowSession && window.api.window) {
            windowSession = true;
            window.api.window.beginPlaybackSession();
        }
        window.api.player.setVideoOnlyMode(true);
        load(entries[0]);
    }

    async function takeRequested() {
        const entries = await window.api.system.takeLocalFiles();
        if (entries?.length) await play(entries);
    }

    window.tigerestLocalPlayerAvailable = available;
    window.tigerestPlayLocalMedia = play;
    window.tigerestOpenLocalFiles = () => window.api.system.chooseLocalFiles();
    window.tigerestLocalPlaybackActive = () => active;

    window.apiPromise.then(api => {
        const player = api.player;
        if (player?.stopped) {
            player.finished.connect(() => { if (active) advancing = queue.length > 0; });
            player.stopped.connect(() => {
                if (!active) return;
                if (advancing) {
                    advancing = false;
                    load(queue.shift());
                } else {
                    finish();
                }
            });
            // A file mpv cannot open ends in an error, not a stop. mpv's own
            // message ("loading failed") says less than the file's name.
            player.error.connect(() => {
                if (!active) return;
                notify(current?.title ? `无法播放「${current.title}」。` : '无法播放这个文件。');
                if (queue.length) load(queue.shift());
                else finish();
            });
        }
        if (!api.system?.localFilesRequested) return;
        api.system.localFilesRequested.connect(takeRequested);
        takeRequested();
    });
})();
