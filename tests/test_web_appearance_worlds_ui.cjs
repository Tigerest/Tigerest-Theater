// Real isolated worlds share a DOM, but cannot read each other's JS globals.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const withBrowser = require('./community_browser.cjs');
const root = path.resolve(__dirname, '..');
const routes = {
    '/': {type: 'text/html', body: `<!doctype html><style>
      body{margin:0;background:#152030}.page{position:fixed;inset:0}.hide{display:none}
      img{width:120px;height:180px}#detail img{margin:80px;width:240px;height:360px}
      </style><div id="home" class="page"><img src="/poster.svg"></div>
      <div id="detail" class="page hide"><img src="/poster.svg"></div>
      <script src="/transitions.js"></script>`},
    '/poster.svg': {type:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180"><rect width="120" height="180" fill="gold"/></svg>'},
    '/transitions.js': {path: path.join(root, 'native/homeTransitions.js')},
};
withBrowser(routes, async ({evaluate, call}) => {
    await call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'no-preference'}]});
    const {frameTree} = await call('Page.getFrameTree');
    const {executionContextId} = await call('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id, worldName: 'appearance-regression',
    });
    async function isolated(expression) {
        const result = await call('Runtime.evaluate', {
            contextId: executionContextId, expression, awaitPromise:true, returnByValue:true,
        });
        assert.equal(result.exceptionDetails, undefined);
        return result.result.value;
    }
    await isolated(fs.readFileSync(path.join(root, 'native/webAppearance.js'), 'utf8'));
    assert.equal(await isolated('typeof window.TigerestHomeTransitions'), 'undefined');
    await evaluate(`window.navigationReady = new Promise(resolve => window.didNavigate = resolve);
      window.transition = TigerestHomeTransitions.poster({
        source:document.querySelector('#home img'),findTarget:()=>document.querySelector('#detail img'),
        navigate:()=>{document.querySelector('#home').classList.add('hide');
          document.querySelector('#detail').classList.remove('hide');didNavigate();
          return new Promise(resolve=>window.releaseNavigation=resolve);}
      });true`);
    await evaluate('navigationReady');
    // Wait beyond the entrance delay while navigation is held by a promise.
    const during = await isolated(`new Promise(resolve=>setTimeout(()=>resolve({
      sharedBusy:document.body.classList.contains('tigerest-motion-busy'),
      classes:document.querySelector('#detail').className,
      animations:document.querySelector('#detail').getAnimations().map(a=>a.animationName)
    }),260))`);
    assert.equal(during.sharedBusy,true);
    assert.ok(!/tigerest-page-(enter|pending)/.test(during.classes),JSON.stringify(during));
    assert.ok(!during.animations.includes('tigerestPageEnter'));
    await evaluate('releaseNavigation(); transition');
    assert.equal(await evaluate("document.body.classList.contains('tigerest-motion-busy')"),false);
    const normal = await isolated(`new Promise(resolve=>{
      document.querySelector('#detail').dispatchEvent(new Event('viewshow',{bubbles:true}));
      setTimeout(()=>resolve(document.querySelector('#detail').classList.contains('tigerest-page-enter')),260);
    })`);
    assert.equal(normal,true,'ordinary entrance works once the shared transition ends');
    console.log('real script worlds: transition exclusivity and recovery passed');
}).catch(error=>{console.error(error);process.exitCode=1;});
