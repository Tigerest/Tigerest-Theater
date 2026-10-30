// A library view fetches its items after the route changes and shows
// Jellyfin's loading spinner meanwhile. The incoming animation must fly in the
// loaded view, not an empty one whose cards appear (and are laid out on the
// main thread) halfway through it. A spinner that never stops must not hold
// the transition beyond its bounded wait.
const assert = require('node:assert/strict'), path = require('node:path');
const withBrowser = require('./community_browser.cjs');
withBrowser({'/': {type: 'text/html', body: `<!doctype html><style>
body{margin:0;background:#123;color:white}.page{position:fixed;inset:0;padding:30px}.hide{display:none}
.card{display:inline-block;width:90px;height:130px;margin:6px;background:#456}
.docspinner{position:fixed;left:50%;top:50%;width:40px;height:40px;display:none}.docspinner.mdlSpinnerActive{display:block}
</style><div id=home class=page><div class=tg-home-nav>Library</div><div class=tg-home-rail>Posters</div><div class=tg-home-stage>Home</div></div>
<div id=library class="page hide"><h1>Library</h1><div class=itemsContainer></div></div><div class="docspinner mdl-spinner"></div>
<script src=/transitions.js></script>`},
'/transitions.js': {path: path.join(__dirname, '../native/homeTransitions.js')}}, async ({evaluate, call}) => {
    await call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'no-preference'}]});
    // Count frames between the copy's insertion and its first animated frame.
    const run = (loadMs) => evaluate(`(() => {
        window.copyFrames = {drawn: 0, primedOpacity: 0, opacity: null, willChange: null};
        (function count() {
            const copy = document.querySelector('.tigerest-motion-layer .tigerest-motion-frozen');
            if (copy && !copy.getAnimations().length) { copyFrames.drawn++; copyFrames.primedOpacity = Math.max(copyFrames.primedOpacity, +getComputedStyle(copy).opacity); }
            if (copy && copy.getAnimations().length && copyFrames.opacity === null) {
                copyFrames.opacity = +getComputedStyle(copy).opacity; copyFrames.willChange = copy.style.willChange;
            }
            if (copyFrames.opacity === null) requestAnimationFrame(count);
        })();
        document.querySelector('#home').className = 'page';
        document.querySelector('#library').className = 'page hide';
        document.querySelector('.itemsContainer').replaceChildren();
        window.fixtureTransition = TigerestHomeTransitions.library({gallery: {active: true, root: document.querySelector('#home')}, navigate: () => {
            document.querySelector('#home').classList.add('hide');
            document.querySelector('#library').className = 'page';
            const spinner = document.querySelector('.docspinner'); spinner.classList.add('mdlSpinnerActive');
            if (${loadMs} >= 0) setTimeout(() => {
                // Cards arrive with lazy artwork that the loader sets a little later.
                const cards = Array.from({length: 12}, () => { const card = Object.assign(document.createElement('div'), {className: 'card lazy'}); card.dataset.src = 'art'; return card; });
                document.querySelector('.itemsContainer').append(...cards);
                spinner.classList.remove('mdlSpinnerActive');
                setTimeout(() => cards.forEach(card => { card.removeAttribute('data-src'); card.style.backgroundImage = 'linear-gradient(#c33, #36c)'; }), 200);
            }, ${loadMs});
        }});
        return true; })()`);
    const firstCopy = async () => {
        // A stuck spinner holds the copy for the whole bounded wait.
        for (const until = Date.now() + 6000; Date.now() < until;) {
            const copy = await evaluate(`(() => { const incoming = document.querySelector('.tigerest-motion-layer .tigerest-motion-frozen');
                return incoming ? {cards: incoming.shadowRoot.querySelectorAll('.card').length, spinner: !!incoming.shadowRoot.querySelector('.mdlSpinnerActive'),
                    pendingArt: incoming.shadowRoot.querySelectorAll('.card[data-src]').length,
                    animations: incoming.getAnimations().length} : null; })()`);
            if (copy && copy.animations) return copy;
            await new Promise(r => setTimeout(r, 10));
        }
        return null;
    };
    await run(320);
    const copy = await firstCopy();
    assert.ok(copy, 'the central incoming animation was observed');
    assert.equal(copy.cards, 12, 'the incoming copy holds the loaded view: ' + JSON.stringify(copy));
    assert.equal(copy.spinner, false, 'the incoming copy does not show the loading spinner');
    assert.equal(copy.pendingArt, 0, 'the incoming copy holds the visible cards artwork: ' + JSON.stringify(copy));
    assert.ok(copy.animations > 0, 'the central incoming animation still runs');
    const primed = await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(copyFrames))))');
    assert.ok(primed.drawn >= 2, 'the copy is drawn under the cover before it moves: ' + JSON.stringify(primed));
    assert.ok(primed.opacity !== null && primed.primedOpacity <= .01, 'the copy is not visible before its animation: ' + JSON.stringify(primed));
    assert.match(primed.willChange, /transform/, 'the copy keeps its own layer from priming into the animation');
    await evaluate('fixtureTransition');
    const waited = await evaluate('TigerestHomeTransitions.last.incomingWaitMs');
    assert.ok(waited >= 500 && waited < 1300, 'the cover waited for the view to load: ' + waited);

    // A view that never finishes loading still animates in after the bounded wait.
    const start = Date.now();
    await run(-1);
    const stuck = await firstCopy();
    assert.ok(stuck && stuck.animations > 0, 'a stuck spinner still lets the view animate in');
    await evaluate('fixtureTransition');
    assert.ok(Date.now() - start < 5000, 'the wait is bounded');
    assert.equal(await evaluate('document.querySelectorAll(".tigerest-motion-layer,.tigerest-motion-input").length'), 0, 'transition releases its cover');
    console.log('library incoming copy waits for the loaded view');
}).catch(e => { console.error(e); process.exitCode = 1; });
