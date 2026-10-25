(function () {
    'use strict';
    window.TigerestHomeBackdrop?.dispose?.();
    // createImageBitmap(HTMLImageElement) still decodes large originals on the
    // renderer thread. Reuse only immutable artwork, keeping small owned copies
    // for worker transfer so finishing/aborting a build cannot close the cache.
    const decoded = new Map(), maxEntries = 64, maxPixels = 4 * 1024 * 1024;
    let pixels = 0, disposed = false;
    function forget(key) {
        const entry = decoded.get(key); if (!entry) return;
        decoded.delete(key); pixels -= entry.pixels; entry.bitmap.close();
    }
    function imageKey(node) {
        try {
            const source = new URL(node.currentSrc || node.src, location.href);
            // Emby's image tag changes with the artwork. Ordinary mutable URLs
            // must keep decoding their actual current image, even on a cache hit.
            const versioned = /\/Items\/[^/]+\/Images\/[^/]+(?:\/\d+)?$/i.test(source.pathname) && source.searchParams.get('tag');
            // Artwork bundled with the client is immutable too: qrc: on desktop,
            // the app's asset origin on Android.
            const scripts = window.jmpInfo?.scriptPath, bundled = !!scripts && source.href.startsWith(new URL(scripts.replace(/\/*$/, '/'), location.href).href);
            if (!['qrc:', 'data:', 'blob:'].includes(source.protocol) && !bundled &&
                !(['http:', 'https:'].includes(source.protocol) && versioned)) return null;
            return JSON.stringify([source.href, node.naturalWidth, node.naturalHeight]);
        } catch { return null; }
    }
    // Chromium decodes an <img> source on the page thread, which stalls a
    // scrolling media wall; a Blob source is decoded on a worker thread.
    // Same-origin server artwork is immutable per tag, and the page's own
    // request has usually put its bytes in the HTTP cache. Only those cached
    // bytes are read: artwork served uncacheable (or evicted) decodes the
    // element instead of being downloaded again while a transition waits.
    // An aborted build stops its request and decodes nothing, not even the element.
    function checkAborted(signal) {
        if (signal?.aborted) throw Object.assign(new Error('capture aborted'), {name: 'AbortError'});
    }
    // Emby varies artwork on Accept, so the cached copy is found only with the
    // header the element's own request sent: Chromium's image Accept, which
    // has gained formats over versions (Android's WebView 155 sends JPEG XL).
    // The plain header is for servers that do not vary.
    const accepts = ['image/jxl,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8', 'image/webp,image/apng,image/*,*/*;q=0.8', null];
    let accepted = 0;
    // Resolves null when the element's bytes are not such cached artwork.
    async function cachedDecode(node, options, signal) {
        const source = new URL(node.currentSrc || node.src, location.href);
        if (!window.fetch || source.origin !== location.origin || !/\/Items\/[^/]+\/Images\/[^/]+(?:\/\d+)?$/i.test(source.pathname) || !source.searchParams.get('tag')) return null;
        for (const index of [accepted, ...accepts.keys()].filter((value, i, all) => all.indexOf(value) === i)) {
            let response;
            try {
                response = await fetch(source.href, {cache: 'only-if-cached', mode: 'same-origin', credentials: 'same-origin', signal,
                    headers: accepts[index] ? {Accept: accepts[index]} : {}});
            } catch (error) { checkAborted(signal); continue; }
            checkAborted(signal);
            if (!response.ok) return null;
            accepted = index;
            const blob = await response.blob();
            checkAborted(signal);
            return createImageBitmap(blob, options);
        }
        return null;
    }
    async function decodeSource(node, options, signal) {
        try {
            const bitmap = await cachedDecode(node, options, signal);
            if (bitmap) return bitmap;
        } catch (error) { checkAborted(signal); }
        checkAborted(signal);
        return createImageBitmap(node, options);
    }
    async function resizedImage(node, options, signal) {
        checkAborted(signal);
        const key = imageKey(node), entry = key && decoded.get(key);
        if (entry && entry.bitmap.width >= options.resizeWidth && entry.bitmap.height >= options.resizeHeight) {
            decoded.delete(key); decoded.set(key, entry);
            try { return await createImageBitmap(entry.bitmap, options); }
            catch { if (decoded.get(key) === entry) forget(key); }
        }
        const bitmap = await decodeSource(node, options, signal), size = bitmap.width * bitmap.height;
        if (signal?.aborted) { bitmap.close(); checkAborted(signal); }
        if (!key || disposed || size > maxPixels) return bitmap;
        let copy;
        try { copy = await createImageBitmap(bitmap); }
        catch { return bitmap; } // Preserve native non-origin-clean image fallback.
        if (disposed) { bitmap.close(); return copy; }
        // Concurrent captures can finish out of order. Keep the largest useful
        // raster; the same backdrop also appears in a smaller home hero panel.
        const newer = decoded.get(key);
        if (newer && newer.bitmap.width >= bitmap.width && newer.bitmap.height >= bitmap.height) {
            bitmap.close(); return copy;
        }
        forget(key);
        decoded.set(key, {bitmap, pixels: size}); pixels += size;
        while (decoded.size > maxEntries || pixels > maxPixels) forget(decoded.keys().next().value);
        return copy;
    }
    function dispose() {
        disposed = true;
        for (const key of decoded.keys()) forget(key);
    }
    // Rasterize only small decoded images in a worker. The immutable-image cache
    // above avoids repeating the main-thread source extraction on later builds.
    function paint(records,width,height,scale) {
          const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d');
          ctx.scale(scale,scale);ctx.fillStyle='#0b0d12';ctx.fillRect(0,0,width/scale,height/scale);
          for(const r of records){
            ctx.save();ctx.globalAlpha=r.alpha;
            if(r.background){ctx.fillStyle=r.background;ctx.fillRect(r.x,r.y,r.w,r.h);}
            if(r.bitmap){
              const factor=Math.max(r.w/r.bitmap.width,r.h/r.bitmap.height);
              ctx.beginPath();ctx.rect(r.x,r.y,r.w,r.h);ctx.clip();
              ctx.drawImage(r.bitmap,r.x+(r.w-r.bitmap.width*factor)/2,r.y+(r.h-r.bitmap.height*factor)/2,r.bitmap.width*factor,r.bitmap.height*factor);
            }else if(r.text){ctx.fillStyle=r.color;ctx.font=r.font||'16px sans-serif';ctx.textBaseline='top';ctx.fillText(r.text,r.x,r.y,r.w);}
            ctx.restore();
          }
          // Extend edge pixels before blurring, then crop without changing
          // viewport geometry. Otherwise the blur leaves a translucent border.
          const pad=16,extended=new OffscreenCanvas(width+pad*2,height+pad*2),edge=extended.getContext('2d');
          edge.drawImage(canvas,pad,pad);
          edge.drawImage(canvas,0,0,1,height,0,pad,pad,height);
          edge.drawImage(canvas,width-1,0,1,height,width+pad,pad,pad,height);
          edge.drawImage(canvas,0,0,width,1,pad,0,width,pad);
          edge.drawImage(canvas,0,height-1,width,1,pad,height+pad,width,pad);
          for(const x of [0,width-1])for(const y of [0,height-1])edge.drawImage(canvas,x,y,1,1,x?width+pad:0,y?height+pad:0,pad,pad);
          const blurred=new OffscreenCanvas(extended.width,extended.height),blur=blurred.getContext('2d');
          blur.filter='blur(5px)';blur.drawImage(extended,0,0);
          const result=new OffscreenCanvas(width,height);
          result.getContext('2d').drawImage(blurred,pad,pad,width,height,0,0,width,height);
          return result.transferToImageBitmap();
    }
    const workerSource = `${paint.toString()}
      self.onmessage = event => {
        const {records,width,height,scale}=event.data, begin=performance.now();
        try {
          const bitmap=paint(records,width,height,scale);
          self.postMessage({bitmap,rasterMs:performance.now()-begin,rasterThread:'worker'},[bitmap]);
        }catch(error){self.postMessage({error:String(error)});}
        finally{for(const r of records)r.bitmap?.close();}
      };`;
    async function build(root, signal) {
        if (disposed || !window.Worker || !window.OffscreenCanvas || !window.createImageBitmap) return null;
        const begin = performance.now(), scale = Math.min(1,240/innerWidth);
        const width = Math.min(240,Math.round(innerWidth*scale)), height = Math.round(innerHeight*scale), records = [], images = [];
        // Skip motion layers, the held poster and Emby's hidden cached views as
        // whole subtrees instead of measuring each of their nodes.
        const skipped='.tigerest-motion-layer,.tigerest-motion-flight,.tigerest-motion-poster,.tigerest-motion-cache,[data-tigerest-poster-held],.mainAnimatedPage.hide,.page.hide,.page.page-hidden';
        // A media card is a self-contained box: well off screen, none of its
        // contents can be, so long walls are measured only near the view. The
        // margin covers hover/focus lifts (webAppearance moves a card box up
        // 12px and scales it), as the page copy's 64px margin does.
        const outside=r=>r.bottom<-64||r.top>innerHeight+64||r.right<-64||r.left>innerWidth+64;
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT,{acceptNode:node=>node.matches(skipped)||
            (node.matches('.card,.listItem')&&outside(node.getBoundingClientRect()))?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
        for (let node=root.closest(skipped)?null:root; node; node=walker.nextNode()) {
            if (signal.aborted) return null;
            const r=node.getBoundingClientRect();
            if (!r.width || !r.height || r.bottom<0 || r.top>innerHeight || r.right<0 || r.left>innerWidth) continue;
            const s=getComputedStyle(node);if (s.visibility==='hidden' || s.display==='none' || +s.opacity===0) continue;
            const record={x:r.x,y:r.y,w:r.width,h:r.height,alpha:+s.opacity,
                background:s.backgroundColor==='transparent'||s.backgroundColor==='rgba(0, 0, 0, 0)'?null:s.backgroundColor};
            if (node.tagName==='IMG' && node.complete && node.naturalWidth) images.push({node,record});
            else if (!node.childElementCount && node.textContent.trim()) Object.assign(record,{text:node.textContent.trim().slice(0,100),font:s.font,color:s.color});
            records.push(record);
        }
        const captureMs=performance.now()-begin, resizeStart=performance.now(), owned=[];
        try {
            // Bound concurrent decodes and keep transferred images below 240px.
            let index=0,decodeFailed=false;
            await Promise.allSettled(Array.from({length:Math.min(4,images.length)},async()=>{
                while(index<images.length && !signal.aborted && !decodeFailed){
                    const {node,record}=images[index++];
                    const w=Math.max(1,Math.min(240,Math.ceil(Math.max(record.w*scale,record.h*scale*node.naturalWidth/node.naturalHeight))));
                    let bitmap;
                    try{bitmap=await resizedImage(node,{resizeWidth:w,resizeHeight:Math.max(1,Math.round(w*node.naturalHeight/node.naturalWidth)),resizeQuality:'low'},signal);}
                    catch(error){decodeFailed=true;throw error;}
                    owned.push(bitmap);record.bitmap=bitmap;
                }
            }));
            if (signal.aborted || decodeFailed) return null;
            const resizeMs=performance.now()-resizeStart;
            const result=await new Promise(resolve=>{
                const objectUrl=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));
                let worker,timer,done=false;
                const finish=value=>{
                    if(done){value?.bitmap?.close();return;}done=true;
                    clearTimeout(timer);signal.removeEventListener('abort',abort);worker?.terminate();URL.revokeObjectURL(objectUrl);resolve(value);
                };
                const abort=()=>finish(null);
                try {
                    worker=new Worker(objectUrl);worker.onmessage=event=>finish(event.data.error?null:event.data);worker.onerror=()=>finish(null);
                    signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,2000);
                    worker.postMessage({records,width,height,scale},owned);
                }catch(error){
                    // Native Android appasset images may be non-origin-clean.
                    // A failed transfer keeps all inputs here; compose only the
                    // already resized bitmaps without weakening origin policies.
                    if(error.name==='DataCloneError'&&!signal.aborted){
                        try{const start=performance.now();finish({bitmap:paint(records,width,height,scale),rasterMs:performance.now()-start,rasterThread:'main-small'});}
                        catch{finish(null);}
                    }else finish(null);
                }
            });
            return result && {...result,width,height,captureMs,resizeMs,totalMs:performance.now()-begin};
        }catch(error){return null;}
        finally{owned.forEach(bitmap=>bitmap.close());}
    }
    window.TigerestHomeBackdrop={build,dispose,decode:cachedDecode};
}());
