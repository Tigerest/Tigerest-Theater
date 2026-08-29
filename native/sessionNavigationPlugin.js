class SessionNavigationPlugin {
    constructor({pageJs, appRouter, connectionManager, viewManager}) {
        this.pageJs = pageJs;
        this.appRouter = appRouter;
        this.connectionManager = connectionManager;
        this.viewManager = viewManager;

        this.originalLogout = appRouter.logout;
        this.originalHandleRoute = pageJs.handleRoute;
        this.logoutHook = this.onLogout.bind(this);
        this.handleRouteHook = this.onHandleRoute.bind(this);

        appRouter.logout = this.logoutHook;
        pageJs.handleRoute = this.handleRouteHook;
    }

    isDownloadedContent(params) {
        const parentId = params?.parentId;
        const itemId = params?.id;
        return parentId === 'downloads' ||
            (typeof parentId === 'string' && parentId.startsWith('local')) ||
            (typeof itemId === 'string' && itemId.startsWith('local'));
    }

    onLogout(apiClient) {
        const selectServerPath = '/startup/selectserver.html';
        const finishLogout = () => this.originalLogout.call(this.appRouter, apiClient);

        try {
            return Promise.resolve(this.pageJs.replace(selectServerPath, {}, false)).then(
                finishLogout,
                error => {
                    console.warn('Tigerest Theater: unable to replace logout history', error);
                    return this.originalLogout.call(this.appRouter, apiClient);
                },
            );
        } catch (error) {
            console.warn('Tigerest Theater: unable to replace logout history', error);
            return this.originalLogout.call(this.appRouter, apiClient);
        }
    }

    onHandleRoute(ctx, route, signal) {
        const apiClient = this.connectionManager.currentApiClient?.();
        const isLoggedIn = Boolean(apiClient?.isLoggedIn?.());
        if (!isLoggedIn && !route?.anonymous && !this.isDownloadedContent(ctx?.params)) {
            this.viewManager.disableRestoreOnCurrentViews?.();
            return this.appRouter.beginConnectionWizard();
        }

        return this.originalHandleRoute.call(this.pageJs, ctx, route, signal);
    }

    destroy() {
        if (this.appRouter.logout === this.logoutHook) {
            this.appRouter.logout = this.originalLogout;
        }
        if (this.pageJs.handleRoute === this.handleRouteHook) {
            this.pageJs.handleRoute = this.originalHandleRoute;
        }
    }
}

window._sessionNavigationPlugin = SessionNavigationPlugin;
