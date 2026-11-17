package top.tigerest.theater

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class IntroSkipTest {
    private val intro = IntroSkip.Intro(10.0, 100.0, auto = false)

    @Test fun thePageMarkerIsCheckedLikeTheDesktop() {
        assertEquals(IntroSkip.Intro(12.5, 95.0, true), IntroSkip.parse(JSONObject().put("start", 12.5).put("end", 95).put("auto", true)))
        assertEquals("automatic only when it is true", false, IntroSkip.parse(JSONObject().put("start", 0).put("end", 90).put("auto", "true"))?.auto)
        for (bad in listOf<Any?>(JSONObject().put("start", -1).put("end", 90), JSONObject().put("start", 90).put("end", 90), JSONObject().put("end", 90),
            JSONObject().put("start", 0).put("end", "later"), "{\"start\":0,\"end\":90}", JSONObject.NULL, null))
            assertNull(bad.toString(), IntroSkip.parse(bad))
    }

    @Test fun theButtonIsOfferedInsideTheIntroUntilTwoSecondsBeforeItsEnd() {
        val skip = IntroSkip()
        assertNull(skip.set(intro, null)); assertFalse("no file, no offer", skip.offered)
        skip.decide(9.9); assertFalse(skip.button)
        skip.decide(10.0); assertTrue(skip.button)
        skip.decide(97.9); assertTrue(skip.button)
        skip.decide(98.0); assertFalse(skip.button)
    }

    @Test fun takingTheOfferJumpsToTheEndAndALandingJustShortOfItDoesNotOfferItAgain() {
        val skip = IntroSkip(); skip.set(intro, 30.0)
        assertTrue(skip.button)
        assertEquals(100.0, skip.skip()!!, 0.0)
        assertFalse(skip.button); assertNull("taken once", skip.skip())
        assertNull("positions until the seek lands are still inside the intro", skip.decide(30.2)); assertFalse(skip.offered)
        skip.restarted(96.0); assertFalse("5 s before the end once taken", skip.offered)
        skip.restarted(94.0); assertTrue("a seek back into the intro offers it again", skip.button)
        skip.decide(5.0); assertFalse(skip.offered)
        skip.decide(96.5); assertTrue("before the start the margin is 2 s again", skip.button)
    }

    @Test fun automaticModeJumpsOnceAndShowsNoButton() {
        val skip = IntroSkip()
        assertNull("before the intro", skip.set(intro.copy(auto = true), 2.0))
        assertEquals(100.0, skip.decide(10.5)!!, 0.0)
        assertFalse(skip.button); assertFalse(skip.offered)
        assertNull("one jump per entry", skip.decide(10.7))
        assertNull(skip.restarted(100.0)); assertNull(skip.decide(100.5))
        assertEquals("resuming inside the intro skips it as well", 100.0, skip.set(intro.copy(auto = true), 30.0)!!, 0.0)
    }

    @Test fun aSeekThatNeverRestartsDoesNotHideTheOfferForGood() {
        val skip = IntroSkip(); skip.set(intro, 20.0); skip.skip()
        assertNull(skip.decide(20.5)); assertFalse(skip.offered)
        skip.seekTimedOut()
        skip.decide(20.6); assertTrue(skip.button)
    }

    @Test fun aNewMarkerOrNoneReplacesThePreviousItems() {
        val skip = IntroSkip(); skip.set(intro, 50.0); assertTrue(skip.button)
        skip.set(null, 50.0); assertFalse(skip.offered); assertNull(skip.intro)
        skip.set(intro, 50.0); skip.clear(); assertNull(skip.intro); assertFalse(skip.offered)
        assertNull(skip.decide(50.0)); assertFalse(skip.offered)
    }
}
