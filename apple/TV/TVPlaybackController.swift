import SwiftUI
import AVFoundation
import AppleCore

/// A playback generation owns its engine, timer and server-report sequence.
@MainActor final class TVPlaybackController: ObservableObject, DanmakuPlaybackState {
    var onStopped: ((JSONValue, Double, Double) -> Void)?
    var onStopReported: ((JSONValue, EmbyClient) -> Void)?
    let surface = MetalSurface(frame: .zero)
    let subtitles = TVSubtitleController()
    let settings: TVPlaybackSettings
    /// A message about this video's playback settings or interpolation, once per item.
    @Published private(set) var notice: String?
    private var nativeNoticeShown = "", nativePolledAt = 0.0
    @Published private(set) var active = false
    @Published private(set) var paused = false
    @Published private(set) var buffering = false
    @Published private(set) var position = 0.0
    @Published private(set) var duration = 0.0
    @Published private(set) var title = ""
    @Published var error: String?
    var engine: MPVEngine?
    @Published private(set) var danmaku: DanmakuRepository?
    @Published private(set) var qualityPreset = "native"
    @Published private(set) var qualityMessage = ""
    private(set) var effectiveQualityPreset = "native"
    private var frameStability = TVFrameStability()
    private(set) var danmakuEpoch: UInt64 = 0
    var rate: Double { 1 }
    private var mappingTask: Task<Void, Never>?
    private var timer: Timer?
    private var playback: EmbyPlayback?
    private var client: EmbyClient?
    private var loaded = false
    private var reportTask: Task<Void, Never>?
    private var reporting = false
    private var lastReport = 0.0
    private let probeEnabled: Bool
    private let fixtureMode: Bool
    private var lastProbe = 0.0
    private var generation = UUID()
    /// Episode requests capture this token before awaiting the server. Leaving
    /// playback or replacing an engine invalidates late responses.
    var playbackGeneration: UUID { generation }
    private var watchdog = PlaybackWatchdog()
    init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        probeEnabled = arguments.contains("--tv-playback-probe")
        fixtureMode = arguments.contains("--tv-fixture")
        settings = TVPlaybackSettings(fixtureMode: fixtureMode)
        if !fixtureMode {
            let saved = UserDefaults.standard.string(forKey: "tv.qualityPreset") ?? "native"
            qualityPreset = ["tigerest-default", "tv-balanced"].contains(saved) ? saved : "native"
        }
        NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            // AirPods or an HDMI receiver connected/disconnected: the new route may
            // carry a different channel count; let mpv reopen its output for it.
            guard reason == AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue ||
                  reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
            Task { @MainActor in self?.renegotiateOutputChannels() }
        }
    }
    private func renegotiateOutputChannels() {
        guard active, let engine else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setPreferredOutputNumberOfChannels(session.maximumOutputNumberOfChannels)
        try? engine.command(["ao-reload"])
    }

    func play(_ playback: EmbyPlayback, client: EmbyClient, session: EmbySession? = nil) throws {
        // A successful episode replacement keeps the existing full-screen
        // presentation. Failure still dismisses it once the old engine is gone.
        stop(preservingPresentation: active)
        defer { if engine == nil { active = false } }
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playback, mode: .moviePlayback)
        // Without this every route reports two channels and mpv downmixes 5.1/7.1;
        // with it AirPods get multichannel audio for the system to spatialize.
        try? audio.setSupportsMultichannelContent(true)
        try audio.setActive(true)
        try? audio.setPreferredOutputNumberOfChannels(audio.maximumOutputNumberOfChannels)
        let next: MPVEngine
        do { next = try MPVEngine(layer: surface.metal) }
        catch { try? audio.setActive(false); throw error }
        do {
            if !playback.headers.isEmpty {
                let headers = try playback.headers.map { key, value -> String in
                    guard !key.contains(where: { $0 == "\r" || $0 == "\n" || $0 == ":" }),
                          !value.contains(where: { $0 == "\r" || $0 == "\n" }) else { throw CoreError.invalidRequest }
                    return key + ": " + value
                }
                try next.set("http-header-fields", headers.joined(separator: ","))
            }
            do {
                try applyQuality(qualityPreset, to: next)
                effectiveQualityPreset = qualityPreset
                qualityMessage = Self.qualityDescription(qualityPreset)
            } catch {
                guard qualityPreset != "native" else { throw error }
                // Resetting alone returns to shared high-quality defaults. The
                // TV native baseline must also be applied before claiming it.
                try applyQuality("native", to: next)
                qualityPreset = "native"
                effectiveQualityPreset = "native"
                qualityMessage = "增强滤镜未能启用，当前使用原生画质。"
            }
            subtitles.begin(playback: playback, engine: next)
            // The settings replace the subtitle controller's television defaults.
            var refused = settings.apply(to: next)
            if let filter = settings.interpolationFilter {
                do { try next.command(["vf", "add", filter]) } catch { refused.append("vf") }
            }
            notice = refused.isEmpty ? nil : "部分播放设置未能应用，已保持默认：" + refused.joined(separator: "、")
            try next.command(["loadfile", playback.url.absoluteString, "replace"])
        } catch { subtitles.reset(); next.close(); try? audio.setActive(false); throw error }
        self.engine = next; self.playback = playback; self.client = client
        generation = UUID(); loaded = false; reporting = false; reportTask = nil
        lastProbe = 0; nativeNoticeShown = ""; nativePolledAt = 0
        frameStability = TVFrameStability()
        position = 0; duration = 0; paused = false; buffering = true; error = nil
        let season = playback.item["ParentIndexNumber"].number, episode = playback.item["IndexNumber"].number
        let label = season.map { $0.isFinite && (0...9999).contains($0) } == true && episode.map { $0.isFinite && (0...9999).contains($0) } == true ? String(format: "S%02dE%02d · ", Int(season!), Int(episode!)) : ""
        title = label + (playback.item["Name"].string ?? "正在播放")
        watchdog = PlaybackWatchdog(); active = true
        danmakuEpoch &+= 1
        if let session, !isLocalFixture(playback) {
            let host = TVDanmakuHost(session: session)
            let repository = DanmakuRepository(host: host)
            danmaku = repository
            repository.autoMatch(playback.item, mediaURL: playback.url)
            mappingTask = Task { [weak self, weak host] in
                let headers = try? await CommunityClient(emby: session).mappingHeaders()
                guard !Task.isCancelled, self?.danmaku === repository else { return }
                host?.mappingHeaders = headers ?? [:]
            }
        }
        UIApplication.shared.isIdleTimerDisabled = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }
    func tick(now: Double = ProcessInfo.processInfo.systemUptime) {
        guard let engine, active else { return }
        for event in engine.events() {
            switch event {
            case .loaded:
                loaded = true
                subtitles.fileLoaded()
                try? settings.applyAspect(to: engine)
                if let start = playback?.startSeconds, start > 0 {
                    do { try engine.command(["seek", String(start), "absolute+exact"]); position = start }
                    catch { self.error = "续播位置未能恢复" }
                }
                sendReport(.start)
            case .ended: stop(); return
            case .failed: stop(); error = "无法播放此媒体，请检查服务器连接后重试。"; return
            case .restarted: watchdog = PlaybackWatchdog(); danmakuEpoch &+= 1; frameStability.interrupt()
            }
        }
        if let value = Double(engine.string("time-pos")), value.isFinite, value >= 0 { position = safeTime(value) }
        if let value = Double(engine.string("duration")), value.isFinite, value > 0 { duration = safeTime(value) }
        paused = engine.flag("pause"); buffering = !loaded || engine.flag("paused-for-cache")
        if loaded { subtitles.update(); pollNativeInterpolation(engine, now: now) }
        if loaded && engine.flag("eof-reached") { stop(); return }
        stabilizeQuality(now: now)
        guard active else { return }
        if probeEnabled, loaded, now - lastProbe >= 10 {
            lastProbe = now
            if let data = try? JSONEncoder().encode(playbackProbe()) {
                try? data.write(to: URL.cachesDirectory.appending(path: "tv-playback-probe.json"), options: .atomic)
            }
        }
        #if DEBUG
        if loaded, now - lastAudioTrace >= 5 { lastAudioTrace = now; writeAudioTrace(engine) }
        #endif
        if watchdog.stalled(position: position, now: now, paused: paused) {
            stop(); error = "播放长时间没有进展，请检查网络后重试。"; return
        }
        if loaded && now - lastReport >= 10 { sendReport(.progress) }
    }
    /// Once a second: why the native filter keeps the video's frames, told once per item.
    private func pollNativeInterpolation(_ engine: MPVEngine, now: Double) {
        guard settings.interpolationFilter != nil, now - nativePolledAt >= 1 else { return }
        nativePolledAt = now
        guard let status = engine.json("vf-metadata/" + NativeInterpolation.label)["status"].string, status != nativeNoticeShown else { return }
        nativeNoticeShown = status
        if let message = NativeInterpolation.notice(status: status, fellBack: false) { notice = message }
    }
    private func sendReport(_ event: EmbyPlaybackEvent) {
        guard let client, let playback, !reporting, !isLocalFixture(playback) else { return }
        reporting = true; lastReport = ProcessInfo.processInfo.systemUptime
        let id = generation, position = position, paused = paused
        reportTask = Task { [weak self] in
            do { try await client.report(event, playback: playback, position: position, paused: paused) }
            catch { if self?.generation == id { self?.error = "观看进度暂时未能同步到服务器" } }
            if self?.generation == id { self?.reporting = false }
        }
    }
    func togglePause() {
        guard let engine else { return }
        do { try engine.set("pause", paused ? "no" : "yes"); paused.toggle(); sendReport(.progress) }
        catch { self.error = "暂停状态未能切换" }
    }
    func seek(by seconds: Double) {
        guard let engine, seconds.isFinite else { return }
        let target = min(duration > 0 ? duration : .greatestFiniteMagnitude, max(0, position + seconds))
        do { try engine.command(["seek", String(target), "absolute+exact"]); watchdog = PlaybackWatchdog(); danmakuEpoch &+= 1; frameStability.interrupt() }
        catch { self.error = "未能跳转播放位置" }
    }
    #if DEBUG
    /// Validation builds only: the current audio path in Caches for devicectl.
    private var lastAudioTrace = 0.0
    private func writeAudioTrace(_ engine: MPVEngine) {
        let session = AVAudioSession.sharedInstance()
        let trace: JSONValue = .object([
            "ao": .string(engine.string("current-ao")), "outChannels": .string(engine.string("audio-out-params/channels")),
            "sourceChannels": .string(engine.string("audio-params/channels")), "codec": .string(engine.string("audio-codec-name")),
            "sessionOutputChannels": .number(Double(session.outputNumberOfChannels)),
            "sessionMaximumOutputChannels": .number(Double(session.maximumOutputNumberOfChannels)),
            "supportsMultichannel": .bool(session.supportsMultichannelContent), "position": .number(position.rounded()),
            "route": .array(session.currentRoute.outputs.map { .object(["type": .string($0.portType.rawValue), "name": .string($0.portName), "channels": .number(Double($0.channels?.count ?? 0)), "spatialAudio": .bool($0.isSpatialAudioEnabled)]) }),
        ])
        if let data = try? JSONEncoder().encode(trace) { try? data.write(to: URL.cachesDirectory.appending(path: "tv-audio-trace.json"), options: .atomic) }
    }
    #endif
    private func safeTime(_ value: Double) -> Double { value.isFinite ? min(1_000_000_000, max(0, value)) : 0 }
    private func isLocalFixture(_ playback: EmbyPlayback) -> Bool {
        fixtureMode && playback.url.isFileURL
    }
    func stop() {
        stop(preservingPresentation: false)
    }
    private func stop(preservingPresentation: Bool) {
        let wasActive = active
        subtitles.reset()
        mappingTask?.cancel(); mappingTask = nil; danmaku?.clear(); danmaku = nil; danmakuEpoch &+= 1
        if let engine, let final = Double(engine.string("time-pos")), final.isFinite, final >= 0 { position = safeTime(final) }
        timer?.invalidate(); timer = nil; engine?.close(); engine = nil
        if wasActive, loaded, let playback, let client, !isLocalFixture(playback) {
            let prior = reportTask, position = position, paused = paused
            Task { [weak self] in
                await prior?.value
                try? await client.report(.stop, playback: playback, position: position, paused: paused)
                self?.onStopReported?(playback.item, client)
            }
        }
        if wasActive, loaded, let playback { onStopped?(playback.item, position, duration) }
        generation = UUID(); reportTask = nil; reporting = false
        playback = nil; client = nil; loaded = false; buffering = false; notice = nil
        if !preservingPresentation { active = false }
        UIApplication.shared.isIdleTimerDisabled = false
        if wasActive { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }

    func selectQuality(_ preset: String) {
        guard ["native", "tv-balanced", "tigerest-default"].contains(preset) else { return }
        let old = effectiveQualityPreset
        do {
            if let engine { try applyQuality(preset, to: engine) }
            qualityPreset = preset
            effectiveQualityPreset = preset
            frameStability = TVFrameStability()
            if !fixtureMode { UserDefaults.standard.set(preset, forKey: "tv.qualityPreset") }
            qualityMessage = Self.qualityDescription(preset)
        } catch {
            guard let engine else { return }
            do {
                try applyQuality(old, to: engine)
                qualityMessage = "未能应用，已恢复上一画质设置。"
            } catch {
                do {
                    try applyQuality("native", to: engine); qualityPreset = "native"
                    effectiveQualityPreset = "native"
                    qualityMessage = "未能恢复上一画质，已切换原生画质。"
                } catch {
                    stop()
                    self.error = "画质设置未能恢复，请重新播放。"
                    qualityMessage = "画质设置未能恢复，请重新播放。"
                }
            }
        }
    }
    private func stabilizeQuality(now: Double) {
        guard loaded, qualityPreset == "tv-balanced", effectiveQualityPreset == "tv-balanced", let engine else { return }
        guard let reason = frameStability.observe(now: now, position: position,
                fps: Double(engine.string("estimated-vf-fps")),
                renderDrops: Double(engine.string("frame-drop-count")),
                decoderDrops: Double(engine.string("decoder-frame-drop-count")), paused: paused, buffering: buffering) else { return }
        do {
            try applyQuality("native", to: engine)
            effectiveQualityPreset = "native"
            qualityMessage = reason == .highFrameRate
                ? "本集帧率较高，已降低滤镜负载以保持流畅。"
                : "检测到持续掉帧，已降低本集滤镜负载以保持流畅。"
        } catch {
            do {
                try applyQuality("tv-balanced", to: engine)
                qualityMessage = "自动减负未能应用，已恢复轻量增强。"
            } catch {
                stop(); self.error = "画质设置未能恢复，请重新播放。"
                qualityMessage = "画质设置未能恢复，请重新播放。"
            }
        }
    }
    private static func qualityDescription(_ preset: String) -> String {
        switch preset {
        case "tv-balanced": return "已选择轻量增强"
        case "tigerest-default": return "已选择完整桌面滤镜"
        default: return "已选择原生画质"
        }
    }
    private func applyQuality(_ selection: String, to engine: MPVEngine) throws {
        // Validate the entire bundled chain before changing a running engine.
        let preset = selection == "native" ? nil : try TVQualityPreset.bundled(selection)
        let paths = try preset?.paths()
        try engine.resetQuality()
        if selection == "native" {
            // Keep full output resolution and color management. Explicitly
            // disable enhancement work instead of inheriting profile defaults.
            try engine.qualitySetting("glsl-shaders", "")
            for scaler in ["scale", "cscale", "dscale"] { try engine.qualitySetting(scaler, "bilinear") }
            for option in ["deband", "sigmoid-upscaling"] { try engine.qualitySetting(option, "no") }
            return
        }
        guard let preset, let paths else { return }
        for (name, value) in preset.options.sorted(by: { $0.key < $1.key }) { try engine.qualitySetting(name, value) }
        try engine.qualitySetting("glsl-shaders", paths.joined(separator: ":"))
    }

    /// Explicit probe mode writes this allowlist only; media metadata, request
    /// headers and URLs are never serialized. One atomic file replaces the last.
    func playbackProbe() -> JSONValue {
        guard let engine else { return .null }
        func number(_ key: String) -> JSONValue {
            guard let value = Double(engine.string(key)), value.isFinite else { return .null }
            return .number(max(0, value))
        }
        func description(_ value: String) -> String {
            String(value.prefix(512))
                .replacingOccurrences(of: #"(?i)\b[a-z][a-z0-9+.-]*://\S+"#, with: "[redacted]", options: .regularExpression)
                .replacingOccurrences(of: #"(?:/[^\s]+)+"#, with: "[path]", options: .regularExpression)
                .components(separatedBy: .controlCharacters).joined(separator: " ")
        }
        let passes = engine.json("vo-passes")
        let passDescriptions = Dictionary(uniqueKeysWithValues: ["fresh", "redraw"].map { kind in
            (kind, JSONValue.array((passes[kind].array ?? []).prefix(128).compactMap { pass in
                pass["desc"].string.map { .string(description($0)) }
            }))
        })
        let passTimings = Dictionary(uniqueKeysWithValues: ["fresh", "redraw"].map { kind in
            (kind, JSONValue.array((passes[kind].array ?? []).prefix(128).map { pass in
                .object(Dictionary(uniqueKeysWithValues: ["avg", "peak", "last"].map { field in
                    let value = pass[field].number
                    return (field, value.map { $0.isFinite && $0 >= 0 ? JSONValue.number($0) : .null } ?? .null)
                }))
            }))
        })
        return .object([
            "capturedAt": .string(ISO8601DateFormatter().string(from: Date())),
            "position": .number(position), "paused": .bool(paused), "buffering": .bool(buffering),
            "qualityPreset": .string(qualityPreset),
            "nativeInterpolation": engine.json("vf-metadata/" + NativeInterpolation.label),
            "playbackSettings": .object(settings.values.mapValues(JSONValue.string)),
            "effectiveQualityPreset": .string(effectiveQualityPreset),
            "estimated-vf-fps": number("estimated-vf-fps"),
            "display-fps": number("display-fps"), "estimated-display-fps": number("estimated-display-fps"),
            "processing": .object(Dictionary(uniqueKeysWithValues: ["deband", "sigmoid-upscaling", "dither", "video-sync", "hwdec-current", "interpolation"].map { ($0, .string(description(engine.string($0)))) })),
            "scalers": .object(Dictionary(uniqueKeysWithValues: ["scale", "cscale", "dscale"].map { ($0, .string(engine.string($0))) })),
            "drawableSize": .object(["width": .number(Double(surface.metal.drawableSize.width)), "height": .number(Double(surface.metal.drawableSize.height))]),
            "cache": .object(["seconds": number("demuxer-cache-duration"), "percent": number("cache-buffering-state")]),
            "videoParams": .object(["width": number("video-params/w"), "height": number("video-params/h"), "codec": .string(description(engine.string("video-codec")))]),
            "frame-drop-count": number("frame-drop-count"), "decoder-frame-drop-count": number("decoder-frame-drop-count"),
            "glsl-shaders": .array((engine.json("glsl-shaders").array ?? []).prefix(64).compactMap { value in
                value.string.map { .string(URL(fileURLWithPath: $0).lastPathComponent) }
            }),
            "vo-passes": .object(passDescriptions), "vo-pass-nanoseconds": .object(passTimings)
        ])
    }
}
