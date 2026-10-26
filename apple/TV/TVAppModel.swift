import AppleCore
import Combine
import Foundation

enum TVServerMode {
    case dedicated, selfHosted
}

enum TVWatchState: Equatable {
    case unplayed, partial(Double), played, remaining(Int)
}

struct TVBrowsePage: Identifiable {
    let id = UUID()
    var item: JSONValue
    var items: [JSONValue] = []
    var hasMore = false
    var favoriteWorks: [JSONValue]?
    var pendingFocusItemID: String?
    /// Poster-wall search inside a library; empty shows the whole library.
    var search = ""
    var title: String { TVMedia.title(item) }
}

@MainActor
final class TVAppModel: ObservableObject {
    @Published private(set) var session: EmbySession?
    @Published private(set) var client: EmbyClient?
    @Published private(set) var libraries: [JSONValue] = []
    @Published private(set) var resume: [JSONValue] = []
    @Published private(set) var homeCards: [EmbyHomeCard] = []
    @Published private(set) var homeLibraryID: String?
    @Published private(set) var homeCardID: String?
    @Published private(set) var homeLoading = false
    @Published private(set) var homeError: String?
    @Published private(set) var homeOrder: EmbyHomeOrder
    @Published private(set) var librarySort: EmbyLibrarySort
    @Published var error: String?
    @Published private(set) var busy = false
    @Published private(set) var serverMode: TVServerMode?
    @Published var serverURL = ""
    @Published var showServerPicker = false
    @Published private(set) var savedServers = ServerSessionHistory()
    @Published private(set) var connectingServerKey: String?
    private var editingServerKey: String?
    @Published private(set) var pages: [TVBrowsePage] = []
    @Published private(set) var selectedItem: JSONValue?
    @Published private(set) var focusTarget: String?
    @Published private(set) var episodeQueue: [JSONValue] = []
    @Published private(set) var episodeSeasons: [JSONValue] = []
    @Published private(set) var episodeSeasonID: String?
    @Published private(set) var currentEpisodeID: String?
    @Published private(set) var episodeLoading = false
    @Published private(set) var episodeError: String?
    @Published private(set) var episodeHasMore = false
    @Published private(set) var episodeSeasonsHaveMore = false
    @Published private var fixtureActive = false

    let player = TVPlaybackController()
    let fixtureMode: Bool
    private let store: TVSessionStore
    private var started = false
    private var requestID = UUID()
    private let batchSize = 80
    private var retryAction: RetryAction = .home
    private var homeTask: Task<Void, Never>?
    private var homeRequestID = UUID()
    private var homeCache: [String: (Date, [EmbyHomeCard])] = [:]
    private var homeDirty = false
    private var pendingStopReports = 0
    private var returnPageTask: Task<Void, Never>?
    private var detailReturnItemID: String?
    private var episodeRequestID = UUID()
    private var episodeSeriesID: String?
    private var episodeOffset = 0
    private var episodeSeasonOffset = 0
    private var episodeAdjacent: [JSONValue] = []
    private var localEpisodeUserData: [String: JSONValue] = [:]

    private enum RetryAction {
        case home, page, more, detail(JSONValue), playback(JSONValue, Bool)
    }

    init(fixtureMode: Bool = ProcessInfo.processInfo.arguments.contains("--tv-fixture"),
         store: TVSessionStore = TVSessionStore()) {
        self.fixtureMode = fixtureMode
        self.store = store
        if !fixtureMode { savedServers = (try? store.loadState()) ?? ServerSessionHistory() }
        homeOrder = fixtureMode ? .resume : EmbyHomeOrder(rawValue: UserDefaults.standard.string(forKey: "tv.home.displayOrder") ?? "") ?? .resume
        librarySort = fixtureMode ? .name : EmbyLibrarySort(rawValue: UserDefaults.standard.string(forKey: "tv.library.sort") ?? "") ?? .name
        player.onStopped = { [weak self] item, position, duration in
            self?.updateProgress(item: item, position: position, duration: duration)
        }
        player.onStopReported = { [weak self] _, client in
            guard let self, self.client === client else { return }
            self.pendingStopReports = max(0, self.pendingStopReports - 1)
            self.refreshDirtyHome()
        }
    }

    var isAuthenticated: Bool { session != nil || fixtureActive }
    var canGoBack: Bool { selectedItem != nil || !pages.isEmpty }
    var currentPage: TVBrowsePage? { pages.last }
    var selectedHomeLibrary: JSONValue? { libraries.first { TVMedia.id($0) == homeLibraryID } }
    var selectedHomeCard: EmbyHomeCard? { homeCards.first { $0.id == homeCardID } ?? homeCards.first }
    var navigationContext: String {
        if let selectedItem { return "detail:" + TVMedia.id(selectedItem) }
        if let page = currentPage { return "page:" + page.id.uuidString }
        return serverMode.map { "login:\($0)" } ?? "home"
    }

    func start() async {
        guard !started else { return }
        started = true
        if fixtureMode {
            fixtureActive = true
            await refresh()
            return
        }
        do {
            if let saved = try store.load() {
                client = try EmbyClient(session: saved)
                session = saved
                serverURL = saved.serverURL
                await refresh()
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func selectServer(_ mode: TVServerMode) {
        invalidateRequest()
        serverMode = mode
        editingServerKey = nil; connectingServerKey = nil
        error = nil
        if mode == .dedicated {
            let presets = ServerPresets.bundled
            serverURL = ServerPresets.onLocalSubnet(presets.localIP) ? presets.local : presets.remote
        } else {
            serverURL = ""
        }
    }

    func resetServerSelection() {
        invalidateRequest()
        serverMode = nil
        editingServerKey = nil; connectingServerKey = nil
        error = nil
        serverURL = ""
    }

    func login(username: String, password: String) async {
        guard !fixtureMode else {
            error = "此启动为隔离测试模式。请正常启动应用后登录服务器。"
            return
        }
        guard serverMode != nil, !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            error = "请输入用户名。"
            return
        }
        let submittedURL = serverURL, replacing = editingServerKey
        // TestFlight builds list no dedicated server; its typed address still connects as one.
        let mode: TVServerMode = Distribution.testFlight && serverMode == .selfHosted && ServerPresets.bundled.contains(typed: submittedURL) ? .dedicated : serverMode!
        let id = beginRequest()
        do {
            let server: String
            // The public info says whether a self-hosted server is Emby or Jellyfin.
            var info: EmbyServerInfo?
            if mode == .dedicated {
                server = try await dedicatedServer()
                info = try await EmbyClient.serverInfo(server: server)
            } else {
                let value = submittedURL.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !value.isEmpty else { throw TVError.message("请输入服务器地址。") }
                guard let canonical = ServerHistory.canonicalAddress(value.contains("://") ? value : "http://" + value) else { throw CoreError.invalidAddress }
                server = canonical
                info = try await EmbyClient.serverInfo(server: server)
            }
            guard isCurrent(id) else { return }
            let deviceID = try store.deviceID()
            let saved = try await EmbyClient.login(server: server, username: username.trimmingCharacters(in: .whitespacesAndNewlines),
                                                   password: password, deviceID: deviceID, serverInfo: info)
            guard isCurrent(id) else { return }
            let authenticatedClient = try EmbyClient(session: saved)
            let loadedLibraries = try await authenticatedClient.libraries()
            guard isCurrent(id) else { return }
            try commitServer(saved, client: authenticatedClient, libraries: loadedLibraries,
                             mode: mode == .dedicated ? "tigerest" : "custom", replacing: replacing, name: info?.name)
        } catch {
            fail(error, request: id)
        }
    }

    var rememberedServers: [ServerHistory.Record] { savedServers.records }
    var currentServerKey: String? { savedServers.currentKey }
    func openServerSettings() {
        invalidateRequest(); cancelHome(); resetServerSelection(); showServerPicker = true
    }
    func closeServerSettings() { resetServerSelection(); showServerPicker = false }
    func editServer(_ record: ServerHistory.Record) {
        selectServer(.selfHosted); serverURL = record.address; editingServerKey = record.key
    }
    func forgetServer(_ key: String) {
        invalidateRequest()
        do { try store.forget(key); savedServers = try store.loadState(); error = nil }
        catch { self.error = error.localizedDescription }
    }
    func connectRememberedServer(_ record: ServerHistory.Record) async {
        invalidateRequest(); serverMode = nil; editingServerKey = nil; connectingServerKey = record.key
        let id = beginRequest()
        do {
            let address = record.mode == "tigerest" ? try await dedicatedServer() : record.address
            let info = try await EmbyClient.serverInfo(server: address)
            guard isCurrent(id) else { return }
            guard let previous = savedServers.cached(key: record.key),
                  previous.serverID == nil || info.id == nil || previous.serverID == info.id else {
                serverMode = record.mode == "tigerest" ? .dedicated : .selfHosted
                serverURL = address; busy = false; return
            }
            let candidate = EmbySession(serverURL: address, userID: previous.userID, accessToken: previous.accessToken,
                                        deviceID: previous.deviceID, serverID: info.id, serverKind: info.kind, serverVersion: info.version)
            let candidateClient = try EmbyClient(session: candidate)
            let loadedLibraries = try await candidateClient.libraries()
            guard isCurrent(id) else { return }
            try commitServer(candidate, client: candidateClient, libraries: loadedLibraries, mode: record.mode, replacing: nil, name: info.name)
        } catch {
            guard isCurrent(id) else { return }
            busy = false; self.error = error.localizedDescription
            if (error as? EmbyClientError) == .unauthorized {
                serverMode = record.mode == "tigerest" ? .dedicated : .selfHosted
                serverURL = record.address
            }
        }
    }
    private func commitServer(_ candidate: EmbySession, client candidateClient: EmbyClient, libraries loaded: [JSONValue],
                              mode: String, replacing: String?, name: String?) throws {
        // A failed/cancelled candidate never changes the active session or its history.
        try store.commit(candidate, mode: mode, replacing: replacing, name: name)
        cancelHome(); player.stop(); clearEpisodeContext()
        detailReturnItemID = nil; localEpisodeUserData = [:]
        pages = []; selectedItem = nil; resume = []; homeCards = []; homeLibraryID = nil; homeCardID = nil
        homeCache = [:]; homeError = nil; homeDirty = false; pendingStopReports = 0
        session = candidate; client = candidateClient; serverURL = candidate.serverURL
        savedServers = try store.loadState()
        libraries = EmbyHomeData.libraries(loaded, serverID: candidate.serverID)
        busy = false; error = nil; serverMode = nil; showServerPicker = false
        editingServerKey = nil; connectingServerKey = nil; focusTarget = nil
        if let first = libraries.first {
            previewLibrary(TVMedia.id(first), refresh: true)
            focusTarget = "tv.library." + TVMedia.id(first)
        }
    }

    func logout() async {
        invalidateRequest()
        cancelHome()
        player.stop()
        clearEpisodeContext(); detailReturnItemID = nil; localEpisodeUserData = [:]
        do {
            if !fixtureMode { try store.clear(); savedServers = try store.loadState() }
            session = nil
            client = nil
            fixtureActive = false
            libraries = []
            resume = []
            homeCards = []; homeLibraryID = nil; homeCardID = nil; homeCache = [:]; homeError = nil
            homeDirty = false; pendingStopReports = 0
            pages = []
            selectedItem = nil
            serverMode = nil
            serverURL = ""
            error = nil
            focusTarget = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func refresh() async {
        let id = beginRequest()
        retryAction = .home
        if fixtureActive {
            libraries = EmbyHomeData.libraries(TVFixtures.libraries, serverID: nil)
            resume = [TVFixtures.episode(1)]
            busy = false
            previewLibrary(homeLibraryID ?? TVMedia.id(libraries[0]), refresh: true)
            focusTarget = "tv.library.\(homeLibraryID ?? TVMedia.id(libraries[0]))"
            return
        }
        guard var client else { busy = false; return }
        do {
            // Identify old sessions before account requests, including a visible
            // retry after an unavailable server. Persist only a successful answer.
            if let saved = session, saved.needsServerInfo,
               let info = try? await EmbyClient.serverInfo(server: saved.serverURL) {
                guard isCurrent(id) else { return }
                let completed = saved.completed(with: info)
                client = try EmbyClient(session: completed)
                try store.save(completed)
                session = completed
                self.client = client
            }
            guard isCurrent(id) else { return }
            let newLibraries = try await client.libraries()
            guard isCurrent(id) else { return }
            libraries = EmbyHomeData.libraries(newLibraries, serverID: session?.serverID)
            busy = false
            let selection = libraries.first { TVMedia.id($0) == homeLibraryID } ?? libraries.first
            if let selection {
                previewLibrary(TVMedia.id(selection), refresh: true)
                focusTarget = "tv.library.\(TVMedia.id(selection))"
            }
        } catch {
            fail(error, request: id)
        }
    }

    func previewLibrary(_ libraryID: String, refresh: Bool = false, preservingSelection: Bool = false) {
        let refresh = refresh || (homeDirty && pendingStopReports == 0 && !homeLoading)
        guard refresh || homeLibraryID != libraryID || !homeLoading else { return }
        guard let library = libraries.first(where: { TVMedia.id($0) == libraryID }),
              refresh || homeLibraryID != libraryID || homeCards.isEmpty else { return }
        let selectedID = preservingSelection && homeLibraryID == libraryID ? homeCardID : nil
        cancelHome()
        if selectedID == nil { homeCards = []; homeCardID = nil }
        homeLibraryID = libraryID; homeLoading = true; homeError = nil
        let generation = homeRequestID, order = homeOrder, key = libraryID + "|" + order.rawValue
        if fixtureActive {
            homeCards = TVFixtures.homeCards(library: library)
            homeCardID = homeCards.first?.id; homeLoading = false
            return
        }
        guard let client else { homeLoading = false; return }
        homeTask = Task { [weak self] in
            guard let self else { return }
            let data = EmbyHomeData(api: client)
            do {
                let cards: [EmbyHomeCard]
                if !refresh, let cache = homeCache[key], Date().timeIntervalSince(cache.0) < 60 { cards = cache.1 }
                else { cards = try await data.load(library: library, order: order) }
                guard homeCurrent(generation) else { return }
                homeCards = cards
                homeCardID = cards.contains(where: { $0.id == selectedID }) ? selectedID : cards.first?.id
                homeLoading = false
                if pendingStopReports == 0 { homeDirty = false }
                if let target = focusTarget, target.hasPrefix("tv.item."),
                   !cards.contains(where: { "tv.item." + $0.id == target }) {
                    focusTarget = homeCardID.map { "tv.item." + $0 } ?? "tv.library." + libraryID
                }
                homeCache[key] = (Date(), cards)
                let enriched = try await data.watchProgress(cards)
                guard homeCurrent(generation) else { return }
                homeCards = enriched; homeCache[key] = (Date(), enriched)
            } catch {
                guard homeCurrent(generation) else { return }
                homeLoading = false; homeError = error.localizedDescription
            }
        }
    }

    func selectHomeCard(_ id: String) {
        guard homeCards.contains(where: { $0.id == id }) else { return }
        homeCardID = id
    }

    func setHomeOrder(_ order: EmbyHomeOrder) {
        guard homeOrder != order else { return }
        homeOrder = order
        if !fixtureMode { UserDefaults.standard.set(order.rawValue, forKey: "tv.home.displayOrder") }
        if let homeLibraryID { previewLibrary(homeLibraryID, refresh: true) }
    }

    /// The current page is a library's poster wall, which can be sorted and searched.
    var currentPageIsLibrary: Bool {
        guard let page = currentPage else { return false }
        return libraries.contains { TVMedia.id($0) == TVMedia.id(page.item) }
    }

    func setLibrarySort(_ sort: EmbyLibrarySort) async {
        guard librarySort != sort else { return }
        librarySort = sort
        if !fixtureMode { UserDefaults.standard.set(sort.rawValue, forKey: "tv.library.sort") }
        await reloadLibraryPage()
    }

    func searchLibrary(_ text: String) async {
        guard currentPageIsLibrary else { return }
        let term = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100))
        guard term != pages[pages.count - 1].search else { return }
        pages[pages.count - 1].search = term
        await reloadLibraryPage()
    }

    private func reloadLibraryPage() async {
        guard currentPageIsLibrary else { return }
        invalidateRequest()
        let index = pages.count - 1
        pages[index].items = []; pages[index].hasMore = false; pages[index].pendingFocusItemID = nil
        await loadPage(append: false)
    }

    private func cancelHome() {
        homeRequestID = UUID(); homeTask?.cancel(); homeTask = nil; homeLoading = false
    }

    private func homeCurrent(_ id: UUID) -> Bool {
        id == homeRequestID && !Task.isCancelled && selectedItem == nil && pages.isEmpty && isAuthenticated
    }

    private func refreshDirtyHome() {
        guard homeDirty, pendingStopReports == 0, !canGoBack, isAuthenticated,
              let homeLibraryID else { return }
        previewLibrary(homeLibraryID, refresh: true, preservingSelection: true)
    }

    func openHomeWork(_ item: JSONValue) async {
        // A callback from the disappearing home view must not stack the library
        // again. Its catalogue is loaded on return so it cannot delay the detail.
        guard pages.isEmpty, selectedItem == nil else { return }
        if let library = selectedHomeLibrary {
            pages.append(TVBrowsePage(item: library, pendingFocusItemID: TVMedia.id(item)))
        }
        await open(item)
    }

    func handleExit(from context: String) {
        guard navigationContext == context else { return }
        if canGoBack { goBack() } else if !isAuthenticated, serverMode != nil { resetServerSelection() }
    }

    func open(_ item: JSONValue) async {
        cancelHome()
        if let page = currentPage, page.pendingFocusItemID != nil,
           page.items.contains(where: { TVMedia.id($0) == TVMedia.id(item) }) {
            pages[pages.count - 1].pendingFocusItemID = nil
        }
        if TVMedia.isContainer(item) || item["kind"].string == "favorites" {
            invalidateRequest()
            selectedItem = nil
            clearEpisodeContext(); detailReturnItemID = nil
            pages.append(TVBrowsePage(item: item))
            await loadPage(append: false)
        } else {
            await loadDetail(item)
        }
    }

    func goBack() {
        invalidateRequest()
        error = nil
        if let selectedItem {
            focusTarget = "tv.item.\(detailReturnItemID ?? TVMedia.id(selectedItem))"
            self.selectedItem = nil
            clearEpisodeContext(); detailReturnItemID = nil
        } else if let page = pages.popLast() {
            let id = TVMedia.id(page.item)
            focusTarget = pages.isEmpty && libraries.contains(where: { TVMedia.id($0) == id }) ? "tv.library.\(id)" : "tv.item.\(id)"
        }
        if selectedItem == nil, let page = currentPage, page.pendingFocusItemID != nil {
            let generation = beginRequest()
            retryAction = page.items.isEmpty ? .page : .more
            focusTarget = "tv.back"
            returnPageTask = Task { [weak self] in
                guard let self, self.isCurrent(generation), self.currentPage?.id == page.id else { return }
                await self.loadPage(append: !page.items.isEmpty)
            }
        }
        if pages.isEmpty, selectedItem == nil {
            if homeDirty { refreshDirtyHome() }
            else if homeCards.isEmpty, let homeLibraryID { previewLibrary(homeLibraryID) }
        }
    }

    func loadMore() async { await loadPage(append: true) }

    /// A response that arrives after backgrounding must not open a new player.
    func suspend() {
        if busy, case .playback = retryAction {
            invalidateRequest()
            error = "播放准备已暂停，请重试。"
            focusTarget = "tv.retry"
        }
    }

    func retry() async {
        switch retryAction {
        case .home: await refresh()
        case .page: await loadPage(append: false)
        case .more: await loadPage(append: true)
        case .detail(let item): await loadDetail(item)
        case .playback(let item, let resume): await play(item, resume: resume)
        }
    }

    func play(_ item: JSONValue, resume shouldResume: Bool, playbackGeneration: UUID? = nil) async {
        let id = beginRequest()
        defer { if requestID == id { busy = false } }
        retryAction = .playback(item, shouldResume)
        if fixtureActive {
            do {
                let arguments = ProcessInfo.processInfo.arguments
                guard let flag = arguments.firstIndex(of: "--tv-fixture-media"), arguments.indices.contains(flag + 1) else {
                    throw TVError.message("这是浏览测试样片。需要随隔离测试启动提供本地测试视频才能验证播放。")
                }
                let path = arguments[flag + 1]
                let url: URL?
                if path == "bundled" {
                    url = Bundle.main.url(forResource: "tv-fixture", withExtension: "mp4")
                } else {
                    url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : nil
                }
                guard let url, (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
                    throw TVError.message("未找到本地测试视频，请检查隔离测试资源。")
                }
                let fixtureSession = EmbySession(serverURL: "http://127.0.0.1:9", userID: "tv-fixture",
                                                 accessToken: "tv-fixture", deviceID: "tv-fixture")
                let fixtureClient = try EmbyClient(session: fixtureSession)
                let playback = EmbyPlayback(url: url, headers: [:], item: item, mediaSourceID: "tv-fixture",
                                            playSessionID: "tv-fixture", startSeconds: shouldResume ? TVMedia.resumeSeconds(item) : 0)
                try player.play(playback, client: fixtureClient)
                busy = false
                if selectedItem != nil { selectedItem = item }
                await prepareEpisodeContext(item)
            } catch {
                fail(error, request: id)
            }
            return
        }
        guard let client else {
            fail(TVError.message("这是浏览测试样片，没有连接媒体服务器。请正常启动并登录后播放。"), request: id)
            return
        }
        var handedToPlayer = false
        do {
            var requestedItem = item
            if !shouldResume, var object = item.object {
                var userData = item["UserData"].object ?? [:]
                userData["PlaybackPositionTicks"] = .number(0)
                object["UserData"] = .object(userData)
                requestedItem = .object(object)
            }
            let playback = try await client.playback(item: requestedItem)
            guard isCurrent(id) else { return }
            if let playbackGeneration, player.playbackGeneration != playbackGeneration { busy = false; return }
            handedToPlayer = true
            try player.play(playback, client: client, session: session)
            busy = false
            if selectedItem != nil { selectedItem = item }
            await prepareEpisodeContext(item)
        } catch {
            guard isCurrent(id) else { return }
            if let playbackGeneration {
                guard handedToPlayer || player.playbackGeneration == playbackGeneration else { return }
                episodeError = error.localizedDescription
            }
            fail(error, request: id)
        }
    }

    private func loadPage(append: Bool) async {
        guard let page = currentPage, !append || page.hasMore else { return }
        let id = beginRequest()
        retryAction = append ? .more : .page
        do {
            let result: [JSONValue]
            var totalCount: Int?
            var favoriteWorks = page.favoriteWorks
            if fixtureActive {
                result = TVFixtures.children(of: page.item)
            } else if let client {
                if page.item["kind"].string == "favorites" {
                    // Keep episode favorites collapsed to their parent work, as
                    // on home, but expose a bounded page of posters at a time.
                    let all: [JSONValue]
                    if append, let favoriteWorks { all = favoriteWorks }
                    else { all = try await EmbyHomeData(api: client).ordered(library: page.item, order: .recent, limit: .max).map(\.item) }
                    favoriteWorks = all
                    totalCount = all.count
                    result = Array(all.dropFirst(append ? page.items.count : 0).prefix(batchSize))
                } else if libraries.contains(where: { TVMedia.id($0) == TVMedia.id(page.item) }) {
                    let works = try await client.libraryItems(in: page.item, startIndex: append ? page.items.count : 0, limit: batchSize,
                                                              sort: librarySort, search: page.search)
                    result = works.items
                    totalCount = works.totalRecordCount
                } else {
                    async let children = client.children(of: page.item, startIndex: append ? page.items.count : 0, limit: batchSize)
                    if !append, ["Series", "Season"].contains(page.item["Type"].string ?? ""), let detail = try? await client.item(id: TVMedia.id(page.item)), isCurrent(id), pages.last?.id == page.id {
                        pages[pages.count - 1].item = detail
                    }
                    result = try await children
                }
            } else {
                busy = false
                return
            }
            guard isCurrent(id), pages.last?.id == page.id else { return }
            let index = pages.count - 1
            pages[index].items = append ? page.items + result : result
            pages[index].favoriteWorks = favoriteWorks
            pages[index].hasMore = !fixtureActive && !result.isEmpty && (totalCount.map { pages[index].items.count < $0 } ?? (result.count == batchSize))
            if let target = page.pendingFocusItemID {
                if pages[index].items.contains(where: { TVMedia.id($0) == target }) {
                    pages[index].pendingFocusItemID = nil
                    busy = false
                    focusTarget = "tv.item." + target
                } else if pages[index].hasMore {
                    await loadPage(append: true)
                } else {
                    pages[index].pendingFocusItemID = nil
                    busy = false
                    focusTarget = pages[index].items.first.map { "tv.item." + TVMedia.id($0) } ?? "tv.back"
                }
                return
            }
            busy = false
            if let first = result.first { focusTarget = "tv.item.\(TVMedia.id(first))" }
        } catch {
            fail(error, request: id)
        }
    }

    private func loadDetail(_ item: JSONValue) async {
        if selectedItem == nil { detailReturnItemID = TVMedia.id(item) }
        // A previous detail's auxiliary request must not populate a new detail,
        // including when loading the new item itself fails.
        episodeRequestID = UUID(); episodeLoading = false
        if item["SeriesId"].string != episodeSeriesID || (item["SeasonId"].string ?? item["ParentId"].string) != episodeSeasonID {
            clearEpisodeContext()
        }
        currentEpisodeID = item["Type"].string == "Episode" ? TVMedia.id(item) : nil
        let id = beginRequest()
        defer { if requestID == id { busy = false } }
        retryAction = .detail(item)
        selectedItem = item
        do {
            let detail: JSONValue
            if fixtureActive {
                detail = item
            } else if let client {
                detail = try await client.item(id: TVMedia.id(item))
            } else {
                busy = false
                return
            }
            guard isCurrent(id) else { return }
            selectedItem = withLocalEpisodeProgress(detail)
            busy = false
            focusTarget = TVMedia.resumeSeconds(withLocalEpisodeProgress(detail)) > 0 ? "tv.resume" : "tv.play"
            await prepareEpisodeContext(withLocalEpisodeProgress(detail))
        } catch {
            fail(error, request: id)
        }
    }

    var canPlayPreviousEpisode: Bool { adjacentEpisode(offset: -1) != nil }
    var canPlayNextEpisode: Bool { adjacentEpisode(offset: 1) != nil }

    func playPreviousEpisode() async {
        if let item = adjacentEpisode(offset: -1) { await playEpisode(item) }
    }
    func playNextEpisode() async {
        if let item = adjacentEpisode(offset: 1) { await playEpisode(item) }
    }
    func playEpisode(_ item: JSONValue) async {
        guard !busy, !episodeLoading,
              let queued = (episodeQueue + episodeAdjacent).first(where: { TVMedia.id($0) == TVMedia.id(item) }) else { return }
        episodeError = nil
        await play(withLocalEpisodeProgress(queued), resume: true, playbackGeneration: player.playbackGeneration)
    }
    func openEpisode(_ item: JSONValue) async {
        guard selectedItem != nil, !busy, let queued = episodeQueue.first(where: { TVMedia.id($0) == TVMedia.id(item) }) else { return }
        await loadDetail(queued)
    }
    func reloadEpisodeContext() async {
        guard !episodeLoading else { return }
        if let selectedItem, let seasonID = episodeSeasonID,
           seasonID != (selectedItem["SeasonId"].string ?? selectedItem["ParentId"].string) {
            await fetchEpisodePage(append: !episodeQueue.isEmpty)
            return
        }
        if let item = selectedItem, item["Type"].string == "Episode" { await prepareEpisodeContext(item, refresh: true) }
        else if let item = episodeQueue.first(where: { TVMedia.id($0) == currentEpisodeID }) { await prepareEpisodeContext(item, refresh: true) }
    }
    func selectEpisodeSeason(_ season: JSONValue) async {
        guard !episodeLoading, episodeSeasons.contains(where: { TVMedia.id($0) == TVMedia.id(season) }) else { return }
        episodeRequestID = UUID()
        episodeSeasonID = TVMedia.id(season)
        episodeQueue = []; episodeOffset = 0; episodeHasMore = false
        await fetchEpisodePage(append: false)
    }
    func loadMoreEpisodes() async {
        guard !episodeLoading, episodeHasMore else { return }
        await fetchEpisodePage(append: true)
    }
    func loadMoreEpisodeSeasons() async {
        guard !episodeLoading, episodeSeasonsHaveMore, let seriesID = episodeSeriesID, let client else { return }
        let generation = episodeRequestID
        defer { if episodeRequestID == generation { episodeLoading = false } }
        episodeLoading = true; episodeError = nil
        do {
            let page = try await client.seasons(seriesID: seriesID, startIndex: episodeSeasonOffset, limit: batchSize)
            guard episodeCurrent(generation) else { return }
            episodeSeasonOffset += page.items.count
            episodeSeasons = mergedEpisodes(episodeSeasons, page.items, seasons: true)
            episodeSeasonsHaveMore = hasMoreEpisodes(page, offset: episodeSeasonOffset)
            episodeLoading = false
        } catch { episodeFailed(error, generation: generation) }
    }

    private func adjacentEpisode(offset: Int) -> JSONValue? {
        guard !episodeLoading, let currentEpisodeID,
              let index = episodeAdjacent.firstIndex(where: { TVMedia.id($0) == currentEpisodeID }),
              episodeAdjacent.indices.contains(index + offset) else { return nil }
        let target = episodeAdjacent[index + offset]
        return withLocalEpisodeProgress(episodeQueue.first { TVMedia.id($0) == TVMedia.id(target) } ?? target)
    }
    private func prepareEpisodeContext(_ item: JSONValue, refresh: Bool = false) async {
        guard item["Type"].string == "Episode" else { clearEpisodeContext(); return }
        currentEpisodeID = TVMedia.id(item)
        guard let seriesID = item["SeriesId"].string, let seasonID = item["SeasonId"].string ?? item["ParentId"].string else {
            clearEpisodeContext(); currentEpisodeID = TVMedia.id(item)
            episodeError = "服务器没有提供此集的剧集或季信息。"
            return
        }
        let sameSeason = episodeSeriesID == seriesID && episodeSeasonID == seasonID && !refresh
        let sameSeries = episodeSeriesID == seriesID && !episodeSeasons.isEmpty && !refresh
        episodeRequestID = UUID(); let generation = episodeRequestID
        defer { if episodeRequestID == generation { episodeLoading = false } }
        episodeSeriesID = seriesID; episodeSeasonID = seasonID
        episodeLoading = true; episodeError = nil; episodeAdjacent = []
        if !sameSeason { episodeQueue = []; episodeOffset = 0; episodeHasMore = false }
        if !sameSeries { episodeSeasons = []; episodeSeasonOffset = 0; episodeSeasonsHaveMore = false }
        do {
            let seasons: EmbyItemPage?
            let episodes: EmbyItemPage?
            let adjacent: [JSONValue]
            if fixtureActive {
                seasons = sameSeries ? nil : EmbyItemPage(items: TVFixtures.children(of: .object(["Id": .string(seriesID)])))
                let all = TVFixtures.children(of: .object(["Id": .string(seasonID)]))
                episodes = sameSeason ? nil : EmbyItemPage(items: all, totalRecordCount: all.count)
                adjacent = all
            } else if let client {
                seasons = sameSeries ? nil : try await client.seasons(seriesID: seriesID, limit: batchSize)
                guard episodeCurrent(generation) else { return }
                episodes = sameSeason ? nil : try await client.episodes(seriesID: seriesID, seasonID: seasonID, limit: batchSize)
                guard episodeCurrent(generation) else { return }
                adjacent = try await client.episodes(seriesID: seriesID, seasonID: seasonID, adjacentTo: TVMedia.id(item)).items
            } else { clearEpisodeContext(); return }
            guard episodeCurrent(generation) else { return }
            if let seasons {
                episodeSeasons = seasons.items; episodeSeasonOffset = seasons.items.count
                episodeSeasonsHaveMore = hasMoreEpisodes(seasons, offset: episodeSeasonOffset)
            }
            // Keep the current season selectable even when it is beyond page 1.
            if !episodeSeasons.contains(where: { TVMedia.id($0) == seasonID }) {
                var season: [String: JSONValue] = ["Id": .string(seasonID), "Type": .string("Season"), "SeriesId": .string(seriesID)]
                if let name = item["SeasonName"].string { season["Name"] = .string(name) }
                else if let number = item["ParentIndexNumber"].number, number.isFinite, number >= 0, number <= 9999 {
                    season["Name"] = .string("第 \(Int(number)) 季")
                } else { season["Name"] = .string("当前季") }
                season["IndexNumber"] = item["ParentIndexNumber"]
                episodeSeasons = mergedEpisodes(episodeSeasons, [.object(season)], seasons: true)
            }
            if let episodes {
                episodeQueue = episodes.items; episodeOffset = episodes.items.count
                episodeHasMore = hasMoreEpisodes(episodes, offset: episodeOffset)
            }
            let sameSeasonAdjacent = adjacent.filter { $0["Type"].string == "Episode" && ($0["SeasonId"].string ?? seasonID) == seasonID }
            episodeAdjacent = sameSeasonAdjacent
            episodeQueue = mergedEpisodes(episodeQueue, sameSeasonAdjacent + [item])
            episodeLoading = false
        } catch { episodeFailed(error, generation: generation) }
    }
    private func fetchEpisodePage(append: Bool) async {
        guard let seriesID = episodeSeriesID, let seasonID = episodeSeasonID else { return }
        let generation = episodeRequestID
        defer { if episodeRequestID == generation { episodeLoading = false } }
        episodeLoading = true; episodeError = nil
        do {
            let page: EmbyItemPage
            if fixtureActive {
                let all = TVFixtures.children(of: .object(["Id": .string(seasonID)]))
                page = EmbyItemPage(items: Array(all.dropFirst(append ? episodeOffset : 0).prefix(batchSize)), totalRecordCount: all.count)
            } else if let client {
                page = try await client.episodes(seriesID: seriesID, seasonID: seasonID, startIndex: append ? episodeOffset : 0, limit: batchSize)
            } else { clearEpisodeContext(); return }
            guard episodeCurrent(generation) else { return }
            episodeOffset = (append ? episodeOffset : 0) + page.items.count
            episodeQueue = mergedEpisodes(append ? episodeQueue : [], page.items)
            episodeHasMore = hasMoreEpisodes(page, offset: episodeOffset)
            episodeLoading = false
        } catch { episodeFailed(error, generation: generation) }
    }
    private func hasMoreEpisodes(_ page: EmbyItemPage, offset: Int) -> Bool {
        !page.items.isEmpty && (page.totalRecordCount.map { offset < $0 } ?? (page.items.count == batchSize))
    }
    private func mergedEpisodes(_ old: [JSONValue], _ new: [JSONValue], seasons: Bool = false) -> [JSONValue] {
        var seen = Set<String>()
        // Prefer existing rows: they can contain a stop position not reported to
        // Emby yet. New page/adjacency responses must not erase that local state.
        return (old + new).filter { seen.insert(TVMedia.id($0)).inserted }.map(withLocalEpisodeProgress).sorted {
            let firstSeason = seasons ? 0 : $0["ParentIndexNumber"].number ?? 0
            let secondSeason = seasons ? 0 : $1["ParentIndexNumber"].number ?? 0
            if firstSeason != secondSeason { return firstSeason < secondSeason }
            let first = $0["IndexNumber"].number ?? 0, second = $1["IndexNumber"].number ?? 0
            if first != second { return first < second }
            return TVMedia.id($0) < TVMedia.id($1)
        }
    }
    private func withLocalEpisodeProgress(_ item: JSONValue) -> JSONValue {
        guard item["Type"].string == "Episode", let progress = localEpisodeUserData[TVMedia.id(item)], var object = item.object else { return item }
        object["UserData"] = progress
        return .object(object)
    }
    private func episodeCurrent(_ generation: UUID) -> Bool {
        episodeRequestID == generation && isAuthenticated && !Task.isCancelled
    }
    private func episodeFailed(_ error: Error, generation: UUID) {
        guard episodeCurrent(generation) else { return }
        episodeLoading = false; episodeError = error.localizedDescription
    }
    private func clearEpisodeContext() {
        episodeRequestID = UUID(); episodeQueue = []; episodeSeasons = []; episodeAdjacent = []
        episodeSeriesID = nil; episodeSeasonID = nil; currentEpisodeID = nil
        episodeLoading = false; episodeError = nil; episodeHasMore = false; episodeSeasonsHaveMore = false
        episodeOffset = 0; episodeSeasonOffset = 0
    }

    private func dedicatedServer() async throws -> String {
        let presets = ServerPresets.bundled
        let candidates = ServerPresets.onLocalSubnet(presets.localIP) ? [presets.local, presets.remote] : [presets.remote]
        var lastError: Error = TVError.message("暂时无法连接专属服务器。")
        for candidate in candidates {
            do {
                _ = try await EmbyClient.publicInfo(server: candidate)
                return candidate
            } catch {
                try Task.checkCancellation()
                lastError = error
            }
        }
        throw lastError
    }

    private func updateProgress(item: JSONValue, position: Double, duration: Double) {
        guard position.isFinite, position >= 0 else { return }
        // The stop report follows any outstanding progress report. Keep the
        // local row visible until that sequence finishes, then fetch fresh work
        // ordering and episode counts when the user returns home.
        if client != nil, !fixtureActive { homeDirty = true; pendingStopReports += 1 }
        let completed = duration.isFinite && duration > 0 && position >= max(0, duration - 0.5)
        let seconds = completed ? 0 : min(position, 600_000_000)
        let id = TVMedia.id(item)
        func updated(_ value: JSONValue) -> JSONValue {
            guard TVMedia.id(value) == id, var object = value.object else { return value }
            var userData = value["UserData"].object ?? [:]
            userData["PlaybackPositionTicks"] = .number((seconds * 10_000_000).rounded(.down))
            if duration.isFinite, duration > 0 {
                userData["PlayedPercentage"] = .number(completed ? 100 : min(100, position / duration * 100))
            }
            if completed { userData["Played"] = .bool(true) }
            object["UserData"] = .object(userData)
            return .object(object)
        }
        if let selectedItem { self.selectedItem = updated(selectedItem) }
        if item["Type"].string == "Episode" { localEpisodeUserData[id] = updated(item)["UserData"] }
        episodeQueue = episodeQueue.map(updated)
        episodeAdjacent = episodeAdjacent.map(updated)
        for index in pages.indices { pages[index].items = pages[index].items.map(updated) }
        homeCache.removeAll()
        let workID = item["Type"].string == "Episode" ? item["SeriesId"].string ?? id : id
        if let index = homeCards.firstIndex(where: { $0.id == workID }) {
            homeCards[index].item = updated(homeCards[index].item)
            homeCards[index].resumeItem = seconds > 0 ? updated(item) : nil
        }
        if seconds > 0 {
            if resume.contains(where: { TVMedia.id($0) == id }) {
                resume = resume.map(updated)
            } else {
                resume.insert(updated(item), at: 0)
            }
        } else {
            resume.removeAll { TVMedia.id($0) == id }
        }
    }

    private func beginRequest() -> UUID {
        requestID = UUID()
        busy = true
        error = nil
        return requestID
    }

    private func invalidateRequest() {
        returnPageTask?.cancel(); returnPageTask = nil
        requestID = UUID()
        busy = false
    }

    private func isCurrent(_ id: UUID) -> Bool { requestID == id && !Task.isCancelled }

    private func fail(_ error: Error, request id: UUID) {
        guard isCurrent(id) else { return }
        busy = false
        self.error = error.localizedDescription
        if isAuthenticated { focusTarget = "tv.retry" }
    }
}

private enum TVError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let message): message }
    }
}

enum TVMedia {
    static func id(_ item: JSONValue) -> String { item["Id"].string ?? "unknown" }
    static func title(_ item: JSONValue) -> String { item["Name"].string ?? "未命名媒体" }
    static func plainText(_ value: String) -> String {
        value.replacingOccurrences(of: "<[^>]*>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func isContainer(_ item: JSONValue) -> Bool {
        item["IsFolder"].bool == true || ["CollectionFolder", "UserView", "Folder", "BoxSet", "Series", "Season"].contains(item["Type"].string ?? "")
    }
    static func episodeLabel(_ item: JSONValue) -> String? {
        guard item["Type"].string == "Episode",
              let season = item["ParentIndexNumber"].number, let episode = item["IndexNumber"].number,
              season.isFinite, episode.isFinite, season >= 0, episode >= 0, season <= 9999, episode <= 9999,
              season.rounded() == season, episode.rounded() == episode else { return nil }
        return String(format: "S%02dE%02d", Int(season), Int(episode))
    }
    static func subtitle(_ item: JSONValue) -> String {
        if let episode = episodeLabel(item) {
            return [item["SeriesName"].string, episode].compactMap { $0 }.joined(separator: " · ")
        }
        let year = item["ProductionYear"].number.map { String(boundedInteger($0, maximum: 9999)) }
        let seconds = (item["RunTimeTicks"].number ?? 0) / 10_000_000
        let duration = seconds > 0 ? "\(boundedInteger(seconds / 60, maximum: 10_000_000)) 分钟" : nil
        return [year, duration].compactMap { $0 }.joined(separator: " · ")
    }
    /// Watched, partly watched or unwatched, from the server's user data.
    /// Series and seasons report how many of their episodes are still unwatched.
    static func watchState(_ item: JSONValue) -> TVWatchState {
        let data = item["UserData"]
        if data["Played"].bool == true { return .played }
        if isContainer(item) {
            let count = boundedInteger(data["UnplayedItemCount"].number, maximum: 99_999)
            return count > 0 ? .remaining(count) : .unplayed
        }
        if let percent = data["PlayedPercentage"].number, percent.isFinite, percent > 0, percent < 100 { return .partial(percent / 100) }
        let runtime = (item["RunTimeTicks"].number ?? 0) / 10_000_000
        if resumeSeconds(item) > 0, runtime.isFinite, runtime > 0 { return .partial(min(0.99, resumeSeconds(item) / runtime)) }
        return .unplayed
    }
    static func resumeSeconds(_ item: JSONValue) -> Double {
        let seconds = (item["UserData"]["PlaybackPositionTicks"].number ?? 0) / 10_000_000
        return seconds.isFinite ? min(max(0, seconds), 600_000_000) : 0
    }
    static func time(_ seconds: Double) -> String {
        let total = boundedInteger(seconds, maximum: 600_000_000)
        return total >= 3600 ? String(format: "%d:%02d:%02d", total / 3600, total / 60 % 60, total % 60)
            : String(format: "%d:%02d", total / 60, total % 60)
    }
    private static func boundedInteger(_ value: Double?, maximum: Double) -> Int {
        guard let value, value.isFinite else { return 0 }
        return Int(min(max(0, value), maximum))
    }
}

/// Explicit launch-only fixtures never read or mutate the production Keychain.
private enum TVFixtures {
    static let libraries: [JSONValue] = [
        .object(["Id": .string("fixture.movies"), "Name": .string("电影"), "Type": .string("CollectionFolder"), "CollectionType": .string("movies")]),
        .object(["Id": .string("fixture.series"), "Name": .string("剧集"), "Type": .string("CollectionFolder"), "CollectionType": .string("tvshows")]),
    ]
    static let movie: JSONValue = .object(metadata.merging([
        "Id": .string("fixture.movie"), "Name": .string("星海远航"), "Type": .string("Movie"),
        "ProductionYear": .number(2026), "RunTimeTicks": .number(6_600 * 10_000_000),
        "Overview": .string("隔离测试内容：检验遥控器焦点、影片详情和返回导航。此内容未连接真实媒体服务器。"),
    ], uniquingKeysWith: { _, new in new }))
    static func episode(_ number: Int, season: Int = 1) -> JSONValue {
        var fields = metadata
        fields.merge([
            "Id": .string(season == 1 ? "fixture.episode.\(number)" : "fixture.episode.s\(season).\(number)"),
            "Name": .string(season == 1 ? (number == 1 ? "启程" : "群星之间") : (number == 1 ? "归航" : "新的航线")),
            "Type": .string("Episode"), "SeriesName": .string("星海纪事"), "ParentIndexNumber": .number(Double(season)),
            "SeriesId": .string("fixture.show"), "SeasonId": .string(season == 1 ? "fixture.season" : "fixture.season.\(season)"),
            "SeasonName": .string("第 \(season) 季"),
            "IndexNumber": .number(Double(number)), "RunTimeTicks": .number(2_700 * 10_000_000),
            "Overview": .string("隔离测试剧集，用于检查 SXXEXX 集数标记、切季选集与继续播放入口。"),
            "UserData": .object(["PlaybackPositionTicks": .number(season == 1 && number == 1 ? 4 * 10_000_000 : 0)]),
        ], uniquingKeysWith: { _, new in new })
        return .object(fields)
    }
    static func children(of item: JSONValue) -> [JSONValue] {
        switch TVMedia.id(item) {
        case "fixture.movies": [movie]
        case "fixture.series": [container(id: "fixture.show", name: "星海纪事", type: "Series")]
        case "fixture.show": [season(1), season(2)]
        case "fixture.season": [episode(1), episode(2)]
        case "fixture.season.2": [episode(1, season: 2), episode(2, season: 2)]
        case "tigerest-favorites": [movie, container(id: "fixture.show", name: "星海纪事", type: "Series")]
        default: []
        }
    }
    private static let metadata: [String: JSONValue] = [
        "ProductionYear": .number(2026), "Genres": .array([.string("科幻"), .string("冒险")]),
        "People": .array([.object(["Name": .string("测试导演"), "Type": .string("Director")]),
                          .object(["Name": .string("测试演员"), "Type": .string("Actor"), "Role": .string("船长")])]),
        "MediaSources": .array([.object(["Container": .string("mp4"), "MediaStreams": .array([
            .object(["Type": .string("Video"), "Codec": .string("h264"), "Width": .number(1920), "Height": .number(1080)]),
            .object(["Type": .string("Audio"), "Codec": .string("aac"), "Channels": .number(2)])])])])
    ]
    private static func season(_ number: Int) -> JSONValue {
        var item = container(id: number == 1 ? "fixture.season" : "fixture.season.\(number)", name: "第 \(number) 季", type: "Season").object!
        item["SeriesId"] = .string("fixture.show"); item["IndexNumber"] = .number(Double(number))
        return .object(item)
    }
    static func homeCards(library: JSONValue) -> [EmbyHomeCard] {
        if TVMedia.id(library) == "fixture.movies" { return [EmbyHomeCard(item: movie)] }
        var series = EmbyHomeCard(item: container(id: "fixture.show", name: "星海纪事", type: "Series"), latestEpisode: episode(2), resumeItem: episode(1))
        series.watchState = .init(unwatched: true, played: 0, total: 2)
        return TVMedia.id(library) == "tigerest-favorites" ? [series, EmbyHomeCard(item: movie)] : [series]
    }
    private static func container(id: String, name: String, type: String) -> JSONValue {
        var item = metadata
        item.merge(["Id": .string(id), "Name": .string(name), "Type": .string(type), "IsFolder": .bool(true),
                    "Overview": .string("星海纪事：隔离测试的剧集资料。")], uniquingKeysWith: { _, new in new })
        return .object(item)
    }
}
