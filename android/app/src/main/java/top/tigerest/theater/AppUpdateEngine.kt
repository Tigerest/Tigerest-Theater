package top.tigerest.theater

import java.io.File
import java.io.IOException
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import org.json.JSONArray
import org.json.JSONObject

interface AppUpdateSource {
    fun releases(): JSONArray
    /** Continues a prefix already in [destination]; an IOException means the attempt can be resumed. */
    fun download(candidate: AppUpdateCandidate, destination: File, cancelled: () -> Boolean, progress: (Long) -> Unit)
    fun validateApk(file: File, candidate: AppUpdateCandidate)
    fun cancel()
}

class AppUpdateEngine(private val currentVersion: String, private val directory: File, private val source: AppUpdateSource,
    private val enabled: () -> Boolean, private val skipped: () -> String, private val saveSkipped: (String) -> Unit,
    private val executor: Executor,
    // Waits before each automatic resume; only consecutive attempts without new bytes consume an entry.
    private val retryDelays: List<Long> = listOf(2_000, 5_000, 10_000, 20_000, 30_000)) {
    @Volatile var changed: (JSONObject) -> Unit = {}
    private var candidate: AppUpdateCandidate? = null
    private var downloaded: File? = null
    private var status = "idle"
    private var received = 0L
    private var error = ""
    private var manual = false
    private var deferred = false
    private var installAfterDownload = false
    private var automaticChecked = false
    private var token = 0L
    private var closed = false
    init {
        directory.mkdirs()
        // Partial packages named by digest survive restarts; numbered packages belong to a finished process.
        directory.listFiles()?.filter { it.name.matches(Regex("update-[0-9]{1,19}\\.(part|apk)")) }?.forEach { it.delete() }
    }
    private fun partial(candidate: AppUpdateCandidate) = File(directory, "update-${candidate.sha256}.part")
    private fun pause(milliseconds: Long, generation: Long) {
        val end = System.nanoTime() + milliseconds * 1_000_000
        while (active(generation)) {
            val left = (end - System.nanoTime()) / 1_000_000
            if (left <= 0) return
            Thread.sleep(minOf(left, 100))
        }
    }
    @Synchronized fun snapshot(): JSONObject = JSONObject().put("status", status).put("currentVersion", currentVersion)
        .put("version", candidate?.version ?: "").put("releaseUrl", candidate?.releaseUrl ?: "").put("notes", candidate?.notes ?: "")
        .put("size", candidate?.size ?: 0).put("received", received).put("error", error)
        .put("installLabel", "安装更新").put("manual", manual).put("platform", "android").put("deferred", deferred)
        .put("installAfterDownload", installAfterDownload)
    private fun publish() { changed(snapshot()) }
    @Synchronized private fun active(generation: Long) = !closed && generation == token
    private fun task(generation: Long, action: () -> Unit) {
        executor.execute {
            if (!active(generation)) return@execute
            try { action() } catch (failure: Exception) {
                synchronized(this) {
                    if (active(generation)) {
                        status = "error"; installAfterDownload = false
                        error = if (failure is IllegalArgumentException || failure is IllegalStateException) failure.message?.take(180) ?: "更新失败，请重试" else "无法完成更新，请检查网络后重试"
                        publish()
                    }
                }
            }
        }
    }
    @Synchronized fun check(manual: Boolean): Boolean {
        if (closed) return false
        if (!manual) {
            if (automaticChecked) return true
            automaticChecked = true
            if (!enabled()) return true
        } else { automaticChecked = true; this.manual = true; deferred = false }
        if (status in setOf("checking", "downloading", "ready", "installing")) { publish(); return true }
        this.manual = manual; deferred = false; installAfterDownload = false; candidate = null; downloaded?.delete(); downloaded = null
        status = "checking"; received = 0; error = ""; val generation = ++token; publish()
        task(generation) {
            val selected = AppUpdatePolicy.select(source.releases(), currentVersion)
            synchronized(this) {
                if (!active(generation)) return@task
                candidate = selected?.takeUnless { !this.manual && it.version == skipped() }
                status = if (candidate == null) "current" else "available"
                publish()
            }
        }
        return true
    }
    @Synchronized fun skip(): Boolean {
        if (closed || status == "installing") return false
        val selected = candidate ?: return false
        // Nothing will resume a skipped release.
        saveSkipped(selected.version); cancel(); partial(selected).delete(); candidate = null; status = "idle"; error = ""; deferred = true; publish(); return true
    }
    @Synchronized fun defer(): Boolean { if (closed) return false; deferred = true; publish(); return true }
    @Synchronized fun cancel(): Boolean {
        if (closed || status == "installing") return false
        token++; installAfterDownload = false; source.cancel(); downloaded?.delete(); downloaded = null
        received = 0; error = ""; status = if (candidate == null) "idle" else "available"; publish(); return true
    }
    @Synchronized fun download(): Boolean {
        if (closed || status in setOf("checking", "downloading", "installing")) return false
        val selected = candidate ?: return false
        manual = true; deferred = false; installAfterDownload = true
        if (status == "ready") { publish(); return true }
        val generation = ++token
        val part = partial(selected)
        status = "downloading"; error = ""; received = resumeOffset(part, selected); deferred = false; publish()
        task(generation) {
            val complete = File(directory, "update-$generation.apk")
            // Partial packages of superseded releases would otherwise accumulate.
            directory.listFiles()?.filter { it.name.endsWith(".part") && it.name != part.name }?.forEach { it.delete() }
            var failures = 0
            while (true) {
                val before = part.length()
                try {
                    source.download(selected, part, { !active(generation) }) { bytes ->
                        synchronized(this) { if (active(generation)) { received = bytes; error = ""; publish() } }
                    }
                    break
                } catch (failure: IOException) {
                    if (!active(generation)) return@task
                    if (part.length() > before) failures = 0
                    check(failures < retryDelays.size) { "更新下载多次中断，已保留下载进度。请检查网络后点击“重试下载”继续。" }
                    val delay = retryDelays[failures++]
                    synchronized(this) {
                        if (!active(generation)) return@task
                        received = part.length(); error = "下载中断，${(delay + 999) / 1000} 秒后自动继续（第 $failures/${retryDelays.size} 次重试）。"; publish()
                    }
                    pause(delay, generation)
                    synchronized(this) {
                        if (!active(generation)) return@task
                        error = "正在重新连接（第 $failures/${retryDelays.size} 次重试）…"; publish()
                    }
                }
            }
            if (!active(generation)) return@task
            try {
                AppUpdatePolicy.verifyFile(part, selected)
                source.validateApk(part, selected)
            } catch (failure: Exception) {
                // A damaged package must not be resumed again.
                part.delete(); throw failure
            }
            synchronized(this) {
                if (!active(generation)) return@task
                check(part.renameTo(complete)) { "无法保存更新包，请重试" }
                downloaded = complete; status = "ready"; received = selected.size; publish()
            }
        }
        return true
    }
    @Synchronized fun prepareInstall(automatic: Boolean = false, ready: (File) -> Unit): Boolean {
        if (closed || status != "ready") return false
        if (automatic && !installAfterDownload) return false
        val selected = candidate ?: return false
        val file = downloaded ?: return false
        val generation = ++token
        // Consume before notifying documents: a replayed ready signal cannot hand off twice.
        installAfterDownload = false
        status = "installing"; error = ""; deferred = false; publish()
        task(generation) {
            try {
                AppUpdatePolicy.verifyFile(file, selected)
                source.validateApk(file, selected)
            } catch (failure: Exception) {
                file.delete(); synchronized(this) { downloaded = null }; throw failure
            }
            synchronized(this) { if (active(generation)) ready(file) }
        }
        return true
    }
    @Synchronized fun installationReturned(error: String = "") {
        if (closed || status != "installing") return
        status = if (downloaded?.isFile == true) "ready" else "error"; this.error = error; publish()
    }
    @Synchronized fun close() { if (closed) return; closed = true; installAfterDownload = false; token++; source.cancel(); changed = {}; (executor as? ExecutorService)?.shutdownNow() }
}
