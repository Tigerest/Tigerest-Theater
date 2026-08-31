const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeClassList {
    constructor(...names) { this.names = new Set(names); }
    add(...names) { names.forEach(name => this.names.add(name)); }
    remove(...names) { names.forEach(name => this.names.delete(name)); }
    contains(name) { return this.names.has(name); }
    toString() { return [...this.names].join(' '); }
}

class FakeElement {
    constructor(tagName = 'div', classes = []) {
        this.tagName = tagName.toUpperCase();
        this.nodeType = 1;
        this.id = '';
        this.textContent = '';
        this.isConnected = false;
        this.classList = new FakeClassList(...classes);
        this.listeners = new Map();
        this.children = [];
        this.parentElement = null;
        this.appendCount = 0;
        this.attributes = new Map();
        this.computedBackgroundImage = 'none';
        const properties = new Map();
        this.style = {
            setProperty(name, value) { properties.set(name, value); },
            getPropertyValue(name) { return properties.get(name) || ''; },
        };
    }

    get className() { return this.classList.toString(); }

    set className(value) {
        this.classList = new FakeClassList(...String(value).split(/\s+/).filter(Boolean));
    }

    setAttribute(name, value) {
        const stringValue = String(value);
        this.attributes.set(name, stringValue);
        if (name === 'id') this.id = stringValue;
        if (name === 'class') this.className = stringValue;
    }

    getAttribute(name) {
        if (name === 'id') return this.id || null;
        if (name === 'class') return this.className || null;
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    hasAttribute(name) {
        return this.getAttribute(name) !== null;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
        if (name === 'id') this.id = '';
        if (name === 'class') this.className = '';
    }

    addEventListener(type, listener, options = {}) {
        const listeners = this.listeners.get(type) || [];
        listeners.push({listener, once: options?.once === true});
        this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        this.listeners.set(type, listeners.filter(entry => entry.listener !== listener));
    }

    dispatchEvent(event) {
        event.target ||= this;
        for (const entry of [...(this.listeners.get(event.type) || [])]) {
            entry.listener(event);
            if (entry.once) this.removeEventListener(event.type, entry.listener);
        }
    }

    matches(selector) {
        return selector.split(',').some(part => {
            const candidate = part.trim();
            const attributeMatch = candidate.match(
                /^(?:([a-z][\w-]*))?\[([\w-]+)(?:=["']([^"']*)["'])?\]$/i,
            );
            if (attributeMatch) {
                const [, tagName, attribute, expected] = attributeMatch;
                if (tagName && this.tagName !== tagName.toUpperCase()) return false;
                if (!this.hasAttribute(attribute)) return false;
                return expected === undefined || this.getAttribute(attribute) === expected;
            }
            if (candidate.startsWith('.')) {
                return candidate.slice(1).split('.').every(name => this.classList.contains(name));
            }
            if (candidate.startsWith('#')) return this.id === candidate.slice(1);
            return this.tagName === candidate.toUpperCase();
        });
    }

    closest(selector) {
        let current = this;
        while (current) {
            if (current.matches(selector)) return current;
            current = current.parentElement;
        }
        return null;
    }

    append(...children) {
        for (const child of children) this.appendChild(child);
    }

    appendChild(child) {
        if (child.parentElement) child.parentElement.removeChild(child);
        child.parentElement = this;
        child.isConnected = this.isConnected;
        this.children.push(child);
        this.appendCount++;
        return child;
    }

    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index === -1) throw new Error('child not found');
        this.children.splice(index, 1);
        child.parentElement = null;
        child.isConnected = false;
        return child;
    }

    remove() { this.parentElement?.removeChild(this); }

    get lastElementChild() { return this.children[this.children.length - 1] || null; }

    querySelectorAll(selector) {
        const matches = [];
        for (const child of this.children) {
            if (child.matches(selector)) matches.push(child);
            matches.push(...child.querySelectorAll(selector));
        }
        return matches;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }
}

function makeDocument({headReady = true} = {}) {
    const listeners = new Map();
    const descendants = root => root ? [root, ...root.children.flatMap(descendants)] : [];
    const document = {
        head: null,
        body: new FakeElement('body'),
        documentElement: new FakeElement('html'),
        createElement(tagName) { return new FakeElement(tagName); },
        getElementById(id) {
            return [...descendants(document.head), ...descendants(document.body)]
                .find(element => element.id === id) || null;
        },
        querySelectorAll(selector) {
            return [...descendants(document.head), ...descendants(document.body)]
                .filter(element => element.matches(selector));
        },
        querySelector(selector) { return document.querySelectorAll(selector)[0] || null; },
        addEventListener(type, listener) {
            const callbacks = listeners.get(type) || [];
            callbacks.push(listener);
            listeners.set(type, callbacks);
        },
        dispatchEvent(event) {
            for (const listener of listeners.get(event.type) || []) listener(event);
        },
    };

    document.mountHead = () => {
        const head = new FakeElement('head');
        head.isConnected = true;
        document.head = head;
        return head;
    };

    if (headReady) document.mountHead();
    document.body.isConnected = true;
    document.documentElement.isConnected = true;
    document.documentElement.append(document.body);
    return document;
}

function runAppearance({reducedMotion = false, headReady = true, prepareDocument} = {}) {
    const scriptPath = path.join(__dirname, '..', 'native', 'webAppearance.js');
    if (!fs.existsSync(scriptPath)) {
        assert.fail('webAppearance.js has not been implemented');
    }

    const document = makeDocument({headReady});
    prepareDocument?.(document);
    const mutationObservers = [];
    class FakeMutationObserver {
        constructor(callback) {
            this.callback = callback;
            mutationObservers.push(this);
        }
        observe(target, options) {
            this.target = target;
            this.options = options;
        }
    }

    const timers = new Map();
    let nextTimerId = 0;
    let imageBehavior = 'success';
    const motionPreference = {matches: reducedMotion};
    const window = {
        document,
        matchMedia() { return motionPreference; },
    };
    const context = {
        console,
        document,
        window,
        MutationObserver: FakeMutationObserver,
        Node: {ELEMENT_NODE: 1},
        Image: class FakeImage {
            set src(value) {
                this.currentSrc = value;
                if (imageBehavior === 'success') this.onload?.();
                if (imageBehavior === 'error') this.onerror?.();
            }
        },
        getComputedStyle(element) {
            return {backgroundImage: element.computedBackgroundImage};
        },
        setTimeout(callback) {
            const id = ++nextTimerId;
            timers.set(id, callback);
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
    };
    window.window = window;
    window.setTimeout = context.setTimeout;
    window.clearTimeout = context.clearTimeout;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), context, {filename: 'webAppearance.js'});
    const runTimers = () => {
        for (const [id, callback] of [...timers]) {
            timers.delete(id);
            callback();
        }
    };
    return {
        context,
        document,
        mutationObservers,
        timers,
        runTimers,
        setImageBehavior(value) { imageBehavior = value; },
        setReducedMotion(value) { motionPreference.matches = value; },
    };
}

function ownedAppearanceStyles(document) {
    return document.head.children.filter(element => (
        element.tagName === 'STYLE'
        && element.getAttribute('data-tigerest-owned') === 'web-appearance'
    ));
}

function appearanceMutationObserver(document, mutationObservers) {
    return mutationObservers.find(observer => observer.target === document.documentElement);
}

function runNativeShell() {
    const document = makeDocument();
    const storage = new Map();
    const jmpInfo = {
        deviceName: 'Test Device',
        version: '0.0.0-test',
        mode: 'desktop',
        scriptPath: 'file:///test',
        sections: [],
        settingsDescriptions: {},
        settings: {
            main: {enableMPV: false, fullscreen: false},
            video: {},
            audio: {},
        },
    };
    const window = {
        document,
        jmpInfo,
        qt: {webChannelTransport: {}},
        sessionStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(key, String(value)); },
        },
    };
    window.window = window;
    const context = {
        console,
        document,
        window,
        jmpInfo,
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() {}
        },
        QWebChannel: class {},
        setTimeout() { return 1; },
        clearTimeout() {},
    };
    vm.createContext(context);
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '..', 'native', 'nativeshell.js'), 'utf8'),
        context,
        {filename: 'nativeshell.js'},
    );
    return window.NativeShell;
}

// Parse the plain-object WebEngineScript wiring inside Component.onCompleted.
// This protects our QML connection contract; Qt's build remains responsible
// for instantiating the component and validating the framework's enum types.
function extractBalancedSection(source, openingIndex) {
    const closingFor = {'{': '}', '[': ']', '(': ')'};
    const opening = source[openingIndex];
    const closing = closingFor[opening];
    assert.ok(closing, `unsupported opening delimiter ${opening}`);

    let depth = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = openingIndex; index < source.length; index++) {
        const character = source[index];
        const next = source[index + 1];
        if (lineComment) {
            if (character === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === '*' && next === '/') {
                blockComment = false;
                index++;
            }
            continue;
        }
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }
        if (character === '/' && next === '/') {
            lineComment = true;
            index++;
            continue;
        }
        if (character === '/' && next === '*') {
            blockComment = true;
            index++;
            continue;
        }
        if (character === '"' || character === '\'' || character === '`') {
            quote = character;
            continue;
        }
        if (character === opening) depth++;
        if (character !== closing) continue;
        depth--;
        if (depth === 0) {
            return {
                body: source.slice(openingIndex + 1, index),
                end: index,
            };
        }
    }
    assert.fail(`unterminated ${opening}${closing} section`);
}

function parseWebEngineScriptWiring(qmlSource) {
    const completedBlocks = [];
    const completedPattern = /\bComponent\.onCompleted\s*:/g;
    for (let match = completedPattern.exec(qmlSource); match; match = completedPattern.exec(qmlSource)) {
        const openingIndex = qmlSource.indexOf('{', match.index + match[0].length);
        assert.notStrictEqual(openingIndex, -1, 'Component.onCompleted has no body');
        const section = extractBalancedSection(qmlSource, openingIndex);
        if (/\bweb\s*\.\s*userScripts\s*\.\s*collection\s*=/.test(section.body)) {
            completedBlocks.push(section.body);
        }
        completedPattern.lastIndex = section.end + 1;
    }
    assert.strictEqual(completedBlocks.length, 1,
        'expected exactly one Component.onCompleted block to configure web.userScripts');
    const block = completedBlocks[0];

    const scriptsByVariable = new Map();
    const declarationPattern = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
    for (let match = declarationPattern.exec(block); match; match = declarationPattern.exec(block)) {
        const openingIndex = block.indexOf('{', match.index + match[0].length - 1);
        const section = extractBalancedSection(block, openingIndex);
        const property = name => {
            const propertyMatch = new RegExp(`(?:^|\\n)\\s*${name}\\s*:\\s*([^,\\r\\n}]+)`, 'm')
                .exec(section.body);
            return propertyMatch?.[1].replace(/\s+/g, '') || '';
        };
        const sourceCall = /^components\.system\.([A-Za-z_$][\w$]*)\(\)$/.exec(property('sourceCode'));
        const injectionPoint = /^WebEngineScript\.([A-Za-z_$][\w$]*)$/.exec(property('injectionPoint'));
        const worldId = /^WebEngineScript\.([A-Za-z_$][\w$]*)$/.exec(property('worldId'));
        scriptsByVariable.set(match[1], {
            sourceGetter: sourceCall?.[1] || '',
            injectionPoint: injectionPoint?.[1] || '',
            worldId: worldId?.[1] || '',
        });
        declarationPattern.lastIndex = section.end + 1;
    }

    const collectionPattern = /\bweb\s*\.\s*userScripts\s*\.\s*collection\s*=\s*\[/g;
    const collectionAssignments = [...block.matchAll(collectionPattern)];
    assert.strictEqual(collectionAssignments.length, 1,
        'web.userScripts.collection must be assigned exactly once');
    const collectionOpening = block.indexOf('[', collectionAssignments[0].index);
    const collection = extractBalancedSection(block, collectionOpening).body
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .map(variable => {
            assert.match(variable, /^[A-Za-z_$][\w$]*$/, `invalid script collection entry ${variable}`);
            assert.ok(scriptsByVariable.has(variable), `script collection references unknown variable ${variable}`);
            return {variable, ...scriptsByVariable.get(variable)};
        });
    return collection;
}

function webViewScriptWiring() {
    const qmlPath = path.join(__dirname, '..', 'src', 'ui', 'webview.qml');
    return parseWebEngineScriptWiring(fs.readFileSync(qmlPath, 'utf8'));
}

function testMountsAfterDocumentCreation() {
    const {document} = runAppearance({headReady: false});
    assert.strictEqual(document.getElementById('tigerest-appearance-style'), null);

    document.mountHead();
    document.dispatchEvent({type: 'DOMContentLoaded'});

    const style = document.getElementById('tigerest-appearance-style');
    assert.ok(style, 'appearance styles were not mounted when the document became ready');
    assert.ok(style.textContent.length > 500, 'appearance stylesheet was unexpectedly empty');
    assert.ok(document.body.classList.contains('tigerest-appearance-ready'));
}

function testUsesOwnedStyleWithoutTakingOverAConflictingServerStyle() {
    let serverStyle;
    const {document} = runAppearance({
        prepareDocument(currentDocument) {
            serverStyle = currentDocument.createElement('style');
            serverStyle.id = 'tigerest-appearance-style';
            serverStyle.textContent = '.server-owned { color: red; }';
            currentDocument.head.appendChild(serverStyle);
        },
    });

    const [appearanceStyle] = ownedAppearanceStyles(document);
    assert.ok(appearanceStyle, 'appearance stylesheet has no unique ownership marker');
    assert.notStrictEqual(appearanceStyle, serverStyle,
        'a server-owned style with a colliding id was mistaken for the native appearance style');
    assert.ok(document.head.children.includes(serverStyle), 'the colliding server style was removed');
    assert.strictEqual(serverStyle.textContent, '.server-owned { color: red; }');
}

function testRestoresDeletedOwnedStyleWithoutRemovingAnonymousServerStyles() {
    const {document, mutationObservers} = runAppearance();
    const observer = appearanceMutationObserver(document, mutationObservers);
    const [originalStyle] = ownedAppearanceStyles(document);
    const anonymousServerStyle = document.createElement('style');
    anonymousServerStyle.textContent = '.server-theme { color: teal; }';
    document.head.appendChild(anonymousServerStyle);

    document.head.removeChild(originalStyle);
    observer.callback([{
        type: 'childList',
        target: document.head,
        addedNodes: [],
        removedNodes: [originalStyle],
    }]);

    const [replacementStyle] = ownedAppearanceStyles(document);
    assert.ok(replacementStyle, 'deleted appearance stylesheet was not restored');
    assert.notStrictEqual(replacementStyle, originalStyle, 'the detached stylesheet was reused');
    assert.ok(replacementStyle.textContent.length > 500, 'restored appearance stylesheet is empty');
    assert.ok(document.head.children.includes(anonymousServerStyle),
        'self-healing removed an anonymous server or core stylesheet');
}

function testKeepsOwnedStyleLastAfterServerAddsAStylesheetWithoutObserverLoop() {
    const {document, mutationObservers} = runAppearance();
    const observer = appearanceMutationObserver(document, mutationObservers);
    const [appearanceStyle] = ownedAppearanceStyles(document);
    const laterServerStyle = document.createElement('style');
    laterServerStyle.textContent = '.late-server-theme { color: rebeccapurple; }';
    document.head.appendChild(laterServerStyle);

    observer.callback([{
        type: 'childList',
        target: document.head,
        addedNodes: [laterServerStyle],
        removedNodes: [],
    }]);

    assert.strictEqual(document.head.lastElementChild, appearanceStyle,
        'a later server stylesheet gained equal-specificity cascade priority');
    assert.ok(document.head.children.includes(laterServerStyle), 'the later server stylesheet was deleted');
    assert.strictEqual(ownedAppearanceStyles(document).length, 1, 'appearance stylesheet was duplicated');

    const appendCountAfterReorder = document.head.appendCount;
    observer.callback([{
        type: 'childList',
        target: document.head,
        addedNodes: [appearanceStyle],
        removedNodes: [appearanceStyle],
    }]);
    assert.strictEqual(document.head.appendCount, appendCountAfterReorder,
        'the observer re-appended an already-last style and can trigger itself forever');
}

function testNativeShellStillAdvertisesMultiserverSupport() {
    const nativeShell = runNativeShell();

    assert.strictEqual(nativeShell.AppHost.supports('multiserver'), true,
        'standard server custom CSS disabling no longer receives the multiserver capability');
    assert.strictEqual(nativeShell.AppHost.supports('MULTISERVER'), true,
        'multiserver capability lookup stopped being case-insensitive');
}

function testWebViewInjectsAppearanceOnceAtDocumentCreationInApplicationWorld() {
    const appearances = webViewScriptWiring()
        .filter(script => script.sourceGetter === 'getWebAppearanceScript');

    assert.strictEqual(appearances.length, 1, 'web appearance is not injected exactly once');
    assert.strictEqual(appearances[0].injectionPoint, 'DocumentCreation');
    assert.strictEqual(appearances[0].worldId, 'ApplicationWorld');
}

function testWebViewKeepsNativeShellOnceAtDocumentCreationInMainWorld() {
    const nativeShells = webViewScriptWiring()
        .filter(script => script.sourceGetter === 'getNativeShellScript');

    assert.strictEqual(nativeShells.length, 1, 'native shell is not injected exactly once');
    assert.strictEqual(nativeShells[0].injectionPoint, 'DocumentCreation');
    assert.strictEqual(nativeShells[0].worldId, 'MainWorld');
}

function testAnimatesVisiblePagesOnce() {
    const {document, runTimers} = runAppearance();
    const page = new FakeElement('div', ['mainAnimatedPage']);

    document.dispatchEvent({type: 'viewshow', target: page});
    assert.ok(!page.classList.contains('tigerest-page-enter'),
        'page animation started before Emby could measure its virtual grid');
    assert.ok(page.classList.contains('tigerest-page-pending'),
        'the destination page can flash its final frame during the measurement delay');
    runTimers();
    assert.ok(page.classList.contains('tigerest-page-enter'), 'visible page did not enter');
    assert.ok(!page.classList.contains('tigerest-page-pending'),
        'the hidden measurement state was not released when animation began');

    page.dispatchEvent({type: 'animationend', animationName: 'tigerestPageEnter'});
    assert.ok(!page.classList.contains('tigerest-page-enter'), 'page transition class was not cleaned up');
}

function testDoesNotAnimateWhenCardsLoadInsideCurrentPage() {
    const {mutationObservers} = runAppearance();
    const page = new FakeElement('div', ['mainAnimatedPage']);
    const shelf = new FakeElement('div', ['itemsContainer']);
    const card = new FakeElement('div', ['card']);
    page.append(shelf);
    shelf.append(card);

    mutationObservers[0].callback([{type: 'childList', target: shelf, addedNodes: [card]}]);

    assert.ok(!page.classList.contains('tigerest-page-enter'),
        'loading a card reanimated the existing page');
}

function testOnlyAnimatesPageVisibilityChanges() {
    const {mutationObservers} = runAppearance();
    const button = new FakeElement('button', ['detailButton']);

    mutationObservers[0].callback([{
        type: 'attributes',
        target: button,
        attributeName: 'class',
        oldValue: 'detailButton hide',
    }]);

    assert.ok(!button.classList.contains('tigerest-page-enter'),
        'a non-page control received the page transition');
}

function testNestedViewShowDoesNotReplayTheWholePage() {
    const {document, runTimers} = runAppearance();
    const page = new FakeElement('div', ['page']);
    const dialogContent = new FakeElement('div', ['dialogContent']);
    page.append(dialogContent);

    document.dispatchEvent({type: 'viewshow', target: dialogContent});
    runTimers();

    assert.ok(!page.classList.contains('tigerest-page-enter'),
        'a nested dialog or menu view replayed the whole route animation');
}

function testAnimatesNewlyInsertedPage() {
    const {mutationObservers, runTimers} = runAppearance();
    const page = new FakeElement('div', ['mainAnimatedPage']);

    mutationObservers[0].callback([{type: 'childList', addedNodes: [page]}]);
    runTimers();

    assert.ok(page.classList.contains('tigerest-page-enter'));
}

function testIgnoresBubbledChildAnimationEnd() {
    const {document, runTimers} = runAppearance();
    const page = new FakeElement('div', ['mainAnimatedPage']);
    const spinner = new FakeElement('div', ['spinner']);
    page.append(spinner);
    document.dispatchEvent({type: 'viewshow', target: page});
    runTimers();

    page.dispatchEvent({type: 'animationend', target: spinner, animationName: 'spin'});

    assert.ok(page.classList.contains('tigerest-page-enter'),
        'a child animation ended the page transition');
}

function testTimeoutCleansUpPageAnimation() {
    const {document, runTimers} = runAppearance();
    const page = new FakeElement('div', ['mainAnimatedPage']);
    document.dispatchEvent({type: 'viewshow', target: page});

    runTimers();
    assert.ok(page.classList.contains('tigerest-page-enter'));
    runTimers();

    assert.ok(!page.classList.contains('tigerest-page-enter'));
}

function testMajorPageAnimationDoesNotScaleVirtualGridWidth() {
    const {document} = runAppearance();
    const css = document.getElementById('tigerest-appearance-style').textContent;
    const pageKeyframes = css.slice(
        css.indexOf('@keyframes tigerestPageEnter'),
        css.indexOf('@keyframes tigerestTabEnterForward'),
    );

    assert.ok(!/scale\(/.test(pageKeyframes),
        'major route animation scales the page while Emby measures virtual card widths');
    assert.ok(/translate3d\(0,\s*72px/.test(pageKeyframes),
        'removing scale also removed the approved large route movement');
    assert.ok(/\.tigerest-page-pending[\s\S]*?visibility:\s*hidden/.test(css),
        'the geometry-safe delay does not hide the destination final frame');
}

function testPendingPageCannotRemainPermanentlyHidden() {
    const first = runAppearance();
    const firstPage = new FakeElement('div', ['page']);
    first.document.dispatchEvent({type: 'viewshow', target: firstPage});
    first.runTimers();
    assert.ok(firstPage.classList.contains('tigerest-page-enter'));
    first.document.dispatchEvent({type: 'viewshow', target: firstPage});
    assert.ok(!firstPage.classList.contains('tigerest-page-pending'),
        'an already animating page was hidden again');

    const second = runAppearance();
    const secondPage = new FakeElement('div', ['page']);
    second.document.dispatchEvent({type: 'viewshow', target: secondPage});
    second.setReducedMotion(true);
    second.runTimers();
    assert.ok(!secondPage.classList.contains('tigerest-page-pending'),
        'enabling reduced motion during the delay left the page hidden');
}

function testDetailHeaderHasBreathingRoom() {
    const {document} = runAppearance();
    const css = document.getElementById('tigerest-appearance-style').textContent;

    assert.ok(/\.detailMainContainer[\s\S]*?padding-top:\s*24px\s*!important/.test(css),
        'detail artwork and title still touch the application header');
    assert.ok(/\.detailNameContainer[\s\S]*?margin-bottom:\s*10px\s*!important/.test(css),
        'detail title and metadata remain vertically cramped');
    assert.ok(/\.mainDetailButtons[\s\S]*?margin-top:\s*14px\s*!important/.test(css),
        'detail actions do not have enough space above them');
}

function testUsesPageArtworkForAmbientBackground() {
    const {context, document} = runAppearance();
    const page = new FakeElement('div', ['mainAnimatedPage']);
    const artwork = new FakeElement('div', ['cardImageContainer']);
    artwork.computedBackgroundImage = 'url("https://media.example/poster.jpg")';
    page.append(artwork);

    context.updateTigerestAmbient(page);

    const firstImage = document.documentElement.style.getPropertyValue('--tgs-ambient-image-a')
        || document.documentElement.style.getPropertyValue('--tgs-ambient-image-b');
    assert.strictEqual(firstImage, 'url("https://media.example/poster.jpg")');
    const css = document.getElementById('tigerest-appearance-style').textContent;
    assert.ok(css.includes('var(--tgs-ambient-image-a)') && css.includes('var(--tgs-ambient-image-b)'),
        'the extracted artwork is not connected to the rendered background');
    assert.ok(/filter:\s*blur\(/.test(css), 'the ambient artwork is not blurred');
}

function activeAmbientImage(document) {
    const slot = document.documentElement.classList.contains('tigerest-ambient-phase-b') ? 'b' : 'a';
    return document.documentElement.style.getPropertyValue(`--tgs-ambient-image-${slot}`);
}

function testAmbientCrossfadesAndAvoidsPreviousArtwork() {
    const {context, document} = runAppearance();
    const firstPage = new FakeElement('div', ['page']);
    const repeatedArtwork = new FakeElement('div', ['cardImageContainer']);
    repeatedArtwork.computedBackgroundImage = 'url("https://media.example/a.jpg")';
    firstPage.append(repeatedArtwork);
    context.updateTigerestAmbient(firstPage);
    assert.strictEqual(activeAmbientImage(document), 'url("https://media.example/a.jpg")');

    const nextPage = new FakeElement('div', ['page']);
    const repeatedAgain = new FakeElement('div', ['cardImageContainer']);
    repeatedAgain.computedBackgroundImage = 'url("https://media.example/a.jpg")';
    const differentArtwork = new FakeElement('div', ['cardImageContainer']);
    differentArtwork.computedBackgroundImage = 'url("https://media.example/b.jpg")';
    nextPage.append(repeatedAgain, differentArtwork);
    context.updateTigerestAmbient(nextPage);

    assert.strictEqual(activeAmbientImage(document), 'url("https://media.example/b.jpg")',
        'a page switch reused the previous poster even though another poster was available');
    const css = document.getElementById('tigerest-appearance-style').textContent;
    assert.ok(/opacity\s+850ms/.test(css), 'ambient poster crossfade is not long enough to read visually');
}

function testAmbientRotatesFromRememberedArtworkOnAnEmptyTab() {
    const {context, document} = runAppearance();
    const populatedTab = new FakeElement('div', ['tabContent']);
    const firstArtwork = new FakeElement('div', ['cardImageContainer']);
    firstArtwork.computedBackgroundImage = 'url("https://media.example/pool-a.jpg")';
    const secondArtwork = new FakeElement('div', ['cardImageContainer']);
    secondArtwork.computedBackgroundImage = 'url("https://media.example/pool-b.jpg")';
    populatedTab.append(firstArtwork, secondArtwork);
    context.updateTigerestAmbient(populatedTab);
    assert.strictEqual(activeAmbientImage(document), 'url("https://media.example/pool-a.jpg")');

    const emptyTab = new FakeElement('div', ['tabContent']);
    assert.ok(context.updateTigerestAmbient(emptyTab),
        'an empty tab could not use previously discovered page artwork');
    assert.strictEqual(activeAmbientImage(document), 'url("https://media.example/pool-b.jpg")',
        'an empty tab did not rotate to a different remembered poster');
}

function testFailedOrTimedOutArtworkKeepsTheCurrentBackground() {
    const {context, document, runTimers, setImageBehavior, timers} = runAppearance();
    timers.clear();
    const makeRoot = url => {
        const root = new FakeElement('div', ['tabContent']);
        const artwork = new FakeElement('div', ['cardImageContainer']);
        artwork.computedBackgroundImage = `url("${url}")`;
        root.append(artwork);
        return root;
    };

    context.updateTigerestAmbient(makeRoot('https://media.example/good.jpg'));
    assert.strictEqual(activeAmbientImage(document), 'url("https://media.example/good.jpg")');

    setImageBehavior('error');
    context.updateTigerestAmbient(makeRoot('https://media.example/broken.jpg'));
    assert.strictEqual(activeAmbientImage(document), 'url("https://media.example/good.jpg")',
        'a failed preload replaced the working ambient background');

    setImageBehavior('pending');
    context.updateTigerestAmbient(makeRoot('https://media.example/slow.jpg'));
    runTimers();
    assert.strictEqual(activeAmbientImage(document), 'url("https://media.example/good.jpg")',
        'a preload timeout replaced the working ambient background before loading');
}

function testCardsFloatWithoutAThickBase() {
    const {document} = runAppearance();
    const css = document.getElementById('tigerest-appearance-style').textContent;

    assert.ok(/\.card\s*\{[\s\S]*?contain:\s*inline-size layout style\s*!important/.test(css),
        'card paint containment still clips the lifted artwork at its original top edge');
    assert.ok(/\.cardBox[\s\S]*?background:\s*transparent\s*!important/.test(css),
        'card box still paints a solid base behind the poster and title');
    assert.ok(/\.cardBox[\s\S]*?box-shadow:\s*none\s*!important/.test(css),
        'the full card box still casts the thick framed shadow');
    assert.ok(/translateY\(-12px\)[\s\S]*?scale\(1\.04\)/.test(css),
        'poster hover does not use the approved large lift and scale');
}

function testDrawerUsesGlassAndSubtleSelection() {
    const {document} = runAppearance();
    const css = document.getElementById('tigerest-appearance-style').textContent;

    assert.ok(/\.mainDrawer[\s\S]*?background:\s*rgba\(/.test(css),
        'the navigation drawer still uses an opaque surface');
    assert.ok(/\.mainDrawer[\s\S]*?backdrop-filter:\s*blur\(28px\)/.test(css),
        'the navigation drawer is missing the 28px glass blur');
    assert.ok(/\.navDrawerListItem:hover[\s\S]*?translateX\(6px\)/.test(css),
        'drawer items do not have the requested lateral hover motion');
}

function buildTabbedPage(document) {
    const slider = new FakeElement('div', ['tabs-viewmenubar-slider']);
    const buttons = [0, 1, 2].map(() => new FakeElement('button', ['emby-tab-button', 'main-tab-button']));
    buttons[0].classList.add('emby-tab-button-active');
    slider.append(...buttons);

    const page = new FakeElement('div', ['page']);
    const contents = [0, 1, 2].map(() => new FakeElement('div', ['tabContent']));
    contents[0].classList.add('is-active');
    const firstArtwork = new FakeElement('div', ['cardImageContainer']);
    firstArtwork.computedBackgroundImage = 'url("https://media.example/tab-a.jpg")';
    const lastArtwork = new FakeElement('div', ['cardImageContainer']);
    lastArtwork.computedBackgroundImage = 'url("https://media.example/tab-b.jpg")';
    contents[0].append(firstArtwork);
    contents[2].append(lastArtwork);
    page.append(...contents);
    document.body.append(slider, page);
    return {buttons, contents};
}

function activateTab(buttons, contents, index) {
    buttons.forEach(button => button.classList.remove('emby-tab-button-active'));
    contents.forEach(content => content.classList.remove('is-active'));
    buttons[index].classList.add('emby-tab-button-active');
    contents[index].classList.add('is-active');
}

function testTopTabsAnimateHorizontallyInClickDirection() {
    const {document, runTimers} = runAppearance();
    const {buttons, contents} = buildTabbedPage(document);

    document.dispatchEvent({type: 'click', target: buttons[2]});
    activateTab(buttons, contents, 2);
    runTimers();
    assert.ok(contents[2].classList.contains('tigerest-tab-enter-forward'),
        'a tab to the right did not enter from the right');
    assert.ok(!contents[2].classList.contains('tigerest-page-enter'),
        'top tab switching incorrectly used the major vertical page transition');
    contents[2].dispatchEvent({type: 'animationend', animationName: 'tigerestTabEnterForward'});

    document.dispatchEvent({type: 'click', target: buttons[0]});
    activateTab(buttons, contents, 0);
    runTimers();
    assert.ok(contents[0].classList.contains('tigerest-tab-enter-backward'),
        'a tab to the left did not enter from the left');
}

function testTopTabSwitchChangesAmbientPoster() {
    const {context, document, runTimers} = runAppearance();
    const {buttons, contents} = buildTabbedPage(document);
    context.updateTigerestAmbient(contents[0]);

    document.dispatchEvent({type: 'click', target: buttons[2]});
    activateTab(buttons, contents, 2);
    runTimers();
    runTimers();

    assert.strictEqual(activeAmbientImage(document), 'url("https://media.example/tab-b.jpg")',
        'top tab switching did not rotate the overall poster background');
}

function testRapidTabClicksDiscardStaleTransitions() {
    const {document, runTimers} = runAppearance();
    const {buttons, contents} = buildTabbedPage(document);

    document.dispatchEvent({type: 'click', target: buttons[2]});
    activateTab(buttons, contents, 2);
    document.dispatchEvent({type: 'click', target: buttons[1]});
    activateTab(buttons, contents, 1);
    runTimers();

    assert.ok(!contents[2].classList.contains('tigerest-tab-enter-forward'),
        'a stale rapid-click transition animated an inactive tab');
    assert.ok(contents[1].classList.contains('tigerest-tab-enter-backward'),
        'the most recent rapid-click direction was not preserved');
}

function testNestedTabContentIsNotMistakenForTopLevelContent() {
    const {document, runTimers} = runAppearance();
    const {buttons, contents} = buildTabbedPage(document);
    const nestedContent = new FakeElement('div', ['tabContent']);
    contents[0].append(nestedContent);

    document.dispatchEvent({type: 'click', target: buttons[1]});
    activateTab(buttons, contents, 1);
    runTimers();

    assert.ok(contents[1].classList.contains('tigerest-tab-enter-forward'));
    assert.ok(!nestedContent.classList.contains('tigerest-tab-enter-forward'),
        'a nested tab panel received the top navigation animation');
}

function testReducedMotionRulesDoNotDisableServerAnimations() {
    const {document} = runAppearance();
    const css = document.getElementById('tigerest-appearance-style').textContent;
    const reducedMotionRules = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));

    assert.ok(!/(^|\n)\s*\*,\s*($|\n)/.test(reducedMotionRules),
        'reduced motion globally overrides the server UI');
}

function testRespectsReducedMotion() {
    const {document} = runAppearance({reducedMotion: true});
    const page = new FakeElement('div', ['mainAnimatedPage']);

    document.dispatchEvent({type: 'viewshow', target: page});

    assert.ok(!page.classList.contains('tigerest-page-enter'));
}

testMountsAfterDocumentCreation();
testNativeShellStillAdvertisesMultiserverSupport();
testWebViewInjectsAppearanceOnceAtDocumentCreationInApplicationWorld();
testWebViewKeepsNativeShellOnceAtDocumentCreationInMainWorld();
testUsesOwnedStyleWithoutTakingOverAConflictingServerStyle();
testRestoresDeletedOwnedStyleWithoutRemovingAnonymousServerStyles();
testKeepsOwnedStyleLastAfterServerAddsAStylesheetWithoutObserverLoop();
testAnimatesVisiblePagesOnce();
testDoesNotAnimateWhenCardsLoadInsideCurrentPage();
testOnlyAnimatesPageVisibilityChanges();
testNestedViewShowDoesNotReplayTheWholePage();
testAnimatesNewlyInsertedPage();
testIgnoresBubbledChildAnimationEnd();
testTimeoutCleansUpPageAnimation();
testMajorPageAnimationDoesNotScaleVirtualGridWidth();
testPendingPageCannotRemainPermanentlyHidden();
testDetailHeaderHasBreathingRoom();
testUsesPageArtworkForAmbientBackground();
testAmbientCrossfadesAndAvoidsPreviousArtwork();
testAmbientRotatesFromRememberedArtworkOnAnEmptyTab();
testFailedOrTimedOutArtworkKeepsTheCurrentBackground();
testCardsFloatWithoutAThickBase();
testDrawerUsesGlassAndSubtleSelection();
testTopTabsAnimateHorizontallyInClickDirection();
testTopTabSwitchChangesAmbientPoster();
testRapidTabClicksDiscardStaleTransitions();
testNestedTabContentIsNotMistakenForTopLevelContent();
testReducedMotionRulesDoNotDisableServerAnimations();
testRespectsReducedMotion();
console.log('web appearance: all checks passed');
