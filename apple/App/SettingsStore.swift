import Foundation
import AppleCore
@MainActor final class SettingsStore {
    static var nativeRifeAvailable: Bool {
        #if RIFE_NATIVE
        true
        #else
        false
        #endif
    }
    private let file: URL
    private let policy: SettingsPolicy
    private(set) var values: [String: [String: JSONValue]] = [:]
    private(set) var descriptions: [String: JSONValue] = [:]
    private(set) var sections: [JSONValue] = []
    var changed: ((String, JSONValue) -> Void)?
    private var supported: [String: Set<String>] = [
        "home": ["displayOrder", "libraryLayout"],
        "main": ["checkForUpdates", "enableMPV", "allowBrowserZoom", "userWebClient", "serverConnectionMode", "knownServers"],
        "audio": ["channels", "normalize"],
        "video": ["aiRife", "nativeInterpolation", "nativeInterpolationTarget", "hardwareDecoding", "deinterlace", "cache", "aspect", "sync_mode", "default_playback_speed", "audio_delay.normal", "force_transcode_hevc", "force_transcode_4k", "force_transcode_av1", "force_transcode_hdr", "force_transcode_hi10p", "force_transcode_dovi", "always_force_transcode", "allow_transcode_to_hevc", "prefer_transcode_to_h265"],
        "mpv": ["shaderPreset", "enableDanmaku", "audioLanguage", "subtitleLanguage", "cachePause", "deband", "toneMapping", "targetColorspaceHint",
                // The desktop's quality parameters: they override the preset only with advancedProfileOverrides on.
                "advancedProfileOverrides", "scale", "cscale", "dscale", "interpolation", "tscale", "debandIterations", "debandThreshold", "debandRange", "debandGrain",
                "sigmoidUpscaling", "correctDownscaling", "scaleAntiring", "cscaleAntiring", "gamutMappingMode", "hdrComputePeak", "ditherDepth", "blendSubtitles",
                "demuxerMaxBackBytes"],
        "subtitles": ["ass_scale_border_and_shadow", "ass_style_override", "placement", "vertical_position", "color", "border_color", "border_size", "background_color", "background_transparency", "size", "font", "bold"],
        "danmaku": ["bold", "fontsize", "outline", "shadow", "scrolltime", "opacity", "displayarea", "apiServer"]
    ]
    init(directory: URL) throws {
        file = directory.appending(path: "settings.json")
        #if !RIFE_NATIVE
        supported["video"]?.remove("aiRife")
        #endif
        #if !NATIVE_VTFI
        supported["video"]?.subtract(["nativeInterpolation", "nativeInterpolationTarget"])
        #endif
        let source = Bundle.main.url(forResource: "settings_description", withExtension: "json", subdirectory: "Web")!
        let groups = try JSONDecoder().decode([JSONValue].self, from: Data(contentsOf: source))
        for (index, group) in groups.enumerated() {
            guard let name = group["section"].string, name != "__meta__" else { continue }
            var raw: [String: JSONValue] = [:], visible: [JSONValue] = []
            for entry in group["values"].array ?? [] {
                guard let key = entry["value"].string else { continue }
                var value = entry["default"]
                if let defaults = value.array { value = defaults.first?["value"] ?? .string("") }
                if value == .null { value = .string("") }
                if name == "mpv" && key == "shaderPreset" { value = .string("native") }
                if name == "mpv" && key == "configMode" { value = .string("embedded") }
                if name == "video" && key == "hardwareDecoding" { value = .string("enabled") }
                if name == "subtitles" && key == "font" { value = .string("Source Han Sans SC") }
                // The bundled Source Han Sans has one weight; bold would be synthesized.
                if name == "subtitles" && key == "bold" { value = .bool(false) }
                raw[key] = value
                guard supported[name]?.contains(key) == true, entry["hidden"].bool != true else { continue }
                var description: [String: JSONValue] = ["key": .string(key), "displayName": entry["display_name"], "help": entry["help"]]
                if name == "video" && key == "aiRife" {
                    description["help"] = .string("实验性 RIFE 4.25 lite：对 1920×1080、BT.709 SDR、23–30 fps 片源进行 2× 补帧。快于正常速度时暂用原帧，恢复正常速度后自动恢复补帧；不支持的片源保留原帧。开关在重新打开视频后生效。")
                }
                if name == "video" && key == "hardwareDecoding" { description["help"] = .string("使用 Apple VideoToolbox 硬件解码。异常时可选择复制模式或关闭。") }
                if name == "video" && key == "nativeInterpolation" {
                    description["help"] = .string("用 Apple VideoToolbox 在设备的图形处理器和神经引擎上补帧，不需要下载模型。「画质优先」用帧率转换，鬼影最少；「低功耗」用低延迟插帧，更省电，只有 2 倍和 4 倍。处理 1080p 以内、30 fps 以内的 SDR 视频，其他片源和倍速播放保持原帧；镜头切换和停住的画面不补。跟不上播放时先改用低功耗，再跟不上就恢复原帧。开启后由它代替 RIFE，重新打开视频后生效。")
                }
                if name == "video" && key == "nativeInterpolationTarget" {
                    description["help"] = .string("「2 倍」：23.976 帧变 47.95 帧，开销最小；「60 fps」：23.976 帧变 59.94 帧；「跟随屏幕刷新率」：补到屏幕的刷新率，ProMotion 屏幕是 120 Hz（最多 5 倍）。低功耗模式只有 2 倍和 4 倍。重新打开视频后生效。")
                }
                if entry["input_type"] != .null { description["inputType"] = entry["input_type"] }
                if entry["possible_range"] != .null { description["range"] = entry["possible_range"] }
                if let choices = entry["possible_values"].array {
                    var seen = Set<String>()
                    description["options"] = .array(choices.compactMap { choice in
                        guard let pair = choice.array, pair.count >= 2,
                              pair.count < 3 || pair[2]["platforms"] == .null,
                              pair[0] != .string("osx_compat"),
                              seen.insert(String(describing: pair[0])).inserted else { return nil }
                        return .object(["value": pair[0], "title": pair[1]])
                    })
                }
                if name == "subtitles" && key == "font" {
                    description["help"] = .string("默认使用内置思源黑体，避免系统字体缺少中文字幕字形；ASS 字幕与内嵌字体仍保留自身样式。")
                    description["options"] = .array((description["options"]?.array ?? []).map { option in
                        option["value"].string == "Segoe UI"
                            ? .object(["value": .string("Source Han Sans SC"), "title": .string("思源黑体（内置）")])
                            : option
                    })
                }
                if name == "mpv" && key == "shaderPreset" {
                    description["options"] = .array([.object(["value": .string("native"), "title": .string("原生画质（无外部着色器）")])] + (description["options"]?.array ?? []))
                    description["help"] = .string("与 PC、Mac 共用三套原始着色器。之后播放使用所选预设；激进测试档较耗电。")
                }
                visible.append(.object(description))
            }
            values[name] = raw
            if supported[name] != nil {
                descriptions[name] = .array(visible)
                sections.append(.object(["key": .string(name), "order": group["order"].number.map(JSONValue.number) ?? .number(Double(index))]))
            }
        }
        values["danmaku", default: [:]]["apiServer"] = .string("")
        descriptions["danmaku"] = .array((descriptions["danmaku"]?.array ?? []) + [.object(["key": .string("apiServer"), "displayName": .string("弹幕服务地址"), "help": .string("留空使用大河弹幕服务。多个接口按顺序用逗号分隔，可在地址后用 | 或 # 添加备注，与 PC 端一致。")])])
        policy = SettingsPolicy(defaults: values)
        if let saved = try? JSONDecoder().decode([String: [String: JSONValue]].self, from: Data(contentsOf: file)) {
            for (section, entries) in saved { for (key, value) in entries { if supported[section]?.contains(key) == true, let valid = try? policy.validate(section: section, key: key, value: value) { values[section]?[key] = valid } } }
        }
        // Migrate the earlier iPad-only picker once. Thereafter the shared key
        // is authoritative, including reset and profile switching.
        let saved = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([String: [String: JSONValue]].self, from: $0) }
        if saved?["mpv"]?["shaderPreset"] == nil {
            let legacy = QualitySelection.read(directory)
            values["mpv"]?["shaderPreset"] = .string(QualitySelection.setting(for: legacy.preset))
            try JSONEncoder().encode(values).write(to: file, options: .atomic)
        }
    }
    func get(_ section: String, _ key: String) -> JSONValue { values[section]?[key] ?? .null }
    func set(_ section: String, _ key: String, _ value: JSONValue) throws {
        guard supported[section]?.contains(key) == true else { throw CoreError.invalidSetting }
        let validated = try policy.validate(section: section, key: key, value: value)
        if let choices = descriptions[section]?.array?.first(where: { $0["key"].string == key })?["options"].array,
           !choices.contains(where: { $0["value"] == validated }) { throw CoreError.invalidSetting }
        if section == "main", key == "userWebClient", let address = value.string, !address.isEmpty { _ = try ServerAddress(address) }
        if section == "danmaku", key == "apiServer", let address=value.string,!address.isEmpty {
            let entries=address.split(separator:",")
            guard !entries.isEmpty, DanmakuProvider.parse(address,embyHost:nil).count==entries.count else { throw CoreError.invalidSetting }
        }
        var next = values; next[section]?[key] = validated
        try JSONEncoder().encode(next).write(to: file, options: .atomic)
        values = next; changed?(section, .object(next[section] ?? [:]))
    }
    func setServerConnection(_ address: ServerAddress, mode: String, history: String? = nil) throws {
        guard ["custom", "tigerest"].contains(mode) else { throw CoreError.invalidSetting }
        var next = values
        next["main", default: [:]]["userWebClient"] = try policy.validate(section: "main", key: "userWebClient", value: .string(address.baseURL.absoluteString))
        next["main", default: [:]]["serverConnectionMode"] = try policy.validate(section: "main", key: "serverConnectionMode", value: .string(mode))
        if let history { next["main", default: [:]]["knownServers"] = try policy.validate(section: "main", key: "knownServers", value: .string(history)) }
        try JSONEncoder().encode(next).write(to: file, options: .atomic)
        values = next; changed?("main", .object(next["main"] ?? [:]))
    }
    func reset(_ section: String) throws {
        guard let defaults = policy.defaults[section] else { throw CoreError.invalidSetting }
        var next = values; next[section] = defaults
        try JSONEncoder().encode(next).write(to: file, options: .atomic)
        values = next; changed?(section, .object(defaults))
    }
}
