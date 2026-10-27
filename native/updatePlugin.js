(function(global) {
    'use strict';
    if (global.TigerestUpdate || (global.jmpInfo?.capabilities?.selfUpdate === false && global.jmpInfo?.capabilities?.updateCheck !== true)) return;
    let api, started, state = {}, dialog, style, title, details, notes, progress, actions, entry, entryDot, observer;
    let disposed = false, autoInstall = false, installInFlight = false, detailsOpen = false, revision = 0;
    // The netdisk buttons stay folded under 备用下载 until asked for or a download fails.
    let backupOpen = false;
    // The startup prompt shows once per document, and only before the user starts doing something.
    let prompted = false, interacted = false;
    const touched = event => { if (event.isTrusted) interacted = true; };
    const touchEvents = ['pointerdown','keydown','touchstart'];
    function invoke(name, ...args) {
        return new Promise((resolve, reject) => {
            if (!api?.system?.[name]) { reject(new Error('此版本暂不支持更新操作')); return; }
            try {
                // Qt uses a callback; Android additionally returns a Promise.
                // Android's compatibility callback maps failures to false; its Promise is authoritative.
                let usesPromise = false;
                const result = api.system[name](...args, value => Promise.resolve().then(() => {
                    if (!usesPromise) resolve(value);
                }));
                if (result?.then) { usesPromise=true; result.then(resolve,reject); }
            } catch (error) { reject(error); }
        });
    }
    function element(tag, text) {
        const node = document.createElement(tag);
        if (text != null) node.textContent = text;
        return node;
    }
    function close() {
        detailsOpen = false; backupOpen = false;
        if (state.status === 'available') {
            state = {...state, deferred:true};
            invoke('deferAppUpdate').catch(() => {});
        }
        dialog?.close();
        mountEntry();
    }
    function createStyle() {
        if (style) return;
        style = element('style');
        style.textContent = `
          #tigerest-update-button { position:relative; display:inline-flex; align-items:center; justify-content:center; flex:0 0 40px; width:40px; height:44px; min-width:40px; margin:0 2px; padding:0; border:0; border-radius:50%; color:inherit; background:transparent; cursor:pointer; }
          #tigerest-update-button:hover { background:#ffffff14; }
          #tigerest-update-button:focus-visible { outline:2px solid #ffbe38; outline-offset:2px; }
          #tigerest-update-button svg { width:23px; height:23px; pointer-events:none; }
          #tigerest-update-button [data-update-dot] { position:absolute; top:7px; right:6px; width:7px; height:7px; border-radius:50%; background:#f14d58; box-shadow:0 0 0 2px #171717; pointer-events:none; }
          #tigerest-update-button [data-update-dot][hidden] { display:none; }
          #tigerest-update-button.tg-update-fallback { position:fixed; top:calc(8px + var(--tgs-safe-top,0px)); right:calc(8px + var(--tgs-safe-right,0px)); z-index:9990; color:#eceef2; background:#202020; }
          #tigerest-update-dialog { box-sizing:border-box; width:min(520px,calc(100% - 32px)); max-height:calc(100dvh - 32px); overflow:auto; padding:26px; border:1px solid #514732; border-radius:18px; background:#13161d; color:#eceef2; box-shadow:0 22px 80px #0009; font:15px/1.6 system-ui,sans-serif; color-scheme:dark; }
          #tigerest-update-dialog::backdrop { background:#0008; }
          #tigerest-update-dialog .tg-update-heading { display:flex; align-items:flex-start; gap:12px; margin-bottom:12px; }
          #tigerest-update-dialog h2 { flex:1; min-width:0; margin:0; font-size:22px; color:#ffc341; }
          #tigerest-update-dialog .tg-update-links { display:flex; flex-shrink:0; gap:4px; }
          #tigerest-update-dialog .tg-update-links a { display:inline-flex; align-items:center; justify-content:center; width:44px; height:44px; border-radius:9px; color:#adb3bf; text-decoration:none; transition:color .15s,background .15s; }
          #tigerest-update-dialog .tg-update-links a:hover { color:#ffc341; background:#ffffff0c; }
          #tigerest-update-dialog .tg-update-links a:focus-visible { outline:2px solid #ffc341; outline-offset:2px; }
          #tigerest-update-dialog .tg-update-links svg { width:23px; height:23px; pointer-events:none; }
          #tigerest-update-dialog p { white-space:pre-wrap; overflow-wrap:anywhere; margin:10px 0; }
          #tigerest-update-dialog pre { font:inherit; white-space:pre-wrap; overflow-wrap:anywhere; max-height:28vh; overflow:auto; color:#adb3bf; border-top:1px solid #ffffff15; padding-top:12px; }
          #tigerest-update-dialog progress { width:100%; height:9px; accent-color:#ffba27; }
          #tigerest-update-dialog .tg-update-actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:22px; }
          #tigerest-update-dialog button { font:inherit; min-height:44px; padding:9px 16px; border-radius:9px; border:1px solid #48505d; background:#242a35; color:#ecedf2; cursor:pointer; }
          #tigerest-update-dialog .tg-update-dismiss { display:flex; gap:inherit; }
          #tigerest-update-dialog .tg-update-backup { order:1; flex-basis:100%; display:flex; flex-wrap:wrap; align-items:center; gap:inherit; padding-top:12px; border-top:1px solid #ffffff15; }
          #tigerest-update-dialog .tg-update-backup span { flex-basis:100%; color:#adb3bf; font-size:.92em; }
          #tigerest-update-dialog .tg-update-backup[hidden] { display:none; }
          #tigerest-update-dialog .tg-update-actions > button:first-child { background:#ffba27; border-color:#ffba27; color:#17130a; font-weight:650; }
          #tigerest-update-dialog button:focus-visible { outline:2px solid #fff; outline-offset:3px; }
          #tigerest-update-dialog button:disabled { opacity:.5; cursor:wait; }
          @media(max-width:440px) { #tigerest-update-dialog { padding:20px; } #tigerest-update-dialog .tg-update-actions { gap:8px; } }
        `;
        document.head.appendChild(style);
    }
    function actionable() {
        if (!state.version || !['available','ready','error'].includes(state.status)) return false;
        if (state.status === 'error' && !(state.size > 0)) return false;
        // Native release selection is authoritative; reject stale/equal version snapshots too.
        // A fourth number marks a fix release (2.9.5.1); without one it is 0.
        const parts = value => /^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(value || ''))?.slice(1).map(part => Number(part || 0));
        const current=parts(state.currentVersion), next=parts(state.version);
        if (!current || !next) return state.version !== state.currentVersion;
        for (let index=0;index<4;index++) { if (next[index] !== current[index]) return next[index] > current[index]; }
        return false;
    }
    function mountEntry() {
        if (disposed || !api || !document.body || !document.head) return;
        createStyle();
        if (!entry) {
            entry=element('button'); entry.id='tigerest-update-button'; entry.type='button';
            entry.className='headerButton headerSectionItem paper-icon-button-light emby-button-focusscale';
            entry.setAttribute('aria-haspopup','dialog');
            entry.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>';
            entryDot=element('span'); entryDot.dataset.updateDot=''; entryDot.setAttribute('aria-hidden','true'); entry.appendChild(entryDot);
            entry.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();open();});
        }
        const anchor=document.getElementById('tigerest-mpv-settings-button')||document.querySelector('.headerUserButton');
        const header=anchor?.parentElement || document.querySelector('.skinHeader .headerRight, .headerTop .headerRight');
        if (header && entry.parentElement !== header) header.insertBefore(entry,anchor?.parentElement===header ? anchor : header.firstChild);
        if (!header && entry.parentElement !== document.body) document.body.appendChild(entry);
        entry.classList.toggle('tg-update-fallback',!header);
        entryDot.hidden=!actionable();
        const label=actionable() ? `客户端有新版本 ${state.version}，查看更新` : state.status==='downloading' ? '客户端更新正在下载，查看进度' : '客户端更新';
        entry.setAttribute('aria-label',label); entry.title=label;
        entry.setAttribute('aria-expanded',String(detailsOpen));
    }
    function observeHeader() {
        if (disposed || observer || !document.documentElement) return;
        observer=new MutationObserver(mountEntry);
        observer.observe(document.documentElement,{childList:true,subtree:true});
    }
    function create() {
        if (dialog) return;
        createStyle();
        dialog = element('dialog'); dialog.id = 'tigerest-update-dialog';
        title = element('h2'); title.id = 'tigerest-update-title';
        dialog.setAttribute('aria-labelledby', title.id);
        const heading = element('div'); heading.className = 'tg-update-heading';
        const links = element('nav'); links.className = 'tg-update-links'; links.setAttribute('aria-label','项目与作者');
        const destinations = [
            ['GitHub 项目','https://github.com/Tigerest/Tigerest-Theater','<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.29-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.09 1.15a10.74 10.74 0 0 1 5.62 0c2.15-1.45 3.1-1.15 3.1-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.27-5.14 5.55.4.35.76 1.03.76 2.08v3.11c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z"/></svg>'],
            ['B站主页','https://space.bilibili.com/12562485','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 2 3 4m7-4-3 4M7 20v2m10-2v2"/><rect x="2" y="6" width="20" height="14" rx="4"/><path d="m7 11 2 1m8-1-2 1m-5 4 2 1 2-1"/></svg>']
        ];
        for (const [label,url,icon] of destinations) {
            const link = element('a'); link.href=url; link.target='_blank'; link.rel='noopener noreferrer';
            link.title=label; link.setAttribute('aria-label',label); link.innerHTML=icon;
            link.addEventListener('click',event=>{
                if (api?.system?.openExternalUrl) { event.preventDefault(); api.system.openExternalUrl(url); }
            });
            links.appendChild(link);
        }
        heading.append(title,links);
        details = element('p'); details.setAttribute('role','status');
        notes = element('pre');
        progress = element('progress'); progress.max = 100; progress.setAttribute('aria-label','更新下载进度');
        actions = element('div'); actions.className = 'tg-update-actions';
        dialog.append(heading, details, progress, notes, actions); document.body.appendChild(dialog);
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    }
    function button(label, action, work, parent = actions) {
        const node = element('button',label); node.type='button'; node.dataset.updateAction=action;
        node.addEventListener('click',async () => {
            node.disabled = true;
            try { await work(); }
            catch (error) { autoInstall=false; receive({...state,status:'error',manual:true,error:error.message || '更新操作失败，请重试'}); }
            finally { node.disabled=false; }
        });
        parent.appendChild(node);
    }
    function install(automatic) {
        if (installInFlight) return Promise.resolve();
        installInFlight=true;
        return invoke('installAppUpdate',automatic).finally(()=>{installInFlight=false;});
    }
    function render() {
        if (disposed || !document.body) return;
        observeHeader(); mountEntry();
        const status = state.status;
        if (!detailsOpen) return;
        create();
        title.textContent = ({available:'发现新版本',checking:'检查更新',downloading:'正在下载更新',ready:'更新已准备好',installing:state.autoRestart?'正在安装更新':'正在打开安装程序',current:'检查完成',unpublished:'iPad / iPhone 版本发布情况',error:'更新未完成'})[status] || '客户端更新';
        const version = state.version ? `当前版本 ${state.currentVersion || '—'} → ${state.version}` : `当前版本 ${state.currentVersion || '—'}`;
        const percent = state.size>0 ? Math.min(100,Math.max(0,Math.round((state.received||0)*100/state.size))) : 0;
        const bytes = value => Number(value)>=1048576 ? `${(Number(value)/1048576).toFixed(1)} MB` : `${(Math.max(0,Number(value)||0)/1024).toFixed(1)} KB`;
        const transfer = `${bytes(state.received)} / ${bytes(state.size)}`;
        const message = state.checkOnly && !['checking','error'].includes(status) ? [state.message,state.status==='unpublished' && state.projectVersion ? `项目最新正式版 ${state.projectVersion}` : ''].filter(Boolean).join('\n') : status === 'current' ? '当前平台暂无可安装的新正式版。' :
            status === 'checking' ? '正在检查正式发布，请稍候…' :
            status === 'downloading' ? state.retrying ? `${transfer}。${state.retryDelay || 1} 秒后第 ${state.retryAttempt || 1}/${state.retryLimit || 5} 次自动重试${state.source?`（${state.source}）`:''}。${state.resumable?'已保留进度，将继续下载。':''}` :
                `已下载 ${percent}%（${transfer}）${percent===100?'，正在校验…':state.speed>0?` · ${bytes(state.speed)}/s`:''}${state.source && percent<100?` · 来源 ${state.source}`:''}` :
            status === 'installing' ? state.autoRestart ? '大河影院马上会自动关闭，装好后自动重新打开。如果出现系统权限提示，请选择「是」。' : '请按系统提示完成更新。取消后可再次安装。' :
            status === 'available' ? `${state.resumable?`已保留 ${transfer}，可继续下载。`:`大小约 ${(Number(state.size||0)/1048576).toFixed(1)} MB。`}下载校验完成后将${state.installLabel || '打开安装程序'}。` :
            status === 'error' && state.resumable ? `已保留 ${transfer}，重试会继续下载。` : '';
        // The build this client was made from, so a test package can be told apart.
        const build = typeof global.jmpInfo?.buildNumber === 'string' && global.jmpInfo.buildNumber ? `构建号 ${global.jmpInfo.buildNumber}` : '';
        details.textContent = [version,build,message,state.error].filter(Boolean).join('\n');
        notes.textContent = String(state.notes || '').slice(0,20000);
        notes.hidden = !notes.textContent || ['checking','current','downloading'].includes(status);
        progress.hidden = status !== 'downloading'; progress.value=percent;
        actions.replaceChildren();
        if (state.checkOnly && ['available','current','unpublished'].includes(status)) {
            button('查看发布说明','release',()=>invoke('openExternalUrl',state.releaseUrl));
        } else if (!state.checkOnly && (status === 'available' || status === 'error' && state.version && state.size>0)) {
            button(state.resumable?'继续下载':status==='error'?'重试下载':'直接下载','download',async()=>{autoInstall=true;await invoke('downloadAppUpdate');});
        } else if (status === 'ready' && !state.checkOnly) {
            button(state.installLabel || '安装更新','install',()=>install(false));
        } else if (status === 'error') {
            button('重新检查','check',()=>check());
        }
        if (status === 'downloading') button('暂停下载','cancel',()=>{autoInstall=false;return invoke('cancelAppUpdate');});
        const mirrors = !state.checkOnly && state.version && (status === 'available' || status === 'error' && state.size>0) ?
            [['夸克网盘','quark'],['百度网盘','baidu']].filter(([,key]) => /^https:\/\//.test(state.mirrors?.[key] || '')) : [];
        if (mirrors.length) {
            const backup = element('div'); backup.className = 'tg-update-backup'; backup.id = 'tigerest-update-backup'; backup.hidden = !backupOpen;
            backup.appendChild(element('span','直接下载不成功时，可从网盘下载安装包手动安装。'));
            const toggle = element('button','备用下载'); toggle.type = 'button'; toggle.dataset.updateAction = 'backup';
            toggle.setAttribute('aria-controls',backup.id); toggle.setAttribute('aria-expanded',String(backupOpen));
            toggle.addEventListener('click',() => { backupOpen = !backupOpen; backup.hidden = !backupOpen; toggle.setAttribute('aria-expanded',String(backupOpen)); });
            actions.append(toggle, backup);
            // Native code opens this version's folder in the share; older bridges open the share itself.
            for (const [label,key] of mirrors) button(label,key,()=>api.system.openAppUpdateMirror ? invoke('openAppUpdateMirror',key) : invoke('openExternalUrl',state.mirrors[key]),backup);
        }
        // Ignore and Later wrap together, so a narrow dialog keeps them on one row.
        const dismiss = status === 'available' ? element('span') : actions;
        if (status === 'available') {
            dismiss.className = 'tg-update-dismiss'; actions.appendChild(dismiss);
            button('忽略本次更新','skip',async()=>{autoInstall=false;await invoke('skipAppUpdate');state={...state,status:'idle',version:''};detailsOpen=false;dialog.close();mountEntry();},dismiss);
        }
        button(status==='available'?'稍后':status==='downloading'?'后台下载':'关闭','close',close,dismiss);
        if (!dialog.open) dialog.showModal();
    }
    function receive(next) {
        if (disposed || !next || typeof next !== 'object') return;
        if (next.status==='error' && state.status==='downloading') backupOpen=true;
        revision++; state=next;
        if (state.status==='error') autoInstall=false;
        if (!prompted && !state.checkOnly && !state.manual && !state.deferred && state.status==='available' && actionable()) {
            prompted=true;
            // A release remembered from last launch is ready before the user acts; a
            // check finishing later waits silently for the next launch instead.
            if (state.cached || !interacted) detailsOpen=true;
            else { state={...state,deferred:true}; invoke('deferAppUpdate').catch(()=>{}); }
        }
        render();
        if (!state.checkOnly && state.status==='ready' && !installInFlight && (autoInstall || state.installAfterDownload)) {
            autoInstall=false;
            install(true).catch(error=>receive({...state,status:'error',manual:true,error:error.message}));
        }
    }
    function start() {
        if (started) return started;
        started = Promise.resolve().then(()=>global.apiPromise || global.api).then(async value=>{
            if (disposed || !value?.system?.appUpdateState) return;
            api=value; api.system.appUpdateChanged?.connect(receive);
            const seen=revision, initial=await invoke('appUpdateState');
            if (revision===seen) receive(initial);
            // API readiness must not wait for a slow startup network check.
            // Its progress/results arrive through appUpdateChanged.
            invoke('checkForUpdates',false).catch(()=>{});
        }).catch(()=>{});
        return started;
    }
    async function check() {
        await start(); detailsOpen=true; autoInstall=false;
        receive({...state,status:'checking',manual:true,deferred:false,error:''});
        try { await invoke('checkForUpdates',true); }
        catch(error) { receive({...state,status:'error',version:'',size:0,notes:'',error:error.message || '无法检查更新，请重试'}); }
    }
    async function open() {
        await start();
        if (disposed) return;
        if (!['available','ready','downloading','installing','checking'].includes(state.status) && !actionable()) return check();
        detailsOpen=true; render();
    }
    function destroy() {
        disposed=true;autoInstall=false;api?.system?.appUpdateChanged?.disconnect(receive);
        for (const type of touchEvents) document.removeEventListener(type,touched,true);
        observer?.disconnect();entry?.remove();dialog?.remove();style?.remove();document.removeEventListener('DOMContentLoaded',render);
    }
    global.TigerestUpdate={start,check,open,close,destroy};
    global._updatePlugin=class { constructor() { this.name='Update Plugin';this.type='input';this.id='updatePlugin';start(); } };
    document.addEventListener('DOMContentLoaded',render,{once:true});
    for (const type of touchEvents) document.addEventListener(type,touched,{capture:true,passive:true});
    // Jellyfin's web client dispatches its own pagehide from view elements;
    // only the browser's pagehide for the document ends this page.
    const leave=event=>{if(!event.isTrusted||(event.target!==document&&event.target!==global))return;global.removeEventListener('pagehide',leave);destroy();};
    global.addEventListener('pagehide',leave);
    start();
})(window);
