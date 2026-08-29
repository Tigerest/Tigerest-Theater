const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function flushPromises() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

function verifyCompatibilityRegistration(Plugin) {
    const registrations = new Map();
    const context = {
        console,
        Promise,
        setInterval() { return 1; },
        clearInterval() {},
        setTimeout() { return 1; },
        clearTimeout() {},
        location: {origin: 'http://test.invalid'},
        jmpInfo: {version: 'test', deviceName: 'test'},
        NativeShell: {AppHost: {}},
        appStartInfo: {},
        _sessionNavigationPlugin: Plugin,
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);

    const source = fs.readFileSync(
        path.join(__dirname, '..', 'native', 'embycompat.js'),
        'utf8',
    );
    vm.runInContext(source, context, {filename: 'embycompat.js'});
    context.define = (id, dependencies, factory) => {
        registrations.set(id, {dependencies, factory});
    };

    assert.ok(
        context.appStartInfo.plugins.includes('tigerest/session-navigation.js'),
        'session navigation plugin was not advertised to Emby',
    );
    const registration = registrations.get('tigerest/session-navigation.js');
    assert.ok(registration, 'session navigation AMD module was not registered');
    assert.deepStrictEqual(Array.from(registration.dependencies), [
        'pageJs', 'appRouter', 'connectionManager', 'viewManager',
    ]);

    const pageJs = {handleRoute() { return 'original-route'; }};
    const appRouter = {
        logout() { return 'original-logout'; },
        beginConnectionWizard() { return 'login'; },
    };
    const connectionManager = {currentApiClient() { return null; }};
    const viewManager = {};
    const RegisteredPlugin = registration.factory(
        {default: pageJs},
        {default: appRouter},
        {default: connectionManager},
        {default: viewManager},
    );
    const instance = new RegisteredPlugin();
    assert.notStrictEqual(appRouter.logout, undefined);
    assert.notStrictEqual(pageJs.handleRoute, undefined);
    assert.notStrictEqual(pageJs.handleRoute(), 'original-route',
        'registered plugin did not install the logged-out route guard');
    instance.destroy();
}

async function verifyLogoutSurvivesHistoryReplacementFailure(Plugin) {
    let logoutCalls = 0;
    const pageJs = {
        replace() { return Promise.reject(new Error('simulated history replacement failure')); },
        handleRoute() {},
    };
    const appRouter = {
        baseUrl() { return '/web'; },
        logout() {
            logoutCalls += 1;
            return Promise.resolve('logged-out');
        },
        beginConnectionWizard() {},
    };
    const instance = new Plugin({
        pageJs,
        appRouter,
        connectionManager: {currentApiClient() { return null; }},
        viewManager: {},
    });

    const result = await appRouter.logout({serverId: 'server-1'});
    assert.strictEqual(result, 'logged-out');
    assert.strictEqual(logoutCalls, 1,
        'history replacement failure prevented the real logout');
    instance.destroy();
}

async function main() {
    const calls = [];
    let loggedIn = false;
    let connectionWizardStarts = 0;
    let protectedRouteRuns = 0;
    let restoreDisables = 0;

    const pageJs = {
        replace(pathname, state, dispatch) {
            calls.push({type: 'replace', pathname, state, dispatch});
            return Promise.resolve();
        },
        handleRoute(ctx, route, signal) {
            protectedRouteRuns += 1;
            return Promise.resolve({ctx, route, signal});
        },
    };
    const appRouter = {
        baseUrl() { return '/web'; },
        logout(apiClient) {
            calls.push({type: 'logout', apiClient});
            return Promise.resolve('logged-out');
        },
        beginConnectionWizard() {
            connectionWizardStarts += 1;
            return Promise.resolve('login');
        },
    };
    const connectionManager = {
        currentApiClient() {
            return {isLoggedIn() { return loggedIn; }};
        },
    };
    const viewManager = {
        replaceCurrentUrl(url) {
            calls.push({type: 'replace-view-url', url});
        },
        disableRestoreOnCurrentViews() {
            restoreDisables += 1;
        },
    };

    const pluginConsole = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn() {},
        error: console.error.bind(console),
    };
    const context = {console: pluginConsole, Promise, window: {}};
    vm.createContext(context);
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'native', 'sessionNavigationPlugin.js'),
        'utf8',
    );
    vm.runInContext(source, context, {filename: 'sessionNavigationPlugin.js'});
    const Plugin = context.window._sessionNavigationPlugin;
    verifyCompatibilityRegistration(Plugin);
    await verifyLogoutSurvivesHistoryReplacementFailure(Plugin);
    const originalLogout = appRouter.logout;
    const originalHandleRoute = pageJs.handleRoute;
    const instance = new Plugin({pageJs, appRouter, connectionManager, viewManager});

    const apiClient = {serverId: 'server-1'};
    await appRouter.logout(apiClient);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].type, 'replace');
    assert.strictEqual(calls[0].pathname, '/startup/selectserver.html');
    assert.strictEqual(calls[0].dispatch, false);
    assert.strictEqual(Object.keys(calls[0].state).length, 0);
    assert.strictEqual(calls[1].type, 'logout');
    assert.strictEqual(calls[1].apiClient, apiClient,
        'logout did not neutralize the authenticated history entry before clearing the session');

    const protectedResult = await pageJs.handleRoute(
        {pathname: '/home', params: {}},
        {anonymous: false},
        {name: 'signal'},
    );
    assert.strictEqual(protectedResult, 'login');
    assert.strictEqual(connectionWizardStarts, 1,
        'logged-out protected navigation did not return to the connection wizard');
    assert.strictEqual(restoreDisables, 1,
        'logged-out protected navigation did not disable stale view restoration');
    assert.strictEqual(protectedRouteRuns, 0,
        'logged-out protected navigation restored stale authenticated content');

    await pageJs.handleRoute(
        {pathname: '/startup/login.html', params: {}},
        {anonymous: true},
        {name: 'signal'},
    );
    assert.strictEqual(protectedRouteRuns, 1,
        'anonymous login route was blocked by the session guard');

    await pageJs.handleRoute(
        {pathname: '/item', params: {id: 'local-download-1'}},
        {anonymous: false},
        {name: 'signal'},
    );
    assert.strictEqual(protectedRouteRuns, 2,
        'downloaded-content routing was changed instead of delegating to Emby');

    loggedIn = true;
    await pageJs.handleRoute(
        {pathname: '/home', params: {}},
        {anonymous: false},
        {name: 'signal'},
    );
    assert.strictEqual(protectedRouteRuns, 3,
        'authenticated navigation was blocked by the session guard');

    instance.destroy();
    assert.strictEqual(appRouter.logout, originalLogout,
        'logout hook was not restored when the plugin was destroyed');
    assert.strictEqual(pageJs.handleRoute, originalHandleRoute,
        'route hook was not restored when the plugin was destroyed');

    calls.length = 0;
    await appRouter.logout(apiClient);
    await flushPromises();
    assert.deepStrictEqual(calls, [{type: 'logout', apiClient}],
        'destroyed session plugin still intercepted logout');

    console.log('session navigation: all checks passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
