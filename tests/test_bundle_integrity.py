#!/usr/bin/env python3
"""Static integrity and credential-safety checks for bundled client assets."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def cmake_command_arguments(source: str, command: str) -> list[list[str]]:
    """Return tokenized arguments for complete, top-level CMake command calls."""
    calls: list[list[str]] = []
    command_start = re.compile(rf"(?im)^\s*{re.escape(command)}\s*\(")
    token_pattern = re.compile(r'"(?:\\.|[^"\\])*"|[^\s()]+')

    for match in command_start.finditer(source):
        depth = 1
        index = match.end()
        quoted = False
        escaped = False
        while index < len(source) and depth:
            character = source[index]
            if escaped:
                escaped = False
            elif character == "\\" and quoted:
                escaped = True
            elif character == '"':
                quoted = not quoted
            elif not quoted and character == "(":
                depth += 1
            elif not quoted and character == ")":
                depth -= 1
            index += 1
        require(depth == 0, f"unterminated {command}() command")

        body = source[match.end():index - 1]
        body = re.sub(r"(?m)#.*$", "", body)
        tokens = token_pattern.findall(body)
        calls.append([
            token[1:-1] if token.startswith('"') and token.endswith('"') else token
            for token in tokens
        ])
    return calls


def inno_section_entries(source: str, section: str) -> list[dict[str, str]]:
    """Parse key/value entries from one Inno Setup section."""
    entries: list[dict[str, str]] = []
    active_section = ""
    for raw_line in source.splitlines():
        line = raw_line.strip()
        section_match = re.fullmatch(r"\[([^]]+)]", line)
        if section_match:
            active_section = section_match.group(1)
            continue
        if active_section != section or not line or line.startswith(";"):
            continue

        fields: dict[str, str] = {}
        for field in line.split(";"):
            key, separator, value = field.partition(":")
            require(bool(separator), f"invalid [{section}] entry: {line}")
            value = value.strip()
            if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            fields[key.strip()] = value
        entries.append(fields)
    return entries


def find_cmake_command() -> str:
    candidates: list[Path] = []
    if configured := os.environ.get("CMAKE_COMMAND"):
        candidates.append(Path(configured))
    if discovered := shutil.which("cmake"):
        candidates.append(Path(discovered))

    checkout_roots = [ROOT]
    if ROOT.parent.name == ".worktrees":
        checkout_roots.append(ROOT.parent.parent)
    for checkout_root in checkout_roots:
        candidates.extend((
            checkout_root / "dev/windows/deps/tools-venv/Scripts/cmake.exe",
            checkout_root / "dev/windows/deps/tools-venv/Lib/site-packages/cmake/data/bin/cmake.exe",
        ))

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    raise AssertionError("cmake is required to execute the portable bundle contract test")


def run_portable_bundle_script(
        runtime_files: dict[str, bytes] | None,
) -> tuple[subprocess.CompletedProcess[str], dict[str, bytes]]:
    with tempfile.TemporaryDirectory(prefix="tigerest-portable-test-") as temporary:
        sandbox = Path(temporary)
        source_dir = sandbox / "installed"
        binary_dir = sandbox / "build"
        runtime_dir = sandbox / "runtime"
        source_dir.mkdir()
        binary_dir.mkdir()
        (source_dir / "app.exe").write_bytes(b"application")
        # A staged app may have been opened in portable mode. Packaging must
        # never export user state or a privately provisioned mapping credential.
        for relative in ("data/profiles/user/private/danmaku-mapping-authorization.txt",
                         "profiles/user/private/danmaku-mapping-authorization.txt",
                         "logs/report-diagnostics-fixture.tmp"):
            private_file = source_dir / relative
            private_file.parent.mkdir(parents=True, exist_ok=True)
            private_file.write_bytes(b"synthetic private state")
        if runtime_files is not None:
            runtime_dir.mkdir()
            for filename, contents in runtime_files.items():
                (runtime_dir / filename).write_bytes(contents)

        configured_script = sandbox / "PreparePortableZip.cmake"
        configure_driver = sandbox / "ConfigurePortableZip.cmake"
        template = ROOT / "CMakeModules/PreparePortableZip.cmake.in"
        configure_driver.write_text(
            "\n".join((
                f"set(CMAKE_INSTALL_PREFIX [==[{source_dir.as_posix()}]==])",
                f"set(CMAKE_CURRENT_BINARY_DIR [==[{binary_dir.as_posix()}]==])",
                f"set(PROJECT_SOURCE_DIR [==[{ROOT.as_posix()}]==])",
                f"set(VCRUNTIME_DIR [==[{runtime_dir.as_posix()}]==])",
                f"configure_file([==[{template.as_posix()}]==] "
                f"[==[{configured_script.as_posix()}]==] @ONLY)",
                "",
            )),
            encoding="utf-8",
        )

        cmake = find_cmake_command()
        configured = subprocess.run(
            [cmake, "-P", str(configure_driver)],
            cwd=sandbox,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        require(configured.returncode == 0,
                "failed to configure portable bundle script: " +
                configured.stdout + configured.stderr)

        result = subprocess.run(
            [cmake, "-P", str(configured_script)],
            cwd=sandbox,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        zip_dir = binary_dir / "portable"
        copied_files = {
            path.relative_to(zip_dir).as_posix(): path.read_bytes()
            for path in zip_dir.rglob("*")
            if path.is_file()
        } if zip_dir.is_dir() else {}
        return result, copied_files


def test_settings() -> None:
    settings = json.loads(read("resources/settings/settings_description.json"))
    section = next(item for item in settings if item.get("section") == "mpv")
    values = {item["value"]: item for item in section["values"]}
    require(values["configMode"]["default"] == "embedded",
            "Windows and macOS must default to the bundled MPV configuration")
    modes = {item[0] for item in values["configMode"]["possible_values"]}
    require(modes == {"auto", "embedded", "system"}, "MPV config modes are incomplete")
    require(values["configModeMigrated"]["hidden"] is True,
            "legacy embedded-mode profiles need a one-time migration marker")
    require(values["embeddedConfigDefaultMigrated"]["hidden"] is True,
            "legacy automatic-mode profiles need a bundled-default migration marker")
    require(values["renderBackend"]["default"] == "auto",
            "the render backend must retain automatic platform selection")
    backends = {item[0] for item in values["renderBackend"]["possible_values"]}
    require(backends == {"auto", "gpu-next", "libmpv"},
            "MPV render backend choices are incomplete")
    gpu_next = [item for item in values["renderBackend"]["possible_values"]
                if item[0] == "gpu-next"]
    require(len(gpu_next) == 2 and
            any(item[2].get("platforms_excluded") == "osx" for item in gpu_next) and
            any(item[2].get("platforms") == "osx" and "独立" in item[1]
                for item in gpu_next),
            "macOS must expose the separate native GPU-Next window mode")
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

    video = next(item for item in settings if item.get("section") == "video")
    video_values = {item["value"]: item for item in video["values"]}
    require(video_values["hardwareDecoding"]["default"] == "copy",
            "shader-compatible hardware decoding must default to copy-back mode")

    subtitles = next(item for item in settings if item.get("section") == "subtitles")
    subtitle_values = {item["value"]: item for item in subtitles["values"]}
    require(subtitle_values["font"]["default"] == "Segoe UI",
            "subtitle font does not match the reference mpv.conf")
    require(subtitle_values["referenceMpvDefaultsMigrated"]["hidden"] is True,
            "legacy sans-serif subtitle default needs a one-time migration")

    danmaku = next((item for item in settings if item.get("section") == "danmaku"), None)
    require(danmaku is not None, "persistent danmaku style settings section is missing")
    danmaku_values = {item["value"]: item for item in danmaku["values"]}
    expected_danmaku_defaults = {
        "bold": True,
        "fontsize": 50,
        "outline": 1.0,
        "shadow": 0,
        "scrolltime": 15,
        "opacity": 0.7,
        "displayarea": 0.2,
    }
    require(set(danmaku_values) == set(expected_danmaku_defaults),
            "danmaku style settings do not match the bundled plugin options")
    for key, expected in expected_danmaku_defaults.items():
        require(danmaku_values[key]["default"] == expected,
                f"danmaku {key} default does not match the bundled plugin")


def test_mpv_bundle() -> None:
    # The default user area of the single editable mpv.conf. Options decided by
    # the client or other settings pages live in the managed tail instead.
    config = read("resources/mpv/mpv.default.conf")
    require("display-stats-toggle" in read("resources/mpv/plugins/stats.lua") and
            "display-page-" in read("resources/mpv/plugins/stats.lua"),
            "shipped stats must preserve the diagnostic script bindings")
    require("[tigerest-quality-base]" in config and
            config.count("profile=tigerest-quality-base") == 3,
            "shader profiles must share a shader-free quality base")
    profiles = set(re.findall(r"^\[([^]]+)]$", config, re.MULTILINE))
    require(profiles == {
        "tigerest-quality-base", "tigerest-default",
        "tigerest-liveaction", "tigerest-aggressive-test",
    }, "retired or unexpected MPV profiles remain in the bundle")
    catalog = json.loads(read("resources/mpvconf/options.json"))
    locked = {key for group in catalog["locked"] for key in group["keys"]}
    page_owned = {key for group in catalog["pageOwned"] for key in group["keys"]}
    for key in ("vo", "input-ipc-server", "load-scripts", "script", "osc", "idle", "include"):
        require(key in locked, f"{key} must be locked to the client")
    for key in ("hwdec", "video-sync", "sub-font", "sub-scale", "audio-channels"):
        require(key in page_owned, f"{key} must be decided by its settings page")
    active = [line.split("=", 1)[0].strip() for line in config.splitlines()
              if line.strip() and not line.lstrip().startswith(("#", "["))]
    require(not (set(active) & (locked | page_owned)),
            "the default user area must not contain locked or page-owned options")
    require(not re.search(r"^profile\s*=", config.split("[", 1)[0], re.MULTILINE),
            "the startup profile belongs to the managed tail, not the user area")
    rife = next(item for item in catalog["conditional"] if item["id"] == "RIFE")
    require(rife["setting"] == ["video", "aiRife"] and
            any("minterpolate" in rule.get("filters", []) for rule in rife["rules"]) and
            any(rule.get("key") == "interpolation" for rule in rife["rules"]),
            "RIFE must suspend frame-rate filters and mpv interpolation")

    # Every active option in the default user area must have an immediately
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

    # Both embedded bundles and the native macOS GPU-Next window retain the
    # user-confirmed full external shader profiles.
    require(config.count("glsl-shader=~~/shaders/") == 9 and
            "Anime4K_Restore_CNN_UL.glsl" in config and
            "KrigBilateral.glsl" in config,
            "the external GPU-Next shader chain changed unexpectedly")

    required = [
        "resources/mpv/plugins/uosc.lua",
        "resources/mpv/plugins/uosc/main.lua",
        "resources/mpv/plugins/uosc/bin/ziggy-windows.exe",
        "resources/mpv/plugins/uosc/bin/ziggy-darwin",
        "resources/mpv/plugins/uosc_danmaku.lua",
        "resources/mpv/plugins/uosc_danmaku/main.lua",
        "resources/mpv/plugins/uosc_danmaku/apis/dandanplay.lua",
        "resources/mpv/plugins/emby_quality.lua",
        "resources/mpv/plugins/profile_menu.lua",
        "resources/mpv/fonts/Source Han Serif SC-Bold.ttf",
    ]
    for relative in required:
        require((ROOT / relative).is_file(), f"missing MPV bundle asset: {relative}")

    manager = read("src/player/MpvConfigManager.cpp")
    require("plugins/uosc.lua" in manager, "uosc named loader is not wired")
    require("plugins/emby_quality.lua" in manager, "Emby quality bridge is not wired")
    require("plugins/uosc_danmaku.lua" in manager, "danmaku named loader is not wired")
    require('QStringLiteral("mpvpipe")' in manager and "#ifdef Q_OS_WIN" in manager,
            "Windows SVP named pipe is not generated before libmpv startup")
    require("legacyPreset" in manager and 'QStringLiteral("aggressive")' in manager,
            "retired preset migration is missing")
    require("referenceMpvDefaultsMigrated" in manager and
            'QStringLiteral("Segoe UI")' in manager,
            "legacy subtitle font is not migrated to the requested default")
    settings_header = read("src/settings/SettingsComponent.h")
    require('#define SETTINGS_SECTION_DANMAKU "danmaku"' in settings_header and
            "writeDanmakuStyleConfig(bundleDir" in manager and
            "SETTINGS_SECTION_DANMAKU" in manager,
            "persistent danmaku style options are not deployed with the bundled MPV config")
    danmaku_options = read("resources/mpv/plugins/uosc_danmaku/modules/options.lua")
    require(re.search(r"^\s*displayarea\s*=\s*0\.2\s*,", danmaku_options, re.MULTILINE),
            "bundled danmaku display area must default to 0.2")
    for marker in ("load-stats-overlay", "~~/plugins/stats.lua", "加载 uosc", "加载弹幕搜索"):
        require(marker in manager, f"managed tail lacks {marker}")
    require("mpvConfEditorMigrated" in manager and "旧版自定义配置备份" in manager and
            "user-overrides.conf" in manager,
            "2.9.4 migration must back up the retired customizations")
    require("pruneRetiredShaders" in manager and "ensureUserShaderDir" in manager,
            "shader library updates must keep shaders/user and drop retired bundled files")
    manifest = json.loads(read("resources/mpv/shaders/manifest.json"))
    shipped = {path.relative_to(ROOT / "resources/mpv/shaders").as_posix()
               for path in (ROOT / "resources/mpv/shaders").rglob("*.glsl")}
    require(set(manifest["files"]) == shipped, "shader manifest is stale; run tools/generate_mpv_shader_catalog.py")
    shaders = json.loads(read("resources/mpvconf/shaders.json"))
    require({item["path"] for item in shaders["shaders"]} == shipped,
            "shader catalog is stale; run tools/generate_mpv_shader_catalog.py")
    controller = read("external/mpvqt/src/mpvcontroller.cpp")
    require("TIGEREST_MPV_FALLBACK_CONFIG" in controller and "TIGEREST_MPV_CONFIG_FALLBACK_USED" in controller,
            "libmpv must fall back to the default configuration instead of aborting")
    require("TIGEREST_MPV_SAFE_SCRIPTS" not in controller and "TIGEREST_MPV_INCLUDE" not in controller,
            "the retired system-mode companion is still wired")
    player = read("src/player/PlayerComponent.cpp")
    require("setOtherConfiguration" not in player and "usingSystemConfig" not in player,
            "the retired advanced options or system mode are still applied")
    require("applyUserConfLive" in player and "MpvConfigManager::refresh()" in player,
            "mpv.conf edits and setting changes must apply to the running player")
    require("mpvDiagnostics" in player and 'read("glsl-shaders")' in player and
            'mpv_observe_property(m_mpv->mpv(), 0, "glsl-shaders"' in player,
            "runtime shader diagnostics are missing")
    require('read("scale")' in player and 'read("vo-passes")' in player,
            "runtime scaling or frame-pipeline diagnostics are missing")
    require('read("scripts")' in player and 'result["scriptFiles"]' in player and
            'result["autoScripts"]' in player,
            "runtime script-isolation diagnostics are missing")

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
    require("nas.tigerest.top:18445" in compat, "public default server is missing")
    # Both server records: the fixed Tigerest one and the one for a server
    # chosen during first run.
    seed_start = compat.index("function chosenServer()")
    seed_end = compat.index("seedDefaultServer();", seed_start)
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
        "if (mode === 'custom')",
        "if (saved) await connectServers([saved])",
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
    require('commandAsync({QStringLiteral("script-binding"),\n'
            '                      QStringLiteral("uosc/flash-volume")})' in mpv_item,
            "vertical mouse-wheel input does not reveal UOSC's existing volume UI")
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
    require("bool MpvVideoItem::shouldUseNativeGpuNext" in mpv_item and
            "#elif defined(Q_OS_MAC)" in mpv_item and
            'requestedBackend != QStringLiteral("libmpv")' in mpv_item and
            "separate macOS GPU-Next playback window" in mpv_item,
            "macOS does not default to the separate native GPU-Next window")
    mpv_item_header = read("src/player/MpvVideoItem.h")
    require("Q_PROPERTY(bool nativeGpuNext" in mpv_item_header,
            "QML cannot distinguish native GPU-Next from the libmpv Render API")
    require("ensureNativeHostWindow" in mpv_item and
            "new QWindow(parentWindow)" in mpv_item and
            "MpvInputFocusWindow" not in mpv_item and
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
    require('QStringLiteral("gpu-api"), QStringLiteral("vulkan")' in mpv_item and
            'QStringLiteral("gpu-context"), QStringLiteral("macvk")' in mpv_item and
            'QStringLiteral("wid"), qlonglong{-1}' in mpv_item,
            "macOS native playback is not detached onto the macvk GPU-Next window")
    player_component = read("src/player/PlayerComponent.cpp")
    require('m_inPlayback ? QStringLiteral("replace")' in player_component and
            'QStringLiteral("append-play")' in player_component and
            "stop();\n  queueMedia" not in player_component,
            "single media load does not distinguish active replacement from idle/EOF startup")
    require("Rejected MPV profile attempt to leave the Render API" in player_component,
            "libmpv compatibility-backend protection is missing")
    require('"CLOSE_WIN stop\\n"' in player_component and
            '"ESC stop\\n"' in player_component and
            'm_mpv->setProperty("fullscreen", true)' in player_component and
            "if (m_nativeVideoOutput)" in player_component and
            "m_mpv->commandAsync(args);" in player_component and
            "if (!m_inPlayback)" in player_component and
            "m_nativeVoTeardownPending || m_shuttingDown" in player_component and
            "prepareForShutdown()" in player_component and
            "completeNativeVoTransition();" in player_component,
            "macOS native close/fullscreen lifecycle protection is missing")
    window_manager = read("src/ui/WindowManager.cpp")
    require("updateNativePlaybackWindow" in window_manager and
            "m_window->hide()" in window_manager and
            "m_window->setVisibility(restoreVisibility)" in window_manager and
            "m_window->requestActivate()" in window_manager,
            "Emby window is not hidden and restored around macOS native playback")
    require("fullscreenRequested" in mpv_item and "Qt::Key_F11" in mpv_item and
            "onFullscreenRequested" in qml,
            "uosc/native fullscreen routing is incomplete")
    require("tigerest-default" in mpv_item and "tigerest-aggressive-test" in mpv_item and
            "m_player->applyQualityProfile" in mpv_item,
            "Alt+1/2/3 must switch through the client's profile application")
    require('<< "change-list" << "glsl-shaders" << "clr"' in player_component and
            "MpvConf::shaderCount(steps)" in player_component and
            "滤镜切换失败" in player_component,
            "profile switches do not clear and exactly verify list-valued shader state")
    profile_menu = read("resources/mpv/plugins/profile_menu.lua")
    require("'script-message', 'tigerest-apply-profile'" in profile_menu and
            "user-data/profile_menu/profiles" in profile_menu,
            "uosc profile menu must list mpv.conf profiles and switch through the client")
    require('"tigerest-apply-profile"' in player_component,
            "the client does not receive profile switches from the uosc menu")

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
    require("this._nativeStopRequested = true;" in video_player,
            "terminal mpv signals do not suppress reentrant native stop")

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
            "icon = 'close'" in exit_button and
            "anchor_id = 'controls'" in exit_button and
            "self.idle_timer" not in exit_button and
            "cursor:on('move'" not in exit_button and
            "self:set_coordinates(margin, margin" in exit_button and
            "mp.command('stop')" in exit_button,
            "controls-anchored UOSC upper-left exit button is missing")
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

    quality = read("resources/mpv/plugins/emby_quality.lua")
    input_plugin = read("native/inputPlugin.js")
    player_header = read("src/player/PlayerComponent.h")
    require("<stream>button:stream-quality" in uosc and
            "script-binding emby_quality/open" in uosc_main and
            "tigerest-stream-quality" in quality and
            "mp.commandv('playlist-play-index'" not in quality and
            "mp.set_property('ytdl-format'" not in quality,
            "UOSC still reloads the current Emby URL for quality changes")
    require("streamingBitrateRequested" in player_header and
            'strcmp(msg->args[0], "tigerest-stream-quality")' in player_component and
            "notifyStreamingBitrateResult" in player_component and
            "playbackManager.setMaxStreamingBitrate" in input_plugin and
            "enableAutomaticBitrateDetection: bitrate === 0" in input_plugin,
            "Emby Web managed streaming quality bridge is incomplete")
    require("this._currentTime = time;" in video_player and
            "this._duration = duration;" in video_player and
            "window.api.player.seekTo(val)" in video_player and
            "ticks / 10000" not in input_plugin,
            "native and Emby player milliseconds do not share one contract")
    audio_player = read("native/mpvAudioPlayer.js")
    require("self._currentTime = time;" in audio_player and
            "self._duration = duration;" in audio_player and
            "window.api.player.seekTo(val)" in audio_player,
            "native audio and Emby player milliseconds do not share one contract")


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
    webview = read("src/ui/webview.qml")
    require("property bool startupCoverVisible: true" in webview and
            'source: "qrc:/images/icon.png"' in webview and
            'color: "#111112"' in webview and
            "startupCoverTimer.restart()" in webview,
            "startup can still expose the server's blue loading canvas")
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
        "播放器设置", "媒体库设置", "MPV 画质与插件", "tgs-search",
        "typeof currentValue === 'boolean'", "tigerest-mpv-settings-button",
        "window.tigerestOpenMpvSettings", "event.key === ','", "当前加载着色器",
        "实际缩放", "完整帧流水线",
    ):
        require(marker in shell, f"dedicated settings UI marker missing: {marker}")
    for marker in (
        "danmaku: {",
        "title: '弹幕样式'",
        "'danmaku.bold'",
        "'danmaku.fontsize'",
        "'danmaku.outline'",
        "'danmaku.shadow'",
        "'danmaku.scrolltime'",
        "'danmaku.opacity'",
        "'danmaku.displayarea'",
    ):
        require(marker in shell, f"persistent danmaku settings UI marker missing: {marker}")
    for marker in (
        "installHorizontalShelfDragging", "scrollLeft - dx",
        "tigerest-shelf-dragging", "suppressNextClick",
    ):
        require(marker in shell, f"desktop horizontal shelf dragging is missing: {marker}")
    system = read("src/system/SystemComponent.cpp")
    require("new TextDecoder('utf-8')" in system,
            "UTF-8 settings descriptions are not decoded correctly")
    require("mpvConfigDir" in system and "mpvConfNotices" in system and "mpvConfEditor.js" in system,
            "settings UI cannot show the MPV config root, startup notices or the mpv.conf editor")
    editor = read("native/mpvConfEditor.js")
    for marker in ("tgs-conf-plus", "强行使用", "复制给 AI", "恢复默认配置", "mpvConfSave", "window.tigerestCreateMpvConfEditor"):
        require(marker in editor, f"mpv.conf editor marker missing: {marker}")
    player = read("src/player/PlayerComponent.cpp")
    require('mpv_observe_property(m_mpv->mpv(), 0, "current-ao"' in player and
            "Audio output fell back to null" in player and
            "tigerest-audio-recovery" in player and
            'read("audio-device-list")' in player and
            'm_mpv->setPropertyAsync("pause",true)' in player and
            'm_mpv->setProperty("pause",true)' in player,
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


def test_local_player_file_types() -> None:
    media = read("src/system/LocalMedia.cpp")
    listed = re.search(r"static const QStringList extensions\{(.*?)\};", media, re.S)
    require(listed is not None, "LocalMedia::videoExtensions() list not found")
    extensions = re.findall(r'"([a-z0-9]+)"', listed.group(1))
    installer = read("bundle/win/JellyfinDesktop.iss.in")
    registered = re.search(r"#dim VideoExtensions\[(\d+)\] \{(.*?)\}", installer)
    require(registered is not None, "installer does not register video file types")
    require(int(registered.group(1)) == len(extensions) and
            re.findall(r'"([a-z0-9]+)"', registered.group(2)) == extensions,
            "installer Open-with file types differ from LocalMedia::videoExtensions()")
    require(r'ValueData: """{app}\{#MyAppExeName}"" ""%1"""' in installer,
            "Open-with command does not pass the file to the client")
    system = read("src/system/SystemComponent.cpp")
    require('":/web-client/extension/localPlayer.js"' in system, "localPlayer.js is not injected")
    # Android and iPad bundle offline.js without the local player.
    apple = read("apple/tools/sync_resources.py")
    android = read("android/app/src/main/java/top/tigerest/theater/WebHost.kt")
    if "localPlayer" not in apple or '"localPlayer.js"' not in android:
        offline = read("native/offline.js")
        require("if (window.tigerestPlayLocalMedia) return window.tigerestPlayLocalMedia(" in offline,
                "offline playback requires localPlayer.js, which Android/iPad do not bundle")


def test_windows_delay_load_targets_final_executable() -> None:
    cmake = read("src/CMakeLists.txt")
    delay_library_calls = [
        arguments for arguments in cmake_command_arguments(cmake, "target_link_libraries")
        if "delayimp.lib" in arguments
    ]
    delay_option_calls = [
        arguments for arguments in cmake_command_arguments(cmake, "target_link_options")
        if "/DELAYLOAD:libmpv-2.dll" in arguments
    ]

    problems: list[str] = []
    library_targets = [arguments[0] for arguments in delay_library_calls if arguments]
    option_targets = [arguments[0] for arguments in delay_option_calls if arguments]
    if library_targets != ["${MAIN_TARGET}"]:
        problems.append(
            f"delayimp.lib must link only to the final executable, got {library_targets}"
        )
    if option_targets != ["${MAIN_TARGET}"]:
        problems.append(
            f"/DELAYLOAD:libmpv-2.dll must apply only to the final executable, got {option_targets}"
        )
    if any(len(arguments) < 2 or arguments[1] != "PRIVATE"
           for arguments in delay_library_calls + delay_option_calls):
        problems.append("Windows delay-load dependencies must use the PRIVATE target signature")
    require(not problems, "; ".join(problems))


def test_windows_packages_bundle_runtime_locally() -> None:
    installer = read("bundle/win/JellyfinDesktop.iss.in")
    file_entries = inno_section_entries(installer, "Files")
    runtime_entries = [
        entry for entry in file_entries
        if entry.get("Source") == "{#DeployPath}/redist/*.dll"
    ]
    require(len(runtime_entries) == 1,
            "installer must have exactly one app-local VC runtime file entry")
    runtime_entry = runtime_entries[0]
    require(runtime_entry.get("DestDir") == "{app}",
            "installer VC runtime DLLs must be copied beside the executable")
    require("Check" not in runtime_entry,
            "installer app-local VC runtime DLLs must not depend on system detection")


def test_windows_portable_runtime_bundle_contract() -> None:
    problems: list[str] = []
    failure_scenarios = (
        ("missing runtime directory", None, "VC runtime directory does not exist"),
        ("runtime directory without DLLs", {}, "No VC runtime DLLs found"),
    )
    for scenario, runtime_files, expected_error in failure_scenarios:
        result, _ = run_portable_bundle_script(runtime_files)
        output = result.stdout + result.stderr
        if result.returncode == 0:
            problems.append(f"portable bundle succeeded with {scenario}")
        elif expected_error not in output:
            problems.append(f"portable bundle reported the wrong error for {scenario}: {output}")

    result, copied_files = run_portable_bundle_script({
        "vcruntime140.dll": b"runtime",
    })
    if result.returncode != 0:
        problems.append("portable bundle rejected a valid runtime directory: " +
                        result.stdout + result.stderr)
    expected_files = {
        "app.exe": b"application",
        "portable": b"",
        "vcruntime140.dll": b"runtime",
    }
    if copied_files != expected_files:
        problems.append(f"portable bundle contents differ: {sorted(copied_files)}")
    require(not problems, "; ".join(problems))


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
        "sanitizeMediaUrl(url)", "QUrlQuery retained", "Authorization: MediaBrowser Token=\\\"%1\\\"",
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
        test_local_player_file_types,
        test_windows_delay_load_targets_final_executable,
        test_windows_packages_bundle_runtime_locally,
        test_windows_portable_runtime_bundle_contract,
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
