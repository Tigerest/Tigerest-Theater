import Foundation
import UIKit
import CryptoKit
import AppleCore
final class NoRedirectSession: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    static func make() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 35
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        return URLSession(configuration: config, delegate: NoRedirectSession(), delegateQueue: nil)
    }
}
@MainActor final class CommunityTransport {
    unowned let model: AppModel
    var http = NoRedirectSession.make()
    private var tasks: [String: Task<Void, Never>] = [:]
    private(set) var session: JSONValue = .object([:])
    private(set) var trusted = "", mappingStatus = 0
    private var epoch: UInt64 = 0
    // The comment session lives in the page; danmaku only borrows its access token as
    // it passes through secure storage, and never refreshes it.
    private var userToken: (value: String, expires: Date)?
    init(model: AppModel) { self.model = model }
    func clear() { epoch &+= 1; tasks.values.forEach { $0.cancel() }; tasks.removeAll(); session = .object([:]); trusted = ""; mappingStatus = 0; userToken = nil }
    func setSession(_ value: JSONValue) -> Bool {
        if value != session { epoch &+= 1; tasks.values.forEach { $0.cancel() }; tasks.removeAll(); session = value; userToken = nil }
        return !mappingHeaders.isEmpty
    }
    var accessToken: String? { userToken.flatMap { $0.expires > Date().addingTimeInterval(30) ? $0.value : nil } }
    var clientHeaders: [String: String] {
        ClientIdentity.headers(platform: UIDevice.current.userInterfaceIdiom == .pad ? "iPadOS" : "iOS",
                               version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown")
    }
    private func remember(_ record: String) {
        let value = try? JSONDecoder().decode(JSONValue.self, from: Data(record.utf8))
        let formatter = ISO8601DateFormatter(); formatter.formatOptions.insert(.withFractionalSeconds)
        let expiry = value?["expiresAt"].string.flatMap { formatter.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) }
        if let token = value?["accessToken"].string, CommunityPolicy.safe(token), let expiry { userToken = (token, expiry) } else { userToken = nil }
    }
    var mappingHeaders: [String: String] {
        guard !CommunityPolicy.guid(trusted).isEmpty, CommunityPolicy.guid(session["serverId"].string ?? "") == CommunityPolicy.guid(trusted),
              ["token", "serverId", "userId"].allSatisfy({ CommunityPolicy.safe(session[$0].string ?? "") }) else { return [:] }
        return ["X-Emby-Token": session["token"].string!, "X-Emby-Server-Id": session["serverId"].string!, "X-Emby-User-Id": session["userId"].string!]
    }
    func cancel(_ id: String) { tasks.removeValue(forKey: id)?.cancel() }
    func credential(_ operation: String, _ context: String, _ value: String) throws -> JSONValue {
        guard !context.isEmpty, context.count <= 4096, value.utf8.count <= 16000 else { throw CoreError.invalidRequest }
        let store = KeychainStore(profile: model.profiles.currentID)
        let server = model.server?.baseURL.absoluteString ?? ""
        var result = ""
        switch operation {
        case "read": result = store.read(server: server, account: context).flatMap { String(data: $0, encoding: .utf8) } ?? ""; remember(result)
        case "write": try store.write(Data(value.utf8), server: server, account: context); remember(value)
        case "remove": try store.write(nil, server: server, account: context); userToken = nil
        default: throw CoreError.invalidRequest
        }
        return .object(["ok": .bool(true), "value": .string(result)])
    }
    func request(_ id: String, _ request: JSONValue, avatar: Bool = false) throws {
        guard id.range(of: "^[A-Za-z0-9-]{1,80}$", options: .regularExpression) != nil, tasks[id] == nil else { throw CoreError.invalidRequest }
        guard avatar || CommunityPolicy.allowed(request, trusted: trusted) else { throw CoreError.invalidRequest }
        let generation = epoch
        tasks[id] = Task { [weak self] in
            guard let self else { return }
            let result: JSONValue
            do { result = try await (avatar ? self.avatar(request) : self.fetch(request)) }
            catch { result = .object(["error": .string(avatar ? "SOURCE_UNAVAILABLE" : "NETWORK_UNAVAILABLE")]) }
            guard !Task.isCancelled, generation == epoch else { return }
            tasks[id] = nil; model.bridge.emit("system", "communityResponse", [.string(id), result])
        }
    }
    func data(_ request: URLRequest, limit: Int) async throws -> (Data, HTTPURLResponse) {
        let (bytes, response) = try await http.bytes(for: request)
        guard let response = response as? HTTPURLResponse, !(300..<400).contains(response.statusCode), response.expectedContentLength <= limit else { throw URLError(.badServerResponse) }
        var data = Data()
        for try await byte in bytes { guard data.count < limit else { throw URLError(.dataLengthExceedsMaximum) }; data.append(byte) }
        return (data, response)
    }
    private func fetch(_ value: JSONValue) async throws -> JSONValue {
        let path = value["path"].string!, image = value["responseType"].string == "image"
        let target = path == "/mapping-capabilities" ? "http://nas.tigerest.top:18443/api/tigerest/v1/danmaku/capabilities" : "http://nas.tigerest.top:18443/community/v2" + path
        var request = URLRequest(url: URL(string: target)!)
        request.httpMethod = value["method"].string
        request.setValue(image ? "image/png" : "application/json", forHTTPHeaderField: "Accept")
        for (name, value) in clientHeaders { request.setValue(value, forHTTPHeaderField: name) }
        for (name, value) in value["headers"].object ?? [:] { request.setValue(value.string, forHTTPHeaderField: name) }
        // A bodiless PUT (blocking) sends neither {} nor a Content-Type.
        if ["POST", "PUT"].contains(request.httpMethod), let body = value["body"].string, !body.isEmpty { request.httpBody = Data(body.utf8); request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type") }
        let (body, response) = try await data(request, limit: image ? 262144 : 2097152)
        try Task.checkCancellation()
        if path == "/capabilities" {
            let caps = try? JSONDecoder().decode(JSONValue.self, from: body)
            trusted = response.statusCode == 200 && caps?["data"]["enabled"].bool == true ? CommunityPolicy.guid(caps?["data"]["embyExchangeServerId"].string ?? "") : ""
        }
        if path == "/mapping-capabilities" { mappingStatus = response.statusCode }
        if image && (200..<300).contains(response.statusCode) {
            guard response.mimeType == "image/png", !body.isEmpty else { throw URLError(.badServerResponse) }
            return .object(["status": .number(Double(response.statusCode)), "bodyBase64": .string(body.base64EncodedString()), "headers": .object(["content-type": .string("image/png")])])
        }
        return .object(["status": .number(Double(response.statusCode)), "body": .string(String(decoding: body, as: UTF8.self)), "headers": .object(["retry-after": .string(response.value(forHTTPHeaderField: "Retry-After") ?? "")])])
    }
    private func avatar(_ source: JSONValue) async throws -> JSONValue {
        guard source["token"] == model.embySession["token"], source["userId"] == model.embySession["userId"], source["address"] == model.embySession["address"],
              let address = source["address"].string, let user = source["userId"].string, user.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
              let token = source["token"].string, CommunityPolicy.safe(token) else { throw CoreError.invalidRequest }
        let server = try ServerAddress(address)
        func get(_ url: URL, limit: Int) async throws -> Data {
            var request = URLRequest(url: url); request.setValue(token, forHTTPHeaderField: "X-Emby-Token")
            let (body, response) = try await data(request, limit: limit)
            guard response.statusCode == 200 else { throw URLError(.badServerResponse) }; return body
        }
        let metadata = try JSONDecoder().decode(JSONValue.self, from: await get(server.endpoint("Users/" + user), limit: 65536))
        guard metadata["Id"].string?.lowercased() == user.lowercased() else { throw CoreError.invalidRequest }
        if metadata["PrimaryImageTag"] == .null || metadata["PrimaryImageTag"] == .string("") { return .object(["status": .number(200), "body": .object(["hash": .null, "imageBase64": .null])]) }
        var components = URLComponents(url: server.endpoint("Users/\(user)/Images/Primary"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name:"MaxWidth", value:"128"), URLQueryItem(name:"MaxHeight", value:"128"), URLQueryItem(name:"Format", value:"png")]
        let bytes = try await get(components.url!, limit: 4194304)
        guard let image = UIImage(data: bytes) else { throw CoreError.invalidRequest }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let png = UIGraphicsImageRenderer(size: CGSize(width:128,height:128), format:format).image { _ in image.draw(in: CGRect(x:0,y:0,width:128,height:128)) }.pngData()!
        let hash = SHA256.hash(data: png).map { String(format:"%02x",$0) }.joined()
        return .object(["status": .number(200), "body": .object(["hash": .string(hash), "imageBase64": .string(png.base64EncodedString())])])
    }
}
