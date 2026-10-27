import WebKit
import SwiftUI
import AppleCore
@MainActor final class WebHost: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    unowned let model: AppModel
    let view: WKWebView
    private let version = AppVersion.current
    private var policy: BridgePolicy?
    private var tasks: [Int: Task<Void, Never>] = [:]
    private var active: Bool
    private var queuedRequests: [BridgeRequest] = []
    private var selectionCompletion: CheckedContinuation<Void, Error>?
    private var selectionTimeout: Task<Void, Never>?
    private var keyboardObserver: NSObjectProtocol?
    init(model: AppModel, active: Bool = true) {
        self.active = active
        self.model = model
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: model.profiles.currentID)
        config.setURLSchemeHandler(AssetSchemeHandler(), forURLScheme: "tigerest")
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        Self.allowFullRateRendering(config.preferences)
        view = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(self, name: "tigerestNative")
        view.navigationDelegate = self; view.uiDelegate = self
        view.isOpaque = false; view.backgroundColor = .clear
        // WebKit's own swipe rewound the page's history underneath Emby's router;
        // a swipe from the left edge is the client's back instead. The strip owns
        // those touches, so the page never takes the start of a swipe as a tap.
        view.allowsBackForwardNavigationGestures = false
        let edge = UIView(frame: CGRect(x: 0, y: 0, width: 16, height: view.bounds.height))
        edge.autoresizingMask = [.flexibleHeight, .flexibleRightMargin]
        edge.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(swipeBack(_:))))
        view.addSubview(edge)
        // iOS zooms into a focused field whose text is under 16 px and leaves the
        // page zoomed after the keyboard closes; return to the page's own scale.
        keyboardObserver = NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let scroll = self?.view.scrollView, scroll.zoomScale > scroll.minimumZoomScale + 0.001 else { return }
                scroll.setZoomScale(scroll.minimumZoomScale, animated: true)
            }
        }
        view.customUserAgent = "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1 TigerestTheater/\(version)"
        #if DEBUG
        view.isInspectable = true
        #endif
        if active { activate() }
    }
    /// WebKit keeps page rendering updates near 60 fps by default, so script-driven
    /// motion ran at 57 fps on a 120 Hz iPad. Its feature switch lifts that to the
    /// display rate (113 fps measured). Not public API; without it the page stays at 60.
    private static func allowFullRateRendering(_ preferences: WKPreferences) {
        let featuresSelector = NSSelectorFromString("_features"), setSelector = NSSelectorFromString("_setEnabled:forFeature:")
        guard let features = (WKPreferences.self as AnyObject).perform(featuresSelector)?.takeUnretainedValue() as? [NSObject],
              preferences.responds(to: setSelector) else { return }
        typealias Setter = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        let setter = unsafeBitCast(preferences.method(for: setSelector), to: Setter.self)
        for feature in features where feature.value(forKey: "key") as? String == "PreferPageRenderingUpdatesNear60FPSEnabled" {
            setter(preferences, setSelector, false, feature)
        }
    }
    /// Page-owned back first (server choice, client menu, the poster flight back),
    /// then an open dialog, then Emby's router, which stops at the home page;
    /// the page's raw history was the app's own start page behind home.
    private static let backScript = """
    (() => {
        if (window.tigerestServerSelectionBack?.() || window.tigerestClientMenuBack?.() || window.TigerestHomeMotion?.handleNativeBack()) return true;
        if (document.querySelector('.dialogContainer .dialog')) { history.back(); return true; }
        const router = window.Emby?.Page;
        if (typeof router?.canGoBack !== 'function') return false;
        if (router.canGoBack()) router.back();
        return true;
    })()
    """
    @objc private func swipeBack(_ gesture: UIPanGestureRecognizer) {
        guard gesture.state == .ended, let host = gesture.view?.superview else { return }
        let moved = gesture.translation(in: host), speed = gesture.velocity(in: host)
        guard moved.x > abs(moved.y), moved.x > 60 || speed.x > 500 else { return }
        view.evaluateJavaScript(Self.backScript) { [weak self] handled, _ in
            guard (handled as? Bool) != true, let view = self?.view, view.canGoBack else { return }
            view.goBack()
        }
    }
    func activate() {
        active = true
        model.bridge.output = { [weak self] in self?.emit($0) }
        model.settings.changed = { [weak model] section, value in model?.bridge.emit("settings", "sectionValueUpdate", [.string(section), value]) }
        let pending = queuedRequests; queuedRequests.removeAll()
        for request in pending { dispatch(request) }
    }
    func loadForSelection(_ address: ServerAddress, mode: String, target: URL?) async throws {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { continuation in
                selectionCompletion = continuation
                selectionTimeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(20)) } catch { return }
                    self?.completeSelection(.failure(URLError(.timedOut)))
                }
                open(address, mode: mode, target: target)
            }
            try Task.checkCancellation()
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancelSelection() }
        }
    }
    func cancelSelection() {
        guard !active else { return }
        completeSelection(.failure(CancellationError()))
        close()
    }
    private func completeSelection(_ result: Result<Void, Error>) {
        selectionTimeout?.cancel(); selectionTimeout = nil
        let completion = selectionCompletion; selectionCompletion = nil
        completion?.resume(with: result)
    }
    private func resource(_ file: String) throws -> String {
        try String(contentsOf: Bundle.main.resourceURL!.appending(path: "Web/" + file), encoding: .utf8)
    }
    func open(_ address: ServerAddress, mode: String? = nil, target: URL? = nil) {
        resetPage()
        policy = BridgePolicy(origin: address.origin)
        do {
            var settings = model.settings.values
            if let mode {
                settings["main", default: [:]]["userWebClient"] = .string(address.baseURL.absoluteString)
                settings["main", default: [:]]["serverConnectionMode"] = .string(mode)
            }
            let manifest = try JSONDecoder().decode(JSONValue.self, from: Data(resource("manifest.json").utf8))
            // platform stays "ipad" for the shared scripts; devicePlatform names iOS on iPhone.
            let bootstrap: JSONValue = .object([
                "version": .string(version), "deviceName": .string(UIDevice.current.model), "platform": .string("ipad"), "mode": .string("desktop"),
                "devicePlatform": .string(UIDevice.current.userInterfaceIdiom == .phone ? "iOS" : "iPadOS"),
                "buildNumber": .string(AppVersion.buildNumber(Bundle.main.infoDictionary, revision: manifest["revision"].string)),
                "userAgent": .string(view.customUserAgent!), "scriptPath": .string("tigerest://bundle"), "mpvConfigMode": .string("embedded"), "mpvConfigDir": .string(UIDevice.current.model + " 应用内配置"),
                "settings": .object(settings.mapValues(JSONValue.object)), "sections": .array(model.settings.sections), "settingsDescriptions": .object(model.settings.descriptions),
                "capabilities": .object(["downloads": .bool(true), "nativePlayback": .bool(true), "desktopWindowControls": .bool(false), "selfUpdate": .bool(false), "updateCheck": .bool(true), "rife": .bool(SettingsStore.nativeRifeAvailable)])
            ])
            let json = String(decoding: try JSONEncoder().encode(bootstrap), as: UTF8.self)
            var script = "(()=>{if(window!==window.top || location.origin!==\(String(decoding: try JSONEncoder().encode(address.origin), as: UTF8.self)))return;window.__tigerestBootstrap=\(json);\n"
            script += try resource("ipadBridge.js")
            for file in manifest["scripts"].array ?? [] { script += "\n;(function(){\n" + (try resource(file.string!)) + "\n}).call(window);" }
            let css = String(decoding: try JSONEncoder().encode(resource("ipadResponsive.css")), as: UTF8.self)
            script += "\ndocument.addEventListener('DOMContentLoaded',()=>{const style=document.createElement('style');style.textContent=\(css);document.head.appendChild(style);});"
            script += try resource("ipadResponsive.js")
            if UIDevice.current.userInterfaceIdiom == .phone {
                // Phone widths: the Android layer condenses the header into a 更多 menu,
                // keeps the measured header height for page offsets and enlarges touch targets.
                let phoneCSS = String(decoding: try JSONEncoder().encode(resource("androidResponsive.css") + "\n" + resource("iphoneResponsive.css")), as: UTF8.self)
                script += "\ndocument.addEventListener('DOMContentLoaded',()=>{const style=document.createElement('style');style.textContent=\(phoneCSS);document.head.appendChild(style);document.documentElement.dataset.tigerestDevice='phone';});"
                script += "\n;(function(){\n" + (try resource("androidResponsive.js")) + "\n}).call(window);"
            }
            script += "\n})();"
            view.configuration.userContentController.removeAllUserScripts()
            view.configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            view.load(URLRequest(url: target ?? address.endpoint("web/index.html")))
        } catch {
            if active { model.error = "无法载入客户端界面资源" }
            else { completeSelection(.failure(error)) }
        }
    }
    private func resetPage() {
        if active { model.community.clear(); model.diagnostics.setScope("") }
        policy?.advancePage(); queuedRequests.removeAll()
        tasks.values.forEach { $0.cancel() }; tasks.removeAll()
    }
    func close() { completeSelection(.failure(CancellationError())); resetPage(); view.stopLoading(); view.configuration.userContentController.removeScriptMessageHandler(forName:"tigerestNative"); view.navigationDelegate=nil; keyboardObserver.map(NotificationCenter.default.removeObserver); keyboardObserver=nil }
    func emit(_ value: JSONValue) {
        guard let policy, let url = view.url, Self.origin(url) == policy.origin else { return }
        view.callAsyncJavaScript("window.__tigerestReceive?.(message)", arguments: ["message": value.foundation], in: nil, in: .page, completionHandler: nil)
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        let port = origin.port == 0 ? "" : ":\(origin.port)"
        guard let policy, policy.allows(origin: "\(origin.protocol)://\(origin.host)\(port)", isMainFrame: message.frameInfo.isMainFrame),
              let text = message.body as? String, let request = try? BridgeRequest.decode(Data(text.utf8)) else { return }
        guard active else {
            guard queuedRequests.count < 256 else { cancelSelection(); return }
            queuedRequests.append(request); return
        }
        dispatch(request)
    }
    private func dispatch(_ request: BridgeRequest) {
        guard let policy else { return }
        let epoch = policy.epoch
        tasks[request.id]?.cancel()
        tasks[request.id] = Task { [weak self] in
            guard let self else { return }
            let response: JSONValue
            do { response = .object(["id": .number(Double(request.id)), "result": try await model.bridge.handle(request)]) }
            catch { response = .object(["id": .number(Double(request.id)), "error": .string((error as? CoreError)?.localizedDescription ?? (error as? MPVFailure)?.message ?? "客户端操作失败，请重试")]) }
            guard !Task.isCancelled, self.policy?.isCurrent(epoch) == true else { return }
            tasks[request.id] = nil; emit(response)
        }
    }
    static func origin(_ url: URL) -> String? {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        parts.path = ""; parts.query = nil; parts.fragment = nil
        return parts.string.flatMap { try? ServerAddress($0).origin }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard action.targetFrame?.isMainFrame != false else { decisionHandler(.allow); return }
        guard let url = action.request.url, Self.origin(url) == policy?.origin else {
            if !active { completeSelection(.failure(CoreError.invalidAddress)) }
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, !(200..<400).contains(http.statusCode) {
            failed(URLError(.badServerResponse)); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        resetPage()
        if active { model.loading = true; model.connectionFailure = nil }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if active { model.loading = false; model.connectionFailure = nil }
        else { completeSelection(.success(())) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failed(URLError(.networkConnectionLost)) }
    private func failed(_ error: Error) {
        if !active { completeSelection(.failure(error)); return }
        model.loading = false
        if (error as NSError).code != NSURLErrorCancelled { model.connectionFailure = "服务器页面加载失败，请检查地址和网络后重试。（\((error as NSError).code)）" }
    }
}
struct WebView: UIViewRepresentable {
    let host: WebHost
    func makeUIView(context: Context) -> WKWebView { host.view }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
