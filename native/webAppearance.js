const TIGEREST_APPEARANCE_STYLE_ID = 'tigerest-appearance-style';
const TIGEREST_PAGE_SELECTOR = '.mainAnimatedPage, .page';
const TIGEREST_PAGE_ENTER_CLASS = 'tigerest-page-enter';
const TIGEREST_PAGE_PENDING_CLASS = 'tigerest-page-pending';
const TIGEREST_TAB_BUTTON_SELECTOR = '.main-tab-button';
const TIGEREST_TAB_CONTENT_SELECTOR = '.tabContent';
const TIGEREST_ARTWORK_SELECTOR = '.detailImageContainer, .cardImageContainer, .primaryImage, img.cardImage, .backdropImage';
const tigerestMotionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)') || {matches: false};
let tigerestAmbientImage = '';
let tigerestAmbientPhase = 'b';
let tigerestAmbientRequest = 0;
let tigerestAmbientGeneration = 0;
let tigerestAmbientPool = [];
let tigerestSuppressPageAnimationUntil = 0;
let tigerestTabTransitionGeneration = 0;
const tigerestPageAnimationTimers = new WeakMap();
const tigerestTabAnimationStates = new WeakMap();

function mountTigerestAppearanceStyles() {
    if (!document.head) return false;

    if (!document.getElementById(TIGEREST_APPEARANCE_STYLE_ID)) {
        const style = document.createElement('style');
        style.id = TIGEREST_APPEARANCE_STYLE_ID;
        style.textContent = `
            :root {
                --tgs-accent: #ffbe38;
                --tgs-accent-soft: rgba(255, 190, 56, .16);
                --tgs-panel: rgba(20, 23, 31, .72);
                --tgs-panel-strong: rgba(17, 20, 27, .88);
                --tgs-panel-border: rgba(255, 255, 255, .10);
                --tgs-text-soft: rgba(255, 255, 255, .72);
                --tgs-shadow: 0 18px 48px rgba(0, 0, 0, .32);
                --tgs-shadow-soft: 0 10px 30px rgba(0, 0, 0, .22);
                --tgs-radius: 14px;
                --tgs-ease: cubic-bezier(.22, 1, .36, 1);
                --tgs-ambient-image-a: none;
                --tgs-ambient-image-b: none;
            }

            html,
            body {
                background-color: #0b0d12 !important;
            }

            body.tigerest-appearance-ready {
                color-scheme: dark;
            }

            .backgroundContainer {
                position: fixed;
                overflow: hidden;
                background-color: #0b0d12 !important;
                background-image: none !important;
                isolation: isolate;
            }

            .backgroundContainer::before,
            .backgroundContainer::after {
                content: '';
                position: absolute;
                z-index: 0;
                top: -12%;
                right: -12%;
                bottom: -12%;
                left: -12%;
                background-image:
                    linear-gradient(180deg, rgba(7, 10, 16, .32), rgba(8, 11, 17, .58)),
                    var(--tgs-ambient-image-a),
                    radial-gradient(circle at 10% -10%, rgba(255, 190, 56, .08), transparent 32rem),
                    radial-gradient(circle at 90% 12%, rgba(67, 133, 255, .18), transparent 38rem),
                    linear-gradient(145deg, #111927 0%, #17263b 54%, #11151d 100%);
                background-position: center;
                background-size: cover;
                filter: blur(58px) saturate(1.42) brightness(.78);
                transform: scale(1.16);
                opacity: .92;
                transition: opacity 850ms var(--tgs-ease), filter 850ms ease, transform 850ms var(--tgs-ease);
            }

            .backgroundContainer::after {
                background-image:
                    linear-gradient(180deg, rgba(7, 10, 16, .32), rgba(8, 11, 17, .58)),
                    var(--tgs-ambient-image-b),
                    radial-gradient(circle at 88% -8%, rgba(255, 190, 56, .07), transparent 32rem),
                    radial-gradient(circle at 12% 16%, rgba(67, 133, 255, .18), transparent 38rem),
                    linear-gradient(215deg, #111927 0%, #17263b 54%, #11151d 100%);
                opacity: 0;
            }

            html.tigerest-ambient-phase-b .backgroundContainer::before {
                opacity: 0;
                transform: scale(1.19);
            }

            html.tigerest-ambient-phase-b .backgroundContainer::after {
                opacity: .92;
                transform: scale(1.16);
            }

            .backgroundContainer.withBackdrop {
                background-color: transparent !important;
                background-image: none !important;
            }

            .backdropImage {
                transform: scale(1.015);
                filter: saturate(.92) contrast(1.03);
                animation: tigerestBackdropEnter 420ms var(--tgs-ease) both;
            }

            .skinHeader,
            .skinHeader-withBackground,
            .headerTop {
                background: rgba(13, 16, 22, .52) !important;
                border-bottom: 1px solid rgba(255, 255, 255, .075);
                box-shadow: 0 8px 28px rgba(0, 0, 0, .16);
            }

            .skinHeader.semiTransparent,
            .skinHeader-withBackground.semiTransparent {
                background: rgba(13, 16, 22, .44) !important;
            }

            .headerTabs,
            .emby-tabs-slider {
                background: transparent !important;
            }

            .emby-tab-button {
                position: relative;
                opacity: .72;
                transition: color 180ms ease, opacity 180ms ease, transform 180ms var(--tgs-ease);
            }

            .emby-tab-button:hover,
            .emby-tab-button:focus,
            .emby-tab-button-active {
                opacity: 1;
                transform: translateY(-1px);
            }

            .emby-tab-button:focus-visible {
                opacity: 1;
                transform: translateY(-1px);
            }

            .emby-tab-button-active {
                color: #fff !important;
            }

            .emby-tab-button-active::after {
                content: '';
                position: absolute;
                right: 22%;
                bottom: .18em;
                left: 22%;
                height: 2px;
                border-radius: 999px;
                background: var(--tgs-accent);
                box-shadow: 0 0 14px rgba(255, 190, 56, .44);
            }

            .dialog,
            .promptDialog,
            .actionSheet,
            .toast,
            .paperList,
            .formDialogHeader,
            .formDialogFooter {
                border: 1px solid var(--tgs-panel-border) !important;
                background: var(--tgs-panel-strong) !important;
                box-shadow: var(--tgs-shadow) !important;
            }

            .dialog,
            .promptDialog,
            .actionSheet,
            .paperList {
                border-radius: var(--tgs-radius) !important;
            }

            .toast {
                border-radius: 999px !important;
                padding-right: 1.2em !important;
                padding-left: 1.2em !important;
            }

            .formDialogHeader {
                border-bottom: 1px solid rgba(255, 255, 255, .08) !important;
            }

            .formDialogFooter {
                border-top: 1px solid rgba(255, 255, 255, .08) !important;
            }

            .detailRibbon,
            .detailPagePrimaryContainer {
                background-color: rgba(12, 15, 21, .28) !important;
                border-color: rgba(255, 255, 255, .07) !important;
            }

            .detailMainContainer {
                padding-top: 24px !important;
                padding-bottom: 18px !important;
            }

            .detailTextContainer {
                padding-top: 6px !important;
            }

            .detailNameContainer {
                margin-bottom: 10px !important;
            }

            .detail-mediaInfoPrimary {
                margin-bottom: 4px !important;
            }

            .mainDetailButtons {
                margin-top: 14px !important;
                margin-bottom: 14px !important;
            }

            .overview-container {
                margin-top: 10px !important;
            }

            .card {
                contain: inline-size layout style !important;
            }

            .portraitCard .cardBox,
            .backdropCard .cardBox,
            .squareCard .cardBox,
            .visualCardBox {
                border-radius: 16px;
                background: transparent !important;
                box-shadow: none !important;
                transition:
                    transform 420ms var(--tgs-ease),
                    filter 360ms ease;
            }

            .cardImageContainer,
            .cardContent-button,
            .cardOverlayContainer {
                border-radius: 16px !important;
            }

            .cardImageContainer {
                overflow: hidden;
                box-shadow: 0 8px 24px rgba(0, 0, 0, .24);
                transition: box-shadow 420ms var(--tgs-ease), filter 360ms ease;
            }

            .cardImageContainer::after {
                content: '';
                position: absolute;
                top: 0;
                right: 0;
                bottom: 0;
                left: 0;
                pointer-events: none;
                border: 1px solid rgba(255, 255, 255, .09);
                border-radius: inherit;
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, .07);
            }

            .portraitCard:hover .cardBox,
            .portraitCard:focus-within .cardBox,
            .backdropCard:hover .cardBox,
            .backdropCard:focus-within .cardBox,
            .squareCard:hover .cardBox,
            .squareCard:focus-within .cardBox {
                transform: translateY(-12px) scale(1.04);
                filter: brightness(1.07) saturate(1.06);
                box-shadow: none !important;
            }

            .card:hover .cardImageContainer,
            .card:focus-within .cardImageContainer {
                box-shadow:
                    0 24px 54px rgba(0, 0, 0, .46),
                    0 0 28px rgba(91, 151, 255, .20),
                    0 0 0 1px rgba(255, 255, 255, .10);
            }

            .card:hover,
            .card:focus-within {
                z-index: 3;
            }

            .cardText,
            .cardTextCentered,
            .cardFooter {
                background: transparent !important;
                box-shadow: none !important;
            }

            .listItem {
                border-radius: 11px;
                transition: background-color 160ms ease, transform 180ms var(--tgs-ease);
            }

            .listItem:hover,
            .listItem:focus-within {
                background-color: rgba(255, 255, 255, .055) !important;
                transform: translateX(2px);
            }

            .mainDrawer {
                background: rgba(15, 19, 27, .66) !important;
                border-right: 1px solid rgba(255, 255, 255, .11);
                box-shadow: 18px 0 54px rgba(0, 0, 0, .36) !important;
            }

            .mainDrawer .navDrawerListItem {
                margin-right: .65em;
                margin-left: .65em;
                border: 1px solid transparent;
                border-radius: 12px;
                transition: background-color 220ms ease, border-color 220ms ease, transform 300ms var(--tgs-ease);
            }

            .mainDrawer .navDrawerListItem:hover,
            .mainDrawer .navDrawerListItem:focus-within {
                background: rgba(255, 255, 255, .075) !important;
                border-color: rgba(255, 255, 255, .07);
                transform: translateX(6px);
            }

            .mainDrawer .navDrawerListItem.navMenuOption-selected {
                background: rgba(73, 154, 91, .40) !important;
                border-color: rgba(143, 221, 155, .20);
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, .08);
            }

            .raised,
            .button-submit,
            .fab {
                border-radius: 11px !important;
                box-shadow: 0 8px 22px rgba(0, 0, 0, .22);
                transition: transform 160ms var(--tgs-ease), box-shadow 160ms ease, filter 160ms ease;
            }

            .raised:hover,
            .button-submit:hover,
            .fab:hover {
                transform: translateY(-1px);
                filter: brightness(1.05);
                box-shadow: 0 11px 28px rgba(0, 0, 0, .28);
            }

            .paper-icon-button-light,
            .headerButton {
                transition: color 150ms ease, background-color 150ms ease, transform 180ms var(--tgs-ease);
            }

            .paper-icon-button-light:hover,
            .headerButton:hover {
                background-color: rgba(255, 255, 255, .075) !important;
                transform: scale(1.045);
            }

            .emby-input,
            .emby-textarea,
            .emby-select-withcolor,
            .selectArrowContainer {
                border-color: rgba(255, 255, 255, .14) !important;
                border-radius: 10px !important;
                background-color: rgba(255, 255, 255, .055) !important;
                transition: border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease;
            }

            .emby-input:focus,
            .emby-textarea:focus,
            .emby-select-withcolor:focus {
                border-color: rgba(255, 190, 56, .70) !important;
                background-color: rgba(255, 255, 255, .075) !important;
                box-shadow: 0 0 0 3px var(--tgs-accent-soft) !important;
            }

            :focus-visible {
                outline-color: var(--tgs-accent) !important;
            }

            ::-webkit-scrollbar {
                width: 10px;
                height: 10px;
            }

            ::-webkit-scrollbar-track {
                background: transparent;
            }

            ::-webkit-scrollbar-thumb {
                min-height: 42px;
                border: 3px solid transparent;
                border-radius: 999px;
                background: rgba(255, 255, 255, .22);
                background-clip: padding-box;
            }

            ::-webkit-scrollbar-thumb:hover {
                background: rgba(255, 255, 255, .34);
                background-clip: padding-box;
            }

            .tigerest-page-enter {
                visibility: visible !important;
                animation: tigerestPageEnter 620ms var(--tgs-ease) 80ms both !important;
                transform-origin: 50% 42%;
                will-change: opacity, filter, transform;
            }

            .tigerest-page-pending {
                visibility: hidden !important;
                opacity: 0 !important;
                filter: blur(12px);
                clip-path: inset(7% 0 0 0 round 18px);
            }

            .tigerest-tab-enter-forward,
            .tigerest-tab-enter-backward {
                transform-origin: center;
                will-change: opacity, filter, transform;
            }

            .tigerest-tab-enter-forward {
                animation: tigerestTabEnterForward 520ms var(--tgs-ease) both !important;
            }

            .tigerest-tab-enter-backward {
                animation: tigerestTabEnterBackward 520ms var(--tgs-ease) both !important;
            }

            @keyframes tigerestPageEnter {
                0% {
                    opacity: .08;
                    filter: blur(12px);
                    clip-path: inset(7% 0 0 0 round 18px);
                    transform: translate3d(0, 72px, 0);
                }
                72% {
                    opacity: 1;
                    filter: blur(0);
                    clip-path: inset(0 0 0 0 round 0);
                    transform: translate3d(0, -9px, 0);
                }
                100% {
                    opacity: 1;
                    filter: blur(0);
                    clip-path: inset(0 0 0 0 round 0);
                    transform: translate3d(0, 0, 0);
                }
            }

            @keyframes tigerestTabEnterForward {
                0% { opacity: .06; filter: blur(11px); transform: translate3d(120px, 0, 0) scale(.94); }
                72% { opacity: 1; filter: blur(0); transform: translate3d(-13px, 0, 0) scale(1.012); }
                100% { opacity: 1; filter: blur(0); transform: translate3d(0, 0, 0) scale(1); }
            }

            @keyframes tigerestTabEnterBackward {
                0% { opacity: .06; filter: blur(11px); transform: translate3d(-120px, 0, 0) scale(.94); }
                72% { opacity: 1; filter: blur(0); transform: translate3d(13px, 0, 0) scale(1.012); }
                100% { opacity: 1; filter: blur(0); transform: translate3d(0, 0, 0) scale(1); }
            }

            @keyframes tigerestBackdropEnter {
                from { opacity: .45; transform: scale(1.035); }
                to { opacity: 1; transform: scale(1.015); }
            }

            @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
                .skinHeader,
                .skinHeader-withBackground,
                .headerTop,
                .dialog,
                .promptDialog,
                .actionSheet,
                .toast,
                .paperList,
                .formDialogHeader,
                .formDialogFooter,
                .detailRibbon,
                .mainDrawer {
                    -webkit-backdrop-filter: blur(20px) saturate(1.32);
                    backdrop-filter: blur(20px) saturate(1.32);
                }

                .mainDrawer {
                    -webkit-backdrop-filter: blur(28px) saturate(1.38);
                    backdrop-filter: blur(28px) saturate(1.38);
                }

                .dialog,
                .promptDialog,
                .actionSheet,
                .toast,
                .paperList {
                    background: var(--tgs-panel) !important;
                }
            }

            @media (prefers-reduced-motion: reduce) {
                .emby-tab-button,
                .cardBox,
                .cardImageContainer,
                .listItem,
                .mainDrawer .navDrawerListItem,
                .raised,
                .button-submit,
                .fab,
                .paper-icon-button-light,
                .headerButton,
                .emby-input,
                .emby-textarea,
                .emby-select-withcolor,
                .selectArrowContainer {
                    transition-duration: .01ms !important;
                }

                .backgroundContainer::before,
                .backgroundContainer::after {
                    transform: none !important;
                    transition: none !important;
                }

                .tigerest-page-enter,
                .tigerest-tab-enter-forward,
                .tigerest-tab-enter-backward,
                .backdropImage {
                    animation: none !important;
                    transform: none !important;
                }

                .tigerest-page-pending {
                    visibility: visible !important;
                    opacity: 1 !important;
                    filter: none !important;
                    clip-path: none !important;
                }
            }
        `;
        document.head.appendChild(style);
    }

    document.body?.classList.add('tigerest-appearance-ready');
    return true;
}

function findTigerestPage(start) {
    if (start?.matches?.(TIGEREST_PAGE_SELECTOR)) return start;
    return start?.closest?.(TIGEREST_PAGE_SELECTOR) || null;
}

function animateTigerestPage(page) {
    if (!page) return;
    page.classList.remove(TIGEREST_PAGE_PENDING_CLASS);
    if (tigerestMotionPreference.matches
        || Date.now() < tigerestSuppressPageAnimationUntil
        || page.classList.contains(TIGEREST_PAGE_ENTER_CLASS)) return;

    page.classList.add(TIGEREST_PAGE_ENTER_CLASS);
    let cleanupTimer = 0;
    function cleanup() {
        if (cleanupTimer) clearTimeout(cleanupTimer);
        cleanupTimer = 0;
        page.removeEventListener('animationend', onAnimationEnd);
        page.classList.remove(TIGEREST_PAGE_PENDING_CLASS);
        page.classList.remove(TIGEREST_PAGE_ENTER_CLASS);
    }
    function onAnimationEnd(event) {
        if (event.target === page && event.animationName === 'tigerestPageEnter') cleanup();
    }
    page.addEventListener('animationend', onAnimationEnd);
    cleanupTimer = setTimeout(cleanup, 820);
}

function scheduleTigerestPageAnimation(page) {
    if (!page) return;
    if (tigerestMotionPreference.matches
        || Date.now() < tigerestSuppressPageAnimationUntil
        || page.classList.contains(TIGEREST_PAGE_ENTER_CLASS)) {
        page.classList.remove(TIGEREST_PAGE_PENDING_CLASS);
        return;
    }

    page.classList.add(TIGEREST_PAGE_PENDING_CLASS);
    const pending = tigerestPageAnimationTimers.get(page);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
        tigerestPageAnimationTimers.delete(page);
        if (!page.classList.contains('hide')) animateTigerestPage(page);
        else page.classList.remove(TIGEREST_PAGE_PENDING_CLASS);
    }, 180);
    tigerestPageAnimationTimers.set(page, timer);
}

function tigerestArtworkImage(element) {
    const backgroundImage = getComputedStyle(element).backgroundImage;
    if (backgroundImage && backgroundImage !== 'none') return backgroundImage;

    const source = element.currentSrc || element.src;
    return source ? `url(${JSON.stringify(source)})` : '';
}

function tigerestArtworkUrl(image) {
    const match = /url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/.exec(image || '');
    return match ? (match[1] || match[2] || match[3] || '').trim() : '';
}

function applyTigerestAmbient(image, request, generation) {
    if (request !== tigerestAmbientRequest || generation !== tigerestAmbientGeneration) return;

    tigerestAmbientPhase = tigerestAmbientPhase === 'a' ? 'b' : 'a';
    const root = document.documentElement;
    root.style.setProperty(`--tgs-ambient-image-${tigerestAmbientPhase}`, image);
    root.classList.toggle?.('tigerest-ambient-phase-b', tigerestAmbientPhase === 'b');
    if (!root.classList.toggle) {
        if (tigerestAmbientPhase === 'b') root.classList.add('tigerest-ambient-phase-b');
        else root.classList.remove('tigerest-ambient-phase-b');
    }
    root.classList.add('tigerest-has-ambient');
    tigerestAmbientImage = image;
}

function preloadTigerestAmbient(image, request, generation) {
    const source = tigerestArtworkUrl(image);
    if (!source || typeof Image !== 'function') {
        applyTigerestAmbient(image, request, generation);
        return;
    }

    const loader = new Image();
    let settled = false;
    let timeoutTimer = 0;
    const succeed = () => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        applyTigerestAmbient(image, request, generation);
    };
    const fail = () => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (request === tigerestAmbientRequest && generation === tigerestAmbientGeneration) {
            tigerestAmbientPool = tigerestAmbientPool.filter(candidate => candidate !== image);
        }
    };
    loader.onload = succeed;
    loader.onerror = fail;
    timeoutTimer = setTimeout(fail, 900);
    loader.src = source;
}

function updateTigerestAmbient(root, generation) {
    if (generation === undefined) generation = ++tigerestAmbientGeneration;
    if (generation !== tigerestAmbientGeneration) return false;

    const candidates = [];
    if (root?.matches?.(TIGEREST_ARTWORK_SELECTOR)) candidates.push(root);
    candidates.push(...(root?.querySelectorAll?.(TIGEREST_ARTWORK_SELECTOR) || []));

    const images = [];
    for (const candidate of candidates) {
        const image = tigerestArtworkImage(candidate);
        if (image && !images.includes(image)) images.push(image);
    }
    for (const image of images) {
        if (!tigerestAmbientPool.includes(image)) tigerestAmbientPool.push(image);
    }
    if (tigerestAmbientPool.length > 48) tigerestAmbientPool = tigerestAmbientPool.slice(-48);
    if (!tigerestAmbientPool.length) return false;

    const choices = [...images, ...tigerestAmbientPool];
    const image = choices.find(candidate => candidate !== tigerestAmbientImage) || choices[0];
    const request = ++tigerestAmbientRequest;
    preloadTigerestAmbient(image, request, generation);
    return true;
}

function scheduleTigerestAmbient(root) {
    const generation = ++tigerestAmbientGeneration;
    let attempts = 0;
    const tryUpdate = () => {
        if (generation !== tigerestAmbientGeneration) return;
        if (updateTigerestAmbient(root, generation)) return;
        attempts += 1;
        if (attempts < 10) setTimeout(tryUpdate, 160);
    };
    setTimeout(tryUpdate, 40);
}

function currentTigerestPage() {
    return [...document.querySelectorAll(TIGEREST_PAGE_SELECTOR)]
        .find(page => !page.classList.contains('hide')) || null;
}

function animateTigerestTab(content, direction) {
    if (tigerestMotionPreference.matches || !content) return;

    tigerestTabAnimationStates.get(content)?.cleanup();
    const className = direction > 0 ? 'tigerest-tab-enter-forward' : 'tigerest-tab-enter-backward';
    const animationName = direction > 0 ? 'tigerestTabEnterForward' : 'tigerestTabEnterBackward';
    content.classList.remove('tigerest-tab-enter-forward', 'tigerest-tab-enter-backward');
    void content.offsetWidth;
    content.classList.add(className);

    let cleanupTimer = 0;
    let finished = false;
    function cleanup() {
        if (finished) return;
        finished = true;
        if (cleanupTimer) clearTimeout(cleanupTimer);
        cleanupTimer = 0;
        content.removeEventListener('animationend', onAnimationEnd);
        content.classList.remove(className);
        if (tigerestTabAnimationStates.get(content)?.cleanup === cleanup) {
            tigerestTabAnimationStates.delete(content);
        }
    }
    function onAnimationEnd(event) {
        if (event.target === content && event.animationName === animationName) cleanup();
    }
    content.addEventListener('animationend', onAnimationEnd);
    cleanupTimer = setTimeout(cleanup, 720);
    tigerestTabAnimationStates.set(content, {cleanup});
}

function handleTigerestTabClick(event) {
    const target = event.target?.closest?.(TIGEREST_TAB_BUTTON_SELECTOR);
    const slider = target?.closest?.('.tabs-viewmenubar-slider');
    if (!target || !slider) return;

    const buttons = [...slider.querySelectorAll(TIGEREST_TAB_BUTTON_SELECTOR)];
    const sourceIndex = buttons.findIndex(button => button.classList.contains('emby-tab-button-active'));
    const targetIndex = buttons.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;

    const direction = targetIndex > sourceIndex ? 1 : -1;
    const originalPage = currentTigerestPage();
    const generation = ++tigerestTabTransitionGeneration;
    tigerestSuppressPageAnimationUntil = Date.now() + 900;

    let attempts = 0;
    const finishSwitch = () => {
        if (generation !== tigerestTabTransitionGeneration) return;
        const activeIndex = buttons.findIndex(button => button.classList.contains('emby-tab-button-active'));
        if (activeIndex !== targetIndex && attempts++ < 8) {
            setTimeout(finishSwitch, 45);
            return;
        }
        if (activeIndex !== targetIndex) return;

        const page = originalPage && !originalPage.classList.contains('hide')
            ? originalPage
            : currentTigerestPage();
        const contents = [...(page?.children || [])]
            .filter(candidate => candidate.matches?.(TIGEREST_TAB_CONTENT_SELECTOR));
        const content = contents.find(candidate => candidate.classList.contains('is-active'))
            || contents[targetIndex];
        animateTigerestTab(content, direction);
        scheduleTigerestAmbient(content || page || document);
    };
    setTimeout(finishSwitch, 32);
}

function observeTigerestPages() {
    if (!document.documentElement) return;

    const observer = new MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'attributes') {
                if (!record.target.matches?.(TIGEREST_PAGE_SELECTOR)) continue;
                const currentClasses = record.target.classList;
                const wasHidden = /(^|\s)hide(\s|$)/.test(record.oldValue || '');
                if (wasHidden && !currentClasses.contains('hide')) {
                    scheduleTigerestPageAnimation(record.target);
                    scheduleTigerestAmbient(record.target);
                }
                continue;
            }

            for (const node of record.addedNodes || []) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                const page = node.matches?.(TIGEREST_PAGE_SELECTOR) ? node : null;
                if (page && !page.classList.contains('hide')) {
                    scheduleTigerestPageAnimation(page);
                    scheduleTigerestAmbient(page);
                }
                for (const child of node.querySelectorAll?.(TIGEREST_PAGE_SELECTOR) || []) {
                    if (!child.classList.contains('hide')) {
                        scheduleTigerestPageAnimation(child);
                        scheduleTigerestAmbient(child);
                    }
                }
            }
        }
    });
    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
        attributeOldValue: true,
        childList: true,
        subtree: true,
    });
}

function initializeTigerestAppearance() {
    mountTigerestAppearanceStyles();
    observeTigerestPages();
    scheduleTigerestAmbient(document);

    document.addEventListener('click', handleTigerestTabClick, true);

    document.addEventListener('viewshow', event => {
        const page = event.target?.matches?.(TIGEREST_PAGE_SELECTOR) ? event.target : null;
        if (!page) return;
        scheduleTigerestPageAnimation(page);
        scheduleTigerestAmbient(page);
    }, true);
}

if (document.head && document.documentElement) {
    initializeTigerestAppearance();
} else {
    document.addEventListener('DOMContentLoaded', initializeTigerestAppearance, {once: true});
}
