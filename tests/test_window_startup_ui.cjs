// Real application/QWebChannel regression: MPV startup must not override the
// home preference, and manual window controls must not change that preference.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const withBrowser = require('./community_browser.cjs');

(async () => {
    const results = [];
    for (const initial of [false, true]) {
        let settingsFile, persisted;
        await withBrowser({'/': {type: 'text/html', body: `<!doctype html>
            <title>Isolated window preference check</title>
            <div class="headerRight"><button class="headerUserButton">Account</button></div>
            <div class="tg-home"><button data-tigerest-window-mode></button></div>`}}, async ({evaluate}) => {
            const result = await evaluate(`(${(async initial => {
                await window.initCompleted;
                // Include the asynchronously delivered initial MPV property.
                await new Promise(resolve => setTimeout(resolve, 500));
                for (let i = 0; i < 100 && !document.querySelector('[data-tigerest-window-mode] .tigerest-window-label'); i++)
                    await new Promise(resolve => setTimeout(resolve, 25));
                const startup = await api.window.isFullScreen();
                const button = document.querySelector('[data-tigerest-window-mode]');
                button.click();
                // Native fullscreen changes are animated on macOS and can take
                // seconds on a loaded runner; stay within the 15 s CDP call.
                for (let i = 0; i < 160; i++) {
                    if (await api.window.isFullScreen() !== startup && button.getAttribute('aria-pressed') === String(!startup)) break;
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                const afterButton = await api.window.isFullScreen();
                const preference = jmpInfo.settings.home.startupFullscreen;
                button.click();
                for (let i = 0; i < 160; i++) {
                    if (await api.window.isFullScreen() === initial && !button.disabled) break;
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                const beforePreference = await api.window.isFullScreen();
                // Use the same settings proxy as the actual settings page.
                jmpInfo.settings.home.startupFullscreen = !initial;
                await new Promise(resolve => setTimeout(resolve, 150));
                return {startup, afterButton, preference, beforePreference, afterPreference: await api.window.isFullScreen()};
            }).toString()})(${initial})`);
            assert.equal(result.startup, initial, 'startup preference survives the initial MPV fullscreen property');
            assert.equal(result.afterButton, !initial, 'shipped home button changes the actual native window');
            assert.equal(result.preference, initial, 'manual toggle keeps the startup preference');
            assert.equal(result.beforePreference, initial, 'return to the mode opposite the new preference');
            assert.equal(result.afterPreference, initial, 'saving preference does not change current window');
            persisted = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            assert.equal(persisted.sections.home.startupFullscreen, !initial, 'preference persisted to disk');
            results.push({initial, ...result, savedPreference: !initial});
        }, {settings: {home: {startupFullscreen: initial}, main: {fullscreen: !initial}},
            prepareProfile: async (_, folder, file) => {settingsFile = file;}});

        await withBrowser({'/': {type: 'text/html', body: '<!doctype html><title>Isolated preference restart</title>'}}, async ({evaluate}) => {
            const restarted = await evaluate(`(async () => {
                await window.initCompleted;
                await new Promise(resolve => setTimeout(resolve, 500));
                return await api.window.isFullScreen();
            })()`);
            assert.equal(restarted, !initial, 'fresh client process uses the saved startup preference');
            results.at(-1).restarted = restarted;
        }, {settings: persisted.sections});
    }
    console.log(JSON.stringify({windowStartupAndRestart: results}));
})().catch(error => {console.error(error); process.exitCode = 1;});
