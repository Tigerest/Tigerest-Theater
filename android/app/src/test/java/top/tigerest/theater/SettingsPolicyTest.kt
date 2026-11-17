package top.tigerest.theater
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class SettingsPolicyTest {
 private fun defaults(vararg entries: Pair<Any, List<String>?>) = JSONArray().apply {
  for ((value, platforms) in entries) put(JSONObject().put("value", value).apply { if (platforms != null) put("platforms", JSONArray(platforms)) })
 }
 @Test fun aPlatformDefaultIsAndroidsOwnElseTheOneForOtherPlatforms() {
  assertEquals(false, SettingsPolicy.platformDefault(defaults(true to listOf("windows", "osx"), false to null)))
  assertEquals("2.0", SettingsPolicy.platformDefault(defaults("auto" to listOf("osx"), "2.0" to null)))
  assertEquals(42, SettingsPolicy.platformDefault(defaults(1 to listOf("windows"), 2 to null, 42 to listOf("linux", "android"))))
  assertEquals("only other platforms' entries: the first", "a", SettingsPolicy.platformDefault(defaults("a" to listOf("windows"), "b" to listOf("osx"))))
  assertEquals("", SettingsPolicy.platformDefault(JSONArray()))
 }
 @Test fun theSharedDescriptionGivesAndroidItsSubtitleDefaults() {
  val sections = JSONArray(File("../../resources/settings/settings_description.json").readText())
  val subtitles = (0 until sections.length()).map { sections.getJSONObject(it) }.single { it.optString("section") == "subtitles" }.getJSONArray("values")
  fun entry(key: String) = (0 until subtitles.length()).map { subtitles.getJSONObject(it) }.single { it.getString("value") == key }
  assertEquals("Windows and Mac draw bold subtitles; Android keeps them regular", false, SettingsPolicy.platformDefault(entry("bold").getJSONArray("default")))
  assertEquals(-1, entry("vertical_position").get("default")); assertEquals("number", entry("vertical_position").getString("input_type"))
 }
 @Test fun subtitleVerticalPositionIsAWholePercentageOrMinusOne() {
  for ((value, expected) in listOf(-1 to -1, 0 to 0, 150 to 150, 99.6 to 100, 37.2 to 37, -0.5 to -1))
   assertEquals(value.toString(), expected, SettingsPolicy.validate("subtitles", "vertical_position", value, -1))
  for (value in listOf<Any>(151, -2, 150.6, Double.NaN, "80", true))
   assertThrows(value.toString(), IllegalArgumentException::class.java) { SettingsPolicy.validate("subtitles", "vertical_position", value, -1) }
  assertEquals(true, SettingsPolicy.validate("subtitles", "bold", true, false))
  assertThrows(IllegalArgumentException::class.java) { SettingsPolicy.validate("subtitles", "bold", "yes", false) }
 }
 @Test fun rejectsNegativeCacheAndInvalidHardwareModes() {
  assertThrows(IllegalArgumentException::class.java) { SettingsPolicy.validate("video", "cache", -1, 75) }
  assertThrows(IllegalArgumentException::class.java) { SettingsPolicy.validate("video", "hardwareDecoding", "arbitrary", "enabled") }
  assertEquals(150, SettingsPolicy.validate("video", "cache", 150, 75))
 }
 @Test fun preservesBooleanAndBoundsOpacityWithoutCoercingStrings() {
  assertEquals(false, SettingsPolicy.validate("mpv", "enableDanmaku", false, true))
  assertThrows(IllegalArgumentException::class.java) { SettingsPolicy.validate("mpv", "enableDanmaku", "false", true) }
  assertThrows(IllegalArgumentException::class.java) { SettingsPolicy.validate("danmaku", "opacity", 1.5, 0.7) }
  assertEquals(0.4, SettingsPolicy.validate("danmaku", "opacity", 0.4, 0.7))
 }
}
