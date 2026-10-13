(function () {
    'use strict';
    window.TigerestHomeTransitions?.dispose?.();
    let active = null, last = null;
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
        ++epoch;cached?.bitmap.close();cached?.wrapper?.remove();cached=null;warming?.controller.abort();warming=null;
        clearTimeout(warmTimer);warmTimer=null;
        if(schedule&&!active&&!reduced())warmTimer=setTimeout(()=>prewarm(),180);
    }
    function changes(records){
        if(active)return;
        const root=backgroundRoot();
        if(records.some(m=>!(m.type==='attributes'&&m.oldValue===m.target.getAttribute(m.attributeName))&&
            !m.target.closest?.('.tigerest-motion-layer,.tigerest-motion-poster,.tigerest-motion-cache')&&
            (root?.contains(m.target)||m.target.matches?.('.mainAnimatedPage,.page,.skinHeader,.backdropContainer,.backgroundContainer'))))invalidate();
    }
    function settled(root,signal){
        const animations=(root.getAnimations?.({subtree:true})||[]).filter(a=>
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
    // The crisp DOM copy is the freeze frame that lets each transition start
    // the real route right away; the blur itself uses the bitmap or a lens.
    const snapshotWanted=()=>true;
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
    async function snapshot(signal,valid){
        const warmJob={},light=frozen(warmJob,false),wrapper=document.createElement('div');
        wrapper.className='tigerest-motion-cache';wrapper.inert=true;wrapper.setAttribute('aria-hidden','true');
        // Attach once offscreen so stylesheet parsing/layout also happens
        // before a click. A return promotes this wrapper in place.
        Object.assign(wrapper.style,{position:'fixed',inset:'0',opacity:'0',pointerEvents:'none',zIndex:'-2147483000',overflow:'hidden',contain:'layout paint'});
        wrapper.append(light);document.body.append(wrapper);sync(warmJob);light.getBoundingClientRect();
        // Offer it to a click only once its stylesheets have loaded.
        if(!await copyStyled(light,signal,2500)||!valid()||!cacheReady()||cached.light){wrapper.remove();return false;}
        Object.assign(cached,{light,wrapper,copies:warmJob.copies});return true;
    }
    function prewarm(){
        changes(observer?.takeRecords()||[]);
        if(active||reduced()||!window.TigerestHomeBackdrop||!backgroundRoot())return Promise.resolve(false);
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
            const result=await window.TigerestHomeBackdrop.build(rasterRoot(),signal);
            if(!result)return false;
            if(!valid()){result.bitmap.close();return false;}
            cached={...result,root:task.root,epoch,stamp:task.stamp,light:null,wrapper:null,copies:null};return true;
        })().catch(()=>false);
        task.promise=task.raster.then(async ready=>{
            if(!ready||!snapshotWanted())return ready;
            // Copying the page is synchronous. Keep it out of the input that
            // usually follows a scroll or hover, and never during a transition.
            task.phase='snapshot';
            if(!await idle(signal)||active||!valid()||!cacheReady())return cacheReady();
            if(!cached.light)await snapshot(signal,valid);
            return cacheReady();
        }).catch(()=>false).finally(()=>{if(warming===task)warming=null;});
        return task.promise;
    }
    const style = document.createElement('style');
    style.id = 'tigerest-home-motion-style';
    style.textContent = `
      body.tigerest-motion-busy{pointer-events:none!important}
      .tigerest-motion-layer{position:fixed;inset:0;z-index:2147483000;pointer-events:none!important;overflow:hidden;contain:layout paint}
      .tigerest-motion-veil,.tigerest-motion-scene,.tigerest-motion-frozen{position:absolute;inset:0}
      .tigerest-motion-veil{background:#0b0d12}
      .tigerest-motion-frozen{filter:blur(7px)}
      .tigerest-motion-lens{-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px)}
      .tigerest-motion-scene>canvas{position:absolute;inset:0;width:100%;height:100%}
      .tigerest-motion-poster{position:fixed;z-index:2147483001;pointer-events:none;transform-origin:0 0;overflow:hidden;background-size:cover;background-position:center;will-change:transform}
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
        return a.finished.catch(() => {});
    }
    async function wait(job, predicate, timeout = 2400) {
        const until = performance.now() + timeout;
        while (!job.signal.aborted && performance.now() < until) {
            const result = predicate(); if (result) return result;
            await sleep(job, 16);
        }
        return null;
    }
    function frame(job) {
        return new Promise(resolve => {
            if (job.signal.aborted) return resolve();
            const done = () => { cancelAnimationFrame(id); job.signal.removeEventListener('abort', done); resolve(); };
            const id = requestAnimationFrame(done); job.signal.addEventListener('abort', done, {once: true});
        });
    }
    function hold(job, node) {
        if (!node || job.held.some(h => h.node === node)) return;
        job.held.push({node, value: node.style.visibility});
        node.style.visibility = 'hidden'; node.setAttribute('data-tigerest-poster-held', '');
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
        job.held.forEach(({node,value}) => { node.style.visibility = value; node.removeAttribute('data-tigerest-poster-held'); });
        job.canvases.forEach(n => { n.width = n.height = 1; });
        job.finalizers.splice(0).forEach(fn => fn());
        cancelAnimationFrame(job.frame);
        if (active === job) { active = null; document.body.classList.remove('tigerest-motion-busy'); }
    }
    async function run(kind, perform) {
        if (active) return;
        changes(observer?.takeRecords()||[]);
        ensureStyle();
        const controller = new AbortController(), job = {controller, signal: controller.signal, animations: [], layers: [], held: [], canvases: [], frames: [], finalizers: [], metric: {kind, surfaces: [], domCopies: 0}};
        active = job; document.body.classList.add('tigerest-motion-busy');
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
            last = {...job.metric, totalMs: performance.now()-start, interrupted,
                medianIntervalMs: sorted[Math.floor(sorted.length/2)] || 0, p95IntervalMs: sorted[Math.floor(sorted.length*.95)] || 0};
        }
    }
    function url(node) {
        if (node?.currentSrc || node?.src) return node.currentSrc || node.src;
        const match = /url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/.exec(node ? getComputedStyle(node).backgroundImage : '');
        return match && (match[1] || match[2] || match[3]);
    }
    // Copy stylesheet elements instead of reading cssRules: Emby may serve CSS from another origin.
    // The shadow tree isolates duplicate IDs and makes the frozen controls inert.
    const uncopied='.tigerest-motion-layer,.tigerest-motion-poster,.tigerest-motion-cache,.mainAnimatedPage.hide,.page.hide,script,iframe,object,embed,audio,video';
    const offscreen = rect => rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth;
    // Clone visible content natively; only paths leading to hidden cached views,
    // motion layers or Emby item lists are walked, so hidden views are never copied.
    function copyTree(node, pairs) {
        if (!node.querySelector(uncopied+',.itemsContainer') && !node.matches('.itemsContainer')) {
            const clone = node.cloneNode(true), from = node.querySelectorAll('*'), to = clone.querySelectorAll('*');
            pairs.push([node,clone]); for (let i = 0; i < from.length; i++) pairs.push([from[i],to[i]]);
            return clone;
        }
        const clone = node.cloneNode(false), list = node.matches('.itemsContainer'); pairs.push([node,clone]);
        for (const child of node.childNodes) {
            if (child.nodeType !== 1) clone.append(child.cloneNode(false));
            else if (child.matches(uncopied)) continue;
            else if (list && child.offsetParent !== null && offscreen(box(child))) {
                // An off-screen card only needs to hold its layout size (unrounded,
                // so rows above stay exact); the frozen page then styles and paints
                // only the visible cards.
                const holder = child.cloneNode(false), rect = box(child);
                holder.style.cssText += `;width:${rect.width}px!important;height:${rect.height}px!important;box-sizing:border-box!important;flex:none!important;visibility:hidden!important`;
                clone.append(holder);
            } else clone.append(copyTree(child,pairs));
        }
        return clone;
    }
    function frozen(job, blur = true) {
        if (job.metric) job.metric.domCopies = (job.metric.domCopies || 0) + 1;
        const host = document.createElement('div'); host.className = 'tigerest-motion-frozen';
        if (!blur) { host.style.filter = 'none'; host.style.transform = 'none'; }
        const home = document.body.classList.contains('tg-home-active') ? document.querySelector('.tg-home-host') : null;
        const shadow = host.attachShadow({mode: 'open'}), html = document.documentElement.cloneNode(false), pairs = [];
        let body;
        if (home) {
            body = document.body.cloneNode(false); body.append(copyTree(home,pairs));
            const copyRoot = body.lastChild, rect = box(home), inherited = getComputedStyle(document.body);
            Object.assign(copyRoot.style,{position:'absolute',left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});
            Object.assign(body.style,{margin:'0',font:inherited.font,color:inherited.color,background:inherited.backgroundColor});
            // The home has its own complete stylesheet. Avoid reparsing all of Emby's
            // cached view styles and cloning hidden views for every poster press.
            for (const node of document.querySelectorAll('.backgroundContainer,.backdropContainer')) {
                const copy=node.cloneNode(true), r=box(node), s=getComputedStyle(node);
                Object.assign(copy.style,{position:'fixed',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px',opacity:s.opacity,filter:s.filter});
                body.prepend(copy);
            }
        } else body = copyTree(document.body,pairs);
        html.classList.add('tigerest-motion-html'); body.classList.remove('tigerest-motion-busy');
        // Animated, transitioning, hovered or focused nodes may differ from their
        // stylesheet values. Freeze only those; every other node matches its CSS.
        const live = new Set(document.querySelectorAll(':hover,:focus-within'));
        for (const animation of document.getAnimations()) if (animation.effect?.target && !animation.effect.pseudoElement) live.add(animation.effect.target);
        const scrolls = [];
        for (const [node,clone] of pairs) {
            if (live.has(node)) {
                const computed = getComputedStyle(node);
                for (const property of ['opacity','transform','filter']) clone.style[property] = computed[property];
            }
            if (node.tagName === 'IMG') {
                const r = box(node);
                clone.removeAttribute('srcset');
                if(r.width&&r.height&&r.bottom>=0&&r.top<=innerHeight&&r.right>=0&&r.left<=innerWidth){clone.src=node.currentSrc||node.src;clone.loading='eager';}
                else clone.removeAttribute('src');
            }
            for (const attr of Array.from(clone.attributes)) if (/^on/i.test(attr.name)) clone.removeAttribute(attr.name);
            if (node.scrollLeft || node.scrollTop) scrolls.push([clone,node.scrollLeft,node.scrollTop]);
        }
        Object.assign(html.style,{display:'block',width:innerWidth+'px',height:innerHeight+'px',overflow:'hidden'});
        Object.assign(body.style,{width:innerWidth+'px',height:innerHeight+'px',pointerEvents:'none'});
        const computed = getComputedStyle(document.documentElement);
        for (const name of computed) if (name.startsWith('--')) html.style.setProperty(name,computed.getPropertyValue(name));
        document.querySelectorAll('style,link[rel="stylesheet"]').forEach(node => {
            if (node.closest('.tigerest-motion-layer,.tigerest-motion-cache')) return;
            if (home && node.tagName === 'LINK') return;
            // A sheet that failed, is still loading or is disabled does not style the
            // live page either; copying it would only keep the copy from being ready.
            if (node.tagName === 'LINK' && (!node.sheet || node.sheet.disabled)) return;
            const copy = node.cloneNode(true);
            if (copy.tagName === 'STYLE') copy.textContent = copy.textContent.replace(/:root\b/g,'.tigerest-motion-html');
            else copy.href = node.href;
            shadow.append(copy);
        });
        // Stylesheets can declare important entrance animations, so a plain
        // universal override loses to them. :is() takes its most specific
        // argument (ten IDs) while still matching every element.
        const override = document.createElement('style');
        override.textContent = ':is(*,#t#t#t#t#t#t#t#t#t#t){animation:none!important;transition:none!important;pointer-events:none!important}';
        shadow.append(override,html); html.append(body);
        job.syncs ||= []; job.syncs.push(() => scrolls.forEach(([n,x,y]) => { n.scrollLeft=x; n.scrollTop=y; }));
        job.copies = new Map(pairs);
        return host;
    }
    // Promote the prepared offscreen copy in place. Moving it would discard its
    // layout and scroll offsets and restyle the whole copy on click. It was
    // appended before any layer of this job, so it stays beneath them.
    function promote(job,source=null){
        if(!cacheReady()||!cached.light)return null;
        const {light,wrapper,copies}=cached;cached.light=cached.wrapper=cached.copies=null;
        const twin=source&&copies?.get(source);if(twin)twin.style.visibility='hidden';
        wrapper.classList.add('tigerest-motion-layer');Object.assign(wrapper.style,{opacity:'1',zIndex:'2147483000',background:'#0b0d12'});job.layers.push(wrapper);
        return {cover:wrapper,copy:light};
    }
    // Returns an opaque cover holding a crisp copy of the current page, or null
    // when a fresh copy's stylesheets do not load in time. The live page stays
    // visible while a fresh copy waits, so nothing unstyled is ever shown.
    async function outgoing(job){
        const ready=promote(job);
        job.metric.lightCacheHit=!!ready;
        if(ready)return ready;
        const cover=layer(job),copy=frozen(job,false);cover.style.background='#0b0d12';cover.style.opacity='0';cover.append(copy);sync(job);
        if(!await copyStyled(copy,job.signal,160)){cover.remove();job.metric.copy='unstyled';return null;}
        cover.style.opacity='';return {cover,copy};
    }
    // A copy may be shown only once every copied <link> sheet has loaded. Any
    // failed sheet, timeout or abort means "not ready": it is never shown.
    function copyStyled(copy,signal,timeout){
        const links=Array.from(copy.shadowRoot.querySelectorAll('link[rel="stylesheet"]')).filter(link=>!link.sheet);
        if(signal.aborted)return Promise.resolve(false);
        if(!links.length)return Promise.resolve(true);
        return new Promise(resolve=>{
            let left=links.length,done=false;
            const finish=value=>{
                if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
                for(const link of links){link.removeEventListener('load',loaded);link.removeEventListener('error',failed);}
                resolve(value&&!signal.aborted);
            };
            const loaded=()=>{if(--left===0)finish(true);},failed=()=>finish(false),abort=()=>finish(false),timer=setTimeout(failed,timeout);
            signal.addEventListener('abort',abort,{once:true});
            for(const link of links){link.addEventListener('load',loaded,{once:true});link.addEventListener('error',failed,{once:true});}
        });
    }
    // A crisp, opaque copy of the old page beneath the blur layers. The real
    // route can then change the page (and fetch its data) during the fade.
    async function freezeFrame(job,below,source){
        const ready=promote(job,source);
        if(ready){ready.cover.classList.add('tigerest-motion-freeze');job.metric.freeze='snapshot';return ready.cover;}
        const cover=layer(job,below),copy=frozen(job,false);
        cover.classList.add('tigerest-motion-freeze');cover.style.background='#0b0d12';cover.style.opacity='0';cover.append(copy);sync(job);
        // Never show the copy unstyled: wait briefly for its copied <link> sheets.
        if(!await copyStyled(copy,job.signal,160)){cover.remove();job.metric.freeze='late';return null;}
        cover.style.opacity='';job.metric.freeze='copy';return cover;
    }
    // Start the route in the second frame: the first frame after a click only
    // shows the response, never the new page's style and layout work. It is
    // wrapped so awaiting this does not wait for the route itself; the route
    // promise is observed so an early failure is reported when awaited later.
    function startRoute(job,navigate){
        job.metric.navigateMs=performance.now()-job.start;
        const route=Promise.resolve().then(navigate);route.catch(()=>{});return {route};
    }
    async function routeSoon(job,navigate){
        await frame(job);await frame(job);
        return job.signal.aborted?null:startRoute(job,navigate);
    }
    async function bitmap(job,view,source=false){
        // A cold raster reads the old page synchronously when it starts; the
        // early route waits for that so the capture never sees the new page.
        let captured=()=>{};
        if(source)job.captured=new Promise(resolve=>{captured=resolve;});
        try{return await raster(job,view,source,()=>captured());}finally{captured();}
    }
    async function raster(job,view,source,captured){
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
            const pending=window.TigerestHomeBackdrop?.build(rasterRoot(),job.signal);captured();
            result=await pending;owned=true;
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
    const transitions = {
        get busy() { return !!active; }, get last() { return last; },
        get cacheState(){changes(observer?.takeRecords()||[]);return {ready:cacheReady(),snapshot:cacheReady()&&!!cached.light,warming:!!warming,bytes:cacheReady()?cached.width*cached.height*4:0};},
        prewarm,invalidate,
        cancel(reason = 'reset') { invalidate(false);if (active) { const job=active;job.controller.abort(reason);clean(job); } },
        dispose(){transitions.cancel();observer?.disconnect();window.removeEventListener('resize',onResize);document.removeEventListener('scroll',onScroll,true);document.removeEventListener('load',onLoad,true);document.removeEventListener('viewshow',onView,true);motionPreference.removeEventListener('change',onPreference);},
        poster(options) { return run('poster',async job => {
            const source=options.source, artwork=url(source);
            if (reduced() || !usable(source) || !artwork) return simple(job,options.navigate);
            const from=box(source), previous=page(), begin=performance.now();
            const floating=document.createElement('div');floating.className='tigerest-motion-poster';floating.setAttribute('aria-hidden','true');
            Object.assign(floating.style,{left:from.x+'px',top:from.y+'px',width:from.width+'px',height:from.height+'px',backgroundImage:'url('+JSON.stringify(artwork)+')',borderRadius:getComputedStyle(source).borderRadius});
            job.layers.push(floating);document.body.append(floating);hold(job,source);
            job.poster=floating;job.posterFrom=from;
            // Start at the exact source rectangle, then lift while the route and
            // blurred backgrounds prepare. Continue from this transform below.
            const initialScale=options.direction==='return'?.96:1.09,shift=(1-initialScale)/2;
            const lift=floating.animate([{transform:'none'},{transform:`translate3d(${from.width*shift}px,${from.height*shift}px,0) scale(${initialScale})`}],{duration:700,easing:'cubic-bezier(.2,.6,.3,1)',fill:'both'});
            job.animations.push(lift);lift.finished.catch(()=>{});
            const hot=cacheReady(), cover=layer(job), veil=document.createElement('div'), fromScene={group:document.createElement('div'),bitmap:null};
            veil.className='tigerest-motion-veil';fromScene.group.className='tigerest-motion-scene';veil.append(fromScene.group);cover.append(veil);
            // Without a prepared bitmap, blur the live page at once and show the
            // opaque veil only when the old page's raster is ready to cover it.
            let glass=null;
            if(!hot){veil.style.opacity='0';glass=lens(job,cover);}
            job.metric.prepareMs=performance.now()-begin;
            const soft='cubic-bezier(.4,0,.6,1)';
            // Reach an opaque blur before revealing anything of the real page. Slow routes stay covered.
            const reveal=Promise.all([hot&&animate(job,veil,[{opacity:0},{opacity:1}],{duration:210,easing:soft}),
                glass&&animate(job,glass,[{opacity:0},{opacity:1}],{duration:210,easing:soft}),
                (async()=>{
                    await bitmap(job,fromScene,true);
                    if(!fromScene.bitmap&&!job.signal.aborted){
                        // No worker raster (or it failed): cover with the blurred DOM copy instead.
                        job.metric.domFallback=true;const copy=frozen(job);copy.style.opacity='0';fromScene.group.append(copy);sync(job);
                        if(await copyStyled(copy,job.signal,160))copy.style.opacity='';else copy.remove();
                    }
                    await animate(job,hot?fromScene.bitmap:veil,[{opacity:0},{opacity:1}],{duration:Math.max(80,210-(performance.now()-job.start)),easing:soft});
                })()]);
            // Start the real route and its data requests during the fade, behind a
            // freeze frame of the old page, instead of after the fade has finished.
            // Created after the raster above so a cold capture still reads the old page.
            const early=(async()=>{
                await frame(job);await job.captured;await frame(job);if(job.signal.aborted)return null;
                const freeze=await freezeFrame(job,glass||cover,source);
                return freeze&&!job.signal.aborted?{freeze,call:startRoute(job,options.navigate)}:null;
            })();
            const [,started]=await Promise.all([reveal,early]);
            // The veil is opaque now; the freeze frame is no longer needed.
            started?.freeze.remove();
            if (job.signal.aborted && job.signal.reason !== 'resize') return;
            if (!started?.call) job.metric.navigateMs=performance.now()-job.start;
            const result=await (started?.call?started.call.route:options.navigate());
            if (job.signal.aborted) return result;
            if (options.prepareTarget) {
                await wait(job,()=>page()!==previous && page());
                if (!job.signal.aborted && !usable(options.findTarget())) await options.prepareTarget(job.signal);
            }
            let target=await wait(job,()=>{const n=options.findTarget();return page()!==previous && usable(n)?n:null;});
            if (target && options.direction==='return') {target.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});await sleep(job,64);}
            if (!usable(target)) { job.metric.fallback='missing-target';await Promise.all([cover,glass].map(n=>animate(job,n,[{opacity:1},{opacity:0}],{duration:220,easing:soft})));return result; }
            // The real page is fully covered; finish its competing entrance now
            // so it cannot move the landing rectangle during our poster flight.
            for (const a of page()?.getAnimations?.()||[]) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) {try{a.finish();}catch{}}
            // Two unchanged frames are enough: the flight rejoins the final rectangle anyway.
            let prior=box(target), steady=0;
            for (const until=performance.now()+576; steady<2 && !job.signal.aborted && performance.now()<until;) {
                await frame(job); const current=box(target);
                steady=Math.max(...['x','y','width','height'].map(k=>Math.abs(current[k]-prior[k])))<.5 ? steady+1 : 0;prior=current;
            }
            if(job.signal.aborted)return result;
            // Fly while the target artwork loads rather than waiting for it first.
            // The poster copy keeps covering the held target until it is ready,
            // at most 1.2 s after take-off (about 0.5 s after landing).
            const targetArt = target.tagName==='IMG' && !target.complete ? wait(job,()=>target.complete,1200) : null;
            const to=box(target);hold(job,target);
            // The destination is already rendered under the opaque veil. Blur it
            // live instead of copying and restyling the new page before the flight.
            glass||=lens(job,cover);
            const duration=720;
            const transform = rect => `translate3d(${rect.x-from.x}px,${rect.y-from.y}px,0) scale(${rect.width/from.width},${rect.height/from.height})`;
            const fly = async () => {
                const lifted=getComputedStyle(floating).transform;floating.style.transform=lifted;lift.cancel();
                job.metric.posterFlightStartsMs=performance.now()-job.start;
                const a=floating.animate([{transform:lifted},{transform:transform(to)}],{duration,easing:'cubic-bezier(.32,.05,.2,1)',fill:'both'});
                job.animations.push(a);a.finished.catch(()=>{});
                await sleep(job,560);if(job.signal.aborted)return;
                // Emby can finish responsive layout during the flight. Rejoin its final
                // rectangle in the last 160 ms, without reading geometry every frame.
                const at=getComputedStyle(floating).transform;floating.style.transform=at;a.cancel();
                await animate(job,floating,[{transform:at},{transform:transform(box(target))}],{duration:160,easing:'cubic-bezier(.2,.6,.3,1)'});
            };
            // Old blur -> live destination blur (veil fades out), then the lens
            // fades to reveal the sharp page, as the copied scenes did before.
            await Promise.all([
                fly(),
                animate(job,veil,[{opacity:1,offset:0},{opacity:1,offset:.16},{opacity:0,offset:.48},{opacity:0,offset:1}],{duration,easing:'linear'}),
                animate(job,glass,[{opacity:1,offset:0},{opacity:1,offset:.7,easing:soft},{opacity:0,offset:1}],{duration,easing:'linear'})
            ]);
            if (targetArt && !target.complete) { await targetArt; job.metric.artworkWaitMs=performance.now()-job.start; }
            // A late image or layout change can still move the target after the
            // flight's last read; rejoin it before releasing the real poster.
            const end=box(target), at=box(floating);
            if (!job.signal.aborted && Math.max(...['x','y','width','height'].map(k=>Math.abs(end[k]-at[k])))>.5) {
                const now=getComputedStyle(floating).transform;floating.style.transform=now;
                await animate(job,floating,[{transform:now},{transform:transform(end)}],{duration:160,easing:'cubic-bezier(.2,.6,.3,1)'});
            }
            const landing=box(floating), actual=box(target);
            job.metric.landingErrorPx=Math.max(...['x','y','width','height'].map(key=>Math.abs(landing[key]-actual[key])));
            return result;
        }); },
        library({gallery,navigate,samePage = false}) { return run('library',async job => {
            if (reduced() || !gallery?.active) return simple(job,navigate);
            // Fly the parts of a frozen home copy out (prepared at idle, so usually
            // free on click). It hides the real home, so the library route and its
            // data start on the next frame instead of after the 410 ms fly-out.
            const out=await outgoing(job);if(!out)return job.signal.aborted?undefined:simple(job,navigate);
            const {cover,copy}=out, shadow=copy.shadowRoot, previous=page();
            const nav=shadow.querySelector('.tg-home-nav'), rail=shadow.querySelector('.tg-home-rail'), stage=shadow.querySelector('.tg-home-stage');
            const accelerated='cubic-bezier(.65,0,.85,.25)', soon=routeSoon(job,navigate);
            await Promise.all([
                animate(job,nav,[{transform:'none',opacity:1,offset:0},{transform:'translate3d(0,18px,0) rotate(1deg)',opacity:1,offset:.19},{transform:'translate3d(-36px,-130vh,0) rotate(-7deg)',opacity:0,offset:1}],{duration:380,easing:accelerated}),
                animate(job,rail,[{transform:'none',opacity:1,offset:0},{transform:'translate3d(-24px,0,0) skewX(-2deg)',opacity:1,offset:.16},{transform:'translate3d(130vw,0,0) skewX(8deg)',opacity:0,offset:1}],{duration:410,easing:accelerated}),
                animate(job,stage,[{opacity:1,transform:'none'},{opacity:0,transform:'scale(.95)'}],{duration:260}),
                animate(job,copy,[{opacity:1,offset:0},{opacity:1,offset:.58},{opacity:0,offset:1}],{duration:410})
            ]);
            if (job.signal.aborted && job.signal.reason !== 'resize') return;
            const call=await soon, result=await (call?call.route:navigate());
            const target=await wait(job,()=>{const n=page();return n && (n!==previous || (samePage && !gallery.active)) ? n : null;});
            if (target && !job.signal.aborted) {
                await sleep(job,100);const incoming=frozen(job,false);incoming.style.opacity='0';cover.replaceChildren(incoming);sync(job);
                // Unstyled, the copy would flash; reveal the real page instead.
                if(!await copyStyled(incoming,job.signal,160)){incoming.remove();await animate(job,cover,[{opacity:1},{opacity:0}],{duration:220});return result;}
                incoming.style.opacity='';
                await animate(job,incoming,[{opacity:0,transform:'scale(.82)',offset:0},{opacity:1,transform:'scale(1.008)',offset:.82},{opacity:1,transform:'none',offset:1}],{duration:460,easing:'cubic-bezier(.16,.8,.22,1)'});
            }
            return result;
        }); },
        homeReturn({navigate,findGallery}) { return run('homeReturn',async job => {
            if (reduced()) return simple(job,navigate);
            const out=await outgoing(job);if(!out)return job.signal.aborted?undefined:simple(job,navigate);
            const {cover,copy}=out;
            const shrink=animate(job,copy,[{opacity:1,transform:'none'},{opacity:0,transform:'scale(.82)'}],{duration:320,easing:'cubic-bezier(.6,0,.8,.4)'});
            // The home route and its data start under the cover. If the gallery
            // begins its own entrance before the cover lifts, pause it there and
            // resume it on reveal, so the entrance is seen in full and unchanged.
            const soon=routeSoon(job,navigate), paused=new Set();
            let covered=true;
            const hold=()=>{const g=findGallery();if(g?.active)for(const a of [...(g.animations||[]),...(g.textAnimations||[])])if(a.playState==='running'){a.pause();paused.add(a);}};
            const resume=()=>{covered=false;paused.forEach(a=>{try{a.play();}catch{}});paused.clear();};
            // Whatever ends this job, a paused entrance must continue.
            job.finalizers.push(resume);
            (async()=>{while(covered&&!job.signal.aborted){hold();await frame(job);}})();
            await shrink;
            if (job.signal.aborted && job.signal.reason !== 'resize') return;
            const call=await soon, result=await (call?call.route:navigate());
            const home=await wait(job,()=>{const g=findGallery();return g?.active?g:null;});
            if (home && !job.signal.aborted) {
                hold();cover.remove();resume();
                // start/onResume owns the shipping Gallery entrance. Never replace its keyframes.
                await wait(job,()=>home.root.classList.contains('tg-entered'),4000);
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
