import Foundation
import CryptoKit
import OSLog
import AppleCore

/// TV-owned preferences and caches never share the iPad profile. An explicit
/// storageRoot also isolates fixture preferences from production UserDefaults.
@MainActor final class TVDanmakuHost: DanmakuHost {
    let serverHost: String?
    let cacheScope: String
    let directory: URL
    var mappingHeaders: [String: String]
    var http: URLSession
    let clientHeaders = TVClient.headers
    private let commentStore: TVCommentTokenStore?
    private let preferencesKey: String
    private let preferences: UserDefaults?
    private var values: [String: [String: JSONValue]]
    private let policy = SettingsPolicy(defaults: TVDanmakuHost.defaults)
    private static let logger = Logger(subsystem: "top.tigerest.theater.tv", category: "Danmaku")
    private static let defaults: [String: [String: JSONValue]] = [
        "mpv": ["enableDanmaku": .bool(true)],
        "danmaku": ["apiServer": .string(""), "bold": .bool(true), "fontsize": .number(50),
                    "outline": .number(1), "shadow": .number(0), "scrolltime": .number(15),
                    "opacity": .number(0.7), "displayarea": .number(0.2)]
    ]

    init(session: EmbySession, mappingHeaders: [String: String] = [:], storageRoot: URL? = nil) {
        let address = try? ServerAddress(session.serverURL)
        serverHost = address?.baseURL.host
        cacheScope = (address?.baseURL.absoluteString ?? session.serverURL) + "|" + session.userID
        let identity = SHA256.hash(data: Data(cacheScope.utf8)).map { String(format: "%02x", $0) }.joined()
        directory = (storageRoot ?? URL.cachesDirectory.appending(path: "TigerestTV/DanmakuProfiles")).appending(path: identity)
        preferencesKey = "tv.danmaku." + identity
        preferences = storageRoot == nil ? .standard : nil
        self.mappingHeaders = mappingHeaders
        // Fixture profiles never read the real comment credentials.
        commentStore = storageRoot == nil ? TVCommentTokenStore(session: session) : nil
        http = TVDanmakuNoRedirect.make()
        values = Self.defaults
        let saved = preferences?.data(forKey: preferencesKey) ?? (try? Data(contentsOf: directory.appending(path: "settings.json")))
        if let saved, let decoded = try? JSONDecoder().decode([String: [String: JSONValue]].self, from: saved) {
            for (section, entries) in decoded {
                for (key, value) in entries {
                    if let valid = try? policy.validate(section: section, key: key, value: value), Self.validProvider(section, key, valid) {
                        values[section]?[key] = valid
                    }
                }
            }
        }
    }

    func setting(_ section: String, _ key: String) -> JSONValue { values[section]?[key] ?? .null }
    /// The saved comment session's unexpired access token; danmaku never refreshes it.
    func communityAccessToken() async -> String? {
        guard let data = try? await commentStore?.read(), let saved = try? JSONDecoder().decode(CommunityCredentials.self, from: data) else { return nil }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions.insert(.withFractionalSeconds)
        guard let expiry = formatter.date(from: saved.expiresAt) ?? ISO8601DateFormatter().date(from: saved.expiresAt), expiry > Date().addingTimeInterval(30) else { return nil }
        return saved.accessToken
    }
    func setSetting(_ section: String, _ key: String, _ value: JSONValue) throws {
        let valid = try policy.validate(section: section, key: key, value: value)
        guard Self.validProvider(section, key, valid) else { throw CoreError.invalidSetting }
        var next = values; next[section]?[key] = valid
        let data = try JSONEncoder().encode(next)
        if let preferences { preferences.set(data, forKey: preferencesKey) }
        else {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: directory.appending(path: "settings.json"), options: .atomic)
        }
        values = next
    }
    private static func validProvider(_ section: String, _ key: String, _ value: JSONValue) -> Bool {
        guard section == "danmaku", key == "apiServer", let text = value.string, !text.isEmpty else { return true }
        let entries = text.split(separator: ",", omittingEmptySubsequences: false)
        return entries.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            && DanmakuProvider.parse(text, embyHost: nil).count == entries.count
    }
    func data(_ request: URLRequest, limit: Int) async throws -> (Data, HTTPURLResponse) {
        let (bytes, response) = try await http.bytes(for: request)
        guard let response = response as? HTTPURLResponse, !(300..<400).contains(response.statusCode),
              response.expectedContentLength <= limit else { throw URLError(.badServerResponse) }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < limit else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        return (data, response)
    }
    func log(_ level: String, _ message: String) { Self.logger.info("\(message, privacy: .private)") }
    func emit(_ event: String, _ args: [JSONValue]) {}
}

private final class TVDanmakuNoRedirect: NSObject, URLSessionTaskDelegate {
    static func make() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 35
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration, delegate: TVDanmakuNoRedirect(), delegateQueue: nil)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
