import Foundation

/// The media server API a session talks to. Jellyfin forked from Emby and
/// keeps most routes, but authenticates and names some queries differently.
public enum MediaServerKind: String, Codable, Sendable {
    case emby, jellyfin

    /// Jellyfin names its product; its releases start at 10.x (now 12.x), while Emby is still 4.x.
    public static func classify(productName: String?, version: String?) -> MediaServerKind {
        if productName?.range(of: "jellyfin", options: .caseInsensitive) != nil { return .jellyfin }
        if let major = version?.split(separator: ".").first.flatMap({ Int($0) }), major >= 10 { return .jellyfin }
        return .emby
    }
}

public struct EmbySession: Codable, Sendable {
    public let serverURL: String
    public let userID: String
    public let accessToken: String
    public let deviceID: String
    public let serverID: String?
    /// nil in sessions saved before 2.9.0, which were all Emby.
    public let serverKind: MediaServerKind?
    public let serverVersion: String?
    public var kind: MediaServerKind { serverKind ?? .emby }
    public init(serverURL: String, userID: String, accessToken: String, deviceID: String, serverID: String? = nil,
                serverKind: MediaServerKind? = nil, serverVersion: String? = nil) {
        self.serverURL = serverURL; self.userID = userID; self.accessToken = accessToken; self.deviceID = deviceID
        self.serverID = serverID; self.serverKind = serverKind; self.serverVersion = serverVersion
    }
    /// Sessions saved before 2.9.0 have no server kind, and older ones no server ID.
    public var needsServerInfo: Bool { serverID == nil || serverKind == nil }
    /// Fills in what the saved session lacks from the server's public info,
    /// keeping the account and the server identity already saved.
    public func completed(with info: EmbyServerInfo) -> EmbySession {
        EmbySession(serverURL: serverURL, userID: userID, accessToken: accessToken, deviceID: deviceID,
                    serverID: serverID ?? info.id, serverKind: serverKind ?? info.kind, serverVersion: serverVersion ?? info.version)
    }
}

public struct EmbyServerInfo: Sendable {
    public let name: String
    public let id: String?
    public let kind: MediaServerKind
    public let version: String?
    public init(name: String, id: String?, kind: MediaServerKind = .emby, version: String? = nil) {
        self.name = name; self.id = id; self.kind = kind; self.version = version
    }
}

public struct EmbyItemPage: Sendable {
    public let items: [JSONValue]
    public let totalRecordCount: Int?
    public init(items: [JSONValue], totalRecordCount: Int? = nil) {
        self.items = items; self.totalRecordCount = totalRecordCount
    }
}

public protocol EmbyHomeAPI: Sendable {
    func items(query: [String: String]) async throws -> EmbyItemPage
    func resumableItems(query: [String: String]) async throws -> EmbyItemPage
}

public struct EmbyPlayback: Sendable {
    public let url: URL
    public let headers: [String: String]
    public let item: JSONValue
    public let mediaSourceID: String
    public let playSessionID: String
    public let startSeconds: Double
    public let subtitleTracks: [EmbySubtitleTrack]
    /// nil means the server did not choose; -1 is an explicit disabled choice.
    public let defaultSubtitleStreamIndex: Int?
    public init(url: URL, headers: [String: String], item: JSONValue, mediaSourceID: String, playSessionID: String, startSeconds: Double,
                subtitleTracks: [EmbySubtitleTrack] = [], defaultSubtitleStreamIndex: Int? = nil) {
        self.url = url; self.headers = headers; self.item = item
        self.mediaSourceID = mediaSourceID; self.playSessionID = playSessionID; self.startSeconds = startSeconds
        self.subtitleTracks = subtitleTracks; self.defaultSubtitleStreamIndex = defaultSubtitleStreamIndex
    }
}

public enum EmbyPlaybackEvent: Sendable { case start, progress, stop }

public enum EmbyClientError: Error, LocalizedError, Sendable, Equatable {
    case invalidResponse, unauthorized, httpStatus(Int), responseTooLarge, noPlayableMedia, unsafeMediaURL
    public var errorDescription: String? {
        switch self {
        case .invalidResponse: "服务器返回的数据无效，请重试"
        case .unauthorized: "登录已失效或没有访问权限，请重新登录"
        case .httpStatus(let status): "服务器请求失败（HTTP \(status)），请重试"
        case .responseTooLarge: "服务器返回的数据过大，请缩小浏览范围"
        case .noPlayableMedia: "服务器没有提供可直接播放的媒体源"
        case .unsafeMediaURL: "服务器提供的播放地址不受支持"
        }
    }
}

// A redirect may forward a POST body or custom Emby headers. Require API endpoints
// to answer directly; media redirects carry only the original URL's query token.
private final class EmbyNoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public actor EmbyClient: EmbyHomeAPI {
    private nonisolated let session: EmbySession
    private nonisolated let server: ServerAddress
    private let urlSession: URLSession
    private static let maxResponseBytes = 8 * 1024 * 1024
    private static let fields = "Overview,PrimaryImageAspectRatio,SeriesId,SeasonId,MediaSources,ProviderIds,DisplayOrder,DateCreated,PremiereDate,CommunityRating,UserDataLastPlayedDate,Genres,People,Studios,MediaStreams"
    static let clientVersion = "2.9.5"
    // Jellyfin's Fields parameter is an enum of optional data, not the names of
    // response properties. These are Emby request names, or data Jellyfin always
    // returns; 10.11 also dropped PresentationUniqueKey from the enum.
    private static let embyOnlyFields: Set<String> = ["userdatalastplayeddate", "premieredate", "communityrating", "productionyear",
        "seriesid", "seasonid", "displayorder", "officialrating", "criticrating", "indexnumber", "parentindexnumber",
        "runtimeticks", "name", "type", "mediatype", "imagetags"]
    // Item kinds Emby knows and Jellyfin's BaseItemKind does not.
    private static let embyOnlyTypes: Set<String> = ["game", "gamesystem"]

    public init(session: EmbySession, urlSession: URLSession = .shared) throws {
        self.server = try ServerAddress(session.serverURL)
        _ = try Self.identifier(session.userID)
        _ = try Self.identifier(session.deviceID)
        guard Self.safeHeaderValue(session.accessToken), !session.accessToken.isEmpty else { throw CoreError.invalidRequest }
        self.session = session
        self.urlSession = urlSession
    }

    public static func publicInfo(server: String, urlSession: URLSession = .shared) async throws -> String {
        try await serverInfo(server: server, urlSession: urlSession).name
    }

    public static func serverInfo(server: String, urlSession: URLSession = .shared) async throws -> EmbyServerInfo {
        let address = try ServerAddress(server)
        let json = try await send(url: address.endpoint("System/Info/Public"), urlSession: urlSession)
        guard let name = json["ServerName"].string, !name.isEmpty else { throw EmbyClientError.invalidResponse }
        let version = json["Version"].string
        return EmbyServerInfo(name: name, id: try? identifier(json["Id"].string),
                              kind: .classify(productName: json["ProductName"].string, version: version), version: version)
    }

    /// Without serverInfo the server is taken to be Emby, as before 2.9.0.
    public static func login(server: String, username: String, password: String, deviceID: String,
                             serverInfo info: EmbyServerInfo? = nil, urlSession: URLSession = .shared) async throws -> EmbySession {
        let address = try ServerAddress(server)
        _ = try identifier(deviceID)
        guard !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              username.utf8.count <= 1024, password.utf8.count <= 16384 else { throw CoreError.invalidRequest }
        let kind = info?.kind ?? .emby
        let json = try await send(url: address.endpoint("Users/AuthenticateByName"), method: "POST",
                                  body: .object(["Username": .string(username), "Pw": .string(password)]),
                                  deviceID: deviceID, kind: kind, urlSession: urlSession)
        guard let userID = json["User"]["Id"].string, let token = json["AccessToken"].string,
              !token.isEmpty, safeHeaderValue(token), (try? identifier(userID)) != nil else { throw EmbyClientError.invalidResponse }
        return EmbySession(serverURL: address.baseURL.absoluteString, userID: userID, accessToken: token, deviceID: deviceID,
                           serverID: (try? identifier(json["ServerId"].string)) ?? info?.id,
                           serverKind: info == nil ? nil : kind, serverVersion: info?.version)
    }

    /// Jellyfin 10.9 added routes that name the user as a query parameter;
    /// 12.x keeps the Users/{id} forms only as deprecated aliases.
    private func userRoute(emby: String, jellyfin: String, query: [String: String]) -> (path: String, query: [String: String]) {
        guard session.kind == .jellyfin else { return ("Users/\(session.userID)/" + emby, query) }
        var query = query
        query["userId"] = session.userID
        return (jellyfin, query)
    }

    public func libraries() async throws -> [JSONValue] {
        let route = userRoute(emby: "Views", jellyfin: "UserViews", query: ["Limit": "200"])
        return try await list(route.path, query: route.query, limit: 200)
    }

    public func resumeItems() async throws -> [JSONValue] {
        let route = userRoute(emby: "Items/Resume", jellyfin: "UserItems/Resume", query: [
            "Limit": "20", "MediaTypes": "Video", "Recursive": "true", "Fields": Self.fields,
            // Emby 4.8–4.10 require named item types even with MediaTypes=Video.
            "IncludeItemTypes": "Episode,Movie,Video,MusicVideo",
            "EnableImages": "true", "EnableUserData": "true"
        ])
        return try await list(route.path, query: route.query, limit: 20)
    }

    public func items(query: [String: String]) async throws -> EmbyItemPage {
        let route = userRoute(emby: "Items", jellyfin: "Items", query: query)
        return try await itemPage(route.path, query: route.query)
    }

    public func resumableItems(query: [String: String]) async throws -> EmbyItemPage {
        let route = userRoute(emby: "Items/Resume", jellyfin: "UserItems/Resume", query: query)
        return try await itemPage(route.path, query: route.query)
    }

    /// A library opens as a work catalogue, independent of its disk-folder layout.
    /// Series and seasons still use children(of:) for their ordered navigation.
    public func libraryItems(in library: JSONValue, startIndex: Int = 0, limit: Int = 80,
                             sort: EmbyLibrarySort = .name, search: String = "") async throws -> EmbyItemPage {
        let id = try Self.identifier(library["Id"].string)
        let types: String
        switch library["CollectionType"].string {
        case "tvshows": types = "Series"
        case "movies": types = "Movie"
        case "music": types = "MusicAlbum"
        case "books": types = "Book,AudioBook"
        case "audiobooks": types = "MusicAlbum,AudioBook"
        case "musicvideos": types = "MusicVideo"
        case "games": types = "Game"
        case "playlists": types = "Playlist"
        case "photos": types = "Photo,PhotoAlbum"
        default: types = "Series,Movie,Video"
        }
        var query = [
            "ParentId": id, "Recursive": "true", "IncludeItemTypes": types,
            "StartIndex": String(max(0, startIndex)), "Limit": String(min(100, max(1, limit))),
            "SortBy": sort.sortBy, "SortOrder": sort.sortOrder, "EnableTotalRecordCount": "true",
            "Fields": Self.fields, "EnableUserData": "true", "EnableImages": "true"
        ]
        let term = String(search.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100))
        if !term.isEmpty { query["SearchTerm"] = term }
        return try await items(query: query)
    }

    private func itemPage(_ path: String, query: [String: String]) async throws -> EmbyItemPage {
        var query = query
        let limit = min(100, max(0, Int(query["Limit"] ?? "100") ?? 100))
        query["Limit"] = String(limit)
        query["StartIndex"] = String(max(0, Int(query["StartIndex"] ?? "0") ?? 0))
        let result = try await request(path, query: query)
        guard let items = result["Items"].array else { throw EmbyClientError.invalidResponse }
        let rawCount = result["TotalRecordCount"].number
        let count = rawCount.flatMap { value in
            value.isFinite && value >= 0 && value <= 9_007_199_254_740_991 && value.rounded() == value ? Int(value) : nil
        }
        return EmbyItemPage(items: Array(items.prefix(limit)), totalRecordCount: count)
    }

    public func children(of item: JSONValue, startIndex: Int = 0, limit: Int = 80) async throws -> [JSONValue] {
        let id = try Self.identifier(item["Id"].string)
        let boundedLimit = min(max(limit, 1), 100)
        var values = ["UserId": session.userID, "StartIndex": String(max(0, startIndex)), "Limit": String(boundedLimit),
                      "Fields": Self.fields, "EnableUserData": "true", "EnableImages": "true"]
        var path = ""
        switch item["Type"].string {
        case "Series":
            path = "Shows/\(id)/Seasons"
            values["SortBy"] = "IndexNumber,SortName"
        case "Season":
            if let series = item["SeriesId"].string {
                path = "Shows/\(try Self.identifier(series))/Episodes"
                values["SeasonId"] = id
            } else {
                values["ParentId"] = id
                values["Recursive"] = "false"
                values["IncludeItemTypes"] = "Episode"
            }
            values["SortBy"] = "ParentIndexNumber,IndexNumber,SortName"
        default:
            values["ParentId"] = id
            values["Recursive"] = "false"
            values["SortBy"] = "SortName"
        }
        values["SortOrder"] = "Ascending"
        if path.isEmpty {
            // The item list names its user in the route (Emby) or as userId (Jellyfin).
            values["UserId"] = nil
            (path, values) = userRoute(emby: "Items", jellyfin: "Items", query: values)
        }
        return try await list(path, query: values, limit: boundedLimit)
    }

    /// Bounded catalogue queries shared by detail and playback episode pickers.
    public func seasons(seriesID: String, startIndex: Int = 0, limit: Int = 80) async throws -> EmbyItemPage {
        try await itemPage("Shows/\(Self.identifier(seriesID))/Seasons", query: [
            "UserId": session.userID, "StartIndex": String(max(0, startIndex)), "Limit": String(min(100, max(1, limit))),
            "SortBy": "IndexNumber,SortName", "SortOrder": "Ascending", "EnableTotalRecordCount": "true",
            "Fields": Self.fields, "EnableUserData": "true", "EnableImages": "true"
        ])
    }

    /// AdjacentTo is the documented Emby sibling query. Its three-item window
    /// avoids scanning an entire long-running season to enable previous/next.
    public func episodes(seriesID: String, seasonID: String, startIndex: Int = 0, limit: Int = 80,
                         adjacentTo: String? = nil) async throws -> EmbyItemPage {
        var query = ["UserId": session.userID, "SeasonId": try Self.identifier(seasonID),
                     "StartIndex": String(max(0, startIndex)), "Limit": String(min(100, max(1, limit))),
                     "SortBy": "ParentIndexNumber,IndexNumber,SortName", "SortOrder": "Ascending",
                     "EnableTotalRecordCount": "true", "Fields": Self.fields,
                     "EnableUserData": "true", "EnableImages": "true"]
        if let adjacentTo {
            query["AdjacentTo"] = try Self.identifier(adjacentTo)
            query["StartIndex"] = "0"; query["Limit"] = "3"
        }
        return try await itemPage("Shows/\(Self.identifier(seriesID))/Episodes", query: query)
    }

    public func item(id: String) async throws -> JSONValue {
        let id = try Self.identifier(id)
        let route = userRoute(emby: "Items/\(id)", jellyfin: "Items/\(id)", query: [:])
        let result = try await request(route.path, query: route.query)
        guard result.object != nil, result["Id"].string == id else { throw EmbyClientError.invalidResponse }
        return result
    }

    public func playback(item: JSONValue) async throws -> EmbyPlayback {
        let id = try Self.identifier(item["Id"].string)
        var resumeTicks = max(0, item["UserData"]["PlaybackPositionTicks"].number ?? 0)
        if !resumeTicks.isFinite || resumeTicks > Double(Int64.max) { resumeTicks = 0 }
        if let duration = item["RunTimeTicks"].number, duration > 0, resumeTicks >= duration { resumeTicks = 0 }
        // Match the existing MPV client's unrestricted direct-play profile. This
        // first TV client asks for original media and does not start transcoders.
        let profile: JSONValue = .object([
            "Name": .string("Tigerest Theater TV"), "MaxStaticBitrate": .number(1_000_000_000),
            "MaxStreamingBitrate": .number(200_000_000),
            "DirectPlayProfiles": .array([.object(["Type": .string("Video")]), .object(["Type": .string("Audio")])]),
            "TranscodingProfiles": .array([]), "CodecProfiles": .array([]),
            // Match native/nativeshell.js so PlaybackInfo can supply external
            // text delivery URLs instead of assuming subtitles need burning in.
            "SubtitleProfiles": .array([
                ("srt", "External"), ("srt", "Embed"), ("ass", "External"), ("ass", "Embed"),
                ("sub", "Embed"), ("sub", "External"), ("ssa", "Embed"), ("ssa", "External"),
                ("smi", "Embed"), ("smi", "External"), ("pgssub", "Embed"), ("dvdsub", "Embed"),
                ("dvbsub", "Embed"), ("pgs", "Embed")
            ].map { .object(["Format": .string($0.0), "Method": .string($0.1)]) })
        ])
        let info = try await request("Items/\(id)/PlaybackInfo", method: "POST", body: .object([
            "UserId": .string(session.userID), "StartTimeTicks": .number(resumeTicks),
            "IsPlayback": .bool(true), "AutoOpenLiveStream": .bool(false),
            "EnableDirectPlay": .bool(true), "EnableDirectStream": .bool(true), "EnableTranscoding": .bool(false),
            "MaxStreamingBitrate": .number(200_000_000), "DeviceProfile": profile
        ]))
        guard info["ErrorCode"] == .null, let sources = info["MediaSources"].array,
              let playSessionID = info["PlaySessionId"].string, !playSessionID.isEmpty else { throw EmbyClientError.noPlayableMedia }
        for source in sources.prefix(32) where source["SupportsDirectPlay"].bool == true || source["SupportsDirectStream"].bool == true {
            guard source["RequiresOpening"].bool != true,
                  let sourceID = source["Id"].string, !sourceID.isEmpty else { continue }
            let mediaURL: URL
            if let direct = source["DirectStreamUrl"].string, !direct.isEmpty {
                mediaURL = try directStreamURL(direct)
            } else if source["SupportsDirectPlay"].bool == true {
                mediaURL = try Self.url(server.endpoint("Videos/\(id)/stream"), query: [
                    "Static": "true", "MediaSourceId": sourceID, "PlaySessionId": playSessionID,
                    "DeviceId": session.deviceID, tokenParameter: session.accessToken
                ])
            } else { continue }
            return EmbyPlayback(url: mediaURL, headers: [:], item: item, mediaSourceID: sourceID,
                                playSessionID: playSessionID, startSeconds: resumeTicks / 10_000_000,
                                subtitleTracks: subtitleTracks(source: source, itemID: id),
                                defaultSubtitleStreamIndex: Self.subtitleIndex(source["DefaultSubtitleStreamIndex"], allowDisabled: true))
        }
        throw EmbyClientError.noPlayableMedia
    }

    private func subtitleTracks(source: JSONValue, itemID: String) -> [EmbySubtitleTrack] {
        var tracks: [EmbySubtitleTrack] = [], seen = Set<Int>(), embeddedOrdinal = 0
        for stream in (source["MediaStreams"].array ?? []).prefix(512) where stream["Type"].string == "Subtitle" {
            let external = stream["IsExternal"].bool == true
            if !external { embeddedOrdinal += 1 }
            guard let index = Self.subtitleIndex(stream["Index"]), seen.insert(index).inserted else { continue }
            var externalURL: URL?
            if external || stream["DeliveryMethod"].string == "External" {
                if let delivery = stream["DeliveryUrl"].string, !delivery.isEmpty {
                    // Never expose a filesystem path or unsafe server-supplied
                    // URL to MPV. Other valid tracks and video remain available.
                    guard let safe = try? directStreamURL(delivery) else { continue }
                    externalURL = safe
                } else {
                    let codec = stream["Codec"].string?.lowercased() ?? ""
                    let text = stream["IsTextSubtitleStream"].bool == true || ["srt", "subrip", "ass", "ssa", "smi", "sami", "vtt", "webvtt", "mov_text", "text"].contains(codec)
                    if text, let sourceID = try? Self.identifier(source["Id"].string) {
                        // Official text-subtitle endpoint; keep full timestamps
                        // because MPV already seeks the media to startSeconds.
                        // https://dev.emby.media/doc/restapi/Subtitles.html
                        externalURL = try? Self.url(server.endpoint("Videos/\(itemID)/\(sourceID)/Subtitles/\(index)/Stream.srt"), query: [tokenParameter: session.accessToken])
                    }
                    if external, externalURL == nil { continue }
                }
            }
            let title = [stream["DisplayTitle"].string, stream["Title"].string, stream["Language"].string]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty } ?? "字幕 \(index)"
            tracks.append(.init(index: index, embeddedIndex: external ? nil : embeddedOrdinal, externalURL: externalURL,
                                title: title, language: stream["Language"].string, codec: stream["Codec"].string,
                                isDefault: stream["IsDefault"].bool == true, isForced: stream["IsForced"].bool == true, isExternal: external))
        }
        return tracks
    }

    private static func subtitleIndex(_ value: JSONValue, allowDisabled: Bool = false) -> Int? {
        guard let number = value.number, number.isFinite, number.rounded() == number,
              number >= (allowDisabled ? -1 : 0), number <= Double(Int32.max) else { return nil }
        return Int(number)
    }

    public nonisolated func imageURL(for item: JSONValue, type: String = "Primary", maxWidth: Int = 400) -> URL? {
        if type == "Backdrop", let tag = item["BackdropImageTags"].array?.first?.string {
            return imageURL(itemID: item["Id"].string ?? "", type: type, index: 0, tag: tag, maxWidth: maxWidth)
        }
        return imageURL(itemID: item["Id"].string ?? "", type: type, tag: item["ImageTags"][type].string, maxWidth: maxWidth)
    }

    public nonisolated func imageURL(itemID: String, type: String, index: Int? = nil, tag: String? = nil, maxWidth: Int = 400) -> URL? {
        guard let id = try? Self.identifier(itemID),
              ["Primary", "Backdrop", "Thumb", "Logo", "Banner"].contains(type) else { return nil }
        var values = ["MaxWidth": String(min(max(maxWidth, 1), 2048)), "Quality": "90", tokenParameter: session.accessToken]
        if let tag { values["Tag"] = tag }
        let suffix = index.map { "/\(min(100, max(0, $0)))" } ?? ""
        return try? Self.url(server.endpoint("Items/\(id)/Images/\(type)" + suffix), query: values)
    }

    public nonisolated func homeArtworkURL(for item: JSONValue, purpose: EmbyHomeArtwork.Purpose) -> URL? {
        guard let art = EmbyHomeArtwork.select(item, purpose: purpose) else { return nil }
        return imageURL(itemID: art.itemID, type: art.type, index: art.index, tag: art.tag, maxWidth: purpose.maxWidth)
    }

    public func report(_ event: EmbyPlaybackEvent, playback: EmbyPlayback, position: Double, paused: Bool) async throws {
        let itemID = try Self.identifier(playback.item["Id"].string)
        guard position.isFinite, position >= 0, position < Double(Int64.max) / 10_000_000 else { throw CoreError.invalidRequest }
        let path: String
        switch event {
        case .start: path = "Sessions/Playing"
        case .progress: path = "Sessions/Playing/Progress"
        case .stop: path = "Sessions/Playing/Stopped"
        }
        var body: [String: JSONValue] = [
            "ItemId": .string(itemID), "MediaSourceId": .string(playback.mediaSourceID),
            "PlaySessionId": .string(playback.playSessionID), "PositionTicks": .number((position * 10_000_000).rounded(.down)),
            "IsPaused": .bool(paused), "IsMuted": .bool(false), "CanSeek": .bool(true),
            "PlayMethod": .string("DirectStream"), "PlaybackRate": .number(1),
            "QueueableMediaTypes": .array([.string("Video")]), "PlaylistIndex": .number(0), "PlaylistLength": .number(1)
        ]
        if case .progress = event { body["EventName"] = .string(paused ? "Pause" : "TimeUpdate") }
        _ = try await request(path, method: "POST", body: .object(body), allowEmpty: true)
    }

    private func list(_ path: String, query: [String: String], limit: Int) async throws -> [JSONValue] {
        let result = try await request(path, query: query)
        guard let items = result["Items"].array else { throw EmbyClientError.invalidResponse }
        return Array(items.prefix(limit))
    }

    /// Media URLs cannot carry headers. Jellyfin 12 reads only ApiKey; Emby reads api_key.
    private nonisolated var tokenParameter: String { session.kind == .jellyfin ? "ApiKey" : "api_key" }

    private func request(_ path: String, query: [String: String] = [:], method: String = "GET", body: JSONValue? = nil,
                         allowEmpty: Bool = false) async throws -> JSONValue {
        let query = session.kind == .jellyfin ? Self.jellyfinQuery(query, version: session.serverVersion) : query
        return try await Self.send(url: Self.url(server.endpoint(path), query: query), method: method, body: body,
                                   deviceID: session.deviceID, token: session.accessToken, kind: session.kind,
                                   urlSession: urlSession, allowEmpty: allowEmpty)
    }

    /// Removes Fields values and item types that Jellyfin's enums do not have.
    static func jellyfinQuery(_ query: [String: String], version: String?) -> [String: String] {
        // PresentationUniqueKey left the enum in 10.11; keep it only for a known older server.
        let parts = version?.split(separator: ".").compactMap { Int($0) } ?? []
        let keepsPresentationKey = parts.count >= 2 && (parts[0] < 10 || (parts[0] == 10 && parts[1] < 11))
        func filter(_ list: String, drop: (String) -> Bool) -> String {
            list.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty && !drop($0.lowercased()) }.joined(separator: ",")
        }
        var query = query
        if let fields = query["Fields"] {
            query["Fields"] = filter(fields) { embyOnlyFields.contains($0) || ($0 == "presentationuniquekey" && !keepsPresentationKey) }
        }
        if let types = query["IncludeItemTypes"] { query["IncludeItemTypes"] = filter(types) { embyOnlyTypes.contains($0) } }
        return query
    }

    private static func send(url: URL, method: String = "GET", body: JSONValue? = nil, deviceID: String? = nil,
                             token: String? = nil, kind: MediaServerKind = .emby, urlSession: URLSession,
                             allowEmpty: Bool = false) async throws -> JSONValue {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let deviceID {
            let client = "MediaBrowser Client=\"Tigerest Theater TV\", Device=\"Apple TV\", DeviceId=\"\(deviceID)\", Version=\"\(clientVersion)\""
            if kind == .jellyfin {
                // Jellyfin 12 disables the legacy X-Emby-* headers by default.
                request.setValue(client + (token.map { ", Token=\"\($0)\"" } ?? ""), forHTTPHeaderField: "Authorization")
            } else {
                request.setValue(client, forHTTPHeaderField: "X-Emby-Authorization")
            }
        }
        if let token, kind == .emby { request.setValue(token, forHTTPHeaderField: "X-Emby-Token") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (bytes, response) = try await urlSession.bytes(for: request, delegate: EmbyNoRedirectDelegate())
        defer { bytes.task.cancel() }
        guard let response = response as? HTTPURLResponse else { throw EmbyClientError.invalidResponse }
        if response.statusCode == 401 || response.statusCode == 403 { throw EmbyClientError.unauthorized }
        guard (200...299).contains(response.statusCode) else { throw EmbyClientError.httpStatus(response.statusCode) }
        guard response.expectedContentLength <= maxResponseBytes else { throw EmbyClientError.responseTooLarge }
        var data = Data()
        for try await byte in bytes {
            guard data.count < maxResponseBytes else { throw EmbyClientError.responseTooLarge }
            data.append(byte)
        }
        if data.isEmpty && allowEmpty { return .null }
        do { return try JSONDecoder().decode(JSONValue.self, from: data) }
        catch { throw EmbyClientError.invalidResponse }
    }

    private static func identifier(_ value: String?) throws -> String {
        guard let value, !value.isEmpty, value.utf8.count <= 256,
              value.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_").contains($0) }) else { throw CoreError.invalidRequest }
        return value
    }

    private static func safeHeaderValue(_ value: String) -> Bool {
        value.utf8.count <= 4096 && value.unicodeScalars.allSatisfy { (32...126).contains($0.value) && $0 != "\"" && $0 != "\\" }
    }

    private static func url(_ base: URL, query: [String: String]) throws -> URL {
        guard var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { throw CoreError.invalidRequest }
        if !query.isEmpty { parts.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = parts.url else { throw CoreError.invalidRequest }
        return url
    }

    private func directStreamURL(_ value: String) throws -> URL {
        guard !value.contains("\\"), !value.unicodeScalars.contains(where: { $0.value < 32 }),
              var parts = URLComponents(string: value), parts.user == nil, parts.password == nil, parts.fragment == nil else { throw EmbyClientError.unsafeMediaURL }
        var decoded = parts.percentEncodedPath
        for _ in 0..<3 { decoded = decoded.removingPercentEncoding ?? decoded }
        guard !decoded.contains("\\"), !decoded.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { throw EmbyClientError.unsafeMediaURL }
        if parts.scheme == nil {
            guard parts.host == nil else { throw EmbyClientError.unsafeMediaURL }
            let prefix = server.baseURL.path.hasSuffix("/") ? server.baseURL.path : server.baseURL.path + "/"
            var path = parts.path
            if !path.hasPrefix(prefix) {
                if prefix.lowercased().hasSuffix("/emby/"), path.lowercased().hasPrefix("/emby/") { path = String(path.dropFirst(6)) }
                path = prefix + path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            }
            let base = URLComponents(url: server.baseURL, resolvingAgainstBaseURL: false)!
            parts.scheme = base.scheme; parts.host = base.host; parts.port = base.port; parts.path = path
        }
        guard let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host, !host.isEmpty, parts.port == nil || (1...65535).contains(parts.port!),
              let rawURL = parts.url else { throw EmbyClientError.unsafeMediaURL }
        let base = URLComponents(url: server.baseURL, resolvingAgainstBaseURL: false)!
        let sameOrigin = scheme == base.scheme && host.lowercased() == base.host?.lowercased()
            && (parts.port ?? (scheme == "https" ? 443 : 80)) == (base.port ?? (base.scheme == "https" ? 443 : 80))
        let authKeys = Set(["api_key", "apikey", "x-emby-token", "x-mediabrowser-token", "x-emby-authorization", "access_token", "token"])
        var query = parts.queryItems ?? []
        if sameOrigin {
            query.removeAll { authKeys.contains($0.name.lowercased()) }
            query.append(URLQueryItem(name: tokenParameter, value: session.accessToken))
        } else {
            // CDN signatures often use token/access_token/api_key too. Preserve
            // those independent credentials; only remove our Emby credential.
            query.removeAll { $0.value?.contains(session.accessToken) == true }
        }
        parts.queryItems = query.isEmpty ? nil : query
        guard let url = parts.url else { throw EmbyClientError.unsafeMediaURL }
        if !sameOrigin, (url.absoluteString.removingPercentEncoding ?? rawURL.absoluteString).contains(session.accessToken) { throw EmbyClientError.unsafeMediaURL }
        return url
    }
}
