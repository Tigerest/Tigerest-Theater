(function () {
    let header, headerResize, headerChanges, frame, disposed=false, savedHeaderHeight=null;
    let actionsHost, more, menu, secondary=[];
    // The client menu holds server switching, so it stays on the compact row.
    const primary='#tigerest-message-entry,#tigerest-update-button,#tigerest-mpv-settings-button,.headerUserButton';
    const remainsPrimary=action=>action.matches(primary)||
        (window.TigerestServer?.isJellyfin?.()===true&&action.matches('.headerSyncButton'));
    function closeMenu() {
        if (menu?.open) menu.close();
        more?.setAttribute('aria-expanded','false');
    }
    function openMenu() {
        layoutActions(header);
        if (!actionsHost?.isConnected || !actionsHost.classList.contains('tgs-header-condensed')) return;
        if (!menu) {
            menu=document.createElement('dialog');menu.id='tigerest-header-menu';
            menu.setAttribute('aria-labelledby','tigerest-header-menu-title');
            menu.addEventListener('cancel',event=>{event.preventDefault();closeMenu();});
            menu.addEventListener('click',event=>{if(event.target===menu)closeMenu();});
            document.body.appendChild(menu);
        }
        menu.replaceChildren();
        const heading=document.createElement('h2');heading.id='tigerest-header-menu-title';heading.textContent='更多操作';menu.appendChild(heading);
        for (const action of secondary) {
            const entry=document.createElement('button');entry.type='button';
            entry.textContent=action.getAttribute('aria-label') || action.title || action.textContent.trim() || '操作';
            entry.disabled=Boolean(action.disabled || action.getAttribute('aria-disabled')==='true');
            entry.addEventListener('click',()=>{
                closeMenu();
                if(!action.isConnected||action.disabled||action.getAttribute('aria-disabled')==='true')return;
                const condensed=actionsHost?.classList.contains('tgs-header-condensed');
                actionsHost?.classList.remove('tgs-header-condensed');
                const visible=Boolean(action.getClientRects().length)&&!action.hidden&&action.getAttribute('aria-hidden')!=='true';
                if(condensed)actionsHost.classList.add('tgs-header-condensed');
                if(visible)action.click();
            });
            menu.appendChild(entry);
        }
        const close=document.createElement('button');close.type='button';close.textContent='关闭';close.addEventListener('click',closeMenu);menu.appendChild(close);
        more.setAttribute('aria-expanded','true');menu.showModal();
    }
    function layoutActions(next) {
        const host=next?.matches('.headerRight')?next:next?.querySelector('.headerRight');
        if (host!==actionsHost) {
            closeMenu();actionsHost?.classList.remove('tgs-header-condensed');more?.remove();actionsHost=host;more=null;
        }
        if (!host) return;
        // The expanded toolbar uses the server's layout unchanged. Avoid
        // un-hiding and measuring every action during page entrance/layout.
        if (!matchMedia('(max-width:600px)').matches) {
            host.classList.remove('tgs-header-condensed');
            if (more) more.hidden=true;
            closeMenu();
            return;
        }
        // Emby can replace its header with cloned markup; cloned entries have no handlers.
        for (const stale of host.querySelectorAll('#tigerest-header-more')) if(stale!==more)stale.remove();
        if (!more) {
            more=document.createElement('button');more.id='tigerest-header-more';more.type='button';
            more.className='headerButton headerSectionItem paper-icon-button-light';more.textContent='⋯';
            more.setAttribute('aria-label','更多操作');more.setAttribute('aria-haspopup','dialog');more.hidden=true;
            more.addEventListener('click',openMenu);host.appendChild(more);
        }
        const condensed=host.classList.contains('tgs-header-condensed');
        host.classList.remove('tgs-header-condensed');more.hidden=true;
        const actions=[...host.children].filter(action=>action!==more&&action.getClientRects().length&&!action.hidden&&action.getAttribute('aria-hidden')!=='true');
        secondary=actions.filter(action=>!remainsPrimary(action));
        const css=getComputedStyle(host),gap=parseFloat(css.columnGap)||0;
        const width=actions.reduce((sum,action)=>{const style=getComputedStyle(action);return sum+action.getBoundingClientRect().width+(parseFloat(style.marginLeft)||0)+(parseFloat(style.marginRight)||0);},0)+Math.max(0,actions.length-1)*gap;
        const available=host.clientWidth-(parseFloat(css.paddingLeft)||0)-(parseFloat(css.paddingRight)||0);
        const compact=matchMedia('(max-width:600px)').matches&&secondary.length>0&&width>available+1;
        for (const action of host.children) action.classList.toggle('tgs-header-secondary',secondary.includes(action));
        host.classList.toggle('tgs-header-condensed',compact);more.hidden=!compact;
        if (!compact || compact!==condensed) closeMenu();
    }
    function restoreHeaderHeight() {
        if (savedHeaderHeight === null) return;
        const root=document.documentElement;
        if (savedHeaderHeight.value) root.style.setProperty('--header-height',savedHeaderHeight.value,savedHeaderHeight.priority);
        else root.style.removeProperty('--header-height');
        savedHeaderHeight=null;
    }
    function measureHeader() {
        frame=null;
        if (disposed || !document.documentElement) return;
        const next=document.querySelector('.skinHeader');
        layoutActions(next);
        if (next !== header) {
            headerResize?.disconnect(); header=next;
            if (header && window.ResizeObserver) {
                headerResize=new ResizeObserver(scheduleHeaderMeasure);
                headerResize.observe(header);
            }
        }
        if (!header || !matchMedia('(max-width:600px)').matches) { restoreHeaderHeight(); return; }
        const height=Math.ceil(header.getBoundingClientRect().height);
        if (!height) return;
        const root=document.documentElement;
        if (savedHeaderHeight === null) savedHeaderHeight={value:root.style.getPropertyValue('--header-height'),priority:root.style.getPropertyPriority('--header-height')};
        const value=height+'px';
        if (root.style.getPropertyValue('--header-height') !== value) root.style.setProperty('--header-height',value);
    }
    function scheduleHeaderMeasure() {
        if (!disposed && !frame) frame=requestAnimationFrame(measureHeader);
    }
    function apply() {
        if (!document.documentElement || !document.head) return;
        let viewport = document.querySelector('meta[name="viewport"]');
        if (!viewport) {
            viewport = document.createElement('meta'); viewport.name = 'viewport';
            viewport.content = 'width=device-width,initial-scale=1'; document.head.appendChild(viewport);
        }
        if (!/viewport-fit\s*=\s*cover/i.test(viewport.content)) {
            viewport.content = viewport.content.replace(/,?\s*viewport-fit\s*=\s*[^,]+/ig, '') + ',viewport-fit=cover';
        }
        const safe = window.tigerestWindowMetrics?.safeInsets || {};
        for (const edge of ['top', 'right', 'bottom', 'left']) {
            document.documentElement.style.setProperty('--tgs-safe-' + edge, (safe[edge] || 0) + 'px');
        }
        document.documentElement.dataset.tigerestWindow = innerWidth < 600 ? 'compact' : innerWidth < 840 ? 'medium' : 'expanded';
        if (!headerChanges) {
            const withoutOwnClasses=value=>String(value||'').split(/\s+/).filter(name=>name&&!name.startsWith('tgs-header-')).sort().join(' ');
            headerChanges=new MutationObserver(records=>{
                let changed=false;
                for(const record of records){
                    if(record.type==='childList'){
                        // Poster walls and frozen scenes can add thousands of
                        // nodes. Only changes to the toolbar (or its replacement)
                        // require removing condensed styles and measuring it.
                        const headerNode=node=>node.nodeType===1 &&
                            (node===header || node.contains(header) || node.matches('.skinHeader') || node.querySelector('.skinHeader'));
                        if(header?.contains(record.target) || [...record.addedNodes,...record.removedNodes].some(headerNode)) changed=true;
                        continue;
                    }
                    if(!header?.contains(record.target)||record.target===more)continue;
                    if(record.attributeName==='class'&&withoutOwnClasses(record.oldValue)===withoutOwnClasses(record.target.className))continue;
                    const overflowAction=secondary.includes(record.target)||
                        record.target.closest?.('.tgs-header-secondary')?.parentElement===actionsHost;
                    if(menu?.hasAttribute('open')&&overflowAction)closeMenu();
                    changed=true;
                }
                if(changed)scheduleHeaderMeasure();
            });
            headerChanges.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeOldValue:true,attributeFilter:['class','style','hidden','aria-hidden','disabled','aria-label','title']});
        }
        scheduleHeaderMeasure();
    }
    window.addEventListener('tigerest-window-changed', apply);
    window.addEventListener('tigerest-server-kind', apply);
    window.addEventListener('resize', apply);
    document.addEventListener('DOMContentLoaded', apply);
    // Jellyfin's web client dispatches its own pagehide from view elements;
    // only the browser's pagehide for the document ends this page.
    const leave = event => {
        if (!event.isTrusted || (event.target !== document && event.target !== window)) return;
        window.removeEventListener('pagehide', leave);
        closeMenu();menu?.remove();more?.remove();actionsHost?.classList.remove('tgs-header-condensed');
        disposed=true; headerResize?.disconnect(); headerChanges?.disconnect();
        cancelAnimationFrame(frame); restoreHeaderHeight();
        window.removeEventListener('tigerest-window-changed',apply);
        window.removeEventListener('tigerest-server-kind',apply);
        window.removeEventListener('resize',apply);
    };
    window.addEventListener('pagehide', leave);
    if (document.readyState !== 'loading') apply();
})();
