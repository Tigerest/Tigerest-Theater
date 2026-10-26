import AppleCore
import SwiftUI

struct TVRootView: View {
    @ObservedObject var model: TVAppModel
    @FocusState private var focused: String?
    @State private var showQuality = false
    @State private var choosingSort = false
    @State private var searchText = ""
    private let columns = [GridItem(.adaptive(minimum: 210, maximum: 260), spacing: 32, alignment: .top)]

    var body: some View {
        let exitContext = model.navigationContext
        ZStack {
            LinearGradient(colors: [Color(red: 0.043, green: 0.051, blue: 0.071), .black],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
                .ignoresSafeArea()
            VStack(alignment: .leading, spacing: 30) {
                header.focusSection()
                if let error = model.error {
                    errorBanner(error)
                }
                if model.isAuthenticated {
                    if let item = model.selectedItem {
                        TVDetailView(model: model, item: item)
                    } else if let page = model.currentPage, ["Series", "Season"].contains(page.item["Type"].string ?? "") {
                        TVDetailView(model: model, item: page.item, children: page.items, hasMore: page.hasMore)
                    } else if model.currentPage == nil {
                        TVHomeView(model: model)
                    } else {
                        browsing
                    }
                } else {
                    TVLoginView(model: model)
                }
            }
            .padding(.horizontal, 64)
            .padding(.vertical, 32)
        }
        .preferredColorScheme(.dark)
        .modifier(TVExitHandler(enabled: !showQuality && !model.showServerPicker && (model.canGoBack || (!model.isAuthenticated && model.serverMode != nil))) {
            model.handleExit(from: exitContext)
        })
        .fullScreenCover(isPresented: $model.showServerPicker, onDismiss: { model.closeServerSettings() }) { TVServerPickerView(model: model) }
        .fullScreenCover(isPresented: $showQuality) { TVQualitySettings(player: model.player) }
        .onChange(of: model.focusTarget) { _, target in focused = target }
    }

    private var header: some View {
        HStack(spacing: 24) {
            if model.canGoBack {
                Button { model.goBack() } label: { Label("返回", systemImage: "chevron.left") }
                    .accessibilityIdentifier("tv.back")
                    .focused($focused, equals: "tv.back")
            }
            VStack(alignment: .leading, spacing: 7) {
                Text("大河影院").font(.system(size: model.isAuthenticated ? 29 : 42, weight: .bold, design: .rounded))
                if !model.pages.isEmpty {
                    Text(model.pages.map(\.title).joined(separator: "  /  "))
                        .font(.callout).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            if model.fixtureMode {
                Label("隔离测试", systemImage: "testtube.2")
                    .font(.callout).foregroundStyle(.orange)
            }
            if model.busy {
                ProgressView().accessibilityLabel("正在加载")
            }
            if model.isAuthenticated {
                Button { model.openServerSettings() } label: { Label("服务器", systemImage: "server.rack") }
                    .accessibilityIdentifier("tv.servers").focused($focused, equals: "tv.servers")
                Button { showQuality = true } label: { Label("画质", systemImage: "sparkles.tv") }
                    .accessibilityIdentifier("tv.quality")
                    .focused($focused, equals: "tv.quality")
                if !model.canGoBack {
                    Button { Task { await model.refresh() } } label: { Label("刷新", systemImage: "arrow.clockwise") }
                        .disabled(model.busy)
                        .accessibilityIdentifier("tv.refresh")
                        .focused($focused, equals: "tv.refresh")
                }
                Button { Task { await model.logout() } } label: { Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right") }
                    .accessibilityIdentifier("tv.logout")
                    .focused($focused, equals: "tv.logout")
            }
        }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 24) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(message).font(.callout).lineLimit(3)
            Spacer(minLength: 16)
            if model.isAuthenticated {
                Button("重试") { Task { await model.retry() } }
                    .disabled(model.busy)
                    .accessibilityIdentifier("tv.retry")
                    .focused($focused, equals: "tv.retry")
            }
        }
        .padding(24)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
        .accessibilityIdentifier("tv.error")
    }

    private var browsing: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 44) {
                    if let page = model.currentPage {
                        Text(page.title).font(.largeTitle.bold())
                        if model.currentPageIsLibrary { libraryTools(page) }
                        if page.items.isEmpty, !model.busy, model.error == nil {
                            if page.search.isEmpty { emptyState("这里还没有媒体", symbol: "film") }
                            else { emptyState("没有找到「\(page.search)」", symbol: "magnifyingglass") }
                        }
                        itemGrid(page.items)
                        if page.hasMore {
                            Button("加载更多") { Task { await model.loadMore() } }
                                .disabled(model.busy)
                                .accessibilityIdentifier("tv.loadMore")
                                .focused($focused, equals: "tv.loadMore")
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }
            .onAppear { revealBrowseTarget(model.focusTarget, using: proxy) }
            .onChange(of: model.focusTarget) { _, target in revealBrowseTarget(target, using: proxy) }
        }
        .accessibilityIdentifier("tv.browse")
    }

    /// Sort and search for a library's poster wall.
    private func libraryTools(_ page: TVBrowsePage) -> some View {
        HStack(spacing: 28) {
            Button { choosingSort = true } label: {
                Label("排序：" + model.librarySort.title, systemImage: "arrow.up.arrow.down")
            }
            .disabled(model.busy)
            .accessibilityIdentifier("tv.library.sort")
            .focused($focused, equals: "tv.library.sort")
            TextField("搜索这个媒体库", text: $searchText)
                .frame(width: 560)
                .onSubmit { Task { await model.searchLibrary(searchText) } }
                .accessibilityIdentifier("tv.library.search")
                .focused($focused, equals: "tv.library.search")
            if !page.search.isEmpty {
                Button("清除搜索") { searchText = ""; Task { await model.searchLibrary("") } }
                    .disabled(model.busy)
                    .accessibilityIdentifier("tv.library.clearSearch")
            }
            Spacer()
        }
        .font(.system(size: 24, weight: .semibold))
        .focusSection()
        .onAppear { searchText = page.search }
        .onChange(of: page.id) { _, _ in searchText = page.search }
        .confirmationDialog("排序", isPresented: $choosingSort) {
            ForEach(EmbyLibrarySort.allCases, id: \.rawValue) { sort in
                Button((sort == model.librarySort ? "✓ " : "") + sort.title) { Task { await model.setLibrarySort(sort) } }
            }
        }
    }

    private func revealBrowseTarget(_ target: String?, using proxy: ScrollViewProxy) {
        guard let target, target.hasPrefix("tv.item.") else { return }
        proxy.scrollTo(String(target.dropFirst("tv.item.".count)), anchor: .center)
        focused = target
    }

    private func itemGrid(_ items: [JSONValue]) -> some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 40) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                Button { Task { await model.open(item) } } label: {
                    TVMediaCard(item: item, imageURL: model.client?.homeArtworkURL(for: item, purpose: .poster), artworkAspectRatio: 2.0 / 3.0)
                }
                .buttonStyle(TVGalleryButtonStyle()).focusEffectDisabled()
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(focused == "tv.item.\(TVMedia.id(item))" ? Color(red: 0.94, green: 0.78, blue: 0.47) : .clear, lineWidth: 3))
                .scaleEffect(focused == "tv.item.\(TVMedia.id(item))" ? 1.025 : 1)
                .accessibilityLabel([TVMedia.title(item), TVMedia.subtitle(item)].filter { !$0.isEmpty }.joined(separator: ", "))
                .accessibilityIdentifier("tv.item.\(TVMedia.id(item))")
                .focused($focused, equals: "tv.item.\(TVMedia.id(item))")
                .id(TVMedia.id(item))
            }
        }
    }

    private func emptyState(_ title: String, symbol: String) -> some View {
        VStack(spacing: 20) {
            Image(systemName: symbol).font(.system(size: 65)).foregroundStyle(.secondary)
            Text(title).font(.title3).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 300)
    }
}

struct TVLoginView: View {
    @ObservedObject var model: TVAppModel
    @State private var username = ""
    @State private var password = ""
    @FocusState private var focused: String?

    var body: some View {
        HStack(spacing: 100) {
            VStack(alignment: .leading, spacing: 28) {
                Image(systemName: "tv").font(.system(size: 110, weight: .light)).foregroundStyle(.cyan)
                Text("让好电影\n回到大屏幕").font(.system(size: 64, weight: .bold)).lineSpacing(12)
                Text(model.serverMode == nil ? "选择服务器，开始观看你的媒体库。" : "使用 Emby 或 Jellyfin 账户登录。\n可通过 iPhone 或 iPad 输入文字。")
                    .font(.title3).foregroundStyle(.secondary).lineSpacing(10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if let mode = model.serverMode {
                    Text(mode == .dedicated ? "专属服务器" : "自建服务器").font(.title.bold())
                    if let error = model.error { Text(error).font(.callout).foregroundStyle(.orange) }
                    if mode == .selfHosted {
                        TextField("服务器地址（含 http:// 或 https://）", text: $model.serverURL)
                            .accessibilityIdentifier("tv.login.server")
                            .focused($focused, equals: "server")
                    }
                    TextField("用户名", text: $username)
                        .textContentType(.username)
                        .accessibilityIdentifier("tv.login.username")
                        .focused($focused, equals: "username")
                    SecureField("密码", text: $password)
                        .textContentType(.password)
                        .accessibilityIdentifier("tv.login.password")
                        .focused($focused, equals: "password")
                    HStack(spacing: 24) {
                        Button("登录") {
                            let submittedPassword = password
                            password = ""
                            Task { await model.login(username: username, password: submittedPassword) }
                        }
                        .disabled(model.busy)
                        .accessibilityIdentifier("tv.login.submit")
                        .focused($focused, equals: "submit")
                        Button("更换服务器") {
                            password = ""
                            model.resetServerSelection()
                        }
                        .accessibilityIdentifier("tv.login.changeServer")
                    }
                    .padding(.top, 8)
                } else {
                    TVServerListView(model: model)
                    Text("连接服务器").font(.title.bold())
                    if !Distribution.testFlight {
                        modeButton("专属服务器", subtitle: "自动选择可用线路", symbol: "sparkles.tv", mode: .dedicated)
                            .accessibilityIdentifier("tv.mode.dedicated")
                            .focused($focused, equals: "dedicated")
                    }
                    modeButton("自建服务器", subtitle: "输入你的 Emby 或 Jellyfin 服务器地址", symbol: "server.rack", mode: .selfHosted)
                        .accessibilityIdentifier("tv.mode.selfHosted")
                        .focused($focused, equals: "selfHosted")
                }
            }
            }.frame(width: 650)
        }
        .padding(.horizontal, 30)
        .frame(maxHeight: .infinity)
        .onAppear { focused = model.serverMode == nil ? firstMode : model.serverMode == .selfHosted ? "server" : "username" }
        .onChange(of: model.serverMode) { _, mode in
            password = ""
            focused = mode == nil ? firstMode : mode == .selfHosted ? "server" : "username"
        }
    }

    private var firstMode: String { Distribution.testFlight ? "selfHosted" : "dedicated" }

    private func modeButton(_ title: String, subtitle: String, symbol: String, mode: TVServerMode) -> some View {
        Button { model.selectServer(mode) } label: {
            HStack(spacing: 24) {
                Image(systemName: symbol).font(.title)
                VStack(alignment: .leading, spacing: 8) {
                    Text(title).font(.title3.bold())
                    Text(subtitle).font(.callout).opacity(0.7)
                }
                Spacer()
                Image(systemName: "chevron.right")
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct TVMediaCard: View {
    let item: JSONValue
    let imageURL: URL?
    var artworkAspectRatio: CGFloat = 16.0 / 9.0
    /// Episode lists also mark what has not been watched; poster walls only
    /// mark watched work and the unwatched episode count.
    var marksUnplayed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TVArtwork(url: imageURL, symbol: TVMedia.isContainer(item) ? "rectangle.stack.fill" : "play.rectangle.fill")
                .aspectRatio(artworkAspectRatio, contentMode: .fit)
                .overlay(alignment: .bottomTrailing) {
                    if let episode = TVMedia.episodeLabel(item) {
                        Text(episode).font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 7)
                            .background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 8))
                            .padding(12)
                    }
                }
                .overlay(alignment: .topTrailing) { TVWatchBadge(state: TVMedia.watchState(item), marksUnplayed: marksUnplayed).padding(10) }
                .overlay(alignment: .bottom) { TVWatchProgress(state: TVMedia.watchState(item)) }
            VStack(alignment: .leading, spacing: 8) {
                Text(TVMedia.title(item)).font(.headline).lineLimit(1)
                let subtitle = TVMedia.subtitle(item)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                if TVMedia.resumeSeconds(item) > 0 {
                    Text("已看到 \(TVMedia.time(TVMedia.resumeSeconds(item)))")
                        .font(.caption).foregroundStyle(.cyan)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, minHeight: 105, alignment: .topLeading)
            .background(Color(white: 0.11))
        }
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

/// Corner badge: unwatched episode count, watched, or (in episode lists) unwatched.
struct TVWatchBadge: View {
    let state: TVWatchState
    var marksUnplayed = false
    private let gold = Color(red: 0.94, green: 0.78, blue: 0.47)
    var body: some View {
        switch state {
        case .remaining(let count):
            badge("\(count) 集未看", foreground: .black, background: gold).accessibilityLabel("\(count) 集未看")
        case .played:
            badge("✓ 已看", foreground: .white, background: Color(red: 0.16, green: 0.55, blue: 0.33)).accessibilityLabel("已看完")
        case .unplayed where marksUnplayed:
            badge("未看", foreground: .white, background: Color(red: 0.12, green: 0.43, blue: 0.82)).accessibilityLabel("未看")
        default:
            EmptyView()
        }
    }
    private func badge(_ text: String, foreground: Color, background: Color) -> some View {
        Text(text).font(.system(size: 18, weight: .bold)).foregroundStyle(foreground)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(background, in: Capsule())
            .shadow(color: .black.opacity(0.4), radius: 6, y: 2)
    }
}

/// Bar along the artwork's bottom edge for partly watched items.
struct TVWatchProgress: View {
    let state: TVWatchState
    var body: some View {
        if case .partial(let fraction) = state {
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Rectangle().fill(.black.opacity(0.55))
                    Rectangle().fill(Color(red: 0.94, green: 0.78, blue: 0.47)).frame(width: geometry.size.width * max(0.02, min(1, fraction)))
                }
            }
            .frame(height: 7)
            .accessibilityLabel("看到 \(Int((fraction * 100).rounded()))%")
        }
    }
}

struct TVArtwork: View {
    let url: URL?
    let symbol: String
    var body: some View {
        GeometryReader { geometry in
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    ZStack {
                        LinearGradient(colors: [Color(red: 0.12, green: 0.27, blue: 0.39), Color(red: 0.06, green: 0.12, blue: 0.22)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                        if !symbol.isEmpty {
                            Image(systemName: symbol).font(.system(size: 65, weight: .light)).foregroundStyle(.white.opacity(0.5))
                        }
                    }
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
        }
        .accessibilityHidden(true)
    }
}

private struct TVExitHandler: ViewModifier {
    let enabled: Bool
    let action: () -> Void
    @ViewBuilder func body(content: Content) -> some View {
        if enabled { content.onExitCommand(perform: action) } else { content }
    }
}
