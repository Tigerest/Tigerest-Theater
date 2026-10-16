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

    @Test fun releaseManifestStandsInForRateLimitedApi() {
        val repository = "https://github.com/Tigerest/Tigerest-Theater/releases"
        assertEquals("v2.8.0", AppUpdatePolicy.latestTag("$repository/tag/v2.8.0"))
        for (bad in listOf("$repository/tag/v2.8.0-beta", "$repository/tag/v2.8.0/extra", "https://github.com/Other/Repo/releases/tag/v2.8.0", "$repository/latest"))
            assertNull(bad, AppUpdatePolicy.latestTag(bad))
        assertEquals("TigerestTheater-2.8.0-RELEASE-MANIFEST.json", AppUpdatePolicy.manifestName("v2.8.0"))
        fun file(name: String, size: Any = 3) = JSONObject().put("name", name).put("size", size).put("sha256", digest)
        val manifest = JSONObject().put("version", "2.8.0").put("files", JSONArray()
            .put(file("TigerestTheater-2.8.0-x64.exe", 5)).put(file("TigerestTheater-2.8.0-android.apk")))
        val selected = AppUpdatePolicy.select(AppUpdatePolicy.manifestRelease(manifest, "v2.8.0"), "2.7.0")!!
        assertEquals(AppUpdateCandidate("2.8.0", "$repository/tag/v2.8.0", "", 3, digest,
            "$repository/download/v2.8.0/TigerestTheater-2.8.0-android.apk"), selected)
        assertNull(AppUpdatePolicy.select(AppUpdatePolicy.manifestRelease(manifest, "v2.8.0"), "2.8.0"))
        assertEquals(0, AppUpdatePolicy.manifestRelease(manifest, "v2.9.0").length())
        assertEquals(0, AppUpdatePolicy.manifestRelease(JSONObject(manifest.toString()).put("files", JSONArray().put(file("TigerestTheater-2.8.0-x64.exe"))), "v2.8.0").length())
        val oversized = JSONObject(manifest.toString()).put("files", JSONArray().put(file("TigerestTheater-2.8.0-android.apk", 2L * 1024 * 1024 * 1024)))
        assertNull(AppUpdatePolicy.select(AppUpdatePolicy.manifestRelease(oversized, "v2.8.0"), "2.7.0"))
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
