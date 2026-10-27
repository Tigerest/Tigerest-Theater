import SwiftUI
import AppleCore
import CryptoKit
import Security

/// Self-reported build details for the comment and danmaku services.
enum TVClient {
    static let headers = ClientIdentity.headers(platform: "tvOS", version: AppVersion.current)
}

actor TVCommentTokenStore: CommunityTokenStore {
    private let account: String
    init(session: EmbySession) {
        account = SHA256.hash(data: Data((session.serverURL + "|" + session.userID).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "top.tigerest.theater.tv.community", kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false] }
    private var tombstone: String { "tv.community.revoked." + account }
    func read() throws -> Data? {
        guard !UserDefaults.standard.bool(forKey: tombstone) else { return nil }
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }; guard status == errSecSuccess else { throw CoreError.invalidRequest }; return result as? Data
    }
    func write(_ data: Data?) throws {
        guard let data else {
            // A failed Keychain deletion must not resurrect this identity next launch.
            // Only this non-sensitive revocation marker lives outside Keychain.
            UserDefaults.standard.set(true, forKey: tombstone)
            let code = SecItemDelete(query as CFDictionary)
            guard code == errSecSuccess || code == errSecItemNotFound else { throw CoreError.invalidRequest }
            return
        }
        let code = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if code == errSecItemNotFound {
            var q = query; q[kSecValueData as String] = data; q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw CoreError.invalidRequest }
        } else if code != errSecSuccess { throw CoreError.invalidRequest }
        UserDefaults.standard.removeObject(forKey: tombstone)
    }
}

@MainActor private final class TVCommentsModel: ObservableObject {
    @Published var channel: CommunityChannel = .publicCommunity
    @Published var scope: String
    @Published var privateAvailable = false
    @Published var comments: [JSONValue] = []
    @Published var nextCursor: String?
    @Published var title = ""
    @Published var status = ""
    @Published var busy = false
    @Published private(set) var hasLoadedComments = false
    @Published var loginRequired = false
    @Published var draft = ""
    @Published var reply: JSONValue?
    @Published var me: JSONValue = .null
    @Published private(set) var item: JSONValue
    @Published private(set) var moderation: JSONValue = .null
    @Published private(set) var terms: JSONValue = .null
    @Published var termsRequired = false
    @Published var termsText = ""
    @Published private(set) var left = false
    @Published var blocked: [JSONValue] = []
    @Published private(set) var blockedCursor: String?
    private var retryAfterTerms = false
    private var flagAttempts: [String: String] = [:]
    private let emby: EmbyClient
    private let community: CommunityClient
    private var hasDiscovered = false
    private var hasSelectedChannel = false
    private var started = false
    private var series: JSONValue = .null
    private var topic: JSONValue = .null
    private var job: Task<Void, Never>?
    private var generation = UUID()
    private var drafts: [String: (String, JSONValue?)] = [:]
    private var key: String { channel.rawValue + ":" + scope }
    /// v1 no longer accepts posts: the dedicated discussion is only read.
    var readOnly: Bool { channel == .privateServer }
    var canSend: Bool { !busy && !loginRequired && !readOnly && !termsRequired && me["muted"].bool != true && topic["id"].string != nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.unicodeScalars.count <= 2000 }
    var canDeleteAccount: Bool { moderation["accountDeletion"]["authKinds"].array?.contains(me["account"]["authKind"]) == true }

    init(item: JSONValue, client: EmbyClient, session: EmbySession, community: CommunityClient? = nil) {
        self.item = item; self.emby = client; scope = item["Type"].string == "Episode" ? "episode" : "work"
        self.community = community ?? CommunityClient(emby: session, store: TVCommentTokenStore(session: session), clientHeaders: TVClient.headers)
    }
    func start() { started = true; refresh() }
    func updateItem(_ item: JSONValue) {
        guard item["Id"] == self.item["Id"], item != self.item else { return }
        if item["SeriesId"] != self.item["SeriesId"] { series = .null }
        self.item = item
        if started { refresh() }
    }
    func select(channel: CommunityChannel? = nil, scope: String? = nil) {
        if channel != nil { hasSelectedChannel = true }
        updateSelection(channel: channel, scope: scope)
        comments = []; nextCursor = nil; topic = .null; me = .null; hasLoadedComments = false
        run { try await self.load($0, reset: true) }
    }
    private func updateSelection(channel: CommunityChannel? = nil, scope: String? = nil) {
        drafts[key] = (draft, reply)
        if let channel { self.channel = channel }; if let scope { self.scope = scope }
        (draft, reply) = drafts[key] ?? ("", nil)
    }
    func refresh() { run { try await self.load($0, reset: true) } }
    private func load(_ id: UUID, reset: Bool) async throws {
        guard current(id) else { return }
        if reset { hasLoadedComments = false }
        // A failed prerequisite remains retryable by refresh or a channel change.
        if !hasDiscovered {
            let available = try await community.privateAvailable()
            guard current(id) else { return }
            privateAvailable = available; hasDiscovered = true
            moderation = try await community.moderation(); terms = try await community.terms()
            guard current(id) else { return }
        }
        if channel == .publicCommunity, series == .null,
           ["Episode", "Season"].contains(item["Type"].string ?? ""), let seriesID = item["SeriesId"].string {
            let series = try await emby.item(id: seriesID)
            guard current(id) else { return }
            self.series = series
        }
        // Every new comment goes to v2; a trusted item without a reliable TMDB identity
        // still shows its old dedicated discussion, read-only.
        if !hasSelectedChannel, channel == .publicCommunity, privateAvailable,
           (try? CommunityClient.mediaIdentity(item: item, series: series, scope: scope)) == nil { updateSelection(channel: .privateServer) }
        let channel = channel, scope = scope
        let me = try await community.me(channel: channel)
        let topic = try await community.resolve(item: item, series: series, scope: scope, channel: channel)
        guard current(id), let topicID = topic["id"].string else { return }
        let page = try await community.comments(topicID: topicID, itemID: item["Id"].string ?? "", channel: channel, cursor: reset ? nil : nextCursor)
        guard current(id) else { return }
        self.me = me; self.topic = topic; self.loginRequired = false; self.left = false; self.title = topic["title"].string ?? item["Name"].string ?? ""
        termsRequired = channel == .publicCommunity && terms["version"].string != nil && me["termsAcceptedVersion"] != terms["version"]
        merge(page["items"].array ?? [], reset: reset); nextCursor = page["nextCursor"].string; hasLoadedComments = true
        status = me["muted"].bool == true ? "你已被禁言，可浏览评论。" : "以 \(me["author"]["name"].string ?? "当前账号") 的身份发言"
    }
    func more() { guard nextCursor != nil else { return }; run { try await self.load($0, reset: false) } }
    func moreReplies(_ comment: JSONValue) {
        guard let cursor = comment["repliesNextCursor"].string, let rootID = comment["id"].string else { return }
        run { id in
            let page = try await self.community.replies(rootID: rootID, itemID: self.item["Id"].string ?? "", channel: self.channel, cursor: cursor)
            guard self.current(id), let index = self.comments.firstIndex(where: { $0["id"].string == rootID }), var fields = self.comments[index].object else { return }
            let existing = fields["replies"]?.array ?? [], ids = Set(existing.compactMap { $0["id"].string })
            fields["replies"] = .array(existing + (page["items"].array ?? []).filter { !ids.contains($0["id"].string ?? "") }); fields["repliesNextCursor"] = page["nextCursor"]
            self.comments[index] = .object(fields)
        }
    }
    func send() {
        guard canSend, let topicID = topic["id"].string else { return }
        let text = draft, reply = reply, channel = channel
        run { id in
            do { _ = try await self.community.send(topicID: topicID, itemID: self.item["Id"].string ?? "", channel: channel, text: text, reply: reply) }
            catch let error as CommunityError where error.code == "TERMS_NOT_ACCEPTED" {
                if self.current(id) { self.termsRequired = true; self.retryAfterTerms = true }; throw error
            }
            guard self.current(id) else { return }
            self.draft = ""; self.reply = nil; self.drafts[self.key] = nil; self.status = "已发送"
            // A successful write is not made to look failed by a later read error.
            do { try await self.load(id, reset: true) } catch { if self.current(id) { self.status = "已发送，列表暂未刷新，请稍后重试。" } }
        }
    }
    func remove(_ comment: JSONValue) {
        guard comment["permissions"]["canDelete"].bool == true, let commentID = comment["id"].string else { return }
        run { id in
            try await self.community.remove(commentID: commentID, itemID: self.item["Id"].string ?? "", channel: self.channel)
            guard self.current(id) else { return }; self.status = "已删除"
            do { try await self.load(id, reset: true) } catch { if self.current(id) { self.status = "已删除，列表暂未刷新，请稍后重试。" } }
        }
    }
    func acceptTerms() {
        guard let version = terms["version"].string else { return }
        run { id in
            _ = try await self.community.acceptTerms(version: version)
            guard self.current(id) else { return }
            self.termsRequired = false; self.me = .null
            if self.retryAfterTerms { self.retryAfterTerms = false; self.busy = false; self.send(); return }
            try await self.load(id, reset: true); if self.current(id) { self.status = "已同意使用条款。" }
        }
    }
    func readTerms() {
        termsText = "正在读取使用条款…"
        Task { let text = (try? await community.termsText()) ?? ""; termsText = text.isEmpty ? "暂时无法读取使用条款，请稍后重试。" : text }
    }
    func flag(_ comment: JSONValue, reason: String) {
        guard let commentID = comment["id"].string else { return }
        // A retry of the same report keeps its UUID.
        let key = commentID + "|" + reason
        let requestID = flagAttempts[key] ?? UUID().uuidString.lowercased(); flagAttempts[key] = requestID
        run { id in
            _ = try await self.community.flag(commentID: commentID, reason: reason, clientRequestID: requestID)
            self.flagAttempts[key] = nil
            guard self.current(id) else { return }
            try await self.load(id, reset: true); if self.current(id) { self.status = "已收到举报，管理员会在 24 小时内处理。" }
        }
    }
    func block(_ author: JSONValue) {
        guard let authorID = author["id"].string else { return }
        let name = author["name"].string ?? "该用户"
        run { id in
            try await self.community.block(authorID: authorID)
            guard self.current(id) else { return }
            try await self.load(id, reset: true); if self.current(id) { self.status = "已屏蔽 \(name)。" }
        }
    }
    func loadBlocked(reset: Bool = true) {
        let cursor = reset ? nil : blockedCursor
        run { id in
            let page = try await self.community.blocks(cursor: cursor)
            guard self.current(id) else { return }
            self.blocked = (reset ? [] : self.blocked) + (page["items"].array ?? []); self.blockedCursor = page["nextCursor"].string; self.status = ""
        }
    }
    func unblock(_ author: JSONValue) {
        guard let authorID = author["id"].string else { return }
        run { id in
            try await self.community.unblock(authorID: authorID)
            guard self.current(id) else { return }
            self.blocked.removeAll { $0["author"]["id"].string == authorID }
            try await self.load(id, reset: true); if self.current(id) { self.status = "已解除屏蔽。" }
        }
    }
    func deleteAccount(password: String?) {
        run { id in
            try await self.community.deleteAccount(password: password)
            let left = await self.community.left
            guard self.current(id) else { return }
            self.me = .null; self.comments = []; self.topic = .null; self.hasLoadedComments = false; self.draft = ""; self.reply = nil
            self.left = left; self.loginRequired = !left
            self.status = "评论账号已注销。" + (left ? "不会自动重新加入。" : "")
        }
    }
    func rejoin() {
        run { id in try await self.community.rejoin(); try await self.load(id, reset: true) }
    }
    func login(username: String, password: String) {
        run { id in try await self.community.login(username: username, password: password); try await self.load(id, reset: true) }
    }
    func close() { started = false; generation = UUID(); job?.cancel(); job = nil; busy = false }
    private func current(_ id: UUID) -> Bool { generation == id && !Task.isCancelled }
    private func merge(_ items: [JSONValue], reset: Bool) {
        let prior = reset ? [] : comments, ids = Set(prior.compactMap { $0["id"].string })
        comments = prior + items.filter { !ids.contains($0["id"].string ?? "") }
    }
    private func run(_ work: @escaping @MainActor (UUID) async throws -> Void) {
        job?.cancel(); let id = UUID(); generation = id; busy = true; status = "正在加载…"
        job = Task { [weak self] in
            guard let self else { return }
            do { try await work(id) }
            catch {
                if current(id) {
                    let code = (error as? CommunityError)?.code ?? ""
                    status = error.localizedDescription; left = code == "COMMUNITY_LEFT"
                    loginRequired = ["LOGIN_REQUIRED", "AUTH_REQUIRED", "AUTH_INVALID", "DELETION_UNKNOWN"].contains(code)
                }
            }
            if current(id) { busy = false }
        }
    }
}

struct TVCommentsView: View {
    @StateObject private var model: TVCommentsModel
    private let item: JSONValue
    private let focusRequest: Int
    @FocusState private var focused: String?
    @State private var username = ""
    @State private var password = ""
    @State private var deleting: JSONValue?
    @State private var flagging: JSONValue?
    @State private var blocking: JSONValue?
    @State private var showingTerms = false
    @State private var showingBlocked = false
    @State private var showingDeletion = false
    @State private var deletionPassword = ""

    init(item: JSONValue, client: EmbyClient, session: EmbySession, focusRequest: Int = 0) {
        self.item = item; self.focusRequest = focusRequest
        _model = StateObject(wrappedValue: TVCommentsModel(item: item, client: client, session: session))
    }

    // The detail owns vertical scrolling and the exit command. This section
    // contributes focus targets directly to that same reading surface.
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                Text("评论区").font(.system(size: 30, weight: .bold))
                    .focusable().focused($focused, equals: "tv.comments.heading")
                    .accessibilityIdentifier("tv.comments.section")
                Spacer()
                Button("刷新评论") { model.refresh() }.disabled(model.busy)
                    .accessibilityIdentifier("tv.comments.refresh")
            }.focusSection()
            HStack(spacing: 22) {
                if model.privateAvailable {
                    Button(model.channel == .privateServer ? "✓ 专属评论（只读）" : "专属评论（只读）") { model.select(channel: .privateServer) }
                        .accessibilityIdentifier("tv.comments.private")
                }
                Button(model.channel == .publicCommunity ? "✓ 公共评论" : "公共评论") { model.select(channel: .publicCommunity) }
                    .accessibilityIdentifier("tv.comments.public")
                Spacer()
                if model.item["Type"].string == "Episode" {
                    Button(model.scope == "episode" ? "✓ 本集评论" : "本集评论") { model.select(scope: "episode") }
                        .accessibilityIdentifier("tv.comments.episode")
                }
                Button(model.scope == "work" ? "✓ 作品评论" : "作品评论") { model.select(scope: "work") }
                    .accessibilityIdentifier("tv.comments.work")
            }.disabled(model.busy).focusSection()
            if !model.title.isEmpty { Text(model.title).font(.title3).lineLimit(2) }
            HStack {
                if model.busy { ProgressView() }
                Text(model.status).font(.callout).foregroundStyle(.secondary)
                    .accessibilityIdentifier("tv.comments.status")
            }
            if model.left {
                VStack(alignment: .leading, spacing: 18) {
                    Text("你已注销评论身份，不会自动重新加入。").foregroundStyle(.secondary)
                    Button("重新加入公共评论") { model.rejoin() }.disabled(model.busy)
                        .accessibilityIdentifier("tv.comments.rejoin")
                }.focusSection()
            } else if model.loginRequired {
                VStack(alignment: .leading, spacing: 18) {
                    HStack {
                        TextField("评论账号", text: $username).textContentType(.username)
                            .accessibilityIdentifier("tv.comments.username")
                        SecureField("评论密码", text: $password).textContentType(.password)
                            .accessibilityIdentifier("tv.comments.password")
                        Button("登录评论账号") {
                            let secret = password; password = ""; model.login(username: username, password: secret)
                        }.disabled(model.busy || username.isEmpty || password.isEmpty)
                            .accessibilityIdentifier("tv.comments.login")
                    }
                    Text("自建服务器的媒体账号密码不会发送给公共评论服务。请使用已有的评论账号。")
                        .font(.caption).foregroundStyle(.secondary)
                }.focusSection()
            } else {
                composer
                if model.channel == .publicCommunity, model.me != .null { account }
                LazyVStack(alignment: .leading, spacing: 20) {
                    if model.hasLoadedComments && model.comments.isEmpty && !model.busy {
                        Text("还没有评论").foregroundStyle(.secondary).padding(24)
                            .accessibilityIdentifier("tv.comments.empty")
                    }
                    ForEach(model.comments, id: \.commentID) { comment in
                        VStack(alignment: .leading, spacing: 16) {
                            row(comment)
                            ForEach(comment["replies"].array ?? [], id: \.commentID) { reply in row(reply).padding(.leading, 50) }
                            if comment["repliesNextCursor"].string != nil {
                                Button("更多回复") { model.moreReplies(comment) }.disabled(model.busy)
                                    .accessibilityIdentifier("tv.comments.moreReplies." + comment.commentID)
                            }
                        }
                        .padding(24).frame(maxWidth: .infinity, alignment: .leading)
                        .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 16))
                    }
                    if model.nextCursor != nil {
                        Button("下一页评论") { model.more() }.disabled(model.busy)
                            .accessibilityIdentifier("tv.comments.more")
                    }
                }.id("tv.comments.list")
            }
        }
        .padding(28).frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 16))
        .tint(Color(red: 0.82, green: 0.68, blue: 0.38))
        .onAppear { model.start() }.onDisappear { model.close() }
        .onChange(of: item) { _, item in model.updateItem(item) }
        .onChange(of: focusRequest) { _, _ in focused = "tv.comments.heading" }
        .alert("删除这条评论？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("取消", role: .cancel) { deleting = nil }
            Button("删除", role: .destructive) { if let deleting { model.remove(deleting) }; deleting = nil }
        }
        .confirmationDialog("举报这条评论", isPresented: Binding(get: { flagging != nil }, set: { if !$0 { flagging = nil } }), titleVisibility: .visible) {
            ForEach(model.moderation["flagReasons"].array?.compactMap(\.string) ?? [], id: \.self) { reason in
                Button(Self.reasons[reason] ?? reason) { if let flagging { model.flag(flagging, reason: reason) }; flagging = nil }
            }
            Button("取消", role: .cancel) { flagging = nil }
        } message: { Text("举报人不会透露给对方。管理员会在 24 小时内处理。") }
        .alert("屏蔽 \(blocking?["name"].string ?? "该用户")？", isPresented: Binding(get: { blocking != nil }, set: { if !$0 { blocking = nil } })) {
            Button("取消", role: .cancel) { blocking = nil }
            Button("屏蔽", role: .destructive) { if let blocking { model.block(blocking) }; blocking = nil }
        } message: { Text("屏蔽后你将看不到 TA 的评论、回复和回复通知，对方不会收到提示。") }
        .sheet(isPresented: $showingTerms) {
            ScrollView { Text(model.termsText).font(.body).padding(60).frame(maxWidth: .infinity, alignment: .leading).focusable() }
        }
        .sheet(isPresented: $showingBlocked) { blockedList }
        .sheet(isPresented: $showingDeletion) { deletion }
    }
    private static let reasons = ["spam": "垃圾广告", "harassment": "辱骂骚扰", "sexual": "色情低俗", "illegal": "违法违规", "other": "其他"]

    private var account: some View {
        HStack(spacing: 26) {
            if model.moderation["blocks"].bool == true {
                Button("已屏蔽的用户") { model.loadBlocked(); showingBlocked = true }.accessibilityIdentifier("tv.comments.blocked")
            }
            if model.canDeleteAccount {
                Button("注销评论账号") { deletionPassword = ""; showingDeletion = true }.accessibilityIdentifier("tv.comments.deleteAccount")
            }
            if let contact = model.terms["contact"].string?.replacingOccurrences(of: "mailto:", with: ""), !contact.isEmpty {
                Text("联系我们：" + contact).font(.caption).foregroundStyle(.secondary)
            }
        }.disabled(model.busy).focusSection()
    }

    private var blockedList: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("已屏蔽的用户").font(.title2.bold())
            if model.blocked.isEmpty && !model.busy { Text("没有屏蔽任何用户。").foregroundStyle(.secondary) }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(model.blocked, id: \.blockedID) { entry in
                        HStack {
                            Text(entry["author"]["name"].string ?? "已注销用户")
                            Spacer()
                            Button("解除屏蔽") { model.unblock(entry["author"]) }.disabled(model.busy)
                        }
                    }
                    if model.blockedCursor != nil { Button("加载更多") { model.loadBlocked(reset: false) }.disabled(model.busy) }
                }
            }
            Text(model.status).font(.callout).foregroundStyle(.secondary)
        }.padding(60)
    }

    private var deletion: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("注销评论账号").font(.title2.bold())
            Text("仅注销评论身份，不会删除 Emby 账号。将删除昵称、头像、屏蔽名单、消息以及你发表的评论正文；有他人回复的评论会显示为「已注销用户」。注销后无法恢复。")
            if model.me["account"]["authKind"].string == "password" {
                SecureField("当前评论密码", text: $deletionPassword).textContentType(.password)
            }
            HStack(spacing: 30) {
                Button("确认注销", role: .destructive) {
                    let secret = model.me["account"]["authKind"].string == "password" ? deletionPassword : nil
                    deletionPassword = ""; showingDeletion = false; model.deleteAccount(password: secret)
                }.disabled(model.busy || (model.me["account"]["authKind"].string == "password" && deletionPassword.isEmpty))
                Button("取消") { deletionPassword = ""; showingDeletion = false }
            }
        }.padding(60)
    }

    @ViewBuilder private var composer: some View {
        if model.readOnly {
            Text("专属评论已停止发言。这部作品缺少可靠的 TMDB 信息，暂时无法在公共评论中讨论。")
                .font(.callout).foregroundStyle(.secondary)
        } else if model.termsRequired {
            VStack(alignment: .leading, spacing: 16) {
                Text("发言前请阅读并同意使用条款：对不当内容和辱骂行为零容忍，违规内容会被删除，违规账号会被禁言或封禁。你可以举报评论或屏蔽用户，举报会在 24 小时内处理。")
                HStack(spacing: 26) {
                    Button("阅读使用条款") { model.readTerms(); showingTerms = true }.accessibilityIdentifier("tv.comments.readTerms")
                    Button("同意并继续") { model.acceptTerms() }.disabled(model.busy).accessibilityIdentifier("tv.comments.acceptTerms")
                }
            }.focusSection()
        } else { editor }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let reply = model.reply {
                HStack {
                    Text("回复 @" + (reply["author"]["name"].string ?? "用户"))
                    Button("取消回复") { model.reply = nil }
                        .accessibilityIdentifier("tv.comments.cancelReply")
                }
            }
            HStack {
                TextField("写下评论（最多 2000 字）", text: $model.draft)
                    .focused($focused, equals: "tv.comments.draft")
                    .accessibilityIdentifier("tv.comments.draft")
                Button("发送") { model.send() }.disabled(!model.canSend)
                    .accessibilityIdentifier("tv.comments.send")
            }.disabled(model.busy || model.me["muted"].bool == true)
        }.focusSection()
    }

    private func row(_ comment: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(comment["author"]["name"].string ?? (comment["state"].string == "blocked_by_viewer" ? "已屏蔽的用户" : "已注销用户")).font(.headline)
                Text(comment["createdAt"].string?.prefix(16).replacingOccurrences(of: "T", with: " ") ?? "")
                    .font(.caption).foregroundStyle(.secondary)
            }
            TVCommentBody(text: Self.text(comment))
                .accessibilityIdentifier("tv.comments.body." + comment.commentID)
            HStack {
                if comment["permissions"]["canReply"].bool == true, comment["state"].string == "visible", !model.readOnly {
                    Button("回复") { model.reply = comment; focused = "tv.comments.draft" }
                        .disabled(model.busy || model.me["muted"].bool == true)
                        .accessibilityIdentifier("tv.comments.reply." + comment.commentID)
                }
                if comment["permissions"]["canDelete"].bool == true {
                    Button("删除") { deleting = comment }.disabled(model.busy)
                        .accessibilityIdentifier("tv.comments.delete." + comment.commentID)
                }
                if model.channel == .publicCommunity, comment["author"]["id"].string != nil, comment["author"]["id"] != model.me["author"]["id"],
                   ["visible", "pending_review"].contains(comment["state"].string ?? "") {
                    if model.moderation["flagReasons"].array?.isEmpty == false, comment["viewerFlagged"].bool != true {
                        Button("举报") { flagging = comment }.disabled(model.busy)
                            .accessibilityIdentifier("tv.comments.flag." + comment.commentID)
                    }
                    if model.moderation["blocks"].bool == true {
                        Button("屏蔽") { blocking = comment["author"] }.disabled(model.busy)
                            .accessibilityIdentifier("tv.comments.block." + comment.commentID)
                    }
                }
            }
        }
    }

    /// Withheld text stays withheld: nothing from an older render fills it in.
    private static func text(_ comment: JSONValue) -> String {
        let target = comment["replyToAuthor"]["name"].string.map { "回复 @\($0)：" } ?? (comment["replyToState"].string == "blocked_by_viewer" ? "回复已屏蔽用户：" : "")
        switch comment["state"].string {
        case "visible": return comment["viewerFlagged"].bool == true ? "你已举报这条评论" : target + (comment["body"].string ?? "")
        case "pending_review": return comment["body"].string.map { target + $0 + "\n（内容待审核，仅你可见）" } ?? "内容待审核"
        case "blocked_by_viewer": return "你已屏蔽此用户的评论"
        default: return "评论已删除"
        }
    }
}

private extension JSONValue {
    var commentID: String { self["id"].string ?? "" }
    var blockedID: String { self["author"]["id"].string ?? "" }
}

/// Keep each focus target shorter than the reading viewport. Focusing successive
/// segments scrolls even very long comments, including read-only/deleted rows.
private struct TVCommentBody: View {
    let text: String
    private var segments: [String] {
        var result: [String] = [], segment = "", lineBreaks = 0
        for character in text {
            segment.append(character)
            if character.isNewline { lineBreaks += 1 }
            if segment.count >= 160 || lineBreaks >= 3 {
                result.append(segment); segment = ""; lineBreaks = 0
            }
        }
        if !segment.isEmpty { result.append(segment) }
        return result
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                TVCommentReadingSegment(text: segment)
            }
        }
    }
}

private struct TVCommentReadingSegment: View {
    let text: String
    @FocusState private var focused: Bool
    var body: some View {
        Text(text).font(.body).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading).padding(10)
            .background(focused ? Color.white.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 8))
            .focusable().focused($focused)
    }
}
