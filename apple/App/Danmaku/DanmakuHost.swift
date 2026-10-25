import Foundation
import AppleCore

/// Application services needed by the shared matcher. Hosts retain their own
/// credential trust policy and expose only validated mapping-write headers.
@MainActor protocol DanmakuHost: AnyObject {
    var serverHost: String? { get }
    var cacheScope: String { get }
    var directory: URL { get }
    var mappingHeaders: [String: String] { get }
    /// Sent only to our own danmaku service.
    var clientHeaders: [String: String] { get }
    func communityAccessToken() async -> String?
    func setting(_ section: String, _ key: String) -> JSONValue
    func setSetting(_ section: String, _ key: String, _ value: JSONValue) throws
    func data(_ request: URLRequest, limit: Int) async throws -> (Data, HTTPURLResponse)
    func log(_ level: String, _ message: String)
    func emit(_ event: String, _ args: [JSONValue])
}

/// A display-cadence renderer reads this small control-cadence snapshot.
@MainActor protocol DanmakuPlaybackState: AnyObject {
    var active: Bool { get }
    var paused: Bool { get }
    var buffering: Bool { get }
    var position: Double { get }
    var rate: Double { get }
    var danmakuEpoch: UInt64 { get }
}
