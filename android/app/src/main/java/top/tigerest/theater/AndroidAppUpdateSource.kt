package top.tigerest.theater

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONArray
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.zip.ZipFile

/** All production URLs originate from the fixed official feed and validated release metadata. */
class AndroidAppUpdateSource(private val context: Context): AppUpdateSource {
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build()
    private val cancellation = AtomicLong()
    @Volatile private var call: Call? = null
    @Volatile private var fixture = ""

    fun debugFixture(address: String) {
        check(BuildConfig.DEBUG) { "发布版不支持测试更新源" }
        val url = address.toHttpUrl()
        require(url.scheme == "http" && url.host == "127.0.0.1" && url.username.isEmpty() && url.password.isEmpty() && url.encodedPath == "/" && url.query == null && url.fragment == null) { "更新测试源必须是本机回环地址" }
        fixture = address.trimEnd('/')
    }

    /** [resumeFrom] is null for release metadata and the kept byte count for a package download. */
    private fun open(address: String, accept: String, cancelled: () -> Boolean, resumeFrom: Long? = null): Response {
        var url = address.toHttpUrl()
        repeat(5) { redirect ->
            if (cancelled()) throw InterruptedIOException("cancelled")
            val active = http.newCall(Request.Builder().url(url).header("User-Agent", "Tigerest-Theater-Android/${BuildConfig.VERSION_NAME}")
                .header("Accept", accept).header("Accept-Encoding", "identity").header("X-GitHub-Api-Version", "2022-11-28")
                .apply { if (resumeFrom != null && resumeFrom > 0) header("Range", "bytes=$resumeFrom-") }.build())
            call = active
            if (cancelled()) { active.cancel(); throw InterruptedIOException("cancelled") }
            val response = active.execute()
            if (response.code !in setOf(301, 302, 303, 307, 308)) {
                // writePackage restarts a kept prefix the server rejects with 416.
                if (!response.isSuccessful && !(resumeFrom != null && response.code == 416)) {
                    val code = response.code; response.close()
                    val message = if (code == 403 || code == 429) "更新服务暂时限流，请稍后重试" else "更新服务响应失败（$code），请稍后重试"
                    // Package downloads resume after server faults, throttling and an expired asset signature.
                    if (resumeFrom != null && (code == 403 || code == 408 || code == 429 || code >= 500)) throw IOException(message)
                    throw IllegalStateException(message)
                }
                return response
            }
            val location = response.header("Location"); response.close()
            val next = location?.let { url.resolve(it) }
            require(redirect < 4 && next != null && next.scheme == "https" && next.username.isEmpty() && next.password.isEmpty()
                && next.port == 443 && next.host in setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")) { "更新下载重定向不受信任" }
            url = next
        }
        error("更新下载重定向过多")
    }

    override fun releases(): JSONArray {
        val generation = cancellation.get()
        val address = if (BuildConfig.DEBUG && fixture.isNotEmpty()) "$fixture/releases" else "https://api.github.com/repos/Tigerest/Tigerest-Theater/releases?per_page=30"
        return open(address, "application/vnd.github+json", { generation != cancellation.get() }).use { response ->
            val bytes = response.body?.byteStream()?.readNBytes(2 * 1024 * 1024 + 1) ?: throw IllegalStateException("更新服务返回空数据")
            require(bytes.size <= 2 * 1024 * 1024) { "更新信息过大" }
            JSONArray(bytes.toString(Charsets.UTF_8))
        }
    }

    override fun download(candidate: AppUpdateCandidate, destination: File, cancelled: () -> Boolean, progress: (Long) -> Unit) {
        val address = if (BuildConfig.DEBUG && fixture.isNotEmpty()) "$fixture/download" else candidate.downloadUrl
        val offset = resumeOffset(destination, candidate)
        // Each attempt starts at the release URL because the signed asset redirect expires.
        open(address, "application/octet-stream", cancelled, offset).use { response ->
            writePackage(response, candidate, destination, offset, cancelled, progress)
        }
    }

    private fun identity(info: PackageInfo) = ApkIdentity(info.packageName, info.longVersionCode, info.versionName ?: "",
        info.signingInfo?.apkContentsSigners?.map { signature -> MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) } }?.toSet() ?: emptySet())

    override fun validateApk(file: File, candidate: AppUpdateCandidate) {
        val flags = PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong())
        val installed = context.packageManager.getPackageInfo(context.packageName, flags)
        val archive = context.packageManager.getPackageArchiveInfo(file.absolutePath, flags) ?: throw IllegalArgumentException("更新包不是有效的 APK")
        require((archive.applicationInfo?.minSdkVersion ?: Int.MAX_VALUE) <= Build.VERSION.SDK_INT) { "更新包需要更高版本的 Android" }
        val abis = ZipFile(file).use { zip ->
            Build.SUPPORTED_ABIS.filter { abi -> zip.getEntry("lib/$abi/libmpv.so") != null && zip.getEntry("lib/$abi/libplayer.so") != null }.toSet()
        }
        AppUpdatePolicy.verifyApk(identity(archive), identity(installed), candidate.version, abis, Build.SUPPORTED_ABIS.toList())
    }
    override fun cancel() { cancellation.incrementAndGet(); call?.cancel(); call = null }
}
