import Foundation
public struct DanmakuProvider: Sendable, Equatable {
    public let url: String, note: String
    public static let remote = TigerestService.remoteOrigin, local = TigerestService.localOrigin
    /// Our service under any address it has had. Old settings name the retired
    /// public HTTP address; `parse` moves it to the active one, never contacting it.
    public static func managed(_ url: String) -> Bool { [remote,local,TigerestService.retiredRemoteOrigin,"https://danmaku-api.152468.xyz"].contains(url.trimmingCharacters(in:CharacterSet(charactersIn:"/"))) }
    /// Only our service at its current addresses learns which client and user asked.
    public static func own(_ url: String) -> Bool { [remote,local].contains(url.trimmingCharacters(in:CharacterSet(charactersIn:"/"))) }
    public static func parse(_ setting: String, embyHost: String?) -> [Self] {
        let active = embyHost=="192.168.5.150" ? local : remote
        return (setting.isEmpty ? remote : setting).split(separator:",").compactMap { entry in
            let parts=entry.split(maxSplits:1,whereSeparator:{ $0=="|" || $0=="#" }).map { $0.trimmingCharacters(in:.whitespacesAndNewlines) }
            guard let raw=parts.first,let address=try? ServerAddress(raw) else { return nil }
            let url=address.baseURL.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/"))
            return Self(url:managed(url) ? active : url,note:parts.count>1 ? parts[1] : "")
        }
    }
}
