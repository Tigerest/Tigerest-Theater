import Foundation
import Combine
import AppleCore
import CryptoKit
@MainActor final class DanmakuRepository: ObservableObject {
    struct Source: Codable, Identifiable {
        let id: String
        let title: String
        let comments: [DanmakuComment]
        var enabled = true
        var delay = 0.0
    }
    let host: any DanmakuHost
    @Published var sources: [Source] = []
    @Published var status = ""
    @Published var enabled = true
    private(set) var revision: UInt64 = 0
    var allComments: [DanmakuComment] { sources.filter(\.enabled).flatMap { source in source.comments.map { .init(time:$0.time+source.delay,text:$0.text,mode:$0.mode,color:$0.color) } } }
    private var timelines: [String: DanmakuTimeline] = [:]
    private var generation: UInt64 = 0
    private var job: Task<Void, Never>?
    private var item: JSONValue = .null
    private var cooldowns: [String: Date] = [:]
    private var activeBase = ""
    var searchTitle: String { item["SeriesName"].string ?? item["Name"].string ?? "" }
    private func number(_ value: JSONValue) -> Double? { value.number ?? value.string.flatMap(Double.init) }
    init(host: any DanmakuHost) { self.host = host; enabled = host.setting("mpv", "enableDanmaku").bool != false }
    var providers: [DanmakuProvider] { DanmakuProvider.parse(host.setting("danmaku","apiServer").string ?? "", embyHost: host.serverHost) }
    var base: String { providers.first?.url ?? DanmakuProvider.remote }
    private var playbackGeneration: UInt64 = 0
    private var mediaURL: URL?
    private func scalar(_ value: JSONValue) -> String { DanmakuMatch.scalar(value) }
    private func recordRateLimit(_ response: HTTPURLResponse, server: String) {
        guard response.statusCode==429 else { return }
        let raw=response.value(forHTTPHeaderField:"Retry-After") ?? "60"
        let formatter=DateFormatter();formatter.locale=Locale(identifier:"en_US_POSIX");formatter.dateFormat="EEE, dd MMM yyyy HH:mm:ss zzz"
        let interval=max(0,Double(raw) ?? formatter.date(from:raw)?.timeIntervalSinceNow ?? 60)
        let until=Date().addingTimeInterval(interval)
        for origin in DanmakuProvider.managed(server) ? [DanmakuProvider.remote,DanmakuProvider.local] : [server] { cooldowns[origin]=max(cooldowns[origin] ?? .distantPast,until) }
    }
    // Same bounded retry as PC modules/http.lua: one retry after 1 s for
    // transient reads. A manual shared correction must never be replayed.
    private func requestData(_ base: URLRequest, server: String, retry: Bool) async throws -> (Data,HTTPURLResponse) {
        // Our own service records which client, and with a comment session which user,
        // asked; other providers receive neither.
        guard DanmakuProvider.managed(server) else { return try await send(base,server:server,retry:retry) }
        var request=base
        for (name,value) in host.clientHeaders { request.setValue(value,forHTTPHeaderField:name) }
        guard let user=await host.communityAccessToken() else { return try await send(request,server:server,retry:retry) }
        request.setValue(user,forHTTPHeaderField:"X-Tigerest-User-Token")
        let result=try await send(request,server:server,retry:retry)
        guard result.1.statusCode==401 else { return result }
        // An expired comment session must not cost the danmaku: ask again anonymously.
        request.setValue(nil,forHTTPHeaderField:"X-Tigerest-User-Token")
        return try await send(request,server:server,retry:retry)
    }
    private func send(_ request: URLRequest, server: String, retry: Bool) async throws -> (Data,HTTPURLResponse) {
        let token=generation
        for attempt in 0...1 {
            guard token==generation,!Task.isCancelled,Date()>=(cooldowns[server] ?? .distantPast) else {throw CancellationError()}
            do {
                let result=try await host.data(request,limit:16*1024*1024)
                if !retry || attempt==1 || ![408,502,503,504].contains(result.1.statusCode) {return result}
            } catch {
                let transient=(error as? URLError).map { [.timedOut,.cannotFindHost,.cannotConnectToHost,.networkConnectionLost,.dnsLookupFailed].contains($0.code) } ?? false
                if !retry || attempt==1 || !transient {throw error}
            }
            try await Task.sleep(for:.seconds(1))
        }
        throw URLError(.badServerResponse)
    }
    private func fetchBytes(_ path: String, server: String? = nil, body: JSONValue? = nil, retry: Bool = false) async throws -> Data {
        let origin=server ?? base
        guard Date() >= (cooldowns[origin] ?? .distantPast), let url=URL(string:origin+path) else { throw CoreError.invalidRequest }
        var request=URLRequest(url:url);request.timeoutInterval=20
        request.setValue("application/json",forHTTPHeaderField:"Accept");request.setValue("mpv_danmaku/1.0",forHTTPHeaderField:"User-Agent")
        for (name,value) in try DanmakuSigning.headers(url:url) { request.setValue(value,forHTTPHeaderField:name) }
        if let body { request.httpMethod="POST";request.httpBody=try JSONEncoder().encode(body);request.setValue("application/json",forHTTPHeaderField:"Content-Type") }
        let (data,response)=try await requestData(request,server:origin,retry:retry || path.hasPrefix("/api/v2/comment/") || path.hasPrefix("/api/v2/extcomment"))
        recordRateLimit(response,server:origin)
        guard response.statusCode==200 else { throw URLError(.badServerResponse) }
        return data
    }
    private func fetch(_ path: String, server: String? = nil, body: JSONValue? = nil) async throws -> JSONValue {
        let data=try await fetchBytes(path,server:server,body:body)
        let value=try JSONDecoder().decode(JSONValue.self,from:data)
        guard value["success"].bool != false else { throw URLError(.badServerResponse) }
        return value
    }
    private func hash(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
    private var scope: String { host.cacheScope + "|" + providers.map(\.url).joined(separator:",") }
    private var cache: URL {
        let identity = item["Id"].string ?? String(decoding: (try? JSONEncoder().encode(item)) ?? Data(), as: UTF8.self)
        return host.directory.appending(path: "Danmaku/" + hash(scope + "|" + identity) + ".json")
    }
    func authorizationChanged() { generation &+= 1; playbackGeneration &+= 1; job?.cancel() }
    func refresh() { let current=item, url=mediaURL; if current != .null { autoMatch(current, mediaURL:url) } }
    func applySettings() {
        let next = host.setting("mpv", "enableDanmaku").bool != false
        let retry = (!enabled && next) || activeBase != providers.map(\.url).joined(separator:",")
        enabled = next
        if retry { refresh() }
        if !enabled { generation &+= 1; job?.cancel(); announce("弹幕已关闭") }
    }
    private func changed() {
        revision &+= 1
        timelines = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, DanmakuTimeline($0.comments)) })
        if item != .null {
            try? FileManager.default.createDirectory(at: cache.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let data = try? JSONEncoder().encode(sources), data.count <= 32*1024*1024 { try? data.write(to: cache, options: .atomic) }
        }
        host.emit("sourcesChanged", [snapshot])
    }
    private func announce(_ text: String) { host.log("info", "Danmaku: " + text); status = text; host.emit("status", [.string(text)]) }
    var snapshot: JSONValue { .array(sources.map { .object(["id": .string($0.id), "title": .string($0.title), "enabled": .bool($0.enabled), "delay": .number($0.delay), "count": .number(Double($0.comments.count))]) }) }
    func clear() { revision &+= 1; generation &+= 1; playbackGeneration &+= 1; mediaURL=nil; job?.cancel(); job = nil; sources = []; timelines = [:]; item = .null; announce("") }
    func autoMatch(_ metadata: JSONValue, mediaURL: URL? = nil) {
        clear(); item = metadata; self.mediaURL=mediaURL; activeBase = providers.map(\.url).joined(separator:",")
        enabled = host.setting("mpv", "enableDanmaku").bool != false
        guard enabled else { announce("弹幕已关闭"); return }
        guard metadata != .null else { announce("无作品信息，可手动搜索或导入弹幕"); return }
        announce("正在匹配弹幕…")
        let token = generation
        job = Task { [weak self] in
            guard let self else { return }
            do {
                // A shared gateway outage must not prevent cached or direct search.
                if (try? await shared(selection: nil, token: token)) == true { return }
                guard token == generation, !Task.isCancelled else { return }
                if let data=try? Data(contentsOf:cache),data.count<=32*1024*1024,let saved=try? JSONDecoder().decode([Source].self,from:data),!saved.isEmpty {
                    sources=Array(saved.prefix(12))
                    // The PC history recalls this file's selected source and
                    // fetches fresh comments; cached comments are an offline fallback.
                    for source in sources {
                        if let provider=providers.first(where:{source.id.hasPrefix($0.url+"/")}) {
                            let id=String(source.id.dropFirst(provider.url.count+1))
                            if (try? await load(id,title:source.title,token:token,server:provider.url)) != nil { return }
                        }
                    }
                    guard token==generation,!Task.isCancelled else {return}
                    changed();announce("已载入缓存弹幕 \(sources.reduce(0) { $0 + $1.comments.count }) 条");return
                }
                let title = metadata["SeriesName"].string ?? metadata["Name"].string ?? ""
                guard !title.isEmpty else { return }
                guard providers.contains(where:{Date()>=(self.cooldowns[$0.url] ?? .distantPast)}) else { announce("弹幕服务请求频繁，请稍后重试"); return }
                if try await matchHash(token:token) { return }
                guard token == generation, !Task.isCancelled else { return }
                guard let episodeNumber=number(metadata["IndexNumber"]), episodeNumber.isFinite, (0...10000).contains(episodeNumber), episodeNumber.rounded()==episodeNumber else { announce("无法解析剧集信息，请手动匹配弹幕"); return }
                let works=try await search(title,manual:false)
                let season=number(metadata["ParentIndexNumber"]).flatMap { $0.isFinite && (0...1000).contains($0) && $0.rounded()==$0 ? Int($0) : nil }
                let ranked=DanmakuMatch.ranked(works:works,title:title,season:season,includeUnmatched:true)
                host.log("info", "Danmaku metadata S\(season ?? -1)E\(Int(episodeNumber)); releases=\(works.count), seasonEligible=\(ranked.count)")
                var matches: [DanmakuMatch.Candidate]=[]
                for work in DanmakuMatch.detailLookups(ranked) {
                    guard token == generation, !Task.isCancelled else { return }
                    guard let detail=try? await release(scalar(work.value["bangumiId"]),server:work.value["_server"].string),
                          var enriched=work.value.object else {continue}
                    enriched["titles"]=detail["titles"]
                    guard let scored=DanmakuMatch.ranked(works:[.object(enriched)],title:title,season:season).first else {continue}
                    let result=DanmakuMatch.episodes(detail["episodes"].array ?? [],number:Int(episodeNumber),title:metadata["Name"].string ?? "")
                    host.log("info", "Danmaku release \(scalar(work.value["bangumiId"])); score=\(scored.score), episodes=\(result.values.count), titleMatched=\(result.byTitle)")
                    matches += result.values.map { .init(work:work.value,episode:$0,score:scored.score,byTitle:result.byTitle) }
                }
                guard token == generation, !Task.isCancelled else { return }
                if let match=DanmakuMatch.resolve(matches) {
                    _ = try await load(scalar(match.episode["episodeId"]), title:(match.work["animeTitle"].string ?? title)+" · "+(match.episode["episodeTitle"].string ?? ""), token:token,server:match.work["_server"].string)
                } else { announce("未找到唯一对应剧集的弹幕，可在弹幕菜单中手动匹配") }
            } catch { if token == generation, !Task.isCancelled { announce("弹幕暂不可用，可稍后手动搜索或导入") } }
        }
    }
    private func scoped(_ values: [JSONValue], server: String, token: UInt64) -> [JSONValue] {
        values.compactMap { value in guard var object=value.object else { return nil };object["_server"] = .string(server);object["_playback"] = .number(Double(token));return .object(object) }
    }
    func search(_ keyword: String, manual: Bool = true) async throws -> [JSONValue] {
        guard !keyword.isEmpty,keyword.count<=200 else { throw CoreError.invalidRequest }
        if manual, let query=DanmakuExtra.query(keyword) {
            // TestFlight builds reach danmaku only through the configured servers.
            if Distribution.testFlight {return try await search(query.name)}
            return try await searchExtra(query.name,category:query.category)
        }
        let token=playbackGeneration, origins=providers.map(\.url)
        let encoded=keyword.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed.subtracting(CharacterSet(charactersIn:"&+=?#")))!
        var results:[JSONValue]=[],seen=Set<String>(),succeeded=false
        // Same provider order and deduplication as the PC manual catalog.
        for start in stride(from:0,to:origins.count,by:5) {
            let batch=origins[start..<min(start+5,origins.count)].map { origin in Task { try? await self.fetch("/api/v2/search/anime?keyword="+encoded,server:origin) } }
            for (offset,task) in batch.enumerated() {
                let value=await task.value
                guard token==playbackGeneration,!Task.isCancelled else { batch.forEach { $0.cancel() };throw CancellationError() }
                if let values=value?["animes"].array {
                    succeeded=true
                    results += scoped(values,server:origins[start+offset],token:token).filter { seen.insert((manual ? "" : ($0["_server"].string ?? "")+"|")+scalar($0["bangumiId"])).inserted }
                }
            }
        }
        guard succeeded else { throw URLError(.badServerResponse) };return results
    }
    private func release(_ id:String,server:String?) async throws -> JSONValue {
        guard id.range(of:"^(?:[0-9]+|tmdb-[A-Za-z0-9-]+)$",options:.regularExpression) != nil,id.count<=100 else {throw CoreError.invalidRequest}
        let token=playbackGeneration,origin=server ?? base
        let value=try await fetch("/api/v2/bangumi/"+id,server:origin)["bangumi"]
        guard token==playbackGeneration,!Task.isCancelled else {throw CancellationError()}
        return value
    }
    func episodes(_ id: String, server: String? = nil) async throws -> [JSONValue] {
        let token=playbackGeneration,origin=server ?? base
        let values=try await release(id,server:origin)["episodes"].array ?? []
        guard token==playbackGeneration,!Task.isCancelled else {throw CancellationError()}
        return scoped(values,server:origin,token:token).map { value in var object=value.object!;object["_bangumi"] = .string(id);return .object(object) }
    }
    private func encoded(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters:.alphanumerics) ?? "" }
    private func searchExtra(_ name: String,category: String) async throws -> [JSONValue] {
        let token=playbackGeneration
        var title=name
        // Same default translation key and language as PC options.lua/extra.lua.
        if !title.unicodeScalars.contains(where:{(0x4000...0x9fff).contains($0.value)}) {
            let key=String(data:Data(base64Encoded:"NmJmYjIxOTZkNzIyN2UyMTIzMGM3Y2YzZjQ4MDNkZGM=")!,encoding:.utf8)!
            let value=try await fetch("/3/search/"+(category=="dy" ? "movie" : "tv")+"?api_key="+key+"&query="+encoded(title)+"&language=zh-CN",server:"https://api.tmdb.org")
            title=value["results"].array?.first?[category=="dy" ? "title" : "name"].string ?? ""
        }
        guard !title.isEmpty else {return []}
        let value=try await fetch("/index?force_v=1&kw="+encoded(title)+"&type="+encoded(category),server:"https://api.so.360kan.com")
        guard token==playbackGeneration,!Task.isCancelled else {throw CancellationError()}
        return scoped(DanmakuExtra.works(value),server:"https://api.so.360kan.com",token:token)
    }
    func episodes(for work: JSONValue) async throws -> [JSONValue] {
        guard work["_playback"].number==Double(playbackGeneration) else {throw CancellationError()}
        guard let extra=work["_extra"].object else {return try await episodes(scalar(work["bangumiId"]),server:work["_server"].string)}
        let token=playbackGeneration,id=scalar(extra["id"] ?? .null),site=extra["site"]?.string ?? ""
        let category=extra["class"]?.string ?? "",cat=category=="电影" ? 1 : category=="电视剧" ? 2 : category=="动漫" ? 4 : 0
        var rows:[JSONValue]=[]
        if cat==1,let link=extra["playlink"]?.string {rows=[DanmakuExtra.episode(index:"1",url:link)]}
        else if [2,4].contains(cat) {
            if extra["seriesSite"]?.string==site {rows=DanmakuExtra.rows(extra["seriesPlaylinks"] ?? .null,playlink:extra["playlink"]?.string)}
            if rows.isEmpty {
                let params:JSONValue = .array([.object(["cat_id":.string(String(cat)),"ent_id":.string(id),"site":.string(site)])])
                let query=String(decoding:try JSONEncoder().encode(params),as:UTF8.self)
                if let value=try? await fetch("/episodesv2?v_ap=1&s="+encoded(query),server:"https://api.so.360kan.com") {
                    rows=DanmakuExtra.rows(value["data"].array?.first?["seriesHTML"]["seriesPlaylinks"] ?? .null)
                }
            }
        }
        if rows.isEmpty,cat != 0 {
            let path="/v1/detail?cat=\(cat)&id="+encoded(id)+"&site="+encoded(site)
            let value=try await fetch(path,server:"https://api.web.360kan.com")
            let number=number(value["data"]["allupinfo"][site]) ?? 0
            guard number.isFinite,(0...10000).contains(number) else {throw CoreError.invalidRequest}
            for start in stride(from:1,through:Int(number),by:200) {
                guard token==playbackGeneration,!Task.isCancelled else {throw CancellationError()}
                let part=try await fetch(path+"&start=\(start)&end=\(min(start+199,Int(number)))",server:"https://api.web.360kan.com")
                rows += (part["data"]["allepidetail"][site].array ?? []).compactMap { row in guard let url=row["url"].string else {return nil};return DanmakuExtra.episode(index:scalar(row["playlink_num"]),url:url) }
            }
        }
        guard token==playbackGeneration,!Task.isCancelled else {throw CancellationError()}
        return scoped(rows,server:work["_server"].string!,token:token).map { var object=$0.object!;object["_bangumi"] = work["bangumiId"];return .object(object) }
    }
    private func matchHash(token: UInt64) async throws -> Bool {
        // PC hashes only a local file >= 16 MiB. Emby streams use metadata;
        // reading a separate HTTP range both delays matching and changes parity.
        guard let mediaURL,mediaURL.isFileURL,let file=try? FileHandle(forReadingFrom:mediaURL) else { return false }
        defer { try? file.close() }
        let count=16*1024*1024, data=try? file.read(upToCount:count)
        guard token==generation,!Task.isCancelled else { throw CancellationError() }
        guard let data,data.count==count else { return false }
        let digest=Insecure.MD5.hash(data:data).map { String(format:"%02x",$0) }.joined()
        let season=scalar(item["ParentIndexNumber"]),episode=scalar(item["IndexNumber"])
        let filename=searchTitle+(season.isEmpty ? " E" : " S"+season+"E")+episode
        for origin in providers.map(\.url) {
            let value=try? await fetch("/api/v2/match",server:origin,body:.object(["fileName":.string(filename),"fileHash":.string(digest),"matchMode":.string("hashAndFileName")]))
            guard token==generation,!Task.isCancelled else { throw CancellationError() }
            if value?["isMatched"].bool==true,let match=value?["matches"].array?.first {
                _ = try await load(scalar(match["episodeId"]),title:(match["animeTitle"].string ?? searchTitle)+" · "+(match["episodeTitle"].string ?? ""),token:token,server:origin);return true
            }
        }
        return false
    }
    @discardableResult func load(_ id: String, title: String, token: UInt64? = nil, server: String? = nil) async throws -> Int {
        guard id.range(of:"^[0-9]{1,32}$",options:.regularExpression) != nil else { throw CoreError.invalidRequest }
        let token = token ?? generation
        let value = try await fetch("/api/v2/comment/\(id)?withRelated=true&chConvert=0",server:server)
        let comments = try DanmakuParser.parse(data: JSONEncoder().encode(value))
        guard token == generation, !Task.isCancelled else { throw CancellationError() }
        add((server ?? base)+"/"+id, title, comments, replacingAPI:true); return comments.count
    }
    func select(_ episode: JSONValue, work: JSONValue, share: Bool) async throws {
        guard episode["_playback"].number==Double(playbackGeneration),work["_playback"].number==Double(playbackGeneration),
              episode["_bangumi"].string==scalar(work["bangumiId"]),episode["_server"].string != nil,episode["_server"]==work["_server"] else { throw CancellationError() }
        generation &+= 1; job?.cancel()
        try host.setSetting("mpv","enableDanmaku",.bool(true));enabled=true
        let token = generation, id = scalar(episode["episodeId"])
        if work["_extra"] != .null,let url=episode["_url"].string {
            _ = try await loadExternal(url,token:token);return
        }
        let server=episode["_server"].string ?? work["_server"].string ?? base
        // PC tries the shared correction first, then retrieves the same episode
        // directly if credentials/write fail; 429 never falls through to a GET.
        if share, (try? await shared(selection:.object(["bangumiId":.string(scalar(work["bangumiId"])),"episodeId":.string(id)]),token:token,server:server))==true { return }
        guard token==generation,Date()>=(cooldowns[server] ?? .distantPast) else { throw CancellationError() }
        _ = try await load(id, title:(work["animeTitle"].string ?? "") + " · " + (episode["episodeTitle"].string ?? ""), token:token,server:server)
        if share, DanmakuProvider.managed(server), token==generation { announce("弹幕已加载；共享匹配未保存，请检查权限或稍后重试") }
    }

    private func shared(selection: JSONValue?, token: UInt64, server: String? = nil) async throws -> Bool {
        let base=server ?? providers.first(where:{DanmakuProvider.managed($0.url)})?.url ?? self.base
        guard [DanmakuProvider.remote,DanmakuProvider.local].contains(base),
              let title = item["SeriesName"].string,!title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,title.unicodeScalars.count<=200,title.utf8.count<=800, let season = number(item["ParentIndexNumber"]), let episode = number(item["IndexNumber"]), (1...1000).contains(season), (1...10000).contains(episode), season.rounded()==season,episode.rounded()==episode,Date() >= (cooldowns[base] ?? .distantPast) else { return false }
        var body: [String:JSONValue] = ["source":.object(["title":.string(title),"season":.number(season),"episode":.number(episode)]),"comment":.object(["withRelated":.bool(true),"chConvert":.number(0)])]
        var request = URLRequest(url:URL(string:base+"/api/tigerest/v1/danmaku")!); request.httpMethod = "POST";request.timeoutInterval=35
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        request.setValue("application/json",forHTTPHeaderField:"Accept");request.setValue("TigerestTheater mapping",forHTTPHeaderField:"User-Agent")
        if let selection {
            guard !host.mappingHeaders.isEmpty,scalar(selection["bangumiId"]).range(of:"^[A-Za-z0-9-]+$",options:.regularExpression) != nil,scalar(selection["episodeId"]).range(of:"^[0-9]{1,32}$",options:.regularExpression) != nil else { return false }
            body["selection"] = selection
            for (name,value) in host.mappingHeaders { request.setValue(value,forHTTPHeaderField:name) }
        }
        request.httpBody = try JSONEncoder().encode(body)
        guard request.httpBody!.count<=16384 else { return false }
        let (data,response) = try await requestData(request,server:base,retry:selection==nil)
        recordRateLimit(response,server:base)
        if response.statusCode == 429 { throw URLError(.resourceUnavailable) }
        guard token == generation, !Task.isCancelled else { throw CancellationError() }
        guard response.statusCode == 200, let value = try? JSONDecoder().decode(JSONValue.self,from:data), value["success"].bool == true, value["matched"].bool == true, value["match"]["origin"].string == (selection == nil ? "shared" : "manual"),value["danmaku"]["comments"].array != nil,scalar(value["match"]["episodeId"]).range(of:"^[0-9]{1,32}$",options:.regularExpression) != nil else { return false }
        let comments = try DanmakuParser.parse(data: JSONEncoder().encode(value["danmaku"]))
        add(base+"/"+scalar(value["match"]["episodeId"]), value["match"]["episodeTitle"].string ?? title, comments, replacingAPI:true)
        return true
    }
    private func add(_ id: String, _ title: String, _ comments: [DanmakuComment], replacingAPI: Bool = false) {
        let previous = sources.first { $0.id == id }
        sources.removeAll { $0.id == id || (replacingAPI && $0.id.hasPrefix("http") && $0.id.split(separator:"/").last?.allSatisfy(\.isNumber)==true) }; if sources.count >= 12 { sources.removeFirst() }
        sources.append(Source(id:id,title:title,comments:comments,enabled:previous?.enabled ?? true,delay:previous?.delay ?? 0)); changed(); announce("已载入 \(comments.count) 条弹幕")
    }
    func importData(_ data: Data, name: String) throws { add(UUID().uuidString,name,try DanmakuParser.parse(data:data)) }
    func setSource(_ id: String, enabled: Bool, delay: Double) throws {
        guard delay.isFinite, abs(delay) <= 3600, let index = sources.firstIndex(where: { $0.id == id }) else { throw CoreError.invalidRequest }
        sources[index].enabled = enabled; sources[index].delay = delay; changed()
    }
    func visible(at time: Double, duration: Double) -> [DanmakuComment] {
        guard enabled else { return [] }
        return sources.filter(\.enabled).flatMap { source in (timelines[source.id]?.visible(at:time-source.delay,duration:duration) ?? []).map { .init(time:$0.time+source.delay,text:$0.text,mode:$0.mode,color:$0.color) } }.sorted { $0.time < $1.time }
    }
    private func loadExternal(_ url: String,token: UInt64) async throws -> Int {
        guard let parsed=URL(string:url),["http","https"].contains(parsed.scheme),parsed.user==nil,parsed.password==nil else {throw CoreError.invalidAddress}
        let origins=providers.map(\.url).filter {!$0.lowercased().contains("dandanplay.net")}
        for start in stride(from:0,to:origins.count,by:3) {
            let comments=try await withThrowingTaskGroup(of:JSONValue?.self,returning:[DanmakuComment]?.self) { group in
                for origin in origins[start..<min(start+3,origins.count)] {
                    group.addTask {try? await self.fetch("/api/v2/extcomment?url="+self.encoded(url),server:origin)}
                }
                for try await value in group {
                    guard token==generation,!Task.isCancelled else {group.cancelAll();throw CancellationError()}
                    if let value,let comments=try? DanmakuParser.parse(data:JSONEncoder().encode(value)),comments.count>1 {
                        group.cancelAll();return comments
                    }
                }
                return nil
            }
            if let comments {add(url,parsed.host ?? "网址弹幕",comments);return comments.count}
        }
        // The PC's default aggregation fallback. Individual site extractors are
        // separate from the catalog/search path and are not run in the iOS core.
        guard !Distribution.testFlight else {throw URLError(.resourceUnavailable)}
        let data=try await fetchBytes("/?ac=dm&url="+encoded(url),server:"https://api.danmu.icu",retry:true)
        let comments=try DanmakuParser.parse(data:data)
        guard token==generation,!Task.isCancelled else {throw CancellationError()}
        guard comments.count>1 else {throw URLError(.cannotParseResponse)}
        add(url,parsed.host ?? "网址弹幕",comments);return comments.count
    }
    func dispatch(_ method: String, _ args: [JSONValue]) async throws -> JSONValue {
        func arg(_ n: Int) -> JSONValue { args.indices.contains(n) ? args[n] : .null }
        switch method {
        case "search": return .array(try await search(arg(0).string ?? ""))
        case "episodes": return .array(try await episodes(scalar(arg(0))))
        case "match": autoMatch(arg(0)); return .bool(true)
        case "load": return .number(Double(try await load(scalar(arg(0)),title:arg(1).string ?? "弹幕")))
        case "sources": return snapshot
        case "setSource": try setSource(arg(0).string ?? "",enabled:arg(1).bool ?? true,delay:arg(2).number ?? 0); return .bool(true)
        case "setEnabled": try host.setSetting("mpv","enableDanmaku",.bool(arg(0).bool ?? false)); applySettings(); return .bool(true)
        case "loadUrl":
            guard let url = arg(0).string, let parsed = URL(string:url), ["http","https"].contains(parsed.scheme), parsed.user == nil else { throw CoreError.invalidAddress }
            return .number(Double(try await loadExternal(url,token:generation)))
        default: throw CoreError.invalidRequest
        }
    }
}
