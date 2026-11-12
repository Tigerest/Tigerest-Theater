(function () {
    'use strict';
    const styleId = 'tigerest-home-gallery-style';
    const identity = api => api ? [api.serverAddress(), api.serverId(), api.getCurrentUserId()].join('|') : '';
    function reveal(list, item) {
        const frame = list.getBoundingClientRect(), box = item.getBoundingClientRect();
        if (box.top < frame.top) list.scrollTop += box.top - frame.top;
        else if (box.bottom > frame.bottom) list.scrollTop += box.bottom - frame.bottom;
        if (box.left < frame.left) list.scrollLeft += box.left - frame.left;
        else if (box.right > frame.right) list.scrollLeft += box.right - frame.right;
    }
    // Animations running on the host or its ancestors, such as a page entrance,
    // move it by transforms that getBoundingClientRect includes. Return the top
    // where it settles: undo their translate and scale, outermost first. Static
    // transforms stay; settle() receives each animation to measure again after.
    function settledTop(node, settle) {
        const moving = [];
        let exact = true;
        for (let element = node; element; element = element.parentElement) {
            const running = (element.getAnimations?.() || []).filter(animation => animation.playState !== 'finished');
            running.forEach(settle);
            if (!running.some(animation => animation.effect?.getKeyframes?.().some(frame => 'transform' in frame))) continue;
            const style = getComputedStyle(element);
            if (style.transform === 'none') continue;
            const matrix = new DOMMatrixReadOnly(style.transform);
            if (matrix.b || matrix.m14 || matrix.m24 || matrix.m34 || !(matrix.d > 0)) exact = false;
            else moving.unshift({element, scale: matrix.d, shift: matrix.f, origin: parseFloat(style.transformOrigin.split(' ')[1]) || 0});
        }
        let undo = top => top;
        if (exact) for (const {element, scale, shift, origin} of moving) {
            const outer = undo, start = outer(element.getBoundingClientRect().top) - shift - origin * (1 - scale);
            undo = top => start + origin + (outer(top) - start - origin - shift) / scale;
        }
        return undo(node.getBoundingClientRect().top);
    }
    const css = `
    body.tg-home-active .skinHeader, body.tg-home-active .mainDrawer, body.tg-home-active .appFooter, body.tg-home-active .appfooter { display: none !important; }
    body.tg-home-active .view-home-home { left: 0 !important; right: 0 !important; width: 100% !important; margin: 0 !important; padding: 0 !important; }
    .tg-home-host { overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
    /* Emby 4.8 hosts the home in a flex row, where it would shrink to its content. */
    .tg-home { --home-height: 650px; --home-safe-height: calc(var(--tgs-safe-top,0px) + var(--tgs-safe-bottom,0px)); box-sizing: border-box; width: 100%; height: var(--home-height); min-height: calc(380px + var(--home-safe-height)); padding: 18px 28px 22px;
        display: grid; grid-template-columns: clamp(160px,19vw,280px) minmax(0,1fr); grid-template-rows: minmax(0,1fr) 158px;
        gap: 20px 24px; position: relative; isolation: isolate; overflow: hidden; color: #f4f2ed; text-align: left; }
    .tg-home *, .tg-home *::before, .tg-home *::after { box-sizing: border-box; }
    .tg-home button { font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
    .tg-home button:focus-visible { outline: 2px solid #efc36e; outline-offset: -4px; }
    .tg-home-nav { grid-column: 1; grid-row: 1 / 3; display: flex; flex-direction: column; gap: 12px; min-height: 0; min-width: 0; }
    .tg-home-nav-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: 0 0 auto; }
    .tg-home-nav-heading .tg-home-eyebrow { min-width: 0; margin: 0; line-height: 1.5; }
    .tg-home-eyebrow > span { display: inline-block; white-space: nowrap; }
    .tg-home-eyebrow { font-size: 10px; letter-spacing: .2em; color: #afa89e; margin: 0 0 2px; padding-left: 4px; text-transform: uppercase; }
    .tg-library-list { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; padding: 3px; }
    .tg-library { position: relative; flex: 0 0 auto; width: 100%; height: clamp(92px,calc((var(--home-height) - 98px)/4),178px); border: 1px solid #ffffff16;
        border-radius: 16px; overflow: hidden; background: #1d2129; text-align: left; padding: 16px 18px; transition: border-color .25s, box-shadow .25s, transform .25s; }
    .tg-library img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .7; transition: transform .65s, opacity .3s; pointer-events: none; }
    .tg-library::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg,#070b11b8,#0b0e1430),linear-gradient(0deg,#0a0c1280,transparent 65%); pointer-events: none; }
    .tg-library:hover img, .tg-library.is-selected img { transform: scale(1.05); opacity: .95; }
    .tg-library:hover, .tg-library.is-selected { border-color: #e8b85eac; box-shadow: inset 0 0 0 1px #e8b85e25,0 6px 24px #0003; }
    .tg-library-label { position: relative; z-index: 1; display: flex; height: 100%; flex-direction: column; justify-content: center; }
    .tg-library-name { font-size: clamp(18px,2vw,30px); font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; text-shadow: 0 2px 12px #0008; }
    .tg-library-index { font-size: 10px; letter-spacing: .13em; margin-top: 7px; color: #ded8c9af; }
    .tg-library.is-selected .tg-library-index { color: #f0c879; }
    .tg-home-stage { grid-column: 2; grid-row: 1; position: relative; min-width: 0; min-height: 0; overflow: hidden; border-radius: 22px; background: #171a21; }
    .tg-home-hero { position: absolute; inset: 0; border: 0; border-radius: inherit; width: 100%; height: 100%; overflow: hidden;
        background: radial-gradient(ellipse at 75% 30%,#3e394b,#151920 70%); text-align: left; padding: 0; opacity: 0;
        transition: opacity .35s ease; }
    .tg-entered.tg-ready .tg-home-hero { opacity: 1; }
    .tg-hero-images { position: absolute; inset: 0; opacity: 0; transform: translate3d(0,28px,0) scale(1.2); transform-origin: 65% 40%; transition: opacity .9s ease,transform 1.6s cubic-bezier(.14,.75,.2,1); }
    .tg-entered.tg-ready .tg-hero-images { opacity: 1; transform: none; }
    .tg-home-hero:disabled { cursor: default; }
    .tg-poster-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transform: scale(1.035); transition: opacity .6s,transform 6.5s linear; }
    .tg-poster-image.is-visible { opacity: 1; transform: scale(1); }
    .tg-hero-shade { position: absolute; inset: 0; background: linear-gradient(0deg,#080a10f5, #080a1080 25%,transparent 67%),linear-gradient(90deg,#080a1030,transparent 75%); }
    .tg-hero-copy { position: absolute; left: clamp(20px,3vw,48px); right: 36px; bottom: 34px; display: grid; grid-template-columns: minmax(0,1.3fr) minmax(0,1fr); gap: clamp(24px,4vw,90px); align-items: end; }
    .tg-hero-copy.tg-no-overview { grid-template-columns: minmax(0,1fr); }
    .tg-hero-content { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
    .tg-hero-content > *, .tg-hero-overview { opacity: 0; }
    .tg-text-ready .tg-hero-content > *, .tg-text-ready .tg-hero-overview { opacity: 1; }
    .tg-hero-overview { margin: 0 0 5px; color: #dedbd5; font-size: clamp(13px,.8vw,17px); line-height: 1.85; text-shadow: 0 2px 8px #000a; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .tg-hero-overview[hidden] { display: none; }
    @media (max-width:1000px) { .tg-hero-copy { grid-template-columns: minmax(0,1fr); gap: 12px; }.tg-hero-overview { font-size: 12px; line-height: 1.65; -webkit-line-clamp: 2; } }
    .tg-hero-kicker { font-size: 11px; letter-spacing: .13em; color: #f5d99a; }
    .tg-hero-title { font-size: clamp(24px,3.1vw,48px); font-weight: 650; line-height: 1.18; max-width: 1000px; text-shadow: 0 3px 20px #0009; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .tg-hero-subtitle { color: #d8d6d0; font-size: 13px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
    .tg-hero-action { font-size: 12px; margin-top: 5px; color: #fff; }
    .tg-hero-action::after { content: ' ↗'; color: #f0c879; margin-left: 4px; }
    .tg-home-status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 16px; padding: 24px; color: #c7c4bc; text-align: center; }
    .tg-home-status[hidden] { display: none; }
    .tg-home-retry { background: #343437; border: 1px solid #ffffff30; border-radius: 30px; padding: 9px 24px; }
    .tg-home-rail { grid-column: 2; grid-row: 2; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
    .tg-rail-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; height: 19px; padding: 0 3px; }
    .tg-rail-title { font-size: 13px; font-weight: 600; letter-spacing: .04em; }
    .tg-rail-counter { color: #b8afa0; font-size: 11px; font-variant-numeric: tabular-nums; }
    .tg-cover-list { display: flex; gap: 12px; overflow-x: auto; overflow-y: hidden; min-height: 0; padding: 3px 3px 8px; scrollbar-width: thin; scroll-snap-type: x proximity; }
    .tg-cover { position: relative; flex: 0 0 clamp(145px,15vw,236px); height: 112px; border: 1px solid #ffffff16; border-radius: 12px; padding: 0; overflow: hidden;
        background: #252730; text-align: left; scroll-snap-align: start; transition: border-color .2s,opacity .2s; }
    .tg-cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: transform .4s; }
    .tg-cover:hover img { transform: scale(1.05); }
    .tg-cover::after { content: ''; position: absolute; inset: 0; background: linear-gradient(0deg,#0b0c12ec,transparent 80%); pointer-events: none; }
    .tg-cover.is-selected { border-color: #e9bd63; box-shadow: inset 0 0 0 1px #e9bd6380; }
    .tg-cover.is-selected::before { content: ''; z-index: 2; position: absolute; left: 12px; right: 12px; bottom: 0; height: 3px; background: #edc471; border-radius: 3px; }
    .tg-cover-label { z-index: 1; position: absolute; left: 12px; right: 12px; bottom: 12px; font-size: 12px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    @media (max-width: 680px) {
        .tg-home { padding: 10px 14px 20px; min-height: 490px; grid-template-columns: minmax(0,1fr); grid-template-rows: 105px minmax(220px,1fr) 144px; gap: 14px; }
        .tg-home-nav { grid-column: 1; grid-row: 1; gap: 5px; }
        .tg-home-eyebrow { font-size: 9px; }
        .tg-library-list { flex-direction: row; overflow-y: hidden; overflow-x: auto; gap: 9px; padding: 2px 2px 5px; }
        .tg-library { width: 144px; height: 78px; border-radius: 12px; padding: 10px 12px; }
        .tg-library-name { font-size: 18px; }
        .tg-library-index { font-size: 8px; margin-top: 4px; }
        .tg-home-stage { grid-column: 1; grid-row: 2; border-radius: 16px; }
        .tg-home-rail { grid-column: 1; grid-row: 3; }
        .tg-hero-copy { left: 20px; right: 20px; bottom: 24px; }
        .tg-hero-title { font-size: 27px; }
        .tg-hero-subtitle { font-size: 11px; }
        .tg-cover { height: 100px; flex-basis: 160px; }
    }
    @media (min-width: 681px) and (max-height: 520px) {
        .tg-home { min-height: calc(320px + var(--home-safe-height)); padding: 8px 20px 14px; grid-template-rows: minmax(140px,1fr) 116px; gap: 12px 16px; }
        .tg-library { height: 84px; padding: 10px 14px; }
        .tg-library-name { font-size: 18px; }
        .tg-cover { height: 78px; }
        .tg-hero-copy { bottom: 18px; gap: 8px; }.tg-hero-content { gap: 6px; }
        .tg-hero-title { font-size: 24px; }
        .tg-hero-action { display: none; }
    }
    @media (prefers-reduced-motion: reduce) { .tg-home *, .tg-home *::before { animation: none !important; transition: none !important; transform: none !important; } }
    /* A continuous cinema composition, with navigation floating over its atmosphere. */
    /* The host/background fills the window; the composition keeps its normal gutters beyond Android system insets. */
    .tg-home { padding: calc(10px + var(--tgs-safe-top,0px)) calc(24px + var(--tgs-safe-right,0px)) calc(24px + var(--tgs-safe-bottom,0px)) calc(24px + var(--tgs-safe-left,0px)); gap: 22px 34px; grid-template-columns: clamp(160px,18vw,380px) minmax(0,1fr); grid-template-rows: minmax(0,1fr) 196px;
        background: linear-gradient(90deg,#0b0d12eb, #0b0d1200 45%); }
    .tg-home-scenery { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .16; z-index: -2; pointer-events: none;
        mask-image: linear-gradient(0deg,transparent,#000 35%,#000 80%,transparent); transition: opacity .8s; }
    .tg-home-scenery.tg-pending { opacity: 0; }
    .tg-home::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: radial-gradient(ellipse at 80% 5%,#87705512,transparent 55%); }
    .tg-home-nav { gap: 16px; transform-origin: 50% 40px; }
    .tg-library-list { gap: 14px; scrollbar-width: none; }
    .tg-library-list::-webkit-scrollbar { display: none; }
    .tg-library { border-radius: 6px 22px 6px 6px; border-color: #ffffff08; padding: 18px 22px; background: #11141b; height: clamp(92px,calc((var(--home-height) - 106px)/4),320px); }
    .tg-library img { opacity: .5; filter: saturate(.6); transform: scale(1.04); }
    .tg-library:hover img, .tg-library.is-selected img { opacity: 1; filter: saturate(1.1); transform: scale(1.13); }
    .tg-library-label { transition: transform .35s cubic-bezier(.2,.8,.2,1); }
    .tg-library.is-selected .tg-library-label { transform: translateX(5px); }
    .tg-library-name { font-size: clamp(22px,2.2vw,34px); font-weight: 750; letter-spacing: .025em; }
    .tg-library::before { content: ''; position: absolute; left: 0; top: 20%; bottom: 20%; width: 3px; z-index: 3; background: #f0c879; transform: scaleY(0); transition: transform .35s; }
    .tg-library.is-selected::before { transform: scaleY(1); }
    .tg-library.is-selected { border-color: #cda76875; box-shadow: 0 12px 35px #0006; }
    .tg-home-stage { border-radius: 8px 8px 0 0; background: transparent; }
    .tg-home-hero { background: radial-gradient(ellipse at 75% 30%,#34334170,#12141a00 75%); }
    .tg-poster-image { mask-image: linear-gradient(0deg,transparent,#000 20%,#000 96%); transform: scale(1.08); transition: opacity .65s,transform 8s linear; }
    .tg-hero-shade { background: linear-gradient(0deg,#0b0d12,#0b0d12b0 20%,transparent 60%),linear-gradient(90deg,#0b0d1240,transparent 65%); }
    .tg-hero-copy { left: clamp(22px,3.2vw,50px); right: 42px; bottom: 34px; }.tg-hero-content { gap: 12px; }
    .tg-hero-title { font-size: clamp(30px,4.1vw,68px); font-weight: 750; letter-spacing: -.025em; line-height: 1.18; }
    .tg-hero-kicker { font-size: 11px; letter-spacing: .16em; }
    .tg-hero-subtitle { font-size: 13px; color: #bcbab3; }
    .tg-hero-action { display: inline-flex; align-self: flex-start; align-items: center; margin-top: 10px; padding: 10px 18px; border: 1px solid #ffffff38; border-radius: 4px; background: #ffffff08; font-size: 12px; }
    .tg-hero-ordinal { position: absolute; top: 25px; right: 28px; color: #f5eee0b0; font-size: 11px; letter-spacing: .15em; border-top: 1px solid #f5eee070; padding-top: 8px; }
    .tg-home-rail { gap: 13px; padding-top: 8px; border-top: 1px solid #ffffff18; }
    .tg-rail-title { font-size: 12px; color: #d9d2c6; }
    .tg-cover-list { gap: 15px; scrollbar-width: none; }
    .tg-cover-list::-webkit-scrollbar { display: none; }
    .tg-cover { height: 116px; border-radius: 5px; border-color: #ffffff13; flex-basis: clamp(170px,17vw,270px); }
    .tg-cover.is-selected { border-color: #d9b273; box-shadow: 0 0 22px #c7a56d18; }
    .tg-cover-label { font-size: 12px; }
    @media (max-width:680px) {
        .tg-home { padding: calc(10px + var(--tgs-safe-top,0px)) calc(12px + var(--tgs-safe-right,0px)) calc(18px + var(--tgs-safe-bottom,0px)) calc(12px + var(--tgs-safe-left,0px)); min-height: calc(533px + var(--home-safe-height)); grid-template-columns: minmax(0,1fr); grid-template-rows: max-content minmax(220px,1fr) 154px; gap: 13px; }
        .tg-home.tg-home-has-window-control { min-height: calc(565px + var(--home-safe-height)); }
        .tg-home-nav { gap: 5px; }.tg-library-list { gap: 10px; }.tg-library { height: 78px; width: 146px; padding: 10px 12px; border-radius: 4px 14px 4px 4px; }
        .tg-library-name { font-size: 19px; }.tg-library.is-selected .tg-library-label { transform: none; }
        .tg-hero-copy { left: 18px; right: 18px; bottom: 20px; gap: 10px; }.tg-hero-content { gap: 9px; }.tg-hero-title { font-size: 32px; }.tg-hero-subtitle { font-size: 11px; }
        .tg-hero-action { padding: 8px 12px; font-size: 11px; margin-top: 6px; }.tg-hero-ordinal { top: 18px; right: 18px; font-size: 9px; }
        .tg-home-rail { padding-top: 8px; gap: 8px; }.tg-cover { height: 96px; flex-basis: 170px; }
    }
    @media (max-width:680px) and (max-height:600px) {
        .tg-hero-copy { bottom: 16px; gap: 8px; }.tg-hero-content { gap: 8px; }.tg-hero-title { font-size: 26px; }
        .tg-hero-kicker, .tg-hero-action { display: none; }
    }
    @media (min-width:681px) and (max-height:520px) {
        .tg-home { padding: calc(8px + var(--tgs-safe-top,0px)) calc(20px + var(--tgs-safe-right,0px)) calc(14px + var(--tgs-safe-bottom,0px)) calc(20px + var(--tgs-safe-left,0px)); grid-template-rows: minmax(140px,1fr) 128px; gap: 12px 20px; }
        .tg-library { height: 84px; padding: 10px 14px; }.tg-library-name { font-size: 19px; }.tg-cover { height: 74px; }
        .tg-home-rail { padding-top: 6px; gap: 8px; }.tg-hero-copy { bottom: 18px; gap: 8px; }.tg-hero-content { gap: 6px; }.tg-hero-title { font-size: 27px; }.tg-hero-action { display:none; }
        .tg-hero-overview { -webkit-line-clamp: 1; font-size: 11px; }
        .tg-hero-kicker { display: none; }
    }
    .tg-rail-heading { height: 28px; }
    .tg-rail-title { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tg-rail-counter { flex: 0 0 auto; }
    .tg-home[data-style="cinema"] .tg-cover { height: 130px; flex-basis: 88px; }
    .tg-home[data-style="cinema"] .tg-cover-label { font-size: 10px; left: 8px; right: 8px; bottom: 10px; }
    .tg-cover-label { display: block; }
    .tg-cover-name { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .tg-watch-badge { position: absolute; top: 7px; right: 6px; z-index: 3; width: 8px; height: 8px; border-radius: 50%; background: #e03c4a; }
    .tg-watch-progress { display: block; margin-top: 4px; color: #f2d6a0; font-size: 9px; line-height: 1.35; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .tg-home-more { margin-left: auto; padding: 4px 6px; border: 0; background: transparent; color: #e5ca91 !important; font-size: 11px !important; white-space: nowrap; }
    .tg-rail-heading { gap: 12px; }
    .tg-resume-progress { position: absolute; left: 4px; right: 4px; bottom: 3px; height: 2px; z-index: 3; background: #ffffff38; }
    .tg-resume-progress > i { display: block; height: 100%; background: #e4c376; }
    @media (max-width:680px) {
        .tg-rail-counter { display: none; }
        .tg-home[data-style="cinema"] .tg-cover { height: 98px; flex-basis: 70px; }
    }
    @media (min-width:681px) and (max-height:520px) {
        .tg-home[data-style="cinema"] .tg-cover { height: 76px; flex-basis: 88px; }
        .tg-home[data-style="cinema"] .tg-cover-name { -webkit-line-clamp: 1; }
        .tg-home[data-style="cinema"] .tg-cover-label { bottom: 7px; }
        .tg-home[data-style="cinema"] .tg-watch-badge { top: 4px; }
    }
    `;
    function element(tag, className, text) {
        const node = document.createElement(tag); node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }
    function watchProgress(card) {
        const state = card.watchState;
        return state && Number.isInteger(state.played) && Number.isInteger(state.total) && state.total > 0
            ? '观看进度：' + state.played + '/' + state.total : '';
    }
    function watchDescription(card) {
        return [card.watchState?.unwatched === true ? '未看' : '', watchProgress(card)].filter(Boolean).join('，');
    }
    function subtitle(card) {
        const episode = card.latestEpisode;
        return [watchProgress(card), card.item.ProductionYear, episode ? (card.newEpisode === episode ? '新一集未看' : '最新入库') + ' · S' + (episode.ParentIndexNumber || 1) + ':E' + (episode.IndexNumber || '?') + ' ' + (episode.Name || '') : '', card.addedAt ? '入库 ' + card.addedAt.slice(0, 10) : ''].filter(Boolean).join('  ·  ');
    }
    // Fades one layer in at a time above the layers already shown and removes
    // those once it covers them. A layer that loads during a fade waits for it
    // to end, and a newer layer replaces one that has not begun to show, so
    // however fast the selection changes at most two layers are ever visible.
    function Crossfade(show) { this.show = show; this.reset(); }
    Crossfade.prototype.reset = function () { this.next = this.fading = null; this.ready = false; };
    Crossfade.prototype.queue = function (node) { this.next?.remove(); this.next = node; this.ready = false; };
    Crossfade.prototype.loading = function (node) { return node === this.next && !this.ready; };
    Crossfade.prototype.loaded = function (node) {
        if (node !== this.next) return;
        this.ready = true;
        if (!this.fading) this.advance();
        // The layer fading in is no longer the one wanted: finish it quickly.
        else this.fading.getAnimations?.().forEach(animation => { if (animation.transitionProperty === 'opacity') animation.playbackRate = 3; });
    };
    Crossfade.prototype.advance = function () {
        const node = this.fading = this.next; this.next = null; this.ready = false;
        requestAnimationFrame(() => {
            if (this.fading !== node) return;
            // A layer styled for the first time in this frame would appear without fading.
            void getComputedStyle(node).opacity; this.show(node);
            const fades = node.getAnimations ? node.getAnimations().filter(animation => animation.transitionProperty === 'opacity').map(animation => animation.finished)
                : [new Promise(resolve => setTimeout(resolve, 900))];
            Promise.allSettled(fades).then(() => {
                if (this.fading !== node) return;
                for (let prior = node.previousElementSibling; prior?.classList.contains(node.classList[0]); prior = node.previousElementSibling) prior.remove();
                this.fading = null; if (this.ready) this.advance();
            });
        });
    };
    // A pointer or held arrow key crossing the rail selects every cover on its
    // way; artwork loads only for the cover it rests on for this long.
    const settleMs = 120;
    function Gallery(host, options) {
        this.host = host; this.options = options; this.generation = 0; this.selection = 0;
        this.posters = new Crossfade(node => node.classList.add('is-visible'));
        this.sceneries = new Crossfade(node => node.classList.remove('tg-pending'));
        this.cache = new Map(); this.animations = []; this.textAnimations = []; this.listeners = []; this.timer = null;
        if (!document.getElementById(styleId)) { const style = element('style', ''); style.id = styleId; style.textContent = css; document.head.append(style); }
        host.classList.add('tg-home-host');
        host.replaceChildren();
        this.root = element('section', 'tg-home'); this.root.setAttribute('aria-label', '媒体首页'); this.root.dataset.style = 'cinema';
        this.scenery = element('img', 'tg-home-scenery'); this.scenery.alt = '';
        this.nav = element('nav', 'tg-home-nav'); this.nav.setAttribute('aria-label', '媒体库');
        this.libraryList = element('div', 'tg-library-list');
        const navHeading = element('div', 'tg-home-nav-heading');
        const eyebrow = element('p', 'tg-home-eyebrow');
        eyebrow.append(element('span', '', 'YOUR LIBRARY /'), document.createTextNode(' '), element('span', '', '我的媒体'));
        navHeading.append(eyebrow);
        if (window.jmpInfo?.capabilities?.desktopWindowControls !== false && !window.tigerestAndroidApi && !window.api?.system?.isAndroid) {
            this.root.classList.add('tg-home-has-window-control');
            const windowMode = element('button', 'tg-home-window-mode');
            windowMode.type = 'button'; windowMode.dataset.tigerestWindowMode = '';
            windowMode.hidden = true; // The shell reveals this after its native controller mounts.
            navHeading.append(windowMode);
        }
        this.nav.append(navHeading, this.libraryList);
        this.stage = element('div', 'tg-home-stage'); this.hero = element('button', 'tg-home-hero'); this.hero.type = 'button';
        this.heroImages = element('div', 'tg-hero-images');
        const content = this.heroContent = element('div', 'tg-hero-content');
        this.kicker = element('span', 'tg-hero-kicker'); this.title = element('span', 'tg-hero-title'); this.subtitle = element('span', 'tg-hero-subtitle');
        content.append(this.kicker, this.title, this.subtitle, element('span', 'tg-hero-action', '查看作品'));
        this.overview = element('span', 'tg-hero-overview'); this.overview.hidden = true;
        this.heroCopy = element('div', 'tg-hero-copy tg-no-overview'); this.heroCopy.append(content, this.overview);
        this.ordinal = element('span', 'tg-hero-ordinal');
        this.hero.append(this.heroImages, element('span', 'tg-hero-shade'), this.heroCopy, this.ordinal);
        this.status = element('div', 'tg-home-status'); this.message = element('span', '', '正在载入媒体库…');
        this.retry = element('button', 'tg-home-retry', '重试'); this.retry.type = 'button'; this.retry.hidden = true;
        this.status.append(this.message, this.retry); this.stage.append(this.hero, this.status);
        this.rail = element('section', 'tg-home-rail'); const heading = element('div', 'tg-rail-heading');
        this.railTitle = element('span', 'tg-rail-title', '最近入库'); this.counter = element('span', 'tg-rail-counter');
        this.more = element('button', 'tg-home-more', '查看更多 →'); this.more.type = 'button';
        heading.append(this.railTitle, this.more, this.counter); this.coverList = element('div', 'tg-cover-list'); this.coverList.setAttribute('aria-label', '首页作品');
        this.rail.append(heading, this.coverList); this.root.append(this.scenery, this.nav, this.stage, this.rail); host.append(this.root);
        const listen = (node, event, fn) => { node.addEventListener(event, fn); this.listeners.push(() => node.removeEventListener(event, fn)); };
        listen(this.root, 'pointerdown', event => {
            const node = event.target.closest('.tg-library,.tg-cover');
            this.touchPress = event.pointerType === 'touch' ? {node, at: event.timeStamp,
                selected: node?.matches('.tg-library') ? node.dataset.libraryId === this.selectedLibrary?.Id : Number(node?.dataset.index) === this.index} : null;
        });
        listen(this.more, 'click', () => this.openLibrary(this.selectedLibrary));
        listen(this.libraryList, 'pointerover', event => {
            if (event.pointerType === 'touch') return;
            const button = event.target.closest('.tg-library');
            if (button && !button.contains(event.relatedTarget)) this.preview(button.dataset.libraryId);
        });
        listen(this.libraryList, 'focusin', event => { const button = event.target.closest('.tg-library'); if (button) { this.finishEntrance(); reveal(this.libraryList, button); this.preview(button.dataset.libraryId); } });
        listen(this.libraryList, 'click', event => {
            const button = event.target.closest('.tg-library'); if (!button || !this.valid()) return;
            const library = this.libraries.find(item => item.Id === button.dataset.libraryId);
            const selected = this.touchPress?.node === button ? this.touchPress.selected : library.Id === this.selectedLibrary?.Id;
            if (this.isTouchClick(event, button) && !selected) { this.preview(library.Id); return; }
            this.openLibrary(library);
        });
        listen(this.hero, 'click', () => this.open(this.cards?.[this.index]));
        listen(this.coverList, 'click', event => {
            const button = event.target.closest('.tg-cover'); if (!button || !this.valid()) return;
            const selected = this.touchPress?.node === button ? this.touchPress.selected : Number(button.dataset.index) === this.index;
            if (this.isTouchClick(event, button) && !selected) { this.select(Number(button.dataset.index), false); return; }
            this.open(this.cards.find(card => card.item.Id === button.dataset.itemId), button.querySelector('img'));
        });
        listen(this.coverList, 'pointerover', event => {
            if (event.pointerType === 'touch') return;
            const button = event.target.closest('.tg-cover'); if (button && !button.contains(event.relatedTarget) && Number(button.dataset.index) !== this.index) this.select(Number(button.dataset.index), false, settleMs);
        });
        listen(this.coverList, 'focusin', event => { const button = event.target.closest('.tg-cover'); if (button) { this.finishEntrance(); reveal(this.coverList, button); if (Number(button.dataset.index) !== this.index) this.select(Number(button.dataset.index), false, settleMs); } });
        listen(this.retry, 'click', () => this.selectedLibrary ? this.preview(this.selectedLibrary.Id, true) : this.start({}));
        // A finished or cancelled animation changes no size, so neither observer reports it.
        const settling = new WeakSet(), settle = animation => {
            if (settling.has(animation)) return;
            settling.add(animation); animation.finished.then(this.resize, this.resize);
        };
        this.resize = () => this.root.style.setProperty('--home-height', Math.max(320, window.innerHeight - settledTop(this.host, settle) - 8) + 'px');
        listen(window, 'resize', this.resize);
        this.resizeObserver = new ResizeObserver(this.resize); this.resizeObserver.observe(host);
        try { localStorage.removeItem('tigerest-home-style'); } catch (error) {}
        this.resize();
    }
    Gallery.prototype.valid = function (generation = this.generation) {
        return this.active && generation === this.generation && identity(this.options.apiProvider()) === this.session;
    };
    Gallery.prototype.isTouchClick = function (event, button) {
        const touch = event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents
            || (this.touchPress?.node === button && event.timeStamp - this.touchPress.at < 1500);
        this.touchPress = null;
        return !!touch;
    };
    Gallery.prototype.start = async function (options = {}) {
        this.stop(); this.active = true; const generation = ++this.generation;
        document.body.classList.add('tg-home-active');
        this.api = this.options.apiProvider(); this.session = identity(this.api); this.cache.clear();
        this.abort = new AbortController(); this.root.classList.remove('tg-entered', 'tg-ready');
        this.libraryList.replaceChildren(); this.clear(); this.resize();
        this.showStatus('正在载入媒体库…');
        if (!this.api || !this.api.getCurrentUserId()) { this.showStatus('请先登录服务器。'); return; }
        this.data = new window.TigerestHomeData(this.api);
        this.order = window.TigerestHomeData.normalizeOrder(window.jmpInfo?.settings?.home?.displayOrder);
        if (options.signal) {
            if (options.signal.aborted) { this.stop(); return; }
            options.signal.addEventListener('abort', () => { if (generation === this.generation) this.stop(); }, { once: true, signal: this.abort.signal });
        }
        try {
            this.libraries = await this.data.libraries(this.abort.signal);
            if (!this.valid(generation)) return;
            const artBase = this.options.artBase || window.jmpInfo?.homeArtPath || ((window.jmpInfo?.scriptPath || '') + '/home-art');
            this.libraries.forEach((library, index) => {
                const button = element('button', 'tg-library'); button.type = 'button'; button.dataset.libraryId = library.Id;
                const name = library.Name || '媒体库 ' + (index + 1);
                const art = library.kind === 'favorites' ? 'favorites' : /动漫|动画|[阿啊]你妹|anime|アニメ/i.test(name) ? 'anime' : library.CollectionType === 'movies' ? 'movies' : 'series';
                const image = element('img', ''); image.src = artBase + '/' + art + '.png'; image.alt = ''; image.draggable = false;
                const label = element('span', 'tg-library-label');
                label.append(element('span', 'tg-library-name', name), element('span', 'tg-library-index', library.kind === 'favorites' ? 'FAVORITES' : 'LIBRARY ' + String(index + 1).padStart(2, '0')));
                button.append(image, label); this.libraryList.append(button);
            });
            this.enter(generation);
            await this.preview(this.libraries[0].Id);
            if (!this.valid(generation)) return;
            this.timer = setInterval(() => {
                if (!this.valid(generation)) { this.stop(); return; }
                if (!document.hidden && this.cards?.length > 1 && !this.stage.matches(':hover') && !this.coverList.matches(':hover') && !this.root.contains(document.activeElement))
                    this.select((this.index + 1) % this.cards.length, true);
            }, 6500);
        } catch (error) { if (this.valid(generation) && error.name !== 'AbortError') this.showStatus('媒体库加载失败，请重试。', true); }
    };
    Gallery.prototype.enter = function (generation) {
        this.animations.forEach(animation => animation.cancel());
        const entrance = this.entrance = (this.entrance || 0) + 1;
        const reveal = () => { if (this.valid(generation) && entrance === this.entrance) { this.root.classList.add('tg-entered'); this.animateText(); } };
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !this.nav.animate) { reveal(); return; }
        this.animations = [
            // Move the whole column outside the viewport; its scrolling list
            // otherwise clips most of a card's long flight before it is visible.
            this.nav.animate([
                { transform: 'translate3d(-44px,calc(-125vh - 100%),0) rotate(-12deg) scale(.8)', opacity: 0, offset: 0, easing: 'cubic-bezier(.45,0,.1,1)' },
                { transform: 'translate3d(0,38px,0) rotate(2.4deg) scale(1.025)', opacity: 1, offset: .68, easing: 'ease-out' },
                { transform: 'translate3d(0,-14px,0) rotate(-.75deg) scale(.992)', opacity: 1, offset: .85, easing: 'ease-out' },
                { transform: 'none', opacity: 1, offset: 1 }
            ], { duration: 1380, fill: 'backwards' }),
            ...Array.from(this.libraryList.children, (button, index) => button.animate([
                { transform: 'translate3d(0,-64px,0) rotate(-3deg) scale(.94)', opacity: 0, offset: 0, easing: 'cubic-bezier(.2,.8,.2,1)' },
                { transform: 'translate3d(0,10px,0) rotate(.8deg) scale(1.01)', opacity: 1, offset: .7, easing: 'ease-out' },
                { transform: 'none', opacity: 1, offset: 1 }
            ], { duration: 740, delay: 420 + Math.min(index, 4) * 120, fill: 'backwards' })),
            this.rail.animate([
                { transform: 'translate3d(calc(130vw + 100%),0,0) skewX(-16deg) scale(.87)', opacity: 0, offset: 0, easing: 'cubic-bezier(.48,0,.1,1)' },
                { transform: 'translate3d(-46px,0,0) skewX(7deg) scale(1.03)', opacity: 1, offset: .64, easing: 'ease-out' },
                { transform: 'translate3d(18px,0,0) skewX(-2deg) scale(.995)', opacity: 1, offset: .84, easing: 'ease-out' },
                { transform: 'none', opacity: 1, offset: 1 }
            ], { duration: 1460, delay: 200, fill: 'backwards' })
        ];
        Promise.all(this.animations.map(animation => animation.finished)).then(reveal).catch(() => {});
    };
    Gallery.prototype.finishEntrance = function () {
        // Keyboard focus needs the final layout now, including when a background
        // compositor has paused an entrance. Remove effects before measuring the
        // scrolling viewport, rather than comparing rotated/offscreen bounds.
        this.entrance = (this.entrance || 0) + 1;
        this.animations.forEach(animation => animation.cancel()); this.animations = [];
        if (this.valid()) { this.root.classList.add('tg-entered'); this.animateText(); }
    };
    Gallery.prototype.cancelText = function () {
        this.textAnimations.forEach(animation => animation.cancel()); this.textAnimations = [];
        this.root.classList.remove('tg-text-ready');
    };
    Gallery.prototype.animateText = function (selection = this.selection) {
        if (!this.valid() || selection !== this.selection || !this.cards?.[this.index] || !this.root.classList.contains('tg-entered') || this.root.classList.contains('tg-text-ready')) return;
        this.root.classList.add('tg-text-ready');
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !this.heroContent.animate) return;
        const nodes = [...this.heroContent.children, ...(!this.overview.hidden ? [this.overview] : [])];
        this.textAnimations = nodes.map((node, index) => node.animate([
            { opacity: 0, transform: 'translate3d(-52px,30px,0)', offset: 0, easing: 'cubic-bezier(.2,.8,.2,1)' },
            { opacity: 1, transform: 'translate3d(3px,-2px,0)', offset: .8, easing: 'ease-out' },
            { opacity: 1, transform: 'none', offset: 1 }
        ], { duration: index === 1 ? 760 : 620, delay: 160 + index * 140, fill: 'both' }));
    };
    Gallery.prototype.clear = function () {
        // Touch focus can preview another library before its click arrives.
        // Preserve the pointerdown selection snapshot through that preview.
        this.cancelText();
        ++this.selection; this.root.classList.remove('tg-ready'); this.hero.disabled = true;
        this.cards = []; this.index = 0; this.title.textContent = ''; this.subtitle.textContent = '';
        this.overview.textContent = ''; this.overview.hidden = true; this.heroCopy.classList.add('tg-no-overview');
        this.clearArtwork(); this.ordinal.textContent = '';
        this.coverList.replaceChildren(); this.counter.textContent = '';
    };
    Gallery.prototype.showStatus = function (message, retry = false) { this.message.textContent = message; this.retry.hidden = !retry; this.status.hidden = false; };
    Gallery.prototype.preview = async function (id, refresh = false) {
        if (!this.valid() || (!refresh && this.selectedLibrary?.Id === id && this.cards?.length)) return;
        const library = this.libraries.find(item => item.Id === id); if (!library) return;
        this.requestAbort?.abort(); this.requestAbort = new AbortController();
        const generation = this.generation, signal = this.requestAbort.signal;
        this.selectedLibrary = library; this.clear();
        this.libraryList.querySelectorAll('.tg-library').forEach(button => { const selected = button.dataset.libraryId === id; button.classList.toggle('is-selected', selected); button.setAttribute('aria-current', selected ? 'true' : 'false'); });
        this.railTitle.textContent = library.Name + ' / ' + window.TigerestHomeData.orders[this.order]; this.showStatus('正在载入作品…');
        this.more.setAttribute('aria-label', '查看更多：' + library.Name);
        try {
            const cached = this.cache.get(id);
            const cards = !refresh && cached && Date.now() - cached.at < 60000 ? cached.cards : await this.data.load(library, signal, this.order);
            if (!this.valid(generation) || signal.aborted) return;
            this.cache.set(id, { cards, at: Date.now() }); this.cards = cards;
            if (!cards.length) { this.showStatus(library.kind === 'favorites' ? '还没有收藏作品。' : '这个媒体库还没有可展示的作品。'); return; }
            this.coverList.replaceChildren(...cards.map((card, index) => {
                const button = element('button', 'tg-cover'); button.type = 'button'; button.dataset.itemId = card.item.Id; button.dataset.index = index;
                const url = this.data.artwork(card.item, 'poster');
                if (url) { const image = element('img', ''); image.src = url; image.alt = ''; image.loading = 'lazy'; image.draggable = false; button.append(image); }
                const label = element('span', 'tg-cover-label');
                label.append(element('span', 'tg-cover-name', card.item.Name));
                const progressText = watchProgress(card);
                if (progressText) label.append(element('span', 'tg-watch-progress', progressText));
                button.append(label);
                if (card.watchState?.unwatched === true) button.append(element('span', 'tg-watch-badge'));
                if (card.resumeItem) {
                    const progress = element('span', 'tg-resume-progress'), fill = element('i', '');
                    fill.style.width = Math.max(0, Math.min(100, Number(card.resumeItem.UserData?.PlayedPercentage) || 0)) + '%';
                    progress.append(fill); button.append(progress);
                }
                button.setAttribute('aria-label', '查看作品：' + card.item.Name + (watchDescription(card) ? '，' + watchDescription(card) : '')); return button;
            }));
            this.status.hidden = true; this.select(0, false); this.root.classList.add('tg-ready');
            this.data.loadWatchProgress(cards, signal, card => {
                if (this.valid(generation) && !signal.aborted && this.cards.includes(card)) this.updateWatchState(card);
            }).catch(error => { if (error.name !== 'AbortError') console.warn('Tigerest Theater: unable to refresh home watch progress', error); });
        } catch (error) { if (this.valid(generation) && !signal.aborted) this.showStatus('作品加载失败，请重试。', true); }
    };
    Gallery.prototype.updateWatchState = function (card) {
        const button = Array.from(this.coverList.children).find(node => node.dataset.itemId === card.item.Id);
        if (!button) return;
        button.querySelector('.tg-watch-badge')?.remove(); button.querySelector('.tg-watch-progress')?.remove();
        if (card.watchState?.unwatched === true) button.append(element('span', 'tg-watch-badge'));
        const text = watchProgress(card);
        if (text) button.querySelector('.tg-cover-label').append(element('span', 'tg-watch-progress', text));
        const accessible = '查看作品：' + card.item.Name + (watchDescription(card) ? '，' + watchDescription(card) : '');
        button.setAttribute('aria-label', accessible);
        if (this.cards[this.index] === card) { this.subtitle.textContent = subtitle(card); this.hero.setAttribute('aria-label', accessible); }
    };
    // settle delays the artwork (never the text) until the selection has
    // rested that long; a later selection within it takes over.
    Gallery.prototype.select = function (index, scroll, settle = 0) {
        const card = this.cards?.[index]; if (!card || !this.valid()) return;
        this.cancelText();
        this.index = index; const selection = ++this.selection;
        this.title.textContent = card.item.Name || '未命名作品';
        // Decode HTML entities after removing markup; the detached textarea
        // treats the remaining content as text and never renders media tags.
        const plain = document.createElement('textarea'); plain.innerHTML = String(card.item.Overview || '').replace(/<[^>]*>/g, ' ');
        this.overview.textContent = plain.value.replace(/\s+/g, ' ').trim();
        this.overview.hidden = !this.overview.textContent;
        this.heroCopy.classList.toggle('tg-no-overview', this.overview.hidden);
        this.kicker.textContent = this.selectedLibrary.Name + ' / ' + window.TigerestHomeData.orders[this.order];
        this.subtitle.textContent = subtitle(card);
        this.hero.setAttribute('aria-label', '查看作品：' + this.title.textContent + (watchDescription(card) ? '，' + watchDescription(card) : '')); this.hero.disabled = false;
        this.counter.textContent = String(index + 1).padStart(2, '0') + ' / ' + String(this.cards.length).padStart(2, '0');
        this.ordinal.textContent = this.counter.textContent;
        const covers = this.coverList.querySelectorAll('.tg-cover');
        covers.forEach((button, i) => { button.classList.toggle('is-selected', index === i); button.setAttribute('aria-current', index === i ? 'true' : 'false'); });
        if (scroll && covers[index]) this.coverList.scrollTo({ left: covers[index].offsetLeft - this.coverList.offsetLeft - 3, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        this.animateText(selection);
        const url = this.data.artwork(card.item, 'hero');
        clearTimeout(this.artworkStall); clearTimeout(this.artworkSettle);
        if (!url) { this.clearArtwork(); return; }
        const current = () => this.valid() && selection === this.selection;
        // Crossfade: the previous work's artwork stays under the new layers
        // until they have loaded and faded in, so a change never shows a dark
        // gap. Artwork that stalls lets the previous work fade out shortly.
        const load = () => {
            const scenery = element('img', 'tg-home-scenery tg-pending'); scenery.alt = '';
            this.scenery.after(scenery); this.scenery = scenery; this.sceneries.queue(scenery);
            const image = element('img', 'tg-poster-image'); image.alt = ''; image.draggable = false;
            this.heroImages.append(image); this.posters.queue(image);
            // Artwork that arrives after the selection moved on is never shown;
            // the next load replaces it.
            scenery.onload = () => { if (current()) this.sceneries.loaded(scenery); };
            image.onload = () => { if (current()) this.posters.loaded(image); };
            image.onerror = () => { image.remove(); if (current()) { this.heroImages.replaceChildren(); this.posters.reset(); } };
            this.artworkStall = setTimeout(() => {
                if (!current()) return;
                if (this.posters.loading(image)) this.heroImages.querySelectorAll('.is-visible').forEach(prior => prior.classList.remove('is-visible'));
                if (this.sceneries.loading(scenery)) this.dropScenery();
            }, 450);
            scenery.src = url; image.src = url;
        };
        if (settle) this.artworkSettle = setTimeout(() => { if (current()) load(); }, settle); else load();
    };
    // Removes backdrop layers left from earlier selections.
    Gallery.prototype.dropScenery = function () {
        this.root.querySelectorAll('.tg-home-scenery').forEach(node => { if (node !== this.scenery) node.remove(); });
    };
    Gallery.prototype.clearArtwork = function () {
        clearTimeout(this.artworkStall); clearTimeout(this.artworkSettle);
        this.posters.reset(); this.sceneries.reset();
        this.heroImages.replaceChildren(); this.dropScenery(); this.scenery.removeAttribute('src');
    };
    Gallery.prototype.open = function (card, source) {
        if (!card || !this.valid() || window.TigerestHomeMotion?.busy) return;
        source = source || Array.from(this.coverList.children).find(node => node.dataset.itemId === card.item.Id)?.querySelector('img');
        const navigate = () => this.options.router.showItem({...card.item, ServerId: this.api.serverId()}, this.api.serverId());
        const result = window.TigerestHomeMotion ? window.TigerestHomeMotion.openItem({gallery: this, card, library: this.selectedLibrary, source, navigate}) : navigate();
        return Promise.resolve(result).catch(error => console.warn('Tigerest Theater: unable to open home work', error));
    };
    Gallery.prototype.openLibrary = function (library) {
        if (!library || !this.valid() || window.TigerestHomeMotion?.busy) return;
        const navigate = () => library.kind === 'favorites' ? (this.options.openFavorites || (() => this.options.router.showFavorites()))()
            : this.options.router.showItem({...library, ServerId: this.api.serverId()}, this.api.serverId());
        const result = window.TigerestHomeMotion ? window.TigerestHomeMotion.openLibrary({gallery: this, library, navigate}) : navigate();
        return Promise.resolve(result).catch(error => console.warn('Tigerest Theater: unable to open home library', error));
    };
    Gallery.prototype.scrollToBeginning = function () { this.host.scrollTop = 0; this.libraryList.scrollTop = 0; this.libraryList.scrollLeft = 0; this.coverList.scrollLeft = 0; };
    Gallery.prototype.stop = function () {
        this.touchPress = null;
        this.active = false; ++this.generation; this.abort?.abort(); this.requestAbort?.abort();
        document.body.classList.remove('tg-home-active');
        this.animations.forEach(animation => animation.cancel()); this.animations = [];
        if (this.timer) clearInterval(this.timer); this.timer = null;
        this.selectedLibrary = null; this.cache.clear(); this.clear();
        this.libraries = []; this.libraryList.replaceChildren();
    };
    Gallery.prototype.destroy = function () { this.stop(); this.resizeObserver.disconnect(); this.listeners.forEach(remove => remove()); this.host.replaceChildren(); this.host.classList.remove('tg-home-host'); };
    window.TigerestHomeGallery = Gallery;
}());
