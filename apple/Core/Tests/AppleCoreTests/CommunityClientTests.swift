import Foundation
import Testing
@testable import AppleCore

private final class CommentFixture: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) async throws -> (Int, JSONValue))?
    private let stateLock = NSLock()
    private var work: Task<Void, Never>?
    private var stopped = false
    static func session(_ block: @escaping @Sendable (URLRequest) async throws -> (Int, JSONValue)) -> URLSession {
        lock.withLock { handler = block }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [Self.self]
        return URLSession(configuration: config)
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let task = Task {
            do {
                let block = Self.lock.withLock { Self.handler! }; let (status, json) = try await block(request)
                guard !Task.isCancelled else { return }
                client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: [:])!, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: try JSONEncoder().encode(json)); client?.urlProtocolDidFinishLoading(self)
            } catch { if !Task.isCancelled { client?.urlProtocol(self, didFailWithError: error) } }
        }
        stateLock.withLock { if stopped { task.cancel() } else { work = task } }
    }
    override func stopLoading() { stateLock.withLock { stopped = true; work?.cancel() } }
}
private func value(_ object: [String: Any]) throws -> JSONValue { try JSONValue(any: object) }
private let trustedID = "62526c3bf747439c99327ddec5fed4a8"
private func communityEmby() -> EmbySession { .init(serverURL: "https://emby.test/", userID: "user1", accessToken: "PRIVATE-EMBY", deviceID: "tv") }
private func capabilities() throws -> JSONValue { try value(["data": ["enabled": true, "auth": ["password", "emby-exchange"], "mediaIdentity": "tmdb-aired", "embyExchangeServerId": trustedID]]) }
private func requestJSON(_ request: URLRequest) throws -> JSONValue {
    var data = request.httpBody ?? Data()
    if data.isEmpty, let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }; var buffer = [UInt8](repeating: 0, count: 4096)
        while true { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(contentsOf: buffer.prefix(n)) }
    }
    return try JSONDecoder().decode(JSONValue.self, from: data)
}
private final class CommentRequests: @unchecked Sendable {
    private let lock = NSLock(); private var rows: [JSONValue] = []
    func append(_ value: JSONValue) -> Int { lock.withLock { rows.append(value); return rows.count } }
    var values: [JSONValue] { lock.withLock { rows } }
}
private actor CommentGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async { if !isOpen { await withCheckedContinuation { waiters.append($0) } } }
    func open() { isOpen = true; let pending = waiters; waiters = []; pending.forEach { $0.resume() } }
}
private actor CommentStore: CommunityTokenStore {
    private var data: Data?
    private var readGate: CommentGate?
    private let readStarted: CommentGate?
    init(_ value: JSONValue, readGate: CommentGate? = nil, readStarted: CommentGate? = nil) throws {
        data = try JSONEncoder().encode(value); self.readGate = readGate; self.readStarted = readStarted
    }
    func read() async -> Data? {
        let snapshot = data
        if let gate = readGate { readGate = nil; await readStarted?.open(); await gate.wait() }
        return snapshot
    }
    func write(_ data: Data?) { self.data = data }
}
private func credentials(_ name: String, expired: Bool = false) throws -> JSONValue {
    try value(["accessToken": name + "-access", "refreshToken": name + "-refresh", "tokenType": "Bearer",
               "expiresAt": expired ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
               "refreshExpiresAt": "2099-02-01T00:00:00Z", "author": ["id": name, "name": name], "kind": "password"])
}

@Suite(.serialized) struct CommunityClientTests {
    @Test func privateHeadersOnlyAfterCapabilityTrust() async throws {
        let transport = CommentFixture.session { request in
            if request.url!.path.hasSuffix("/capabilities") {
                #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == nil); return (200, try capabilities())
            }
            #expect(request.url!.path == "/community/v1/topics/topic/comments")
            #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == "PRIVATE-EMBY")
            #expect(request.value(forHTTPHeaderField: "X-Tigerest-Item-Id") == "episode")
            return (200, try value(["data": ["items": [], "nextCursor": NSNull()]]))
        }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: trustedID, urlSession: transport)
        _ = try await client.comments(topicID: "topic", itemID: "episode", channel: .privateServer)
    }
    @Test func servicesAreHTTPSExceptTheLANDiscussion() async throws {
        let calls = CommentRequests()
        let transport = CommentFixture.session { request in
            _ = calls.append(.string(request.url!.absoluteString))
            if request.url!.path.hasSuffix("/capabilities") { return (200, try capabilities()) }
            return (200, try value(["data": ["items": [], "nextCursor": NSNull()]]))
        }
        defer { transport.invalidateAndCancel() }
        let lan = EmbySession(serverURL: "http://192.168.5.150:8095/", userID: "user1", accessToken: "PRIVATE-EMBY", deviceID: "tv")
        _ = try await CommunityClient(emby: lan, serverID: trustedID, urlSession: transport).comments(topicID: "topic", itemID: "episode", channel: .privateServer)
        _ = try await CommunityClient(emby: communityEmby(), serverID: trustedID, urlSession: transport).comments(topicID: "topic", itemID: "episode", channel: .privateServer)
        let urls = calls.values.compactMap(\.string)
        #expect(urls.contains { $0.hasPrefix("http://192.168.5.150:18443/community/v1/topics/topic/comments") }, "\(urls)")
        #expect(urls.contains { $0.hasPrefix("https://nas.tigerest.top:18446/community/v1/topics/topic/comments") }, "\(urls)")
        #expect(urls.filter { $0.contains("/community/v2/") }.allSatisfy { $0.hasPrefix("https://nas.tigerest.top:18446/community/v2/") })
        #expect(!urls.contains { $0.contains(":18443") && $0.contains("nas.tigerest.top") })
    }
    @Test func foreignServerCannotUsePrivateAuth() async throws {
        let calls = CommentRequests()
        let transport = CommentFixture.session { request in
            _ = calls.append(.string(request.url!.path)); #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == nil)
            return (200, try capabilities())
        }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: "foreign", urlSession: transport)
        await #expect(throws: CommunityError.self) { try await client.comments(topicID: "topic", itemID: "episode", channel: .privateServer) }
        #expect(calls.values.count == 1)
    }
    @Test func publicExchangeThenBearerOnly() async throws {
        let transport = CommentFixture.session { request in
            let path = request.url!.path
            if path.hasSuffix("/capabilities") { return (200, try capabilities()) }
            if path.hasSuffix("/auth/emby") {
                #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == "PRIVATE-EMBY")
                return (200, try value(["data": ["accessToken": "access-token", "refreshToken": "refresh-token", "tokenType": "Bearer", "expiresAt": "2099-01-01T00:00:00Z", "refreshExpiresAt": "2099-02-01T00:00:00Z", "author": ["id": "a", "name": "A"]]]))
            }
            #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == nil)
            #expect(request.value(forHTTPHeaderField: "X-Tigerest-Item-Id") == nil)
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer access-token")
            return (200, try value(["data": ["author": ["id": "a", "name": "A"]]]))
        }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: trustedID, urlSession: transport)
        _ = try await client.me(channel: .publicCommunity)
    }
    @Test func uncertainSendRetainsIdempotencyKeyAndDraft() async throws {
        let sends = CommentRequests()
        let transport = CommentFixture.session { request in
            if request.url!.path.hasSuffix("/capabilities") { return (200, try capabilities()) }
            let body = try requestJSON(request); let count = sends.append(body)
            if count == 1 { throw URLError(.networkConnectionLost) }
            return (200, try value(["data": ["id": "accepted"]]))
        }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: trustedID, urlSession: transport)
        await #expect(throws: (any Error).self) { try await client.send(topicID: "topic", itemID: "episode", channel: .privateServer, text: " hello ") }
        _ = try await client.send(topicID: "topic", itemID: "episode", channel: .privateServer, text: " hello ")
        #expect(sends.values.count == 2)
        #expect(sends.values[0]["clientRequestId"] == sends.values[1]["clientRequestId"])
        #expect(sends.values[1]["body"].string == "hello")
    }
    @Test func publicIdentityUsesSeriesAndRejectsAmbiguousOrder() throws {
        let item = try value(["Type": "Episode", "ProviderIds": ["Tmdb": "999"], "ParentIndexNumber": 0, "IndexNumber": 2])
        let series = try value(["Type": "Series", "ProviderIds": ["Tmdb": "123"], "DisplayOrder": "Aired"])
        let identity = try CommunityClient.mediaIdentity(item: item, series: series, scope: "episode")
        #expect(identity["tmdbId"].string == "123"); #expect(identity["season"].number == 0)
        #expect(throws: CommunityError.self) { try CommunityClient.mediaIdentity(item: item, series: .null, scope: "work") }
        #expect(throws: CommunityError.self) { try CommunityClient.mediaIdentity(item: item, series: value(["ProviderIds": ["Tmdb": "123"], "DisplayOrder": "DVD"]), scope: "episode") }
    }
    @Test func unsafeIdentifiersAndOversizedCommentsNeverReachNetwork() async throws {
        let transport = CommentFixture.session { _ in Issue.record("Unexpected network request"); return (500, .null) }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: trustedID, urlSession: transport)
        await #expect(throws: CommunityError.self) { try await client.comments(topicID: "../secret", itemID: "item", channel: .privateServer) }
        await #expect(throws: CommunityError.self) { try await client.send(topicID: "topic", itemID: "item", channel: .privateServer, text: String(repeating: "字", count: 2001)) }
    }

    @Test func uncertainSendSurvivesAnotherContext() async throws {
        let sends = CommentRequests()
        let transport = CommentFixture.session { request in
            if request.url!.path.hasSuffix("/capabilities") { return (200, try capabilities()) }
            let count = sends.append(try requestJSON(request))
            if count <= 2 { throw URLError(.networkConnectionLost) }
            return (200, try value(["data": ["id": "accepted"]]))
        }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: trustedID, urlSession: transport)
        await #expect(throws: (any Error).self) { try await client.send(topicID: "episode-topic", itemID: "episode", channel: .privateServer, text: "episode draft") }
        await #expect(throws: (any Error).self) { try await client.send(topicID: "work-topic", itemID: "episode", channel: .privateServer, text: "work draft") }
        _ = try await client.send(topicID: "episode-topic", itemID: "episode", channel: .privateServer, text: "episode draft")
        #expect(sends.values.count == 3)
        #expect(sends.values[0]["clientRequestId"] == sends.values[2]["clientRequestId"])
        #expect(sends.values[0]["clientRequestId"] != sends.values[1]["clientRequestId"])
    }

    @Test func delayedStoreReadCannotRestoreLoggedOutIdentity() async throws {
        let gate = CommentGate(), started = CommentGate(), reads = CommentRequests()
        let store = try CommentStore(credentials("A"), readGate: gate, readStarted: started)
        let transport = CommentFixture.session { request in
            if request.url!.path.hasSuffix("/capabilities") { return (200, try capabilities()) }
            _ = reads.append(.string(request.url!.path))
            return (200, try value(["data": ["author": ["id": "A", "name": "A"]]]))
        }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: "foreign", urlSession: transport, store: store)
        let oldRead = Task { try await client.me(channel: .publicCommunity) }
        await started.wait()
        await client.logout()
        await gate.open()
        await #expect(throws: CancellationError.self) { try await oldRead.value }
        await #expect(throws: CommunityError.self) { try await client.me(channel: .publicCommunity) }
        #expect(reads.values.isEmpty)
        #expect(await store.read() == nil)
    }

    @Test func retiredNetworkFailureCannotAffectNewLogin() async throws {
        let gate = CommentGate(), started = CommentGate()
        let store = try CommentStore(credentials("A"))
        let transport = CommentFixture.session { request in
            if request.url!.path.hasSuffix("/capabilities") { return (200, try capabilities()) }
            if request.url!.path.hasSuffix("/auth/login") { return (200, .object(["data": try credentials("B")])) }
            if request.value(forHTTPHeaderField: "Authorization") == "Bearer A-access" {
                await started.open(); await gate.wait(); throw URLError(.networkConnectionLost)
            }
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer B-access")
            return (200, try value(["data": ["author": ["id": "B", "name": "B"]]]))
        }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: "foreign", urlSession: transport, store: store)
        let oldRead = Task { try await client.me(channel: .publicCommunity) }
        await started.wait()
        try await client.login(username: "B", password: "test-password")
        await gate.open()
        await #expect(throws: CancellationError.self) { try await oldRead.value }
        let me = try await client.me(channel: .publicCommunity)
        #expect(me["author"]["id"].string == "B")
        let saved = try JSONDecoder().decode(JSONValue.self, from: #require(await store.read()))
        #expect(saved["author"]["id"].string == "B")
    }

    @Test func delayedUnauthorizedResponseReusesAlreadyRotatedToken() async throws {
        let gate = CommentGate(), started = CommentGate(), oldReads = CommentRequests(), refreshes = CommentRequests()
        let store = try CommentStore(credentials("A"))
        let transport = CommentFixture.session { request in
            if request.url!.path.hasSuffix("/capabilities") { return (200, try capabilities()) }
            if request.url!.path.hasSuffix("/auth/refresh") {
                _ = refreshes.append(try requestJSON(request))
                return (200, .object(["data": try credentials("rotated")]))
            }
            if request.value(forHTTPHeaderField: "Authorization") == "Bearer A-access" {
                if oldReads.append(.string("read")) == 1 { await started.open(); await gate.wait() }
                return (401, try value(["error": ["code": "AUTH_INVALID"]]))
            }
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer rotated-access")
            return (200, try value(["data": ["author": ["id": "A", "name": "A"]]]))
        }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: "foreign", urlSession: transport, store: store)
        let delayed = Task { try await client.me(channel: .publicCommunity) }
        await started.wait()
        _ = try await client.me(channel: .publicCommunity)
        await gate.open()
        _ = try await delayed.value
        #expect(refreshes.values.count == 1)
        #expect(refreshes.values.first?["refreshToken"].string == "A-refresh")
    }

    @Test(arguments: [401, 429]) func retiredHTTPFailureCannotRevokeOrRateLimitNewLogin(status: Int) async throws {
        let gate = CommentGate(), started = CommentGate()
        let store = try CommentStore(credentials("A"))
        let transport = CommentFixture.session { request in
            if request.url!.path.hasSuffix("/capabilities") { return (200, try capabilities()) }
            if request.url!.path.hasSuffix("/auth/login") { return (200, .object(["data": try credentials("B")])) }
            if request.value(forHTTPHeaderField: "Authorization") == "Bearer A-access" {
                await started.open(); await gate.wait()
                return (status, try value(["error": ["code": status == 401 ? "AUTH_INVALID" : "RATE_LIMITED"]]))
            }
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer B-access")
            #expect(request.httpMethod == "POST")
            return (200, try value(["data": ["id": "new-account-comment"]]))
        }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: "foreign", urlSession: transport, store: store)
        let retired = Task { try await client.me(channel: .publicCommunity) }
        await started.wait()
        try await client.login(username: "B", password: "test-password")
        await gate.open()
        await #expect(throws: CancellationError.self) { try await retired.value }
        let sent = try await client.send(topicID: "topic", itemID: "item", channel: .publicCommunity, text: "new account draft")
        #expect(sent["id"].string == "new-account-comment")
        let saved = try JSONDecoder().decode(JSONValue.self, from: #require(await store.read()))
        #expect(saved["author"]["id"].string == "B")
    }

    @Test func rotatingRefreshTombstonesOldSecretBeforeDispatch() async throws {
        let store = try CommentStore(credentials("A", expired: true)), refreshes = CommentRequests()
        let transport = CommentFixture.session { request in
            if request.url!.path.hasSuffix("/capabilities") { return (200, try capabilities()) }
            if request.url!.path.hasSuffix("/auth/refresh") {
                #expect(await store.read() == nil)
                _ = refreshes.append(try requestJSON(request))
                return (200, .object(["data": try credentials("rotated")]))
            }
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer rotated-access")
            return (200, try value(["data": ["author": ["id": "A", "name": "A"]]]))
        }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: "foreign", urlSession: transport, store: store)
        _ = try await client.me(channel: .publicCommunity)
        _ = try await client.me(channel: .publicCommunity)
        #expect(refreshes.values.count == 1)
        #expect(refreshes.values.first?["refreshToken"].string == "A-refresh")
        let saved = try JSONDecoder().decode(JSONValue.self, from: #require(await store.read()))
        #expect(saved["refreshToken"].string == "rotated-refresh")
    }

    @Test func logoutDuringRefreshKeepsCredentialsRevoked() async throws {
        let gate = CommentGate(), started = CommentGate(), authorizedReads = CommentRequests()
        let store = try CommentStore(credentials("A", expired: true))
        let transport = CommentFixture.session { request in
            if request.url!.path.hasSuffix("/capabilities") { return (200, try capabilities()) }
            if request.url!.path.hasSuffix("/auth/refresh") {
                await started.open(); await gate.wait()
                return (200, .object(["data": try credentials("late")]))
            }
            _ = authorizedReads.append(.string(request.url!.path))
            return (200, try value(["data": ["author": ["id": "A", "name": "A"]]]))
        }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: "foreign", urlSession: transport, store: store)
        let oldRead = Task { try await client.me(channel: .publicCommunity) }
        await started.wait()
        await client.logout()
        await gate.open()
        await #expect(throws: CancellationError.self) { try await oldRead.value }
        await #expect(throws: CommunityError.self) { try await client.me(channel: .publicCommunity) }
        #expect(await store.read() == nil)
        #expect(authorizedReads.values.isEmpty)
    }
    private func moderatedCapabilities() throws -> JSONValue {
        try value(["data": ["enabled": true, "auth": ["password", "emby-exchange"], "mediaIdentity": "tmdb-aired", "embyExchangeServerId": trustedID,
                            "moderation": ["flagReasons": ["spam", "harassment"], "blocks": true, "accountDeletion": ["authKinds": ["password", "emby"]],
                                           "terms": ["version": "2026-10-24", "url": "https://nas.tigerest.top:18446/community/v2/terms", "contact": "mailto:owner@example.com"]]]])
    }
    private func exchanged() throws -> JSONValue {
        try value(["data": ["accessToken": "access-token", "refreshToken": "refresh-token", "tokenType": "Bearer", "expiresAt": "2099-01-01T00:00:00Z", "refreshExpiresAt": "2099-02-01T00:00:00Z", "author": ["id": "a", "name": "A"]]])
    }
    @Test func complianceCallsCarryClientHeadersAndBlocksSendNoBody() async throws {
        let calls = CommentRequests()
        let transport = CommentFixture.session { request in
            let path = request.url!.path
            #expect(request.value(forHTTPHeaderField: "X-Tigerest-Client-Platform") == "tvOS")
            if path.hasSuffix("/capabilities") { return (200, try self.moderatedCapabilities()) }
            if path.hasSuffix("/auth/emby") { return (200, try self.exchanged()) }
            let body = request.httpBody ?? request.httpBodyStream.map { _ in Data([1]) } ?? Data()
            _ = calls.append(try value(["path": path, "method": request.httpMethod!, "empty": body.isEmpty]))
            if path.hasSuffix("/flags") { #expect(try requestJSON(request) == value(["reason": "spam", "clientRequestId": "11111111-1111-4111-8111-111111111111"])) }
            return (200, try value(["data": ["ok": true]]))
        }
        defer { transport.invalidateAndCancel() }
        let client = CommunityClient(emby: communityEmby(), serverID: trustedID, urlSession: transport, clientHeaders: ClientIdentity.headers(platform: "tvOS", version: "2.9.4"))
        try await client.block(authorID: "author-2")
        _ = try await client.flag(commentID: "comment-1", reason: "spam", clientRequestID: "11111111-1111-4111-8111-111111111111")
        await #expect(throws: CommunityError.self) { _ = try await client.flag(commentID: "comment-1", reason: "unknown", clientRequestID: UUID().uuidString) }
        #expect(calls.values.first == (try value(["path": "/community/v2/me/blocks/author-2", "method": "PUT", "empty": true])))
        #expect(calls.values.count == 2, "an unannounced reason never reaches the network")
    }
    @Test func deletedEmbyIdentityIsNeverExchangedUntilRejoin() async throws {
        let exchanges = CommentRequests()
        let transport = CommentFixture.session { request in
            let path = request.url!.path
            if path.hasSuffix("/capabilities") { return (200, try self.moderatedCapabilities()) }
            if path.hasSuffix("/auth/emby") { _ = exchanges.append(.null); return (200, try self.exchanged()) }
            if path.hasSuffix("/me/delete") {
                #expect(try requestJSON(request) == value(["confirm": "DELETE"]))
                #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == nil)
                return (200, try value(["data": ["deleted": true]]))
            }
            return (200, try value(["data": ["author": ["id": "a", "name": "A"]]]))
        }
        defer { transport.invalidateAndCancel() }
        let store = try CommentStore(.null)
        let client = CommunityClient(emby: communityEmby(), serverID: trustedID, urlSession: transport, store: store)
        _ = try await client.me(channel: .publicCommunity)
        try await client.deleteAccount()
        #expect(try JSONDecoder().decode(JSONValue.self, from: await store.read() ?? Data()) == value(["left": true]))
        // A restart reads the marker back.
        let restarted = CommunityClient(emby: communityEmby(), serverID: trustedID, urlSession: transport, store: store)
        await #expect(throws: CommunityError.self) { _ = try await restarted.me(channel: .publicCommunity) }
        #expect(exchanges.values.count == 1)
        try await restarted.rejoin()
        #expect(exchanges.values.count == 2)
        #expect(await restarted.left == false)
    }
    @Test func wrongDeletionPasswordKeepsTheAccount() async throws {
        let deletions = CommentRequests()
        let transport = CommentFixture.session { request in
            let path = request.url!.path
            if path.hasSuffix("/capabilities") { return (200, try self.moderatedCapabilities()) }
            if path.hasSuffix("/me/delete") { _ = deletions.append(.null); return (401, try value(["error": ["code": "AUTH_INVALID"]])) }
            return (200, try value(["data": ["author": ["id": "saved", "name": "saved"]]]))
        }
        defer { transport.invalidateAndCancel() }
        let store = try CommentStore(credentials("saved"))
        let client = CommunityClient(emby: communityEmby(), serverID: "foreign", urlSession: transport, store: store)
        await #expect { try await client.deleteAccount(password: "wrong") } throws: { ($0 as? CommunityError)?.code == "DELETION_WRONG_PASSWORD" }
        #expect(deletions.values.count == 1)
        #expect(await store.read() != nil)
        #expect(await client.currentAccessToken() == "saved-access")
    }
    @Test func clientIdentityAndTermsTextStayPlain() {
        let headers = ClientIdentity.headers(platform: " tvOS\n", version: String(repeating: "9", count: 50))
        #expect(headers["X-Tigerest-Client-Platform"] == "tvOS")
        #expect(headers["X-Tigerest-Client-Version"]?.count == 40)
        #expect(CommunityClient.plainText("<html><style>p{}</style><h1>条款</h1><p>零容忍&amp;举报<br>24 小时</p><script>x()</script></html>") == "条款\n零容忍&举报\n24 小时")
    }
}
