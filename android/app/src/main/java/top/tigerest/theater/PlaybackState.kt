package top.tigerest.theater

class PlaybackState {
    var opening = false; private set
    private var waitingForCache = false
    /** The video waits (at most 10 s) for the external subtitle it starts with. */
    var held = false; private set
    val loading: Boolean get() = active && (opening || held || waitingForCache && !paused)
    fun ready(generation: Long) { if (generation == this.generation && active) opening = false }
    fun buffering(generation: Long, waiting: Boolean) { if (generation == this.generation && active) waitingForCache = waiting }
    fun hold(generation: Long, held: Boolean) { if (generation == this.generation && active) this.held = held }
    var active = false; private set
    var paused = false; private set
    var positionMs = 0L; private set
    var generation = 0L; private set
    var url = ""; private set
    var speed = 1.0; private set
    fun begin(url: String): Long { this.url = url; generation++; active = true; opening = true; waitingForCache = false; held = false; positionMs = 0; paused = false; return generation }
    fun end(generation: Long): Boolean { if (generation != this.generation || !active) return false; active = false; opening = false; waitingForCache = false; held = false; return true }
    fun update(generation: Long, seconds: Double, paused: Boolean, speed: Double) {
        if (generation != this.generation || !active) return
        positionMs = (seconds.coerceAtLeast(0.0) * 1000).toLong()
        this.paused = paused; this.speed = speed
    }
}
