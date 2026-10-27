import Foundation

/// The dedicated server's own services: plain HTTP inside the NAS network,
/// HTTPS from anywhere else (from 2.9.5). The retired public HTTP addresses are
/// only recognised so saved settings move off them; they are never contacted.
public enum TigerestService {
    public static let lanHost = "192.168.5.150"
    public static let localOrigin = "http://192.168.5.150:18443"
    public static let remoteOrigin = "https://nas.tigerest.top:18446"
    static let retiredRemoteOrigin = "http://nas.tigerest.top:18443"
    public static let remoteEmby = "https://nas.tigerest.top:18445/"
    static let retiredRemoteEmby = "http://nas.tigerest.top:8095"

    /// The comment, room and mapping service for an Emby address: the LAN
    /// service only for the LAN Emby address, otherwise the public one.
    public static func origin(forEmby address: String) -> String {
        URL(string: address)?.host?.lowercased() == lanHost ? localOrigin : remoteOrigin
    }
    /// The public HTTPS Emby address for a dedicated profile saved on the old
    /// public address, or nil when there is nothing to move.
    public static func movedEmby(_ address: String) -> String? {
        guard let saved = try? ServerAddress(address), saved.origin == retiredRemoteEmby, saved.baseURL.path == "/" else { return nil }
        return remoteEmby
    }
}
