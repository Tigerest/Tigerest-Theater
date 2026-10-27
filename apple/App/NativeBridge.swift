import UIKit
import AppleCore
@MainActor final class NativeBridge {
    unowned let model: AppModel
    var output: ((JSONValue) -> Void)?
    init(model: AppModel) { self.model = model }
    func emit(_ component: String, _ signal: String, _ args: [JSONValue] = []) { output?(.object(["component": .string(component), "signal": .string(signal), "args": .array(args)])) }
    func handle(_ request: BridgeRequest) async throws -> JSONValue {
        let args = request.args
        func arg(_ index: Int) -> JSONValue { args.indices.contains(index) ? args[index] : .null }
        switch request.component {
        case "danmaku": return try await model.danmaku.dispatch(request.method, args)
        case "player": return try model.player.dispatch(request.method, args)
        case "settings":
            let section = arg(0).string ?? "", key = arg(1).string ?? ""
            switch request.method {
            case "value": return model.settings.get(section, key)
            case "setValue":
                if section == "mpv", key == "shaderPreset" {
                    guard let preset=QualitySelection.ids[arg(2).string ?? ""] else {throw CoreError.invalidSetting}
                    try model.player.selectQuality(QualitySelection(preset:preset))
                } else {try model.settings.set(section, key, arg(2));try model.player.applySettings()}
                model.danmaku.applySettings(); return .bool(true)
            case "resetToDefault":
                try model.settings.reset(section)
                if section == "mpv" {try model.player.selectQuality(QualitySelection())}
                else {try model.player.applySettings()}
                model.danmaku.applySettings();return .bool(true)
            default: throw CoreError.invalidRequest
            }
        case "window":
            switch request.method {
            case "isFullScreen": return .bool(true)
            case "beginPlaybackSession", "endPlaybackSession", "requestPlaybackFullScreen", "setCursorVisibility": return .null
            default: throw CoreError.invalidRequest
            }
        case "system":
            switch request.method {
            case "setEmbySession": model.setEmbySession(arg(0));return .bool(true)
            case "startDownload", "downloads", "downloadInfo", "pauseDownload", "resumeDownload", "removeDownload": return try model.downloads.dispatch(request.method,args)
            case "communityRequest": try model.community.request(arg(0).string ?? "", arg(1)); return .bool(true)
            case "communitySourceAvatar": try model.community.request(arg(0).string ?? "", arg(1), avatar: true); return .bool(true)
            case "communityCancel": model.community.cancel(arg(0).string ?? ""); return .bool(true)
            case "communityCredential": return try model.community.credential(arg(0).string ?? "", arg(1).string ?? "", arg(2).string ?? "")
            case "communitySetEmbySession": return .bool(model.community.setSession(arg(0)))
            case "setReportDiagnosticsScope": model.diagnostics.setScope(arg(0).string ?? ""); return .bool(true)
            case "collectReportDiagnostics": return model.diagnostics.collect()
            case "debugInformation": return model.player.diagnostics()
            case "isAddressOnLocalSubnet": return .bool(ServerPresets.onLocalSubnet(arg(0).string ?? ""))
            case "cancelServerConnectivity": return .bool(true)
            case "checkServerConnectivity":
                let address = try ServerAddress(arg(0).string ?? "")
                let (body, response) = try await model.community.data(URLRequest(url: address.endpoint("System/Info/Public")), limit: 65536)
                let info = try JSONDecoder().decode(JSONValue.self, from: body)
                let success = response.statusCode == 200 && (info["Id"].string != nil || info["Version"].string != nil)
                emit("system", "serverConnectivityResult", [arg(0), .bool(success), .string(address.endpoint("web/index.html").absoluteString), .string(success ? "" : "无法连接 Emby 或 Jellyfin 服务器")]); return .bool(success)
            case "hello": return .string("大河影院 Universal")
            case "getUserAgent": return .string(model.web.view.customUserAgent ?? "TigerestTheater/\(AppVersion.current)")
            case "finishServerSelection": return .bool(await model.finishServerSelection(arg(0).string ?? "", mode: arg(1).string ?? "", target: arg(2).string ?? "", history: arg(3).string))
            case "takeServerSelectionError": return .bool(model.takeServerSelectionError())
            case "openServerSettings": model.openServerSettings(); return .null
            case "openQualitySettings": model.showQuality = true; return .null
            case "openProfiles": model.showProfiles = true; return .null
            case "openOfflineLibrary": model.showOffline = true; return .null
            case "systemInformation": return .object(["platform": .string("ipad"), "version": .string(UIDevice.current.systemVersion)])
            case "openExternalUrl":
                guard let text = arg(0).string, let url = URL(string: text), ["https", "http"].contains(url.scheme), url.user == nil, url.password == nil else { throw CoreError.invalidAddress }
                return .bool(await UIApplication.shared.open(url))
            case "restart": model.start(); return .null
            case "appUpdateState": return model.updates.state
            case "checkForUpdates": return await model.updates.check(manual:arg(0).bool ?? false)
            case "skipAppUpdate": model.updates.skip();return .null
            case "deferAppUpdate": model.updates.deferUpdate();return .null
            default: throw CoreError.invalidRequest
            }
        default: throw CoreError.invalidRequest
        }
    }
}
