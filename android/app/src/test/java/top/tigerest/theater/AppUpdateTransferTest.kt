package top.tigerest.theater

import okhttp3.MediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.BufferedSource
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files

class AppUpdateTransferTest {
    private val candidate = AppUpdateCandidate("2.5.0", "", "", 3, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "")
    private fun response(code: Int, body: ResponseBody, contentRange: String? = null) = Response.Builder()
        .request(Request.Builder().url("https://release-assets.githubusercontent.com/asset").build())
        .protocol(Protocol.HTTP_1_1).code(code).message("fixture")
        .apply { if (contentRange != null) header("Content-Range", contentRange) }.body(body).build()
    private fun unknownLength(text: String) = object : ResponseBody() {
        override fun contentType(): MediaType? = null
        override fun contentLength() = -1L
        override fun source(): BufferedSource = Buffer().writeUtf8(text)
    }
    private fun file(text: String) = Files.createTempFile("update", ".part").toFile().apply { writeText(text); deleteOnExit() }
    private fun write(destination: File, response: Response, progress: MutableList<Long> = mutableListOf()) =
        writePackage(response, candidate, destination, resumeOffset(destination, candidate), { false }) { progress.add(it) }

    @Test fun resumesOnlyStrictlyShorterPrefixes() {
        assertEquals(0L, resumeOffset(file(""), candidate))
        assertEquals(2L, resumeOffset(file("ab"), candidate))
        assertEquals(0L, resumeOffset(file("abc"), candidate))
    }

    @Test fun matchingPartialResponseAppends() {
        val destination = file("a"); val progress = mutableListOf<Long>()
        write(destination, response(206, "bc".toResponseBody(), "bytes 1-2/3"), progress)
        assertEquals("abc", destination.readText())
        assertEquals(listOf(1L, 3L), progress)
    }

    @Test fun fullResponseReplacesPrefix() {
        val destination = file("x")
        write(destination, response(200, "abc".toResponseBody()))
        assertEquals("abc", destination.readText())
    }

    @Test fun misalignedOrRejectedRangeRestartsFromZero() {
        for (rejected in listOf(response(206, "bc".toResponseBody(), "bytes 0-1/3"), response(206, "bc".toResponseBody()),
                response(416, "".toResponseBody()))) {
            val destination = file("a")
            assertThrows(IOException::class.java) { write(destination, rejected) }
            assertEquals(0L, destination.length())
        }
    }

    @Test fun earlyEndKeepsResumablePrefix() {
        val destination = file("")
        assertThrows(IOException::class.java) { write(destination, response(200, unknownLength("ab"))) }
        assertEquals("ab", destination.readText())
    }

    @Test fun wrongLengthIsNotRetried() {
        val destination = file("a")
        assertThrows(IllegalArgumentException::class.java) { write(destination, response(206, "bcd".toResponseBody(), "bytes 1-2/3")) }
        assertEquals("a", destination.readText())
    }
}
