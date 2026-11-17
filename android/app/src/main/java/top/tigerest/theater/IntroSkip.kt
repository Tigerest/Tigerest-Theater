package top.tigerest.theater

import org.json.JSONObject

/**
 * Emby's intro marker for the playing item, in seconds, as the page publishes it
 * (`setIntroSkip`) once the user's intro skip mode and Emby Premiere allow it.
 * Inside the intro the player offers a "跳过片头" button, or skips by itself when
 * the mode is automatic. Same rules as the desktop's uosc element
 * (TigerestSkipIntro.lua): the offer ends 2 s before the intro does, and 5 s
 * before once it was taken, so a seek that lands just short of the end does not
 * bring it back.
 */
class IntroSkip {
    data class Intro(val start: Double, val end: Double, val auto: Boolean)
    var intro: Intro? = null; private set
    /** The position is inside the intro and the offer stands. */
    var offered = false; private set
    private var margin = MARGIN
    private var seeking = false
    /** The offer as a button; an automatic skip shows none. */
    val button: Boolean get() = offered && intro?.auto == false

    /** A new item's marker, or none; [time] is the position now (null without a file). Returns an automatic skip's target. */
    fun set(value: Intro?, time: Double?): Double? {
        intro = value; margin = MARGIN; seeking = false
        return decide(time)
    }
    fun clear() { intro = null; offered = false; margin = MARGIN; seeking = false }

    /** Called with every position. Returns where to jump when the offer starts and the mode is automatic. */
    fun decide(time: Double?): Double? {
        val intro = intro
        if (intro != null && time != null && time <= intro.start) margin = MARGIN
        val inside = intro != null && time != null && !seeking && time >= intro.start && time < intro.end - margin
        if (inside == offered) return null
        offered = inside
        return if (inside && intro!!.auto) skip() else null
    }

    /** Takes the offer (the button, or an automatic skip): the position to seek to, null when nothing is offered. */
    fun skip(): Double? {
        val intro = intro ?: return null
        if (!offered) return null
        // Positions reported until the seek lands are still inside the intro.
        margin = MARGIN_AFTER_SKIP; seeking = true; offered = false
        return intro.end
    }

    /** A seek is over (playback restarted at [time]): a position inside the intro is where the viewer is now. */
    fun restarted(time: Double?): Double? { seeking = false; return decide(time) }
    /** A seek that never restarts playback must not hide the offer for good. */
    fun seekTimedOut() { seeking = false }

    companion object {
        const val MARGIN = 2.0
        const val MARGIN_AFTER_SKIP = 5.0
        const val SEEK_TIMEOUT_MS = 3000L
        /** The page's `{start, end, auto}`; anything else is no marker, as on the desktop. */
        fun parse(value: Any?): Intro? {
            val data = value as? JSONObject ?: return null
            fun number(key: String) = when (val field = data.opt(key)) { is Number -> field.toDouble(); is String -> field.toDoubleOrNull(); else -> null }
            val start = number("start") ?: return null
            val end = number("end") ?: return null
            if (!start.isFinite() || !end.isFinite() || start < 0 || end <= start) return null
            return Intro(start, end, data.opt("auto") == true)
        }
    }
}
