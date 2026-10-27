package top.tigerest.theater

import org.junit.Assert.*
import org.junit.Test

class CoreTest {
 @org.junit.Test fun encodedProxyPathsAndDefaultPortsMatchWebViewOrigins() {
  org.junit.Assert.assertEquals("https://example.test/media%20proxy/",ServerAddress.base("https://example.test/media%20proxy/web/index.html"))
  org.junit.Assert.assertEquals("https://example.test",ServerAddress.origin("https://EXAMPLE.test:443/web/index.html"))
 }
    @Test fun reverseProxyIsPreservedAndCredentialsRejected() {
        assertEquals("https://example.org/emby/", ServerAddress.base(" https://example.org/emby/web/index.html "))
        assertEquals("http://example.org:8096/", ServerAddress.base("example.org:8096"))
        for (url in listOf("file:///tmp/a", "javascript:alert(1)", "https://user:pass@example.org", "https://example.org/#secret")) {
            assertThrows(IllegalArgumentException::class.java) { ServerAddress.base(url) }
        }
    }
    @Test fun dedicatedProfileOnTheOldPublicAddressMovesToHttps() {
        for (mode in listOf("tigerest", "")) assertEquals("https://nas.tigerest.top:18445/", ServerAddress.movedDedicated("http://nas.tigerest.top:8095/web/index.html", mode))
        assertNull(ServerAddress.movedDedicated("http://nas.tigerest.top:8095/", "custom"))
        for (saved in listOf("http://192.168.5.150:8095/", "https://nas.tigerest.top:18445/", "")) assertNull(ServerAddress.movedDedicated(saved, "tigerest"))
    }
    @Test fun replacedSessionRejectsLateEndAndPausePreservesTime() {
        val state = PlaybackState()
        val old = state.begin("old"); val current = state.begin("new")
        assertFalse(state.end(old)); assertTrue(state.active)
        state.update(current, 24.5, true, 1.5)
        assertEquals(24500L, state.positionMs); assertTrue(state.paused)
        assertTrue(state.end(current)); assertFalse(state.active)
    }
    @Test fun danmakuTimelineUsesPlayerTimeAfterSeekAndSourceDelay() {
        val comments = listOf(DanmakuComment(1.0,"first",1,0xffffff),DanmakuComment(5.0,"second",5,0xffffff))
        val timeline = DanmakuTimeline(comments)
        assertEquals(listOf("first"), timeline.visible(2.0,8.0,0.0).map{it.text})
        assertEquals(listOf("first","second"), timeline.visible(6.0,8.0,0.0).map{it.text})
        assertEquals(emptyList<String>(), timeline.visible(0.5,8.0,0.0).map{it.text})
        assertEquals(listOf("first"), timeline.visible(4.0,8.0,2.0).map{it.text})
    }
}
