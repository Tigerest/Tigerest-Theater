import Foundation
import AppleCore

@MainActor private final class AppDanmakuHost: DanmakuHost {
    unowned let model: AppModel
    init(model: AppModel) { self.model = model }
    var serverHost: String? { model.server?.baseURL.host }
    var cacheScope: String { model.embySession["serverId"].string ?? model.server?.origin ?? "offline" }
    var directory: URL { model.profiles.directory }
    var mappingHeaders: [String: String] { model.community.mappingHeaders }
    var clientHeaders: [String: String] { model.community.clientHeaders }
    func communityAccessToken() async -> String? { model.community.accessToken }
    func setting(_ section: String, _ key: String) -> JSONValue { model.settings.get(section, key) }
    func setSetting(_ section: String, _ key: String, _ value: JSONValue) throws { try model.settings.set(section, key, value) }
    func data(_ request: URLRequest, limit: Int) async throws -> (Data, HTTPURLResponse) { try await model.community.data(request, limit: limit) }
    func log(_ level: String, _ message: String) { model.diagnostics.record(level, message) }
    func emit(_ event: String, _ args: [JSONValue]) { model.bridge.emit("danmaku", event, args) }
}

extension DanmakuRepository {
    convenience init(model: AppModel) { self.init(host: AppDanmakuHost(model: model)) }
}

extension PlaybackController: DanmakuPlaybackState {}
