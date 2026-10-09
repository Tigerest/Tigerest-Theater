package top.tigerest.theater

import okhttp3.Response
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InterruptedIOException

/** Bytes of [destination] worth resuming; a prefix that is empty or not shorter than the package restarts. */
fun resumeOffset(destination: File, candidate: AppUpdateCandidate): Long =
    destination.length().takeIf { it in 1 until candidate.size } ?: 0L

/**
 * Streams a package response into [destination]. Only a 206 whose Content-Range starts exactly at [offset]
 * is appended; a 200 replaces the prefix. An IOException leaves a valid prefix that a later attempt resumes.
 */
fun writePackage(response: Response, candidate: AppUpdateCandidate, destination: File, offset: Long,
    cancelled: () -> Boolean, progress: (Long) -> Unit) {
    val append = response.code == 206
    if (response.code == 416 || append && (offset == 0L ||
            response.header("Content-Range") != "bytes $offset-${candidate.size - 1}/${candidate.size}")) {
        // The kept prefix cannot be trusted to line up with this response.
        FileOutputStream(destination).close()
        throw IOException("更新包续传位置不匹配，将重新下载")
    }
    val start = if (append) offset else 0L
    val body = response.body ?: throw IllegalStateException("更新包为空")
    require(body.contentLength() == -1L || body.contentLength() == candidate.size - start) { "更新包大小不匹配，请重新检查更新" }
    body.byteStream().use { input -> FileOutputStream(destination, append).use { output ->
        val bytes = ByteArray(64 * 1024); var received = start; var reportedAt = 0L
        progress(received)
        while (true) {
            if (cancelled()) throw InterruptedIOException("cancelled")
            val count = input.read(bytes); if (count < 0) break
            received += count
            require(received <= candidate.size) { "更新包超出预期大小" }
            output.write(bytes, 0, count)
            val now = System.nanoTime()
            if (now - reportedAt >= 200_000_000L || received == candidate.size) { reportedAt = now; progress(received) }
        }
        output.fd.sync()
        if (received < candidate.size) throw IOException("更新包下载中断")
    } }
}
