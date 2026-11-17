package top.tigerest.theater

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.View

/**
 * Text subtitles for HDR output: MediaCodec renders straight to the surface,
 * where mpv draws nothing, so mpv's plain subtitle text is drawn here with the
 * user's subtitle size, colours, weight and placement. ASS positioning is not kept.
 */
class SubtitleOverlay(context: Context, private val settings: SettingsStore): View(context) {
    private val fill = TextPaint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND }
    private val box = Paint()
    var text = ""
        set(value) { if (field != value) { field = value; invalidate() } }
    /** Aspect of the centred video; subtitles sit and scale inside it. */
    var aspect = 0.0
        set(value) { if (field != value) { field = value; invalidate() } }

    private fun setting(key: String, fallback: String) = settings.string("subtitles", key).let { if (it.isBlank() || it == "-1") fallback else it }
    private fun color(value: String, fallback: Int) = runCatching { Color.parseColor(value) }.getOrDefault(fallback)

    override fun onDraw(canvas: Canvas) {
        if (text.isBlank() || width == 0 || height == 0) return
        val video = PlaybackContract.fit(width, height, aspect)
        val left = (width - video.width) / 2f; val videoTop = (height - video.height) / 2f
        val style = PlaybackContract.SubtitleStyle(video.height,
            setting("size", "55").toDoubleOrNull() ?: 55.0, setting("border_size", "3").toDoubleOrNull() ?: 3.0)
        val font = setting("font", "")
        val bold = settings.bool("subtitles", "bold")
        val typeface = if (font.isEmpty()) (if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT) else Typeface.create(font, if (bold) Typeface.BOLD else Typeface.NORMAL)
        for (paint in listOf(fill, stroke)) { paint.textSize = style.textSize; paint.typeface = typeface }
        fill.color = color(setting("color", "#FFFFFF"), Color.WHITE)
        stroke.color = color(setting("border_color", "#000000"), Color.BLACK)
        // A centred stroke: double width for mpv's outer border size.
        stroke.strokeWidth = style.border * 2
        val placement = settings.string("subtitles", "placement").split(',')
        val alignment = when (placement.getOrNull(0)) { "left" -> Layout.Alignment.ALIGN_NORMAL; "right" -> Layout.Alignment.ALIGN_OPPOSITE; else -> Layout.Alignment.ALIGN_CENTER }
        val lineWidth = (video.width - style.sideMargin * 2).toInt().coerceAtLeast(1)
        val layout = { paint: TextPaint -> StaticLayout.Builder.obtain(text, 0, text.length, paint, lineWidth).setAlignment(alignment).build() }
        val front = layout(fill); val outline = layout(stroke)
        // The subtitle's own vertical position (as mpv's sub-pos) goes before the placement.
        val position = settings.number("subtitles", "vertical_position")
        val top = videoTop + if (position >= 0) PlaybackContract.subtitleTop(video.height.toFloat(), front.height.toFloat(), style.verticalMargin, position)
        else when (placement.getOrNull(1)) {
            "top" -> style.verticalMargin
            "center" -> (video.height - front.height) / 2f
            else -> video.height - style.verticalMargin - front.height
        }
        canvas.save(); canvas.translate(left + style.sideMargin, top)
        box.color = color(PlaybackContract.subtitleBackground(setting("background_color", "#000000"), setting("background_transparency", "00")), Color.TRANSPARENT)
        if (Color.alpha(box.color) > 0) for (line in 0 until front.lineCount)
            canvas.drawRect(front.getLineLeft(line) - style.border, front.getLineTop(line).toFloat(), front.getLineRight(line) + style.border, front.getLineBottom(line).toFloat(), box)
        outline.draw(canvas); front.draw(canvas)
        canvas.restore()
    }
}
