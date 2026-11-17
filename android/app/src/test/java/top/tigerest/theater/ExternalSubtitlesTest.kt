package top.tigerest.theater

import org.junit.Assert.*
import org.junit.Test

class ExternalSubtitlesTest {
    @Test fun theReplyOfTheCurrentSelectionSelectsOnce() {
        val subtitles = ExternalSubtitles()
        val request = subtitles.request(1, "https://server/one.srt")!!
        assertTrue(subtitles.pending(1)); assertFalse(subtitles.pending(2))
        assertNull("one fetch of a file per item", subtitles.request(1, "https://server/one.srt"))
        assertTrue(subtitles.complete(request)); assertFalse(subtitles.complete(request)); assertFalse(subtitles.pending(1))
    }

    @Test fun aNewerSelectionAStopOrTheNextItemLeavesALateReplyUnused() {
        val subtitles = ExternalSubtitles()
        val first = subtitles.request(1, "one")!!
        val second = subtitles.request(1, "two")!!
        assertFalse(subtitles.complete(first)); assertTrue(subtitles.pending(1))
        subtitles.supersede(); assertFalse("an embedded subtitle or none was chosen", subtitles.complete(second))
        val old = subtitles.request(1, "one")!!
        val next = subtitles.request(2, "one")!!
        assertNotSame(old, next); assertFalse("a new item", subtitles.complete(old)); assertTrue(subtitles.complete(next))
    }

    @Test fun onlyTheWaitingItemsFileBecomesLate() {
        val subtitles = ExternalSubtitles()
        assertFalse(subtitles.startedWithout(1))
        val request = subtitles.request(2, "one")!!
        assertFalse(subtitles.startedWithout(1)); assertFalse(request.late)
        assertTrue(subtitles.startedWithout(2)); assertTrue(request.late)
        assertTrue("still selects when it arrives", subtitles.complete(request))
    }
}
