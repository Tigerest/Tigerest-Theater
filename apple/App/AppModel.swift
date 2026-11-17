import SwiftUI
import AppleCore
@MainActor final class AppModel: ObservableObject {
    static weak var shared: AppModel?
    let profiles: ProfileStore
    var embySession: JSONValue = .null
    private var downloadRegistry: [UUID: DownloadCoordinator] = [:]
    var offlinePlayback: (DownloadCoordinator, String)?
    @Published var settings: SettingsStore
    @Published var server: ServerAddress?
    @Published var showConnection = false
    @Published var showOffline = false
    @Published var showProfiles = false
    @Published var showQuality = false
    @Published var error: String?
    @Published var loading = false
    @Published var connectionFailure: String?
    /// The server the connecting card names while `loading`.
    @Published var connectingTo: String?
    private var connectionTask: Task<Void, Never>?
    private var selectionID = UUID()
    private var pendingWeb: WebHost?
    private var serverSelectionError = false
    private func cancelServerSelection() {
        selectionID = UUID(); pendingWeb?.cancelSelection(); pendingWeb = nil
    }
    func takeServerSelectionError() -> Bool {
        let result = serverSelectionError; serverSelectionError = false; return result
    }
    let diagnostics = DiagnosticsLog()
    lazy var updates = UpdateController(model:self)
    lazy var danmaku = DanmakuRepository(model: self)
    lazy var community = CommunityTransport(model: self)
    lazy var player = PlaybackController(model: self)
    lazy var bridge = NativeBridge(model: self)
    lazy var web = WebHost(model: self)
    init() {
        let testing = ProcessInfo.processInfo.arguments.contains("--ui-testing")
        let root = URL.applicationSupportDirectory.appending(path: testing ? "UITestProfiles" : "Profiles")
        if testing && !ProcessInfo.processInfo.arguments.contains("--ui-testing-keep-profile") {
            try? FileManager.default.removeItem(at: root)
            UserDefaults(suiteName:"TigerestUITestUpdates")?.removePersistentDomain(forName:"TigerestUITestUpdates")
        }
        do {
            profiles = try ProfileStore(root: root)
            settings = try SettingsStore(directory: profiles.directory)
            Self.moveDedicatedAddress(settings)
            server = try? ServerAddress(settings.get("main", "userWebClient").string ?? "")
        } catch { fatalError("无法打开应用配置目录") }
        showConnection = server == nil
        Self.shared = self
    }
    /// A dedicated profile saved on the old public HTTP address moves to the HTTPS
    /// one before anything connects; the old address is never contacted again.
    /// The web sign-in is per origin, so Emby asks to sign in once more.
    private static func moveDedicatedAddress(_ settings: SettingsStore) {
        guard settings.get("main", "serverConnectionMode").string != "custom",
              let moved = TigerestService.movedEmby(settings.get("main", "userWebClient").string ?? ""),
              let address = try? ServerAddress(moved) else { return }
        try? settings.setServerConnection(address, mode: "tigerest")
    }
    var downloads: DownloadCoordinator { coordinator(for: profiles.currentID) }
    func coordinator(for id: UUID) -> DownloadCoordinator {
        if let saved=downloadRegistry[id] { return saved }
        let value=try! DownloadCoordinator(profile:id,directory:profiles.root.appending(path:id.uuidString))
        value.changed={ [weak self] snapshot in guard let self,self.profiles.currentID==id else {return};self.bridge.emit("system","downloadsChanged",[snapshot]) }
        downloadRegistry[id]=value;return value
    }
    func setEmbySession(_ value: JSONValue) { if embySession != value { danmaku.authorizationChanged() };embySession=value;downloads.setOwner(value) }
    func playOffline(_ record: DownloadRecord, coordinator: DownloadCoordinator) throws {
        guard record.status=="completed" else {throw CoreError.invalidRequest}
        try player.dispatch("load",[.string(coordinator.localURL(record).absoluteString),.object(["autoplay":.bool(true),"startMilliseconds":.number((record.progress?.position ?? 0)*1000)]),.object(["title":.string(record.title),"type":.string("video")]),.number(1),.number(-1)])
        offlinePlayback=(coordinator,record.id)
    }
    func selectProfile(_ id: UUID) throws {
        connectionTask?.cancel(); cancelServerSelection(); connectionFailure = nil
        player.stop(notify:true);community.clear();web.close()
        try profiles.select(id)
        settings=try SettingsStore(directory:profiles.directory);Self.moveDedicatedAddress(settings)
        community=CommunityTransport(model:self);danmaku=DanmakuRepository(model:self)
        embySession = .null
        server=try? ServerAddress(settings.get("main","userWebClient").string ?? "")
        web=WebHost(model:self);showConnection=server==nil;start();objectWillChange.send()
    }
    func connect(_ input: String, mode: String, replacing: String? = nil) async throws {
        try await selectServer(input, mode: mode, target: nil, replacing: replacing)
    }
    func finishServerSelection(_ input: String, mode: String, target: String, history: String? = nil) async -> Bool {
        guard ["custom", "tigerest"].contains(mode), let address = try? ServerAddress(input),
              let url = URL(string: target), WebHost.origin(url) == address.origin else { return false }
        do {
            if let history { try ServerHistory.validate(history) }
            try await selectServer(input, mode: mode, target: url, suppliedHistory: history); return true
        }
        catch { return false }
    }
    private func selectServer(_ input: String, mode: String, target: URL?, replacing: String? = nil, suppliedHistory: String? = nil) async throws {
        // An old view task can be cancelled before its first actor turn.
        // It must not invalidate the newer profile's selection in that case.
        try Task.checkCancellation()
        guard ["custom", "tigerest"].contains(mode) else { throw CoreError.invalidSetting }
        cancelServerSelection(); serverSelectionError = false
        let selection = selectionID, profile = profiles.currentID
        let previous = currentHistoryServer
        var candidate: WebHost?
        do {
            let address = try await checkServer(input)
            try Task.checkCancellation()
            guard profile == profiles.currentID, selection == selectionID else { throw CancellationError() }
            let host = WebHost(model: self, active: false)
            candidate = host; pendingWeb = host
            try await host.loadForSelection(address, mode: mode, target: target)
            try Task.checkCancellation()
            guard profile == profiles.currentID, selection == selectionID else { throw CancellationError() }
            let history = try suppliedHistory ?? ServerHistory.remember(settings.get("main", "knownServers").string ?? "", mode: mode, address: address.baseURL.absoluteString, replacing: replacing, current: previous)
            try settings.setServerConnection(address, mode: mode, history: history.isEmpty ? nil : history)
            // No suspension between persistence and replacement: cancelled or stale
            // documents never write the profile or dispatch native side effects.
            web.close(); player.stop(notify: true); setEmbySession(.null)
            web = host; pendingWeb = nil
            server = address; showConnection = false; loading = false
            error = nil; connectionFailure = nil
            host.activate(); objectWillChange.send()
        } catch {
            candidate?.cancelSelection()
            if selection == selectionID {
                pendingWeb = nil
                if !Task.isCancelled && !(error is CancellationError) { serverSelectionError = true }
            }
            throw error
        }
    }
    func checkServer(_ input: String, timeout: TimeInterval = 5) async throws -> ServerAddress {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let canonical = ServerHistory.canonicalAddress(value.contains("://") ? value : "http://" + value) else { throw CoreError.invalidAddress }
        let address = try ServerAddress(canonical)
        var request = URLRequest(url: address.endpoint("System/Info/Public"))
        request.timeoutInterval = timeout
        let (body, response) = try await community.data(request, limit: 65536)
        let info = try JSONDecoder().decode(JSONValue.self, from: body)
        guard response.statusCode == 200, info["Id"].string != nil || info["Version"].string != nil else { throw URLError(.badServerResponse) }
        return address
    }
    func connectDedicated(replacing: String? = nil) async throws {
        let profile = profiles.currentID
        let presets = ServerPresets.bundled
        let candidates = ServerPresets.onLocalSubnet(presets.localIP) ? [presets.local, presets.remote] : [presets.remote]
        for (index, candidate) in candidates.enumerated() {
            do { try await connect(candidate, mode: "tigerest", replacing: replacing); return }
            catch {
                try Task.checkCancellation()
                guard profile == profiles.currentID else { throw CancellationError() }
                if index == candidates.count - 1 { throw error }
            }
        }
    }
    func start() {
        connectionTask?.cancel(); cancelServerSelection(); connectionFailure = nil
        guard let server else { return }
        let mode = settings.get("main", "serverConnectionMode").string ?? ""
        if mode == "tigerest" || (mode.isEmpty && ServerPresets.bundled.contains(server)) {
            loading = true; connectingTo = "大河李斯特专属服务器"
            connectionTask = Task {
                do { try await connectDedicated() }
                catch { if !Task.isCancelled { loading = false; connectionFailure = "专属服务器暂时无法连接，请检查网络后重试，也可以先打开离线媒体。" } }
            }
        } else {
            loading = true; connectingTo = Self.title(server)
            web.open(server)
            connectionTask = Task { await probe(server) }
        }
    }
    private static func title(_ server: ServerAddress) -> String {
        guard let host = server.baseURL.host() else { return server.baseURL.absoluteString }
        return server.baseURL.port.map { "\(host):\($0)" } ?? host
    }
    /// The page waits up to a minute for an address that does not answer, such
    /// as the home network's address away from home (issue #42). The server's
    /// public info answers within seconds when it is reachable, so a probe
    /// that cannot reach it ends the attempt early. Only network failures
    /// count; any other answer leaves the decision to the page.
    private func probe(_ server: ServerAddress) async {
        do { _ = try await checkServer(server.baseURL.absoluteString, timeout: 8) }
        catch {
            let unreachable: [URLError.Code] = [.timedOut, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff]
            guard !Task.isCancelled, let code = (error as? URLError)?.code, unreachable.contains(code),
                  loading, connectionFailure == nil, self.server?.origin == server.origin else { return }
            web.view.stopLoading(); loading = false
            connectionFailure = "\(Self.title(server)) 暂时无法连接。在家和在外使用不同地址时，可以直接改用其他服务器。"
        }
    }
    /// Remembered servers other than the current one, newest first: one tap
    /// on the connecting card or the failure page switches to them.
    var otherServers: [ServerHistory.Record] {
        let current = currentServerKey
        return Array(rememberedServers.filter { $0.key != current }.prefix(3))
    }
    /// Ends the attempt in progress, whichever it is: the dedicated
    /// candidates, a server being selected, or the saved server's page.
    private func interruptConnection() {
        connectionTask?.cancel(); connectionTask = nil; cancelServerSelection()
        if loading { web.view.stopLoading() }
        loading = false
    }
    func switchServer(to record: ServerHistory.Record) {
        interruptConnection()
        loading = true; connectingTo = record.title; connectionFailure = nil
        connectionTask = Task {
            do {
                if record.mode == "tigerest" { try await connectDedicated() }
                else { try await connect(record.address, mode: record.mode) }
            } catch {
                // The page's own selection flow must not see this failure later.
                serverSelectionError = false
                if !Task.isCancelled { loading = false; connectionFailure = "\(record.title) 也暂时无法连接，请检查网络后重试，或选择其他服务器。" }
            }
        }
    }
    var currentHistoryServer: ServerHistory.Current? {
        guard let server else { return nil }
        let savedMode = settings.get("main", "serverConnectionMode").string ?? ""
        let mode = savedMode.isEmpty ? (ServerPresets.bundled.contains(server) ? "tigerest" : "custom") : savedMode
        return .init(mode: mode, address: server.baseURL.absoluteString)
    }
    var currentServerKey: String? { currentHistoryServer.flatMap { ServerHistory.key(mode: $0.mode, address: $0.address) } }
    var rememberedServers: [ServerHistory.Record] { ServerHistory.list(settings.get("main", "knownServers").string ?? "", current: currentHistoryServer) }
    func forgetServer(_ key: String) throws {
        guard key != currentServerKey else { throw CoreError.invalidSetting }
        try settings.set("main", "knownServers", .string(ServerHistory.forget(settings.get("main", "knownServers").string ?? "", key: key)))
        objectWillChange.send()
    }
    /// Also the way out of a connection in progress (issue #42): the attempt
    /// stops, and closing the server list without a choice leaves the retry page.
    func openServerSettings() {
        let interrupted = loading
        interruptConnection()
        if interrupted { connectionFailure = "已停止连接。可以重试，也可以改用其他服务器或打开离线媒体。" }
        showConnection = true
    }
}
