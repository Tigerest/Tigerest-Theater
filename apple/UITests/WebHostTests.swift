import XCTest
import UIKit
final class WebHostTests: XCTestCase {
    @MainActor private func makeApplication() -> XCUIApplication {
        let app = XCUIApplication()
        // Opt-in workaround for device XCTest sessions that never receive the
        // animation-idle notification. This changes the runner's wait only;
        // app animations and all explicit UI/playback assertions remain active.
        if ProcessInfo.processInfo.environment["TIGEREST_UI_SKIP_ANIMATION_IDLE_WAIT"] == "1" {
            let setter = NSSelectorFromString("setIdleAnimationWaitEnabled:")
            precondition(app.responds(to: setter), "This XCTest runtime cannot configure animation-idle waiting")
            app.setValue(false, forKey: "idleAnimationWaitEnabled")
        }
        return app
    }
    @MainActor private var fixtureURL: String {
        ProcessInfo.processInfo.environment["TIGEREST_FIXTURE_URL"] ?? "http://127.0.0.1:18768/sub/"
    }
    @MainActor func testServerSelectionPreservesOldPageUntilHTMLLoadsAndClearsHistoryOnSuccess() {
        continueAfterFailure = false
        let base = URL(string: fixtureURL)!.deletingLastPathComponent().absoluteString
        let original = base + "selection-old"
        let app = makeApplication()
        app.launchArguments = ["--ui-testing", "-TigerestPlaybackGesturesSeen", "YES"]
        app.launch()
        func enter(_ url: String) {
            let field = app.textFields["服务器地址"]
            XCTAssertTrue(field.waitForExistence(timeout: 5))
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            let current = field.value as? String ?? ""
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current == "服务器地址" ? 0 : current.count) + url)
        }
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap(); enter(original)
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["事务页面 selection-old 就绪"].waitForExistence(timeout: 15))
        let identity = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '页面身份 '")).firstMatch.label
        for failedServer in ["selection-denied", "selection-disconnected", "selection-delayed"] {
            app.webViews.buttons["切换服务器"].tap()
            XCTAssertTrue(app.buttons["取消"].waitForExistence(timeout: 5))
            Thread.sleep(forTimeInterval: 0.8) // Wait for the sheet to settle before tapping.
            app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
            XCTAssertTrue(app.textFields["服务器地址"].waitForExistence(timeout: 5))
            XCTAssertTrue((app.textFields["服务器地址"].value as? String)?.contains("selection-old") == true)
            enter(base + failedServer); app.buttons["连接服务器"].tap()
            if failedServer == "selection-delayed" {
                Thread.sleep(forTimeInterval: 1)
            } else {
                XCTAssertTrue(app.staticTexts["连接错误"].waitForExistence(timeout: 15), "HTML failure must return to the chooser")
            }
            app.buttons["取消"].tap()
            XCTAssertTrue(app.webViews.staticTexts[identity].waitForExistence(timeout: 5), "Cancel/failure must preserve the original document")
            XCTAssertEqual(app.webViews.textFields["原页未保存文本"].value as? String, "保留原页状态")
            app.webViews.buttons["检查保存地址和会话"].tap()
            let saved = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '保存地址 '")).firstMatch
            XCTAssertTrue(saved.waitForExistence(timeout: 5))
            XCTAssertTrue(saved.label.contains(original) && saved.label.contains("模式 custom") && saved.label.contains("会话 original-session") && saved.label.contains("缓存 150") && saved.label.contains("历史 selection-old"))
        }
        app.webViews.buttons["检查非法切服目标"].tap()
        XCTAssertTrue(app.staticTexts["非法目标和模式已拒绝"].waitForExistence(timeout: 5))
        app.webViews.buttons["切换服务器"].tap()
        XCTAssertTrue(app.buttons["取消"].waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 0.8)
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap(); enter(base + "selection-denied")
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["连接错误"].waitForExistence(timeout: 15))
        enter(base + "selection-new"); app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["事务页面 selection-new 就绪"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.webViews.staticTexts[identity].exists)
        app.webViews.buttons["检查新页历史"].tap()
        XCTAssertTrue(app.staticTexts["新页历史与保存地址通过"].waitForExistence(timeout: 5))
    }
    @MainActor func testRememberedServersConnectEditRemoveAndReturn() {
        continueAfterFailure = false
        let base = URL(string: fixtureURL)!.deletingLastPathComponent().absoluteString
        let app = makeApplication(); app.launchArguments = ["--ui-testing", "-TigerestPlaybackGesturesSeen", "YES"]; app.launch()
        func enter(_ suffix: String) {
            let field = app.textFields["服务器地址"]
            XCTAssertTrue(field.waitForExistence(timeout: 5)); field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
            let old = field.value as? String ?? ""
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old == "服务器地址" ? 0 : old.count) + base + suffix)
            XCTAssertEqual(field.value as? String, base + suffix)
            app.buttons["连接服务器"].tap()
        }
        func chooser() {
            Thread.sleep(forTimeInterval: 0.8) // Let the previous sheet finish dismissing.
            app.webViews.buttons["切换服务器"].tap()
            XCTAssertTrue(app.staticTexts["已连接的服务器"].waitForExistence(timeout: 5))
        }
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap(); enter("selection-old")
        XCTAssertTrue(app.staticTexts["事务页面 selection-old 就绪"].waitForExistence(timeout: 15))
        chooser()
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap(); enter("selection-new")
        XCTAssertTrue(app.staticTexts["事务页面 selection-new 就绪"].waitForExistence(timeout: 15))
        chooser()
        let oldKey = "custom:" + base + "selection-old/"
        let newKey = "custom:" + base + "selection-new/"
        XCTAssertTrue(app.buttons["server.connect." + oldKey].exists)
        XCTAssertFalse(app.buttons["server.remove." + newKey].exists)
        app.buttons["server.connect." + oldKey].tap()
        XCTAssertTrue(app.staticTexts["事务页面 selection-old 就绪"].waitForExistence(timeout: 15))
        chooser()
        app.buttons["server.edit." + newKey].tap(); enter("selection-edited")
        XCTAssertTrue(app.staticTexts["事务页面 selection-edited 就绪"].waitForExistence(timeout: 15))
        chooser()
        XCTAssertFalse(app.buttons["server.connect." + newKey].exists)
        app.buttons["server.remove." + oldKey].tap()
        XCTAssertTrue(app.buttons["确认移除"].waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 0.8) // External audit disables idle waits; let the popover reach its final position.
        app.buttons["确认移除"].tap()
        XCTAssertTrue(app.buttons["server.connect." + oldKey].waitForNonExistence(timeout: 5))
        app.buttons["取消"].tap()
        XCTAssertTrue(app.staticTexts["事务页面 selection-edited 就绪"].waitForExistence(timeout: 5))
        app.terminate(); app.launchArguments.append("--ui-testing-keep-profile"); app.launch()
        XCTAssertTrue(app.staticTexts["事务页面 selection-edited 就绪"].waitForExistence(timeout: 15))
        chooser()
        XCTAssertTrue(app.buttons["server.connect.custom:" + base + "selection-edited/"].exists)
        XCTAssertFalse(app.buttons["server.connect." + oldKey].exists)
        app.buttons["管理配置档"].tap()
        let name = app.textFields["名称"]; XCTAssertTrue(name.waitForExistence(timeout: 5)); name.tap(); name.typeText("History isolation")
        app.buttons["创建"].tap()
        XCTAssertTrue(app.buttons["连接自建 Emby / Jellyfin 服务器"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["已连接的服务器"].exists)
        app.buttons["管理配置档"].tap()
        XCTAssertTrue(app.buttons["默认配置"].waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 0.8)
        app.buttons["默认配置"].tap()
        XCTAssertTrue(app.staticTexts["事务页面 selection-edited 就绪"].waitForExistence(timeout: 15))
        chooser()
        XCTAssertTrue(app.buttons["server.connect.custom:" + base + "selection-edited/"].exists)
        app.buttons["取消"].tap()
    }

    @MainActor func testProfileStartupSurvivesOldChooserDismissal() throws {
        guard ProcessInfo.processInfo.environment["TIGEREST_TEST_PRESET_URL"] != nil else {
            throw XCTSkip("Build the isolated validation app with a fixture-only server_defaults.json")
        }
        continueAfterFailure = false
        let base = URL(string: fixtureURL)!.deletingLastPathComponent().absoluteString
        let app = makeApplication(); app.launchArguments = ["--ui-testing"]; app.launch()
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        let address = app.textFields["服务器地址"]; address.tap(); address.typeText(base + "selection-old")
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["事务页面 selection-old 就绪"].waitForExistence(timeout: 15))
        app.webViews.buttons["设置专属启动测试"].tap()
        XCTAssertTrue(app.staticTexts["专属启动设置就绪"].waitForExistence(timeout: 5))
        app.webViews.buttons["切换服务器"].tap()
        XCTAssertTrue(app.buttons["管理配置档"].waitForExistence(timeout: 5)); Thread.sleep(forTimeInterval: 0.8)
        app.buttons["管理配置档"].tap()
        let name = app.textFields["名称"]; XCTAssertTrue(name.waitForExistence(timeout: 5)); Thread.sleep(forTimeInterval: 0.8)
        name.tap(); name.typeText("Startup isolation"); app.buttons["创建"].tap()
        XCTAssertTrue(app.buttons["连接自建 Emby / Jellyfin 服务器"].waitForExistence(timeout: 5)); Thread.sleep(forTimeInterval: 0.8)
        app.buttons["管理配置档"].tap()
        XCTAssertTrue(app.buttons["默认配置"].waitForExistence(timeout: 5)); Thread.sleep(forTimeInterval: 0.8)
        app.buttons["默认配置"].tap()
        XCTAssertTrue(app.staticTexts["事务页面 selection-delayed 就绪"].waitForExistence(timeout: 25), "Dismissing the old profile chooser must not cancel the selected profile's dedicated startup")
    }

    @MainActor func testSPAPageHideAndRealDocumentReplacementKeepBridgeLifecycleCorrect() {
        let app = makeApplication()
        app.launchArguments = ["--ui-testing", "-TigerestPlaybackGesturesSeen", "YES"]
        app.launch()
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        let field = app.textFields["服务器地址"]
        field.tap(); field.typeText(fixtureURL)
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["桥接校验通过"].waitForExistence(timeout: 20))
        app.buttons["验证文档生命周期"].tap()
        let result = app.staticTexts.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "文档关闭清理及新页桥接通过", "生命周期失败")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(result.label, "文档关闭清理及新页桥接通过")
    }

    @MainActor func testOnboardingAndOfflineEntryAreAvailableWithoutNetwork() {
        let app = makeApplication()
        app.launchArguments = ["--ui-testing", "-TigerestPlaybackGesturesSeen", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["连接大河李斯特专属 EMBY 服务器"].waitForExistence(timeout:10))
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        XCTAssertTrue(app.textFields["服务器地址"].waitForExistence(timeout: 10))
        app.buttons["离线媒体"].tap()
        XCTAssertTrue(app.staticTexts["尚无离线媒体"].waitForExistence(timeout: 5))
    }
}
extension WebHostTests {
    @MainActor func testVolumeAndMuteSurvivePlayerReplacement() {
        let app = makeApplication(); app.launchArguments = ["--ui-testing", "-TigerestPlaybackGesturesSeen", "YES"]; app.launch()
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        let field = app.textFields["服务器地址"]; field.tap(); field.typeText(fixtureURL)
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["桥接校验通过"].waitForExistence(timeout: 20))
        app.buttons["验证音量保留"].tap()
        let result = app.staticTexts.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "音量保留校验通过", "音量保留失败")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 15))
        XCTAssertEqual(result.label, "音量保留校验通过")
    }

    @MainActor func testBootstrapNamesTheBuildAndTheDevice() {
        let app = makeApplication(); app.launchArguments = ["--ui-testing", "-TigerestPlaybackGesturesSeen", "YES"]; app.launch()
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        let field = app.textFields["服务器地址"]; field.tap(); field.typeText(fixtureURL)
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["桥接校验通过"].waitForExistence(timeout: 20))
        app.buttons["验证构建号"].tap()
        let result = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "构建号校验通过", "构建号失败")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 10))
        let device = UIDevice.current.userInterfaceIdiom == .phone ? "iOS" : "iPadOS"
        XCTAssertTrue(result.label.hasPrefix("构建号校验通过 ") && result.label.hasSuffix(" " + device), result.label)
    }

    @MainActor func testControlledBridgePlaybackAndDownload() {
        let app=makeApplication();app.launchArguments=["--ui-testing", "-TigerestPlaybackGesturesSeen", "YES"];app.launch()
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        let field=app.textFields["服务器地址"]
        XCTAssertTrue(field.waitForExistence(timeout:10));field.tap();field.typeText(fixtureURL)
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["桥接校验通过"].waitForExistence(timeout:20),app.debugDescription)
        XCTAssertFalse(app.buttons["服务器"].exists)
        XCTAssertFalse(app.buttons["配置"].exists)
        XCTAssertFalse(app.buttons["重新载入"].exists)
        app.buttons["验证播放循环"].tap()
        let playbackResult = app.staticTexts.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "20 次播放和定位通过", "播放失败")).firstMatch
        XCTAssertTrue(playbackResult.waitForExistence(timeout:150))
        XCTAssertEqual(playbackResult.label, "20 次播放和定位通过")
        app.buttons["验证离线下载"].tap()
        XCTAssertTrue(app.staticTexts["下载完成并校验通过"].waitForExistence(timeout:40),app.debugDescription)
        app.buttons["打开离线媒体"].tap()
        XCTAssertTrue(app.staticTexts["离线夹具"].waitForExistence(timeout:5))
    }
}

extension WebHostTests {
    @MainActor func testQueueSelectionUsesWebPlaylistId() {
        let app = openQueueFixture()
        XCTAssertTrue(app.staticTexts["第一项"].waitForExistence(timeout: 10))
        app.buttons["下一集"].tap()
        XCTAssertTrue(app.staticTexts["重复媒体第二项"].waitForExistence(timeout: 10), "换集须通过共享 inputPlugin 真正加载另一播放列表项")
        app.buttons["上一集"].tap()
        XCTAssertTrue(app.staticTexts["第一项"].waitForExistence(timeout: 10))
        app.buttons["选集"].tap()
        XCTAssertTrue(app.buttons["S01E01 · 第一项"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["S01E02 · 重复媒体第二项"].exists)
        app.buttons["S02E03 · 跨季第三项"].tap()
        XCTAssertTrue(app.staticTexts["跨季第三项"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["下一集"].isEnabled, "末项不能继续向后跳转")
        app.buttons["上一集"].tap()
        XCTAssertTrue(app.staticTexts["重复媒体第二项"].waitForExistence(timeout: 10))
        app.buttons["上一集"].tap()
        XCTAssertTrue(app.staticTexts["第一项"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["上一集"].isEnabled, "首项不能继续向前跳转")
    }

    @MainActor func testEpisodeMenuWorksDuringPlayback() {
        let app = openQueueFixture()
        XCTAssertTrue(app.staticTexts["第一项"].waitForExistence(timeout: 10))
        app.buttons["播放"].tap()
        app.buttons["选集"].tap()
        let episode = app.buttons["S01E02 · 重复媒体第二项"]
        XCTAssertTrue(episode.waitForExistence(timeout: 2))
        // Deliberately keep choosing beyond the OSD's 3.5-second hide deadline.
        Thread.sleep(forTimeInterval: 4)
        XCTAssertTrue(episode.exists, "选择期间不能被控制栏自动隐藏收掉")
        XCTAssertFalse(statusBarContent.exists, "选集浮层也不能露出系统顶栏")
        episode.tap()
        XCTAssertTrue(app.staticTexts["重复媒体第二项"].waitForExistence(timeout: 10))
    }

    @MainActor func testPlaybackHidesStatusBarUntilExit() {
        let app = openQueueFixture()
        XCTAssertTrue(app.staticTexts["第一项"].waitForExistence(timeout: 10))
        XCTAssertTrue(statusBarContent.waitForNonExistence(timeout: 5), "暂停及 OSD 显示时也应隐藏系统顶栏")
        app.buttons["播放"].tap()
        XCTAssertTrue(statusBarContent.waitForNonExistence(timeout: 5))
        app.buttons["退出播放"].tap()
        XCTAssertTrue(statusBarContent.waitForExistence(timeout: 5), "退出播放器后应恢复系统顶栏")
    }

    // iPadOS retains empty status-bar containers in SpringBoard even when hidden.
    // Assert its actual clock/battery content rather than the container's existence.
    @MainActor private var statusBarContent: XCUIElement {
        XCUIApplication(bundleIdentifier: "com.apple.springboard").statusBars
            .descendants(matching: .any).matching(NSPredicate(format: "label != ''")).firstMatch
    }

    @MainActor private func openQueueFixture() -> XCUIApplication {
        continueAfterFailure = false
        let app = makeApplication(); app.launchArguments = ["--ui-testing", "-TigerestPlaybackGesturesSeen", "YES"]; app.launch()
        XCTAssertTrue(statusBarContent.waitForExistence(timeout: 5))
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        let field = app.textFields["服务器地址"]; field.tap(); field.typeText(fixtureURL)
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["桥接校验通过"].waitForExistence(timeout: 20))
        app.buttons["验证选集"].tap()
        return app
    }

    @MainActor func testSubtitleSettingsReachPlayerAndReset() {
        let app = makeApplication(); app.launchArguments = ["--ui-testing", "-TigerestPlaybackGesturesSeen", "YES"]; app.launch()
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        let field = app.textFields["服务器地址"]; field.tap(); field.typeText(fixtureURL)
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["桥接校验通过"].waitForExistence(timeout: 20))
        app.buttons["验证字幕设置"].tap()
        let result = app.staticTexts.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "字幕设置校验通过", "字幕设置失败")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 15))
        XCTAssertEqual(result.label, "字幕设置校验通过")
    }
}


extension WebHostTests {
    @MainActor private func openGestureFixture() -> XCUIApplication {
        let app = makeApplication(); app.launchArguments = ["--ui-testing", "-TigerestPlaybackGesturesSeen", "YES"]; app.launch()
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        let field = app.textFields["服务器地址"]; field.tap(); field.typeText(fixtureURL)
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["桥接校验通过"].waitForExistence(timeout: 20))
        app.buttons["验证播放手势"].tap()
        XCTAssertTrue(app.buttons["锁定"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["playbackTime"].wait(for: \.label, toEqual: "0:00 / 0:12", timeout: 3))
        return app
    }
    @MainActor func testTouchLockRequiresLongPressToUnlock() {
        let app = openGestureFixture()
        app.buttons["锁定"].tap()
        let unlock = app.buttons["长按解除防误触锁"]
        XCTAssertTrue(unlock.waitForExistence(timeout: 2), app.debugDescription)
        unlock.tap()
        XCTAssertTrue(unlock.exists, "短按不能解除防误触锁")
        let video = app.otherElements["playerVideo"]
        video.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).doubleTap()
        video.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.3)).press(forDuration: 0.1, thenDragTo: video.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.3)))
        XCTAssertTrue(unlock.waitForNonExistence(timeout: 5), "锁定提示应自动隐藏，即使暂停也不能永久遮挡")
        video.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        XCTAssertTrue(unlock.waitForExistence(timeout: 2), "锁定时轻点画面应唤回解锁按钮")
        unlock.press(forDuration: 0.8)
        XCTAssertTrue(app.buttons["锁定"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.staticTexts["playbackTime"].label, "0:00 / 0:12")
    }
    @MainActor func testHorizontalSeekAndBrightnessGestureFeedback() {
        let app = openGestureFixture()
        let video = app.otherElements["playerVideo"]
        XCTAssertTrue(video.exists)
        let start = video.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.32))
        let end = video.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.32))
        start.press(forDuration: 0.1, thenDragTo: end)
        let position = app.staticTexts["playbackTime"]
        XCTAssertTrue(position.wait(for: \.label, toEqual: "0:02 / 0:12", timeout: 3) || position.label == "0:03 / 0:12", position.label)
        // Start above the transport row: on a portrait phone it sits near 40% of the height.
        let brightStart = video.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.3))
        brightStart.press(forDuration: 0.1, thenDragTo: video.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.1)))
        XCTAssertTrue(app.staticTexts["playerGestureFeedback"].label.hasPrefix("亮度"))
        app.buttons["退出播放"].tap()
        XCTAssertTrue(app.buttons["验证播放手势"].exists)
    }
    @MainActor func testStationaryHoldRestoresPlaybackSpeed() {
        let app = openGestureFixture()
        app.buttons["播放"].tap()
        let video = app.otherElements["playerVideo"]
        video.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.32)).press(forDuration: 0.9)
        app.buttons["退出播放"].tap()
        XCTAssertTrue(app.staticTexts["长按倍速及恢复通过"].waitForExistence(timeout: 4))
    }
}

extension WebHostTests {
    @MainActor func testVideoTapAndDoubleTapControlPlayback() {
        let app = openGestureFixture()
        let point = app.otherElements["playerVideo"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        point.doubleTap()
        XCTAssertTrue(app.buttons["暂停"].waitForExistence(timeout: 2))
        point.doubleTap()
        XCTAssertTrue(app.buttons["播放"].waitForExistence(timeout: 2))
        point.tap()
        XCTAssertTrue(app.buttons["锁定"].waitForNonExistence(timeout: 2))
        point.tap()
        XCTAssertTrue(app.buttons["锁定"].waitForExistence(timeout: 2))
    }
}

extension WebHostTests {
    @MainActor func testBundledArtSettingsDanmakuAndReturnTransition() {
        let app = makeApplication(); app.launchArguments = ["--ui-testing", "-TigerestPlaybackGesturesSeen", "YES"]; app.launch()
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        let field = app.textFields["服务器地址"]; field.tap(); field.typeText(fixtureURL)
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["桥接校验通过"].waitForExistence(timeout: 20))
        for (button, result) in [("验证首页资源", "四张首页图片加载通过"), ("验证主设置画质", "主设置画质校验通过"), ("验证返回转场", "返回转场全分辨率与清理通过")] {
            app.buttons[button].tap()
            XCTAssertTrue(app.staticTexts[result].waitForExistence(timeout: 15), app.debugDescription)
        }
        app.buttons["验证弹幕"].tap()
        XCTAssertTrue(app.staticTexts["danmakuStatus"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["danmakuStatus"].wait(for: \.label, toEqual: "已载入 3 条弹幕", timeout: 15), app.debugDescription)
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "danmaku-rendered"; screenshot.lifetime = .keepAlways; add(screenshot)
        XCTAssertFalse(app.buttons["画质"].exists)
        app.buttons["退出播放"].tap()
        XCTAssertTrue(app.staticTexts["弹幕匹配开关与偏移通过"].waitForExistence(timeout: 10), app.debugDescription)
    }
}

extension WebHostTests {
    @MainActor func testSpacePausesAfterOSDAutoHideWithoutReloading() {
        let app=makeApplication();app.launchArguments=["--ui-testing","-TigerestPlaybackGesturesSeen","YES"];app.launch()
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        let field=app.textFields["服务器地址"];field.tap();field.typeText(fixtureURL)
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["桥接校验通过"].waitForExistence(timeout:20))
        app.buttons["验证实体键盘"].tap()
        XCTAssertTrue(app.buttons["暂停"].waitForExistence(timeout:8))
        XCTAssertTrue(app.buttons["暂停"].waitForNonExistence(timeout:6))
        app.typeKey(" ",modifierFlags:[])
        XCTAssertTrue(app.buttons["播放"].waitForExistence(timeout:2), "隐藏 OSD 后空格必须暂停")
        let position=app.staticTexts["playbackTime"].label
        XCTAssertFalse(position.hasPrefix("0:00 "));XCTAssertFalse(position.hasPrefix("0:02 "))
        app.buttons["弹幕"].tap()
        let search=app.textFields["搜索作品"];XCTAssertTrue(search.waitForExistence(timeout:3));search.tap();search.typeText("Blue Box")
        XCTAssertEqual(search.value as? String,"Blue Box","搜索框内空格必须作为文本输入")
        app.buttons["完成"].tap()
        XCTAssertTrue(app.buttons["播放"].waitForExistence(timeout:3))
        app.buttons["锁定"].tap()
        app.typeKey(" ",modifierFlags:[])
        let unlock=app.buttons["长按解除防误触锁"]
        XCTAssertTrue(unlock.waitForExistence(timeout:2));unlock.press(forDuration:0.8)
        XCTAssertTrue(app.buttons["播放"].waitForExistence(timeout:2),"锁定状态的空格不能改变播放")
        app.typeKey(" ",modifierFlags:[])
        XCTAssertTrue(app.buttons["暂停"].waitForExistence(timeout:2))
        app.buttons["退出播放"].tap()
        XCTAssertTrue(app.staticTexts["键盘播放次数 1"].waitForExistence(timeout:3), "空格不可穿透重新载入底层网页的剧集")
    }
}

extension WebHostTests {
    /// Real read-only GitHub check through WKWebView -> native bridge -> HTTP.
    @MainActor func testIPadUpdateEntryShowsPlatformStatusWithoutInstaller() {
        let app=makeApplication();app.launchArguments=["--ui-testing","-TigerestPlaybackGesturesSeen","YES"];app.launch()
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        let field=app.textFields["服务器地址"];field.tap();field.typeText(fixtureURL)
        app.buttons["连接服务器"].tap()
        XCTAssertTrue(app.staticTexts["桥接校验通过"].waitForExistence(timeout:20))
        let entry=app.descendants(matching:.any).matching(NSPredicate(format:"label == %@ OR label BEGINSWITH %@","客户端更新","客户端有新版本")).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout:5),app.debugDescription);entry.tap()
        let result=app.staticTexts.matching(NSPredicate(format:"label == %@ OR label == %@ OR label == %@","iPad / iPhone 版本发布情况","发现新版本","检查完成")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout:35),app.debugDescription)
        XCTAssertTrue(app.buttons["查看发布说明"].exists)
        XCTAssertFalse(app.buttons["立即更新"].exists);XCTAssertFalse(app.buttons["安装更新"].exists)
        let capture=XCTAttachment(screenshot:app.screenshot());capture.name="ipad-update-status";capture.lifetime = .keepAlways;add(capture)
        app.buttons["关闭"].tap()
    }
}


extension WebHostTests {
    /// Opt-in integration coverage using an isolated instance or a dedicated
    /// remote test account; credentials are injected by the test runner.
    @MainActor func testIsolatedJellyfinLoginAndNativePlayback() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["TIGEREST_JELLYFIN_URL"],
              let username = env["TIGEREST_JELLYFIN_USER"],
              let password = env["TIGEREST_JELLYFIN_PASSWORD"] else {
            throw XCTSkip("An isolated Jellyfin server and test account are required")
        }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let app = makeApplication()
        app.launchArguments = ["--ui-testing", "-TigerestPlaybackGesturesSeen", "YES"]
        app.launch()
        app.buttons["连接自建 Emby / Jellyfin 服务器"].tap()
        let server = app.textFields["服务器地址"]
        server.tap(); server.typeText(url)
        app.buttons["连接服务器"].tap()
        let user = app.webViews.textFields.firstMatch
        let manualLogin = app.webViews.buttons.matching(NSPredicate(format: "label == '手动登录' OR label == 'Manual Login' OR label == 'Manual login'")).firstMatch
        let loginReady = expectation(for: NSPredicate { _, _ in user.exists || manualLogin.exists }, evaluatedWith: nil)
        wait(for: [loginReady], timeout: 45)
        if !user.exists {
            // Device audits disable XCTest animation-idle waiting. The manual
            // button appears before its login page finishes sliding into place.
            Thread.sleep(forTimeInterval: 3)
            if !user.exists { manualLogin.tap() }
        }
        XCTAssertTrue(user.waitForExistence(timeout: 30))
        Thread.sleep(forTimeInterval: 3) // Allow the web login document to finish replacing its form.
        user.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)
        user.typeText(username)
        let secret = app.webViews.secureTextFields.firstMatch
        XCTAssertTrue(secret.exists)
        secret.tap(); secret.typeText(password + "\n")
        // Return submits the real web form once. A second tap while its
        // network login is pending can start another authentication request.
        if let libraryName = env["TIGEREST_JELLYFIN_TEST_LIBRARY_NAME"] {
            let library = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", libraryName)).firstMatch
            XCTAssertTrue(library.waitForExistence(timeout: 90))
            // Animation idle waiting is disabled only in the physical-device
            // harness; let the entrance settle before targeting a library.
            Thread.sleep(forTimeInterval: 3)
            library.tap()
        }
        let itemTitle = env["TIGEREST_JELLYFIN_TEST_ITEM_TITLE"] ?? "同名验收作品"
        let hero = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS %@", itemTitle)).firstMatch
        XCTAssertTrue(hero.waitForExistence(timeout: 90), app.debugDescription)
        // An optional inspector on the isolated server measures the real WK
        // DOM and exercises visible navigation while XCTest rotates the device.
        if env["TIGEREST_WEB_LAYOUT_AUDIT"] == "1" {
            defer { XCUIDevice.shared.orientation = .portrait }
            for (orientation, marker) in [(UIDeviceOrientation.portrait, "layout-portrait-passed"), (.landscapeLeft, "layout-landscape-passed")] {
                XCUIDevice.shared.orientation = orientation
                XCTAssertTrue(app.staticTexts[marker].waitForExistence(timeout: 240), app.debugDescription)
                let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = marker; shot.lifetime = .keepAlways; add(shot)
            }
            // The navigation matrix changes the gallery selection. Its caller
            // can run native playback independently with a known media target.
            if env["TIGEREST_WEB_LAYOUT_AUDIT_ONLY"] == "1" { return }
        }
        Thread.sleep(forTimeInterval: 1) // Capture the settled entrance rather than an intermediate animation frame.
        let home = XCTAttachment(screenshot: app.screenshot()); home.name = "isolated-jellyfin-home"; home.lifetime = .keepAlways; add(home)
        XCTAssertTrue(hero.waitForExistence(timeout: 15), app.debugDescription)
        // Touching a small, unselected cover previews it first. The hero then
        // acquires that title and becomes the first matching button.
        let selectingCover = hero.frame.height < app.frame.height * 0.3
        let play = app.webViews.buttons.matching(NSPredicate(format: "label == 'Play' OR label == '播放' OR label == 'Resume' OR label == '继续播放'")).firstMatch
        hero.tap()
        if selectingCover {
            // Library cards open details directly; home rail cards preview the hero.
            let previewReady = expectation(for: NSPredicate { _, _ in play.exists || (hero.exists && hero.frame.height >= app.frame.height * 0.3) }, evaluatedWith: nil)
            wait(for: [previewReady], timeout: 10)
            if !play.exists { hero.tap() }
        }
        XCTAssertTrue(play.waitForExistence(timeout: 15), app.debugDescription)
        play.tap()
        let clock = app.staticTexts["playbackTime"]
        XCTAssertTrue(clock.waitForExistence(timeout: 20), app.debugDescription)
        func seconds() -> Int {
            let parts = clock.label.components(separatedBy: " / ")[0].split(separator: ":").compactMap { Int($0) }
            return parts.reduce(0) { $0 * 60 + $1 }
        }
        let video = app.otherElements["playerVideo"]
        func pausePlayback() {
            let pause = app.buttons["pause.fill"]
            if !pause.isHittable { video.tap() }
            XCTAssertTrue(pause.waitForExistence(timeout: 3))
            pause.tap()
            XCTAssertTrue(app.buttons["play.fill"].waitForExistence(timeout: 5))
        }
        pausePlayback()
        let first = seconds()
        app.buttons["play.fill"].tap()
        Thread.sleep(forTimeInterval: 4)
        pausePlayback()
        let paused = seconds()
        XCTAssertGreaterThanOrEqual(paused, first + 2)
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertLessThanOrEqual(abs(seconds() - paused), 1)
        if env["TIGEREST_JELLYFIN_TEST_ITEM_TITLE"] != nil {
            app.buttons["goforward.10"].tap()
            let sought = NSPredicate { _, _ in seconds() >= paused + 9 }
            let seek = expectation(for: sought, evaluatedWith: nil)
            wait(for: [seek], timeout: 15)
        }
        let frame = XCTAttachment(screenshot: app.screenshot()); frame.name = "isolated-jellyfin-native-frame"; frame.lifetime = .keepAlways; add(frame)
        app.buttons["退出播放"].tap()
        XCTAssertTrue(play.waitForExistence(timeout: 10))
    }
}
