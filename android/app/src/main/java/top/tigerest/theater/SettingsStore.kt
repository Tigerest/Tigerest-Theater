package top.tigerest.theater

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("client-settings", Context.MODE_PRIVATE)
    private val source = JSONArray(context.assets.open("shared/settings_description.json").bufferedReader().use { it.readText() })
    private val defaults = JSONObject()
    val values = JSONObject()
    val descriptions = JSONObject()
    val sections = JSONArray()
    var changed: (String, JSONObject) -> Unit = { _, _ -> }
    private val supported = mapOf(
        "home" to setOf("displayOrder","libraryLayout"),
        "main" to setOf("enableMPV","allowBrowserZoom","userWebClient","serverConnectionMode","knownServers","checkForUpdates","onboardingTour"),
        "audio" to setOf("channels","normalize"),
        "video" to setOf("hardwareDecoding","deinterlace","cache","aspect","sync_mode","default_playback_speed","audio_delay.normal","force_transcode_hevc","force_transcode_4k","force_transcode_av1","force_transcode_hdr","force_transcode_hi10p","force_transcode_dovi","always_force_transcode","allow_transcode_to_hevc","prefer_transcode_to_h265"),
        "mpv" to setOf("enableDanmaku","audioLanguage","subtitleLanguage","cachePause","deband","toneMapping"),
        "subtitles" to setOf("ass_scale_border_and_shadow","ass_style_override","vertical_position","placement","color","border_color","border_size","background_color","background_transparency","size","font","bold"),
        "danmaku" to setOf("bold","fontsize","outline","shadow","scrolltime","opacity","displayarea","apiServer")
    )
    init {
        for (i in 0 until source.length()) {
            val group = source.getJSONObject(i); val name = group.getString("section")
            if (name == "__meta__") continue
            val entries = group.optJSONArray("values") ?: JSONArray()
            val raw = JSONObject(); val visible = JSONArray()
            for (j in 0 until entries.length()) {
                val entry = entries.getJSONObject(j); val key = entry.getString("value")
                var default = entry.opt("default") ?: ""
                if (default is JSONArray) default = SettingsPolicy.platformDefault(default)
                // Android has always detected the output's channels (MaxAudioChannels 6 for Emby).
                if (name == "audio" && key == "channels") default = "auto"
                if (name == "mpv" && key == "configMode") default = "embedded"
                if (name == "video" && key == "hardwareDecoding") default = "enabled"
                if (name == "subtitles" && key == "font") default = "sans-serif"
                raw.put(key, default)
                if (key !in (supported[name] ?: emptySet()) || entry.optBoolean("hidden")) continue
                val description = JSONObject().put("key", key).put("displayName", entry.optString("display_name", key)).put("help", entry.optString("help"))
                val androidHelp = mapOf("hardwareDecoding" to "使用安卓 MediaCodec 解码；遇到异常可选择复制模式或关闭硬件解码。", "sync_mode" to "选择音视频同步时钟。弹幕始终按实际播放时间独立渲染。", "enableDanmaku" to "按播放器时间显示弹幕，可在播放页搜索、导入、屏蔽来源或调整偏移。", "cache" to "网络视频缓存上限，单位 MB。", "audio_delay.normal" to "正值延迟音频，负值提前音频，单位毫秒。")
                androidHelp[key]?.let { description.put("help",it) }
                if(name == "danmaku" && key == "bold") description.put("help","切换滚动与固定弹幕的粗体显示，立即应用。")
                // Android reads one provider; the desktop and iPad take an ordered list.
                if(name == "danmaku" && key == "apiServer") description.put("help","留空自动使用大河弹幕服务；也可填写兼容 Dandanplay API 的 HTTP(S) 服务地址，地址可以带路径。")
                if(name == "audio" && key == "channels") description.put("help","限制播放器可使用的声道数；安卓默认自动检测。")
                if(name == "subtitles" && key == "bold") description.put("help","用字体的粗体显示 SRT 等纯文本字幕；ASS 字幕保留脚本自带样式。安卓默认关闭。")
                if(name == "subtitles" && key == "vertical_position") description.put("help","0–150 的整数：100 贴着画面底部，数值越小越靠上；-1 表示按下面的「字幕位置」。")
                if(name == "mpv" && key == "enableDanmaku") description.put("displayName","启用弹幕")
                entry.optString("input_type").takeIf { it.isNotEmpty() }?.let { description.put("inputType", it) }
                entry.optJSONObject("possible_range")?.let { description.put("range", it) }
                entry.optJSONArray("possible_values")?.let { options ->
                    val choices = JSONArray(); val seen = mutableSetOf<String>()
                    for (k in 0 until options.length()) {
                        val pair = options.getJSONArray(k); val value = pair.get(0)
                        if (pair.optJSONObject(2)?.has("platforms") == true || !seen.add(value.toString()) || value == "osx_compat") continue
                        choices.put(JSONObject().put("value",value).put("title",pair.getString(1)))
                    }
                    description.put("options",choices)
                }
                visible.put(description)
            }
            defaults.put(name,JSONObject(raw.toString())); values.put(name,raw)
            if (supported.containsKey(name)) { descriptions.put(name,visible); sections.put(JSONObject().put("key",name).put("order",group.optInt("order",i))) }
        }
        val saved = runCatching { JSONObject(prefs.getString("values","{}")!!) }.getOrDefault(JSONObject())
        for (section in supported.keys) {
            val savedSection = saved.optJSONObject(section) ?: continue
            for (key in supported[section]!!) if (savedSection.has(key)) runCatching { set(section,key,savedSection.get(key),false) }
        }
        // The first-run usage tour (shared/onboardingTour.js) cannot be skipped on a
        // new install; settings an earlier version saved belong to an upgraded user.
        if (saved.optJSONObject("main")?.has("onboardingTour") != true) set("main","onboardingTour",if (prefs.contains("values")) "upgrade" else "new",false)
    }
    @Synchronized fun set(section: String, key: String, value: Any, notify: Boolean = true): Boolean {
        require(key in (supported[section] ?: emptySet())) { "此设置不适用于安卓" }
        val validated = SettingsPolicy.validate(section,key,value,defaults.getJSONObject(section).get(key))
        val description = descriptions.optJSONArray(section)
        if (description != null) for (i in 0 until description.length()) {
            val entry = description.getJSONObject(i)
            if (entry.getString("key") == key && entry.has("options")) {
                val options = entry.getJSONArray("options")
                require((0 until options.length()).any { val option = options.getJSONObject(it).get("value"); if (option is Number && validated is Number) option.toDouble() == validated.toDouble() else option.toString() == validated.toString() }) { "设置选项无效" }
            }
        }
        values.getJSONObject(section).put(key,validated)
        prefs.edit().putString("values",values.toString()).apply()
        if (notify) changed(section,JSONObject(values.getJSONObject(section).toString()))
        return true
    }
    @Synchronized fun reset(section: String): Boolean {
        require(supported.containsKey(section))
        for (key in supported[section]!!) values.getJSONObject(section).put(key,defaults.getJSONObject(section).get(key))
        prefs.edit().putString("values",values.toString()).apply(); changed(section,JSONObject(values.getJSONObject(section).toString())); return true
    }
    fun get(section: String, key: String): Any = values.getJSONObject(section).get(key)
    fun string(section: String, key: String) = get(section,key).toString()
    fun number(section: String, key: String) = string(section,key).toDoubleOrNull() ?: 0.0
    fun bool(section: String, key: String) = get(section,key) == true
}
