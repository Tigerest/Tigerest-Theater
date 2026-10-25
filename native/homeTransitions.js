(function () {
    'use strict';
    window.TigerestHomeTransitions?.dispose?.();
    let active = null, last = null;
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Desktop pages render a batch well inside a frame: the poster flies once
    // its target exists, late sections load during the flight and its rejoin
    // absorbs layout shifts. Touch devices stalled mid-flight on those batches
    // and still wait for a steady target and a quiet page, except WebKit on iPad
    // and iPhone, which flies as the desktop does, and Android: its WebView
    // stalled 50-90 ms on the page ambient's two oversized blurred layers, which
    // ambientBackdrop.js now draws as small prepared bitmaps.
    const settles = () => window.matchMedia('(pointer: coarse)').matches && window.jmpInfo?.platform !== 'ipad';
    const android = () => !!(window.tigerestAndroidApi || window.api?.system?.isAndroid);
    const box = node => node?.getBoundingClientRect();
    const usable = node => { const b = box(node); return node?.isConnected && b?.width > 1 && b.height > 1; };
    const page = () => Array.from(document.querySelectorAll('.mainAnimatedPage,.page')).filter(node =>
        !node.classList.contains('hide') && usable(node) && getComputedStyle(node).visibility !== 'hidden').at(-1);
    let cached=null,warming=null,warmTimer=null,epoch=0,observer=null;
    const motionPreference=window.matchMedia('(prefers-reduced-motion: reduce)');
    const backgroundRoot=()=>document.body.classList.contains('tg-home-active')?document.querySelector('.tg-home-host'):page();
    const stamp=()=>[innerWidth,innerHeight,location.href,document.body.className.split(/\s+/).filter(n=>n&&n!=='tigerest-motion-busy').sort().join(' '),document.body.style.cssText].join('|');
    const rasterRoot=()=>document.body.classList.contains('tg-home-active')?backgroundRoot():document.body;
    const cacheReady=()=>!!cached&&cached.root===backgroundRoot()&&cached.epoch===epoch&&cached.stamp===stamp();
    function invalidate(schedule=true){
        ++epoch;cached?.bitmap?.close();cached?.wrapper?.remove();cached=null;warming?.controller.abort();warming=null;
        clearTimeout(warmTimer);warmTimer=null;
        if(schedule&&!active&&!reduced())warmTimer=setTimeout(()=>prewarm(),180);
    }
    // Scrolling, lazy loading and animations mutate the page every frame, so
    // relevance is decided from selectors alone: backgroundRoot() reads layout.
    // Any shown page counts, which can only invalidate more often, not less.
    const shownRoots='.mainAnimatedPage:not(.hide):not(.page-hidden),.page:not(.hide):not(.page-hidden)';
    function changes(records){
        if(active)return;
        const roots=homeActive()?'.tg-home-host':shownRoots;
        if(records.some(m=>{
            const node=m.target.nodeType===Node.ELEMENT_NODE?m.target:m.target.parentElement;
            return node&&!(m.type==='attributes'&&m.oldValue===m.target.getAttribute(m.attributeName))&&
                !node.closest('.tigerest-motion-layer,.tigerest-motion-flight,.tigerest-motion-poster,.tigerest-motion-cache')&&
                (!!node.closest(roots)||node.matches('.mainAnimatedPage,.page,.skinHeader,.backdropContainer,.backgroundContainer'));
        }))invalidate();
    }
    function settled(root,signal){
        // The ambient layers live outside the page/home root. Freeze their
        // settled opacity/transform, not an intermediate crossfade frame.
        const roots=[root,...document.querySelectorAll('.backgroundContainer')];
        const animations=[...new Set(roots.flatMap(node=>node.getAnimations?.({subtree:true})||[]))].filter(a=>
            (a.playState==='running'||a.pending)&&a.effect?.getComputedTiming().endTime<=2500);
        if(!animations.length)return Promise.resolve(true);
        return new Promise(resolve=>{
            let done=false;
            const finish=value=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);resolve(value);};
            const abort=()=>finish(false),timer=setTimeout(abort,3000);
            signal.addEventListener('abort',abort,{once:true});
            Promise.all(animations.map(a=>a.finished.catch(()=>{}))).then(()=>finish(!signal.aborted));
        });
    }
    const homeActive=()=>document.body.classList.contains('tg-home-active');
    // Only a return to home shows the crisp DOM copy. Home transitions animate
    // the live gallery and poster transitions use the small bitmap or a lens.
    const nativeGlass=()=>window.jmpInfo?.platform==='ipad';
    const snapshotWanted=()=>nativeGlass()||!homeActive();
    function idle(signal){
        return new Promise(resolve=>{
            if(signal.aborted)return resolve(false);
            const native=!!window.requestIdleCallback;
            const done=value=>{signal.removeEventListener('abort',abort);resolve(value);};
            const abort=()=>{native?cancelIdleCallback(handle):clearTimeout(handle);done(false);};
            const handle=native?requestIdleCallback(()=>done(true),{timeout:600}):setTimeout(()=>done(true),50);
            signal.addEventListener('abort',abort,{once:true});
        });
    }
    function snapshot(){
        const warmJob={},light=frozen(warmJob,false),wrapper=document.createElement('div');
        wrapper.className='tigerest-motion-cache';wrapper.inert=true;wrapper.setAttribute('aria-hidden','true');
        // Attach once offscreen so stylesheet parsing/layout also happens
        // before a click. A return promotes this wrapper in place.
        Object.assign(wrapper.style,{position:'fixed',inset:'0',opacity:'0',pointerEvents:'none',zIndex:'-2147483000',overflow:'hidden',contain:'layout paint'});
        wrapper.append(light);document.body.append(wrapper);sync(warmJob);light.getBoundingClientRect();
        Object.assign(cached,{light,wrapper,copies:warmJob.copies});
    }
    // Android rasters a flying poster's artwork at the start of its flight and
    // presents nothing until that frame is rastered. Flights off the small home
    // covers waited 30-300 ms for a full-size JPEG decode: the 4K scenery had
    // pushed the cover's decoded art out of the cache. The selected cover is the
    // likely press, so its art is decoded on a decoder thread beforehand, at
    // the size this window's detail posters landed, and that flight shows it
    // on a canvas, which needs no raster.
    let art=null,preparing=null;
    function prepareArt(){
        const node=document.querySelector('.tg-home .tg-cover.is-selected img'),source=node?.complete&&node.naturalWidth&&url(node);
        if(!source||art?.source===source||preparing?.source===source||!window.TigerestHomeBackdrop?.decode)return;
        preparing?.controller.abort();
        const task=preparing={source,controller:new AbortController()},signal=task.controller.signal;
        const landed=Object.entries(stored()).filter(([key,entry])=>key.startsWith('detail|')&&entry.w===innerWidth&&entry.h===innerHeight).map(([,entry])=>entry.rect.height);
        const height=Math.min(node.naturalHeight,Math.ceil((landed.length?Math.max(...landed):box(node).height*2)*1.1*devicePixelRatio));
        window.TigerestHomeBackdrop.decode(node,{resizeWidth:Math.max(1,Math.round(height*node.naturalWidth/node.naturalHeight)),resizeHeight:height,resizeQuality:'high'},signal).then(bitmap=>{
            if(!bitmap)return;
            if(!signal.aborted&&url(node)===source){
                const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
                canvas.getContext('2d').drawImage(bitmap,0,0);art={source,canvas};
            }
            bitmap.close();
        }).catch(()=>{}).finally(()=>{if(preparing===task)preparing=null;});
    }
    function prewarm(){
        changes(observer?.takeRecords()||[]);
        if(active||reduced()||!window.TigerestHomeBackdrop||!backgroundRoot())return Promise.resolve(false);
        if(android()&&homeActive())prepareArt();
        if(warming)return warming.promise;
        if(cacheReady()&&(cached.light||!snapshotWanted()))return Promise.resolve(true);
        if(cached&&!cacheReady())invalidate(false);
        const controller=new AbortController(),signal=controller.signal,task={controller,root:backgroundRoot(),epoch,stamp:stamp(),phase:'settle'};
        const valid=()=>!signal.aborted&&task.epoch===epoch&&task.root===backgroundRoot()&&task.stamp===stamp();
        warming=task;
        task.raster=(async()=>{
            if(cacheReady())return true;
            if(!await settled(task.root,signal))return false;
            task.phase='build';
            // WebKit does not reliably blur OffscreenCanvas; its 240px raster also
            // omits CSS backdrop images/gradients. Cache a full-resolution DOM scene
            // on iPad, keeping its CSS and letting the compositor produce the glass.
            const result=nativeGlass()?{bitmap:null,width:0,height:0}:await window.TigerestHomeBackdrop.build(rasterRoot(),signal);
            if(!result)return false;
            if(!valid()){result.bitmap?.close();return false;}
            cached={...result,root:task.root,epoch,stamp:task.stamp,light:null,wrapper:null};return true;
        })().catch(()=>false);
        task.promise=task.raster.then(async ready=>{
            if(!ready||!snapshotWanted())return ready;
            // Copying the page is synchronous. Keep it out of the input that
            // usually follows a scroll or hover, and never during a transition.
            task.phase='snapshot';
            if(!await idle(signal)||active||!valid()||!cacheReady())return cacheReady();
            if(!cached.light)snapshot();
            return true;
        }).catch(()=>false).finally(()=>{if(warming===task)warming=null;});
        return task.promise;
    }
    const style = document.createElement('style');
    style.id = 'tigerest-home-motion-style';
    style.textContent = `
      .tigerest-motion-input{position:fixed;inset:0;z-index:2147483002;pointer-events:auto!important;touch-action:none}
      .tigerest-motion-layer{position:fixed;inset:0;z-index:2147483000;pointer-events:none!important;overflow:hidden;contain:layout paint}
      .tigerest-motion-veil,.tigerest-motion-scene,.tigerest-motion-frozen{position:absolute;inset:0}
      .tigerest-motion-veil{background:#0b0d12}
      .tigerest-motion-frozen{filter:blur(var(--tigerest-motion-blur,7px))}
      .tigerest-motion-lens{-webkit-backdrop-filter:blur(var(--tigerest-motion-blur,7px));backdrop-filter:blur(var(--tigerest-motion-blur,7px))}
      .tigerest-motion-scene>canvas{position:absolute;inset:0;width:100%;height:100%}
      .tigerest-motion-flight{position:fixed;left:0;top:0;z-index:2147483001;pointer-events:none!important}
      .tigerest-motion-part,.tigerest-motion-poster{position:absolute;left:0;top:0;transform-origin:0 0}
      .tigerest-motion-part{will-change:transform}
      .tigerest-motion-poster{overflow:hidden;background-size:cover;background-position:center}
      .tigerest-motion-poster>canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
      @media(max-width:900px){
        .view-item-item .detailMainContainer:has(.detailImageContainer-main.detailImageContainer-portrait){display:grid!important;grid-template-columns:clamp(90px,18vw,130px) minmax(0,1fr);gap:12px 18px;align-items:center}
        .view-item-item .detailImageContainer-main.detailImageContainer-portrait{display:block!important;grid-column:1;grid-row:1/3;width:100%!important;max-width:none!important;margin:0!important;align-self:center}
        .view-item-item .detailImageContainer-main.detailImageContainer-portrait .card{width:100%!important;padding:0!important;margin:0!important}
        .view-item-item .detailImageContainer-main.detailImageContainer-portrait .cardBox{margin:0!important}
        .view-item-item .detailMainContainer:has(.detailImageContainer-main.detailImageContainer-portrait)>.detailTextContainer{display:contents}
        .view-item-item .detailMainContainer:has(.detailImageContainer-main.detailImageContainer-portrait)>.detailTextContainer>*{grid-column:1/-1}
        .view-item-item .detailMainContainer:has(.detailImageContainer-main.detailImageContainer-portrait)>.detailTextContainer>.detailNameContainer{grid-column:2;grid-row:1;align-self:end;margin:0}
        .view-item-item .detailMainContainer:has(.detailImageContainer-main.detailImageContainer-portrait)>.detailTextContainer>.detail-mediaInfoPrimary{grid-column:2;grid-row:2;align-self:start;margin:0}
      }
    `;
    function ensureStyle() { if (!style.isConnected) document.head.append(style); }
    if (document.head) ensureStyle(); else document.addEventListener('DOMContentLoaded',ensureStyle,{once:true});
    function sleep(job, ms) {
        return new Promise(resolve => {
            if (job.signal.aborted) return resolve();
            const done = () => { clearTimeout(timer); job.signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, ms); job.signal.addEventListener('abort', done, {once: true});
        });
    }
    function animate(job, node, frames, options) {
        if (!node || job.signal.aborted || job.done) return Promise.resolve();
        job.metric.firstAnimationMs??=performance.now()-job.start;
        const a = node.animate(frames, {...options, fill: 'both'}); job.animations.push(a);
        // Timed from now, not from the next frame: on Android that frame began
        // 10-30 ms later and every landing and reveal ended that much late.
        a.startTime = performance.now();
        return a.finished.catch(() => {});
    }
    async function wait(job, predicate, timeout = 2400, step = 32) {
        const until = performance.now() + timeout;
        while (!job.signal.aborted && performance.now() < until) {
            const result = predicate(); if (result) return result;
            await sleep(job, step);
        }
        return null;
    }
    // A view shows its loading spinner while it fetches items and renders
    // them after the route has changed. Wait under the opaque cover until that
    // is over and the page stops growing: a copy taken earlier flew in an
    // empty view, and the real cards were then styled and laid out on the
    // main thread in the middle of the incoming animation. Jellyfin's lazy
    // loader then sets the visible cards' artwork (dropping data-src): a copy
    // taken before that flew in blank cards whose artwork popped in later.
    async function loaded(job, target, timeout = 2400) {
        const begin = performance.now();
        let count = -1, steady = 0;
        const shown = node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
        await wait(job, () => {
            const busy = [...document.querySelectorAll('.docspinner.mdlSpinnerActive')].some(n => n.getClientRects().length) ||
                [...target.querySelectorAll('[data-src]')].some(shown);
            const nodes = target.getElementsByTagName('*').length;
            steady = !busy && nodes === count ? steady + 1 : 0; count = nodes;
            return steady >= 2 && performance.now() - begin >= 100;
        }, timeout);
        job.metric.incomingWaitMs = performance.now() - begin;
    }
    // Rasterizing a whole page copy and decoding its artwork took the first
    // 33-133 ms frames of its incoming animation on a phone. Draw it a few
    // frames ahead in its own layer, nearly transparent over the opaque
    // cover, at its final scale. The animation then moves tiles that exist.
    async function primed(job, node, frames = 3) {
        const begin = performance.now();
        node.style.willChange = 'transform, opacity'; node.style.opacity = '.01';
        for (let i = 0; i < frames && !job.signal.aborted; i++) await new Promise(r => requestAnimationFrame(r));
        node.style.opacity = '';
        job.metric.incomingPrimeMs = performance.now() - begin;
    }
    // A shown page keeps adding sections, artwork and plugin panels for a
    // while. On a phone each batch's style, layout and raster work stalled
    // the compositor for 30-50 ms frames in the middle of the flight, and a
    // late section could move the landing poster. Keep the lifted poster
    // waiting until the page has stopped changing and frames are smooth.
    async function quiet(job, timeout = 700) {
        const begin = performance.now();
        const ours = node => node?.nodeType === Node.ELEMENT_NODE && !!node.closest('.tigerest-motion-layer,.tigerest-motion-flight,.tigerest-motion-input,.tigerest-motion-cache');
        let changed = begin;
        const observer = new MutationObserver(records => {
            if (records.some(m => m.type === 'childList' && m.target === document.body
                ? [...m.addedNodes, ...m.removedNodes].some(node => !ours(node))
                : !ours(m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement))) changed = performance.now();
        });
        observer.observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true});
        let previous = begin, smooth = 0;
        while (!job.signal.aborted && performance.now() - begin < timeout) {
            const now = await new Promise(resolve => requestAnimationFrame(resolve));
            smooth = now - previous < 20 ? smooth + 1 : 0; previous = now;
            if (smooth >= 4 && now - changed >= 120) break;
        }
        observer.disconnect();
        job.metric.quietWaitMs = performance.now() - begin;
    }
    // Jellyfin draws a dark padder box with an icon and a blurhash canvas
    // under lazy card artwork, at the poster's own rectangle. Hidden with the
    // poster, or they show through the blur where it is about to land.
    const placeholders = node => [...(node?.closest?.('.cardScalable')?.querySelectorAll('.cardPadder,.blurhash-canvas') || [])];
    function hold(job, node) {
        for (const part of node ? [node, ...placeholders(node)] : []) {
            if (job.held.some(h => h.node === part)) continue;
            job.held.push({node: part, value: part.style.visibility, owner: node});
            part.style.visibility = 'hidden'; part.setAttribute('data-tigerest-poster-held', '');
        }
    }
    // The flying copy is drawn a frame or two after the frame that adds it;
    // hiding its card in that same frame left an empty slot until then. The
    // tablet's DOM scene leaves the card out of its own copy instead (bitmap()).
    // On Android it was sometimes drawn four frames later; the card stays
    // under the poster, which has barely moved, for HOLD_MS.
    function holdDrawn(job, node) {
        job.leaving = node;
        const until = performance.now() + (android() ? HOLD_MS : 0);
        const step = frames => requestAnimationFrame(now => {
            if (job.done) return;
            if (frames > 1 || now < until) step(frames - 1); else hold(job, node);
        });
        step(2);
    }
    const release = ({node, value, opacity}) => { node.style.visibility = value; if (opacity !== undefined) node.style.opacity = opacity; node.removeAttribute('data-tigerest-poster-held'); };
    // A hidden card is not drawn, and Emby decodes its artwork asynchronously:
    // shown in the frame the poster left, it was blank for that frame. Draw it
    // nearly transparent under the landing poster first.
    function predraw(job, target) {
        for (const h of job.held) if (h.owner === target && h.opacity === undefined) {
            h.opacity = h.node.style.opacity; h.node.style.opacity = '.01'; h.node.style.visibility = h.value;
        }
    }
    // Lazy artwork: Jellyfin keeps data-src until its image has loaded and
    // then fades it in; Emby's lazy images have no src until then.
    function artworkReady(node) {
        if (!node?.isConnected) return true;
        if (node.hasAttribute('data-src') || node.classList.contains('lazy-hidden')) return false;
        return node.tagName !== 'IMG' || node.complete;
    }
    // Cards on screen in the landing's list whose artwork is still loading.
    function cardsLoading(target) {
        const root = target.closest('.itemsContainer,.virtualItemsContainer') || page() || document;
        let loading = 0;
        for (const card of root.querySelectorAll('.card')) {
            const r = card.getBoundingClientRect();
            if (r.width <= 0 || r.bottom <= 0 || r.top >= innerHeight) continue;
            const art = card.querySelector('img.cardImage') || card.querySelector('.cardImageContainer');
            if (art && !artworkReady(art)) loading++;
        }
        return loading;
    }
    function layer(job, below = null) {
        const node = document.createElement('div'); node.className = 'tigerest-motion-layer';
        node.inert = true; node.setAttribute('aria-hidden', 'true');
        job.layers.push(node); document.body.insertBefore(node, below); return node;
    }
    // Blur the live page under the cover instead of copying its DOM. A copied
    // page has to be styled and laid out on the main thread before it paints.
    function lens(job, cover) { const node = layer(job, cover); node.classList.add('tigerest-motion-lens'); return node; }
    function clean(job) {
        job.done = true;
        if(!job.signal.aborted)job.controller.abort('complete');
        job.animations.forEach(a => a.cancel()); job.layers.forEach(n => n.remove());
        job.held.forEach(release);
        job.canvases.forEach(n => { n.width = n.height = 1; });
        cancelAnimationFrame(job.frame);
        if (active === job) { active = null; document.body.classList.remove('tigerest-motion-busy'); }
    }
    // A landed poster whose page artwork is still loading stays over it after
    // the transition has released input, then fades into the loaded image.
    // Scrolling, resizing, another transition or route hands over at once.
    // With `frames`, a loaded card is shown at once and the poster stays over
    // it for that many frames: Android draws a card a frame or two after the
    // frame that shows it, and a poster removed at once left its place blank.
    let tail = null;
    function handOver(job, flight, target, frames = 0) {
        dropTail();
        const t = {root: flight.root, target, page: page(), held: job.held.filter(h => h.owner === target), until: performance.now() + 5000};
        job.held = job.held.filter(h => h.owner !== target); job.layers = job.layers.filter(n => n !== flight.root);
        t.cut = () => dropTail();
        for (const type of ['scroll', 'wheel', 'resize']) addEventListener(type, t.cut, {capture: true, passive: true});
        if (frames) {
            t.held.splice(0).forEach(release);
            const step = () => { if (tail === t) { if (--frames > 0) t.frame = requestAnimationFrame(step); else dropTail(); } };
            tail = t; t.frame = requestAnimationFrame(step); return;
        }
        const poll = () => {
            if (tail !== t) return;
            if (page() !== t.page) return dropTail();
            if (artworkReady(target) || performance.now() > t.until) return dropTail(true);
            t.timer = setTimeout(poll, 32);
        };
        tail = t; t.timer = setTimeout(poll, 32);
    }
    function dropTail(fade = false) {
        const t = tail; if (!t) return;
        tail = null; clearTimeout(t.timer); cancelAnimationFrame(t.frame);
        for (const type of ['scroll', 'wheel', 'resize']) removeEventListener(type, t.cut, {capture: true});
        // The image is opaque under the copy: skip its own fade-in.
        if (fade) for (const a of t.target.getAnimations?.() || []) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) { try { a.finish(); } catch {} }
        t.held.forEach(release);
        if (!fade) return t.root.remove();
        const out = t.root.animate([{opacity: 1}, {opacity: 0}], {duration: 120, fill: 'forwards'});
        out.finished.catch(() => {}).finally(() => t.root.remove());
    }
    // A live page brought in after input was handed back (Android's library)
    // finishes its entrance when the next transition starts.
    let arriving = [];
    function arrive(nodes, frames, timing) {
        finishArriving();
        for (const node of new Set(nodes)) {
            if (node.closest('.tigerest-motion-layer,.tigerest-motion-cache') || !usable(node)) continue;
            // Each part scales about the window's centre, as one copy of the page did.
            const r = box(node), origin = node.style.transformOrigin;
            node.style.transformOrigin = `${innerWidth/2-r.x}px ${innerHeight/2-r.y}px`;
            const a = node.animate(frames, timing); arriving.push(a);
            a.finished.catch(() => {}).finally(() => { node.style.transformOrigin = origin; arriving = arriving.filter(n => n !== a); });
        }
    }
    function finishArriving() { for (const a of arriving.splice(0)) { try { a.finish(); } catch {} } }
    async function run(kind, perform) {
        if (active) return;
        dropTail(); finishArriving();
        changes(observer?.takeRecords()||[]);
        ensureStyle();
        // Only poster transitions consume a pending raster. Other routes must
        // not let a settling prewarm start decoding old artwork mid-animation.
        // Keep an already prepared snapshot for homeReturn's outgoing cover.
        if (kind !== 'poster') {
            clearTimeout(warmTimer); warmTimer = null;
            warming?.controller.abort(); warming = null;
        }
        const controller = new AbortController(), job = {controller, signal: controller.signal, animations: [], layers: [], held: [], canvases: [], frames: [], metric: {kind, surfaces: [], domCopies: 0}};
        active = job; document.body.classList.add('tigerest-motion-busy');
        // An input surface blocks even controls with explicit pointer-events:auto.
        // Changing the body's inherited pointer-events instead restyles the whole
        // library at the first animation frame and again when it finishes.
        const input = document.createElement('div'); input.className = 'tigerest-motion-input';
        input.setAttribute('aria-hidden','true');
        for (const type of ['pointerdown','click','dblclick','wheel','touchmove'])
            input.addEventListener(type,event=>{event.preventDefault();event.stopPropagation();},{passive:false});
        job.layers.push(input);document.body.append(input);
        const start = job.start = performance.now(), tick = t => {
            job.metric.firstFrameMs??=Math.max(0,t-start);job.frames.push(t);
            if (job.poster && job.metric.posterFirstMotionMs === undefined) {
                const current=box(job.poster),from=job.posterFrom;
                if (Math.max(...['x','y','width','height'].map(k=>Math.abs(current[k]-from[k])))>.15) job.metric.posterFirstMotionMs=performance.now()-start;
            }
            if (!job.signal.aborted) job.frame = requestAnimationFrame(tick);
        };
        job.frame = requestAnimationFrame(tick);
        try { return await perform(job); }
        finally {
            const interrupted=job.signal.aborted;
            clean(job);
            invalidate();
            const intervals = job.frames.slice(1).map((t,i) => t - job.frames[i]), sorted = [...intervals].sort((a,b) => a-b);
            const flight = job.metric.posterFlightStartsMs, flying = flight === undefined ? [] : intervals.filter((d,i) => job.frames[i]-start >= flight).sort((a,b) => a-b);
            last = {...job.metric, totalMs: performance.now()-start, interrupted,
                medianIntervalMs: sorted[Math.floor(sorted.length/2)] || 0, p95IntervalMs: sorted[Math.floor(sorted.length*.95)] || 0,
                flightP95IntervalMs: flying[Math.floor(flying.length*.95)] || 0, flightMaxIntervalMs: flying.at(-1) || 0};
        }
    }
    function url(node) {
        if (node?.currentSrc || node?.src) return node.currentSrc || node.src;
        const match = /url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/.exec(node ? getComputedStyle(node).backgroundImage : '');
        return match && (match[1] || match[2] || match[3]);
    }
    // Copy stylesheet elements instead of reading cssRules: Emby may serve CSS from another origin.
    // The shadow tree isolates duplicate IDs and makes the frozen controls inert.
    function frozen(job, blur = true) {
        if (job.metric) job.metric.domCopies = (job.metric.domCopies || 0) + 1;
        const host = document.createElement('div'); host.className = 'tigerest-motion-frozen';
        if (!blur) { host.style.filter = 'none'; host.style.transform = 'none'; }
        const home = document.body.classList.contains('tg-home-active') ? document.querySelector('.tg-home-host') : null;
        const pairs = [], plainPrototypes = new Map();
        function customizedBuiltin(node) {
            if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || node.localName.includes('-')) return false;
            if (node.hasAttribute('is')) return true;
            // createElement(tag, {is}) may customize a built-in without an `is`
            // attribute. Compare to a plain same-tag element once per tag.
            if (!plainPrototypes.has(node.localName)) plainPrototypes.set(node.localName,Object.getPrototypeOf(document.createElement(node.localName)));
            return Object.getPrototypeOf(node) !== plainPrototypes.get(node.localName);
        }
        // Emby keeps old views in the body. Reject entire inactive branches
        // before copying them; cloning then removing them still constructs all
        // their controls and makes work grow with the navigation history.
        function copyTree(node) {
            if (node.nodeType !== Node.ELEMENT_NODE) return node.cloneNode(true);
            if (node.matches('.mainAnimatedPage.hide,.page.hide,.page.page-hidden,.tigerest-motion-layer,.tigerest-motion-input,.tigerest-motion-flight,.tigerest-motion-poster,.tigerest-motion-cache,script,iframe,object,embed,audio,video')) return null;
            let clone;
            if (customizedBuiltin(node)) {
                // cloneNode upgrades customized built-ins and reconnects Emby's
                // scrollers/tabs in this static picture. Create ordinary elements
                // without an `is` option, and leave out the `is` attribute too:
                // Jellyfin's webcomponents v0 polyfill upgrades any element that
                // carries one, in this open shadow tree as well, and runs the
                // control's callbacks on the copy. Neither Emby's nor Jellyfin's
                // stylesheets select on `is`; classes keep the appearance.
                clone = document.createElement(node.localName);
                for (const attr of node.attributes) if (attr.name !== 'is') clone.setAttributeNS(attr.namespaceURI,attr.name,attr.value);
                if (node.tagName === 'INPUT' && node.type === 'file') clone.files = node.files;
                else if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') clone.value = node.value;
                if (node.tagName === 'INPUT') { clone.checked = node.checked; clone.indeterminate = node.indeterminate; }
            } else clone = node.cloneNode(false);
            if (node.tagName === 'CANVAS' && node.width && node.height) {
                // cloneNode copies a canvas's dimensions, not its backing image.
                // drawImage also preserves origin restrictions without readback.
                try { clone.getContext('2d').drawImage(node,0,0); } catch {}
            }
            pairs.push([node,clone]);
            if (node.matches('.card')) {
                const r = box(node);
                // Keep flow boxes, including Emby's absolute virtual-list cards,
                // without constructing offscreen poster/text subtrees. The margin
                // also keeps near-edge shadows and artwork in the snapshot.
                if (r.width && r.height && (r.bottom < -64 || r.top > innerHeight + 64 || r.right < -64 || r.left > innerWidth + 64)) {
                    const layout = getComputedStyle(node.parentElement).display;
                    const s = getComputedStyle(node);
                    if (s.position === 'absolute' || ['flex','inline-flex','grid','inline-grid'].includes(layout)) {
                        for (const property of ['width','height','box-sizing','min-width','min-height'])
                            clone.style.setProperty(property,s.getPropertyValue(property),'important');
                        return clone;
                    }
                }
            }
            for (const child of node.childNodes) {
                const copy = copyTree(child); if (copy) clone.append(copy);
            }
            return clone;
        }
        const shadow = host.attachShadow({mode: 'open'}), html = document.documentElement.cloneNode(false), body = home ? document.body.cloneNode(false) : copyTree(document.body);
        html.classList.add('tigerest-motion-html'); body.classList.remove('tigerest-motion-busy');
        if (home) {
            const copyRoot = copyTree(home); body.append(copyRoot);
            const rect = box(home), inherited = getComputedStyle(document.body);
            Object.assign(copyRoot.style,{position:'absolute',left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});
            Object.assign(body.style,{margin:'0',font:inherited.font,color:inherited.color,background:inherited.backgroundColor});
            // The home has its own complete stylesheet. Avoid reparsing all of Emby's
            // cached view styles and cloning hidden views for every poster press.
            for (const node of document.querySelectorAll('.backgroundContainer,.backdropContainer')) {
                const copy=copyTree(node), r=box(node), s=getComputedStyle(node);
                if (!copy) continue;
                Object.assign(copy.style,{position:'fixed',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px',opacity:s.opacity,filter:s.filter});
                body.prepend(copy);
            }
        }
        const scrolls = [];
        job.copies=new WeakMap();
        pairs.forEach(([node,clone]) => {
            job.copies.set(node,clone);
            // Stylesheets can declare important entrance animations. A universal
            // shadow override cannot beat those selectors; freeze each element.
            clone.style.setProperty('animation','none','important');
            clone.style.setProperty('transition','none','important');
            const r = box(node);
            if (r.width && r.height && r.bottom >= 0 && r.top <= innerHeight) {
                const computed = getComputedStyle(node);
                for (const property of ['opacity','transform','filter']) clone.style[property] = computed[property];
            }
            if (node.tagName === 'IMG') {
                clone.removeAttribute('srcset');
                // Emby decodes card artwork asynchronously. A copy drawn again in a
                // busy frame showed those posters blank for three frames; a frozen
                // picture keeps its previous pixels until they draw.
                if(r.width&&r.height&&r.bottom>=0&&r.top<=innerHeight&&r.right>=0&&r.left<=innerWidth){clone.src=node.currentSrc||node.src;clone.loading='eager';clone.decoding='sync';}
                else clone.removeAttribute('src');
            }
            for (const attr of Array.from(clone.attributes)) if (/^on/i.test(attr.name)) clone.removeAttribute(attr.name);
            if (node.scrollLeft || node.scrollTop) {scrolls.push([clone,node.scrollLeft,node.scrollTop]);clone.setAttribute('data-tigerest-scroll',JSON.stringify([node.scrollLeft,node.scrollTop]));}
        });
        Object.assign(html.style,{display:'block',width:innerWidth+'px',height:innerHeight+'px',overflow:'hidden'});
        Object.assign(body.style,{width:innerWidth+'px',height:innerHeight+'px',pointerEvents:'none'});
        const computed = getComputedStyle(document.documentElement);
        for (const name of computed) if (name.startsWith('--')) html.style.setProperty(name,computed.getPropertyValue(name));
        const restore = () => scrolls.forEach(([n,x,y]) => { n.scrollLeft=x; n.scrollTop=y; });
        document.querySelectorAll('style,link[rel="stylesheet"]').forEach(node => {
            if (node.closest('.tigerest-motion-layer,.tigerest-motion-cache')) return;
            if (home && node.tagName === 'LINK') return;
            const copy = node.cloneNode(true);
            if (copy.tagName === 'STYLE') copy.textContent = copy.textContent.replace(/:root\b/g,'.tigerest-motion-html');
            else {
                // A copied link applies a task after the copy is attached. Emby's
                // list scroller only scrolls with its linked styles, so the first
                // sync clamped it to the top, whose cards the copy leaves empty.
                copy.href = node.href; copy.addEventListener('load',restore);
            }
            shadow.append(copy);
        });
        const override = document.createElement('style');
        override.textContent = '*{animation:none!important;transition:none!important;pointer-events:none!important}';
        shadow.append(override,html); html.append(body);
        job.syncs ||= []; job.syncs.push(restore);
        return host;
    }
    // Returns an opaque cover holding a crisp copy of the current page.
    function outgoing(job){
        if(cacheReady()&&cached.light){
            const {light,wrapper}=cached;cached.light=cached.wrapper=null;
            // Promote the prepared offscreen copy in place. Moving it would
            // discard its layout and scroll offsets and restyle it on click.
            wrapper.classList.add('tigerest-motion-layer');Object.assign(wrapper.style,{opacity:'1',zIndex:'2147483000',background:'#0b0d12'});job.layers.push(wrapper);
            job.metric.lightCacheHit=true;return {cover:wrapper,copy:light};
        }
        job.metric.lightCacheHit=false;
        const cover=layer(job),copy=frozen(job,false);cover.style.background='#0b0d12';cover.append(copy);sync(job);
        return {cover,copy};
    }
    async function bitmap(job,view,source=false){
        if(nativeGlass()) {
            // Never reuse a low-resolution worker raster on the tablet. A warm
            // DOM scene belongs to exactly one route, viewport and mutation epoch.
            const hit=source&&cacheReady()&&cached.light;
            let scene;
            if(hit) {
                scene=cached.light;cached.light=null;
                cached.wrapper?.remove();cached.wrapper=null;
                scene.style.removeProperty('filter');
                for(const n of scene.shadowRoot?.querySelectorAll('[data-tigerest-scroll]')||[]) {
                    const [x,y]=JSON.parse(n.getAttribute('data-tigerest-scroll'));
                    (job.syncs||=[]).push(()=>{n.scrollLeft=x;n.scrollTop=y;});
                }
            } else scene=frozen(job);
            // The independently flying poster must not remain in the scene.
            const copies=hit?cached.copies:job.copies;
            for(const part of job.leaving?[job.leaving,...placeholders(job.leaving)]:[]) copies?.get(part)?.style.setProperty('visibility','hidden');
            job.metric.cacheHit=!!hit;job.metric.backgroundRenderer='dom-glass';
            view.bitmap=scene;view.group.append(scene);sync(job);return;
        }
        let result=source&&cacheReady()?cached:null,owned=false;
        if(source){job.metric.cacheHit=!!result;job.metric.syncRasterMs=0;}
        if(!result&&source&&warming){
            // A warm task still waiting for entrance animations would hold
            // navigation for their remaining time. Raster the current frame now.
            if(warming.phase==='build'){await warming.raster;if(cacheReady()){result=cached;job.metric.cacheHit=true;}}
            else if(warming.phase==='settle')warming.controller.abort();
        }
        if(!result&&!job.signal.aborted){
            // Yield the first frame before even collecting a cold raster plan.
            await new Promise(resolve=>requestAnimationFrame(resolve));
            if(job.signal.aborted)return;
            result=await window.TigerestHomeBackdrop?.build(rasterRoot(),job.signal);owned=true;
        }
        if(!result)return;
        if(job.signal.aborted||job.done){if(owned)result.bitmap.close();return;}
        const canvas=document.createElement('canvas');canvas.width=result.width;canvas.height=result.height;
        canvas.getContext('2d').drawImage(result.bitmap,0,0);
        if(owned)result.bitmap.close();
        job.canvases.push(canvas);job.metric.surfaces.push({width:canvas.width,height:canvas.height,blur:5});
        (job.metric.backgroundPhases||=[]).push({captureMs:result.captureMs,resizeMs:result.resizeMs,rasterMs:result.rasterMs,rasterThread:result.rasterThread});
        view.bitmap=canvas;view.group.append(canvas);
    }
    function sync(job) { job.syncs?.forEach(fn => fn()); }
    async function simple(job,navigate) {
        const before=page(), result=await navigate();
        const target=await wait(job,()=>{const n=page();return n!==before?n:null;},1200);
        if (target) await animate(job,target,[{opacity:0},{opacity:1}],{duration:110});
        job.metric.fallback=reduced()?'reduced-motion':'missing-poster';return result;
    }
    // Desktop poster timing in ms from the press. The poster flies at once and
    // lands by LAND_MS; the blur covers the old page before the route starts
    // and the destination is revealed as soon as its poster exists.
    // A wall that was never shown from home answers its item queries only
    // after 520-630 ms on a remote server: its short flight and reveal are
    // what still fits before DEADLINE_MS, which leaves the landing frame and
    // the release of input inside 700 ms.
    const COVER_MS=150,LAND_MS=600,DEADLINE_MS=680,LIFT_MS=260,FLIGHT_MS=320,SHORT_FLIGHT_MS=120,SHORT_REVEAL_MS=120,TOUCH_FLIGHT_MS=720,CORRECT_MS=160,LATE_MS=120,VEIL_MS=150,LENS_DELAY_MS=80,LENS_MS=180;
    // Android's library: the live wall starts coming in by then after the press, loaded or not.
    const ARRIVE_BY_MS=560;
    // The landing card is drawn, nearly transparent, this long before the poster leaves it.
    const PREDRAW_MS=40;
    // Android: the pressed card is hidden this long after the press, under its poster.
    const HOLD_MS=50;
    // Where a destination's poster landed before, per window size, so the next
    // press can fly at once. Kept across restarts; a few dozen entries.
    let landings=null;
    const landingStore='tigerest-motion-landings';
    function stored(){
        if(!landings){try{landings=JSON.parse(localStorage.getItem(landingStore)||'{}')||{};}catch{landings={};}}
        return landings;
    }
    function remembered(key){
        if(!key)return null;
        const entry=stored()[key];
        return entry&&entry.w===innerWidth&&entry.h===innerHeight?entry.rect:null;
    }
    function remember(key,rect){
        if(!key||!(rect?.width>1&&rect.height>1))return;
        remembered(key);
        landings[key]={w:innerWidth,h:innerHeight,at:Date.now(),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
        const keys=Object.keys(landings).sort((a,b)=>landings[b].at-landings[a].at);
        for(const old of keys.slice(48))delete landings[old];
        try{localStorage.setItem(landingStore,JSON.stringify(landings));}catch{}
    }
    const differs=(a,b)=>Math.max(...['x','y','width','height'].map(k=>Math.abs(a[k]-b[k])))>.5;
    // The flying poster is a stack: translations outside, scales inside, each
    // a compositor transform animation. The base flight heads for a predicted
    // landing; a correction stage starts at identity when the real target (or
    // a late layout change) is known, so a retarget never restarts a running
    // animation and the poster cannot jump.
    function stack(job,from,artwork,radius){
        const part=()=>{const n=document.createElement('div');n.className='tigerest-motion-part';return n;};
        const root=document.createElement('div'),poster=document.createElement('div');
        root.className='tigerest-motion-flight';poster.className='tigerest-motion-poster';root.setAttribute('aria-hidden','true');
        const moveA=part(),moveB=part(),move=part(),size=part(),sizeB=part(),sizeA=part();
        root.append(moveA);moveA.append(moveB);moveB.append(move);move.append(size);size.append(sizeB);sizeB.append(sizeA);sizeA.append(poster);
        for(const n of [moveA,moveB,move,size,sizeB,sizeA,poster])Object.assign(n.style,{width:from.width+'px',height:from.height+'px'});
        poster.style.borderRadius=radius;
        job.metric.preparedArt=art?.source===artwork;
        if(job.metric.preparedArt){poster.append(art.canvas);art=null;}
        else poster.style.backgroundImage='url('+JSON.stringify(artwork)+')';
        move.style.transform=`translate3d(${from.x}px,${from.y}px,0)`;
        job.layers.push(root);document.body.append(root);
        return {root,poster,from,final:new Map(),stages:{base:[move,size],A:[moveA,sizeA],B:[moveB,sizeB]}};
    }
    // Moves the stage's share of the poster from rectangle a to b. The base
    // stage is absolute; correction stages are relative to the rectangle the
    // stages outside them end at.
    function fly(job,flight,stage,a,b,timing){
        const [mover,sizer]=flight.stages[stage],base=stage==='base',{from}=flight;
        const scale=r=>base?`scale(${r.width/from.width},${r.height/from.height})`:`scale(${r.width/a.width},${r.height/a.height})`;
        const frames=base?[[`translate3d(${a.x}px,${a.y}px,0)`,`translate3d(${b.x}px,${b.y}px,0)`],[scale(a),scale(b)]]
            :[['translate3d(0px,0px,0)',`translate3d(${b.x-a.x}px,${b.y-a.y}px,0)`],['scale(1,1)',scale(b)]];
        return Promise.all([mover,sizer].map((node,i)=>{flight.final.set(node,frames[i][1]);return animate(job,node,frames[i].map(transform=>({transform})),timing);}));
    }
    // Keep the landed transforms when the animations are cancelled.
    function freeze(flight){for(const [node,transform] of flight.final)node.style.transform=transform;}
    const transitions = {
        get busy() { return !!active; }, get last() { return last; },
        get cacheState(){changes(observer?.takeRecords()||[]);return {ready:cacheReady(),snapshot:cacheReady()&&!!cached.light,warming:!!warming,bytes:cacheReady()?cached.width*cached.height*4:0};},
        prewarm,invalidate,
        cancel(reason = 'reset') { invalidate(false);dropTail();finishArriving();if (active) { const job=active;job.controller.abort(reason);clean(job); } },
        dispose(){transitions.cancel();observer?.disconnect();window.removeEventListener('resize',onResize);document.removeEventListener('scroll',onScroll,true);document.removeEventListener('load',onLoad,true);document.removeEventListener('viewshow',onView,true);motionPreference.removeEventListener('change',onPreference);},
        poster(options) { return run('poster',async job => {
            const source=options.source, artwork=url(source);
            if (reduced() || !usable(source) || !artwork) return simple(job,options.navigate);
            const from=box(source), previous=page(), begin=performance.now(), returning=options.direction==='return';
            const flight=stack(job,from,artwork,getComputedStyle(source).borderRadius);holdDrawn(job,source);
            job.poster=flight.poster;job.posterFrom=from;
            // Fly at once to where this destination's poster landed last time, to
            // the card that was left, or to where the page is known to draw it.
            // Without any, lift in place and fly when the target exists. Android
            // keeps the old page until the poster lands there, and without a
            // prediction lifts and waits for a quiet page: its pages stalled the
            // compositor while loading under a moving poster.
            const key=options.landingKey&&`${options.landingKey}|${Math.round(from.width/from.height*10)}`;
            const usableRect=rect=>rect?.width>1&&rect.height>1?rect:null;
            const departure=usableRect(options.landingRect), preset=usableRect(options.presetRect);
            const predicted=remembered(key)||departure||preset, settle=!android()&&settles();
            let aim=settle?null:predicted, landAt=null;
            if (aim) {
                job.metric.aim=remembered(key)?'remembered':departure?'departure':'preset';
                landAt=job.start+LAND_MS;job.metric.posterFlightStartsMs=performance.now()-job.start;
                fly(job,flight,'base',from,aim,{duration:LAND_MS,easing:'cubic-bezier(.3,.05,.18,1)'});
            } else {
                job.metric.aim='lift';
                const scale=returning?.96:1.09;
                aim={x:from.x-from.width*(scale-1)/2,y:from.y-from.height*(scale-1)/2,width:from.width*scale,height:from.height*scale};
                fly(job,flight,'base',from,aim,{duration:LIFT_MS,easing:'cubic-bezier(.2,.6,.3,1)'});
            }
            const hot=cacheReady()&&!nativeGlass(), cover=layer(job), veil=document.createElement('div'), fromScene={group:document.createElement('div'),bitmap:null};
            veil.className='tigerest-motion-veil';fromScene.group.className='tigerest-motion-scene';veil.append(fromScene.group);cover.append(veil);
            // Without a prepared bitmap, blur the live page at once and show the
            // opaque veil only when the old page's raster is ready to cover it.
            let glass=null;
            if(!hot){veil.style.opacity='0';glass=lens(job,cover);}
            job.metric.prepareMs=performance.now()-begin;
            const soft='cubic-bezier(.4,0,.6,1)';
            // Reach an opaque blur before changing the real page. Slow routes stay
            // covered. Emby swaps a cached view at once, so a route started with
            // the fade showed the sharp new page through the half-faded cover.
            await Promise.all([hot&&animate(job,veil,[{opacity:0},{opacity:1}],{duration:COVER_MS,easing:soft}),
                glass&&animate(job,glass,[{opacity:0},{opacity:1}],{duration:COVER_MS,easing:soft}),
                (async()=>{
                    await bitmap(job,fromScene,true);
                    if(!fromScene.bitmap&&!job.signal.aborted){
                        // No worker raster (or it failed): cover with the blurred DOM copy instead.
                        job.metric.domFallback=true;fromScene.group.append(frozen(job));sync(job);
                    }
                    // A tablet scene, fresh or warm, is drawn a few frames after it is
                    // added; fading the veil in sooner showed its dark background over the
                    // whole page. Its warm copy also faded in with the veil, dimming it.
                    if(nativeGlass()&&!job.signal.aborted){await primed(job,veil);veil.style.opacity='0';}
                    await animate(job,hot?fromScene.bitmap:veil,[{opacity:0},{opacity:1}],{duration:Math.max(80,COVER_MS-(performance.now()-job.start)),easing:soft});
                })()]);
            if (job.signal.aborted && job.signal.reason !== 'resize') return;
            job.metric.routeStartMs=performance.now()-job.start;
            const result=await options.navigate();
            if (job.signal.aborted) return result;
            const missing=async()=>{job.metric.fallback='missing-target';await Promise.all([cover,glass,flight.root].map(n=>animate(job,n,[{opacity:1},{opacity:0}],{duration:220,easing:soft})));return result;};
            if (options.prepareTarget) {
                await wait(job,()=>page()!==previous && page());
                if (!job.signal.aborted) options.restoreScroll?.();
                if (!job.signal.aborted && !usable(options.findTarget())) await options.prepareTarget(job.signal);
            }
            let target=await wait(job,()=>{const n=options.findTarget();return page()!==previous && usable(n)?n:null;},2400,16);
            if (target && returning) {
                // Keep a visible card where it was left, so the predicted landing
                // holds; only bring a card outside the window into view.
                const r=box(target);
                if (r.top<64||r.bottom>innerHeight||r.left<0||r.right>innerWidth) {target.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});if(settle)await sleep(job,64);}
            }
            if (!usable(target)) return missing();
            // The real page is still covered; finish its competing entrance now
            // so it cannot move the landing rectangle during our poster flight.
            for (const a of page()?.getAnimations?.()||[]) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) {try{a.finish();}catch{}}
            let prior=box(target), steady=0;
            for (let i=0;settle && i<18 && steady<2 && !job.signal.aborted;i++) {
                await sleep(job,32); const current=box(target);
                steady=Math.max(...['x','y','width','height'].map(k=>Math.abs(current[k]-prior[k])))<.5 ? steady+1 : 0;prior=current;
            }
            if(job.signal.aborted)return result;
            // The destination is already rendered under the opaque veil. Blur it
            // live instead of copying and restyling the new page before the flight.
            glass||=lens(job,cover);hold(job,target);
            if (settle) await quiet(job);
            if(job.signal.aborted)return result;
            // A late section can re-render the poster itself.
            if(!usable(target)){target=options.findTarget();hold(job,target);}
            if(!usable(target))return missing();
            // An image without fixed dimensions changes size when it decodes.
            // A landed poster covers it while it does.
            if (target.tagName==='IMG' && !target.complete) await wait(job,()=>target.complete,Math.max(0,Math.min(200,(landAt?landAt-CORRECT_MS:job.start+DEADLINE_MS-SHORT_FLIGHT_MS)-performance.now())),16);
            if(job.signal.aborted)return result;
            let to=box(target),now=performance.now(),end=aim;
            job.metric.targetMs=now-job.start;if(job.metric.aim!=='lift')job.metric.aimErrorPx=Math.max(...['x','y','width','height'].map(k=>Math.abs(aim[k]-to[k])));
            // A poster that already landed is corrected instead.
            if (!settle && now+SHORT_FLIGHT_MS>job.start+DEADLINE_MS && (job.metric.aim==='lift'||differs(aim,to))) {
                // Too late for a flight that lands by DEADLINE_MS: the poster
                // stays where it settled and fades out as the page is revealed
                // under it, with the real card shown in its own place.
                job.metric.fallback='late-target';
                job.held.filter(h=>h.owner===target).forEach(release);job.held=job.held.filter(h=>h.owner!==target);
                const pace=SHORT_REVEAL_MS/(LENS_DELAY_MS+LENS_MS);
                job.metric.plannedEndMs=now+SHORT_REVEAL_MS-job.start;
                await Promise.all([animate(job,veil,[{opacity:1},{opacity:0}],{duration:VEIL_MS*pace,easing:soft}),
                    animate(job,glass,[{opacity:1},{opacity:0}],{delay:LENS_DELAY_MS*pace,duration:LENS_MS*pace,easing:soft}),
                    animate(job,flight.root,[{opacity:1},{opacity:0}],{duration:SHORT_REVEAL_MS,easing:soft})]);
                if(job.signal.aborted)return result;
                job.metric.landedMs=performance.now()-job.start;
                remember(key,box(target));
                return result;
            }
            if (job.metric.aim==='lift') {
                // The real flight starts now, from the lifted rectangle. A late
                // target shortens it (not below SHORT_FLIGHT_MS) to land by DEADLINE_MS.
                const flightMs=Math.min(FLIGHT_MS,Math.max(SHORT_FLIGHT_MS,job.start+DEADLINE_MS-now));
                landAt=settle?now+TOUCH_FLIGHT_MS:Math.max(job.start+LAND_MS,now+flightMs);job.metric.posterFlightStartsMs=now-job.start;
                fly(job,flight,'A',aim,to,{delay:Math.max(0,job.start+LIFT_MS-now),duration:landAt-Math.max(now,job.start+LIFT_MS),easing:'cubic-bezier(.32,.05,.2,1)'});end=to;
            } else if (differs(aim,to)) {
                landAt=Math.max(landAt,now+Math.max(SHORT_FLIGHT_MS,Math.min(CORRECT_MS,job.start+DEADLINE_MS-now)));job.metric.correctionPx=Math.round(Math.max(...['x','y','width','height'].map(k=>Math.abs(aim[k]-to[k]))));
                fly(job,flight,'A',aim,to,{duration:landAt-now,easing:'cubic-bezier(.4,0,.2,1)'});end=to;
            }
            // Old blur -> live destination blur (veil fades out), then the lens
            // fades to reveal the sharp page, ending as the poster lands. A
            // short final flight compresses the reveal instead of outlasting it.
            // A wall shown for the first time waits for its cards' artwork, as
            // long as the shortest reveal still ends with the landing, so it is
            // not uncovered while its rows fill in.
            const reveal=(async()=>{
                if (options.revealCards && !settle) {
                    await wait(job,()=>!cardsLoading(target),Math.max(0,landAt-SHORT_REVEAL_MS-performance.now()),16);
                    if (job.signal.aborted) return;
                    job.metric.cardsLoading=cardsLoading(target);
                }
                const at=performance.now(), span=Math.min(LENS_DELAY_MS+LENS_MS,Math.max(SHORT_REVEAL_MS,landAt-at)), pace=span/(LENS_DELAY_MS+LENS_MS), revealAt=Math.max(at,landAt-span);
                job.metric.revealMs=revealAt-job.start;
                await Promise.all([
                    animate(job,veil,[{opacity:1},{opacity:0}],{delay:revealAt-at,duration:VEIL_MS*pace,easing:soft}),
                    animate(job,glass,[{opacity:1},{opacity:0}],{delay:revealAt-at+LENS_DELAY_MS*pace,duration:LENS_MS*pace,easing:soft})]);
            })();
            job.metric.plannedEndMs=Math.max(landAt,now+Math.min(LENS_DELAY_MS+LENS_MS,Math.max(SHORT_REVEAL_MS,landAt-now)))-job.start;
            // Emby can finish responsive layout during the flight. Rejoin a moved
            // target over the last part, without reading geometry every frame.
            await sleep(job,landAt-LATE_MS-performance.now());
            if(job.signal.aborted)return result;
            if(!usable(target)){const again=options.findTarget();if(usable(again)){target=again;hold(job,target);}}
            const late=box(target);now=performance.now();
            if (usable(target) && differs(late,end)) {
                landAt=Math.max(landAt,now+Math.max(60,Math.min(LATE_MS,job.start+DEADLINE_MS-now)));job.metric.lateCorrection=true;job.metric.plannedEndMs=Math.max(job.metric.plannedEndMs,landAt-job.start);
                fly(job,flight,'B',end,late,{duration:landAt-now,easing:'cubic-bezier(.4,0,.2,1)'});
            }
            await sleep(job,landAt-PREDRAW_MS-performance.now());
            if(job.signal.aborted)return result;
            if(artworkReady(target))predraw(job,target);
            await Promise.all([reveal,sleep(job,landAt-performance.now())]);
            if(job.signal.aborted)return result;
            const landing=box(flight.poster), actual=box(target);
            job.metric.landedMs=performance.now()-job.start;
            job.metric.landingErrorPx=Math.max(...['x','y','width','height'].map(key=>Math.abs(landing[key]-actual[key])));
            remember(key,actual);
            freeze(flight);
            job.metric.artworkPending=!artworkReady(target);
            if (job.metric.artworkPending) handOver(job,flight,target);
            else if (android()) handOver(job,flight,target,6);
            return result;
        }); },
        library({gallery,navigate,samePage = false}) { return run('library',async job => {
            if (reduced() || !gallery?.active) return simple(job,navigate);
            // Fly the live gallery parts out; the cover darkens over the last
            // part. Copying the home first delayed the first frame on click.
            const scope=gallery.root||backgroundRoot()||document, part=name=>gallery[name]||scope.querySelector('.tg-home-'+name);
            const nav=part('nav'), rail=part('rail'), stage=part('stage'), cover=layer(job);cover.style.background='#0b0d12';
            const accelerated='cubic-bezier(.65,0,.85,.25)';
            // A press during the gallery's entrance (Android hands input back
            // before it ends) starts the parts from where they are.
            const pose=node=>{const s=node&&getComputedStyle(node);return {transform:s?.transform||'none',opacity:s?Number(s.opacity):1};},from={nav:pose(nav),rail:pose(rail)};
            if(gallery.root&&!gallery.root.classList.contains('tg-entered'))gallery.finishEntrance?.();
            await Promise.all([
                animate(job,nav,[{...from.nav,offset:0},{transform:'translate3d(0,18px,0) rotate(1deg)',opacity:1,offset:.19},{transform:'translate3d(-36px,-130vh,0) rotate(-7deg)',opacity:0,offset:1}],{duration:380,easing:accelerated}),
                animate(job,rail,[{...from.rail,offset:0},{transform:'translate3d(-24px,0,0) skewX(-2deg)',opacity:1,offset:.16},{transform:'translate3d(130vw,0,0) skewX(8deg)',opacity:0,offset:1}],{duration:410,easing:accelerated}),
                animate(job,stage,[{opacity:1,transform:'none'},{opacity:0,transform:'scale(.95)'}],{duration:260}),
                animate(job,cover,[{opacity:0,offset:0},{opacity:0,offset:.58},{opacity:1,offset:1}],{duration:410})
            ]);
            if (job.signal.aborted && job.signal.reason !== 'resize') return;
            cover.style.background='#0b0d12';job.metric.routeStartMs=performance.now()-job.start;const previous=page(),result=await navigate();
            const target=await wait(job,()=>{const n=page();return n && (n!==previous || (samePage && !gallery.active)) ? n : null;});
            job.metric.pageMs=performance.now()-job.start;
            const zoom=[{opacity:0,transform:'scale(.82)',offset:0},{opacity:1,transform:'scale(1.008)',offset:.82},{opacity:1,transform:'none',offset:1}],zoomTiming={duration:460,easing:'cubic-bezier(.16,.8,.22,1)'};
            if (target && !job.signal.aborted && android()) {
                // Android brings the live page in and hands input back as it
                // starts: copying a wall that was still loading, rastering the
                // copy and flying it in kept the wall unusable for 1.1-1.4 s.
                // Cards that load during the zoom appear in their places.
                await loaded(job,target,Math.max(0,job.start+ARRIVE_BY_MS-performance.now()));job.metric.loadedMs=performance.now()-job.start;
                if (job.signal.aborted) return result;
                for (const a of target.getAnimations?.()||[]) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) {try{a.finish();}catch{}}
                // The body's background is the cover's colour.
                cover.remove();arrive([target,...document.querySelectorAll('.skinHeader,.backgroundContainer')],zoom,zoomTiming);
                job.metric.incomingMs=performance.now()-job.start;
                return result;
            }
            if (target && !job.signal.aborted) {
                await loaded(job,target);job.metric.loadedMs=performance.now()-job.start;
                // The opaque cover hides the page's own entrance. Snapshot its
                // final pixels, not an early low-opacity/blurred frame that
                // would suddenly become sharp when the cover is removed.
                // The central incoming animation below still runs in full.
                for (const a of target.getAnimations?.()||[]) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) {try{a.finish();}catch{}}
                const incoming=frozen(job,false);cover.replaceChildren(incoming);sync(job);
                await primed(job,incoming);job.metric.incomingMs=performance.now()-job.start;
                await animate(job,incoming,zoom,zoomTiming);
            }
            return result;
        }); },
        homeReturn({navigate,findGallery}) { return run('homeReturn',async job => {
            if (reduced()) return simple(job,navigate);
            const {cover,copy}=outgoing(job);
            // The copy is drawn a few frames after it is added; until then the
            // opaque cover showed only its dark background on the tablet, and
            // blank posters for three frames on Android. There the leaving copy
            // gets its own layer now, drawn while primed, not once it moves
            // and the route keeps the main thread busy.
            if(android())copy.style.willChange='transform, opacity';
            if((nativeGlass()||android())&&!job.signal.aborted){await primed(job,cover);cover.style.opacity='1';}
            // Android changes the route under the opaque cover while the copy
            // leaves, and hands input back as soon as the home is uncovered; the
            // gallery's entrance keeps running. Emby's back() returns nothing, so
            // whether the route has started is kept apart from its result.
            const early=android();let routed=false;
            const route=()=>{routed=true;cover.style.background='#0b0d12';job.metric.routeStartMs=performance.now()-job.start;return navigate();};
            const routing=early?route():null;
            await animate(job,copy,[{opacity:1,transform:'none'},{opacity:0,transform:'scale(.82)'}],{duration:320,easing:'cubic-bezier(.6,0,.8,.4)'});
            if (job.signal.aborted && job.signal.reason !== 'resize') return routing;
            const result=await (routed?routing:route());
            job.metric.routedMs=performance.now()-job.start;
            const home=await wait(job,()=>{const g=findGallery();return g?.active?g:null;});
            job.metric.homeMs=performance.now()-job.start;
            if (home && !job.signal.aborted) {
                cover.remove();
                // start/onResume owns the shipping Gallery entrance. Never replace its keyframes.
                if (!early) await wait(job,()=>home.root.classList.contains('tg-entered'),4000);
            }
            return result;
        }); }
    };
    const onResize=()=>{transitions.cancel('resize');invalidate();},onScroll=event=>{if(!active&&(event.target===document||backgroundRoot()?.contains(event.target)))invalidate();},onLoad=event=>{if(!active&&event.target.tagName==='IMG'&&!event.target.closest('.tigerest-motion-cache'))invalidate();},onView=()=>{if(!active)invalidate();},onPreference=()=>invalidate();
    function observe(){
        observer=new MutationObserver(changes);observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeOldValue:true,attributeFilter:['src','class','style','hidden']});
        document.addEventListener('scroll',onScroll,true);document.addEventListener('load',onLoad,true);document.addEventListener('viewshow',onView,true);invalidate();
    }
    window.addEventListener('resize',onResize);
    motionPreference.addEventListener('change',onPreference);
    window.TigerestHomeTransitions=transitions;
    if(document.body)observe();else document.addEventListener('DOMContentLoaded',observe,{once:true});
}());
