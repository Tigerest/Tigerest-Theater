(function () {
    'use strict';
    window.TigerestAmbientBackdrop?.dispose();
    // Loaded by the Mac and Android shells. The original CSS is always the fallback.
    if (!window.Worker || !window.OffscreenCanvas || !window.createImageBitmap) return;
    const states = new Map(), requests = new Map();
    const prepared = 'tigerest-ambient-prepared', canvasClass = 'tigerest-ambient-canvas';
    const blur = 58, padding = blur * 3, maxDimension = 1600;
    let disposed = false, worker = null, sequence = 0, queue = Promise.resolve();

    // Rasterize the existing CSS background at a resolution appropriate to its
    // 58px blur. A bitmap-renderer canvas can be composited without re-rastering
    // two oversized filtered CSS layers on every route change.
    async function paint({blob, width, height, scale, padding, slot, rem}) {
        const w = Math.ceil(width * scale), h = Math.ceil(height * scale);
        const source = new OffscreenCanvas(w, h), context = source.getContext('2d');
        function linear(angle, stops) {
            const radians = angle * Math.PI / 180, x = Math.sin(radians), y = -Math.cos(radians);
            const length = Math.abs(w * x) + Math.abs(h * y);
            const gradient = context.createLinearGradient(w / 2 - x * length / 2, h / 2 - y * length / 2,
                w / 2 + x * length / 2, h / 2 + y * length / 2);
            for (const [offset, color] of stops) gradient.addColorStop(offset, color);
            return gradient;
        }
        function radial(x, y, radius, color) {
            const gradient = context.createRadialGradient(x * w, y * h, 0, x * w, y * h, radius * rem * scale);
            gradient.addColorStop(0, color); gradient.addColorStop(1, 'transparent');
            context.fillStyle = gradient; context.fillRect(0, 0, w, h);
        }
        context.fillStyle = linear(slot === 'a' ? 145 : 215, [[0, '#111927'], [.54, '#17263b'], [1, '#11151d']]);
        context.fillRect(0, 0, w, h);
        if (slot === 'a') {
            radial(.9, .12, 38, 'rgba(67,133,255,.18)'); radial(.1, -.1, 32, 'rgba(255,190,56,.08)');
        } else {
            radial(.12, .16, 38, 'rgba(67,133,255,.18)'); radial(.88, -.08, 32, 'rgba(255,190,56,.07)');
        }
        if (blob) {
            const image = await createImageBitmap(blob);
            try {
                const factor = Math.max(w / image.width, h / image.height);
                context.drawImage(image, (w - image.width * factor) / 2, (h - image.height * factor) / 2,
                    image.width * factor, image.height * factor);
            } finally { image.close(); }
        }
        context.fillStyle = linear(180, [[0, 'rgba(7,10,16,.32)'], [1, 'rgba(8,11,17,.58)']]);
        context.fillRect(0, 0, w, h);
        const pad = Math.ceil(padding * scale), output = new OffscreenCanvas(w + pad * 2, h + pad * 2);
        const filtered = output.getContext('2d');
        filtered.filter = `blur(${58 * scale}px) saturate(1.42) brightness(.78)`;
        filtered.drawImage(source, pad, pad);
        return output.transferToImageBitmap();
    }
    const workerSource = `${paint.toString()}
        onmessage = async ({data}) => {
            try { const bitmap = await paint(data); postMessage({id:data.id,bitmap},[bitmap]); }
            catch { postMessage({id:data.id,error:true}); }
        };`;
    function stopWorker() {
        worker?.terminate(); worker = null;
        for (const request of requests.values()) { clearTimeout(request.timer); request.reject(Error('Background preparation stopped')); }
        requests.clear();
    }
    function getWorker() {
        if (worker) return worker;
        const url = URL.createObjectURL(new Blob([workerSource], {type: 'text/javascript'}));
        try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
        worker.onmessage = ({data}) => {
            const request = requests.get(data.id);
            if (!request) { data.bitmap?.close(); return; }
            requests.delete(data.id); clearTimeout(request.timer);
            if (data.error) request.reject(Error('Background preparation failed'));
            else request.resolve(data.bitmap);
        };
        worker.onerror = stopWorker;
        return worker;
    }
    function render(input, slot, state) {
        // Only one worker job is in flight. Superseded navigation requests are
        // discarded before fetching/decoding, and a late bitmap is never shown.
        const run = async () => {
            if (disposed || state.desired !== input) return null;
            let blob = null;
            const match = /url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/.exec(input.images[slot]);
            if (match) {
                const controller = state.fetch = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 3000);
                try {
                    const response = await fetch(match[1] || match[2] || match[3], {
                        credentials: 'same-origin', signal: controller.signal,
                    });
                    if (!response.ok) throw Error('Background source unavailable');
                    blob = await response.blob();
                } finally { clearTimeout(timeout); if (state.fetch === controller) state.fetch = null; }
            }
            if (disposed || state.desired !== input) return null;
            const target = getWorker(), id = ++sequence;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(stopWorker, 3000);
                requests.set(id, {resolve, reject, timer});
                try { target.postMessage({id, blob, slot, width:input.width, height:input.height,
                    rem:input.rem, scale:input.scale, padding}); }
                catch (error) { clearTimeout(timer); requests.delete(id); reject(error); }
            });
        };
        const result = queue.then(run); queue = result.catch(() => {}); return result;
    }
    const style = document.createElement('style');
    style.setAttribute('data-tigerest-owned', 'ambient-backdrop');
    style.textContent = `
        .${prepared}::before,.${prepared}::after{visibility:hidden!important}
        .${canvasClass}{position:absolute;left:calc(-12% - 174px);top:calc(-12% - 174px);
            width:calc(124% + 348px);height:calc(124% + 348px);z-index:0;pointer-events:none;
            visibility:hidden;transform:scale(1.16);opacity:.92;
            transition:opacity 850ms var(--tgs-ease),transform 850ms var(--tgs-ease);will-change:transform,opacity}
        .${prepared}>.${canvasClass}{visibility:visible}
        .${canvasClass}[data-tigerest-ambient=b]{opacity:0}
        .${prepared}[data-tigerest-ambient-phase=b]>.${canvasClass}[data-tigerest-ambient=a]{opacity:0;transform:scale(1.19)}
        .${prepared}[data-tigerest-ambient-phase=b]>.${canvasClass}[data-tigerest-ambient=b]{opacity:.92;transform:scale(1.16)}
        @media(prefers-reduced-motion:reduce){.${canvasClass}{transform:none!important;transition:none!important}}
    `;
    function release(background, state) {
        state.desired = null; state.fetch?.abort();
        background.classList.remove(prepared); background.removeAttribute('data-tigerest-ambient-phase');
        for (const canvas of Object.values(state.canvases)) { canvas.width = canvas.height = 1; canvas.remove(); }
        states.delete(background);
    }
    function read(background) {
        const css = getComputedStyle(background, '::before');
        // Respect custom filters and native fallbacks instead of approximating
        // a different effect with this renderer's fixed CSS-equivalent recipe.
        if (!/^blur\(58px\) saturate\(1\.42\) brightness\(0\.78\)$/.test(css.filter)) return null;
        const width = parseFloat(css.width), height = parseFloat(css.height);
        if (!(width > 0 && height > 0)) return null;
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const images = Object.fromEntries(['a', 'b'].map(slot => [slot,
            background.style.getPropertyValue('--tgs-ambient-image-' + slot) || 'none']));
        const phase = document.documentElement.classList.contains('tigerest-ambient-phase-b') ? 'b' : 'a';
        const keys = Object.fromEntries(['a', 'b'].map(slot => [slot, JSON.stringify([images[slot], width, height, rem])]));
        return {width, height, rem, images, phase, keys, signature: JSON.stringify([keys, phase]),
            // Width, height and both padding edges each round up separately.
            scale: Math.min(.5, (maxDimension - 3) / (width + padding * 2), (maxDimension - 3) / (height + padding * 2))};
    }
    async function pump(background, state) {
        while (!disposed && state.desired && state.applied !== state.desired) {
            const input = state.desired;
            const bitmaps = new Map();
            try {
                for (const slot of ['a', 'b']) {
                    if (state.keys[slot] === input.keys[slot]) continue;
                    const bitmap = await render(input, slot, state);
                    if (!bitmap) break;
                    if (disposed || !background.isConnected || state.desired !== input) { bitmap.close(); break; }
                    bitmaps.set(slot, bitmap);
                }
                if (disposed || state.desired !== input || !background.isConnected) continue;
                // Commit the pair together. A rapid reversal may update both
                // slots; the visible one must not change while the other waits.
                for (const [slot, bitmap] of bitmaps) {
                    const canvas = state.canvases[slot] || document.createElement('canvas');
                    canvas.className = canvasClass; canvas.setAttribute('data-tigerest-ambient', slot);
                    canvas.width = bitmap.width; canvas.height = bitmap.height;
                    const context = canvas.getContext('bitmaprenderer');
                    if (!context) throw Error('Bitmap rendering unavailable');
                    context.transferFromImageBitmap(bitmap);
                    if (!canvas.isConnected) background.append(canvas);
                    state.canvases[slot] = canvas; state.keys[slot] = input.keys[slot];
                }
                background.setAttribute('data-tigerest-ambient-phase', input.phase);
                background.classList.add(prepared); state.applied = input;
                // Canvas pixels are not DOM mutations. A snapshot made while
                // preparation was pending must not outlive the old artwork.
                window.TigerestHomeTransitions?.invalidate();
            } catch {
                if (state.desired === input) { background.classList.remove(prepared); state.applied = input; }
            } finally {
                for (const bitmap of bitmaps.values()) bitmap.close();
            }
        }
    }
    function update(background) {
        if (disposed || !background.isConnected) return Promise.resolve();
        let state = states.get(background);
        if (!state) { state = {keys:{}, canvases:{}, desired:null, applied:null, running:null}; states.set(background, state); }
        const input = read(background);
        if (!input) {
            state.desired = null; state.fetch?.abort();
            // Even removing an absent class creates a mutation record. During
            // startup (before server CSS arrives), that would starve the page
            // with an observer -> refresh -> class mutation microtask loop.
            if (background.classList.contains(prepared)) background.classList.remove(prepared);
            return state.running || Promise.resolve();
        }
        if (state.desired?.signature !== input.signature) { state.fetch?.abort(); state.desired = input; }
        if (!state.running && state.desired !== state.applied) {
            state.running = pump(background, state).finally(() => {
                state.running = null;
                if (!disposed && state.desired && state.desired !== state.applied) return update(background);
            });
        }
        return state.running || Promise.resolve();
    }
    function refresh() {
        if (disposed) return Promise.resolve();
        for (const [background, state] of states) if (!background.isConnected) release(background, state);
        if (!style.isConnected && document.head) document.head.append(style);
        return Promise.all([...document.querySelectorAll('.backgroundContainer')].map(update));
    }
    const observer = new MutationObserver(records => {
        // Card, drawer and player mutations must not trigger a layout read.
        const relevant = records.some(record => {
            if (record.type === 'attributes') return record.target === document.documentElement || states.has(record.target);
            return [...record.addedNodes].some(node => node.nodeType === 1 &&
                (node.matches('.backgroundContainer') || node.querySelector('.backgroundContainer')));
        });
        if (relevant || [...states.keys()].some(background => !background.isConnected)) refresh();
    });
    function start() {
        if (disposed || !document.documentElement) return;
        observer.observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:['class', 'style']});
        refresh();
    }
    window.addEventListener('resize', refresh);
    // Native scripts run at DocumentCreation, before the <html> element exists.
    document.addEventListener('DOMContentLoaded', start, {once:true});
    const api = {
        refresh,
        inspect: () => ({backgrounds:states.size, ready:[...states.keys()].filter(b => b.classList.contains(prepared)).length,
            pending:requests.size, worker:!!worker, disposed}),
        dispose() {
            if (disposed) return; disposed = true; observer.disconnect();
            window.removeEventListener('resize', refresh); document.removeEventListener('DOMContentLoaded', start);
            for (const [background, state] of states) release(background, state);
            stopWorker(); style.remove();
        },
    };
    window.TigerestAmbientBackdrop = api; start();
}());
