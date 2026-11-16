package top.tigerest.theater

/** The shared Emby player uses music, #1 and an empty subtitle selection. */
object PlaybackContract {
    fun isVideo(type: String) = type.lowercase() !in setOf("audio","music")
    fun track(value: String): String {
        val normalized = value.removePrefix("#")
        return if(normalized.isBlank() || normalized.toIntOrNull()?.let { it < 0 } == true) "no" else normalized
    }
    fun subtitleBackground(color: String, alpha: String) = "#" + alpha + color.removePrefix("#")
    /** Bitmap subtitles have no text for the HDR output's native subtitle layer. */
    fun isImageSubtitle(codec: String) = codec.lowercase() in setOf("hdmv_pgs_subtitle","dvd_subtitle","dvb_subtitle","xsub")
    data class Size(val width: Int, val height: Int)
    /** The largest box of the given aspect inside the pane. */
    fun fit(width: Int, height: Int, aspect: Double): Size =
        if(aspect <= 0 || width <= 0 || height <= 0) Size(width,height)
        else if(width.toDouble()/height > aspect) Size((height*aspect).toInt(),height)
        else Size(width,(width/aspect).toInt())
    /** mpv sizes subtitles in pixels of a 720-line frame; the overlay scales them with the visible video. */
    data class SubtitleStyle(val height: Int, val fontSize: Double, val borderSize: Double) {
        private val scale = height / 720f
        val textSize = (fontSize * scale).toFloat()
        val border = (borderSize * scale).toFloat()
        val verticalMargin = 22 * scale
        val sideMargin = 25 * scale
    }
    /** mpv `video-params` / `video-target-params` fields the dynamic range notice reads. */
    data class ColorParams(val width: Int = 0, val height: Int = 0, val primaries: String = "", val gamma: String = "", val maxLuma: Double = 0.0)
    /**
     * The playback-start notice: HDR or SDR output, from what source. Same rules
     * and wording as the Apple clients (DynamicRangeSummary.swift); null until
     * both colorspaces are known.
     */
    fun dynamicRangeText(source: ColorParams, target: ColorParams, dolbyVisionProfile: Int, toneMapping: String): String? {
        if(source.gamma.isEmpty() || target.gamma.isEmpty()) return null
        val hdr = setOf("pq","hlg"); val sourceHdr = source.gamma in hdr; val targetHdr = target.gamma in hdr
        val format = if(dolbyVisionProfile > 0) "杜比视界 Profile $dolbyVisionProfile" else if(source.gamma == "hlg") "HLG" else "HDR10"
        val mode = if(targetHdr) "HDR 输出 · $format"
            else if(sourceHdr) "SDR 输出 · $format 已色调映射（${toneMapping.ifEmpty { "自动" }}）"
            else "SDR 播放"
        val input = mutableListOf<String>()
        if(source.width > 0 && source.height > 0) input += "${source.width}×${source.height}"
        input += colorspace(source)
        // Mastering peaks are coded with small offsets (1000.6); report them in 10-nit steps.
        // MediaCodec hands mpv no mastering metadata, and mpv then reports PQ's 10000-nit ceiling.
        if(sourceHdr && source.maxLuma.isFinite() && source.maxLuma > 0 && source.maxLuma < 10000) input += "母版 ${Math.round(source.maxLuma/10)*10} nits"
        // A PQ target's max-luma is the signal's ceiling, not the screen's.
        val output = mutableListOf(colorspace(target)); if(targetHdr) output += "由系统按屏幕能力映射亮度"
        return "$mode\n片源 ${input.joinToString(" · ")}\n输出 ${output.joinToString(" · ")}"
    }
    private fun colorspace(params: ColorParams): String {
        val primaries = mapOf("bt.709" to "BT.709","bt.2020" to "BT.2020","display-p3" to "Display P3","dci-p3" to "DCI-P3",
            "bt.601-525" to "BT.601","bt.601-625" to "BT.601","apple" to "Apple RGB","adobe" to "Adobe RGB")[params.primaries]
            ?: params.primaries.uppercase().ifEmpty { "未知" }
        val transfer = mapOf("pq" to "PQ","hlg" to "HLG","srgb" to "sRGB","bt.1886" to "BT.1886","gamma2.2" to "Gamma 2.2",
            "gamma2.4" to "Gamma 2.4","linear" to "线性")[params.gamma] ?: params.gamma.ifEmpty { "未知" }
        return "$primaries / $transfer"
    }
    /** An end of file this far from the duration is a stream cut short, not the credits. */
    const val EARLY_END_SECONDS = 10.0
    /**
     * The diagnostic line for a playback that ends: why and when, nothing else
     * (no title, address or account). A network stream cut short reaches mpv's
     * end of file as well; the time left tells it apart from a finished episode.
     */
    fun endRecord(cause: String, positionSeconds: Double?, durationSeconds: Double?, endOfFile: Boolean = false): String {
        val position = positionSeconds?.takeIf { it.isFinite() && it >= 0 }
        val duration = durationSeconds?.takeIf { it.isFinite() && it > 0 }
        fun seconds(value: Double?) = if(value == null) "unknown" else String.format(java.util.Locale.ROOT,"%.1fs",value)
        val left = if(position != null && duration != null) (duration-position).coerceAtLeast(0.0) else null
        val early = endOfFile && left != null && left > EARLY_END_SECONDS
        return "Player ended: $cause at ${seconds(position)} of ${seconds(duration)}" +
            (if(left != null) ", ${seconds(left)} left" else "") + (if(early) " (ended before the duration)" else "")
    }
}
