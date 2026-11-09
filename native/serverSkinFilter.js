(function () {
    'use strict';

    // Server-side skins and mods (emby-crx, danmaku and external-player scripts)
    // add script and stylesheet tags to Emby's index.html. This client has its
    // own home page, danmaku and player and those additions only get in their
    // way, so they are removed as the page is parsed, before they can run.
    //
    // The stock page of every Emby release from 4.8.0.80 to 4.10.2.0 has two
    // scripts, an inline import map and apploader.js, and no stylesheet link;
    // the rest of the web client is added after parsing. A later Emby's page is
    // unknown and may need more, so it is left alone.
    const server = window.TigerestServer;
    const isKnownPage = () => server.isEmby() && server.atLeast(4, 8) && !server.atLeast(4, 11);
    if (!/\/web\/(index\.html)?$/i.test(window.location.pathname) || !isKnownPage()) return;

    function addedByServer(node) {
        if (node.localName === 'link') return /stylesheet/i.test(node.rel);
        if (node.localName !== 'script') return false;
        return node.getAttribute('type') !== 'importmap'
            && !/(^|\/)apploader\.js(\?|$)/.test(node.getAttribute('src') || '');
    }

    let removed = 0;
    function sweep(records) {
        if (!isKnownPage()) return;
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (!addedByServer(node)) continue;
                node.remove();
                removed += 1;
            }
        }
    }

    // A mutation callback runs before the parser prepares a script it has just
    // inserted, so the tag is gone before it can start. The web client's own
    // tags come from apploader.js, a deferred script that runs after the first
    // state change and before DOMContentLoaded.
    const observer = new MutationObserver(sweep);
    observer.observe(document, {childList: true, subtree: true});
    document.addEventListener('readystatechange', () => {
        sweep(observer.takeRecords());
        observer.disconnect();
        if (removed) console.info('Tigerest Theater: ignored ' + removed + ' script and stylesheet tags the server added to its page');
    }, {once: true});

    // The version is remembered from the last visit and the server may have
    // been updated since; this page then needs the tags that were removed.
    server.ready.then(() => {
        if (removed && !isKnownPage()) window.location.reload();
    });
})();
