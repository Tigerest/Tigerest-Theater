package top.tigerest.theater

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class AppUpdatePolicyTest {
    private val digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    private fun release(version: String, name: String = "TigerestTheater-$version-android.apk") = JSONObject()
        .put("tag_name", "v$version").put("draft", false).put("prerelease", false)
        .put("html_url", "https://github.com/Tigerest/Tigerest-Theater/releases/tag/v$version")
        .put("body", "New playback fixes")
        .put("assets", JSONArray().put(JSONObject().put("name", name).put("state", "uploaded").put("size", 3)
            .put("digest", "sha256:$digest")
            .put("browser_download_url", "https://github.com/Tigerest/Tigerest-Theater/releases/download/v$version/$name")))

    @Test fun selectsNumericNewestStableAndAllowsSameVersionAfterPrerelease() {
        val releases = JSONArray().put(release("2.9.0")).put(release("2.10.0"))
            .put(release("3.0.0").put("draft", true)).put(release("4.0.0").put("prerelease", true))
        assertEquals("2.10.0", AppUpdatePolicy.select(releases, "2.8.0")?.version)
        assertEquals("2.10.0", AppUpdatePolicy.select(releases, "2.10.0-rc.1")?.version)
        assertNull(AppUpdatePolicy.select(releases, "2.10.0"))
        assertNull(AppUpdatePolicy.select(releases, "3.0.0"))
        assertNull(AppUpdatePolicy.select(releases, "2.10.0+build-1"))
    }

    @Test fun readsFixReleases() {
        // A fourth number marks a fix release; 2.9.5 and 2.9.5.0 are the same version.
        assertEquals("2.9.5.1", AppUpdatePolicy.select(JSONArray().put(release("2.9.5")).put(release("2.9.5.1")).put(release("2.9.4.9")), "2.9.5")?.version)
        assertEquals("2.9.5.10", AppUpdatePolicy.select(JSONArray().put(release("2.9.5.2")).put(release("2.9.5.10")), "2.9.5.1")?.version)
        assertEquals("2.9.6", AppUpdatePolicy.select(JSONArray().put(release("2.9.5.2")).put(release("2.9.6")), "2.9.5.1")?.version)
        assertNull(AppUpdatePolicy.select(JSONArray().put(release("2.9.5")).put(release("2.9.5.1")), "2.9.5.1"))
        assertEquals("2.9.5.1", AppUpdatePolicy.select(JSONArray().put(release("2.9.5.1")), "2.9.5.1-rc.1")?.version)
        for (bad in listOf("2.9.5.0", "2.9.5.100", "2.9.5.01", "2.9.5.1.1")) assertNull(bad, AppUpdatePolicy.select(JSONArray().put(release(bad)), "2.9.5"))
        // A fix published for another platform only is not offered here.
        assertNull(AppUpdatePolicy.select(JSONArray().put(release("2.9.5.1", "TigerestTheater-2.9.5.1-x64.exe")), "2.9.5"))
    }

    @Test fun buildVersionCodeKeepsTheFixNumberInTheLastTwoDigits() {
        val parts = BuildConfig.VERSION_NAME.split('.').map(String::toInt)
        assertEquals(parts[0] * 1_000_000 + parts[1] * 10_000 + parts[2] * 100 + parts.getOrElse(3) { 0 }, BuildConfig.VERSION_CODE)
        // Empty only for a build made outside a Git checkout, such as a source package.
        assertTrue(BuildConfig.GIT_REVISION.isEmpty() || BuildConfig.GIT_REVISION.matches(Regex("[0-9a-f]{8,}")))
    }

    @Test fun rejectsMissingDigestWrongAssetAndUntrustedUrls() {
        for (bad in listOf(
            release("2.5.0", "TigerestTheater-2.5.0-android-sources.zip"),
            release("2.5.0").apply { getJSONArray("assets").getJSONObject(0).remove("digest") },
            release("2.5.0").apply { getJSONArray("assets").getJSONObject(0).put("size", 0) },
            release("2.5.0").apply { getJSONArray("assets").getJSONObject(0).put("size", 3.5) },
            release("2.5.0").apply { getJSONArray("assets").getJSONObject(0).put("digest", "sha256:no") },
            release("2.5.0").apply { getJSONArray("assets").getJSONObject(0).put("browser_download_url", "https://evil.example/update.apk") },
            release("2.5.0").apply { getJSONArray("assets").getJSONObject(0).put("browser_download_url", "http://github.com/Tigerest/Tigerest-Theater/releases/download/v2.5.0/TigerestTheater-2.5.0-android.apk") },
            release("2.5.0").put("html_url", "https://github.com/attacker/Theater/releases/tag/v2.5.0"),
            release("2.5.0-beta"), release("2.5.0").put("tag_name", "release-2.5.0")
        )) assertNull(bad.toString(), AppUpdatePolicy.select(JSONArray().put(bad), "2.4.1"))
    }

    @Test fun readsNetdiskMirrorsFromReleaseNotes() {
        val marked = release("2.5.0").put("body", "Fixed\n<!-- tigerest-mirrors {\"quark\":\"https://pan.quark.cn/s/abc123def\",\"baidu\":\"https://pan.baidu.com/s/1AbC-d_E?pwd=x7k2\"} -->")
        val releases = JSONArray().put(release("2.4.5")).put(marked)
        val selected = AppUpdatePolicy.select(releases, "2.4.1")!!
        assertEquals("Fixed", selected.notes)
        assertEquals("https://pan.quark.cn/s/abc123def", selected.quarkUrl)
        assertEquals("https://pan.baidu.com/s/1AbC-d_E?pwd=x7k2", selected.baiduUrl)
        // The remembered form selects the same package again, and nothing once it is installed.
        val cached = AppUpdatePolicy.cachedRelease(releases, selected)!!
        assertEquals(selected, AppUpdatePolicy.select(JSONArray().put(cached), "2.4.1"))
        assertNull(AppUpdatePolicy.select(JSONArray().put(cached), "2.5.0"))
        val untrusted = release("2.5.0").put("body", "<!-- tigerest-mirrors {\"quark\":\"https://evil.example/s/abc123def\",\"baidu\":\"http://pan.baidu.com/s/1AbCdEf\"} -->")
        val plain = AppUpdatePolicy.select(JSONArray().put(untrusted), "2.4.1")!!
        assertEquals(AppUpdatePolicy.DEFAULT_QUARK_SHARE, plain.quarkUrl); assertEquals(AppUpdatePolicy.DEFAULT_BAIDU_SHARE, plain.baiduUrl); assertEquals("", plain.notes)
    }

    @Test fun usesBuiltInNetdiskSharesWithoutAMarker() {
        val selected = AppUpdatePolicy.select(JSONArray().put(release("2.5.0")), "2.4.1")!!
        assertEquals("https://pan.quark.cn/s/88e6f7a795b4", selected.quarkUrl)
        assertEquals("https://pan.baidu.com/s/58azzOU4piiB3miyZqA1dig", selected.baiduUrl)
    }

    @Test fun checksActualBytesAndExactLength() {
        val selected = AppUpdatePolicy.select(JSONArray().put(release("2.5.0")), "2.4.1")!!
        val file = File.createTempFile("update", ".apk")
        try {
            file.writeText("abc")
            AppUpdatePolicy.verifyFile(file, selected)
            file.writeText("abd")
            assertThrows(IllegalArgumentException::class.java) { AppUpdatePolicy.verifyFile(file, selected) }
            file.writeText("abcd")
            assertThrows(IllegalArgumentException::class.java) { AppUpdatePolicy.verifyFile(file, selected) }
        } finally { file.delete() }
    }

    @Test fun validatesPackageSignerVersionAndDeviceAbi() {
        val installed = ApkIdentity("top.tigerest.theater", 2040103, "2.4.1", setOf("certificate"))
        val update = ApkIdentity("top.tigerest.theater", 2050000, "2.5.0", setOf("certificate"))
        AppUpdatePolicy.verifyApk(update, installed, "2.5.0", setOf("arm64-v8a", "x86_64"), listOf("arm64-v8a"))
        for (bad in listOf(update.copy(packageName = "attacker"), update.copy(versionCode = 2040103),
            update.copy(versionName = "2.6.0"), update.copy(signers = setOf("other")), update.copy(signers = emptySet()))) {
            assertThrows(IllegalArgumentException::class.java) { AppUpdatePolicy.verifyApk(bad, installed, "2.5.0", setOf("arm64-v8a"), listOf("arm64-v8a")) }
        }
        assertThrows(IllegalArgumentException::class.java) { AppUpdatePolicy.verifyApk(update, installed, "2.5.0", setOf("x86_64"), listOf("arm64-v8a")) }
    }
}
