import Foundation
import Testing
@testable import AppleCore

private final class EmbyFixtureProtocol: URLProtocol, @unchecked Sendable {
    struct Reply { var status = 200; var data: Data; var headers: [String: String] = [:] }
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: (@Sendable (URLRequest) throws -> Reply)?
    static func install(_ handler: @escaping @Sendable (URLRequest) throws -> Reply) -> URLSession {
        lock.withLock { self.handler = handler }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EmbyFixtureProtocol.self]
        return URLSession(configuration: configuration)
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let handler = Self.lock.withLock { Self.handler }
            let reply = try handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: reply.data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private func reply(_ json: String, status: Int = 200) -> EmbyFixtureProtocol.Reply {
    .init(status: status, data: Data(json.utf8))
}
private func body(_ request: URLRequest) throws -> JSONValue {
    var data = request.httpBody ?? Data()
    if data.isEmpty, let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
    return try JSONDecoder().decode(JSONValue.self, from: data)
}
private func query(_ url: URL) -> [String: String] {
    Dictionary((URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _, rhs in rhs })
}
private func mediaItem() throws -> JSONValue {
    try JSONValue(any: ["Id": "episode1", "Type": "Episode", "Name": "Test", "RunTimeTicks": 72000000000,
                       "UserData": ["PlaybackPositionTicks": 125000000]])
}
private func session() -> EmbySession {
    EmbySession(serverURL: "https://emby.test/proxy/emby/", userID: "user1", accessToken: "private-token", deviceID: "tv-device")
}

@Suite(.serialized) struct EmbyClientTests {
    @Test func episodeContextUsesBoundedSeasonAndAdjacentQueries() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            let values = query(request.url!)
            #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == "private-token")
            #expect(values["UserId"] == "user1")
            #expect(values["EnableUserData"] == "true")
            #expect(values["Fields"]?.contains("People") == true)
            #expect(values["Fields"]?.contains("MediaStreams") == true)
            if request.url?.path == "/proxy/emby/Shows/show/Seasons" {
                #expect(values["StartIndex"] == "80")
                #expect(values["Limit"] == "100")
            } else {
                #expect(request.url?.path == "/proxy/emby/Shows/show/Episodes")
                #expect(values["SeasonId"] == "season")
                #expect(values["SortBy"] == "ParentIndexNumber,IndexNumber,SortName")
                if values["AdjacentTo"] != nil {
                    #expect(values["AdjacentTo"] == "episode500")
                    #expect(values["Limit"] == "3")
                } else {
                    #expect(values["StartIndex"] == "80")
                    #expect(values["Limit"] == "80")
                }
            }
            return reply(#"{"Items":[{"Id":"one"}],"TotalRecordCount":501}"#)
        }
        defer { transport.invalidateAndCancel() }
        let client = try EmbyClient(session: session(), urlSession: transport)
        #expect(try await client.seasons(seriesID: "show", startIndex: 80, limit: 900).totalRecordCount == 501)
        #expect(try await client.episodes(seriesID: "show", seasonID: "season", startIndex: 80).items.count == 1)
        #expect(try await client.episodes(seriesID: "show", seasonID: "season", adjacentTo: "episode500").items.count == 1)
        await #expect(throws: CoreError.invalidRequest) {
            try await client.episodes(seriesID: "show", seasonID: "../escape")
        }
    }

    @Test func loginRetainsServerIdentityWithoutBreakingStoredSessions() async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            reply(#"{"User":{"Id":"user1"},"AccessToken":"private-token","ServerId":"62526c3bf747439c99327ddec5fed4a8"}"#)
        }
        defer { transport.invalidateAndCancel() }
        let saved = try await EmbyClient.login(server: session().serverURL, username: "alice", password: "secret", deviceID: "tv-device", urlSession: transport)
        let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(saved))
        #expect(encoded["serverID"].string == "62526c3bf747439c99327ddec5fed4a8")
        let old = try JSONDecoder().decode(EmbySession.self, from: Data(#"{"serverURL":"https://emby.test/","userID":"user1","accessToken":"private-token","deviceID":"tv-device"}"#.utf8))
        #expect(old.userID == "user1")
    }

    @Test func loginPreservesProxyPathAndSendsPasswordOnlyInJSON() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            #expect(request.url?.absoluteString == "https://emby.test/proxy/emby/Users/AuthenticateByName")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            #expect(request.value(forHTTPHeaderField: "X-Emby-Authorization")?.contains("DeviceId=\"tv-device\"") == true)
            #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == nil)
            let json = try body(request)
            #expect(json["Username"].string == "alice")
            #expect(json["Pw"].string == "password with spaces")
            #expect(request.timeoutInterval <= 30)
            return reply(#"{"User":{"Id":"user1"},"AccessToken":"private-token"}"#)
        }
        defer { transport.invalidateAndCancel() }
        let authenticated = try await EmbyClient.login(server: " https://emby.test/proxy/emby ", username: "alice", password: "password with spaces", deviceID: "tv-device", urlSession: transport)
        #expect(authenticated.serverURL == "https://emby.test/proxy/emby/")
        #expect(authenticated.userID == "user1")
        #expect(authenticated.accessToken == "private-token")
        #expect(authenticated.deviceID == "tv-device")
        let encoded = try JSONEncoder().encode(authenticated)
        #expect(!String(decoding: encoded, as: UTF8.self).contains("password with spaces"))
    }

    @Test func publicInfoIsUnauthenticatedAndReturnsServerName() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            #expect(request.url?.path == "/proxy/emby/System/Info/Public")
            #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == nil)
            return reply(#"{"ServerName":"Living Room","Version":"4.9.0.0","Id":"server"}"#)
        }
        defer { transport.invalidateAndCancel() }
        #expect(try await EmbyClient.publicInfo(server: session().serverURL, urlSession: transport) == "Living Room")
        #expect(try await EmbyClient.serverInfo(server: session().serverURL, urlSession: transport).id == "server")
    }

    @Test func homeCountOnlyQueryRetainsTotalWithoutDownloadingEpisodes() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            #expect(request.url?.path == "/proxy/emby/Users/user1/Items")
            #expect(query(request.url!)["Limit"] == "0")
            #expect(query(request.url!)["ParentId"] == "series")
            #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == "private-token")
            return reply(#"{"Items":[],"TotalRecordCount":37}"#)
        }
        defer { transport.invalidateAndCancel() }
        let result = try await EmbyClient(session: session(), urlSession: transport).items(query: ["ParentId": "series", "Limit": "0", "EnableTotalRecordCount": "true"])
        #expect(result.items.isEmpty)
        #expect(result.totalRecordCount == 37)
    }

    @Test func homeArtworkUsesParentBackdropIndexAndCacheTag() throws {
        let client = try EmbyClient(session: session())
        let item: JSONValue = .object(["Id": .string("episode"), "ParentBackdropItemId": .string("series"), "ParentBackdropImageTags": .array([.string("parent-tag")])])
        let image = try #require(client.homeArtworkURL(for: item, purpose: .hero))
        #expect(image.path == "/proxy/emby/Items/series/Images/Backdrop/0")
        #expect(query(image)["Tag"] == "parent-tag")
        #expect(query(image)["MaxWidth"] == "1920")
    }

    @Test func authenticationRejectsHTTPFailureAndIncompleteSession() async throws {
        for (status, json) in [(401, #"{"AccessToken":"do-not-display","User":{"Id":"user1"}}"#), (200, #"{"User":{"Id":"user1"}}"#)] {
            let transport = EmbyFixtureProtocol.install { _ in reply(json, status: status) }
            defer { transport.invalidateAndCancel() }
            await #expect(throws: (any Error).self) {
                try await EmbyClient.login(server: session().serverURL, username: "alice", password: "secret", deviceID: "tv-device", urlSession: transport)
            }
        }
    }

    @Test func browsingUsesAuthenticatedBoundedQueriesAndSeasonEpisodeRoutes() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            let url = try #require(request.url)
            let values = query(url)
            #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == "private-token")
            #expect(values["api_key"] == nil)
            #expect(Int(values["Limit"] ?? "0")! > 0)
            #expect(Int(values["Limit"] ?? "10000")! <= 200)
            switch url.path {
            case "/proxy/emby/Users/user1/Views": break
            case "/proxy/emby/Users/user1/Items/Resume":
                #expect(values["MediaTypes"] == "Video")
                #expect(values["Limit"] == "20")
            case "/proxy/emby/Shows/series1/Seasons":
                #expect(values["UserId"] == "user1")
                #expect(values["SortBy"] == "IndexNumber,SortName")
            case "/proxy/emby/Shows/series1/Episodes":
                #expect(values["SeasonId"] == "season2")
                #expect(values["UserId"] == "user1")
            case "/proxy/emby/Users/user1/Items":
                #expect(values["ParentId"] == "folder1")
                #expect(values["Recursive"] == "false")
            default: Issue.record("Unexpected browse route: \(url.path)")
            }
            return reply(#"{"Items":[{"Id":"one","Type":"Episode","IndexNumber":2}],"TotalRecordCount":1}"#)
        }
        defer { transport.invalidateAndCancel() }
        let client = try EmbyClient(session: session(), urlSession: transport)
        #expect(try await client.libraries().count == 1)
        #expect(try await client.resumeItems().count == 1)
        #expect(try await client.children(of: JSONValue(any: ["Id": "series1", "Type": "Series"])).count == 1)
        #expect(try await client.children(of: JSONValue(any: ["Id": "season2", "SeriesId": "series1", "Type": "Season"])).count == 1)
        #expect(try await client.children(of: JSONValue(any: ["Id": "folder1", "Type": "Folder"])).count == 1)
    }

    @Test func childPaginationRetainsOffsetAndCapsOversizedServerResponses() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            let values = query(request.url!)
            #expect(values["StartIndex"] == "160")
            #expect(values["Limit"] == "100")
            return .init(data: try JSONSerialization.data(withJSONObject: ["Items": (0..<150).map { ["Id": String($0)] }, "TotalRecordCount": 1000]))
        }
        defer { transport.invalidateAndCancel() }
        let client = try EmbyClient(session: session(), urlSession: transport)
        let result = try await client.children(of: JSONValue(any: ["Id": "library", "Type": "Folder"]), startIndex: 160, limit: 10000)
        #expect(result.count == 100)
        #expect(result.last?["Id"].string == "99")
    }

    @Test func libraryCatalogUsesRecursiveWorkTypesAndRetainsPagingTotals() async throws {
        for (collection, expectedTypes) in [("tvshows", "Series"), ("movies", "Movie"), ("mixed", "Series,Movie,Video"), ("music", "MusicAlbum")] {
            let transport = EmbyFixtureProtocol.install { request in
                #expect(request.url?.path == "/proxy/emby/Users/user1/Items")
                #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == "private-token")
                let values = query(request.url!)
                #expect(values["ParentId"] == "library")
                #expect(values["Recursive"] == "true")
                #expect(values["IncludeItemTypes"] == expectedTypes)
                #expect(values["StartIndex"] == "160")
                #expect(values["Limit"] == "100")
                #expect(values["EnableTotalRecordCount"] == "true")
                #expect(values["SortBy"] == "SortName")
                #expect(values["SortOrder"] == "Ascending")
                return reply(#"{"Items":[{"Id":"work"}],"TotalRecordCount":161}"#)
            }
            let client = try EmbyClient(session: session(), urlSession: transport)
            let result = try await client.libraryItems(in: JSONValue(any: ["Id": "library", "CollectionType": collection]), startIndex: 160, limit: 10_000)
            #expect(result.items.first?["Id"].string == "work")
            #expect(result.totalRecordCount == 161)
            transport.invalidateAndCancel()
        }
    }

    @Test func libraryItemsSortAndSearchThePosterWall() async throws {
        let expected: [EmbyLibrarySort: (String, String)] = [
            .name: ("SortName", "Ascending"), .recent: ("DateCreated,SortName", "Descending"),
            .release: ("PremiereDate,ProductionYear,SortName", "Descending"), .rating: ("CommunityRating,SortName", "Descending")]
        for (sort, (sortBy, order)) in expected {
            let transport = EmbyFixtureProtocol.install { request in
                let values = query(request.url!)
                #expect(values["SortBy"] == sortBy)
                #expect(values["SortOrder"] == order)
                #expect(values["SearchTerm"] == (sort == .rating ? "进击的巨人" : nil))
                return reply(#"{"Items":[],"TotalRecordCount":0}"#)
            }
            let client = try EmbyClient(session: session(), urlSession: transport)
            _ = try await client.libraryItems(in: JSONValue(any: ["Id": "library", "CollectionType": "tvshows"]), sort: sort,
                                              search: sort == .rating ? "  进击的巨人 \n" : "   ")
            transport.invalidateAndCancel()
        }
    }

    @Test func resumeNamesPlayableVideoTypesForEmby48Through410() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            #expect(request.url?.path == "/proxy/emby/Users/user1/Items/Resume")
            let values = query(request.url!)
            #expect(values["MediaTypes"] == "Video")
            // These server versions return no resumable records without named
            // types, even when MediaTypes already specifies Video.
            let included = Set((values["IncludeItemTypes"] ?? "").split(separator: ",").map(String.init))
            #expect(included == ["Episode", "Movie", "Video", "MusicVideo"])
            let records = ["Episode", "Movie", "Video", "MusicVideo"].filter(included.contains).map { ["Id": $0, "Type": $0] }
            return .init(data: try JSONSerialization.data(withJSONObject: ["Items": records, "TotalRecordCount": records.count]))
        }
        defer { transport.invalidateAndCancel() }
        let client = try EmbyClient(session: session(), urlSession: transport)
        let items = try await client.resumeItems()
        #expect(items.map { $0["Type"].string } == ["Episode", "Movie", "Video", "MusicVideo"])
    }

    @Test func seasonWithoutSeriesIDStillQueriesOnlyItsEpisodes() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            #expect(request.url?.path == "/proxy/emby/Users/user1/Items")
            let values = query(request.url!)
            #expect(values["ParentId"] == "season1")
            #expect(values["IncludeItemTypes"] == "Episode")
            #expect(values["SortBy"] == "ParentIndexNumber,IndexNumber,SortName")
            #expect(values["StartIndex"] == "0")
            #expect(values["Limit"] == "80")
            return reply(#"{"Items":[],"TotalRecordCount":0}"#)
        }
        defer { transport.invalidateAndCancel() }
        let client = try EmbyClient(session: session(), urlSession: transport)
        #expect(try await client.children(of: JSONValue(any: ["Id": "season1", "Type": "Season"])).isEmpty)
    }

    @Test func itemAndImagesPreserveProxyPathAndRejectPathInjection() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            #expect(request.url?.path == "/proxy/emby/Users/user1/Items/episode1")
            return reply(#"{"Id":"episode1","Name":"Episode"}"#)
        }
        defer { transport.invalidateAndCancel() }
        let client = try EmbyClient(session: session(), urlSession: transport)
        #expect(try await client.item(id: "episode1")["Name"].string == "Episode")
        let image = try #require(client.imageURL(for: mediaItem(), type: "Primary", maxWidth: 400))
        #expect(image.path == "/proxy/emby/Items/episode1/Images/Primary")
        #expect(query(image)["api_key"] == "private-token")
        #expect(query(image)["MaxWidth"] == "400")
        await #expect(throws: (any Error).self) { try await client.item(id: "../Users") }
        #expect(client.imageURL(for: try JSONValue(any: ["Id": "../Users"]), type: "Primary", maxWidth: 400) == nil)
    }

    @Test func playbackNegotiatesMPVDirectPlayAndResumesWithSafeFallback() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            #expect(request.url?.path == "/proxy/emby/Items/episode1/PlaybackInfo")
            #expect(request.httpMethod == "POST")
            let json = try body(request)
            #expect(json["UserId"].string == "user1")
            #expect(json["StartTimeTicks"].number == 125000000)
            #expect(json["EnableDirectPlay"].bool == true)
            #expect(json["EnableTranscoding"].bool == false)
            #expect(json["DeviceProfile"]["DirectPlayProfiles"].array?.contains { $0["Type"].string == "Video" } == true)
            return reply(#"{"PlaySessionId":"play1","MediaSources":[{"Id":"source1","Path":"/Volumes/private/movie.mkv","Protocol":"File","Container":"mkv","SupportsDirectPlay":true,"SupportsDirectStream":true}]}"#)
        }
        defer { transport.invalidateAndCancel() }
        let playback = try await EmbyClient(session: session(), urlSession: transport).playback(item: mediaItem())
        #expect(playback.url.path == "/proxy/emby/Videos/episode1/stream")
        #expect(query(playback.url)["Static"] == "true")
        #expect(query(playback.url)["MediaSourceId"] == "source1")
        #expect(query(playback.url)["api_key"] == "private-token")
        #expect(playback.headers.isEmpty)
        #expect(playback.startSeconds == 12.5)
        #expect(playback.mediaSourceID == "source1")
        #expect(playback.playSessionID == "play1")
        #expect(!playback.url.absoluteString.contains("Volumes"))
    }

    @Test(arguments: ["/Videos/episode1/original.mkv?MediaSourceId=source1", "/emby/Videos/episode1/original.mkv?MediaSourceId=source1", "/proxy/emby/Videos/episode1/original.mkv?MediaSourceId=source1", "Videos/episode1/original.mkv?MediaSourceId=source1"])
    func directStreamRelativeFormsRetainProxyPrefix(_ directURL: String) async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            .init(data: try JSONSerialization.data(withJSONObject: ["PlaySessionId": "play1", "MediaSources": [["Id": "source1", "SupportsDirectPlay": true, "DirectStreamUrl": directURL]]]))
        }
        defer { transport.invalidateAndCancel() }
        let playback = try await EmbyClient(session: session(), urlSession: transport).playback(item: mediaItem())
        #expect(playback.url.path == "/proxy/emby/Videos/episode1/original.mkv")
        #expect(query(playback.url)["MediaSourceId"] == "source1")
        #expect(query(playback.url)["api_key"] == "private-token")
        #expect(playback.headers.isEmpty)
    }

    @Test func playbackRetainsSubtitleChoicesAndNegotiatesExternalTextSupport() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            let json = try body(request)
            let profiles = json["DeviceProfile"]["SubtitleProfiles"].array ?? []
            #expect(profiles.contains { $0["Format"].string == "srt" && $0["Method"].string == "External" })
            #expect(profiles.contains { $0["Format"].string == "pgssub" && $0["Method"].string == "Embed" })
            return reply(#"{"PlaySessionId":"play1","MediaSources":[{"Id":"source1","SupportsDirectPlay":true,"DefaultSubtitleStreamIndex":7,"MediaStreams":[{"Type":"Video","Index":0},{"Type":"Audio","Index":1},{"Type":"Subtitle","Index":2,"Codec":"ass","Language":"jpn","Title":"Japanese","IsDefault":true},{"Type":"Subtitle","Index":7,"Codec":"srt","Language":"zho","DisplayTitle":"简体中文","IsExternal":true,"IsForced":true,"DeliveryMethod":"External","DeliveryUrl":"/emby/Videos/episode1/source1/Subtitles/7/Stream.srt?api_key=stale"},{"Type":"Subtitle","Index":9,"Codec":"pgssub","Language":"eng","Title":"English"}]}]}"#)
        }
        defer { transport.invalidateAndCancel() }
        let playback = try await EmbyClient(session: session(), urlSession: transport).playback(item: mediaItem())
        #expect(playback.defaultSubtitleStreamIndex == 7)
        #expect(playback.subtitleTracks.map(\.index) == [2, 7, 9])
        #expect(playback.subtitleTracks.map(\.embeddedIndex) == [1, nil, 2])
        let external = try #require(playback.subtitleTracks.first { $0.index == 7 })
        #expect(external.title == "简体中文")
        #expect(external.language == "zho")
        #expect(external.codec == "srt")
        #expect(external.isExternal && external.isForced && !external.isDefault)
        let url = try #require(external.externalURL)
        #expect(url.path == "/proxy/emby/Videos/episode1/source1/Subtitles/7/Stream.srt")
        #expect(query(url)["api_key"] == "private-token")
        #expect(playback.subtitleTracks.first?.isDefault == true)
    }

    @Test func externalTextSubtitleWithoutDeliveryURLUsesDocumentedEndpoint() async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            reply(#"{"PlaySessionId":"play1","MediaSources":[{"Id":"source1","SupportsDirectPlay":true,"DefaultSubtitleStreamIndex":3,"MediaStreams":[{"Type":"Subtitle","Index":3,"Codec":"subrip","IsExternal":true,"IsTextSubtitleStream":true,"Path":"/private/server/subtitle.srt"}]}]}"#)
        }
        defer { transport.invalidateAndCancel() }
        let playback = try await EmbyClient(session: session(), urlSession: transport).playback(item: mediaItem())
        let url = try #require(playback.subtitleTracks.first?.externalURL)
        #expect(url.path == "/proxy/emby/Videos/episode1/source1/Subtitles/3/Stream.srt")
        #expect(query(url)["api_key"] == "private-token")
        #expect(!url.absoluteString.contains("private/server"))
        #expect(query(url)["StartPositionTicks"] == nil)
    }

    @Test func disabledDefaultDoesNotSelectAFlaggedDefaultSubtitle() async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            reply(#"{"PlaySessionId":"play1","MediaSources":[{"Id":"source1","SupportsDirectPlay":true,"DefaultSubtitleStreamIndex":-1,"MediaStreams":[{"Type":"Subtitle","Index":4,"Codec":"ass","IsDefault":true,"IsForced":true}]}]}"#)
        }
        defer { transport.invalidateAndCancel() }
        let playback = try await EmbyClient(session: session(), urlSession: transport).playback(item: mediaItem())
        #expect(playback.defaultSubtitleStreamIndex == -1)
        #expect(playback.subtitleTracks.first?.embeddedIndex == 1)
        #expect(playback.subtitleTracks.first?.isDefault == true)
    }

    @Test func playbackWithoutSubtitleMetadataKeepsEmptyChoicesAndNoDefault() async throws {
        let transport = EmbyFixtureProtocol.install { _ in reply(#"{"PlaySessionId":"play1","MediaSources":[{"Id":"source1","SupportsDirectPlay":true}]}"#) }
        defer { transport.invalidateAndCancel() }
        let playback = try await EmbyClient(session: session(), urlSession: transport).playback(item: mediaItem())
        #expect(playback.subtitleTracks.isEmpty)
        #expect(playback.defaultSubtitleStreamIndex == nil)
    }

    @Test func extractedInternalSubtitleKeepsOrdinalAndDoesNotInventMissingDefault() async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            reply(#"{"PlaySessionId":"play1","MediaSources":[{"Id":"unplayable","DefaultSubtitleStreamIndex":99,"MediaStreams":[{"Type":"Subtitle","Index":99}]},{"Id":"source1","SupportsDirectPlay":true,"MediaStreams":[{"Type":"Subtitle","Index":3,"Codec":"ass","IsDefault":true,"DeliveryMethod":"External","DeliveryUrl":"Videos/episode1/source1/Subtitles/3/Stream.ass"},{"Type":"Subtitle","Index":5,"Codec":"pgssub"}]}]}"#)
        }
        defer { transport.invalidateAndCancel() }
        let playback = try await EmbyClient(session: session(), urlSession: transport).playback(item: mediaItem())
        #expect(playback.defaultSubtitleStreamIndex == nil)
        #expect(playback.subtitleTracks.map(\.index) == [3, 5])
        #expect(playback.subtitleTracks.map(\.embeddedIndex) == [1, 2])
        #expect(playback.subtitleTracks.first?.isExternal == false)
        #expect(playback.subtitleTracks.first?.isDefault == true)
        #expect(playback.subtitleTracks.first?.externalURL?.path == "/proxy/emby/Videos/episode1/source1/Subtitles/3/Stream.ass")
    }

    @Test func externalSubtitleCDNReceivesNoEmbyCredential() async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            reply(#"{"PlaySessionId":"play1","MediaSources":[{"Id":"source1","SupportsDirectPlay":true,"MediaStreams":[{"Type":"Subtitle","Index":3,"IsExternal":true,"DeliveryUrl":"https://subs.cdn.test/sub.srt?token=cdn-signature&api_key=private-token&X-Emby-Token=private-token"}]}]}"#)
        }
        defer { transport.invalidateAndCancel() }
        let playback = try await EmbyClient(session: session(), urlSession: transport).playback(item: mediaItem())
        #expect(playback.subtitleTracks.first?.externalURL?.absoluteString == "https://subs.cdn.test/sub.srt?token=cdn-signature")
        #expect(playback.headers.isEmpty)
    }

    @Test(arguments: ["file:///private/sub.srt", "../sub.srt", "/Videos/%2e%2e/sub.srt", "https://user:pass@cdn.test/sub.srt", "//cdn.test/sub.srt"])
    func unsafeSubtitleURLIsNotExposedToPlayer(_ subtitleURL: String) async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            .init(data: try JSONSerialization.data(withJSONObject: ["PlaySessionId": "play1", "MediaSources": [["Id": "source1", "SupportsDirectPlay": true,
                "MediaStreams": [["Type": "Subtitle", "Index": 2, "IsExternal": true, "DeliveryUrl": subtitleURL], ["Type": "Subtitle", "Index": 4, "Codec": "ass"]]]]]))
        }
        defer { transport.invalidateAndCancel() }
        let playback = try await EmbyClient(session: session(), urlSession: transport).playback(item: mediaItem())
        #expect(playback.subtitleTracks.map(\.index) == [4])
        #expect(playback.subtitleTracks.first?.embeddedIndex == 1)
        #expect(playback.subtitleTracks.first?.externalURL == nil)
    }

    @Test func externalDirectStreamNeverReceivesEmbyCredentialsOrHeaders() async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            reply(#"{"PlaySessionId":"play1","MediaSources":[{"Id":"source1","SupportsDirectPlay":true,"DirectStreamUrl":"https://cdn.test/movie.mkv?signature=cdn-signature&api_key=private-token&X-Emby-Token=private-token","RequiredHttpHeaders":{"Authorization":"private-token","Referer":"https://emby.test"}}]}"#)
        }
        defer { transport.invalidateAndCancel() }
        let playback = try await EmbyClient(session: session(), urlSession: transport).playback(item: mediaItem())
        #expect(playback.url.absoluteString == "https://cdn.test/movie.mkv?signature=cdn-signature")
        #expect(playback.headers.isEmpty)
    }

    @Test func externalDirectStreamRetainsIndependentCDNSigningParameters() async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            reply(#"{"PlaySessionId":"play1","MediaSources":[{"Id":"source1","SupportsDirectPlay":true,"DirectStreamUrl":"https://cdn.test/movie.mkv?token=cdn-signature&access_token=cdn-access&api_key=cdn-api&signature=private-token"}]}"#)
        }
        defer { transport.invalidateAndCancel() }
        let playback = try await EmbyClient(session: session(), urlSession: transport).playback(item: mediaItem())
        #expect(playback.url.absoluteString == "https://cdn.test/movie.mkv?token=cdn-signature&access_token=cdn-access&api_key=cdn-api")
        #expect(!playback.url.absoluteString.contains("private-token"))
        #expect(playback.headers.isEmpty)
    }

    @Test(arguments: ["file:///etc/passwd", "smb://nas/private/movie.mkv", "https://user:pass@cdn.test/movie", "../private", "/Videos/%2e%2e/private"])
    func unsafeDirectStreamsAreRejected(_ directURL: String) async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            .init(data: try JSONSerialization.data(withJSONObject: ["PlaySessionId": "play1", "MediaSources": [["Id": "source1", "SupportsDirectPlay": true, "DirectStreamUrl": directURL]]]))
        }
        defer { transport.invalidateAndCancel() }
        let client = try EmbyClient(session: session(), urlSession: transport)
        await #expect(throws: (any Error).self) { try await client.playback(item: mediaItem()) }
    }

    @Test(arguments: [EmbyPlaybackEvent.start, .progress, .stop])
    func sessionReportsUseTicksAndCorrectEndpoints(_ event: EmbyPlaybackEvent) async throws {
        let expectedPath: String
        switch event {
        case .start: expectedPath = "/proxy/emby/Sessions/Playing"
        case .progress: expectedPath = "/proxy/emby/Sessions/Playing/Progress"
        case .stop: expectedPath = "/proxy/emby/Sessions/Playing/Stopped"
        }
        let transport = EmbyFixtureProtocol.install { request in
            #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == "private-token")
            let json = try body(request)
            #expect(json["ItemId"].string == "episode1")
            #expect(json["MediaSourceId"].string == "source1")
            #expect(json["PlaySessionId"].string == "play1")
            #expect(json["PositionTicks"].number == 427500000)
            #expect(json["IsPaused"].bool == true)
            #expect(json["PlayMethod"].string == "DirectStream")
            #expect(request.url!.path == expectedPath)
            return reply("", status: 204)
        }
        defer { transport.invalidateAndCancel() }
        let client = try EmbyClient(session: session(), urlSession: transport)
        let playback = EmbyPlayback(url: URL(string: "https://emby.test/proxy/emby/Videos/episode1/stream")!, headers: [:], item: try mediaItem(), mediaSourceID: "source1", playSessionID: "play1", startSeconds: 12.5)
        try await client.report(event, playback: playback, position: 42.75, paused: true)
    }

    @Test func oversizedJSONIsRejectedBeforeDecoding() async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            .init(data: Data(repeating: 32, count: 8 * 1024 * 1024 + 1), headers: ["Content-Length": "8388609"])
        }
        defer { transport.invalidateAndCancel() }
        let client = try EmbyClient(session: session(), urlSession: transport)
        await #expect(throws: EmbyClientError.responseTooLarge) { try await client.libraries() }
    }

    @Test func oversizedChunkedJSONIsRejectedDuringTransfer() async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            .init(data: Data(repeating: 32, count: 8 * 1024 * 1024 + 1))
        }
        defer { transport.invalidateAndCancel() }
        let client = try EmbyClient(session: session(), urlSession: transport)
        await #expect(throws: EmbyClientError.responseTooLarge) { try await client.libraries() }
    }

    @Test func emptySourcesOrPlaybackErrorsCannotBecomeFilesystemPlayback() async throws {
        for response in [#"{"PlaySessionId":"play1","MediaSources":[]}"#,
                         #"{"PlaySessionId":"play1","ErrorCode":"NotAllowed","MediaSources":[{"Id":"source1","Path":"file:///private/video.mkv","SupportsDirectPlay":true}]}"#] {
            let transport = EmbyFixtureProtocol.install { _ in reply(response) }
            defer { transport.invalidateAndCancel() }
            let client = try EmbyClient(session: session(), urlSession: transport)
            await #expect(throws: EmbyClientError.noPlayableMedia) { try await client.playback(item: mediaItem()) }
        }
    }

    @Test func invalidPositionNeverSendsAProgressRequest() async throws {
        let transport = EmbyFixtureProtocol.install { _ in
            Issue.record("Invalid position must be rejected before requesting the server")
            return reply("", status: 204)
        }
        defer { transport.invalidateAndCancel() }
        let client = try EmbyClient(session: session(), urlSession: transport)
        let playback = EmbyPlayback(url: URL(string: "https://emby.test/stream")!, headers: [:], item: try mediaItem(), mediaSourceID: "source", playSessionID: "play", startSeconds: 0)
        for position in [Double.nan, .infinity, -1, Double.greatestFiniteMagnitude] {
            await #expect(throws: CoreError.invalidRequest) { try await client.report(.progress, playback: playback, position: position, paused: false) }
        }
    }
}

private func jellyfinSession(version: String? = "10.11.11") -> EmbySession {
    EmbySession(serverURL: "https://media.test/jellyfin/", userID: "user1", accessToken: "private-token", deviceID: "tv-device",
                serverID: "server", serverKind: .jellyfin, serverVersion: version)
}

// Jellyfin fixtures share the serialized suite: EmbyFixtureProtocol has one handler.
extension EmbyClientTests {
    @Test func publicInfoIdentifiesJellyfinByProductOrVersion() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
            return reply(#"{"ServerName":"Home","Version":"10.11.11","ProductName":"Jellyfin Server","Id":"server"}"#)
        }
        defer { transport.invalidateAndCancel() }
        let info = try await EmbyClient.serverInfo(server: "https://media.test/jellyfin", urlSession: transport)
        #expect(info.kind == .jellyfin)
        #expect(info.version == "10.11.11")
        #expect(MediaServerKind.classify(productName: nil, version: "12.2.0") == .jellyfin)
        #expect(MediaServerKind.classify(productName: "Emby Server", version: "4.9.1.80") == .emby)
        let old = try JSONDecoder().decode(EmbySession.self, from: Data(#"{"serverURL":"https://emby.test/","userID":"user1","accessToken":"private-token","deviceID":"tv-device"}"#.utf8))
        #expect(old.kind == .emby)
    }

    @Test func jellyfinLoginUsesAuthorizationHeaderAndRemembersKind() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            #expect(request.url?.absoluteString == "https://media.test/jellyfin/Users/AuthenticateByName")
            let authorization = request.value(forHTTPHeaderField: "Authorization") ?? ""
            #expect(authorization.hasPrefix("MediaBrowser Client=\"Tigerest Theater TV\""))
            #expect(authorization.contains("DeviceId=\"tv-device\"") && authorization.contains("Version=\"2.9.5\""))
            #expect(!authorization.contains("Token="))
            #expect(request.value(forHTTPHeaderField: "X-Emby-Authorization") == nil)
            #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == nil)
            return reply(#"{"User":{"Id":"user1"},"AccessToken":"private-token","ServerId":"server"}"#)
        }
        defer { transport.invalidateAndCancel() }
        let info = EmbyServerInfo(name: "Home", id: "server", kind: .jellyfin, version: "12.2.0")
        let saved = try await EmbyClient.login(server: "https://media.test/jellyfin", username: "alice", password: "secret",
                                               deviceID: "tv-device", serverInfo: info, urlSession: transport)
        #expect(saved.kind == .jellyfin)
        #expect(saved.serverVersion == "12.2.0")
        let restored = try JSONDecoder().decode(EmbySession.self, from: JSONEncoder().encode(saved))
        #expect(restored.kind == .jellyfin)
    }

    @Test func jellyfinRequestsUseUserQueryRoutesAndEnumFields() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            let values = query(request.url!)
            #expect(request.value(forHTTPHeaderField: "X-Emby-Token") == nil)
            #expect(request.value(forHTTPHeaderField: "Authorization")?.contains("Token=\"private-token\"") == true)
            #expect(values["userId"] == "user1")
            #expect(values["UserId"] == nil)
            if let fields = values["Fields"] {
                for name in ["SeriesId", "SeasonId", "DisplayOrder", "PremiereDate", "CommunityRating", "UserDataLastPlayedDate", "PresentationUniqueKey"] {
                    #expect(!fields.contains(name))
                }
                #expect(fields.contains("MediaStreams"))
            }
            #expect(!(values["IncludeItemTypes"] ?? "").contains("Game"))
            switch request.url?.path {
            case "/jellyfin/Items/movie1": return reply(#"{"Id":"movie1"}"#)
            case "/jellyfin/UserViews", "/jellyfin/UserItems/Resume", "/jellyfin/Items": return reply(#"{"Items":[],"TotalRecordCount":0}"#)
            default:
                Issue.record("Unexpected Jellyfin route \(request.url?.path ?? "")")
                return reply("{}", status: 404)
            }
        }
        defer { transport.invalidateAndCancel() }
        let client = try EmbyClient(session: jellyfinSession(), urlSession: transport)
        _ = try await client.libraries()
        _ = try await client.resumeItems()
        _ = try await client.libraryItems(in: JSONValue(any: ["Id": "library", "CollectionType": "games"]))
        _ = try await client.children(of: JSONValue(any: ["Id": "folder", "Type": "Folder"]))
        #expect(try await client.item(id: "movie1")["Id"].string == "movie1")
        let image = try #require(client.imageURL(itemID: "movie1", type: "Primary", tag: "tag"))
        #expect(image.path == "/jellyfin/Items/movie1/Images/Primary")
        #expect(query(image)["ApiKey"] == "private-token")
        #expect(query(image)["api_key"] == nil)
    }

    @Test func jellyfinPlaybackKeepsBaseURLAndUsesApiKey() async throws {
        let transport = EmbyFixtureProtocol.install { request in
            #expect(request.url?.path == "/jellyfin/Items/episode1/PlaybackInfo")
            return reply(#"{"PlaySessionId":"play1","MediaSources":[{"Id":"source1","SupportsDirectPlay":true,"MediaStreams":[{"Type":"Subtitle","Index":2,"Codec":"srt","IsExternal":true,"DeliveryMethod":"External","DeliveryUrl":"/Videos/episode1/source1/Subtitles/2/0/Stream.srt?ApiKey=stale"}]}]}"#)
        }
        defer { transport.invalidateAndCancel() }
        let playback = try await EmbyClient(session: jellyfinSession(), urlSession: transport).playback(item: mediaItem())
        #expect(playback.url.path == "/jellyfin/Videos/episode1/stream")
        #expect(query(playback.url)["ApiKey"] == "private-token")
        #expect(query(playback.url)["api_key"] == nil)
        let subtitle = try #require(playback.subtitleTracks.first?.externalURL)
        #expect(subtitle.path == "/jellyfin/Videos/episode1/source1/Subtitles/2/0/Stream.srt")
        #expect(query(subtitle)["ApiKey"] == "private-token")
    }

    @Test func presentationKeyIsRequestedOnlyFromKnownOlderJellyfin() {
        let fields = ["Fields": "PresentationUniqueKey,Overview,UserDataLastPlayedDate"]
        #expect(EmbyClient.jellyfinQuery(fields, version: "10.10.7")["Fields"] == "PresentationUniqueKey,Overview")
        #expect(EmbyClient.jellyfinQuery(fields, version: "10.11.0")["Fields"] == "Overview")
        #expect(EmbyClient.jellyfinQuery(fields, version: "12.2.0")["Fields"] == "Overview")
        #expect(EmbyClient.jellyfinQuery(fields, version: nil)["Fields"] == "Overview")
        #expect(EmbyClient.jellyfinQuery(["IncludeItemTypes": "Movie,Game"], version: nil)["IncludeItemTypes"] == "Movie")
    }
}

extension EmbyClientTests {
    @Test func savedSessionWithoutKindIsCompletedFromPublicInfo() throws {
        // 2.8.1 saved the server ID of a Jellyfin server but not its kind.
        let old = try JSONDecoder().decode(EmbySession.self, from: Data(#"{"serverURL":"https://media.test/jellyfin/","userID":"user1","accessToken":"private-token","deviceID":"tv-device","serverID":"server"}"#.utf8))
        #expect(old.needsServerInfo)
        #expect(old.kind == .emby)
        let completed = old.completed(with: EmbyServerInfo(name: "Home", id: "other", kind: .jellyfin, version: "12.2.0"))
        #expect(completed.kind == .jellyfin)
        #expect(completed.serverVersion == "12.2.0")
        #expect(completed.serverID == "server", "the saved server identity is kept")
        #expect(completed.serverURL == old.serverURL && completed.userID == old.userID)
        #expect(completed.accessToken == old.accessToken && completed.deviceID == old.deviceID)
        #expect(!completed.needsServerInfo)
        let restored = try JSONDecoder().decode(EmbySession.self, from: JSONEncoder().encode(completed))
        #expect(restored.kind == .jellyfin)
        // A session that knows its kind keeps it.
        #expect(!jellyfinSession().needsServerInfo)
        #expect(jellyfinSession().completed(with: EmbyServerInfo(name: "Home", id: "server", kind: .emby, version: "4.9.1.80")).kind == .jellyfin)
    }
}
