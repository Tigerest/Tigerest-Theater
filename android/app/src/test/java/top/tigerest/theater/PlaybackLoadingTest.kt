package top.tigerest.theater

import org.junit.Assert.*
import org.junit.Test

class PlaybackLoadingTest {
    @Test fun openingWaitsForPlaybackReadyEvenWhenInitialCacheIsEmptyOrPauseChanges() {
        val state = PlaybackState()
        assertFalse(state.loading)
        val generation = state.begin("video")
        assertTrue(state.loading)
        state.buffering(generation, false)
        state.update(generation, 0.0, true, 1.0)
        assertTrue("a pause or initial cache event is not the first rendered frame", state.loading)
        state.ready(generation)
        assertFalse(state.loading)
    }

    @Test fun realBufferingShowsAfterReadyButUserPauseHidesIt() {
        val state = PlaybackState()
        val generation = state.begin("video")
        state.ready(generation)
        state.buffering(generation, true)
        assertTrue(state.loading)
        state.update(generation, 12.0, true, 1.0)
        assertFalse("paused playback must not look stalled", state.loading)
        state.update(generation, 12.0, false, 1.0)
        assertTrue(state.loading)
        state.buffering(generation, false)
        assertFalse(state.loading)
    }

    @Test fun stoppedOrFailedSessionHidesLoadingAndIgnoresLateEvents() {
        val state = PlaybackState()
        val generation = state.begin("unreachable")
        assertTrue(state.loading)
        assertTrue(state.end(generation))
        state.buffering(generation, true)
        state.ready(generation)
        assertFalse(state.loading)
    }

    @Test fun aVideoWaitingForItsSubtitleShowsLoadingUntilTheHoldEnds() {
        val state = PlaybackState()
        val generation = state.begin("video")
        state.ready(generation); state.hold(generation, true)
        assertTrue(state.held); assertTrue(state.loading)
        state.update(generation, 0.0, true, 1.0)
        assertTrue("paused by the hold, not by the viewer", state.loading)
        state.hold(generation - 1, false); assertTrue("another item's hold ends nothing", state.held)
        state.hold(generation, false); assertFalse(state.loading)
        state.hold(generation, true)
        val next = state.begin("next"); assertFalse("a new item starts without a hold", state.held)
        state.ready(next); assertFalse(state.loading)
        state.hold(next, true); assertTrue(state.end(next)); assertFalse(state.held)
    }

    @Test fun replacingVideoRejectsOldReadinessAndCacheEvents() {
        val state = PlaybackState()
        val old = state.begin("old")
        val current = state.begin("new")
        state.ready(old)
        state.buffering(old, false)
        assertTrue(state.loading)
        state.ready(current)
        state.buffering(old, true)
        assertFalse(state.loading)
    }
}
