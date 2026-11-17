package top.tigerest.theater

/**
 * External subtitle files mpv is fetching. Emby can take seconds, or over a
 * minute for a large file, to extract a subtitle, so mpv fetches it on a worker
 * thread and the reply selects the track. As on the desktop, a reply selects only
 * while its request is still the current selection of the same item: a newer
 * selection, a new item or a stop leaves it unused.
 */
class ExternalSubtitles {
    class Request(val id: Long, val generation: Long, val url: String) {
        /** The video started without it, and the viewer was told it would follow. */
        var late = false
    }
    private var serial = 0L
    var current: Request? = null; private set

    /** A selection of [url] for the item [generation]; null when that file is already being fetched for it. */
    fun request(generation: Long, url: String): Request? {
        val pending = current
        if (pending != null && pending.generation == generation && pending.url == url) return null
        return Request(++serial, generation, url).also { current = it }
    }
    /** Any other selection, a new item or the end of one. */
    fun supersede() { current = null }
    /** The reply for [request]: true while it is the current selection, which it then stops being. */
    fun complete(request: Request): Boolean {
        if (current !== request) return false
        current = null
        return true
    }
    fun pending(generation: Long) = current?.generation == generation
    /** The item [generation] starts without its file: true when one was still pending, which is now late. */
    fun startedWithout(generation: Long): Boolean {
        val pending = current?.takeIf { it.generation == generation } ?: return false
        pending.late = true
        return true
    }
}
