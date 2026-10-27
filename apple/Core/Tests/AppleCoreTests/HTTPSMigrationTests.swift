import Foundation
import Testing
@testable import AppleCore

// 2.9.5: the dedicated server's public services are HTTPS; the old public HTTP
// addresses are rewritten and never contacted. The LAN addresses stay HTTP.
@Test func serviceOriginsFollowTheEmbyAddress() {
    #expect(TigerestService.origin(forEmby: "http://192.168.5.150:8095/") == "http://192.168.5.150:18443")
    #expect(TigerestService.origin(forEmby: "https://nas.tigerest.top:18445/") == "https://nas.tigerest.top:18446")
    #expect(TigerestService.origin(forEmby: "https://emby.example/") == "https://nas.tigerest.top:18446")
    #expect(ReleaseFeed.productionURL.absoluteString == "https://nas.tigerest.top:18446/api/tigerest/v1/app/releases")
}
@Test func onlyTheOldPublicEmbyAddressMoves() {
    for saved in ["http://nas.tigerest.top:8095/", "http://NAS.tigerest.top:8095", " http://nas.tigerest.top:8095/ "] {
        #expect(TigerestService.movedEmby(saved) == "https://nas.tigerest.top:18445/", "\(saved)")
    }
    for kept in ["https://nas.tigerest.top:18445/", "http://192.168.5.150:8095/", "https://nas.tigerest.top:8095/",
                 "http://nas.tigerest.top:8096/", "http://nas.tigerest.top:8095/emby/", "http://other.example:8095/", ""] {
        #expect(TigerestService.movedEmby(kept) == nil, "\(kept)")
    }
}
@Test func savedDedicatedTVSessionMovesWithItsSignIn() throws {
    let old = EmbySession(serverURL: "http://nas.tigerest.top:8095/", userID: "u", accessToken: "token", deviceID: "tv", serverID: "id", serverKind: .emby, serverVersion: "4.9")
    var state = ServerSessionHistory()
    try state.commit(old, mode: "tigerest", at: 1)
    let moved = state.moveDedicated()
    #expect(moved)
    #expect(state.current?.serverURL == "https://nas.tigerest.top:18445/")
    #expect(state.current?.accessToken == "token" && state.current?.serverID == "id" && state.current?.deviceID == "tv")
    #expect(state.cached(key: "tigerest")?.serverURL == "https://nas.tigerest.top:18445/")
    #expect(state.currentKey == "tigerest")
    let again = state.moveDedicated()
    #expect(!again, "a moved session stays put")

    // A self-hosted record keeps its address, as on the desktop and Android.
    var custom = ServerSessionHistory()
    try custom.commit(old, mode: "custom", at: 1)
    let customMoved = custom.moveDedicated()
    #expect(!customMoved)
    #expect(custom.current?.serverURL == "http://nas.tigerest.top:8095/")
}
@Test func danmakuMovesOffTheRetiredAddressAndOnlyOurServiceLearnsTheClient() {
    #expect(DanmakuProvider.parse("http://nas.tigerest.top:18443", embyHost: "nas.tigerest.top").map(\.url) == ["https://nas.tigerest.top:18446"])
    #expect(DanmakuProvider.parse("", embyHost: "nas.tigerest.top").map(\.url) == ["https://nas.tigerest.top:18446"])
    #expect(DanmakuProvider.parse("http://nas.tigerest.top:18443/", embyHost: "192.168.5.150").map(\.url) == ["http://192.168.5.150:18443"])
    #expect(DanmakuProvider.own("https://nas.tigerest.top:18446") && DanmakuProvider.own("http://192.168.5.150:18443/"))
    for other in ["http://nas.tigerest.top:18443", "https://danmaku-api.152468.xyz", "https://custom.example/api", "https://nas.tigerest.top:18445"] {
        #expect(!DanmakuProvider.own(other), "\(other)")
    }
}

@Test func fullVersionComesFromTheFixReleaseKeyOnlyWhenItExtendsTheShortVersion() {
    #expect(AppVersion.full(["CFBundleShortVersionString": "2.9.5"]) == "2.9.5")
    #expect(AppVersion.full(["CFBundleShortVersionString": "2.9.5", "TigerestVersion": "2.9.5.1"]) == "2.9.5.1")
    #expect(AppVersion.full(["CFBundleShortVersionString": "2.9.5", "TigerestVersion": "2.9.5.12"]) == "2.9.5.12")
    for bad in ["2.9.6.1", "2.9.5", "2.9.5.0", "2.9.5.100", "2.9.5.01", "2.9.5.1.1", "2.9.5.x"] {
        #expect(AppVersion.full(["CFBundleShortVersionString": "2.9.5", "TigerestVersion": bad]) == "2.9.5", "\(bad)")
    }
    #expect(AppVersion.full(nil) == "unknown")
}
@Test func buildNumberNamesTheBuildAndCommit() {
    #expect(AppVersion.buildNumber(["CFBundleVersion": "295"], revision: "56541590208f2987cb533b8e9a5d266fae2421c5") == "295 · 56541590")
    #expect(AppVersion.buildNumber(["CFBundleVersion": "295"], revision: nil) == "295")
    #expect(AppVersion.buildNumber(["CFBundleVersion": "295"], revision: "not a commit") == "295")
    #expect(AppVersion.buildNumber(nil, revision: "abcdef0123") == "abcdef01")
}

private func universal(_ version: String, package: String = "universal.ipa") -> JSONValue {
    let name = "TigerestTheater-\(version)-\(package)"
    return .object(["tag_name": .string("v" + version), "prerelease": .bool(false), "draft": .bool(false), "body": .string(version), "assets": .array([.object([
        "name": .string(name), "browser_download_url": .string("https://github.com/Tigerest/Tigerest-Theater/releases/download/v\(version)/\(name)"),
        "size": .number(100), "digest": .string("sha256:" + String(repeating: "a", count: 64))])])])
}
// Same cases as the desktop readsFixReleases and Android AppUpdatePolicyTest.readsFixReleases.
@Test func readsFixReleases() {
    func offered(_ releases: [JSONValue], from current: String) -> String? {
        let state = UniversalUpdatePolicy.state(releases: releases, currentVersion: current)
        return state["status"].string == "available" ? state["version"].string : nil
    }
    #expect(offered([universal("2.9.5.1")], from: "2.9.5") == "2.9.5.1")
    #expect(offered([universal("2.9.5.10"), universal("2.9.5.2")], from: "2.9.5") == "2.9.5.10")
    #expect(offered([universal("2.9.5.2")], from: "2.9.5.10") == nil)
    #expect(offered([universal("2.9.6")], from: "2.9.5.3") == "2.9.6")
    #expect(offered([universal("2.9.5")], from: "2.9.5.1") == nil, "2.9.5 is 2.9.5.0")
    #expect(offered([universal("2.9.5.1")], from: "2.9.5.1") == nil)
    // A fix release for another platform only: nothing to offer here.
    #expect(offered([universal("2.9.5.1", package: "android.apk")], from: "2.9.5") == nil)
    #expect(offered([universal("2.9.5.1", package: "android.apk"), universal("2.9.5")], from: "2.9.5") == nil)
    for tag in ["2.9.5.0", "2.9.5.100", "2.9.5.01", "2.9.5.1.1"] {
        #expect(offered([universal(tag)], from: "2.9.5") == nil, "\(tag)")
    }
    #expect(UniversalUpdatePolicy.state(releases: [], currentVersion: "2.9.5.1")["status"].string == "unpublished")
}
