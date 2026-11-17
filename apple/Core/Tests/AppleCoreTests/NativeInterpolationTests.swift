import XCTest
@testable import AppleCore

final class NativeInterpolationTests: XCTestCase {
    func testFilters() {
        XCTAssertNil(NativeInterpolation.filter(mode: "off", target: "2x", displayFps: 120, qualityAvailable: true))
        XCTAssertEqual(NativeInterpolation.filter(mode: "quality", target: "2x", displayFps: 120, qualityAvailable: true),
                       "@tigerest-vtfi:tigerest-vtfi=mode=quality:factor=2")
        XCTAssertEqual(NativeInterpolation.filter(mode: "efficient", target: "60", displayFps: 60, qualityAvailable: true),
                       "@tigerest-vtfi:tigerest-vtfi=mode=efficient:target=60")
        XCTAssertEqual(NativeInterpolation.filter(mode: "quality", target: "display", displayFps: 120, qualityAvailable: true),
                       "@tigerest-vtfi:tigerest-vtfi=mode=quality:target=120")
        // tvOS: the efficient processor takes the quality one's place.
        XCTAssertEqual(NativeInterpolation.filter(mode: "quality", target: "2x", displayFps: 60, qualityAvailable: false),
                       "@tigerest-vtfi:tigerest-vtfi=mode=efficient:factor=2")
        // A 24 Hz television (frame-rate matching) gets twice the source rate.
        XCTAssertEqual(NativeInterpolation.filter(mode: "efficient", target: "display", displayFps: 24, qualityAvailable: false),
                       "@tigerest-vtfi:tigerest-vtfi=mode=efficient:factor=2")
    }

    func testDecoding() {
        XCTAssertEqual(NativeInterpolation.hardwareDecoding("videotoolbox-copy", interpolating: true), "videotoolbox")
        XCTAssertEqual(NativeInterpolation.hardwareDecoding("videotoolbox-copy", interpolating: false), "videotoolbox-copy")
        XCTAssertEqual(NativeInterpolation.hardwareDecoding("no", interpolating: true), "no")
    }

    func testNotices() {
        for status in ["active", "preparing", "warming", "waiting", "target-not-higher", "speed-bypass"] {
            XCTAssertNil(NativeInterpolation.notice(status: status, fellBack: false), status)
        }
        for status in ["unsupported-size", "unsupported-fps", "hdr", "interlaced", "needs-hardware-frames", "unavailable", "too-slow", "failed"] {
            XCTAssertNotNil(NativeInterpolation.notice(status: status, fellBack: false), status)
        }
        XCTAssertNotNil(NativeInterpolation.notice(status: "active", fellBack: true))
        XCTAssertEqual(NativeInterpolation.summary([:]), "未启用")
        XCTAssertTrue(NativeInterpolation.summary(["status": "active", "sourceFps": "23.976", "outputFps": "47.952",
                                                   "processP95Ms": "12.5", "generated": "40", "mode": "efficient"]).hasPrefix("低功耗 23.976 → 47.952"))
    }
}
