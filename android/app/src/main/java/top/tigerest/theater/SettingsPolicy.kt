package top.tigerest.theater
object SettingsPolicy {
 /** A default that differs by platform: Android's own entry, else the one for all other platforms, else the first. */
 fun platformDefault(values: org.json.JSONArray): Any {
  var others: Any? = null
  for (i in 0 until values.length()) {
   val entry = values.optJSONObject(i) ?: continue
   val platforms = entry.optJSONArray("platforms")
   if (platforms == null) { if (others == null) others = entry.opt("value") }
   else if ((0 until platforms.length()).any { platforms.optString(it) == "android" }) return entry.opt("value") ?: ""
  }
  return others ?: values.optJSONObject(0)?.opt("value") ?: ""
 }
 fun validate(section: String, key: String, value: Any, default: Any): Any {
  if (default is Boolean) require(value is Boolean) { "设置需要布尔值" }
  if (default is Number) require(value is Number && value.toDouble().isFinite()) { "设置需要有效数字" }
  // Remembered servers are one bounded JSON document (native/serverHistory.js).
  val textLimit = if (section == "main" && key == "knownServers") 32768 else 4096
  if (default is String) require(value is String && value.length <= textLimit) { "设置需要有效文本" }
  if (section == "main" && key == "knownServers" && value.toString().isNotBlank()) {
   val servers = runCatching { org.json.JSONObject(value.toString()).getJSONArray("servers") }.getOrNull()
   require(servers != null && servers.length() <= 20) { "服务器列表格式无效" }
  }
  val range = when("$section.$key") {
   "video.cache" -> 10.0..500.0; "video.default_playback_speed" -> 0.25..4.0
   "danmaku.opacity", "danmaku.displayarea" -> 0.0..1.0; "danmaku.fontsize" -> 10.0..120.0
   "danmaku.scrolltime" -> 2.0..40.0; "danmaku.outline", "danmaku.shadow" -> 0.0..10.0
   "subtitles.vertical_position" -> -1.0..150.0
   else -> null
  }
  if (range != null) { val number = value.toString().toDoubleOrNull(); require(number != null && number in range) { "设置值超出范围" } }
  // A whole percentage, or -1 to follow the placement (mpv's sub-pos).
  if (section == "subtitles" && key == "vertical_position") return value.toString().toDouble().let { if (it < 0) -1 else Math.round(it).toInt() }
  if (section == "video" && key == "hardwareDecoding") require(value in listOf("safe","enabled","copy","disabled")) { "不支持的硬解模式" }
  if (section == "main" && key == "userWebClient" && value.toString().isNotBlank()) ServerAddress.base(value.toString())
  if (section == "danmaku" && key == "apiServer" && value.toString().isNotBlank()) ServerAddress.base(value.toString())
  return value
 }
}
