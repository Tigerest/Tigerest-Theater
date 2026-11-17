import Foundation
import AppleCore

/// One choice of a television setting: the stored value and its title.
struct TVSettingChoice: Identifiable, Hashable {
    let value: String
    let title: String
    var id: String { value }
}

/// A desktop playback setting that also makes sense on a television. Keys
/// follow the desktop's `section.key` names; choices follow its settings page,
/// trimmed to what a remote and a screen across the room need.
struct TVSettingDefinition: Identifiable {
    let key: String
    let title: String
    let help: String?
    let choices: [TVSettingChoice]
    let defaultValue: String
    var id: String { key }
}

struct TVSettingSection: Identifiable {
    let title: String
    let settings: [TVSettingDefinition]
    var id: String { title }
}

/// The Apple TV's playback settings (设置 → 播放设置), kept on the device and
/// applied when a video opens. Defaults keep the television's playback as it
/// was before these settings existed. Fixture runs never read or write them.
@MainActor final class TVPlaybackSettings: ObservableObject {
    static let storageKey = "tv.playbackSettings"
    private static func choices(_ pairs: [(String, String)]) -> [TVSettingChoice] { pairs.map { TVSettingChoice(value: $0.0, title: $0.1) } }
    // Separate declarations keep each literal within the type checker's reach.
    private static let colors: [(String, String)] = [("", "默认"), ("#FFFFFF", "白色"), ("#EEEEEE", "浅灰色"), ("#CCCCCC", "柔和浅灰色"), ("#FBF93E", "黄色"), ("#FFFFCC", "浅黄色"), ("#EEEDB8", "柔和浅黄色"), ("#000000", "黑色")]
    private static let delays: [(String, String)] = {
        var result: [(String, String)] = []
        for ms in stride(from: -300, through: 300, by: 50) {
            result.append((String(ms), ms == 0 ? "0 ms（默认）" : (ms > 0 ? "+\(ms) ms" : "\(ms) ms")))
        }
        return result
    }()
    private static let interpolationSection = TVSettingSection(title: "原生补帧", settings: [
            TVSettingDefinition(key: "video.nativeInterpolation", title: "系统原生补帧",
                                help: "用 Apple TV 的 VideoToolbox 低延迟插帧补到 2 倍帧率（23.976 帧变 47.95 帧），不需要下载模型。只处理 1080p 以内、30 fps 以内的 SDR 视频，其他片源保持原帧；镜头切换和停住的画面不补，跟不上播放时本集恢复原帧。重新打开视频后生效。",
                                choices: choices([("off", "关闭"), ("efficient", "开启（低延迟插帧，2 倍）")]), defaultValue: "off"),
    ])
    private static let videoSection = TVSettingSection(title: "视频", settings: [
            TVSettingDefinition(key: "video.sync_mode", title: "音画同步模式", help: "「显示重采样」让画面贴合电视刷新率，偶有轻微变速；音画不同步时改回「跟随音频时钟」。",
                                choices: choices([("audio", "跟随音频时钟"), ("display-resample", "显示重采样"), ("display-adrop", "丢弃/补充音频帧")]), defaultValue: "audio"),
            TVSettingDefinition(key: "video.aspect", title: "画面比例", help: nil,
                                choices: choices([("normal", "保持原始比例"), ("zoom", "缩放填充"), ("force_4_3", "强制 4:3"), ("force_16_9", "强制 16:9"), ("force_16_9_if_4_3", "仅将 4:3 强制为 16:9"), ("stretch", "拉伸填满"), ("noscaling", "不缩放")]), defaultValue: "normal"),
            TVSettingDefinition(key: "video.deinterlace", title: "视频去隔行", help: nil, choices: choices([("no", "关闭"), ("yes", "开启")]), defaultValue: "no"),
            TVSettingDefinition(key: "mpv.toneMapping", title: "HDR 色调映射", help: "HDR 片源转成电视当前画面时使用的曲线。",
                                choices: choices([("", "自动（默认）"), ("bt.2446a", "BT.2446A（自然耐看）"), ("bt.2390", "BT.2390（高光保留）"), ("mobius", "莫比乌斯曲线"), ("reinhard", "莱因哈德曲线"), ("hable", "Hable 电影曲线"), ("clip", "直接裁切高光")]), defaultValue: ""),
    ])
    private static let cacheSection = TVSettingSection(title: "缓存", settings: [
            TVSettingDefinition(key: "video.cache", title: "网络缓存大小", help: nil, choices: choices([("75", "75 MB"), ("150", "150 MB（推荐）"), ("500", "500 MB")]), defaultValue: "150"),
            TVSettingDefinition(key: "mpv.demuxerMaxBackBytes", title: "回退缓存", help: "已播放部分保留在内存中的大小，回退 10 秒时不必重新下载。",
                                choices: choices([("10", "10 MB"), ("50", "50 MB（推荐）"), ("100", "100 MB"), ("250", "250 MB")]), defaultValue: "50"),
            TVSettingDefinition(key: "mpv.cachePause", title: "缓存不足时自动暂停", help: nil, choices: choices([("yes", "开启"), ("no", "关闭")]), defaultValue: "yes"),
    ])
    private static let audioSection = TVSettingSection(title: "音频", settings: [
            TVSettingDefinition(key: "audio.channels", title: "最大输出声道", help: nil,
                                choices: choices([("", "自动（默认）"), ("2.0", "立体声（2.0）"), ("5.1,2.0", "最高 5.1 环绕声"), ("7.1,5.1,2.0", "最高 7.1 环绕声")]), defaultValue: ""),
            TVSettingDefinition(key: "audio.normalize", title: "音量标准化", help: "多声道下混成立体声时统一音量，避免爆音。", choices: choices([("no", "关闭"), ("yes", "开启")]), defaultValue: "no"),
            TVSettingDefinition(key: "video.audio_delay.normal", title: "音画偏移", help: "声音比画面早时调成正数，晚时调成负数。回音壁或功放有延迟时使用。",
                                choices: choices(delays), defaultValue: "0"),
    ])
    private static let subtitleSection = TVSettingSection(title: "字幕", settings: [
            TVSettingDefinition(key: "subtitles.size", title: "字幕字号", help: "纯文本字幕的大小，已按观看距离放大；ASS 字幕保留脚本里的大小。",
                                choices: choices([("24", "较小"), ("32", "标准（默认）"), ("42", "较大"), ("60", "超大")]), defaultValue: "32"),
            TVSettingDefinition(key: "subtitles.color", title: "字幕文字颜色", help: nil, choices: choices(colors), defaultValue: ""),
            TVSettingDefinition(key: "subtitles.border_size", title: "字幕边框粗细", help: nil,
                                choices: choices([("-1", "默认"), ("0", "无边框"), ("1", "极细"), ("2", "较细"), ("3", "标准"), ("4", "较粗"), ("5", "超粗")]), defaultValue: "-1"),
            TVSettingDefinition(key: "subtitles.border_color", title: "字幕边框颜色", help: nil, choices: choices(colors), defaultValue: ""),
            TVSettingDefinition(key: "subtitles.background", title: "字幕背景", help: nil,
                                choices: choices([("", "无"), ("#80000000", "半透明黑色"), ("#C0000000", "较深黑色"), ("#FF000000", "黑色")]), defaultValue: ""),
            TVSettingDefinition(key: "subtitles.placement", title: "字幕位置", help: nil,
                                choices: choices([("", "默认"), ("center,bottom", "下方居中"), ("left,bottom", "左下"), ("right,bottom", "右下"), ("center,top", "上方居中"), ("left,top", "左上"), ("right,top", "右上")]), defaultValue: ""),
            TVSettingDefinition(key: "subtitles.vertical_position", title: "字幕垂直位置", help: "电视边缘被裁掉一部分时，把字幕往上移。优先于字幕位置里的上下。",
                                choices: choices([("-1", "默认"), ("100", "100%（最底部）"), ("95", "95%"), ("90", "90%"), ("85", "85%"), ("80", "80%")]), defaultValue: "-1"),
            TVSettingDefinition(key: "subtitles.bold", title: "字幕粗体", help: nil, choices: choices([("no", "关闭"), ("yes", "开启")]), defaultValue: "no"),
            TVSettingDefinition(key: "subtitles.ass_style_override", title: "ASS 字幕样式覆盖", help: "「遵循字幕脚本」保留特效字幕的原样；需要统一字号和颜色时选「强制覆盖全部样式」。",
                                choices: choices([("no", "遵循字幕脚本（默认）"), ("scale", "仅额外覆盖缩放"), ("yes", "应用客户端样式"), ("force", "强制覆盖全部样式"), ("strip", "移除 ASS 样式与标签")]), defaultValue: "no"),
    ])
    static let sections: [TVSettingSection] = [interpolationSection, videoSection, cacheSection, audioSection, subtitleSection]
    static var all: [TVSettingDefinition] { sections.flatMap(\.settings) }

    @Published private(set) var values: [String: String] = [:]
    private let persistent: Bool
    init(fixtureMode: Bool) {
        persistent = !fixtureMode
        let saved = persistent ? UserDefaults.standard.dictionary(forKey: Self.storageKey) as? [String: String] ?? [:] : [:]
        for definition in Self.all {
            let value = saved[definition.key].flatMap { value in definition.choices.contains { $0.value == value } ? value : nil }
            values[definition.key] = value ?? definition.defaultValue
        }
    }
    func value(_ key: String) -> String { values[key] ?? "" }
    func title(_ definition: TVSettingDefinition) -> String {
        definition.choices.first { $0.value == value(definition.key) }?.title ?? ""
    }
    var isDefault: Bool { Self.all.allSatisfy { value($0.key) == $0.defaultValue } }
    func set(_ key: String, _ value: String) {
        guard let definition = Self.all.first(where: { $0.key == key }), definition.choices.contains(where: { $0.value == value }) else { return }
        values[key] = value
        save()
    }
    func reset() {
        for definition in Self.all { values[definition.key] = definition.defaultValue }
        save()
    }
    private func save() { if persistent { UserDefaults.standard.set(values, forKey: Self.storageKey) } }

    /// The interpolation filter for these settings, nil when off. tvOS has
    /// only the efficient processor, and a 60 Hz television shows twice the
    /// source rate more evenly than four times.
    var interpolationFilter: String? {
        NativeInterpolation.filter(mode: value("video.nativeInterpolation"), target: "2x", displayFps: 60, qualityAvailable: false)
    }

    /// Sets the engine for these settings before a file opens, after
    /// TVSubtitleController.begin (whose television defaults they replace).
    /// Each option stands alone: one the engine refuses keeps its default and
    /// is returned, and playback goes on.
    func apply(to engine: MPVEngine) -> [String] {
        var refused: [String] = []
        func set(_ name: String, _ value: String?) {
            do { try engine.setting(name, value) } catch { refused.append(name) }
        }
        func bytes(_ key: String) -> String { String((Int(value(key)) ?? 0) * 1_048_576) }
        set("video-sync", value("video.sync_mode"))
        set("deinterlace", value("video.deinterlace"))
        set("tone-mapping", value("mpv.toneMapping").isEmpty ? nil : value("mpv.toneMapping"))
        set("demuxer-max-bytes", bytes("video.cache"))
        set("demuxer-max-back-bytes", bytes("mpv.demuxerMaxBackBytes"))
        set("cache-pause", value("mpv.cachePause"))
        set("audio-channels", value("audio.channels").isEmpty ? nil : value("audio.channels"))
        set("audio-normalize-downmix", value("audio.normalize"))
        set("audio-delay", String((Double(value("video.audio_delay.normal")) ?? 0) / 1000))
        // 1.15: plain text a little larger than mpv's size for viewing distance.
        set("sub-scale", String((Double(value("subtitles.size")) ?? 32) / 32 * 1.15))
        set("sub-color", value("subtitles.color").isEmpty ? nil : value("subtitles.color"))
        let border = Int(value("subtitles.border_size")) ?? -1
        set("sub-border-size", border >= 0 ? String(border) : nil)
        set("sub-border-color", value("subtitles.border_color").isEmpty ? nil : value("subtitles.border_color"))
        // A box behind the text needs the background-box border style.
        let background = value("subtitles.background")
        set("sub-border-style", background.isEmpty ? nil : "background-box")
        set("sub-back-color", background.isEmpty ? nil : background)
        set("sub-bold", value("subtitles.bold"))
        set("sub-ass-override", value("subtitles.ass_style_override"))
        let placement = value("subtitles.placement").split(separator: ",")
        set("sub-align-x", placement.count == 2 ? String(placement[0]) : nil)
        // A vertical position of its own goes before the one the placement implies (the desktop's rule).
        let vertical = Int(value("subtitles.vertical_position")) ?? -1
        set("sub-pos", vertical >= 0 ? String(min(vertical, 150)) : placement.count == 2 ? (placement[1] == "bottom" ? "100" : "10") : nil)
        return refused
    }

    /// The aspect ratio, once the video's own is known (as the iPad does).
    func applyAspect(to engine: MPVEngine) throws {
        let mode = value("video.aspect")
        let sourceAspect = engine.number("video-params/aspect")
        let force = mode == "force_4_3" ? "4:3" : (mode == "force_16_9" || (mode == "force_16_9_if_4_3" && abs(sourceAspect - 4 / 3) < 0.1) ? "16:9" : "no")
        try engine.set("video-unscaled", mode == "noscaling" ? "yes" : "no")
        try engine.set("video-aspect-override", force)
        try engine.set("keepaspect", mode == "stretch" ? "no" : "yes")
        try engine.set("panscan", mode == "zoom" ? "1" : "0")
    }
}
