import Foundation

/// Apple-native frame interpolation in the iOS and tvOS apps: the
/// `tigerest-vtfi` mpv filter (apple/NativeInterpolation), the same filter the
/// Mac builds into its libmpv. Settings follow the desktop's
/// `video.nativeInterpolation` and `video.nativeInterpolationTarget`.
public enum NativeInterpolation {
    public static let label = "tigerest-vtfi"

    /// The `vf add` argument for these settings, or nil when off. Where the
    /// quality processor is missing (tvOS) the efficient one takes its place.
    /// A target of "display" follows the screen's refresh rate; a screen
    /// slower than 48 Hz cannot show more than twice 24 fps.
    public static func filter(mode: String, target: String, displayFps: Double, qualityAvailable: Bool) -> String? {
        guard mode == "quality" || mode == "efficient" else { return nil }
        let chosen = mode == "quality" && !qualityAvailable ? "efficient" : mode
        var rate = "factor=2"
        if target == "60" {
            rate = "target=60"
        } else if target == "display", displayFps.isFinite, displayFps >= 48, displayFps <= 600 {
            rate = "target=\(Int(displayFps.rounded()))"
        }
        return "@\(label):\(label)=mode=\(chosen):\(rate)"
    }

    /// The filter takes VideoToolbox frames as they leave the decoder: the
    /// copy-back mode becomes zero-copy while it runs; software decoding
    /// stays (the filter then keeps the video's own frames).
    public static func hardwareDecoding(_ hwdec: String, interpolating: Bool) -> String {
        interpolating && hwdec == "videotoolbox-copy" ? "videotoolbox" : hwdec
    }

    /// What to show once per item for a status the filter reports (its
    /// vf-metadata), nil when there is nothing to tell.
    public static func notice(status: String, fellBack: Bool) -> String? {
        if fellBack && status == "active" { return "画质优先的原生补帧跟不上播放，本集改用低功耗方式" }
        switch status {
        case "unsupported-size": return "当前分辨率保持原帧播放（原生补帧最高 1080p）"
        case "unsupported-fps": return "当前帧率保持原帧播放（原生补帧最高 30 fps）"
        case "hdr": return "HDR 视频保持原帧播放"
        case "interlaced": return "隔行视频保持原帧播放"
        case "needs-hardware-frames": return "原生补帧需要硬件解码，当前保持原帧播放"
        case "unavailable": return "这台设备不支持所选的原生补帧方式，保持原帧播放"
        case "too-slow": return "原生补帧跟不上播放，本集已恢复原帧；可以改用低功耗模式或 2 倍"
        case "failed": return "原生补帧出错，本集已恢复原帧播放"
        default: return nil
        }
    }

    /// A one-line state for the playback diagnostics, from the filter's
    /// vf-metadata (string values).
    public static func summary(_ metadata: [String: String]) -> String {
        guard let status = metadata["status"] else { return "未启用" }
        guard status == "active" else { return status }
        let source = Double(metadata["sourceFps"] ?? "") ?? 0, output = Double(metadata["outputFps"] ?? "") ?? 0
        let p95 = Double(metadata["processP95Ms"] ?? "") ?? 0
        let mode = metadata["mode"] == "efficient" ? "低功耗" : "画质优先"
        return String(format: "%@ %.3f → %.3f fps，每对源帧 %.1f ms（P95），已补 %@ 帧", mode, source, output, p95, metadata["generated"] ?? "0")
    }
}
