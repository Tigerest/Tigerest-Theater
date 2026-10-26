import Foundation
import Darwin
import AppleCore
struct ServerPresets: Decodable {
    let remote: String
    let local: String
    let localIP: String
    static var bundled: Self { try! JSONDecoder().decode(Self.self,from:Data(contentsOf:Bundle.main.resourceURL!.appending(path:"Web/server_defaults.json"))) }
    func contains(_ address: ServerAddress) -> Bool { [remote, local].contains { (try? ServerAddress($0).origin) == address.origin && address.baseURL.path == "/" } }
    /// Whether a typed address is the dedicated server's local or remote preset.
    func contains(typed input: String) -> Bool {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let canonical = ServerHistory.canonicalAddress(value.contains("://") ? value : "http://" + value),
              let address = try? ServerAddress(canonical) else { return false }
        return contains(address)
    }
    static func onLocalSubnet(_ host: String) -> Bool {
        var target = in_addr()
        guard inet_pton(AF_INET,host,&target)==1 else {return false}
        var list:UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list)==0 else {return false};defer {freeifaddrs(list)}
        var cursor=list
        while let interface=cursor?.pointee {
            defer {cursor=interface.ifa_next}
            guard let address=interface.ifa_addr,let mask=interface.ifa_netmask,Int32(address.pointee.sa_family)==AF_INET,interface.ifa_flags & UInt32(IFF_UP) != 0,interface.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else {continue}
            let ip=UnsafeRawPointer(address).assumingMemoryBound(to:sockaddr_in.self).pointee.sin_addr.s_addr
            let subnet=UnsafeRawPointer(mask).assumingMemoryBound(to:sockaddr_in.self).pointee.sin_addr.s_addr
            if ip & subnet == target.s_addr & subnet {return true}
        }
        return false
    }
}
/// TestFlight builds set TIGEREST_DISTRIBUTION=testflight; GitHub IPAs and Apple TV keep the default.
enum Distribution {
    static let testFlight = Bundle.main.object(forInfoDictionaryKey:"TigerestDistribution") as? String == "testflight"
}
