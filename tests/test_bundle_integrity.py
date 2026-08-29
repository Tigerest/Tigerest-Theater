#!/usr/bin/env python3
"""Static integrity and credential-safety checks for bundled client assets."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_settings() -> None:
    settings = json.loads(read("resources/settings/settings_description.json"))
    section = next(item for item in settings if item.get("section") == "mpv")
    values = {item["value"]: item for item in section["values"]}
    require(values["configMode"]["default"] == "auto", "MPV must auto-detect an existing user config")
    modes = {item[0] for item in values["configMode"]["possible_values"]}
    require(modes == {"auto", "embedded", "system"}, "MPV config modes are incomplete")
    require(values["configModeMigrated"]["hidden"] is True,
            "legacy embedded-mode profiles need a one-time migration marker")
    require(values["renderBackend"]["default"] == "auto",
            "native GPU-Next must be selected automatically on supported desktop platforms")
    backends = {item[0] for item in values["renderBackend"]["possible_values"]}
    require(backends == {"auto", "gpu-next", "libmpv"},
            "MPV render backend choices are incomplete")
    require(values["enableUosc"]["default"] is True, "uosc must be enabled by default")
    require(values["enableDanmaku"]["default"] is True, "danmaku must be enabled by default")
    advanced = {
        "advancedProfileOverrides", "scale", "cscale", "dscale", "interpolation", "tscale", "deband",
        "debandIterations", "debandThreshold", "debandRange", "debandGrain",
        "sigmoidUpscaling", "correctDownscaling", "scaleAntiring",
        "cscaleAntiring", "targetColorspaceHint", "iccProfileAuto",
        "toneMapping", "gamutMappingMode", "hdrComputePeak", "ditherDepth",
        "blendSubtitles", "audioLanguage",
        "subtitleLanguage", "cachePause", "demuxerMaxBackBytes",
        "screenshotFormat", "screenshotDirectory",
    }
    require(advanced.issubset(values), "advanced MPV settings are incomplete")
    require(values["advancedProfileOverrides"]["default"] is False,
            "profile-specific values must not be overwritten by default")
    presets = {item[0] for item in values["shaderPreset"]["possible_values"]}
    require(values["shaderPreset"]["default"] == "default" and
            presets == {"default", "liveaction", "aggressive"},
            "only default/live-action/aggressive-test profiles may be selectable")
    expected_defaults = {
        "scale": "ewa_lanczos", "cscale": "ewa_lanczos",
        "debandIterations": 3, "debandThreshold": 24,
        "debandRange": 12, "debandGrain": 12,
        "scaleAntiring": 0.95, "cscaleAntiring": 0.95,
        "blendSubtitles": "no",
    }
    for key, expected in expected_defaults.items():
        require(values[key]["default"] == expected,
                f"{key} does not match the requested anime-aa-insane default")

    subtitles = next(item for item in settings if item.get("section") == "subtitles")
    subtitle_values = {item["value"]: item for item in subtitles["values"]}
    require(subtitle_values["font"]["default"] == "Segoe UI",
            "subtitle font does not match the reference mpv.conf")
    require(subtitle_values["referenceMpvDefaultsMigrated"]["hidden"] is True,
            "legacy sans-serif subtitle default needs a one-time migration")


def test_mpv_bundle() -> None:
    config = read("resources/mpv/mpv.conf.in")
    require("load-stats-overlay=yes" in config,
            "embedded MPV must load the stats overlay for diagnostics")
    require("[tigerest-quality-base]" in config and
            config.count("profile=tigerest-quality-base") == 3,
            "shader profiles must share a shader-free quality base")
    profiles = set(re.findall(r"^\[([^]]+)]$", config, re.MULTILINE))
    require(profiles == {
        "tigerest-quality-base", "tigerest-default",
        "tigerest-liveaction", "tigerest-aggressive-test", "default",
    }, "retired or unexpected MPV profiles remain in the bundle")
    require("safe" not in "\n".join(line for line in config.splitlines()
                                     if line.startswith("[tigerest-")),
            "safe profile must be removed")
    require("@TIGEREST_IPC_SERVER@" in config,
            "platform-specific SVP IPC placeholder is missing")

    # Every active option in the user-facing template must have an immediately
    # preceding Chinese comment so the generated mpv.conf is self-documenting.
    lines = config.splitlines()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        require(index > 0 and lines[index - 1].lstrip().startswith("#") and
                re.search(r"[\u4e00-\u9fff]", lines[index - 1]),
                f"MPV option lacks a Chinese comment: {stripped}")
    for shader in re.findall(r"glsl-shader=~~/shaders/([^\r\n]+)", config):
        require((ROOT / "resources/mpv/shaders" / shader).is_file(), f"missing shader: {shader}")

    required = [
        "resources/mpv/plugins/uosc.lua",
        "resources/mpv/plugins/uosc/main.lua",
        "resources/mpv/plugins/uosc/bin/ziggy-windows.exe",
        "resources/mpv/plugins/uosc/bin/ziggy-darwin",
        "resources/mpv/plugins/uosc_danmaku.lua",
        "resources/mpv/plugins/uosc_danmaku/main.lua",
        "resources/mpv/plugins/uosc_danmaku/apis/dandanplay.lua",
        "resources/mpv/plugins/profile_menu.lua",
        "resources/mpv/fonts/Source Han Serif SC-Bold.ttf",
    ]
    for relative in required:
        require((ROOT / relative).is_file(), f"missing MPV bundle asset: {relative}")

    manager = read("src/player/MpvConfigManager.cpp")
    require("plugins/uosc.lua" in manager, "uosc named loader is not wired")
    require("plugins/uosc_danmaku.lua" in manager, "danmaku named loader is not wired")
    require("input-ipc-server=mpvpipe" in manager and "#ifdef Q_OS_WIN" in manager,
            "Windows SVP named pipe is not generated before libmpv startup")
    require("legacyPreset" in manager and 'QStringLiteral("aggressive")' in manager,
            "retired preset migration is missing")
    require("referenceMpvDefaultsMigrated" in manager and
            'QStringLiteral("Segoe UI")' in manager,
            "legacy subtitle font is not migrated to the requested default")
    for comment in (
        "# 加载 UOSC", "# 加载大河三档画质菜单", "# 加载 UOSC 弹幕",
    ):
        require(comment in manager, "generated script option lacks a Chinese comment")
    require("mode == \"auto\" || mode == \"system\"" in manager,
            "automatic user MPV config detection is not wired")
    require("writeSystemCompanionConfig" in manager and
            "TIGEREST_MPV_INCLUDE" in manager and
            "tigerest-system-profiles.conf" in manager,
            "system MPV mode does not receive bundled shader profiles")
    controller = read("external/mpvqt/src/mpvcontroller.cpp")
    require('mpv_set_option_string(d_ptr->m_mpv, "include"' in controller and
            "TIGEREST_MPV_INCLUDE" in controller,
            "libmpv does not parse the system-mode companion profile file")
    player = read("src/player/PlayerComponent.cpp")
    require("MpvConfigManager::usingSystemConfig()" in player and
            "Preserving user MPV profile and shaders" in player,
            "user MPV profiles and shaders are still overwritten")
    require("mpvDiagnostics" in player and 'getProperty("glsl-shaders")' in player,
            "runtime shader diagnostics are missing")
    require('getProperty("scale")' in player and 'getProperty("vo-passes")' in player,
            "runtime scaling or full frame-pipeline diagnostics are missing")

    renderer = read("external/mpvqt/src/mpvrenderer.cpp")
    require("MPV_RENDER_PARAM_ADVANCED_CONTROL" in renderer and
            "mpv_render_context_update" in renderer,
            "libmpv advanced-control frame timings are not enabled")

    inputs = read("resources/mpv/input.conf")
    require("stats/display-stats-toggle" in inputs and "stats/display-page-2" in inputs,
            "overview and full frame-pipeline stats shortcuts are missing")
    uosc = read("resources/mpv/script-opts/uosc.conf")
    require("button:diagnostics" in uosc,
            "uosc playback diagnostics button is missing")
    shortcuts = set(re.findall(r"^Alt\+(\d)\s+script-binding profile_menu/", inputs, re.MULTILINE))
    require(shortcuts == {"1", "2", "3"} and "apply-safe" not in inputs,
            "only Alt+1/2/3 profile shortcuts may remain")

    profile_menu = read("resources/mpv/plugins/profile_menu.lua")
    for marker in ("tigerest-default", "tigerest-liveaction", "tigerest-aggressive-test"):
        require(marker in profile_menu, f"profile menu is missing {marker}")
    for retired in ("tigerest-safe", "tigerest-shader-off", "tigerest-anime-aa"):
        require(retired not in profile_menu, f"profile menu still exposes {retired}")

    danmaku = read("resources/mpv/plugins/uosc_danmaku/main.lua")
    danmaku_menu = read("resources/mpv/plugins/uosc_danmaku/modules/menu.lua")
    require("ENABLED = get_danmaku_visibility()" in danmaku and
            'toggle_danmaku_switch(ENABLED and "on" or "off")' in danmaku,
            "saved danmaku visibility is not restored on file load")
    require("local visible = get_danmaku_visibility()" in danmaku_menu and
            'visible and "on" or "off"' in danmaku_menu,
            "uosc button does not restore the saved danmaku visibility")


def test_default_server_seed() -> None:
    compat = read("native/embycompat.js")
    require("192.168.5.150:8095" in compat, "internal default server is missing")
    require("nas.tigerest.top:8095" in compat, "public default server is missing")
    seed_start = compat.index("credentials.Servers = [{")
    seed_end = compat.index("localStorage.setItem", seed_start)
    seed = compat[seed_start:seed_end]
    require(not re.search(r"(?i)(password|access.?token|api.?key|username)", seed),
            "default server seed contains a credential field")
    require("ManualAddress: remoteAddress" in seed,
            "public default server is not the manual fallback")

    startup = read("native/find-webclient.js")
    for marker in (
        "isAddressOnLocalSubnet(DEFAULT_LOCAL_SERVER_IP)",
        "[DEFAULT_LOCAL_SERVER, DEFAULT_REMOTE_SERVER]",
        "[DEFAULT_REMOTE_SERVER]",
        "savedServer && !isTigerestDefaultServer(savedServer)",
    ):
        require(marker in startup, f"LAN/WAN startup routing is missing: {marker}")

    system = read("src/system/SystemComponent.cpp")
    require("emit serverConnectivityResult(url, false" in system and
            "CONNECTIVITY_RETRY_INTERVAL_MS" not in system,
            "failed startup probes do not advance to the WAN fallback")


def test_native_player_composition() -> None:
    compat = read("native/embycompat.js")
    require("router.setTransparency(level)" in compat,
            "Emby transparency adapter is not wired to appRouter")
    qml = read("src/ui/webview.qml")
    require("visible: video.nativeGpuNext" in qml and "webRestoreDelay" not in qml and
            "webRestoreReady" not in qml and "layer.enabled" not in qml,
            "WebEngine composition is not separated for GPU-Next and libmpv")
    player = read("native/mpvVideoPlayer.js")
    require("getExternalSubtitleUrl" in player and "new URL(deliveryUrl, this._currentSrc).href" in player,
            "external subtitle URLs are not resolved for libmpv")
    require("appRouter.showVideoOsd()" in player and "useUoscPlaybackUi" in player,
            "uosc/HTML OSD selection is not wired")
    mpv_item = read("src/player/MpvVideoItem.cpp")
    for marker in ("MOUSE_ENTER", "MOUSE_LEAVE", "WHEEL_UP", "keydown", "keyup", "mouseDoubleClickEvent"):
        require(marker in mpv_item, f"libmpv input bridge is missing: {marker}")
    require('commandAsync({QStringLiteral("cycle"), QStringLiteral("pause")})' in mpv_item and
            "m_leftDoubleClickHandledLocally" in mpv_item,
            "left double-click does not perform one local pause toggle")
    mpv_input = read("resources/mpv/input.conf")
    require("MBTN_LEFT_DBL ignore" in mpv_input and "MBTN_LEFT_DBL cycle" not in mpv_input,
            "mpv input.conf does not suppress the duplicate/default double-click action")
    require("initializeController();" in mpv_item and
            'setPropertyBlocking(QStringLiteral("wid")' in mpv_item and
            'setPropertyBlocking(QStringLiteral("vo"), QStringLiteral("gpu-next"))' in mpv_item,
            "native GPU-Next window embedding is missing")
    mpv_item_header = read("src/player/MpvVideoItem.h")
    require("Q_PROPERTY(bool nativeGpuNext" in mpv_item_header,
            "QML cannot distinguish native GPU-Next from the libmpv Render API")
    require("ensureNativeHostWindow" in mpv_item and
            "new QWindow(parentWindow)" in mpv_item and
            "nativeHost->winId()" in mpv_item and
            "m_nativeHostWindow->hide()" in mpv_item and
            "window()->winId()" not in mpv_item,
            "native mpv is not isolated from the WebEngine toplevel")
    require('setFlag(Qt::WindowDoesNotAcceptFocus, false)' in mpv_item and
            'installEventFilter(this)' in mpv_item and
            'bool MpvVideoItem::eventFilter' in mpv_item and
            'setPropertyBlocking(QStringLiteral("input-cursor"), true)' in mpv_item and
            "requestActivate()" in mpv_item,
            "native gpu-next host cannot receive UOSC pointer/focus input")
    player_component = read("src/player/PlayerComponent.cpp")
    require('m_inPlayback ? QStringLiteral("replace")' in player_component and
            'QStringLiteral("append-play")' in player_component and
            "stop();\n  queueMedia" not in player_component,
            "single media load does not distinguish active replacement from idle/EOF startup")
    require("Rejected MPV profile attempt to leave the Render API" in player_component,
            "libmpv compatibility-backend protection is missing")
    require("fullscreenRequested" in mpv_item and "Qt::Key_F11" in mpv_item and
            "onFullscreenRequested" in qml,
            "uosc/native fullscreen routing is incomplete")
    require("tigerest-default" in mpv_item and "tigerest-aggressive-test" in mpv_item and
            'getProperty(QStringLiteral("glsl-shaders"))' in mpv_item and
            "滤镜切换失败" in mpv_item,
            "profile shortcuts do not verify the runtime shader list")
    require('QStringLiteral("change-list"), QStringLiteral("glsl-shaders")' in mpv_item and
            'QStringLiteral("clr")' in mpv_item and
            "shader.toString().trimmed().isEmpty()" in mpv_item and
            "shaderCount == expectedShaders" in mpv_item,
            "profile shortcuts do not clear and exactly verify list-valued shader state")
    profile_menu = read("resources/mpv/plugins/profile_menu.lua")
    require("mp.commandv('change-list', 'glsl-shaders', 'clr', '')" in profile_menu,
            "uosc profile menu does not clear the previous shader list")
    require('value(SETTINGS_SECTION_MPV, "advancedProfileOverrides").toBool()' in player_component,
            "advanced settings still overwrite every profile by default")

    video_player = read("native/mpvVideoPlayer.js")
    for marker in (
        "startStartupTimer()", "播放器启动超时（30 秒）", "requestNativeStop()",
        "this.onCanceled", "player.canceled.disconnect(this.onCanceled)",
        "window.api.window.beginPlaybackSession()", "window.api.window.endPlaybackSession()",
    ):
        require(marker in video_player, f"video lifecycle cleanup is missing: {marker}")
    require("player.canceled.connect(()" not in video_player and
            "window.api.player.stop();\n\n            window.api.player.setVideoRectangle" not in video_player,
            "video lifecycle still leaks anonymous signals or issues duplicate stop")

    window_manager = read("src/ui/WindowManager.cpp")
    for marker in (
        "beginPlaybackSession", "endPlaybackSession", "m_isFullScreen",
        "m_playbackSessionStartedFullScreen", "m_playbackSessionEnteredFullScreen",
    ):
        require(marker in window_manager, f"playback window session is missing: {marker}")

    shell = read("native/nativeshell.js")
    require("tigerest-window-mode-button" in shell and "installWindowModeEntry" in shell,
            "Emby window/fullscreen control is missing")
    uosc = read("resources/mpv/script-opts/uosc.conf")
    uosc_main = read("resources/mpv/plugins/uosc/main.lua")
    exit_button = read("resources/mpv/plugins/uosc/elements/TigerestExit.lua")
    require("top_bar_controls=" in uosc and "button:tigerest-exit" not in uosc and
            "tigerest_exit = require('elements/TigerestExit')" in uosc_main and
            "self.idle_timer = mp.add_timeout(3" in exit_button and
            "self.last_cursor_x == cursor.x" in exit_button and
            "cursor:on('move', function()" in exit_button and
            "self:register_mp_event('file-loaded', reveal)" in exit_button and
            "function TigerestExit:get_visibility()" in exit_button and
            "self:set_coordinates(margin, margin" in exit_button and
            "mp.command('stop')" in exit_button,
            "mouse-aware UOSC upper-left exit button is missing")
    require("{title = t('Quit'), value = 'stop'}" in uosc_main and
            "mp.command('quit')" not in uosc_main and
            "mp.command('quit')" not in read("resources/mpv/plugins/uosc/elements/TopBar.lua") and
            "mp.command('quit')" not in read("resources/mpv/plugins/uosc/elements/Updater.lua"),
            "embedded UOSC can still destroy the shared libmpv core")
    require("case MPV_END_FILE_REASON_QUIT:" in player_component and
            "Embedded mpv received quit; treating playback as canceled" in player_component,
            "unexpected mpv quit is not reported as user cancellation")
    require("playNext: false" in video_player and "resetPlayQueue: true" in video_player,
            "explicit playback cancellation can still auto-advance the Emby queue")


def test_brand_assets() -> None:
    required = [
        "resources/images/icon.png",
        "resources/images/icon.svg",
        "bundle/win/tigerest.ico",
        "bundle/win/wizard-image.png",
        "bundle/win/wizard-small-image.png",
        "bundle/osx/tigerest.icns",
        "native/logo.png",
    ]
    for relative in required:
        require((ROOT / relative).is_file(), f"missing Tigerest brand asset: {relative}")
    require("tigerest.ico" in read("bundle/win/JellyfinDesktop.iss.in"),
            "Windows installer still points at the legacy icon")
    require("tigerest.ico" in read("bundle/win/iconres.rc"),
            "Windows executable still points at the legacy icon")
    require("tigerest.icns" in read("src/CMakeLists.txt"),
            "macOS bundle still points at the legacy icon")
    generator = read("tools/generate_brand_assets.py")
    require('wordmark(icon).save(native_dir / "logo.png"' in generator and
            '((width - badge.width) // 2, 245)' in generator,
            "connection wordmark or centered installer artwork generation is missing")


def test_settings_ui() -> None:
    shell = read("native/nativeshell.js")
    for marker in (
        "大河影院 / MPV 设置", "MPV 画质与插件", "tgs-search",
        "typeof currentValue === 'boolean'", "tigerest-mpv-settings-button",
        "window.tigerestOpenMpvSettings", "event.key === ','", "当前加载着色器",
        "实际缩放", "完整帧流水线",
    ):
        require(marker in shell, f"dedicated settings UI marker missing: {marker}")
    for marker in (
        "installHorizontalShelfDragging", "scrollLeft - dx",
        "tigerest-shelf-dragging", "suppressNextClick",
    ):
        require(marker in shell, f"desktop horizontal shelf dragging is missing: {marker}")
    system = read("src/system/SystemComponent.cpp")
    require("new TextDecoder('utf-8')" in system,
            "UTF-8 settings descriptions are not decoded correctly")
    require("mpvConfigDir" in system and "mpvConfigMode" in system,
            "settings UI cannot show the active MPV config root")
    player = read("src/player/PlayerComponent.cpp")
    require('mpv_observe_property(m_mpv->mpv(), 0, "current-ao"' in player and
            "Audio output fell back to null" in player and
            "tigerest-audio-recovery" in player and
            'getProperty("audio-device-list")' in player and
            'm_mpv->setProperty("pause", true)' in player,
            "silent null-audio fallback is not surfaced and paused")


def test_offline_download_cleanup() -> None:
    system = read("src/system/SystemComponent.cpp")
    remove_start = system.index("void SystemComponent::removeDownload")
    remove_body = system[remove_start:remove_start + 1200]
    require('const QString localPath' in remove_body and
            'QFile::remove(localPath);' in remove_body,
            "completed offline media file is not deleted with its index item")

    offline = read("native/offline.js")
    require("window.__tigerestOfflineRender = render" in offline and
            "const activeRender = window.__tigerestOfflineRender" in offline,
            "reopened offline library does not receive download updates")


def test_macos_reproducibility_contract() -> None:
    require("CMAKE_OSX_DEPLOYMENT_TARGET \"26.0\"" in read("CMakeLists.txt"),
            "CMake macOS 26 target is missing")
    require("<string>26.0</string>" in read("bundle/osx/Info.plist.in"),
            "Info.plist macOS 26 minimum is missing")
    require("CMAKE_OSX_DEPLOYMENT_TARGET=26.0" in read("dev/macos/build.sh"),
            "local macOS build target is missing")
    workflow = read(".github/workflows/build-macos.yml")
    require("macos-26" in workflow and
            "CMAKE_OSX_DEPLOYMENT_TARGET=26.0" in workflow and
            "ctest --test-dir build" in workflow,
            "macOS CI matrix or test step is missing")
    deploy = read("CMakeModules/CompleteBundleMac.cmake.in")
    for unsupported_plugin in (
        "libqsqlmimer.dylib", "libqsqlodbc.dylib", "libqsqlpsql.dylib",
        "libqtposition_nmea.dylib",
    ):
        require(unsupported_plugin in deploy,
                f"unsupported macOS plugin is not pruned: {unsupported_plugin}")
    require("Bundled Qt framework dependency is missing" in deploy,
            "bundled Qt frameworks are not validated before dependency fixup")


def test_no_embedded_tokens() -> None:
    token = re.compile(
        rb"(?i)(?:api_key=|X-(?:MediaBrowser|Emby)-Token(?:=|%3D)|"
        rb"AccessToken(?:=|\\\":\\\")|Token(?:=\\\"|%3D%22))[A-Za-z0-9_-]{32}"
    )
    literal_password = re.compile(
        rb"(?i)(?:password|passwd|pwd)\s*[:=]\s*['\"][^'\"]+['\"]"
    )
    literal_test_account = re.compile(
        rb"(?i)(?:test|emby|jellyfin)[_-]?"
        rb"(?:username|user|account|login|email|password|pass|passwd)"
        rb"\s*[:=]\s*['\"][^'\"]+['\"]"
    )
    scan_roots = ["src", "native", "resources", "bundle", "CMakeModules", "dev"]
    allowed_suffixes = {
        ".cpp", ".h", ".js", ".json", ".in", ".cmake", ".sh", ".bat",
        ".yml", ".yaml", ".conf", ".lua", ".plist", ".xml", ".desktop",
    }
    offenders: list[str] = []
    account_offenders: list[str] = []
    for root_name in scan_roots:
        for path in (ROOT / root_name).rglob("*"):
            if not path.is_file():
                continue
            contents = path.read_bytes()
            if path.suffix.lower() in allowed_suffixes:
                if token.search(contents) or literal_password.search(contents):
                    offenders.append(str(path.relative_to(ROOT)))
            if path.suffix.lower() in allowed_suffixes | {".md", ".html", ".css"}:
                if literal_test_account.search(contents):
                    account_offenders.append(str(path.relative_to(ROOT)))
    require(not offenders, "literal credential found in source: " + ", ".join(offenders))
    require(not account_offenders,
            "literal test account found in source: " + ", ".join(account_offenders))

    for path in (ROOT / "README.md", ROOT / "PLAN.md", ROOT / "BUILD_REPORT.md",
                 ROOT / "TEST_REPORT.md"):
        require(not literal_test_account.search(path.read_bytes()),
                f"literal test account found in {path.name}")

    log_source = read(ROOT / "src" / "utils" / "Log.cpp")
    for marker in (
        "X-(?:Emby|MediaBrowser)-Token",
        "Authorization\\\\s*:\\\\s*Bearer",
        "censorExistingLogs(logDir)",
        "QSaveFile destination(path)",
    ):
        require(marker in log_source, f"log credential migration missing: {marker}")

    censor = read("src/utils/Log.cpp")
    for marker in ("api_key=", "X-Emby-Token=", "AccessToken\\\":\\\"", "Token=\\\""):
        require(marker in censor, f"log censor marker missing: {marker}")

    player = read("src/player/PlayerComponent.cpp")
    for marker in (
        "sanitizeMediaUrl(url)", "QUrlQuery retained", "X-Emby-Token: %1",
        'setProperty("http-header-fields", headers)',
    ):
        require(marker in player, f"media credential header transport missing: {marker}")


def main() -> int:
    tests = [
        test_settings,
        test_mpv_bundle,
        test_default_server_seed,
        test_native_player_composition,
        test_brand_assets,
        test_settings_ui,
        test_offline_download_cleanup,
        test_macos_reproducibility_contract,
        test_no_embedded_tokens,
    ]
    for test in tests:
        test()
    print(f"bundle integrity: {len(tests)} checks passed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as error:
        print(f"bundle integrity failure: {error}", file=sys.stderr)
        raise SystemExit(1)
